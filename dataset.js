const STORAGE_KEY = "lastDatasetInfo";

// lookbackDays: -1 means no date limit at all (mine the entire mailbox).
async function buildDataset(log, lookbackDays) {
  const cutoff = lookbackDays === -1 ? undefined : new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);
  const sentFolders = await browser.folders.query({ specialUse: ["sent"] });
  const inboxFolders = await browser.folders.query({ specialUse: ["inbox"] });

  log(cutoff ? "Indexing inbox (one pass, this is the slow part)..." : "Indexing entire inbox (no date limit - this may take a while)...");
  const replyIndex = await buildReplyIndex(inboxFolders, cutoff, log);

  const rows = [];
  let scanned = 0;
  let skippedAmbiguous = 0;

  for (const folder of sentFolders) {
    const queryInfo = { folderId: folder.id };
    if (cutoff) queryInfo.fromDate = cutoff;
    const list = await browser.messages.query(queryInfo);
    const messages = await collectAll(list);

    for (const message of messages) {
      scanned++;
      if (scanned % 25 === 0) {
        log(`scanned ${scanned} sent messages, collected ${rows.length} rows...`);
      }

      const ownRefs = await headerRefs(message.id);
      const isFirstInThread = !ownRefs.trim();

      const reply = findDirectReplyIndexed(message, replyIndex);
      if (!reply) {
        skippedAmbiguous++;
        continue; // no observed reply -> ambiguous, not "didn't need one" -> skip
      }

      if (isFirstInThread) {
        const text = await getBodyText(message.id);
        rows.push({ label: 1, subject: message.subject, text: stripQuoteTail(text) });
      } else {
        const replyText = await getBodyText(reply.id);
        if (isCloseout(replyText)) {
          const text = await getBodyText(message.id);
          const ownText = stripQuoteTail(text);
          if (looksLikeRequest(ownText)) {
            // a short reply to OUR question isn't a closeout, it's an answer
            skippedAmbiguous++;
          } else {
            rows.push({ label: 0, subject: message.subject, text: ownText });
          }
        } else {
          skippedAmbiguous++;
        }
      }
    }
  }

  log(`Done. Scanned ${scanned} sent messages, ${skippedAmbiguous} skipped as ambiguous.`);
  return rows;
}

// Prompts a native Save dialog (defaults to the Downloads folder, but the
// user can navigate anywhere - e.g. straight into this extension's own
// folder) instead of the old anchor-click trick, which always lands in
// Downloads with no way to redirect it.
async function downloadJson(obj, suggestedName) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  await browser.downloads.download({ url, filename: suggestedName, saveAs: true });
}

async function getLastDatasetInfo() {
  const { lastDatasetInfo } = await browser.storage.local.get({ lastDatasetInfo: null });
  return lastDatasetInfo;
}

async function saveLastDatasetInfo(rowCount) {
  await browser.storage.local.set({
    lastDatasetInfo: { generatedAt: new Date().toISOString(), rowCount },
  });
}

function renderLastDatasetInfo(info) {
  const el = document.getElementById("existingNotice");
  if (!info) {
    el.textContent = "";
    return;
  }
  const when = new Date(info.generatedAt).toLocaleString();
  el.textContent = `Last generated ${when}, ${info.rowCount} rows. Running again will ask for confirmation.`;
}

let lastRows = null; // kept in memory so "Train classifier" can run right after extraction

document.getElementById("run").addEventListener("click", async (event) => {
  const existing = await getLastDatasetInfo();
  if (existing) {
    const when = new Date(existing.generatedAt).toLocaleString();
    const proceed = confirm(
      `A dataset was already generated on ${when} (${existing.rowCount} rows).\n\nRun extraction again anyway?`
    );
    if (!proceed) return;
  }

  event.target.disabled = true;
  document.getElementById("trainSection").style.display = "none";
  const logEl = document.getElementById("log");
  const log = (msg) => {
    logEl.textContent += msg + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  };

  const lookbackDays = Number(document.getElementById("lookbackDays").value);
  log(
    lookbackDays === -1
      ? "Starting extraction (entire mailbox, no date limit)..."
      : `Starting extraction (last ${lookbackDays} days)...`
  );

  const rows = await buildDataset(log, lookbackDays);
  lastRows = rows;
  const positives = rows.filter((r) => r.label === 1).length;
  const negatives = rows.filter((r) => r.label === 0).length;
  log(`${rows.length} labeled rows: ${positives} positive, ${negatives} negative.`);

  await saveLastDatasetInfo(rows.length);
  renderLastDatasetInfo(await getLastDatasetInfo());

  document.getElementById("downloadDataset").onclick = () => downloadJson(rows, "tb-nudge-dataset.json");
  document.getElementById("downloadDataset").style.display = "inline";
  document.getElementById("trainSection").style.display = rows.length > 0 ? "block" : "none";

  event.target.disabled = false;
});

document.getElementById("train").addEventListener("click", async (event) => {
  if (!lastRows || lastRows.length === 0) return;
  event.target.disabled = true;
  const logEl = document.getElementById("trainLog");
  logEl.textContent = "Training (tokenizing + 5-fold cross-validation first)...\n";

  // Yield to the browser so the "Training..." message actually paints before
  // the (synchronous, CPU-bound) training loop blocks the main thread.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const tokenizedRows = lastRows.map((r) => ({
    label: r.label,
    tokens: tokenize(`${r.subject || ""} ${r.text || ""}`),
  }));
  const { model, cvMetrics } = trainModel(tokenizedRows, { threshold: 0.5, kFolds: 5 });

  let out = `Folds evaluated: ${cvMetrics.length}/5\n`;
  if (cvMetrics.length > 0) {
    out += `Avg precision (needs-reply): ${averageMetric(cvMetrics, "precision").toFixed(2)}\n`;
    out += `Avg recall (needs-reply):    ${averageMetric(cvMetrics, "recall").toFixed(2)}\n`;
    out += `Avg F1:                      ${averageMetric(cvMetrics, "f1").toFixed(2)}\n`;
    out += `Avg recall on negatives:     ${averageMetric(cvMetrics, "negRecall").toFixed(2)}\n`;
  }
  out += `\nTrained on the full ${tokenizedRows.length}-row set. Vocab size: ${model.vocab.length}.`;
  logEl.textContent = out;

  document.getElementById("downloadModel").onclick = () => downloadJson(model, "model.json");
  document.getElementById("downloadModel").style.display = "inline";

  event.target.disabled = false;
});

(async () => {
  renderLastDatasetInfo(await getLastDatasetInfo());
})();
