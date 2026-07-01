// Trains the "does this sent message need a reply" classifier from the
// weak-supervision dataset built by dataset.html. Plain TF-IDF + logistic
// regression, hand-rolled: the dataset is tiny (dozens of rows), not worth a
// dependency for.
//
// Usage: node train.js [path-to-dataset.json]
// Writes model.json next to this script (gitignored - it's derived from your
// own email vocabulary, more sensitive than the code that produces it).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { tokenize, computeTfidfVector, sigmoid, predictProba } = require("./lib.js");

const datasetPath = process.argv[2] || path.join(os.homedir(), "Downloads", "tb-nudge-dataset.json");
const MIN_DF = 2; // drop singleton tokens - too few examples to trust them
const L2 = 0.01;
const LR = 0.5;
const ITERS = 2000;
const K_FOLDS = 5;
const THRESHOLD = 0.5;

function loadRows(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return raw.map((r) => ({
    label: r.label,
    tokens: tokenize(`${r.subject || ""} ${r.text || ""}`),
  }));
}

function buildVocab(rows) {
  const df = new Map();
  for (const row of rows) {
    for (const t of new Set(row.tokens)) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const vocab = [...df.entries()].filter(([, count]) => count >= MIN_DF).map(([t]) => t);
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

function trainLogReg(X, y, sampleWeights, dims) {
  const w = new Array(dims).fill(0);
  let b = 0;
  const n = X.length;
  for (let iter = 0; iter < ITERS; iter++) {
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
      w[j] -= LR * (gradW[j] / n + L2 * w[j]);
    }
    b -= LR * (gradB / n);
  }
  return { w, b };
}

function evaluate(X, y, w, b, threshold) {
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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function kFoldCV(rows, k) {
  const indices = shuffle(rows.map((_, i) => i));
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
    const { w, b } = trainLogReg(Xtrain, ytrain, sampleWeights, dims);

    const Xtest = testRows.map((r) => computeTfidfVector(r.tokens, vocabIndex, idf));
    const ytest = testRows.map((r) => r.label);
    metrics.push(evaluate(Xtest, ytest, w, b, THRESHOLD));
  }
  return metrics;
}

function average(metrics, key) {
  return metrics.reduce((s, m) => s + m[key], 0) / metrics.length;
}

console.log(`Loading dataset from ${datasetPath}`);
const rows = loadRows(datasetPath);
const nPos = rows.filter((r) => r.label === 1).length;
const nNeg = rows.length - nPos;
console.log(`${rows.length} rows: ${nPos} positive, ${nNeg} negative`);

console.log(`\nRunning ${K_FOLDS}-fold cross-validation (rough signal only, dataset is tiny)...`);
const cvMetrics = kFoldCV(rows, K_FOLDS);
console.log(`Folds evaluated: ${cvMetrics.length}/${K_FOLDS}`);
if (cvMetrics.length > 0) {
  console.log(`Avg precision (needs-reply):    ${average(cvMetrics, "precision").toFixed(2)}`);
  console.log(`Avg recall (needs-reply):       ${average(cvMetrics, "recall").toFixed(2)}`);
  console.log(`Avg F1:                         ${average(cvMetrics, "f1").toFixed(2)}`);
  console.log(`Avg recall on negatives:        ${average(cvMetrics, "negRecall").toFixed(2)}`);
  console.log(`(negatives = correctly NOT nudging on a "didn't need reply" message)`);
}

console.log("\nTraining final model on the full dataset...");
const { vocab, vocabIndex, idf } = buildVocab(rows);
const X = rows.map((r) => computeTfidfVector(r.tokens, vocabIndex, idf));
const y = rows.map((r) => r.label);
const sampleWeights = classWeights(y);
const { w, b } = trainLogReg(X, y, sampleWeights, idf.length);

const outPath = path.join(__dirname, "model.json");
fs.writeFileSync(
  outPath,
  JSON.stringify({ vocab, idf, weights: w, bias: b, threshold: THRESHOLD }, null, 2)
);
console.log(`Wrote ${outPath} (vocab size ${vocab.length})`);
