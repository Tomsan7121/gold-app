// アプリ本体（画面の組み立て・タイマー・価格表示・チャート連携）。データの状態は controller.js が持つ。
import * as I from './indicators.js';
import * as L from './levels.js';
import * as T from './trade.js';
import * as SG from './signals.js';
import * as ST from './stats.js';
import * as SE from './sessions.js';
import * as D from './data.js';
import * as store from './store.js';
import { createDataController, REFRESH_SEC } from './controller.js';
import { $, $$, el, clear, setText, fmtNum, fmtSigned, fmtYen, fmtJSTTime, fmtDuration, toast, safeInit } from './dom.js';
import { ChartView } from './chart.js';
import { renderAnalysis, initAnalysis, loadDerivatives } from './ui-analysis.js';
import { initTools, refreshToolDefaults, initJournal } from './ui-tools.js';
import { initAlerts, checkCalendar, renderAlertList, notify } from './ui-alerts.js';
import { initSettings, initSheets } from './ui-settings.js';

const DEBUG = new URLSearchParams(location.search).has('debug'); // 本番では内部を公開しない（?debug=1 のときだけ）
if (DEBUG) window.GA = { ind: I, lv: L, trade: T, sig: SG, stats: ST, sessions: SE, data: D };

// 起動時、どの画面の初期化よりも前に保存データを検査する（N1・13-5）
const boot = (() => { try { return store.sanitizeAll(); } catch (e) { console.error(e); return { report: [], settings: store.DEFAULT_SETTINGS }; } })();

const ctx = {
  settings: boot.settings,
  settingsVersion: 0,
  state: { spot: null, spotError: null, spotFails: 0, usdJpy: null, silver: null },
  chart: null,
  ctrl: null,
  save() { ctx.settingsVersion++; store.saveSettings(ctx.settings); },
  usdJpy() {
    const s = ctx.settings;
    return s.usdJpyAuto && ctx.state.usdJpy && ctx.state.usdJpy.rate ? ctx.state.usdJpy.rate : Number(s.usdJpyManual) || 150;
  },
  candles() { return ctx.ctrl.state.candles; },
  tf() { return ctx.ctrl.state.tf; },
  tag() { return ctx.ctrl.state.tag; },
  lastPrice() { const c = ctx.candles(); return c.length ? c[c.length - 1].close : null; },
  isDemo() { const t = ctx.tag(); return !!t && t.family === 'demo'; },
  intervalSec() { return D.TIMEFRAMES[ctx.tf()].sec; },
  rerender: null,
};
if (DEBUG) window.GA.ctx = ctx;

ctx.ctrl = createDataController({ tf: ctx.settings.tf, sourceMode: ctx.settings.sourceMode, getApiKey: store.getApiKey });

// 総合判定は「ローソク足の更新 1 回につき 1 回」だけ計算して使い回す（N3・13-8）
const compMemo = { key: null, confirmed: null, liveKey: null, live: null };
ctx.composite = () => {
  const c = ctx.candles();
  if (c.length < 31) return { confirmed: null, live: null };
  const key = [c.length, c[0].time, c[c.length - 2].time, c[c.length - 2].close, ctx.settingsVersion, ctx.ctrl.state.gen].join('|');
  if (key !== compMemo.key) { compMemo.key = key; compMemo.confirmed = SG.compositeScore(c.slice(0, -1), ctx.settings); }
  const liveKey = key + '|' + c[c.length - 1].close;
  if (liveKey !== compMemo.liveKey) { compMemo.liveKey = liveKey; compMemo.live = SG.compositeScore(c, ctx.settings); }
  return { confirmed: compMemo.confirmed, live: compMemo.live };
};

// ---------------- テーマ ----------------
function applyTheme() {
  document.documentElement.dataset.theme = ctx.settings.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', ctx.settings.theme === 'light' ? '#f3f5f8' : '#0f1218');
}
ctx.applyTheme = applyTheme;

