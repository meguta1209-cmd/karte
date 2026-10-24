/* ポケノート：オフラインでも開けるように、画面の部品だけを端末にとっておく（データは Firebase。端末にも写しがある）。
   自分のファイル＝まず通信で最新を取りにいき、つながらない時だけ、とっておいた物を使う
   Firebase の本体（www.gstatic.com の版つきのファイル）＝中身が変わらないので、とっておいた物を先に使う（圏外でも開けるように。テスター 2026-10-24） */
const VER = "pocket-v16";
const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const FILES = ["./", "./index.html", "./style.css?v=16", "./app.js?v=16", "./firebase-config.js", "./manifest.webmanifest", "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png",
  FB + "firebase-app.js", FB + "firebase-auth.js", FB + "firebase-firestore.js", FB + "firebase-messaging.js"];
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
/* v5：スマホ通知（Firebase Cloud Messaging の data だけの知らせを受けて、自分で出す）。押すとポケノートを開く
   中身：{data: {title, body, tag, url}}。tag が同じ知らせは上書き（同じ物を何度も並べない） */
self.addEventListener("push", e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (x) { p = {data: {body: e.data ? e.data.text() : ""}}; }
  const d = p.data || p.notification || p;
  e.waitUntil(self.registration.showNotification(d.title || "ポケノート", {
    body: d.body || "", tag: d.tag || undefined, renotify: !!d.tag, icon: "./icons/icon-192.png", badge: "./icons/icon-192.png",
    data: {url: d.url || "./"}}));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(clients.matchAll({type: "window", includeUncontrolled: true}).then(ws => {
    const w = ws.find(c => c.url.startsWith(self.registration.scope));
    if (w) { w.focus(); if ("navigate" in w && w.url !== url) return w.navigate(url).catch(() => {}); return; }
    return clients.openWindow(url);
  }));
});
