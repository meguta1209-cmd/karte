/* ビートメーカー — オフライン用サービスワーカー
   アプリを更新したら CACHE の数字を1つ上げること。

   重要:
   - このSWは /beat/ 配下だけを扱う。スコープ外のリクエストには一切respondWithしない。
     （ルートの訪販カルテ用SWがこのフォルダを巻き込んで、訪販カルテの
       キャッシュを壊さないよう、こちらで制御を引き取るのが目的）
   - キャッシュ削除は "beatmaker-" で始まるものだけ。caches.keys() は
     オリジン全体を返すので、無条件に消すと訪販カルテのキャッシュまで消える。
*/
const CACHE = "beatmaker-v1";
const ASSETS = ["./", "./index.html", "./manifest.json", "./icon.svg"];

function scopePath() {
  return new URL("./", self.location).pathname;
}

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
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith("beatmaker-") && k !== CACHE)
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
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(scopePath())) return;   // スコープ外は素通し

  /* 更新がすぐ反映されるよう、常にネットワーク優先。圏外のときだけキャッシュ */
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
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
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(r => r || new Response("", { status: 503 })))
  );
});
