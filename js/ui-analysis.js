// 分析タブ（総合判定・判定表・MTF・シグナル・水準・統計・建玉）
import * as I from './indicators.js';
import * as L from './levels.js';
import * as T from './trade.js';
import * as SG from './signals.js';
import * as ST from './stats.js';
import * as D from './data.js';
import * as store from './store.js';
import { $, $$, el, clear, setText, fmtNum, fmtSigned, fmtJSTmd, toast } from './dom.js';

let pivotMethod = 'classic';
const p2 = (v) => fmtNum(v, 2);
const stateCls = (s) => (s === 'bull' ? 'st-bull' : s === 'bear' ? 'st-bear' : 'st-neutral');
const stateJa = (s) => (s === 'bull' ? '上昇寄り' : s === 'bear' ? '下落寄り' : '中立');
const row = (...cells) => el('tr', {}, ...cells.map((c) => (c instanceof Node ? c : el('td', { text: c }))));
const numTd = (v, cls = '') => el('td', { class: 'num ' + cls, text: v });

export function initAnalysis(ctx) {
  $$('#pivotSeg button').forEach((b) => b.addEventListener('click', () => {
    pivotMethod = b.dataset.m;
    $$('#pivotSeg button').forEach((x) => x.classList.toggle('on', x === b));
    renderLevels(ctx);
  }));
  $('#btnMtf').addEventListener('click', () => loadMtf(ctx));
  $('#btnSeason').addEventListener('click', () => loadSeason(ctx));
  $('#btnCorr').addEventListener('click', () => loadCorr(ctx));
}

export function renderAnalysis(ctx) {
  const c = ctx.candles();
  if (!c.length) return;
  renderComposite(ctx, c);
  renderRefs(ctx, c);
  renderSignals(ctx, c);
  renderLevels(ctx);
  renderStats(ctx);
}

const fmtScore = SG.fmtScore;

function renderComposite(ctx, c) {
  const { confirmed: r, live } = ctx.composite();
  const tag = ctx.tag();
  setText('#compTf', `${D.TIMEFRAMES[ctx.tf()].label}・${tag ? D.SHORT_NAMES[tag.base] || '' : ''}・確定足`);
  if (!r) { setText('#compScore', '—'); setText('#compSummary', 'データ不足のため計算できません'); return; }
  const txt = SG.buildReasons(r);
  setText('#compLive', live ? `形成中の足を含めた参考値: ${live.score}（足が確定するまで変わります）` : '');
  setText('#compScore', `${r.score}`);
  const lb = $('#compLabel');
  lb.textContent = r.fewInputs ? '中立（判定材料が少ない）' : `${SG.strengthJa(r.score)}　上昇寄り${r.bullCount}・下落寄り${r.bearCount}・中立${r.neutralCount}`;
  lb.className = 'pill ' + (r.label === 'bullish' ? 'bull' : r.label === 'bearish' ? 'bear' : '');
  $('#gaugeMark').style.left = r.score + '%';
  setText('#compSummary', txt.summary);
  const ul = clear($('#compReasons'));
  txt.lines.forEach((l) => ul.appendChild(el('li', { class: l.state, text: l.text })));
  const tb = clear($('#judgeTable'));
  r.components.forEach((x) => {
    const v = x.key === 'bb' ? x.value.toFixed(2) : x.key === 'supertrend' || x.key === 'psar' || x.key === 'ma' || x.key === 'longMa' || x.key === 'ichimoku' ? p2(x.value) : fmtNum(x.value, 1);
    tb.appendChild(row(x.name, numTd(v), el('td', { class: stateCls(x.state), text: `${stateJa(x.state)}（${fmtScore(x.score)}）` }), numTd(String(x.weight))));
  });
  const used = new Set(r.components.map((x) => x.key));
  Object.keys(SG.DEFAULT_WEIGHTS).filter((k) => !used.has(k)).forEach((k) => tb.appendChild(row(SG.INDICATOR_NAMES[k], numTd('—'), el('td', { class: 'st-neutral', text: 'データ不足・除外' }), numTd('0'))));
}

