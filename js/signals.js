// 判定（指標ごとの判定・総合スコア・パターン・ダイバージェンス・スクイーズ）純粋関数
import * as I from './indicators.js';
import { swingPoints } from './levels.js';

export const DEFAULT_WEIGHTS = { ma: 2.0, longMa: 1.5, macd: 1.5, adx: 1.5, supertrend: 1.0, ichimoku: 1.0, psar: 0.5, rsi: 1.0, stoch: 0.5, bb: 0.5 };
export const DEFAULT_PARAMS = {
  emaFast: 20, emaSlow: 50, smaLong: 200, rsi: 14,
  macdFast: 12, macdSlow: 26, macdSignal: 9,
  stochK: 14, stochSmooth: 3, stochD: 3,
  bbPeriod: 20, bbMult: 2, adx: 14,
  stPeriod: 10, stMult: 3,
  psarStart: 0.02, psarStep: 0.02, psarMax: 0.2,
  ichiTenkan: 9, ichiKijun: 26, ichiSenkouB: 52, ichiDisp: 26,
};
export const INDICATOR_NAMES = {
  ma: '移動平均（EMA）', longMa: '長期線 SMA', macd: 'MACD', adx: 'ADX/DMI', supertrend: 'スーパートレンド',
  ichimoku: '一目均衡表', psar: 'パラボリックSAR', rsi: 'RSI', stoch: 'ストキャス', bb: 'ボリンジャー %B',
};
export const DISCLAIMER = 'これは過去の価格から機械的に計算した参考情報で、将来の値動きや売買を示すものではありません。';

const sign = (x) => (x === 0 ? 0 : x > 0 ? 1 : -1);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const p2 = (v) => v.toFixed(2);
const p1 = (v) => v.toFixed(1);
const fmtContrib = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1);