// ---------------- タブ ----------------
function initTabs() {
  $$('.bottom-nav button').forEach((b) => b.addEventListener('click', () => {
    $$('.bottom-nav button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    window.scrollTo(0, 0);
    if (b.dataset.tab === 'analysis') { renderAnalysis(ctx); loadDerivatives(ctx); }
    if (b.dataset.tab === 'tools') refreshToolDefaults(ctx);
  }));
}

// ---------------- 時間足 ----------------
function initTfBar() {
  const bar = $('#tfBar');
  for (const [k, v] of Object.entries(D.TIMEFRAMES)) {
    bar.appendChild(el('button', { type: 'button', role: 'tab', class: k === ctx.tf() ? 'on' : '', dataset: { tf: k }, text: v.label, onclick: () => {
      if (ctx.tf() === k && ctx.candles().length) return;
      ctx.settings.tf = k; ctx.save();
      $$('#tfBar button').forEach((x) => x.classList.toggle('on', x.dataset.tf === k)); // 押した瞬間に選択状態にする（R10）
      ctx.ctrl.setTf(k).then(() => ctx.ctrl.tick());
    } }));
  }
}

// ---------------- データソース表示 ----------------
const tfName = (tf) => { const l = D.TIMEFRAMES[tf].label; return l.endsWith('足') ? l : l + '足'; };
function sourceLabel(tag) {
  if (!tag) return '';
  return tag.src === 'cache' ? `${D.SHORT_NAMES[tag.base] || ''}・キャッシュ` : D.SHORT_NAMES[tag.base] || '';
}
function updateSourceBar() {
  const st = ctx.ctrl.state, bar = $('#sourceBar'), tag = st.tag;
  bar.classList.remove('demo', 'cache', 'stale');
  const failed = st.attempts.filter((a) => !a.ok).map((a) => `${D.SHORT_NAMES[a.source] || a.source}: ${a.kind === 'blocked' ? '地域制限 ' + (a.status || '') : a.error}`);
  const failText = failed.length ? `（${failed.join('・')}）` : '';
  const loading = st.inflight.candles;
  if (!tag || !st.candles.length) {
    const want = st.sourceMode === 'auto' ? D.SHORT_NAMES.binance : st.sourceMode === 'demo' ? 'デモ' : D.SHORT_NAMES[st.sourceMode];
    bar.textContent = loading ? `${tfName(st.tf)}を取得中…（${want}）` : st.banner || 'データ取得中…';
    if (st.banner) bar.classList.add('stale');
    return;
  }
  const loadingText = loading ? `　${tfName(loading.tf)}を更新中…` : '';
  if (st.banner) { bar.classList.add('stale'); bar.textContent = `${st.banner}　タップで詳細`; return; }
  if (ctx.ctrl.isCandleStale()) {
    bar.classList.add('stale');
    bar.textContent = `更新が止まっています（最終 ${fmtJSTTime(st.lastApplyAt).slice(0, 5)}）。通信を確認しています　タップで詳細`;
    return;
  }
  if (tag.src === 'demo') { bar.classList.add('demo'); bar.textContent = `デモデータ表示中：実際の相場ではありません${failText}${loadingText}　タップで詳細`; }
  else if (tag.src === 'cache') { bar.classList.add('cache'); bar.textContent = `オフライン：${st.cacheAgeMin ?? '—'}分前のデータ（${D.SOURCE_NAMES[tag.base] || ''}）${loadingText}　タップで詳細`; }
  else bar.textContent = `データ元: ${D.SOURCE_NAMES[tag.base]}${failText}・更新 ${fmtJSTTime(st.lastApplyAt)} JST${loadingText}`;
}
function showSourceDetail() {
  const box = clear($('#srcDetail'));
  const st = ctx.ctrl.state, tag = st.tag;
  box.appendChild(el('p', { class: 'small', text: `使用中: ${tag ? D.SOURCE_NAMES[tag.src === 'cache' ? 'cache' : tag.base] + (tag.src === 'cache' ? `（${D.SOURCE_NAMES[tag.base]}）` : '') : '—'}／時間足: ${D.TIMEFRAMES[st.tf].label}／最終取得 ${st.lastApplyAt ? fmtJSTTime(st.lastApplyAt) : '—'}／世代 ${st.gen}` }));
  for (const a of st.attempts) {
    box.appendChild(el('div', { class: 'src-row' },
      el('b', { text: D.SOURCE_NAMES[a.source] || a.source }), ' ',
      el('span', { class: a.ok ? 'st-bull' : 'st-bear', text: a.ok ? '成功' : '失敗' }),
      ` ${a.status ? 'HTTP ' + a.status : ''} ${a.error || ''} ${a.ms ? `(${a.ms}ms)` : ''}`));
  }
  const blocked = D.getBlockedSources();
  const now = Date.now();
  for (const [k, v] of Object.entries(blocked)) {
    if (v.until > now) box.appendChild(el('div', { class: 'src-row small', text: `${D.SOURCE_NAMES[k]}: ${v.kind === 'blocked' ? '地域制限' : '回数制限'}（HTTP ${v.status ?? '—'}）の記録あり。${fmtDuration(v.until - now)}後に再試行` }));
  }
  for (const r of st.log.slice(-5)) box.appendChild(el('div', { class: 'src-row small', text: `記録 ${fmtJSTTime(r.at)}: ${r.error || `${r.what || ''} の結果を破棄（${r.verdict || r.kind}）`}` }));
  box.appendChild(el('div', { class: 'src-row small', text: `スポット: ${ctx.state.spot ? `gold-api.com（${fmtJSTTime(ctx.state.spot.updatedAt)} 更新）` : ctx.state.spotError || '未取得'}` }));
  box.appendChild(el('div', { class: 'src-row small', text: `USD/JPY: ${ctx.state.usdJpy ? `${ctx.state.usdJpy.source}` : '手入力値 ' + ctx.settings.usdJpyManual}` }));
  box.appendChild(el('div', { class: 'src-row small', text: `水準・ADR の${ctx.ctrl.levelsInfo().note}` }));
  $('#dlgSource').showModal();
}

// ---------------- 描画 ----------------
let renderTimer = null;
function renderAll() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    safeInit('chart', renderChart);
    safeInit('price', updatePriceCard);
    safeInit('info', renderChartInfo);
    updateSourceBar();
    if ($('#tab-analysis').classList.contains('active')) safeInit('analysis', () => renderAnalysis(ctx));
    safeInit('tools', () => refreshToolDefaults(ctx, true));
  }, 30);
}
ctx.rerender = renderAll;

