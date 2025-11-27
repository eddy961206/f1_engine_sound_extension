const WINDOW_MS = 1200;
const REPORT_INTERVAL = 250;
let pressedTimestamps = [];
let enabled = true;
let lastKey = "";
let lastReportedKps = -1;

chrome.storage.sync.get({ enabled: true }, (items) => {
  enabled = items.enabled;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.enabled) return;
  enabled = changes.enabled.newValue;
  if (!enabled) {
    pressedTimestamps = [];
    lastReportedKps = -1;
  }
});

window.addEventListener(
  "keydown",
  (event) => {
    if (!enabled) return;
    const now = Date.now();
    pressedTimestamps.push(now);
    lastKey = event.key;
  },
  { capture: true }
);

setInterval(() => {
  if (!enabled) return;
  const cutoff = Date.now() - WINDOW_MS;
  while (pressedTimestamps.length && pressedTimestamps[0] < cutoff) {
    pressedTimestamps.shift();
  }
  const windowSeconds = WINDOW_MS / 1000;
  const kps = pressedTimestamps.length / windowSeconds;
  if (Math.abs(kps - lastReportedKps) < 0.1) {
    return;
  }
  lastReportedKps = kps;
  chrome.runtime.sendMessage({ type: "KPS_UPDATE", kps, lastKey });
}, REPORT_INTERVAL);
