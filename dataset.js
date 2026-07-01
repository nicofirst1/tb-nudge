const STORAGE_KEY = "lastDatasetInfo";

// lookbackDays: -1 means no date limit at all (mine the entire mailbox).
async function buildDataset(log, lookbackDays) {
  const cutoff = lookbackDays === -1 ? undefined : new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);
  const sentFolders = await browser.folders.query({ specialUse: ["sent"] });
  const inboxFolders = await browser.folders.query({ specialUse: ["inbox"] });

  log(cutoff ? "Indexing inbox replies (one pass, this is the slow part)..." : "Indexing entire inbox (no date limit - this may take a while)...");
  const inboxIndex = await buildReplyIndex(inboxFolders, cutoff, log);

  // Self-bump signal: the sender's own later mail whose immediate parent is this
  // message. No date cutoff on the bumps themselves (a bump landing just past the
  // window still proves the in-window message needed a reply).
  log("Indexing self-bumps in Sent (immediate-parent only)...");
  const bumpIndex = await buildReplyIndex(sentFolders, undefined, log, immediateParentKeys);

  const rows = [];
  let scanned = 0;
  const counts = { "self-bump": 0, request: 0, "own-closeout": 0, "reply-closeout": 0, silence: 0, ambiguous: 0 };

  for (const folder of sentFolders) {
    const queryInfo = { folderId: folder.id };
    if (cutoff) queryInfo.fromDate = cutoff;
    const messages = await collectAll(await browser.messages.query(queryInfo));

    for (const message of messages) {
      scanned++;
      if (scanned % 25 === 0) {
        log(`scanned ${scanned} sent messages, collected ${rows.length} rows...`);
      }

      const key = message.headerMessageId ? normalizeMessageId(message.headerMessageId) : "";
      const inboxHdr = key ? inboxIndex.get(key) || null : null;
      const bumpHdr = key ? bumpIndex.get(key) || null : null;

      if (!inboxHdr && !bumpHdr) {
        counts.silence++;
        continue; // silence with no self-follow-up is never a label
      }

      const ownText = stripQuoteTail(await getBodyText(message.id));
      const inboxReply = inboxHdr ? { date: inboxHdr.date, body: await getBodyText(inboxHdr.id) } : null;
      const selfBump = bumpHdr ? { date: bumpHdr.date } : null;

      const { label, source } = labelSentMessage({ ownText, inboxReply, selfBump });
      counts[source]++;
      if (label !== null) rows.push({ label, subject: message.subject, text: ownText });
    }
  }

  log(
    `Done. Scanned ${scanned}. Positives: ${counts["self-bump"]} self-bump + ${counts.request} request. ` +
      `Negatives: ${counts["own-closeout"]} own-closeout + ${counts["reply-closeout"]} reply-closeout. ` +
      `Skipped: ${counts.silence} silence + ${counts.ambiguous} ambiguous.`
  );
  return rows;
}

async function getLastDatasetInfo() {
  const { lastDatasetInfo } = await browser.storage.local.get({ lastDatasetInfo: null });
  return lastDatasetInfo;
}

// Persist the rows too (not just the count) so "Train" is available on a later
// visit without re-extracting. ponytail: stores full body text in local storage
// - fine for a few hundred rows; if a whole-mailbox extraction ever bloats it,
// cap or store tokens-only.
async function saveLastDataset(rows) {
  await browser.storage.local.set({
    lastDatasetInfo: { generatedAt: new Date().toISOString(), rowCount: rows.length },
    lastDatasetRows: rows,
  });
}

async function getLastDatasetRows() {
  const { lastDatasetRows } = await browser.storage.local.get({ lastDatasetRows: null });
  return lastDatasetRows;
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

// Reveal the download link + train section for a dataset (freshly extracted, or
// restored from storage on page load).
function showTraining(rows) {
  lastRows = rows;
  document.getElementById("downloadDataset").onclick = () => downloadJson(rows, "tb-nudge-dataset.json");
  document.getElementById("downloadDataset").style.display = "inline";
  document.getElementById("trainSection").style.display = rows.length > 0 ? "block" : "none";
}

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
  const positives = rows.filter((r) => r.label === 1).length;
  const negatives = rows.filter((r) => r.label === 0).length;
  log(`${rows.length} labeled rows: ${positives} positive, ${negatives} negative.`);

  await saveLastDataset(rows);
  renderLastDatasetInfo(await getLastDatasetInfo());
  showTraining(rows);

  event.target.disabled = false;
});

