/* ポケノート v6（2026-10-24：くり返しタスク・日報・商談の準備チェック。v2 からの作り）：社長専用のタスク・予定・メモ＋秘書。
   データは結果カウンターと同じ Firebase（kekka-counter-2026）の hub/<社長のuid>/…（ルールで社長本人だけ・ほかのメンバーは読めない）。
   端末にも写しを持つので、圏外でも使えて、つながったら自動で送る。v1 でスマホの中（localStorage "pocket-v1"）に入れた分は、最初のログインで移す。
     tasks:  {id, title, note, imp(重要), urg(急ぎ), due:"YYYY-MM-DD"|null, time:"HH:MM"|"", done, doneAt, createdAt, updatedAt, src:"me",
              repeat:{type:"daily"|"weekday"|"weekly"|"monthly", dow:0-6, dom:1-31}|null（v6 くり返し）, repFrom(前の回のid), repNext(作った次の回のid)}
     events: {id, title, date:"YYYY-MM-DD", allDay, start:"HH:MM", end:"HH:MM", note, color, createdAt, updatedAt, src:"me"}
     memos:  {id, text, status:"wait"(振り分け待ち)|"memo"(メモのまま)|"done"(振り分け済み), result:{kind,label}|null, createdAt, updatedAt,
              cat:"imp"|"idea"|"etc"|null（v6.7 分類・無い＝その他）, catBy:"ai"|"me"}
     chat:   {id, role:"me"|"ai", text, at, status:"wait"(PCの秘書がまだ読んでいない), kind:"nippo"(v6 日報の材料／できた日報), nippo:{…}(材料の中身), replyTo}
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
/* 線・面のアイコン（v6.7・社長「絵文字でAIっぽくなるのは避けて、Apple純正アプリのように」）。SF Symbols に似せた1色（currentColor）・同じ太さ。絵文字は使わない */
const svg = (inner, o) => `<svg class="sf" viewBox="0 0 24 24" ${o || 'fill="currentColor"'} aria-hidden="true">${inner}</svg>`;
const LINE = w => `fill="none" stroke="currentColor" stroke-width="${w || 2}" stroke-linecap="round" stroke-linejoin="round"`;
const SF = {
  plus: svg('<path d="M12 5v14M5 12h14"/>', LINE(2.2)),
  chevL: svg('<path d="M15 5l-7 7 7 7"/>', LINE(2.6)), chevR: svg('<path d="M9 5l7 7-7 7"/>', LINE(2.6)),
  chevD: svg('<path d="M6 9.5l6 6 6-6"/>', LINE(2.4)), chevU: svg('<path d="M6 14.5l6-6 6 6"/>', LINE(2.4)),
  bell: svg('<path d="M12 22a2.6 2.6 0 0 0 2.5-1.9h-5A2.6 2.6 0 0 0 12 22zm7.2-5.3l-1.7-2V10a5.5 5.5 0 0 0-4.3-5.4V4a1.2 1.2 0 0 0-2.4 0v.6A5.5 5.5 0 0 0 6.5 10v4.7l-1.7 2v1.4h14.4z"/>'),
  mic: svg('<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'),
  compose: svg('<path d="M11 4.5H6.5A2.5 2.5 0 0 0 4 7v10.5A2.5 2.5 0 0 0 6.5 20H17a2.5 2.5 0 0 0 2.5-2.5V13"/><path d="M17.6 3.6a2 2 0 0 1 2.8 2.8L12 14.8l-3.6.8.8-3.6z"/>', LINE(1.9)),
  checklist: svg('<path d="M3.5 6l1.5 1.5 3-3M3.5 12.5L5 14l3-3M3.5 19L5 20.5l3-3M11 6.5h9.5M11 13h9.5M11 19.5h9.5"/>', LINE(1.9)),
  repeat: svg('<path d="M17 2.5l3 3-3 3M4 11.5v-1a5 5 0 0 1 5-5h11M7 21.5l-3-3 3-3M20 12.5v1a5 5 0 0 1-5 5H4"/>', LINE(2)),
  bubble: svg('<path d="M4 12a9 8 0 1 1 4 6.6L4 21l1.2-4.2A7.6 7.6 0 0 1 4 12z"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', LINE(2.6)),
  cal: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 2.8v4M16 2.8v4"/>', LINE(2)),
  note: svg('<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 8.5h7M8.5 12.5h7M8.5 16.5h4"/>', LINE(2)),
  person: svg('<circle cx="12" cy="8" r="4"/><path d="M4 20.5c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5z"/>'),
  trash: svg('<path d="M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l1 13a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-13M10 10.5v6.5M14 10.5v6.5"/>', LINE(1.9))
};
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
function toast(msg, ms) { const el = $("toast"); el.textContent = msg; el.classList.add("on"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("on"), ms || 2400); }   // ms：長い案内は長めに出す

/* ---------- 保存（Firebase）----------
   画面の作りは v1 のまま：db の中身を直してから save() を呼ぶ。save() は「前に送った形」と比べて、変わった物だけを書き、消えた物を消す */
const COLS = ["tasks", "events", "memos", "chat"];
const db = {tasks: [], events: [], memos: [], chat: []};
const shadow = {tasks: new Map(), events: new Map(), memos: new Map(), chat: new Map()};
let got = {};   /* v6.7：最初の読み込みが来たか（来るまでは描かない＝「まだありません」が一瞬出てから中身に変わるちらつきを防ぐ） */
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
  got = {}; COLS.forEach(c => { db[c] = []; shadow[c].clear(); }); kcRecs = []; kcTasks = []; brief = null; pcAt = null; prep = {};
  if (!u) { gate("Googleアカウントでログインしてください（社長のアカウント）。", true, false); return; }
  if (String(u.email || "").toLowerCase() !== OWNER_EMAIL) { gate("このアプリは社長専用です（" + (u.email || "") + "）。", false, true); return; }
  U = u.uid; ghostOut($("gate"), "out", 320); $("gate").hidden = true; start();   // 入口はふわっと消す
});
function start() {
  const err = what => e => { console.error(what, e); toast(what + "を読み込めませんでした"); COLS.forEach(c => { got[c] = true; }); render(); };
  setTimeout(() => { if (COLS.some(c => !got[c])) { COLS.forEach(c => { got[c] = true; }); render(); } }, 2500);   // つながらない時も2.5秒で今ある物を出す
  COLS.forEach(col => unsubs.push(onSnapshot(collection(fs, P(col)), s => {
    db[col] = s.docs.map(d => ({...d.data(), id: d.id}));
    shadow[col] = new Map(db[col].map(o => [o.id, JSON.stringify(o)]));
    got[col] = true;
    if (col === "memos") sweepDeleted();   // 消しかけのまま閉じた物を片づける（写しをそろえたあとで消す＝ほかは書き直さない）
    if ($("sheet").hidden) render();
  }, err({tasks: "タスク", events: "予定", memos: "メモ", chat: "秘書の会話"}[col]))));
  unsubs.push(onSnapshot(doc(fs, P("meta"), "brief"), s => { brief = s.exists() ? s.data() : null; if (view === "today" && $("sheet").hidden) render(); }, () => {}));
  unsubs.push(onSnapshot(doc(fs, P("meta"), "prep"), s => { prep = s.exists() && s.data().items || {}; if (view === "today" && $("sheet").hidden) render(); }, () => {}));
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
let hishoOpen = false, appearNext = false;   // 今日の画面で、秘書のひと言を全部出しているか
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
const scrollMem = {};   /* v6.7：画面ごとのスクロールの位置（純正のタブと同じく、戻ったら前の位置。今の画面のタブをもう一度押すと上へ） */
function go(v) {
  if (v !== view) scrollMem[view] = window.scrollY;
  view = v;
  VIEWS.forEach(x => $("v-" + x).hidden = x !== v);
  $("tabs").querySelectorAll("button").forEach(b => b.dataset.go === v ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  const ai = v === "ai";
  /* 下の欄は、秘書の画面もほかの画面と同じ形（マイクが欄の中の右）。社長「秘書の画面の同じ位置にない」 */
  $("askIn").placeholder = ai ? "秘書に頼む…" : "秘書に頼む・メモする…";
  syncFab();
  $("areaSeg").hidden = v === "ai";
  syncAskBtn();
  if (v === "cal") calScrolled = false;
  /* 秘書の画面は、描いたその場でいちばん下に合わせる（画面に出る前なので跳ねない。前は上で一度描いてから下へ動かしていた＝社長「開く時にガタッとなる」） */
  /* （ほかの画面は、描いたあとで前の位置へ） */
  render();
  if (ai) { chatToBottom(); requestAnimationFrame(chatToBottom); } else window.scrollTo(0, scrollMem[v] || 0);
}
const chatToBottom = () => window.scrollTo(0, document.documentElement.scrollHeight);
$("tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-go]"); if (!b) return;
  if (b.dataset.go === view && view !== "ai") { window.scrollTo({top: 0, behavior: "smooth"}); return; }   // 今の画面のタブをもう一度押すと、いちばん上へ（純正と同じ）
  go(b.dataset.go);
});

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
  const q = quadOf(t), over = isOver(t), rl = repLabel(t.repeat);
  return `<div class="cell${t.done ? " strike" : ""}" data-tedit="${esc(t.id)}"><button class="circle${t.done ? " done" : ""}" data-tdone="${esc(t.id)}" aria-label="${t.done ? "未完了に戻す" : "完了にする"}"></button>
    <div class="grow"><div class="t">${esc(t.title || "（題なし）")}</div>${t.due || t.note || rl ? `<div class="s${over ? " over" : ""}">${[esc(dueLabel(t)), rl ? `<span class="repi">${SF.repeat}</span>${esc(rl)}` : "", t.note ? esc(t.note.split("\n")[0]) : ""].filter(Boolean).join(" ・ ")}</div>` : ""}</div>
    ${withPill && q.pill && !t.done ? `<span class="pill ${q.pill}">${q.name}</span>` : ""}</div>`;
}

/* ---------- くり返しタスク（v6・社長「毎日17:30 日報」「毎週月曜 KPI報告」） ----------
   repeat:{type:"daily"(毎日)|"weekday"(平日＝月〜金)|"weekly"(毎週・dow 0日〜6土)|"monthly"(毎月・dom 1〜31。その月に無い日は末日)}。
   完了にすると、次の回を新しいタスクとして入れる（題・メモ・4マス・区分・時刻・くり返しを引き継ぐ）。
   次の回の期限＝今の期限より後で、今日より前ではない最初の日（遅れて済ませても、たまった回は作らない）。完了を戻すと、作った次の回（まだ手を付けていない物）を消す */
const REP_TYPES = [["", "なし"], ["daily", "毎日"], ["weekday", "平日"], ["weekly", "毎週"], ["monthly", "毎月"]];
const repOk = r => !!r && ["daily", "weekday", "weekly", "monthly"].includes(r.type);
const repDow = r => { const n = parseInt(r.dow, 10); return n >= 0 && n <= 6 ? n : 1; };   // 無い・変な値は月曜
const repDom = r => Math.min(31, Math.max(1, Number(r.dom) || 1));
const repLabel = r => !repOk(r) ? "" : r.type === "daily" ? "毎日" : r.type === "weekday" ? "平日" : r.type === "weekly" ? "毎週" + WD[repDow(r)] + "曜" : "毎月" + repDom(r) + "日";
const lastDom = d => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
function repHit(r, d) {
  const w = d.getDay();
  if (r.type === "daily") return true;
  if (r.type === "weekday") return w >= 1 && w <= 5;
  if (r.type === "weekly") return w === repDow(r);
  return d.getDate() === Math.min(repDom(r), lastDom(d));
}
/* from の日（その日も入れる）から先で、最初に当たる日 */
function repFirst(r, from) { let d = new Date(from); for (let i = 0; i < 400; i++, d = addDays(d, 1)) if (repHit(r, d)) return ymd(d); return ymd(from); }
const repNextDue = t => { const T = parseYmd(todayStr()), after = t.due ? addDays(parseYmd(t.due), 1) : addDays(T, 1); return repFirst(t.repeat, after > T ? after : T); };

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
   いちばん上の切り替え（並びは［すべて］［仕事］［プライベート］・開いた時はいつも［すべて］）で見る物を絞る。アプリで新しく入れる物は今選んでいる方（「すべて」なら仕事）。入力の画面でワンタップで変えられる */
