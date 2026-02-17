// background.js (MV3 service worker)
// 타이핑(KPS) -> throttle(0~1) -> rpm/gear dynamics -> offscreen(WebAudio) 제어

// === Engine sim constants ===
// Offscreen 쪽이랑 맞추려고 RPM 범위는 그대로 유지해.
const MIN_RPM = 1000;
const MAX_RPM = 11000;

// content.js KPS 측정이 WINDOW_MS=1200 기반이라 “지속 타이핑”일 때 값이 천천히 변해.
// 여기서 한 번 더 throttle 모델로 물리감을 만든다.
const MAX_KPS_BASE = 12;

const MIN_GEAR = 1;
const MAX_GEAR = 8;

// 기존 200ms는 스텝이 너무 커서 “게임같이” 들려.
// 50~70ms 정도가 체감이 확 좋아져.
const ENGINE_UPDATE_INTERVAL = 60;

// 각 배열은 0 인덱스를 비워두고 1~8단까지 9개 요소를 유지해야 한다.
// (마지막은 8단용 더미)
// 기존 값(1단 4000 업시프트)은 너무 빨리 올라가서 변속만 난무했어.
// F1 느낌(고RPM 유지)에 맞춰 더 위로 올림.
const GEAR_UP_RPM = [0, 7200, 7900, 8600, 9300, 10000, 10600, 11000, 11000];
const GEAR_DOWN_RPM = [0, 2600, 3300, 4100, 4900, 5800, 6800, 7800, 8800];

// 기어비(대략). 낮은 기어일수록 가속(=RPM 상승)이 빠르게, 높은 기어일수록 느리게.
// 실제 수치와 1:1 매칭이 목적이 아니라 “상승률 차이”가 체감되게 하는 게 목적.
const GEAR_RATIO = [0, 3.2, 2.55, 2.1, 1.8, 1.58, 1.4, 1.26, 1.14];

// 물리/감성 튜닝 파라미터(권장 기본값)
// 단위:
// - accelBase/brakeBase: rpm/s^2
// - damping: 1/s
// - idleSpring: rpm/s^2 per rpm-diff
const ENGINE_SIM = {
  // throttle dynamics
  throttleAttackSec: 0.06, // 키를 치기 시작하면 빨리 열린다
  throttleReleaseSec: 0.28, // 손 떼면 자연스럽게 떨어진다
  throttleGamma: 1.35, // 저KPS 구간을 더 눌러서 “살짝 타이핑=살짝 스로틀” 느낌

  // rpm dynamics (2차계: rpmVel 사용)
  accelBase: 7200, // rpm/s^2 (기본 가속)
  brakeBase: 8200, // rpm/s^2 (스로틀 오프 엔진브레이크)
  damping: 7.2, // 1/s (rpmVel 감쇠)

  // idle return
  idleSpring: 3.8,
  idleOnlyBelowThrottle: 0.12,

  // limiter 느낌(레드라인 근처에서 살짝 “튕김”)
  limiterStart: 0.985, // redline 비율
  limiterStrength: 1.35,
  limiterBounce: 0.22,

  // 안전장치
  maxRpmVel: 28000,

  // shift logic
  shiftCooldownSec: 0.14,
  upshiftMinThrottle: 0.22,
  // 다운시프트는 스로틀 온 상태에서도 허용하되 너무 공격적으로는 안 하게
  downshiftMaxThrottle: 0.75,

  // shift rpm tweak (ratio 변환 후 추가로 살짝 더 떨어지거나(UP) 올라가는(DOWN) 느낌)
  upshiftExtraDrop: 0.985,
  downshiftExtraBlipRpm: 180
};

const OFFSCREEN_URL = "offscreen.html";

const SETTINGS_DEFAULT = {
  enabled: true,
  volume: 0.6,
  engineType: "v10",
  sensitivity: "medium"
};

const SENSITIVITY_RATIO = {
  low: 1.3,
  medium: 1,
  high: 0.7
};

let settings = { ...SETTINGS_DEFAULT };
let lastKps = 0;

// Driver/engine state
let throttle = 0; // 0..1
let currentRpm = MIN_RPM;
let rpmVel = 0; // rpm/s
let currentGear = MIN_GEAR;

let lastTickMs = typeof performance !== "undefined" ? performance.now() : Date.now();
let shiftCooldownUntilSec = 0;

let offscreenActive = false;
let lastSentState = { rpm: -999, gear: 0, throttle: -1 };

