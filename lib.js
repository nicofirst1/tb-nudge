// Pure logic, kept separate from background.js so it's testable with plain node.

function normalizeSubject(subject) {
  return (subject || "")
    .replace(/^(re|fwd?|aw):\s*/gi, "")
    .trim()
    .toLowerCase();
}

// "Name <foo@bar.com>" -> "foo@bar.com"; bare "foo@bar.com" -> itself.
function extractEmail(addr) {
  if (!addr) return "";
  const match = addr.match(/<([^>]+)>/);
  return (match ? match[1] : addr).trim().toLowerCase();
}

// sentHeaderMessageId: the Message-ID of the message we sent
// sentSubject / sentRecipients: from the sent message
// candidate: { subject, author } of a message received later
// candidateRefs: string containing the candidate's References + In-Reply-To headers
function isLikelyReply(sentHeaderMessageId, sentSubject, sentRecipients, candidate, candidateRefs) {
  if (sentHeaderMessageId && candidateRefs && candidateRefs.includes(sentHeaderMessageId)) {
    return true;
  }
  const subjectMatches = normalizeSubject(candidate.subject) === normalizeSubject(sentSubject);
  const candidateEmail = extractEmail(candidate.author);
  const fromRecipient = (sentRecipients || []).some((r) => extractEmail(r) === candidateEmail);
  return subjectMatches && fromRecipient && candidateEmail !== "";
}

// Cuts off quoted history (">" lines, "On ... wrote:", German "Am ... schrieb ...:",
// "-----Original Message-----") so only the sender's own new text remains.
function stripQuoteTail(text) {
  const lines = (text || "").split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^>/.test(trimmed)) break;
    if (/^On .+wrote:$/.test(trimmed)) break;
    if (/^Am .+schrieb.*:$/.test(trimmed)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

const CLOSEOUT_PHRASES =
  /^(thanks|thank you|thx|danke|great|awesome|perfect|sounds good|got it|sure|no problem|no worries|ok|okay|cool|will do|noted|understood|alles klar|passt)\b/i;

// Weak-supervision negative-label proxy: a short reply, or one opening with a
// closing phrase, after quoted history is stripped. Used to decide whether a
// reply-to-a-reply wrapped up the thread without needing more from us.
function isCloseout(text) {
  const own = stripQuoteTail(text);
  if (!own) return false;
  const wordCount = own.split(/\s+/).filter(Boolean).length;
  return wordCount <= 12 || CLOSEOUT_PHRASES.test(own);
}

const REQUEST_PHRASES =
  /\b(can you|could you|would you|please|let me know|should i|who should|do you know|is that correct|is this correct|can we|could we)\b/i;

// A short reply to a real question ("The 30th works") looks identical to a
// short closing acknowledgment ("Thanks!") by word count alone. Before
// trusting isCloseout() as a negative-label signal, check the SENT message
// itself isn't the one asking something.
function looksLikeRequest(text) {
  const own = stripQuoteTail(text);
  if (!own) return false;
  return own.includes("?") || REQUEST_PHRASES.test(own);
}

if (typeof module !== "undefined") {
  module.exports = {
    normalizeSubject,
    extractEmail,
    isLikelyReply,
    stripQuoteTail,
    isCloseout,
    looksLikeRequest,
  };
}
