/* 結果カウンター チーム版 — オフライン用サービスワーカー
   アプリを更新したら CACHE の数字を1つ上げ、index.html の app.js?v= と style.css?v= も同じ数字にすること
   （ブラウザが古い app.js をとっておいて使うのを防ぐため）。

   重要（beat/sw.js と同じ作法）:
   - このSWは /karte/team/ 配下だけを扱う。スコープ外のリクエストには
     一切 respondWith しない。ルートの訪販カルテ用SWはスコープが /karte/ 全体
     なので、こちらで制御を引き取らないとサブresourceを巻き込まれる。
   - キャッシュ削除は "team-" で始まるものだけ。caches.keys() は
     オリジン全体を返すので、無条件に消すと訪販カルテのキャッシュまで消える。
*/
const VER = "team-v49";
/* 同じサイトに会社ごとの置き場（/karte/team/・/karte/team2/ …）が並ぶので、キャッシュの名前に置き場の住所を付けて分ける
   （2026-10-03 他社版。前は "team-v42" だけだったので、ほかの置き場の分まで消してしまうおそれがあった） */
const CACHE = VER + "@" + new URL("./", self.location).pathname;
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./app.js",
  "./style.css",
  "./firebase-config.js"
];

function scopePath() {
  return new URL("./", self.location).pathname;
}

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: "reload" }))))   // 入れるときも取り直す
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        // 消すのは「自分の置き場の古い版」と「置き場の印が無い前の形」だけ（ほかの会社の置き場の分は消さない）
        keys.filter(k => k.startsWith("team-v") && k !== CACHE && (!k.includes("@") || k.endsWith("@" + scopePath())))
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;          // Googleフォント等は素通し
  if (!url.pathname.startsWith(scopePath())) return;        // スコープ外も素通し

  /* 更新がすぐ反映されるよう、常にネットワーク優先。圏外のときだけキャッシュ */
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req.url, { cache: "no-cache", credentials: "same-origin" })   // ブラウザがとっておいた古いページは使わず、毎回サーバーに確かめる
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./index.html").then(r => r || caches.match("./")))
    );
    return;
  }

  e.respondWith(
    fetch(req, { cache: "no-cache" })   // app.js なども同じ。変わっていなければ確認だけで済む（304）
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || new Response("", { status: 503 })))
  );
});
