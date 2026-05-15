const SURFACE = "#111827";
const WHITE = "#ffffff";
const INK = "#e8eef7";
const MUTED = "#9aa8bd";
const GRID = "rgba(255, 255, 255, 0.12)";
const AXIS = "rgba(255, 255, 255, 0.82)";
const COLORS = {
  blue: "#60a5fa",
  cyan: "#22d3ee",
  green: "#2dd4bf",
  purple: "#a78bfa",
  orange: "#fb923c",
  yellow: "#facc15",
  pink: "#f472b6",
  red: "#f87171",
  gray: "rgba(154, 168, 189, 0.45)"
};
const SERIES = [COLORS.blue, COLORS.cyan, COLORS.green, COLORS.purple, COLORS.orange, COLORS.yellow, COLORS.pink, COLORS.red];
const FONT = '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Yu Gothic UI", Meiryo, sans-serif';

const state = {
  measurements: [],
  selectedDate: null,
  selectedSensor: null,
  compareSensor: null,
  compareDates: new Set(),
  datasetName: "デモデータ",
  datasetNote: "フォルダ全体、または複数CSVをまとめて読み込めます。",
  hasUserData: false
};

function $(id) {
  return document.getElementById(id);
}

function chartFont(weight = 700, size = 13) {
  return `${weight} ${size}px ${FONT}`;
}

