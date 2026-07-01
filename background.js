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
  try {
    const res = await fetch(browser.runtime.getURL("model.json"));
    if (!res.ok) return null;
    const raw = await res.json();
    const vocabIndex = {};
    raw.vocab.forEach((t, i) => {
      vocabIndex[t] = i;
    });
    return { ...raw, vocabIndex };
  } catch (e) {
    return null; // no model trained yet - fall back to nudging on everything
  }
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

async function hasReply(sentMessage, inboxFolders) {
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
        return true;
      }
    }
  }
  return false;
}

const TAG_LABEL = "Needs Reply";
let tagKey = null; // resolved once at startup

async function ensureTag() {
  const existing = await browser.messages.tags.list();
  const found = existing.find((t) => t.tag === TAG_LABEL);
  if (found) return found.key;
  return browser.messages.tags.create(TAG_LABEL, "#e6a817");
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

  if (tagKey) {
    const newTags = Array.from(new Set([...(message.tags || []), tagKey]));
    await browser.messages.update(message.id, { flagged: true, tags: newTags });
  }
}

async function runCheck() {
  const settings = await getSettings();
  const handled = await getHandledIds();
  const notifiedMap = await getNotifiedMap();

  const cutoffOld = new Date(Date.now() - settings.lookbackDays * 24 * 3600 * 1000);
  const cutoffRecent = new Date(Date.now() - settings.hoursThreshold * 3600 * 1000);

  const sentFolders = await browser.folders.query({ specialUse: ["sent"] });
  const inboxFolders = await browser.folders.query({ specialUse: ["inbox"] });

  const seenIds = new Set();
  let scanned = 0;
  let notified = 0;
  let alreadyReplied = 0;
  let suppressedByClassifier = 0;
  const decisions = []; // per-message trace, for the "Run check now" test view

  for (const folder of sentFolders) {
    const list = await browser.messages.query({
      folderId: folder.id,
      fromDate: cutoffOld,
      toDate: cutoffRecent,
    });
    const messages = await collectAll(list);
    for (const message of messages) {
      seenIds.add(message.id);
      if (handled.has(message.id)) continue;
      scanned++;

      const replied = await hasReply(message, inboxFolders);
      if (replied) {
        handled.add(message.id);
        alreadyReplied++;
        decisions.push({
          id: message.id,
          headerMessageId: message.headerMessageId,
          subject: message.subject,
          outcome: "already replied",
          words: [],
        });
      } else {
        const result = await classify(message);
        if (result.needsReply) {
          await notifyFollowUp(message, notifiedMap, result.topWords);
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
        handled.add(message.id); // either notified, or classifier says it didn't need a reply
      }
    }
  }

  // drop handled entries that fell out of the lookback window, so storage stays bounded
  for (const id of handled) {
    if (!seenIds.has(id)) handled.delete(id);
  }

  await saveHandledIds(handled);
  // notifiedMap is no longer written here - notifyFollowUp() persists it
  // immediately per-notification now, so this batched write would be redundant.
  return { scanned, notified, alreadyReplied, suppressedByClassifier, decisions };
}

browser.notifications.onClicked.addListener(async (notifId) => {
  const notifiedMap = await getNotifiedMap();
  const headerMessageId = notifiedMap[notifId];
  if (!headerMessageId) return;
  // Re-resolve the CURRENT message.id from the stable Message-ID header
  // rather than trusting a stored id, which can go stale (IMAP resync/
  // reindex) and throw NS_MSG_ERROR_FOLDER_MISSING when opened.
  const messageId = await resolveCurrentMessageId(headerMessageId);
  if (!messageId) return; // message moved/deleted since it was nudged
  await browser.messages.getFull(messageId, { decodeContent: true });
  // location: "window", not "tab" - the background page has no window of
  // its own to open a tab in, so a standalone message window is the only
  // unambiguous target.
  await browser.messageDisplay.open({ messageId, location: "window" });
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "nudge-check") runCheck();
});

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
  return undefined;
});

(async () => {
  model = await loadModel();
  tagKey = await ensureTag();
  const settings = await getSettings();
  await browser.alarms.create("nudge-check", { periodInMinutes: settings.checkIntervalMinutes });
  runCheck();
})();
