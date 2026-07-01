const SECTIONS = [
  { outcome: "nudged", title: "Nudged" },
  { outcome: "already replied", title: "Already replied" },
  { outcome: "suppressed", title: "Suppressed" },
];

async function openByHeaderMessageId(headerMessageId, folders) {
  const messageId = await resolveCurrentMessageId(headerMessageId, folders);
  if (!messageId) {
    alert("Could not find this email anymore - it may have moved or been deleted.");
    return;
  }
  await openMessageInTab(messageId);
}

// A row-action button that sends a correction (label 1 for suppressed misses,
// label 0 for wrong nudges) and reports the result inline.
function correctionButton(d, type, text, title) {
  const btn = document.createElement("button");
  btn.textContent = text;
  btn.title = title;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      const result = await browser.runtime.sendMessage({ type, headerMessageId: d.headerMessageId });
      btn.textContent = result.ok ? "Corrected" : `Failed: ${result.error}`;
    } catch (err) {
      console.error("tb-nudge: correction failed", d, err);
      btn.textContent = "Failed";
    }
  });
  return btn;
}

function buildTable(items) {
  const table = document.createElement("table");
  for (const d of items) {
    const row = document.createElement("tr");
    row.className = "clickable";
    row.title = "Open this email";
    row.addEventListener("click", async () => {
      try {
        // Re-resolve the CURRENT message.id from the stable Message-ID header
        // instead of trusting d.id, which can go stale (IMAP resync/reindex)
        // and throw NS_MSG_ERROR_FOLDER_MISSING when opened. Scoped to Sent
        // folders specifically - see resolveCurrentMessageId in mailapi.js.
        const sentFolders = await browser.folders.query({ specialUse: ["sent"] });
        await openByHeaderMessageId(d.headerMessageId, sentFolders);
      } catch (err) {
        console.error("tb-nudge: failed to open message", d, err);
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

    const actionCell = document.createElement("td");
    if (d.outcome === "suppressed") {
      actionCell.appendChild(correctionButton(d, "correct-suppression", "✓ Needed reply", "Tag it now, and remember it as a training correction"));
    } else if (d.outcome === "nudged") {
      actionCell.appendChild(correctionButton(d, "correct-nudge", "✗ Didn't need reply", "Untag it now, and remember it as a training correction"));
    } else if (d.outcome === "already replied" && d.replyHeaderMessageId) {
      const link = document.createElement("a");
      link.textContent = "View reply →";
      link.href = "#";
      link.addEventListener("click", async (event) => {
        event.stopPropagation();
        event.preventDefault();
        try {
          const inboxFolders = await browser.folders.query({ specialUse: ["inbox"] });
          await openByHeaderMessageId(d.replyHeaderMessageId, inboxFolders);
        } catch (err) {
          console.error("tb-nudge: failed to open reply", d, err);
          alert(`Could not open the reply: ${err.message}`);
        }
      });
      actionCell.appendChild(link);
    }
    row.appendChild(actionCell);

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

    // Collapsible group (native <details>). "Already replied" is the big,
    // least-actionable pile, so start it folded; the two you label stay open.
    const group = document.createElement("details");
    group.open = section.outcome !== "already replied";
    const summary = document.createElement("summary");
    summary.textContent = `${section.title} (${items.length})`;
    group.appendChild(summary);
    group.appendChild(buildTable(items));
    el.appendChild(group);
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
    `${result.suppressedByClassifier} suppressed by the classifier` +
    `${result.deduped ? `, ${result.deduped} skipped as same-thread duplicates` : ""}.`;
  renderDecisions(result.decisions);
  event.target.disabled = false;
});

document.getElementById("scanAll").addEventListener("click", (event) => {
  const btn = event.target;
  btn.disabled = true;
  const logEl = document.getElementById("scanLog");
  logEl.style.display = "block";
  logEl.textContent = "Starting whole-mailbox scan (no notifications)...\n";
  const log = (msg) => {
    logEl.textContent += msg + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  };

  const port = browser.runtime.connect({ name: "label-scan" });
  port.onMessage.addListener((info) => {
    if (info.phase === "indexing") {
      if (info.text) log(info.text);
    } else if (info.phase === "scanning") {
      if (info.scanned === 0) log(`indexing done. Scanning ${info.total} sent messages...`);
      else log(`  ${info.scanned}/${info.total} scanned (${info.notified} nudge, ${info.alreadyReplied} replied, ${info.suppressedByClassifier} suppressed, ${info.deduped} deduped)`);
    } else if (info.phase === "error") {
      log(`ERROR: ${info.error}`);
      btn.disabled = false;
      port.disconnect();
    } else if (info.phase === "done") {
      log(`Done. ${info.scanned} scanned: ${info.notified} would-nudge, ${info.alreadyReplied} replied, ${info.suppressedByClassifier} suppressed, ${info.deduped} deduped.`);
      log(`Now correct the wrong rows below, then retrain.`);
      renderDecisions(info.decisions);
      btn.disabled = false;
      port.disconnect();
    }
  });
  port.onDisconnect.addListener(() => {
    btn.disabled = false;
  });
  port.postMessage("start");
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

document.getElementById("downloadCorrections").addEventListener("click", async () => {
  const corrections = await browser.runtime.sendMessage("get-corrections");
  if (!corrections || corrections.length === 0) {
    alert('No corrections yet - click "✓ Needed reply" on a suppressed row, or "✗ Didn\'t need reply" on a nudged row first.');
    return;
  }
  await downloadJson(corrections, "tb-nudge-corrections.json");
});
