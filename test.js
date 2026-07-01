const assert = require("assert");
const {
  normalizeSubject,
  extractEmail,
  isLikelyReply,
  stripQuoteTail,
  isCloseout,
  looksLikeRequest,
  tokenize,
  computeTfidfVector,
  sigmoid,
  predictProba,
  topContributions,
  bottomContributions,
  buildVocab,
  classWeights,
  trainLogReg,
  evaluateModel,
  trainModel,
} = require("./lib.js");

function approxEqual(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} to be close to ${b}`);
}

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

// Real cases the dataset spot-check found mislabeled as "didn't need a reply"
assert.strictEqual(looksLikeRequest("Are you free for a call now?"), true);
assert.strictEqual(looksLikeRequest("What about the 30th?"), true);
assert.strictEqual(looksLikeRequest("Can you send me a link please?"), true);
assert.strictEqual(
  looksLikeRequest("Could you let us know who should issue such submission please."),
  true
);
assert.strictEqual(looksLikeRequest("You should have received the paper, is that correct?"), true);

// Genuine closeouts should still pass through
assert.strictEqual(looksLikeRequest("Sounds good, thanks!"), false);
assert.strictEqual(looksLikeRequest("Great, see you then."), false);
assert.strictEqual(looksLikeRequest(""), false);

assert.deepStrictEqual(
  tokenize("Hello, world! Können Sie das prüfen?"),
  ["hello", "world", "können", "sie", "das", "prüfen"]
);
assert.deepStrictEqual(tokenize("ok no way"), ["way"], "drops tokens of length <= 2");

const vec = computeTfidfVector(["foo", "foo", "baz"], { foo: 0, bar: 1 }, [2, 3]);
approxEqual(vec[0], (1 + Math.log(2)) * 2, 1e-9);
assert.strictEqual(vec[1], 0, "unmentioned vocab term stays 0");
assert.strictEqual(vec.length, 2, "vector length matches idf length, unknown tokens ignored");

approxEqual(sigmoid(0), 0.5);
approxEqual(predictProba([1, 0], [2, 3], -1), sigmoid(1));

const vocab3 = ["please", "meeting", "thanks"];
const weights3 = [2, 1, -3];
// vec: "please" and "meeting" present (positive contribution), "thanks" absent (vec=0, ignored)
assert.deepStrictEqual(
  topContributions([1.5, 0.5, 0], vocab3, weights3, 2),
  ["please", "meeting"],
  "ranks present words by contribution, ignores absent (0) ones"
);
assert.deepStrictEqual(
  topContributions([0, 0, 2], vocab3, weights3, 5),
  ["thanks"],
  "a present word with negative contribution still shows up if it's the only one"
);
assert.deepStrictEqual(topContributions([0, 0, 0], vocab3, weights3, 3), [], "no present words -> empty");

// vec: "please" present (positive), "thanks" present (negative) - bottom should surface "thanks" first
assert.deepStrictEqual(
  bottomContributions([1.5, 0, 2], vocab3, weights3, 2),
  ["thanks", "please"],
  "ranks present words most-negative-first, ignores absent (0) ones"
);
assert.deepStrictEqual(bottomContributions([0, 0, 0], vocab3, weights3, 3), [], "no present words -> empty");

// --- training sanity check: does the pipeline actually learn anything? ---
// A tiny, trivially-separable synthetic set: "needs reply" mentions "urgent",
// "no reply needed" mentions "thanks". If trainModel can't separate this, the
// pipeline itself is broken, independent of any real dataset's noise.
const toyRows = [
  { label: 1, tokens: tokenize("urgent please respond soon") },
  { label: 1, tokens: tokenize("urgent question need answer") },
  { label: 1, tokens: tokenize("urgent deadline tomorrow help") },
  { label: 0, tokens: tokenize("thanks appreciate your help") },
  { label: 0, tokens: tokenize("thanks sounds good great") },
  { label: 0, tokens: tokenize("thanks all set now") },
];
assert.deepStrictEqual(
  classWeights([1, 1, 0]).map((w) => Math.round(w * 100) / 100),
  [0.75, 0.75, 1.5],
  "balanced class weights: rarer class gets a bigger weight"
);

const vocabResult = buildVocab(toyRows, 1);
assert.ok(vocabResult.vocab.includes("urgent"), "vocab should include a word repeated across positive rows");
const X = toyRows.map((r) => computeTfidfVector(r.tokens, vocabResult.vocabIndex, vocabResult.idf));
const y = toyRows.map((r) => r.label);
const { w, b } = trainLogReg(X, y, classWeights(y), vocabResult.idf.length, { iters: 500 });
const trainMetrics = evaluateModel(X, y, w, b, 0.5);
assert.strictEqual(trainMetrics.f1, 1, "should perfectly fit a trivially-separable toy set");

const { model } = trainModel(toyRows, { minDf: 1, kFolds: 2 });
assert.ok(model.vocab.length > 0, "trainModel should produce a non-empty vocab");
assert.strictEqual(typeof model.bias, "number");

console.log("ok - all lib.js tests passed");