const AREA_KEY = "pocket-area";
let areaF = "all";   /* 開いた時はいつも［すべて］（社長「基本は『すべて』に固定で」2026-10-25。前に選んだ物は覚えない）。使っている間は［仕事］［プライベート］に切り替えられる */
try { localStorage.removeItem(AREA_KEY); } catch (e) {}   // 前の版で覚えていた分を片づける
const areaOfX = x => x && x.area === "private" ? "private" : "work";
const inArea = x => areaF === "all" || areaOfX(x) === areaF;
const newArea = () => areaF === "private" ? "private" : "work";
const showWork = () => areaF !== "private";
function syncAreaSeg() { $("areaSeg").querySelectorAll("[data-a]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.a === areaF))); }
$("areaSeg").addEventListener("click", e => {
  const b = e.target.closest("[data-a]"); if (!b) return;
  areaF = b.dataset.a;
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

/* ---------- 日報（v6・社長 2026-10-24） ----------
   今日の画面（仕事）に「日報を書く」。17時から上の方に大きく出す。押すと材料の入力（意識した事・どうだった・よかった・課題・明日・ひとこと。数字は結果カウンターから自動）。
   送ると chat に {role:"me", kind:"nippo", text:＜日報の材料＞の文, nippo:{date, focus, result, good, issue, tomorrow, note, kpi:{n, ans, apo, week, goal}}, status:"wait"}。
   PCの秘書が AIメグタ（社長の文体）で日報にして {role:"ai", kind:"nippo", replyTo, text:日報の本文} を返す → 秘書の画面と今日の画面でコピーできる。
   書きかけは端末に覚える（閉じても消えない） */
const NIPPO_HOUR = 17, NIPPO_LS = "pocket-nippo";
const NIPPO_F = [["focus", "意識した事"], ["result", "どうだった"], ["good", "よかった"], ["issue", "課題"], ["tomorrow", "明日"], ["note", "ひとこと"]];
const nippoDraft = () => { try { const x = JSON.parse(localStorage.getItem(NIPPO_LS) || "null"); return x && x.date === todayStr() ? x.f || {} : null; } catch (e) { return null; } };
const nippoKeep = f => { try { localStorage.setItem(NIPPO_LS, JSON.stringify({date: todayStr(), f})); } catch (e) {} };
/* 今日送った材料（いちばん新しい物）と、その返事 */
function nippoToday() {
  const T = todayStr(), byAt = (a, b) => String(b.at).localeCompare(String(a.at));
  const sent = db.chat.filter(c => c.role === "me" && c.kind === "nippo" && c.nippo && c.nippo.date === T).sort(byAt);
  const ids = new Set(sent.map(c => c.id));
  const reply = db.chat.filter(c => c.role !== "me" && c.kind === "nippo" && ids.has(c.replyTo)).sort(byAt)[0] || null;
  return {sent: sent[0] || null, reply};
}
/* text は AIメグタの「材料の型」（SNS営業ツール\AIメグタ\材料の型.md）と同じ9行＝そのまま貼れる。空の所は空のまま（AIメグタが【社長に聞く】にする。テスター） */
const NIPPO_HEAD = {focus: "意識"};
function nippoText(x) {
  const k = x.kpi, d = parseYmd(x.date), v = s => String(s || "").trim();
  return ["＜日報の材料＞", "日付：" + (d.getMonth() + 1) + "/" + d.getDate(), "時間：" + v(x.hours), `数字：コール${k.n} 対応${k.ans} アポ${k.apo}（今週 ${k.week}/${k.goal}）`,
    ...NIPPO_F.map(([id, l]) => (NIPPO_HEAD[id] || l) + "：" + v(x[id]))].join("\n");
}
function nippoForm() {
  const {sent} = nippoToday(), d = nippoDraft() || (sent ? sent.nippo : {}) || {}, k = kpiNow();
  openSheet("今日の日報", `
    <div class="kpi1" style="margin-top:0"><span><b>${k.n}</b>コール</span><span><b>${k.ans}</b>対応</span><span><b>${k.apo}</b>アポ</span><span><b>${k.week}</b>/${WEEK_GOAL} 週</span></div>
    <p class="note" style="margin-top:6px">数字は結果カウンターから自動で入ります</p>
    <div class="lab">時間</div><input class="field" id="n_hours" placeholder="いつもの10時〜18時テレアポなら空でOK" value="${esc(d.hours || "")}" autocomplete="off" enterkeyhint="done">
    ${NIPPO_F.map(([id, l]) => `<div class="lab nlab"><span>${l}</span><button type="button" class="chip micchip sm" data-nmic="${id}" aria-pressed="false" aria-label="${l}を話して書く">${SF.mic}</button></div>
      <textarea class="field nfield" id="n_${id}" rows="2" placeholder="${l === "ひとこと" ? "（なくてもOK）" : ""}">${esc(d[id] || "")}</textarea>`).join("")}
    <p class="note">送ると、PCの秘書が社長の文体（AIメグタ）で日報にして返します。返事は秘書の画面に届き、コピーできます。${sent ? "<br>今日はもう送っています（直して送ると、新しい材料で作り直します）。" : ""}</p>`, sendNippo, "秘書に送る");
  const keep = () => { nippoKeep(readNippo()); sheetSnap = sheetState(); };   // 書きかけは覚えるので、閉じる時に聞かない
  ["hours", ...NIPPO_F.map(x => x[0])].forEach(id => $("n_" + id).addEventListener("input", keep));
  $("sheetBody").querySelectorAll("[data-nmic]").forEach(b => b.onclick = () => dictate($("n_" + b.dataset.nmic), b, keep));
}
const readNippo = () => Object.fromEntries(["hours", ...NIPPO_F.map(x => x[0])].map(id => [id, ($("n_" + id) ? $("n_" + id).value : "").trim()]));
function sendNippo() {
  const f = readNippo();
  if (!NIPPO_F.some(([id]) => f[id])) { toast("どれか1つは書いてください"); return; }
  const k = kpiNow(), nippo = Object.assign({date: todayStr()}, f, {kpi: {n: k.n, ans: k.ans, apo: k.apo, week: k.week, goal: WEEK_GOAL}});
  nippoKeep(f);
  db.chat.push({id: newId(), role: "me", kind: "nippo", text: nippoText(nippo), nippo, at: nowIso(), status: "wait"});
  save(); closeSheet(); go("ai"); toast("日報の材料を秘書に送りました");
}
/* できた日報：全部の文とコピー */
function nippoOut(c) {
  openSheet("今日の日報", `<div class="nippoOut">${esc(c.text)}</div><button type="button" class="btn" id="nCopy" style="font-weight:600">コピー</button><button type="button" class="btn" id="nEdit">材料を直して送り直す</button>`);
  $("nCopy").onclick = () => copyText(c.text);
  $("nEdit").onclick = () => nippoForm();
}
async function copyText(s) {
  try { await Promise.race([navigator.clipboard.writeText(s), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500))]); toast("コピーしました"); return; } catch (e) {}
  try {   // 古いやり方（クリップボードが使えない時）
    const ta = document.createElement("textarea"); ta.value = s; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, s.length);
    const okc = document.execCommand("copy"); ta.remove(); toast(okc ? "コピーしました" : "コピーできませんでした（長押しで選んでください）");
  } catch (e) { toast("コピーできませんでした（長押しで選んでください）"); }
}
/* 今日の画面の「日報」の行。17時からは上の方に大きく */
function nippoRow(big) {
  const {sent, reply} = nippoToday();
  const label = reply ? "日報ができました（押すとコピー）" : sent ? "日報：秘書が作っています…" : "今日の日報を書く";
  const sub = reply ? "" : sent ? "送った材料を直して送り直せます" : "数字は結果カウンターから自動で入ります";
  return big ? `<button class="nippoBig${reply ? " done" : ""}" data-nippo="1"><span class="nic">${reply ? SF.check : SF.compose}</span><span class="grow"><span class="t">${label}</span>${sub ? `<span class="s2">${sub}</span>` : ""}</span></button>`
    : `<div class="group" style="margin-top:22px"><button class="cell plain more" data-nippo="1"><span class="rowic">${SF.compose}</span><div class="grow"><div class="t">${label}</div></div></button></div>`;
}

/* ---------- 商談の準備チェック（v6・社長の反省 2026-10-20「資料を増やすより、前日の相手役の練習・最初の3行・同席者との出番決め」） ----------
   明日（月曜の商談は土曜から）商談がある時、今日の画面に「明日の商談の準備」と3つのチェック。商談の当日も始まるまでは出す。
   商談＝結果カウンターの自分のアポ／ポケノートの予定で題に「商談」が入る物。
   チェックは hub/<社長>/meta/prep {items:{<key>:{c:[練習, 最初の3行, 出番], day:商談の日, at}}}（ほかの端末ともそろう）。終わった日の物は、書く時に片づける */
const PREP = ["前日の相手役の練習", "最初の3行を決める", "同席者と出番を決める"];
let prep = {};
function prepTargets() {
  const now = new Date(), T = parseYmd(todayStr()), out = [];
  const add = (key, w, title) => {
    const day = parseYmd(ymd(w)), from = addDays(day, w.getDay() === 1 ? -2 : -1);   // 月曜の商談は土曜から
    if (w > now && from <= T) out.push({key, w, day: ymd(w), title});
  };
  if (showWork()) kcRecs.forEach(r => { if (r.r === "アポ" && r.memo && r.memo.when && !r.canceled) add("apo:" + r.id + "@" + ymd(r.memo.when), r.memo.when, "商談：" + (r.memo.shop || "（店名なし）")); });
  db.events.filter(e => !e.deleted && inArea(e) && /商談/.test(e.title || "") && e.date).forEach(e => {
    const w = new Date(parseYmd(e.date).getTime() + (e.allDay ? 24 * 60 - 1 : toMin(e.start)) * 6e4);
    add("ev:" + e.id + "@" + e.date, w, e.title);
  });
  return out.sort((a, b) => a.w - b.w);
}
function prepCard() {
  const list = prepTargets(); if (!list.length) return "";
  const T = todayStr(), tm = ymd(addDays(parseYmd(T), 1));
  const when = x => x.day === T ? "今日" : x.day === tm ? "明日" : mdw(x.day);
  const head = list.every(x => x.day === T) ? "今日の商談の準備" : list.every(x => x.day !== T) && list.every(x => x.day === tm) ? "明日の商談の準備" : "商談の準備";
  const cnt = list.reduce((a, x) => a + ((prep[x.key] && prep[x.key].c) || []).filter(Boolean).length, 0);
  /* 純正のリマインダーの形：カードの中に見出し（アイコン＋名前・右に数）、チェックは丸（済むと青） */
  return `<div class="group prep"><div class="ph"><span class="pt"><i class="pic">${SF.checklist}</i>${head}</span><b>${cnt}/${list.length * PREP.length}</b></div>${list.map(x => {
    const c = (prep[x.key] && prep[x.key].c) || [];
    return `<div class="pm">${esc(when(x) + " " + hm(x.w) + "　" + x.title)}</div>` + PREP.map((l, i) => `<button class="pi${c[i] ? " on" : ""}" data-prep="${esc(x.key)}" data-pi="${i}" data-pday="${x.day}" aria-pressed="${!!c[i]}"><span class="circle${c[i] ? " done" : ""}"></span><span class="pl">${l}</span></button>`).join("");
  }).join("")}</div>`;
}
function togglePrep(key, i, day) {
  const T = todayStr(), items = {};
  Object.entries(prep).forEach(([k, v]) => { if (v && v.day >= T) items[k] = v; });   // 終わった日の物は片づける
  const cur = items[key] ? {...items[key], c: (items[key].c || []).slice()} : {c: [false, false, false], day};
  while (cur.c.length < PREP.length) cur.c.push(false);
  cur.c[i] = !cur.c[i]; cur.at = nowIso(); items[key] = cur; prep = items; render();
  setDoc(doc(fs, P("meta"), "prep"), {items}).catch(e => { console.error(e); toast("保存できませんでした"); });
}

/* ---------- 今日 ---------- */
function renderToday() {
  const ap = appearNext ? " appear" : ""; appearNext = false;   // 開いた所だけ、ふわっと出す（v6.7）
  const n = new Date(), T = todayStr();
  $("tDate").textContent = `${n.getMonth() + 1}月${n.getDate()}日 ${WD[n.getDay()]}曜日`;
  const evs = eventsOn(T);
  const open = db.tasks.filter(t => !t.done && !isWait(t) && inArea(t)), waits = showWork() ? waitsOpen() : [];
  const over = open.filter(isOver), todays = open.filter(t => isToday(t) && !isOver(t));
  const doneToday = db.tasks.filter(t => t.done && !isWait(t) && inArea(t) && t.doneAt && ymd(new Date(t.doneAt)) === T);
  const waiting = liveMemos().filter(m => m.status === "wait" && inArea(m)).length;
  /* 結果カウンターの前確：前確の日が今日まで（商談の前まで）の分を、今日のタスクに */
  const E = addDays(parseYmd(T), 1), pres = (showWork() ? kcPres() : []).filter(p => p.when < E).sort((a, b) => a.when - b.when);
  const next = evs.find(e => !e.allDay && toMin(e.end || e.start) > n.getHours() * 60 + n.getMinutes());
  const hello = n.getHours() < 11 ? "おはようございます。" : n.getHours() < 18 ? "おつかれさまです。" : "おつかれさまでした。";
  const say = hello + `今日は予定が${evs.length}件、今日のタスクが${todays.length + pres.length}件です。` + (over.length ? `期限切れのタスクが${over.length}件あります。` : "") +
    (next ? `次は ${next.start}「${next.title}」。` : "") + (waiting ? `振り分け待ちのメモが${waiting}件。` : "") + (waits.length ? `チームが社長を待っている作業が${waits.length}件あります。` : "");
  /* 秘書のひと言：PCの秘書が今日書いた物があればそれ、なければ自動のまとめ */
  const bAt = brief && brief.at ? tsd(brief.at) || new Date(brief.at) : null;
  const useBrief = showWork() && brief && brief.text && bAt && ymd(bAt) === T;   // プライベートの時は自動のまとめ
  /* v5.1（社長「文字が多くてごちゃごちゃ」）：iPhone 純正の「今日」くらいの文字の量に。
     各行は題1行だけ（説明・手順・小さい字は押すと出る）・見出しは少なく・空の欄は出さない・秘書のひと言は2行で切って押すと全部 */
  const nowMin = n.getHours() * 60 + n.getMinutes();
  const miniTask = t => `<div class="cell" data-tedit="${esc(t.id)}"><button class="circle" data-tdone="${esc(t.id)}" aria-label="${isWait(t) ? "済みにする" : "完了にする"}"></button><div class="grow"><div class="t${isOver(t) ? " overT" : ""}">${esc(t.title || "（題なし）")}${repOk(t.repeat) ? `<span class="rep" aria-label="くり返し">${SF.repeat}</span>` : ""}</div></div></div>`;
  const miniEvent = e => `<div class="cell" ${evAttr(e)}><div class="time">${e.allDay ? "終日" : esc(e.start)}</div><div class="bar" style="background:${colorOf(e)[0]}"></div><div class="grow"><div class="t">${esc(e.title || "（予定）")}</div></div></div>`;
  const more = (n2, attr) => `<button class="cell plain more" ${attr}><div class="grow"><div class="t">ほか ${n2}件</div></div></button>`;
  let h = "";
  /* 秘書のひと言（2行で切る・押すと全部） */
  h += `<button class="hisho" data-hisho="1"><div class="av">${SF.bubble}</div><div class="grow"><div class="t${hishoOpen ? "" : " clamp2"}">${esc(useBrief ? brief.text : say)}</div>${hishoOpen ? `<div class="s${ap}">${useBrief ? "秘書 ・ " + hm(bAt) : "ポケノートのまとめ ・ " + hm(n)}</div>` : ""}</div></button>`;
  /* 今日の数字（小さい1段・押すと結果カウンター） */
  if (kpiFor !== T && U) subscribeKpi();   // 日付が変わったら読み直す
  const k = kpiNow();
  if (showWork()) h += `<button class="kpi1" data-kc="1"><span><b>${k.n}</b>コール</span><span><b>${k.ans}</b>対応</span><span><b>${k.apo}</b>アポ</span><span><b>${k.week}</b>/${WEEK_GOAL} 週</span></button>`;
  /* 日報（17時からは上に大きく） */
  const eve = n.getHours() >= NIPPO_HOUR;
  if (showWork() && eve) h += nippoRow(true);
  /* 社長待ち（期限の近い順に3件） */
  if (waits.length) h += `<div class="sec bell"><span><i class="secic">${SF.bell}</i>社長待ち</span><button data-gotask="wait">${waits.length}件</button></div><div class="group wait">${waits.slice(0, 3).map(miniTask).join("")}${waits.length > 3 ? more(waits.length - 3, `data-gotask="wait"`) : ""}</div>`;
  /* 明日の商談の準備 */
  h += prepCard();
  /* 予定（これからの物を3件・結果カウンターは1行） */
  const mine = evs.filter(e => !e.kc), kcs = evs.filter(e => e.kc);
  const coming = mine.filter(e => e.allDay || toMin(e.end || e.start) > nowMin), shown = coming.slice(0, 3), rest = mine.length - shown.length;
  let eh = shown.map(miniEvent).join("");
  /* これからの予定が無い時は「ほか n件」ではなく「今日の予定は終わりました（n件）」（テスター） */
  if (rest > 0) eh += shown.length ? more(rest, `data-gotoday="1"`) : `<button class="cell plain more" data-gotoday="1"><div class="grow"><div class="t">今日の予定は終わりました（${mine.length}件）</div></div></button>`;
  if (kcs.length) {
    const cnt = k2 => kcs.filter(e => e.id.indexOf("kc:" + k2 + ":") === 0).length;
    const parts = [["apo", "商談"], ["call", "再架電"], ["task", "予定"]].map(([k2, l]) => cnt(k2) ? l + cnt(k2) : "").filter(Boolean).join("・");
    eh += `<button class="cell" data-kctoggle="1"><div class="time" style="color:var(--orange)">結果</div><div class="bar" style="background:var(--orange)"></div><div class="grow"><div class="t">結果カウンター：${esc(parts)}</div></div><span class="chev">${kcOpen ? SF.chevU : SF.chevD}</span></button>`;
    if (kcOpen) eh += kcs.map(miniEvent).join("").replace(/<div class="cell" /g, `<div class="cell${ap}" `);
  }
  if (eh) h += `<div class="sec"><span>予定</span><button data-goto="cal">すべて</button></div><div class="group">${eh}</div>`;
  /* タスク（期限切れ・今日・前確。済んだ物は出さない） */
  const list = [...over.sort(byDue), ...todays.sort(byDue)];
  const preRows = pres.map(p => `<div class="cell" data-kc="1"><span class="circle" style="opacity:.35"></span><div class="grow"><div class="t${p.when < n ? " overT" : ""}">${esc(p.title)}</div></div></div>`);
  const th = list.map(miniTask).join("") + preRows.join("");
  if (th) h += `<div class="sec"><span>タスク</span><button data-goto="task">すべて</button></div><div class="group">${th}</div>`;
  if (!waits.length && !eh && !th) h += `<div class="group" style="margin-top:22px"><div class="empty">今日の予定・タスクはありません</div></div>`;
  if (showWork() && !eve) h += nippoRow(false);   // 17時までは下に小さく
  /* 通知：オンになっていれば出さない */
  const pl = pushLabel();
  if (pl !== "オン") h += `<div class="group" style="margin-top:22px"><div class="cell plain"><span class="setic">${SF.bell}</span><div class="grow"><div class="t" style="font-size:15px">通知：${esc(pl)}</div></div>${pushBtn()}</div></div>`;   // 設定アプリの形（赤い角丸にベル）
  h += `<p class="note foot">${esc(auth.currentUser ? auth.currentUser.email : "")} ・ <button class="linkbtn" data-logout="1">ログアウト</button></p>`;
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
    $("taskBody").innerHTML = `<div class="sec bell"><span><i class="secic">${SF.bell}</i>チームが社長を待っています（${w.length}）</span></div><div class="group wait">${w.map(waitCell).join("") || `<div class="empty">チームが社長を待っている作業はありません</div>`}</div>` +
      (doneW.length ? `<div class="sec"><span>済み（最近）</span></div><div class="group">${doneW.map(waitCell).join("")}</div>` : "") +
      `<p class="note">押すと手順と場所が出ます。済んだら丸を押すと、チームに伝わります。</p>`;
    return;
  }
  if (taskF === "quad") {
    $("taskBody").innerHTML = `<div class="quad">${QUADS.map(q => {
      const items = open.filter(t => quadOf(t) === q).sort(byDue);
      return `<div class="q" data-q="${q.k}" style="--qc:${q.color}"><div class="qh"><span class="dot" style="background:${q.color}"></span>${q.name}<span class="qn">${items.length}</span></div>
        ${items.map(t => `<div class="qi${qMark[t.id] ? " " + qMark[t.id] : ""}" data-tedit="${esc(t.id)}"><button class="circle" data-tdone="${esc(t.id)}" aria-label="完了にする"></button><div>${esc(t.title || "（題なし）")}${t.due || repOk(t.repeat) ? `<small class="${isOver(t) ? "over" : ""}">${[esc(dueLabel(t)), repOk(t.repeat) ? `<span class="repi">${SF.repeat}</span>${esc(repLabel(t.repeat))}` : ""].filter(Boolean).join(" ")}</small>` : ""}</div></div>`).join("")}
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
/* ---------- 4マス：長押しして引っぱって、別のマスへ移す（v6.8・社長「重要度を変える時に、長押しして引っぱって移動できる形に」） ----------
   0.4秒押したままにすると、タスクが少し浮き上がって（影・ほんの少し大きく）指について動く。別のマスの上で離すと、そのマスの imp・urg に書き換える。
   運んでいる間は、置けるマスをうすく色づけ（指の下のマスは濃く）。マスの外か同じマスで離したら、元の所へ戻る。
   長押しの前に指が動いたら、ふつうのスクロール。長押しのあとは画面をスクロールさせない（touchmove を止める）。マスの中の並べ替えはしない */
const QHOLD_MS = 400, QPAD = 10;   // 長押しの時間／写しの左右の余白（文字の位置は元と同じにする）
let qd = null, qdClick = false;
const qMark = {};   // 運んでいる間・置いている間の印（描き直しても残す）：id → "qghost"(元の場所は空き)｜"qhide"(移り先は吸い込まれるまで空ける)
/* v6.9（社長「遅れてくる、詰まってるイメージ」→ 純正のリマインダー・ホーム画面のアイコンを運ぶ動きに近づける）
   ・押している間は少し沈む ・浮く時はつかんだ所を中心に1.03倍＋影（0.18秒・内側だけ）・文字の位置は動かない（前は写しにだけ左右の余白が付いて10pxずれていた）
   ・指には transform だけで遅れなくついていく（前は大きさの動き 0.18秒 が指の動きにもかかって遅れていた＝「遅れてくる」）。
     マスの位置は運び始めに1回だけ測って覚え、動かす時は測り直さない。色づけはマスが変わった時だけ（重い処理をしない＝「詰まる」を防ぐ）
   ・元の場所は同じ高さの空きを残す（ほかが詰まって跳ねない）。同期で描き直しても、空き・印は残す
   ・離すと移り先の置き場所へ0.22秒でスッと吸い込まれる／外なら元の所へスッと戻る（前はその場でパッと消えた）・マスの色づけはふわっと */
const qiOf = id => $("taskBody").querySelector(`.qi[data-tedit="${CSS.escape(id)}"]`);
const qMarkSet = (id, cls) => { if (cls) qMark[id] = cls; else delete qMark[id]; const el = qiOf(id); if (el) { el.classList.remove("qghost", "qhide"); if (cls) el.classList.add(cls); } };
function qdStart(x, y, target) {
  const it = target.closest(".qi[data-tedit]"); if (!it || target.closest("[data-tdone]") || taskF !== "quad") return;
  qd = {id: it.dataset.tedit, x0: x, y0: y, x, y, on: false,
    p: setTimeout(() => { if (qd && !qd.on) { const e = qiOf(qd.id); if (e) e.classList.add("press"); } }, 120),   // 押している間、少し沈む
    t: setTimeout(qdLift, QHOLD_MS)};
}
const qdUnpress = id => { const e = qiOf(id); if (e) e.classList.remove("press"); };
function qdLift() {
  if (!qd) return;
  const it = qiOf(qd.id); if (!it) { qd = null; return; }
  const r = it.getBoundingClientRect(); it.classList.remove("press");
  /* 写し：外側（.qdrag）は指について動くだけ、内側（.qdin）が浮く（大きさ・影） */
  const g = document.createElement("div"), inner = it.cloneNode(true);
  inner.removeAttribute("data-tedit"); inner.querySelectorAll("[data-tdone]").forEach(x => x.removeAttribute("data-tdone"));
  inner.className = "qi qdin"; g.className = "qdrag"; g.setAttribute("aria-hidden", "true"); g.appendChild(inner);
  Object.assign(g.style, {left: (r.left - QPAD) + "px", top: r.top + "px", width: (r.width + QPAD * 2) + "px"});
  inner.style.transformOrigin = (qd.x0 - r.left + QPAD) + "px " + (qd.y0 - r.top) + "px";   // つかんだ所を中心に浮く
  document.body.appendChild(g); void g.offsetWidth; g.classList.add("up");
  qd.on = true; qd.g = g; qd.r = r; qd.from = it.closest(".q").dataset.q; qd.hover = null;
  /* マスの位置は運び始めに1回だけ測って覚える（運んでいる間は画面が動かないので、測り直さない） */
  qd.qs = [...$("taskBody").querySelectorAll(".quad .q")].map(b => ({k: b.dataset.q, r: b.getBoundingClientRect()}));
  qMarkSet(qd.id, "qghost"); const quad = $("taskBody").querySelector(".quad"); if (quad) quad.classList.add("dragging");
  try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) {}
  qdPaint();
}
const qdHitK = (d, x, y) => (d.qs.find(o => x >= o.r.left && x <= o.r.right && y >= o.r.top && y <= o.r.bottom) || {}).k || null;
/* 指の位置へ：transform を書くだけ（ページの形を測らない。iPhone の指の動きは1コマに1回に揃って届くので、そのまま書けば遅れがいちばん少ない） */
function qdPaint() {
  qd.g.style.transform = `translate3d(${qd.x - qd.x0}px, ${qd.y - qd.y0}px, 0)`;
  const k = qdHitK(qd, qd.x, qd.y), to = k && k !== qd.from ? k : null;
  if (to !== qd.hover) {   // 色づけはマスが変わった時だけ
    $("taskBody").querySelectorAll(".quad .q").forEach(b => b.classList.toggle("drop", b.dataset.q === to));
    qd.hover = to;
  }
}
function qdMove(x, y, ev) {
  if (!qd) return;
  if (!qd.on) { if (Math.hypot(x - qd.x0, y - qd.y0) > 8) { clearTimeout(qd.t); clearTimeout(qd.p); qdUnpress(qd.id); qd = null; } return; }   // 長押しの前に動いた＝スクロール
  if (ev && ev.cancelable) ev.preventDefault();
  qd.x = x; qd.y = y; qdPaint();
}
/* 写しを rect の所へスッと動かして（大きさ・影も元へ）から消す */
function qdSettle(d, rect, done) {
  const g = d.g;
  g.style.transition = "transform .22s cubic-bezier(.2,.8,.2,1)";
  g.style.transform = `translate3d(${rect.left - d.r.left}px, ${rect.top - d.r.top}px, 0)`;
  g.classList.remove("up");
  setTimeout(() => { g.remove(); done(); }, 230);
}
function qdEnd() {
  const d = qd; qd = null; if (!d) return; clearTimeout(d.t); clearTimeout(d.p); qdUnpress(d.id);
  if (!d.on) return;
  qdClick = true; setTimeout(() => { qdClick = false; }, 350);   // 離したあとの「押した」でタスクを開かない
  $("taskBody").querySelectorAll(".q").forEach(b => b.classList.remove("drop")); const quad = $("taskBody").querySelector(".quad"); if (quad) quad.classList.remove("dragging");
  const k = qdHitK(d, d.x, d.y), t = db.tasks.find(x => x.id === d.id), to = k && QUADS.find(z => z.k === k);
  if (t && to && k !== d.from) {   // 別のマス → 移して、写しを移り先の置き場所へ吸い込ませる
    delete qMark[d.id]; qMark[d.id] = "qhide";
    t.imp = to.imp; t.urg = to.urg; t.updatedAt = nowIso(); save(); render();
    const ni = qiOf(d.id);
    qdSettle(d, ni ? ni.getBoundingClientRect() : d.r, () => qMarkSet(d.id, null));
    toast("「" + to.name + "」に移しました");
    return;
  }
  const back = qiOf(d.id);   // 元の所へスッと戻す
  qdSettle(d, back ? back.getBoundingClientRect() : d.r, () => qMarkSet(d.id, null));
}
$("taskBody").addEventListener("touchstart", e => { if (e.touches.length === 1) qdStart(e.touches[0].clientX, e.touches[0].clientY, e.target); }, {passive: true});
$("taskBody").addEventListener("touchmove", e => { if (qd && e.touches.length === 1) qdMove(e.touches[0].clientX, e.touches[0].clientY, e); }, {passive: false});
$("taskBody").addEventListener("touchend", qdEnd); $("taskBody").addEventListener("touchcancel", qdEnd);
$("taskBody").addEventListener("mousedown", e => { if (e.button === 0) qdStart(e.clientX, e.clientY, e.target); });   // PC のマウスでも
window.addEventListener("mousemove", e => { if (qd) qdMove(e.clientX, e.clientY, e); });
window.addEventListener("mouseup", () => { if (qd) qdEnd(); });
$("taskBody").addEventListener("click", e => { if (qdClick) { e.stopPropagation(); e.preventDefault(); } }, true);
$("taskBody").addEventListener("contextmenu", e => { if (e.target.closest(".qi")) e.preventDefault(); });   // 長押しのメニューを出さない
function toggleTask(id) {
  const t = db.tasks.find(x => x.id === id); if (!t) return;
  t.done = !t.done; t.doneAt = t.done ? nowIso() : null; t.updatedAt = nowIso();
  let msg = t.done ? (isWait(t) ? "済みにしました（チームに伝わります）" : "完了にしました") : "未完了に戻しました";
  if (!isWait(t) && repOk(t.repeat)) {
    if (t.done) {   // くり返し：次の回を入れる（もう作ってあれば作らない）
      let nx = db.tasks.find(x => x.repFrom === t.id && !x.done);
      if (!nx) {
        const ts = nowIso();
        nx = {id: newId(), title: t.title, note: t.note || "", imp: !!t.imp, urg: !!t.urg, due: repNextDue(t), time: t.time || "", area: areaOfX(t), repeat: plain(t.repeat),
          done: false, doneAt: null, createdAt: ts, updatedAt: ts, src: "me", repFrom: t.id};
        db.tasks.push(nx);
      }
      t.repNext = nx.id; msg = "完了にしました。次の回（" + mdw(nx.due) + (nx.time ? " " + nx.time : "") + "）を入れました";
    } else if (t.repNext) {   // 完了を戻した：作った次の回を消す（直していない・済んでいない物だけ）
      const nx = db.tasks.find(x => x.id === t.repNext);
      if (nx && !nx.done && nx.updatedAt === nx.createdAt) { db.tasks = db.tasks.filter(x => x !== nx); msg = "未完了に戻しました（次の回は消しました）"; }
      t.repNext = null;
    }
  }
  save(); render(); toast(msg);
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
  $("weekStrip").innerHTML = `<button class="arrow" data-wk="-1" aria-label="前の週">${SF.chevL}</button>` + [0, 1, 2, 3, 4, 5, 6].map(i => {
    const d = addDays(ws, i), s = ymd(d);
    return `<button class="wd${s === T ? " today" : ""}${calMode === "day" && s === sel ? " sel" : ""}" data-day="${s}">${WD[i]}<b>${d.getDate()}</b><i class="${[...db.events.filter(inArea), ...(showWork() ? kcEvents() : [])].some(e => e.date === s && !e.deleted) ? "on" : ""}"></i></button>`;
  }).join("") + `<button class="arrow" data-wk="1" aria-label="次の週">${SF.chevR}</button>`;
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
  const tb = $("tabs").getBoundingClientRect(), under = tb.height ? window.innerHeight - tb.top : 66;   // 下のメニュー（浮いたカプセル）から下の分
  w.style.height = Math.max(240, window.innerHeight - top - under - 70 + window.scrollY) + "px";
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
/* ---------- メモの分類（v6.7・社長「雑なメモがどんどんたまるので、重要なメモと振り分けて」・見本＝iPhone のメールのカテゴリ） ----------
   memos.cat："imp"(重要)|"idea"(ネタ・アイデア)|"etc"(その他)。無い物（まだ振り分けていない）は「その他」に出る。
   catBy："ai"＝PCのポケノート係が中身で決めた／"me"＝社長が選んだ（係は "me" を変えない）。仕事/プライベートの絞りと重ねて効く。
   上の切り替え：選んでいる物だけ青いカプセル（アイコン＋名前）、ほかは灰色のアイコンだけ＋数。メモを長押しで分類を移す。検索は全部の分類から探す */
const ICO = {
  imp: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z"/></svg>`,
  idea: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2zM9 19.5h6v1A1.5 1.5 0 0 1 13.5 22h-3A1.5 1.5 0 0 1 9 20.5z"/></svg>`,
  etc: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 3H15l4 4v12.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3zM8 11h8v1.6H8zm0 3.6h8v1.6H8zM8 7.4h5V9H8z"/></svg>`};
const MCATS = [["imp", "重要"], ["idea", "ネタ・アイデア"], ["etc", "その他"]], MCAT_LS = "pocket-memocat";
const catOf = m => m && (m.cat === "imp" || m.cat === "idea") ? m.cat : "etc";
const catName = k => (MCATS.find(x => x[0] === k) || MCATS[2])[1];
let memoCat = (() => { try { const v = localStorage.getItem(MCAT_LS); return MCATS.some(x => x[0] === v) ? v : "imp"; } catch (e) { return "imp"; } })();
function setMemoCat(k) { memoCat = k; try { localStorage.setItem(MCAT_LS, k); } catch (e) {} renderMemos(); }
function moveCat(id, k) { const m = db.memos.find(x => x.id === id); if (!m) return; m.cat = k; m.catBy = "me"; m.updatedAt = nowIso(); save(); render(); toast(catName(k) + "に移しました"); }
/* 長押しのメニュー：分類を移す */
function catMenu(id) {
  const m = db.memos.find(x => x.id === id); if (!m) return;
  openSheet("分類を移す", `<p class="note" style="margin:0 4px 10px">${esc(String(m.text || "").split("\n")[0].slice(0, 40))}</p><div class="group">${MCATS.map(([k, l]) =>
    `<button class="cell catpick" data-catpick="${k}"><span class="cic ${k}">${ICO[k]}</span><div class="grow"><div class="t">${l}</div></div>${catOf(m) === k ? `<span class="chk">${SF.check}</span>` : ""}</button>`).join("")}</div>`);
  $("sheetBody").querySelectorAll("[data-catpick]").forEach(b => b.onclick = () => { closeSheet(); moveCat(id, b.dataset.catpick); });
}
const MEMPTY = {imp: "重要なメモはまだありません。PCの秘書が中身で振り分けます（メモを長押しでも移せます）", idea: "ネタ・アイデアのメモはまだありません", etc: "メモはまだありません。右下の書くボタンか、下の欄から書けます"};
function renderMemos() {
  const q = $("memoSearch").value.trim().toLowerCase(), mine = liveMemos().filter(inArea);
  const cnt = k => mine.filter(m => catOf(m) === k).length;
  $("memoCats").innerHTML = MCATS.map(([k, l]) => { const n = cnt(k);
    return `<button class="mcat" data-mcat="${k}" role="tab" aria-pressed="${!q && memoCat === k}" aria-label="${l} ${n}件"><span class="ic">${ICO[k]}</span><span class="lb">${l}</span>${n ? `<span class="cnt">${n > 99 ? "99+" : n}</span>` : ""}</button>`; }).join("");
  const list = mine.filter(m => q ? String(m.text).toLowerCase().includes(q) : catOf(m) === memoCat).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $("memoBody").innerHTML = `<div class="group">${list.map(m => {
    const lines = String(m.text || "").split("\n"), head = lines[0] || "（空のメモ）", rest = lines.slice(1).join(" ").trim();
    return `<div class="mrow" data-mrow="${esc(m.id)}"><button class="mdel" data-mdel="${esc(m.id)}" aria-label="削除" tabindex="-1">${SF.trash}<span>削除</span></button><button class="memo" data-medit="${esc(m.id)}"><div class="t">${q ?`<span class="mcico ${catOf(m)}" aria-label="${catName(catOf(m))}">${ICO[catOf(m)]}</span>` : ""}${esc(head)}</div>${rest ? `<div class="s">${esc(rest)}</div>` : ""}${memoTag(m)}<div class="s" style="font-size:12px;margin-top:4px">${whenText(m.createdAt)}</div></button></div>`;
  }).join("") || `<div class="empty">${q ? "見つかりません" : MEMPTY[memoCat]}</div>`}</div>${list.length ? `<p class="note">長押しで分類を移す・左にスワイプで削除</p>` : ""}`;
  if (swOpen) { const r = $("memoBody").querySelector(`[data-mrow="${CSS.escape(swOpen)}"]`); if (r) r.classList.add("open"); else swOpen = null; }   // 開いていた「削除」は描き直しても開いたまま
}
/* 長押し（0.5秒・指が動いたらやめる）→ 分類を移す。長押しのあとの「押した」ではメモを開かない。PC の右クリックでも出る */
let lpT = null, lpAt = null, lpFired = false;
const lpClear = () => { clearTimeout(lpT); lpT = null; };
$("memoBody").addEventListener("pointerdown", e => {
  const b = e.target.closest("[data-medit]"); lpFired = false; lpClear(); if (!b) return;
  lpAt = [e.clientX, e.clientY];
  lpT = setTimeout(() => { lpT = null; lpFired = true; try { if (navigator.vibrate) navigator.vibrate(10); } catch (x) {} catMenu(b.dataset.medit); }, 500);
});
$("memoBody").addEventListener("pointermove", e => { if (lpT && lpAt && Math.hypot(e.clientX - lpAt[0], e.clientY - lpAt[1]) > 10) lpClear(); });
["pointerup", "pointercancel", "pointerleave"].forEach(ev => $("memoBody").addEventListener(ev, lpClear));
$("memoBody").addEventListener("click", e => { if (lpFired) { e.stopPropagation(); e.preventDefault(); lpFired = false; } }, true);
/* ---------- メモを左にスワイプして削除（v6.7・社長「スワイプで削除・下に元に戻す」。純正のメール・メモと同じ形） ----------
   左に引くと右に赤い「削除」。押すか、幅の半分以上引っぱると消える。消した物はすぐには消さず deleted の印だけ付けて、
   画面の下に「メモを削除しました［元に戻す］」を5秒出す。5秒たったら本当に消す（続けて消したら、前の物はその時に消す）。
   長押し（分類を移す）とはぶつからない：横に動いたら長押しをやめる */
const DEL_W = 88;
let swp = null, swOpen = null, swClick = false;
const liveMemos = () => db.memos.filter(m => !m.deleted);
function swSet(row, x, anim) { const b = row.querySelector(".memo"); b.style.transition = anim ? "transform .25s cubic-bezier(.2,.8,.2,1)" : "none"; b.style.transform = x ? `translateX(${x}px)` : ""; row.classList.toggle("open", x < 0); }
function swClose() { if (!swOpen) return; const r = $("memoBody").querySelector(`[data-mrow="${CSS.escape(swOpen)}"]`); swOpen = null; if (r) swSet(r, 0, true); }
$("memoBody").addEventListener("pointerdown", e => {
  const b = e.target.closest(".memo[data-medit]"), row = b && b.closest(".mrow");
  if (swOpen && (!row || row.dataset.mrow !== swOpen)) { swClose(); swClick = true; setTimeout(() => { swClick = false; }, 350); return; }   // 開いている時は、ほかを押したら閉じるだけ
  if (!row) return;
  swp = {row, x0: e.clientX, y0: e.clientY, base: row.classList.contains("open") ? -DEL_W : 0, x: 0, mode: ""};
});
$("memoBody").addEventListener("pointermove", e => {
  if (!swp) return;
  const dx = e.clientX - swp.x0, dy = e.clientY - swp.y0;
  if (!swp.mode) {
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { swp.mode = "h"; lpClear(); try { swp.row.setPointerCapture(e.pointerId); } catch (x) {} }
    else if (Math.abs(dy) > 8) { swp.mode = "v"; return; } else return;
  }
  if (swp.mode !== "h") return;
  swp.x = Math.min(0, swp.base + dx); swSet(swp.row, swp.x < 0 ? swp.x : 0, false); e.preventDefault();
});
const swEnd = () => {
  const s = swp; swp = null; if (!s || s.mode !== "h") return;
  swClick = true; setTimeout(() => { swClick = false; }, 350);   // 引っぱり終わりの「押した」でメモを開かない
  const id = s.row.dataset.mrow, w = s.row.offsetWidth;
  if (s.x < -w * 0.5) { swOpen = null; swGone(s.row, id); }   // 最後まで引っぱった
  else if (s.x < -DEL_W / 2) { swOpen = id; swSet(s.row, -DEL_W, true); }   // 「削除」を出しておく
  else { if (swOpen === id) swOpen = null; swSet(s.row, 0, true); }
};
$("memoBody").addEventListener("pointerup", swEnd); $("memoBody").addEventListener("pointercancel", swEnd);
$("memoBody").addEventListener("click", e => {
  if (swClick) { e.stopPropagation(); e.preventDefault(); return; }
  const d = e.target.closest("[data-mdel]"); if (d) { e.stopPropagation(); swOpen = null; swGone(d.closest(".mrow"), d.dataset.mdel); }
}, true);
/* 消える動き：横に流して、行の高さを縮めてから消す */
function swGone(row, id) {
  if (!row) { deleteMemo(id); return; }
  const h = row.offsetHeight; row.style.height = h + "px"; swSet(row, -row.offsetWidth, true);
  void row.offsetWidth; row.style.transition = "height .22s ease .12s"; row.style.height = "0px";
  setTimeout(() => deleteMemo(id), 340);
}
/* 画面の下の「〜しました［元に戻す］」（v6.7 メモの削除・v6.11 音声で自動で送った時の［取り消す］）。出せるのは1つ：新しく出す時は、前の物を確定する */
let undoT = null, undoId = null, undoFn = null, undoDone = null;
function showUndo(msg, label, onUndo, onDone, ms) {
  flushUndo();
  undoFn = onUndo; undoDone = onDone || null;
  $("undoMsg").textContent = msg; $("undoBtn").textContent = label || "元に戻す";
  document.body.classList.add("undoing"); $("undo").hidden = false; void $("undo").offsetWidth; $("undo").classList.add("on");   // 出したその場で動きを始める
  clearTimeout(undoT); undoT = setTimeout(flushUndo, ms || 5000);
}
function flushUndo() { clearTimeout(undoT); undoT = null; const d = undoDone; undoFn = undoDone = null; hideUndo(); if (d) d(); }   // 時間が来た・次が出た＝確定
function hideUndo() { const u = $("undo"); u.classList.remove("on"); document.body.classList.remove("undoing"); setTimeout(() => { if (!u.classList.contains("on")) u.hidden = true; }, 220); }
$("undoBtn").onclick = () => { clearTimeout(undoT); undoT = null; const f = undoFn; undoFn = undoDone = null; hideUndo(); if (f) f(); };
function deleteMemo(id) {
  const m = db.memos.find(x => x.id === id); if (!m) return;
  flushUndo();   // 前に消した物は、ここで本当に消す（元に戻せるのは最後の1つ）
  m.deleted = true; m.updatedAt = nowIso(); undoId = id; save(); render();
  showUndo("メモを削除しました", "元に戻す",
    () => { undoId = null; const x = db.memos.find(y => y.id === id); if (x) { x.deleted = false; x.updatedAt = nowIso(); save(); render(); toast("元に戻しました"); } },
    () => commitDelete(id));
}
function commitDelete(id) {
  if (undoId === id) undoId = null;
  const m = db.memos.find(x => x.id === id);
  if (m && m.deleted) { db.memos = db.memos.filter(x => x !== m); save(); render(); }
}
/* 前に開いた時に消しかけのまま閉じた物（deleted の印のまま）は、次に開いた時に片づける */
function sweepDeleted() {
  const old = db.memos.filter(m => m.deleted && m.id !== undoId && Date.now() - Date.parse(m.updatedAt || 0) > 15000);
  if (old.length) { db.memos = db.memos.filter(m => !old.includes(m)); save(); }
}
$("memoBody").addEventListener("contextmenu", e => { const b = e.target.closest("[data-medit]"); if (!b) return; e.preventDefault(); lpClear(); if (!lpFired) { lpFired = true; catMenu(b.dataset.medit); } });
function addMemo(text, area, cat) {
  const m = {id: newId(), text, status: "wait", result: null, area: area || newArea(), createdAt: nowIso(), updatedAt: nowIso()};
  if (cat) { m.cat = cat; m.catBy = "me"; }   // 社長が選んだ時だけ。選ばない時は PCの係が中身で振り分ける（それまで「その他」）
  db.memos.push(m); save(); return m;
}

/* ---------- 秘書 ---------- */
let chatHtml = "";   // いま秘書の画面に出している会話（同じなら描き直さない）
function renderAi() {
  const on = pcOn();
  $("pcState").className = "pc" + (on ? " on" : "");
  $("pcState").innerHTML = on ? `<i></i>PCの秘書：対応中（パソコンが開いています）` : `<i></i>PCの秘書：お休み中（送った文はためておいて、PCが開いたら届きます）${pcAt ? " ・ 最後 " + esc(whenText(pcAt.toISOString())) : ""}`;
  let h = `<div class="msg ai">ここに頼みごとを書いてください。予定・タスクに入れる、メンバーに頼む、などを秘書がやります。</div>`, last = "";
  const list = db.chat.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const ICON = {task: ["var(--blue)", SF.check], event: ["var(--red)", SF.cal], memo: ["var(--orange)", SF.note], member: ["var(--gray)", SF.person]};   // 文字の丸（予・メ・人）をやめて線のアイコンに
  list.forEach((c, i) => {
    const d = new Date(c.at), day = ymd(d);
    const stamp = day === todayStr() ? "今日 " + hm(d) : (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm(d);
    if (day + pad(d.getHours()) !== last) { h += `<div class="when">${stamp}</div>`; last = day + pad(d.getHours()); }
    h += `<div class="msg ${c.role === "me" ? "me" : "ai"}${c.kind === "nippo" ? " nippo" : ""}">${esc(c.text)}</div>`;
    if (c.role !== "me" && c.kind === "nippo") h += `<button class="copyBtn" data-copy="${esc(c.id)}">コピー</button>`;   // 秘書が作った日報
    if (c.role !== "me" && Array.isArray(c.items) && c.items.length) h += `<div class="card2">${c.items.map(x => { const ic = ICON[x.kind] || ICON.memo; return `<div class="row2"><span class="ico" style="background:${ic[0]}">${ic[1]}</span><span class="grow">${esc(x.label)}</span><span class="state">${esc(x.state || "")}</span></div>`; }).join("")}</div>`;
    if (c.role === "me" && (c.status === "wait" || c.status === "doing")) {
      const later = list.slice(i + 1).some(x => x.role === "me");   // 続けて送った分は、いちばん下だけに出す
      if (!later) h += `<div class="stat">${c.status === "doing" ? "秘書が対応中…" : on ? "届きました（秘書がもうすぐ見ます）" : "ためています（PCが開いたら届きます）"}</div>`;
    }
  });
  /* 中身が同じなら描き直さない（PCの秘書の見張りが動くたびに全部を描き直して揺れないように）。
     いちばん下を見ていた時は、新しい吹き出しが来ても下に合わせたまま（上の方を読んでいる時は動かさない） */
  if (h === chatHtml) return;
  const atBottom = !chatHtml || window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
  chatHtml = h; $("chatBody").innerHTML = h;
  if (atBottom) chatToBottom();
}

/* ---------- 入力欄（どの画面にも） ---------- */
/* 空ならマイク、書いてあれば送る。聞いている間はマイク（赤）のまま＝押して止められる */
function syncAskBtn() { const has = !!$("askIn").value.trim(), recOn = !!rec && recBtn === $("askMic"); $("askMic").hidden = has && !recOn; $("askSend").hidden = !has || recOn; }
/* 下の入力欄は複数行（textarea）：書いた分だけ高さが伸びる（最大6行・それより長い時は中を動かす）。改行キーは改行、送るのはボタン（社長「改行されず打ちにくい」） */
/* メモの画面の大きい書くボタンは、下の欄で打っている間（中身がある・カーソルがある）は隠す（伸びた欄と重なるため。テスター） */
function syncFab() { const el = $("askIn"); $("memoFab").hidden = view !== "memo" || document.activeElement === el || !!el.value.trim(); }
$("askIn").addEventListener("focus", syncFab); $("askIn").addEventListener("blur", () => setTimeout(syncFab, 0));
function growAsk() { const el = $("askIn"); el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 142) + "px"; }
/* キーボードが出ている間（v6.1・社長「入力欄に打つ時、下のタブがキーボードと一緒に上がってくるのが嫌」）
   文字の欄（下の欄・秘書の画面・メモを書く画面など）にカーソルがある間は body に kb を付けて下のタブを隠し、
   下の欄・下から出る画面を、見えている所（visualViewport）の下の端＝キーボードのすぐ上に置く。打ち終わったら元に戻す */
const isTyping = el => !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" && /^(text|search|email|url|tel|number)?$/i.test(el.getAttribute("type") || ""));
function syncKb() {
  const on = isTyping(document.activeElement), vv = window.visualViewport, root = document.documentElement.style;
  document.body.classList.toggle("kb", on);
  /* レイアウトの下の端と、見えている所の下の端の差（キーボードで画面が縮む作りなら 0・縮まない作りならキーボードの高さ） */
  root.setProperty("--kb", (on && vv ? Math.max(0, Math.round(window.innerHeight - (vv.offsetTop + vv.height))) : 0) + "px");
  root.setProperty("--vvh", (vv ? Math.round(vv.height) : window.innerHeight) + "px");
}
document.addEventListener("focusin", syncKb);
document.addEventListener("focusout", () => setTimeout(syncKb, 120));   // 送るボタンを押した時に、押し終わる前に欄が動かないよう少し待つ
if (window.visualViewport) { visualViewport.addEventListener("resize", syncKb); visualViewport.addEventListener("scroll", syncKb); }
/* 下の欄のマイク・送るは、押してもカーソルを欄に残す（キーボードとタブが出たり消えたりしない） */
["askMic", "askSend"].forEach(id => $(id).addEventListener("mousedown", e => e.preventDefault()));
$("askIn").addEventListener("input", () => { syncAskBtn(); growAsk(); syncFab(); });
$("ask").addEventListener("submit", e => { e.preventDefault(); sendAsk(false); });
/* 下の欄を送る。auto＝音声入力が止まって自動で送った時（v6.11・社長「自動送信で」）：送ったあと下に［取り消す］を5秒。
   取り消すと、送った文を下の欄に戻す（聞きまちがいを直して送り直せる）。秘書へは、秘書がまだ受け取っていない間だけ取り消せる */
function sendAsk(auto) {
  const text = $("askIn").value.trim(); if (!text) return;
  const clear = () => { $("askIn").value = ""; syncAskBtn(); growAsk(); syncFab(); };
  const putBack = () => { $("askIn").value = text; syncAskBtn(); growAsk(); syncFab(); };
  if (view === "ai") {
    const c = {id: newId(), role: "me", text, at: nowIso(), status: "wait"};
    db.chat.push(c); save(); clear(); render(); chatToBottom();
    if (auto) showUndo("秘書に送りました", "取り消す", () => {
      const x = db.chat.find(y => y.id === c.id); if (!x) return;
      if (x.status && x.status !== "wait") { toast("秘書が受け取り済みです（取り消せません）"); return; }
      db.chat = db.chat.filter(y => y !== x); save(); render(); putBack(); toast("取り消しました");
    });
    return;
  }
  const m = addMemo(text); clear(); $("askIn").blur(); render();
  if (auto) showUndo("メモに入れました", "取り消す", () => { db.memos = db.memos.filter(x => x.id !== m.id); save(); render(); putBack(); toast("取り消しました"); });
  else toast(view === "memo" && memoCat !== "etc" ? "メモに入れました（振り分けまで「その他」に入ります）" : "メモに入れました");
}
/* ---------- 音声メモ（v5.2・社長「音声メモ機能いける？」→ A：話した言葉を文字に） ----------
   マイクを押す → 話している最中から入力欄に文字が出る → もう一度押すか、話し終わると止まる → 止まったら自動で送る（v6.11・下に［取り消す］5秒）。
   使えない時（ホーム画面のアプリで音声の文字起こしが止められている等）は、キーボードを開いて「キーボードのマイクで話してください」と案内。
   使う所：下の欄（メモ・秘書）／メモを書く画面。入ったメモはふつうのメモと同じく「振り分け待ち」で秘書に届く */
let rec = null, recBtn = null, recTarget = null, recLast = null;   // recLast：いちばん最後に作った音声認識（終わるまで覚えて、次を始める前に止める）
/* うまく使えなかった時の案内（何が原因か分かるよう、決まった言葉も出す。v6.10・社長「マイク使われへんくなった」） */
const SR_ERR = {
  "not-allowed": "マイクの使用が許可されていません（not-allowed）。iPhone の 設定 → アプリ → Safari → マイク を「確認」か「許可」に",
  "service-not-allowed": "音声入力が止められています（service-not-allowed）。設定 → 一般 → キーボード →「音声入力」をオンに",
  "audio-capture": "マイクが使えません（audio-capture）。ほかのアプリがマイクを使っていないか確かめてください",
  "network": "ネットにつながらないため、音声を文字にできません（network）"
};
const SRClass = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;
/* 止める（v6.11・社長「1回入力したら次が入力できなくなる」）：iPhone が終わりの合図（onend）を出さないと「聞いている」のまま残り、
   次にマイクを押しても「止める」だけで終わっていた。手で止めた時も、自動で止めた時と同じく1.5秒で打ち切ってボタンを戻す */
function stopDictation() {
  const me = rec; if (!me) return;
  if (!me._stopAt) me._stopAt = Date.now();
  try { me.stop(); } catch (e) {}
  setTimeout(() => { if (rec === me) { try { me.abort(); } catch (x) {} if (rec === me) { me.onend(); recLast = me; } } }, 1500);
}
const DICTATE_QUIET_MS = 2000, DICTATE_FIRST_MS = 5000, DICTATE_WAIT_MS = 30000;   // 黙ったら止める：話したあと2秒／聞き始めてから何も話さない時5秒／聞き始めるまで（許可の確認）最大30秒
/* onDone(言葉)：止まった時に新しい言葉が入っていたら呼ぶ（v6.11 自動で送る。日報など欄がいくつもある所では渡さない＝欄に入れるだけ） */
function dictate(target, btn, after, onDone) {
  if (rec) {
    /* 止めたのに残っている（iPhone が終わりの合図を出していない）→ 片づけて、この押したので新しく聞き始める（何回押しても毎回聞き始める） */
    if (rec._stopAt && Date.now() - rec._stopAt > 600) { const old = rec; try { old.abort(); } catch (x) {} if (rec === old) { old.onend(); recLast = old; } }
    else { stopDictation(); return; }
  }
  const SR = SRClass();
  /* 使えない時：押した直後にキーボードを開く（iPhone は押した直後でないと開かない）＋案内 */
  if (!SR) { target.focus(); toast("この画面では音声入力が使えません（音声認識なし）。キーボードのマイクを押して話してください", 6000); return; }
  let base = target.value, finals = "", interim = "", lastErr = "", quiet = null;
  if (base && !/[\s\n]$/.test(base)) base += " ";
  const ph = target.placeholder;
  try {
    if (recLast) { try { recLast.abort(); } catch (x) {} recLast = null; }   // 前の音声認識が残っていたら止める（iPhone は同時に1つしか使えず、残っていると始められない）
    const me = rec = recLast = new SR(); rec.lang = "ja-JP"; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
    recBtn = btn; recTarget = target;
    btn.classList.add("rec"); btn.setAttribute("aria-pressed", "true"); target.placeholder = "聞いています…（黙ると自動で止まります）";
    /* v6.6（社長「指示が終わったら自動でマイクが切れるように」）：最後に言葉が入ってから2秒（最初に何も話さない時は5秒）黙ったら止める。
       止めても iPhone が止まらない時は、1.5秒後に打ち切る。v6.11 から、下の欄・メモを書く画面は止まったら自動で送る（onDone）。日報は欄に入れるだけ */
    const arm = ms => { clearTimeout(quiet); quiet = setTimeout(() => {
      if (rec !== me) return;
      stopDictation();   // 止める（iPhone が止まらない時は1.5秒で打ち切り・次を始める前にもう一度止める）
    }, ms); };
    /* 5秒の「何も話さない」は、聞き始めてから数える（v6.10：iPhone は押したあとにマイク・音声入力の許可を聞くことがあり、
       その間に数えていたので、許可の前に打ち切って「キーボードのマイク」の案内に落ちていた＝社長「マイク使われへんくなった」）。
       聞き始めない時の止まりっぱなしを防ぐため、押してから30秒は待つ */
    arm(DICTATE_WAIT_MS);
    rec.onstart = () => { if (rec === me) arm(DICTATE_FIRST_MS); };
    rec.onresult = e => {
      interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) finals += r[0].transcript; else interim += r[0].transcript; }
      target.value = base + finals + interim;
      target.dispatchEvent(new Event("input", {bubbles: true}));
      arm(DICTATE_QUIET_MS);
    };
    rec.onerror = e => { lastErr = e && e.error || "error"; };
    rec.onend = () => {
      if (recLast === me) recLast = null;
      if (rec !== me) return;   // 二度目（打ち切りのあとに iPhone からも来た時）は何もしない
      clearTimeout(quiet);
      rec = null; btn.classList.remove("rec"); btn.setAttribute("aria-pressed", "false"); target.placeholder = ph;
      const said = (finals + interim).trim();
      target.value = (base + finals + interim).replace(/\s+$/, "") || target.value; target.dispatchEvent(new Event("input", {bubbles: true}));   // 確定前の言葉も残す
      if (lastErr === "no-speech") toast("聞き取れませんでした。もう一度マイクを押して話してください");
      else if (lastErr && lastErr !== "aborted") toast((SR_ERR[lastErr] || "音声を文字にできませんでした（" + lastErr + "）") + "。キーボードのマイクも使えます", 7000);   // 何が起きたかを、決まった言葉（not-allowed など）つきで出す
      if (after) after();
      if (onDone && said && (!lastErr || lastErr === "aborted")) onDone(said);   // 新しい言葉が入っていたら、そのまま送る（聞き取れなかった時は送らない）
    };
    rec.start();
  } catch (e) { rec = null; recLast = null; btn.classList.remove("rec"); btn.setAttribute("aria-pressed", "false"); target.placeholder = ph; target.focus(); toast("音声入力を始められませんでした（" + (e && (e.name || e.message) || "error") + "）。キーボードのマイクを押して話してください", 7000); }
}
$("askMic").onclick = () => dictate($("askIn"), $("askMic"), () => { syncAskBtn(); growAsk(); }, () => sendAsk(true));   // 止まったら自動で送る（秘書の画面＝秘書へ／ほか＝メモ）

/* ---------- 下から出る画面 ---------- */
let sheetDone = null, sheetSnap = "";
const sheetState = () => [...$("sheetBody").querySelectorAll("input,textarea")].map(x => x.type === "checkbox" ? x.checked : x.value).join("\u0001");
function openSheet(title, html, onDone, doneLabel) {
  $("sheet").style.transform = $("sheet").style.transition = $("scrim").style.opacity = "";   // 引っぱった跡を消す
  $("sheetTitle").textContent = title; $("sheetBody").innerHTML = html;
  $("sheetDone").textContent = doneLabel || "保存"; $("sheetDone").style.visibility = onDone ? "visible" : "hidden";
  sheetDone = onDone || null; $("scrim").hidden = $("sheet").hidden = false; $("sheetBody").scrollTop = 0;
  setTimeout(() => { sheetSnap = sheetState(); }, 0);
}
/* なめらかに消す（v6.7・社長「押して表示する時のガタつきを滑らかに」）：本物はすぐ隠し（中の作りはそのまま）、
   写しを同じ所に重ねて、動き（.ghost.out）が終わったら写しを消す。書いた途中の文も写しに移す（消える間に中身が変わって見えないように） */
function ghostOut(el, cls, ms) {
  if (!el || el.hidden) return;
  try { if (matchMedia("(prefers-reduced-motion: reduce)").matches) return; } catch (e) {}
  const g = el.cloneNode(true), src = el.querySelectorAll("input, textarea, select"), dst = g.querySelectorAll("input, textarea, select");
  src.forEach((x, i) => { if (dst[i]) { dst[i].value = x.value; if ("checked" in x) dst[i].checked = x.checked; } });
  g.removeAttribute("id"); g.querySelectorAll("[id]").forEach(x => x.removeAttribute("id"));
  g.classList.add("ghost", cls); g.setAttribute("aria-hidden", "true");
  el.parentNode.insertBefore(g, el.nextSibling); setTimeout(() => g.remove(), ms || 300);
}
function closeSheet() {
  stopDictation(); ghostOut($("sheet"), "out", 300); ghostOut($("scrim"), "out", 300);   // 下へ滑らせて消す（写しで動かす。本物はすぐ閉じる）
  $("scrim").hidden = $("sheet").hidden = true; sheetDone = null;
  $("sheet").style.transform = $("sheet").style.transition = $("scrim").style.opacity = "";
}
const sheetDirty = () => !!sheetDone && sheetState() !== sheetSnap;
const DISCARD_Q = "書いた内容を破棄しますか？";   // 純正のメモと同じ聞き方
function closeSafely() { if (sheetDirty() && !confirm(DISCARD_Q)) return; closeSheet(); }
$("sheetCancel").onclick = closeSafely; $("scrim").onclick = closeSafely;
/* 下から出る画面を、下に引っぱって閉じる（v6.7・社長「上から下にスワイプしても閉じない・画面ごと動く」→ 純正のシートと同じに）
   取っ手・見出しの所（中身がいちばん上までスクロールされている時は中身も）を下に引くと、指について下がる。
   画面の高さの1/4以上か、すばやく下にはらったら閉じる。足りなければ元に戻る。書きかけがある時は、閉じる前に「破棄しますか？」。
   引っぱっている間は、後ろの画面がゴムのように動かない（指の動きを止める・CSS の overscroll-behavior） */
let sdrag = null, sdragClick = false;
function sdragStart(y, target) {
  const sh = $("sheet"), body = $("sheetBody"); if (sh.hidden) return;
  const head = !!target.closest(".grab, .shead");
  const top = !head && !!target.closest("#sheetBody") && body.scrollTop <= 0 && !target.closest("input, textarea, select");
  if (!head && !top) return;
  sdrag = {y0: y, dy: 0, on: false, vy: 0, ly: y, lt: performance.now()};
}
function sdragMove(y, ev) {
  if (!sdrag) return;
  const sh = $("sheet"), dy = y - sdrag.y0;
  if (!sdrag.on) {
    if (dy > 6) { sdrag.on = true; sh.style.transition = "none"; }
    else if (dy < -6) { sdrag = null; return; }   // 上に動かした＝ふつうのスクロール
    else return;
  }
  if (ev.cancelable) ev.preventDefault();   // 後ろの画面・中身を動かさない
  const now = performance.now(); if (now > sdrag.lt) { sdrag.vy = (y - sdrag.ly) / (now - sdrag.lt); sdrag.ly = y; sdrag.lt = now; }   // 指の今の速さ（はらった時に閉じる）
  sdrag.dy = Math.max(0, dy);
  sh.style.transform = `translateY(${sdrag.dy}px)`;
  $("scrim").style.opacity = String(Math.max(0, 1 - sdrag.dy / Math.max(1, sh.offsetHeight)));
}
function sdragEnd() {
  const d = sdrag; sdrag = null; if (!d || !d.on) return;
  const sh = $("sheet"), v = performance.now() - d.lt > 120 ? 0 : d.vy;   // 止まってから離した時は、はらいではない
  sdragClick = true; setTimeout(() => { sdragClick = false; }, 350);   // 引っぱり終わりの「押した」でキャンセル等が動かないように
  const back = () => { sh.style.transition = "transform .25s cubic-bezier(.2,.8,.2,1)"; sh.style.transform = ""; $("scrim").style.opacity = ""; };
  if (!(d.dy > sh.offsetHeight * 0.25 || (v > 0.8 && d.dy > 40))) { back(); return; }
  if (sheetDirty() && !confirm(DISCARD_Q)) { back(); return; }
  closeSheet();   // 写しが今の位置から下へ滑って消える
}
$("sheet").addEventListener("touchstart", e => { if (e.touches.length === 1) sdragStart(e.touches[0].clientY, e.target); }, {passive: true});
$("sheet").addEventListener("touchmove", e => { if (e.touches.length === 1) sdragMove(e.touches[0].clientY, e); }, {passive: false});
$("sheet").addEventListener("touchend", sdragEnd); $("sheet").addEventListener("touchcancel", sdragEnd);
$("sheet").addEventListener("mousedown", e => { if (e.button === 0) sdragStart(e.clientY, e.target); });   // PC のマウスでも
window.addEventListener("mousemove", e => { if (sdrag) sdragMove(e.clientY, e); });
window.addEventListener("mouseup", () => { if (sdrag) sdragEnd(); });
$("sheet").addEventListener("click", e => { if (sdragClick) { e.stopPropagation(); e.preventDefault(); } }, true);
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
  const waitBox = t && isWait(t) ? `<div class="waitbox"><div class="from"><i class="secic">${SF.bell}</i>${esc(t.from || "チーム")}が待っています${t.due ? " ・ " + esc(dueLabel(t)) : ""}</div>
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
    ${t && isWait(t) ? "" : repBox(v)}
    <div class="lab">メモ</div>
    <textarea class="field" id="fNote" placeholder="（なくてもOK）">${esc(v.note || "")}</textarea>
    ${t && isWait(t) ? "" : areaChips(t ? areaOfX(t) : (v.area || newArea()))}
    ${t ? `<button type="button" class="btn" id="fDone">${t.done ? "未完了に戻す" : "完了にする"}</button><button type="button" class="btn danger" id="fDel">このタスクを消す</button>` : ""}`, () => saveTask(t, v));
  wireAreaChips(); wireRep();
  $("fQuick").addEventListener("click", e => { const b = e.target.closest("[data-q]"); if (!b) return; $("fDate").value = b.dataset.q; if (!b.dataset.q) $("fTime").value = ""; $("fQuick").querySelectorAll("[data-q]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); });
  $("fDate").addEventListener("input", () => $("fQuick").querySelectorAll("[data-q]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.q === $("fDate").value))));
  if (t) {
    $("fDone").onclick = () => { closeSheet(); toggleTask(t.id); };
    if ($("fDone2")) $("fDone2").onclick = () => { closeSheet(); toggleTask(t.id); };
    if ($("fCopy")) $("fCopy").onclick = async () => {
      try { await Promise.race([navigator.clipboard.writeText(t.link), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500))]); toast("コピーしました"); }
      catch (e) { toast("コピーできませんでした（長押しで選んでください）"); }
    };
    $("fDel").onclick = () => { if (!confirm(repOk(t.repeat) && !t.done ? "このくり返しタスクを消します（次の回も作られなくなります）。よろしいですか？" : "このタスクを消します。よろしいですか？")) return; db.tasks = db.tasks.filter(x => x.id !== t.id); save(); closeSheet(); render(); toast("消しました"); };
  } else setTimeout(() => $("fTitle").focus(), 80);
}
/* くり返しの入力：なし／毎日／平日／毎週（曜日）／毎月（日にち）。毎週・毎月の初めの値は、期限の日（無ければ今日）から */
function repBox(v) {
  const r = repOk(v.repeat) ? v.repeat : null, base = v.due ? parseYmd(v.due) : parseYmd(todayStr());
  const dow = r && r.type === "weekly" ? repDow(r) : base.getDay(), dom = r && r.type === "monthly" ? repDom(r) : base.getDate();
  return `<div class="lab">くり返し</div>
    <div class="chips" id="fRep">${REP_TYPES.map(([k, l]) => `<button type="button" class="chip" data-rep="${k}" aria-pressed="${(r ? r.type : "") === k}">${l}</button>`).join("")}</div>
    <div class="chips" id="fRepW"${r && r.type === "weekly" ? "" : " hidden"}>${[1, 2, 3, 4, 5, 6, 0].map(i => `<button type="button" class="chip" data-dow="${i}" aria-pressed="${dow === i}">${WD[i]}</button>`).join("")}</div>
    <div class="fgroup" id="fRepM" style="margin-top:10px"${r && r.type === "monthly" ? "" : " hidden"}><div class="frow">毎月<select id="fDom" class="sel">${Array.from({length: 31}, (_, i) => `<option value="${i + 1}"${dom === i + 1 ? " selected" : ""}>${i + 1}日${i + 1 >= 29 ? "（無い月は末日）" : ""}</option>`).join("")}</select></div></div>
    <p class="note" id="fRepNote"${r ? "" : " hidden"}>完了にすると、次の回を自動で入れます（期限が空なら、最初の回の日を期限にします）</p>`;
}
function wireRep() {
  const box = $("fRep"); if (!box) return;
  const pick = (sel, b) => $(sel).querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  box.addEventListener("click", e => {
    const b = e.target.closest("[data-rep]"); if (!b) return;
    pick("fRep", b); const k = b.dataset.rep;
    $("fRepW").hidden = k !== "weekly"; $("fRepM").hidden = k !== "monthly"; $("fRepNote").hidden = !k;
    const d = $("fDate").value ? parseYmd($("fDate").value) : null;   // 期限の日を先に入れていれば、その曜日・日にちに合わせる
    if (d && k === "weekly") pick("fRepW", $("fRepW").querySelector(`[data-dow="${d.getDay()}"]`));
    if (d && k === "monthly") $("fDom").value = String(d.getDate());
  });
  $("fRepW").addEventListener("click", e => { const b = e.target.closest("[data-dow]"); if (b) pick("fRepW", b); });
}
function readRep() {
  const b = $("fRep") && $("fRep").querySelector('[aria-pressed="true"]'), type = b ? b.dataset.rep : "";
  if (!type) return null;
  const r = {type};
  if (type === "weekly") { const w = $("fRepW").querySelector('[aria-pressed="true"]'); r.dow = w ? Number(w.dataset.dow) : 1; }
  if (type === "monthly") r.dom = Number($("fDom").value) || 1;
  return r;
}
function saveTask(t, v) {
  const title = $("fTitle").value.trim();
  if (!title) { toast("やることを入れてください"); return; }
  const rep = t && isWait(t) ? undefined : readRep();
  let due = $("fDate").value || null;
  if (rep && !due) due = repFirst(rep, parseYmd(todayStr()));   // くり返しで期限が空 → 今日から先で最初に当たる日
  const time = due ? $("fTime").value || "" : "";
  const data = {title, note: $("fNote").value.trim(), imp: $("fImp").checked, urg: $("fUrg").checked, due, time, updatedAt: nowIso()};
  if (!(t && isWait(t))) { data.area = pickedArea(); data.repeat = rep; }
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
    <div class="chips"><button type="button" class="chip micchip" id="mMic" aria-pressed="false">${SF.mic}話して書く</button></div>
    ${areaChips(m ? areaOfX(m) : newArea())}
    ${catChips(m && MCATS.some(x => x[0] === m.cat) ? m.cat : "")}
    ${m ? `<div class="chips"><button type="button" class="chip" id="mTask">タスクにする</button><button type="button" class="chip" id="mEvent">予定にする</button><button type="button" class="chip" id="mKeep" aria-pressed="${m.status === "memo"}">メモのまま（振り分けない）</button></div>
      <p class="note">${m.status === "done" && m.result ? "→ " + esc(m.result.label) + "<br>" : ""}書いた日時：${esc(whenText(m.createdAt))}</p>
      <button type="button" class="btn danger" id="mDel">このメモを消す</button>` : `<p class="note">書いたメモは、PCの秘書がつながったら「予定・タスク・メモのまま」に振り分けます。</p>`}`, () => saveMemo(m));
  if (m) {
    const firstLine = () => ($("mText").value.split("\n")[0] || "").trim().slice(0, 60);
    const ar = () => pickedArea();   // メモで選んでいる区分を、タスク・予定にも引き継ぐ
    $("mTask").onclick = () => { saveMemoText(m); taskForm(null, {title: firstLine(), note: $("mText").value.split("\n").slice(1).join("\n").trim(), memoId: m.id, area: ar()}); };
    $("mEvent").onclick = () => { saveMemoText(m); eventForm(null, {title: firstLine(), date: todayStr(), note: $("mText").value.split("\n").slice(1).join("\n").trim(), memoId: m.id, area: ar(), color: ar() === "private" ? "green" : "blue"}); };
    $("mKeep").onclick = () => { saveMemoText(m); m.status = m.status === "memo" ? "wait" : "memo"; m.result = null; m.updatedAt = nowIso(); save(); closeSheet(); render(); toast(m.status === "memo" ? "メモのままにしました" : "振り分け待ちに戻しました"); };
    $("mDel").onclick = () => { closeSheet(); deleteMemo(m.id); };   // 純正と同じく、聞かずに消して下に［元に戻す］
  } else setTimeout(() => $("mText").focus(), 80);
  wireAreaChips();
  $("mCat").addEventListener("click", e => { const b = e.target.closest("[data-mc]"); if (!b) return; $("mCat").querySelectorAll("[data-mc]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); });
  /* 音声メモ：話して書く。止まったら自動で保存（v6.11）。止まる前に画面を閉じた（キャンセル等）時は保存しない */
  const mBox = $("mText");
  $("mMic").onclick = () => dictate(mBox, $("mMic"), null, () => { if (!$("sheet").hidden && $("mText") === mBox) saveMemo(m, true); });
}
/* メモを書く画面の「分類」：おまかせ（PCの係が中身で振り分ける）／重要／ネタ・アイデア／その他 */
const catChips = cur => `<div class="lab">分類</div><div class="chips" id="mCat"><button type="button" class="chip" data-mc="" aria-pressed="${!cur}">おまかせ</button>${MCATS.map(([k, l]) =>
  `<button type="button" class="chip" data-mc="${k}" aria-pressed="${cur === k}">${ICO[k]}${l}</button>`).join("")}</div>`;
const pickedCat = () => { const b = $("mCat") && $("mCat").querySelector('[aria-pressed="true"]'); return b ? b.dataset.mc : ""; };
function saveMemoText(m) { const t = $("mText").value.trim(); if (t && t !== m.text) { m.text = t; m.updatedAt = nowIso(); save(); } }
/* auto＝メモを書く画面の音声入力が止まって自動で保存した時（v6.11）：下に［取り消す］を5秒。取り消すと、新しいメモは消して、直したメモは前の中身に戻し、
   どちらもメモを書く画面をもう一度開いて、話した文を入れたままにする（聞きまちがいを直せる） */
function saveMemo(m, auto) {
  const text = $("mText").value.trim();
  if (!text) { if (!m) { closeSheet(); return; } toast("中身が空です（消すときは下のボタン）"); return; }
  const c = pickedCat(), before = m ? {text: m.text, area: m.area, cat: m.cat, catBy: m.catBy, updatedAt: m.updatedAt} : null;
  let nm = null;
  if (m) {
    m.text = text; m.area = pickedArea(); m.updatedAt = nowIso();
    if (c !== (MCATS.some(x => x[0] === m.cat) ? m.cat : "")) { m.cat = c || null; m.catBy = c ? "me" : null; }   // 変えた時だけ（おまかせに戻すと係がもう一度振り分ける）
  } else nm = addMemo(text, pickedArea(), c);
  save(); closeSheet(); render();
  if (auto) {
    showUndo(m ? "メモを直しました" : "メモを保存しました", "取り消す", () => {
      if (m) { const cur = db.memos.find(x => x.id === m.id); if (cur) { Object.assign(cur, before); save(); render(); memoForm(cur); $("mText").value = text; } }   // 同期で入れ替わった今のメモを戻す
      else { db.memos = db.memos.filter(x => x.id !== nm.id); save(); render(); memoForm(null); $("mText").value = text; }
      toast("取り消しました");
    });
    return;
  }
  toast(m ? "直しました" : !c && view === "memo" && memoCat !== "etc" ? "メモしました（振り分けまで「その他」に入ります）" : "メモしました");
}
function markMemo(id, kind, label) { const m = db.memos.find(x => x.id === id); if (!m) return; m.status = "done"; m.result = {kind, label}; m.updatedAt = nowIso(); }

/* ---------- 押したとき（まとめて） ---------- */
document.addEventListener("click", e => {
  const t = e.target;
  const gt = t.closest("[data-goto]"); if (gt) { go(gt.dataset.goto); return; }
  const pu = t.closest("[data-push]"); if (pu) { enablePush(); return; }
  const hs = t.closest("[data-hisho]"); if (hs) { hishoOpen = !hishoOpen; appearNext = true; render(); return; }
  const kt = t.closest("[data-kctoggle]"); if (kt) { kcOpen = !kcOpen; appearNext = true; render(); return; }
  const mc = t.closest("[data-mcat]"); if (mc) { $("memoSearch").value = ""; setMemoCat(mc.dataset.mcat); return; }   // 分類を押したら検索は消す
  const np = t.closest("[data-nippo]"); if (np) { const r = nippoToday().reply; if (r) nippoOut(r); else nippoForm(); return; }
  const cp = t.closest("[data-copy]"); if (cp) { const c = db.chat.find(x => x.id === cp.dataset.copy); if (c) copyText(c.text); return; }
  const pr = t.closest("[data-prep]"); if (pr) { togglePrep(pr.dataset.prep, Number(pr.dataset.pi), pr.dataset.pday); return; }
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
  if (!U || COLS.some(c => !got[c])) return;   // ログイン前・最初の読み込みが来るまでは描かない
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