function renderChart() {
  const st = ctx.ctrl.state, m = $('#chartMsg');
  if (!ctx.chart || !ctx.chart.lib) return;
  if (!st.candles.length || !st.tag) {
    ctx.chart.destroy();
    m.hidden = false;
    m.textContent = `${tfName(st.tf)}を取得中…`;
    return;
  }
  if (!ctx.chartFailed) m.hidden = true;
  const tag = st.tag;
  ctx.chart.render({
    candles: st.candles, tf: st.tf, tagKey: `${tag.src}:${tag.base}:${tag.gen}`, intervalSec: ctx.intervalSec(), settings: ctx.settings,
    levels: ctx.ctrl.levelsInfo(),
    hlines: store.readJSON(store.KEYS.hlines, []), trendlines: store.readJSON(store.KEYS.trendlines, []), alerts: store.readJSON(store.KEYS.alerts, []),
  });
  const w = ctx.settings.weekend;
  setText('#weekendNote', w === 'dim' ? '薄く表示' : w === 'hide' ? '非表示に' : '通常表示');
}

function renderChartInfo() {
  const box = clear($('#chartInfo'));
  const c = ctx.candles();
  const { confirmed: comp, live } = ctx.composite();
  if (!comp) { box.appendChild(el('div', { class: 'it', text: c.length ? 'データ不足' : '取得中…' })); return; }
  box.appendChild(el('div', { class: 'it' }, '総合判定（確定足）: ', el('b', { class: comp.label === 'bullish' ? 'st-bull' : comp.label === 'bearish' ? 'st-bear' : 'st-neutral', text: `${SG.labelJa(comp.label)}（${comp.score}/100）` }), '　詳しくは「分析」タブ'));
  if (live) box.appendChild(el('div', { class: 'it small', text: `形成中の足を含めた参考値: ${live.score}（足が確定するまで変わります）` }));
  const pats = SG.candlePatterns(c, c.length - 2).map((p) => SG.PATTERN_NAMES[p]);
  box.appendChild(el('div', { class: 'it', text: `直近の確定足のパターン: ${pats.length ? pats.join('・') + '（パターン出現）' : 'なし'}` }));
  const sq = SG.squeeze(c);
  box.appendChild(el('div', { class: 'it', text: `ボラティリティ: ${sq.squeeze ? 'スクイーズ中（値幅縮小・放れに注意）' : 'スクイーズなし'}／BB幅の位置 ${sq.bandwidthPercentile === null ? '—' : sq.bandwidthPercentile.toFixed(0) + '%'}／ATR比 ${sq.atrRatio === null ? '—' : sq.atrRatio.toFixed(2)}${sq.atrRatio > 1.3 ? '（値動き拡大）' : sq.atrRatio !== null && sq.atrRatio < 0.7 ? '（縮小）' : ''}` }));
}

