/* 筋トレアプリ：電波が無くても開けるように、画面の部品を端末にとっておく（記録は localStorage なので、ここには入らない）。
   まず通信で最新を取りにいき、つながらない時だけ、とっておいた物を使う。
   同じドメインのほかのアプリ（結果カウンター・ポケノートなど）と置き場を共有するので、消すのは "gym-" で始まる古い物だけ。 */
const VER = "gym-v1";
const FILES = ["./", "./index.html", "./style.css?v=1", "./data.js?v=1", "./avatars.js?v=1", "./app.js?v=1", "./manifest.webmanifest",
  "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png",
  "./img/miu_1.jpg", "./img/miu_2.jpg", "./img/miu_3.jpg", "./img/miu_4.jpg", "./img/miu_5.jpg", "./img/miu_6.jpg", "./img/miu_7.jpg", "./img/miu_8.jpg"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VER).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("gym-") && k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(VER).then(c => c.put(e.request, copy)).catch(() => {}); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html"))));
});
