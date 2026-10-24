/* ポケノート v2（2026-10-24）：社長専用のタスク・予定・メモ＋秘書。
   データは結果カウンターと同じ Firebase（kekka-counter-2026）の hub/<社長のuid>/…（ルールで社長本人だけ・ほかのメンバーは読めない）。
   端末にも写しを持つので、圏外でも使えて、つながったら自動で送る。v1 でスマホの中（localStorage "pocket-v1"）に入れた分は、最初のログインで移す。
     tasks:  {id, title, note, imp(重要), urg(急ぎ), due:"YYYY-MM-DD"|null, time:"HH:MM"|"", done, doneAt, createdAt, updatedAt, src:"me"}
     events: {id, title, date:"YYYY-MM-DD", allDay, start:"HH:MM", end:"HH:MM", note, color, createdAt, updatedAt, src:"me"}
     memos:  {id, text, status:"wait"(振り分け待ち)|"memo"(メモのまま)|"done"(振り分け済み), result:{kind,label}|null, createdAt, updatedAt}
     chat:   {id, role:"me"|"ai", text, at, status:"wait"(PCの秘書がまだ読んでいない)}
     meta/brief {text, at}＝秘書のひと言（PCの秘書が書く）／meta/pc {at}＝PCの秘書が最後に動いた時刻
   結果カウンターの自分のアポ・前確・再架電・予定（records・tasks の uid＝自分）も読んで、今日と予定に出す（見るだけ） */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, query, where, onSnapshot, setDoc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getMessaging, getToken, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { firebaseConfig } from "./firebase-config.js";

const OWNER_EMAIL = "meguta1209@gmail.com";
const KC_URL = "https://meguta1209-cmd.github.io/karte/team/";
const KEY = "pocket-v1", MOVED = "pocket-v1-moved";
const fb = initializeApp(firebaseConfig), auth = getAuth(fb);
const fs = initializeFirestore(fb, {localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})});
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const pad = n => String(n).padStart(2, "0");
const WD = "日月火水木金土";
const nowIso = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const parseYmd = s => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const todayStr = () => ymd(new Date());
const hm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
const toMin = t => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + m; };
const fromMin = n => pad(Math.floor(n / 60) % 24) + ":" + pad(n % 60);
const mdw = s => { const d = parseYmd(s); return (d.getMonth() + 1) + "/" + d.getDate() + "（" + WD[d.getDay()] + "）"; };
const tsd = v => v && typeof v.toDate === "function" ? v.toDate() : v instanceof Date ? v : null;
let tt = null;
function toast(msg) { const el = $("toast"); el.textContent = msg; el.classList.add("on"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("on"), 2400); }

/* ---------- 保存（Firebase）----------
   画面の作りは v1 のまま：db の中身を直してから save() を呼ぶ。save() は「前に送った形」と比べて、変わった物だけを書き、消えた物を消す */
const COLS = ["tasks", "events", "memos", "chat"];
const db = {tasks: [], events: [], memos: [], chat: []};
const shadow = {tasks: new Map(), events: new Map(), memos: new Map(), chat: new Map()};
let U = null, unsubs = [], canSave = true, brief = null, pcAt = null, kcRecs = [], kcTasks = [];
const P = col => `hub/${U}/${col}`;
const plain = o => JSON.parse(JSON.stringify(o));
/* Googleカレンダーをそろえる仕組み（GAS）が書く項目。アプリは新しく作る時の gcalId:"" 以外は書かない
   （古い写しで上書きして、Googleに二重に作られないように。書くときは merge＝送った項目だけ。テスター 2026-10-24） */
const GAS_FIELDS = ["gcalId", "gcalKey", "link", "recur", "syncedAt"];
function save() {
  if (!U) return;
  COLS.forEach(col => {
    const seen = new Set();
    db[col].forEach(o => {
      seen.add(o.id);
      const s = JSON.stringify(o), isNew = !shadow[col].has(o.id);
      if (shadow[col].get(o.id) === s) return;
      shadow[col].set(o.id, s);
      const data = plain(o);
      if (col === "events") {
        if (isNew && !data.gcalId) { data.gcalId = ""; data.dirty = false; data.deleted = false; }
        else GAS_FIELDS.forEach(k => delete data[k]);
      }
      setDoc(doc(fs, P(col), o.id), data, {merge: true}).catch(e => { console.error(e); toast("保存できませんでした"); });
    });
    [...shadow[col].keys()].filter(id => !seen.has(id)).forEach(id => {
      shadow[col].delete(id);
      deleteDoc(doc(fs, P(col), id)).catch(e => { console.error(e); toast("消せませんでした"); });
    });
  });
}
/* v1 でスマホの中に入れた分を、最初のログインで移す（同じ id で書くので、2回動いても増えない）。元の中身は控えとして残す */
async function moveLocal() {
  let x = null;
  try { if (localStorage.getItem(MOVED)) return; x = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return; }
  const items = x && x.v === 1 ? COLS.flatMap(col => (x[col] || []).filter(o => o && o.id).map(o => [col, o])) : [];
  if (items.length) {
    try {
      for (let i = 0; i < items.length; i += 400) {
        const b = writeBatch(fs);
        items.slice(i, i + 400).forEach(([col, o]) => b.set(doc(fs, P(col), o.id), col === "events" ? Object.assign({gcalId: "", dirty: false, deleted: false}, plain(o)) : plain(o), {merge: true}));
        await b.commit();
      }
      toast("スマホの中の " + items.length + "件をクラウドに移しました");
    } catch (e) { console.error(e); toast("スマホの中の分を移せませんでした（あとでもう一度）"); return; }
  }
  try { localStorage.setItem(MOVED, nowIso()); } catch (e) {}
}

/* ---------- ログイン（社長だけ） ---------- */
function gate(msg, login, other) { $("gate").hidden = false; $("gateMsg").textContent = msg; $("loginBtn").hidden = !login; $("logoutBtn2").hidden = !other; }
$("loginBtn").onclick = async () => { try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (e) { toast("ログインできませんでした"); } };
$("logoutBtn2").onclick = () => signOut(auth);
onAuthStateChanged(auth, u => {
  unsubs.forEach(f => f()); unsubs = []; U = null;
  kpiUnsubs.forEach(f => f()); kpiUnsubs = []; kpiDays = {}; kpiFor = "";
  COLS.forEach(c => { db[c] = []; shadow[c].clear(); }); kcRecs = []; kcTasks = []; brief = null; pcAt = null;
  if (!u) { gate("Googleアカウントでログインしてください（社長のアカウント）。", true, false); return; }
  if (String(u.email || "").toLowerCase() !== OWNER_EMAIL) { gate("このアプリは社長専用です（" + (u.email || "") + "）。", false, true); return; }
  U = u.uid; $("gate").hidden = true; start();
});
function start() {
  const err = what => e => { console.error(what, e); toast(what + "を読み込めませんでした"); };
  COLS.forEach(col => unsubs.push(onSnapshot(collection(fs, P(col)), s => {
    db[col] = s.docs.map(d => ({...d.data(), id: d.id}));
    shadow[col] = new Map(db[col].map(o => [o.id, JSON.stringify(o)]));
    if ($("sheet").hidden) render();
  }, err({tasks: "タスク", events: "予定", memos: "メモ", chat: "秘書の会話"}[col]))));
  unsubs.push(onSnapshot(doc(fs, P("meta"), "brief"), s => { brief = s.exists() ? s.data() : null; if (view === "today" && $("sheet").hidden) render(); }, () => {}));
  unsubs.push(onSnapshot(doc(fs, P("meta"), "pc"), s => { const a = s.exists() ? s.data().at : null; pcAt = a ? tsd(a) || new Date(a) : null; if (view === "ai" && $("sheet").hidden) render(); }, () => {}));
  /* 結果カウンターの自分の分（ルールで読める：uid＝自分）。見るだけ */
  unsubs.push(onSnapshot(query(collection(fs, "records"), where("uid", "==", U), where("pending", "==", true)), s => {
    kcRecs = s.docs.map(x => { const d = x.data(); const m = d.memo ? {...d.memo, when: tsd(d.memo.when)} : null; return {id: x.id, ...d, t: tsd(d.t), memo: m}; });
    if ($("sheet").hidden) render();
  }, e => console.error("結果カウンター", e)));
  unsubs.push(onSnapshot(query(collection(fs, "tasks"), where("uid", "==", U), where("done", "==", false)), s => {
    kcTasks = s.docs.map(x => { const d = x.data(); return {id: x.id, ...d, when: tsd(d.when)}; });
    if ($("sheet").hidden) render();
  }, e => console.error("結果カウンターの予定", e)));
  subscribeKpi();
  moveLocal();
  render();
}

