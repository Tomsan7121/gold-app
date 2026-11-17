// テクニカル指標（純粋関数・DOM に触らない）
// 入力: candles = [{time(秒UNIX), open, high, low, close, volume}]（時刻の昇順）
// 出力: 入力と同じ長さの配列。計算できない先頭部分は null。途中で丸めない。

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const validPeriod = (n) => Number.isInteger(n) && n >= 1;
const nulls = (n) => new Array(n).fill(null);

export function pickSource(c, source = 'close') {
  switch (source) {
    case 'hl2': return (c.high + c.low) / 2;
    case 'hlc3': return (c.high + c.low + c.close) / 3;
    case 'ohlc4': return (c.open + c.high + c.low + c.close) / 4;
    default: return c[source];
  }
}

function firstValid(vals) {
  for (let i = 0; i < vals.length; i++) if (vals[i] !== null && vals[i] !== undefined) return i;
  return -1;
}

// ---- ヘルパー（値の配列。null を含んでよい。先頭の null を飛ばして数える） ----
export function smaValues(values, n) {
  const out = nulls(values.length);
  if (!validPeriod(n)) return out;
  const start = firstValid(values);
  if (start < 0) return out;
  for (let i = start + n - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += values[j];
    out[i] = s / n;
  }
  return out;
}

export function emaValues(values, n) {
  const out = nulls(values.length);
  if (!validPeriod(n)) return out;
  const start = firstValid(values);
  if (start < 0 || values.length - start < n) return out;
  const k = 2 / (n + 1);
  const seed = start + n - 1;
  let s = 0;
  for (let j = start; j <= seed; j++) s += values[j];
  out[seed] = s / n;
  for (let i = seed + 1; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

export function rmaValues(values, n) {
  const out = nulls(values.length);
  if (!validPeriod(n)) return out;
  const start = firstValid(values);
  if (start < 0 || values.length - start < n) return out;
  const seed = start + n - 1;
  let s = 0;
  for (let j = start; j <= seed; j++) s += values[j];
  out[seed] = s / n;
  for (let i = seed + 1; i < values.length; i++) out[i] = (out[i - 1] * (n - 1) + values[i]) / n;
  return out;
}

function stdevPop(w) {
  const m = w.reduce((a, b) => a + b, 0) / w.length;
  return Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / w.length);
}
function stdevSample(w) {
  const m = w.reduce((a, b) => a + b, 0) / w.length;
  return Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / (w.length - 1));
}
function highest(c, from, to) { let m = -Infinity; for (let j = from; j <= to; j++) if (c[j].high > m) m = c[j].high; return m; }
function lowest(c, from, to) { let m = Infinity; for (let j = from; j <= to; j++) if (c[j].low < m) m = c[j].low; return m; }

// ---- 4-1 / 4-2 ----
export function sma(candles, period = 20, source = 'close') {
  if (!validPeriod(period)) return nulls(candles.length);
  return smaValues(candles.map((c) => pickSource(c, source)), period);
}
export function ema(candles, period = 20, source = 'close') {
  if (!validPeriod(period)) return nulls(candles.length);
  return emaValues(candles.map((c) => pickSource(c, source)), period);
}

