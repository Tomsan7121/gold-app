// チャート描画（Lightweight Charts 5.2.0、app/vendor に同梱）。読み込めなくても他の画面は動くように、失敗時は null を返す。
// 2周目（N3）: チャートを作り直すのは「構成」（時間足・データ元・表示設定）が変わったときだけ。
// 新しい足・確定した足は series.update() で差分だけを反映する。
import * as I from './indicators.js';
import * as L from './levels.js';
import { divergence, candlePatterns, PATTERN_NAMES } from './signals.js';
import { isSpotMarketClosed, getSessions } from './sessions.js';

export const LWC_URL = './vendor/lightweight-charts.standalone.production.js';
export const LWC_SRI = 'sha384-q1KYLSKHgBnW5tWYGGR8+6YV4/iPy31dILoF2I1OD7XiVUvHEp/TaxIQVmB0j3R2';

let libPromise = null;
export function loadChartLib(timeoutMs = 12000) {
  if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = LWC_URL;
    s.integrity = LWC_SRI; // 同梱ファイルの改変検知
    s.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), timeoutMs);
    s.onload = () => { clearTimeout(timer); resolve(window.LightweightCharts || null); };
    s.onerror = () => { clearTimeout(timer); resolve(null); };
    document.head.appendChild(s);
  });
  return libPromise;
}

const jstFull = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const jstHM = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const jstMD = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' });
const jstYM = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric' });
const jstY = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric' });

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
const toLine = (candles, vals) => {
  const out = [];
  for (let i = 0; i < candles.length; i++) if (vals[i] !== null && vals[i] !== undefined && Number.isFinite(vals[i])) out.push({ time: candles[i].time, value: vals[i] });
  return out;
};
const parsePeriods = (s) => String(s || '').split(/[,\s、]+/).map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= 1000).slice(0, 5);
const LINE_COLORS = ['#f5c542', '#4fc3f7', '#ba68c8', '#81c784', '#ff8a65'];
// 同じ配列に対する計算は 1 回だけ（BB の上・中・下など）
const memo = (fn) => { let lc = null, lv = null; return (cs) => { if (cs !== lc) { lc = cs; lv = fn(cs); } return lv; }; };
const MAX_BARS = 3000;

// 差分更新の方針（純粋関数・テスト用）。'update' = 同じ足の並びで最終足だけ変わった、'reset' = 新しい足が増えた（全系列を setData）、
// 'rebuild' = 並びがつながらない（作り直す）。どの場合もチャートの足は新しい配列と同じ本数・同じ時刻になる（N12）
export function planChartUpdate(old, newC) {
  if (!old || !old.length || !newC || !newC.length) return { mode: 'rebuild' };
  const oLast = old[old.length - 1].time, nLast = newC[newC.length - 1].time;
  if (old.length === newC.length && old[0].time === newC[0].time && oLast === nLast) return { mode: 'update' };
  if (nLast > oLast && newC.some((c) => c.time === oLast) && newC.length <= MAX_BARS) return { mode: 'reset' };
  return { mode: 'rebuild' };
}

export class ChartView {
  constructor(container, legendEl, onClick) {
    this.container = container;
    this.legendEl = legendEl;
    this.onClick = onClick;
    this.lib = null;
    this.chart = null;
    this.main = null;
    this.mode = null;
    this.byTime = new Map();
    this.regs = [];
    this.priceLines = [];
    this.buildKey = null;
    this.linesKey = null;
    this.stats = { builds: 0, updates: 0 }; // 検証用（作り直しの回数）
  }

  async init() {
    this.lib = await loadChartLib();
    return !!this.lib;
  }

  destroy() {
    if (this.chart) { try { this.chart.remove(); } catch { /* noop */ } }
    this.chart = null; this.main = null; this.regs = []; this.priceLines = []; this.markersApi = null; this.buildKey = null; this.linesKey = null;
  }