/* ---------- 結果カウンターの予定（見るだけ）を、予定の形に ----------
   アポ＝商談の時刻から90分、再架電＝15分、予定（前確など）＝30分。前確は前日の同じ時刻（月曜の商談は土曜）＝今日のタスクに出す */
function kcEvents() {
  const out = [];
  const add = (key, when, mins, title, note) => { if (!when) return; out.push({id: "kc:" + key, kc: true, title, date: ymd(when), allDay: false, start: hm(when), end: fromMin(Math.min(23 * 60 + 59, toMin(hm(when)) + mins)), note, color: "orange"}); };
  kcRecs.forEach(r => {
    if (!r.memo || !r.memo.when || r.canceled) return;
    if (r.r === "アポ") add("apo:" + r.id, r.memo.when, 90, "商談：" + (r.memo.shop || "（店名なし）"), "結果カウンター");
    else if (r.r === "再架電") add("call:" + r.id, r.memo.when, 15, "再架電：" + (r.memo.shop || "（店名なし）"), "結果カウンター" + (r.memo.tel ? " ・ " + r.memo.tel : ""));
  });
  kcTasks.forEach(t => add("task:" + t.id, t.when, 30, (t.kind || "予定") + "：" + (t.title || t.shop || ""), "結果カウンター"));
  return out;
}
function kcPres() {
  const now = new Date(), out = [];
  kcRecs.forEach(r => {
    if (r.r !== "アポ" || !r.memo || !r.memo.when || r.canceled) return;
    const w = r.memo.when, pre = new Date(w); pre.setDate(pre.getDate() - (w.getDay() === 1 ? 2 : 1));
    const res = r.res && tsd(r.res.w) && +tsd(r.res.w) === +w ? r.res : null;
    if (w > now && !(res && res.pre) && (!r.t || pre > r.t)) out.push({id: r.id, when: pre, w, title: "前確：" + (r.memo.shop || "（店名なし）"), sub: (w.getDay() === 1 ? "月曜" : "明日") + " " + hm(w) + " の商談 ・ 結果カウンター"});
  });
  return out;
}
const openKC = () => window.open(KC_URL, "_blank", "noopener");

/* ---------- 今日の数字（結果カウンターの stats から。今週＝月曜から） ---------- */
let kcOpen = false;   // 今日の画面で、結果カウンターの行を開いているか
const WEEK_GOAL = 20, NO_ANSWER = ["留守", "繋がらない", "使われてない"];
let kpiFor = "", kpiUnsubs = [], kpiDays = {};
function subscribeKpi() {
  kpiUnsubs.forEach(f => f()); kpiUnsubs = []; kpiDays = {};
  const T = parseYmd(todayStr()), mon = addDays(T, -((T.getDay() + 6) % 7));
  kpiFor = todayStr();
  for (let d = new Date(mon); d <= T; d = addDays(d, 1)) {
    const key = ymd(d);
    kpiUnsubs.push(onSnapshot(doc(fs, "stats", key), s => {
      const c = s.exists() && s.data().c && s.data().c[U] ? s.data().c[U] : {};
      kpiDays[key] = c;
      if (view === "today" && $("sheet").hidden) render();
    }, () => {}));
  }
}
function kpiNow() {
  const c = kpiDays[todayStr()] || {}, n = Object.values(c).reduce((a, v) => a + (Number(v) || 0), 0);
  const ans = n - NO_ANSWER.reduce((a, k) => a + (Number(c[k]) || 0), 0);
  const week = Object.values(kpiDays).reduce((a, x) => a + (Number(x["アポ"]) || 0), 0);
  return {n, ans, apo: Number(c["アポ"]) || 0, week};
}


/* ---------- 画面の切りかえ ---------- */
let view = "today";
const VIEWS = ["today", "task", "cal", "memo", "ai"];
function go(v) {
  view = v;
  VIEWS.forEach(x => $("v-" + x).hidden = x !== v);
  $("tabs").querySelectorAll("button").forEach(b => b.dataset.go === v ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  const ai = v === "ai";
  $("ask").classList.toggle("chatbar", ai);
  $("askIn").placeholder = ai ? "秘書に頼む…" : "秘書に頼む・メモする…";
  $("memoFab").hidden = v !== "memo";
  $("areaSeg").hidden = v === "ai";
  syncAskBtn();
  if (v === "cal") calScrolled = false;
  window.scrollTo(0, 0);
  render();
  if (ai) setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 0);
}
$("tabs").addEventListener("click", e => { const b = e.target.closest("button[data-go]"); if (b) go(b.dataset.go); });

/* ---------- タスクの部品 ---------- */
const QUADS = [
  {k: "11", imp: true, urg: true, name: "重要・急ぎ", color: "var(--red)", pill: "red"},
  {k: "10", imp: true, urg: false, name: "重要", color: "var(--blue)", pill: "blue"},
  {k: "01", imp: false, urg: true, name: "急ぎ", color: "var(--orange)", pill: "orange"},
  {k: "00", imp: false, urg: false, name: "そのうち", color: "var(--gray)", pill: ""}];
const quadOf = t => QUADS.find(q => q.imp === !!t.imp && q.urg === !!t.urg);
const dueAt = t => t.due ? new Date(parseYmd(t.due).getTime() + (t.time ? toMin(t.time) : 24 * 60 - 1) * 6e4) : null;
const isOver = t => !t.done && !!t.due && dueAt(t) < new Date();
const isToday = t => !t.done && t.due === todayStr();
function dueLabel(t) {
  if (!t.due) return "";
  const diff = Math.round((parseYmd(t.due) - parseYmd(todayStr())) / 864e5);
  const day = diff === 0 ? "今日" : diff === 1 ? "明日" : diff === -1 ? "昨日" : mdw(t.due);
  return day + (t.time ? " " + t.time : "") + (diff >= 0 && !t.time ? "まで" : "");
}
const byDue = (a, b) => (a.due ? dueAt(a) : Infinity) - (b.due ? dueAt(b) : Infinity) || String(a.createdAt).localeCompare(String(b.createdAt));
function taskCell(t, withPill) {
  const q = quadOf(t), over = isOver(t);
  return `<div class="cell${t.done ? " strike" : ""}" data-tedit="${esc(t.id)}"><button class="circle${t.done ? " done" : ""}" data-tdone="${esc(t.id)}" aria-label="${t.done ? "未完了に戻す" : "完了にする"}"></button>
    <div class="grow"><div class="t">${esc(t.title || "（題なし）")}</div>${t.due || t.note ? `<div class="s${over ? " over" : ""}">${esc([dueLabel(t), t.note ? t.note.split("\n")[0] : ""].filter(Boolean).join(" ・ "))}</div>` : ""}</div>
    ${withPill && q.pill && !t.done ? `<span class="pill ${q.pill}">${q.name}</span>` : ""}</div>`;
}

/* ---------- スマホの通知（v5・Firebase Cloud Messaging） ----------
   「オンにする」を押す（iPhone はホーム画面に追加したアプリで）→ 通知の許可 → この端末の宛先（トークン）を hub/<社長>/meta/push の devices に保存。
   送るのは社長の Google で動く GAS（朝8時・予定の15分前）と、PC の秘書の道具（返事・社長待ち）。受けて出すのは sw.js */
