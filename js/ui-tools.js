// 計算タブ（ロット・ATR ストップ・RR・損益・証拠金）と日記タブ
// 2周目: 入力は parseNum で厳密に読み、範囲外はエラー・危ない値は警告（13-6、B6〜B10）
import * as I from './indicators.js';
import * as T from './trade.js';
import * as store from './store.js';
import { parseNum, checkLotInputs, checkAtrInputs, sanitizeJournal, INPUT_MESSAGES } from './validate.js';
import { $, el, clear, fmtNum, fmtSigned, fmtMoney, fmtJST, toast } from './dom.js';

// 欄の値: 空欄 → null、読めない → NaN、読める → 数
const raw = (id) => { const e = $('#' + id); return e ? e.value.trim() : ''; };
const pv = (id) => { const s = raw(id); if (s === '') return null; const n = parseNum(s); return n === null ? NaN : n; };
const LABELS = { lotBalance: '口座残高', lotRisk: '許容損失 %', lotEntry: 'エントリー価格', lotStop: '損切り価格', lotUsdJpy: 'USD/JPY', atrEntry: 'エントリー', atrValue: 'ATR', atrMult: '倍率', rrStop: '損切り', rrTarget: '利確', pnlEntry: 'エントリー', pnlExit: '決済', pnlLots: 'ロット', mgLots: 'ロット', mgPrice: '価格', mgLev: 'レバレッジ' };
// 読めない欄があれば、そのエラー文を返す
const unreadable = (ids) => ids.filter((id) => Number.isNaN(pv(id))).map((id) => `「${LABELS[id] || id}」は数値で入れてください`);
const msgEl = (text, kind = 'warn') => el('div', { class: kind, text });
const line = (label, value, cls = '') => el('div', {}, label, el('span', { class: cls, text: value }));
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const inPrice = (p) => p !== null && Number.isFinite(p) && p >= 500 && p <= 20000;

// 「自動」の印（data-auto="1"）がある欄だけ上書きする。利用者が入力したら印を外す（B9・B12）
function setAuto(id, val) {
  const e = $('#' + id);
  if (!e || e.dataset.auto === '0' || val === null || val === undefined || !Number.isFinite(val)) return;
  const s = String(val);
  if (e.value !== s) e.value = s;
}
function markAuto(ids, on = true) { ids.forEach((id) => { const e = $('#' + id); if (e) e.dataset.auto = on ? '1' : '0'; }); }

export function currentAtr(ctx) {
  const a = I.atr(ctx.candles(), ctx.settings.params.atr);
  return a[a.length - 1];
}

export function refreshToolDefaults(ctx) {
  const S = ctx.settings, price = ctx.lastPrice(), at = currentAtr(ctx);
  setAuto('lotBalance', S.balance); setAuto('lotRisk', S.riskPercent);
  if ($('#lotCurrency').dataset.auto !== '0') $('#lotCurrency').value = S.accountCurrency;
  $('#lotUsdJpy').placeholder = `空欄なら自動 ${fmtNum(ctx.usdJpy(), 2)}`;
  setAuto('atrEntry', r2(price)); setAuto('atrValue', r2(at)); setAuto('atrMult', S.atrMult);
  setAuto('pnlEntry', r2(price)); setAuto('mgPrice', r2(price)); setAuto('mgLev', S.leverage);
  setAuto('alPrice', r2(price));
  computeAll(ctx);
}

