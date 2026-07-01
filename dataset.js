const LOOKBACK_DAYS = 730; // ponytail: bounded window, extend if you need older mail

async function buildDataset(log) {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000);
  const sentFolders = await browser.folders.query({ specialUse: ["sent"] });
  const inboxFolders = await browser.folders.query({ specialUse: ["inbox"] });

  log("Indexing inbox (one pass, this is the slow part)...");
  const replyIndex = await buildReplyIndex(inboxFolders, cutoff, log);

  const rows = [];
  let scanned = 0;
  let skippedAmbiguous = 0;

  for (const folder of sentFolders) {
    const list = await browser.messages.query({ folderId: folder.id, fromDate: cutoff });
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

function triggerDownload(rows) {
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.getElementById("download");
  a.href = url;
  a.download = "tb-nudge-dataset.json";
  a.style.display = "inline";
  a.textContent = `Download dataset.json (${rows.length} rows)`;
}

document.getElementById("run").addEventListener("click", async (event) => {
  event.target.disabled = true;
  const logEl = document.getElementById("log");
  const log = (msg) => {
    logEl.textContent += msg + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  };
  log(`Starting extraction (last ${LOOKBACK_DAYS} days)...`);
  const rows = await buildDataset(log);
  const positives = rows.filter((r) => r.label === 1).length;
  const negatives = rows.filter((r) => r.label === 0).length;
  log(`${rows.length} labeled rows: ${positives} positive, ${negatives} negative.`);
  triggerDownload(rows);
  event.target.disabled = false;
});
