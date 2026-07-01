const assert = require("assert");
const { normalizeSubject, extractEmail, isLikelyReply, stripQuoteTail, isCloseout } = require("./lib.js");

assert.strictEqual(normalizeSubject("Re: Hello"), "hello");
assert.strictEqual(normalizeSubject("FWD: Hello"), "hello");
assert.strictEqual(normalizeSubject("Aw: Hello"), "hello");
assert.strictEqual(normalizeSubject("Hello"), "hello");

assert.strictEqual(extractEmail("Boss <boss@company.com>"), "boss@company.com");
assert.strictEqual(extractEmail("boss@company.com"), "boss@company.com");

assert.strictEqual(
  isLikelyReply(
    "<abc123@mail.gmail.com>",
    "Meeting tomorrow",
    ["boss@company.com"],
    { subject: "irrelevant subject", author: "someone@else.com" },
    "references: <abc123@mail.gmail.com>"
  ),
  true,
  "should match via References header even if subject/author look unrelated"
);

assert.strictEqual(
  isLikelyReply(
    null,
    "Meeting tomorrow",
    ["boss@company.com"],
    { subject: "Re: Meeting tomorrow", author: "Boss <boss@company.com>" },
    ""
  ),
  true,
  "should match via subject+sender fallback when no References header"
);

assert.strictEqual(
  isLikelyReply(
    null,
    "Meeting tomorrow",
    ["boss@company.com"],
    { subject: "Totally different topic", author: "boss@company.com" },
    ""
  ),
  false,
  "should not match when subject is unrelated"
);

assert.strictEqual(
  isLikelyReply(
    null,
    "Meeting tomorrow",
    ["boss@company.com"],
    { subject: "Re: Meeting tomorrow", author: "someone-else@company.com" },
    ""
  ),
  false,
  "should not match when reply comes from an unrelated address"
);

assert.strictEqual(
  stripQuoteTail("Sure, let's do 3pm.\n\nOn Tue, Jan 5, 2026, Boss wrote:\n> can we meet?"),
  "Sure, let's do 3pm.",
  "should cut off at 'On ... wrote:' quote header"
);
assert.strictEqual(
  stripQuoteTail("Klingt gut.\n\nAm 05.01.2026 schrieb Boss:\n> Passt das?"),
  "Klingt gut.",
  "should cut off at German 'Am ... schrieb ...:' quote header"
);
assert.strictEqual(stripQuoteTail("no quote here at all"), "no quote here at all");

assert.strictEqual(isCloseout("Thanks!"), true, "short closing phrase is a closeout");
assert.strictEqual(isCloseout("Sounds good, talk then."), true, "short reply is a closeout");
assert.strictEqual(
  isCloseout("Actually, can you also send me the invoice from March, and check with accounting?"),
  false,
  "a long message with a further ask is not a closeout"
);
assert.strictEqual(isCloseout(""), false, "empty text is not a closeout");

console.log("ok - all lib.js tests passed");