// 価格カードの「最終更新 hh:mm」。止まっているときは帯と同じオレンジにする（R2-3・13-7）
function updateFreshness() {
  const st = ctx.ctrl.state, e = $('#pcUpdated'), card = $('.price-card');
  if (!e || !card) return;
  if (!st.lastApplyAt) { e.textContent = ''; e.classList.remove('stale-text'); card.classList.remove('stale'); return; }
  const stale = ctx.ctrl.isCandleStale();
  e.textContent = `最終更新 ${fmtJSTTime(st.lastApplyAt).slice(0, 5)}${stale ? '（更新が止まっています）' : ''}`;
  e.classList.toggle('stale-text', stale);
  card.classList.toggle('stale', stale);
}

// ---------------- 価格カード ----------------
function updatePriceCard() {
  const st = ctx.ctrl.state, S = ctx.settings, tag = st.tag;
  const fut = ctx.lastPrice();
  const isDemo = ctx.isDemo();
  const now = Date.now();
  const spot = ctx.state.spot;
  const spotFresh = spot && now - spot.updatedAt < 5 * 60 * 1000;
  let big, bigLabel;
  if (!tag) { big = null; bigLabel = '取得中…'; }
  else if (isDemo) { big = fut; bigLabel = 'デモ価格（実際の相場ではありません）'; }
  else if (spot) { big = spot.price; bigLabel = spotFresh ? 'スポット参考値 gold-api.com' : `スポット参考値 gold-api.com（${fmtJSTTime(spot.updatedAt)} 時点）`; }
  else { big = fut; bigLabel = 'スポット取得不可のため先物価格'; }
  setText('#spotPrice', fmtNum(big)); setText('#spotLabel', bigLabel);
  setText('#futLabel', !tag ? 'チャート：取得中…' : isDemo ? 'チャート：デモデータ' : `チャート：${D.SOURCE_NAMES[tag.base] || '—'}${tag.src === 'cache' ? '（キャッシュ）' : ''}`);
  setText('#futPrice', fmtNum(fut));
  const tickStale = tag && tag.src !== 'cache' && st.lastTickOkAt && ctx.ctrl.isTickStale(S.priceIntervalSec);
  updateFreshness();
  setText('#futStale', tag && tag.src === 'cache' ? '（ティック無し）' : st.tickPausedUntil > now ? '（ティック休止中）' : tickStale ? `（${fmtJSTTime(st.lastTickOkAt)} 時点）` : '');
  if (isDemo) setText('#basisText', '先物−スポット: —（デモ）');
  else if (spot && spotFresh && Number.isFinite(fut)) { const b = T.basis(fut, spot.price); setText('#basisText', `先物−スポット: ${fmtSigned(b.diff)}（${fmtSigned(b.pct, 2)}%）`); }
  else setText('#basisText', `先物−スポット: —（${spot ? 'スポット更新が5分以上前' : 'スポット取得失敗'}）`);

  // 24h 変化（先物）。ティックの印がローソク足と同じときだけ ticker の値を使う（13-1）
  const tk = st.ticker && tag && st.ticker.tag.gen === tag.gen && st.ticker.tag.base === tag.base ? st.ticker : null;
  let open24 = tk && Number.isFinite(tk.open24h) ? tk.open24h : null;
  let hi24 = tk && Number.isFinite(tk.high24h) ? tk.high24h : null;
  let lo24 = tk && Number.isFinite(tk.low24h) ? tk.low24h : null;
  const c = st.candles;
  if (c.length && (open24 === null || hi24 === null)) {
    const sec = ctx.intervalSec();
    const lastT = c[c.length - 1].time;
    if (sec < 86400) {
      const w = c.filter((x) => x.time > lastT - 86400);
      if (w.length) { open24 = open24 ?? w[0].open; hi24 = hi24 ?? Math.max(...w.map((x) => x.high)); lo24 = lo24 ?? Math.min(...w.map((x) => x.low)); }
    } else if (c.length >= 2) { open24 = open24 ?? c[c.length - 2].close; hi24 = hi24 ?? c[c.length - 1].high; lo24 = lo24 ?? c[c.length - 1].low; }
  }
  const chg = open24 && Number.isFinite(fut) ? fut - open24 : null;
  const chgPct = chg !== null ? (chg / open24) * 100 : null;
  const cls = chg === null ? '' : chg >= 0 ? 'up' : 'down';
  const chgEl = $('#chg24'); chgEl.textContent = chg === null ? '—' : `${fmtSigned(chg)} (${fmtSigned(chgPct)}%)`; chgEl.className = cls;
  setText('#hi24', fmtNum(hi24)); setText('#lo24', fmtNum(lo24));
  setText('#hdrPrice', fmtNum(big));
  // B12: ヘッダーの価格はスポット、変化は先物から計算するため「先物」と明記する
  const hc = $('#hdrChange'); hc.textContent = chg === null ? '' : `先物24h ${fmtSigned(chg)} (${fmtSigned(chgPct)}%)${isDemo ? ' デモ' : ''}`; hc.className = 'hdr-change ' + cls;

  // ADR（日足の出典がローソク足と合うときだけ。13-1）
  const a = ctx.ctrl.adrInfo();
  setText('#adrVal', a.adr === null ? '—' : '$' + fmtNum(a.adr));
  setText('#adrProg', a.progress === null ? '—' : a.progress.toFixed(0) + '%');

  // 円換算
  const uj = ctx.usdJpy();
  setText('#usdjpy', fmtNum(uj, 2) + (S.usdJpyAuto && ctx.state.usdJpy ? '' : '（手入力）'));
  if (Number.isFinite(big)) { const y = T.yenPrices(big, uj); setText('#yenOz', fmtYen(y.perOz)); setText('#yenG', fmtYen(y.perGram)); }
  else { setText('#yenOz', '—'); setText('#yenG', '—'); }
  // デモ中は金銀比を出さない（デモ価格と実際の銀価格を混ぜない）
  setText('#gsr', !isDemo && ctx.state.silver && Number.isFinite(big) ? (big / ctx.state.silver).toFixed(2) : '—');
}
ctx.updatePriceCard = updatePriceCard;

