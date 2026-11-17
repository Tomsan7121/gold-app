// アラート・通知・経済指標カレンダー・ニュース
import * as D from './data.js';
import * as store from './store.js';
import { localParts } from './sessions.js';
import { $, el, clear, fmtNum, fmtJSTmd, fmtDuration, toast, safeHttpsUrl } from './dom.js';
import { parseNum, checkAlertPrice, sanitizeAlerts, sanitizeCalendar, impStars, INPUT_MESSAGES } from './validate.js';

// ---------------- 通知 ----------------
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.15;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.35);
  } catch { /* 非対応 */ }
}
export async function notify(ctx, title, body) {
  const A = ctx.settings.alertOpts;
  toast(`${title}　${body}`);
  if (A.sound) beep();
  if (A.vibrate && navigator.vibrate) { try { navigator.vibrate([200, 100, 200]); } catch { /* noop */ } }
  if (A.notify && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
      if (reg) await reg.showNotification(title, { body, icon: './icons/icon-192.png', tag: 'gold-alert' });
      else new Notification(title, { body, icon: './icons/icon-192.png' });
    } catch { /* 端末が非対応 */ }
  }
}

// ---------------- 価格アラート ----------------
export function renderAlertList(ctx) {
  const list = clear($('#alList'));
  const alerts = sanitizeAlerts(store.readJSON(store.KEYS.alerts, [])).value;
  if (!alerts.length) list.appendChild(el('div', { class: 'small', text: 'アラートはありません' }));
  alerts.forEach((a) => list.appendChild(el('div', { class: 'j-item' + (a.enabled === false ? ' past' : '') },
    el('div', { class: 'grow', text: `${fmtNum(a.price)} を${a.direction === 'above' ? '上抜け' : '下抜け'}${a.enabled === false ? '（発火済み）' : ''}` }),
    a.enabled === false ? el('button', { class: 'btn sm', type: 'button', text: '再開', onclick: () => { a.enabled = true; store.writeJSON(store.KEYS.alerts, alerts); renderAlertList(ctx); ctx.rerender(); } }) : null,
    el('button', { class: 'btn sm danger', type: 'button', text: '削除', onclick: () => { store.writeJSON(store.KEYS.alerts, alerts.filter((x) => x.id !== a.id)); renderAlertList(ctx); ctx.rerender(); } }))));
}

