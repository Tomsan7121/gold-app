// Service Worker（01_research.md 追-3。3回目の修正で N9 に対応）
// - HTML・JS・CSS・アイコン・vendor はすべて「自分の VERSION のキャッシュ」から返す（キャッシュ優先）。
//   ネットワークの応答をキャッシュに書くのはインストール時だけ。このため、新しい SW が待機している間も
//   旧 SW は旧版の HTML と旧版の JS/CSS をそろえて返し、新旧が混ざらない（N9）。
// - 新版は、ブラウザが sw.js の変化を見つけてインストールし、利用者が「更新する」を押したときに切り替わる
//   （SKIP_WAITING → controllerchange で 1 回だけ再読み込み）。
// - VERSION は tools/update_sw_version.py が ASSETS の中身のハッシュから作る（手で書き換えない）。
//   app/ を変えたら必ず `python tools/update_sw_version.py` を実行する。tests.html でも一致を確かめる。
// - キャッシュに無いナビゲーション（tests.html など）はネットワークへ。API・外部の通信は扱わない。
const VERSION = 'gold-0b66ebcd2e73';
const ASSETS = [
  './index.html', './manifest.webmanifest',
  './css/style.css',
  './js/app.js', './js/chart.js', './js/controller.js', './js/data.js', './js/dom.js', './js/indicators.js', './js/levels.js',
  './js/sessions.js', './js/signals.js', './js/stats.js', './js/store.js', './js/trade.js', './js/validate.js',
  './js/ui-alerts.js', './js/ui-analysis.js', './js/ui-settings.js', './js/ui-tools.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './vendor/lightweight-charts.standalone.production.js', './vendor/lightweight-charts.LICENSE.txt', './vendor/lightweight-charts.NOTICE.txt',
];
const SCOPE = self.registration.scope;
const ASSET_PATHS = new Set(ASSETS.map((a) => new URL(a, SCOPE).pathname));
const ROOT_PATH = new URL('./', SCOPE).pathname;
const INDEX_URL = new URL('./index.html', SCOPE).href;

self.addEventListener('install', (e) => {
  // skipWaiting は呼ばない（トレード中に勝手に入れ替わらないように）
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('gold-') && k !== VERSION).map((k) => caches.delete(k)))));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API・外部は触らない
  const isApp = url.pathname === ROOT_PATH || ASSET_PATHS.has(url.pathname);
  if (!isApp) return; // tests.html・expected_values.json などはネットワークのまま
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const key = url.pathname === ROOT_PATH ? INDEX_URL : req;
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit; // 同じ VERSION のキャッシュから返す（HTML と JS/CSS の版がそろう）
    return fetch(req); // インストール前など。キャッシュには書かない
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs.length ? cs[0].focus() : self.clients.openWindow('./index.html'))));
});
