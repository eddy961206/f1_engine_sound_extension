const MIN_RPM = 1000;
const MAX_RPM = 11000;

const ENGINE_PROFILES = {
  v6: {
    cylinders: 6,
    baseWave: "triangle",
    buzzWave: "sawtooth",
    detuneCents: 4,
    buzzHarmonic: 2.4,
    baseGain: [0.16, 0.28],
    subGain: [0.28, 0.12],
    buzzGain: [0.05, 0.18],
    noiseGain: [0.02, 0.12],
    bodyFilter: [500, 2600],
    noiseFilter: [1200, 6200],
    bodyQ: 0.7,
    noiseQ: 0.8,
    drive: [0.9, 1.4],
    distortion: 24
  },
  v8: {
    cylinders: 8,
    baseWave: "square",
    buzzWave: "sawtooth",
    detuneCents: 6,
    buzzHarmonic: 2.1,
    baseGain: [0.2, 0.33],
    subGain: [0.32, 0.16],
    buzzGain: [0.08, 0.22],
    noiseGain: [0.03, 0.15],
    bodyFilter: [450, 2400],
    noiseFilter: [1200, 6800],
    bodyQ: 0.8,
    noiseQ: 0.9,
    drive: [1.0, 1.6],
    distortion: 28
  },
  v10: {
    cylinders: 10,
    baseWave: "sawtooth",
    buzzWave: "square",
    detuneCents: 7,
    buzzHarmonic: 2.7,
    baseGain: [0.18, 0.3],
    subGain: [0.22, 0.1],
    buzzGain: [0.1, 0.28],
    noiseGain: [0.03, 0.18],
    bodyFilter: [600, 3400],
    noiseFilter: [1500, 8200],
    bodyQ: 0.7,
    noiseQ: 1.1,
    drive: [1.1, 1.8],
    distortion: 32
  },
  v12: {
    cylinders: 12,
    baseWave: "sawtooth",
    buzzWave: "triangle",
    detuneCents: 5,
    buzzHarmonic: 2.2,
    baseGain: [0.16, 0.28],
    subGain: [0.2, 0.08],
    buzzGain: [0.08, 0.24],
    noiseGain: [0.02, 0.14],
    bodyFilter: [650, 3600],
    noiseFilter: [1400, 7600],
    bodyQ: 0.6,
    noiseQ: 1.0,
    drive: [0.95, 1.6],
    distortion: 26
  }
};

let audioContext;
let mixGain;
let shiftGain;
let volumeGain;
let masterGain;

let currentEngineType = "v10";
let engineNodes = null;
let targetVolume = 0.6;
let lastRpm = MIN_RPM;
let shiftPitchMul = 1;
let shiftRecoverTimer;
let noiseBuffer;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function lerp(min, max, t) {
  return min + (max - min) * t;
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

    mixGain.connect(shiftGain);
    shiftGain.connect(volumeGain);
    volumeGain.connect(masterGain);
    masterGain.connect(audioContext.destination);
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
}

function getAudioContext() {
  if (!audioContext) {
    ensureContext();
  }
  return audioContext;
}

function getNoiseBuffer() {
  if (noiseBuffer) return noiseBuffer;
  const ctx = getAudioContext();
  const length = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.9;
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

function makeDistortionCurve(amount) {
  const size = 2048;
  const curve = new Float32Array(size);
  const k = amount;
  for (let i = 0; i < size; i++) {
    const x = (i * 2) / size - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
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
    source.disconnect();
  });
  engineNodes.nodes.forEach((node) => node.disconnect());
  engineNodes = null;
  shiftPitchMul = 1;
  if (shiftRecoverTimer) {
    clearTimeout(shiftRecoverTimer);
    shiftRecoverTimer = undefined;
  }
}

function buildEngineNodes(profile) {
  const ctx = getAudioContext();

  const preGain = ctx.createGain();
  const driveGain = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  shaper.curve = makeDistortionCurve(profile.distortion);
  shaper.oversample = "4x";

  const bodyFilter = ctx.createBiquadFilter();
  bodyFilter.type = "lowpass";
  bodyFilter.Q.value = profile.bodyQ;

  preGain.connect(driveGain);
  driveGain.connect(shaper);
  shaper.connect(bodyFilter);
  bodyFilter.connect(mixGain);

  const baseA = ctx.createOscillator();
  baseA.type = profile.baseWave;
  const baseB = ctx.createOscillator();
  baseB.type = profile.baseWave;
  baseB.detune.value = profile.detuneCents;

  const sub = ctx.createOscillator();
  sub.type = "sine";

  const buzz = ctx.createOscillator();
  buzz.type = profile.buzzWave;

  const baseGain = ctx.createGain();
  const subGain = ctx.createGain();
  const buzzGain = ctx.createGain();

  baseGain.gain.value = 0;
  subGain.gain.value = 0;
  buzzGain.gain.value = 0;

  baseA.connect(baseGain).connect(preGain);
  baseB.connect(baseGain);
  sub.connect(subGain).connect(preGain);
  buzz.connect(buzzGain).connect(preGain);

  const noiseSource = createNoiseSource();
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = "bandpass";
  noiseFilter.Q.value = profile.noiseQ;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;
  noiseSource.connect(noiseFilter).connect(noiseGain).connect(mixGain);

  baseA.start();
  baseB.start();
  sub.start();
  buzz.start();
  noiseSource.start();

  return {
    profile,
    sources: [baseA, baseB, sub, buzz, noiseSource],
    nodes: [
      preGain,
      driveGain,
      shaper,
      bodyFilter,
      baseGain,
      subGain,
      buzzGain,
      noiseFilter,
      noiseGain
    ],
    baseA,
    baseB,
    sub,
    buzz,
    baseGain,
    subGain,
    buzzGain,
    noiseSource,
    noiseFilter,
    noiseGain,
    bodyFilter,
    driveGain
  };
}