function renderRefs(ctx, c) {
  const P = ctx.settings.params, i = c.length - 1, cl = c[i].close;
  const tb = clear($('#refTable'));
  const cci = I.cci(c, P.cci)[i], wr = I.williamsR(c, P.willr)[i], rc = I.roc(c, P.roc)[i], mo = I.momentum(c, P.mom)[i];
  const at = I.atr(c, P.atr)[i], hv = I.historicalVolatility(c, P.hv, I.periodsPerYearFor(ctx.intervalSec()))[i];
  const vw = ctx.intervalSec() < 86400 ? I.vwap(c, P.vwapReset)[i] : null;
  const f = (v, d = 1) => (v === null ? '—' : fmtNum(v, d));
  tb.appendChild(row(`CCI(${P.cci})`, numTd(f(cci)), el('td', { text: cci === null ? '' : cci > 100 ? '+100 超（強い／行き過ぎ注意）' : cci < -100 ? '−100 未満（弱い／行き過ぎ注意）' : '±100 の範囲' })));
  tb.appendChild(row(`ウィリアムズ%R(${P.willr})`, numTd(f(wr)), el('td', { text: wr === null ? '' : wr > -20 ? '−20 超（買われすぎ圏）' : wr < -80 ? '−80 未満（売られすぎ圏）' : '中間' })));
  tb.appendChild(row(`ROC(${P.roc})`, numTd(rc === null ? '—' : fmtSigned(rc, 2) + '%'), el('td', { text: rc === null ? '' : rc > 0 ? '上向き' : '下向き' })));
  tb.appendChild(row(`モメンタム(${P.mom})`, numTd(mo === null ? '—' : fmtSigned(mo, 2)), el('td', { text: mo === null ? '' : mo > 0 ? '上向き' : '下向き' })));
  tb.appendChild(row('VWAP（日次）', numTd(vw === null ? '—' : p2(vw)), el('td', { text: vw === null ? '日足以上は非表示' : cl > vw ? '価格は VWAP の上' : '価格は VWAP の下' })));
  tb.appendChild(row(`ATR(${P.atr})`, numTd(at === null ? '—' : p2(at)), el('td', { text: '1本あたりの平均値幅' })));
  tb.appendChild(row(`HV(${P.hv})`, numTd(hv === null ? '—' : fmtNum(hv, 1) + '%'), el('td', { text: '年率換算（24時間取引のため目安）' })));
}

function renderSignals(ctx, c) {
  const P = ctx.settings.params;
  const box = clear($('#signalList'));
  const items = [];
  const recent = (idx) => idx >= c.length - 30;
  I.crossings(I.ema(c, P.emaFast), I.ema(c, P.emaSlow)).filter((x) => recent(x.index)).forEach((x) => items.push([x.index, `EMA${P.emaFast}/${P.emaSlow} ${x.type === 'up' ? 'ゴールデンクロス' : 'デッドクロス'}`]));
  const m = I.macd(c, P.macdFast, P.macdSlow, P.macdSignal);
  I.crossings(m.macd, m.signal).filter((x) => recent(x.index)).forEach((x) => items.push([x.index, `MACD がシグナルを${x.type === 'up' ? '上抜け' : '下抜け'}`]));
  const r = I.rsi(c, P.rsi);
  for (const lv of [70, 30]) I.crossings(r, lv).filter((x) => recent(x.index)).forEach((x) => items.push([x.index, `RSI が ${lv} を${x.type === 'up' ? '上抜け' : '下抜け'}`]));
  SG.divergence(c, r).forEach((d) => items.push([d.toIndex, `${d.type === 'bullish' ? '強気' : '弱気'}ダイバージェンスの可能性（RSI）`]));
  for (let i = Math.max(2, c.length - 10); i < c.length; i++) SG.candlePatterns(c, i).forEach((p) => items.push([i, `${SG.PATTERN_NAMES[p]}（パターン出現）`]));
  items.sort((a, b) => b[0] - a[0]);
  if (!items.length) box.appendChild(el('div', { class: 'it', text: '直近30本に目立ったクロス・パターンはありません' }));
  items.slice(0, 15).forEach(([i, t]) => box.appendChild(el('div', { class: 'it', text: `${fmtJSTmd(c[i].time * 1000)}　${t}${i === c.length - 1 ? '（形成中の足）' : ''}` })));
  const sq = SG.squeeze(c);
  box.appendChild(el('div', { class: 'it', text: `スクイーズ: ${sq.squeeze ? 'あり（BB が KC の内側）' : 'なし'}／BB 幅の順位（直近120本）${sq.bandwidthPercentile === null ? '—' : sq.bandwidthPercentile.toFixed(0) + '%'}／ATR÷平均ATR ${sq.atrRatio === null ? '—' : sq.atrRatio.toFixed(2)}` }));
}

