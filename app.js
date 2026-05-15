const SURFACE = "#111827";
const WHITE = "#ffffff";
const INK = "#e8eef7";
const MUTED = "#9aa8bd";
const GRID = "rgba(255,255,255,.12)";
const AXIS = "rgba(255,255,255,.82)";
const C = {
  blue: "#60a5fa",
  cyan: "#22d3ee",
  green: "#2dd4bf",
  purple: "#a78bfa",
  orange: "#fb923c",
  yellow: "#facc15",
  pink: "#f472b6",
  red: "#f87171",
  gray: "rgba(154,168,189,.45)"
};
const SERIES = [C.blue, C.cyan, C.green, C.purple, C.orange, C.yellow, C.pink, C.red];
const FONT = '"Noto Sans JP","Hiragino Sans","Yu Gothic","Yu Gothic UI",Meiryo,sans-serif';
const ACC_SMOOTH_SEC = 5;

const state = {
  measurements: [],
  selectedDate: null,
  selectedSensor: null,
  compareSensor: null,
  compareDates: new Set(),
  timeStart: null,
  timeEnd: null,
  datasetName: "読み込み中",
  datasetNote: "data/index.json を確認しています。"
};

function $(id) { return document.getElementById(id); }
function fnt(weight = 700, size = 13) { return `${weight} ${size}px ${FONT}`; }
function setStatus(name, note) {
  state.datasetName = name;
  state.datasetNote = note;
  $("datasetName").textContent = name;
  $("datasetNote").textContent = note;
}

function canvasContext(canvas) {
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
function secOfDay(d) { return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); }
function timeLabel(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600) % 24;
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function splitCSV(line) {
  if (!line.includes('"')) return line.split(",");
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function canonicalHeader(value) { return String(value || "").trim().toLowerCase().replace(/[\s_\-()]/g, ""); }
function findColumn(headers, candidates) {
  const hs = headers.map(canonicalHeader);
  for (const c of candidates) {
    const i = hs.indexOf(canonicalHeader(c));
    if (i >= 0) return i;
  }
  for (const c of candidates) {
    const key = canonicalHeader(c);
    const i = hs.findIndex(h => h.includes(key));
    if (i >= 0) return i;
  }
  return -1;
}
function parseMeta(path) {
  const name = path.split("/").pop() || path;
  const base = name.replace(/\.csv$/i, "");
  const type = /加速度|acc|acceler/i.test(path) ? "acc" : /心拍|heart|hr/i.test(path) ? "hr" : null;
  const dm = path.match(/(20\d{2})[\/_\-年](\d{1,2})[\/_\-月](\d{1,2})/);
  const date = dm ? `${dm[1]}-${String(dm[2]).padStart(2, "0")}-${String(dm[3]).padStart(2, "0")}` : null;
  const stripped = base.replace(/加速度|心拍数|心拍|Heart Rate|Heart|HR|ACC|Acceleration/ig, "");
  const matches = stripped.match(/(?:^|[_\-\s])([A-Za-z]*\d{1,6})(?=$|[_\-\s])/g);
  const sensor = matches && matches.length ? matches[matches.length - 1].replace(/^[_\-\s]+/, "") : "001";
  return { type, date, sensor, name };
}

function parseAccCSV(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return { samples: [], firstDate: null };
  const headers = splitCSV(lines[0]);
  const ti = findColumn(headers, ["Timestamp", "Time", "DateTime", "日時"]);
  const xi = findColumn(headers, ["ACC X", "AccX", "X", "Acceleration X"]);
  const yi = findColumn(headers, ["ACC Y", "AccY", "Y", "Acceleration Y"]);
  const zi = findColumn(headers, ["ACC Z", "AccZ", "Z", "Acceleration Z"]);
  if ([ti, xi, yi, zi].some(i => i < 0)) throw new Error("加速度CSV列を判定できません");
  const bins = new Map();
  let firstDate = null;
  for (let i = 1; i < lines.length; i++) {
    const row = splitCSV(lines[i]);
    const d = parseDateTime(row[ti]);
    if (!d) continue;
    if (!firstDate) firstDate = dateKey(d);
    const x = Number(row[xi]);
    const y = Number(row[yi]);
    const z = Number(row[zi]);
    if (![x, y, z].every(Number.isFinite)) continue;
    const sec = secOfDay(d);
    const b = bins.get(sec) || { sum: 0, count: 0 };
    b.sum += Math.sqrt(x * x + y * y + z * z);
    b.count += 1;
    bins.set(sec, b);
  }
  const samples = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([x, b]) => ({ x, value: b.sum / b.count }));
  return { samples, firstDate };
}
function parseHrCSV(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return { samples: [], firstDate: null };
  const headers = splitCSV(lines[0]);
  const ti = findColumn(headers, ["Timestamp", "Time", "DateTime", "日時"]);
  const hi = findColumn(headers, ["Heart Rate", "HeartRate", "HR", "心拍数", "心拍"]);
  if (ti < 0 || hi < 0) throw new Error("心拍CSV列を判定できません");
  const bins = new Map();
  let firstDate = null;
  for (let i = 1; i < lines.length; i++) {
    const row = splitCSV(lines[i]);
    const d = parseDateTime(row[ti]);
    if (!d) continue;
    if (!firstDate) firstDate = dateKey(d);
    const hr = Number(row[hi]);
    if (!Number.isFinite(hr) || hr <= 0) continue;
    const sec = secOfDay(d);
    const b = bins.get(sec) || { sum: 0, count: 0 };
    b.sum += hr;
    b.count += 1;
    bins.set(sec, b);
  }
  const samples = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([x, b]) => ({ x, value: b.sum / b.count }));
  return { samples, firstDate };
}

