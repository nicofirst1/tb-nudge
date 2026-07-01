// Thin wrappers over browser.messages/folders, shared by background.js (nudging)
// and dataset.js (training-data extraction). Kept separate from lib.js because
// these touch the browser.* APIs and can't be unit-tested with plain node.

async function collectAll(list) {
  const messages = [...list.messages];
  let page = list;
  while (page.id) {
    page = await browser.messages.continueList(page.id);
    messages.push(...page.messages);
  }
  return messages;
}

// Combined References + In-Reply-To header text of a message (used both to
// check "does candidate reply to X" and "is this message itself a reply").
async function headerRefs(messageId) {
  const full = await browser.messages.getFull(messageId);
  const h = full.headers || {};
  return [...(h["references"] || []), ...(h["in-reply-to"] || [])].join(" ");
}

// Runs up to `limit` calls to fn(item) concurrently instead of one at a time.
// getFull() is an IPC round-trip to Thunderbird's message store; sequential
// calls over thousands of messages is the slow part, not the CPU work.
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Message-IDs show up both as "<id>" (raw header text) and "id" (parsed
// headerMessageId field) depending on where Thunderbird's API gives them to
// us. Strip the brackets so both forms compare equal.
function normalizeMessageId(id) {
  return (id || "").trim().replace(/^</, "").replace(/>$/, "");
}

// One pass over `folders`: maps every Message-ID mentioned in any candidate's
// References/In-Reply-To to that candidate. Replaces the naive approach of
// re-scanning + re-fetching all inbox messages for every single sent message
// (O(sent x inbox) getFull calls) with a single O(inbox) pass.
async function buildReplyIndex(folders, sinceDate, log) {
  const index = new Map();
  let done = 0;
  for (const folder of folders) {
    const list = await browser.messages.query({ folderId: folder.id, fromDate: sinceDate });
    const candidates = await collectAll(list);
    await mapConcurrent(candidates, 8, async (candidate) => {
      const refs = await headerRefs(candidate.id);
      for (const rawToken of refs.split(/\s+/).filter(Boolean)) {
        const token = normalizeMessageId(rawToken);
        if (!index.has(token)) index.set(token, candidate);
      }
      done++;
      if (log && done % 200 === 0) log(`indexed ${done} inbox messages...`);
    });
  }
  if (log) log(`indexing done: ${done} inbox messages, ${index.size} reply references.`);
  return index;
}

function findDirectReplyIndexed(message, replyIndex) {
  if (!message.headerMessageId) return null;
  return replyIndex.get(normalizeMessageId(message.headerMessageId)) || null;
}

function extractPlainText(part) {
  if (!part) return "";
  const contentType = part.contentType || "";
  if (part.body && contentType.includes("text/plain")) return part.body;
  if (part.parts) {
    for (const p of part.parts) {
      const t = extractPlainText(p);
      if (t) return t;
    }
  }
  if (part.body && contentType.includes("text/html")) {
    return part.body.replace(/<[^>]+>/g, " ");
  }
  return "";
}

async function getBodyText(messageId) {
  const full = await browser.messages.getFull(messageId, { decodeContent: true });
  return extractPlainText(full);
}

// message.id can go stale between when we scan a message and when the user
// later clicks to open it (IMAP resync/reindex reassigns internal ids and
// opening a stale one throws NS_MSG_ERROR_FOLDER_MISSING). headerMessageId
// (the actual RFC Message-ID) is stable, so re-look-up the CURRENT id right
// before opening instead of trusting whatever id we stored earlier.
//
// sentFolders, if given, scopes the lookup to those folders. Gmail exposes
// the same physical message under multiple IMAP folders (Sent, All Mail,
// labels) - an unscoped query can match the "All Mail" copy instead of the
// Sent copy, and Thunderbird's tree-view handles that aggregated/virtual
// folder differently (selecting a message there silently fails to display).
// We only ever deal with sent messages here, so scoping to the real Sent
// folder(s) avoids that ambiguity entirely.
async function resolveCurrentMessageId(headerMessageId, sentFolders) {
  if (!headerMessageId) return null;
  const queryInfo = { headerMessageId };
  if (sentFolders && sentFolders.length) {
    queryInfo.folderId = sentFolders.map((f) => f.id);
  }
  const list = await browser.messages.query(queryInfo);
  return list.messages && list.messages[0] ? list.messages[0].id : null;
}

// messageDisplay.open({location: "window"}) throws NS_MSG_ERROR_FOLDER_MISSING
// even with a correctly-scoped id - the error trace points specifically at
// chrome://messenger/content/messageWindow.js, the standalone-window-only
// code path. location: "tab" uses a different internal path (opening within
// an existing window's tab strip), which may not share that bug. Explicitly
// resolve a real mail window's id first, since this is often called from
// contexts (background page, a separate extension page) that have no
// "current window" of their own for the default to fall back on.
async function openMessageInTab(messageId) {
  const tabs = await browser.mailTabs.query({});
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) throw new Error("No mail window open to open the message in");
  await browser.messageDisplay.open({ messageId, location: "tab", windowId: tab.windowId });
}

// Prompts a native Save dialog (defaults to the Downloads folder, but the
// user can navigate anywhere - e.g. straight into this extension's own
// folder) instead of an anchor-click download, which always lands in
// Downloads with no way to redirect it. Shared by dataset.js and
// diagnostics.js, both of which need to save JSON the user picked up.
async function downloadJson(obj, suggestedName) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  await browser.downloads.download({ url, filename: suggestedName, saveAs: true });
}

