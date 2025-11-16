const toggle = document.getElementById("engineToggle");
const gearText = document.getElementById("gearText");
const rpmText = document.getElementById("rpmText");
const volumeRange = document.getElementById("volumeRange");
const volumeValue = document.getElementById("volumeValue");
const openOptionsButton = document.getElementById("openOptions");

function formatRpm(value) {
  return value.toLocaleString("ko-KR");
}

function refreshState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
    if (!response) return;
    toggle.checked = response.enabled;
    gearText.textContent = `현재 기어: ${response.gear}단`;
    rpmText.textContent = `RPM: ${formatRpm(response.rpm)}`;
    const volumePercent = Math.round((response.settings.volume ?? 0.6) * 100);
    volumeRange.value = volumePercent;
    volumeValue.textContent = `${volumePercent}%`;
  });
}

toggle.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "TOGGLE_ENABLED", enabled: toggle.checked });
});

volumeRange.addEventListener("input", () => {
  const percent = Number(volumeRange.value);
  volumeValue.textContent = `${percent}%`;
  chrome.storage.sync.set({ volume: percent / 100 });
});

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refreshState();
setInterval(refreshState, 1000);