const VAPID_KEY = "BKzGnPVZTWr1OYlDMsoSal70yYhh_16VvR7NKcfGH4GE5bjDi9fUTBvXV6I6UTROm6wSI024-sMhQK7mQaIXfdY";   // Firebase のコンソールで作った「ウェブプッシュの鍵」（公開鍵・2026-10-24 秘書が社長の代わりに作成）
const PUSH_LS = "pocket-push";
const pushSaved = () => { try { return localStorage.getItem(PUSH_LS) || ""; } catch (e) { return ""; } };
function pushLabel() {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return "このブラウザでは使えません（ホーム画面に追加したポケノートで開いてください）";
  if (Notification.permission === "denied") return "止まっています（iPhone の 設定 → ポケノート → 通知 で許可してください）";
  if (Notification.permission === "granted" && pushSaved()) return "オン";
  return VAPID_KEY ? "オフ" : "準備中（鍵を作ったあとで使えます）";
}
const pushBtn = () => !VAPID_KEY || !("Notification" in window) || Notification.permission === "denied" ? "" :
  `<button type="button" class="pill blue" data-push="1" style="padding:6px 12px;font-size:13px">${Notification.permission === "granted" && pushSaved() ? "つなぎ直す" : "オンにする"}</button>`;
const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return "d" + (h >>> 0).toString(36); };
async function enablePush() {
  if (!VAPID_KEY) { toast("通知の準備中です"); return; }
  try {
    /* 許可を聞くのは、押した直後のいちばん最初に（iPhone は押した直後でないと聞けない） */
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("通知が許可されませんでした"); render(); return; }
    if (!(await isSupported())) { toast("このブラウザでは通知が使えません（ホーム画面のポケノートで開いてください）"); return; }
    const reg = await navigator.serviceWorker.register("./sw.js");
    await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(fb), {vapidKey: VAPID_KEY, serviceWorkerRegistration: reg});
    if (!token) { toast("通知の宛先を作れませんでした"); return; }
    const id = hashStr(token);
    await setDoc(doc(fs, P("meta"), "push"), {devices: {[id]: {token, ua: navigator.userAgent.slice(0, 160), at: nowIso()}}}, {merge: true});
    try { localStorage.setItem(PUSH_LS, id); } catch (e) {}
    toast("通知をオンにしました"); render();
  } catch (e) { console.error(e); toast("通知をオンにできませんでした（" + (e.code || e.message || "") + "）"); }
}

/* ---------- 仕事／プライベート（v4・社長 2026-10-24） ----------
   tasks・events・memos に area:"work"|"private"（無い古い物は仕事）。結果カウンター・今日の数字・社長待ちはいつも仕事。
   いちばん上の切り替え（端末に覚える）で見る物を絞る。アプリで新しく入れる物は今選んでいる方（「すべて」なら仕事）。入力の画面でワンタップで変えられる */
