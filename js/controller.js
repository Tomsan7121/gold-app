// データ管理（controller）。状態の変更はここだけで行う（02_analysis.md 13-1〜13-4）。
// 画面の部品は getState() と各メソッドの結果を読むだけ。fetch・storage・時計は差し替え可能（tests.html 用）。
import * as D from './data.js';
import * as I from './indicators.js';
import * as T from './trade.js';

export const REFRESH_SEC = { '1m': 30, '5m': 30, '15m': 60, '30m': 60, '1h': 120, '4h': 120, '1d': 300, '1w': 300 };

// ---------------- 純粋関数（期待値: round2.acceptResult / combine / alertGate） ----------------
export function acceptResult(req, st, resultTf, aborted = false) {
  if (aborted) return 'aborted';
  if (req.seq !== st.latestSeq) return 'stale-seq';
  if (req.gen !== st.gen) return 'stale-gen';
  if (resultTf !== st.tf || req.tf !== st.tf) return 'tf-mismatch';
  return 'apply';
}
export function combine(a, b) {
  if (!a || !b) return 'reject';
  if (a.gen !== b.gen) return 'reject';
  if (a.family !== b.family) return 'reject';
  if (a.base === b.base) return 'same';
  return a.family === 'real' ? 'real-mixed' : 'reject';
}
export function alertGate(prev, cur) {
  if (!cur || cur.kind === 'cache') return 'skip';
  if (!prev) return 'arm';
  if (prev.gen !== cur.gen || prev.base !== cur.base || prev.kind !== cur.kind) return 'arm';
  if (Math.abs(cur.price - prev.price) / prev.price > 0.03) return 'jump';
  return 'judge';
}
export function makeTag(src, cachedSource, tf, gen, fetchedAt) {
  const base = src === 'cache' ? cachedSource : src;
  return { src, base, family: base === 'demo' ? 'demo' : 'real', tf, gen, fetchedAt };
}
const fmt2 = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function alertTitle(a, cur) {
  return `${cur && cur.base === 'demo' ? '【デモ】' : ''}価格アラート: ${fmt2(a.price)} を${a.direction === 'above' ? '上抜け' : '下抜け'}`;
}

const KINDS = ['candles', 'daily', 'ticker', 'h1', 'mtf'];

