/* ポケノート：オフラインでも開けるように、画面の部品だけを端末にとっておく（データは localStorage）。
   まず通信で最新を取りにいき、つながらない時だけ、とっておいた物を使う */
const VER = "pocket-v1";
const FILES = ["./", "./index.html", "./style.css?v=1", "./app.js?v=1", "./manifest.webmanifest", "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VER).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
/* 消すのはポケノートの古い箱だけ（キャッシュは同じドメインの他のアプリと共通なので、名前で絞る。テスター 2026-10-24） */
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("pocket-") && k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VER).then(c => c.put(e.request, copy)).catch(() => {}); return r; })
    .catch(() => caches.match(e.request, {ignoreSearch: false}).then(r => r || caches.match("./index.html"))));
});