// ---------------- セッション時計 ----------------
function updateSessionClock() {
  const now = Date.now();
  const s = SE.getSessions(now);
  const names = s.active.map((k) => SE.SESSIONS.find((x) => x.key === k).name);
  const parts = [];
  parts.push(names.length ? `取引中: ${names.join('・')}${s.overlap ? '（ロンドン×NY 重複＝値動きが大きくなりやすい時間帯）' : ''}` : '主要セッション時間外');
  for (const ses of SE.SESSIONS) {
    if (s.active.includes(ses.key)) { const t = SE.sessionCloseTime(ses, now); if (t) parts.push(`${ses.name} 終了まで ${fmtDuration(t - now)}`); }
    else { const t = SE.nextSessionOpen(ses, now); if (t) parts.push(`${ses.name} 開始まで ${fmtDuration(t - now)}`); }
  }
  if (SE.isSpotMarketClosed(now)) parts.push('スポット市場は週末休場中（先物は取引あり）');
  parts.push(`米国は${SE.isUsDst(now) ? '夏時間' : '標準時間'}`);
  setText('#sessionClock', parts.join('／'));
}

// ---------------- controller のイベント ----------------
const firedKeys = new Set(store.readJSON(store.KEYS.notified, []));
function checkIndicatorAlerts(recordOnly) {
  const st = ctx.ctrl.state, tag = st.tag, c = st.candles;
  if (!tag) return;
  const evs = SG.indicatorEvents(c, ctx.settings.alertOpts, ctx.settings.params);
  if (!evs.length) return;
  const t = c[c.length - 2].time;
  const tfName = D.TIMEFRAMES[st.tf].label;
  let changed = false;
  for (const e of evs) {
    const k = `${tag.base}:${st.tf}:${e.key}:${t}`;
    if (firedKeys.has(k)) continue;
    firedKeys.add(k); changed = true;
    if (!recordOnly) notify(ctx, (tag.family === 'demo' ? '【デモ】' : '') + e.title, `${tfName}・確定足 ${fmtJSTTime(t * 1000)}（参考情報）`);
  }
  if (changed) store.writeJSON(store.KEYS.notified, [...firedKeys].slice(-200));
}

