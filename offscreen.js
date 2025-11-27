const MIN_RPM = 1000;
const MAX_RPM = 11000;
const MIN_RATE = 0.9;
const MAX_RATE = 1.1;

// 엔진 타입별 RPM 구간 레이어 구성 (사용자가 파일을 채워 넣어야 함)
const ENGINE_LAYER_CONFIG = {
  v6: [
    { id: "idle", ratio: 0.0, file: "assets/v6/engine_idle.mp3" },
    { id: "low", ratio: 0.25, file: "assets/v6/engine_low.mp3" },
    { id: "mid", ratio: 0.55, file: "assets/v6/engine_mid.mp3" },
    { id: "high", ratio: 0.85, file: "assets/v6/engine_high.mp3" },
    { id: "red", ratio: 1.0, file: "assets/v6/engine_redline.mp3" }
  ],
  v8: [
    { id: "idle", ratio: 0.0, file: "assets/v8/engine_idle.mp3" },
    { id: "low", ratio: 0.25, file: "assets/v8/engine_low.mp3" },
    { id: "mid", ratio: 0.55, file: "assets/v8/engine_mid.mp3" },
    { id: "high", ratio: 0.85, file: "assets/v8/engine_high.mp3" },
    { id: "red", ratio: 1.0, file: "assets/v8/engine_redline.mp3" }
  ],
  v10: [
    { id: "idle", ratio: 0.0, file: "assets/v10/engine_idle.mp3" },
    { id: "low", ratio: 0.25, file: "assets/v10/engine_low.mp3" },
    { id: "mid", ratio: 0.55, file: "assets/v10/engine_mid.mp3" },
    { id: "high", ratio: 0.85, file: "assets/v10/engine_high.mp3" },
    { id: "red", ratio: 1.0, file: "assets/v10/engine_redline.mp3" }
  ],
  v12: [
    { id: "idle", ratio: 0.0, file: "assets/v12/engine_idle.mp3" },
    { id: "low", ratio: 0.25, file: "assets/v12/engine_low.mp3" },
    { id: "mid", ratio: 0.55, file: "assets/v12/engine_mid.mp3" },
    { id: "high", ratio: 0.85, file: "assets/v12/engine_high.mp3" },
    { id: "red", ratio: 1.0, file: "assets/v12/engine_redline.mp3" }
  ]
};

const ENGINE_FILES = {
  v6: "assets/engine_v6_loop.mp3",
  v8: "assets/engine_v8_loop.mp3",
  v10: "assets/engine_v10_loop.mp3",
  v12: "assets/engine_v12_loop.mp3"
};
const RPM_SEGMENTS = [
  { name: "idle", start: MIN_RPM, end: 2500 },
  { name: "low", start: 2500, end: 4500 },
  { name: "mid", start: 4500, end: 6500 },
  { name: "high", start: 6500, end: 8500 },
  { name: "redline", start: 8500, end: MAX_RPM }
];
const LAYER_RATE_VARIATION = 0.08;
const SHIFT_FILES = {
  UP: "assets/shift_up.mp3",
  DOWN: "assets/shift_down.mp3"
};

let audioContext;
let mixGain; // 레이어 합산 버스
let shiftGain; // 변속시 일시 감쇠용
let volumeGain; // 사용자 설정 볼륨
const engineBuffers = new Map();
const shiftBuffers = new Map();
let currentEngineType = "v10";
let layerPlayers = new Map();
let targetVolume = 0.6;
let lastNormalized = 0;
let shiftPitchMul = 1;
let shiftRecoverTimer;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
let masterGain;
let engineSource;
let engineSourceGain;
const engineBuffers = new Map();
const shiftBuffers = new Map();
let currentEngineType = "v10";
let targetVolume = 0.6;
let lastEngineState = { rpm: MIN_RPM, gear: 1, playbackRate: MIN_RATE };
let shiftAutomationEndTime = 0;

async function ensureContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
    mixGain = audioContext.createGain();
    mixGain.gain.value = 1;

    shiftGain = audioContext.createGain();
    shiftGain.gain.value = 1;

    volumeGain = audioContext.createGain();
    volumeGain.gain.value = targetVolume;

    mixGain.connect(shiftGain).connect(volumeGain).connect(audioContext.destination);
    masterGain = audioContext.createGain();
    masterGain.gain.value = targetVolume;
    masterGain.connect(audioContext.destination);
  }
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
}

function getAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

async function fetchBuffer(path, cache) {
  if (cache.has(path)) return cache.get(path);
  const url = chrome.runtime.getURL(path);
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = await getAudioContext().decodeAudioData(arrayBuffer);
  cache.set(path, buffer);
  return buffer;
}

function stopAllLayers() {
  layerPlayers.forEach(({ source, gain }) => {
function getAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
    masterGain = audioContext.createGain();
    masterGain.gain.value = targetVolume;
    masterGain.connect(audioContext.destination);
  }
  return audioContext;
}

async function ensureEngineLoop(engineType) {
  await ensureContext();
  const normalizedType = ENGINE_FILES[engineType] ? engineType : "v10";
  if (engineSource && currentEngineType === normalizedType) return;

  const filePath = ENGINE_FILES[normalizedType];
  currentEngineType = normalizedType;
  const buffer = await fetchBuffer(filePath, engineBuffers);

  if (!engineSource) {
    engineSource = getAudioContext().createBufferSource();
    engineSourceGain = getAudioContext().createGain();
    engineSourceGain.gain.value = 1;
    engineSource.buffer = buffer;
    engineSource.loop = true;
    engineSource.connect(engineSourceGain);
    engineSourceGain.connect(masterGain);
    engineSource.start();
    return;
  }

  const fadeDuration = 0.35;
  const now = getAudioContext().currentTime;

  const oldSource = engineSource;
  const oldGain = engineSourceGain;

  const newSource = getAudioContext().createBufferSource();
  const newGain = getAudioContext().createGain();
  newGain.gain.value = 0;
  newSource.buffer = buffer;
  newSource.loop = true;
  newSource.connect(newGain);
  newGain.connect(masterGain);
  newSource.start();

  oldGain.gain.cancelScheduledValues(now);
  oldGain.gain.setValueAtTime(oldGain.gain.value, now);
  oldGain.gain.linearRampToValueAtTime(0, now + fadeDuration);

  newGain.gain.cancelScheduledValues(now);
  newGain.gain.setValueAtTime(0, now);
  newGain.gain.linearRampToValueAtTime(1, now + fadeDuration);

  engineSource = newSource;
  engineSourceGain = newGain;

  try {
    oldSource.stop(now + fadeDuration + 0.05);
  } catch (error) {
    // 이미 정지된 경우 무시
  }
  setTimeout(() => {
    try {
      oldSource.disconnect();
      oldGain.disconnect();
    } catch (error) {
      // 이미 해제된 경우 무시
    }
  }, (fadeDuration + 0.1) * 1000);
}

function stopEngineLoop() {
  if (!engineLayers.length) return;
  engineLayers.forEach(({ source, gain }) => {
    try {
      source.stop();
    } catch (error) {
      // 이미 정지된 경우 무시
    }
    source.disconnect();
    gain.disconnect();
  });
  layerPlayers.clear();
}

async function prepareEngineLayers(engineType) {
  await ensureContext();
  const config = ENGINE_LAYER_CONFIG[engineType] || ENGINE_LAYER_CONFIG.v10;
  if (currentEngineType === engineType && layerPlayers.size === config.length) return;

  stopAllLayers();
  currentEngineType = engineType;

  for (const layer of config) {
    const buffer = await fetchBuffer(layer.file, engineBuffers);
    const source = getAudioContext().createBufferSource();
    const gain = getAudioContext().createGain();
    gain.gain.value = 0;
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain).connect(mixGain);
    source.start();
    layerPlayers.set(layer.id, { source, gain, config: layer });
  }
    engineSource.disconnect();
    if (engineSourceGain) {
      engineSourceGain.disconnect();
    }
    engineSource = null;
    engineSourceGain = null;
  }
}

function setPlaybackRate(rate) {
  if (!engineSource) return;
  engineSource.playbackRate.value = rate;
}

function setVolume(volume) {
  targetVolume = volume;
  if (volumeGain) {
    volumeGain.gain.setTargetAtTime(volume, getAudioContext().currentTime, 0.05);
  }
}