function renderLevels(ctx) {
  const c = ctx.candles();
  if (!c.length) return;
  // 日足はローソク足と出典が合うものだけ使う（B1・13-1）。出典を必ず書く
  const lv = ctx.ctrl.levelsInfo();
  const daily = lv.daily || [];
  setText('#levelSource', lv.note);
  $('#levelSource').className = 'small ' + (lv.mode === 'real-mixed' || lv.mode === 'none' ? 'warn' : lv.mode === 'aggregate' ? 'note-dim' : '');
  const price = ctx.lastPrice();
  const tb = clear($('#pivotTable'));
  if (daily.length >= 2) {
    const pd = daily[daily.length - 2];
    const pv = L.pivots(pd.high, pd.low, pd.close, pivotMethod);
    const keys = ['R4', 'R3', 'R2', 'R1', 'P', 'S1', 'S2', 'S3', 'S4'].filter((k) => k in pv);
    keys.forEach((k) => tb.appendChild(row(k, numTd(p2(pv[k]), k.startsWith('R') ? 'st-bear' : k.startsWith('S') ? 'st-bull' : ''), numTd(price ? fmtSigned(pv[k] - price) : '—'))));
    tb.appendChild(row(el('td', { class: 'small', text: `前日（UTC）: 高 ${p2(pd.high)} 安 ${p2(pd.low)} 終 ${p2(pd.close)}`, colSpan: 3 })));
  }
  const hl = clear($('#prevHLTable'));
  const addHL = (name, arr) => { if (arr.length >= 2) { const x = arr[arr.length - 2]; hl.appendChild(row(name, numTd('高 ' + p2(x.high)), numTd('安 ' + p2(x.low)))); } };
  addHL('前日', daily); addHL('前週', I.aggregatePeriod(daily, 'week')); addHL('前月', I.aggregatePeriod(daily, 'month'));
  const sr = L.supportResistance(c);
  const srt = clear($('#srTable'));
  if (!sr.levels.length) srt.appendChild(row('検出なし'));
  sr.levels.forEach((x) => srt.appendChild(row(x.type === 'resistance' ? 'レジスタンス' : 'サポート', numTd(p2(x.level), x.type === 'resistance' ? 'st-bear' : 'st-bull'), numTd(`${x.touches}回`))));
  const f = L.fibonacciAuto(c, 100);
  const ft = clear($('#fibTable'));
  if (f) {
    ft.appendChild(row(el('td', { class: 'small', colSpan: 2, text: `${f.direction === 'up' ? '上昇波（安値→高値）' : '下降波（高値→安値）'} 高 ${p2(f.high)} / 安 ${p2(f.low)}` })));
    f.levels.forEach((x) => ft.appendChild(row(`${(x.ratio * 100).toFixed(1)}%`, numTd(p2(x.price)))));
    f.extensions.forEach((x) => ft.appendChild(row(`拡張 ${(x.ratio * 100).toFixed(1)}%`, numTd(p2(x.price)))));
  }
  if (price) {
    const r50 = L.roundNumbers(price, 50, 3);
    setText('#roundText', `上: ${r50.above.join(' / ')}　下: ${r50.below.join(' / ')}（$100 刻みは特に意識されやすい）`);
  }
}

