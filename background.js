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
// been trained. topWords is the explainability piece: the words in THIS
// message that most pushed the decision, for display in the notification and
// (later) anywhere else we want to show "why was this flagged."
async function classify(message) {
  if (!model) return { needsReply: true, topWords: [] };
  const text = await getBodyText(message.id);
  const own = stripQuoteTail(text);
  const tokens = tokenize(`${message.subject || ""} ${own}`);
  const vec = computeTfidfVector(tokens, model.vocabIndex, model.idf);
  const proba = predictProba(vec, model.weights, model.bias);
  const topWords = topContributions(vec, model.vocab, model.weights, 3);
  return { needsReply: proba >= model.threshold, topWords };
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
  notifiedMap[notifId] = message.id;

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
      } else {
        const result = await classify(message);
        if (result.needsReply) {
          await notifyFollowUp(message, notifiedMap, result.topWords);
          notified++;
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
  await browser.storage.local.set({ notifiedMap });
  return { scanned, notified };
}

browser.notifications.onClicked.addListener(async (notifId) => {
  const notifiedMap = await getNotifiedMap();
  const messageId = notifiedMap[notifId];
  if (messageId) {
    await browser.messageDisplay.open({ messageId, location: "tab" });
  }
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