// 各指標の判定（データ不足のものは含めない）
export function evaluateIndicators(candles, settings = {}) {
  const P = { ...DEFAULT_PARAMS, ...(settings.params || {}) };
  const W = { ...DEFAULT_WEIGHTS, ...(settings.weights || {}) };
  const enabled = settings.enabled || {};
  const out = [];
  const n = candles.length;
  if (!n) return out;
  const i = n - 1;
  const cl = candles[i].close;
  const add = (key, score, value, text) => {
    if (enabled[key] === false) return;
    out.push({ key, name: INDICATOR_NAMES[key], weight: W[key], score, value, state: score > 0 ? 'bull' : score < 0 ? 'bear' : 'neutral', text });
  };

  const e20 = I.ema(candles, P.emaFast)[i], e50 = I.ema(candles, P.emaSlow)[i];
  if (e20 !== null && e50 !== null) {
    const a = sign(cl - e20), b = sign(e20 - e50);
    const s = (a + b) / 2;
    const t1 = `終値 ${p2(cl)} が EMA${P.emaFast}（${p2(e20)}）の${a >= 0 ? '上' : '下'}、EMA${P.emaFast} が EMA${P.emaSlow}（${p2(e50)}）の${b >= 0 ? '上' : '下'}`;
    const t2 = s === 1 ? '上昇トレンド寄り' : s === -1 ? '下落トレンド寄り' : s > 0 ? '混在 → やや上昇寄り' : s < 0 ? '混在 → やや下落寄り' : '混在 → 方向感なし';
    add('ma', s, e20, `${t1} → ${t2}`);
  }
  const s200 = I.sma(candles, P.smaLong)[i];
  if (s200 !== null) {
    const s = sign(cl - s200);
    add('longMa', s, s200, `終値が SMA${P.smaLong}（${p2(s200)}）の${s >= 0 ? '上 → 長期は上昇寄り' : '下 → 長期は下落寄り'}`);
  }
  const m = I.macd(candles, P.macdFast, P.macdSlow, P.macdSignal);
  if (m.signal[i] !== null) {
    const a = sign(m.macd[i] - m.signal[i]), b = sign(m.macd[i]);
    const s = (a + b) / 2;
    const t = s === 1 ? '上昇の勢い' : s === -1 ? '下落の勢い' : '勢いは混在';
    add('macd', s, m.macd[i], `MACD（${p2(m.macd[i])}）がシグナル（${p2(m.signal[i])}）の${a >= 0 ? '上' : '下'}、かつ 0 より${b >= 0 ? '上' : '下'} → ${t}`);
  }
  const a = I.adx(candles, P.adx);
  if (a.adx[i] !== null) {
    const d = sign(a.plusDI[i] - a.minusDI[i]);
    const av = a.adx[i];
    const s = d * (av >= 25 ? 1 : av >= 20 ? 0.5 : 0);
    const dir = d > 0 ? `+DI ${p1(a.plusDI[i])} > −DI ${p1(a.minusDI[i])} → 上昇トレンド寄り` : d < 0 ? `+DI ${p1(a.plusDI[i])} < −DI ${p1(a.minusDI[i])} → 下落トレンド寄り` : '+DI と −DI が同じ';
    const text = av < 20 ? `ADX ${p1(av)}（20 未満）→ トレンドが弱い（レンジの可能性）→ 判定に寄与せず`
      : av < 25 ? `ADX ${p1(av)}（20〜25＝トレンド形成途中）、${dir}` : `ADX ${p1(av)}（25 以上＝トレンドあり）、${dir}`;
    add('adx', s, av, text);
  }
  const st = I.supertrend(candles, P.stPeriod, P.stMult);
  if (st.direction[i] !== null) {
    const up = st.direction[i] === 'up';
    add('supertrend', up ? 1 : -1, st.value[i], up ? `スーパートレンドは上向き（下値目安 ${p2(st.value[i])}）` : `スーパートレンドは下向き（上値目安 ${p2(st.value[i])}）`);
  }
  const ich = I.ichimoku(candles, P.ichiTenkan, P.ichiKijun, P.ichiSenkouB, P.ichiDisp);
  const j = i - ich.displacement;
  if (j >= 0 && ich.senkouA[j] !== null && ich.senkouB[j] !== null) {
    const top = Math.max(ich.senkouA[j], ich.senkouB[j]), bot = Math.min(ich.senkouA[j], ich.senkouB[j]);
    const s = cl > top ? 1 : cl < bot ? -1 : 0;
    add('ichimoku', s, top, s > 0 ? `価格が雲の上（雲上限 ${p2(top)}）→ 上昇寄り` : s < 0 ? `価格が雲の下（雲下限 ${p2(bot)}）→ 下落寄り` : '雲の中 → 方向感なし');
  }
  const ps = I.parabolicSar(candles, P.psarStart, P.psarStep, P.psarMax);
  if (ps.trend[i] !== null) {
    const up = ps.trend[i] === 'up';
    add('psar', up ? 1 : -1, ps.sar[i], `パラボリック SAR（${p2(ps.sar[i])}）が価格の${up ? '下 → 上昇寄り' : '上 → 下落寄り'}`);
  }
  const r = I.rsi(candles, P.rsi)[i];
  if (r !== null) {
    const s = r >= 70 ? -0.5 : r <= 30 ? 0.5 : clamp((r - 50) / 20, -1, 1);
    const text = r >= 70 ? `RSI ${p1(r)}（70 以上）→ 買われすぎ水準。上昇の行き過ぎに注意`
      : r <= 30 ? `RSI ${p1(r)}（30 以下）→ 売られすぎ水準。下落の行き過ぎに注意`
      : `RSI ${p1(r)} → ${r > 50 ? '50 より上（やや強い）' : r < 50 ? '50 より下（やや弱い）' : '50 ちょうど'}`;
    add('rsi', s, r, text);
  }
  const so = I.stochastic(candles, P.stochK, P.stochSmooth, P.stochD);
  const k = so.k[i], dd = so.d[i];
  if (k !== null && dd !== null) {
    let s;
    if (k < 20 && k > dd) s = 1;
    else if (k > 80 && k < dd) s = -1;
    else s = 0.5 * sign(k - dd);
    const text = s === 1 ? `%K ${p1(k)} が売られすぎ圏で %D ${p1(dd)} を上回る → 反発の兆し`
      : s === -1 ? `%K ${p1(k)} が買われすぎ圏で %D ${p1(dd)} を下回る → 反落の兆し`
      : `%K ${p1(k)} が %D ${p1(dd)} の${k >= dd ? '上 → 短期は上向き' : '下 → 短期は下向き'}`;
    add('stoch', s, k, text);
  }
  const b = I.bollinger(candles, P.bbPeriod, P.bbMult).percentB[i];
  if (b !== null) {
    const s = b > 1 ? -0.5 : b < 0 ? 0.5 : 0.5 * sign(b - 0.5);
    const text = b > 1 ? `%B ${b.toFixed(2)}（上のバンドの外）→ 行き過ぎの可能性` : b < 0 ? `%B ${b.toFixed(2)}（下のバンドの外）→ 行き過ぎの可能性`
      : `%B ${b.toFixed(2)}（ミドルより${b >= 0.5 ? '上）→ 上側で推移' : '下）→ 下側で推移'}`;
    add('bb', s, b, text);
  }
  return out;
}

