// 設定・保存データ（localStorage）。APIキーはこの端末の localStorage のみに保存する。
// 読み込み時とインポート時に 13-5 の検査を通し、壊れた項目は捨てるか既定値に戻す（N1・N7）。
import * as V from './validate.js';
import { validateCandles, TIMEFRAMES } from './data.js';

export const KEYS = {
  settings: 'ga:settings', apiKey: 'ga:apiKey', hlines: 'ga:hlines', trendlines: 'ga:trendlines',
  alerts: 'ga:alerts', journal: 'ga:journal', calendar: 'ga:calendar', notified: 'ga:notified', calNotified: 'ga:calNotified',
  blocked: 'ga:blockedSources', xaus: 'ga:xausHistory',
};

export const DEFAULT_SETTINGS = V.defaultSettings();

function ls() { try { return globalThis.localStorage || null; } catch { return null; } }

export function readJSON(key, fallback, storage = ls()) {
  try { const s = storage && storage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
export function writeJSON(key, v, storage = ls()) {
  try { storage.setItem(key, JSON.stringify(v)); return true; } catch { return false; }
}
function removeKey(key, storage) { try { storage.removeItem(key); } catch { /* noop */ } }
function storageKeys(storage) {
  const out = [];
  try {
    if (typeof storage.length === 'number' && typeof storage.key === 'function') { for (let i = 0; i < storage.length; i++) out.push(storage.key(i)); }
    else if (storage._m) out.push(...storage._m.keys());
  } catch { /* noop */ }
  return out;
}

// 設定を読み、検査して返す。壊れていたら書き直す
export function loadSettingsChecked(storage = ls()) {
  let raw = null, parseFailed = false;
  try { const s = storage && storage.getItem(KEYS.settings); if (s) raw = JSON.parse(s); } catch { parseFailed = true; }
  const r = V.sanitizeSettings(raw === null ? {} : raw);
  if (parseFailed || r.fixed.length || (raw !== null && r.reset)) writeJSON(KEYS.settings, r.settings, storage);
  return { settings: r.settings, fixed: r.fixed, reset: parseFailed || (raw !== null && r.reset) };
}
export function loadSettings() { return loadSettingsChecked().settings; }
export function saveSettings(s) { writeJSON(KEYS.settings, s); }
export function getApiKey() { try { return V.sanitizeApiKey(localStorage.getItem(KEYS.apiKey)) || ''; } catch { return ''; } }
export function setApiKey(k) {
  try {
    const v = V.sanitizeApiKey(k);
    if (v) localStorage.setItem(KEYS.apiKey, v); else localStorage.removeItem(KEYS.apiKey);
    // キーが変わったら Twelve Data の「キー無効」の記録を消す
    const b = readJSON(KEYS.blocked, {}); if (b && b.twelvedata) { delete b.twelvedata; writeJSON(KEYS.blocked, b); }
    return !!v || !k;
  } catch { return false; }
}

// 配列キーの検査を一括で行う。report = [{label, dropped, fixed}]
const LIST_RULES = (nowMs, cur) => [
  [KEYS.alerts, 'アラート', (v) => V.sanitizeAlerts(v)],
  [KEYS.calendar, '予定', (v) => V.sanitizeCalendar(v)],
  [KEYS.journal, '日記', (v) => V.sanitizeJournal(v, nowMs, cur)],
  [KEYS.hlines, '水平線', (v) => V.sanitizeHlines(v)],
  [KEYS.trendlines, 'トレンド線', (v) => V.sanitizeTrendlines(v)],
  [KEYS.notified, '通知の記録', (v) => V.sanitizeStrings(v, 120, 200)],
  [KEYS.calNotified, '予定通知の記録', (v) => V.sanitizeStrings(v, 60, 100)],
  [KEYS.blocked, '制限の記録', (v) => V.sanitizeBlocked(v)],
];

// 起動時、どの画面の初期化よりも前に呼ぶ（13-5）
export function sanitizeAll(storage = ls(), nowMs = Date.now()) {
  const report = [];
  if (!storage) return { report, settings: V.defaultSettings() };
  const st = loadSettingsChecked(storage);
  if (st.reset) report.push({ label: '設定', dropped: 0, fixed: 0, reset: true });
  else if (st.fixed.length) report.push({ label: '設定', dropped: 0, fixed: st.fixed.length });
  for (const [key, label, fn] of LIST_RULES(nowMs, st.settings.accountCurrency)) {
    let s = null;
    try { s = storage.getItem(key); } catch { /* noop */ }
    if (s === null || s === undefined) continue;
    let val;
    try { val = JSON.parse(s); } catch { removeKey(key, storage); report.push({ label, dropped: 0, fixed: 0, reset: true }); continue; }
    const r = fn(val);
    if (r.reset) {
      if (key === KEYS.calendar) removeKey(key, storage); // 既定の予定を作り直す
      else writeJSON(key, r.value, storage);
      report.push({ label, dropped: 0, fixed: 0, reset: true });
    } else if (r.dropped || r.fixed) {
      writeJSON(key, r.value, storage);
      report.push({ label, dropped: r.dropped, fixed: r.fixed });
    }
  }
  // ローソク足キャッシュ・長期日足・APIキー: 形が違えば消す
  for (const k of storageKeys(storage)) {
    if (!k || !k.startsWith('ga:cache:')) continue;
    const tf = k.slice(9);
    const raw = readJSON(k, undefined, storage);
    if (!(tf in TIMEFRAMES) || !V.sanitizeCandleCache(raw, nowMs, validateCandles)) { removeKey(k, storage); report.push({ label: 'キャッシュ', dropped: 1, fixed: 0 }); }
  }
  const xs = readJSON(KEYS.xaus, undefined, storage);
  if (xs !== undefined) {
    const ok = xs && typeof xs === 'object' && Number.isFinite(xs.at) && Array.isArray(xs.rows) && xs.rows.length >= 100
      && xs.rows.every((r) => r && Number.isFinite(r.time) && Number.isFinite(r.close) && Number.isFinite(r.high) && Number.isFinite(r.low));
    if (!ok) { removeKey(KEYS.xaus, storage); report.push({ label: '長期日足', dropped: 1, fixed: 0 }); }
  }
  let key = null;
  try { key = storage.getItem(KEYS.apiKey); } catch { /* noop */ }
  if (key !== null && !V.sanitizeApiKey(key)) { removeKey(KEYS.apiKey, storage); report.push({ label: 'APIキー', dropped: 1, fixed: 0 }); }
  return { report, settings: st.settings };
}
export function reportText(report) {
  return report.map((r) => (r.reset ? `${r.label}を既定に戻す` : [r.fixed ? `${r.label} ${r.fixed} 件を修正` : '', r.dropped ? `${r.label} ${r.dropped} 件を除外` : ''].filter(Boolean).join('・'))).filter(Boolean).join('・');
}

export function exportData(settings, includeJournal) {
  const d = { app: 'gold-analysis', version: 1, exportedAt: new Date().toISOString(), settings,
    hlines: readJSON(KEYS.hlines, []), trendlines: readJSON(KEYS.trendlines, []), alerts: readJSON(KEYS.alerts, []), calendar: readJSON(KEYS.calendar, null) };
  if (includeJournal) d.journal = readJSON(KEYS.journal, []);
  return d; // APIキーは含めない
}

// ---------------- インポート（13-5 手順 4、3回目の修正で R2-2 に対応） ----------------
// 1) planImport で「今の件数 → 取り込み後の件数」を計算して画面で確認を取る（まだ何も書かない）
// 2) applyImport は書き込む前に今の状態を ga:importBackup に保存する（1 回だけ元に戻せる）
// mode: 'replace'（置き換え）| 'merge'（追加。id か中身が同じものは除く）
// 取り込める項目が 0 件のキーは書き換えない（壊れたファイルで日記が消えないように）
export const BACKUP_KEY = 'ga:importBackup';
const IMPORT_KEYS = [KEYS.settings, KEYS.alerts, KEYS.calendar, KEYS.journal, KEYS.hlines, KEYS.trendlines];
const sameContent = (a, b) => { const { id: _a, ...x } = a; const { id: _b, ...y } = b; return JSON.stringify(x) === JSON.stringify(y); };

export function checkImportFile(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.app !== 'gold-analysis') throw new Error('このアプリの設定ファイルではありません');
  if (typeof d.version !== 'number' || !Number.isFinite(d.version) || d.version > 1) throw new Error(`対応していない版のファイルです（version ${JSON.stringify(d.version)}。このアプリは version 1 まで読めます）`);
}

export function planImport(d, { storage = ls(), nowMs = Date.now(), mode = 'replace' } = {}) {
  checkImportFile(d);
  // 設定は「ファイルにある項目だけ」を今の設定に反映する。ファイルに settings が無ければ触れない（R3-1）
  const nowSettings = loadSettingsChecked(storage).settings;
  const hasSettings = d.settings !== null && typeof d.settings === 'object' && !Array.isArray(d.settings);
  const ms = V.mergeSettings(nowSettings, hasSettings ? d.settings : null);
  const cur = ms.settings.accountCurrency;
  const lists = [
    ['alerts', KEYS.alerts, 'アラート', (v) => V.sanitizeAlerts(v)],
    ['calendar', KEYS.calendar, '予定', (v) => V.sanitizeCalendar(v)],
    ['journal', KEYS.journal, '日記', (v) => V.sanitizeJournal(v, nowMs, cur)],
    ['hlines', KEYS.hlines, '水平線', (v) => V.sanitizeHlines(v)],
    ['trendlines', KEYS.trendlines, 'トレンド線', (v) => V.sanitizeTrendlines(v)],
  ];
  const rows = [];
  for (const [field, key, label, fn] of lists) {
    if (!Array.isArray(d[field])) continue;
    const inc = fn(JSON.parse(JSON.stringify(d[field])));
    const nowRaw = readJSON(key, null, storage);
    const now = Array.isArray(nowRaw) ? (fn(nowRaw).value || []) : [];
    const incoming = inc.value || [];
    let result, added = 0, dup = 0;
    if (incoming.length === 0) result = null; // 書き換えない
    else if (mode === 'merge') {
      const merged = now.slice();
      for (const x of incoming) {
        if (merged.some((y) => (x.id && y.id === x.id) || sameContent(x, y))) { dup++; continue; }
        merged.push(x); added++;
      }
      result = fn(merged).value;
    } else result = incoming;
    let reason = null;
    if (!result) reason = 'empty';
    else if (JSON.stringify(result) === JSON.stringify(now)) { result = null; reason = 'same'; } // 中身が今と同じなら書かない（R3-2）
    rows.push({ field, key, label, current: now.length, incoming: incoming.length, dropped: inc.dropped, fixed: inc.fixed, added, dup,
      after: result ? result.length : now.length, write: !!result, reason, result });
  }
  const settingsWrite = ms.changed.length > 0;
  return { mode, settings: ms.settings, hasSettings, settingsChanged: ms.changed, settingsRejected: ms.rejected, settingsConflicts: ms.conflicts, settingsWrite, rows,
    changes: settingsWrite || rows.some((r) => r.write) };
}

export function describePlan(plan) {
  const lines = [];
  const cf = plan.settingsConflicts || [];
  const rej = (plan.settingsRejected.length ? `（範囲外・型違いで無視 ${plan.settingsRejected.length} 項目）` : '')
    + (cf.length ? `（項目どうしの条件で取り込まず: ${cf.map((c) => c.message).join('／')}）` : ''); // 理由を分ける（R4-1）
  if (!plan.hasSettings) lines.push('設定: ファイルに無いため変更しません');
  else if (!plan.settingsWrite) lines.push(`設定: 今と同じため変更しません${rej}`);
  else lines.push(`設定: ${plan.settingsChanged.length} 項目を変更（${plan.settingsChanged.slice(0, 5).join('、')}${plan.settingsChanged.length > 5 ? ' ほか' : ''}）${rej}`);
  for (const r of plan.rows) {
    const notes = [r.dropped ? `除外 ${r.dropped} 件` : '', r.fixed ? `修正 ${r.fixed} 件` : '', plan.mode === 'merge' && r.dup ? `重複 ${r.dup} 件` : ''].filter(Boolean).join('・');
    if (!r.write) lines.push(`${r.label}: ${r.reason === 'same' ? (plan.mode === 'merge' ? '追加する項目が無いため' : '今と同じため') : '取り込める項目が 0 件のため'}変更しません（今 ${r.current} 件）${notes ? `（${notes}）` : ''}`);
    else lines.push(`${r.label}: 今 ${r.current} 件 → ${r.after} 件（${plan.mode === 'merge' ? `追加 ${r.added} 件` : `置き換え・ファイル ${r.incoming} 件`}）${notes ? `（${notes}）` : ''}`);
  }
  if (!plan.changes) lines.push('変更される項目はありません（取り込んでも何も変わりません）');
  return lines;
}

// 何も変わらない計画なら書き込みもバックアップもしない（R3-2）
export function applyImport(plan, { storage = ls(), nowMs = Date.now() } = {}) {
  if (!plan.changes) return { changed: false, settings: plan.settings, summary: describePlan(plan).join('・') };
  // 書き込む前に今の状態を保存（1 回だけ元に戻せる）
  const snap = {};
  for (const k of IMPORT_KEYS) { let v = null; try { v = storage.getItem(k); } catch { /* noop */ } snap[k] = v; }
  if (!writeJSON(BACKUP_KEY, { at: nowMs, keys: snap }, storage)) throw new Error('バックアップを保存できないため取り込みを中止しました（空き容量を確認してください）');
  if (plan.settingsWrite) writeJSON(KEYS.settings, plan.settings, storage);
  for (const r of plan.rows) if (r.write) writeJSON(r.key, r.result, storage);
  return { changed: true, settings: plan.settings, summary: describePlan(plan).join('・') };
}

export function backupInfo(storage = ls()) {
  const b = readJSON(BACKUP_KEY, null, storage);
  return b && typeof b === 'object' && Number.isFinite(b.at) && b.keys && typeof b.keys === 'object' ? { at: b.at } : null;
}
export function restoreBackup(storage = ls()) {
  const b = readJSON(BACKUP_KEY, null, storage);
  if (!b || !b.keys) return false;
  for (const k of IMPORT_KEYS) {
    const v = b.keys[k];
    try { if (typeof v === 'string') storage.setItem(k, v); else storage.removeItem(k); } catch { /* noop */ }
  }
  removeKey(BACKUP_KEY, storage); // 戻せるのは 1 回だけ
  return true;
}

// 互換: 確認なしで置き換える（テスト・内部用）。画面からは plan → 確認 → apply を使う
export function importData(d, { storage = ls(), nowMs = Date.now(), mode = 'replace' } = {}) {
  return applyImport(planImport(d, { storage, nowMs, mode }), { storage, nowMs });
}
