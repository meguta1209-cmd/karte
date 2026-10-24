/* ポケノート：オフラインでも開けるように、画面の部品だけを端末にとっておく（データは Firebase。端末にも写しがある）。
   自分のファイル＝まず通信で最新を取りにいき、つながらない時だけ、とっておいた物を使う
   Firebase の本体（www.gstatic.com の版つきのファイル）＝中身が変わらないので、とっておいた物を先に使う（圏外でも開けるように。テスター 2026-10-24） */
const VER = "pocket-v3";
const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const FILES = ["./", "./index.html", "./style.css?v=3", "./app.js?v=3", "./firebase-config.js", "./manifest.webmanifest", "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png",
  FB + "firebase-app.js", FB + "firebase-auth.js", FB + "firebase-firestore.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VER).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => {})))).then(() => self.skipWaiting())); });
/* 消すのはポケノートの古い箱だけ（キャッシュは同じドメインの他のアプリと共通なので、名前で絞る。テスター 2026-10-24） */
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("pocket-") && k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = e.request.url;
  if (url.startsWith(FB)) {
    e.respondWith(caches.match(e.request, {ignoreVary: true}).then(hit => hit || fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(VER).then(c => c.put(e.request, copy)).catch(() => {}); } return r; })));
    return;
  }
  if (new URL(url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VER).then(c => c.put(e.request, copy)).catch(() => {}); return r; })
    .catch(() => caches.match(e.request, {ignoreSearch: false}).then(r => r || caches.match("./index.html"))));
});
