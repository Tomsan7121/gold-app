// 2周目のテスト（docs/02_analysis.md 13-9。期待値は expected_values.json の expected.round2）
// fetch を差し替えた通信・状態遷移・取得中の操作・アラート・保存データの検査を含む。
import * as I from './indicators.js';
import * as L from './levels.js';
import * as T from './trade.js';
import * as S from './signals.js';
import * as D from './data.js';
import * as V from './validate.js';
import * as store from './store.js';
import { createDataController, acceptResult, combine, alertGate } from './controller.js';
import { safeInit } from './dom.js';
import { ChartView, planChartUpdate } from './chart.js';

const TOL = 1e-4;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- テスト用の道具 ----------------
export function memStorage(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, _m: m,
  };
}
// routes = [{match, status=200, json, text, delayMs=0, hang:null|'headers'|'body', ignoreAbort=false}]
// status・json・delayMs は (url) => 値 の関数でもよい
export function mockFetch(routes) {
  const calls = [];
  const val = (v, url) => (typeof v === 'function' ? v(url) : v);
  const fn = (url, init = {}) => {
    const signal = init.signal;
    calls.push({ url, signal });
    const r = routes.find((x) => (typeof x.match === 'string' ? url.includes(x.match) : x.match.test(url)));
    if (!r) return Promise.reject(new TypeError('Failed to fetch'));
    const status = val(r.status, url) ?? 200;
    return new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => { if (r.ignoreAbort || done) return; done = true; reject(new DOMException('Aborted', 'AbortError')); };
      if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
      if (r.hang === 'headers') return;
      setTimeout(() => {
        if (done) return;
        done = true;
        if (r.hang === 'body') {
          const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":')); } }); // close しない
          resolve(new Response(stream, { status }));
          return;
        }
        const body = r.text !== undefined ? val(r.text, url) : JSON.stringify(val(r.json, url) ?? {});
        resolve(new Response(body, { status, headers: { 'content-type': 'application/json' } }));
      }, val(r.delayMs, url) || 0);
    });
  };
  fn.calls = calls;
  return fn;
}
// 決まった値の足を作る（妥当な OHLC）
export function genBars(n, sec, endT, p0 = 3870, amp = 3) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = endT - (n - 1 - k) * sec;
    const o = p0 + amp * Math.sin(k / 5), c = p0 + amp * Math.sin((k + 1) / 5);
    out.push({ time: t, open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c, volume: 100 + k });
  }
  return out;
}
const SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
const BIN_TF = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' };
const OKX_TF = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1H': '1h', '4H': '4h', '1Dutc': '1d', '1Wutc': '1w' };
const BYB_TF = { 1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 240: '4h', D: '1d', W: '1w' };
const nowEnd = (sec) => Math.floor(Date.now() / 1000 / sec) * sec;
const binTf = (url) => { const m = /interval=([0-9a-z]+)/.exec(url); return m ? BIN_TF[m[1]] : null; };
const okxTf = (url) => { const m = /bar=([0-9A-Za-z]+)/.exec(url); return m ? OKX_TF[m[1]] : null; };
const bybTf = (url) => { const m = /interval=([0-9A-Z]+)/.exec(url); return m ? BYB_TF[m[1]] : null; };
const binanceKlines = (bars) => bars.map((b) => [b.time * 1000, String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume), b.time * 1000 + 1, '0', 1, '0', '0', '0']);
const okxBody = (bars) => ({ code: '0', msg: '', data: bars.slice().reverse().map((b) => [String(b.time * 1000), String(b.open), String(b.high), String(b.low), String(b.close), '1', String(b.volume), '0', '1']) });
const bybitBody = (bars) => ({ retCode: 0, retMsg: 'OK', result: { list: bars.slice().reverse().map((b) => [String(b.time * 1000), String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume), '0']) } });

// 実データ風のルート一式。opt: { price, bin:{status,delay,tfStatus:{tf:status}}, okx:{...}, byb:{...}, tickers:{binance:[...]}, n }
function realRoutes(opt = {}) {
  const price = opt.price ?? 3870;
  const n = opt.n ?? 120;
  const seqs = { binance: [...(opt.tickers?.binance || [])], okx: [...(opt.tickers?.okx || [])], bybit: [...(opt.tickers?.bybit || [])] };
  const nextTick = (src) => (seqs[src].length > 1 ? seqs[src].shift() : seqs[src].length ? seqs[src][0] : price);
  const st = (o, tf) => (o && o.tfStatus && o.tfStatus[tf] !== undefined ? o.tfStatus[tf] : o && o.status !== undefined ? (typeof o.status === 'function' ? o.status() : o.status) : 200);
  const dl = (o, tf) => (o && o.tfDelay && o.tfDelay[tf] !== undefined ? o.tfDelay[tf] : (o && o.delay) || 0);
  const bars = (tf, url) => { const lim = Number((/limit=(\d+)/.exec(url) || [])[1]) || n; return genBars(Math.min(n, lim), SEC[tf], (opt.endFor && opt.endFor(tf)) || nowEnd(SEC[tf]), (opt.priceFor && opt.priceFor(tf)) ?? price); };
  return [
    { match: 'fapi/v1/ticker/24hr', status: () => st(opt.binTick, 't'), delayMs: () => dl(opt.binTick, 't'), json: () => { const p = nextTick('binance'); return { lastPrice: String(p), highPrice: String(p + 10), lowPrice: String(p - 10), openPrice: String(price - 5) }; } },
    { match: 'fapi.binance.com/fapi/v1/klines', status: (u) => st(opt.bin, binTf(u)), delayMs: (u) => dl(opt.bin, binTf(u)), json: (u) => binanceKlines(bars(binTf(u), u)) },
    { match: 'okx.com/api/v5/market/ticker', json: () => { const p = nextTick('okx'); return { code: '0', data: [{ last: String(p), high24h: String(p + 10), low24h: String(p - 10), open24h: String(price - 5) }] }; } },
    { match: 'okx.com/api/v5/market/candles', status: (u) => st(opt.okx, okxTf(u)), delayMs: (u) => dl(opt.okx, okxTf(u)), json: (u) => okxBody(bars(okxTf(u), u)) },
    { match: 'okx.com/api/v5/market/history-candles', json: { code: '0', msg: '', data: [] } },
    { match: 'api.bybit.com/v5/market/tickers', json: () => { const p = nextTick('bybit'); return { retCode: 0, result: { list: [{ lastPrice: String(p), highPrice24h: String(p + 10), lowPrice24h: String(p - 10), prevPrice24h: String(price - 5) }] } }; } },
    { match: 'api.bybit.com/v5/market/kline', status: (u) => st(opt.byb, bybTf(u)), delayMs: (u) => dl(opt.byb, bybTf(u)), json: (u) => bybitBody(bars(bybTf(u), u)) },
  ];
}
const FAST = { candles: 400, ticker: 400, twelve: 400, perSource: 2000, total: 4000, retryDelays: [10, 10], watchdogCandles: 6000, watchdogTicker: 3000, watchdogOther: 6000 };
const mkCtrl = (fetchFn, extra = {}) => createDataController({ fetchFn, storage: memStorage(), timeouts: FAST, tf: '1h', sourceMode: 'auto', limit: 120, dailyLimit: 60, h1Limit: 120, ...extra });
const ivl = (c) => (c.length > 1 ? c[c.length - 1].time - c[c.length - 2].time : null);
const P_of = (daily) => { const pd = daily[daily.length - 2]; return L.pivots(pd.high, pd.low, pd.close, 'classic').P; };

// 順序を問わない深い比較
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-12;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEq(a[k], b[k]));
}