function applyShiftEnvelope(direction, gear) {
  if (!shiftGain) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const dip = gear <= 2 ? 0.75 : 0.82;
  shiftGain.gain.cancelAndHoldAtTime(now);
  shiftGain.gain.setValueAtTime(1, now);
  shiftGain.gain.linearRampToValueAtTime(dip, now + 0.08);
  shiftGain.gain.linearRampToValueAtTime(1, now + 0.28);

  if (shiftRecoverTimer) clearTimeout(shiftRecoverTimer);
  shiftPitchMul = 0.88;
  shiftRecoverTimer = setTimeout(() => {
    shiftPitchMul = 1;
    refreshPlaybackRates();
  }, 220);
  refreshPlaybackRates();
}

function refreshPlaybackRates() {
  const config = ENGINE_LAYER_CONFIG[currentEngineType] || ENGINE_LAYER_CONFIG.v10;
  for (const layer of config) {
    const player = layerPlayers.get(layer.id);
    if (!player) continue;
    const base = MIN_RATE + (MAX_RATE - MIN_RATE) * clamp(lastNormalized, 0, 1);
    const localOffset = clamp((lastNormalized - layer.ratio) * 1.2, -0.2, 0.2);
    player.source.playbackRate.value = clamp(base + localOffset, MIN_RATE, MAX_RATE) * shiftPitchMul;
  }
}

function crossfadeLayers(normalized) {
  lastNormalized = normalized;
  const config = ENGINE_LAYER_CONFIG[currentEngineType] || ENGINE_LAYER_CONFIG.v10;
  if (config.length === 0) return;

  let lower = config[0];
  let upper = config[config.length - 1];

  for (let i = 1; i < config.length; i++) {
    if (normalized <= config[i].ratio) {
      lower = config[i - 1];
      upper = config[i];
      break;
    }
  }

  const span = Math.max(upper.ratio - lower.ratio, 0.001);
  const t = clamp((normalized - lower.ratio) / span, 0, 1);

  layerPlayers.forEach((player) => {
    const isLower = player.config.id === lower.id;
    const isUpper = player.config.id === upper.id;
    const targetGain = isLower ? 1 - t : isUpper ? t : 0;
    player.gain.gain.setTargetAtTime(targetGain, getAudioContext().currentTime, 0.05);
  });

  refreshPlaybackRates();
}

function stopEngineLoop() {
  stopAllLayers();
}

async function handleEngineState(message) {
  const { rpm, settings } = message;
  if (!settings.enabled) return;
  await prepareEngineLayers(settings.engineType || "v10");
  setVolume(settings.volume ?? 0.6);
  const normalized = clamp((rpm - MIN_RPM) / (MAX_RPM - MIN_RPM), 0, 1);
  crossfadeLayers(normalized);
  if (masterGain) {
    masterGain.gain.setTargetAtTime(volume, getAudioContext().currentTime, 0.05);
  }
}

function clampRpm(rpm) {
  return Math.min(Math.max(rpm, MIN_RPM), MAX_RPM);
}

function segmentBlend(rpm) {
  const clamped = clampRpm(rpm);
  for (let i = 0; i < RPM_SEGMENTS.length; i++) {
    const segment = RPM_SEGMENTS[i];
    const isLast = i === RPM_SEGMENTS.length - 1;
    if (clamped <= segment.end || isLast) {
      const span = Math.max(segment.end - segment.start, 1);
      const position = Math.min(Math.max((clamped - segment.start) / span, 0), 1);
      return {
        primaryIndex: i,
        secondaryIndex: isLast ? null : i + 1,
        secondaryWeight: isLast ? 0 : position
      };
    }
  }
  return { primaryIndex: 0, secondaryIndex: null, secondaryWeight: 0 };
}

function updateLayerRates(rpm) {
  const clamped = clampRpm(rpm);
  engineLayers.forEach(({ segment, source }) => {
    const span = Math.max(segment.end - segment.start, 1);
    const offset = Math.min(Math.max((clamped - segment.start) / span, 0), 1);
    const rateOffset = (offset - 0.5) * 2 * LAYER_RATE_VARIATION;
    source.playbackRate.setTargetAtTime(1 + rateOffset, getAudioContext().currentTime, 0.05);
  });
}

function updateEngineMix(rpm) {
  if (!engineLayers.length) return;
  const { primaryIndex, secondaryIndex, secondaryWeight } = segmentBlend(rpm);
  const currentTime = getAudioContext().currentTime;
  engineLayers.forEach((layer, index) => {
    let target = 0;
    if (index === primaryIndex) {
      target = 1 - secondaryWeight;
    } else if (index === secondaryIndex) {
      target = secondaryWeight;
    }
    layer.gain.gain.setTargetAtTime(target, currentTime, 0.05);
  });
  updateLayerRates(rpm);
}

