// データ取得・正規化・検証・デモデータ
// 正規化・検証・乱数・デモは純粋関数。取得系は fetch と storage を差し替え可能（テスト用）。
import { sanitizeBlocked, sanitizeCandleCache } from './validate.js';

export const TIMEFRAMES = {
  '1m': { label: '1分', sec: 60, binance: '1m', okx: '1m', bybit: '1', td: '1min' },
  '5m': { label: '5分', sec: 300, binance: '5m', okx: '5m', bybit: '5', td: '5min' },
  '15m': { label: '15分', sec: 900, binance: '15m', okx: '15m', bybit: '15', td: '15min' },
  '30m': { label: '30分', sec: 1800, binance: '30m', okx: '30m', bybit: '30', td: '30min' },
  '1h': { label: '1時間', sec: 3600, binance: '1h', okx: '1H', bybit: '60', td: '1h' },
  '4h': { label: '4時間', sec: 14400, binance: '4h', okx: '4H', bybit: '240', td: '4h' },
  '1d': { label: '日足', sec: 86400, binance: '1d', okx: '1Dutc', bybit: 'D', td: '1day' },
  '1w': { label: '週足', sec: 604800, binance: '1w', okx: '1Wutc', bybit: 'W', td: '1week' },
};

export const SOURCE_NAMES = {
  binance: 'Binance 先物 XAUUSDT',
  okx: 'OKX 先物 XAU-USDT-SWAP',
  bybit: 'Bybit 先物 XAUUSDT',
  twelvedata: 'Twelve Data XAU/USD',
  cache: 'キャッシュ',
  demo: 'デモデータ（実際の相場ではありません）',
};
export const SHORT_NAMES = { binance: 'Binance 先物', okx: 'OKX 先物', bybit: 'Bybit 先物', twelvedata: 'Twelve Data', cache: 'キャッシュ', demo: 'デモ' };
export const SOURCE_ORDER = ['binance', 'okx', 'bybit', 'twelvedata'];
export const REAL_SOURCES = SOURCE_ORDER;

// タイムアウト（ms）。接続から本文を読み終えるまでの合計（02_analysis.md 13-7）
export const DEFAULT_TIMEOUTS = {
  candles: 8000, twelve: 10000, ticker: 4000, spot: 5000, fx: 6000, deriv: 5000, long: 10000, news: 8000,
  perSource: 15000, total: 30000, retryDelays: [1000, 3000],
  watchdogCandles: 35000, watchdogTicker: 10000, watchdogOther: 35000,
};

// ---------------- 正規化 ----------------
function dedupeSort(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.time, r); // 後勝ち
  return [...m.values()].sort((a, b) => a.time - b.time);
}
const row = (t, o, h, l, c, v) => ({ time: t, open: Number(o), high: Number(h), low: Number(l), close: Number(c), volume: Number(v) });

export function parseBinanceKlines(json) {
  if (!Array.isArray(json)) throw new Error('Binance: 形式が不正');
  return dedupeSort(json.map((r) => row(Math.floor(Number(r[0]) / 1000), r[1], r[2], r[3], r[4], r[5])));
}
export function parseOkxCandles(json) {
  if (!json || json.code !== '0' || !Array.isArray(json.data)) throw new Error('OKX: ' + (json && json.msg ? json.msg : 'エラー応答'));
  return dedupeSort(json.data.map((r) => row(Math.floor(Number(r[0]) / 1000), r[1], r[2], r[3], r[4], r[6])));
}
export function parseBybitKlines(json) {
  if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) throw new Error('Bybit: ' + (json && json.retMsg ? json.retMsg : 'エラー応答'));
  return dedupeSort(json.result.list.map((r) => row(Math.floor(Number(r[0]) / 1000), r[1], r[2], r[3], r[4], r[5])));
}
export function parseTwelveData(json) {
  if (!json || json.status === 'error' || !Array.isArray(json.values)) throw new Error('Twelve Data: ' + (json && json.message ? json.message : 'エラー応答'));
  return dedupeSort(json.values.map((v) => {
    const s = String(v.datetime);
    const iso = s.length <= 10 ? s + 'T00:00:00Z' : s.replace(' ', 'T') + 'Z';
    return row(Math.floor(Date.parse(iso) / 1000), v.open, v.high, v.low, v.close, v.volume ?? 0);
  }));
}