const AREA_KEY = "pocket-area";
let areaF = (() => { try { const v = localStorage.getItem(AREA_KEY); return v === "work" || v === "private" ? v : "all"; } catch (e) { return "all"; } })();
const areaOfX = x => x && x.area === "private" ? "private" : "work";
const inArea = x => areaF === "all" || areaOfX(x) === areaF;
const newArea = () => areaF === "private" ? "private" : "work";
const showWork = () => areaF !== "private";
function syncAreaSeg() { $("areaSeg").querySelectorAll("[data-a]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.a === areaF))); }
$("areaSeg").addEventListener("click", e => {
  const b = e.target.closest("[data-a]"); if (!b) return;
  areaF = b.dataset.a; try { localStorage.setItem(AREA_KEY, areaF); } catch (x) {}
  syncAreaSeg(); render();
});
/* 入力の画面の「仕事／プライベート」 */
const areaChips = cur => `<div class="lab">区分</div><div class="chips" id="fArea"><button type="button" class="chip ar" data-ar="work" aria-pressed="${cur !== "private"}">仕事</button><button type="button" class="chip ar" data-ar="private" aria-pressed="${cur === "private"}">プライベート</button></div>`;
function wireAreaChips() { const box = $("fArea"); if (box) box.addEventListener("click", e => { const b = e.target.closest("[data-ar]"); if (!b) return; box.querySelectorAll("[data-ar]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); }); }
const pickedArea = () => { const b = $("fArea") && $("fArea").querySelector('[aria-pressed="true"]'); return b ? b.dataset.ar : newArea(); };

/* 社長待ち（チームが社長を待っている作業。秘書が wait:true・from・steps・link を付けて入れる）。4マス・リストには出さない */
const isWait = t => !!t.wait;
const waitsOpen = () => db.tasks.filter(t => isWait(t) && !t.done).sort(byDue);
function waitCell(t) {
  const sub = [t.from ? t.from + "が待っています" : "", dueLabel(t), t.steps ? String(t.steps).split("\n")[0] : ""].filter(Boolean).join(" ・ ");
  return `<div class="cell${t.done ? " strike" : ""}" data-tedit="${esc(t.id)}"><button class="circle${t.done ? " done" : ""}" data-tdone="${esc(t.id)}" aria-label="${t.done ? "未完了に戻す" : "済みにする"}"></button>
    <div class="grow"><div class="t">${esc(t.title || "（題なし）")}</div>${sub ? `<div class="s${isOver(t) ? " over" : ""}">${esc(sub)}</div>` : ""}</div>${t.done ? "" : `<span class="pill orange">待ち</span>`}</div>`;
}

/* ---------- 予定の部品 ---------- */
const COLORS = {blue: ["var(--blue)", "rgba(0,122,255,.14)"], orange: ["var(--orange)", "rgba(255,149,0,.16)"], purple: ["var(--purple)", "rgba(175,82,222,.14)"], green: ["var(--green)", "rgba(52,199,89,.16)"], red: ["var(--red)", "rgba(255,59,48,.14)"]};
const colorOf = e => COLORS[e.color] || COLORS.blue;
/* 自分で入れた予定＋結果カウンターの予定（見るだけ・橙） */
const eventsOn = s => [...db.events.filter(inArea), ...(showWork() ? kcEvents() : [])].filter(e => e.date === s && !e.deleted).sort((a, b) => (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || toMin(a.start) - toMin(b.start));
const evAttr = e => e.kc ? `data-kc="1"` : `data-eedit="${esc(e.id)}"`;
const LONG_MIN = 240;   // これ以上（4時間以上）の予定は、日の表示で細い帯にする
const isLongEv = e => !e.allDay && !e.kc && toMin(e.end || e.start) - toMin(e.start) >= LONG_MIN;
function eventCell(e) {
  return `<div class="cell" ${evAttr(e)}><div class="time">${e.allDay ? "終日" : esc(e.start)}${e.allDay ? "" : `<small>${esc(e.end)}</small>`}</div><div class="bar" style="background:${colorOf(e)[0]}"></div>
    <div class="grow"><div class="t">${esc(e.title || "（予定）")}</div>${e.note ? `<div class="s">${esc(e.note.split("\n")[0])}</div>` : ""}</div></div>`;
}

/* ---------- 今日 ---------- */
function renderToday() {
  const n = new Date(), T = todayStr();
  $("tDate").textContent = `${n.getMonth() + 1}月${n.getDate()}日 ${WD[n.getDay()]}曜日`;
  const evs = eventsOn(T);
  const open = db.tasks.filter(t => !t.done && !isWait(t) && inArea(t)), waits = showWork() ? waitsOpen() : [];
  const over = open.filter(isOver), todays = open.filter(t => isToday(t) && !isOver(t));
  const doneToday = db.tasks.filter(t => t.done && !isWait(t) && inArea(t) && t.doneAt && ymd(new Date(t.doneAt)) === T);
  const waiting = db.memos.filter(m => m.status === "wait" && inArea(m)).length;
  /* 結果カウンターの前確：前確の日が今日まで（商談の前まで）の分を、今日のタスクに */
  const E = addDays(parseYmd(T), 1), pres = (showWork() ? kcPres() : []).filter(p => p.when < E).sort((a, b) => a.when - b.when);
  const next = evs.find(e => !e.allDay && toMin(e.end || e.start) > n.getHours() * 60 + n.getMinutes());
  const hello = n.getHours() < 11 ? "おはようございます。" : n.getHours() < 18 ? "おつかれさまです。" : "おつかれさまでした。";
  const say = hello + `今日は予定が${evs.length}件、今日のタスクが${todays.length + pres.length}件です。` + (over.length ? `期限切れのタスクが${over.length}件あります。` : "") +
    (next ? `次は ${next.start}「${next.title}」。` : "") + (waiting ? `振り分け待ちのメモが${waiting}件。` : "") + (waits.length ? `チームが社長を待っている作業が${waits.length}件あります。` : "");
  /* 秘書のひと言：PCの秘書が今日書いた物があればそれ、なければ自動のまとめ */
  const bAt = brief && brief.at ? tsd(brief.at) || new Date(brief.at) : null;
  const useBrief = showWork() && brief && brief.text && bAt && ymd(bAt) === T;   // プライベートの時は自動のまとめ
  /* いちばん上：チームが社長を待っている作業（無い時は出さない） */
  /* 期限の近い順に3件だけ＋「ほか n件」（社長「タスクぱんぱんになっちゃう」） */
  let h = waits.length ? `<div class="sec bell"><span>🔔 チームが社長を待っています（${waits.length}）</span><button data-gotask="wait">すべて</button></div><div class="group wait">${waits.slice(0, 3).map(waitCell).join("")}${waits.length > 3 ? `<button class="cell plain" data-gotask="wait"><div class="grow"><div class="t" style="color:var(--blue);font-size:15px">ほか ${waits.length - 3}件を見る</div></div></button>` : ""}</div><div style="height:14px"></div>` : "";
  h += `<div class="hisho"><div class="av">秘</div><div class="grow"><div class="t">${esc(useBrief ? brief.text : say)}</div><div class="s">${useBrief ? "秘書 ・ " + hm(bAt) : "ポケノートのまとめ ・ " + hm(n)}</div></div></div>`;
  if (kpiFor !== T && U) subscribeKpi();   // 日付が変わったら読み直す
  const k = kpiNow();
  if (showWork()) h += `<div class="sec"><span>今日の数字（結果カウンター）</span><button data-kc="1">開く</button></div><div class="kpi" data-kc="1"><div><b>${k.n}</b><span>コール</span></div><div><b>${k.ans}</b><span>対応</span></div><div><b>${k.apo}</b><span>アポ</span></div><div><b>${k.week}<small style="font-size:13px;color:var(--sub)">/${WEEK_GOAL}</small></b><span>今週のアポ</span></div></div>`;
  /* 予定：これからの物を3件＋「ほか n件」（社長「全部入れるとパンパンで醜い」）。結果カウンターの分は1行にまとめて、押すと開く */
  const nowMin = n.getHours() * 60 + n.getMinutes();
  const mine = evs.filter(e => !e.kc), kcs = evs.filter(e => e.kc);
  const coming = mine.filter(e => e.allDay || toMin(e.end || e.start) > nowMin), shown = coming.slice(0, 3), rest = mine.length - shown.length;
  let eh = shown.map(eventCell).join("");
  if (!mine.length && !kcs.length) eh = `<div class="empty">今日の予定はありません</div>`;
  else if (!shown.length && mine.length) eh = `<div class="empty">今日の予定は終わりました</div>`;
  if (rest > 0) eh += `<button class="cell plain" data-gotoday="1"><div class="grow"><div class="t" style="color:var(--blue);font-size:15px">ほか ${rest}件を見る${coming.length < mine.length ? "（終わった予定も）" : ""}</div></div></button>`;
  if (kcs.length) {
    const cnt = k => kcs.filter(e => e.id.indexOf("kc:" + k + ":") === 0).length;
    const parts = [["apo", "商談"], ["call", "再架電"], ["task", "予定"]].map(([k, l]) => cnt(k) ? l + cnt(k) : "").filter(Boolean).join("・");
    const kNext = kcs.find(e => toMin(e.end || e.start) > nowMin);
    eh += `<button class="cell" data-kctoggle="1"><div class="time" style="color:var(--orange)">結果</div><div class="bar" style="background:var(--orange)"></div><div class="grow"><div class="t">結果カウンター：${esc(parts)}</div><div class="s">${kNext ? "次は " + esc(kNext.start + " " + kNext.title) : "今日の分は終わりました"}</div></div><span class="chev">${kcOpen ? "⌃" : "⌄"}</span></button>`;
    if (kcOpen) eh += kcs.map(eventCell).join("");
  }
  h += `<div class="sec"><span>予定</span><button data-goto="cal">すべて</button></div><div class="group">${eh}</div>`;
  const list = [...over.sort(byDue), ...todays.sort(byDue), ...doneToday];
  const preRows = pres.map(p => `<div class="cell" data-kc="1"><span class="circle" style="opacity:.35"></span><div class="grow"><div class="t">${esc(p.title)}</div><div class="s${p.when < n ? " over" : ""}">${esc((ymd(p.when) === T ? "今日 " : mdw(ymd(p.when)) + " ") + hm(p.when) + "まで ・ " + p.sub)}</div></div><span class="pill orange">前確</span></div>`);
  h += `<div class="sec"><span>今日のタスク</span><button data-goto="task">すべて</button></div><div class="group">${list.map(t => taskCell(t, true)).join("") + preRows.join("") || `<div class="empty">今日のタスクはありません</div>`}</div>`;
  h += `<div class="sec"><span>通知</span></div><div class="group"><div class="cell plain"><div class="grow"><div class="t" style="font-size:15px">🔔 スマホの通知：${esc(pushLabel())}</div><div class="s">秘書の返事・社長待ち・今日が期限のタスク（朝8時）・予定の15分前。23時〜7時は送りません</div></div>${pushBtn()}</div></div>`;
  h += `<p class="note">橙＝結果カウンターの予定（押すと結果カウンターが開きます）。ログイン中：${esc(auth.currentUser ? auth.currentUser.email : "")} ・ <button class="linkbtn" data-logout="1">ログアウト</button></p>`;
  $("todayBody").innerHTML = h;
}

/* ---------- タスク ---------- */
let taskF = "quad";
$("taskSeg").addEventListener("click", e => { const b = e.target.closest("[data-f]"); if (!b) return; taskF = b.dataset.f; $("taskSeg").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); renderTasks(); });
$("taskAdd").onclick = () => taskForm(null, {});
function renderTasks() {
  const open = db.tasks.filter(t => !t.done && !isWait(t) && inArea(t));
  if (taskF === "wait") {
    const w = waitsOpen(), doneW = db.tasks.filter(t => isWait(t) && t.done).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt))).slice(0, 20);
    $("taskBody").innerHTML = `<div class="sec bell"><span>🔔 チームが社長を待っています（${w.length}）</span></div><div class="group wait">${w.map(waitCell).join("") || `<div class="empty">チームが社長を待っている作業はありません</div>`}</div>` +
      (doneW.length ? `<div class="sec"><span>済み（最近）</span></div><div class="group">${doneW.map(waitCell).join("")}</div>` : "") +
      `<p class="note">押すと手順と場所が出ます。済んだら丸を押すと、チームに伝わります。</p>`;
    return;
  }
  if (taskF === "quad") {
    $("taskBody").innerHTML = `<div class="quad">${QUADS.map(q => {
      const items = open.filter(t => quadOf(t) === q).sort(byDue);
      return `<div class="q"><div class="qh"><span class="dot" style="background:${q.color}"></span>${q.name}<span class="qn">${items.length}</span></div>
        ${items.map(t => `<div class="qi" data-tedit="${esc(t.id)}"><button class="circle" data-tdone="${esc(t.id)}" aria-label="完了にする"></button><div>${esc(t.title || "（題なし）")}${t.due ? `<small class="${isOver(t) ? "over" : ""}">${esc(dueLabel(t))}</small>` : ""}</div></div>`).join("")}
        <button class="qadd" data-qadd="${q.k}">＋ 足す</button></div>`;
    }).join("")}</div>`;
  } else if (taskF === "list") {
    const T = parseYmd(todayStr()), E = ymd(addDays(T, 1)), W = addDays(T, 7);
    const groups = [["期限切れ", open.filter(isOver)], ["今日", open.filter(t => isToday(t) && !isOver(t))], ["明日", open.filter(t => t.due === E && !isOver(t))],
      ["今週", open.filter(t => t.due && t.due > E && parseYmd(t.due) < W)], ["それより先", open.filter(t => t.due && parseYmd(t.due) >= W)], ["期限なし", open.filter(t => !t.due)]];
    const shown = groups.filter(g => g[1].length);
    $("taskBody").innerHTML = shown.map(([l, list]) => `<div class="sec"><span>${l}</span><span>${list.length}</span></div><div class="group">${list.sort(byDue).map(t => taskCell(t, true)).join("")}</div>`).join("")
      || `<div class="group"><div class="empty">タスクはありません。右上の＋で足せます</div></div>`;
  } else {
    const done = db.tasks.filter(t => t.done && inArea(t)).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
    $("taskBody").innerHTML = done.length ? `<div class="group">${done.slice(0, 200).map(t => taskCell(t, false)).join("")}</div><button class="btn danger" id="clearDone">完了したタスクを全部消す</button>`
      : `<div class="group"><div class="empty">完了したタスクはまだありません</div></div>`;
    const delN = done.filter(t => !isWait(t)).length;   /* 見ている区分の完了だけ消す（ほかの区分・社長待ちの済みは残す。テスター） */
    const c = $("clearDone"); if (c) c.onclick = () => { if (!confirm("完了したタスク " + delN + "件を消します。よろしいですか？")) return; db.tasks = db.tasks.filter(t => !(t.done && inArea(t) && !isWait(t))); save(); render(); toast("消しました"); };
  }
}
function toggleTask(id) {
  const t = db.tasks.find(x => x.id === id); if (!t) return;
  t.done = !t.done; t.doneAt = t.done ? nowIso() : null; t.updatedAt = nowIso(); save(); render();
  toast(t.done ? (isWait(t) ? "済みにしました（チームに伝わります）" : "完了にしました") : "未完了に戻しました");
}

/* ---------- 予定 ---------- */
let calDate = parseYmd(todayStr()), calMode = "day", calScrolled = false;
const HOUR = 56;
$("calMode").addEventListener("click", e => { const b = e.target.closest("[data-m]"); if (!b) return; calMode = b.dataset.m; $("calMode").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); calScrolled = false; renderCal(); });
$("calToday").onclick = () => { calDate = parseYmd(todayStr()); calScrolled = false; renderCal(); };
$("evAdd").onclick = () => eventForm(null, {date: ymd(calDate)});
function renderCal() {
  const T = todayStr(), sel = ymd(calDate), ws = addDays(calDate, -calDate.getDay());
  $("calMonth").textContent = (calDate.getMonth() + 1) + "月";
  const we = addDays(ws, 6);
  $("calTitle").textContent = calMode === "day" ? `${calDate.getMonth() + 1}月${calDate.getDate()}日 ${WD[calDate.getDay()]}曜日`
    : `${ws.getMonth() + 1}月${ws.getDate()}日〜${we.getMonth() === ws.getMonth() ? "" : (we.getMonth() + 1) + "月"}${we.getDate()}日`;
  $("weekStrip").innerHTML = `<button class="arrow" data-wk="-1" aria-label="前の週">‹</button>` + [0, 1, 2, 3, 4, 5, 6].map(i => {
    const d = addDays(ws, i), s = ymd(d);
    return `<button class="wd${s === T ? " today" : ""}${calMode === "day" && s === sel ? " sel" : ""}" data-day="${s}">${WD[i]}<b>${d.getDate()}</b><i class="${[...db.events.filter(inArea), ...(showWork() ? kcEvents() : [])].some(e => e.date === s && !e.deleted) ? "on" : ""}"></i></button>`;
  }).join("") + `<button class="arrow" data-wk="1" aria-label="次の週">›</button>`;
  if (calMode === "week") {
    $("calBody").innerHTML = [0, 1, 2, 3, 4, 5, 6].map(i => { const s = ymd(addDays(ws, i)), evs = eventsOn(s);
      return `<div class="sec"><span>${mdw(s)}${s === T ? " ・ 今日" : ""}</span><button data-dadd="${s}">＋</button></div><div class="group">${evs.map(eventCell).join("") || `<div class="empty">予定なし</div>`}</div>`; }).join("");
    return;
  }
  const evs = eventsOn(sel), all = evs.filter(e => e.allDay);
  /* 4時間以上の予定（テレアポ10〜18時など、毎日の決まった予定）は左の細い帯にして場所を取らない（社長「パンパンで醜い」） */
  const longs = evs.filter(isLongEv), timed = evs.filter(e => !e.allDay && !isLongEv(e)), off = longs.length * 16;
  /* 重なる予定は横に並べる */
  const lanes = [], laneOf = {}, groupN = {};
  let grp = [], gEnd = -1;
  const flush = () => { const n = Math.max(1, ...grp.map(e => laneOf[e.id] + 1)); grp.forEach(e => groupN[e.id] = n); grp = []; };
  timed.forEach(e => {
    const s = toMin(e.start), en = Math.max(s + 15, toMin(e.end || e.start));
    if (grp.length && s >= gEnd) { flush(); lanes.length = 0; }
    let l = lanes.findIndex(x => x <= s); if (l < 0) { l = lanes.length; lanes.push(0); }
    lanes[l] = en; laneOf[e.id] = l; grp.push(e); gEnd = Math.max(gEnd, en);
  });
  flush();
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  let tl = "";
  for (let h = 0; h < 24; h++) tl += `<div class="hr" data-slot="${h}"><span>${h}時</span></div>`;
  tl += longs.map((e, i) => {
    const s = toMin(e.start), en = toMin(e.end), c = colorOf(e);
    return `<button class="ev2 long" ${evAttr(e)} title="${esc(e.title + " " + e.start + "〜" + e.end)}" style="top:${s / 60 * HOUR}px;height:${(en - s) / 60 * HOUR - 2}px;left:${52 + i * 16}px;width:13px;background:${c[1]};border-color:${c[0]};color:${c[0]}"><span>${esc(e.title || "（予定）")}</span></button>`;
  }).join("");
  tl += timed.map(e => {
    const s = toMin(e.start), en = Math.max(s + 20, toMin(e.end || e.start)), n = groupN[e.id] || 1, l = laneOf[e.id] || 0, c = colorOf(e);
    /* 45分より短い予定は、題と時刻を1行に（30分の予定で時刻が下で切れていた。テスター） */
    return `<button class="ev2${e.kc ? " kc" : ""}${en - s < 45 ? " tiny" : ""}" ${evAttr(e)} style="top:${s / 60 * HOUR}px;height:${Math.max(22, (en - s) / 60 * HOUR - 2)}px;left:calc(${52 + off}px + (100% - ${56 + off}px) * ${l} / ${n});width:calc((100% - ${56 + off}px) / ${n} - 2px);background:${c[1]};border-color:${c[0]};color:${c[0]}">${esc(e.title || "（予定）")}<small>${esc(e.start)}〜${esc(e.end)}</small></button>`;
  }).join("");
  if (sel === T) tl += `<div class="now" style="top:${nowMin / 60 * HOUR}px"></div>`;
  $("calBody").innerHTML = (all.length ? `<div class="allday">${all.map(e => `<button ${evAttr(e)} style="background:${colorOf(e)[1]};color:${colorOf(e)[0]}">終日 ${esc(e.title || "（予定）")}</button>`).join("")}</div>` : "") +
    `<div class="tlwrap" id="tlwrap"><div class="tl">${tl}</div></div>`;
  const w = $("tlwrap"), top = w.getBoundingClientRect().top;
  w.style.height = Math.max(240, window.innerHeight - top - $("tabs").offsetHeight - 70 + window.scrollY) + "px";
  if (!calScrolled) {
    const y = Math.max(0, ((sel === T ? nowMin - 60 : 8 * 60) / 60) * HOUR);
    w.scrollTop = y; requestAnimationFrame(() => { w.scrollTop = y; }); setTimeout(() => { w.scrollTop = y; }, 60);
    calScrolled = true;
  }
}
$("weekStrip").addEventListener("click", e => {
  const a = e.target.closest("[data-wk]"); if (a) { calDate = addDays(calDate, 7 * Number(a.dataset.wk)); calScrolled = false; renderCal(); return; }
  const d = e.target.closest("[data-day]"); if (d) { calDate = parseYmd(d.dataset.day); if (calMode === "week") { calMode = "day"; $("calMode").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.m === "day"))); } calScrolled = false; renderCal(); }
});
$("calBody").addEventListener("click", e => {
  if (e.target.closest("[data-eedit],[data-kc]")) return;
  const s = e.target.closest("[data-slot]"); if (s) { const h = Number(s.dataset.slot); eventForm(null, {date: ymd(calDate), start: pad(h) + ":00", end: pad(Math.min(23, h + 1)) + ":00"}); return; }
  const d = e.target.closest("[data-dadd]"); if (d) eventForm(null, {date: d.dataset.dadd});
});