function naturalCompare(a, b) { return String(a).localeCompare(String(b), "ja", { numeric: true, sensitivity: "base" }); }
function mean(values) {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      sum += value;
      count += 1;
    }
  }
  return count ? sum / count : NaN;
}
function safeMax(values, fallback = 0) {
  let max = -Infinity;
  for (const value of values) {
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max === -Infinity ? fallback : max;
}
function completeMeasurement(m) {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of m.hr) {
    if (Number.isFinite(p.x)) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
  }
  for (const p of m.acc) {
    if (Number.isFinite(p.x)) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
  }
  if (minX === Infinity) {
    minX = 0;
    maxX = 0;
  }
  return { ...m, startX: minX, endX: maxX };
}
function dates() { return [...new Set(state.measurements.map(m => m.date))].sort(); }
function sensors() { return [...new Set(state.measurements.map(m => m.sensor))].sort(naturalCompare); }
function sensorsForDate(date) { return [...new Set(state.measurements.filter(m => m.date === date).map(m => m.sensor))].sort(naturalCompare); }
function datesForSensor(sensor) { return [...new Set(state.measurements.filter(m => m.sensor === sensor).map(m => m.date))].sort(); }
function selectedMeasurement() { return state.measurements.find(m => m.date === state.selectedDate && m.sensor === state.selectedSensor) || null; }
function selectedCompareMeasurements() {
  return [...state.compareDates].sort().map(d => state.measurements.find(m => m.date === d && m.sensor === state.compareSensor)).filter(Boolean);
}
function dateColor(date) {
  const ds = dates();
  const i = ds.indexOf(date);
  return SERIES[(i >= 0 ? i : 0) % SERIES.length];
}

function boundsForAllData() {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const m of state.measurements) {
    for (const p of m.hr) {
      if (Number.isFinite(p.x)) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
      }
    }
    for (const p of m.acc) {
      if (Number.isFinite(p.x)) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
      }
    }
  }
  if (minX === Infinity) return null;
  return { min: minX, max: maxX };
}
function ensureTimeRange() {
  const b = boundsForAllData();
  if (!b) return;
  const start = Math.floor(b.min / 300) * 300;
  const end = Math.ceil(b.max / 300) * 300;
  if (state.timeStart === null || state.timeStart < start || state.timeStart >= end) state.timeStart = start;
  if (state.timeEnd === null || state.timeEnd > end || state.timeEnd <= state.timeStart) state.timeEnd = end;
}
function timeOptions() {
  const b = boundsForAllData();
  if (!b) return [];
  const start = Math.floor(b.min / 300) * 300;
  const end = Math.ceil(b.max / 300) * 300;
  const out = [];
  for (let s = start; s <= end; s += 300) out.push(s);
  return out;
}
function inTimeRange(p) { return p.x >= state.timeStart && p.x <= state.timeEnd; }
function filterRange(samples) { return samples.filter(inTimeRange); }

