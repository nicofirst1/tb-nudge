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

if (typeof module !== "undefined") {
  module.exports = { normalizeSubject, extractEmail, isLikelyReply };
}