function computeLot(ctx) {
  const S = ctx.settings, box = clear($('#lotResult'));
  const bad = unreadable(['lotBalance', 'lotRisk', 'lotEntry', 'lotStop', 'lotUsdJpy']);
  if (bad.length) { bad.forEach((m) => box.appendChild(msgEl(m, 'err'))); return; }
  const cur = $('#lotCurrency').value, side = $('#lotSide').value;
  const inp = { balance: pv('lotBalance'), riskPercent: pv('lotRisk'), accountCurrency: cur, usdJpy: pv('lotUsdJpy'), entry: pv('lotEntry'), stop: pv('lotStop'), side, current: ctx.lastPrice() };
  if (inp.entry === null && inp.stop === null) { box.textContent = 'エントリーと損切りを入れてください'; return; }
  const chk = checkLotInputs(inp);
  if (chk.errors.length) { chk.errors.forEach((c) => box.appendChild(msgEl(INPUT_MESSAGES[c] || c, 'err'))); return; }
  const usdJpy = inp.usdJpy ?? ctx.usdJpy();
  for (const w of chk.warnings) {
    if (w === 'USDJPY_AUTO') box.appendChild(msgEl(`USD/JPY は自動取得値 ${fmtNum(usdJpy, 2)} を使っています`, 'info'));
    else box.appendChild(msgEl(INPUT_MESSAGES[w] || w, w === 'RISK_VERY_HIGH' ? 'err' : 'warn'));
  }
  const r = T.calcLot({ balance: inp.balance, accountCurrency: cur, usdJpy, riskPercent: inp.riskPercent, entry: inp.entry, stop: inp.stop, contractSize: S.contractSize, lotStep: S.lotStep, minLot: S.minLot, maxLot: S.maxLot });
  if (r.error) { box.appendChild(msgEl(INPUT_MESSAGES.STOP_EQUALS_ENTRY, 'err')); return; }
  box.appendChild(el('div', {}, 'ロット: ', el('span', { class: 'big', text: fmtNum(r.lots, 2) }), ' lot'));
  if (r.warning === 'BELOW_MIN_LOT') box.appendChild(msgEl(`許容損失に対して最小ロット（${S.minLot}）でも大きすぎます`));
  if (r.warning === 'LOT_CAPPED') box.appendChild(msgEl(`最大ロット ${S.maxLot} で頭打ちにしました（計算上は ${fmtNum(r.rawLots, 4)} lot）`));
  box.appendChild(line('許容損失: ', `${fmtMoney(r.riskAmount, cur)}（${fmtMoney(r.riskUSD, 'USD')}）`));
  box.appendChild(line('損切り幅: ', `$${fmtNum(Math.abs(inp.entry - inp.stop))}（1 lot あたり ${fmtMoney(r.lossPerLotUSD, 'USD')}）`));
  box.appendChild(line('計算上のロット: ', fmtNum(r.rawLots, 4) + ' lot（刻みに合わせて切り捨て）'));
  box.appendChild(line('このロットで損切りした場合: ', `${fmtMoney(r.actualRiskAccount, cur)}（${fmtMoney(r.actualRiskUSD, 'USD')}）`));
  const m = T.calcMargin({ lots: r.lots, price: inp.entry, contractSize: S.contractSize, leverage: S.leverage, accountCurrency: cur, usdJpy });
  box.appendChild(line(`必要証拠金（${S.leverage}倍）: `, fmtMoney(m.marginAccount, cur)));
  if (m.marginAccount > inp.balance) box.appendChild(msgEl('必要証拠金が口座残高を超えます', 'err'));
  $('#lotNote').textContent = `1 lot = ${S.contractSize} oz、ロット刻み ${S.lotStep}、最小 ${S.minLot}、最大 ${S.maxLot}、レバレッジ ${S.leverage} 倍として計算（設定で変更可）。`;
}

function rrList(ctx) {
  const rr = String(ctx.settings.rrList).split(/[,\s、]+/).map((s) => parseNum(s)).filter((x) => x !== null && x >= 0.1 && x <= 20).slice(0, 5);
  return rr.length ? rr : [1, 2, 3];
}