function smoothSamples(samples, windowSec = ACC_SMOOTH_SEC) {
  const src = [...samples].sort((a, b) => a.x - b.x);
  if (!src.length) return [];
  const half = windowSec / 2;
  const out = [];
  let left = 0, right = 0, sum = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i].x;
    while (right < src.length && src[right].x <= x + half) {
      sum += src[right].value;
      right += 1;
    }
    while (left < src.length && src[left].x < x - half) {
      sum -= src[left].value;
      left += 1;
    }
    const n = Math.max(1, right - left);
    out.push({ x, value: sum / n });
  }
  return out;
}
function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}
function classStats(date, type) {
  const bins = new Map();
  const group = state.measurements.filter(m => m.date === date);
  for (const m of group) {
    const data = type === "acc" ? smoothSamples(m.acc) : m.hr;
    for (const p of data) {
      if (!inTimeRange(p) || !Number.isFinite(p.value)) continue;
      const key = Math.round(p.x);
      const bin = bins.get(key) || [];
      bin.push(p.value);
      bins.set(key, bin);
    }
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([x, values]) => {
    values.sort((a, b) => a - b);
    return { x, q1: quantile(values, 0.25), median: quantile(values, 0.5), q3: quantile(values, 0.75), n: values.length };
  });
}

function measurementMetrics(m) {
  const hr = filterRange(m.hr).map(p => p.value);
  const acc = filterRange(m.acc).map(p => p.value);
  return { date: m.date, sensor: m.sensor, avgHr: mean(hr), avgAcc: mean(acc), hrN: hr.length, accN: acc.length };
}
function allMetricPoints() {
  return state.measurements.map(measurementMetrics).filter(m => Number.isFinite(m.avgHr) && Number.isFinite(m.avgAcc));
}
function formatNumber(value, digits = 1) { return Number.isFinite(value) ? value.toFixed(digits) : "-"; }