function bar(container, label, value, maxAbs, text, color) {
  const pct = maxAbs ? Math.min(100, (Math.abs(value) / maxAbs) * 100) : 0;
  const fill = el('div', { class: 'bar-fill', style: `left:${value >= 0 ? 50 : 50 - pct / 2}%;width:${pct / 2}%;background:${color || (value >= 0 ? 'var(--up)' : 'var(--down)')}` });
  container.appendChild(el('div', { class: 'bar-row' }, el('span', { text: label }), el('div', { class: 'bar-track' }, fill), el('span', { class: 'num', text })));
}
function barPos(container, label, value, max, text) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  container.appendChild(el('div', { class: 'bar-row' }, el('span', { text: label }), el('div', { class: 'bar-track' }, el('div', { class: 'bar-fill', style: `left:0;width:${pct}%;background:var(--gold)` })), el('span', { class: 'num', text })));
}

let lastHeatKey = null;
async function renderStats(ctx) {
  const lv = ctx.ctrl.levelsInfo();
  const daily = lv.daily || [];
  const tb = clear($('#statsTable'));
  const { adr, progress: prog } = ctx.ctrl.adrInfo();
  tb.appendChild(row('ADR(14日)', numTd(adr === null ? '—' : '$' + p2(adr))));
  tb.appendChild(row('本日の値幅 / 消化率', numTd(daily.length ? `$${p2(daily[daily.length - 1].high - daily[daily.length - 1].low)} / ${prog === null ? '—' : prog.toFixed(0) + '%'}` : '—')));
  const hv = daily.length >= 15 ? I.historicalVolatility(daily, 20, 252) : [];
  tb.appendChild(row('HV(20日・年率)', numTd(hv[hv.length - 1] === null || hv[hv.length - 1] === undefined ? '—' : fmtNum(hv[hv.length - 1], 1) + '%')));
  const rt = clear($('#returnsTable'));
  const pr = daily.length >= 15 ? ST.periodReturns(daily) : {};
  for (const [k, n] of [['w1', '1週間'], ['m1', '1か月'], ['m3', '3か月'], ['y1', '1年']]) rt.appendChild(row(n, numTd(pr[k] === null || pr[k] === undefined ? 'データ不足' : fmtSigned(pr[k], 2) + '%', pr[k] > 0 ? 'st-bull' : pr[k] < 0 ? 'st-bear' : '')));
  rt.appendChild(row(el('td', { class: 'small', colSpan: 2, text: `日足 ${daily.length} 本（${lv.note}）` })));
  // ヒートマップは base・gen が変わったか 10 分たったときだけ描き直す（N11。描画のたびに取得しない）
  const tag = ctx.tag();
  const heatKey = tag ? `${tag.base}:${tag.gen}:${Math.floor(Date.now() / 600000)}` : null;
  if (!heatKey || heatKey === lastHeatKey) return;
  lastHeatKey = heatKey;
  try {
    const h1 = await ctx.ctrl.getH1(); // 1時間足は base（データの出どころ）ごとに持つ（N8）。取得中なら合流
    if (h1 && h1.candles.length) renderHeatmap(h1.candles, h1.tag);
    else { lastHeatKey = null; clear($('#heatmap')); clear($('#weekdayBars')).appendChild(el('div', { class: 'small', text: '1時間足を取得できませんでした' })); }
  } catch { /* noop */ }
}

function renderHeatmap(h1, tag) {
  const grid = ST.volatilityHeatmap(h1);
  const box = clear($('#heatmap'));
  const all = grid.flat().filter((v) => v !== null);
  const max = Math.max(...all, 1e-9), min = Math.min(...all, 0);
  const wd = ['日', '月', '火', '水', '木', '金', '土'];
  box.appendChild(el('div', { text: '' }));
  for (let h = 0; h < 24; h++) box.appendChild(el('div', { class: 'small', text: h % 3 === 0 ? String(h) : '' }));
  for (let d = 0; d < 7; d++) {
    box.appendChild(el('div', { class: 'small', text: wd[d] }));
    for (let h = 0; h < 24; h++) {
      const v = grid[d][h];
      const a = v === null ? 0 : (v - min) / (max - min || 1);
      box.appendChild(el('div', { title: v === null ? 'データなし' : `${wd[d]} ${h}時 平均値幅 $${v.toFixed(2)}`, style: `background:rgba(245,197,66,${(0.08 + a * 0.85).toFixed(2)})` }));
    }
  }
  const wbox = clear($('#weekdayBars'));
  const w = ST.volatilityByWeekday(h1);
  const wmax = Math.max(...w.map((x) => x.avgRange || 0), 1e-9);
  w.forEach((x) => barPos(wbox, wd[x.weekday], x.avgRange || 0, wmax, x.avgRange === null ? '—' : '$' + x.avgRange.toFixed(2)));
  wbox.appendChild(el('div', { class: 'small', text: `1時間足 ${h1.length} 本の H−L 平均（${tag ? D.SHORT_NAMES[tag.base] || '' : ''}・先物のため週末も含む）` }));
}