export async function runRound2(J, { record, checkVal, checkEq }) {
  const R = J.expected.round2;
  const C = J.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
  const NOW2 = R.now.sec;
  const bar = (g, name, a, e) => { if (!a) { record(g, name, false, '足が無い'); return; } for (const k of ['time', 'open', 'high', 'low', 'close', 'volume']) checkVal(g, `${name}.${k}`, a[k], e[k], k === 'time' || k === 'volume' ? 0 : TOL); };
  const safe = async (g, name, fn) => { try { await fn(); } catch (e) { record(g, name, false, '例外: ' + (e && e.message)); } };

  // ================= (A) 期待値の照合 =================
  let g = 'A 期待値';
  await safe(g, 'A1 demoCandles', () => {
    for (const [tf, e] of Object.entries(R.demo.candles)) {
      const c = D.demoCandles(tf, { nowSec: NOW2, limit: 500 });
      checkVal(g, `A1 ${tf} 本数`, c.length, e.length, 0);
      bar(g, `A1 ${tf} first`, c[0], e.first);
      e.last2.forEach((x, i) => bar(g, `A1 ${tf} last2[${i}]`, c[c.length - 2 + i], x));
    }
  });
  await safe(g, 'A2 demoHourlyBase', () => {
    const b = D.demoHourlyBase(Math.floor(NOW2 / 3600) * 3600);
    checkVal(g, 'A2 本数', b.length, R.demo.baseCount, 0);
    bar(g, 'A2 最初', b[0], R.demo.baseFirst); bar(g, 'A2 最後', b[b.length - 1], R.demo.baseLast);
    checkVal(g, 'A2 終値の最小', Math.min(...b.map((x) => x.close)), R.demo.baseMinClose);
    checkVal(g, 'A2 終値の最大', Math.max(...b.map((x) => x.close)), R.demo.baseMaxClose);
    checkVal(g, 'A2 安値の最小', Math.min(...b.map((x) => x.low)), R.demo.baseMinLow);
    checkVal(g, 'A2 高値の最大', Math.max(...b.map((x) => x.high)), R.demo.baseMaxHigh);
  });
  await safe(g, 'A3 デモの整合', () => {
    const h1 = D.demoCandles('1h', { nowSec: NOW2 }), d1 = D.demoCandles('1d', { nowSec: NOW2 });
    const agg = I.aggregateDaily(h1).slice(1), m = new Map(d1.map((x) => [x.time, x]));
    const ok = agg.every((x) => m.has(x.time) && ['open', 'high', 'low', 'close', 'volume'].every((k) => Math.abs(x[k] - m.get(x.time)[k]) < 1e-9));
    record(g, `A3 1時間足→日足が一致（${agg.length} 日）`, ok && agg.length === R.demo.aggregateCheckedDays && R.demo.aggregateMatches1d === true);
    const sp = R.demo.split15mOfHour;
    const m15 = D.demoCandles('15m', { nowSec: NOW2 }).filter((x) => x.time >= sp.hourTime && x.time < sp.hourTime + 3600);
    checkVal(g, 'A3 15分足の本数', m15.length, 4, 0);
    sp.bars.forEach((x, i) => bar(g, `A3 15分足[${i}]`, m15[i], x));
    const hb = sp.hourBar;
    record(g, 'A3 15分足4本→1時間足と一致', m15[0].open === h1.find((x) => x.time === hb.time).open && Math.abs(m15[3].close - hb.close) < TOL
      && Math.abs(Math.max(...m15.map((x) => x.high)) - hb.high) < TOL && Math.abs(Math.min(...m15.map((x) => x.low)) - hb.low) < TOL && m15.reduce((a, x) => a + x.volume, 0) === hb.volume);
  });
  await safe(g, 'A4 デモの水準', () => {
    const d1 = D.demoCandles('1d', { nowSec: NOW2 }), h1 = D.demoCandles('1h', { nowSec: NOW2 });
    const pd = d1[d1.length - 2];
    bar(g, 'A4 前日', pd, R.demo.pivotPrevDay.prevDay);
    const pv = L.pivots(pd.high, pd.low, pd.close, 'classic');
    for (const [k, v] of Object.entries(R.demo.pivotPrevDay.classic)) checkVal(g, `A4 ピボット ${k}`, pv[k], v);
    record(g, 'A4 P と 1時間足の終値の差 < 100', Math.abs(pv.P - h1[h1.length - 1].close) < 100, `差 ${Math.abs(pv.P - h1[h1.length - 1].close)}`);
  });
  await safe(g, 'A5 デモの再現性', () => {
    const a = D.demoCandles('1h', { nowSec: NOW2 }), b = D.demoCandles('1h', { nowSec: NOW2 });
    record(g, 'A5 同じ now で完全一致', JSON.stringify(a) === JSON.stringify(b));
    const c = D.demoCandles('1h', { nowSec: NOW2 + 3600 });
    const mb = new Map(a.map((x) => [x.time, x]));
    const common = c.filter((x) => mb.has(x.time) && x.time < Math.floor(NOW2 / 3600) * 3600);
    record(g, 'A5 1時間後も過去の足は同じ', common.length > 400 && common.every((x) => JSON.stringify(x) === JSON.stringify(mb.get(x.time))), `共通 ${common.length}`);
    record(g, 'A5 validate 合格', D.validateCandles(a).ok && D.validateCandles(D.demoCandles('1m', { nowSec: NOW2 })).ok);
  });
  await safe(g, 'A6 デモの切り捨て', () => {
    checkVal(g, 'A6 1分足の最後', D.demoCandles('1m', { nowSec: NOW2 }).at(-1).time, R.demo.cutoff.last1m, 0);
    checkVal(g, 'A6 15分足の最後', D.demoCandles('15m', { nowSec: NOW2 }).at(-1).time, R.demo.cutoff.last15m, 0);
  });
  await safe(g, 'A7 確定足の総合判定', () => {
    const r = S.compositeScore(C.slice(0, -1)), e = R.compositeConfirmed;
    checkVal(g, 'A7 score', r.score, e.score, 0); checkVal(g, 'A7 label', r.label, e.label);
    checkVal(g, 'A7 weightedSum', r.weightedSum, e.weightedSum); checkVal(g, 'A7 totalWeight', r.totalWeight, e.totalWeight);
    e.components.forEach((x, i) => { const a = r.components[i] || {}; record(g, `A7 components[${i}] ${x.key}`, a.key === x.key && a.weight === x.weight && Math.abs(a.score - x.score) < TOL, JSON.stringify(a.key) + ' ' + a.score); });
    checkEq(g, 'A7 RSI の寄与の表示は小数1桁（B12）', S.fmtScore(0.23380331814344366), '+0.2');
  });
  await safe(g, 'A8 LOT_CAPPED', () => {
    const r = T.calcLot(R.lotCapped.input);
    for (const [k, v] of Object.entries(R.lotCapped.output)) checkVal(g, `A8 ${k}`, r[k], v);
  });
  await safe(g, 'A9 parseNum', () => R.parseNum.forEach((c) => checkEq(g, `A9 parseNum(${JSON.stringify(c.input)})`, V.parseNum(c.input), c.output)));
  await safe(g, 'A10 入力の検査', () => {
    R.lotInputChecks.forEach((c) => checkEq(g, `A10 ロット ${c.name}`, V.checkLotInputs(c.input), c.output));
    R.alertInputChecks.forEach((c) => checkEq(g, `A10 アラート ${c.name}`, V.checkAlertPrice(c.input), c.output));
    R.atrInputChecks.forEach((c) => checkEq(g, `A10 ATR ${c.name}`, V.checkAtrInputs(c.input), c.output));
  });
  await safe(g, 'A11 sanitizeSettings', () => R.sanitizeSettings.forEach((c) => {
    const r = V.sanitizeSettings(JSON.parse(JSON.stringify(c.input)));
    checkEq(g, `A11 ${c.name} fixed`, r.fixed, c.fixed);
    checkEq(g, `A11 ${c.name} reset`, r.reset, c.reset);
    record(g, `A11 ${c.name} settings 全体`, deepEq(r.settings, c.settings), JSON.stringify(r.settings).slice(0, 200));
  }));
  await safe(g, 'A12 保存データの検査', () => {
    checkEq(g, 'A12 sanitizeCalendar', V.sanitizeCalendar(JSON.parse(JSON.stringify(R.sanitizeCalendar.input))), R.sanitizeCalendar.output);
    checkEq(g, 'A12 sanitizeCalendar（配列でない）', V.sanitizeCalendar(R.sanitizeCalendarNotArray.input), R.sanitizeCalendarNotArray.output);
    const sj = R.sanitizeJournal;
    checkEq(g, 'A12 sanitizeJournal', V.sanitizeJournal(JSON.parse(JSON.stringify(sj.input)), sj.nowMs, sj.defaultCurrency), sj.output);
    checkEq(g, 'A12 sanitizeAlerts', V.sanitizeAlerts(JSON.parse(JSON.stringify(R.sanitizeAlerts.input))), R.sanitizeAlerts.output);
  });
  await safe(g, 'A13 classifyResponse', () => R.classifyResponse.forEach((c) => checkEq(g, `A13 ${c.name}`, D.classifyResponse(c.source, c.status, c.body), c.output)));
  await safe(g, 'A14 checkInterval/backoff/isStale', () => {
    R.checkInterval.forEach((c) => checkEq(g, `A14 checkInterval ${c.name}`, D.checkInterval(c.times, c.sec), c.output));
    for (const k of ['ticker', 'spot']) R.backoff[k].forEach((c) => checkEq(g, `A14 backoff ${k} fails=${c.fails}`, D.backoff(c.base, c.fails, c.cap), c.output));
    R.stale.forEach((c) => checkEq(g, `A14 isStale ${c.name}`, D.isStale(c.lastOkMs, c.nowMs, c.limitSec), c.output));
  });
  await safe(g, 'A15 acceptResult/combine/alertGate', () => {
    R.acceptResult.forEach((c) => checkEq(g, `A15 acceptResult ${c.name}`, acceptResult(c.req, c.state, c.resultTf, c.aborted), c.output));
    R.combine.forEach((c) => checkEq(g, `A15 combine ${c.name}`, combine(c.a, c.b), c.output));
    R.alertGate.forEach((c) => checkEq(g, `A15 alertGate ${c.name}`, alertGate(c.prev, c.cur), c.output));
  });

  // ================= (B) 通信 =================
  g = 'B 通信';
  const timed = async (p) => { const t0 = performance.now(); try { await p; return { ok: true, ms: performance.now() - t0 }; } catch (e) { return { ok: false, kind: e.kind, ms: performance.now() - t0, e }; } };
  await safe(g, 'B-N1', async () => {
    const f = mockFetch([{ match: 'x', hang: 'body' }]);
    const r = await timed(D.fetchJson('https://x/', { fetchFn: f, timeoutMs: 300 }));
    record(g, 'B-N1 本文が止まる → 300ms で timeout（B4）', !r.ok && r.kind === 'timeout' && r.ms < 500, `${r.kind} ${Math.round(r.ms)}ms`);
  });
  await safe(g, 'B-N2', async () => {
    const r = await timed(D.fetchJson('https://x/', { fetchFn: mockFetch([{ match: 'x', delayMs: 1000, json: {} }]), timeoutMs: 300 }));
    record(g, 'B-N2 ヘッダーが来ない → timeout', !r.ok && r.kind === 'timeout' && r.ms < 500, `${r.kind} ${Math.round(r.ms)}ms`);
  });
  await safe(g, 'B-N3', async () => {
    const r = await timed(D.fetchJson('https://x/', { fetchFn: mockFetch([{ match: 'x', hang: 'headers', ignoreAbort: true }]), timeoutMs: 300 }));
    record(g, 'B-N3 abort を無視されても timeout（見張り）', !r.ok && r.kind === 'timeout' && r.ms < 500, `${r.kind} ${Math.round(r.ms)}ms`);
  });
  await safe(g, 'B-N4', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await timed(D.fetchJson('https://x/', { fetchFn: mockFetch([{ match: 'x', hang: 'body' }]), timeoutMs: 2000, signal: ac.signal }));
    record(g, 'B-N4 外から中断 → aborted（timeout ではない）', !r.ok && r.kind === 'aborted' && r.ms < 400, `${r.kind} ${Math.round(r.ms)}ms`);
  });
  const fcw = (f, st, extra = {}) => D.fetchCandlesWithFallback('1h', 60, { fetchFn: f, storage: st, now: Date.now(), timeouts: FAST, ...extra });
  await safe(g, 'B-N5', async () => {
    const f = mockFetch([{ match: 'binance', json: [] }, ...realRoutes()]);
    const r = await fcw(f, memStorage());
    record(g, 'B-N5 Binance 空配列 → OKX', r.source === 'okx' && r.attempts[0].kind === 'empty', JSON.stringify(r.attempts.map((a) => [a.source, a.kind])));
  });
  await safe(g, 'B-N6', async () => {
    const f = mockFetch([{ match: 'binance', status: 451 }, { match: 'okx', status: 500 }, { match: 'bybit', json: { retCode: 0, retMsg: 'OK', result: { list: [] } } }]);
    const r = await fcw(f, memStorage());
    const by = r.attempts.find((a) => a.source === 'bybit');
    record(g, 'B-N6 Bybit retCode0・list空 → 失敗扱い → デモ', by && by.kind === 'empty' && r.source === 'demo', JSON.stringify(r.attempts.map((a) => [a.source, a.kind])) + ' ' + r.source);
  });
  await safe(g, 'B-N7', async () => {
    const st = memStorage(), now = Date.now();
    await D.fetchCandlesWithFallback('1h', 60, { fetchFn: mockFetch([{ match: 'bybit', json: { retCode: 10006, retMsg: 'Too many visits!' } }]), storage: st, now, sourceMode: 'bybit', timeouts: FAST });
    const b = JSON.parse(st.getItem('ga:blockedSources') || '{}').bybit;
    record(g, 'B-N7 Bybit 10006 → ratelimit 5分', b && b.kind === 'ratelimit' && b.until - b.at === 300000, JSON.stringify(b));
  });
  await safe(g, 'B-N8', async () => {
    const st = memStorage(), now = Date.now();
    await D.fetchCandlesWithFallback('1h', 60, { fetchFn: mockFetch([{ match: 'bybit', status: 403 }]), storage: st, now, sourceMode: 'bybit', timeouts: FAST });
    const b = JSON.parse(st.getItem('ga:blockedSources') || '{}').bybit;
    record(g, 'B-N8 Bybit HTTP 403 → ratelimit 15分', b && b.kind === 'ratelimit' && b.until - b.at === 900000, JSON.stringify(b));
  });
  await safe(g, 'B-N9', async () => {
    const f = mockFetch([{ match: 'binance', json: () => binanceKlines(genBars(60, 14400, nowEnd(14400))) }, ...realRoutes()]);
    const r = await fcw(f, memStorage());
    record(g, 'B-N9 1h に 4h 間隔の足 → invalid → 次へ', r.attempts[0].kind === 'invalid' && r.source === 'okx', JSON.stringify(r.attempts.map((a) => [a.source, a.kind])));
  });
  await safe(g, 'B-N10', async () => {
    const f = mockFetch([{ match: 'binance', hang: 'headers' }, ...realRoutes()]);
    const r = await fcw(f, memStorage());
    const nb = f.calls.filter((c) => c.url.includes('binance')).length, no = f.calls.filter((c) => c.url.includes('okx')).length;
    record(g, 'B-N10 自動: Binance タイムアウトは1回だけ → OKX', nb === 1 && no >= 1 && r.source === 'okx' && r.attempts[0].kind === 'timeout', `binance ${nb} okx ${no}`);
  });
  await safe(g, 'B-N11', async () => {
    let n = 0;
    const f = mockFetch([{ match: 'binance', status: () => (++n <= 2 ? 502 : 200), json: () => binanceKlines(genBars(60, 3600, nowEnd(3600))) }]);
    const r = await fcw(f, memStorage(), { sourceMode: 'binance' });
    record(g, 'B-N11 固定: 502→502→成功（3回）', r.source === 'binance' && f.calls.length === 3, `${r.source} 呼び出し ${f.calls.length}`);
  });
  await safe(g, 'B-N12', async () => {
    const f = mockFetch([{ match: /./, delayMs: 2000, json: [] }]);
    const t0 = performance.now();
    const r = await fcw(f, memStorage(), { timeouts: { ...FAST, candles: 8000, total: 1000 } });
    const ms = performance.now() - t0;
    record(g, 'B-N12 全体の上限 1 秒 → 退避', ms < 1500 && r.source === 'demo', `${Math.round(ms)}ms ${r.source}`);
  });
  await safe(g, 'B-N13', async () => {
    const st = memStorage();
    const f = mockFetch([{ match: 'binance', delayMs: 1000, json: [] }, ...realRoutes()]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await timed(fcw(f, st, { signal: ac.signal }));
    record(g, 'B-N13 取得中に中断 → 次へ進まない・記録しない・退避しない', !r.ok && r.kind === 'aborted' && !f.calls.some((c) => c.url.includes('okx')) && st.length === 0, `${r.kind} calls=${f.calls.length} keys=${st.length}`);
  });
  await safe(g, 'B-N14', async () => {
    const ctrl = mkCtrl(mockFetch(realRoutes({ tickers: { binance: [0, 3870 * 1.06, 3871] } })));
    await ctrl.start();
    const before = ctrl.state.candles.at(-1).close;
    const r1 = await ctrl.tick(); const f1 = ctrl.state.tickFails;
    const r2 = await ctrl.tick(); const f2 = ctrl.state.tickFails;
    record(g, 'B-N14 価格0・6%離れ → 反映しない・fails+1', r1 === 'invalid' && r2 === 'invalid' && f1 === 1 && f2 === 2 && ctrl.state.candles.at(-1).close === before, `${r1} ${r2} ${f1} ${f2}`);
    const r3 = await ctrl.tick();
    record(g, 'B-N14 正常な値で fails が 0 に戻る', r3 === 'arm' && ctrl.state.tickFails === 0, `${r3} ${ctrl.state.tickFails}`);
  });

  // ================= (C) 状態遷移 =================
  g = 'C 状態遷移';
  await safe(g, 'C-S1', async () => {
    const f = mockFetch(realRoutes({ price: 3870 }));
    const ctrl = mkCtrl(f, { sourceMode: 'demo' });
    await ctrl.start(); await ctrl.tick(); await ctrl.getH1?.();
    const g0 = ctrl.state.gen;
    record(g, 'C-S1 前提: デモの ticker・prevPrice がある', ctrl.state.ticker && ctrl.state.prevPrice && ctrl.state.dailyTag.base === 'demo');
    await ctrl.setSourceMode('auto');
    const s = ctrl.state;
    record(g, 'C-S1 デモ→自動: candles・daily とも binance', s.tag.base === 'binance' && s.dailyTag && s.dailyTag.base === 'binance', `${s.tag.base} ${s.dailyTag && s.dailyTag.base}`);
    checkEq(g, 'C-S1 gen が 1 増える', s.gen, g0 + 1);
    record(g, 'C-S1 ticker・prevPrice・h1 は空', s.ticker === null && s.prevPrice === null && (s.h1 === null || s.h1.base === 'binance'));
    const P = P_of(ctrl.levelsInfo().daily);
    record(g, 'C-S1 前日ピボット P が 3870±100（B1 が直った）', Math.abs(P - 3870) < 100, `P=${P.toFixed(2)}`);
  });
  await safe(g, 'C-S2', async () => {
    const ctrl = mkCtrl(mockFetch(realRoutes({ price: 3870 })));
    await ctrl.start();
    await ctrl.setSourceMode('demo');
    const s = ctrl.state, P = P_of(ctrl.levelsInfo().daily);
    record(g, 'C-S2 自動→デモ: daily は demo', s.dailyTag && s.dailyTag.base === 'demo' && s.tag.base === 'demo');
    record(g, 'C-S2 P がデモの終値±100（実データの日足が残らない）', Math.abs(P - s.candles.at(-1).close) < 100, `P=${P.toFixed(2)} close=${s.candles.at(-1).close.toFixed(2)}`);
  });
  await safe(g, 'C-S3', async () => {
    const opt = { bin: { status: 200 } };
    const f = mockFetch(realRoutes(opt));
    const ctrl = mkCtrl(f);
    await ctrl.start(); await ctrl.tick();
    const g0 = ctrl.state.gen;
    opt.bin.status = 451;
    const n0 = f.calls.length;
    await ctrl.refresh();
    const s = ctrl.state;
    record(g, 'C-S3 451 で OKX へ（E4）: gen+1', s.tag.base === 'okx' && s.gen === g0 + 1, `${s.tag.base} gen ${s.gen}`);
    record(g, 'C-S3 OKX の 1Dutc の日足要求が出る', f.calls.slice(n0).some((c) => c.url.includes('okx') && c.url.includes('bar=1Dutc')) && s.dailyTag.base === 'okx');
    record(g, 'C-S3 ticker・prevPrice は null', s.ticker === null && s.prevPrice === null);
  });
  await safe(g, 'C-S4', async () => {
    const f = mockFetch(realRoutes());
    const ctrl = mkCtrl(f);
    await ctrl.start(); await ctrl.tick();
    const d0 = ctrl.state.daily, n1d = () => f.calls.filter((c) => c.url.includes('interval=1d')).length, c0 = n1d();
    await ctrl.setTf('4h');
    const s = ctrl.state;
    record(g, 'C-S4 時間足変更: 日足の要求が出ない（daily 保持）', n1d() === c0 && s.daily === d0);
    record(g, 'C-S4 prevPrice は null・candles.tag.tf=4h', s.prevPrice === null && s.tag.tf === '4h' && ivl(s.candles) === 14400);
  });
  await safe(g, 'C-S5', async () => {
    const ctrl = mkCtrl(mockFetch(realRoutes()));
    await ctrl.start();
    await ctrl.setTf('1d');
    record(g, 'C-S5 tf=1d: daily は candles と同じ（同じ印）', ctrl.state.daily === ctrl.state.candles && ctrl.state.dailyTag === ctrl.state.tag);
  });
  await safe(g, 'C-S6', async () => {
    const ctrl = mkCtrl(mockFetch(realRoutes({ bin: { tfStatus: { '1h': 500 } }, okx: { tfStatus: { '1d': 500 } } })));
    await ctrl.start();
    const lv = ctrl.levelsInfo();
    record(g, 'C-S6 OKX の足 × Binance の日足 → real-mixed', ctrl.state.tag.base === 'okx' && ctrl.state.dailyTag.base === 'binance' && lv.mode === 'real-mixed', `${lv.mode}`);
    record(g, 'C-S6 出典文に「チャートは」', lv.note.includes('チャートは'), lv.note);
  });
  await safe(g, 'C-S7', async () => {
    const ctrl = mkCtrl(mockFetch(realRoutes({ bin: { tfDelay: { '1d': 800 } } })));
    const p = ctrl.start();
    for (let k = 0; k < 50 && !ctrl.state.tag; k++) await wait(20);
    const p2 = ctrl.setSourceMode('demo');
    await Promise.all([p, p2]);
    await wait(900);
    const s = ctrl.state;
    const disc = s.log.find((r) => r.what === 'daily');
    record(g, 'C-S7 切替前の日足要求は捨てられ、daily は demo のまま', s.dailyTag && s.dailyTag.base === 'demo' && disc && ['aborted', 'stale-gen'].includes(disc.verdict), JSON.stringify(disc));
  });
  await safe(g, 'C-S8', async () => {
    const end = Math.floor(Date.UTC(2026, 10, 16, 12) / 1000);
    const ctrl = mkCtrl(mockFetch(realRoutes({ n: 60, endFor: (tf) => (tf === '5m' ? end : null), bin: { tfStatus: { '1d': 500 } }, okx: { tfStatus: { '1d': 500 } }, byb: { tfStatus: { '1d': 500 } } })), { tf: '5m' });
    await ctrl.start();
    const lv = ctrl.levelsInfo();
    record(g, 'C-S8 日足 reject・5分足が1日分 → 水準を出さない', lv.daily === null && lv.note === '日足を取得できないため水準を表示していません', lv.note);
  });
  await safe(g, 'C-S9', async () => {
    const f = mockFetch(realRoutes());
    const ctrl = mkCtrl(f, { sourceMode: 'demo', tf: '4h' });
    await ctrl.start();
    await ctrl.getH1();
    const n0 = f.calls.filter((c) => c.url.includes('interval=1h')).length;
    await ctrl.setSourceMode('auto');
    const n1 = f.calls.filter((c) => c.url.includes('interval=1h')).length;
    record(g, 'C-S9 統計を開いたまま demo→auto: h1 を取り直す（N8）', n1 > n0 && ctrl.state.h1 && ctrl.state.h1.base === 'binance', `${n0}→${n1}`);
  });
  await safe(g, 'C-S10', async () => {
    const f = mockFetch(realRoutes());
    const ctrl = mkCtrl(f);
    await ctrl.start();
    ctrl.state.preferred = 'okx';
    const g0 = ctrl.state.gen, n0 = f.calls.length;
    await ctrl.retry({ resetBlocked: true });
    const first = f.calls[n0];
    record(g, 'C-S10 再取得: gen+1・Binance から試す', ctrl.state.gen === g0 + 1 && first && first.url.includes('binance') && ctrl.state.tag.base === 'binance', first && first.url);
  });
  await safe(g, 'C-S11', async () => {
    const st = memStorage();
    const ctrl = mkCtrl(mockFetch(realRoutes()), { storage: st });
    await ctrl.start();
    const c0 = ctrl.state.candles, d0 = ctrl.state.daily, g0 = ctrl.state.gen;
    ctrl.clearCache();
    record(g, 'C-S11 キャッシュ消去: candles・daily・gen は変わらない', ctrl.state.candles === c0 && ctrl.state.daily === d0 && ctrl.state.gen === g0 && st.getItem('ga:cache:1h') === null);
  });
  await safe(g, 'C-S12', async () => {
    const now = Date.now();
    const rows = (sec, n) => genBars(n, sec, nowEnd(sec) - sec * 3).map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume]);
    const st = memStorage({ 'ga:cache:1h': { source: 'okx', fetchedAt: now - 600000, candles: rows(3600, 60) }, 'ga:cache:1d': { source: 'okx', fetchedAt: now - 600000, candles: rows(86400, 30) } });
    const ctrl = mkCtrl(mockFetch([]), { storage: st });
    await ctrl.start();
    const s = ctrl.state;
    record(g, 'C-S12 全部失敗 → キャッシュ（src=cache・base=okx）', s.tag.src === 'cache' && s.tag.base === 'okx', JSON.stringify(s.tag));
    record(g, 'C-S12 日足キャッシュの source が okx なので使う', s.dailyTag && s.dailyTag.src === 'cache' && s.dailyTag.base === 'okx');
    const st2 = memStorage({ 'ga:cache:1h': { source: 'okx', fetchedAt: now - 600000, candles: rows(3600, 60) }, 'ga:cache:1d': { source: 'binance', fetchedAt: now - 600000, candles: rows(86400, 30) } });
    const c2 = mkCtrl(mockFetch([]), { storage: st2 });
    await c2.start();
    record(g, 'C-S12 日足キャッシュの source が違えば使わない', c2.state.dailyTag === null && c2.levelsInfo().mode !== 'same');
  });

  // ================= (D) 取得中の操作 =================
  g = 'D 取得中の操作';
  await safe(g, 'D-R1', async () => {
    const f = mockFetch(realRoutes({ bin: { tfDelay: { '4h': 500, '1d': 50 } } }));
    const ctrl = mkCtrl(f);
    await ctrl.start();
    const a = ctrl.setTf('4h'), b = ctrl.setTf('1d');
    await Promise.all([a, b]);
    const s = ctrl.state;
    const req4h = f.calls.find((c) => c.url.includes('interval=4h'));
    record(g, 'D-R1 4h→すぐ1d: 表示は 1d（間隔 86400）', s.tf === '1d' && s.tag.tf === '1d' && ivl(s.candles) === 86400);
    record(g, 'D-R1 4h の要求は中断された', req4h && req4h.signal.aborted);
    record(g, 'D-R1 daily に 4h の足が入らない（B2 が直った）', ivl(s.daily) === 86400 && s.daily === s.candles);
  });
  await safe(g, 'D-R2', async () => {
    const f = mockFetch(realRoutes({ bin: { tfDelay: { '1d': 500, '4h': 50 } } }));
    const ctrl = mkCtrl(f);
    await ctrl.start();
    const ps = [ctrl.setTf('1d'), ctrl.setTf('4h'), ctrl.setTf('1d')];
    const rs = await Promise.all(ps);
    record(g, 'D-R2 1d→4h→1d: 表示は 1d・途中は捨てる', ctrl.state.tag.tf === '1d' && ivl(ctrl.state.candles) === 86400 && rs[0] !== 'apply' && rs[1] !== 'apply' && rs[2] === 'apply', JSON.stringify(rs));
  });
  await safe(g, 'D-R3', async () => {
    const st = memStorage();
    const f = mockFetch(realRoutes({ bin: { delay: 2000 } }));
    const ctrl = mkCtrl(f, { storage: st, timeouts: { ...FAST, candles: 5000 } });
    const t0 = performance.now();
    const p = ctrl.start();
    await wait(50);
    await ctrl.setSourceMode('demo');
    const ms = performance.now() - t0;
    await p;
    record(g, 'D-R3 取得中にデモへ: すぐ demo（N2）', ctrl.state.tag.base === 'demo' && ms < 800, `${Math.round(ms)}ms`);
    record(g, 'D-R3 blockedSources・キャッシュは書かれない', st.getItem('ga:blockedSources') === null && st.getItem('ga:cache:1h') === null);
  });
  await safe(g, 'D-R4', async () => {
    const f = mockFetch(realRoutes({ bin: { delay: 300 } }));
    const ctrl = mkCtrl(f);
    const p = ctrl.start();
    await wait(30);
    const n0 = f.calls.length;
    const r = await ctrl.refresh();
    record(g, 'D-R4 取得中の定期更新は合流（fetch が増えない）', r === 'joined' && f.calls.length === n0, `${r} ${n0}→${f.calls.length}`);
    await p;
  });
  await safe(g, 'D-R5', async () => {
    const f = mockFetch(realRoutes({ bin: { delay: 300 } }));
    const ctrl = mkCtrl(f);
    const p = ctrl.start();
    await wait(30);
    const first = f.calls.find((c) => c.url.includes('klines'));
    const n0 = f.calls.filter((c) => c.url.includes('klines')).length;
    const p2 = ctrl.retry();
    await wait(10);
    const n1 = f.calls.filter((c) => c.url.includes('klines')).length;
    const rs = await Promise.all([p, p2]);
    record(g, 'D-R5 取得中の再取得: 中断して出し直す', first.signal.aborted && n1 === n0 + 1 && rs[0] === 'aborted' && rs[1] === 'apply', `${JSON.stringify(rs)} ${n0}→${n1}`);
  });
  await safe(g, 'D-R6', async () => {
    const opt = { hang: true };
    const routes = realRoutes();
    routes.unshift({ match: 'fapi.binance.com/fapi/v1/klines', hang: 'headers', ignoreAbort: true });
    const f = mockFetch(routes);
    const ctrl = mkCtrl(f, { timeouts: { ...FAST, candles: 5000, perSource: 6000, total: 8000, watchdogCandles: 1000 } });
    ctrl.start();
    await wait(1300);
    const s = ctrl.state;
    record(g, 'D-R6 見張り 1 秒: inflight.candles が null・attempts に watchdog', s.inflight.candles === null && s.attempts.some((a) => a.kind === 'watchdog') && s.banner, JSON.stringify(s.attempts.map((a) => a.kind)));
    routes.shift(); opt.hang = false;
    const n0 = f.calls.length;
    const r = await ctrl.refresh();
    record(g, 'D-R6 その後の refresh で新しい要求が出る', f.calls.length > n0 && r === 'apply' && s.tag && s.banner === null, r);
  });
  await safe(g, 'D-R7', async () => {
    const ctrl = mkCtrl(mockFetch(realRoutes({ binTick: { delay: 300 } })));
    await ctrl.start();
    const pt = ctrl.tick();
    await wait(20);
    await ctrl.setSourceMode('demo');
    const lastBefore = ctrl.state.candles.at(-1).close;
    const r = await pt;
    record(g, 'D-R7 遅れて返ったティックは捨てる（N4）', r === 'discard' && ctrl.state.candles.at(-1).close === lastBefore && ctrl.state.ticker === null, r);
  });
  await safe(g, 'D-R8', async () => {
    const routes = realRoutes();
    let n = 0;
    routes.unshift({ match: 'fapi.binance.com/fapi/v1/klines', ignoreAbort: true, delayMs: () => (++n === 1 ? 300 : 800), json: (u) => binanceKlines(genBars(120, 3600, nowEnd(3600))) });
    const ctrl = mkCtrl(mockFetch(routes), { timeouts: { ...FAST, candles: 3000 } });
    const pA = ctrl.start();
    await wait(30);
    const pB = ctrl.retry();
    await wait(30);
    const reqB = ctrl.state.inflight.candles;
    await pA; // 古い要求の finally が走る
    await wait(400);
    record(g, 'D-R8 古い要求の finally は新しい要求の「取得中」を消さない（R7）', reqB && ctrl.state.inflight.candles === reqB);
    await pB;
  });

  // ================= (E) アラート =================
  g = 'E アラート';
  const demoAt = (p) => (tf, { nowSec, limit }) => genBars(Math.min(limit, 120), SEC[tf], Math.floor(nowSec / SEC[tf]) * SEC[tf], p, 2);
  await safe(g, 'E-A1', async () => {
    const st = memStorage({ 'ga:alerts': [{ id: 'a1', price: 3830, direction: 'above', enabled: true }] });
    const ctrl = mkCtrl(mockFetch(realRoutes({ price: 3873, tickers: { binance: [3873, 3874] } })), { storage: st, sourceMode: 'demo', demoFn: demoAt(3782), demoTickFn: () => 3782 });
    await ctrl.start(); await ctrl.tick(); await ctrl.tick();
    await ctrl.setSourceMode('auto');
    const g1 = await ctrl.tick(), g2 = await ctrl.tick();
    const a = JSON.parse(st.getItem('ga:alerts'))[0];
    record(g, 'E-A1 デモ3782→実データ3873: 1回目 arm・2回目も発火しない（B3 が直った）', g1 === 'arm' && g2 === 'judge' && a.enabled === true, `${g1} ${g2} enabled=${a.enabled}`);
  });
  await safe(g, 'E-A2', async () => {
    const st = memStorage({ 'ga:alerts': [{ id: 'a1', price: 3830, direction: 'above', enabled: true }] });
    const fired = [];
    const ctrl = mkCtrl(mockFetch(realRoutes({ price: 3828, tickers: { binance: [3825, 3831, 3835, 3829, 3832] } })), { storage: st });
    ctrl.on((type, d) => { if (type === 'tick') fired.push(...d.fired); });
    await ctrl.start();
    for (let k = 0; k < 5; k++) await ctrl.tick();
    const a = JSON.parse(st.getItem('ga:alerts'))[0];
    record(g, 'E-A2 3825→3831 で 1 回だけ発火し enabled=false', fired.length === 1 && a.enabled === false, `fired ${fired.length}`);
  });
  await safe(g, 'E-A3', async () => {
    const st = memStorage({ 'ga:alerts': [{ id: 'a1', price: 3990, direction: 'above', enabled: true }] });
    const ctrl = mkCtrl(mockFetch(realRoutes({ price: 3870, tickers: { binance: [3870, 4000, 4001] } })), { storage: st });
    await ctrl.start();
    const r = [await ctrl.tick(), await ctrl.tick()];
    const prevAfterJump = ctrl.state.prevPrice.price;
    r.push(await ctrl.tick());
    const a = JSON.parse(st.getItem('ga:alerts'))[0];
    record(g, 'E-A3 3870→4000（3%超）は jump で判定しない・次は 4000 から判定', JSON.stringify(r) === JSON.stringify(['arm', 'jump', 'judge']) && prevAfterJump === 4000 && a.enabled === true, JSON.stringify(r));
  });
  await safe(g, 'E-A4', async () => {
    const opt = { bin: { status: 200 } };
    const ctrl = mkCtrl(mockFetch(realRoutes(opt)));
    await ctrl.start(); await ctrl.tick(); await ctrl.tick();
    opt.bin.status = 451;
    await ctrl.refresh();
    const r = await ctrl.tick();
    record(g, 'E-A4 自動切替 Binance→OKX の後の 1 回目は arm', ctrl.state.tag.base === 'okx' && r === 'arm', `${ctrl.state.tag.base} ${r}`);
  });
  await safe(g, 'E-A5', async () => {
    let clock = Date.now();
    const ctrl = mkCtrl(mockFetch(realRoutes()), { now: () => clock });
    await ctrl.start(); await ctrl.tick(); await ctrl.tick();
    clock += 11 * 60 * 1000;
    const rs = await ctrl.onVisible();
    record(g, 'E-A5 11分隠して戻す → 最初のティックは arm', rs.includes('arm'), JSON.stringify(rs));
  });
  await safe(g, 'E-A6', async () => {
    const ctrl = mkCtrl(mockFetch(realRoutes()));
    const evs = [];
    ctrl.on((type, d) => { if (type === 'candles') evs.push(d.recordOnly); });
    await ctrl.start();
    await ctrl.setTf('4h');
    const afterTf = evs.at(-1);
    await ctrl.refresh(); // 時間足は 4h のまま（最後の定期更新から時間が経っていなくても refresh は取得する）
    record(g, 'E-A6 時間足変更直後は記録のみ・次の更新から通知', afterTf === true && evs.at(-1) === false, JSON.stringify(evs));
    // RSI が直近の確定足で 70 を上抜けるデータ
    const base = genBars(80, 3600, 1794834000, 3800, 0);
    const c = base.map((x, k) => { const p = k < 60 ? 3800 - k * 2 : 3680 + (k - 60) * 15; return { ...x, open: p - 1, close: p, high: p + 2, low: p - 3 }; });
    const r = I.rsi(c, 14);
    const k = I.crossings(r, 70).find((x) => x.type === 'up' && x.index >= 59);
    const sub = c.slice(0, k.index + 2);
    const ev = S.indicatorEvents(sub, { rsi: true }, {});
    record(g, 'E-A6 indicatorEvents: 直近の確定足の RSI 70 上抜けを検出', ev.some((e) => e.key === 'rsi70up'), JSON.stringify(ev));
  });
  await safe(g, 'E-A7', async () => {
    const st = memStorage({ 'ga:alerts': [{ id: 'a1', price: 3790, direction: 'above', enabled: true }] });
    const seq = [3782, 3795];
    const fired = [];
    const ctrl = mkCtrl(mockFetch([]), { storage: st, sourceMode: 'demo', demoFn: demoAt(3785), demoTickFn: () => seq.shift() ?? 3795 });
    ctrl.on((type, d) => { if (type === 'tick') fired.push(...d.fired); });
    await ctrl.start(); await ctrl.tick(); await ctrl.tick();
    record(g, 'E-A7 デモでの発火は題が【デモ】で始まる', fired.length === 1 && fired[0].title.startsWith('【デモ】'), fired[0] && fired[0].title);
  });

  // ================= (F) 保存データ・インポート =================
  g = 'F 保存データ';
  const NOWMS = Date.now();
  await safe(g, 'F-S1', () => {
    const st = memStorage({ 'ga:calendar': [{ id: 'x', time: NOWMS + 86400000, name: 'CPI', imp: 5 }] });
    const r = store.sanitizeAll(st, NOWMS);
    const cal = JSON.parse(st.getItem('ga:calendar'));
    record(g, 'F-S1 imp:5 → imp=2 に直して起動を続ける（N1）', cal[0].imp === 2 && V.impStars(5) === '★★☆' && store.reportText(r.report).includes('予定 1 件を修正'), store.reportText(r.report));
  });
  await safe(g, 'F-S2', () => {
    const st = memStorage({ 'ga:journal': [{ id: 'bad', time: 'abc', side: 'buy', pnl: 1 }, { id: 'ok', time: NOWMS - 1000, side: 'sell', pnl: -5 }] });
    store.sanitizeAll(st, NOWMS);
    const j = JSON.parse(st.getItem('ga:journal'));
    record(g, 'F-S2 time:"abc" の記録だけ除外', j.length === 1 && j[0].id === 'ok');
  });
  await safe(g, 'F-S3', () => {
    const st = memStorage({ 'ga:settings': '{' });
    const r = store.sanitizeAll(st, NOWMS);
    record(g, 'F-S3 壊れた JSON → 既定の設定・キーを書き直す', deepEq(r.settings, V.defaultSettings()) && deepEq(JSON.parse(st.getItem('ga:settings')), V.defaultSettings()));
  });
  await safe(g, 'F-S4', () => {
    const st = memStorage({ 'ga:cache:1h': { source: 'x' } });
    store.sanitizeAll(st, NOWMS);
    record(g, 'F-S4 形の違うキャッシュは消す', st.getItem('ga:cache:1h') === null);
  });
  await safe(g, 'F-S5', () => {
    const st = memStorage({ 'ga:blockedSources': { binance: { at: NOWMS, until: NOWMS + 365 * 86400000, status: 451, kind: 'blocked' }, okx: { at: NOWMS, until: NOWMS + 300000, status: 429, kind: 'ratelimit' } } });
    store.sanitizeAll(st, NOWMS);
    const b = JSON.parse(st.getItem('ga:blockedSources'));
    record(g, 'F-S5 until が 1 年後の記録は捨てる', !b.binance && b.okx && b.okx.kind === 'ratelimit');
  });
  await safe(g, 'F-S6', () => {
    const st = memStorage();
    let e1 = null, e2 = null;
    try { store.importData({ app: 'other', version: 1 }, { storage: st }); } catch (e) { e1 = e.message; }
    try { store.importData({ app: 'gold-analysis', version: 2 }, { storage: st }); } catch (e) { e2 = e.message; }
    record(g, 'F-S6 app 違い・version 2 は取り込まない', !!e1 && !!e2 && st.length === 0, `${e1} / ${e2}`);
  });
  await safe(g, 'F-S7', () => {
    const st = memStorage();
    const r = store.importData({ app: 'gold-analysis', version: 1, alerts: R.sanitizeAlerts.input, settings: { leverage: 0 } }, { storage: st });
    const al = JSON.parse(st.getItem('ga:alerts')), s = JSON.parse(st.getItem('ga:settings') || 'null') || V.defaultSettings(); // leverage:0 は無視され設定は書き換わらない（R3-1）
    record(g, 'F-S7 アラート 3 件・leverage 25・「除外 3 件」', al.length === 3 && s.leverage === 25 && r.summary.includes('除外 3 件'), r.summary);
  });
  await safe(g, 'F-S8', () => {
    const host = document.createElement('div'); host.id = 'fs8host'; document.body.appendChild(host);
    const order = [];
    const ok1 = safeInit('alerts', () => { order.push('alerts'); throw new Error('boom'); }, '#fs8host');
    const ok2 = safeInit('journal', () => { order.push('journal'); });
    record(g, 'F-S8 initAlerts が例外でもほかは動き「表示できません」を出す', ok1 === false && ok2 === true && order.join() === 'alerts,journal' && host.textContent.includes('この部分を表示できません'));
    host.remove();
  });

  // ================= (G) 3回目の修正の回帰テスト =================
  g = 'G 3回目';
  await safe(g, 'N9 VERSION', async () => {
    const sw = await (await fetch('./sw.js', { cache: 'no-store' })).text();
    const ver = (/const VERSION = '([^']*)';/.exec(sw) || [])[1];
    const assets = [...(/const ASSETS = \[([\s\S]*?)\];/.exec(sw) || [])[1].matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean).sort();
    const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    let s = '';
    for (const rel of assets) s += `${rel}\n${hex(await crypto.subtle.digest('SHA-256', await (await fetch('./' + rel, { cache: 'no-store' })).arrayBuffer()))}\n`;
    const want = 'gold-' + hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).slice(0, 12);
    record(g, 'N9 sw.js の VERSION が ASSETS の中身のハッシュと一致（上げ忘れなし）', ver === want, `sw.js=${ver} / 計算=${want}（python tools/update_sw_version.py を実行）`);
    record(g, 'N9 SW はインストール時以外にキャッシュへ書かない（HTML と JS/CSS が同じ版）', !sw.includes('cache.put') && sw.includes('addAll') && sw.includes('cache.match(key'));
    record(g, 'N9 テスト用ファイルは事前キャッシュしない', !assets.some((a) => a.startsWith('tests') || a.includes('/tests') || a === 'expected_values.json'));
    record(g, 'N9 index.html と全 JS・CSS が ASSETS に入っている', ['index.html', 'css/style.css', 'js/app.js', 'js/controller.js', 'js/validate.js', 'vendor/lightweight-charts.standalone.production.js'].every((a) => assets.includes(a)));
  });
  const J0 = [{ id: 'j1', time: NOWMS - 3 * 86400000, side: 'buy', pnl: 100, entry: null, exit: null, lots: null, currency: 'JPY', memo: '' },
    { id: 'j2', time: NOWMS - 2 * 86400000, side: 'sell', pnl: -50, entry: null, exit: null, lots: null, currency: 'JPY', memo: '' }];
  await safe(g, 'R2-2 壊れた日記で消えない', () => {
    const st = memStorage({ 'ga:journal': J0 });
    const plan = store.planImport({ app: 'gold-analysis', version: 1, journal: [{ time: 'x' }, 'bad'] }, { storage: st, nowMs: NOWMS });
    const row = plan.rows.find((r) => r.field === 'journal');
    record(g, 'R2-2 計画だけでは何も書かない', st.getItem('ga:settings') === null && JSON.parse(st.getItem('ga:journal')).length === 2);
    store.applyImport(plan, { storage: st, nowMs: NOWMS });
    record(g, 'R2-2 取り込める項目が 0 件の日記は書き換えない', row.write === false && JSON.parse(st.getItem('ga:journal')).length === 2, store.describePlan(plan).join(' / '));
  });
  await safe(g, 'R2-2 件数の差分と追加', () => {
    const st = memStorage({ 'ga:journal': J0 });
    const file = { app: 'gold-analysis', version: 1, journal: [J0[1], { id: 'other-id', ...J0[0], memo: '' }, { id: 'j9', time: NOWMS - 86400000, side: 'buy', pnl: 30 }] };
    file.journal[1].id = 'other-id';
    const rep = store.planImport(file, { storage: st, nowMs: NOWMS, mode: 'replace' }).rows[0];
    const mer = store.planImport(file, { storage: st, nowMs: NOWMS, mode: 'merge' }).rows[0];
    record(g, 'R2-2 置き換え: 今 2 件 → 3 件', rep.current === 2 && rep.after === 3 && rep.write);
    record(g, 'R2-2 追加: id 重複・中身重複を除き 1 件だけ足す（2→3）', mer.added === 1 && mer.dup === 2 && mer.after === 3, JSON.stringify({ added: mer.added, dup: mer.dup, after: mer.after }));
    const lines = store.describePlan(store.planImport(file, { storage: st, nowMs: NOWMS, mode: 'merge' }));
    record(g, 'R2-2 確認文に「今 2 件 → 3 件」', lines.some((l) => l.includes('日記: 今 2 件 → 3 件')), lines.join(' / '));
  });
  await safe(g, 'R2-2 バックアップと 1 回だけ元に戻す', () => {
    const st = memStorage({ 'ga:journal': J0, 'ga:alerts': [{ id: 'a', price: 3900, direction: 'above', enabled: true }] });
    const before = { j: st.getItem('ga:journal'), a: st.getItem('ga:alerts'), s: st.getItem('ga:settings') };
    store.importData({ app: 'gold-analysis', version: 1, journal: [{ id: 'n', time: NOWMS - 1000, side: 'buy', pnl: 1 }], alerts: [], settings: { leverage: 10 } }, { storage: st, nowMs: NOWMS });
    const changed = JSON.parse(st.getItem('ga:journal')).length === 1 && JSON.parse(st.getItem('ga:settings')).leverage === 10;
    record(g, 'R2-2 取り込み後にバックアップがある', changed && !!store.backupInfo(st));
    const ok1 = store.restoreBackup(st);
    record(g, 'R2-2 元に戻すと取り込み前と同じ（設定が無かったことも戻る）', ok1 && st.getItem('ga:journal') === before.j && st.getItem('ga:alerts') === before.a && st.getItem('ga:settings') === before.s);
    record(g, 'R2-2 戻せるのは 1 回だけ', store.restoreBackup(st) === false && store.backupInfo(st) === null);
  });
  await safe(g, 'N10 MTF の中断', async () => {
    const f = mockFetch(realRoutes({ bin: { tfDelay: { '4h': 800 } } }));
    const ctrl = mkCtrl(f, { timeouts: { ...FAST, candles: 3000 } });
    await ctrl.start();
    const p = ctrl.getMtf('4h');
    await wait(30);
    const call = f.calls.find((c) => c.url.includes('interval=4h'));
    await ctrl.setSourceMode('demo');
    const r = await p;
    record(g, 'N10 データ元を変えると取得中の MTF も中断される', call && call.signal.aborted && r === null && ctrl.state.mtfReqs.size === 0);
  });
  await safe(g, 'N11 h1 の取得は合流する', async () => {
    const f = mockFetch(realRoutes({ bin: { tfDelay: { '1h': 200 } } }));
    const ctrl = mkCtrl(f, { tf: '4h', timeouts: { ...FAST, candles: 3000 } });
    await ctrl.start();
    const n0 = f.calls.filter((c) => c.url.includes('interval=1h')).length;
    const [a, b, c] = await Promise.all([ctrl.getH1(), ctrl.getH1(), ctrl.getH1()]);
    const n1 = f.calls.filter((x) => x.url.includes('interval=1h')).length;
    record(g, 'N11 同時に 3 回呼んでも 1 時間足の取得は 1 回', n1 - n0 === 1 && a && a === b && b === c, `${n0}→${n1}`);
    await ctrl.getH1();
    record(g, 'N11 取得後はキャッシュを使う（通信しない）', f.calls.filter((x) => x.url.includes('interval=1h')).length === n1);
  });

  // ================= (H) 3回目の修正の検証で見つかったバグの回帰テスト =================
  g = 'H R3';
  const mySettings = () => { const s = V.defaultSettings(); s.balance = 3000000; s.riskPercent = 1.5; s.theme = 'light'; return s; };
  await safe(g, 'R3-1 設定を含まないファイル', () => {
    for (const mode of ['replace', 'merge']) {
      const st = memStorage({ 'ga:settings': mySettings(), 'ga:journal': J0 });
      const before = st.getItem('ga:settings');
      const plan = store.planImport({ app: 'gold-analysis', version: 1, journal: [] }, { storage: st, nowMs: NOWMS, mode });
      const lines = store.describePlan(plan);
      const r = store.applyImport(plan, { storage: st, nowMs: NOWMS });
      record(g, `R3-1 ${mode}: settings が無いファイルでは設定を変えない`, st.getItem('ga:settings') === before && JSON.parse(st.getItem('ga:settings')).balance === 3000000);
      record(g, `R3-1 ${mode}: 確認文が「設定: ファイルに無いため変更しません」`, lines[0] === '設定: ファイルに無いため変更しません', lines.join(' / '));
      record(g, `R3-1 ${mode}: 何も変わらないので書き込みもバックアップもしない`, r.changed === false && store.backupInfo(st) === null && JSON.parse(st.getItem('ga:journal')).length === 2);
    }
  });
  await safe(g, 'R3-1 ファイルにある項目だけ反映', () => {
    const st = memStorage({ 'ga:settings': mySettings() });
    const plan = store.planImport({ app: 'gold-analysis', version: 1, settings: { riskPercent: 2, leverage: 0, unknown: 1 } }, { storage: st, nowMs: NOWMS });
    checkEq(g, 'R3-1 変わる項目は riskPercent だけ', plan.settingsChanged, ['riskPercent']);
    checkEq(g, 'R3-1 範囲外の leverage は無視（今の値のまま）', plan.settingsRejected, ['leverage']);
    store.applyImport(plan, { storage: st, nowMs: NOWMS });
    const s = JSON.parse(st.getItem('ga:settings'));
    record(g, 'R3-1 残高・テーマ・レバレッジは今の値のまま、riskPercent だけ 2', s.riskPercent === 2 && s.balance === 3000000 && s.theme === 'light' && s.leverage === 25);
    const line = store.describePlan(plan)[0];
    record(g, 'R3-1 確認文の件数が実際の変更と一致（1 項目を変更・無視 1 項目）', line.startsWith('設定: 1 項目を変更') && line.includes('無視 1 項目'), line);
    const m = V.mergeSettings(mySettings(), { params: { emaFast: 60 } });
    record(g, 'R3-1 項目どうしの条件が破れる値は今の値に戻す', m.settings.params.emaFast === 20 && m.changed.length === 0 && m.rejected.length === 0 && m.conflicts[0].paths.includes('params.emaFast'), JSON.stringify(m.conflicts));
  });
  await safe(g, 'R3-2 2 回目のインポート', () => {
    const st = memStorage({ 'ga:settings': mySettings(), 'ga:journal': J0 });
    const file = { app: 'gold-analysis', version: 1, journal: [{ id: 'n1', time: NOWMS - 1000, side: 'buy', pnl: 5 }] };
    const r1 = store.importData(file, { storage: st, nowMs: NOWMS, mode: 'merge' });
    const b1 = st.getItem('ga:importBackup');
    const p2 = store.planImport(file, { storage: st, nowMs: NOWMS + 5000, mode: 'merge' });
    const r2 = store.applyImport(p2, { storage: st, nowMs: NOWMS + 5000 });
    record(g, 'R3-2 2 回目（追加 0 件）は何も変えず、バックアップも上書きしない', r1.changed && !p2.changes && r2.changed === false && st.getItem('ga:importBackup') === b1, store.describePlan(p2).join(' / '));
    store.restoreBackup(st);
    record(g, 'R3-2 最初の状態（日記 2 件・残高 3,000,000）に戻せる', JSON.parse(st.getItem('ga:journal')).length === 2 && JSON.parse(st.getItem('ga:settings')).balance === 3000000);
    const st2 = memStorage({ 'ga:journal': J0 });
    const same = store.planImport({ app: 'gold-analysis', version: 1, journal: J0 }, { storage: st2, nowMs: NOWMS, mode: 'replace' });
    record(g, 'R3-2 置き換えでも中身が同じなら変更なし', !same.changes && same.rows[0].reason === 'same');
  });

  // ================= (I) 5回目の修正の回帰テスト =================
  g = 'I 5回目';
  await safe(g, 'R4-1 理由を分ける', () => {
    const st = memStorage({ 'ga:settings': mySettings() });
    const plan = store.planImport({ app: 'gold-analysis', version: 1, settings: { params: { emaFast: 60 }, leverage: 0 } }, { storage: st, nowMs: NOWMS });
    const line = store.describePlan(plan)[0];
    record(g, 'R4-1 範囲外（leverage）と項目どうしの条件（emaFast）を別々に数える', plan.settingsRejected.join() === 'leverage' && plan.settingsConflicts.length === 1 && plan.settingsConflicts[0].paths.join() === 'params.emaFast', JSON.stringify(plan.settingsConflicts));
    record(g, 'R4-1 確認文に条件の理由「短期 EMA は長期 EMA より小さく」', line.includes('範囲外・型違いで無視 1 項目') && line.includes('項目どうしの条件で取り込まず: 短期 EMA は長期 EMA より小さくしてください'), line);
    const only = store.describePlan(store.planImport({ app: 'gold-analysis', version: 1, settings: { params: { emaFast: 60 } } }, { storage: st, nowMs: NOWMS }))[0];
    record(g, 'R4-1 条件だけのときは「範囲外」と出さない', !only.includes('範囲外') && only.includes('短期 EMA'), only);
  });
  await safe(g, 'N12 チャートの足は分析と同じ配列', () => {
    const a = genBars(500, 3600, 1794830400), sameLast = a.map((x) => ({ ...x })); sameLast[499].close += 1;
    const appended = genBars(500, 3600, 1794834000);
    checkEq(g, 'N12 同じ並びで最終足だけ変化 → update', planChartUpdate(a, sameLast).mode, 'update');
    checkEq(g, 'N12 新しい足 → reset（全系列 setData・作り直さない）', planChartUpdate(a, appended).mode, 'reset');
    checkEq(g, 'N12 つながらない → rebuild', planChartUpdate(a, genBars(500, 3600, 1794834000 + 3600 * 600)).mode, 'rebuild');
    // ChartView.update の後の本数・時刻が新しい配列と一致（ライブラリ無しで系列を模擬）
    const cv = new ChartView(null, null, null);
    const s = { n: 0, setData() { this.n++; }, update() {} };
    Object.assign(cv, { candles: a.map((x) => ({ ...x })), regs: [{ s, points: (cs) => cs.map((c) => ({ time: c.time, value: c.close })), mode: 'update' }], main: null, markersApi: null, drawLevels() {}, model: { tf: '1h' } });
    cv.update({ tf: '1h', settings: {} }, appended);
    record(g, 'N12 差分更新の後もチャートの足は 500 本で、分析と同じ時刻', cv.candles.length === 500 && cv.candles[0].time === appended[0].time && cv.candles[499].time === appended[499].time && s.n === 1);
  });
  await safe(g, 'R2-1 古いチャートに書かない', () => {
    const cv = new ChartView(null, null, null);
    let calls = 0;
    const bars = genBars(10, 3600, 1794834000);
    Object.assign(cv, { candles: bars.map((x) => ({ ...x })), main: { update() { calls++; } }, model: { tf: '1h' }, viewKey: '1h|binance:binance:1', chartType: 'candle', toBar: (x) => x });
    const last = { ...bars[9], close: bars[9].close * 1.12 };
    const r1 = cv.updateLast(last, 'demo:demo:2');
    record(g, 'R2-1 データ元（tagKey）が違うティックはチャートに書かない', r1 === false && calls === 0 && cv.candles[9].close === bars[9].close);
    cv.updateLast({ ...bars[9], close: bars[9].close + 1 }, 'binance:binance:1');
    record(g, 'R2-1 同じデータ元なら最終足を更新する', calls === 1 && cv.candles[9].close === bars[9].close + 1);
  });
}