export function validateCandles(candles) {
  const errors = [];
  if (!Array.isArray(candles) || candles.length < 1) return { ok: false, errors: ['空のデータ'] };
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || !Number.isInteger(c.time)) { errors.push(`[${i}] time が整数でない`); continue; }
    if (i > 0 && !(c.time > candles[i - 1].time)) errors.push(`[${i}] time が昇順でない/重複`);
    for (const k of ['open', 'high', 'low', 'close', 'volume']) if (!Number.isFinite(c[k])) errors.push(`[${i}] ${k} が数値でない`);
    if (c.high < Math.max(c.open, c.close)) errors.push(`[${i}] high が始値/終値より低い`);
    if (c.low > Math.min(c.open, c.close)) errors.push(`[${i}] low が始値/終値より高い`);
    if (!(c.low > 0)) errors.push(`[${i}] low が 0 以下`);
    if (c.low < 500 || c.high > 20000) errors.push(`[${i}] 価格が金の妥当範囲外`);
    if (errors.length > 20) break;
  }
  return { ok: errors.length === 0, errors };
}

// 直近 50 本の時刻差の中央値（偶数個なら小さい方）が sec と一致するか（13-7）
export function checkInterval(times, sec) {
  const t = times.slice(-51);
  const d = [];
  for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
  if (!d.length) return false;
  d.sort((a, b) => a - b);
  return d[Math.floor((d.length - 1) / 2)] === sec;
}
// 連続失敗 fails 回目の後の待ち秒数（2回までは通常、3回目から倍々、cap で頭打ち）
export function backoff(base, fails, cap) {
  if (fails < 3) return base;
  return Math.min(cap, base * 2 ** (fails - 2));
}
export function isStale(lastOkMs, nowMs, limitSec) {
  return lastOkMs === null || lastOkMs === undefined || nowMs - lastOkMs > limitSec * 1000;
}

// ---------------- 応答の分類（13-7） ----------------
export const PARSE_ERROR = 'PARSE_ERROR';
export function classifyResponse(source, status, body) {
  const res = (kind, pauseMin = 0, retryable = false) => ({ kind, pauseMin, retryable });
  if (status === 451) return res('blocked', 1440);
  if (status === 403) return source === 'bybit' ? res('ratelimit', 15) : res('blocked', 1440);
  if (status === 429 || status === 418) return res('ratelimit', 5);
  if (status === 408 || (status >= 500 && status <= 599)) return res('server', 0, true);
  if (!(status >= 200 && status <= 299)) return res('http');
  if (body === PARSE_ERROR) return res('parse');
  const isO = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (source === 'binance') {
    if (isO(body) && 'code' in body) return body.code === -1003 ? res('ratelimit', 5) : res('api');
    if (!Array.isArray(body)) return res('parse');
    return body.length === 0 ? res('empty') : res('ok');
  }
  if (source === 'okx') {
    if (!isO(body)) return res('parse');
    const code = body.code;
    if (code !== '0') {
      if (code === '50011') return res('ratelimit', 5);
      if (code === '50001' || code === '50013') return res('server', 0, true);
      return res('api');
    }
    if (!Array.isArray(body.data)) return res('parse');
    return body.data.length === 0 ? res('empty') : res('ok');
  }
  if (source === 'bybit') {
    if (!isO(body)) return res('parse');
    const rc = body.retCode;
    if (rc !== 0) {
      if (rc === 10006 || rc === 10018) return res('ratelimit', 5);
      if (rc === 10009) return res('blocked', 1440);
      if (rc === 10016) return res('server', 0, true);
      return res('api');
    }
    const lst = isO(body.result) ? body.result.list : undefined;
    if (!Array.isArray(lst)) return res('parse');
    return lst.length === 0 ? res('empty') : res('ok');
  }
  if (source === 'twelvedata') {
    if (!isO(body)) return res('parse');
    if (body.status === 'error') {
      if (body.code === 429) return res('ratelimit', 5);
      if (body.code === 401 || body.code === 403) return res('auth');
      return res('api');
    }
    if (!Array.isArray(body.values)) return res('parse');
    return body.values.length === 0 ? res('empty') : res('ok');
  }
  return res('ok'); // その他（スポット・為替など）は HTTP と JSON だけで判断
}
const KIND_JA = { blocked: '地域制限', ratelimit: '回数制限', server: 'サーバーエラー', http: 'HTTP エラー', parse: 'JSON 不正', api: 'API エラー', auth: 'APIキーが無効', empty: '空のデータ', invalid: 'データ不正', timeout: 'タイムアウト', network: '通信エラー/CORS', aborted: '中断', watchdog: '見張りで中断', skip: 'スキップ', exhausted: '全ソース失敗' };
export function kindJa(kind) { return KIND_JA[kind] || kind; }