function computeAtr(ctx) {
  const box = clear($('#atrResult'));
  const bad = unreadable(['atrEntry', 'atrValue', 'atrMult']);
  if (bad.length) { bad.forEach((m) => box.appendChild(msgEl(m, 'err'))); return; }
  const side = $('#atrSide').value, entry = pv('atrEntry'), at = pv('atrValue'), mult = pv('atrMult');
  const chk = checkAtrInputs({ entry, atr: at, mult });
  if (chk.errors.length) { chk.errors.forEach((c) => box.appendChild(msgEl(INPUT_MESSAGES[c] || c, 'err'))); return; }
  chk.warnings.forEach((w) => box.appendChild(msgEl(INPUT_MESSAGES[w] || w)));
  const rr = rrList(ctx);
  const r = T.atrStops(side, entry, at, mult, rr);
  box.appendChild(el('div', { class: 'small', text: `ATR×${mult} を損切り幅の目安とした場合（幅 $${fmtNum(r.riskDistance)}）` }));
  box.appendChild(line('損切りの目安: ', fmtNum(r.stopLoss), 'down'));
  r.takeProfits.forEach((tp, k) => box.appendChild(line(`利確の目安（RR 1:${rr[k]}）: `, fmtNum(tp), 'up')));
  const c = ctx.candles();
  if (c.length > 20) {
    const look = c.slice(-50);
    const ref = side === 'buy' ? Math.min(...look.map((x) => x.low)) - 0.2 * at : Math.max(...look.map((x) => x.high)) + 0.2 * at;
    box.appendChild(line('構造ベースの目安（直近50本の' + (side === 'buy' ? '安値の下' : '高値の上') + '）: ', fmtNum(ref)));
  }
  box.appendChild(el('div', { class: 'small', text: '目安の計算であり、売買を勧めるものではありません。' }));
  // リスクリワード欄は ATR の結果に連動（手で入れた欄は上書きしない）
  setAuto('rrStop', r2(r.stopLoss));
  setAuto('rrTarget', r2(r.takeProfits[r.takeProfits.length > 1 ? 1 : 0]));
}

function computeRR() {
  const box = clear($('#rrResult'));
  const bad = unreadable(['atrEntry', 'rrStop', 'rrTarget']);
  if (bad.length) { bad.forEach((m) => box.appendChild(msgEl(m, 'err'))); return; }
  const side = $('#atrSide').value, entry = pv('atrEntry'), stop = pv('rrStop'), target = pv('rrTarget');
  if (entry === null || stop === null || target === null) { box.textContent = 'エントリー・損切り・利確を入れてください'; return; }
  if (![entry, stop, target].every(inPrice)) { box.appendChild(msgEl('価格は 500〜20,000 の範囲で入れてください', 'err')); return; }
  const r = T.riskReward(side, entry, stop, target);
  const auto = $('#rrStop').dataset.auto !== '0' && $('#rrTarget').dataset.auto !== '0';
  box.appendChild(r === null ? msgEl('損切りの位置が逆です（リスクが 0 以下）', 'err') : el('div', {}, 'リスクリワード比 1 : ', el('span', { class: 'big', text: fmtNum(r, 2) }), auto ? '（ATR の結果から自動）' : '（手入力）'));
  if (r !== null && r <= 0) box.appendChild(msgEl('利確の位置がエントリーの逆側です'));
}

function computePnl(ctx) {
  const S = ctx.settings, box = clear($('#pnlResult'));
  const bad = unreadable(['pnlEntry', 'pnlExit', 'pnlLots']);
  if (bad.length) { bad.forEach((m) => box.appendChild(msgEl(m, 'err'))); return; }
  const entry = pv('pnlEntry'), exit = pv('pnlExit'), lots = pv('pnlLots');
  if (entry === null || exit === null || lots === null) { box.textContent = 'エントリー・決済・ロットを入れてください'; return; }
  const errs = [];
  if (!inPrice(entry) || !inPrice(exit)) errs.push('価格は 500〜20,000 の範囲で入れてください');
  if (!(lots > 0 && lots <= 100000)) errs.push('ロットは 0 より大きく 100,000 以下で入れてください');
  if (errs.length) { errs.forEach((m) => box.appendChild(msgEl(m, 'err'))); return; }
  const r = T.calcPnl({ side: $('#pnlSide').value, entry, exit, lots, contractSize: S.contractSize, pipSize: S.pipSize, usdJpy: ctx.usdJpy() });
  const cls = r.pnlUSD >= 0 ? 'up' : 'down';
  box.appendChild(el('div', {}, '損益: ', el('span', { class: 'big ' + cls, text: fmtMoney(r.pnlUSD, 'USD') }), `（${fmtMoney(r.pnlJPY, 'JPY')}）`));
  box.appendChild(line('値幅: ', `${fmtSigned(r.priceDiff)} ドル　= ${fmtSigned(r.pips, 1)} pips`));
  box.appendChild(el('div', { class: 'small', text: `1 pip = $${S.pipSize} として計算（業者により 0.1 / 0.01 など。設定で変更可）。円換算 USD/JPY ${fmtNum(ctx.usdJpy())}` }));
}

