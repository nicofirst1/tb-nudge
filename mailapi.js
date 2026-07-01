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
      for (const token of refs.split(/\s+/).filter(Boolean)) {
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
  return replyIndex.get(message.headerMessageId) || null;
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
