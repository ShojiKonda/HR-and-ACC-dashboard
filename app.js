const state = {
  manifest: [],
  currentMeta: null,
  currentRows: []
};

const MAX_POINTS = 5000;

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await initialize();
  } catch (error) {
    console.error(error);
    alert("初期化に失敗しました: " + error.message);
  }
});

async function initialize() {
  state.manifest = await loadManifest();

  populatePlayerSelect();
  populateDateSelect();
  populateSessionSelect();

  document.getElementById("playerSelect").addEventListener("change", handlePlayerChange);
  document.getElementById("dateSelect").addEventListener("change", handleDateChange);
  document.getElementById("sessionSelect").addEventListener("change", renderCurrentSelection);
  document.getElementById("reloadBtn").addEventListener("click", renderCurrentSelection);

  await renderCurrentSelection();
}

async function loadManifest() {
  const res = await fetch("manifest.json");
  if (!res.ok) {
    throw new Error("manifest.json を読み込めません");
  }
  return await res.json();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function populatePlayerSelect() {
  const select = document.getElementById("playerSelect");
  const players = uniqueSorted(state.manifest.map(item => item.player_id));

  select.innerHTML = players
    .map(playerId => `<option value="${playerId}">${playerId}</option>`)
    .join("");
}

function populateDateSelect() {
  const playerId = document.getElementById("playerSelect").value;
  const select = document.getElementById("dateSelect");

  const dates = uniqueSorted(
    state.manifest
      .filter(item => item.player_id === playerId)
      .map(item => item.date)
  );

  select.innerHTML = dates
    .map(date => `<option value="${date}">${date}</option>`)
    .join("");
}

function getSessionLabel(item) {
  const start = item.start_time || "----";
  const end = item.end_time || "----";
  return `${start}-${end}`;
}

function populateSessionSelect() {
  const playerId = document.getElementById("playerSelect").value;
  const date = document.getElementById("dateSelect").value;
  const select = document.getElementById("sessionSelect");

  const sessions = state.manifest.filter(item =>
    item.player_id === playerId && item.date === date
  );

  select.innerHTML = sessions
    .map((item, index) => `<option value="${index}">${getSessionLabel(item)}</option>`)
    .join("");
}

function handlePlayerChange() {
  populateDateSelect();
  populateSessionSelect();
  renderCurrentSelection();
}

function handleDateChange() {
  populateSessionSelect();
  renderCurrentSelection();
}

function getSelectedMeta() {
  const playerId = document.getElementById("playerSelect").value;
  const date = document.getElementById("dateSelect").value;
  const sessionIndex = Number(document.getElementById("sessionSelect").value || 0);

  const sessions = state.manifest.filter(item =>
    item.player_id === playerId && item.date === date
  );

  return sessions[sessionIndex] || null;
}

async function renderCurrentSelection() {
  const meta = getSelectedMeta();
  if (!meta) {
    clearDisplay();
    return;
  }

  state.currentMeta = meta;

  const csvText = await loadText(meta.file);
  const rows = parseCSV(csvText)
    .map(normalizeRow)
    .filter(r =>
      Number.isFinite(r.t) &&
      Number.isFinite(r.acc_mag) &&
      Number.isFinite(r.heart_rate)
    );

  state.currentRows = rows;

  clearDisplay();

  try {
    renderSummary(meta, rows);
    renderMetaInfo(meta, rows);
  } catch (error) {
    console.error("summary/meta render error:", error);
  }

  try {
    renderTimeSeriesChart(rows);
  } catch (error) {
    console.error("timeSeriesChart render error:", error);
    document.getElementById("timeSeriesChart").innerHTML = "<p>時系列グラフの描画に失敗しました。</p>";
  }

  try {
    renderScatter(rows);
  } catch (error) {
    console.error("scatterChart render error:", error);
    document.getElementById("scatterChart").innerHTML = "<p>散布図の描画に失敗しました。</p>";
  }
}

async function loadText(path) {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`ファイルを読み込めません: ${path}`);
  }
  return await res.text();
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim());

  return lines.slice(1).map(line => {
    const values = line.split(",");
    const row = {};
    headers.forEach((header, i) => {
      row[header] = (values[i] ?? "").trim();
    });
    return row;
  });
}

function normalizeRow(row) {
  return {
    timestamp: row.timestamp,
    t: toMillis(row.timestamp),
    acc_mag: Number(row.acc_mag),
    heart_rate: Number(row.heart_rate)
  };
}