async function initSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_DEFAULT);
  settings = { ...SETTINGS_DEFAULT, ...stored };

  // 서비스워커는 자주 재시작될 수 있어서,
  // 이미 떠있는 offscreen 문서가 있으면 상태를 먼저 동기화해준다.
  if (chrome.offscreen?.hasDocument) {
    try {
      offscreenActive = await chrome.offscreen.hasDocument();
    } catch (e) {
      offscreenActive = false;
    }
  }

  if (settings.enabled) {
    await ensureOffscreenDocument();
  } else if (offscreenActive) {
    sendStopToOffscreen();
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(null);
  if (Object.keys(stored).length === 0) {
    await chrome.storage.sync.set(SETTINGS_DEFAULT);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;

  let shouldNotifyOffscreen = false;

  if (changes.enabled) {
    settings.enabled = changes.enabled.newValue;
    if (!settings.enabled) {
      lastKps = 0;
      // 즉시 멈춤
      sendStopToOffscreen();
    } else {
      // 다시 켜질 땐 첫 프레임 강제 전송
      lastSentState = { rpm: -999, gear: 0, throttle: -1 };
      ensureOffscreenDocument();
    }
    shouldNotifyOffscreen = true;
  }

  if (changes.volume) {
    settings.volume = changes.volume.newValue;
    shouldNotifyOffscreen = true;
  }
  if (changes.engineType) {
    settings.engineType = changes.engineType.newValue;
    shouldNotifyOffscreen = true;
  }
  if (changes.sensitivity) {
    settings.sensitivity = changes.sensitivity.newValue;
  }

  if (shouldNotifyOffscreen) {
    broadcastSettings();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "KPS_UPDATE") {
    // content.js에서 주기적으로 들어오는 “운전자 입력”
    lastKps = message.kps;
    return;
  }

  if (message?.type === "GET_STATE") {
    sendResponse({
      type: "STATE",
      enabled: settings.enabled,
      rpm: Math.round(currentRpm),
      gear: currentGear,
      throttle: Number(throttle.toFixed(3)),
      settings
    });
    return true;
  }

  if (message?.type === "TOGGLE_ENABLED") {
    chrome.storage.sync.set({ enabled: message.enabled });
    return true;
  }

  return undefined;
});

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return;
  if (chrome.offscreen.hasDocument) {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) {
      offscreenActive = true;
      return;
    }
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["AUDIO_PLAYBACK"],
    justification: "타이핑 속도에 따른 엔진 사운드 재생"
  });
  offscreenActive = true;
  broadcastSettings();
}

function sendStopToOffscreen() {
  if (!offscreenActive) return;
  chrome.runtime.sendMessage({ type: "STOP_AUDIO" });
}

