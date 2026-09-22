/* 訪販カルテ — オフライン用サービスワーカー
   アプリを更新したら CACHE の数字を1つ上げること

   このSWのスコープは /karte/ 全体なので、サブフォルダの別アプリ
   （au-template/ や beat/）まで巻き込まないよう2箇所ガードしている。
   下の「他のアプリを巻き込まない」コメント参照。 */
const CACHE = "hohan-karte-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./setup.html",
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
      /* 他のアプリを巻き込まない①: caches.keys() はこのドメイン全部の
         キャッシュを返す。名前で絞らずに消すと、beat/ など別アプリの
         キャッシュまで削除してしまう。 */
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith("hohan-karte-") && k !== CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  /* 画面そのものは「まず新しいのを取りに行く。圏外ならキャッシュ」 */
  if (req.mode === "navigate") {
    /* 他のアプリを巻き込まない②: このスコープは /karte/ 全体なので、
       ガードが無いと au-template/ や beat/ を開いたときに、その中身を
       訪販カルテのトップページとしてキャッシュに上書きしてしまう。
       圏外時もそれらのURLに訪販カルテを返してしまう。
       スコープ直下のページ以外は、SWが何もせずネットワークに任せる。 */
    const base = new URL("./", self.location).pathname;
    const rest = new URL(req.url).pathname.slice(base.length);
    if (rest !== "" && rest !== "index.html" && rest !== "setup.html") return;

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

  /* それ以外は「キャッシュ優先」で即表示 */
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok && new URL(req.url).origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => new Response("", {status: 503, statusText: "offline"})))
  );
});