export function createDataController(options = {}) {
  const o = {
    fetchFn: (url, init) => globalThis.fetch(url, init), // 呼ぶ時点の fetch を使う（検証で差し替えられるように）
    storage: (() => { try { return globalThis.localStorage; } catch { return null; } })(),
    now: () => Date.now(), timeouts: {}, getApiKey: () => '',
    tf: '1h', sourceMode: 'auto', limit: 500, dailyLimit: 400, h1Limit: 1000,
    demoFn: D.demoCandles, demoTickFn: null, random: Math.random,
    ...options,
  };
  const TO = { ...D.DEFAULT_TIMEOUTS, ...o.timeouts };
  const listeners = new Set();
  const st = {
    gen: 0, tf: o.tf, sourceMode: o.sourceMode,
    candles: [], tag: null, lastSrc: null, attempts: [], cacheAgeMin: null,
    daily: [], dailyTag: null, dailyAttempts: [], dailyFetchedAt: 0,
    ticker: null, prevPrice: null, h1: null, h1Wanted: false, h1Promise: null, mtf: new Map(), mtfReqs: new Set(),
    lastApplyAt: null, lastTickOkAt: null, tickFails: 0, tickPausedUntil: 0,
    preferred: null, lastFullChain: 0, banner: null, armed: false,
    log: [], // 捨てた結果・見張り・急変などの記録（詳細ダイアログ用）
    inflight: Object.fromEntries(KINDS.map((k) => [k, null])),
    latest: Object.fromEntries(KINDS.map((k) => [k, 0])),
    seq: Object.fromEntries(KINDS.map((k) => [k, 0])),
  };

  const emit = (type, detail = {}) => { for (const fn of listeners) { try { fn(type, detail, st); } catch (e) { console.error(e); } } };
  const log = (rec) => { st.log.push({ at: o.now(), ...rec }); if (st.log.length > 50) st.log.splice(0, st.log.length - 50); };

  function startReq(kind, extra = {}) {
    const req = { kind, seq: ++st.seq[kind], gen: st.gen, tf: st.tf, base: st.tag ? st.tag.base : null, ctrl: new AbortController(), startedAt: o.now(), ...extra };
    if (kind !== 'mtf') { st.latest[kind] = req.seq; st.inflight[kind] = req; }
    else st.mtfReqs.add(req); // MTF は同時に複数あるので集合で持ち、gen が上がったら全部中断する（N10）
    const wdMs = kind === 'candles' ? TO.watchdogCandles : kind === 'ticker' ? TO.watchdogTicker : TO.watchdogOther;
    req.wd = setTimeout(() => {
      if (kind !== 'mtf' && st.inflight[kind] !== req) return;
      req.ctrl.abort();
      req.watchdog = true;
      if (kind !== 'mtf') st.inflight[kind] = null;
      const rec = { source: '-', ok: false, status: null, kind: 'watchdog', error: `取得が ${Math.round(wdMs / 1000)} 秒を超えたため中断（${kind}）`, ms: wdMs };
      log(rec);
      if (kind === 'candles') { st.attempts = [...st.attempts, rec]; st.banner = 'データの取得に時間がかかっています（再試行します）'; }
      emit('watchdog', { kind });
    }, wdMs);
    return req;
  }
  function endReq(req) { clearTimeout(req.wd); if (st.inflight[req.kind] === req) st.inflight[req.kind] = null; } // R7
  function abortKind(kind) { const r = st.inflight[kind]; if (r) { r.ctrl.abort(); clearTimeout(r.wd); st.inflight[kind] = null; } }

  // gen を上げ、出どころに依存する系列をすべて破棄する（E2・E3・E4）
  function bumpGen() {
    st.gen++;
    st.daily = []; st.dailyTag = null; st.dailyFetchedAt = 0;
    st.ticker = null; st.prevPrice = null; st.h1 = null; st.mtf.clear(); st.armed = false;
    st.tickFails = 0; st.lastTickOkAt = null;
    for (const k of ['daily', 'ticker', 'h1', 'mtf']) abortKind(k); // R6
    for (const r of st.mtfReqs) { r.ctrl.abort(); clearTimeout(r.wd); }
    st.mtfReqs.clear();
    st.h1Promise = null;
  }
  function resetAll(reason) {
    bumpGen();
    st.candles = []; st.tag = null; st.lastSrc = null; st.preferred = null; st.lastFullChain = 0; st.banner = null;
    emit('reset', { reason });
  }

  // ---------------- ローソク足 ----------------
  async function requestCandles(trigger = 'user') {
    const cur = st.inflight.candles;
    if (trigger === 'periodic' && cur && cur.tf === st.tf && cur.gen === st.gen) return 'joined'; // R3
    if (cur) { cur.ctrl.abort(); endReq(cur); } // R2: 取得中でも操作は捨てない
    const now = o.now();
    const fullChain = trigger !== 'periodic' || !st.preferred || now - st.lastFullChain > 10 * 60 * 1000;
    const req = startReq('candles', { trigger });
    emit('loading', { tf: req.tf });
    let r = null, aborted = false, error = null;
    try {
      r = await D.fetchCandlesWithFallback(req.tf, o.limit, {
        fetchFn: o.fetchFn, storage: o.storage, now, apiKey: o.getApiKey(), sourceMode: st.sourceMode,
        startFrom: fullChain ? null : st.preferred, signal: req.ctrl.signal, timeouts: o.timeouts, demoFn: o.demoFn,
      });
    } catch (e) {
      if (e && e.kind === 'aborted') aborted = true; else error = e;
    } finally { endReq(req); }
    aborted = aborted || req.ctrl.signal.aborted;
    const verdict = acceptResult(req, { latestSeq: st.latest.candles, gen: st.gen, tf: st.tf }, req.tf, aborted);
    if (verdict !== 'apply') { log({ kind: 'discard', what: 'candles', verdict, tf: req.tf, seq: req.seq }); emit('discard', { what: 'candles', verdict }); return verdict; }
    if (error || !r) { st.banner = 'データを取得できませんでした（' + (error ? error.message : '不明') + '）'; emit('error', { error }); return 'error'; }
    if (fullChain) st.lastFullChain = now;
    const reset = applyCandles(r, req);
    // 取り直し（ローソク足の base に合わせる）: 日足 → h1
    if (st.tf !== '1d' && (!st.dailyTag || st.dailyTag.gen !== st.gen)) await loadDaily();
    if (reset && st.h1Wanted && st.tf !== '1h') await getH1();
    return 'apply';
  }

  function applyCandles(r, req) {
    const src = r.source, base = src === 'cache' ? r.cachedSource : src;
    let reset = req.trigger === 'user' ? 'user' : null;
    if (st.lastSrc && (st.lastSrc.src !== src || st.lastSrc.base !== base)) { bumpGen(); reset = 'E4'; } // E4
    st.lastSrc = { src, base };
    st.tag = makeTag(src, r.cachedSource, req.tf, st.gen, r.fetchedAt);
    st.candles = r.candles;
    st.attempts = r.attempts; st.cacheAgeMin = r.cacheAgeMin ?? null;
    st.lastApplyAt = o.now(); st.banner = null;
    if (D.REAL_SOURCES.includes(src)) st.preferred = src;
    if (st.tf === '1d') { st.daily = st.candles; st.dailyTag = st.tag; st.dailyFetchedAt = o.now(); }
    const recordOnly = !st.armed; // 初回は記録のみ（指標アラート）
    st.armed = true;
    emit('candles', { reset, recordOnly, tag: st.tag });
    return reset;
  }

  // ---------------- 日足（13-2-3） ----------------
  async function loadDaily() {
    const tag = st.tag;
    if (!tag) return 'no-candles';
    if (st.tf === '1d') { st.daily = st.candles; st.dailyTag = tag; st.dailyFetchedAt = o.now(); return 'same'; }
    abortKind('daily');
    const req = startReq('daily', { base: tag.base, family: tag.family, tf: '1d' });
    const now = o.now();
    let res = null, aborted = false;
    try {
      if (tag.family === 'demo') res = { candles: o.demoFn('1d', { nowSec: Math.floor(now / 1000), limit: o.dailyLimit }), source: 'demo', fetchedAt: now, attempts: [] };
      else if (tag.src === 'cache') {
        const c = D.readCandleCache('1d', o.storage, now);
        res = c && c.source === tag.base ? { candles: c.candles, source: 'cache', cachedSource: c.source, fetchedAt: c.fetchedAt, attempts: [] } : null;
      } else {
        const order = [tag.base, ...D.SOURCE_ORDER.filter((s) => s !== tag.base)];
        res = await D.fetchCandlesWithFallback('1d', o.dailyLimit, {
          fetchFn: o.fetchFn, storage: o.storage, now, apiKey: o.getApiKey(), order, fallback: false, useCache: false,
          signal: req.ctrl.signal, timeouts: o.timeouts,
        });
      }
    } catch (e) {
      if (e && e.kind === 'aborted') aborted = true; else { st.dailyAttempts = (e && e.attempts) || []; res = null; }
    } finally { endReq(req); }
    aborted = aborted || req.ctrl.signal.aborted;
    const verdict = aborted ? 'aborted' : req.seq !== st.latest.daily ? 'stale-seq' : req.gen !== st.gen ? 'stale-gen' : 'apply';
    if (verdict !== 'apply') { log({ kind: 'discard', what: 'daily', verdict }); return verdict; }
    st.dailyFetchedAt = o.now();
    if (!res) { st.daily = []; st.dailyTag = null; emit('daily', {}); return 'none'; }
    st.daily = res.candles;
    st.dailyTag = makeTag(res.source, res.cachedSource, '1d', st.gen, res.fetchedAt);
    st.dailyAttempts = res.attempts || [];
    emit('daily', {});
    return combine(st.tag, st.dailyTag);
  }

  // 水準・ADR に使う日足（13-1 の combine と reject 時の代わり）
  function levelsInfo() {
    const tag = st.tag, c = st.candles;
    if (!tag || !c.length) return { daily: null, mode: 'none', note: 'データ取得中…' };
    const cmb = combine(tag, st.dailyTag);
    if (st.daily.length >= 2 && (cmb === 'same' || cmb === 'real-mixed')) {
      const dn = D.SHORT_NAMES[st.dailyTag.base] || st.dailyTag.base, cn = D.SHORT_NAMES[tag.base] || tag.base;
      const cache = st.dailyTag.src === 'cache' ? '・キャッシュ' : '';
      const note = cmb === 'same' ? `日足: ${dn}${cache}（チャートと同じ）` : `日足: ${dn}${cache}（チャートは ${cn}。差は通常数ドル）`;
      return { daily: st.daily, mode: cmb, note };
    }
    if (D.TIMEFRAMES[st.tf].sec < 86400) {
      const agg = I.aggregateDaily(c);
      if (agg.length >= 2) return { daily: agg, mode: 'aggregate', note: `日足: 表示中の足から集計（${agg.length} 日分）` };
    }
    return { daily: null, mode: 'none', note: '日足を取得できないため水準を表示していません' };
  }
  function adrInfo() {
    const lv = levelsInfo();
    if (!lv.daily) return { adr: null, progress: null, daily: null };
    const adr = T.adr(lv.daily, 14);
    return { adr, progress: T.adrProgress(lv.daily[lv.daily.length - 1], adr), daily: lv.daily };
  }

  // ---------------- ティック（R9・13-4） ----------------
  async function tick() {
    const tag = st.tag, c = st.candles;
    if (!tag || !c.length) return 'no-candles';
    if (tag.src === 'cache') return 'skip';
    if (st.inflight.ticker) return 'busy';
    const now = o.now();
    if (st.tickPausedUntil > now) return 'paused';
    const last = c[c.length - 1];
    const req = startReq('ticker', { base: tag.base, lastTime: last.time });
    let t = null, err = null;
    try {
      if (tag.family === 'demo') {
        const p = o.demoTickFn ? o.demoTickFn(last) : last.close * Math.exp((o.random() - 0.5) * 0.0006);
        t = { price: p, high24h: null, low24h: null, open24h: null };
      } else {
        t = await D.fetchFuturesTicker(tag.base, { fetchFn: o.fetchFn, apiKey: o.getApiKey(), signal: req.ctrl.signal, timeoutMs: TO.ticker });
      }
    } catch (e) { err = e; } finally { endReq(req); }
    const curTag = st.tag, cc = st.candles, curLast = cc[cc.length - 1];
    if (req.ctrl.signal.aborted || req.seq !== st.latest.ticker || !curTag || req.gen !== st.gen || req.base !== curTag.base || !curLast || curLast.time !== req.lastTime) {
      log({ kind: 'discard', what: 'ticker' });
      return 'discard';
    }
    if (err) {
      st.tickFails++;
      if ((err.kind === 'ratelimit' || err.kind === 'blocked') && D.REAL_SOURCES.includes(curTag.base)) {
        const pauseMin = err.pauseMin || (err.kind === 'blocked' ? 1440 : 5);
        st.tickPausedUntil = o.now() + pauseMin * 60000;
        try {
          const b = D.getBlockedSources(o.storage);
          b[curTag.base] = { at: o.now(), until: o.now() + pauseMin * 60000, status: err.status ?? null, kind: err.kind };
          o.storage.setItem('ga:blockedSources', JSON.stringify(b));
        } catch { /* noop */ }
      }
      emit('tickFail', { error: err });
      return 'fail';
    }
    if (!D.validTick(t.price, curLast.close)) { st.tickFails++; log({ kind: 'invalid', what: 'ticker', price: t.price }); emit('tickFail', {}); return 'invalid'; }
    st.tickFails = 0; st.lastTickOkAt = o.now();
    st.ticker = { ...t, tag: { ...curTag } };
    curLast.close = t.price; curLast.high = Math.max(curLast.high, t.price); curLast.low = Math.min(curLast.low, t.price);
    const cur = { price: t.price, base: curTag.base, gen: st.gen, kind: curTag.family === 'demo' ? 'demo' : 'ticker', at: o.now() };
    const gate = alertGate(st.prevPrice, cur);
    let fired = [];
    if (gate === 'judge') fired = judgeAlerts(st.prevPrice.price, cur);
    if (gate === 'jump') log({ kind: 'jump', what: 'ticker', error: '価格が急に変わったため判定を見送り', from: st.prevPrice.price, to: cur.price });
    if (gate !== 'skip') st.prevPrice = cur;
    emit('tick', { gate, fired, cur });
    return gate;
  }
  function judgeAlerts(prevPrice, cur) {
    let alerts;
    try { alerts = JSON.parse(o.storage.getItem('ga:alerts') || '[]'); } catch { alerts = []; }
    if (!Array.isArray(alerts)) return [];
    const ids = T.checkPriceAlerts(alerts, prevPrice, cur.price);
    if (!ids.length) return [];
    const fired = [];
    for (const a of alerts) if (ids.includes(a.id)) { a.enabled = false; fired.push({ ...a, title: alertTitle(a, cur), price: a.price, at: cur.price, base: cur.base }); }
    try { o.storage.setItem('ga:alerts', JSON.stringify(alerts)); } catch { /* noop */ }
    return fired;
  }

  // ---------------- 1時間足（ヒートマップ）・MTF ----------------
  async function fetchFor(kind, tf, limit, req) {
    const tag = st.tag, now = o.now();
    if (tag.family === 'demo') return { candles: o.demoFn(tf, { nowSec: Math.floor(now / 1000), limit }), source: 'demo' };
    if (tag.src === 'cache') { const c = D.readCandleCache(tf, o.storage, now); return c && c.source === tag.base ? { candles: c.candles, source: 'cache', cachedSource: c.source } : null; }
    return D.fetchCandlesWithFallback(tf, limit, {
      fetchFn: o.fetchFn, storage: o.storage, now, apiKey: o.getApiKey(), order: [tag.base], fallback: false, useCache: false, writeCache: false,
      signal: req.ctrl.signal, timeouts: o.timeouts,
    });
  }
  async function getH1() {
    st.h1Wanted = true;
    const tag = st.tag;
    if (!tag) return null;
    if (st.tf === '1h') return { candles: st.candles, tag };
    if (st.h1 && st.h1.base === tag.base && st.h1.gen === st.gen && o.now() - st.h1.at < 10 * 60 * 1000) return st.h1;
    // 同じ gen・base の取得中があれば合流する（N11。中断して出し直さない）
    const cur = st.inflight.h1;
    if (cur && cur.gen === st.gen && cur.base === tag.base && st.h1Promise) return st.h1Promise;
    abortKind('h1');
    const req = startReq('h1', { tf: '1h' });
    const p = (async () => {
      let r = null;
      try { r = await fetchFor('h1', '1h', o.h1Limit, req); } catch { r = null; } finally { endReq(req); if (st.h1Promise === p) st.h1Promise = null; }
      if (req.ctrl.signal.aborted || req.seq !== st.latest.h1 || req.gen !== st.gen || !st.tag || st.tag.base !== tag.base) return null;
      if (!r) return null;
      st.h1 = { base: tag.base, gen: st.gen, at: o.now(), candles: r.candles, tag: makeTag(r.source, r.cachedSource, '1h', st.gen, o.now()) };
      return st.h1;
    })();
    st.h1Promise = p;
    return p;
  }
  async function getMtf(tf) {
    const tag = st.tag;
    if (!tag) return null;
    if (tf === st.tf) return { candles: st.candles, tag };
    const key = `${tag.base}:${st.gen}:${tf}`;
    const hit = st.mtf.get(key);
    if (hit && o.now() - hit.at < 10 * 60 * 1000) return hit;
    const req = startReq('mtf', { tf });
    let r = null;
    try { r = await fetchFor('mtf', tf, o.limit, req); } catch { r = null; } finally { clearTimeout(req.wd); st.mtfReqs.delete(req); }
    if (req.ctrl.signal.aborted || req.gen !== st.gen || !r) return null;
    const v = { at: o.now(), candles: r.candles, tag: makeTag(r.source, r.cachedSource, tf, st.gen, o.now()) };
    st.mtf.set(key, v);
    return v;
  }

  // ---------------- イベント（13-2-1） ----------------
  return {
    state: st,
    getState: () => st,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // E7 起動: キャッシュがあれば印付きで先に表示してから取得
    start() {
      st.gen = 0;
      if (st.sourceMode !== 'demo') {
        const now = o.now();
        const cached = D.readCandleCache(st.tf, o.storage, now);
        if (cached) {
          st.tag = makeTag('cache', cached.source, st.tf, st.gen, cached.fetchedAt);
          st.candles = cached.candles; st.lastSrc = { src: 'cache', base: cached.source };
          st.cacheAgeMin = Math.round((now - cached.fetchedAt) / 60000);
          st.attempts = [];
          const d1 = st.tf === '1d' ? null : D.readCandleCache('1d', o.storage, now);
          if (d1 && d1.source === cached.source) { st.daily = d1.candles; st.dailyTag = makeTag('cache', d1.source, '1d', st.gen, d1.fetchedAt); }
          emit('candles', { reset: 'E7', recordOnly: true, tag: st.tag, preview: true });
        }
      }
      return requestCandles('user');
    },
    setTf(tf) { // E1
      if (!(tf in D.TIMEFRAMES)) return Promise.resolve('bad-tf');
      st.tf = tf; st.candles = []; st.tag = null; st.prevPrice = null; st.armed = false; st.banner = null;
      emit('reset', { reason: 'E1', tf });
      return requestCandles('user');
    },
    setSourceMode(mode) { // E2
      st.sourceMode = mode;
      resetAll('E2');
      return requestCandles('user');
    },
    retry({ resetBlocked = true } = {}) { // E3
      if (resetBlocked) D.resetBlockedSources(o.storage);
      resetAll('E3');
      return requestCandles('user');
    },
    refresh() { return requestCandles('periodic'); }, // E5
    onVisible() { // E6
      const now = o.now();
      if (st.prevPrice && now - st.prevPrice.at >= 10 * 60 * 1000) st.prevPrice = null;
      const p = [];
      if (!st.lastApplyAt || now - st.lastApplyAt > 30000) p.push(requestCandles('periodic'));
      else if (st.tf !== '1d' && now - st.dailyFetchedAt > 10 * 60 * 1000) p.push(loadDaily());
      p.push(tick());
      return Promise.all(p);
    },
    clearCache() { // E8
      try {
        const keys = [];
        if (typeof o.storage.length === 'number' && o.storage.key) { for (let i = 0; i < o.storage.length; i++) keys.push(o.storage.key(i)); }
        else if (o.storage._m) keys.push(...o.storage._m.keys());
        keys.filter((k) => k && (k.startsWith('ga:cache:') || k === 'ga:xausHistory')).forEach((k) => o.storage.removeItem(k));
      } catch { /* noop */ }
      st.h1 = null; st.mtf.clear();
    },
    tick, loadDaily, levelsInfo, adrInfo, getH1, getMtf,
    isCandleStale(now = o.now()) { return st.lastApplyAt !== null && D.isStale(st.lastApplyAt, now, 3 * REFRESH_SEC[st.tf]); },
    isTickStale(intervalSec, now = o.now()) { return st.tag && st.tag.src !== 'cache' && D.isStale(st.lastTickOkAt, now, Math.max(30, 6 * intervalSec)); },
    stop() { for (const k of KINDS) abortKind(k); },
  };
}
