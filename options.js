const DEFAULTS = { hoursThreshold: 30, lookbackDays: 14 };

async function load() {
  const settings = await browser.storage.local.get(DEFAULTS);
  document.getElementById("hoursThreshold").value = settings.hoursThreshold;
  document.getElementById("lookbackDays").value = settings.lookbackDays;
}

async function saveSettings() {
  await browser.storage.local.set({
    hoursThreshold: Number(document.getElementById("hoursThreshold").value) || DEFAULTS.hoursThreshold,
    lookbackDays: Number(document.getElementById("lookbackDays").value) || DEFAULTS.lookbackDays,
  });
  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 1500);
}

document.getElementById("hoursThreshold").addEventListener("change", saveSettings);
document.getElementById("lookbackDays").addEventListener("change", saveSettings);

async function loadStatus() {
  const status = await browser.runtime.sendMessage("get-status");
  document.getElementById("modelStatus").textContent = status.modelLoaded
    ? `trained (${status.vocabSize} words)`
    : "not trained yet - run train.js";
  document.getElementById("tagStatus").textContent = status.tagKey || "not created yet";
}

load();
loadStatus();
