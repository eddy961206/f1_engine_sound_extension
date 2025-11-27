const MIN_RPM = 1000;
const MAX_RPM = 11000;
const ENGINE_FILES = {
  v6: "assets/engine_v10_loop.mp3",
  v8: "assets/engine_v10_loop.mp3",
  v10: "assets/engine_v10_loop.mp3",
  v12: "assets/engine_v10_loop.mp3"
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
let gainNode;
let engineLayers = [];
const engineBuffers = new Map();
const shiftBuffers = new Map();
let currentEngineType = "v10";
let targetVolume = 0.6;
let lastEngineState = { rpm: MIN_RPM, gear: 1, playbackRate: MIN_RATE };
let shiftAutomationEndTime = 0;

async function ensureContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
    gainNode = audioContext.createGain();
    gainNode.gain.value = targetVolume;
    gainNode.connect(audioContext.destination);
  }
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
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

function getAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
    gainNode = audioContext.createGain();
    gainNode.gain.value = targetVolume;
    gainNode.connect(audioContext.destination);
  }
  return audioContext;
}

async function ensureEngineLoop(engineType) {
  await ensureContext();
  if (engineLayers.length && currentEngineType === engineType) return;
  const filePath = ENGINE_FILES[engineType] || ENGINE_FILES.v10;
  currentEngineType = engineType;
  const buffer = await fetchBuffer(filePath, engineBuffers);
  stopEngineLoop();
  engineLayers = RPM_SEGMENTS.map((segment) => {
    const source = getAudioContext().createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const layerGain = getAudioContext().createGain();
    layerGain.gain.value = 0;
    source.connect(layerGain);
    layerGain.connect(gainNode);
    source.start();
    return { segment, source, gain: layerGain };
  });
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
  engineLayers = [];
}

function setVolume(volume) {
  targetVolume = volume;
  if (gainNode) {
    gainNode.gain.setTargetAtTime(volume, getAudioContext().currentTime, 0.05);
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
  source.connect(gainNode);
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
      ensureEngineLoop(message.settings.engineType);
    }
  } else if (message.type === "SHIFT") {
    playShiftSound(message.direction);
    applyShiftAutomation(message.direction, message.gear);
  }
});
