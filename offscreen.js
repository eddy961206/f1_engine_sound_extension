// offscreen.js
// Web Audio 합성으로 “레이어 기반” F1 엔진 느낌을 만든다.
// - order(기본 톤) / harmonic(하모닉 스택) / rasp(배기/거칠기) / whine(인테이크/터보) / mechanical(메탈릭)
// - rpm + throttle에 따라 레이어별 gain/필터/drive를 다르게 움직여서
//   저RPM~고RPM 스윕에서 질감이 자연스럽게 바뀌게 한다.

const MIN_RPM = 1000;
const MAX_RPM = 11000;

// 엔진 타입별 “성격”만 확실히 갈라두고,
// 실제 곡선은 updateEngineSound에서 rpm/throttle로 계속 움직인다.
const ENGINE_PROFILES = {
  v6: {
    cylinders: 6,
    // tonal
    orderWave: "triangle",
    harmWave: "sawtooth",
    orderDetuneCents: 4,
    harmDetuneCents: 7,

    // core saturation
    coreDistortion: 2.2,
    raspDistortion: 3.0,
    coreDrive: [0.85, 1.25],
    raspDrive: [0.75, 1.35],

    // body/filter
    coreLPHz: [1600, 7200],
    coreLPQ: 0.75,
    bodyResHz: [220, 380],
    bodyResQ: 1.2,

    // layer gains (대략적인 범위)
    orderGain: [0.20, 0.22],
    subGain: [0.16, 0.05],
    harmGain: [0.05, 0.18],
    raspGain: [0.015, 0.14],
    whineGain: [0.03, 0.24],
    mechGain: [0.02, 0.08],

    // rasp filters
    raspHPHz: [120, 320],
    raspBPHZ: [650, 2300],
    raspLPHz: [5200, 10500],
    raspQ: 0.9,

    // whine
    whineWave: "sine",
    whineMul: 12.5,
    whineAddHz: 900,
    whineMinHz: 1200,
    whineMaxHz: 10500,
    whineQ: 1.35,
    whineVibratoCents: 9,

    // mechanical resonances
    mechResHz: [2500, 4100],
    mechQ: 11
  },

  v8: {
    cylinders: 8,
    orderWave: "square",
    harmWave: "sawtooth",
    orderDetuneCents: 6,
    harmDetuneCents: 9,

    coreDistortion: 2.6,
    raspDistortion: 3.4,
    coreDrive: [0.9, 1.35],
    raspDrive: [0.9, 1.55],

    coreLPHz: [1500, 6800],
    coreLPQ: 0.85,
    bodyResHz: [200, 320],
    bodyResQ: 1.35,

    orderGain: [0.22, 0.24],
    subGain: [0.20, 0.07],
    harmGain: [0.06, 0.20],
    raspGain: [0.02, 0.17],
    whineGain: [0.02, 0.16],
    mechGain: [0.03, 0.10],

    raspHPHz: [140, 360],
    raspBPHZ: [700, 2600],
    raspLPHz: [5200, 9800],
    raspQ: 1.0,

    whineWave: "triangle",
    whineMul: 9.5,
    whineAddHz: 650,
    whineMinHz: 900,
    whineMaxHz: 9500,
    whineQ: 1.25,
    whineVibratoCents: 7,

    mechResHz: [2400, 3600, 5200],
    mechQ: 10
  },

  v10: {
    cylinders: 10,
    orderWave: "sawtooth",
    harmWave: "square",
    orderDetuneCents: 7,
    harmDetuneCents: 11,

    coreDistortion: 2.4,
    raspDistortion: 3.2,
    coreDrive: [0.95, 1.55],
    raspDrive: [0.85, 1.65],

    coreLPHz: [1900, 8200],
    coreLPQ: 0.7,
    bodyResHz: [260, 480],
    bodyResQ: 1.15,

    orderGain: [0.18, 0.20],
    subGain: [0.12, 0.04],
    harmGain: [0.07, 0.24],
    raspGain: [0.018, 0.18],
    whineGain: [0.03, 0.22],
    mechGain: [0.02, 0.09],

    raspHPHz: [130, 360],
    raspBPHZ: [800, 3000],
    raspLPHz: [5600, 11000],
    raspQ: 1.05,

    whineWave: "sine",
    whineMul: 10.8,
    whineAddHz: 750,
    whineMinHz: 1100,
    whineMaxHz: 11500,
    whineQ: 1.4,
    whineVibratoCents: 8,

    mechResHz: [2800, 4300, 6100],
    mechQ: 11
  },

  v12: {
    cylinders: 12,
    orderWave: "sawtooth",
    harmWave: "triangle",
    orderDetuneCents: 5,
    harmDetuneCents: 9,

    coreDistortion: 2.1,
    raspDistortion: 2.9,
    coreDrive: [0.85, 1.35],
    raspDrive: [0.70, 1.30],

    coreLPHz: [2100, 8800],
    coreLPQ: 0.65,
    bodyResHz: [260, 520],
    bodyResQ: 1.05,

    orderGain: [0.16, 0.18],
    subGain: [0.10, 0.03],
    harmGain: [0.06, 0.20],
    raspGain: [0.012, 0.14],
    whineGain: [0.02, 0.18],
    mechGain: [0.018, 0.07],

    raspHPHz: [120, 320],
    raspBPHZ: [750, 2600],
    raspLPHz: [5600, 10500],
    raspQ: 0.95,

    whineWave: "sine",
    whineMul: 9.2,
    whineAddHz: 650,
    whineMinHz: 900,
    whineMaxHz: 11000,
    whineQ: 1.25,
    whineVibratoCents: 6,

    mechResHz: [2600, 3900, 5400],
    mechQ: 10
  }
};

