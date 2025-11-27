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
  }
});
