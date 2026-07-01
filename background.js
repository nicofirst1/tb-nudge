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
// a reply? Falls back to "yes" (old behavior) if no model has been trained.
async function needsReply(message) {
  if (!model) return true;
  const text = await getBodyText(message.id);
  const own = stripQuoteTail(text);
  const tokens = tokenize(`${message.subject || ""} ${own}`);
  const vec = computeTfidfVector(tokens, model.vocabIndex, model.idf);
  const proba = predictProba(vec, model.weights, model.bias);
  return proba >= model.threshold;
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

async function notifyFollowUp(message, notifiedMap) {
  const notifId = `nudge-${message.id}`;
  await browser.notifications.create(notifId, {
    type: "basic",
    title: "No reply yet",
    message: `${message.subject || "(no subject)"}\nto ${(message.recipients || []).join(", ")}`,
  });
  notifiedMap[notifId] = message.id;
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

      const replied = await hasReply(message, inboxFolders);
      if (replied) {
        handled.add(message.id);
      } else if (await needsReply(message)) {
        await notifyFollowUp(message, notifiedMap);
        handled.add(message.id);
      } else {
        handled.add(message.id); // classifier says this one didn't need a reply
      }
    }
  }

  // drop handled entries that fell out of the lookback window, so storage stays bounded
  for (const id of handled) {
    if (!seenIds.has(id)) handled.delete(id);
  }

  await saveHandledIds(handled);
  await browser.storage.local.set({ notifiedMap });
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

(async () => {
  model = await loadModel();
  const settings = await getSettings();
  await browser.alarms.create("nudge-check", { periodInMinutes: settings.checkIntervalMinutes });
  runCheck();
})();
