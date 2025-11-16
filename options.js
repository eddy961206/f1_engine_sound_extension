const DEFAULTS = {
  engineType: "v10",
  volume: 0.6,
  sensitivity: "medium"
};

const engineTypeSelect = document.getElementById("engineType");
const volumeSlider = document.getElementById("defaultVolume");
const volumeDisplay = document.getElementById("volumeDisplay");
const sensitivitySelect = document.getElementById("sensitivity");
const saveButton = document.getElementById("saveButton");
const statusEl = document.getElementById("status");

function updateVolumeDisplay(value) {
  volumeDisplay.textContent = `${value}%`;
}

function loadSettings() {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    engineTypeSelect.value = stored.engineType;
    const percent = Math.round((stored.volume ?? DEFAULTS.volume) * 100);
    volumeSlider.value = percent;
    updateVolumeDisplay(percent);
    sensitivitySelect.value = stored.sensitivity;
  });
}

function saveSettings() {
  const payload = {
    engineType: engineTypeSelect.value,
    volume: Number(volumeSlider.value) / 100,
    sensitivity: sensitivitySelect.value
  };
  chrome.storage.sync.set(payload, () => {
    statusEl.textContent = "설정을 저장했습니다.";
    setTimeout(() => {
      statusEl.textContent = "";
    }, 1500);
  });
}

volumeSlider.addEventListener("input", (event) => {
  updateVolumeDisplay(event.target.value);
});

saveButton.addEventListener("click", saveSettings);

loadSettings();
