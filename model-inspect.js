const TOP_N = 40;

function renderTable(tableEl, entries, cssClass) {
  tableEl.innerHTML = "";
  for (const { word, weight } of entries) {
    const row = document.createElement("tr");
    row.className = cssClass;
    const wordCell = document.createElement("td");
    wordCell.textContent = word;
    const weightCell = document.createElement("td");
    weightCell.className = "weight";
    weightCell.textContent = weight.toFixed(3);
    row.appendChild(wordCell);
    row.appendChild(weightCell);
    tableEl.appendChild(row);
  }
}

async function main() {
  let model;
  try {
    const res = await fetch(browser.runtime.getURL("model.json"));
    if (!res.ok) throw new Error("not found");
    model = await res.json();
  } catch (e) {
    document.getElementById("empty").style.display = "block";
    return;
  }

  document.getElementById("content").style.display = "block";
  document.getElementById("vocabSize").textContent = model.vocab.length;
  document.getElementById("bias").textContent = model.bias.toFixed(3);

  const entries = model.vocab.map((word, i) => ({ word, weight: model.weights[i] }));
  const needsReply = [...entries].sort((a, b) => b.weight - a.weight).slice(0, TOP_N);
  const noReplyNeeded = [...entries].sort((a, b) => a.weight - b.weight).slice(0, TOP_N);

  renderTable(document.getElementById("needsTable"), needsReply, "needs");
  renderTable(document.getElementById("noneedTable"), noReplyNeeded, "noneed");
}

main();
