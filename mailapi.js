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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// messageDisplay.open({location: "window"}) throws NS_MSG_ERROR_FOLDER_MISSING
// for this account even with a correctly-scoped id - a genuine bug in that
// API's own window-opening path, confirmed by mailTabs.setSelectedMessages()
// working fine with the exact same id. So: open a real new 3-pane window
// ourselves, then use the working mailTabs mechanism inside it.
async function openMessageInNewWindow(messageId) {
  const win = await browser.windows.create({ type: "normal" });
  let tab = null;
  for (let attempt = 0; attempt < 5 && !tab; attempt++) {
    if (attempt > 0) await wait(200); // new window's mail tab can take a beat to initialize
    const tabs = await browser.mailTabs.query({ windowId: win.id });
    tab = tabs[0];
  }
  if (!tab) throw new Error("New window did not create a mail tab in time");
  await browser.mailTabs.setSelectedMessages(tab.id, [messageId]);
}

