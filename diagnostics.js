const SECTIONS = [
  { outcome: "nudged", title: "Nudged" },
  { outcome: "already replied", title: "Already replied" },
  { outcome: "suppressed", title: "Suppressed" },
];

function buildTable(items) {
  const table = document.createElement("table");
  for (const d of items) {
    const row = document.createElement("tr");
    row.className = "clickable";
    row.title = "Open this email";
    row.addEventListener("click", async () => {
      try {
        // Force a body fetch before opening - messageDisplay.open() seems not
        // to trigger the same on-demand IMAP body fetch that clicking a
        // message in the normal UI does, leaving the body blank.
        await browser.messages.getFull(d.id, { decodeContent: true });
        await browser.messageDisplay.open({ messageId: d.id, location: "window" });
      } catch (err) {
        console.error("tb-nudge: failed to open message", d.id, err);
        alert(`Could not open this email: ${err.message}`);
      }
    });

    const subjectCell = document.createElement("td");
    subjectCell.textContent = d.subject || "(no subject)";
    row.appendChild(subjectCell);

    const reasonCell = document.createElement("td");
    reasonCell.className = "reason";
    reasonCell.textContent = d.words && d.words.length ? d.words.join(", ") : "—";
    row.appendChild(reasonCell);

    table.appendChild(row);
  }
  return table;
}

function renderDecisions(decisions) {
  const el = document.getElementById("decisions");
  el.innerHTML = "";
  for (const section of SECTIONS) {
    const items = decisions.filter((d) => d.outcome === section.outcome);
    if (items.length === 0) continue;

    const heading = document.createElement("h3");
    heading.textContent = `${section.title} (${items.length})`;
    el.appendChild(heading);
    el.appendChild(buildTable(items));
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
