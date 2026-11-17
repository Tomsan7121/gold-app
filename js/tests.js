// 計算関数のテスト（docs/expected_values.json の期待値と照合）
import * as I from './indicators.js';
import * as L from './levels.js';
import * as T from './trade.js';
import * as S from './signals.js';
import * as ST from './stats.js';
import * as SE from './sessions.js';
import * as D from './data.js';
import { runRound2 } from './tests-round2.js';

const TOL = 1e-4;
const results = [];
function record(group, name, ok, detail = '') { results.push({ group, name, ok: !!ok, detail }); }
function approx(a, b, tol = TOL) {
  if (a === null || b === null || a === undefined || b === undefined) return a === b || (a == null && b == null);
  return Math.abs(a - b) <= tol;
}
function checkVal(group, name, actual, expected, tol = TOL) {
  const ok = typeof expected === 'string' ? actual === expected : approx(actual, expected, tol);
  record(group, name, ok, ok ? '' : `期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
}
function checkSeries(group, label, arr, expMap) {
  for (const [idx, ev] of Object.entries(expMap)) checkVal(group, `${label}[${idx}]`, arr[Number(idx)], ev);
}
function checkObj(group, label, obj, expObj, tol = TOL) {
  for (const [k, ev] of Object.entries(expObj)) {
    if (Array.isArray(ev)) ev.forEach((v, i) => checkVal(group, `${label}.${k}[${i}]`, obj[k] && obj[k][i], v, tol));
    else checkVal(group, `${label}.${k}`, obj[k], ev, tol);
  }
}
function checkEq(group, name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  record(group, name, a === e, a === e ? '' : `期待 ${e} / 実際 ${a}`);
}
function safe(group, name, fn) {
  try { fn(); } catch (e) { record(group, name, false, '例外: ' + (e && e.message)); }
}

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function resp(status, body) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
}

async function run() {
  const res = await fetch('./expected_values.json', { cache: 'no-store' });
  const J = await res.json();
  const C = J.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
  const E = J.expected;
  const snapshot = JSON.stringify(C);

  // ---- 指標 ----
  let g = '指標';
  safe(g, 'SMA', () => { checkSeries(g, 'SMA20', I.sma(C, 20), E.sma20); checkSeries(g, 'SMA5', I.sma(C, 5), E.sma5); });
  safe(g, 'EMA', () => { checkSeries(g, 'EMA20', I.ema(C, 20), E.ema20); checkSeries(g, 'EMA50', I.ema(C, 50), E.ema50); checkSeries(g, 'EMA9', I.ema(C, 9), E.ema9); });
  safe(g, 'RSI', () => checkSeries(g, 'RSI14', I.rsi(C, 14), E.rsi14));
  safe(g, 'MACD', () => { const m = I.macd(C); for (const k of ['macd', 'signal', 'hist']) checkSeries(g, 'MACD.' + k, m[k], E.macd[k]); });
  safe(g, 'BB', () => { const b = I.bollinger(C, 20, 2); for (const k of Object.keys(E.bb20_2)) checkSeries(g, 'BB.' + k, b[k], E.bb20_2[k]); });
  safe(g, 'TR', () => checkSeries(g, 'TR', I.trueRange(C), E.trueRange));
  safe(g, 'ATR', () => checkSeries(g, 'ATR14', I.atr(C, 14), E.atr14));
  safe(g, 'Stoch', () => { const s = I.stochastic(C, 14, 3, 3); for (const k of ['rawK', 'k', 'd']) checkSeries(g, 'Stoch.' + k, s[k], E.stoch14_3_3[k]); });
  safe(g, 'ADX', () => { const a = I.adx(C, 14); for (const k of ['plusDI', 'minusDI', 'dx', 'adx']) checkSeries(g, 'ADX.' + k, a[k], E.adx14[k]); });
  safe(g, 'CCI', () => checkSeries(g, 'CCI20', I.cci(C, 20), E.cci20));
  safe(g, 'W%R', () => checkSeries(g, 'W%R14', I.williamsR(C, 14), E.williamsR14));
  safe(g, 'ROC', () => checkSeries(g, 'ROC12', I.roc(C, 12), E.roc12));
  safe(g, 'MOM', () => checkSeries(g, 'MOM10', I.momentum(C, 10), E.momentum10));
  safe(g, 'HV', () => checkSeries(g, 'HV20', I.historicalVolatility(C, 20, 252), E.hv20_252));
  safe(g, 'Keltner', () => { const k = I.keltner(C, 20, 10, 2); for (const kk of ['middle', 'upper', 'lower']) checkSeries(g, 'KC.' + kk, k[kk], E.keltner20_10_2[kk]); });
  safe(g, '一目', () => { const k = I.ichimoku(C); for (const kk of ['tenkan', 'kijun', 'senkouA', 'senkouB']) checkSeries(g, '一目.' + kk, k[kk], E.ichimoku[kk]); });
  safe(g, 'PSAR', () => {
    const p = I.parabolicSar(C);
    checkSeries(g, 'PSAR.sar', p.sar, E.psar.sar);
    checkSeries(g, 'PSAR.trend', p.trend, E.psar.trend);
    const flips = []; for (let i = 2; i < C.length; i++) if (p.trend[i] !== p.trend[i - 1]) flips.push(i);
    checkEq(g, 'PSAR 反転 index', flips, E.psar.flipIndexes);
  });
  safe(g, 'Supertrend', () => {
    const s = I.supertrend(C, 10, 3);
    checkSeries(g, 'ST.value', s.value, E.supertrend10_3.value);
    checkSeries(g, 'ST.direction', s.direction, E.supertrend10_3.direction);
    const flips = []; for (let i = 10; i < C.length; i++) if (s.direction[i] !== s.direction[i - 1]) flips.push(i);
    checkEq(g, 'ST 反転 index', flips, E.supertrend10_3.flipIndexes);
  });
  safe(g, 'VWAP', () => checkSeries(g, 'VWAP', I.vwap(C, 0), E.vwap));
  safe(g, '平均足', () => { const h = I.heikinAshi(C); for (const [idx, o] of Object.entries(E.heikinAshi)) checkObj(g, `HA[${idx}]`, h[Number(idx)], o); });

  // ---- 水準 ----
  g = '水準';
  safe(g, '日足集計', () => {
    const d = I.aggregateDaily(C);
    record(g, '日足集計 本数', d.length === E.dailyAggregate.length, `本数 ${d.length}`);
    E.dailyAggregate.forEach((e, i) => checkObj(g, `日足[${i}]`, d[i] || {}, e));
    const p = L.pivots(d[1].high, d[1].low, d[1].close, 'classic');
    checkObj(g, '前日ピボット', p, E.pivotsFromPrevDay.classic);
  });
  safe(g, 'ピボット固定', () => {
    const { high, low, close } = E.pivotsFixed.input;
    for (const m of ['classic', 'fibonacci', 'camarilla']) checkObj(g, `ピボット ${m}`, L.pivots(high, low, close, m), E.pivotsFixed[m]);
  });
  safe(g, 'スイング', () => {
    const sp = L.swingPoints(C, 3, 3);
    checkEq(g, 'スイング高値', sp.highs.map((p) => [p.index, p.price]), E.swingPoints3_3.highs);
    checkEq(g, 'スイング安値', sp.lows.map((p) => [p.index, p.price]), E.swingPoints3_3.lows);
  });
  safe(g, 'サポレジ', () => {
    const sr = L.supportResistance(C);
    checkVal(g, 'サポレジ tolerance', sr.tolerance, E.supportResistance.tolerance);
    record(g, 'サポレジ 本数', sr.levels.length === E.supportResistance.levels.length, `本数 ${sr.levels.length}`);
    E.supportResistance.levels.forEach((e, i) => {
      const a = sr.levels[i] || {};
      checkVal(g, `サポレジ[${i}].level`, a.level, e.level);
      checkVal(g, `サポレジ[${i}].touches`, a.touches, e.touches);
      checkVal(g, `サポレジ[${i}].type`, a.type, e.type);
    });
  });
  safe(g, 'フィボ', () => {
    const f = L.fibonacciAuto(C, 100), e = E.fibonacciAuto;
    for (const k of ['direction', 'high', 'low', 'highIndex', 'lowIndex']) checkVal(g, `フィボ.${k}`, f[k], e[k]);
    for (const [r, v] of Object.entries(e.levels)) { const it = f.levels.find((x) => x.ratio === parseFloat(r)); checkVal(g, `フィボ ${r}`, it && it.price, v); }
    for (const [r, v] of Object.entries(e.extensions)) { const it = f.extensions.find((x) => x.ratio === parseFloat(r)); checkVal(g, `フィボ拡張 ${r}`, it && it.price, v); }
  });
  safe(g, 'ラウンド', () => { const i = E.roundNumbers.input; checkEq(g, 'ラウンドナンバー', L.roundNumbers(i.price, i.step, i.count), E.roundNumbers.output); });

  // ---- トレード補助 ----
  g = 'トレード';
  safe(g, 'ロット', () => {
    E.lot.forEach((c, n) => {
      const r = T.calcLot(c.input);
      const { lots, warning, ...rest } = c.output;
      checkObj(g, `L${n + 1}`, r, rest);
      record(g, `L${n + 1}.lots 完全一致`, Math.round(r.lots * 1e8) / 1e8 === lots, `期待 ${lots} / 実際 ${r.lots}`);
      checkEq(g, `L${n + 1}.warning`, r.warning, warning);
    });
    checkEq(g, 'ロット entry=stop', T.calcLot({ balance: 1000, riskPercent: 1, entry: 4000, stop: 4000 }).error, 'STOP_EQUALS_ENTRY');
  });
  safe(g, '証拠金', () => checkObj(g, '証拠金', T.calcMargin(E.margin.input), E.margin.output));
  safe(g, '損益', () => checkObj(g, '損益', T.calcPnl(E.pnl.input), E.pnl.output));
  safe(g, 'ATRストップ', () => {
    for (const k of ['fixed', 'sellFixed', 'fromData']) {
      const i = E.atrStops[k].input;
      checkObj(g, `ATRストップ ${k}`, T.atrStops(i.side, i.entry, i.atr, i.slMult, i.rr || [1, 2, 3]), E.atrStops[k].output);
    }
  });
  safe(g, 'RR', () => {
    const i = E.riskReward.input;
    checkVal(g, 'リスクリワード', T.riskReward(i.side, i.entry, i.stop, i.target), E.riskReward.output);
    checkEq(g, 'リスクリワード（リスク0→null）', T.riskReward('buy', 4000, 4000, 4050), null);
  });
  safe(g, 'ベーシス', () => checkObj(g, 'ベーシス', T.basis(E.basis.input.futures, E.basis.input.spot), E.basis.output));
  safe(g, 'DXY', () => checkVal(g, 'DXY 近似', ST.dxyApprox(E.dxyApprox.input), E.dxyApprox.output));
  safe(g, 'ピアソン', () => {
    checkVal(g, 'ピアソン 小データ', ST.pearson(E.pearson.input.x, E.pearson.input.y), E.pearson.output);
    checkVal(g, 'ピアソン 固定データ', ST.pearson(C.map((c) => c.close), C.map((c) => c.volume)), E.pearsonData.output);
    checkEq(g, 'ピアソン 分散0→null', ST.pearson([1, 1, 1], [1, 2, 3]), null);
  });
  safe(g, '日記', () => {
    const s = T.journalStats([{ pnl: 100 }, { pnl: -50 }, { pnl: 200 }, { pnl: -50 }]);
    checkObj(g, '日記集計', s, { count: 4, wins: 2, losses: 2, winRate: 50, totalPnl: 200, avgWin: 150, avgLoss: -50, profitFactor: 3 });
    checkEq(g, '日記 負け0→PF null', T.journalStats([{ pnl: 10 }]).profitFactor, null);
  });
  safe(g, 'アラート', () => {
    const al = [{ id: 'a', price: 4000, direction: 'above' }, { id: 'b', price: 3990, direction: 'below' }, { id: 'c', price: 4000, direction: 'above', enabled: false }];
    checkEq(g, '価格アラート 上抜け', T.checkPriceAlerts(al, 3999, 4000.5), ['a']);
    checkEq(g, '価格アラート 下抜け', T.checkPriceAlerts(al, 3995, 3989), ['b']);
    checkEq(g, '価格アラート 変化なし', T.checkPriceAlerts(al, 3995, 3996), []);
  });
  safe(g, 'ADR', () => {
    const d = I.aggregateDaily(C);
    checkEq(g, 'ADR データ不足→null', T.adr(d, 14), null);
    checkVal(g, 'ADR(2)', T.adr(d, 2), ((4074.47 - 3999.42) + (4069.8 - 4034.71)) / 2);
  });

  // ---- 判定 ----
  g = '判定';
  safe(g, 'パターン', () => {
    for (const [name, c] of Object.entries(E.candlePatterns)) {
      const input = c.input ? c.input.map(([o, h, l, cl], i) => ({ time: i, open: o, high: h, low: l, close: cl, volume: 0 })) : C;
      checkEq(g, `パターン ${name}`, S.candlePatterns(input), c.output);
    }
  });
  safe(g, '総合', () => {
    const r = S.compositeScore(C);
    checkVal(g, '総合 score', r.score, E.composite.score, 0);
    checkVal(g, '総合 label', r.label, E.composite.label);
    checkVal(g, '総合 weightedSum', r.weightedSum, E.composite.weightedSum);
    checkVal(g, '総合 totalWeight', r.totalWeight, E.composite.totalWeight);
    checkEq(g, '総合 components', r.components.map((c) => ({ key: c.key, weight: c.weight, score: c.score })), E.composite.components);
    const txt = S.buildReasons(r);
    const banned = ['買うべき', '売るべき', '今すぐ', '必ず', '確実', 'エントリー推奨', '勝てる'];
    const all = [txt.summary, ...txt.lines.map((l) => l.text)].join('\n');
    record(g, '根拠文に禁止表現なし', !banned.some((b) => all.includes(b)), all);
    record(g, '根拠文 件数=採用指標数', txt.lines.length === r.components.length);
  });
  safe(g, 'クロス', () => {
    checkEq(g, 'crossings', I.crossings([1, 2, 3, 2, 1], [2, 2, 2, 2, 2]), [{ index: 2, type: 'up' }, { index: 4, type: 'down' }]);
    checkEq(g, 'crossings 定数', I.crossings([65, 71, 69], 70), [{ index: 1, type: 'up' }, { index: 2, type: 'down' }]);
  });
  safe(g, 'ダイバージェンス', () => {
    const dv = S.divergence(C, I.rsi(C, 14));
    record(g, 'ダイバージェンス 形式', Array.isArray(dv) && dv.every((x) => ['bullish', 'bearish'].includes(x.type)), JSON.stringify(dv));
  });
  safe(g, 'スクイーズ', () => {
    const sq = S.squeeze(C);
    record(g, 'スクイーズ 形式', typeof sq.squeeze === 'boolean' && (sq.bandwidthPercentile === null || (sq.bandwidthPercentile >= 0 && sq.bandwidthPercentile <= 100)), JSON.stringify(sq));
  });

  // ---- 正規化・データ ----
  g = 'データ';
  safe(g, '正規化', () => {
    const b = D.parseBinanceKlines([[1794834780000, '3873.47', '3873.47', '3870.96', '3872.41', '829.162', 1794834839999, '3210275.14813', 2115, '235.980', '913693.15472', '0']]);
    checkEq(g, 'Binance 正規化', b, E.parse.binance);
    const o = D.parseOkxCandles({ code: '0', data: [['1794837600000', '3880.0', '3885.0', '3879.0', '3884.0', '500', '500.0', '1940000', '0'], ['1794834000000', '3875.2', '3881.2', '3871.2', '3871.8', '1048787', '1048.787', '4065683.3292', '1']], msg: '' });
    checkEq(g, 'OKX 正規化', o, E.parse.okx);
    const y = D.parseBybitKlines({ retCode: 0, result: { symbol: 'XAUUSDT', list: [['1794834900000', '3872.53', '3874.00', '3872.00', '3873.10', '0.300', '1161.9'], ['1794834840000', '3872.86', '3873.01', '3871.87', '3872.53', '0.548', '2122.11108']] } });
    checkEq(g, 'Bybit 正規化', y, E.parse.bybit);
    const t = D.parseTwelveData({ values: [{ datetime: '2026-11-16 13:01:00', open: '3875', high: '3876', low: '3874', close: '3875.5' }, { datetime: '2026-11-16 13:00:00', open: '3874', high: '3875.5', low: '3873', close: '3875' }], status: 'ok' });
    checkEq(g, 'Twelve Data 正規化（昇順・UTC）', t.map((x) => x.time), [Date.UTC(2026, 10, 16, 13, 0) / 1000, Date.UTC(2026, 10, 16, 13, 1) / 1000]);
    let threw = 0;
    try { D.parseOkxCandles({ code: '50011', msg: 'x', data: [] }); } catch { threw++; }
    try { D.parseBybitKlines({ retCode: 10001, retMsg: 'x' }); } catch { threw++; }
    try { D.parseTwelveData({ status: 'error', code: 401, message: 'x' }); } catch { threw++; }
    record(g, 'エラー応答で例外', threw === 3, `例外数 ${threw}`);
  });
  safe(g, '乱数', () => {
    const r = D.mulberry32(E.mulberry32.seed);
    E.mulberry32.first3.forEach((v, i) => checkVal(g, `mulberry32[${i}]`, r(), v, 1e-9));
  });
  safe(g, 'validate', () => {
    record(g, 'validate 正常データ', D.validateCandles(C).ok);
    const bad = C.map((c) => ({ ...c })); bad[5].high = bad[5].close - 1;
    record(g, 'validate high<close 不合格', !D.validateCandles(bad).ok);
    const dup = C.map((c) => ({ ...c })); dup[6].time = dup[5].time;
    record(g, 'validate time重複 不合格', !D.validateCandles(dup).ok);
    record(g, 'validate 空 不合格', !D.validateCandles([]).ok);
  });
  safe(g, 'デモ', () => {
    const a = D.generateDemoCandles({ seed: 7, count: 300, endTime: 1793790000 });
    const b = D.generateDemoCandles({ seed: 7, count: 300, endTime: 1793790000 });
    record(g, 'デモ 同seedで完全一致', JSON.stringify(a) === JSON.stringify(b));
    record(g, 'デモ validate 合格', D.validateCandles(a).ok, D.validateCandles(a).errors.join(','));
    record(g, 'デモ 本数', a.length === 300 && a[299].time === 1793790000);
  });

  // ---- 時間 ----
  g = '時間';
  safe(g, 'セッション', () => {
    const s1 = SE.getSessions(Date.parse('2026-11-16T13:30:00Z'));
    checkEq(g, 'セッション 11/16 13:30Z', s1, { active: ['london', 'newyork'], overlap: true });
    const s2 = SE.getSessions(Date.parse('2026-07-01T07:30:00Z'));
    checkEq(g, 'セッション 7/1 07:30Z', s2, { active: ['tokyo', 'london'], overlap: false });
    checkEq(g, 'セッション 土曜', SE.getSessions(Date.parse('2026-11-14T12:00:00Z')).active, []);
  });
  safe(g, '週末', () => {
    checkEq(g, '休場 土曜', SE.isSpotMarketClosed(Date.parse('2026-11-14T12:00:00Z')), true);
    checkEq(g, '休場 金NY17:30', SE.isSpotMarketClosed(Date.parse('2026-11-13T22:30:00Z')), true);
    checkEq(g, '休場 日NY18:30', SE.isSpotMarketClosed(Date.parse('2026-11-15T23:30:00Z')), false);
    checkEq(g, '休場 月曜', SE.isSpotMarketClosed(Date.parse('2026-11-16T13:30:00Z')), false);
  });

  // ---- 性質テスト ----
  g = '性質';
  const fns = {
    sma: (c) => I.sma(c, 20), ema: (c) => I.ema(c, 20), rsi: (c) => I.rsi(c, 14), atr: (c) => I.atr(c, 14),
    cci: (c) => I.cci(c, 20), williamsR: (c) => I.williamsR(c, 14), roc: (c) => I.roc(c, 12), momentum: (c) => I.momentum(c, 10),
    vwap: (c) => I.vwap(c), hv: (c) => I.historicalVolatility(c, 20), trueRange: (c) => I.trueRange(c),
    'macd.macd': (c) => I.macd(c).macd, 'bb.upper': (c) => I.bollinger(c).upper, 'stoch.k': (c) => I.stochastic(c).k,
    'adx.adx': (c) => I.adx(c).adx, 'kc.upper': (c) => I.keltner(c).upper, 'ichi.senkouB': (c) => I.ichimoku(c).senkouB,
    'psar.sar': (c) => I.parabolicSar(c).sar, 'st.value': (c) => I.supertrend(c).value, heikinAshi: (c) => I.heikinAshi(c),
  };
  const insufficient = new Set(['sma', 'ema', 'rsi', 'atr', 'cci', 'williamsR', 'roc', 'momentum', 'hv', 'macd.macd', 'bb.upper', 'stoch.k', 'adx.adx', 'kc.upper', 'ichi.senkouB', 'st.value']);
  for (const [name, fn] of Object.entries(fns)) {
    safe(g, name, () => {
      record(g, `${name} 出力長=入力長`, fn(C).length === C.length);
      record(g, `${name} 空配列→空配列`, fn([]).length === 0);
      if (insufficient.has(name)) { const o = fn(C.slice(0, 5)); record(g, `${name} データ不足→全null`, o.length === 5 && o.every((v) => v === null)); }
    });
  }
  record(g, '不正な period → 全null', I.sma(C, 0).every((v) => v === null) && I.ema(C, 2.5).every((v) => v === null) && I.rsi(C, -1).every((v) => v === null));
  record(g, '入力配列が変更されていない', JSON.stringify(C) === snapshot);

  // ---- 取得の切替（fetch を差し替え） ----
  g = '取得切替';
  const okxRows = C.slice(0, 30).reverse().map((c) => [String(c.time * 1000), String(c.open), String(c.high), String(c.low), String(c.close), '1', String(c.volume), '0', '1']);
  const NOW = Date.parse('2026-11-16T13:00:00Z');
  await (async () => {
    const st = memStorage();
    const stub = (url) => (url.includes('binance') ? resp(451, {}) : url.includes('okx') ? resp(200, { code: '0', data: okxRows, msg: '' }) : resp(500, {}));
    const r = await D.fetchCandlesWithFallback('1h', 30, { fetchFn: stub, storage: st, now: NOW });
    checkEq(g, 'Binance 451 → OKX 成功', r.source, 'okx');
    checkEq(g, '試行の記録', r.attempts.map((a) => [a.source, a.ok, a.status]), [['binance', false, 451], ['okx', true, 200]]);
    const bl = JSON.parse(st.getItem('ga:blockedSources') || '{}');
    record(g, '451 の記録が残る（24時間）', bl.binance && bl.binance.status === 451 && bl.binance.until === NOW + 86400000, JSON.stringify(bl));
    record(g, 'キャッシュ保存', !!st.getItem('ga:cache:1h'));
    let binanceCalled = false;
    const stub2 = (url) => { if (url.includes('binance')) binanceCalled = true; return stub(url); };
    const r2 = await D.fetchCandlesWithFallback('1h', 30, { fetchFn: stub2, storage: st, now: NOW + 3600000 });
    record(g, '記録中は Binance を飛ばす', !binanceCalled && r2.source === 'okx' && r2.attempts[0].skipped === true);
    const r3 = await D.fetchCandlesWithFallback('1h', 30, { fetchFn: () => resp(500, {}), storage: st, now: NOW + 2 * 3600000 });
    record(g, '全失敗・キャッシュあり → cache', r3.source === 'cache' && r3.candles.length === 30 && r3.cacheAgeMin === 60, `${r3.source} ${r3.cacheAgeMin}`);
  })().catch((e) => record(g, '切替テスト1', false, '例外: ' + e.message));
  await (async () => {
    const st = memStorage();
    const r = await D.fetchCandlesWithFallback('1h', 100, { fetchFn: () => Promise.reject(new TypeError('Failed to fetch')), storage: st, now: NOW });
    record(g, '全失敗・キャッシュ無し → demo', r.source === 'demo' && r.candles.length === 100 && D.validateCandles(r.candles).ok);
    record(g, 'ネットワークエラーは記録しない', st.getItem('ga:blockedSources') === null);
    const st2 = memStorage();
    await D.fetchCandlesWithFallback('1h', 30, { fetchFn: (u) => (u.includes('binance') ? resp(429, {}) : resp(500, {})), storage: st2, now: NOW });
    const bl = JSON.parse(st2.getItem('ga:blockedSources') || '{}');
    record(g, '429 → 5分休止', bl.binance && bl.binance.until === NOW + 300000, JSON.stringify(bl));
    const st3 = memStorage();
    const r4 = await D.fetchCandlesWithFallback('1h', 30, { fetchFn: (u) => (u.includes('binance') ? resp(200, [[1, '4000', '3990', '4001', '4000', '1']]) : resp(200, { code: '0', data: okxRows, msg: '' })), storage: st3, now: NOW });
    record(g, '不正データ → 次のソース', r4.source === 'okx');
  })().catch((e) => record(g, '切替テスト2', false, '例外: ' + e.message));

  // ---- 2周目（13-9 のテストケースと expected.round2） ----
  document.getElementById('summary').textContent = '2周目のテストを実行中…（通信・状態遷移、数秒かかります）';
  await runRound2(J, { record, checkVal, checkEq }).catch((e) => record('2周目', '実行', false, '例外: ' + e.message));

  render();
}

function render() {
  const pass = results.filter((r) => r.ok).length, fail = results.length - pass;
  const sum = document.getElementById('summary');
  sum.textContent = `合格 ${pass} / 不合格 ${fail}（全 ${results.length} 件）`;
  sum.className = fail ? 'sum fail' : 'sum pass';
  document.body.dataset.pass = String(pass);
  document.body.dataset.fail = String(fail);
  document.title = `テスト: 合格 ${pass} / 不合格 ${fail}`;
  const tbody = document.getElementById('rows');
  const onlyFail = document.getElementById('onlyFail').checked;
  tbody.textContent = '';
  for (const r of results) {
    if (onlyFail && r.ok) continue;
    const tr = document.createElement('tr');
    tr.className = r.ok ? 'ok' : 'ng';
    for (const v of [r.ok ? '合格' : '不合格', r.group, r.name, r.detail]) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }
    tbody.appendChild(tr);
  }
  console.log(`[tests] pass=${pass} fail=${fail}`);
}

document.getElementById('onlyFail').addEventListener('change', render);
run().catch((e) => {
  const sum = document.getElementById('summary');
  sum.textContent = 'テストの実行に失敗しました: ' + e.message;
  sum.className = 'sum fail';
  document.body.dataset.fail = 'error';
});