/* ---------- メモ ---------- */
$("memoAdd").onclick = () => memoForm(null);
$("memoFab").onclick = () => memoForm(null);
$("memoSearch").addEventListener("input", () => renderMemos());
function memoTag(m) {
  if (m.status === "done" && m.result) return `<div class="tag">→ ${esc(m.result.label)}</div>`;
  if (m.status === "memo") return `<div class="tag gray">${esc(m.result && m.result.label || "メモのまま")}</div>`;
  if (m.status === "doing") return `<div class="tag gray">秘書が振り分け中…</div>`;
  return `<div class="tag gray">振り分け待ち（${pcOn() ? "PCの秘書がもうすぐ見ます" : "PCが開いたら秘書が振り分けます"}）</div>`;
}
/* PCの秘書が動いているか（見張りが5分以内に動いた） */
const pcOn = () => !!pcAt && Date.now() - pcAt.getTime() < 5 * 6e4;
function whenText(iso) {
  const d = new Date(iso), s = ymd(d), T = todayStr();
  return s === T ? "今日 " + hm(d) : s === ymd(addDays(new Date(), -1)) ? "昨日 " + hm(d) : (d.getMonth() + 1) + "月" + d.getDate() + "日";
}
function renderMemos() {
  const q = $("memoSearch").value.trim().toLowerCase();
  const list = db.memos.filter(m => inArea(m) && (!q || String(m.text).toLowerCase().includes(q))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $("memoBody").innerHTML = `<div class="group">${list.map(m => {
    const lines = String(m.text || "").split("\n"), head = lines[0] || "（空のメモ）", rest = lines.slice(1).join(" ").trim();
    return `<button class="memo" data-medit="${esc(m.id)}"><div class="t">${esc(head)}</div>${rest ? `<div class="s">${esc(rest)}</div>` : ""}${memoTag(m)}<div class="s" style="font-size:12px;margin-top:4px">${whenText(m.createdAt)}</div></button>`;
  }).join("") || `<div class="empty">${q ? "見つかりません" : "メモはまだありません。右上の✎か、下の欄から書けます"}</div>`}</div>`;
}
function addMemo(text, area) {
  const m = {id: newId(), text, status: "wait", result: null, area: area || newArea(), createdAt: nowIso(), updatedAt: nowIso()};
  db.memos.push(m); save(); return m;
}

/* ---------- 秘書 ---------- */
function renderAi() {
  const on = pcOn();
  $("pcState").className = "pc" + (on ? " on" : "");
  $("pcState").innerHTML = on ? `<i></i>PCの秘書：対応中（パソコンが開いています）` : `<i></i>PCの秘書：お休み中（送った文はためておいて、PCが開いたら届きます）${pcAt ? " ・ 最後 " + esc(whenText(pcAt.toISOString())) : ""}`;
  let h = `<div class="msg ai">ここに頼みごとを書いてください。予定・タスクに入れる、メンバーに頼む、などを秘書がやります。</div>`, last = "";
  const list = db.chat.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const ICON = {task: ["var(--blue)", "✓"], event: ["var(--red)", "予"], memo: ["var(--gray)", "メ"], member: ["#1c1c1e", "人"]};
  list.forEach((c, i) => {
    const d = new Date(c.at), day = ymd(d);
    const stamp = day === todayStr() ? "今日 " + hm(d) : (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm(d);
    if (day + pad(d.getHours()) !== last) { h += `<div class="when">${stamp}</div>`; last = day + pad(d.getHours()); }
    h += `<div class="msg ${c.role === "me" ? "me" : "ai"}">${esc(c.text)}</div>`;
    if (c.role !== "me" && Array.isArray(c.items) && c.items.length) h += `<div class="card2">${c.items.map(x => { const ic = ICON[x.kind] || ICON.memo; return `<div class="row2"><span class="ico" style="background:${ic[0]}">${ic[1]}</span><span class="grow">${esc(x.label)}</span><span class="state">${esc(x.state || "")}</span></div>`; }).join("")}</div>`;
    if (c.role === "me" && (c.status === "wait" || c.status === "doing")) {
      const later = list.slice(i + 1).some(x => x.role === "me");   // 続けて送った分は、いちばん下だけに出す
      if (!later) h += `<div class="stat">${c.status === "doing" ? "秘書が対応中…" : on ? "届きました（秘書がもうすぐ見ます）" : "ためています（PCが開いたら届きます）"}</div>`;
    }
  });
  $("chatBody").innerHTML = h;
}

/* ---------- 入力欄（どの画面にも） ---------- */
function syncAskBtn() { const has = !!$("askIn").value.trim(); $("askSend").hidden = !has && view !== "ai"; $("askMic").hidden = has || view === "ai"; }
$("askIn").addEventListener("input", syncAskBtn);
$("ask").addEventListener("submit", e => {
  e.preventDefault();
  const text = $("askIn").value.trim(); if (!text) return;
  if (view === "ai") { db.chat.push({id: newId(), role: "me", text, at: nowIso(), status: "wait"}); save(); $("askIn").value = ""; syncAskBtn(); render(); setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 0); return; }
  addMemo(text); $("askIn").value = ""; syncAskBtn(); $("askIn").blur(); render(); toast("メモに入れました");
});
let rec = null;
$("askMic").onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $("askIn").focus(); toast("キーボードのマイクで話して入れられます"); return; }
  if (rec) { rec.stop(); return; }
  try {
    rec = new SR(); rec.lang = "ja-JP"; rec.interimResults = false; rec.maxAlternatives = 1;
    $("askMic").classList.add("rec");
    rec.onresult = e => { const t = Array.from(e.results).map(r => r[0].transcript).join(""); $("askIn").value = ($("askIn").value + " " + t).trim(); syncAskBtn(); };
    rec.onend = () => { rec = null; $("askMic").classList.remove("rec"); $("askIn").focus(); };
    rec.onerror = () => { toast("聞き取れませんでした。キーボードのマイクも使えます"); };
    rec.start();
  } catch (e) { rec = null; $("askMic").classList.remove("rec"); $("askIn").focus(); }
};

