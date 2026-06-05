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
const DEFAULT_START_SEC = 10 * 3600 + 40 * 60;
const DEFAULT_END_SEC = 11 * 3600 + 50 * 60;

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


function isMergedCSV(headers) {
  const hasTimestamp = findColumn(headers, ["Timestamp", "Time", "DateTime", "日時"]) >= 0;
  const hasDate = findColumn(headers, ["Date", "計測日", "日付"]) >= 0;
  const hasSensor = findColumn(headers, ["SensorID", "Sensor ID", "Sensor", "センサID", "ID"]) >= 0;
  const hasHr = findColumn(headers, ["HeartRate", "Heart Rate", "HR", "心拍数", "心拍"]) >= 0;
  const hasAcc = findColumn(headers, ["AccNorm", "Acceleration Norm", "ACC Norm", "加速度ノルム"]) >= 0;
  return hasTimestamp && hasSensor && hasHr && hasAcc && hasDate;
}

function parseMergedCSV(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return [];
  const headers = splitCSV(lines[0]);
  if (!isMergedCSV(headers)) return [];
  const dateIdx = findColumn(headers, ["Date", "計測日", "日付"]);
  const tsIdx = findColumn(headers, ["Timestamp", "Time", "DateTime", "日時"]);
  const sensorIdx = findColumn(headers, ["SensorID", "Sensor ID", "Sensor", "センサID", "ID"]);
  const hrIdx = findColumn(headers, ["HeartRate", "Heart Rate", "HR", "心拍数", "心拍"]);
  const accIdx = findColumn(headers, ["AccNorm", "Acceleration Norm", "ACC Norm", "加速度ノルム"]);
  const map = new Map();

  for (let i = 1; i < lines.length; i++) {
    const row = splitCSV(lines[i]);
    const d = parseDateTime(row[tsIdx]);
    const dateText = String(row[dateIdx] || "").trim();
    const date = dateText || (d ? dateKey(d) : null);
    const sensor = String(row[sensorIdx] || "").trim() || "001";
    if (!date || !d) continue;
    const key = `${date}|${sensor}`;
    const item = map.get(key) || { date, sensor, acc: [], hr: [], sourceFiles: [] };
    const x = secOfDay(d);
    const hr = Number(row[hrIdx]);
    const acc = Number(row[accIdx]);
    if (Number.isFinite(hr) && hr > 0) item.hr.push({ x, value: hr });
    if (Number.isFinite(acc)) item.acc.push({ x, value: acc });
    map.set(key, item);
  }

  return [...map.values()].map(item => ({
    ...item,
    hr: item.hr.sort((a, b) => a.x - b.x),
    acc: item.acc.sort((a, b) => a.x - b.x)
  }));
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
  const defaultStart = Math.max(start, Math.min(DEFAULT_START_SEC, Math.max(start, end - 300)));
  const defaultEnd = Math.min(end, Math.max(DEFAULT_END_SEC, defaultStart + 300));
  if (state.timeStart === null || state.timeStart < start || state.timeStart >= end) state.timeStart = defaultStart;
  if (state.timeEnd === null || state.timeEnd > end || state.timeEnd <= state.timeStart) state.timeEnd = Math.max(state.timeStart + 300, defaultEnd);
  if (state.timeEnd > end) state.timeEnd = end;
  if (state.timeEnd <= state.timeStart) state.timeStart = Math.max(start, state.timeEnd - 300);
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

function finiteMetricValues(m, type) {
  const samples = type === "hr" ? m.hr : m.acc;
  return filterRange(samples).map(p => p.value).filter(Number.isFinite);
}
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function minMax(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Infinity ? { min: NaN, max: NaN } : { min, max };
}
function allMetricValuesForDate(date, type) {
  const values = [];
  for (const m of state.measurements) {
    if (m.date !== date) continue;
    const samples = type === "hr" ? m.hr : m.acc;
    for (const p of filterRange(samples)) {
      if (Number.isFinite(p.value)) values.push(p.value);
    }
  }
  return values;
}

const HR_ZONE_DEFS = [
  { key: "z1", level: "1", name: "50-60%", min: 0.50, max: 0.60, bpmMin: 100, bpmMax: 120, color: "#cfd8dc", bandColor: "rgba(207,216,220,.30)" },
  { key: "z2", level: "2", name: "60-70%", min: 0.60, max: 0.70, bpmMin: 120, bpmMax: 140, color: "#4fc3f7", bandColor: "rgba(79,195,247,.28)" },
  { key: "z3", level: "3", name: "70-80%", min: 0.70, max: 0.80, bpmMin: 140, bpmMax: 160, color: "#9ccc65", bandColor: "rgba(156,204,101,.28)" },
  { key: "z4", level: "4", name: "80-90%", min: 0.80, max: 0.90, bpmMin: 160, bpmMax: 180, color: "#facc15", bandColor: "rgba(250,204,21,.28)" },
  { key: "z5", level: "5", name: "90-100%", min: 0.90, max: Infinity, bpmMin: 180, bpmMax: 200, color: "#ec4899", bandColor: "rgba(236,72,153,.28)" }
];
const ACC_INTENSITY_BANDS = [
  { key: "b1", label: "1.00-1.05g", min: 1.00, max: 1.05, color: "rgba(96,165,250,.90)" },
  { key: "b2", label: "1.05-1.10g", min: 1.05, max: 1.10, color: "rgba(34,211,238,.92)" },
  { key: "b3", label: "1.10-1.20g", min: 1.10, max: 1.20, color: "rgba(45,212,191,.92)" },
  { key: "b4", label: "1.20-1.40g", min: 1.20, max: 1.40, color: "rgba(167,139,250,.92)" },
  { key: "b5", label: "1.40-1.60g", min: 1.40, max: 1.60, color: "rgba(250,204,21,.95)" },
  { key: "b6", label: "1.60-2.00g", min: 1.60, max: 2.00, color: "rgba(251,146,60,.95)" },
  { key: "b7", label: "≥2.00g", min: 2.00, max: Infinity, color: "rgba(248,113,113,.96)" }
];

function formatDuration(totalSeconds) {
  const sec = Math.max(0, Math.round(totalSeconds || 0));
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
function heartZoneSummary(hrValues, hrMaxRef) {
  const zones = HR_ZONE_DEFS.map(z => ({ ...z, count: 0, pct: 0, seconds: 0 }));
  const valid = hrValues.filter(v => Number.isFinite(v) && v > 0);
  if (!valid.length || !Number.isFinite(hrMaxRef) || hrMaxRef <= 0) return zones;
  for (const value of valid) {
    const ratio = value / hrMaxRef;
    const z = zones.find(zone => ratio >= zone.min && ratio < zone.max);
    if (z) z.count += 1;
  }
  const totalInZones = zones.reduce((sum, z) => sum + z.count, 0);
  for (const z of zones) {
    z.seconds = z.count;
    z.pct = totalInZones ? (z.count / totalInZones) * 100 : 0;
  }
  return zones;
}
function renderHeartZoneBar(hrValues, hrMaxRef) {
  const zones = heartZoneSummary(hrValues, hrMaxRef).slice().reverse();
  const totalInZones = zones.reduce((sum, z) => sum + z.count, 0);
  if (!totalInZones) return '<div class="zone-empty">表示範囲内に Polar 心拍ゾーンへ入る心拍データがありません。</div>';
  const rows = zones.map(z => `
    <div class="zone-row">
      <div class="zone-level" style="--c:${z.color}">${z.level}</div>
      <div class="zone-track"><div class="zone-fill" style="--c:${z.color};width:${Math.max(0, z.pct)}%"></div></div>
      <div class="zone-time">${formatDuration(z.seconds)}</div>
    </div>`).join("");
  const caption = HR_ZONE_DEFS.slice().reverse().map(z => `<span class="zone-caption-item"><i style="--c:${z.color}"></i>${z.level}: ${z.name}</span>`).join("");
  return `
    <div class="zone-block">
      <div class="zone-head"><span>心拍ゾーン滞在時間</span><span>Polar 5 zones / HRmax 200 bpm固定</span></div>
      <div class="zone-rows" aria-label="心拍ゾーン滞在時間">${rows}</div>
      <div class="zone-caption">${caption}</div>
    </div>`;
}

function accBandSummary(accValues) {
  const counts = ACC_INTENSITY_BANDS.map(b => ({ ...b, count: 0, pct: 0 }));
  const valid = accValues.filter(v => Number.isFinite(v) && v > 0).map(v => Math.max(1, v));
  if (!valid.length) return counts;
  for (const value of valid) {
    const band = counts.find(item => value >= item.min && value < item.max) || counts[counts.length - 1];
    band.count += 1;
  }
  for (const band of counts) band.pct = valid.length ? (band.count / valid.length) * 100 : 0;
  return counts;
}
function stackedBandHighPct(bands, thresholdKeySet) {
  return bands.filter(b => thresholdKeySet.has(b.key)).reduce((sum, b) => sum + b.pct, 0);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return;
  }
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function drawStackedBandCompare(canvas, config) {
  const rows = config.rows || [];
  if (!rows.length) {
    noData(canvas, config.title, config.emptyMessage || "表示できるデータがありません。");
    return;
  }
  const { ctx, width, height } = canvasContext(canvas);
  // Hidden tabs can report a 0-1 px canvas width. Skip drawing now; the chart is redrawn when the tab becomes visible.
  if (width < 320 || height < 160) return;
  title(ctx, config.title, "");
  const defs = config.defs || [];

  const legendY = 56;
  let lx = 24;
  ctx.save();
  ctx.font = fnt(800, 11);
  ctx.textAlign = "left";
  for (const d of defs) {
    const label = d.label || (d.level ? `Z${d.level}` : d.key);
    const tw = ctx.measureText(label).width;
    const itemW = tw + 24;
    if (lx + itemW > width - 24) break;
    ctx.fillStyle = d.color;
    ctx.fillRect(lx, legendY - 5, 12, 12);
    ctx.fillStyle = INK;
    ctx.fillText(label, lx + 18, legendY + 1);
    lx += itemW + 10;
  }
  ctx.restore();

  const leftW = 112;
  const rightW = 112;
  const plot = { l: 24 + leftW, r: width - 24 - rightW, t: 88, b: height - 42 };
  const rowGap = 18;
  const rowH = Math.min(38, Math.max(28, (plot.b - plot.t - rowGap * (rows.length - 1)) / Math.max(1, rows.length)));
  const totalH = rows.length * rowH + (rows.length - 1) * rowGap;
  const y0 = plot.t + Math.max(0, (plot.b - plot.t - totalH) / 2);
  const sx = pct => plot.l + (pct / 100) * (plot.r - plot.l);

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
  for (let i = 0; i <= 4; i++) {
    const pct = i * 25;
    const x = sx(pct);
    ctx.strokeStyle = i === 0 ? AXIS : GRID;
    ctx.beginPath();
    ctx.moveTo(x, plot.t - 8);
    ctx.lineTo(x, plot.b);
    ctx.stroke();
    ctx.fillText(`${pct}%`, x, plot.b + 18);
  }
  ctx.restore();

  rows.forEach((row, idx) => {
    const y = y0 + idx * (rowH + rowGap);
    const cy = y + rowH / 2;
    ctx.save();
    ctx.textAlign = "right";
    ctx.fillStyle = WHITE;
    ctx.font = fnt(900, 12);
    ctx.fillText(row.label, plot.l - 12, cy);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,.04)";
    roundRect(ctx, plot.l, y, plot.r - plot.l, rowH, 8);
    ctx.fill();
    ctx.restore();

    let startPct = 0;
    for (const seg of row.segments) {
      const w = ((plot.r - plot.l) * seg.pct) / 100;
      if (w <= 0.4) { startPct += seg.pct; continue; }
      ctx.save();
      ctx.fillStyle = seg.color;
      ctx.fillRect(sx(startPct), y, w, rowH);
      if (seg.pct >= 9) {
        ctx.fillStyle = "#0f172a";
        ctx.font = fnt(900, 11);
        ctx.textAlign = "center";
        ctx.fillText(`${seg.pct.toFixed(0)}%`, sx(startPct) + w / 2, cy);
      }
      ctx.restore();
      startPct += seg.pct;
    }
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,.14)";
    roundRect(ctx, plot.l, y, plot.r - plot.l, rowH, 8);
    ctx.stroke();
    ctx.restore();

    if (row.summary) {
      ctx.save();
      ctx.textAlign = "left";
      ctx.fillStyle = WHITE;
      ctx.font = fnt(900, 11);
      ctx.fillText(row.summary, plot.r + 12, cy - 7);
      if (row.detail) {
        ctx.fillStyle = MUTED;
        ctx.font = fnt(700, 10);
        ctx.fillText(row.detail, plot.r + 12, cy + 8);
      }
      ctx.restore();
    }
  });
}


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
    let mergedLoaded = 0;
    let rawLoaded = 0;
    const errors = [];

    function putMeasurement(item, sourcePath) {
      const key = `${item.date}|${item.sensor}`;
      const existing = map.get(key) || { date: item.date, sensor: item.sensor, acc: [], hr: [], sourceFiles: [] };
      if (item.acc && item.acc.length) existing.acc = item.acc;
      if (item.hr && item.hr.length) existing.hr = item.hr;
      existing.sourceFiles.push(sourcePath);
      map.set(key, existing);
    }

    for (const path of files) {
      if (!/\.csv$/i.test(path)) continue;
      if (/preprocess_report\.csv$/i.test(path)) continue;
      try {
        const csvRes = await fetch(encodeURI(path), { cache: "no-store" });
        if (!csvRes.ok) throw new Error(`${csvRes.status} ${csvRes.statusText}`);
        const text = await csvRes.text();

        const mergedItems = parseMergedCSV(text);
        if (mergedItems.length) {
          for (const item of mergedItems) putMeasurement(item, path);
          loaded += 1;
          mergedLoaded += 1;
          continue;
        }

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
        rawLoaded += 1;
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
    const modeText = mergedLoaded ? `統合CSV ${mergedLoaded}ファイル` : `元CSV ${rawLoaded}ファイル`;
    setStatus(`GitHubデータ ${measurements.length}件`, `${modeText}を読み込みました。表示範囲を変えると指標を再計算します。${errors.length ? ` ${errors.length}件の警告があります。` : ""}`);
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
  const hrValues = finiteMetricValues(m, "hr");
  const accValues = finiteMetricValues(m, "acc");
  const avgHr = mean(hrValues);
  const maxHr = safeMax(hrValues, NaN);
  const avgAcc = mean(accValues);
  el.innerHTML = `
    <article class="kpi heart-kpi">
      <p class="klabel">心拍数</p>
      <div class="metric-pair">
        <div class="metric-box">
          <p class="metric-label">平均心拍数</p>
          <p class="metric-value">${formatNumber(avgHr, 1)}<span class="unit">bpm</span></p>
        </div>
        <div class="metric-box">
          <p class="metric-label">最大心拍数</p>
          <p class="metric-value">${formatNumber(maxHr, 0)}<span class="unit">bpm</span></p>
        </div>
      </div>
      ${renderHeartZoneBar(hrValues, 200)}
    </article>
    <article class="kpi acc-kpi">
      <p class="klabel">加速度ノルム</p>
      <p class="metric-label">平均加速度ノルム</p>
      <p class="metric-value">${formatNumber(avgAcc, 3)}<span class="unit">g</span></p>
      <p class="sub">選択IDの表示範囲内平均値です。</p>
    </article>`;
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

function areaPath(ctx, samples, sx, sy, baselineY, color, alpha = 0.18) {
  const pts = samples.filter(p => Number.isFinite(p.value) && p.x >= state.timeStart && p.x <= state.timeEnd);
  if (pts.length < 2) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = sx(p.x);
    const y = sy(p.value);
    if (i === 0) ctx.moveTo(x, baselineY);
    ctx.lineTo(x, y);
  });
  ctx.lineTo(sx(pts[pts.length - 1].x), baselineY);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
function drawHeartZoneBands(ctx, plot, hrMax) {
  ctx.save();
  for (const zone of HR_ZONE_DEFS) {
    const yTop = plot.b - (Math.min(hrMax, zone.bpmMax) / hrMax) * (plot.b - plot.t);
    const yBottom = plot.b - (Math.max(0, zone.bpmMin) / hrMax) * (plot.b - plot.t);
    if (yBottom <= plot.t || yTop >= plot.b) continue;
    const bandTop = Math.max(plot.t, yTop);
    const bandBottom = Math.min(plot.b, yBottom);
    if (bandBottom <= bandTop) continue;
    ctx.fillStyle = zone.bandColor;
    ctx.fillRect(plot.l, bandTop, plot.r - plot.l, bandBottom - bandTop);
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.font = fnt(800, 10);
    ctx.textAlign = "right";
    ctx.fillText(zone.level, plot.r - 6, (bandTop + bandBottom) / 2 + 3);
  }
  ctx.restore();
}

function drawAccAxis(ctx, plot, min, max, label) {
  ctx.save();
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.r, plot.t);
  ctx.lineTo(plot.r, plot.b);
  ctx.stroke();
  ctx.font = fnt(700, 11);
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  for (let i = 0; i <= 3; i++) {
    const ratio = i / 3;
    const y = plot.b - ratio * (plot.b - plot.t);
    const v = min + ratio * (max - min);
    ctx.strokeStyle = i === 0 ? AXIS : "rgba(255,255,255,.08)";
    ctx.beginPath();
    ctx.moveTo(plot.r, y);
    ctx.lineTo(plot.r + 6, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(max - min <= 5 ? 1 : 0), plot.r + 9, y);
  }
  ctx.save();
  ctx.translate(plot.r + 52, (plot.t + plot.b) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = MUTED;
  ctx.font = fnt(800, 12);
  ctx.textAlign = "center";
  ctx.fillText(label, 0, 0);
  ctx.restore();
  ctx.restore();
}

function combinedChart(canvas, config) {
  const series = config.series || [];
  const hasHr = series.some(s => (s.hr || []).some(x => x.samples.length) || (s.hrBands || []).some(x => x.samples.length));
  const hasAcc = series.some(s => (s.acc || []).some(x => x.samples.length) || (s.accBands || []).some(x => x.samples.length));
  if ((!hasHr && !hasAcc) || state.timeStart === null || state.timeEnd === null || state.timeEnd <= state.timeStart) {
    noData(canvas, config.title, "表示できるデータがありません。");
    return;
  }
  const { ctx, width, height } = canvasContext(canvas);
  title(ctx, config.title, config.subtitle);
  const outer = { l: 72, r: width - 82, t: 78, b: height - 56 };
  const gap = hasHr && hasAcc ? 32 : 0;
  const innerH = outer.b - outer.t;
  let hrPlot = null;
  let accPlot = null;
  if (hasHr && hasAcc) {
    const eachH = (innerH - gap) / 2;
    hrPlot = { l: outer.l, r: outer.r, t: outer.t, b: outer.t + eachH };
    accPlot = { l: outer.l, r: outer.r, t: hrPlot.b + gap, b: outer.b };
  } else if (hasHr) {
    hrPlot = { ...outer };
  } else if (hasAcc) {
    accPlot = { ...outer };
  }

  const hrVals = valuesFromSeries(series, "hr");
  const accVals = valuesFromSeries(series, "acc");
  const hrMax = 200;
  const accMin = 1;
  const accMaxRaw = hasAcc ? Math.max(accMin + 0.2, safeMax(accVals, accMin) * 1.08) : accMin + 1;
  const accMax = niceMax(accMaxRaw, 0.25, accMin + 1);
  const sx = x => outer.l + ((x - state.timeStart) / (state.timeEnd - state.timeStart)) * (outer.r - outer.l);
  const syHr = v => hrPlot.b - (v / hrMax) * (hrPlot.b - hrPlot.t);
  const syAcc = v => {
    const clamped = Math.max(accMin, Math.min(accMax, v));
    return accPlot.b - ((clamped - accMin) / (accMax - accMin || 1)) * (accPlot.b - accPlot.t);
  };

  if (hasHr) {
    drawAxis(ctx, hrPlot, "left", 0, hrMax, "Heart Rate bpm");
    drawHeartZoneBands(ctx, hrPlot, hrMax);
  }
  if (hasAcc) {
    drawAxis(ctx, accPlot, "left", accMin, accMax, "Acceleration norm g");
  }
  drawTimeAxis(ctx, hasAcc ? accPlot : hrPlot);

  for (const s of series) {
    if (hasHr) {
      for (const b of (s.hrBands || [])) bandPath(ctx, b.samples, sx, syHr, b.color || s.color || C.blue, b.alpha ?? 0.16);
    }
    if (hasAcc) {
      for (const b of (s.accBands || [])) bandPath(ctx, b.samples, sx, syAcc, b.color || s.color || C.cyan, b.alpha ?? 0.10);
      for (const line of (s.acc || [])) areaPath(ctx, line.samples, sx, syAcc, syAcc(accMin), line.color || s.color || C.cyan, line.fillAlpha ?? 0.16);
    }
  }
  for (const s of series) {
    if (hasHr) {
      for (const line of (s.hr || [])) linePath(ctx, line.samples, sx, syHr, line.color || s.color || C.yellow, line.width || 2.4, line.alpha ?? 1, line.dashed || false);
    }
    if (hasAcc) {
      for (const line of (s.acc || [])) linePath(ctx, line.samples, sx, syAcc, line.color || s.color || C.cyan, line.width || 2.2, line.alpha ?? 1, line.dashed || false);
    }
  }
  ctx.save();
  ctx.font = fnt(900, 12);
  ctx.fillStyle = WHITE;
  ctx.textAlign = "left";
  if (hasHr && hrPlot) ctx.fillText("心拍数", hrPlot.l + 8, hrPlot.t + 14);
  if (hasAcc && accPlot) ctx.fillText("加速度ノルム", accPlot.l + 8, accPlot.t + 14);
  ctx.restore();
}

function gaussianKernel(u) { return Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI); }
function standardDeviation(values) {
  const xs = values.filter(Number.isFinite);
  if (!xs.length) return NaN;
  const m = mean(xs);
  const v = mean(xs.map(x => (x - m) ** 2));
  return Math.sqrt(v);
}
function bandwidthSilverman(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = xs.length;
  if (n < 2) return 0.12;
  const sd = standardDeviation(xs);
  const iqr = quantile(xs, 0.75) - quantile(xs, 0.25);
  const scale = Math.min(sd || Infinity, (iqr / 1.34) || Infinity);
  const fallback = Math.max(0.08, ((xs[xs.length - 1] - xs[0]) || 0.5) / 20);
  const h = 0.9 * (Number.isFinite(scale) && scale > 0 ? scale : fallback) * Math.pow(n, -1 / 5);
  return Number.isFinite(h) && h > 0 ? h : fallback;
}
function kdeCurve(values, gridMin, gridMax, points = 160) {
  const xs = values.filter(Number.isFinite);
  if (xs.length < 2) return [];
  const h = bandwidthSilverman(xs);
  const step = (gridMax - gridMin) / Math.max(2, points - 1);
  const curve = [];
  for (let i = 0; i < points; i++) {
    const x = gridMin + step * i;
    let sum = 0;
    for (const v of xs) sum += gaussianKernel((x - v) / h);
    curve.push({ x, value: sum / (xs.length * h) });
  }
  return curve;
}
function densityChart(canvas, config) {
  const items = (config.series || []).map(s => ({ ...s, values: (s.values || []).filter(Number.isFinite) })).filter(s => s.values.length >= 2);
  if (!items.length) { noData(canvas, config.title, "表示できるデータがありません。"); return; }
  const { ctx, width, height } = canvasContext(canvas);
  title(ctx, config.title, config.subtitle);
  const plot = { l: 72, r: width - 42, t: 78, b: height - 56 };
  const all = items.flatMap(s => s.values);
  const xMin = Math.max(1, (config.xMin ?? (Math.min(...all) - 0.08)));
  const xMax = config.xMax ?? niceMax(Math.max(...all) * 1.05, 0.25, 2);
  const curves = items.map(s => ({ ...s, curve: kdeCurve(s.values, xMin, xMax) })).filter(s => s.curve.length > 1);
  if (!curves.length) { noData(canvas, config.title, "表示できるデータがありません。"); return; }
  const yMax = Math.max(0.1, ...curves.flatMap(s => s.curve.map(p => p.value))) * 1.12;
  const sx = v => plot.l + ((v - xMin) / (xMax - xMin || 1)) * (plot.r - plot.l);
  const sy = v => plot.b - ((v - 0) / (yMax || 1)) * (plot.b - plot.t);
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.l, plot.t);
  ctx.lineTo(plot.l, plot.b);
  ctx.lineTo(plot.r, plot.b);
  ctx.stroke();
  ctx.font = fnt(700, 11);
  ctx.fillStyle = INK;
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const r = i / 4;
    const y = plot.b - r * (plot.b - plot.t);
    const v = r * yMax;
    ctx.strokeStyle = i === 0 ? AXIS : GRID;
    ctx.beginPath();
    ctx.moveTo(plot.l, y);
    ctx.lineTo(plot.r, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(2), plot.l - 9, y);
  }
  ctx.textAlign = "center";
  for (let i = 0; i <= 6; i++) {
    const r = i / 6;
    const x = plot.l + r * (plot.r - plot.l);
    const v = xMin + r * (xMax - xMin);
    ctx.fillText(v.toFixed(2), x, plot.b + 22);
  }
  ctx.fillStyle = MUTED;
  ctx.font = fnt(800, 12);
  ctx.fillText("加速度ノルム (g)", (plot.l + plot.r) / 2, height - 14);
  ctx.save();
  ctx.translate(20, (plot.t + plot.b) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("確率密度", 0, 0);
  ctx.restore();
  for (const s of curves) {
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    s.curve.forEach((p, i) => {
      const x = sx(p.x), y = sy(p.value);
      if (i === 0) ctx.moveTo(x, plot.b);
      ctx.lineTo(x, y);
    });
    ctx.lineTo(sx(s.curve[s.curve.length - 1].x), plot.b);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    s.curve.forEach((p, i) => {
      const x = sx(p.x), y = sy(p.value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }
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
  ctx.save(); ctx.globalAlpha = 0.22;
  for (const p of pts) { ctx.fillStyle = dateColor(p.date); ctx.beginPath(); ctx.arc(sx(p.avgAcc), sy(p.avgHr), 3.8, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
  const legendDates = dates();
  let lx = Math.max(plot.l + 8, plot.r - 178), ly = plot.t + 12;
  ctx.font = fnt(800, 11); ctx.textAlign = "left";
  for (let i = 0; i < Math.min(legendDates.length, 8); i++) {
    const d = legendDates[i]; ctx.fillStyle = dateColor(d); ctx.beginPath(); ctx.arc(lx, ly + i * 17, 4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = INK; ctx.fillText(d, lx + 10, ly + i * 17);
  }
  const vectors = config.vectors || [];
  vectors.forEach((v, i) => {
    const color = v.color || dateColor(v.date);
    const x = sx(v.avgAcc);
    const y = sy(v.avgHr);
    ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 7.5, 0, Math.PI * 2); ctx.fill();
    const dx = (i % 2 === 0) ? 12 : -82;
    const dy = -18 + (i % 3) * 16;
    labelBox(ctx, v.date, x + dx, y + dy, color);
  });
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
    noData($("classCombinedChart"), "心拍数のクラス中央値とばらつき", "選択条件に一致するデータがありません。");
    noData($("personalScatterChart"), "平均加速度と平均心拍数", "選択条件に一致するデータがありません。");
    return;
  }
  const accSmooth = smoothSamples(m.acc);
  combinedChart($("personalCombinedChart"), {
    title: "心拍・加速度ノルム時系列",
    subtitle: "",
    series: [{
      hr: [{ samples: filterRange(m.hr), color: C.yellow, width: 2.8 }],
      acc: [{ samples: filterRange(accSmooth), color: C.cyan, width: 2.4, fillAlpha: 0.20 }]
    }]
  });
  const hrStats = classStats(m.date, "hr");
  combinedChart($("classCombinedChart"), {
    title: "心拍数のクラス中央値とばらつき",
    subtitle: "",
    series: [{
      hrBands: [{ samples: hrStats, color: C.blue, alpha: 0.18 }],
      hr: [
        { samples: hrStats.map(p => ({ x: p.x, value: p.median })), color: C.blue, width: 2.4 },
        { samples: filterRange(m.hr), color: C.yellow, width: 2.0, alpha: 0.95 }
      ]
    }]
  });
  const sm = measurementMetrics(m);
  scatter($("personalScatterChart"), {
    title: "平均加速度と平均心拍数",
    subtitle: "",
    selected: Number.isFinite(sm.avgAcc) && Number.isFinite(sm.avgHr) ? sm : null
  });
}


function renderCompareCharts() {
  const ms = selectedCompareMeasurements();
  const legendHtml = ms.map(m => `<span><i class="dot" style="--c:${dateColor(m.date)}"></i>${m.date}</span>`).join("");
  combinedChart($("compareCombinedChart"), {
    title: "心拍・加速度ノルム時系列の日間比較",
    subtitle: "",
    series: ms.map(m => {
      const color = dateColor(m.date);
      return {
        color,
        hr: [{ samples: filterRange(m.hr), color, width: 2.2 }],
        acc: [{ samples: filterRange(smoothSamples(m.acc)), color, width: 2.0, fillAlpha: 0.10 }]
      };
    })
  });
  $("compareLegend").innerHTML = legendHtml || '<span class="empty">比較する計測日を選択してください。</span>';

  drawStackedBandCompare($("compareAccBandChart"), {
    title: "加速度ノルム強度帯別割合の日間比較",
    subtitle: "",
    defs: ACC_INTENSITY_BANDS,
    rows: ms.map(m => {
      const values = finiteMetricValues(m, "acc");
      const bands = accBandSummary(values);
      const highPct = stackedBandHighPct(bands, new Set(["b4", "b5", "b6", "b7"]));
      return {
        label: m.date,
        segments: bands,
        summary: `≥1.20g ${highPct.toFixed(1)}%`,
        detail: `n=${values.length.toLocaleString()}`
      };
    }),
    emptyMessage: "比較用の加速度データがありません。"
  });

  drawStackedBandCompare($("compareHrZoneChart"), {
    title: "心拍ゾーン別割合の日間比較",
    subtitle: "",
    defs: HR_ZONE_DEFS,
    rows: ms.map(m => {
      const values = finiteMetricValues(m, "hr");
      const bands = heartZoneSummary(values, 200);
      const highPct = stackedBandHighPct(bands, new Set(["z4", "z5"]));
      return {
        label: m.date,
        segments: bands,
        summary: `Z4+Z5 ${highPct.toFixed(1)}%`,
        detail: `n=${values.length.toLocaleString()}`
      };
    }),
    emptyMessage: "比較用の心拍データがありません。"
  });

  const selectedDates = [...state.compareDates].sort();
  combinedChart($("compareClassCombinedChart"), {
    title: "心拍数のクラス中央値とばらつきの日間比較",
    subtitle: "",
    series: selectedDates.map(d => {
      const color = dateColor(d);
      const hrStats = classStats(d, "hr");
      return {
        color,
        hrBands: [{ samples: hrStats, color, alpha: 0.09 }],
        hr: [{ samples: hrStats.map(p => ({ x: p.x, value: p.median })), color, width: 2.0 }]
      };
    })
  });
  $("compareClassLegend").innerHTML = legendHtml || '<span class="empty">比較する計測日を選択してください。</span>';

  const vectors = ms.map(m => ({ ...measurementMetrics(m), color: dateColor(m.date) })).filter(m => Number.isFinite(m.avgAcc) && Number.isFinite(m.avgHr));
  scatter($("compareScatterChart"), {
    title: "平均加速度と平均心拍数の関係の日間変化",
    subtitle: "",
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
