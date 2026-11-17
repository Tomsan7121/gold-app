// 入力欄と保存データの検査（純粋関数）。docs/02_analysis.md 13-5・13-6。
import { DEFAULT_WEIGHTS } from './signals.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const isInt = (v) => isNum(v) && Number.isInteger(v);

// ---------------- 13-6 数値の読み方 ----------------
const FW_FROM = '０１２３４５６７８９．，－＋ｅＥ';
const FW_TO = '0123456789.,-+eE';
const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
export function parseNum(s) {
  if (typeof s !== 'string') return null;
  let t = '';
  for (const ch of s) { const k = FW_FROM.indexOf(ch); t += k >= 0 ? FW_TO[k] : ch; }
  t = t.trim().replace(/　/g, '').replace(/,/g, '');
  if (!NUM_RE.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

// ---------------- 13-6 入力の検査 ----------------
export function checkLotInputs({ balance, riskPercent, accountCurrency, usdJpy, entry, stop, side, current = null }) {
  const errors = [], warnings = [];
  if (balance === null || balance === undefined) errors.push('BALANCE_REQUIRED');
  else if (balance <= 0) errors.push('BALANCE_NOT_POSITIVE');
  else if (balance > 1e12) errors.push('BALANCE_TOO_LARGE');
  if (riskPercent === null || riskPercent === undefined) errors.push('RISK_REQUIRED');
  else if (riskPercent <= 0) errors.push('RISK_NOT_POSITIVE');
  else if (riskPercent > 100) errors.push('RISK_OVER_100');
  else if (riskPercent > 20) warnings.push('RISK_VERY_HIGH');
  else if (riskPercent > 5) warnings.push('RISK_HIGH');
  if (accountCurrency === 'JPY') {
    if (usdJpy === null || usdJpy === undefined) warnings.push('USDJPY_AUTO');
    else if (!(usdJpy >= 50 && usdJpy <= 500)) errors.push('USDJPY_RANGE');
  }
  const inRange = (p) => p !== null && p !== undefined && p >= 500 && p <= 20000;
  for (const [name, p] of [['ENTRY', entry], ['STOP', stop]]) {
    if (p === null || p === undefined) errors.push(name + '_REQUIRED');
    else if (!inRange(p)) errors.push(name + '_RANGE');
  }
  if (inRange(entry) && inRange(stop)) {
    if (entry === stop) errors.push('STOP_EQUALS_ENTRY');
    else if ((side === 'buy' && stop > entry) || (side === 'sell' && stop < entry)) errors.push('STOP_WRONG_SIDE');
    else if (Math.abs(entry - stop) < 0.5) warnings.push('STOP_TOO_TIGHT');
    if (current !== null && current !== undefined && current > 0 && Math.abs(entry - current) / current > 0.2) warnings.push('PRICE_FAR');
  }
  return { errors, warnings };
}

export function checkAlertPrice({ price, direction, current = null }) {
  const errors = [], warnings = [];
  if (price === null || price === undefined) errors.push('PRICE_REQUIRED');
  else if (!(price >= 500 && price <= 20000)) errors.push('PRICE_RANGE');
  else if (current !== null && current !== undefined && current > 0) {
    const d = Math.abs(price - current) / current;
    if (d > 0.5) errors.push('ALERT_TOO_FAR');
    else if (d > 0.1) warnings.push('ALERT_FAR');
    if ((direction === 'above' && current >= price) || (direction === 'below' && current <= price)) warnings.push('ALERT_ALREADY_PASSED');
  }
  return { errors, warnings };
}

export function checkAtrInputs({ entry, atr, mult }) {
  const errors = [], warnings = [];
  const okEntry = entry !== null && entry !== undefined && entry >= 500 && entry <= 20000;
  if (entry === null || entry === undefined) errors.push('ENTRY_REQUIRED');
  else if (!okEntry) errors.push('ENTRY_RANGE');
  if (atr === null || atr === undefined) errors.push('ATR_REQUIRED');
  else if (atr <= 0) errors.push('ATR_NOT_POSITIVE');
  else if (atr > 1000) errors.push('ATR_RANGE');
  else if (okEntry && atr / entry > 0.1) warnings.push('ATR_LARGE');
  if (mult === null || mult === undefined) errors.push('MULT_REQUIRED');
  else if (!(mult >= 0.1 && mult <= 10)) errors.push('MULT_RANGE');
  return { errors, warnings };
}

export const INPUT_MESSAGES = {
  BALANCE_REQUIRED: '口座残高を入れてください',
  BALANCE_NOT_POSITIVE: '口座残高は 0 より大きい数で入れてください',
  BALANCE_TOO_LARGE: '口座残高が大きすぎます（1 兆まで）',
  RISK_REQUIRED: '許容損失 % は 0 より大きい数で入れてください',
  RISK_NOT_POSITIVE: '許容損失 % は 0 より大きい数で入れてください',
  RISK_OVER_100: '許容損失が 100% を超えています。計算できません',
  RISK_VERY_HIGH: '1 回の損切りで残高の 20% 超を失う設定です',
  RISK_HIGH: '一般的な目安（1〜2%）を大きく超えています',
  USDJPY_RANGE: 'USD/JPY は 50〜500 の範囲で入れてください',
  ENTRY_REQUIRED: 'エントリー価格を入れてください',
  STOP_REQUIRED: '損切り価格を入れてください',
  ENTRY_RANGE: '価格は 500〜20,000 の範囲で入れてください（エントリー）',
  STOP_RANGE: '価格は 500〜20,000 の範囲で入れてください（損切り）',
  STOP_EQUALS_ENTRY: 'エントリーと損切りが同じです',
  STOP_WRONG_SIDE: '買いの損切りはエントリーより下にしてください（売りは上）',
  STOP_TOO_TIGHT: '損切り幅が $0.50 未満です（スプレッド程度の幅です）',
  PRICE_FAR: 'エントリーが現在値から 20% 以上離れています',
  ATR_REQUIRED: 'ATR を入れてください',
  ATR_NOT_POSITIVE: 'ATR は 0 より大きい数で入れてください',
  ATR_RANGE: 'ATR が大きすぎます（1000 まで）',
  ATR_LARGE: 'ATR がエントリー価格の 10% を超えています',
  MULT_REQUIRED: '倍率を入れてください',
  MULT_RANGE: '倍率は 0.1〜10 の範囲で入れてください',
  PRICE_REQUIRED: '価格を入れてください',
  PRICE_RANGE: '価格は 500〜20,000 の範囲で入れてください',
  ALERT_TOO_FAR: '現在値から 50% 以上離れた価格は登録できません',
};

// ---------------- 13-5 保存データの検査 ----------------
export const TIME_MIN_MS = 946684800000;
export const TIME_MAX_MS = 4102444800000; // 未満

function fixIds(items, prefix) {
  const seen = new Set();
  let fixed = 0;
  items.forEach((x, i) => {
    const id = x.id;
    if (!(typeof id === 'string' && id.length > 0 && id.length <= 40) || seen.has(id)) { x.id = `${prefix}-${i}`; fixed++; }
    seen.add(x.id);
  });
  return fixed;
}
function optStr(x, key, maxlen) {
  if (!(key in x) || x[key] === null || x[key] === undefined) return ['', 0];
  const v = x[key];
  if (typeof v !== 'string') return ['', 1];
  if (v.length > maxlen) return [v.slice(0, maxlen), 1];
  return [v, 0];
}

export function sanitizeAlerts(arr) {
  if (!Array.isArray(arr)) return { value: [], dropped: 0, fixed: 0, reset: true };
  let out = [], dropped = 0, fixed = 0;
  for (const x of arr) {
    if (!isObj(x) || !isNum(x.price) || !(x.price >= 500 && x.price <= 20000) || !['above', 'below'].includes(x.direction)) { dropped++; continue; }
    let en = x.enabled === undefined ? true : x.enabled;
    if (typeof en !== 'boolean') { en = true; fixed++; }
    out.push({ id: x.id, price: x.price, direction: x.direction, enabled: en });
  }
  if (out.length > 50) { dropped += out.length - 50; out = out.slice(-50); }
  fixed += fixIds(out, 'al');
  return { value: out, dropped, fixed, reset: false };
}

export function sanitizeCalendar(arr) {
  if (!Array.isArray(arr)) return { value: null, dropped: 0, fixed: 0, reset: true };
  let out = [], dropped = 0, fixed = 0;
  for (const x of arr) {
    if (!isObj(x) || !isInt(x.time) || !(x.time >= TIME_MIN_MS && x.time < TIME_MAX_MS)) { dropped++; continue; }
    let name = x.name;
    if (typeof name !== 'string' || !name.trim()) { dropped++; continue; }
    name = name.trim();
    if (name.length > 60) { name = name.slice(0, 60); fixed++; }
    let imp = x.imp;
    if (imp === undefined || imp === null) imp = 2;
    else if (!(isInt(imp) && imp >= 1 && imp <= 3)) { imp = 2; fixed++; }
    const [memo, f] = optStr(x, 'memo', 120); fixed += f;
    let nm = x.notifyMin === undefined ? 30 : x.notifyMin;
    if (!(isInt(nm) && nm >= 0 && nm <= 1440)) { nm = 30; fixed++; }
    out.push({ id: x.id, time: x.time, name, imp, memo, notifyMin: nm });
  }
  out.sort((a, b) => a.time - b.time);
  if (out.length > 200) { dropped += out.length - 200; out = out.slice(0, 200); }
  fixed += fixIds(out, 'cal');
  return { value: out, dropped, fixed, reset: false };
}

export function sanitizeJournal(arr, nowMs, defaultCurrency = 'JPY') {
  if (!Array.isArray(arr)) return { value: [], dropped: 0, fixed: 0, reset: true };
  let out = [], dropped = 0, fixed = 0;
  for (const x of arr) {
    if (!isObj(x) || !isInt(x.time) || !(x.time >= TIME_MIN_MS && x.time <= nowMs + 86400000)) { dropped++; continue; }
    if (!['buy', 'sell'].includes(x.side) || !isNum(x.pnl) || Math.abs(x.pnl) > 1e12) { dropped++; continue; }
    const e = { id: x.id, time: x.time, side: x.side, pnl: x.pnl };
    for (const k of ['entry', 'exit']) {
      const v = x[k];
      if (v === null || v === undefined) e[k] = null;
      else if (isNum(v) && v >= 500 && v <= 20000) e[k] = v;
      else { e[k] = null; fixed++; }
    }
    const lv = x.lots;
    if (lv === null || lv === undefined) e.lots = null;
    else if (isNum(lv) && lv > 0 && lv <= 100000) e.lots = lv;
    else { e.lots = null; fixed++; }
    const cur = x.currency;
    if (cur === null || cur === undefined) e.currency = defaultCurrency;
    else if (cur === 'JPY' || cur === 'USD') e.currency = cur;
    else { e.currency = defaultCurrency; fixed++; }
    const [memo, f] = optStr(x, 'memo', 500); fixed += f;
    e.memo = memo;
    out.push(e);
  }
  out.sort((a, b) => a.time - b.time);
  if (out.length > 5000) { dropped += out.length - 5000; out = out.slice(-5000); }
  fixed += fixIds(out, 'j');
  return { value: out, dropped, fixed, reset: false };
}

export function sanitizeHlines(arr) {
  if (!Array.isArray(arr)) return { value: [], dropped: 0, fixed: 0, reset: true };
  let out = [], dropped = 0;
  for (const x of arr) {
    if (!isObj(x) || !isNum(x.price) || !(x.price >= 500 && x.price <= 20000)) { dropped++; continue; }
    out.push({ id: x.id, price: x.price });
  }
  if (out.length > 30) { dropped += out.length - 30; out = out.slice(-30); }
  const fixed = fixIds(out, 'hl');
  return { value: out, dropped, fixed, reset: false };
}

export function sanitizeTrendlines(arr) {
  if (!Array.isArray(arr)) return { value: [], dropped: 0, fixed: 0, reset: true };
  let out = [], dropped = 0;
  const tOk = (t) => isInt(t) && t >= 946684800 && t <= 4102444799;
  const pOk = (p) => isNum(p) && p >= 500 && p <= 20000;
  for (const x of arr) {
    if (!isObj(x) || !tOk(x.t1) || !tOk(x.t2) || x.t1 === x.t2 || !pOk(x.p1) || !pOk(x.p2)) { dropped++; continue; }
    out.push({ id: x.id, t1: x.t1, p1: x.p1, t2: x.t2, p2: x.p2 });
  }
  if (out.length > 20) { dropped += out.length - 20; out = out.slice(-20); }
  const fixed = fixIds(out, 'tl');
  return { value: out, dropped, fixed, reset: false };
}

export function sanitizeStrings(arr, maxLen, maxCount) {
  if (!Array.isArray(arr)) return { value: [], dropped: 0, fixed: 0, reset: true };
  let out = arr.filter((s) => typeof s === 'string' && s.length <= maxLen);
  let dropped = arr.length - out.length;
  if (out.length > maxCount) { dropped += out.length - maxCount; out = out.slice(-maxCount); }
  return { value: out, dropped, fixed: 0, reset: false };
}

export const BLOCK_SOURCES = ['binance', 'okx', 'bybit', 'twelvedata'];
export function sanitizeBlocked(obj) {
  if (!isObj(obj)) return { value: {}, dropped: 0, fixed: 0, reset: true };
  const out = {};
  let dropped = 0, fixed = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (!BLOCK_SOURCES.includes(k) || !isObj(v) || !isNum(v.at) || !isNum(v.until) || !['blocked', 'ratelimit'].includes(v.kind)) { dropped++; continue; }
    const d = v.until - v.at;
    if (!(d > 0 && d <= 24 * 3600 * 1000 + 60000)) { dropped++; continue; }
    let st = v.status === undefined ? null : v.status;
    if (!(st === null || isInt(st))) { st = null; fixed++; }
    out[k] = { at: v.at, until: v.until, status: st, kind: v.kind };
  }
  return { value: out, dropped, fixed, reset: false };
}

// ローソク足キャッシュ（ga:cache:{tf}）。形が違えば null（キーを消す）
export function sanitizeCandleCache(obj, nowMs, validateCandles) {
  if (!isObj(obj) || !BLOCK_SOURCES.includes(obj.source) || !isNum(obj.fetchedAt) || obj.fetchedAt > nowMs + 60000) return null;
  if (!Array.isArray(obj.candles) || obj.candles.length < 1 || obj.candles.length > 1500) return null;
  if (!obj.candles.every((r) => Array.isArray(r) && r.length === 6 && r.every(isNum))) return null;
  const candles = obj.candles.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
  if (validateCandles && !validateCandles(candles).ok) return null;
  return { source: obj.source, fetchedAt: obj.fetchedAt, candles };
}

export function sanitizeApiKey(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= 200 && /^[\x21-\x7e]+$/.test(v) ? v : null;
}

// ---------------- 設定 ----------------
const INT_PARAMS = { emaFast: 20, emaSlow: 50, smaLong: 200, rsi: 14, macdFast: 12, macdSlow: 26, macdSignal: 9, stochK: 14, stochSmooth: 3, stochD: 3,
  bbPeriod: 20, adx: 14, stPeriod: 10, ichiTenkan: 9, ichiKijun: 26, ichiSenkouB: 52, ichiDisp: 26,
  cci: 20, willr: 14, roc: 12, mom: 10, atr: 14, hv: 20, kcEma: 20, kcAtr: 10 };
const IND_ON = [['sma', true], ['ema', true], ['bb', true], ['ichimoku', false], ['psar', false], ['supertrend', false], ['keltner', false], ['vwap', false], ['volume', true],
  ['rsi', true], ['macd', true], ['stoch', false], ['adx', false], ['atr', false], ['cci', false], ['willr', false], ['roc', false], ['mom', false], ['hv', false]];
const LEVEL_BOOL = [['pivot', true], ['prevDay', true], ['prevWeek', false], ['prevMonth', false], ['prevClose', true], ['round', false], ['fib', false], ['sr', false], ['manual', true], ['alerts', true]];

export const SETTINGS_SCHEMA = [
  ['sourceMode', { t: 'enum', values: ['auto', 'binance', 'okx', 'bybit', 'twelvedata', 'demo'], def: 'auto' }],
  ['priceIntervalSec', { t: 'int', min: 2, max: 60, def: 5 }],
  ['spotIntervalSec', { t: 'int', min: 30, max: 600, def: 60 }],
  ['tf', { t: 'enum', values: ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'], def: '1h' }],
  ['chartType', { t: 'enum', values: ['candle', 'heikin', 'line', 'area'], def: 'candle' }],
  ['theme', { t: 'enum', values: ['dark', 'light'], def: 'dark' }],
  ['weekend', { t: 'enum', values: ['dim', 'hide', 'show'], def: 'dim' }],
  ['sessionBg', { t: 'bool', def: true }],
  ['accountCurrency', { t: 'enum', values: ['JPY', 'USD'], def: 'JPY' }],
  ['usdJpyAuto', { t: 'bool', def: true }],
  ['usdJpyManual', { t: 'num', min: 50, max: 500, def: 150 }],
  ['balance', { t: 'num', min: 1, max: 1e12, def: 1000000 }],
  ['riskPercent', { t: 'num', min: 0.01, max: 100, def: 1 }],
  ['contractSize', { t: 'num', min: 0.001, max: 100000, def: 100 }],
  ['lotStep', { t: 'num', min: 0.0001, max: 100, def: 0.01 }],
  ['minLot', { t: 'num', min: 0.0001, max: 1000, def: 0.01 }],
  ['maxLot', { t: 'num', min: 0.0001, max: 100000, def: 100 }],
  ['pipSize', { t: 'num', min: 0.0001, max: 10, def: 0.1 }],
  ['leverage', { t: 'num', min: 1, max: 1000, def: 25 }],
  ['atrMult', { t: 'num', min: 0.1, max: 10, def: 1.5 }],
  ['rrList', { t: 'rr', def: '1,2,3' }],
  ...Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => ['weights.' + k, { t: 'num', min: 0, max: 10, def: v }]),
  ...Object.entries(INT_PARAMS).map(([k, v]) => ['params.' + k, { t: 'int', min: 1, max: 1000, def: v }]),
  ['params.bbMult', { t: 'num', min: 0.1, max: 10, def: 2 }],
  ['params.stMult', { t: 'num', min: 0.1, max: 20, def: 3 }],
  ['params.kcMult', { t: 'num', min: 0.1, max: 10, def: 2 }],
  ['params.psarStart', { t: 'num', min: 0.001, max: 1, def: 0.02 }],
  ['params.psarStep', { t: 'num', min: 0.001, max: 1, def: 0.02 }],
  ['params.psarMax', { t: 'num', min: 0.01, max: 1, def: 0.2 }],
  ['params.vwapReset', { t: 'int', min: 0, max: 23, def: 0 }],
  ...IND_ON.map(([k, v]) => [`ind.${k}.on`, { t: 'bool', def: v }]),
  ['ind.sma.periods', { t: 'periods', def: '200' }],
  ['ind.ema.periods', { t: 'periods', def: '20,50' }],
  ...LEVEL_BOOL.map(([k, v]) => ['levels.' + k, { t: 'bool', def: v }]),
  ['levels.pivotMethod', { t: 'enum', values: ['classic', 'fibonacci', 'camarilla'], def: 'classic' }],
  ['levels.roundStep', { t: 'enum', values: [10, 25, 50, 100], def: 50 }],
  ...[['cross', true], ['divergence', true], ['patterns', false]].map(([k, v]) => ['markers.' + k, { t: 'bool', def: v }]),
  ...[['sound', true], ['vibrate', true], ['notify', false], ['rsi', false], ['emaCross', false], ['stFlip', false]].map(([k, v]) => ['alertOpts.' + k, { t: 'bool', def: v }]),
  ['alertOpts.calendarMinutes', { t: 'int', min: 0, max: 1440, def: 30 }],
  ['rssUrl', { t: 'url', def: 'https://www.fxstreet.com/rss/news' }],
];
const SCHEMA_MAP = new Map(SETTINGS_SCHEMA);
const CROSS_RULES = [['minLot', 'maxLot', false], ['params.emaFast', 'params.emaSlow', true], ['params.macdFast', 'params.macdSlow', true], ['params.psarStart', 'params.psarMax', false]];

export function getPath(o, path) {
  let cur = o;
  for (const k of path.split('.')) {
    if (!isObj(cur) || !(k in cur)) return [false, undefined];
    cur = cur[k];
  }
  return [true, cur];
}
export function setPath(o, path, v) {
  const ks = path.split('.');
  let cur = o;
  for (const k of ks.slice(0, -1)) { if (!isObj(cur[k])) cur[k] = {}; cur = cur[k]; }
  cur[ks[ks.length - 1]] = v;
}
const TOKEN_SPLIT = /[,\s、]+/;
export function checkRule(rule, v) {
  switch (rule.t) {
    case 'enum': return [rule.values.includes(v) && typeof v === typeof rule.def, v];
    case 'bool': return [typeof v === 'boolean', v];
    case 'int': return [isInt(v) && v >= rule.min && v <= rule.max, v];
    case 'num': return [isNum(v) && v >= rule.min && v <= rule.max, v];
    case 'rr': {
      if (typeof v !== 'string' || v.length > 30) return [false, v];
      const toks = [];
      for (const t of v.trim().split(TOKEN_SPLIT)) {
        const n = parseNum(t);
        if (n !== null && n >= 0.1 && n <= 20 && toks.length < 5) toks.push(String(n));
      }
      return [toks.length > 0, toks.join(',')];
    }
    case 'periods': {
      if (typeof v !== 'string' || v.length > 40) return [false, v];
      const toks = [];
      for (const t of v.trim().split(TOKEN_SPLIT)) {
        const n = parseNum(t);
        if (n !== null && Number.isInteger(n) && n >= 1 && n <= 1000 && !toks.includes(String(n)) && toks.length < 5) toks.push(String(n));
      }
      return [toks.length > 0, toks.join(',')];
    }
    case 'url': return [typeof v === 'string' && v.length <= 300 && /^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/.test(v), v];
    default: return [false, v];
  }
}
export function ruleFor(path) { return SCHEMA_MAP.get(path) || null; }
export function ruleText(rule) {
  if (!rule) return '';
  if (rule.t === 'int') return `${rule.min}〜${rule.max} の整数で入れてください`;
  if (rule.t === 'num') return `${rule.min}〜${rule.max} の数で入れてください`;
  return '値が正しくありません';
}

export function sanitizeSettings(obj) {
  const reset = !isObj(obj);
  const src = reset ? {} : obj;
  const out = {};
  const fixed = [];
  for (const [path, rule] of SETTINGS_SCHEMA) {
    const [has, v] = getPath(src, path);
    if (!has) { setPath(out, path, rule.def); continue; }
    const [ok, norm] = checkRule(rule, v);
    if (ok) { setPath(out, path, norm); if (norm !== v) fixed.push(path); }
    else { setPath(out, path, rule.def); fixed.push(path); }
  }
  for (const [a, b, strict] of CROSS_RULES) {
    const va = getPath(out, a)[1], vb = getPath(out, b)[1];
    if (strict ? va >= vb : va > vb) {
      setPath(out, a, SCHEMA_MAP.get(a).def); setPath(out, b, SCHEMA_MAP.get(b).def);
      for (const p of [a, b]) if (!fixed.includes(p)) fixed.push(p);
    }
  }
  fixed.sort();
  return { settings: out, fixed, reset };
}
export function defaultSettings() { return sanitizeSettings({}).settings; }

// インポート用: 今の設定に「ファイルにある項目だけ」を検査して反映する（R3-1）。
// 戻り値: settings（新しい設定）、changed（値が変わるパス）、rejected（範囲外・型違いで無視したパス）。どちらも昇順
export function mergeSettings(current, partial) {
  const out = JSON.parse(JSON.stringify(sanitizeSettings(current).settings));
  const changed = [], rejected = [];
  if (!isObj(partial)) return { settings: out, changed, rejected };
  for (const [path, rule] of SETTINGS_SCHEMA) {
    const [has, v] = getPath(partial, path);
    if (!has) continue;
    const [ok, norm] = checkRule(rule, v);
    if (!ok) { rejected.push(path); continue; }
    if (getPath(out, path)[1] !== norm) { setPath(out, path, norm); changed.push(path); }
  }
  // 項目どうしの条件が破れたら、その 2 項目は今の値に戻す。理由は「範囲外」と分けて conflicts に入れる（R4-1）
  const conflicts = [];
  for (const [a, b, strict] of CROSS_RULES) {
    const va = getPath(out, a)[1], vb = getPath(out, b)[1];
    if (strict ? va >= vb : va > vb) {
      const paths = [];
      for (const p of [a, b]) {
        const cur = getPath(sanitizeSettings(current).settings, p)[1];
        setPath(out, p, cur);
        const k = changed.indexOf(p); if (k >= 0) changed.splice(k, 1);
        if (getPath(partial, p)[0] && !rejected.includes(p)) paths.push(p);
      }
      conflicts.push({ paths, rule: `${a}|${b}`, message: CROSS_MESSAGES[`${a}|${b}`] });
    }
  }
  changed.sort(); rejected.sort();
  return { settings: out, changed, rejected, conflicts };
}
export const CROSS_MESSAGES = {
  'minLot|maxLot': '最小ロットは最大ロット以下にしてください',
  'params.emaFast|params.emaSlow': '短期 EMA は長期 EMA より小さくしてください',
  'params.macdFast|params.macdSlow': 'MACD の短期は長期より小さくしてください',
  'params.psarStart|params.psarMax': 'パラボリック SAR の開始は上限以下にしてください',
};

// カレンダーの★表示（壊れた値でも落ちない）
export function impStars(imp) {
  const n = isInt(imp) && imp >= 1 && imp <= 3 ? imp : 2;
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}