function toMillis(timestamp) {
  const t = new Date(timestamp).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function basicStats(values) {
  let count = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    count += 1;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (count === 0) {
    return { mean: NaN, min: NaN, max: NaN };
  }

  return {
    mean: sum / count,
    min,
    max
  };
}

function correlation(x, y) {
  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;

  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const a = x[i];
    const b = y[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

    n += 1;
    sumX += a;
    sumY += b;
    sumXY += a * b;
    sumXX += a * a;
    sumYY += b * b;
  }

  if (n < 2) return NaN;

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));

  if (!Number.isFinite(denominator) || denominator === 0) return NaN;
  return numerator / denominator;
}

function downsampleRows(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;

  const step = Math.ceil(rows.length / maxPoints);
  const sampled = [];
  for (let i = 0; i < rows.length; i += step) {
    sampled.push(rows[i]);
  }
  return sampled;
}

function renderSummary(meta, rows) {
  const accValues = rows.map(r => r.acc_mag);
  const hrValues = rows.map(r => r.heart_rate);

  const accStats = basicStats(accValues);
  const hrStats = basicStats(hrValues);
  const corr = correlation(accValues, hrValues);

  const cards = [
    { label: "選手ID", value: meta.player_id || "-" },
    { label: "日付", value: meta.date || "-" },
    { label: "データ点数", value: rows.length.toString() },
    { label: "平均加速度", value: Number.isFinite(accStats.mean) ? accStats.mean.toFixed(2) : "-" },
    { label: "最大加速度", value: Number.isFinite(accStats.max) ? accStats.max.toFixed(2) : "-" },
    { label: "平均心拍", value: Number.isFinite(hrStats.mean) ? `${hrStats.mean.toFixed(1)} bpm` : "-" },
    { label: "最大心拍", value: Number.isFinite(hrStats.max) ? `${hrStats.max.toFixed(1)} bpm` : "-" },
    { label: "相関", value: Number.isFinite(corr) ? corr.toFixed(3) : "-" }
  ];

  const container = document.getElementById("summaryCards");
  container.innerHTML = cards.map(card => `
    <div class="summary-card">
      <div class="label">${card.label}</div>
      <div class="value">${card.value}</div>
    </div>
  `).join("");
}

function renderMetaInfo(meta, rows) {
  const first = rows[0]?.timestamp || "-";
  const last = rows[rows.length - 1]?.timestamp || "-";

  const html = `
    <div><strong>選手ID:</strong> ${meta.player_id || "-"}</div>
    <div><strong>選手名:</strong> ${meta.player_name || "-"}</div>
    <div><strong>日付:</strong> ${meta.date || "-"}</div>
    <div><strong>時間帯:</strong> ${meta.start_time || "-"} - ${meta.end_time || "-"}</div>
    <div><strong>セッション種別:</strong> ${meta.session_type || "-"}</div>
    <div><strong>CSV:</strong> <code>${meta.file || "-"}</code></div>
    <div><strong>先頭時刻:</strong> ${first}</div>
    <div><strong>末尾時刻:</strong> ${last}</div>
  `;

  document.getElementById("metaInfo").innerHTML = html;
}

function renderTimeSeriesChart(rows) {
  const sampled = downsampleRows(rows, MAX_POINTS);

  const x = sampled.map(r => r.timestamp);
  const acc = sampled.map(r => r.acc_mag);
  const hr = sampled.map(r => r.heart_rate);

  Plotly.newPlot("timeSeriesChart", [
    {
      x,
      y: acc,
      type: "scattergl",
      mode: "lines",
      name: "Acceleration Magnitude",
      yaxis: "y1"
    },
    {
      x,
      y: hr,
      type: "scattergl",
      mode: "lines",
      name: "Heart Rate",
      yaxis: "y2"
    }
  ], {
    margin: { t: 20 },
    xaxis: { title: "Time" },
    yaxis: { title: "Acceleration Magnitude", side: "left" },
    yaxis2: {
      title: "Heart Rate (bpm)",
      overlaying: "y",
      side: "right"
    },
    legend: { orientation: "h" }
  }, {
    responsive: true
  });
}

function renderScatter(rows) {
  const sampled = downsampleRows(rows, MAX_POINTS);

  const x = sampled.map(r => r.acc_mag);
  const y = sampled.map(r => r.heart_rate);
  const text = sampled.map(r => r.timestamp);

  Plotly.newPlot("scatterChart", [
    {
      x,
      y,
      text,
      type: "scattergl",
      mode: "markers",
      name: "HR vs ACC"
    }
  ], {
    margin: { t: 20 },
    xaxis: { title: "Acceleration Magnitude" },
    yaxis: { title: "Heart Rate (bpm)" }
  }, {
    responsive: true
  });
}

function clearDisplay() {
  document.getElementById("summaryCards").innerHTML = "";
  document.getElementById("metaInfo").innerHTML = "";

  ["timeSeriesChart", "scatterChart"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      try {
        Plotly.purge(id);
      } catch (e) {
      }
      el.innerHTML = "";
    }
  });
}