// ---- 4-3 RSI（ワイルダー） ----
export function rsi(candles, period = 14) {
  const n = candles.length;
  const out = nulls(n);
  if (!validPeriod(period) || n <= period) return out;
  const val = (ag, al) => (al === 0 && ag === 0 ? 50 : al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const ch = candles[i].close - candles[i - 1].close;
    ag += Math.max(ch, 0); al += Math.max(-ch, 0);
  }
  ag /= period; al /= period;
  out[period] = val(ag, al);
  for (let i = period + 1; i < n; i++) {
    const ch = candles[i].close - candles[i - 1].close;
    ag = (ag * (period - 1) + Math.max(ch, 0)) / period;
    al = (al * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = val(ag, al);
  }
  return out;
}

// ---- 4-4 MACD ----
export function macd(candles, fast = 12, slow = 26, signal = 9) {
  const n = candles.length;
  if (!validPeriod(fast) || !validPeriod(slow) || !validPeriod(signal)) return { macd: nulls(n), signal: nulls(n), hist: nulls(n) };
  const cl = candles.map((c) => c.close);
  const ef = emaValues(cl, fast), es = emaValues(cl, slow);
  const line = ef.map((a, i) => (a === null || es[i] === null ? null : a - es[i]));
  const sig = emaValues(line, signal);
  const hist = line.map((a, i) => (a === null || sig[i] === null ? null : a - sig[i]));
  return { macd: line, signal: sig, hist };
}

// ---- 4-5 ボリンジャー ----
export function bollinger(candles, period = 20, mult = 2) {
  const n = candles.length;
  const mid = nulls(n), up = nulls(n), lo = nulls(n), pb = nulls(n), bw = nulls(n);
  if (validPeriod(period)) {
    for (let i = period - 1; i < n; i++) {
      const w = [];
      for (let j = i - period + 1; j <= i; j++) w.push(candles[j].close);
      const m = w.reduce((a, b) => a + b, 0) / period;
      const sd = stdevPop(w);
      mid[i] = m; up[i] = m + mult * sd; lo[i] = m - mult * sd;
      pb[i] = up[i] === lo[i] ? 0.5 : (candles[i].close - lo[i]) / (up[i] - lo[i]);
      bw[i] = ((up[i] - lo[i]) / m) * 100;
    }
  }
  return { middle: mid, upper: up, lower: lo, percentB: pb, bandwidth: bw };
}

// ---- 4-6 TR / ATR ----
export function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}
export function atr(candles, period = 14) {
  if (!validPeriod(period)) return nulls(candles.length);
  return rmaValues(trueRange(candles), period);
}

// ---- 4-7 ストキャスティクス（スロー） ----
export function stochastic(candles, kPeriod = 14, kSmooth = 3, dPeriod = 3) {
  const n = candles.length;
  const raw = nulls(n);
  if (!validPeriod(kPeriod) || !validPeriod(kSmooth) || !validPeriod(dPeriod)) return { k: nulls(n), d: nulls(n), rawK: raw };
  for (let i = kPeriod - 1; i < n; i++) {
    const hh = highest(candles, i - kPeriod + 1, i), ll = lowest(candles, i - kPeriod + 1, i);
    raw[i] = hh === ll ? 50 : (100 * (candles[i].close - ll)) / (hh - ll);
  }
  const k = smaValues(raw, kSmooth);
  const d = smaValues(k, dPeriod);
  return { k, d, rawK: raw };
}

// ---- 4-8 ADX / DMI ----
export function adx(candles, period = 14) {
  const n = candles.length;
  const pdm = nulls(n), mdm = nulls(n), tr = nulls(n);
  if (!validPeriod(period)) return { adx: nulls(n), plusDI: nulls(n), minusDI: nulls(n), dx: nulls(n) };
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - pc), Math.abs(candles[i].low - pc));
  }
  const sp = rmaValues(pdm, period), sm = rmaValues(mdm, period), st = rmaValues(tr, period);
  const pdi = nulls(n), mdi = nulls(n), dx = nulls(n);
  for (let i = 0; i < n; i++) {
    if (st[i] === null) continue;
    pdi[i] = st[i] === 0 ? 0 : (100 * sp[i]) / st[i];
    mdi[i] = st[i] === 0 ? 0 : (100 * sm[i]) / st[i];
    const s = pdi[i] + mdi[i];
    dx[i] = s === 0 ? 0 : (100 * Math.abs(pdi[i] - mdi[i])) / s;
  }
  return { adx: rmaValues(dx, period), plusDI: pdi, minusDI: mdi, dx };
}

// ---- 4-9 CCI ----
export function cci(candles, period = 20) {
  const n = candles.length, out = nulls(n);
  if (!validPeriod(period)) return out;
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  for (let i = period - 1; i < n; i++) {
    let m = 0;
    for (let j = i - period + 1; j <= i; j++) m += tp[j];
    m /= period;
    let md = 0;
    for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j] - m);
    md /= period;
    out[i] = md === 0 ? 0 : (tp[i] - m) / (0.015 * md);
  }
  return out;
}

// ---- 4-10 ウィリアムズ%R ----
export function williamsR(candles, period = 14) {
  const n = candles.length, out = nulls(n);
  if (!validPeriod(period)) return out;
  for (let i = period - 1; i < n; i++) {
    const hh = highest(candles, i - period + 1, i), ll = lowest(candles, i - period + 1, i);
    out[i] = hh === ll ? -50 : (-100 * (hh - candles[i].close)) / (hh - ll);
  }
  return out;
}