document.getElementById("train").addEventListener("click", async (event) => {
  if (!lastRows || lastRows.length === 0) return;
  event.target.disabled = true;
  const logEl = document.getElementById("trainLog");
  const log = (msg) => {
    logEl.textContent += msg + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  };
  // A microtask isn't enough to repaint; a 0ms timeout yields a real frame so
  // each progress line shows before the next CPU-bound step blocks the thread.
  const yieldPaint = () => new Promise((resolve) => setTimeout(resolve, 0));

  logEl.textContent = `Tokenizing ${lastRows.length} rows...\n`;
  await yieldPaint();

  const toTokenized = (r) => ({ label: r.label, tokens: tokenize(`${r.subject || ""} ${r.text || ""}`) });
  const tokenizedRows = lastRows.map(toTokenized);

  // Merge human corrections (the ✓/✗ buttons in diagnostics) so they actually
  // shape the active model, not just the CLI-trained one.
  const corrections = (await browser.runtime.sendMessage("get-corrections")) || [];
  const trainingRows = tokenizedRows.concat(corrections.map(toTokenized));
  if (corrections.length) log(`Merged ${corrections.length} human correction(s).`);

  log("Running 5-fold cross-validation (this is the slow part)...");
  await yieldPaint();

  const { model, cvMetrics } = await trainModel(trainingRows, {
    threshold: 0.5,
    kFolds: 5,
    onProgress: async (p) => {
      log(p.phase === "final" ? "  cross-validation done. Fitting final model on full set..." : `  fold ${p.fold}/${p.total}...`);
      await yieldPaint();
    },
  });

  let out = logEl.textContent + `\nFolds evaluated: ${cvMetrics.length}/5\n`;
  if (cvMetrics.length > 0) {
    out += `Avg precision (needs-reply): ${averageMetric(cvMetrics, "precision").toFixed(2)}\n`;
    out += `Avg recall (needs-reply):    ${averageMetric(cvMetrics, "recall").toFixed(2)}\n`;
    out += `Avg F1:                      ${averageMetric(cvMetrics, "f1").toFixed(2)}\n`;
    out += `Avg recall on negatives:     ${averageMetric(cvMetrics, "negRecall").toFixed(2)}\n`;
  }
  out += `\nTrained on the full ${trainingRows.length}-row set. Vocab size: ${model.vocab.length}.`;

  // Make this the active model immediately: the nudger and the inspector both
  // prefer the storage-saved model over the bundled model.json.
  await saveActiveModel(model);
  out += `\nSaved as the active model (nudger + inspector now use it).`;
  logEl.textContent = out;

  // Prompt to save model.json right away (Save-As dialog) so the user can drop
  // it into the repo to commit; the link stays for saving again later.
  document.getElementById("downloadModel").onclick = () => downloadJson(model, "model.json");
  document.getElementById("downloadModel").style.display = "inline";
  await downloadJson(model, "model.json");

  event.target.disabled = false;
});

async function renderCorrectionsCount() {
  const corrections = (await browser.runtime.sendMessage("get-corrections")) || [];
  const pos = corrections.filter((r) => r.label === 1).length;
  const neg = corrections.length - pos;
  const el = document.getElementById("correctionsCount");
  el.textContent = corrections.length
    ? `${corrections.length} stored correction(s): ${pos} "needed reply", ${neg} "didn't need reply".`
    : "No corrections stored yet.";
}

document.getElementById("clearCorrections").addEventListener("click", async () => {
  if (!confirm("Delete all stored human corrections? This can't be undone.")) return;
  await browser.runtime.sendMessage("clear-corrections");
  await renderCorrectionsCount();
});

document.getElementById("downloadCorrections").addEventListener("click", async () => {
  const corrections = (await browser.runtime.sendMessage("get-corrections")) || [];
  if (!corrections.length) {
    alert("No corrections stored to download yet.");
    return;
  }
  await downloadJson(corrections, "tb-nudge-corrections.json");
});

document.getElementById("uploadCorrections").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  let rows;
  try {
    rows = JSON.parse(await file.text());
  } catch (e) {
    alert("Couldn't parse that file as JSON.");
    event.target.value = "";
    return;
  }
  const result = await browser.runtime.sendMessage({ type: "import-corrections", rows });
  event.target.value = ""; // let the same file be re-picked later
  if (!result.ok) {
    alert(`Import failed: ${result.error}`);
    return;
  }
  alert(
    `Imported ${result.added} correction(s)` +
      (result.skipped ? `, ${result.skipped} duplicate(s) skipped` : "") +
      (result.invalid ? `, ${result.invalid} invalid row(s) ignored` : "") +
      `. ${result.total} stored in total.`
  );
  await renderCorrectionsCount();
});

(async () => {
  renderLastDatasetInfo(await getLastDatasetInfo());
  await renderCorrectionsCount();
  const rows = await getLastDatasetRows();
  if (rows && rows.length) showTraining(rows); // dataset already extracted earlier -> let them train straight away
})();