/* ---------- 下から出る画面 ---------- */
let sheetDone = null, sheetSnap = "";
const sheetState = () => [...$("sheetBody").querySelectorAll("input,textarea")].map(x => x.type === "checkbox" ? x.checked : x.value).join("\u0001");
function openSheet(title, html, onDone, doneLabel) {
  $("sheetTitle").textContent = title; $("sheetBody").innerHTML = html;
  $("sheetDone").textContent = doneLabel || "保存"; $("sheetDone").style.visibility = onDone ? "visible" : "hidden";
  sheetDone = onDone || null; $("scrim").hidden = $("sheet").hidden = false; $("sheetBody").scrollTop = 0;
  setTimeout(() => { sheetSnap = sheetState(); }, 0);
}
function closeSheet() { $("scrim").hidden = $("sheet").hidden = true; sheetDone = null; }
function closeSafely() { if (sheetDone && sheetState() !== sheetSnap && !confirm("入力した内容を保存せずに閉じますか？")) return; closeSheet(); }
$("sheetCancel").onclick = closeSafely; $("scrim").onclick = closeSafely;
$("sheetDone").onclick = () => { if (sheetDone) sheetDone(); };
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").hidden) closeSafely(); });
const sw = (id, on) => `<label class="sw"><input type="checkbox" id="${id}"${on ? " checked" : ""}><span></span></label>`;