function computeMargin(ctx) {
  const S = ctx.settings, box = clear($('#mgResult'));
  const bad = unreadable(['mgLots', 'mgPrice', 'mgLev']);
  if (bad.length) { bad.forEach((m) => box.appendChild(msgEl(m, 'err'))); return; }
  const lots = pv('mgLots'), price = pv('mgPrice'), lev = pv('mgLev');
  if (lots === null || price === null || lev === null) { box.textContent = 'ロット・価格・レバレッジを入れてください'; return; }
  const errs = [];
  if (!(lots > 0 && lots <= 100000)) errs.push('ロットは 0 より大きく 100,000 以下で入れてください');
  if (!inPrice(price)) errs.push('価格は 500〜20,000 の範囲で入れてください');
  if (!(lev >= 1 && lev <= 1000)) errs.push('レバレッジは 1〜1000 の範囲で入れてください');
  if (errs.length) { errs.forEach((m) => box.appendChild(msgEl(m, 'err'))); return; }
  const cur = S.accountCurrency;
  const r = T.calcMargin({ lots, price, contractSize: S.contractSize, leverage: lev, accountCurrency: cur, usdJpy: ctx.usdJpy() });
  box.appendChild(el('div', {}, '必要証拠金: ', el('span', { class: 'big', text: fmtMoney(r.marginUSD, 'USD') }), cur === 'JPY' ? `（約 ${fmtMoney(r.marginAccount, 'JPY')}）` : ''));
  box.appendChild(el('div', { class: 'small', text: `${lots} lot × ${S.contractSize} oz × $${fmtNum(price)} ÷ ${lev} 倍` }));
  if (lev > 25) box.appendChild(msgEl('国内 FX の個人の上限は 25 倍です', 'info'));
}

function computeAll(ctx) { computeLot(ctx); computeAtr(ctx); computeRR(); computePnl(ctx); computeMargin(ctx); }

const AUTO_IDS = ['lotBalance', 'lotRisk', 'atrEntry', 'atrValue', 'atrMult', 'rrStop', 'rrTarget', 'pnlEntry', 'mgPrice', 'mgLev', 'alPrice'];
export function initTools(ctx) {
  markAuto(AUTO_IDS);
  $('#lotCurrency').dataset.auto = '1';
  const ids = ['lotBalance', 'lotCurrency', 'lotRisk', 'lotSide', 'lotEntry', 'lotStop', 'lotUsdJpy', 'atrSide', 'atrEntry', 'atrValue', 'atrMult', 'rrStop', 'rrTarget', 'pnlSide', 'pnlEntry', 'pnlExit', 'pnlLots', 'mgLots', 'mgPrice', 'mgLev'];
  ids.forEach((id) => $('#' + id).addEventListener('input', (e) => {
    if (e.isTrusted || e.detail === 'user') { const t = $('#' + id); if (t.dataset.auto) t.dataset.auto = '0'; } // 利用者が入力したら自動更新をやめる
    computeAll(ctx);
  }));
  $('#lotCurrency').addEventListener('change', () => { $('#lotCurrency').dataset.auto = '0'; computeAll(ctx); });
  // 売買の向きを変えたら損切り・利確を自動に戻す
  $('#atrSide').addEventListener('change', () => { markAuto(['rrStop', 'rrTarget']); $('#rrStop').value = ''; $('#rrTarget').value = ''; computeAll(ctx); });
  $('#btnAtrRefill').addEventListener('click', () => { markAuto(['atrEntry', 'atrValue', 'atrMult', 'rrStop', 'rrTarget']); refreshToolDefaults(ctx); toast('ATR の結果から入れ直しました'); });
  $('#btnLotNow').addEventListener('click', () => {
    const price = ctx.lastPrice(), at = currentAtr(ctx);
    if (!Number.isFinite(price) || !Number.isFinite(at)) { toast('価格または ATR がまだありません'); return; }
    const side = $('#lotSide').value, d = at * ctx.settings.atrMult;
    $('#lotEntry').value = price.toFixed(2);
    $('#lotStop').value = (side === 'buy' ? price - d : price + d).toFixed(2);
    computeAll(ctx);
  });
}
// 設定画面で残高・リスク % などを変えたとき（自動の印がある欄だけ更新。B12）
export function onSettingsChanged(ctx) { refreshToolDefaults(ctx); }