export function scoreLabel(score) {
  return score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral';
}
export function labelJa(label) {
  return label === 'bullish' ? '強気' : label === 'bearish' ? '弱気' : '中立';
}
export function strengthJa(score) {
  if (score >= 75) return '強気（強め）';
  if (score >= 60) return '強気（弱め）';
  if (score <= 25) return '弱気（強め）';
  if (score <= 40) return '弱気（弱め）';
  return '中立';
}

export function compositeScore(candles, settings = {}) {
  const components = evaluateIndicators(candles, settings);
  const totalWeight = components.reduce((a, c) => a + c.weight, 0);
  const weightedSum = components.reduce((a, c) => a + c.weight * c.score, 0);
  const score = totalWeight > 0 ? Math.round(50 + (50 * weightedSum) / totalWeight) : 50;
  const fewInputs = components.length < 4;
  const label = fewInputs ? 'neutral' : scoreLabel(score);
  return {
    score, label, weightedSum, totalWeight, components, fewInputs,
    bullCount: components.filter((c) => c.state === 'bull').length,
    bearCount: components.filter((c) => c.state === 'bear').length,
    neutralCount: components.filter((c) => c.state === 'neutral').length,
  };
}

// 根拠の文（|寄与| の大きい順）とまとめ文
export function buildReasons(result) {
  const lines = result.components
    .map((c) => ({ c, contrib: c.weight * c.score }))
    .sort((x, y) => Math.abs(y.contrib) - Math.abs(x.contrib))
    .map(({ c, contrib }) => ({ key: c.key, state: c.state, text: `【${c.name}】${c.text}（寄与 ${fmtContrib(contrib)}）` }));
  let summary;
  if (result.fewInputs) summary = '判定材料が少ないため、方向は判断できません（中立）。';
  else if (result.label === 'bullish') summary = `テクニカル指標は全体として上昇寄りです（スコア ${result.score}/100）。`;
  else if (result.label === 'bearish') summary = `テクニカル指標は全体として下落寄りです（スコア ${result.score}/100）。`;
  else summary = `指標の方向がそろっておらず、方向感は限定的です（スコア ${result.score}/100）。`;
  const dir = sign(result.weightedSum);
  if (dir !== 0) {
    const opp = result.components.filter((c) => sign(c.score) === -dir).sort((a, b) => Math.abs(b.weight * b.score) - Math.abs(a.weight * a.score))[0];
    if (opp) {
      const note = opp.key === 'rsi' ? (opp.value >= 70 ? 'RSI が買われすぎ水準です' : opp.value <= 30 ? 'RSI が売られすぎ水準です' : 'RSI が逆の方向を示しています')
        : `${opp.name} が逆の方向を示しています`;
      summary += `ただし ${note}。`;
    }
  }
  return { summary, lines, disclaimer: DISCLAIMER };
}