async function prepareEngine(engineType) {
  await ensureContext();
  if (currentEngineType === engineType && engineNodes) return;
  stopEngine();
  currentEngineType = engineType;
  engineNodes = buildEngineNodes(getProfile(engineType));
  updateEngineSound(lastRpm);
}

function setVolume(volume) {
  targetVolume = volume;
  if (volumeGain) {
    volumeGain.gain.setTargetAtTime(volume, getAudioContext().currentTime, 0.05);
  }
}

function updateEngineSound(rpm) {
  if (!engineNodes) return;
  lastRpm = rpm;
  const ctx = getAudioContext();
  const profile = engineNodes.profile;
  const normalized = clamp((rpm - MIN_RPM) / (MAX_RPM - MIN_RPM), 0, 1);

  const firingFreq = (rpm / 60) * (profile.cylinders / 2);
  const baseFreq = clamp(firingFreq, 30, 2000) * shiftPitchMul;
  const now = ctx.currentTime;

  engineNodes.baseA.frequency.setTargetAtTime(baseFreq, now, 0.06);
  engineNodes.baseB.frequency.setTargetAtTime(baseFreq, now, 0.06);
  engineNodes.sub.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.06);
  engineNodes.buzz.frequency.setTargetAtTime(baseFreq * profile.buzzHarmonic, now, 0.06);

  const baseGain = lerp(profile.baseGain[0], profile.baseGain[1], normalized);
  const subGain = lerp(profile.subGain[0], profile.subGain[1], normalized);
  const buzzGain = lerp(profile.buzzGain[0], profile.buzzGain[1], normalized);
  const noiseGain = lerp(profile.noiseGain[0], profile.noiseGain[1], normalized);

  engineNodes.baseGain.gain.setTargetAtTime(baseGain, now, 0.08);
  engineNodes.subGain.gain.setTargetAtTime(subGain, now, 0.08);
  engineNodes.buzzGain.gain.setTargetAtTime(buzzGain, now, 0.08);
  engineNodes.noiseGain.gain.setTargetAtTime(noiseGain, now, 0.08);

  const bodyCutoff = lerp(profile.bodyFilter[0], profile.bodyFilter[1], normalized);
  const noiseCutoff = lerp(profile.noiseFilter[0], profile.noiseFilter[1], normalized);

  engineNodes.bodyFilter.frequency.setTargetAtTime(bodyCutoff, now, 0.1);
  engineNodes.noiseFilter.frequency.setTargetAtTime(noiseCutoff, now, 0.1);

  const drive = lerp(profile.drive[0], profile.drive[1], normalized);
  engineNodes.driveGain.gain.setTargetAtTime(drive, now, 0.1);
}

function applyShiftEnvelope(direction, gear) {
  if (!shiftGain) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const dip = gear <= 2 ? 0.6 : 0.8;

  if (shiftGain.gain.cancelAndHoldAtTime) {
    shiftGain.gain.cancelAndHoldAtTime(now);
  } else {
    shiftGain.gain.cancelScheduledValues(now);
  }
  shiftGain.gain.setValueAtTime(shiftGain.gain.value, now);
  shiftGain.gain.linearRampToValueAtTime(dip, now + 0.05);
  shiftGain.gain.linearRampToValueAtTime(1, now + 0.3);

  if (shiftRecoverTimer) clearTimeout(shiftRecoverTimer);
  shiftPitchMul = direction === "DOWN" ? 0.86 : 0.9;
  updateEngineSound(lastRpm);

  shiftRecoverTimer = setTimeout(() => {
    shiftPitchMul = 1;
    updateEngineSound(lastRpm);
  }, 200);
}

async function playShiftSound(direction) {
  await ensureContext();
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const duration = 0.22;

  const osc = ctx.createOscillator();
  osc.type = direction === "DOWN" ? "sawtooth" : "triangle";
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.35, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  const startFreq = direction === "DOWN" ? 720 : 620;
  const endFreq = direction === "DOWN" ? 260 : 1100;
  osc.frequency.setValueAtTime(startFreq, now);
  osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration);

  const noiseSource = createNoiseSource(false);
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = "bandpass";
  noiseFilter.frequency.value = direction === "DOWN" ? 900 : 1800;
  noiseFilter.Q.value = 0.8;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.2, now + 0.03);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain).connect(volumeGain);
  noiseSource.connect(noiseFilter).connect(noiseGain).connect(volumeGain);

  osc.start(now);
  noiseSource.start(now);
  osc.stop(now + duration);
  noiseSource.stop(now + duration);

  setTimeout(() => {
    osc.disconnect();
    gain.disconnect();
    noiseSource.disconnect();
    noiseFilter.disconnect();
    noiseGain.disconnect();
  }, (duration + 0.1) * 1000);
}

async function handleEngineState(message) {
  const { rpm, settings } = message;
  if (!settings.enabled) {
    stopEngine();
    return;
  }

  await prepareEngine(settings.engineType || "v10");
  setVolume(settings.volume ?? 0.6);
  updateEngineSound(rpm);
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
    applyShiftEnvelope(message.direction, message.gear);
    playShiftSound(message.direction);
  }
});
