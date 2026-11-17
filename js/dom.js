// DOM ヘルパー。文字列は常に textContent で入れる（innerHTML は使わない）

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = String(v);
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}
export function setText(sel, text) { const e = typeof sel === 'string' ? $(sel) : sel; if (e) e.textContent = text; }
export function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }

const jstFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const jstTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const jstMd = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const fmtJST = (ms) => jstFmt.format(new Date(ms));
export const fmtJSTTime = (ms) => jstTime.format(new Date(ms));
export const fmtJSTmd = (ms) => jstMd.format(new Date(ms));

export function fmtNum(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtSigned(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : v < 0 ? '−' : '±') + fmtNum(Math.abs(v), d);
}
export function fmtYen(v) { return Number.isFinite(v) ? (v < 0 ? '−' : '') + '¥' + Math.abs(Math.round(v)).toLocaleString('ja-JP') : '—'; }
export function fmtMoney(v, cur) { return cur === 'JPY' ? fmtYen(v) : Number.isFinite(v) ? (v < 0 ? '−' : '') + '$' + fmtNum(Math.abs(v), 2) : '—'; }
export function fmtDuration(ms) {
  if (!(ms > 0)) return '0分';
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return (d ? d + '日' : '') + (d || h ? h + '時間' : '') + mm + '分';
}

let toastTimer = null;
export function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
// 画面の部品の初期化・描画を 1 つずつ受け止める。失敗した部分にだけ「表示できません」と出し、ほかは動かし続ける（N1）
export function safeInit(name, fn, hostSel = null, onError = null) {
  try { fn(); return true; } catch (e) {
    console.error(`[init] ${name}`, e);
    if (onError) { try { onError(e); } catch { /* noop */ } }
    if (hostSel && typeof document !== 'undefined') {
      const host = document.querySelector(hostSel);
      if (host && !host.querySelector('.init-error')) host.prepend(el('div', { class: 'card warn init-error', role: 'alert', text: 'この部分を表示できません（保存データを確認してください）' }));
    }
    return false;
  }
}
export function num(v, fallback = null) { const n = parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : fallback; }
export function safeHttpsUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; }
}