// ---------------- デモデータ（13-2-4） ----------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1周目の互換用（任意の seed で作る単純なランダムウォーク）
export function generateDemoCandles({ seed = 20261116, count = 500, intervalSec = 3600, endTime, startPrice = 4000, sigma = 0.0025 } = {}) {
  const rand = mulberry32(seed);
  const end = endTime !== undefined ? endTime : Math.floor(Date.now() / 1000 / intervalSec) * intervalSec;
  const sigmaBar = sigma * Math.sqrt(intervalSec / 3600);
  const out = [];
  let open = startPrice;
  for (let k = 0; k < count; k++) {
    const u1 = 1 - rand(), u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const close = open * Math.exp(sigmaBar * z);
    const high = Math.max(open, close) * (1 + Math.abs(rand() * 0.6 * sigmaBar));
    const low = Math.min(open, close) * (1 - Math.abs(rand() * 0.6 * sigmaBar));
    const volume = 500 + Math.floor(rand() * 1500);
    out.push({ time: end - (count - 1 - k) * intervalSec, open, high, low, close, volume });
    open = close;
  }
  return out;
}

export const DEMO = { SEED: 20261116, EPOCH: 1735516800, P0: 4000, SIGMA: 0.0025, KAPPA: 0.0005 };
let demoMemo = { endHour: null, base: null };
// DEMO.EPOCH から endHour（含む）までの1時間足。返す配列は共有なので書き換えないこと
export function demoHourlyBase(endHour) {
  if (demoMemo.endHour === endHour && demoMemo.base) return demoMemo.base;
  const rng = mulberry32(DEMO.SEED);
  const out = [];
  let o = DEMO.P0;
  for (let t = DEMO.EPOCH; t <= endHour; t += 3600) {
    const u1 = 1 - rng(), u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const c = o * Math.exp(DEMO.SIGMA * z + DEMO.KAPPA * Math.log(DEMO.P0 / o));
    const h = Math.max(o, c) * (1 + rng() * 0.6 * DEMO.SIGMA);
    const l = Math.min(o, c) * (1 - rng() * 0.6 * DEMO.SIGMA);
    const v = 500 + Math.floor(rng() * 1500);
    out.push(Object.freeze({ time: t, open: o, high: h, low: l, close: c, volume: v }));
    o = c;
  }
  demoMemo = { endHour, base: out };
  return out;
}
export function bucketStart(t, tf) {
  if (tf === '1w') { const d = Math.floor(t / 86400); return (d - ((d + 3) % 7)) * 86400; }
  const s = TIMEFRAMES[tf].sec;
  return Math.floor(t / s) * s;
}
export function aggregateBy(c, tf) {
  const out = [];
  let cur = null, g = null;
  for (const x of c) {
    const b = bucketStart(x.time, tf);
    if (b !== cur) { cur = b; g = { time: b, open: x.open, high: x.high, low: x.low, close: x.close, volume: 0 }; out.push(g); }
    g.high = Math.max(g.high, x.high); g.low = Math.min(g.low, x.low); g.close = x.close; g.volume += x.volume;
  }
  return out;
}
export function demoSplitHour(hb, sec) {
  const m = 3600 / sec;
  const rng = mulberry32((DEMO.SEED ^ (hb.time / 3600)) >>> 0);
  const s = DEMO.SIGMA / Math.sqrt(m);
  const W = [0];
  for (let k = 1; k <= m; k++) {
    const u1 = 1 - rng(), u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    W.push(W[k - 1] + s * z);
  }
  const { open: O, high: H, low: L, close: C, volume: V } = hb;
  const D = Math.log(C / O);
  const p = [O];
  for (let k = 1; k < m; k++) { const f = k / m; p.push(Math.min(H, Math.max(L, O * Math.exp(W[k] - f * W[m] + f * D)))); }
  p.push(C);
  const bars = [];
  const baseV = Math.floor(V / m);
  for (let j = 0; j < m; j++) {
    const o = p[j], c = p[j + 1];
    const h = Math.min(H, Math.max(o, c) * (1 + rng() * 0.3 * s));
    const l = Math.max(L, Math.min(o, c) * (1 - rng() * 0.3 * s));
    bars.push({ time: hb.time + j * sec, open: o, high: h, low: l, close: c, volume: j < m - 1 ? baseV : V - baseV * (m - 1) });
  }
  let jh = 0, jl = 0;
  for (let j = 1; j < m; j++) { if (bars[j].high > bars[jh].high) jh = j; if (bars[j].low < bars[jl].low) jl = j; }
  bars[jh].high = H; bars[jl].low = L;
  return bars;
}
// nowSec: 秒。limit 本まで（1w は基準系列の長さで 99 本程度）
export function demoCandles(tf, { nowSec = Math.floor(Date.now() / 1000), limit = 500 } = {}) {
  const endHour = Math.floor(nowSec / 3600) * 3600;
  const base = demoHourlyBase(endHour);
  if (tf === '1h') return base.slice(-limit).map((c) => ({ ...c }));
  if (tf === '4h' || tf === '1d' || tf === '1w') return aggregateBy(base, tf).slice(-limit);
  const sec = TIMEFRAMES[tf].sec, m = 3600 / sec;
  const cutoff = Math.floor(nowSec / sec) * sec;
  const nh = Math.ceil(limit / m) + 1;
  let out = [];
  for (const hb of base.slice(-nh)) out = out.concat(demoSplitHour(hb, sec));
  return out.filter((x) => x.time <= cutoff).slice(-limit);
}