// 指標の寄与（score）を表示用に小数 1 桁へ丸める（RSI は連続値。B12）
export function fmtScore(s) {
  const v = Math.round(s * 10) / 10;
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}`;
}

// 指標アラートの候補（直近の確定足 i = n-2 で起きたもの）。通知するかどうか（初回は記録のみ・同じ足で 1 回）は呼び出し側
export function indicatorEvents(candles, opts = {}, params = {}) {
  const P = { ...DEFAULT_PARAMS, ...params };
  const c = candles, out = [];
  if (!c || c.length < 60 || !(opts.rsi || opts.emaCross || opts.stFlip)) return out;
  const i = c.length - 2;
  if (opts.rsi) {
    const r = I.rsi(c, P.rsi);
    for (const lvl of [70, 30]) I.crossings(r, lvl).filter((x) => x.index === i).forEach((x) => out.push({ key: `rsi${lvl}${x.type}`, title: `RSI が ${lvl} を${x.type === 'up' ? '上抜け' : '下抜け'}` }));
  }
  if (opts.emaCross) {
    I.crossings(I.ema(c, P.emaFast), I.ema(c, P.emaSlow)).filter((x) => x.index === i)
      .forEach((x) => out.push({ key: `ema${x.type}`, title: `EMA${P.emaFast}/${P.emaSlow} の${x.type === 'up' ? 'ゴールデンクロス' : 'デッドクロス'}` }));
  }
  if (opts.stFlip) {
    const s = I.supertrend(c, P.stPeriod, P.stMult);
    if (s.direction[i] && s.direction[i - 1] && s.direction[i] !== s.direction[i - 1]) out.push({ key: `st${s.direction[i]}`, title: `スーパートレンドが${s.direction[i] === 'up' ? '上向き' : '下向き'}に転換` });
  }
  return out;
}

export const PATTERN_NAMES = {
  doji: '十字線', bullishPinBar: '下ヒゲピンバー', bearishPinBar: '上ヒゲピンバー',
  bullishEngulfing: '陽の包み足', bearishEngulfing: '陰の包み足', morningStar: '明けの明星', eveningStar: '宵の明星',
};

export function candlePatterns(candles, i = candles.length - 1) {
  const res = [];
  if (i < 0 || i >= candles.length) return res;
  const x = candles[i];
  const body = Math.abs(x.close - x.open), rng = x.high - x.low;
  const upper = x.high - Math.max(x.open, x.close), lower = Math.min(x.open, x.close) - x.low;
  if (rng > 0 && body <= rng * 0.1) res.push('doji');
  if (rng > 0 && body > rng * 0.1) {
    if (lower >= body * 2 && upper <= body && lower >= rng * 0.6) res.push('bullishPinBar');
    if (upper >= body * 2 && lower <= body && upper >= rng * 0.6) res.push('bearishPinBar');
  }
  if (i >= 1) {
    const p = candles[i - 1];
    const pb = Math.abs(p.close - p.open);
    if (p.close < p.open && x.close > x.open && x.open <= p.close && x.close >= p.open && body > pb) res.push('bullishEngulfing');
    if (p.close > p.open && x.close < x.open && x.open >= p.close && x.close <= p.open && body > pb) res.push('bearishEngulfing');
  }
  if (i >= 2) {
    const a = candles[i - 2], b = candles[i - 1];
    const ab = Math.abs(a.close - a.open), bb = Math.abs(b.close - b.open);
    if (a.close < a.open && bb <= ab * 0.3 && x.close > x.open && x.close >= (a.open + a.close) / 2) res.push('morningStar');
    if (a.close > a.open && bb <= ab * 0.3 && x.close < x.open && x.close <= (a.open + a.close) / 2) res.push('eveningStar');
  }
  return res;
}

// ダイバージェンス。all=false: 直近2つのスイングのみ。all=true: 隣り合うスイングの全ペア（チャート表示用）
export function divergence(candles, oscValues, opts = {}) {
  const { left = 3, right = 3, minGap = 5, maxGap = 60, all = false } = opts;
  const sp = swingPoints(candles, left, right);
  const res = [];
  const check = (pts, type) => {
    const pairs = [];
    if (all) for (let k = 1; k < pts.length; k++) pairs.push([pts[k - 1], pts[k]]);
    else if (pts.length >= 2) pairs.push([pts[pts.length - 2], pts[pts.length - 1]]);
    for (const [p1, p2] of pairs) {
      const gap = p2.index - p1.index;
      if (gap < minGap || gap > maxGap) continue;
      const o1 = oscValues[p1.index], o2 = oscValues[p2.index];
      if (o1 === null || o2 === null || o1 === undefined || o2 === undefined) continue;
      if (type === 'bullish' && p2.price < p1.price && o2 > o1) res.push({ type, fromIndex: p1.index, toIndex: p2.index });
      if (type === 'bearish' && p2.price > p1.price && o2 < o1) res.push({ type, fromIndex: p1.index, toIndex: p2.index });
    }
  };
  check(sp.lows, 'bullish');
  check(sp.highs, 'bearish');
  return res.sort((a, b) => a.toIndex - b.toIndex);
}

export function squeeze(candles) {
  const n = candles.length;
  if (!n) return { squeeze: false, bandwidthPercentile: null, atrRatio: null };
  const i = n - 1;
  const bb = I.bollinger(candles, 20, 2);
  const kc = I.keltner(candles, 20, 10, 1.5);
  const sq = bb.upper[i] !== null && kc.upper[i] !== null && bb.upper[i] < kc.upper[i] && bb.lower[i] > kc.lower[i];
  const bws = bb.bandwidth.slice(Math.max(0, n - 120)).filter((v) => v !== null);
  let pct = null;
  if (bws.length >= 2 && bb.bandwidth[i] !== null) {
    const cur = bb.bandwidth[i];
    pct = (bws.filter((v) => v < cur).length / (bws.length - 1)) * 100;
  }
  const a = I.atr(candles, 14);
  const as = I.smaValues(a, 50);
  const atrRatio = a[i] !== null && as[i] !== null && as[i] !== 0 ? a[i] / as[i] : null;
  return { squeeze: sq, bandwidthPercentile: pct, atrRatio };
}
