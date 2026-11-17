// 水準（ピボット・スイング・サポレジ・フィボナッチ・ラウンドナンバー）純粋関数
import { atr } from './indicators.js';

export function pivots(high, low, close, method = 'classic') {
  const p = (high + low + close) / 3, r = high - low;
  if (method === 'classic') {
    return { P: p, R1: 2 * p - low, S1: 2 * p - high, R2: p + r, S2: p - r, R3: high + 2 * (p - low), S3: low - 2 * (high - p) };
  }
  if (method === 'fibonacci') {
    return { P: p, R1: p + 0.382 * r, S1: p - 0.382 * r, R2: p + 0.618 * r, S2: p - 0.618 * r, R3: p + 1.0 * r, S3: p - 1.0 * r };
  }
  if (method === 'camarilla') {
    return {
      P: p,
      R1: close + (r * 1.1) / 12, S1: close - (r * 1.1) / 12,
      R2: close + (r * 1.1) / 6, S2: close - (r * 1.1) / 6,
      R3: close + (r * 1.1) / 4, S3: close - (r * 1.1) / 4,
      R4: close + (r * 1.1) / 2, S4: close - (r * 1.1) / 2,
    };
  }
  throw new Error('unknown pivot method: ' + method);
}

export function swingPoints(candles, left = 3, right = 3) {
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const h = candles[i].high, l = candles[i].low;
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (!(h > candles[j].high)) isH = false;
      if (!(l < candles[j].low)) isL = false;
    }
    if (isH) highs.push({ index: i, time: candles[i].time, price: h });
    if (isL) lows.push({ index: i, time: candles[i].time, price: l });
  }
  return { highs, lows };
}

export function supportResistance(candles, opts = {}) {
  const { left = 3, right = 3, maxLevels = 6 } = opts;
  let tolerance = opts.tolerance;
  if (!candles.length) return { levels: [], tolerance: tolerance ?? null };
  if (tolerance === undefined || tolerance === null) {
    const a = atr(candles, 14);
    const last = a[a.length - 1];
    tolerance = last === null ? 0 : last * 0.5;
  }
  const sp = swingPoints(candles, left, right);
  const pts = [...sp.highs.map((p) => p.price), ...sp.lows.map((p) => p.price)].sort((a, b) => a - b);
  const clusters = [];
  for (const p of pts) {
    const lastC = clusters[clusters.length - 1];
    if (lastC && Math.abs(p - lastC.reduce((a, b) => a + b, 0) / lastC.length) <= tolerance) lastC.push(p);
    else clusters.push([p]);
  }
  const lastClose = candles[candles.length - 1].close;
  const lv = clusters.map((cl) => {
    const level = cl.reduce((a, b) => a + b, 0) / cl.length;
    return { level, touches: cl.length, type: level > lastClose ? 'resistance' : 'support' };
  });
  lv.sort((a, b) => b.touches - a.touches || Math.abs(a.level - lastClose) - Math.abs(b.level - lastClose));
  return { levels: lv.slice(0, maxLevels), tolerance };
}

export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
export const FIB_EXT = [1.272, 1.618];

// levels / extensions は [{ratio, price}] の配列（比率は数値）
export function fibonacciAuto(candles, lookback = 100) {
  if (!candles.length) return null;
  const off = Math.max(0, candles.length - lookback);
  let hiI = off, loI = off;
  for (let i = off; i < candles.length; i++) {
    if (candles[i].high > candles[hiI].high) hiI = i; // 同値なら古い方
    if (candles[i].low < candles[loI].low) loI = i;
  }
  const high = candles[hiI].high, low = candles[loI].low, rng = high - low;
  const up = hiI > loI;
  const levels = FIB_RATIOS.map((r) => ({ ratio: r, price: up ? high - r * rng : low + r * rng }));
  const extensions = FIB_EXT.map((r) => ({ ratio: r, price: up ? low + r * rng : high - r * rng }));
  return { direction: up ? 'up' : 'down', high, low, highIndex: hiI, lowIndex: loI, levels, extensions };
}

export function roundNumbers(price, step = 50, count = 3) {
  const base = Math.floor(price / step) * step;
  const below = [], above = [];
  for (let i = 0; i < count; i++) { below.push(base - step * i); above.push(base + step * (i + 1)); }
  return { above, below };
}