export function initAlerts(ctx) {
  const A = ctx.settings.alertOpts;
  $('#alPrice').addEventListener('input', (e) => { if (e.isTrusted) $('#alPrice').dataset.auto = '0'; });
  $('#btnAlAdd').addEventListener('click', () => {
    const s = $('#alPrice').value.trim();
    const price = s === '' ? null : parseNum(s);
    if (s !== '' && price === null) { toast('価格は数値で入れてください'); return; }
    const direction = $('#alDir').value;
    const current = ctx.lastPrice();
    const chk = checkAlertPrice({ price, direction, current });
    if (chk.errors.length) { toast(INPUT_MESSAGES[chk.errors[0]] || chk.errors[0]); return; } // B10
    if (chk.warnings.includes('ALERT_FAR') && !confirm(`現在値から ${(Math.abs(price - current) / current * 100).toFixed(1)}% 離れています。登録しますか？`)) return;
    const alerts = sanitizeAlerts(store.readJSON(store.KEYS.alerts, [])).value;
    alerts.push({ id: 'al' + Date.now().toString(36), price, direction, enabled: true });
    store.writeJSON(store.KEYS.alerts, sanitizeAlerts(alerts).value);
    $('#alPrice').dataset.auto = '1';
    renderAlertList(ctx); ctx.rerender();
    if (chk.warnings.includes('ALERT_ALREADY_PASSED')) toast(`いまの価格はすでに ${fmtNum(price)} より${direction === 'above' ? '上' : '下'}です。一度${direction === 'above' ? '下回って' : '上回って'}から再び${direction === 'above' ? '上抜けた' : '下抜けた'}ときに通知します`);
    else toast('アラートを追加しました（アプリを開いている間に判定します）');
  });
  const bind = (id, key) => {
    const e = $('#' + id);
    e.checked = !!A[key];
    e.addEventListener('change', () => { ctx.settings.alertOpts[key] = e.checked; ctx.save(); });
  };
  bind('alRsi', 'rsi'); bind('alEma', 'emaCross'); bind('alSt', 'stFlip'); bind('alNotify', 'notify'); bind('alSound', 'sound'); bind('alVibrate', 'vibrate');
  $('#btnNotifyPerm').addEventListener('click', async () => {
    if (!('Notification' in window)) { toast('この端末のブラウザは通知に対応していません（iOS はホーム画面に追加すると使える場合があります）'); return; }
    const p = await Notification.requestPermission();
    if (p === 'granted') { ctx.settings.alertOpts.notify = true; $('#alNotify').checked = true; ctx.save(); toast('通知を許可しました'); }
    else toast('通知は許可されませんでした');
  });
  $('#btnTestAlert').addEventListener('click', () => notify(ctx, 'テスト通知', 'アラートはこのように届きます'));
  renderAlertList(ctx);

  // カレンダー
  $('#calMin').value = String(A.calendarMinutes);
  $('#btnCalAdd').addEventListener('click', () => {
    const t = Date.parse($('#calDate').value);
    const name = $('#calName').value.trim();
    if (!Number.isFinite(t) || !name) { toast('日時と名前を入れてください'); return; }
    if (name.length > 60) { toast('名前は 60 文字までです'); return; }
    const imp = Number($('#calImp').value);
    const ms = $('#calMin').value.trim();
    const nm = ms === '' ? 30 : parseNum(ms);
    if (!(Number.isInteger(nm) && nm >= 0 && nm <= 1440)) { toast('事前通知は 0〜1440 の整数（分）で入れてください'); return; }
    if (!(Number.isInteger(imp) && imp >= 1 && imp <= 3)) { toast('重要度を選んでください'); return; }
    const jstMs = t - (9 * 60 + new Date(t).getTimezoneOffset()) * 60000; // 入力は JST として解釈
    const cal = loadCalendar();
    cal.push({ id: 'cal' + Date.now().toString(36), time: Math.round(jstMs), name, imp, memo: $('#calMemo').value.slice(0, 120), notifyMin: nm });
    saveCalendar(cal);
    $('#calName').value = ''; $('#calMemo').value = '';
    renderCalendar(ctx);
  });
  $('#btnCalReset').addEventListener('click', () => { if (confirm('既定の予定に戻しますか？（追加した予定は消えます）')) { saveCalendar(defaultCalendar()); renderCalendar(ctx); } });
  renderCalendar(ctx);
  setInterval(() => renderCalendar(ctx), 60000);

  $('#btnNews').addEventListener('click', () => loadNews(ctx));
}

