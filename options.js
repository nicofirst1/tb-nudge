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

async function loadStatus() {
  const manifest = browser.runtime.getManifest();
  document.getElementById("version").textContent = manifest.version;

  const status = await browser.runtime.sendMessage("get-status");
  document.getElementById("modelStatus").textContent = status.modelLoaded
    ? `trained (${status.vocabSize} words)`
    : "not trained yet - run train.js";
  document.getElementById("tagStatus").textContent = status.tagKey || "not created yet";
}

function renderDecisions(decisions) {
  const el = document.getElementById("decisions");
  el.innerHTML = "";
  for (const d of decisions) {
    const row = document.createElement("div");
    row.style.marginTop = "4px";
    const subjectSpan = document.createElement("b");
    subjectSpan.textContent = d.subject || "(no subject)";
    row.appendChild(subjectSpan);
    row.appendChild(document.createTextNode(` — ${d.outcome}`));
    if (d.words && d.words.length) {
      row.appendChild(document.createTextNode(` (${d.words.join(", ")})`));
    }
    el.appendChild(row);
  }
}

document.getElementById("runNow").addEventListener("click", async (event) => {
  event.target.disabled = true;
  const resultEl = document.getElementById("runResult");
  resultEl.textContent = "Running...";
  const result = await browser.runtime.sendMessage("run-check-now");
  resultEl.textContent =
    `Scanned ${result.scanned} new message(s): ${result.notified} nudged, ` +
    `${result.alreadyReplied} already had a reply, ` +
    `${result.suppressedByClassifier} suppressed by the classifier.`;
  renderDecisions(result.decisions);
  event.target.disabled = false;
});

document.getElementById("reset").addEventListener("click", async (event) => {
  event.target.disabled = true;
  const resultEl = document.getElementById("runResult");
  resultEl.textContent = "Resetting...";
  await browser.runtime.sendMessage("reset-handled");
  resultEl.textContent = 'Reset. Click "Run check now" to re-scan everything in the window.';
  event.target.disabled = false;
});

load();
loadStatus();
