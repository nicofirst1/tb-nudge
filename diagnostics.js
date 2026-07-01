function renderDecisions(decisions) {
  const el = document.getElementById("decisions");
  el.innerHTML = "";
  for (const d of decisions) {
    const row = document.createElement("div");
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
  document.getElementById("decisions").innerHTML = "";
  event.target.disabled = false;
});