// ---- 4-11 ROC / モメンタム ----
export function roc(candles, period = 12) {
  const n = candles.length, out = nulls(n);
  if (!validPeriod(period)) return out;
  for (let i = period; i < n; i++) out[i] = (100 * (candles[i].close - candles[i - period].close)) / candles[i - period].close;
  return out;
}
export function momentum(candles, period = 10) {
  const n = candles.length, out = nulls(n);
  if (!validPeriod(period)) return out;
  for (let i = period; i < n; i++) out[i] = candles[i].close - candles[i - period].close;
  return out;
}

// ---- 4-12 ケルトナー ----
export function keltner(candles, emaPeriod = 20, atrPeriod = 10, mult = 2) {
  const mid = ema(candles, emaPeriod), a = atr(candles, atrPeriod);
  const up = mid.map((m, i) => (m === null || a[i] === null ? null : m + mult * a[i]));
  const lo = mid.map((m, i) => (m === null || a[i] === null ? null : m - mult * a[i]));
  return { middle: mid, upper: up, lower: lo };
}

// ---- 4-13 一目均衡表（ずらす前の位置に値を置く） ----
export function ichimoku(candles, tenkan = 9, kijun = 26, senkouB = 52, displacement = 26) {
  const n = candles.length;
  const t = nulls(n), k = nulls(n), a = nulls(n), b = nulls(n);
  const ok = [tenkan, kijun, senkouB].every(validPeriod);
  const mid = (i, p) => (highest(candles, i - p + 1, i) + lowest(candles, i - p + 1, i)) / 2;
  if (ok) {
    for (let i = 0; i < n; i++) {
      if (i >= tenkan - 1) t[i] = mid(i, tenkan);
      if (i >= kijun - 1) k[i] = mid(i, kijun);
      if (t[i] !== null && k[i] !== null) a[i] = (t[i] + k[i]) / 2;
      if (i >= senkouB - 1) b[i] = mid(i, senkouB);
    }
  }
  return { tenkan: t, kijun: k, senkouA: a, senkouB: b, chikou: candles.map((c) => c.close), displacement };
}

// ---- 4-14 パラボリック SAR ----
export function parabolicSar(candles, start = 0.02, step = 0.02, max = 0.2) {
  const n = candles.length;
  const sar = nulls(n), trend = nulls(n);
  if (n < 2) return { sar, trend };
  const c = candles;
  let isLong = c[1].close >= c[0].close;
  let s, ep;
  if (isLong) { s = Math.min(c[0].low, c[1].low); ep = Math.max(c[0].high, c[1].high); }
  else { s = Math.max(c[0].high, c[1].high); ep = Math.min(c[0].low, c[1].low); }
  let af = start;
  sar[1] = s; trend[1] = isLong ? 'up' : 'down';
  for (let i = 2; i < n; i++) {
    const prev = sar[i - 1];
    s = prev + af * (ep - prev);
    if (isLong) {
      s = Math.min(s, c[i - 1].low, c[i - 2].low);
      if (c[i].low < s) { isLong = false; s = ep; ep = c[i].low; af = start; }
      else if (c[i].high > ep) { ep = c[i].high; af = Math.min(af + step, max); }
    } else {
      s = Math.max(s, c[i - 1].high, c[i - 2].high);
      if (c[i].high > s) { isLong = true; s = ep; ep = c[i].high; af = start; }
      else if (c[i].low < ep) { ep = c[i].low; af = Math.min(af + step, max); }
    }
    sar[i] = s; trend[i] = isLong ? 'up' : 'down';
  }
  return { sar, trend };
}

// ---- 4-15 スーパートレンド ----
export function supertrend(candles, period = 10, mult = 3) {
  const n = candles.length;
  const a = atr(candles, period);
  const value = nulls(n), direction = nulls(n);
  let fu = null, fl = null, d = null;
  for (let i = 0; i < n; i++) {
    if (a[i] === null) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const bu = hl2 + mult * a[i], bl = hl2 - mult * a[i];
    if (fu === null) {
      fu = bu; fl = bl;
      d = candles[i].close > fu ? 'up' : 'down';
    } else {
      const pc = candles[i - 1].close;
      fu = bu < fu || pc > fu ? bu : fu;
      fl = bl > fl || pc < fl ? bl : fl;
      if (d === 'up') d = candles[i].close < fl ? 'down' : 'up';
      else d = candles[i].close > fu ? 'up' : 'down';
    }
    direction[i] = d;
    value[i] = d === 'up' ? fl : fu;
  }
  return { value, direction };
}

