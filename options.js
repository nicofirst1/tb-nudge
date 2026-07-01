const DEFAULTS = { hoursThreshold: 30, lookbackDays: 14 };

async function load() {
  const settings = await browser.storage.local.get(DEFAULTS);
  document.getElementById("hoursThreshold").value = settings.hoursThreshold;
  document.getElementById("lookbackDays").value = settings.lookbackDays;
}

document.getElementById("save").addEventListener("click", async () => {
  await browser.storage.local.set({
    hoursThreshold: Number(document.getElementById("hoursThreshold").value) || DEFAULTS.hoursThreshold,
    lookbackDays: Number(document.getElementById("lookbackDays").value) || DEFAULTS.lookbackDays,
  });
  const status = document.getElementById("status");
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 1500);
});

load();