function getCanvasContext(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.textBaseline = "middle";
  ctx.fillStyle = SURFACE;
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

function parseDateTime(value) {
  const text = String(value || "").trim();
  const m = text.match(/(\d{4})[\/\-年_](\d{1,2})[\/\-月_](\d{1,2})\D+(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d+))?/);
  if (!m) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const ms = m[7] ? Number((m[7] + "000").slice(0, 3)) : 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function splitCSVLine(line) {
  if (!line.includes('"')) return line.split(",");
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function canonicalHeader(header) {
  return String(header || "").trim().toLowerCase().replace(/[\s_\-()]/g, "");
}

function findColumn(headers, candidates) {
  const normalized = headers.map(canonicalHeader);
  for (const candidate of candidates) {
    const idx = normalized.indexOf(canonicalHeader(candidate));
    if (idx >= 0) return idx;
  }
  for (const candidate of candidates) {
    const key = canonicalHeader(candidate);
    const idx = normalized.findIndex((header) => header.includes(key));
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseFileMeta(file) {
  const rel = file.webkitRelativePath || file.name;
  const base = file.name.replace(/\.csv$/i, "");
  const type = /加速度|acc|acceler/i.test(rel) ? "acc" : /心拍|heart|hr/i.test(rel) ? "hr" : null;
  const dateMatch = rel.match(/(20\d{2})[\/_\-年](\d{1,2})[\/_\-月](\d{1,2})/);
  const date = dateMatch ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, "0")}-${String(dateMatch[3]).padStart(2, "0")}` : null;
  const stripped = base.replace(/加速度|心拍数|心拍|Heart Rate|Heart|HR|ACC|Acceleration/ig, "");
  const sensorMatches = stripped.match(/(?:^|[_\-\s])([A-Za-z]*\d{1,6})(?=$|[_\-\s])/g);
  const sensor = sensorMatches && sensorMatches.length ? sensorMatches[sensorMatches.length - 1].replace(/^[_\-\s]+/, "") : "001";
  return { type, date, sensor };
}

function parseAccCSV(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) return { samples: [], firstDate: null };
  const headers = splitCSVLine(lines[0]);
  const tIdx = findColumn(headers, ["Timestamp", "Time", "DateTime", "日時"]);
  const xIdx = findColumn(headers, ["ACC X", "AccX", "X", "Acceleration X"]);
  const yIdx = findColumn(headers, ["ACC Y", "AccY", "Y", "Acceleration Y"]);
  const zIdx = findColumn(headers, ["ACC Z", "AccZ", "Z", "Acceleration Z"]);
  if ([tIdx, xIdx, yIdx, zIdx].some((idx) => idx < 0)) throw new Error("加速度CSV列を判定できません");

  const bins = new Map();
  let baseTime = null;
  let firstDate = null;
  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitCSVLine(lines[i]);
    const d = parseDateTime(cols[tIdx]);
    if (!d) continue;
    if (baseTime === null) {
      baseTime = d.getTime();
      firstDate = dateKey(d);
    }
    const x = Number(cols[xIdx]);
    const y = Number(cols[yIdx]);
    const z = Number(cols[zIdx]);
    if (![x, y, z].every(Number.isFinite)) continue;
    const sec = Math.max(0, Math.floor((d.getTime() - baseTime) / 1000));
    const bin = bins.get(sec) || { sum: 0, count: 0 };
    bin.sum += Math.sqrt(x * x + y * y + z * z);
    bin.count += 1;
    bins.set(sec, bin);
  }
  const samples = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([t, bin]) => ({ t, value: bin.sum / bin.count }));
  return { samples, firstDate };
}

function parseHrCSV(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) return { samples: [], firstDate: null };
  const headers = splitCSVLine(lines[0]);
  const tIdx = findColumn(headers, ["Timestamp", "Time", "DateTime", "日時"]);
  const hrIdx = findColumn(headers, ["Heart Rate", "HeartRate", "HR", "心拍数", "心拍"]);
  if (tIdx < 0 || hrIdx < 0) throw new Error("心拍CSV列を判定できません");

  const bins = new Map();
  let baseTime = null;
  let firstDate = null;
  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitCSVLine(lines[i]);
    const d = parseDateTime(cols[tIdx]);
    if (!d) continue;
    if (baseTime === null) {
      baseTime = d.getTime();
      firstDate = dateKey(d);
    }
    const hr = Number(cols[hrIdx]);
    if (!Number.isFinite(hr) || hr <= 0) continue;
    const sec = Math.max(0, Math.floor((d.getTime() - baseTime) / 1000));
    const bin = bins.get(sec) || { sum: 0, count: 0 };
    bin.sum += hr;
    bin.count += 1;
    bins.set(sec, bin);
  }
  const samples = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([t, bin]) => ({ t, value: bin.sum / bin.count }));
  return { samples, firstDate };
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN;
}

function completeMeasurement(m) {
  const avgAcc = mean(m.acc.map((p) => p.value));
  const avgHr = mean(m.hr.map((p) => p.value));
  const maxHr = m.hr.length ? Math.max(...m.hr.map((p) => p.value)) : NaN;
  const durationSec = Math.max(0, ...m.acc.map((p) => p.t), ...m.hr.map((p) => p.t));
  return { ...m, avgAcc, avgHr, maxHr, durationSec };
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), "ja", { numeric: true, sensitivity: "base" });
}

async function loadFiles(fileList) {
  const files = [...fileList].filter((file) => /\.csv$/i.test(file.name));
  if (!files.length) return;

  const grouped = new Map();
  const errors = [];
  let parsedCount = 0;

  for (const file of files) {
    const meta = parseFileMeta(file);
    if (!meta.type) continue;
    try {
      const text = await file.text();
      const parsed = meta.type === "acc" ? parseAccCSV(text) : parseHrCSV(text);
      const date = meta.date || parsed.firstDate || "unknown-date";
      const key = `${date}|${meta.sensor}`;
      const item = grouped.get(key) || { date, sensor: meta.sensor, acc: [], hr: [], sourceFiles: [] };
      if (meta.type === "acc") item.acc = parsed.samples;
      if (meta.type === "hr") item.hr = parsed.samples;
      item.sourceFiles.push(file.name);
      grouped.set(key, item);
      parsedCount += 1;
    } catch (error) {
      errors.push(`${file.name}: ${error.message}`);
    }
  }

  const incoming = [...grouped.values()]
    .map(completeMeasurement)
    .filter((m) => m.acc.length || m.hr.length)
    .sort((a, b) => a.date.localeCompare(b.date) || naturalCompare(a.sensor, b.sensor));

  if (!incoming.length) {
    alert(["読み込めるCSVがありません。", errors.slice(0, 4).join("\n")].filter(Boolean).join("\n"));
    return;
  }

  const merged = new Map();
  if (state.hasUserData) {
    for (const m of state.measurements) merged.set(`${m.date}|${m.sensor}`, m);
  }

  for (const m of incoming) {
    const key = `${m.date}|${m.sensor}`;
    if (merged.has(key)) {
      const old = merged.get(key);
      merged.set(key, completeMeasurement({
        date: m.date,
        sensor: m.sensor,
        acc: m.acc.length ? m.acc : old.acc,
        hr: m.hr.length ? m.hr : old.hr,
        sourceFiles: [...(old.sourceFiles || []), ...(m.sourceFiles || [])]
      }));
    } else {
      merged.set(key, m);
    }
  }

  state.measurements = [...merged.values()]
    .map(completeMeasurement)
    .filter((m) => m.acc.length || m.hr.length)
    .sort((a, b) => a.date.localeCompare(b.date) || naturalCompare(a.sensor, b.sensor));
  state.hasUserData = true;

  const uploadedDates = [...new Set(incoming.map((m) => m.date))].sort();
  const uploadedSensors = [...new Set(incoming.map((m) => m.sensor))].sort(naturalCompare);
  const focusDate = uploadedDates[uploadedDates.length - 1] || state.selectedDate;
  state.selectedDate = dates().includes(focusDate) ? focusDate : dates()[0];
  const dateSensors = sensorsForDate(state.selectedDate);
  const focusSensor = uploadedSensors.find((sensor) => dateSensors.includes(sensor)) || state.selectedSensor || dateSensors[0];
  state.selectedSensor = dateSensors.includes(focusSensor) ? focusSensor : dateSensors[0] || sensors()[0];
  state.compareSensor = state.selectedSensor || state.compareSensor;
  state.compareDates = new Set(datesForSensor(state.compareSensor));
  state.datasetName = `読込データ ${state.measurements.length}件`;
  state.datasetNote = `今回${parsedCount}ファイルを追加／更新し、全${state.measurements.length}測定を再計算しました。${errors.length ? ` ${errors.length}件の警告があります。` : ""}`;
  updateAll();
}

function dates() {
  return [...new Set(state.measurements.map((m) => m.date))].sort();
}

function sensors() {
  return [...new Set(state.measurements.map((m) => m.sensor))].sort(naturalCompare);
}

function sensorsForDate(date) {
  return [...new Set(state.measurements.filter((m) => m.date === date).map((m) => m.sensor))].sort(naturalCompare);
}

function datesForSensor(sensor) {
  return [...new Set(state.measurements.filter((m) => m.sensor === sensor).map((m) => m.date))].sort();
}

function selectedMeasurement() {
  return state.measurements.find((m) => m.date === state.selectedDate && m.sensor === state.selectedSensor) || null;
}

function selectedCompareMeasurements() {
  return [...state.compareDates]
    .sort()
    .map((date) => state.measurements.find((m) => m.date === date && m.sensor === state.compareSensor))
    .filter(Boolean);
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] === undefined ? sorted[base] : sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function classStats(date, type) {
  const bins = new Map();
  for (const m of state.measurements.filter((item) => item.date === date && item[type].length)) {
    for (const p of m[type]) {
      if (!Number.isFinite(p.value)) continue;
      const bin = bins.get(p.t) || [];
      bin.push(p.value);
      bins.set(p.t, bin);
    }
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([t, values]) => {
    values.sort((a, b) => a - b);
    return { t, q1: quantile(values, 0.25), median: quantile(values, 0.5), q3: quantile(values, 0.75), n: values.length };
  });
}

function dateColor(date) {
  const ds = dates();
  const idx = ds.indexOf(date);
  return SERIES[(idx >= 0 ? idx : 0) % SERIES.length];
}

function drawTitle(ctx, titleText, subtitle, x = 24, y = 28) {
  ctx.fillStyle = WHITE;
  ctx.font = chartFont(900, 17);
  ctx.textAlign = "left";
  ctx.fillText(titleText, x, y);
  if (subtitle) {
    ctx.fillStyle = MUTED;
    ctx.font = chartFont(600, 12);
    ctx.fillText(subtitle, x, y + 24);
  }
}

function drawNoData(canvas, titleText, message) {
  const { ctx } = getCanvasContext(canvas);
  drawTitle(ctx, titleText, message);
}

function chartExtent(series, yMinDefault = 0) {
  const values = [];
  for (const s of series) {
    if (s.points) values.push(...s.points.map((p) => p.value));
    if (s.band) values.push(...s.band.flatMap((p) => [p.q1, p.median, p.q3]));
  }
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { yMin: yMinDefault, yMax: yMinDefault + 1 };
  const maxValue = Math.max(...finite);
  const minValue = Math.min(yMinDefault, ...finite);
  const span = Math.max(1, maxValue - minValue);
  return { yMin: minValue, yMax: Math.ceil((maxValue + span * 0.08) / 5) * 5 };
}

function drawAxes(ctx, plot, xMax, yMin, yMax, yLabel) {
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.left, plot.top);
  ctx.lineTo(plot.left, plot.bottom);
  ctx.lineTo(plot.right, plot.bottom);
  ctx.stroke();

  ctx.font = chartFont(600, 11);
  ctx.fillStyle = INK;
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i += 1) {
    const ratio = i / 5;
    const y = plot.bottom - ratio * (plot.bottom - plot.top);
    const value = yMin + ratio * (yMax - yMin);
    ctx.strokeStyle = i ? GRID : AXIS;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.fillText(value.toFixed(yMax - yMin <= 5 ? 1 : 0), plot.left - 9, y);
  }

  ctx.textAlign = "center";
  for (let i = 0; i <= 6; i += 1) {
    const ratio = i / 6;
    const x = plot.left + ratio * (plot.right - plot.left);
    ctx.fillText(`${Math.round((ratio * xMax) / 60)}分`, x, plot.bottom + 22);
  }

  ctx.save();
  ctx.translate(18, (plot.top + plot.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = MUTED;
  ctx.font = chartFont(700, 12);
  ctx.textAlign = "center";
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}

function drawLine(ctx, points, scaleX, scaleY, color, width = 2.5, alpha = 1) {
  const valid = points.filter((p) => Number.isFinite(p.value));
  if (!valid.length) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  valid.forEach((p, i) => {
    if (i) ctx.lineTo(scaleX(p.t), scaleY(p.value));
    else ctx.moveTo(scaleX(p.t), scaleY(p.value));
  });
  ctx.stroke();
  ctx.restore();
}

function drawBand(ctx, band, scaleX, scaleY, color, alpha = 0.18) {
  const valid = band.filter((p) => Number.isFinite(p.q1) && Number.isFinite(p.q3));
  if (valid.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  valid.forEach((p, i) => {
    if (i) ctx.lineTo(scaleX(p.t), scaleY(p.q3));
    else ctx.moveTo(scaleX(p.t), scaleY(p.q3));
  });
  for (let i = valid.length - 1; i >= 0; i -= 1) ctx.lineTo(scaleX(valid[i].t), scaleY(valid[i].q1));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawSeriesChart(canvas, { titleText, subtitle, yLabel, series, yMin = 0 }) {
  if (!series.some((s) => (s.points && s.points.length) || (s.band && s.band.length))) {
    drawNoData(canvas, titleText, "表示できるデータがありません。");
    return;
  }
  const { ctx, width, height } = getCanvasContext(canvas);
  const plot = { left: 62, right: width - 24, top: 72, bottom: height - 48 };
  drawTitle(ctx, titleText, subtitle);
  const xMax = Math.max(60, ...series.flatMap((s) => [
    ...(s.points || []).map((p) => p.t),
    ...(s.band || []).map((p) => p.t)
  ]));
  const extent = chartExtent(series, yMin);
  drawAxes(ctx, plot, xMax, extent.yMin, extent.yMax, yLabel);
  const scaleX = (t) => plot.left + (t / xMax) * (plot.right - plot.left);
  const scaleY = (v) => plot.bottom - ((v - extent.yMin) / (extent.yMax - extent.yMin)) * (plot.bottom - plot.top);
  for (const s of series) if (s.band) drawBand(ctx, s.band, scaleX, scaleY, s.color || COLORS.blue, s.bandAlpha ?? 0.18);
  for (const s of series) drawLine(ctx, s.points || (s.band ? s.band.map((p) => ({ t: p.t, value: p.median })) : []), scaleX, scaleY, s.color || COLORS.blue, s.width || 2.5, s.alpha ?? 1);
}

function allScatterPoints() {
  return state.measurements.filter((m) => Number.isFinite(m.avgAcc) && Number.isFinite(m.avgHr));
}

function drawArrow(ctx, x1, y1, x2, y2, color) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 13;
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4.2;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - (head + 4) * Math.cos(angle - Math.PI / 6), y2 - (head + 4) * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - (head + 4) * Math.cos(angle + Math.PI / 6), y2 - (head + 4) * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawLabelBox(ctx, text, x, y, color) {
  ctx.save();
  ctx.font = chartFont(900, 11);
  const padX = 7;
  const width = ctx.measureText(text).width + padX * 2;
  const height = 20;
  ctx.fillStyle = "rgba(17, 24, 39, 0.92)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y - height / 2, width, height, 7);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = WHITE;
  ctx.textAlign = "left";
  ctx.fillText(text, x + padX, y);
  ctx.restore();
}

function drawScatter(canvas, { titleText, subtitle, selected = null, vectors = [] }) {
  const points = allScatterPoints();
  if (!points.length) {
    drawNoData(canvas, titleText, "散布図用のデータがありません。");
    return;
  }
  const { ctx, width, height } = getCanvasContext(canvas);
  const plot = { left: 70, right: width - 28, top: 70, bottom: height - 52 };
  drawTitle(ctx, titleText, subtitle);

  const xs = points.map((p) => p.avgAcc);
  const ys = points.map((p) => p.avgHr);
  const xMin = Math.max(0, Math.min(...xs) - 0.05);
  const xMax = Math.max(...xs) + 0.08;
  const yMin = Math.max(0, Math.floor((Math.min(...ys) - 8) / 5) * 5);
  const yMax = Math.ceil((Math.max(...ys) + 8) / 5) * 5;
  const scaleX = (v) => plot.left + ((v - xMin) / (xMax - xMin || 1)) * (plot.right - plot.left);
  const scaleY = (v) => plot.bottom - ((v - yMin) / (yMax - yMin || 1)) * (plot.bottom - plot.top);

  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.left, plot.top);
  ctx.lineTo(plot.left, plot.bottom);
  ctx.lineTo(plot.right, plot.bottom);
  ctx.stroke();
  ctx.font = chartFont(600, 11);
  ctx.fillStyle = INK;
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i += 1) {
    const ratio = i / 5;
    const y = plot.bottom - ratio * (plot.bottom - plot.top);
    const value = yMin + ratio * (yMax - yMin);
    ctx.strokeStyle = i ? GRID : AXIS;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.fillText(value.toFixed(0), plot.left - 9, y);
  }
  ctx.textAlign = "center";
  for (let i = 0; i <= 5; i += 1) {
    const ratio = i / 5;
    const x = plot.left + ratio * (plot.right - plot.left);
    const value = xMin + ratio * (xMax - xMin);
    ctx.fillText(value.toFixed(2), x, plot.bottom + 22);
  }
  ctx.fillStyle = MUTED;
  ctx.font = chartFont(700, 12);
  ctx.fillText("平均加速度ノルム", (plot.left + plot.right) / 2, height - 14);
  ctx.save();
  ctx.translate(18, (plot.top + plot.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("平均心拍数 bpm", 0, 0);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.55;
  for (const p of points) {
    ctx.fillStyle = dateColor(p.date);
    ctx.beginPath();
    ctx.arc(scaleX(p.avgAcc), scaleY(p.avgHr), 4.7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  const legendDates = dates();
  const lx = Math.max(plot.left + 8, plot.right - 178);
  const ly = plot.top + 12;
  ctx.save();
  ctx.font = chartFont(800, 11);
  ctx.textAlign = "left";
  for (let i = 0; i < Math.min(legendDates.length, 8); i += 1) {
    const date = legendDates[i];
    const y = ly + i * 17;
    ctx.fillStyle = dateColor(date);
    ctx.beginPath();
    ctx.arc(lx, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.fillText(date, lx + 10, y);
  }
  if (legendDates.length > 8) {
    ctx.fillStyle = MUTED;
    ctx.fillText(`他 ${legendDates.length - 8}日`, lx + 10, ly + 8 * 17);
  }
  ctx.restore();

  for (let i = 0; i < vectors.length - 1; i += 1) {
    drawArrow(ctx, scaleX(vectors[i].avgAcc), scaleY(vectors[i].avgHr), scaleX(vectors[i + 1].avgAcc), scaleY(vectors[i + 1].avgHr), vectors[i + 1].color || dateColor(vectors[i + 1].date));
  }

  for (const v of vectors) {
    const color = v.color || dateColor(v.date);
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.beginPath();
    ctx.arc(scaleX(v.avgAcc), scaleY(v.avgHr), 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(scaleX(v.avgAcc), scaleY(v.avgHr), 7, 0, Math.PI * 2);
    ctx.fill();
    drawLabelBox(ctx, v.date, scaleX(v.avgAcc) + 10, scaleY(v.avgHr) - 13, color);
  }

  if (selected && Number.isFinite(selected.avgAcc) && Number.isFinite(selected.avgHr)) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.beginPath();
    ctx.arc(scaleX(selected.avgAcc), scaleY(selected.avgHr), 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.yellow;
    ctx.beginPath();
    ctx.arc(scaleX(selected.avgAcc), scaleY(selected.avgHr), 7.5, 0, Math.PI * 2);
    ctx.fill();
    drawLabelBox(ctx, `${selected.sensor} ${selected.date}`, scaleX(selected.avgAcc) + 12, scaleY(selected.avgHr), COLORS.yellow);
  }
}

function formatNumber(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "-";
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}時間${rest}分` : `${minutes}分`;
}

function renderKpis(m) {
  const grid = $("kpiGrid");
  if (!m) {
    grid.innerHTML = '<div class="empty">選択条件に一致するデータがありません。</div>';
    return;
  }
  const rows = [
    ["平均心拍数", formatNumber(m.avgHr, 1), "bpm", `最大 ${formatNumber(m.maxHr, 0)} bpm`],
    ["平均加速度ノルム", formatNumber(m.avgAcc, 3), "g", "ACC X/Y/Zから算出"],
    ["解析時間", formatDuration(m.durationSec), "", `${Math.round(m.durationSec)} 秒`],
    ["有効点数", `${m.hr.length.toLocaleString()} / ${m.acc.length.toLocaleString()}`, "", "心拍 / 加速度ノルム"]
  ];
  grid.innerHTML = rows.map((row) => `
    <article class="kpi">
      <p class="klabel">${row[0]}</p>
      <p class="kvalue">${row[1]}${row[2] ? `<span class="unit">${row[2]}</span>` : ""}</p>
      <p class="sub">${row[3]}</p>
    </article>`).join("");
}

function updateSelectors() {
  $("datasetName").textContent = state.datasetName;
  $("datasetNote").textContent = state.datasetNote;

  const ds = dates();
  if (!state.selectedDate || !ds.includes(state.selectedDate)) state.selectedDate = ds[0] || null;
  $("dateSelect").innerHTML = ds.map((d) => `<option value="${d}" ${d === state.selectedDate ? "selected" : ""}>${d}</option>`).join("");

  const ss = sensorsForDate(state.selectedDate);
  if (!state.selectedSensor || !ss.includes(state.selectedSensor)) state.selectedSensor = ss[0] || sensors()[0] || null;
  $("sensorSelect").innerHTML = ss.map((s) => `<option value="${s}" ${s === state.selectedSensor ? "selected" : ""}>${s}</option>`).join("");

  const allSensors = sensors();
  if (!state.compareSensor || !allSensors.includes(state.compareSensor)) state.compareSensor = state.selectedSensor || allSensors[0] || null;
  $("compareSensorSelect").innerHTML = allSensors.map((s) => `<option value="${s}" ${s === state.compareSensor ? "selected" : ""}>${s}</option>`).join("");

  const compareDateList = datesForSensor(state.compareSensor);
  if (![...state.compareDates].some((d) => compareDateList.includes(d))) {
    state.compareDates = new Set(compareDateList.slice(0, 5));
  }
  $("compareDateChecks").innerHTML = compareDateList.map((d) => `<label class="check"><input type="checkbox" value="${d}" ${state.compareDates.has(d) ? "checked" : ""}>${d}</label>`).join("") || '<div class="empty">このセンサIDには比較可能な計測日がありません。</div>';
}

function updatePersonalCharts() {
  const m = selectedMeasurement();
  renderKpis(m);
  if (!m) return;
  drawSeriesChart($("personalHrChart"), { titleText: "心拍時系列", subtitle: `${m.date} / Sensor ${m.sensor}`, yLabel: "Heart Rate bpm", series: [{ points: m.hr, color: COLORS.yellow, width: 2.8 }] });
  drawSeriesChart($("personalAccChart"), { titleText: "3軸加速度ノルム時系列", subtitle: `${m.date} / Sensor ${m.sensor}`, yLabel: "Acceleration norm g", series: [{ points: m.acc, color: COLORS.cyan, width: 2.4 }] });
  drawSeriesChart($("classAccChart"), {
    titleText: "クラス中央値 加速度",
    subtitle: `${m.date} / IQR帯 + 個人`,
    yLabel: "Acceleration norm g",
    series: [
      { band: classStats(m.date, "acc"), color: COLORS.blue, bandAlpha: 0.20, width: 2.2 },
      { points: m.acc, color: COLORS.yellow, width: 2.0, alpha: 0.95 }
    ]
  });
  drawSeriesChart($("classHrChart"), {
    titleText: "クラス中央値 心拍数",
    subtitle: `${m.date} / IQR帯 + 個人`,
    yLabel: "Heart Rate bpm",
    series: [
      { band: classStats(m.date, "hr"), color: COLORS.blue, bandAlpha: 0.20, width: 2.2 },
      { points: m.hr, color: COLORS.yellow, width: 2.0, alpha: 0.95 }
    ]
  });
  drawScatter($("personalScatterChart"), { titleText: "平均加速度ノルムと平均心拍数", subtitle: "背景: 全員の測定を日別色分け / 黄色: 選択個人", selected: m });
}

function renderLegend(id, measurements) {
  $(id).innerHTML = measurements.map((m) => `<span><i class="dot" style="--c:${dateColor(m.date)}"></i>${m.date}</span>`).join("");
}

function updateCompareCharts() {
  const ms = selectedCompareMeasurements();
  drawSeriesChart($("compareHrChart"), {
    titleText: "心拍時系列の日間比較",
    subtitle: `Sensor ${state.compareSensor || "-"}`,
    yLabel: "Heart Rate bpm",
    series: ms.map((m) => ({ points: m.hr, color: dateColor(m.date), width: 2.3 }))
  });
  drawSeriesChart($("compareAccChart"), {
    titleText: "3軸加速度ノルム時系列の日間比較",
    subtitle: `Sensor ${state.compareSensor || "-"}`,
    yLabel: "Acceleration norm g",
    series: ms.map((m) => ({ points: m.acc, color: dateColor(m.date), width: 2.2 }))
  });
  renderLegend("compareHrLegend", ms);
  renderLegend("compareAccLegend", ms);

  const selectedDates = [...state.compareDates].sort();
  drawSeriesChart($("compareClassAccChart"), {
    titleText: "クラス中央値 加速度の日間比較",
    subtitle: "各日のIQR帯を低透過で表示",
    yLabel: "Acceleration norm g",
    series: selectedDates.map((date) => ({ band: classStats(date, "acc"), color: dateColor(date), bandAlpha: 0.10, width: 2.1 }))
  });
  drawSeriesChart($("compareClassHrChart"), {
    titleText: "クラス中央値 心拍数の日間比較",
    subtitle: "各日のIQR帯を低透過で表示",
    yLabel: "Heart Rate bpm",
    series: selectedDates.map((date) => ({ band: classStats(date, "hr"), color: dateColor(date), bandAlpha: 0.10, width: 2.1 }))
  });
  drawScatter($("compareScatterChart"), {
    titleText: "散布図上の個人内変化ベクトル",
    subtitle: `Sensor ${state.compareSensor || "-"} / 背景: 全員の測定を日別色分け`,
    vectors: ms.filter((m) => Number.isFinite(m.avgAcc) && Number.isFinite(m.avgHr)).map((m) => ({ ...m, color: dateColor(m.date) }))
  });
}

function updateAll() {
  updateSelectors();
  updatePersonalCharts();
  updateCompareCharts();
}

function createDemoData() {
  const demoDates = ["2026-01-08", "2026-01-15", "2026-01-22"];
  const demoSensors = ["001", "002", "003", "004", "005", "006"];
  const out = [];
  for (let di = 0; di < demoDates.length; di += 1) {
    for (let si = 0; si < demoSensors.length; si += 1) {
      const acc = [];
      const hr = [];
      const baseHr = 82 + si * 3 + di * 4;
      const phase = si * 0.8 + di * 0.4;
      for (let t = 0; t <= 3600; t += 1) {
        const warmup = 1 / (1 + Math.exp(-(t - 420) / 90));
        const wave = Math.sin(t / 240 + phase) * 0.18 + Math.sin(t / 60 + phase) * 0.06;
        const burst = Math.max(0, Math.sin((t - 900) / 160)) * 0.24 + Math.max(0, Math.sin((t - 2100) / 180)) * 0.18;
        const accValue = Math.max(0.04, 0.92 + wave + burst + si * 0.012 + di * 0.018);
        const hrValue = baseHr + warmup * 18 + burst * 48 + Math.sin(t / 310 + phase) * 5;
        acc.push({ t, value: accValue });
        if (t > 120) hr.push({ t, value: hrValue });
      }
      out.push(completeMeasurement({ date: demoDates[di], sensor: demoSensors[si], acc, hr, sourceFiles: [] }));
    }
  }
  return out;
}

function resetDemo() {
  state.measurements = createDemoData();
  state.selectedDate = dates()[0];
  state.selectedSensor = sensorsForDate(state.selectedDate)[0];
  state.compareSensor = state.selectedSensor;
  state.compareDates = new Set(datesForSensor(state.compareSensor));
  state.datasetName = "デモデータ";
  state.datasetNote = "実データを読み込むと、ここが読込ファイル数に更新されます。";
  state.hasUserData = false;
  updateAll();
}

function setupEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab;
      document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item.dataset.tab === tab));
      document.querySelectorAll(".page").forEach((item) => item.classList.toggle("active", item.dataset.page === tab));
      window.setTimeout(updateAll, 30);
    });
  });

  $("folderInput").addEventListener("change", (e) => {
    loadFiles(e.target.files);
    e.target.value = "";
  });
  $("filesInput").addEventListener("change", (e) => {
    loadFiles(e.target.files);
    e.target.value = "";
  });
  $("resetDemo").addEventListener("click", resetDemo);
  $("dateSelect").addEventListener("change", (e) => {
    state.selectedDate = e.target.value;
    state.selectedSensor = sensorsForDate(state.selectedDate)[0] || state.selectedSensor;
    updateAll();
  });
  $("sensorSelect").addEventListener("change", (e) => {
    state.selectedSensor = e.target.value;
    updateAll();
  });
  $("compareSensorSelect").addEventListener("change", (e) => {
    state.compareSensor = e.target.value;
    state.compareDates = new Set(datesForSensor(state.compareSensor).slice(0, 5));
    updateAll();
  });
  $("compareDateChecks").addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    if (e.target.checked) state.compareDates.add(e.target.value);
    else state.compareDates.delete(e.target.value);
    updateCompareCharts();
  });
  window.addEventListener("resize", () => {
    window.clearTimeout(window.__resizeTimer);
    window.__resizeTimer = window.setTimeout(updateAll, 120);
  });
}

setupEvents();
resetDemo();