async function getXaus() {
  const cached = store.readJSON(store.KEYS.xaus, null);
  if (cached && Date.now() - cached.at < 6 * 3600 * 1000 && Array.isArray(cached.rows)) return cached.rows;
  const rows = await D.fetchXausHistory();
  store.writeJSON(store.KEYS.xaus, { at: Date.now(), rows });
  return rows;
}

async function loadSeason() {
  const box = clear($('#seasonBars'));
  box.appendChild(el('div', { class: 'small', text: '読み込み中…' }));
  try {
    const rows = await getXaus();
    const s = ST.monthlySeasonality(rows);
    clear(box);
    const max = Math.max(...s.map((x) => Math.abs(x.avgReturn || 0)), 1e-9);
    s.forEach((x) => bar(box, `${x.month}月`, x.avgReturn || 0, max, x.avgReturn === null ? '—' : `${fmtSigned(x.avgReturn, 2)}%`));
    box.appendChild(el('div', { class: 'small', text: `xaus.com 日足 ${rows.length} 本（${rows.length ? new Date(rows[0].time * 1000).toISOString().slice(0, 10) : ''}〜）。過去の平均で、将来を示すものではありません。` }));
  } catch (e) {
    clear(box).appendChild(el('div', { class: 'small', text: '取得できませんでした（' + e.message + '）' }));
  }
}

async function loadCorr(ctx) {
  const tb = clear($('#corrTable'));
  tb.appendChild(row('読み込み中…'));
  const out = [];
  try {
    const rows = await getXaus();
    const from = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const uj = await D.fetchUsdJpyHistory(from);
    const gold = rows.filter((r) => r.time >= Date.parse(from) / 1000);
    const c = ST.returnCorrelation(gold, uj);
    out.push(['金 vs USD/JPY（1年・日次リターン）', c.r === null ? '—' : c.r.toFixed(2), `${c.n} 日`]);
  } catch (e) { out.push(['金 vs USD/JPY', '取得失敗', e.message]); }
  try {
    const d = await D.fetchDxyRates();
    out.push(['ドル指数（近似・ECB 日次）', ST.dxyApprox(d.rates).toFixed(2), d.date || '']);
  } catch (e) { out.push(['ドル指数（近似）', '取得失敗', e.message]); }
  if (ctx.isDemo()) out.push(['金銀比', '—', 'デモ中は表示しません']);
  else if (ctx.state.silver) {
    const g = ctx.state.spot ? ctx.state.spot.price : ctx.lastPrice();
    out.push(['金銀比', (g / ctx.state.silver).toFixed(2), '銀 $' + p2(ctx.state.silver)]);
  }
  clear(tb);
  out.forEach((r) => tb.appendChild(row(r[0], numTd(r[1]), el('td', { class: 'small', text: r[2] }))));
  tb.appendChild(row(el('td', { class: 'small', colSpan: 3, text: '金はドル高（ドル指数上昇）で下がりやすいと言われます。相関は期間で変わります。米10年債利回りは無料のブラウザ向け API が無いため未対応です。' })));
}