function onCtrlEvent(type, d) {
  if (type === 'loading' || type === 'discard' || type === 'watchdog' || type === 'error' || type === 'tickFail') { updateSourceBar(); if (type === 'tickFail') updatePriceCard(); return; }
  if (type === 'reset') { if (ctx.chart) ctx.chart.destroy(); renderAll(); return; } // 古いチャートに新しいソースの価格を書かない（R2-1）
  if (type === 'candles') {
    renderAll();
    if (!d.preview) checkIndicatorAlerts(d.recordOnly);
    return;
  }
  if (type === 'daily') { renderAll(); return; }
  if (type === 'tick') {
    const c = ctx.candles(), last = c[c.length - 1];
    const tg = ctx.tag();
    if (ctx.chart && last && tg) ctx.chart.updateLast({ ...last }, `${tg.src}:${tg.base}:${tg.gen}`);
    updatePriceCard();
    if (d.fired && d.fired.length) {
      for (const f of d.fired) notify(ctx, f.title, `現在 ${fmtNum(d.cur.price)}（${D.SOURCE_NAMES[d.cur.base] || ''}）`);
      renderAlertList(ctx);
      renderChart();
    }
  }
}

// ---------------- 関連データ ----------------
async function refreshSpot() {
  const st = ctx.state;
  try { st.spot = await D.fetchSpot(); st.spotError = null; st.spotFails = 0; } catch (e) { st.spotError = 'スポット取得失敗: ' + e.message; st.spotFails++; }
  try { st.silver = await D.fetchSilver(); } catch { /* 任意 */ }
  updatePriceCard();
}
let usdJpyFails = 0;
async function refreshUsdJpy() {
  if (!ctx.settings.usdJpyAuto) return;
  try { ctx.state.usdJpy = await D.fetchUsdJpy(); usdJpyFails = 0; } catch { ctx.state.usdJpy = null; usdJpyFails++; }
  updatePriceCard();
}