async function handleEngineState(message) {
  const { rpm, settings, gear } = message;
  if (!settings.enabled) return;
  await ensureEngineLoop(settings.engineType);
  setVolume(settings.volume ?? 0.6);
  const playbackRate = computePlaybackRateFromRpm(rpm);
  lastEngineState = { rpm, gear: gear ?? lastEngineState.gear, playbackRate };
  const currentTime = getAudioContext().currentTime;
  if (shiftAutomationEndTime > currentTime && engineSource) {
    engineSource.playbackRate.setValueAtTime(playbackRate, shiftAutomationEndTime);
  } else {
    setPlaybackRate(playbackRate);
  }
}

async function playShiftSound(direction) {
  if (!SHIFT_FILES[direction]) return;
  await ensureContext();
  const buffer = await fetchBuffer(SHIFT_FILES[direction], shiftBuffers);
  const source = getAudioContext().createBufferSource();
  source.buffer = buffer;
  source.connect(volumeGain);
  source.start();
}

  source.connect(masterGain);
  source.start();
}

function computePlaybackRateFromRpm(rpm) {
  const ratio = Math.min(Math.max((rpm - MIN_RPM) / (MAX_RPM - MIN_RPM), 0), 1);
  return MIN_RATE + (MAX_RATE - MIN_RATE) * ratio;
}

function computePostShiftRpm(gear, direction) {
  const previousGear = direction === "UP" ? gear - 1 : gear + 1;
  if (previousGear < 1 || gear < 1) {
    return lastEngineState.rpm;
  }
  const gearRatio = previousGear / gear;
  const estimatedRpm = lastEngineState.rpm * gearRatio;
  return Math.min(Math.max(estimatedRpm, MIN_RPM), MAX_RPM);
}

function applyShiftAutomation(direction, gear) {
  if (!engineSource || !gainNode) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const adjustedRpm = computePostShiftRpm(gear ?? lastEngineState.gear, direction);
  const targetPlaybackRate = computePlaybackRateFromRpm(adjustedRpm);
  const normalizedGear = Math.min(Math.max((gear || lastEngineState.gear) - 1, 0), 7);
  const dipAmount = 0.22 - normalizedGear * ((0.22 - 0.08) / 7);
  const dipDuration = 0.12;
  const releaseDuration = 0.2;
  const dipPlaybackRate = Math.max(MIN_RATE, targetPlaybackRate * (1 - dipAmount));

  engineSource.playbackRate.cancelScheduledValues(now);
  engineSource.playbackRate.setValueAtTime(engineSource.playbackRate.value, now);
  engineSource.playbackRate.linearRampToValueAtTime(dipPlaybackRate, now + dipDuration);
  engineSource.playbackRate.linearRampToValueAtTime(
    targetPlaybackRate,
    now + dipDuration + releaseDuration
  );

  const gainDipAmount = 0.14 + (0.06 * (1 - normalizedGear / 7));
  const dipGain = targetVolume * (1 - gainDipAmount);
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  gainNode.gain.linearRampToValueAtTime(dipGain, now + dipDuration);
  gainNode.gain.linearRampToValueAtTime(targetVolume, now + dipDuration + releaseDuration);

  shiftAutomationEndTime = now + dipDuration + releaseDuration;
  lastEngineState = {
    rpm: adjustedRpm,
    gear: gear ?? lastEngineState.gear,
    playbackRate: targetPlaybackRate
  };
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "ENGINE_STATE") {
    handleEngineState(message);
  } else if (message.type === "STOP_AUDIO") {
    stopEngineLoop();
  } else if (message.type === "SETTINGS") {
    if (message.settings?.volume !== undefined) {
      setVolume(message.settings.volume);
    }
    if (message.settings?.engineType) {
      prepareEngineLayers(message.settings.engineType);
    }
  } else if (message.type === "SHIFT") {
    applyShiftEnvelope(message.direction, message.gear);
    playShiftSound(message.direction);
      ensureEngineLoop(message.settings.engineType);
    }
  } else if (message.type === "SHIFT") {
    playShiftSound(message.direction);
    applyShiftAutomation(message.direction, message.gear);
  }
});