function broadcastSettings() {
  if (!offscreenActive) return;
  chrome.runtime.sendMessage({ type: "SETTINGS", settings });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function expApproach(current, target, dt, tau) {
  const safeTau = Math.max(0.001, tau);
  const a = 1 - Math.exp(-dt / safeTau);
  return current + (target - current) * a;
}

function mapKpsToThrottleTarget(kps) {
  const ratioBase = SENSITIVITY_RATIO[settings.sensitivity] || 1;
  const effectiveMax = MAX_KPS_BASE * ratioBase;
  const x = clamp(kps / effectiveMax, 0, 1);
  return Math.pow(x, ENGINE_SIM.throttleGamma);
}

function updateThrottle(dt) {
  const target = settings.enabled ? mapKpsToThrottleTarget(lastKps) : 0;
  const tau = target > throttle ? ENGINE_SIM.throttleAttackSec : ENGINE_SIM.throttleReleaseSec;
  throttle = expApproach(throttle, target, dt, tau);
  throttle = clamp(throttle, 0, 1);
}

function torqueCurve(rpmNorm) {
  // 저RPM에서 토크가 더 강하고, 레드라인 근처로 갈수록 토크가 빠진다.
  // (현실 1:1이 아니라 “느낌”)
  return 0.35 + 0.65 * (1 - Math.pow(rpmNorm, 1.85));
}

function brakeCurve(rpmNorm) {
  // 엔진브레이크는 고RPM에서 더 강해지게
  return 0.25 + 0.75 * Math.pow(rpmNorm, 0.9);
}

function stepRpm(dt) {
  const gearFactor = GEAR_RATIO[currentGear] / GEAR_RATIO[MAX_GEAR];
  const rpmNorm = clamp((currentRpm - MIN_RPM) / (MAX_RPM - MIN_RPM), 0, 1);

  let rpmAccel = 0;
  rpmAccel += throttle * ENGINE_SIM.accelBase * gearFactor * torqueCurve(rpmNorm);
  rpmAccel -= (1 - throttle) * ENGINE_SIM.brakeBase * gearFactor * brakeCurve(rpmNorm);
  rpmAccel -= ENGINE_SIM.damping * rpmVel;

  if (throttle < ENGINE_SIM.idleOnlyBelowThrottle) {
    rpmAccel += (MIN_RPM - currentRpm) * ENGINE_SIM.idleSpring;
  }

  // 소프트 리미터(레드라인 근처에서 가속을 강하게 깎음)
  if (throttle > 0.2 && rpmNorm > ENGINE_SIM.limiterStart) {
    const over = (rpmNorm - ENGINE_SIM.limiterStart) / (1 - ENGINE_SIM.limiterStart);
    rpmAccel -= ENGINE_SIM.accelBase * ENGINE_SIM.limiterStrength * over * over;
  }

  rpmVel += rpmAccel * dt;
  rpmVel = clamp(rpmVel, -ENGINE_SIM.maxRpmVel, ENGINE_SIM.maxRpmVel);
  currentRpm += rpmVel * dt;

  // 바운더리 처리
  if (currentRpm < MIN_RPM) {
    currentRpm = MIN_RPM;
    if (rpmVel < 0) rpmVel *= -0.15;
  }
  if (currentRpm > MAX_RPM) {
    currentRpm = MAX_RPM;
    // 레브리미터 “툭 끊김” 느낌
    if (rpmVel > 0) rpmVel *= -ENGINE_SIM.limiterBounce;
  }
}

function maybeShift(nowSec) {
  if (nowSec < shiftCooldownUntilSec) return;

  // 업시프트: 고RPM + 어느 정도 스로틀이 열려있을 때만
  if (
    currentGear < MAX_GEAR &&
    currentRpm >= GEAR_UP_RPM[currentGear] &&
    throttle >= ENGINE_SIM.upshiftMinThrottle
  ) {
    doShift("UP", currentGear + 1, nowSec);
    return;
  }

  // 다운시프트: RPM이 너무 떨어지면 자동으로
  if (
    currentGear > MIN_GEAR &&
    currentRpm <= GEAR_DOWN_RPM[currentGear] &&
    throttle <= ENGINE_SIM.downshiftMaxThrottle
  ) {
    doShift("DOWN", currentGear - 1, nowSec);
  }
}

function doShift(direction, nextGear, nowSec) {
  const fromGear = currentGear;
  const rpmBefore = currentRpm;

  currentGear = nextGear;

  // 기어비 변화로 인한 RPM 점프/드롭 (차속 유지 가정)
  const ratioFrom = GEAR_RATIO[fromGear] || 1;
  const ratioTo = GEAR_RATIO[nextGear] || 1;
  const ratio = ratioTo / ratioFrom;

  currentRpm = clamp(currentRpm * ratio, MIN_RPM, MAX_RPM);
  rpmVel *= ratio;

  if (direction === "UP") {
    currentRpm = clamp(currentRpm * ENGINE_SIM.upshiftExtraDrop, MIN_RPM, MAX_RPM);
  } else {
    // 다운시프트는 blip 느낌으로 살짝 더 올려줌
    currentRpm = clamp(currentRpm + ENGINE_SIM.downshiftExtraBlipRpm, MIN_RPM, MAX_RPM);
    rpmVel += 900; // 짧게 올라가려는 관성
  }

  shiftCooldownUntilSec = nowSec + ENGINE_SIM.shiftCooldownSec;

  // offscreen에 더 많은 메타데이터를 보내서 변속 효과를 더 리얼하게 만들 수 있게
  chrome.runtime.sendMessage({
    type: "SHIFT",
    direction,
    gear: currentGear,
    fromGear,
    rpmBefore: Math.round(rpmBefore),
    rpmAfter: Math.round(currentRpm),
    throttle: Number(throttle.toFixed(3))
  });

  // 변속 직후는 상태 강제 전송(gear 바뀌었으니까)
  maybeSendState(true);
}

function maybeSendState(force = false) {
  if (!settings.enabled) return;

  const roundedRpm = Math.round(currentRpm);
  const t = Number(throttle.toFixed(3));

  // 메시지 스팸 방지: RPM은 10~15단위, throttle은 0.02 정도 이상 변할 때만
  if (!force) {
    const rpmDelta = Math.abs(lastSentState.rpm - roundedRpm);
    const thrDelta = Math.abs(lastSentState.throttle - t);
    const gearSame = lastSentState.gear === currentGear;

    if (gearSame && rpmDelta < 12 && thrDelta < 0.02) return;
  }

  lastSentState = { rpm: roundedRpm, gear: currentGear, throttle: t };

  ensureOffscreenDocument().then(() => {
    chrome.runtime.sendMessage({
      type: "ENGINE_STATE",
      rpm: roundedRpm,
      gear: currentGear,
      throttle: t,
      settings
    });
  });
}

function updateEngineState() {
  const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  let dt = (nowMs - lastTickMs) / 1000;
  lastTickMs = nowMs;

  // 서비스워커가 잠깐 멈췄다가 돌아오면 dt가 커질 수 있어서 클램프
  if (!Number.isFinite(dt) || dt <= 0) dt = ENGINE_UPDATE_INTERVAL / 1000;
  dt = clamp(dt, 0, 0.25);

  updateThrottle(dt);
  stepRpm(dt);

  const nowSec = nowMs / 1000;

  if (settings.enabled) {
    maybeShift(nowSec);
    maybeSendState(false);
  } else {
    // 꺼져있을 땐 기어를 1단 쪽으로 자연스럽게 정리
    if (currentGear > MIN_GEAR && currentRpm <= GEAR_DOWN_RPM[currentGear]) {
      currentGear--;
    }
  }
}

initSettings();
setInterval(updateEngineState, ENGINE_UPDATE_INTERVAL);
