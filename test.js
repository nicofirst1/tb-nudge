const assert = require("assert");
const { normalizeSubject, extractEmail, isLikelyReply } = require("./lib.js");

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

console.log("ok - all lib.js tests passed");