// ---------------- チャート操作 ----------------
let trendFirst = null;
function setDrawMode(mode) {
  const cur = ctx.chart ? ctx.chart.mode : null;
  const next = cur === mode ? null : mode;
  if (ctx.chart) ctx.chart.setMode(next);
  trendFirst = null;
  $('#btnHline').setAttribute('aria-pressed', String(next === 'hline'));
  $('#btnTrend').setAttribute('aria-pressed', String(next === 'trend'));
  if (next === 'hline') toast('チャートをタップした価格に水平線を追加します');
  if (next === 'trend') toast('チャート上の2点をタップしてトレンド線を引きます');
}
function onChartClick({ time, price, mode }) {
  if (!mode || !Number.isFinite(price)) return;
  if (!(price >= 500 && price <= 20000)) { toast('価格の範囲外です'); return; }
  if (mode === 'hline') {
    const h = store.readJSON(store.KEYS.hlines, []);
    h.push({ id: 'hl' + Date.now().toString(36), price: Math.round(price * 100) / 100 });
    store.writeJSON(store.KEYS.hlines, h.slice(-30));
    toast(`水平線 ${fmtNum(price)} を追加しました`);
    setDrawMode('hline');
    renderChart();
  } else if (mode === 'trend') {
    if (time === null) { toast('足のある位置をタップしてください'); return; }
    if (!trendFirst) { trendFirst = { time, price }; toast('2点目をタップしてください'); return; }
    if (trendFirst.time === time) { toast('別の時刻の足をタップしてください'); return; }
    const t = store.readJSON(store.KEYS.trendlines, []);
    t.push({ id: 'tl' + Date.now().toString(36), t1: trendFirst.time, p1: trendFirst.price, t2: time, p2: price });
    store.writeJSON(store.KEYS.trendlines, t.slice(-20));
    trendFirst = null;
    setDrawMode('trend');
    toast('トレンド線を追加しました');
    renderChart();
  }
}

function initChartControls() {
  $('#chartType').value = ctx.settings.chartType;
  $('#chartType').addEventListener('change', (e) => { ctx.settings.chartType = e.target.value; ctx.save(); renderChart(); });
  $('#btnHline').addEventListener('click', () => setDrawMode('hline'));
  $('#btnTrend').addEventListener('click', () => setDrawMode('trend'));
  $('#btnClearDraw').addEventListener('click', () => {
    if (!confirm('手動で追加した水平線とトレンド線をすべて消去しますか？')) return;
    store.writeJSON(store.KEYS.hlines, []); store.writeJSON(store.KEYS.trendlines, []);
    renderChart();
  });
  const wrap = $('#chartWrap');
  const exitFs = () => { wrap.classList.remove('fs'); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); renderChart(); };
  $('#btnFull').addEventListener('click', async () => {
    wrap.classList.add('fs');
    try { if (wrap.requestFullscreen) await wrap.requestFullscreen(); } catch { /* iOS 等は CSS の全画面のみ */ }
    try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch { /* 非対応 */ }
    renderChart();
  });
  $('#btnFsClose').addEventListener('click', exitFs);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && wrap.classList.contains('fs')) { wrap.classList.remove('fs'); renderChart(); } });
  $('#sourceBar').addEventListener('click', showSourceDetail);
  $('#dlgSource').addEventListener('close', () => { if ($('#dlgSource').returnValue === 'retry') ctx.ctrl.retry({ resetBlocked: true }).then(() => ctx.ctrl.tick()); });
  $('#btnTheme').addEventListener('click', () => {
    ctx.settings.theme = ctx.settings.theme === 'dark' ? 'light' : 'dark';
    ctx.save(); applyTheme();
    const sel = $('#setTheme'); if (sel) sel.value = ctx.settings.theme;
    renderChart();
  });
}

async function initChart() {
  ctx.chart = new ChartView($('#chart'), $('#legend'), onChartClick);
  const ok = await ctx.chart.init();
  if (!ok) {
    ctx.chartFailed = true;
    const m = $('#chartMsg');
    m.hidden = false;
    m.textContent = 'チャートライブラリ（Lightweight Charts）を読み込めませんでした。チャート以外の機能（分析・計算・日記・アラート）はそのまま使えます。';
    $('#chart').style.height = '0px';
    return;
  }
  renderChart();
}

