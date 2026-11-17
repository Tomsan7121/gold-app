// 統計（相関・DXY 近似・期間リターン・時間帯別値幅・季節性）純粋関数

export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

// frankfurter(from=USD) の値（1ドルあたりの外貨）から DXY を近似
export function dxyApprox({ EUR, JPY, GBP, CAD, SEK, CHF }) {
  return 50.14348112 * EUR ** 0.576 * JPY ** 0.136 * GBP ** 0.119 * CAD ** 0.091 * SEK ** 0.042 * CHF ** 0.036;
}

export function periodReturns(dailyCandles) {
  const n = dailyCandles.length;
  const ret = (N) => (n > N ? (dailyCandles[n - 1].close / dailyCandles[n - 1 - N].close - 1) * 100 : null);
  return { w1: ret(5), m1: ret(21), m3: ret(63), y1: ret(252) };
}

const jstHour = (t) => Math.floor(((t + 9 * 3600) % 86400) / 3600);
const jstWeekday = (t) => new Date((t + 9 * 3600) * 1000).getUTCDay();

export function volatilityByHour(candles) {
  const acc = Array.from({ length: 24 }, (_, h) => ({ hourJST: h, sum: 0, count: 0 }));
  for (const c of candles) { const a = acc[jstHour(c.time)]; a.sum += c.high - c.low; a.count++; }
  return acc.map((a) => ({ hourJST: a.hourJST, avgRange: a.count ? a.sum / a.count : null, count: a.count }));
}

export function volatilityByWeekday(candles) {
  const acc = Array.from({ length: 7 }, (_, d) => ({ weekday: d, sum: 0, count: 0 }));
  for (const c of candles) { const a = acc[jstWeekday(c.time)]; a.sum += c.high - c.low; a.count++; }
  return acc.map((a) => ({ weekday: a.weekday, avgRange: a.count ? a.sum / a.count : null, count: a.count }));
}

// 曜日×時間帯のヒートマップ（JST）
export function volatilityHeatmap(candles) {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ sum: 0, count: 0 })));
  for (const c of candles) { const g = grid[jstWeekday(c.time)][jstHour(c.time)]; g.sum += c.high - c.low; g.count++; }
  return grid.map((row) => row.map((g) => (g.count ? g.sum / g.count : null)));
}

// 日次（time, close の配列）から月別の平均騰落率（%）
export function monthlySeasonality(daily) {
  const lastByMonth = new Map();
  for (const d of daily) {
    const dt = new Date(d.time * 1000);
    lastByMonth.set(dt.getUTCFullYear() * 12 + dt.getUTCMonth(), d.close);
  }
  const keys = [...lastByMonth.keys()].sort((a, b) => a - b);
  const acc = Array.from({ length: 12 }, (_, m) => ({ month: m + 1, sum: 0, count: 0, up: 0 }));
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] - keys[i - 1] !== 1) continue;
    const r = (lastByMonth.get(keys[i]) / lastByMonth.get(keys[i - 1]) - 1) * 100;
    const a = acc[keys[i] % 12];
    a.sum += r; a.count++; if (r > 0) a.up++;
  }
  return acc.map((a) => ({ month: a.month, avgReturn: a.count ? a.sum / a.count : null, count: a.count, upRate: a.count ? (a.up / a.count) * 100 : null }));
}

// 2つの日次系列（{time, close}）を日付で合わせ、日次リターン同士の相関を返す
export function returnCorrelation(a, b) {
  const mb = new Map(b.map((x) => [Math.floor(x.time / 86400), x.close]));
  const pairs = [];
  for (const x of a) { const d = Math.floor(x.time / 86400); if (mb.has(d)) pairs.push([x.close, mb.get(d)]); }
  const xs = [], ys = [];
  for (let i = 1; i < pairs.length; i++) {
    xs.push(Math.log(pairs[i][0] / pairs[i - 1][0]));
    ys.push(Math.log(pairs[i][1] / pairs[i - 1][1]));
  }
  return { r: pearson(xs, ys), n: xs.length };
}
