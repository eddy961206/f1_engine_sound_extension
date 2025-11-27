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
  const { rpm, settings } = message;
  if (!settings.enabled) return;
  await ensureEngineLoop(settings.engineType);
  setVolume(settings.volume ?? 0.6);
  updateEngineMix(rpm);
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
  }
});