// ---------------- タイマー ----------------
function startTimers() {
  const st = ctx.ctrl.state;
  let lastRefreshCall = Date.now();
  setInterval(() => {
    updateSourceBar(); // 止まっていないかの表示（13-7）
    updateFreshness();
    if (document.hidden) return;
    const since = Date.now() - Math.max(st.lastApplyAt || 0, lastRefreshCall);
    if (since >= REFRESH_SEC[st.tf] * 1000) { lastRefreshCall = Date.now(); ctx.ctrl.refresh(); }
  }, 5000);
  const tickLoop = () => {
    const next = () => setTimeout(tickLoop, D.backoff(ctx.settings.priceIntervalSec, st.tickFails, 60) * 1000);
    if (document.hidden) { next(); return; }
    ctx.ctrl.tick().catch(() => {}).finally(next);
  };
  setTimeout(tickLoop, 3000);
  const spotLoop = () => {
    const next = () => setTimeout(spotLoop, D.backoff(ctx.settings.spotIntervalSec, ctx.state.spotFails, 600) * 1000);
    if (document.hidden) { next(); return; }
    refreshSpot().finally(next);
  };
  setTimeout(spotLoop, ctx.settings.spotIntervalSec * 1000);
  const fxLoop = () => refreshUsdJpy().finally(() => setTimeout(fxLoop, usdJpyFails === 1 ? 5 * 60 * 1000 : 60 * 60 * 1000));
  setTimeout(fxLoop, 60 * 60 * 1000);
  setInterval(() => { if (!document.hidden && st.tf !== '1d') ctx.ctrl.loadDaily(); }, 10 * 60 * 1000);
  setInterval(() => { updateSessionClock(); checkCalendar(ctx); }, 30 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { ctx.ctrl.onVisible(); refreshSpot(); } });
}

// ---------------- Service Worker（更新は利用者の操作で） ----------------
function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let wantReload = false;
  const hadController = !!navigator.serviceWorker.controller; // 初回インストールでは再読み込みしない
  const bar = $('#updateBar');
  const offer = (worker) => {
    if (!worker || !navigator.serviceWorker.controller) return;
    bar.hidden = false;
    $('#btnUpdate').onclick = () => { wantReload = true; bar.hidden = true; worker.postMessage({ type: 'SKIP_WAITING' }); };
  };
  // 新しい SW に切り替わったら、ボタンを押していない別のタブも 1 回だけ再読み込みする（旧 JS のまま新しい SW の管理下に残さない）
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloaded || !hadController) return; reloaded = true; wantReload = false; location.reload(); });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => { /* 内蔵ブラウザなど SW が使えない環境 */ });
}

// ---------------- 起動 ----------------
async function main() {
  applyTheme();
  ctx.ctrl.on(onCtrlEvent);
  // 各画面の初期化は個別に受け止め、失敗した部分だけ「表示できません」と出す（N1）
  safeInit('tabs', initTabs);
  safeInit('tfBar', initTfBar);
  safeInit('chartControls', initChartControls, '#tab-chart');
  safeInit('sheets', () => initSheets(ctx));
  safeInit('settings', () => initSettings(ctx), '#tab-more');
  safeInit('analysis', () => initAnalysis(ctx), '#tab-analysis');
  safeInit('tools', () => initTools(ctx), '#tab-tools');
  safeInit('journal', () => initJournal(ctx), '#tab-journal');
  safeInit('alerts', () => initAlerts(ctx), '#tab-alerts');
  safeInit('session', updateSessionClock);
  if (boot.report.length) setTimeout(() => toast(`保存データの一部が壊れていたため直しました（${store.reportText(boot.report)}）`), 400);
  initChart().catch((e) => console.error(e));
  await ctx.ctrl.start().catch((e) => console.error(e));
  ctx.ctrl.tick().catch(() => {});
  refreshSpot();
  refreshUsdJpy();
  safeInit('calendar', () => checkCalendar(ctx));
  startTimers();
  initServiceWorker();
}
main().catch((e) => {
  console.error(e);
  const bar = $('#sourceBar');
  if (bar) { bar.classList.add('stale'); bar.textContent = '起動中にエラーが発生しました。再読み込みしてください（' + e.message + '）'; }
});