// ---------------- 取得 ----------------
export class FetchError extends Error {
  constructor(message, { status = null, kind = 'network', pauseMin = 0, retryable = false } = {}) {
    super(message); this.status = status; this.kind = kind; this.pauseMin = pauseMin; this.retryable = retryable;
  }
}
const abortedError = () => new FetchError('中断', { kind: 'aborted' });

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}
function readJSON(storage, key, fallback) {
  try { const s = storage && storage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
function writeJSON(storage, key, value) {
  try { storage && storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortedError()); return; }
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortedError()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// 接続から本文を読み終えるまでをタイムアウトの対象にする（B4）。
// AbortController＋setTimeout に加え、Promise.race の見張りで、abort が効かない実装でも必ず抜ける。
// 戻り値 { status, body }（body は JSON。読めなければ PARSE_ERROR。2xx 以外は null）
export async function fetchRaw(url, { fetchFn = globalThis.fetch?.bind(globalThis), timeoutMs = 8000, signal = null } = {}) {
  if (signal && signal.aborted) throw abortedError();
  const ctrl = new AbortController();
  let timer = null, onAbort = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new FetchError('タイムアウト', { kind: 'timeout', retryable: true })); }, timeoutMs);
    if (signal) { onAbort = () => { ctrl.abort(); reject(abortedError()); }; signal.addEventListener('abort', onAbort, { once: true }); }
  });
  const work = (async () => {
    let res;
    try { res = await fetchFn(url, { signal: ctrl.signal, cache: 'no-store' }); }
    catch { throw ctrl.signal.aborted ? abortedError() : new FetchError('通信エラー/CORS', { kind: 'network', retryable: true }); }
    const status = res.status;
    if (!(status >= 200 && status <= 299)) { try { if (res.body && res.body.cancel) res.body.cancel().catch(() => {}); } catch { /* noop */ } return { status, body: null }; }
    let text;
    try { text = await res.text(); } // 本文の読み込みも見張りの内側
    catch { throw ctrl.signal.aborted ? abortedError() : new FetchError('本文の読み込みに失敗', { kind: 'network', retryable: true }); }
    let body;
    try { body = JSON.parse(text); } catch { body = PARSE_ERROR; }
    return { status, body };
  })();
  work.catch(() => { /* race で負けた側の失敗は無視 */ });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer); // 本文を読み終えた後（または失敗後）に解除
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

