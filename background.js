const DEFAULTS = {
  hoursThreshold: 30,
  lookbackDays: 14,
  checkIntervalMinutes: 60,
};

async function getSettings() {
  const stored = await browser.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// message ids we've already handled (replied, or already notified once)
async function getHandledIds() {
  const { handledIds } = await browser.storage.local.get({ handledIds: [] });
  return new Set(handledIds);
}

async function saveHandledIds(set) {
  await browser.storage.local.set({ handledIds: [...set] });
}

// notificationId -> messageId, so a click can open the right message
async function getNotifiedMap() {
  const { notifiedMap } = await browser.storage.local.get({ notifiedMap: {} });
  return notifiedMap;
}

// collectAll / headerRefs / getBodyText come from mailapi.js (loaded before this script).

let model = null; // null until model.json exists (i.e. train.js has been run)

async function loadModel() {
  const raw = await loadActiveModel(); // storage-trained model wins over bundled model.json
  if (!raw) return null; // no model trained yet - fall back to nudging on everything
  const vocabIndex = {};
  raw.vocab.forEach((t, i) => {
    vocabIndex[t] = i;
  });
  return { ...raw, vocabIndex };
}

// Classifier pre-filter: does this sent message actually look like it needed
// a reply? Falls back to "yes, no explanation" (old behavior) if no model has
// been trained. topWords explains a NUDGE ("flagged because of these words"),
// bottomWords explains a SUPPRESSION ("not flagged because of these words").
async function classify(message) {
  if (!model) return { needsReply: true, topWords: [], bottomWords: [] };
  const text = await getBodyText(message.id);
  const own = stripQuoteTail(text);
  const tokens = tokenize(`${message.subject || ""} ${own}`);
  const vec = computeTfidfVector(tokens, model.vocabIndex, model.idf);
  const proba = predictProba(vec, model.weights, model.bias);
  const topWords = topContributions(vec, model.vocab, model.weights, 3);
  const bottomWords = bottomContributions(vec, model.vocab, model.weights, 3);
  return { needsReply: proba >= model.threshold, topWords, bottomWords };
}

// Returns the matching reply MessageHeader (so callers can e.g. open it),
// or null if none was found.
async function findReply(sentMessage, inboxFolders) {
  for (const folder of inboxFolders) {
    const list = await browser.messages.query({
      folderId: folder.id,
      fromDate: sentMessage.date,
    });
    const candidates = await collectAll(list);
    for (const candidate of candidates) {
      const refs = await headerRefs(candidate.id);
      if (
        isLikelyReply(
          sentMessage.headerMessageId,
          sentMessage.subject,
          sentMessage.recipients,
          candidate,
          refs
        )
      ) {
        return candidate;
      }
    }
  }
  return null;
}

// Stable key for a message's thread: the root Message-ID (first entry of its
// References/In-Reply-To chain), or its own id if it starts the thread. All
// messages in one conversation share this, so we can nudge a thread just once.
async function threadKey(message) {
  const first = (await headerRefs(message.id)).split(/\s+/).filter(Boolean)[0];
  return normalizeMessageId(first || message.headerMessageId || "");
}

const TAG_LABEL = "Needs Reply";
let tagKey = null; // resolved once at startup

async function ensureTag() {
  const existing = await browser.messages.tags.list();
  const found = existing.find((t) => t.tag === TAG_LABEL);
  if (found) return found.key;
  return browser.messages.tags.create(TAG_LABEL, "#e6a817");
}

async function applyNeedsReplyTag(message) {
  if (!tagKey) return;
  const newTags = Array.from(new Set([...(message.tags || []), tagKey]));
  await browser.messages.update(message.id, { tags: newTags }); // tag only, don't touch the "important" flag
}

async function notifyFollowUp(message, notifiedMap, topWords) {
  const notifId = `nudge-${message.id}`;
  const reasonLine = topWords && topWords.length ? `\nWhy: ${topWords.join(", ")}` : "";
  await browser.notifications.create(notifId, {
    type: "basic",
    title: "No reply yet",
    message: `${message.subject || "(no subject)"}\nto ${(message.recipients || []).join(", ")}${reasonLine}`,
  });
  // Store headerMessageId (stable), not message.id (can go stale by the time
  // the user clicks - see onClicked below).
  notifiedMap[notifId] = message.headerMessageId;
  // Persist immediately: onClicked can fire while runCheck() is still mid-scan
  // (still processing other folders/messages), before the batched write at the
  // end of runCheck() would otherwise happen - clicking during that window read
  // stale storage and silently did nothing. This closes that race.
  await browser.storage.local.set({ notifiedMap });

  await applyNeedsReplyTag(message);
}

// opts:
//   notify (default true)  - fire OS notifications + tag nudged messages. The
//     labeling scan turns this off: it's a read-only classification pass.
//   scanAll (default false) - ignore the recent-time window AND the "already
//     handled" memory, and don't write either back. Used to sweep the WHOLE
//     mailbox for manual labeling; normal periodic runs leave it false so they
//     stay incremental. Also swaps per-message reply lookup for a single inbox
//     index pass, since O(sent x inbox) findReply() is far too slow at scale.
//   onProgress (default null) - called with {phase,...} so the diagnostics page
//     can stream a live progress log during a long scan.
async function runCheck(opts = {}) {
  const { notify = true, scanAll = false, onProgress = null } = opts;
  const report = (info) => onProgress && onProgress(info);
  const settings = await getSettings();
  const handled = await getHandledIds();
  const notifiedMap = await getNotifiedMap();

  const cutoffOld = scanAll ? undefined : new Date(Date.now() - settings.lookbackDays * 24 * 3600 * 1000);
  const cutoffRecent = scanAll ? undefined : new Date(Date.now() - settings.hoursThreshold * 3600 * 1000);

  const sentFolders = await browser.folders.query({ specialUse: ["sent"] });
  const inboxFolders = await browser.folders.query({ specialUse: ["inbox"] });

  // Reply lookup: at scanAll scale, one inbox index pass instead of scanning the
  // whole inbox per sent message. Matches on Message-ID references only (no
  // subject/sender fallback), which is fine here - the user corrects by hand.
  let findReplyFor;
  if (scanAll) {
    report({ phase: "indexing" });
    const replyIndex = await buildReplyIndex(inboxFolders, undefined, (line) => report({ phase: "indexing", text: line }));
    findReplyFor = (m) => replyIndex.get(normalizeMessageId(m.headerMessageId)) || null;
  } else {
    findReplyFor = (m) => findReply(m, inboxFolders);
  }

  const seenIds = new Set();
  let scanned = 0;
  let notified = 0;
  let alreadyReplied = 0;
  let suppressedByClassifier = 0;
  let deduped = 0;
  const decisions = []; // per-message trace, for the diagnostics view

  // One decision per thread: a thread that already got a reply, or that we've
  // already nudged this run, shouldn't nudge again for a sibling message.
  const resolvedThreads = new Set();

  // Gather every candidate first and process newest-first, so when a thread has
  // several unanswered sent messages the nudge lands on the latest one and the
  // older siblings are the ones deduped away.
  let allMessages = [];
  for (const folder of sentFolders) {
    const list = await browser.messages.query({
      folderId: folder.id,
      fromDate: cutoffOld,
      toDate: cutoffRecent,
    });
    allMessages = allMessages.concat(await collectAll(list));
  }
  allMessages.sort((a, b) => b.date - a.date);
  report({ phase: "scanning", scanned: 0, total: allMessages.length });

  for (const message of allMessages) {
    seenIds.add(message.id);
    if (!scanAll && handled.has(message.id)) continue;
    scanned++;
    if (scanned % 20 === 0) report({ phase: "scanning", scanned, total: allMessages.length, notified, alreadyReplied, suppressedByClassifier, deduped });

    const reply = await findReplyFor(message);
    if (reply) {
      if (!scanAll) handled.add(message.id);
      resolvedThreads.add(await threadKey(message)); // an answered message resolves its whole thread
      alreadyReplied++;
      decisions.push({
        id: message.id,
        headerMessageId: message.headerMessageId,
        subject: message.subject,
        outcome: "already replied",
        words: [],
        replyHeaderMessageId: reply.headerMessageId,
      });
      continue;
    }

    const result = await classify(message);
    if (result.needsReply) {
      const tkey = await threadKey(message);
      if (resolvedThreads.has(tkey)) {
        if (!scanAll) handled.add(message.id);
        deduped++;
        continue; // another message in this thread already nudged (or got a reply) - don't repeat
      }
      resolvedThreads.add(tkey);
      if (notify) await notifyFollowUp(message, notifiedMap, result.topWords);
      notified++;
      decisions.push({
        id: message.id,
        headerMessageId: message.headerMessageId,
        subject: message.subject,
        outcome: "nudged",
        words: result.topWords,
      });
    } else {
      suppressedByClassifier++;
      decisions.push({
        id: message.id,
        headerMessageId: message.headerMessageId,
        subject: message.subject,
        outcome: "suppressed",
        words: result.bottomWords,
      });
    }
    if (!scanAll) handled.add(message.id); // either notified, or classifier says it didn't need a reply
  }

  const summary = { scanned, notified, alreadyReplied, suppressedByClassifier, deduped, decisions };
  report({ phase: "done", ...summary });

  if (scanAll) return summary; // labeling pass is read-only: no handled/notifiedMap writes

  // drop handled entries that fell out of the lookback window, so storage stays bounded
  for (const id of handled) {
    if (!seenIds.has(id)) handled.delete(id);
  }
  await saveHandledIds(handled);
  // notifiedMap is no longer written here - notifyFollowUp() persists it
  // immediately per-notification now, so this batched write would be redundant.
  return summary;
}

// Merge an uploaded corrections file into stored corrections. Validates each row
// at this trust boundary (only {label:0|1, subject, text} survives) and dedupes
// by content so re-importing the same file is idempotent.
async function importCorrections(rows) {
  if (!Array.isArray(rows)) return { ok: false, error: "File is not a JSON array of corrections." };
  const clean = rows.filter(
    (r) => r && (r.label === 0 || r.label === 1) && typeof r.subject === "string" && typeof r.text === "string"
  );
  const { corrections } = await browser.storage.local.get({ corrections: [] });
  const key = (r) => `${r.label} ${r.subject} ${r.text}`;
  const seen = new Set(corrections.map(key));
  let added = 0;
  for (const r of clean) {
    if (seen.has(key(r))) continue;
    seen.add(key(r));
    corrections.push({ label: r.label, subject: r.subject, text: r.text });
    added++;
  }
  await browser.storage.local.set({ corrections });
  return { ok: true, added, skipped: clean.length - added, invalid: rows.length - clean.length, total: corrections.length };
}

// Streamed whole-mailbox labeling scan: the diagnostics page connects a port,
// we push progress messages as we go, then a final "done" with all decisions.
// A port (not sendMessage) is what lets progress arrive live during the scan.
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "label-scan") return;
  port.onMessage.addListener(async () => {
    try {
      await runCheck({ scanAll: true, notify: false, onProgress: (info) => port.postMessage(info) });
    } catch (err) {
      port.postMessage({ phase: "error", error: String(err && err.message ? err.message : err) });
    }
  });
});

