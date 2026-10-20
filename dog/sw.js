/* わんカルテ — オフライン用サービスワーカー
   アプリを更新したら CACHE の数字を1つ上げること。
   同じサイトに他のアプリも置くので、消すキャッシュは自分の "dog-karte-" だけに限る */
const CACHE = "dog-karte-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./setup.html",
  "./help.html",
  "./help-img/start.png",
  "./help-img/karte.png",
  "./help-img/record.png",
  "./help-img/report.png",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("dog-karte-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  /* 画面そのものは「まず新しいのを取りに行く。圏外ならキャッシュ」 */
  if (req.mode === "navigate") {
    const rest = new URL(req.url).pathname.slice(new URL(self.registration.scope).pathname.length);
    if (rest !== "" && rest !== "index.html" && rest !== "setup.html") return;
    const key = rest === "setup.html" ? "./setup.html" : "./index.html";
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(key).then(r => r || caches.match("./")))
    );
    return;
  }

  /* それ以外は「キャッシュ優先」で即表示 */
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => new Response("", {status: 503, statusText: "offline"})))
  );
});