// JSON を取る（スポット・為替など）。2xx 以外・JSON 不正は FetchError
export async function fetchJson(url, opts = {}) {
  const { status, body } = await fetchRaw(url, opts);
  const c = classifyResponse(opts.source || 'other', status, body);
  if (c.kind !== 'ok') throw new FetchError(c.kind === 'parse' ? 'JSON 不正' : `HTTP ${status}`, { status, kind: c.kind, pauseMin: c.pauseMin, retryable: c.retryable });
  return body;
}

const BLOCK_KEY = 'ga:blockedSources';
export function getBlockedSources(storage = defaultStorage()) { return sanitizeBlocked(readJSON(storage, BLOCK_KEY, {})).value; }
export function resetBlockedSources(storage = defaultStorage(), only = null) {
  try {
    if (!storage) return;
    if (!only) { storage.removeItem(BLOCK_KEY); return; }
    const b = getBlockedSources(storage); delete b[only]; writeJSON(storage, BLOCK_KEY, b);
  } catch { /* noop */ }
}

function errMsg(c, status, body) {
  const extra = body && typeof body === 'object' ? (body.msg || body.retMsg || body.message || '') : '';
  return `${kindJa(c.kind)}${status && status !== 200 ? ' ' + status : ''}${extra ? '（' + String(extra).slice(0, 60) + '）' : ''}`;
}

async function fetchFromSource(source, tf, limit, { fetchFn, apiKey, signal, TO, deadline }) {
  const T = TIMEFRAMES[tf];
  const get = async (url, perReq) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new FetchError('時間の上限を超えました', { kind: 'timeout', retryable: true });
    const { status, body } = await fetchRaw(url, { fetchFn, timeoutMs: Math.max(1, Math.min(perReq, left)), signal });
    const c = classifyResponse(source, status, body);
    if (c.kind !== 'ok') throw new FetchError(errMsg(c, status, body), { status, kind: c.kind, pauseMin: c.pauseMin, retryable: c.retryable });
    return body;
  };
  if (source === 'binance') return parseBinanceKlines(await get(`https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${T.binance}&limit=${Math.min(limit, 1500)}`, TO.candles));
  if (source === 'okx') {
    let all = parseOkxCandles(await get(`https://www.okx.com/api/v5/market/candles?instId=XAU-USDT-SWAP&bar=${T.okx}&limit=${Math.min(limit, 300)}`, TO.candles));
    const pages = Math.min(3, Math.max(0, Math.ceil((limit - 300) / 300)));
    for (let k = 0; k < pages && all.length < limit && all.length > 0; k++) {
      let more;
      try { more = parseOkxCandles(await get(`https://www.okx.com/api/v5/market/history-candles?instId=XAU-USDT-SWAP&bar=${T.okx}&limit=300&after=${all[0].time * 1000}`, TO.candles)); }
      catch (e) { if (e.kind === 'empty') break; throw e; }
      const before = all.length;
      all = dedupeSort([...more, ...all]);
      if (all.length === before) break;
    }
    return all.slice(-limit);
  }
  if (source === 'bybit') return parseBybitKlines(await get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=${T.bybit}&limit=${Math.min(limit, 1000)}`, TO.candles));
  if (source === 'twelvedata') {
    if (!apiKey) throw new FetchError('APIキー未設定', { kind: 'skip' });
    return parseTwelveData(await get(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${T.td}&outputsize=${Math.min(limit, 5000)}&timezone=UTC&apikey=${encodeURIComponent(apiKey)}`, TO.twelve));
  }
  throw new FetchError('不明なソース', { kind: 'skip' });
}

export function readCandleCache(tf, storage = defaultStorage(), nowMs = Date.now()) {
  const raw = readJSON(storage, `ga:cache:${tf}`, null);
  return raw ? sanitizeCandleCache(raw, nowMs, validateCandles) : null;
}