// ---- 4-16 VWAP（日次リセット） ----
export function vwap(candles, resetHourUTC = 0) {
  const out = nulls(candles.length);
  let pv = 0, vv = 0, cur = null;
  candles.forEach((x, i) => {
    const day = Math.floor((x.time - resetHourUTC * 3600) / 86400);
    if (day !== cur) { cur = day; pv = 0; vv = 0; }
    const tp = (x.high + x.low + x.close) / 3;
    pv += tp * x.volume; vv += x.volume;
    out[i] = vv === 0 ? tp : pv / vv;
  });
  return out;
}

// ---- 4-17 ヒストリカル・ボラティリティ ----
export function historicalVolatility(candles, period = 20, periodsPerYear = 252) {
  const n = candles.length, out = nulls(n);
  if (!validPeriod(period) || period < 2) return out;
  const lr = candles.map((c, i) => (i === 0 ? null : Math.log(c.close / candles[i - 1].close)));
  for (let i = period; i < n; i++) out[i] = stdevSample(lr.slice(i - period + 1, i + 1)) * Math.sqrt(periodsPerYear) * 100;
  return out;
}

// ---- 4-18 平均足 ----
export function heikinAshi(candles) {
  const out = [];
  candles.forEach((x, i) => {
    const hc = (x.open + x.high + x.low + x.close) / 4;
    const ho = i === 0 ? (x.open + x.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({ time: x.time, open: ho, high: Math.max(x.high, ho, hc), low: Math.min(x.low, ho, hc), close: hc, volume: x.volume });
  });
  return out;
}

// ---- 4-19 補助 ----
export function aggregateDaily(candles, resetHourUTC = 0) {
  const out = [];
  let cur = null, g = null;
  for (const x of candles) {
    const d = Math.floor((x.time - resetHourUTC * 3600) / 86400);
    if (d !== cur) {
      cur = d;
      g = { time: d * 86400 + resetHourUTC * 3600, open: x.open, high: x.high, low: x.low, close: x.close, volume: 0 };
      out.push(g);
    }
    g.high = Math.max(g.high, x.high); g.low = Math.min(g.low, x.low); g.close = x.close; g.volume += x.volume;
  }
  return out;
}

const MONDAY_OFFSET = 4 * 86400; // 1970-01-01 は木曜。月曜 00:00 UTC 起点にずらす
export function periodStart(time, unit) {
  if (unit === 'week') return Math.floor((time - MONDAY_OFFSET) / 604800) * 604800 + MONDAY_OFFSET;
  if (unit === 'month') { const d = new Date(time * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; }
  return Math.floor(time / 86400) * 86400;
}
export function aggregatePeriod(candles, unit = 'week') {
  const out = [];
  let cur = null, g = null;
  for (const x of candles) {
    const p = periodStart(x.time, unit);
    if (p !== cur) {
      cur = p;
      g = { time: p, open: x.open, high: x.high, low: x.low, close: x.close, volume: 0 };
      out.push(g);
    }
    g.high = Math.max(g.high, x.high); g.low = Math.min(g.low, x.low); g.close = x.close; g.volume += x.volume;
  }
  return out;
}

// b は配列または定数（RSI の 30/70 ライン等）
export function crossings(a, b) {
  const res = [];
  const bv = (i) => (Array.isArray(b) ? b[i] : b);
  for (let i = 1; i < a.length; i++) {
    const a0 = a[i - 1], a1 = a[i], b0 = bv(i - 1), b1 = bv(i);
    if (!isNum(a0) || !isNum(a1) || !isNum(b0) || !isNum(b1)) continue;
    if (a0 <= b0 && a1 > b1) res.push({ index: i, type: 'up' });
    else if (a0 >= b0 && a1 < b1) res.push({ index: i, type: 'down' });
  }
  return res;
}

// 時間足から年換算の本数（HV 用・先物は24時間取引のため目安）
export function periodsPerYearFor(intervalSec) {
  if (intervalSec >= 604800) return 52;
  if (intervalSec >= 86400) return 252;
  return Math.round((252 * 86400) / intervalSec);
}
