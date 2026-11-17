// 市場セッション・週末判定（Intl のタイムゾーン計算で夏時間を自動対応）純粋関数

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map();

export function localParts(timeMs, timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    fmtCache.set(timeZone, f);
  }
  const parts = {};
  for (const p of f.formatToParts(new Date(timeMs))) parts[p.type] = p.value;
  return { weekday: WD[parts.weekday], hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

export const SESSIONS = [
  { key: 'tokyo', name: '東京', tz: 'Asia/Tokyo', open: 9, close: 18 },
  { key: 'london', name: 'ロンドン', tz: 'Europe/London', open: 8, close: 17 },
  { key: 'newyork', name: 'ニューヨーク', tz: 'America/New_York', open: 8, close: 17 },
];

export function isSessionActive(session, timeMs) {
  const p = localParts(timeMs, session.tz);
  if (p.weekday === 0 || p.weekday === 6) return false;
  const m = p.hour * 60 + p.minute;
  return m >= session.open * 60 && m < session.close * 60;
}

export function getSessions(timeMs) {
  const active = SESSIONS.filter((s) => isSessionActive(s, timeMs)).map((s) => s.key);
  return { active, overlap: active.includes('london') && active.includes('newyork') };
}

// NY 時間で 金曜17:00以降・土曜終日・日曜18:00前 → スポット休場
export function isSpotMarketClosed(timeMs) {
  const p = localParts(timeMs, 'America/New_York');
  if (p.weekday === 6) return true;
  if (p.weekday === 5 && p.hour >= 17) return true;
  if (p.weekday === 0 && p.hour < 18) return true;
  return false;
}

// 次にセッションが始まる時刻（ms）。各市場は整数時間のオフセットなので1時間刻みで探す
export function nextSessionOpen(session, timeMs) {
  let t = Math.floor(timeMs / 3600000) * 3600000 + 3600000;
  for (let k = 0; k < 24 * 8; k++, t += 3600000) {
    if (isSessionActive(session, t) && !isSessionActive(session, t - 60000)) return t;
  }
  return null;
}
export function sessionCloseTime(session, timeMs) {
  let t = Math.floor(timeMs / 3600000) * 3600000 + 3600000;
  for (let k = 0; k < 48; k++, t += 3600000) if (!isSessionActive(session, t)) return t;
  return null;
}

// 米国の夏時間かどうか（表示用）
export function isUsDst(timeMs) {
  const p = localParts(timeMs, 'America/New_York');
  const u = new Date(timeMs);
  const diff = ((u.getUTCHours() - p.hour + 24) % 24);
  return diff === 4;
}