// 戻り値: { candles, source, cachedSource?, attempts, fetchedAt, cacheAgeMin? }
// 外からの signal で中断されたら FetchError(kind 'aborted') を投げ、記録・キャッシュ・退避は何もしない（R5）
export async function fetchCandlesWithFallback(tf, limit = 500, opts = {}) {
  const {
    fetchFn = globalThis.fetch?.bind(globalThis), storage = defaultStorage(), now = Date.now(),
    apiKey = '', sourceMode = 'auto', startFrom = null, order: orderOpt = null, minBars = 20,
    useCache = true, writeCache = true, fallback = true, signal = null, timeouts = {}, demoFn = demoCandles,
  } = opts;
  const TO = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const t0 = Date.now(), totalDeadline = t0 + TO.total;
  const attempts = [];
  const blocked = getBlockedSources(storage);
  let order = orderOpt ? orderOpt.slice() : sourceMode === 'auto' ? SOURCE_ORDER.slice() : sourceMode === 'demo' ? [] : [sourceMode];
  if (!orderOpt && startFrom && order.includes(startFrom)) order = order.slice(order.indexOf(startFrom));
  const fixedMode = !orderOpt && sourceMode !== 'auto' && sourceMode !== 'demo';
  const sec = TIMEFRAMES[tf].sec;
  const checkAbort = () => { if (signal && signal.aborted) throw abortedError(); };

  for (const source of order) {
    checkAbort();
    if (source === 'twelvedata' && !apiKey) continue;
    const b = blocked[source];
    if (b && b.until > now) {
      attempts.push({ source, ok: false, status: b.status, error: b.kind === 'blocked' ? '地域制限の記録あり（スキップ）' : '回数制限で休止中（スキップ）', kind: b.kind, ms: 0, skipped: true });
      continue;
    }
    if (Date.now() >= totalDeadline) { attempts.push({ source, ok: false, status: null, error: '全体の時間上限を超えたため試していません', kind: 'timeout', ms: 0, skipped: true }); continue; }
    let tries = 0;
    for (;;) {
      const ts = Date.now();
      try {
        const candles = await fetchFromSource(source, tf, limit, { fetchFn, apiKey, signal, TO, deadline: Math.min(ts + TO.perSource, totalDeadline) });
        checkAbort();
        const v = validateCandles(candles);
        if (!v.ok) throw new FetchError('データ不正: ' + v.errors[0], { kind: 'invalid' });
        if (candles.length < minBars) throw new FetchError(`本数不足（${candles.length}本）`, { kind: 'invalid' });
        if (!checkInterval(candles.map((c) => c.time), sec)) throw new FetchError('足の間隔が時間足と合いません', { kind: 'invalid' });
        attempts.push({ source, ok: true, status: 200, error: null, kind: 'ok', ms: Date.now() - ts });
        if (writeCache) writeJSON(storage, `ga:cache:${tf}`, { source, fetchedAt: now, candles: candles.slice(-1500).map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]) });
        return { candles, source, attempts, fetchedAt: now };
      } catch (e) {
        if ((e && e.kind === 'aborted') || (signal && signal.aborted)) throw abortedError();
        const kind = e.kind || 'network';
        attempts.push({ source, ok: false, status: e.status ?? null, error: e.message, kind, ms: Date.now() - ts });
        if ((kind === 'blocked' || kind === 'ratelimit') && e.pauseMin > 0) {
          blocked[source] = { at: now, until: now + e.pauseMin * 60000, status: e.status ?? null, kind };
          writeJSON(storage, BLOCK_KEY, blocked);
        }
        if (kind === 'auth') { // キーが変わるまで飛ばす（設定でキーを変えると記録を消す）
          blocked[source] = { at: now, until: now + 24 * 3600 * 1000, status: 401, kind: 'blocked' };
          writeJSON(storage, BLOCK_KEY, blocked);
        }
        const delay = TO.retryDelays[tries];
        if (fixedMode && e.retryable && delay !== undefined && Date.now() + delay < totalDeadline) {
          await sleep(delay, signal);
          tries++;
          continue;
        }
        break;
      }
    }
  }
  checkAbort();
  if (!fallback) throw Object.assign(new FetchError('すべてのソースで取得できませんでした', { kind: 'exhausted' }), { attempts });
  if (sourceMode !== 'demo' && useCache) {
    const cached = readCandleCache(tf, storage, now);
    if (cached) return { candles: cached.candles, source: 'cache', cachedSource: cached.source, attempts, fetchedAt: cached.fetchedAt, cacheAgeMin: Math.round((now - cached.fetchedAt) / 60000) };
  }
  const candles = demoFn(tf, { nowSec: Math.floor(now / 1000), limit });
  return { candles, source: 'demo', attempts, fetchedAt: now };
}

