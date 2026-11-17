/* フォーマット入力 — オフライン用（karte/format/ 専用）
   アプリを更新したら CACHE の数字を1つ上げ、index.html の parse.js?v= と app.js?v= も同じ数字にすること。
   消すのは自分の接頭辞（format-v）の古い物だけ（同じサイトのほかのアプリのキャッシュには触らない） */
const VER = "format-v3";
const CACHE = VER + "@" + new URL("./", self.location).pathname;
const ASSETS = ["./", "./index.html", "./parse.js?v=3", "./app.js?v=3", "./manifest.webmanifest", "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  const mine = "@" + new URL("./", self.location).pathname;
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("format-v") && k.endsWith(mine) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  /* 画面そのものは「まず新しいのを取りに行く。圏外ならキャッシュ」 */
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(res => { if (res.ok && new URL(req.url).pathname.replace(/index\.html$/, "") === new URL("./", self.location).pathname) { const copy = res.clone(); caches.open(CACHE).then(c => c.put("./index.html", copy)).catch(() => {}); } return res; })   // 正しく取れたアプリの画面だけ覚える（404 や打ち間違えの URL は覚えない。テスター A1）
      .catch(() => caches.match("./index.html", {cacheName: CACHE}).then(r => r || caches.match("./", {cacheName: CACHE}))));
    return;
  }
  /* それ以外はキャッシュ優先（版の数字が URL に付いているので、更新すると取り直す） */
  e.respondWith(caches.match(req, {cacheName: CACHE}).then(hit => hit || fetch(req).then(res => {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
    return res;
  })));
});