  // model: { candles, tf, tagKey, intervalSec, settings, levels:{daily}, hlines, trendlines, alerts, fs }
  render(model) {
    if (!this.lib) return;
    const S = model.settings;
    const candles = S.weekend === 'hide' ? model.candles.filter((c) => !isSpotMarketClosed(c.time * 1000)) : model.candles;
    if (!candles.length) { this.destroy(); return; }
    const fs = this.container.closest('.chart-wrap')?.classList.contains('fs');
    const buildKey = JSON.stringify([model.tf, model.tagKey, S.chartType, S.ind, S.params, S.markers, S.weekend, S.sessionBg, S.theme, fs, model.trendlines]);
    if (!this.chart || buildKey !== this.buildKey || !this.update(model, candles)) this.build(model, candles, buildKey);
  }

  build(model, candles, buildKey) {
    const LW = this.lib;
    const { settings: S, intervalSec } = model;
    let range = null;
    const sameView = this.chart && this.viewKey === `${model.tf}|${model.tagKey}`;
    if (this.chart && sameView) { try { range = this.chart.timeScale().getVisibleLogicalRange(); } catch { /* noop */ } }
    this.destroy();
    this.stats.builds++;
    this.buildKey = buildKey;
    this.viewKey = `${model.tf}|${model.tagKey}`;
    this.candles = candles.map((c) => ({ ...c }));
    candles = this.candles;
    this.byTime = new Map(candles.map((c, i) => [c.time, i]));
    this.model = model;

    const P = S.params, ind = S.ind;
    const up = cssVar('--up') || '#26a69a', down = cssVar('--down') || '#ef5350';
    const text = cssVar('--text-dim') || '#9aa4b2', grid = cssVar('--grid') || '#1e2530', bg = cssVar('--chart-bg') || '#0f1218';
    const isIntraday = intervalSec < 86400;
    this.intervalSec = intervalSec;

    const subs = ['rsi', 'macd', 'stoch', 'adx', 'atr', 'cci', 'willr', 'roc', 'mom', 'hv'].filter((k) => ind[k] && ind[k].on);
    const fs = this.container.closest('.chart-wrap')?.classList.contains('fs');
    if (!fs) this.container.style.height = 360 + subs.length * 110 + 'px';

    const chart = LW.createChart(this.container, {
      autoSize: true,
      layout: { background: { type: 'solid', color: bg }, textColor: text, fontSize: 11, panes: { separatorColor: grid, enableResize: true } }, // attributionLogo は既定（表示）のまま
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid },
      timeScale: {
        borderColor: grid, timeVisible: isIntraday, secondsVisible: false, rightOffset: 6,
        tickMarkFormatter: (t, type) => {
          const d = new Date(t * 1000);
          return type === 0 ? jstY.format(d) : type === 1 ? jstYM.format(d) : type === 2 ? jstMD.format(d) : jstHM.format(d);
        },
      },
      localization: { locale: 'ja-JP', timeFormatter: (t) => jstFull.format(new Date(t * 1000)) },
      crosshair: { mode: 0 },
      handleScale: { axisPressedMouseMove: true, pinch: true, mouseWheel: true },
      handleScroll: { horzTouchDrag: true, vertTouchDrag: false, pressedMouseMove: true },
    });
    this.chart = chart;
    const reg = (s, points, mode = 'update') => { this.regs.push({ s, points, mode }); s.setData(points(candles)); return s; };

