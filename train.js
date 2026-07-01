// CLI wrapper around lib.js's trainModel() - the actual algorithm is shared
// with dataset.html's in-page "Train classifier" button, so both stay in
// sync. See lib.js if you're looking for the TF-IDF/logistic-regression code.
//
// Usage: node train.js [path-to-dataset.json]
// Writes model.json next to this script (gitignored - it's derived from your
// own email vocabulary, more sensitive than the code that produces it).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { tokenize, averageMetric, trainModel } = require("./lib.js");

const datasetPath = process.argv[2] || path.join(os.homedir(), "Downloads", "tb-nudge-dataset.json");
const K_FOLDS = 5;
const THRESHOLD = 0.5;

function loadRows(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return raw.map((r) => ({
    label: r.label,
    tokens: tokenize(`${r.subject || ""} ${r.text || ""}`),
  }));
}

console.log(`Loading dataset from ${datasetPath}`);
const rows = loadRows(datasetPath);
const nPos = rows.filter((r) => r.label === 1).length;
const nNeg = rows.length - nPos;
console.log(`${rows.length} rows: ${nPos} positive, ${nNeg} negative`);

console.log(`\nRunning ${K_FOLDS}-fold cross-validation (rough signal only, dataset is tiny)...`);
const { model, cvMetrics } = trainModel(rows, { threshold: THRESHOLD, kFolds: K_FOLDS });
console.log(`Folds evaluated: ${cvMetrics.length}/${K_FOLDS}`);
if (cvMetrics.length > 0) {
  console.log(`Avg precision (needs-reply):    ${averageMetric(cvMetrics, "precision").toFixed(2)}`);
  console.log(`Avg recall (needs-reply):       ${averageMetric(cvMetrics, "recall").toFixed(2)}`);
  console.log(`Avg F1:                         ${averageMetric(cvMetrics, "f1").toFixed(2)}`);
  console.log(`Avg recall on negatives:        ${averageMetric(cvMetrics, "negRecall").toFixed(2)}`);
  console.log(`(negatives = correctly NOT nudging on a "didn't need reply" message)`);
}

console.log("\nTraining final model on the full dataset...");
const outPath = path.join(__dirname, "model.json");
fs.writeFileSync(outPath, JSON.stringify(model, null, 2));
console.log(`Wrote ${outPath} (vocab size ${model.vocab.length})`);