browser.notifications.onClicked.addListener(async (notifId) => {
  const notifiedMap = await getNotifiedMap();
  const headerMessageId = notifiedMap[notifId];
  if (!headerMessageId) return;
  // Re-resolve the CURRENT message.id from the stable Message-ID header
  // rather than trusting a stored id, which can go stale (IMAP resync/
  // reindex) and throw NS_MSG_ERROR_FOLDER_MISSING when opened. Scoped to
  // Sent folders specifically - see resolveCurrentMessageId in mailapi.js.
  const sentFolders = await browser.folders.query({ specialUse: ["sent"] });
  const messageId = await resolveCurrentMessageId(headerMessageId, sentFolders);
  if (!messageId) return; // message moved/deleted since it was nudged
  await openMessageInTab(messageId);
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "nudge-check") runCheck();
});

async function removeNeedsReplyTag(message) {
  if (!tagKey) return;
  const newTags = (message.tags || []).filter((t) => t !== tagKey);
  await browser.messages.update(message.id, { tags: newTags }); // tag only, leave the flag as the user set it
}

// A manual correction from the diagnostics table: fix the message's tag/flag to
// match reality right now, and save it as a labeled example so a future retrain
// learns from the miss (see train.js's optional corrections-file argument, and
// the in-page trainer which also merges these in).
//   label 1: a SUPPRESSED message that did need a reply -> tag/flag it.
//   label 0: a NUDGED message that did not -> clear the wrong tag/flag.
async function saveCorrection(headerMessageId, label) {
  const sentFolders = await browser.folders.query({ specialUse: ["sent"] });
  const messageId = await resolveCurrentMessageId(headerMessageId, sentFolders);
  if (!messageId) return { ok: false, error: "Message not found - it may have moved or been deleted." };

  const message = await browser.messages.get(messageId);
  if (label === 1) await applyNeedsReplyTag(message);
  else await removeNeedsReplyTag(message);

  const ownText = stripQuoteTail(await getBodyText(messageId));
  const { corrections } = await browser.storage.local.get({ corrections: [] });
  corrections.push({ label, subject: message.subject, text: ownText });
  await browser.storage.local.set({ corrections });

  return { ok: true, correctionCount: corrections.length };
}

