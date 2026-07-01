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

async function collectAll(list) {
  const messages = [...list.messages];
  let page = list;
  while (page.id) {
    page = await browser.messages.continueList(page.id);
    messages.push(...page.messages);
  }
  return messages;
}

async function headerRefs(messageId) {
  const full = await browser.messages.getFull(messageId);
  const h = full.headers || {};
  return [...(h["references"] || []), ...(h["in-reply-to"] || [])].join(" ");
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
      } else {
        await notifyFollowUp(message, notifiedMap);
        handled.add(message.id);
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
  const settings = await getSettings();
  await browser.alarms.create("nudge-check", { periodInMinutes: settings.checkIntervalMinutes });
  runCheck();
})();