// ---------------- 経済指標カレンダー ----------------
function etToUtc(y, m, d, h, min) {
  for (const off of [4, 5]) {
    const t = Date.UTC(y, m, d, h + off, min);
    const p = localParts(t, 'America/New_York');
    if (p.hour === h && p.minute === min) return t;
  }
  return Date.UTC(y, m, d, h + 5, min);
}
// FOMC（2026年・FRB 公表日程。声明は2日目 14:00 ET）。2027年以降は公式発表を見て追加してください
const FOMC_2026 = [[0, 28], [2, 18], [3, 29], [5, 17], [6, 29], [8, 16], [9, 28], [11, 9]];
export function defaultCalendar(now = Date.now()) {
  const ev = [];
  FOMC_2026.forEach(([m, d]) => ev.push({ id: `fomc-${m}`, time: etToUtc(2026, m, d, 14, 0), name: 'FOMC 政策金利発表', imp: 3, memo: '利下げ観測↑で金は上昇しやすい（ドル安・実質金利低下）', notifyMin: 30 }));
  const base = new Date(now);
  for (let k = 0; k < 8; k++) {
    const y = base.getUTCFullYear() + Math.floor((base.getUTCMonth() + k) / 12), m = (base.getUTCMonth() + k) % 12;
    let d = 1;
    while (new Date(Date.UTC(y, m, d)).getUTCDay() !== 5) d++;
    ev.push({ id: `nfp-${y}-${m}`, time: etToUtc(y, m, d, 8, 30), name: '米雇用統計（原則第1金曜・要確認）', imp: 3, memo: '結果が強い→ドル高で金は下落しやすい（逆も同様）', notifyMin: 30 });
  }
  return ev.filter((e) => e.time > now - 86400000).sort((a, b) => a.time - b.time);
}
function loadCalendar() {
  const r = sanitizeCalendar(store.readJSON(store.KEYS.calendar, null));
  if (!r.reset) return r.value;
  const d = defaultCalendar();
  saveCalendar(d);
  return d;
}
function saveCalendar(c) { store.writeJSON(store.KEYS.calendar, sanitizeCalendar(c).value || []); }

function renderCalendar(ctx) {
  const list = clear($('#calList'));
  const now = Date.now();
  const cal = loadCalendar().filter((e) => e.time > now - 6 * 3600000);
  if (!cal.length) list.appendChild(el('div', { class: 'small', text: '予定はありません。「予定を追加」から登録できます（CPI などは公式日程で確認して追加してください）。' }));
  cal.slice(0, 20).forEach((e) => {
    const past = e.time <= now;
    list.appendChild(el('div', { class: 'j-item' + (past ? ' past' : '') },
      el('div', { class: 'grow' },
        el('div', {}, el('span', { class: 'imp' + e.imp, text: impStars(e.imp) }), ` ${fmtJSTmd(e.time)}　`, el('b', { text: e.name })),
        el('div', { class: 'small', text: (past ? '発表済み' : `あと ${fmtDuration(e.time - now)}`) + (e.memo ? `／${e.memo}` : '') })),
      el('button', { class: 'btn sm danger', type: 'button', text: '削除', onclick: () => { saveCalendar(loadCalendar().filter((x) => x.id !== e.id)); renderCalendar(ctx); } })));
  });
}

export function checkCalendar(ctx) {
  const now = Date.now();
  const notified = new Set(store.readJSON('ga:calNotified', []));
  let changed = false;
  for (const e of loadCalendar()) {
    const before = (Number.isInteger(e.notifyMin) ? e.notifyMin : ctx.settings.alertOpts.calendarMinutes) * 60000;
    if (e.time > now && e.time - now <= before && !notified.has(e.id)) {
      notified.add(e.id); changed = true;
      notify(ctx, `まもなく: ${e.name}`, `${fmtJSTmd(e.time)}（あと ${fmtDuration(e.time - now)}）値動きが急になることがあります`);
    }
  }
  if (changed) store.writeJSON('ga:calNotified', [...notified].slice(-100));
}

// ---------------- ニュース ----------------
async function loadNews(ctx) {
  const ul = clear($('#newsList'));
  ul.appendChild(el('li', { class: 'small', text: '読み込み中…' }));
  try {
    const items = await D.fetchNews(ctx.settings.rssUrl);
    clear(ul);
    items.forEach((it) => {
      const href = safeHttpsUrl(it.link);
      ul.appendChild(el('li', {},
        href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: it.title }) : el('span', { text: it.title }),
        el('div', { class: 'small', text: it.pubDate })));
    });
    if (!items.length) ul.appendChild(el('li', { class: 'small', text: '記事がありません' }));
  } catch (e) {
    clear(ul).appendChild(el('li', { class: 'small', text: 'ニュースを取得できませんでした（' + e.message + '）' }));
  }
}