// ---------------- 現在値・関連データ ----------------
export async function fetchFuturesTicker(source, { fetchFn, apiKey, signal, timeoutMs = DEFAULT_TIMEOUTS.ticker } = {}) {
  const o = { fetchFn, signal, timeoutMs, source };
  if (source === 'binance') {
    const j = await fetchJson('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=XAUUSDT', { ...o, source: 'other' });
    if (j && 'code' in j && !('lastPrice' in j)) throw new FetchError('Binance ticker エラー', { kind: j.code === -1003 ? 'ratelimit' : 'api', pauseMin: j.code === -1003 ? 5 : 0 });
    return { price: Number(j.lastPrice), high24h: Number(j.highPrice), low24h: Number(j.lowPrice), open24h: Number(j.openPrice) };
  }
  if (source === 'okx') {
    const j = await fetchJson('https://www.okx.com/api/v5/market/ticker?instId=XAU-USDT-SWAP', o);
    const d = j.data && j.data[0];
    if (!d) throw new FetchError('OKX ticker 不正', { kind: 'parse' });
    return { price: Number(d.last), high24h: Number(d.high24h), low24h: Number(d.low24h), open24h: Number(d.open24h) };
  }
  if (source === 'bybit') {
    const j = await fetchJson('https://api.bybit.com/v5/market/tickers?category=linear&symbol=XAUUSDT', o);
    const d = j.result && j.result.list && j.result.list[0];
    if (!d) throw new FetchError('Bybit ticker 不正', { kind: 'parse' });
    return { price: Number(d.lastPrice), high24h: Number(d.highPrice24h), low24h: Number(d.lowPrice24h), open24h: Number(d.prevPrice24h) };
  }
  if (source === 'twelvedata' && apiKey) {
    const j = await fetchJson(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${encodeURIComponent(apiKey)}`, { ...o, source: 'other' });
    if (!j.price) throw new FetchError('Twelve Data price 不正', { kind: 'parse' });
    return { price: Number(j.price), high24h: null, low24h: null, open24h: null };
  }
  throw new FetchError('ticker 非対応', { kind: 'skip' });
}
// ティックの値の検査（13-7）: 500〜20000、かつ最後の足の終値から 5% 以内
export function validTick(price, lastClose) {
  return Number.isFinite(price) && price >= 500 && price <= 20000 && Number.isFinite(lastClose) && lastClose > 0 && Math.abs(price - lastClose) / lastClose <= 0.05;
}

export async function fetchSpot({ fetchFn } = {}) {
  const j = await fetchJson('https://api.gold-api.com/price/XAU', { fetchFn, timeoutMs: DEFAULT_TIMEOUTS.spot });
  const price = Number(j.price);
  if (!(Number.isFinite(price) && price >= 500 && price <= 20000)) throw new FetchError('スポット不正', { kind: 'invalid' });
  const ts = j.updatedAt ? Date.parse(j.updatedAt) : NaN;
  return { price, updatedAt: Number.isFinite(ts) ? ts : Date.now(), source: 'gold-api.com' };
}
export async function fetchSilver({ fetchFn } = {}) {
  const j = await fetchJson('https://api.gold-api.com/price/XAG', { fetchFn, timeoutMs: DEFAULT_TIMEOUTS.spot });
  const p = Number(j.price);
  if (!(Number.isFinite(p) && p > 0)) throw new FetchError('銀価格不正', { kind: 'invalid' });
  return p;
}
const okJpy = (v) => Number.isFinite(v) && v >= 50 && v <= 500;
export async function fetchUsdJpy({ fetchFn } = {}) {
  try {
    const j = await fetchJson('https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY', { fetchFn, timeoutMs: DEFAULT_TIMEOUTS.fx });
    const r = Number(j.rates && j.rates.JPY);
    if (okJpy(r)) return { rate: r, source: 'frankfurter（ECB 日次）', date: j.date };
  } catch { /* 次へ */ }
  const j = await fetchJson('https://open.er-api.com/v6/latest/USD', { fetchFn, timeoutMs: DEFAULT_TIMEOUTS.fx });
  const r = Number(j.rates && j.rates.JPY);
  if (okJpy(r)) return { rate: r, source: 'open.er-api.com（日次）', date: j.time_last_update_utc };
  throw new FetchError('USDJPY 取得失敗', { kind: 'invalid' });
}
export async function fetchDxyRates({ fetchFn } = {}) {
  const j = await fetchJson('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,JPY,GBP,CAD,SEK,CHF', { fetchFn, timeoutMs: DEFAULT_TIMEOUTS.fx });
  return { rates: j.rates, date: j.date };
}
export async function fetchUsdJpyHistory(fromDate, { fetchFn } = {}) {
  const j = await fetchJson(`https://api.frankfurter.dev/v1/${fromDate}..?base=USD&symbols=JPY`, { fetchFn, timeoutMs: DEFAULT_TIMEOUTS.long });
  return Object.keys(j.rates || {}).sort().map((d) => ({ time: Date.parse(d + 'T00:00:00Z') / 1000, close: Number(j.rates[d].JPY) }));
}
export async function fetchDerivatives({ fetchFn } = {}) {
  try {
    const j = await fetchJson('https://api.bybit.com/v5/market/tickers?category=linear&symbol=XAUUSDT', { fetchFn, timeoutMs: DEFAULT_TIMEOUTS.deriv, source: 'other' });
    const d = j.retCode === 0 && j.result && j.result.list && j.result.list[0];
    if (d) return { openInterest: Number(d.openInterest), fundingRate: Number(d.fundingRate), source: 'Bybit' };
  } catch { /* 次へ */ }
  const [p, oi] = await Promise.all([
    fetchJson('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=XAUUSDT', { fetchFn, timeoutMs: DEFAULT_TIMEOUTS.deriv }),
    fetchJson('https://fapi.binance.com/fapi/v1/openInterest?symbol=XAUUSDT', { fetchFn, timeoutMs: DEFAULT_TIMEOUTS.deriv }),
  ]);
  return { openInterest: Number(oi.openInterest), fundingRate: Number(p.lastFundingRate), source: 'Binance' };
}
// xaus.com 5年日足（始値なし）→ {time, close, high, low}
export function parseXausHistory(json) {
  let arr = Array.isArray(json) ? json : null;
  if (!arr && json && typeof json === 'object') {
    for (const k of Object.keys(json)) if (Array.isArray(json[k])) { arr = json[k]; break; }
  }
  if (!arr) throw new Error('xaus: 形式が不正');
  return arr
    .filter((x) => x && x.d && Number.isFinite(Number(x.c)))
    .map((x) => ({ time: Date.parse(String(x.d) + 'T00:00:00Z') / 1000, close: Number(x.c), high: Number(x.h ?? x.c), low: Number(x.l ?? x.c) }))
    .filter((x) => Number.isFinite(x.time))
    .sort((a, b) => a.time - b.time);
}
export async function fetchXausHistory({ fetchFn } = {}) {
  const rows = parseXausHistory(await fetchJson('https://xaus.com/api/v1/history', { fetchFn, timeoutMs: DEFAULT_TIMEOUTS.long }));
  if (rows.length < 100) throw new FetchError(`長期日足が不足（${rows.length}行）`, { kind: 'invalid' });
  return rows;
}
export async function fetchNews(rssUrl, { fetchFn } = {}) {
  const j = await fetchJson(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`, { fetchFn, timeoutMs: DEFAULT_TIMEOUTS.news });
  if (j.status !== 'ok' || !Array.isArray(j.items)) throw new FetchError('ニュース取得失敗', { kind: 'parse' });
  return j.items.slice(0, 20).map((it) => ({ title: String(it.title || ''), link: String(it.link || ''), pubDate: String(it.pubDate || '') }));
}