let audioContext;
let mixGain;
let shiftGain; // 엔진 컷(변속 시)만 걸고, shift one-shot은 bypass
let volumeGain;
let masterGain;
let masterCompressor;

let currentEngineType = "v10";
let engineNodes = null;

let targetVolume = 0.6;
let lastRpm = MIN_RPM;
let lastThrottle = 0;

let pitchMul = 1;
let pitchRecoverTimer;

let noiseBuffer;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// 주파수/컷오프는 선형보다 지수 보간이 더 자연스럽다.
function lerpExp(min, max, t) {
  const safeMin = Math.max(1e-6, min);
  const safeMax = Math.max(1e-6, max);
  return safeMin * Math.pow(safeMax / safeMin, t);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function getProfile(engineType) {
  return ENGINE_PROFILES[engineType] || ENGINE_PROFILES.v10;
}

async function ensureContext() {
  if (!audioContext) {
    audioContext = new AudioContext();

    mixGain = audioContext.createGain();
    mixGain.gain.value = 1;

    shiftGain = audioContext.createGain();
    shiftGain.gain.value = 1;

    volumeGain = audioContext.createGain();
    volumeGain.gain.value = targetVolume;

    masterGain = audioContext.createGain();
    masterGain.gain.value = 1;

    // “한 덩어리” 느낌 + 피크 억제
    masterCompressor = audioContext.createDynamicsCompressor();
    masterCompressor.threshold.value = -18;
    masterCompressor.knee.value = 24;
    masterCompressor.ratio.value = 4;
    masterCompressor.attack.value = 0.003;
    masterCompressor.release.value = 0.18;

    mixGain.connect(shiftGain);
    shiftGain.connect(volumeGain);
    volumeGain.connect(masterGain);
    masterGain.connect(masterCompressor);
    masterCompressor.connect(audioContext.destination);
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
}

function getAudioContext() {
  if (!audioContext) {
    // ensureContext는 async지만, 여기선 "컨텍스트 있으면 좋고" 정도로만.
    ensureContext();
  }
  return audioContext;
}

function getNoiseBuffer() {
  if (noiseBuffer) return noiseBuffer;
  const ctx = getAudioContext();
  const length = Math.floor(ctx.sampleRate * 2);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    // 조금 핫하게 만들어 놓고, 레이어별로 gain으로 조절
    data[i] = (Math.random() * 2 - 1) * 0.95;
  }
  noiseBuffer = buffer;
  return noiseBuffer;
}

function createNoiseSource(loop = true) {
  const ctx = getAudioContext();
  const source = ctx.createBufferSource();
  source.buffer = getNoiseBuffer();
  source.loop = loop;
  return source;
}

function makeTanhCurve(amount) {
  const size = 2048;
  const curve = new Float32Array(size);
  const k = Math.max(0.01, amount);
  const norm = Math.tanh(k);
  for (let i = 0; i < size; i++) {
    const x = (i * 2) / size - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

function stopEngine() {
  if (!engineNodes) return;

  engineNodes.sources.forEach((source) => {
    try {
      source.stop();
    } catch (e) {
      /* ignore */
    }
    try {
      source.disconnect();
    } catch (e) {
      /* ignore */
    }
  });

  engineNodes.nodes.forEach((node) => {
    try {
      node.disconnect();
    } catch (e) {
      /* ignore */
    }
  });

  engineNodes = null;
  pitchMul = 1;
  if (pitchRecoverTimer) {
    clearTimeout(pitchRecoverTimer);
    pitchRecoverTimer = undefined;
  }
}

function buildEngineNodes(profile) {
  const ctx = getAudioContext();

  // ===== Core tonal bus (order + harmonic + sub) =====
  const coreIn = ctx.createGain();

  const coreDrive = ctx.createGain();
  const coreShaper = ctx.createWaveShaper();
  coreShaper.curve = makeTanhCurve(profile.coreDistortion);
  coreShaper.oversample = "4x";

  const coreLP = ctx.createBiquadFilter();
  coreLP.type = "lowpass";
  coreLP.Q.value = profile.coreLPQ;

  // 공명(배기/차체) 느낌: core를 bandpass로 살짝만 뽑아서 섞는다
  const bodyRes = ctx.createBiquadFilter();
  bodyRes.type = "bandpass";
  bodyRes.Q.value = profile.bodyResQ;
  const bodyResGain = ctx.createGain();
  bodyResGain.gain.value = 0;

  coreIn.connect(coreDrive);
  coreDrive.connect(coreShaper);
  coreShaper.connect(coreLP);
  coreLP.connect(mixGain);

  coreLP.connect(bodyRes);
  bodyRes.connect(bodyResGain);
  bodyResGain.connect(mixGain);

  // order
  const orderOscA = ctx.createOscillator();
  orderOscA.type = profile.orderWave;
  const orderOscB = ctx.createOscillator();
  orderOscB.type = profile.orderWave;
  orderOscB.detune.value = profile.orderDetuneCents;
  const orderGain = ctx.createGain();
  orderGain.gain.value = 0;
  orderOscA.connect(orderGain);
  orderOscB.connect(orderGain);
  orderGain.connect(coreIn);

  // sub
  const subOsc = ctx.createOscillator();
  subOsc.type = "sine";
  const subGain = ctx.createGain();
  subGain.gain.value = 0;
  subOsc.connect(subGain);
  subGain.connect(coreIn);

  // harmonic stack-ish (rich waveform + slight detune)
  const harmOscA = ctx.createOscillator();
  harmOscA.type = profile.harmWave;
  const harmOscB = ctx.createOscillator();
  harmOscB.type = profile.harmWave;
  harmOscB.detune.value = -profile.harmDetuneCents;
  const harmGain = ctx.createGain();
  harmGain.gain.value = 0;
  harmOscA.connect(harmGain);
  harmOscB.connect(harmGain);
  harmGain.connect(coreIn);

  // ===== Shared noise source =====
  const noiseSource = createNoiseSource(true);

  // ===== Rasp / exhaust =====
  const raspHP = ctx.createBiquadFilter();
  raspHP.type = "highpass";
  raspHP.Q.value = 0.7;

  const raspBP = ctx.createBiquadFilter();
  raspBP.type = "bandpass";
  raspBP.Q.value = profile.raspQ;

  const raspDrive = ctx.createGain();
  const raspShaper = ctx.createWaveShaper();
  raspShaper.curve = makeTanhCurve(profile.raspDistortion);
  raspShaper.oversample = "4x";

  const raspLP = ctx.createBiquadFilter();
  raspLP.type = "lowpass";
  raspLP.Q.value = 0.75;

  const raspGain = ctx.createGain();
  raspGain.gain.value = 0;

  noiseSource.connect(raspHP);
  raspHP.connect(raspBP);
  raspBP.connect(raspDrive);
  raspDrive.connect(raspShaper);
  raspShaper.connect(raspLP);
  raspLP.connect(raspGain);
  raspGain.connect(mixGain);

  // ===== Whine / intake =====
  const whineOsc = ctx.createOscillator();
  whineOsc.type = profile.whineWave;
  const whineBP = ctx.createBiquadFilter();
  whineBP.type = "bandpass";
  whineBP.Q.value = profile.whineQ;
  const whineGain = ctx.createGain();
  whineGain.gain.value = 0;
  whineOsc.connect(whineBP);
  whineBP.connect(whineGain);
  whineGain.connect(mixGain);

  // 아주 약한 비브라토/불안정성 (정적인 사인 톤 방지)
  const whineLFO = ctx.createOscillator();
  whineLFO.type = "sine";
  whineLFO.frequency.value = 6.2;
  const whineLFOGain = ctx.createGain();
  whineLFOGain.gain.value = profile.whineVibratoCents;
  whineLFO.connect(whineLFOGain);
  whineLFOGain.connect(whineOsc.detune);

  // ===== Mechanical metallic =====
  const mechHP = ctx.createBiquadFilter();
  mechHP.type = "highpass";
  mechHP.Q.value = 0.7;
  noiseSource.connect(mechHP);

  const mechSum = ctx.createGain();
  mechSum.gain.value = 1;
  mechSum.connect(mixGain);

  const mechBands = profile.mechResHz.map((hz) => {
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = profile.mechQ;
    bp.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.value = 0;
    mechHP.connect(bp);
    bp.connect(g);
    g.connect(mechSum);
    return { bp, g, baseHz: hz };
  });

  // start
  orderOscA.start();
  orderOscB.start();
  subOsc.start();
  harmOscA.start();
  harmOscB.start();
  noiseSource.start();
  whineOsc.start();
  whineLFO.start();

  return {
    profile,
    sources: [orderOscA, orderOscB, subOsc, harmOscA, harmOscB, noiseSource, whineOsc, whineLFO],
    nodes: [
      coreIn,
      coreDrive,
      coreShaper,
      coreLP,
      bodyRes,
      bodyResGain,
      orderGain,
      subGain,
      harmGain,
      raspHP,
      raspBP,
      raspDrive,
      raspShaper,
      raspLP,
      raspGain,
      whineBP,
      whineGain,
      whineLFOGain,
      mechHP,
      mechSum,
      ...mechBands.map((b) => b.bp),
      ...mechBands.map((b) => b.g)
    ],
    // refs
    orderOscA,
    orderOscB,
    subOsc,
    harmOscA,
    harmOscB,
    noiseSource,
    whineOsc,
    whineBP,
    whineGain,
    coreDrive,
    coreLP,
    bodyRes,
    bodyResGain,
    orderGain,
    subGain,
    harmGain,
    raspHP,
    raspBP,
    raspLP,
    raspDrive,
    raspGain,
    mechHP,
    mechBands
  };
}

async function prepareEngine(engineType) {
  await ensureContext();
  if (currentEngineType === engineType && engineNodes) return;
  stopEngine();
  currentEngineType = engineType;
  engineNodes = buildEngineNodes(getProfile(engineType));
  updateEngineSound(lastRpm, lastThrottle);
}

function setVolume(volume) {
  targetVolume = volume;
  if (volumeGain) {
    volumeGain.gain.setTargetAtTime(volume, getAudioContext().currentTime, 0.05);
  }
}

function setParam(param, value, now, tau) {
  // 값이 NaN이면 AudioParam이 터지니까 안전장치
  const safe = Number.isFinite(value) ? value : 0;
  param.setTargetAtTime(safe, now, tau);
}

function updateEngineSound(rpm, throttle) {
  if (!engineNodes) return;
  lastRpm = rpm;
  lastThrottle = throttle ?? lastThrottle;

  const ctx = getAudioContext();
  const p = engineNodes.profile;
  const now = ctx.currentTime;

  const r = clamp((rpm - MIN_RPM) / (MAX_RPM - MIN_RPM), 0, 1);
  const t = clamp(throttle ?? 0, 0, 1);

  const nyquist = ctx.sampleRate * 0.5;

  // 4-stroke firing frequency
  const firingFreq = (rpm / 60) * (p.cylinders / 2);
  const baseHz = clamp(firingFreq * pitchMul, 25, 2000);

  // ===== Frequencies =====
  setParam(engineNodes.orderOscA.frequency, baseHz, now, 0.04);
  setParam(engineNodes.orderOscB.frequency, baseHz, now, 0.04);
  setParam(engineNodes.subOsc.frequency, clamp(baseHz * 0.5, 20, 800), now, 0.06);
  setParam(engineNodes.harmOscA.frequency, baseHz, now, 0.05);
  setParam(engineNodes.harmOscB.frequency, baseHz, now, 0.05);

  // whine: baseHz의 배수 + 오프셋. 과도하게 올라가면 clamp.
  const whineHz = clamp(
    baseHz * p.whineMul + p.whineAddHz,
    p.whineMinHz,
    Math.min(p.whineMaxHz, nyquist * 0.92)
  );
  setParam(engineNodes.whineOsc.frequency, whineHz, now, 0.06);
  setParam(engineNodes.whineBP.frequency, whineHz, now, 0.08);

  // ===== Filters =====
  // core LP: rpm 올라갈수록 열리고, throttle 열릴수록 더 열리게
  let coreCut = lerpExp(p.coreLPHz[0], p.coreLPHz[1], r);
  coreCut *= 0.8 + 0.35 * t;
  coreCut = clamp(coreCut, 200, nyquist * 0.92);
  setParam(engineNodes.coreLP.frequency, coreCut, now, 0.10);

  // body resonance
  const bodyHz = clamp(lerpExp(p.bodyResHz[0], p.bodyResHz[1], r), 80, 900);
  setParam(engineNodes.bodyRes.frequency, bodyHz, now, 0.18);

  // rasp filters
  const raspHP = clamp(lerpExp(p.raspHPHz[0], p.raspHPHz[1], r), 60, 1200);
  const raspBP = clamp(lerpExp(p.raspBPHZ[0], p.raspBPHZ[1], r), 200, 4500);
  const raspLP = clamp(lerpExp(p.raspLPHz[0], p.raspLPHz[1], r), 1500, nyquist * 0.92);
  setParam(engineNodes.raspHP.frequency, raspHP, now, 0.12);
  setParam(engineNodes.raspBP.frequency, raspBP, now, 0.12);
  setParam(engineNodes.raspLP.frequency, raspLP, now, 0.14);

  // mechanical resonances: rpm 올라가면 약간 위로 쉬프트
  const mechShift = 0.92 + 0.22 * r;
  engineNodes.mechBands.forEach((band) => {
    const hz = clamp(band.baseHz * mechShift, 600, nyquist * 0.92);
    setParam(band.bp.frequency, hz, now, 0.22);
  });

  // ===== Drives =====
  const coreDrive = lerp(p.coreDrive[0], p.coreDrive[1], r) * (0.55 + 0.85 * t);
  const raspDrive = lerp(p.raspDrive[0], p.raspDrive[1], r) * (0.25 + 1.05 * t);
  setParam(engineNodes.coreDrive.gain, coreDrive, now, 0.10);
  setParam(engineNodes.raspDrive.gain, raspDrive, now, 0.10);

  // ===== Layer gains =====
  // order/sub은 저RPM에서 존재감. throttle이 많이 열리면 noise/rasp가 올라가면서 상대적으로 묻힘.
  const orderGain = lerp(p.orderGain[0], p.orderGain[1], r) * (0.88 - 0.25 * t);
  // sub는 고RPM에서 줄어들게
  const subFadeHigh = 1 - smoothstep(0.55, 1.0, r) * 0.85;
  const subGain = lerp(p.subGain[0], p.subGain[1], r) * (1 - 0.55 * t) * subFadeHigh;

  // harmonic은 중고RPM + 스로틀 열릴수록
  const harmGate = smoothstep(0.12, 0.55, r);
  const harmGain = lerp(p.harmGain[0], p.harmGain[1], r) * harmGate * (0.15 + 0.85 * Math.pow(t, 1.05));

  // rasp는 고RPM + 스로틀 열릴수록 급격히
  const raspGate = smoothstep(0.20, 0.70, r);
  const raspGain = lerp(p.raspGain[0], p.raspGain[1], r) * raspGate * Math.pow(t, 1.45);

  // whine은 rpm에 민감 (v10/v6에서 특히). rpm^1.6로 고RPM에서 확 뜨게.
  const whineGain = lerp(p.whineGain[0], p.whineGain[1], r) * Math.pow(r, 1.6) * (0.10 + 0.90 * t);

  // mechanical은 throttle과 rpm 둘 다에 반응하지만, rasp보단 완만
  const mechGate = 0.25 + 0.75 * smoothstep(0.08, 0.9, r);
  const mechGainTotal = lerp(p.mechGain[0], p.mechGain[1], r) * mechGate * (0.35 + 0.65 * t);

  setParam(engineNodes.orderGain.gain, orderGain, now, 0.07);
  setParam(engineNodes.subGain.gain, subGain, now, 0.08);
  setParam(engineNodes.harmGain.gain, harmGain, now, 0.08);
  setParam(engineNodes.raspGain.gain, raspGain, now, 0.08);
  setParam(engineNodes.whineGain.gain, whineGain, now, 0.08);

  // mechanical bands gain 분배
  const perBand = mechGainTotal / Math.max(1, engineNodes.mechBands.length);
  engineNodes.mechBands.forEach((band) => {
    setParam(band.g.gain, perBand, now, 0.10);
  });

  // body resonance는 스로틀 열릴수록 + 중RPM에서 더 살아나게
  const resGate = smoothstep(0.10, 0.65, r);
  const bodyResGain = (0.06 + 0.10 * t) * resGate;
  setParam(engineNodes.bodyResGain.gain, bodyResGain, now, 0.15);
}

function setPitchTransient(mult, durationMs) {
  pitchMul = mult;
  updateEngineSound(lastRpm, lastThrottle);
  if (pitchRecoverTimer) clearTimeout(pitchRecoverTimer);
  pitchRecoverTimer = setTimeout(() => {
    pitchMul = 1;
    updateEngineSound(lastRpm, lastThrottle);
    pitchRecoverTimer = undefined;
  }, Math.max(30, durationMs));
}

function applyShiftEnvelope(direction, gear, meta = {}) {
  if (!shiftGain) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const g = clamp((gear - 1) / 7, 0, 1);
  const t = clamp(meta.throttle ?? lastThrottle ?? 0, 0, 1);

  if (shiftGain.gain.cancelAndHoldAtTime) {
    shiftGain.gain.cancelAndHoldAtTime(now);
  } else {
    shiftGain.gain.cancelScheduledValues(now);
    shiftGain.gain.setValueAtTime(shiftGain.gain.value, now);
  }

  if (direction === "UP") {
    // ignition cut: 짧고 날카롭게
    const dip = lerp(0.10, 0.22, g); // 저단 더 깊게
    const tCut = lerp(0.085, 0.06, g); // 고단 더 짧게
    const tRecover = tCut + lerp(0.11, 0.075, g);

    shiftGain.gain.setValueAtTime(shiftGain.gain.value, now);
    shiftGain.gain.linearRampToValueAtTime(dip, now + tCut * 0.35);
    shiftGain.gain.linearRampToValueAtTime(1.0, now + tRecover);

    // pitch dip (톤이 순간 끊겼다가 재연결되는 느낌)
    setPitchTransient(0.92, Math.round(tRecover * 1000));
    playUpshiftChirp(gear, t, meta);
  } else {
    // downshift blip: dip은 약하게 + 살짝 부스트
    const dip = lerp(0.82, 0.90, g);
    const bump = lerp(1.06, 1.02, g);
    const tDip = 0.028;
    const tBump = lerp(0.16, 0.12, g);

    shiftGain.gain.setValueAtTime(shiftGain.gain.value, now);
    shiftGain.gain.linearRampToValueAtTime(dip, now + tDip);
    shiftGain.gain.linearRampToValueAtTime(bump, now + tDip + 0.045);
    shiftGain.gain.linearRampToValueAtTime(1.0, now + tDip + tBump);

    setPitchTransient(1.06, Math.round((tDip + tBump) * 1000));
    playDownshiftBlip(gear, t, meta);
  }
}

async function playUpshiftChirp(gear, throttle, meta = {}) {
  await ensureContext();
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const g = clamp((gear - 1) / 7, 0, 1);

  const dur = lerp(0.075, 0.055, g);
  const amp = (0.18 + 0.12 * throttle) * (0.9 - 0.15 * g);

  const osc = ctx.createOscillator();
  osc.type = "triangle";
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(amp, now + 0.010);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  const startHz = 1900 + 500 * (1 - g);
  const endHz = 900 + 300 * g;
  osc.frequency.setValueAtTime(startHz, now);
  osc.frequency.exponentialRampToValueAtTime(endHz, now + dur);

  // 고역 노이즈 “치익”
  const n = createNoiseSource(false);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 2600;
  hp.Q.value = 0.7;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 4200;
  bp.Q.value = 1.0;
  const ng = ctx.createGain();
  const nAmp = (0.16 + 0.16 * throttle) * (0.9 - 0.2 * g);
  ng.gain.setValueAtTime(0.0001, now);
  ng.gain.exponentialRampToValueAtTime(nAmp, now + 0.007);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  osc.connect(gain).connect(volumeGain);
  n.connect(hp).connect(bp).connect(ng).connect(volumeGain);

  osc.start(now);
  n.start(now);
  osc.stop(now + dur);
  n.stop(now + dur);

  setTimeout(() => {
    try {
      osc.disconnect();
      gain.disconnect();
      n.disconnect();
      hp.disconnect();
      bp.disconnect();
      ng.disconnect();
    } catch (e) {
      /* ignore */
    }
  }, (dur + 0.1) * 1000);
}

async function playDownshiftBlip(gear, throttle, meta = {}) {
  await ensureContext();
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const g = clamp((gear - 1) / 7, 0, 1);

  const dur = lerp(0.14, 0.11, g);
  const baseAmp = 0.20 + 0.10 * throttle;

  // rpm 점프가 큰 다운시프트일수록 좀 더 공격적으로
  const rpmDelta = (meta.rpmAfter ?? 0) - (meta.rpmBefore ?? 0);
  const deltaBoost = clamp(rpmDelta / 2500, 0, 0.35);
  const amp = baseAmp * (1 + deltaBoost);

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(amp, now + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  const startHz = 720 - 180 * g;
  const endHz = 220 + 60 * g;
  osc.frequency.setValueAtTime(startHz, now);
  osc.frequency.exponentialRampToValueAtTime(endHz, now + dur);

  const n = createNoiseSource(false);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1200 + 500 * (1 - g);
  bp.Q.value = 0.75;
  const ng = ctx.createGain();
  const nAmp = (0.22 + 0.12 * throttle) * (1 + deltaBoost);
  ng.gain.setValueAtTime(0.0001, now);
  ng.gain.exponentialRampToValueAtTime(nAmp, now + 0.016);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + dur);

  osc.connect(gain).connect(volumeGain);
  n.connect(bp).connect(ng).connect(volumeGain);

  osc.start(now);
  n.start(now);
  osc.stop(now + dur);
  n.stop(now + dur);

  // 아주 짧은 "pop" (백파이어 느낌 살짝)
  if (rpmDelta > 800) {
    const popDur = 0.035;
    const popNoise = createNoiseSource(false);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700;
    lp.Q.value = 0.9;
    const popShaper = ctx.createWaveShaper();
    popShaper.curve = makeTanhCurve(3.6);
    popShaper.oversample = "4x";
    const popG = ctx.createGain();
    popG.gain.setValueAtTime(0.0001, now);
    popG.gain.exponentialRampToValueAtTime(0.18, now + 0.006);
    popG.gain.exponentialRampToValueAtTime(0.0001, now + popDur);

    popNoise.connect(lp).connect(popShaper).connect(popG).connect(volumeGain);
    popNoise.start(now);
    popNoise.stop(now + popDur);

    setTimeout(() => {
      try {
        popNoise.disconnect();
        lp.disconnect();
        popShaper.disconnect();
        popG.disconnect();
      } catch (e) {
        /* ignore */
      }
    }, (popDur + 0.1) * 1000);
  }

  setTimeout(() => {
    try {
      osc.disconnect();
      gain.disconnect();
      n.disconnect();
      bp.disconnect();
      ng.disconnect();
    } catch (e) {
      /* ignore */
    }
  }, (dur + 0.1) * 1000);
}

async function handleEngineState(message) {
  const { rpm, throttle, settings } = message;
  if (!settings?.enabled) {
    stopEngine();
    return;
  }

  await prepareEngine(settings.engineType || "v10");
  setVolume(settings.volume ?? 0.6);
  updateEngineSound(rpm, throttle ?? lastThrottle);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "ENGINE_STATE") {
    handleEngineState(message);
  } else if (message.type === "STOP_AUDIO") {
    stopEngine();
  } else if (message.type === "SETTINGS") {
    if (message.settings?.volume !== undefined) {
      setVolume(message.settings.volume);
    }
    if (message.settings?.engineType) {
      prepareEngine(message.settings.engineType);
    }
    if (message.settings?.enabled === false) {
      stopEngine();
    }
  } else if (message.type === "SHIFT") {
    applyShiftEnvelope(message.direction, message.gear, message);
  }
});
