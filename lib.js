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

// Lowercase, drop everything but letters (incl. German umlauts/ß since the
// mailbox is English/German-mixed), drop very short tokens.
function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-zäöüß\s]/gi, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

// vocabIndex: plain object token -> index (not a Map, so it round-trips
// through JSON as model.json without conversion). idf: array aligned to it.
function computeTfidfVector(tokens, vocabIndex, idf) {
  const vec = new Array(idf.length).fill(0);
  const counts = {};
  for (const t of tokens) {
    const idx = vocabIndex[t];
    if (idx === undefined) continue;
    counts[idx] = (counts[idx] || 0) + 1;
  }
  for (const idxStr of Object.keys(counts)) {
    const idx = Number(idxStr);
    vec[idx] = (1 + Math.log(counts[idxStr])) * idf[idx];
  }
  return vec;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function predictProba(vec, weights, bias) {
  let z = bias;
  for (let i = 0; i < vec.length; i++) z += vec[i] * weights[i];
  return sigmoid(z);
}

function presentContributions(vec, vocab, weights) {
  const contributions = [];
  for (let i = 0; i < vec.length; i++) {
    if (vec[i] === 0) continue;
    contributions.push({ word: vocab[i], contribution: vec[i] * weights[i] });
  }
  return contributions;
}

// Words actually present in this message, ranked by how much they pushed the
// prediction (their tfidf value times their learned weight), highest first.
// This is the explanation for a NUDGE: "flagged mostly because of these words."
function topContributions(vec, vocab, weights, n) {
  return presentContributions(vec, vocab, weights)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, n)
    .map((c) => c.word);
}

// Same, but lowest (most negative) contribution first - the explanation for a
// SUPPRESSED nudge: "not flagged mostly because of these words."
function bottomContributions(vec, vocab, weights, n) {
  return presentContributions(vec, vocab, weights)
    .sort((a, b) => a.contribution - b.contribution)
    .slice(0, n)
    .map((c) => c.word);
}

// --- Training (TF-IDF + logistic regression). Shared between train.js
// (Node CLI) and dataset.js (in-page training), so both stay in sync. ---

function buildVocab(rows, minDf) {
  const df = new Map();
  for (const row of rows) {
    for (const t of new Set(row.tokens)) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const min = minDf === undefined ? 2 : minDf;
  const vocab = [...df.entries()].filter(([, count]) => count >= min).map(([t]) => t);
  const vocabIndex = {};
  vocab.forEach((t, i) => {
    vocabIndex[t] = i;
  });
  const n = rows.length;
  const idf = vocab.map((t) => Math.log((n + 1) / (df.get(t) + 1)) + 1);
  return { vocab, vocabIndex, idf };
}

function classWeights(labels) {
  const n = labels.length;
  const nPos = labels.filter((y) => y === 1).length;
  const nNeg = n - nPos;
  const wPos = n / (2 * nPos);
  const wNeg = n / (2 * nNeg);
  return labels.map((y) => (y === 1 ? wPos : wNeg));
}

function trainLogReg(X, y, sampleWeights, dims, opts) {
  const iters = (opts && opts.iters) || 2000;
  const l2 = (opts && opts.l2) || 0.01;
  const lr = (opts && opts.lr) || 0.5;
  const w = new Array(dims).fill(0);
  let b = 0;
  const n = X.length;
  for (let iter = 0; iter < iters; iter++) {
    const gradW = new Array(dims).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const p = predictProba(X[i], w, b);
      const err = (p - y[i]) * sampleWeights[i];
      for (let j = 0; j < dims; j++) {
        if (X[i][j] !== 0) gradW[j] += err * X[i][j];
      }
      gradB += err;
    }
    for (let j = 0; j < dims; j++) {
      w[j] -= lr * (gradW[j] / n + l2 * w[j]);
    }
    b -= lr * (gradB / n);
  }
  return { w, b };
}

function evaluateModel(X, y, w, b, threshold) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (let i = 0; i < X.length; i++) {
    const pred = predictProba(X[i], w, b) >= threshold ? 1 : 0;
    if (pred === 1 && y[i] === 1) tp++;
    else if (pred === 1 && y[i] === 0) fp++;
    else if (pred === 0 && y[i] === 0) tn++;
    else fn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const negRecall = tn + fp === 0 ? 0 : tn / (tn + fp);
  return { tp, fp, tn, fn, precision, recall, f1, negRecall };
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function kFoldCV(rows, k, threshold, trainOpts) {
  const indices = shuffleArray(rows.map((_, i) => i));
  const foldSize = Math.ceil(indices.length / k);
  const metrics = [];
  for (let f = 0; f < k; f++) {
    const testIdx = new Set(indices.slice(f * foldSize, (f + 1) * foldSize));
    const trainRows = rows.filter((_, i) => !testIdx.has(i));
    const testRows = rows.filter((_, i) => testIdx.has(i));
    if (trainRows.filter((r) => r.label === 0).length === 0 || testRows.length === 0) {
      continue; // degenerate fold (no negatives to learn from) - skip
    }

    const { vocabIndex, idf } = buildVocab(trainRows);
    const dims = idf.length;
    const Xtrain = trainRows.map((r) => computeTfidfVector(r.tokens, vocabIndex, idf));
    const ytrain = trainRows.map((r) => r.label);
    const sampleWeights = classWeights(ytrain);
    const { w, b } = trainLogReg(Xtrain, ytrain, sampleWeights, dims, trainOpts);

    const Xtest = testRows.map((r) => computeTfidfVector(r.tokens, vocabIndex, idf));
    const ytest = testRows.map((r) => r.label);
    metrics.push(evaluateModel(Xtest, ytest, w, b, threshold));
  }
  return metrics;
}

function averageMetric(metrics, key) {
  return metrics.reduce((s, m) => s + m[key], 0) / metrics.length;
}

// Full pipeline: rows ({label, tokens}) in, {vocab, idf, weights, bias,
// threshold, cvMetrics} out. Used by both train.js and dataset.js so the
// in-page "Train classifier" button and the CLI script can't drift apart.
function trainModel(rows, opts) {
  const minDf = opts && opts.minDf;
  const threshold = (opts && opts.threshold) || 0.5;
  const kFolds = (opts && opts.kFolds) || 5;
  const trainOpts = opts && opts.trainOpts;

  const cvMetrics = kFoldCV(rows, kFolds, threshold, trainOpts);

  const { vocab, vocabIndex, idf } = buildVocab(rows, minDf);
  const X = rows.map((r) => computeTfidfVector(r.tokens, vocabIndex, idf));
  const y = rows.map((r) => r.label);
  const sampleWeights = classWeights(y);
  const { w, b } = trainLogReg(X, y, sampleWeights, idf.length, trainOpts);

  return {
    model: { vocab, idf, weights: w, bias: b, threshold },
    cvMetrics,
  };
}

if (typeof module !== "undefined") {
  module.exports = {
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
    shuffleArray,
    kFoldCV,
    averageMetric,
    trainModel,
  };
}