let derivAt = 0;
export async function loadDerivatives() {
  if (Date.now() - derivAt < 5 * 60 * 1000) return;
  derivAt = Date.now();
  const tb = clear($('#derivTable'));
  try {
    const d = await D.fetchDerivatives();
    tb.appendChild(row('建玉（枚数＝oz）', numTd(fmtNum(d.openInterest, 0))));
    tb.appendChild(row('資金調達率', numTd((d.fundingRate * 100).toFixed(4) + '%'), el('td', { class: 'small', text: d.fundingRate > 0 ? 'ロングが支払い（買い優勢）' : d.fundingRate < 0 ? 'ショートが支払い（売り優勢）' : '支払いなし（中立）' })));
    tb.appendChild(row(el('td', { class: 'small', colSpan: 3, text: `出典: ${d.source} XAUUSDT 無期限先物` })));
  } catch (e) {
    derivAt = 0;
    tb.appendChild(row('取得できませんでした', e.message));
  }
}

async function loadMtf(ctx, retries = 0) {
  const btn = $('#btnMtf');
  btn.disabled = true;
  const tb = clear($('#mtfTable'));
  setText('#mtfAgree', '');
  const tfs = ['5m', '15m', '1h', '4h', '1d'];
  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  const gen0 = ctx.ctrl.state.gen;
  // データ元が変わった（gen が上がった）ら、表を空にして新しいデータ元で最初から取り直す（R3-3。中断を「取得失敗」と見せない）
  const restart = () => {
    clear(tb).appendChild(row('データ元が変わったため取り直します…'));
    if (retries < 3) {
      // 新しいデータ元のローソク足が届くのを待ってから（最大 40 秒）
      const t0 = Date.now();
      const waitTag = () => (ctx.ctrl.state.tag && !ctx.ctrl.state.inflight.candles) || Date.now() - t0 > 40000 ? loadMtf(ctx, retries + 1) : setTimeout(waitTag, 300);
      setTimeout(waitTag, 300);
    }
    else { btn.disabled = false; clear(tb).appendChild(row('データ元の切り替えが続いたため中止しました。もう一度「読み込む」を押してください')); }
  };
  for (const tf of tfs) {
    if (ctx.ctrl.state.gen !== gen0) { restart(); return; }
    const tr = row(D.TIMEFRAMES[tf].label, '読込中…');
    tb.appendChild(tr);
    try {
      // 表示中の足と同じデータ元から取り、確定足で判定する（13-8）
      const r = await ctx.ctrl.getMtf(tf);
      if (ctx.ctrl.state.gen !== gen0) { restart(); return; }
      if (!r || r.candles.length < 31) throw new Error('取得失敗');
      const c = r.candles.slice(0, -1);
      const comp = SG.compositeScore(c, ctx.settings);
      const P = ctx.settings.params, i = c.length - 1;
      const rs = I.rsi(c, P.rsi)[i];
      const m = I.macd(c, P.macdFast, P.macdSlow, P.macdSignal);
      const a = I.adx(c, P.adx).adx[i];
      counts[comp.label]++;
      clear(tr);
      tr.appendChild(el('td', { text: D.TIMEFRAMES[tf].label + (r.tag.family === 'demo' ? '（デモ）' : r.tag.src === 'cache' ? '（キャッシュ）' : '') }));
      tr.appendChild(el('td', { class: comp.label === 'bullish' ? 'st-bull' : comp.label === 'bearish' ? 'st-bear' : 'st-neutral', text: SG.labelJa(comp.label) }));
      tr.appendChild(numTd(String(comp.score)));
      tr.appendChild(numTd(rs === null ? '—' : rs.toFixed(1)));
      tr.appendChild(el('td', { text: m.signal[i] === null ? '—' : m.macd[i] > m.signal[i] ? '上' : '下' }));
      tr.appendChild(numTd(a === null ? '—' : a.toFixed(1)));
    } catch (e) {
      clear(tr);
      tr.appendChild(el('td', { text: D.TIMEFRAMES[tf].label }));
      tr.appendChild(el('td', { colSpan: 5, text: '取得失敗' }));
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  setText('#mtfAgree', `一致度: 強気 ${counts.bullish} / 中立 ${counts.neutral} / 弱気 ${counts.bearish}（参考情報）`);
  btn.disabled = false;
  toast('マルチタイムフレームを更新しました');
}
