const MIN_RPM = 1000;
const MAX_RPM = 11000;
const MIN_RATE = 0.6;
const MAX_RATE = 2.2;
const ENGINE_FILES = {
  v6: "assets/engine_v10_loop.mp3",
  v8: "assets/engine_v10_loop.mp3",
  v10: "assets/engine_v10_loop.mp3",
  v12: "assets/engine_v10_loop.mp3"
};
const SHIFT_FILES = {
  UP: "assets/shift_up.mp3",
  DOWN: "assets/shift_down.mp3"
};

let audioContext;
let gainNode;
let engineSource;
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
  if (engineSource && currentEngineType === engineType) return;
  const filePath = ENGINE_FILES[engineType] || ENGINE_FILES.v10;
  currentEngineType = engineType;
  const buffer = await fetchBuffer(filePath, engineBuffers);
  if (engineSource) {
    try {
      engineSource.stop();
    } catch (error) {
      // 이미 정지된 경우 무시
    }
    engineSource.disconnect();
  }
  engineSource = getAudioContext().createBufferSource();
  engineSource.buffer = buffer;
  engineSource.loop = true;
  engineSource.connect(gainNode);
  engineSource.start();
}

function stopEngineLoop() {
  if (engineSource) {
    try {
      engineSource.stop();
    } catch (error) {
      // 이미 정지된 경우 무시
    }
    engineSource.disconnect();
    engineSource = null;
  }
}

function setPlaybackRate(rate) {
  if (!engineSource) return;
  engineSource.playbackRate.value = rate;
}

function setVolume(volume) {
  targetVolume = volume;
  if (gainNode) {
    gainNode.gain.setTargetAtTime(volume, getAudioContext().currentTime, 0.05);
  }
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