async function autoLoadIndexedData() {
  setStatus("読み込み中", "data/index.json からCSV一覧を取得しています。");
  try {
    const res = await fetch("data/index.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`data/index.json: ${res.status}`);
    const index = await res.json();
    const files = Array.isArray(index) ? index : (Array.isArray(index.files) ? index.files : []);
    if (!files.length) throw new Error("data/index.json にCSVファイルが登録されていません");

    const map = new Map();
    let loaded = 0;
    const errors = [];
    for (const path of files) {
      try {
        const csvRes = await fetch(encodeURI(path), { cache: "no-store" });
        if (!csvRes.ok) throw new Error(`${csvRes.status} ${csvRes.statusText}`);
        const text = await csvRes.text();
        const meta = parseMeta(path);
        if (!meta.type) continue;
        const parsed = meta.type === "acc" ? parseAccCSV(text) : parseHrCSV(text);
        const date = meta.date || parsed.firstDate || "unknown-date";
        const key = `${date}|${meta.sensor}`;
        const item = map.get(key) || { date, sensor: meta.sensor, acc: [], hr: [], sourceFiles: [] };
        if (meta.type === "acc") item.acc = parsed.samples;
        else item.hr = parsed.samples;
        item.sourceFiles.push(path);
        map.set(key, item);
        loaded += 1;
      } catch (e) {
        errors.push(`${path}: ${e.message}`);
      }
    }
    const measurements = [...map.values()].filter(m => m.acc.length || m.hr.length).map(completeMeasurement).sort((a, b) => a.date.localeCompare(b.date) || naturalCompare(a.sensor, b.sensor));
    if (!measurements.length) throw new Error("読み込み可能な測定データがありません");

    state.measurements = measurements;
    state.selectedDate = dates()[0];
    state.selectedSensor = sensorsForDate(state.selectedDate)[0] || sensors()[0];
    state.compareSensor = state.selectedSensor;
    state.compareDates = new Set(datesForSensor(state.compareSensor));
    state.timeStart = null;
    state.timeEnd = null;
    ensureTimeRange();
    setStatus(`GitHubデータ ${measurements.length}件`, `${loaded}ファイルを読み込み、全測定を再計算しました。${errors.length ? ` ${errors.length}件の警告があります。` : ""}`);
    updateAll();
  } catch (e) {
    state.measurements = [];
    setStatus("データ未読込", `${e.message}。data/index.json とCSV配置を確認してください。`);
    updateAll();
  }
}

function renderSelectors() {
  $("datasetName").textContent = state.datasetName;
  $("datasetNote").textContent = state.datasetNote;
  ensureTimeRange();
  const ds = dates();
  if (!state.selectedDate || !ds.includes(state.selectedDate)) state.selectedDate = ds[0] || null;
  $("dateSelect").innerHTML = ds.map(d => `<option value="${d}" ${d === state.selectedDate ? "selected" : ""}>${d}</option>`).join("");
  const ss = sensorsForDate(state.selectedDate);
  if (!state.selectedSensor || !ss.includes(state.selectedSensor)) state.selectedSensor = ss[0] || null;
  $("sensorSelect").innerHTML = ss.map(s => `<option value="${s}" ${s === state.selectedSensor ? "selected" : ""}>${s}</option>`).join("");

  const allSensors = sensors();
  if (!state.compareSensor || !allSensors.includes(state.compareSensor)) state.compareSensor = state.selectedSensor || allSensors[0] || null;
  $("compareSensorSelect").innerHTML = allSensors.map(s => `<option value="${s}" ${s === state.compareSensor ? "selected" : ""}>${s}</option>`).join("");
  const cd = datesForSensor(state.compareSensor);
  if (![...state.compareDates].some(d => cd.includes(d))) state.compareDates = new Set(cd);
  $("compareDateChecks").innerHTML = cd.map(d => `<label class="check"><input type="checkbox" value="${d}" ${state.compareDates.has(d) ? "checked" : ""}>${d}</label>`).join("") || '<div class="empty">このセンサIDには比較可能な計測日がありません。</div>';

  const opts = timeOptions();
  const startHtml = opts.map(s => `<option value="${s}" ${s === state.timeStart ? "selected" : ""}>${timeLabel(s)}</option>`).join("");
  const endHtml = opts.map(s => `<option value="${s}" ${s === state.timeEnd ? "selected" : ""}>${timeLabel(s)}</option>`).join("");
  document.querySelectorAll(".time-start").forEach(sel => { sel.innerHTML = startHtml; });
  document.querySelectorAll(".time-end").forEach(sel => { sel.innerHTML = endHtml; });
}

function renderKpis() {
  const el = $("kpiGrid");
  const m = selectedMeasurement();
  if (!m) {
    el.innerHTML = '<div class="empty">選択条件に一致するデータがありません。</div>';
    return;
  }
  const met = measurementMetrics(m);
  const cards = [
    ["平均心拍数", formatNumber(met.avgHr, 1), "bpm", `有効点数 ${met.hrN.toLocaleString()}`],
    ["平均加速度ノルム", formatNumber(met.avgAcc, 3), "g", `有効点数 ${met.accN.toLocaleString()}`]
  ];
  el.innerHTML = cards.map(row => `<article class="kpi"><p class="klabel">${row[0]}</p><p class="kvalue">${row[1]}<span class="unit">${row[2]}</span></p><p class="sub">${row[3]}</p></article>`).join("");
}

function title(ctx, text, subtitle, x = 24, y = 28) {
  ctx.fillStyle = WHITE;
  ctx.font = fnt(900, 17);
  ctx.textAlign = "left";
  ctx.fillText(text, x, y);
  if (subtitle) {
    ctx.fillStyle = MUTED;
    ctx.font = fnt(700, 12);
    ctx.fillText(subtitle, x, y + 24);
  }
}
function noData(canvas, text, message) {
  const { ctx } = canvasContext(canvas);
  title(ctx, text, message);
}
function niceMax(value, step = 5, fallback = 1) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.ceil(value / step) * step;
}
function valuesFromSeries(series, key) {
  const vals = [];
  for (const s of series) {
    for (const line of (s[key] || [])) vals.push(...line.samples.map(p => p.value));
    for (const band of (s[`${key}Bands`] || [])) vals.push(...band.samples.flatMap(p => [p.q1, p.median, p.q3]));
  }
  return vals.filter(Number.isFinite);
}
function drawAxis(ctx, plot, side, min, max, label) {
  ctx.save();
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const xAxis = side === "left" ? plot.l : plot.r;
  ctx.moveTo(xAxis, plot.t);
  ctx.lineTo(xAxis, plot.b);
  ctx.stroke();
  ctx.font = fnt(700, 11);
  ctx.fillStyle = INK;
  ctx.textAlign = side === "left" ? "right" : "left";
  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;
    const y = plot.b - ratio * (plot.b - plot.t);
    const v = min + ratio * (max - min);
    ctx.strokeStyle = i === 0 ? AXIS : GRID;
    ctx.beginPath();
    ctx.moveTo(plot.l, y);
    ctx.lineTo(plot.r, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(max - min <= 5 ? 1 : 0), side === "left" ? plot.l - 9 : plot.r + 9, y);
  }
  ctx.save();
  const labelX = side === "left" ? 20 : plot.r + 52;
  ctx.translate(labelX, (plot.t + plot.b) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = MUTED;
  ctx.font = fnt(800, 12);
  ctx.textAlign = "center";
  ctx.fillText(label, 0, 0);
  ctx.restore();
  ctx.restore();
}
function drawTimeAxis(ctx, plot) {
  ctx.save();
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.l, plot.b);
  ctx.lineTo(plot.r, plot.b);
  ctx.stroke();
  ctx.font = fnt(800, 11);
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  for (let i = 0; i <= 6; i++) {
    const r = i / 6;
    const x = plot.l + r * (plot.r - plot.l);
    const sec = state.timeStart + r * (state.timeEnd - state.timeStart);
    ctx.fillText(timeLabel(sec), x, plot.b + 22);
  }
  ctx.restore();
}
function linePath(ctx, samples, sx, sy, color, width = 2.4, alpha = 1, dashed = false) {
  const pts = samples.filter(p => Number.isFinite(p.value) && p.x >= state.timeStart && p.x <= state.timeEnd);
  if (!pts.length) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = sx(p.x), y = sy(p.value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}
function bandPath(ctx, samples, sx, sy, color, alpha = 0.16) {
  const pts = samples.filter(p => Number.isFinite(p.q1) && Number.isFinite(p.q3) && p.x >= state.timeStart && p.x <= state.timeEnd);
  if (pts.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = sx(p.x), y = sy(p.q3);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(sx(pts[i].x), sy(pts[i].q1));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
function combinedChart(canvas, config) {
  const series = config.series || [];
  const hasData = series.some(s => (s.hr || []).some(x => x.samples.length) || (s.acc || []).some(x => x.samples.length) || (s.hrBands || []).some(x => x.samples.length) || (s.accBands || []).some(x => x.samples.length));
  if (!hasData || state.timeStart === null || state.timeEnd === null || state.timeEnd <= state.timeStart) {
    noData(canvas, config.title, "表示できるデータがありません。");
    return;
  }
  const { ctx, width, height } = canvasContext(canvas);
  title(ctx, config.title, config.subtitle);
  const marginL = 72, marginR = 82;
  const hrPlot = { l: marginL, r: width - marginR, t: 78, b: Math.round(height * 0.49) };
  const accPlot = { l: marginL, r: width - marginR, t: Math.round(height * 0.61), b: height - 56 };
  const hrVals = valuesFromSeries(series, "hr");
  const accVals = valuesFromSeries(series, "acc");
  const hrMax = niceMax(safeMax(hrVals, 0) * 1.05, 10, 180);
  const accMax = niceMax(safeMax(accVals, 0) * 1.08, 0.5, 5);
  drawAxis(ctx, hrPlot, "left", 0, hrMax, "Heart Rate bpm");
  drawAxis(ctx, accPlot, "right", 0, accMax, "Acceleration norm g");
  drawTimeAxis(ctx, accPlot);
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.16)";
  ctx.beginPath();
  ctx.moveTo(hrPlot.l, (hrPlot.b + accPlot.t) / 2);
  ctx.lineTo(hrPlot.r, (hrPlot.b + accPlot.t) / 2);
  ctx.stroke();
  ctx.restore();
  const sx = x => hrPlot.l + ((x - state.timeStart) / (state.timeEnd - state.timeStart)) * (hrPlot.r - hrPlot.l);
  const syHr = v => hrPlot.b - (v / hrMax) * (hrPlot.b - hrPlot.t);
  const syAcc = v => accPlot.b - (v / accMax) * (accPlot.b - accPlot.t);
  for (const s of series) {
    for (const b of (s.hrBands || [])) bandPath(ctx, b.samples, sx, syHr, b.color || s.color || C.blue, b.alpha ?? 0.16);
    for (const b of (s.accBands || [])) bandPath(ctx, b.samples, sx, syAcc, b.color || s.color || C.cyan, b.alpha ?? 0.16);
  }
  for (const s of series) {
    for (const line of (s.hr || [])) linePath(ctx, line.samples, sx, syHr, line.color || s.color || C.yellow, line.width || 2.4, line.alpha ?? 1, line.dashed || false);
    for (const line of (s.acc || [])) linePath(ctx, line.samples, sx, syAcc, line.color || s.color || C.cyan, line.width || 2.2, line.alpha ?? 1, line.dashed || false);
  }
  ctx.save();
  ctx.font = fnt(900, 12);
  ctx.fillStyle = C.yellow;
  ctx.textAlign = "left";
  ctx.fillText("心拍数", hrPlot.l + 8, hrPlot.t + 14);
  ctx.fillStyle = C.cyan;
  ctx.fillText("加速度ノルム", accPlot.l + 8, accPlot.t + 14);
  ctx.restore();
}

function labelBox(ctx, text, x, y, color) {
  ctx.save();
  ctx.font = fnt(900, 11);
  const pad = 7;
  const w = ctx.measureText(text).width + pad * 2;
  const h = 20;
  ctx.fillStyle = "rgba(17,24,39,.92)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.fillRect(x, y - h / 2, w, h);
  ctx.strokeRect(x, y - h / 2, w, h);
  ctx.fillStyle = WHITE;
  ctx.textAlign = "left";
  ctx.fillText(text, x + pad, y);
  ctx.restore();
}
function arrow(ctx, x1, y1, x2, y2, color) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const head = 13;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.95)";
  ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4.2;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.95)";
  ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - (head + 4) * Math.cos(a - Math.PI / 6), y2 - (head + 4) * Math.sin(a - Math.PI / 6)); ctx.lineTo(x2 - (head + 4) * Math.cos(a + Math.PI / 6), y2 - (head + 4) * Math.sin(a + Math.PI / 6)); ctx.closePath(); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - head * Math.cos(a - Math.PI / 6), y2 - head * Math.sin(a - Math.PI / 6)); ctx.lineTo(x2 - head * Math.cos(a + Math.PI / 6), y2 - head * Math.sin(a + Math.PI / 6)); ctx.closePath(); ctx.fill();
  ctx.restore();
}
function scatter(canvas, config) {
  const pts = allMetricPoints();
  if (!pts.length) { noData(canvas, config.title, "散布図用のデータがありません。"); return; }
  const { ctx, width, height } = canvasContext(canvas);
  title(ctx, config.title, config.subtitle);
  const plot = { l: 72, r: width - 48, t: 72, b: height - 56 };
  const xs = pts.map(p => p.avgAcc), ys = pts.map(p => p.avgHr);
  const xMin = Math.max(0, Math.min(...xs) - 0.05);
  const xMax = Math.max(...xs) + 0.08;
  const yMin = Math.max(0, Math.floor((Math.min(...ys) - 8) / 5) * 5);
  const yMax = Math.ceil((Math.max(...ys) + 8) / 5) * 5;
  const sx = v => plot.l + ((v - xMin) / (xMax - xMin || 1)) * (plot.r - plot.l);
  const sy = v => plot.b - ((v - yMin) / (yMax - yMin || 1)) * (plot.b - plot.t);
  ctx.strokeStyle = AXIS; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(plot.l, plot.t); ctx.lineTo(plot.l, plot.b); ctx.lineTo(plot.r, plot.b); ctx.stroke();
  ctx.font = fnt(700, 11); ctx.fillStyle = INK; ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const r = i / 5, y = plot.b - r * (plot.b - plot.t), v = yMin + r * (yMax - yMin);
    ctx.strokeStyle = i ? GRID : AXIS; ctx.beginPath(); ctx.moveTo(plot.l, y); ctx.lineTo(plot.r, y); ctx.stroke(); ctx.fillText(v.toFixed(0), plot.l - 9, y);
  }
  ctx.textAlign = "center";
  for (let i = 0; i <= 5; i++) {
    const r = i / 5, x = plot.l + r * (plot.r - plot.l), v = xMin + r * (xMax - xMin);
    ctx.fillText(v.toFixed(2), x, plot.b + 22);
  }
  ctx.fillStyle = MUTED; ctx.font = fnt(800, 12); ctx.fillText("平均加速度ノルム", (plot.l + plot.r) / 2, height - 14);
  ctx.save(); ctx.translate(18, (plot.t + plot.b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("平均心拍数 bpm", 0, 0); ctx.restore();
  ctx.save(); ctx.globalAlpha = 0.55;
  for (const p of pts) { ctx.fillStyle = dateColor(p.date); ctx.beginPath(); ctx.arc(sx(p.avgAcc), sy(p.avgHr), 4.8, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
  const legendDates = dates();
  let lx = Math.max(plot.l + 8, plot.r - 178), ly = plot.t + 12;
  ctx.font = fnt(800, 11); ctx.textAlign = "left";
  for (let i = 0; i < Math.min(legendDates.length, 8); i++) {
    const d = legendDates[i]; ctx.fillStyle = dateColor(d); ctx.beginPath(); ctx.arc(lx, ly + i * 17, 4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = INK; ctx.fillText(d, lx + 10, ly + i * 17);
  }
  const vectors = config.vectors || [];
  for (let i = 0; i < vectors.length - 1; i++) arrow(ctx, sx(vectors[i].avgAcc), sy(vectors[i].avgHr), sx(vectors[i + 1].avgAcc), sy(vectors[i + 1].avgHr), vectors[i + 1].color || dateColor(vectors[i + 1].date));
  for (const v of vectors) {
    const color = v.color || dateColor(v.date);
    ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.beginPath(); ctx.arc(sx(v.avgAcc), sy(v.avgHr), 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(sx(v.avgAcc), sy(v.avgHr), 7, 0, Math.PI * 2); ctx.fill();
    labelBox(ctx, v.date, sx(v.avgAcc) + 10, sy(v.avgHr) - 13, color);
  }
  if (config.selected) {
    const s = config.selected;
    ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.beginPath(); ctx.arc(sx(s.avgAcc), sy(s.avgHr), 11, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.yellow; ctx.beginPath(); ctx.arc(sx(s.avgAcc), sy(s.avgHr), 7.5, 0, Math.PI * 2); ctx.fill();
    labelBox(ctx, `${s.sensor} ${s.date}`, sx(s.avgAcc) + 12, sy(s.avgHr), C.yellow);
  }
}

function renderPersonalCharts() {
  const m = selectedMeasurement();
  if (!m) {
    noData($("personalCombinedChart"), "心拍・加速度ノルム時系列", "選択条件に一致するデータがありません。");
    noData($("classCombinedChart"), "クラス中央値とIQR帯", "選択条件に一致するデータがありません。");
    noData($("personalScatterChart"), "平均加速度ノルムと平均心拍数", "選択条件に一致するデータがありません。");
    return;
  }
  const accSmooth = smoothSamples(m.acc);
  combinedChart($("personalCombinedChart"), {
    title: "心拍・加速度ノルム時系列",
    subtitle: `${m.date} / Sensor ${m.sensor} / ${timeLabel(state.timeStart)}-${timeLabel(state.timeEnd)}`,
    series: [{
      hr: [{ samples: filterRange(m.hr), color: C.yellow, width: 2.8 }],
      acc: [{ samples: filterRange(accSmooth), color: C.cyan, width: 2.4 }]
    }]
  });
  combinedChart($("classCombinedChart"), {
    title: "クラス中央値とIQR帯",
    subtitle: `${m.date} / Sensor ${m.sensor} / ${timeLabel(state.timeStart)}-${timeLabel(state.timeEnd)}`,
    series: [{
      hrBands: [{ samples: classStats(m.date, "hr"), color: C.blue, alpha: 0.18 }],
      accBands: [{ samples: classStats(m.date, "acc"), color: C.cyan, alpha: 0.16 }],
      hr: [
        { samples: classStats(m.date, "hr").map(p => ({ x: p.x, value: p.median })), color: C.blue, width: 2.4 },
        { samples: filterRange(m.hr), color: C.yellow, width: 2.0, alpha: 0.95 }
      ],
      acc: [
        { samples: classStats(m.date, "acc").map(p => ({ x: p.x, value: p.median })), color: C.cyan, width: 2.4 },
        { samples: filterRange(accSmooth), color: C.yellow, width: 2.0, alpha: 0.95 }
      ]
    }]
  });
  const sm = measurementMetrics(m);
  scatter($("personalScatterChart"), {
    title: "平均加速度ノルムと平均心拍数",
    subtitle: `${timeLabel(state.timeStart)}-${timeLabel(state.timeEnd)} / 背景: 全員の測定を日別色分け`,
    selected: Number.isFinite(sm.avgAcc) && Number.isFinite(sm.avgHr) ? sm : null
  });
}

function renderCompareCharts() {
  const ms = selectedCompareMeasurements();
  combinedChart($("compareCombinedChart"), {
    title: "心拍・加速度ノルム時系列の日間比較",
    subtitle: `Sensor ${state.compareSensor || "-"} / ${timeLabel(state.timeStart)}-${timeLabel(state.timeEnd)}`,
    series: ms.map(m => {
      const color = dateColor(m.date);
      return {
        color,
        hr: [{ samples: filterRange(m.hr), color, width: 2.2 }],
        acc: [{ samples: filterRange(smoothSamples(m.acc)), color, width: 2.0 }]
      };
    })
  });
  $("compareLegend").innerHTML = ms.map(m => `<span><i class="dot" style="--c:${dateColor(m.date)}"></i>${m.date}</span>`).join("");
  const selectedDates = [...state.compareDates].sort();
  combinedChart($("compareClassCombinedChart"), {
    title: "クラス中央値とIQR帯の日間比較",
    subtitle: `${timeLabel(state.timeStart)}-${timeLabel(state.timeEnd)} / 加速度は5秒中央移動平均後に集計`,
    series: selectedDates.map(d => {
      const color = dateColor(d);
      return {
        color,
        hrBands: [{ samples: classStats(d, "hr"), color, alpha: 0.09 }],
        accBands: [{ samples: classStats(d, "acc"), color, alpha: 0.08 }],
        hr: [{ samples: classStats(d, "hr").map(p => ({ x: p.x, value: p.median })), color, width: 2.0 }],
        acc: [{ samples: classStats(d, "acc").map(p => ({ x: p.x, value: p.median })), color, width: 2.0 }]
      };
    })
  });
  const vectors = ms.map(m => ({ ...measurementMetrics(m), color: dateColor(m.date) })).filter(m => Number.isFinite(m.avgAcc) && Number.isFinite(m.avgHr));
  scatter($("compareScatterChart"), {
    title: "散布図上の個人内変化ベクトル",
    subtitle: `Sensor ${state.compareSensor || "-"} / ${timeLabel(state.timeStart)}-${timeLabel(state.timeEnd)} / 背景: 全員の測定を日別色分け`,
    vectors
  });
}

function updateAll() {
  renderSelectors();
  renderKpis();
  renderPersonalCharts();
  renderCompareCharts();
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
      document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.dataset.page === tab));
      setTimeout(updateAll, 30);
    });
  });
  $("dateSelect").addEventListener("change", e => {
    state.selectedDate = e.target.value;
    state.selectedSensor = sensorsForDate(state.selectedDate)[0] || state.selectedSensor;
    updateAll();
  });
  $("sensorSelect").addEventListener("change", e => { state.selectedSensor = e.target.value; updateAll(); });
  $("compareSensorSelect").addEventListener("change", e => {
    state.compareSensor = e.target.value;
    state.compareDates = new Set(datesForSensor(state.compareSensor));
    updateAll();
  });
  $("compareDateChecks").addEventListener("change", e => {
    if (e.target.type !== "checkbox") return;
    if (e.target.checked) state.compareDates.add(e.target.value);
    else state.compareDates.delete(e.target.value);
    updateAll();
  });
  document.addEventListener("change", e => {
    if (e.target.classList && e.target.classList.contains("time-start")) {
      state.timeStart = Number(e.target.value);
      if (state.timeStart >= state.timeEnd) state.timeEnd = state.timeStart + 300;
      updateAll();
    }
    if (e.target.classList && e.target.classList.contains("time-end")) {
      state.timeEnd = Number(e.target.value);
      if (state.timeEnd <= state.timeStart) state.timeStart = state.timeEnd - 300;
      updateAll();
    }
  });
  window.addEventListener("resize", () => {
    clearTimeout(window.__resizeTimer);
    window.__resizeTimer = setTimeout(updateAll, 120);
  });
}

bindEvents();
updateAll();
autoLoadIndexedData();