// Lets the options page trigger a check on demand (for testing, instead of
// waiting up to checkIntervalMinutes for the alarm to fire) and read status.
browser.runtime.onMessage.addListener((msg) => {
  if (msg === "run-check-now") return runCheck();
  if (msg === "get-status") {
    return Promise.resolve({
      modelLoaded: !!model,
      vocabSize: model ? model.vocab.length : 0,
      tagKey,
    });
  }
  if (msg === "reset-handled") {
    // clears the "already processed" memory so the next check re-scans
    // everything currently in the window - for testing after a code change,
    // or if you just want a fresh pass with the current settings/model.
    return browser.storage.local.remove(["handledIds", "notifiedMap"]).then(() => ({ reset: true }));
  }
  if (msg && msg.type === "correct-suppression") {
    return saveCorrection(msg.headerMessageId, 1);
  }
  if (msg && msg.type === "correct-nudge") {
    return saveCorrection(msg.headerMessageId, 0);
  }
  if (msg === "get-corrections") {
    return browser.storage.local.get({ corrections: [] }).then((r) => r.corrections);
  }
  if (msg === "clear-corrections") {
    return browser.storage.local.set({ corrections: [] }).then(() => ({ ok: true }));
  }
  if (msg && msg.type === "import-corrections") {
    return importCorrections(msg.rows);
  }
  return undefined;
});

// Retraining in dataset.html writes a new model to storage; pick it up live
// instead of waiting for the next extension restart.
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area === "local" && changes.trainedModel) model = await loadModel();
});

(async () => {
  model = await loadModel();
  tagKey = await ensureTag();
  const settings = await getSettings();
  await browser.alarms.create("nudge-check", { periodInMinutes: settings.checkIntervalMinutes });
  runCheck();
})();
