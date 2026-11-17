// トレード補助（ロット・証拠金・損益・ATR ストップ・RR・ベーシス・ADR・日記・アラート）純粋関数

export const OZ_TO_G = 31.1034768;

export function floorToStep(x, step) {
  return Math.floor(x / step + 1e-9) * step;
}

export function calcLot({ balance, accountCurrency = 'JPY', usdJpy = 150, riskPercent, entry, stop, contractSize = 100, lotStep = 0.01, minLot = 0.01, maxLot = 100 }) {
  const riskAmount = (balance * riskPercent) / 100;
  const riskUSD = accountCurrency === 'JPY' ? riskAmount / usdJpy : riskAmount;
  const dist = Math.abs(entry - stop);
  if (!(dist > 0)) return { error: 'STOP_EQUALS_ENTRY' };
  const lossPerLotUSD = dist * contractSize;
  const rawLots = riskUSD / lossPerLotUSD;
  const floored = floorToStep(rawLots, lotStep);
  const capped = floored > maxLot; // 2周目: 最大ロットで頭打ちにしたことを知らせる
  let lots = Math.min(floored, maxLot);
  lots = Math.round(lots * 1e8) / 1e8;
  let warning = null;
  if (lots < minLot) { lots = 0; warning = 'BELOW_MIN_LOT'; }
  else if (capped) warning = 'LOT_CAPPED';
  const actualRiskUSD = lots * lossPerLotUSD;
  const actualRiskAccount = accountCurrency === 'JPY' ? actualRiskUSD * usdJpy : actualRiskUSD;
  return { riskAmount, riskUSD, lossPerLotUSD, rawLots, lots, actualRiskUSD, actualRiskAccount, warning };
}

export function calcMargin({ lots, price, contractSize = 100, leverage = 25, accountCurrency = 'USD', usdJpy = 1 }) {
  const marginUSD = (lots * contractSize * price) / leverage;
  return { marginUSD, marginAccount: accountCurrency === 'JPY' ? marginUSD * usdJpy : marginUSD };
}

export function calcPnl({ side, entry, exit, exitPrice, lots, contractSize = 100, pipSize = 0.1, usdJpy = null }) {
  const ex = exit !== undefined ? exit : exitPrice;
  const priceDiff = side === 'buy' ? ex - entry : entry - ex;
  const pnlUSD = priceDiff * lots * contractSize;
  return { priceDiff, pips: priceDiff / pipSize, pnlUSD, pnlJPY: usdJpy === null || usdJpy === undefined ? null : pnlUSD * usdJpy };
}

export function atrStops(side, entry, atrValue, slMult = 1.5, rrList = [1, 2, 3]) {
  const d = atrValue * slMult;
  const stopLoss = side === 'buy' ? entry - d : entry + d;
  const takeProfits = rrList.map((r) => (side === 'buy' ? entry + d * r : entry - d * r));
  return { stopLoss, takeProfits, riskDistance: d };
}

export function riskReward(side, entry, stop, target) {
  const risk = side === 'buy' ? entry - stop : stop - entry;
  const reward = side === 'buy' ? target - entry : entry - target;
  return risk <= 0 ? null : reward / risk;
}

export function basis(futures, spot) {
  const diff = futures - spot;
  return { diff, pct: (diff / spot) * 100 };
}

// 平均日次値幅。最後の1本（本日・形成中）を除いた直近 period 日の H-L 平均
export function adr(dailyCandles, period = 14, includeToday = false) {
  const d = includeToday ? dailyCandles : dailyCandles.slice(0, -1);
  if (d.length < period) return null;
  const w = d.slice(-period);
  return w.reduce((a, x) => a + (x.high - x.low), 0) / period;
}
export function adrProgress(todayCandle, adrValue) {
  if (!todayCandle || !adrValue) return null;
  return ((todayCandle.high - todayCandle.low) / adrValue) * 100;
}

export function yenPrices(usdPrice, usdJpy) {
  const perOz = usdPrice * usdJpy;
  return { perOz, perGram: perOz / OZ_TO_G };
}

export function journalStats(trades) {
  const count = trades.length;
  const winsArr = trades.filter((t) => t.pnl > 0);
  const lossArr = trades.filter((t) => !(t.pnl > 0));
  const sumWin = winsArr.reduce((a, t) => a + t.pnl, 0);
  const sumLoss = lossArr.reduce((a, t) => a + t.pnl, 0);
  return {
    count,
    wins: winsArr.length,
    losses: lossArr.length,
    winRate: count ? (winsArr.length / count) * 100 : null,
    totalPnl: sumWin + sumLoss,
    avgWin: winsArr.length ? sumWin / winsArr.length : null,
    avgLoss: lossArr.length ? sumLoss / lossArr.length : null,
    profitFactor: sumLoss === 0 ? null : sumWin / Math.abs(sumLoss),
  };
}

// 通貨ごとの集計（通貨が混ざっていても足し合わせない。B12）
export function journalStatsByCurrency(trades, defaultCurrency = 'JPY') {
  const groups = {};
  for (const t of trades) { const c = t.currency === 'USD' || t.currency === 'JPY' ? t.currency : defaultCurrency; (groups[c] = groups[c] || []).push(t); }
  return Object.entries(groups).map(([currency, list]) => ({ currency, ...journalStats(list) }));
}

// 価格アラート。enabled === false のものは無視。発火した id の配列を返す
export function checkPriceAlerts(alerts, prevPrice, price) {
  if (prevPrice === null || prevPrice === undefined || price === null || price === undefined) return [];
  const fired = [];
  for (const a of alerts) {
    if (a.enabled === false) continue;
    if (a.direction === 'above' && prevPrice < a.price && price >= a.price) fired.push(a.id);
    if (a.direction === 'below' && prevPrice > a.price && price <= a.price) fired.push(a.id);
  }
  return fired;
}