/* タスクの入力（新しく／直す）。pre＝下書き {title, note, imp, urg, due, time, memoId} */
function taskForm(t, pre) {
  const v = t || Object.assign({title: "", note: "", imp: false, urg: false, due: null, time: ""}, pre);
  const T = parseYmd(todayStr()), fri = addDays(T, ((5 - T.getDay()) + 7) % 7);
  const quick = [["今日", ymd(T)], ["明日", ymd(addDays(T, 1))], ["今週の金曜", ymd(fri)], ["期限なし", ""]];
  /* 社長待ち：だれが待っているか・手順・場所（URL ならボタンで開く／ファイルの場所は文字とコピー） */
  const isUrl = s => /^https?:\/\//i.test(String(s || "").trim());
  const waitBox = t && isWait(t) ? `<div class="waitbox"><div class="from">🔔 ${esc(t.from || "チーム")}が待っています${t.due ? " ・ " + esc(dueLabel(t)) : ""}</div>
      ${t.steps ? `<div class="steps">${esc(t.steps)}</div>` : ""}
      ${t.link ? (isUrl(t.link) ? `<div class="row3"><a class="btn" href="${esc(t.link.trim())}" target="_blank" rel="noopener">開く</a></div>` : `<div class="path">${esc(t.link)}</div><div class="row3"><button type="button" class="btn" id="fCopy">場所をコピー</button></div>`) : ""}
      <div class="row3"><button type="button" class="btn" id="fDone2" style="color:var(--green);font-weight:600">${t.done ? "未完了に戻す" : "済んだ（チームに伝える）"}</button></div></div>` : "";
  openSheet(t ? (isWait(t) ? "社長待ち" : "タスクを直す") : "タスクを足す", `${waitBox}
    <input class="field" id="fTitle" placeholder="やること" value="${esc(v.title)}" autocomplete="off" enterkeyhint="done">
    <div class="lab">分け方（4マス）</div>
    <div class="fgroup"><div class="frow">重要${sw("fImp", v.imp)}</div><div class="frow">急ぎ${sw("fUrg", v.urg)}</div></div>
    <div class="lab">期限</div>
    <div class="fgroup"><div class="frow">日付<input type="date" id="fDate" value="${esc(v.due || "")}"></div><div class="frow">時刻（なくてもOK）<input type="time" id="fTime" value="${esc(v.time || "")}"></div></div>
    <div class="chips" id="fQuick">${quick.map(([l, d]) => `<button type="button" class="chip" data-q="${d}" aria-pressed="${(v.due || "") === d}">${l}</button>`).join("")}</div>
    <div class="lab">メモ</div>
    <textarea class="field" id="fNote" placeholder="（なくてもOK）">${esc(v.note || "")}</textarea>
    ${t && isWait(t) ? "" : areaChips(t ? areaOfX(t) : (v.area || newArea()))}
    ${t ? `<button type="button" class="btn" id="fDone">${t.done ? "未完了に戻す" : "完了にする"}</button><button type="button" class="btn danger" id="fDel">このタスクを消す</button>` : ""}`, () => saveTask(t, v));
  wireAreaChips();
  $("fQuick").addEventListener("click", e => { const b = e.target.closest("[data-q]"); if (!b) return; $("fDate").value = b.dataset.q; if (!b.dataset.q) $("fTime").value = ""; $("fQuick").querySelectorAll("[data-q]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); });
  $("fDate").addEventListener("input", () => $("fQuick").querySelectorAll("[data-q]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.q === $("fDate").value))));
  if (t) {
    $("fDone").onclick = () => { closeSheet(); toggleTask(t.id); };
    if ($("fDone2")) $("fDone2").onclick = () => { closeSheet(); toggleTask(t.id); };
    if ($("fCopy")) $("fCopy").onclick = async () => {
      try { await Promise.race([navigator.clipboard.writeText(t.link), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500))]); toast("コピーしました"); }
      catch (e) { toast("コピーできませんでした（長押しで選んでください）"); }
    };
    $("fDel").onclick = () => { if (!confirm("このタスクを消します。よろしいですか？")) return; db.tasks = db.tasks.filter(x => x.id !== t.id); save(); closeSheet(); render(); toast("消しました"); };
  } else setTimeout(() => $("fTitle").focus(), 80);
}
function saveTask(t, v) {
  const title = $("fTitle").value.trim();
  if (!title) { toast("やることを入れてください"); return; }
  const due = $("fDate").value || null, time = due ? $("fTime").value || "" : "";
  const data = {title, note: $("fNote").value.trim(), imp: $("fImp").checked, urg: $("fUrg").checked, due, time, updatedAt: nowIso()};
  if (!(t && isWait(t))) data.area = pickedArea();
  if (t) Object.assign(t, data);
  else {
    const nt = Object.assign({id: newId(), done: false, doneAt: null, createdAt: nowIso(), src: "me"}, data);
    db.tasks.push(nt);
    if (v.memoId) markMemo(v.memoId, "task", "タスク「" + title + "」に入れました");
  }
  save(); closeSheet(); render(); toast(t ? "直しました" : "タスクに入れました");
}

/* 予定の入力（新しく／直す）。pre＝下書き {title, date, start, end, allDay, note, memoId} */
function eventForm(e, pre) {
  /* Googleのくり返し予定は見るだけ（直すのは Googleカレンダーで） */
  if (e && e.recur) {
    openSheet("予定", `<div class="group"><div class="cell plain"><div class="grow"><div class="t">${esc(e.title)}</div><div class="s">${esc(mdw(e.date) + (e.allDay ? " 終日" : " " + e.start + "〜" + e.end))}</div>${e.note ? `<div class="s">${esc(e.note)}</div>` : ""}</div></div></div>
      ${e.link ? `<a class="btn" href="${esc(e.link)}" target="_blank" rel="noopener">Googleカレンダーで開く</a>` : ""}<p class="note">Googleカレンダーのくり返しの予定です。直すときは Googleカレンダーで直してください（数分でそろいます）。</p>`);
    return;
  }
  const n = new Date(), next = fromMin(Math.min(23 * 60, (n.getHours() + 1) * 60));
  const v = e || Object.assign({title: "", date: todayStr(), allDay: false, start: next, end: fromMin(Math.min(23 * 60 + 59, toMin(next) + 60)), note: "", color: newArea() === "private" ? "green" : "blue", area: newArea()}, pre);
  openSheet(e ? "予定を直す" : "予定を足す", `
    <input class="field" id="eTitle" placeholder="予定の名前" value="${esc(v.title)}" autocomplete="off" enterkeyhint="done">
    <div class="lab">日時</div>
    <div class="fgroup"><div class="frow">終日${sw("eAll", v.allDay)}</div><div class="frow">日付<input type="date" id="eDate" value="${esc(v.date)}"></div>
      <div class="frow" id="eRowS">開始<input type="time" id="eStart" value="${esc(v.start || "09:00")}"></div><div class="frow" id="eRowE">終了<input type="time" id="eEnd" value="${esc(v.end || "10:00")}"></div></div>
    <div class="lab">色</div>
    <div class="chips" id="eColor">${Object.keys(COLORS).map(k => `<button type="button" class="chip" data-c="${k}" aria-pressed="${(v.color || "blue") === k}" style="color:${(v.color || "blue") === k ? "#fff" : COLORS[k][0]};${(v.color || "blue") === k ? "background:" + COLORS[k][0] : ""}">●</button>`).join("")}</div>
    <div class="lab">メモ</div>
    <textarea class="field" id="eNote" placeholder="場所・相手など（なくてもOK）">${esc(v.note || "")}</textarea>
    ${areaChips(e ? areaOfX(e) : (v.area || newArea()))}
    ${e ? `<button type="button" class="btn danger" id="eDel">この予定を消す</button>` : ""}
    ${e && e.link ? `<a class="btn" href="${esc(e.link)}" target="_blank" rel="noopener">Googleカレンダーで開く</a>` : ""}
    <p class="note">${e && e.src === "gcal" ? "Googleカレンダーの予定です。直す・消すと、数分でGoogleにもそろいます。" : "Googleカレンダーとは数分おきにそろえます（そろえる仕組みが動いている時）。"}</p>`, () => saveEvent(e, v));
  wireAreaChips();
  const syncAll = () => { const a = $("eAll").checked; $("eRowS").hidden = $("eRowE").hidden = a; };
  $("eAll").addEventListener("change", syncAll); syncAll();
  $("eStart").addEventListener("change", () => { if (toMin($("eEnd").value) <= toMin($("eStart").value)) $("eEnd").value = fromMin(Math.min(23 * 60 + 59, toMin($("eStart").value) + 60)); });
  $("eColor").addEventListener("click", ev => { const b = ev.target.closest("[data-c]"); if (!b) return; $("eColor").querySelectorAll("[data-c]").forEach(x => { const on = x === b; x.setAttribute("aria-pressed", String(on)); x.style.background = on ? COLORS[x.dataset.c][0] : ""; x.style.color = on ? "#fff" : COLORS[x.dataset.c][0]; }); });
  if (e) $("eDel").onclick = () => { if (!confirm("この予定を消します。よろしいですか？")) return; e.deleted = true; e.updatedAt = nowIso(); save();   /* 印だけ（文書を消すのはカレンダーをそろえる仕組み。Googleにあれば Google からも消す） */ closeSheet(); render(); toast("消しました"); };
  else setTimeout(() => $("eTitle").focus(), 80);
}
function saveEvent(e, v) {
  const title = $("eTitle").value.trim(), date = $("eDate").value;
  if (!title) { toast("予定の名前を入れてください"); return; }
  if (!date) { toast("日付を入れてください"); return; }
  const allDay = $("eAll").checked;
  let start = allDay ? "" : $("eStart").value || "09:00", end = allDay ? "" : $("eEnd").value || "";
  if (!allDay && toMin(end) <= toMin(start)) end = fromMin(Math.min(23 * 60 + 59, toMin(start) + 60));
  const c = $("eColor").querySelector('[aria-pressed="true"]');
  const data = {title, date, allDay, start, end, note: $("eNote").value.trim(), color: c ? c.dataset.c : "blue", area: pickedArea(), updatedAt: nowIso()};
  if (e) { Object.assign(e, data); e.dirty = true; }   // 直した印→そろえる仕組みが Google を直す（Googleにまだ無い予定は、作る時に今の中身で作る）
  else {
    db.events.push(Object.assign({id: newId(), createdAt: nowIso(), src: "me"}, data));
    if (v.memoId) markMemo(v.memoId, "event", "予定（" + mdw(date) + (allDay ? "" : " " + start) + "）に入れました");
  }
  calDate = parseYmd(date);
  save(); closeSheet(); render(); toast(e ? "直しました" : "予定に入れました");
}

/* メモ（新しく／直す・タスクや予定にする） */
function memoForm(m) {
  openSheet(m ? "メモ" : "新しいメモ", `
    <textarea class="field big" id="mText" placeholder="思いついたこと・あとでやること・聞いた話…">${esc(m ? m.text : "")}</textarea>
    ${areaChips(m ? areaOfX(m) : newArea())}
    ${m ? `<div class="chips"><button type="button" class="chip" id="mTask">タスクにする</button><button type="button" class="chip" id="mEvent">予定にする</button><button type="button" class="chip" id="mKeep" aria-pressed="${m.status === "memo"}">メモのまま（振り分けない）</button></div>
      <p class="note">${m.status === "done" && m.result ? "→ " + esc(m.result.label) + "<br>" : ""}書いた日時：${esc(whenText(m.createdAt))}</p>
      <button type="button" class="btn danger" id="mDel">このメモを消す</button>` : `<p class="note">書いたメモは、PCの秘書がつながったら「予定・タスク・メモのまま」に振り分けます。</p>`}`, () => saveMemo(m));
  if (m) {
    const firstLine = () => ($("mText").value.split("\n")[0] || "").trim().slice(0, 60);
    const ar = () => pickedArea();   // メモで選んでいる区分を、タスク・予定にも引き継ぐ
    $("mTask").onclick = () => { saveMemoText(m); taskForm(null, {title: firstLine(), note: $("mText").value.split("\n").slice(1).join("\n").trim(), memoId: m.id, area: ar()}); };
    $("mEvent").onclick = () => { saveMemoText(m); eventForm(null, {title: firstLine(), date: todayStr(), note: $("mText").value.split("\n").slice(1).join("\n").trim(), memoId: m.id, area: ar(), color: ar() === "private" ? "green" : "blue"}); };
    $("mKeep").onclick = () => { saveMemoText(m); m.status = m.status === "memo" ? "wait" : "memo"; m.result = null; m.updatedAt = nowIso(); save(); closeSheet(); render(); toast(m.status === "memo" ? "メモのままにしました" : "振り分け待ちに戻しました"); };
    $("mDel").onclick = () => { if (!confirm("このメモを消します。よろしいですか？")) return; db.memos = db.memos.filter(x => x.id !== m.id); save(); closeSheet(); render(); toast("消しました"); };
  } else setTimeout(() => $("mText").focus(), 80);
  wireAreaChips();
}
function saveMemoText(m) { const t = $("mText").value.trim(); if (t && t !== m.text) { m.text = t; m.updatedAt = nowIso(); save(); } }
function saveMemo(m) {
  const text = $("mText").value.trim();
  if (!text) { if (!m) { closeSheet(); return; } toast("中身が空です（消すときは下のボタン）"); return; }
  if (m) { m.text = text; m.area = pickedArea(); m.updatedAt = nowIso(); } else addMemo(text, pickedArea());
  save(); closeSheet(); render(); toast(m ? "直しました" : "メモしました");
}
function markMemo(id, kind, label) { const m = db.memos.find(x => x.id === id); if (!m) return; m.status = "done"; m.result = {kind, label}; m.updatedAt = nowIso(); }

/* ---------- 押したとき（まとめて） ---------- */
document.addEventListener("click", e => {
  const t = e.target;
  const gt = t.closest("[data-goto]"); if (gt) { go(gt.dataset.goto); return; }
  const pu = t.closest("[data-push]"); if (pu) { enablePush(); return; }
  const kt = t.closest("[data-kctoggle]"); if (kt) { kcOpen = !kcOpen; render(); return; }
  const gd = t.closest("[data-gotoday]"); if (gd) { calDate = parseYmd(todayStr()); calMode = "day"; $("calMode").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.m === "day"))); go("cal"); return; }
  const gk = t.closest("[data-gotask]"); if (gk) { taskF = gk.dataset.gotask; $("taskSeg").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.f === taskF))); go("task"); return; }
  const dn = t.closest("[data-tdone]"); if (dn) { e.stopPropagation(); toggleTask(dn.dataset.tdone); return; }
  const qa = t.closest("[data-qadd]"); if (qa) { const k = qa.dataset.qadd; taskForm(null, {imp: k[0] === "1", urg: k[1] === "1"}); return; }
  const te = t.closest("[data-tedit]"); if (te) { const x = db.tasks.find(y => y.id === te.dataset.tedit); if (x) taskForm(x); return; }
  const kc = t.closest("[data-kc]"); if (kc) { openKC(); return; }
  const lo = t.closest("[data-logout]"); if (lo) { if (confirm("ログアウトしますか？")) signOut(auth); return; }
  const ee = t.closest("[data-eedit]"); if (ee) { const x = db.events.find(y => y.id === ee.dataset.eedit); if (x) eventForm(x); return; }
  const me = t.closest("[data-medit]"); if (me) { const x = db.memos.find(y => y.id === me.dataset.medit); if (x) memoForm(x); return; }
});

function render() {
  $("waitDot").hidden = !showWork() || !db.tasks.some(t => isWait(t) && !t.done);
  $("taskSeg").querySelector('[data-f="wait"]').hidden = !showWork();
  if (!showWork() && taskF === "wait") { taskF = "quad"; $("taskSeg").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.f === "quad"))); }   // タスクのタブの赤い印＝チームが社長を待っている作業がある
  if (view === "today") renderToday(); else if (view === "task") renderTasks(); else if (view === "cal") renderCal(); else if (view === "memo") renderMemos(); else renderAi();
}
/* 日付が変わったら・別のタブで直したら、描き直す */
setInterval(() => { if ($("sheet").hidden && (view === "today" || view === "cal")) render(); }, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && $("sheet").hidden) render(); });
window.addEventListener("resize", () => { if (view === "cal") renderCal(); });

syncAreaSeg();
go("today");
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("./sw.js").catch(() => {});