    if (S.sessionBg && intervalSec <= 3600) {
      const sess = chart.addSeries(LW.HistogramSeries, { priceScaleId: 'sess', priceLineVisible: false, lastValueVisible: false, base: 0 }, 0);
      sess.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
      reg(sess, (cs) => cs.map((c) => {
        const s = getSessions(c.time * 1000);
        const color = s.overlap ? 'rgba(171,71,188,0.13)' : s.active.includes('newyork') ? 'rgba(239,83,80,0.08)' : s.active.includes('london') ? 'rgba(102,187,106,0.08)' : s.active.includes('tokyo') ? 'rgba(66,165,245,0.08)' : 'rgba(0,0,0,0)';
        return { time: c.time, value: 1, color };
      }));
    }
    if (ind.volume && ind.volume.on) {
      const vol = chart.addSeries(LW.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false, title: '' }, 0);
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
      reg(vol, (cs) => cs.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)' })));
    }

    // メイン系列
    const dimColor = 'rgba(140,150,160,0.35)';
    const weekendDim = S.weekend === 'dim';
    this.chartType = S.chartType;
    let main;
    if (S.chartType === 'line' || S.chartType === 'area') {
      main = S.chartType === 'line'
        ? chart.addSeries(LW.LineSeries, { color: '#f5c542', lineWidth: 2 }, 0)
        : chart.addSeries(LW.AreaSeries, { lineColor: '#f5c542', topColor: 'rgba(245,197,66,0.35)', bottomColor: 'rgba(245,197,66,0.02)', lineWidth: 2 }, 0);
      this.mainPoints = (cs) => cs.map((c) => ({ time: c.time, value: c.close }));
    } else {
      main = chart.addSeries(LW.CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false }, 0);
      const toBar = (c) => {
        const d = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
        if (weekendDim && isSpotMarketClosed(c.time * 1000)) { d.color = dimColor; d.wickColor = dimColor; d.borderColor = dimColor; }
        return d;
      };
      this.mainPoints = S.chartType === 'heikin' ? (cs) => I.heikinAshi(cs).map(toBar) : (cs) => cs.map(toBar);
      this.toBar = toBar;
    }
    // 縦軸の自動調整は表示中の足の高安だけで行う（遠い水準ラインで縦軸が広がらないように）
    main.applyOptions({
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      autoscaleInfoProvider: () => {
        const cs = this.candles;
        const r = chart.timeScale().getVisibleLogicalRange();
        const n = cs.length;
        const from = r ? Math.max(0, Math.floor(r.from)) : 0, to = r ? Math.min(n - 1, Math.ceil(r.to)) : n - 1;
        if (to < from) return null;
        let mn = Infinity, mx = -Infinity;
        for (let i = from; i <= to; i++) { if (cs[i].low < mn) mn = cs[i].low; if (cs[i].high > mx) mx = cs[i].high; }
        return { priceRange: { minValue: mn, maxValue: mx }, margins: { above: 12, below: 12 } };
      },
    });
    this.main = main;
    reg(main, this.mainPoints);

    const line = (calc, color, opts = {}, pane = 0) => reg(
      chart.addSeries(LW.LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...opts }, pane),
      (cs) => toLine(cs, calc(cs)));

    if (ind.sma && ind.sma.on) parsePeriods(ind.sma.periods).forEach((p, k) => line((cs) => I.sma(cs, p), LINE_COLORS[(k + 2) % 5], { title: `SMA${p}` }));
    if (ind.ema && ind.ema.on) parsePeriods(ind.ema.periods).forEach((p, k) => line((cs) => I.ema(cs, p), LINE_COLORS[k % 5], { title: `EMA${p}` }));
    if (ind.bb && ind.bb.on) {
      const b = memo((cs) => I.bollinger(cs, P.bbPeriod, P.bbMult));
      line((cs) => b(cs).upper, 'rgba(100,181,246,0.8)'); line((cs) => b(cs).middle, 'rgba(100,181,246,0.5)', { lineStyle: 2 }); line((cs) => b(cs).lower, 'rgba(100,181,246,0.8)');
    }
    if (ind.keltner && ind.keltner.on) {
      const k = memo((cs) => I.keltner(cs, P.kcEma, P.kcAtr, P.kcMult));
      line((cs) => k(cs).upper, 'rgba(255,183,77,0.7)', { lineStyle: 2 }); line((cs) => k(cs).lower, 'rgba(255,183,77,0.7)', { lineStyle: 2 });
    }
    if (ind.vwap && ind.vwap.on && isIntraday) line((cs) => I.vwap(cs, P.vwapReset), '#e040fb', { lineWidth: 2, title: 'VWAP' });
    if (ind.ichimoku && ind.ichimoku.on) this.drawIchimoku(chart, P, intervalSec, reg);
    if (ind.psar && ind.psar.on) line((cs) => I.parabolicSar(cs, P.psarStart, P.psarStep, P.psarMax).sar, '#cfd8dc', { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 });
    if (ind.supertrend && ind.supertrend.on) {
      reg(chart.addSeries(LW.LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, 0), (cs) => {
        const st = I.supertrend(cs, P.stPeriod, P.stMult);
        const d = [];
        cs.forEach((c, i) => { if (st.value[i] !== null) d.push({ time: c.time, value: st.value[i], color: st.direction[i] === 'up' ? up : down }); });
        return d;
      });
    }

    // サブペイン
    let pane = 1;
    const guide = (s, levels) => levels.forEach((v) => s.createPriceLine({ price: v, color: 'rgba(150,160,170,0.5)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false }));
    for (const key of subs) {
      if (key === 'rsi') guide(line((cs) => I.rsi(cs, P.rsi), '#ba68c8', { lastValueVisible: true, title: `RSI${P.rsi}` }, pane), [70, 30]);
      if (key === 'macd') {
        const m = memo((cs) => I.macd(cs, P.macdFast, P.macdSlow, P.macdSignal));
        reg(chart.addSeries(LW.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane),
          (cs) => { const h = m(cs).hist; return cs.map((c, i) => (h[i] === null ? { time: c.time } : { time: c.time, value: h[i], color: h[i] >= 0 ? 'rgba(38,166,154,0.6)' : 'rgba(239,83,80,0.6)' })); });
        line((cs) => m(cs).macd, '#4fc3f7', { title: 'MACD', lastValueVisible: true }, pane); line((cs) => m(cs).signal, '#ff8a65', { title: 'Sig' }, pane);
      }
      if (key === 'stoch') { const s = memo((cs) => I.stochastic(cs, P.stochK, P.stochSmooth, P.stochD)); guide(line((cs) => s(cs).k, '#4fc3f7', { title: '%K', lastValueVisible: true }, pane), [80, 20]); line((cs) => s(cs).d, '#ff8a65', { title: '%D' }, pane); }
      if (key === 'adx') { const a = memo((cs) => I.adx(cs, P.adx)); line((cs) => a(cs).adx, '#f5c542', { title: 'ADX', lastValueVisible: true }, pane); line((cs) => a(cs).plusDI, up, { title: '+DI' }, pane); guide(line((cs) => a(cs).minusDI, down, { title: '−DI' }, pane), [25, 20]); }
      if (key === 'atr') line((cs) => I.atr(cs, P.atr), '#90a4ae', { title: `ATR${P.atr}`, lastValueVisible: true }, pane);
      if (key === 'cci') guide(line((cs) => I.cci(cs, P.cci), '#81c784', { title: `CCI${P.cci}`, lastValueVisible: true }, pane), [100, -100]);
      if (key === 'willr') guide(line((cs) => I.williamsR(cs, P.willr), '#ffb74d', { title: '%R', lastValueVisible: true }, pane), [-20, -80]);
      if (key === 'roc') guide(line((cs) => I.roc(cs, P.roc), '#4dd0e1', { title: `ROC${P.roc}`, lastValueVisible: true }, pane), [0]);
      if (key === 'mom') guide(line((cs) => I.momentum(cs, P.mom), '#aed581', { title: `MOM${P.mom}`, lastValueVisible: true }, pane), [0]);
      if (key === 'hv') line((cs) => I.historicalVolatility(cs, P.hv, I.periodsPerYearFor(intervalSec)), '#f06292', { title: 'HV%', lastValueVisible: true }, pane);
      pane++;
    }
    try {
      const panes = chart.panes();
      if (panes.length > 1) { panes[0].setStretchFactor(fs ? Math.max(2, 6 - panes.length) : 3.3); for (let k = 1; k < panes.length; k++) panes[k].setStretchFactor(1); }
    } catch { /* 古い版では無視 */ }

    try { this.markersApi = LW.createSeriesMarkers(main, []); } catch { this.markersApi = null; }
    this.drawMarkers();
    this.drawLevels(model);
    this.drawTrendlines(model.trendlines || []);

    chart.subscribeCrosshairMove((p) => this.updateLegend(p));
    chart.subscribeClick((p) => {
      if (!this.onClick || !p.point) return;
      const price = this.main.coordinateToPrice(p.point.y);
      this.onClick({ time: p.time ?? null, price, mode: this.mode });
    });
    if (range) { try { chart.timeScale().setVisibleLogicalRange(range); } catch { /* noop */ } }
    else { const n = candles.length; chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 5 }); }
    this.updateLegend(null);
  }

  // 差分の反映。できなければ false を返す（呼び出し側で作り直す）。
  // チャートの足は常に分析タブと同じ配列（st.candles の写し）にそろえる（N12）
  update(model, newC) {
    const plan = planChartUpdate(this.candles, newC);
    if (plan.mode === 'rebuild') return false;
    const lastT = this.candles[this.candles.length - 1].time;
    const cs = newC.map((c) => ({ ...c }));
    this.candles = cs;
    this.byTime = new Map(cs.map((c, i) => [c.time, i]));
    this.model = model;
    try {
      for (const r of this.regs) {
        const pts = r.points(cs);
        if (plan.mode === 'reset' || r.mode === 'set') { r.s.setData(pts); continue; } // 新しい足: 全系列を差し替え（チャートは作り直さない）
        let j = pts.length;
        while (j > 0 && pts[j - 1].time >= lastT) j--;
        for (let q = j; q < pts.length; q++) r.s.update(pts[q]); // 同じ最終足の更新だけ
      }
    } catch { return false; }
    this.stats.updates++;
    if (plan.mode === 'reset') this.drawMarkers();
    this.drawLevels(model);
    this.updateLegend(null);
    return true;
  }

  drawIchimoku(chart, P, sec, reg) {
    const LW = this.lib;
    const ich = memo((cs) => I.ichimoku(cs, P.ichiTenkan, P.ichiKijun, P.ichiSenkouB, P.ichiDisp));
    const mk = (color, opts = {}) => chart.addSeries(LW.LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...opts }, 0);
    reg(mk('#ef5350'), (cs) => toLine(cs, ich(cs).tenkan));
    reg(mk('#42a5f5'), (cs) => toLine(cs, ich(cs).kijun));
    const shifted = (key) => (cs) => {
      const v = ich(cs), n = cs.length, D = v.displacement, out = [];
      const timeAt = (idx) => (idx < n ? cs[idx].time : cs[n - 1].time + (idx - (n - 1)) * sec);
      for (let i = 0; i < n; i++) if (v[key][i] !== null) out.push({ time: timeAt(i + D), value: v[key][i] });
      return out;
    };
    // 先行スパンは未来の時刻を持つので update ではなく setData（この系列だけ）
    reg(mk('rgba(102,187,106,0.8)'), shifted('senkouA'), 'set');
    reg(mk('rgba(239,83,80,0.8)'), shifted('senkouB'), 'set');
    reg(mk('rgba(158,158,158,0.7)', { lineStyle: 2 }), (cs) => {
      const D = ich(cs).displacement, out = [];
      for (let i = D; i < cs.length; i++) out.push({ time: cs[i - D].time, value: cs[i].close });
      return out;
    }, 'set');
  }

  drawLevels(model) {
    const candles = this.candles, S = model.settings, Lv = S.levels, s = this.main;
    const daily = model.levels && model.levels.daily;
    const dKey = daily && daily.length >= 2 ? [daily[daily.length - 2], daily[daily.length - 1].time] : null;
    const key = JSON.stringify([Lv, dKey, candles[candles.length - 1].time, candles.length, model.hlines, (model.alerts || []).filter((a) => a.enabled !== false)]);
    if (key === this.linesKey) return;
    this.linesKey = key;
    for (const pl of this.priceLines) { try { s.removePriceLine(pl); } catch { /* noop */ } }
    this.priceLines = [];
    // 価格ラインは縦軸の範囲に含まれるため、直近の値動きから大きく離れた水準は描かない
    const recent = candles.slice(-150);
    const rMin = Math.min(...recent.map((c) => c.low)), rMax = Math.max(...recent.map((c) => c.high));
    const pad = Math.max((rMax - rMin) * 0.3, rMax * 0.002);
    const pl = (price, color, title, style = 2, width = 1) => {
      if (!Number.isFinite(price) || price < rMin - pad || price > rMax + pad) return;
      this.priceLines.push(s.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title }));
    };
    const lastPrice = candles[candles.length - 1].close;
    if (daily && daily.length >= 2) { // 日足の出典が合わないとき（reject）は daily が null で、水準は描かない
      const pd = daily[daily.length - 2];
      if (Lv.pivot) {
        const p = L.pivots(pd.high, pd.low, pd.close, Lv.pivotMethod);
        for (const [k, v] of Object.entries(p)) pl(v, k === 'P' ? '#f5c542' : k.startsWith('R') ? 'rgba(239,83,80,0.7)' : 'rgba(38,166,154,0.7)', k, 1);
      }
      if (Lv.prevDay) { pl(pd.high, '#90caf9', '前日高', 0); pl(pd.low, '#90caf9', '前日安', 0); }
      if (Lv.prevClose) pl(pd.close, '#b0bec5', '前日終', 3);
      if (Lv.prevWeek) { const w = I.aggregatePeriod(daily, 'week'); if (w.length >= 2) { pl(w[w.length - 2].high, '#ce93d8', '前週高', 0); pl(w[w.length - 2].low, '#ce93d8', '前週安', 0); } }
      if (Lv.prevMonth) { const m = I.aggregatePeriod(daily, 'month'); if (m.length >= 2) { pl(m[m.length - 2].high, '#ffcc80', '前月高', 0); pl(m[m.length - 2].low, '#ffcc80', '前月安', 0); } }
    }
    if (Lv.round) {
      const step = Number(Lv.roundStep) || 50;
      const r = L.roundNumbers(lastPrice, step, 3);
      [...r.above, ...r.below].forEach((v) => pl(v, 'rgba(200,200,200,0.35)', '', v % 100 === 0 ? 0 : 1, v % 100 === 0 ? 2 : 1));
    }
    if (Lv.fib) { const f = L.fibonacciAuto(candles, 100); if (f) f.levels.forEach((x) => pl(x.price, 'rgba(255,213,79,0.6)', `Fib ${(x.ratio * 100).toFixed(1)}%`, 1)); }
    if (Lv.sr) L.supportResistance(candles).levels.forEach((x) => pl(x.level, x.type === 'resistance' ? 'rgba(239,83,80,0.9)' : 'rgba(38,166,154,0.9)', `${x.type === 'resistance' ? 'R' : 'S'}×${x.touches}`, 0, 2));
    if (Lv.manual) (model.hlines || []).forEach((h) => pl(h.price, '#ffffff', '水平線', 0));
    if (Lv.alerts) (model.alerts || []).filter((a) => a.enabled !== false).forEach((a) => pl(a.price, '#ffd54f', a.direction === 'above' ? 'アラート↑' : 'アラート↓', 2));
  }

  drawMarkers() {
    if (!this.markersApi) return;
    const candles = this.candles, S = this.model.settings, P = S.params, M = S.markers;
    const up = '#26a69a', down = '#ef5350';
    const marks = [];
    if (M.cross) I.crossings(I.ema(candles, P.emaFast), I.ema(candles, P.emaSlow)).forEach((x) => marks.push({ time: candles[x.index].time, position: x.type === 'up' ? 'belowBar' : 'aboveBar', color: x.type === 'up' ? up : down, shape: x.type === 'up' ? 'arrowUp' : 'arrowDown', text: x.type === 'up' ? 'GC' : 'DC' }));
    if (M.divergence) divergence(candles, I.rsi(candles, P.rsi), { all: true }).forEach((d) => marks.push({ time: candles[d.toIndex].time, position: d.type === 'bullish' ? 'belowBar' : 'aboveBar', color: d.type === 'bullish' ? '#80deea' : '#ffab91', shape: 'circle', text: d.type === 'bullish' ? '強気Div?' : '弱気Div?' }));
    if (M.patterns) {
      for (let i = Math.max(2, candles.length - 60); i < candles.length; i++) {
        const p = candlePatterns(candles, i).filter((x) => x !== 'doji');
        if (p.length) { const bull = p[0].startsWith('bull') || p[0] === 'morningStar'; marks.push({ time: candles[i].time, position: bull ? 'belowBar' : 'aboveBar', color: '#b39ddb', shape: 'square', text: PATTERN_NAMES[p[0]] }); }
      }
    }
    marks.sort((a, b) => a.time - b.time);
    try { this.markersApi.setMarkers(marks); } catch { /* noop */ }
  }

  drawTrendlines(lines) {
    for (const t of lines) {
      if (t.t1 === t.t2) continue;
      const pts = [{ time: t.t1, value: t.p1 }, { time: t.t2, value: t.p2 }].sort((a, b) => a.time - b.time);
      const s = this.chart.addSeries(this.lib.LineSeries, { color: '#fff176', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null }, 0);
      s.setData(pts);
    }
  }

  updateLegend(p) {
    if (!this.legendEl || !this.candles || !this.candles.length) return;
    let idx = this.candles.length - 1;
    if (p && p.time !== undefined && this.byTime.has(p.time)) idx = this.byTime.get(p.time);
    const c = this.candles[idx], prev = this.candles[idx - 1];
    const ch = prev ? ((c.close - prev.close) / prev.close) * 100 : 0;
    const f = (v) => v.toFixed(2);
    this.legendEl.textContent = `${jstFull.format(new Date(c.time * 1000))}  始${f(c.open)} 高${f(c.high)} 安${f(c.low)} 終${f(c.close)}  ${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`;
    this.legendEl.classList.toggle('up', ch >= 0);
    this.legendEl.classList.toggle('down', ch < 0);
  }

  // 最終足だけ更新（現在値ティック）。平均足もここで最後の 1 本を計算し直す
  // tagKey が今のチャートと違う（データ元が変わった直後など）なら書き込まない（R2-1）
  updateLast(c, tagKey) {
    if (!this.main || !this.candles || !this.candles.length) return false;
    if (tagKey !== undefined && this.viewKey !== `${this.model ? this.model.tf : ''}|${tagKey}`) return false;
    const n = this.candles.length, last = this.candles[n - 1];
    if (!last || c.time !== last.time) return;
    Object.assign(last, c);
    try {
      if (this.chartType === 'line' || this.chartType === 'area') this.main.update({ time: c.time, value: c.close });
      else if (this.chartType === 'heikin') {
        const ha = I.heikinAshi(this.candles.slice(Math.max(0, n - 300)));
        this.main.update(this.toBar(ha[ha.length - 1]));
      } else this.main.update(this.toBar(last));
    } catch { /* noop */ }
    this.updateLegend(null);
  }

  setMode(mode) { this.mode = mode; }
  fit() { if (this.chart) this.chart.timeScale().fitContent(); }
}