// ---------------- 日記 ----------------
function loadJournal(ctx) { return sanitizeJournal(store.readJSON(store.KEYS.journal, []), Date.now(), ctx.settings.accountCurrency).value; }
function saveJournal(j) { store.writeJSON(store.KEYS.journal, j); }

function nowLocalInput() {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

export function initJournal(ctx) {
  $('#jDate').value = nowLocalInput();
  $('#btnJAdd').addEventListener('click', () => {
    const S = ctx.settings;
    const LB = { jEntry: 'エントリー', jExit: '決済', jLots: 'ロット', jPnl: '損益' };
    const badIds = ['jEntry', 'jExit', 'jLots', 'jPnl'].filter((id) => Number.isNaN(pv(id)));
    if (badIds.length) { toast(`${badIds.map((id) => LB[id]).join('・')}は数値で入れてください`); return; }
    const side = $('#jSide').value, entry = pv('jEntry'), exit = pv('jExit'), lots = pv('jLots');
    const errs = [];
    if (entry !== null && !inPrice(entry)) errs.push('エントリーは 500〜20,000');
    if (exit !== null && !inPrice(exit)) errs.push('決済は 500〜20,000');
    if (lots !== null && !(lots > 0 && lots <= 100000)) errs.push('ロットは 0 より大きく 100,000 以下');
    let pnl = pv('jPnl');
    if (pnl !== null && !(Math.abs(pnl) <= 1e12)) errs.push('損益が大きすぎます');
    const t = Date.parse($('#jDate').value);
    if (!Number.isFinite(t)) errs.push('日時を入れてください');
    else if (t > Date.now() + 86400000) errs.push('日時が未来です');
    if (errs.length) { toast(errs.join('／')); return; }
    if (pnl === null) {
      if (entry === null || exit === null || lots === null) { toast('損益、またはエントリー・決済・ロットを入れてください'); return; }
      const r = T.calcPnl({ side, entry, exit, lots, contractSize: S.contractSize, pipSize: S.pipSize, usdJpy: ctx.usdJpy() });
      pnl = S.accountCurrency === 'JPY' ? Math.round(r.pnlJPY) : Math.round(r.pnlUSD * 100) / 100;
    }
    const j = loadJournal(ctx);
    j.push({ id: 'j' + Date.now().toString(36), time: Math.round(t), side, pnl, entry, exit, lots, currency: S.accountCurrency, memo: $('#jMemo').value.slice(0, 500) });
    saveJournal(sanitizeJournal(j, Date.now(), S.accountCurrency).value);
    ['jEntry', 'jExit', 'jPnl', 'jMemo'].forEach((id) => { $('#' + id).value = ''; });
    $('#jDate').value = nowLocalInput();
    toast('記録しました');
    renderJournal(ctx);
  });
  renderJournal(ctx);
}

function renderJournal(ctx) {
  const j = loadJournal(ctx);
  const cur = ctx.settings.accountCurrency;
  const groups = T.journalStatsByCurrency(j, cur); // 通貨が混ざっていても足し合わせない（B12）
  const box = clear($('#jStats'));
  const cell = (label, val, cls = '') => box.appendChild(el('div', {}, label, el('b', { class: cls, text: val })));
  if (!groups.length) groups.push({ currency: cur, ...T.journalStats([]) });
  for (const s of groups) {
    const sfx = groups.length > 1 ? `（${s.currency === 'JPY' ? '円' : 'ドル'}口座）` : '';
    cell('取引数' + sfx, String(s.count));
    cell('勝率' + sfx, s.winRate === null ? '—' : s.winRate.toFixed(1) + '%');
    cell('合計損益' + sfx, fmtMoney(s.totalPnl, s.currency), s.totalPnl >= 0 ? 'up' : 'down');
    cell('プロフィットファクター' + sfx, s.profitFactor === null ? '—' : s.profitFactor.toFixed(2));
    cell('平均利益' + sfx, s.avgWin === null ? '—' : fmtMoney(s.avgWin, s.currency), 'up');
    cell('平均損失' + sfx, s.avgLoss === null ? '—' : fmtMoney(s.avgLoss, s.currency), 'down');
  }
  drawPnl(j.filter((t) => t.currency === cur), cur);
  const list = clear($('#jList'));
  if (!j.length) list.appendChild(el('div', { class: 'small', text: 'まだ記録がありません' }));
  [...j].reverse().forEach((t) => {
    list.appendChild(el('div', { class: 'j-item' },
      el('div', { class: 'grow' },
        el('div', {}, el('b', { text: t.side === 'buy' ? '買い' : '売り' }), ` ${fmtJST(t.time)}　${Number.isFinite(t.entry) ? fmtNum(t.entry) : '—'} → ${Number.isFinite(t.exit) ? fmtNum(t.exit) : '—'}　${Number.isFinite(t.lots) ? t.lots + ' lot' : ''}`),
        el('div', { class: t.pnl >= 0 ? 'up' : 'down', text: fmtMoney(t.pnl, t.currency || cur) }),
        t.memo ? el('div', { class: 'small', text: t.memo }) : null),
      el('button', { class: 'btn sm danger', type: 'button', text: '削除', onclick: () => {
        if (!confirm('この記録を削除しますか？')) return;
        saveJournal(loadJournal(ctx).filter((x) => x.id !== t.id));
        renderJournal(ctx);
      } })));
  });
}

function drawPnl(j, cur) {
  const cv = $('#jChart');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 320, h = cv.clientHeight || 180;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  g.fillStyle = css.getPropertyValue('--text-dim');
  g.font = '11px system-ui';
  if (j.length < 1) { g.fillText('記録すると累積損益のグラフが表示されます', 10, h / 2); return; }
  const pts = [0]; let acc = 0;
  j.forEach((t) => { acc += t.pnl; pts.push(acc); });
  const max = Math.max(...pts), min = Math.min(...pts), pad = 16;
  const y = (val) => pad + (h - 2 * pad) * (1 - (val - min) / (max - min || 1));
  const x = (i) => pad + ((w - 2 * pad) * i) / (pts.length - 1 || 1);
  g.strokeStyle = css.getPropertyValue('--line'); g.beginPath(); g.moveTo(pad, y(0)); g.lineTo(w - pad, y(0)); g.stroke();
  g.strokeStyle = acc >= 0 ? '#26a69a' : '#ef5350'; g.lineWidth = 2; g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(x(i), y(p)) : g.moveTo(x(i), y(p))));
  g.stroke();
  g.fillText(`累積 ${fmtMoney(acc, cur)}（${cur === 'JPY' ? '円' : 'ドル'}口座の記録）`, pad, 12);
}
