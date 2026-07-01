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

// Strict single-hop match: the first message in `folders` whose References/
// In-Reply-To names `message`'s Message-ID. No subject/sender fallback —
// for training-data extraction, a missed example is fine, a wrong label isn't.
async function findDirectReply(message, folders) {
  if (!message.headerMessageId) return null;
  for (const folder of folders) {
    const list = await browser.messages.query({ folderId: folder.id, fromDate: message.date });
    const candidates = await collectAll(list);
    for (const candidate of candidates) {
      const refs = await headerRefs(candidate.id);
      if (refs.includes(message.headerMessageId)) return candidate;
    }
  }
  return null;
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
