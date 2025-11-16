const MIN_RPM = 1000;
const MAX_RPM = 11000;
const MAX_KPS_BASE = 12;
const MIN_GEAR = 1;
const MAX_GEAR = 8;
const ENGINE_UPDATE_INTERVAL = 200;
const GEAR_UP_RPM = [0, 4000, 5500, 7000, 8000, 9000, 10000, 11000];
const GEAR_DOWN_RPM = [0, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
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
let currentRpm = MIN_RPM;
let currentGear = MIN_GEAR;
let offscreenActive = false;
let lastSentState = { rpm: 0, gear: 0 };

async function initSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_DEFAULT);
  settings = { ...SETTINGS_DEFAULT, ...stored };
  if (settings.enabled) {
    await ensureOffscreenDocument();
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
      sendStopToOffscreen();
    } else {
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
    if (!settings.enabled) return;
    lastKps = message.kps;
    return;
  }
  if (message?.type === "GET_STATE") {
    sendResponse({
      type: "STATE",
      enabled: settings.enabled,
      rpm: Math.round(currentRpm),
      gear: currentGear,
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

function updateEngineState() {
  if (!settings.enabled) {
    smoothTowardsIdle();
    return;
  }
  const ratioBase = SENSITIVITY_RATIO[settings.sensitivity] || 1;
  const effectiveMax = MAX_KPS_BASE * ratioBase;
  const ratio = clamp(lastKps / effectiveMax, 0, 1);
  const targetRpm = MIN_RPM + (MAX_RPM - MIN_RPM) * ratio;
  currentRpm += (targetRpm - currentRpm) * 0.25;
  updateGear();
  maybeSendState();
}

function smoothTowardsIdle() {
  currentRpm += (MIN_RPM - currentRpm) * 0.15;
  if (Math.abs(currentRpm - MIN_RPM) < 5) {
    currentRpm = MIN_RPM;
  }
  if (currentGear !== MIN_GEAR && currentRpm <= GEAR_DOWN_RPM[currentGear]) {
    currentGear--;
  }
  maybeSendState();
}

function updateGear() {
  if (currentGear < MAX_GEAR && currentRpm >= GEAR_UP_RPM[currentGear]) {
    currentGear++;
    chrome.runtime.sendMessage({ type: "SHIFT", direction: "UP", gear: currentGear });
  } else if (currentGear > MIN_GEAR && currentRpm <= GEAR_DOWN_RPM[currentGear]) {
    currentGear--;
    chrome.runtime.sendMessage({ type: "SHIFT", direction: "DOWN", gear: currentGear });
  }
}

function maybeSendState() {
  const roundedRpm = Math.round(currentRpm);
  if (lastSentState.rpm === roundedRpm && lastSentState.gear === currentGear) return;
  lastSentState = { rpm: roundedRpm, gear: currentGear };
  if (!settings.enabled) {
    sendStopToOffscreen();
    return;
  }
  ensureOffscreenDocument().then(() => {
    chrome.runtime.sendMessage({
      type: "ENGINE_STATE",
      rpm: roundedRpm,
      gear: currentGear,
      settings
    });
  });
}

initSettings();
setInterval(updateEngineState, ENGINE_UPDATE_INTERVAL);
