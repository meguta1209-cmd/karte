/* ============================================================
   結果カウンター チーム版
   ・Googleでログイン → 名前を登録 → 管理者が承認 → 使える
   ・データは Firestore（kekka-counter-2026）
       members/{uid}   名簿（name, email, closer, status: pending/active/removed, role）
       records/{id}    1架電＝1件（uid, r, t, day, hour, memo, undated, pending, done, slotId。前のカウンターから引っ越した分は src:"old"）
       slots/{日_時刻_クローザー}  アポの枠。1枠1件なので二重予約できない
       stats/{日}      日ごとの集計 c.{uid}.{結果} / h.{uid}.{時}（KPIとチーム数はここだけ読む）
       config/items    結果の項目（管理者が編集）
       imports/{uid}   前のカウンターからの引っ越しの進み具合 days.{日} = {n, last, done, skip}
   ・カレンダーとアポはリアルタイム、チームの架電数は30秒ごとに読む（無料枠に収めるため）
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, query, where, orderBy, documentId, onSnapshot, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  writeBatch, runTransaction, increment, Timestamp, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const ADMIN_EMAIL = "meguta1209@gmail.com";
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

/* ---------- 項目（シートの結果欄と同じ12個・同じ色）。config/items があればそちらが優先 ---------- */
const DEFAULT_ITEMS = [
  {k:"留守",         bg:"#E8EAED", fg:"#3C4043"},
  {k:"受けブロ",     bg:"#E6CFF2", fg:"#5A3286"},
  {k:"オーナー断り", bg:"#B10202", fg:"#FFFFFF"},
  {k:"接客中",       bg:"#BDE7E0", fg:"#0B5B4F"},
  {k:"ガチャ切り",   bg:"#5F6368", fg:"#FFFFFF"},
  {k:"使われてない", bg:"#D5D8DC", fg:"#80868B", strike:true},
  {k:"オーナー不在", bg:"#C6DBE1", fg:"#215A6C"},
  {k:"繋がらない",   bg:"#E1D5C9", fg:"#5B4636"},
  {k:"アポ",         bg:"#FFD54F", fg:"#473822"},
  {k:"本社管理",     bg:"#0A53A8", fg:"#FFFFFF"},
  {k:"NG",           bg:"#473822", fg:"#FFFFFF"},
  {k:"再架電",       bg:"#BFE1F6", fg:"#0A53A8"}
];
const PALETTE = [
  ["#E8EAED","#3C4043"], ["#D5D8DC","#3C4043"], ["#5F6368","#FFFFFF"],
  ["#BFE1F6","#0A53A8"], ["#C6DBE1","#215A6C"], ["#BDE7E0","#0B5B4F"], ["#D4EDBC","#11734B"],
  ["#FFD54F","#473822"], ["#FFC8AA","#753800"], ["#FFCFC9","#B10202"],
  ["#E6CFF2","#5A3286"], ["#E1D5C9","#5B4636"], ["#B10202","#FFFFFF"],
  ["#0A53A8","#FFFFFF"], ["#11734B","#FFFFFF"], ["#473822","#FFFFFF"]
];
const PEOPLE_COLORS = ["#1E4E86","#11734B","#8A4B08","#6B3FA0","#A33A5B","#0B6E7A","#5B6B1A","#9C3D10","#3D4F8F","#7A2E6E"];
const CLOSER_COLORS = ["#2F6DB5","#1F7A55","#B0572A","#7B4DB8","#B83B6B","#0E7F8C"];
const KEYS = "1234567890qwertyuiop";
const SLOT_H0 = 10, SLOT_H1 = 19;          // アポ枠 10:00〜19:00・30分ごと・日曜休み

/* ---------- 小道具 ---------- */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const WD = ["日","月","火","水","木","金","土"];
const dk = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const md = d => (d.getMonth() + 1) + "/" + d.getDate() + "(" + WD[d.getDay()] + ")";
const hm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
const dayStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const today = () => dayStart(new Date());
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const toLocal = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
const tsd = v => v && typeof v.toDate === "function" ? v.toDate() : (v instanceof Date ? v : null);
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
let tt;
function toast(msg, actLabel, act) {
  const el = $("toast"); el.textContent = msg;
  if (actLabel) { const b = document.createElement("button"); b.textContent = actLabel; b.onclick = () => { el.classList.remove("on"); act(); }; el.appendChild(b); }
  el.classList.add("on"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("on"), actLabel ? 3500 : 2200);
}
const errMsg = e => (e && e.code === "permission-denied") ? "権限がありません" : (e && e.message === "FULL") ? "その時間は埋まっています" : (e && e.code === "unavailable") ? "オフラインのため保存できません" : "保存できませんでした";

/* ---------- 状態 ---------- */
let U = null;            // ログイン中の uid
let me = null;           // 自分の members の中身
let members = {};        // uid → 名簿
let ITEMS = DEFAULT_ITEMS;
let COL = {};
let myToday = [];        // 自分の今日の記録
let pendMine = [], pendTeam = [], undated = [], slots = [];
const loadedFlags = {rec: false, task: false};   // 「今日の予定」は両方そろってから出す
let unsubs = [];
/* 購読が断られたら黙って止まらず、数秒おいて張り直す（名簿の確定直後などに起こりうる） */
let retrying = false;
const onErr = what => e => {
  console.error(what, e);
  if (retrying || !U) return;
  retrying = true;
  toast(what + "の読み込みをやり直しています…");
  setTimeout(() => { retrying = false; if (!U || !me || me.status !== "active") return; stopAll(); startApp(); }, 3000);
};
let started = false, itemsLoaded = false;

const nameOf = uid => (members[uid] && members[uid].name) || "（退出した人）";
function colorOf(uid) {
  const ids = Object.keys(members).sort();
  const i = ids.indexOf(uid);
  return PEOPLE_COLORS[(i < 0 ? 0 : i) % PEOPLE_COLORS.length];
}
function closerList() {
  const list = Object.entries(members).filter(([, m]) => m.status === "active" && m.closer)
    .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || "", "ja"))
    .map(([id, m], i) => ({id, name: m.name, color: CLOSER_COLORS[i % CLOSER_COLORS.length]}));
  return list.length ? list : [{id: "none", name: "担当未定", color: "#5F6368"}];
}
const CNAME = id => (closerList().find(c => c.id === id) || {name: id === "none" ? "担当未定" : nameOf(id)}).name;
const CCOL = id => (closerList().find(c => c.id === id) || {color: "#5F6368"}).color;
const OLD_BADGE = `<span class="badge old">前のカウンター</span>`;   // 前のカウンターから引っ越した記録の印
const resChip = k => { const c = COL[k] || (typeof TASK_COL !== "undefined" && TASK_COL[k]) || {bg:"#E8EAED", fg:"#3C4043"}; return `<span class="res${c.strike ? " strike" : ""}" style="background:${c.bg};color:${c.fg}">${esc(k)}</span>`; };

/* Firestore の記録 → 画面で使う形 */
function recOf(snap) {
  const d = snap.data();
  const m = d.memo ? {...d.memo, when: tsd(d.memo.when)} : null;
  return {...d, id: snap.id, t: tsd(d.t) || new Date(), memo: m};
}

/* ============================================================
   入口：ログイン → 名簿を見て振り分け
   ============================================================ */
const GATES = ["gLoading", "gLogin", "gRegister", "gPending", "gRemoved"];
function gate(id) { GATES.forEach(g => $(g).hidden = g !== id); $("app").hidden = true; }

/* アプリの中のブラウザ（LINE・インスタ・Facebook など）ではログインできないので、先に案内を出す */
const IN_APP = /\bLine\/|Instagram|FBAN|FBAV|FB_IAB|Twitter|TikTok|; wv\)/i.test(navigator.userAgent || "");
const APP_URL = location.origin + location.pathname;
if (IN_APP) $("inApp").hidden = false;
$("copyLink").onclick = async () => {
  try { await navigator.clipboard.writeText(APP_URL); toast("リンクをコピーしました。Safari／Chromeに貼り付けてください"); }
  catch (_) { prompt("このリンクをコピーしてください", APP_URL); }
};
$("btnLogin").onclick = async () => {
  $("loginErr").hidden = true;
  if (IN_APP) { toast("SafariかChromeで開いてからログインしてください"); return; }
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    $("loginErr").hidden = false;
    $("loginErr").textContent = e.code === "auth/popup-blocked" ? "ポップアップが止められました。ブラウザの設定で許可してください" :
      e.code === "auth/popup-closed-by-user" ? "ログインの画面が閉じられました。もう一度押してください" : "ログインできませんでした（" + e.code + "）";
  }
};
["regLogout", "pendLogout", "remLogout", "logout"].forEach(id => $(id).onclick = () => { stopAll(); signOut(auth); });

let meUnsub = null;
onAuthStateChanged(auth, u => {
  if (meUnsub) { meUnsub(); meUnsub = null; }
  if (!u) { stopAll(); U = null; gate("gLogin"); return; }
  U = u.uid;
  gate("gLoading");
  meUnsub = onSnapshot(doc(db, "members", u.uid), {includeMetadataChanges: true}, async snap => {
    if (!snap.exists()) {
      if ((u.email || "").toLowerCase() === ADMIN_EMAIL) {     // 管理者は最初から有効
        await setDoc(doc(db, "members", u.uid), {name: "竹内", email: u.email, closer: false, status: "active", role: "admin", createdAt: serverTimestamp()});
        return;
      }
      $("regMail").textContent = u.email + " でログイン中";
      if (!$("regName").value) $("regName").value = (u.displayName || "").split(/\s/)[0].slice(0, 12);
      gate("gRegister"); return;
    }
    /* 自分の名簿がまだサーバーで確定していない間は始めない（確定前だと読み込みを断られる） */
    if (snap.metadata.hasPendingWrites) return;
    me = snap.data();
    if (me.status === "pending") { $("pendName").textContent = me.name; stopAll(); gate("gPending"); return; }
    if (me.status !== "active") { stopAll(); gate("gRemoved"); return; }
    GATES.forEach(g => $(g).hidden = true); $("app").hidden = false;
    renderMe();
    if (!started) startApp();
  }, e => { $("loginErr").hidden = false; $("loginErr").textContent = "読み込めませんでした（" + e.code + "）"; gate("gLogin"); });
});

$("btnRegister").onclick = async () => {
  const name = $("regName").value.trim();
  if (!name) { $("regErr").hidden = false; $("regErr").textContent = "名前を入れてください"; return; }
  $("btnRegister").disabled = true;
  try {
    await setDoc(doc(db, "members", U), {name, email: auth.currentUser.email, closer: $("regCloser").checked, status: "pending", role: "member", createdAt: serverTimestamp()});
  } catch (e) { $("regErr").hidden = false; $("regErr").textContent = "登録できませんでした（" + (e.code || e.message) + "）"; }
  $("btnRegister").disabled = false;
};

function stopAll() {
  unsubs.forEach(f => { try { f(); } catch (_) {} }); unsubs = []; started = false; clearInterval(teamTimer); clearInterval(notifTimer);
  movePlan = null; $("moveNag").hidden = true; if (!moving) $("mvScrim").hidden = $("moveDlg").hidden = true;   // 前の人の引っ越しの案内を残さない
}

/* ============================================================
   本体の開始：リアルタイムの購読を張る
   ============================================================ */
let listenDay = null;
function startApp() {
  started = true;
  const recs = collection(db, "records");
  unsubs.push(onSnapshot(collection(db, "members"), s => {
    members = {}; s.forEach(d => members[d.id] = d.data());
    renderMe(); renderAdmin(); renderCount(); if (curTab === "cal") renderCal(); renderUndated();
  }, onErr("メンバー")));
  unsubs.push(onSnapshot(doc(db, "config", "items"), s => {
    const list = s.exists() && Array.isArray(s.data().list) && s.data().list.length ? s.data().list : DEFAULT_ITEMS;
    ITEMS = list; COL = Object.fromEntries(ITEMS.map(i => [i.k, i])); itemsLoaded = true;
    buildGrid(); renderCount();
  }, onErr("項目")));
  subscribeToday();
  unsubs.push(onSnapshot(query(recs, where("uid", "==", U), where("pending", "==", true)), s => {
    recPendMine = s.docs.map(recOf); loadedFlags.rec = true; rebuildPending(); cleanupOldApos();
  }, onErr("予定")));
  unsubs.push(onSnapshot(query(recs, where("pending", "==", true)), s => { recPendTeam = s.docs.map(recOf); rebuildPending(); }, onErr("チームの予定")));
  /* テレアポ以外の予定（前確など） */
  unsubs.push(onSnapshot(query(collection(db, "tasks"), where("uid", "==", U), where("done", "==", false)), s => {
    taskMine = s.docs.map(taskOf); loadedFlags.task = true; rebuildPending();
  }, onErr("予定")));
  unsubs.push(onSnapshot(query(collection(db, "tasks"), where("done", "==", false)), s => { taskTeam = s.docs.map(taskOf); rebuildPending(); }, onErr("チームの予定")));
  unsubs.push(onSnapshot(query(recs, where("undated", "==", true)), s => { undated = s.docs.map(recOf).sort((a, b) => a.t - b.t); renderUndated(); }, onErr("日時未定のアポ")));
  unsubs.push(onSnapshot(collection(db, "busy"), {includeMetadataChanges: true}, s => {   // サーバーの最新が届いたことも知りたいので
    busyMap = {};
    s.forEach(d => { const x = d.data(); busyMap[d.id] = {...x, updatedAt: tsd(x.updatedAt), blocks: (x.blocks || []).map(b => ({s: tsd(b.s), e: tsd(b.e)})).filter(b => b.s && b.e)}; });
    /* 端末にとっておいた古い分ではなく、サーバーの最新が届いてから「連携がまだ」を判断する */
    if (!s.metadata.fromCache) busyLoaded = true;
    if (curTab === "cal") renderCal(); renderGcal(); if (!$("msheet").hidden) checkClash();
    maybeGcalGuide();
  }, onErr("クローザーの予定")));
  unsubs.push(onSnapshot(query(collection(db, "slots"), where("day", ">=", dk(addDays(today(), -7)))), s => {
    slots = s.docs.map(d => ({id: d.id, ...d.data(), when: tsd(d.data().when)}));
    if (curTab === "cal") renderCal(); if (!$("msheet").hidden) checkClash();
  }, onErr("カレンダー")));
  startFeedback();
  pollTeam(); teamTimer = setInterval(() => { if (document.visibilityState === "visible") pollTeam(); }, 30000);
  notifTimer = setInterval(checkNotifs, 15000);
  showTab(curTab);
  setTimeout(() => { if (!lsGet(MOVE_SKIP, false)) refreshMove(); }, 1500);   // 前のカウンターの記録がこのブラウザに残っていれば、引っ越しの案内を出す
}
function subscribeToday() {
  listenDay = dk(today());
  const f = onSnapshot(query(collection(db, "records"), where("uid", "==", U), where("day", "==", listenDay)), s => {
    myToday = s.docs.map(recOf).sort((a, b) => a.t - b.t);
    renderCount(); if (curTab === "log") renderLog();
  }, onErr("今日の記録"));
  unsubs.push(f); todayUnsub = f;
}
let todayUnsub = null, teamTimer = null, notifTimer = null;

/* 日付が変わったら今日の購読を張り直す */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !started) return;
  if (listenDay !== dk(today())) { if (todayUnsub) todayUnsub(); unsubs = unsubs.filter(f => f !== todayUnsub); subscribeToday(); }
  pollTeam(); maybeDaySum(); checkNotifs(true);
});
window.addEventListener("online", () => $("offline").hidden = true);
window.addEventListener("offline", () => $("offline").hidden = false);
$("offline").hidden = navigator.onLine;

/* ============================================================
   カウント
   ============================================================ */
function renderMe() {
  if (!me) return;
  $("meAv").textContent = (me.name || "?")[0]; $("meAv").style.background = colorOf(U);
  $("meName").textContent = me.name + (me.role === "admin" ? "（管理者）" : "");
  const act = Object.values(members).filter(m => m.status === "active").length;
  $("teamName").textContent = "チーム " + (act || 1) + "人";
  $("todayLbl").textContent = md(today());
  $("myMail").textContent = auth.currentUser ? auth.currentUser.email : "";
  if (document.activeElement !== $("myName")) $("myName").value = me.name || "";
  $("myCloser").checked = !!me.closer;
  renderGcal();
  $("adminBox").hidden = me.role !== "admin";
}
const grid = $("grid");
function buildGrid() {
  grid.innerHTML = "";
  ITEMS.forEach((it, i) => {
    const b = document.createElement("button");
    b.className = "rb" + (i === ITEMS.length - 1 && ITEMS.length % 2 ? " wide" : "");
    b.style.background = it.bg; b.style.color = it.fg; b.dataset.k = it.k;
    b.innerHTML = (KEYS[i] ? `<span class="key">${KEYS[i].toUpperCase()}</span>` : "") +
      `<span style="${it.strike ? "text-decoration:line-through" : ""}">${esc(it.k)}</span><span class="n">0</span>` +
      (it.k === "アポ" || it.k === "再架電" ? `<span class="memo-mark">＋詳細</span>` : "");
    b.onclick = () => addResult(it.k, b);
    grid.appendChild(b);
  });
}
/* 日ごとの集計に足す（n=1）／引く（n=-1）。mb は10分枠 "HHM0"（稼働時間を出すため。古い記録には無い） */
function statInc(uid, k, hour, n, mb) {
  const o = {c: {[uid]: {[k]: increment(n)}}, h: {[uid]: {[String(hour)]: increment(n)}}};
  if (mb) o.m = {[uid]: {[mb]: increment(n)}};
  return o;
}
const mbOf = t => pad(t.getHours()) + Math.floor(t.getMinutes() / 10) + "0";

function addResult(k, btn) {
  const t = new Date(), day = dk(t), hour = t.getHours();
  const ref = doc(collection(db, "records"));
  const mb = mbOf(t);
  const data = {uid: U, r: k, t: Timestamp.fromDate(t), day, hour, mb, memo: null, undated: k === "アポ", pending: false, done: false, slotId: null};
  const b = writeBatch(db);
  b.set(ref, data);
  b.set(doc(db, "stats", day), statInc(U, k, hour, 1, mb), {merge: true});
  b.commit().catch(e => toast(errMsg(e)));
  if (btn) { btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop"); }
  if (navigator.vibrate) navigator.vibrate(15);
  const rec = {...data, id: ref.id, t};
  if (k === "アポ" || k === "再架電") openMemo(rec);
  else toast(k + " +1", "メモを付ける", () => openMemo(myToday.find(r => r.id === rec.id) || rec));
}
function deleteRec(rec) {
  const b = writeBatch(db);
  b.delete(doc(db, "records", rec.id));
  b.set(doc(db, "stats", rec.day), statInc(rec.uid, rec.r, rec.hour, -1, rec.mb), {merge: true});
  if (rec.slotId) b.delete(doc(db, "slots", rec.slotId));
  return b.commit();
}
$("undo").onclick = () => {
  const last = myToday[myToday.length - 1]; if (!last) return;
  deleteRec(last).catch(e => toast(errMsg(e)));
  toast("「" + last.r + "」を1件戻しました");
};
$("memoLast").onclick = () => { const last = myToday[myToday.length - 1]; if (last) openMemo(last); };

function count(list) { const c = Object.fromEntries(ITEMS.map(i => [i.k, 0])); list.forEach(r => c[r.r] = (c[r.r] || 0) + 1); return c; }
function renderCount() {
  if (!started) return;
  const c = count(myToday), n = myToday.length, apo = c["アポ"] || 0;
  $("cTotal").textContent = n;
  $("cSide").innerHTML = `アポ <b>${apo}</b>　再架電 <b>${c["再架電"] || 0}</b><br>アポ率 <b>${n ? (apo / n * 100).toFixed(1) : "0.0"}%</b>`;
  grid.querySelectorAll(".rb").forEach(b => b.querySelector(".n").textContent = c[b.dataset.k] || 0);
  fillRecs($("recent"), myToday.slice(-15).reverse());
  renderNext(); renderUndated();
}
async function pollTeam() {
  try {
    const s = await getDoc(doc(db, "stats", dk(today())));
    let n = 0, apo = 0;
    if (s.exists()) Object.values(s.data().c || {}).forEach(m => Object.entries(m).forEach(([k, v]) => { n += v; if (k === "アポ") apo += v; }));
    $("tTotal").textContent = n; $("tApo").textContent = apo;
  } catch (_) {}
}

/* キーボード：1〜0・Q…で +1、Backspace / Ctrl+Z でひとつ戻す */
document.addEventListener("keydown", e => {
  if (!started || curTab !== "count" || !$("msheet").hidden || !$("itemSheet").hidden || !$("moveDlg").hidden || e.isComposing || e.altKey || e.metaKey) return;
  if (e.target.closest && e.target.closest("input, textarea, select")) return;
  if ((e.ctrlKey && e.key.toLowerCase() === "z") || (!e.ctrlKey && e.key === "Backspace")) { e.preventDefault(); $("undo").click(); return; }
  if (e.ctrlKey || e.repeat) return;
  const i = KEYS.indexOf(e.key.toLowerCase());
  if (i < 0 || !ITEMS[i]) return;
  e.preventDefault(); addResult(ITEMS[i].k, grid.children[i]);
});

/* ============================================================
   記録の一覧（カウント画面の直近15件・記録タブ）
   ============================================================ */
let logF = "all";
$("logFilter").onclick = e => { const b = e.target.closest("button"); if (!b) return; logF = b.dataset.f; $("logFilter").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderLog(); };
function renderLog() {
  let list = myToday.slice().reverse();
  if (logF === "memo") list = list.filter(r => r.memo);
  if (logF === "apo") list = list.filter(r => r.r === "アポ" || r.r === "再架電");
  fillRecs($("logList"), list, true);
  if (logMode === "hist") renderHist();
}

/* ---------- 再架電・アポの履歴（自分の分を、取った日ごとに） ----------
   今日の分は「今日の記録」の購読から、昨日以前は開いたときに2週間ずつ読む（読み込み量を抑えるため） */
let logMode = "today", histF = "all", histFrom = null, histPast = [], histLoadedAt = 0, histLoading = false;
$("logMode").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  logMode = b.dataset.m;
  $("logMode").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b));
  $("logToday").hidden = logMode !== "today"; $("logHist").hidden = logMode !== "hist";
  if (logMode === "hist") loadHist(false);
};
$("histFilter").onclick = e => { const b = e.target.closest("button"); if (!b) return; histF = b.dataset.f; $("histFilter").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderHist(); };
$("histMore").onclick = () => loadHist(true);
async function loadHist(more) {
  const T = today();
  if (!more && histFrom && Date.now() - histLoadedAt < 5 * 6e4) { renderHist(); return; }   // 5分以内なら読み直さない
  if (histLoading) return;
  histLoading = true; $("histMore").disabled = true;
  const to = more && histFrom ? histFrom : T;                    // この日より前を読む
  const from = addDays(to, -14);
  if (!more) histPast = [];
  try {
    if (!more || !histFrom) renderHist(true);
    const s = await getDocs(query(collection(db, "records"), where("uid", "==", U), where("r", "in", ["アポ", "再架電"]),
      where("day", ">=", dk(from)), where("day", "<", dk(to)), orderBy("day", "desc")));
    const got = s.docs.map(recOf);
    histPast = histPast.filter(r => !got.some(g => g.id === r.id)).concat(got);
    histFrom = from; histLoadedAt = Date.now();
  } catch (e) {
    console.error(e);
    toast(e.code === "failed-precondition" ? "履歴の準備中です。数分後にもう一度開いてください" : "履歴を読み込めませんでした");
  }
  histLoading = false; $("histMore").disabled = false;
  renderHist();
}
function renderHist(loading) {
  const todayList = myToday.filter(r => r.r === "アポ" || r.r === "再架電");
  let all = todayList.concat(histPast.filter(r => !todayList.some(t => t.id === r.id)));
  if (histF !== "all") all = all.filter(r => r.r === histF);
  const byDay = {};
  all.forEach(r => (byDay[r.day] = byDay[r.day] || []).push(r));
  const days = Object.keys(byDay).sort().reverse();
  const apoN = all.filter(r => r.r === "アポ").length, cbN = all.filter(r => r.r === "再架電").length;
  $("histSum").innerHTML = histFrom ? `${md(histFrom)} 〜 今日　<b>アポ ${apoN}件</b>・<b>再架電 ${cbN}件</b>` : "";
  const body = $("histBody");
  if (loading && !all.length) { body.innerHTML = `<div class="card"><div class="empty">読み込み中…</div></div>`; return; }
  if (!days.length) { body.innerHTML = `<div class="card"><div class="empty">この期間の${histF === "all" ? "再架電・アポ" : histF}はありません</div></div>`; return; }
  const now = new Date();
  body.innerHTML = "";
  days.forEach(k => {
    const list = byDay[k].sort((a, b) => b.t - a.t);
    const a = list.filter(r => r.r === "アポ").length, c = list.filter(r => r.r === "再架電").length;
    const d = new Date(k + "T00:00");
    const h = document.createElement("h2");
    h.innerHTML = `${md(d)}${k === dk(today()) ? "（今日）" : ""} <span class="aside">${a ? "アポ" + a : ""}${a && c ? "・" : ""}${c ? "再架電" + c : ""}</span>`;
    body.appendChild(h);
    const card = document.createElement("div"); card.className = "card";
    list.forEach(r => {
      const m = r.memo || {}, w = m.when;
      let st = "";
      if (r.src === "old" && !w) st = OLD_BADGE;
      else if (r.r === "アポ") st = !w ? `<span class="badge late">日時未定</span>` : w < now ? `<span class="badge done">面談済み</span>` : "";
      else st = r.done ? `<span class="badge done">かけた</span>` : w && w < now ? `<span class="badge late">期限切れ</span>` : !w ? `<span class="badge pend">日時なし</span>` : "";
      const row = document.createElement("div"); row.className = "rec hrow tap"; row.tabIndex = 0;
      row.innerHTML = `<span class="tm">${hm(r.t)}</span><span class="body">${resChip(r.r)}${w ? `<span class="when">${r.r === "アポ" ? "面談" : "再架電"} ${md(w)} ${hm(w)}</span>` : ""}${st}
        <div class="memo"><b>${esc(m.shop || "（店名なし）")}</b>${m.tel ? `　<span class="tel-line num">☎ ${esc(m.tel)}</span>` : ""}</div>
        ${m.text ? `<div class="memo">${esc(m.text)}</div>` : ""}</span>`;
      row.onclick = () => openDetail(r);
      row.onkeydown = e => { if (e.key === "Enter") openDetail(r); };
      card.appendChild(row);
    });
    body.appendChild(card);
  });
}
function memoLine(m) {
  if (!m) return "";
  return [m.shop ? `<b>${esc(m.shop)}</b>` : "", m.text ? esc(m.text) : ""].filter(Boolean).join("　");
}
function fillRecs(box, list, withDelete) {
  if (!list.length) { box.innerHTML = `<div class="empty">まだ記録はありません</div>`; return; }
  box.innerHTML = "";
  list.forEach(r => {
    const row = document.createElement("div"); row.className = "rec"; row.setAttribute("role", "button"); row.tabIndex = 0;
    const w = r.memo && r.memo.when;
    const when = w ? `<span class="when">${r.r === "アポ" ? "面談" : "再架電"} ${md(w)} ${hm(w)}</span>` : r.src === "old" ? OLD_BADGE : (r.r === "アポ" ? `<span class="badge late">日時未定</span>` : "");
    row.innerHTML = `<span class="tm">${hm(r.t)}</span><span class="body">${resChip(r.r)}${when}` +
      (r.memo && (r.memo.shop || r.memo.text) ? `<div class="memo">${memoLine(r.memo)}</div>` : `<div class="add">＋ メモを付ける</div>`) + `</span>`;
    const hasInfo = r.memo && (r.memo.shop || r.memo.tel || r.memo.text || r.memo.when);
    row.onclick = () => hasInfo ? openDetail(r) : openMemo(r);
    row.onkeydown = e => { if (e.key === "Enter") row.onclick(); };
    if (withDelete) {
      const del = document.createElement("button"); del.className = "ib rm"; del.textContent = "×"; del.setAttribute("aria-label", "この記録を消す");
      del.style.marginLeft = "auto"; del.style.height = "32px";
      del.onclick = e => { e.stopPropagation(); confirmDelete(r, del); };
      row.appendChild(del);
    }
    box.appendChild(row);
  });
}
/* confirm() を使わず、2回押しで消す */
function confirmDelete(r, btn) {
  if (btn.dataset.arm) { deleteRec(r).then(() => toast("消しました")).catch(e => toast(errMsg(e))); return; }
  btn.dataset.arm = "1"; btn.textContent = "消す"; btn.style.width = "auto"; btn.style.padding = "0 8px";
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.arm; btn.textContent = "×"; btn.style.width = ""; btn.style.padding = ""; } }, 2500);
}

/* ============================================================
   メモのシート（アポの日時・クローザー・再架電の日時）
   ============================================================ */
let editing = null, selCloser = "auto", tick = 0;
function dayWord(d) { const diff = Math.round((dayStart(d) - today()) / 864e5); return diff === 0 ? "今日" : diff === 1 ? "明日" : diff === 2 ? "明後日" : md(d); }
function setQuick(kind) {
  const q = $("mQuick"); q.innerHTML = "";
  let opts;
  if (kind === "再架電") {
    $("mQuickLbl").textContent = "";
    const at = (off, h) => { const d = addDays(today(), off); d.setHours(h, 0, 0, 0); return d; };
    opts = [["1時間後", new Date(Date.now() + 36e5)], ["今日17時", at(0, 17)], ["明日10時", at(1, 10)], ["明日15時", at(1, 15)]];
  } else {
    $("mQuickLbl").textContent = "空いている枠（近い順）";
    opts = freeSlots(new Date(Date.now() + 36e5), 6).map(d => [dayWord(d) + " " + hm(d), d]);
  }
  opts.forEach(([l, d]) => { const b = document.createElement("button"); b.type = "button"; b.textContent = l; b.onclick = () => { $("mWhen").value = toLocal(d); checkClash(); }; q.appendChild(b); });
}
function openMemo(rec) {
  editing = rec; const m = rec.memo || {};
  const kind = rec.r, timed = kind === "アポ" || kind === "再架電", mine = rec.uid === U;
  $("mTitle").innerHTML = resChip(kind) + (kind === "アポ" ? " アポの詳細" : kind === "再架電" ? " 再架電の予定" : " メモ");
  $("mHint").textContent = !mine ? nameOf(rec.uid) + "さんの記録です（見るだけ）" :
    rec.draft ? "カレンダーから登録します。保存するとアポが1件増えます" : hm(rec.t) + " の記録" + (timed ? "。日時を入れるとリマインドに出ます" : "");
  $("mShop").value = m.shop || ""; $("mTel").value = m.tel || ""; $("mText").value = m.text || "";
  $("mInfo").value = m.info || ""; $("mInfoBox").hidden = kind !== "アポ";
  $("mWhenBox").hidden = !timed; $("mRemindBox").hidden = !timed;
  $("mPick").hidden = kind !== "アポ" || !mine;
  $("mCloserBox").hidden = kind !== "アポ";
  if (timed) {
    selCloser = m.closer || "auto";
    $("mWhenLbl").textContent = kind === "アポ" ? "商談日時（1時間半）" : "かけ直す日時";
    $("mWhen").value = m.when ? toLocal(m.when) : ""; $("mRemind").checked = m.remind !== false; setQuick(kind);
  }
  ["mShop", "mTel", "mText", "mWhen", "mInfo"].forEach(id => $(id).readOnly = !mine);
  $("mPaste").hidden = !mine;
  $("mSave").hidden = !mine; $("mSkip").textContent = mine ? "あとで" : "閉じる";
  checkClash();
  $("scrim").hidden = $("msheet").hidden = false;
  if (mine) setTimeout(() => $(timed ? "mShop" : "mText").focus(), 50);
}
/* ---------- リストからの貼り付け：「店名[タブ/改行]（住所）[タブ/改行]電話番号」を店名と電話に分ける ---------- */
const toHalf = s => String(s || "").normalize("NFKC").replace(/[ー‐―−–—]/g, "-");
function asPhone(s) {
  const n = toHalf(s).trim();
  if (!/^[+\d][\d\-()\s]*$/.test(n)) return "";
  const digits = n.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 13 ? n.replace(/\s/g, "") : "";
}
function parseListPaste(text) {
  const raw = String(text || "").replace(/\r/g, "");
  let parts = raw.split(/[\t\n]+/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 1 && asPhone(parts[0])) return {shop: "", tel: asPhone(parts[0])};
  if (parts.length < 2) {
    /* 1行で「店名 06-…」のように空白で並んでいるとき */
    const m = toHalf(raw).trim().match(/^(.*?)[\s]+([+\d][\d\-()]{8,}\d)$/);
    if (!m) return null;
    parts = [raw.trim().slice(0, raw.trim().length - m[2].length).trim(), m[2]];
  }
  const telPart = parts.find(p => asPhone(p));
  if (!telPart) return null;
  const shop = parts.find(p => p !== telPart && !asPhone(p)) || "";
  return {shop, tel: asPhone(telPart)};
}
function fillFromList(text, shopId = "mShop", telId = "mTel") {
  const p = parseListPaste(text);
  if (!p) return false;
  if (p.shop) $(shopId).value = p.shop;
  $(telId).value = p.tel;
  toast(p.shop ? "店名と電話番号を分けて入れました" : "電話番号を入れました");
  return true;
}
["mShop", "mTel"].forEach(id => {
  $(id).addEventListener("paste", e => {
    if ($(id).readOnly) return;
    const t = (e.clipboardData || window.clipboardData).getData("text");
    if (fillFromList(t)) e.preventDefault();
  });
});
/* 貼り付けで1行にまとまって入ったときも分ける（スマホの貼り付けなど） */
$("mShop").addEventListener("input", () => { const v = $("mShop").value; if (/\d{2,}.*\d{3,}\s*$/.test(toHalf(v)) && parseListPaste(v)) fillFromList(v); });
$("mPaste").onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (!fillFromList(t)) toast("店名と電話番号が見つかりませんでした。リストで店名と電話番号のセルをコピーしてから押してください");
  } catch (_) {
    $("mShop").focus();
    toast("ここで読めなかったので、店名の欄を長押しして貼り付けてください（自動で分けます）");
  }
};

function refreshHistSoon() { histLoadedAt = 0; if (curTab === "log" && logMode === "hist") setTimeout(() => loadHist(false), 800); }
/* ---------- 予定（前確など）を書く画面 ---------- */
let editingTask = null, tKind = "前確", tApoWhen = null;
function drawTaskKinds() {
  $("tKinds").innerHTML = TASK_KINDS.map(k => `<button type="button" class="cl-chip" data-k="${esc(k.k)}" aria-pressed="${tKind === k.k}"><i style="background:${k.bg};outline:1px solid ${k.fg}"></i>${k.k}</button>`).join("");
}
$("tKinds").onclick = e => { const b = e.target.closest("button"); if (!b) return; tKind = b.dataset.k; drawTaskKinds(); setTaskQuick(); };
function setTaskQuick() {
  const q = $("tQuick"); q.innerHTML = "";
  const at = (base, off, h, mi) => { const d = addDays(dayStart(base), off); d.setHours(h, mi || 0, 0, 0); return d; };
  let opts;
  if (tApoWhen && tKind === "前確") {
    $("tQuickLbl").textContent = "面談（" + md(tApoWhen) + " " + hm(tApoWhen) + "）に合わせて";
    const w = tApoWhen;
    opts = [["面談の前日 同じ時間", at(w, -1, w.getHours(), w.getMinutes())], ["面談の日 朝10時", at(w, 0, 10)], ["面談の1時間前", new Date(w.getTime() - 36e5)], ["面談の30分前", new Date(w.getTime() - 18e5)]]
      .filter(([, d]) => d > new Date());
  } else {
    $("tQuickLbl").textContent = "";
    opts = [["1時間後", new Date(Date.now() + 36e5)], ["今日17時", at(new Date(), 0, 17)], ["明日10時", at(new Date(), 1, 10)], ["明日15時", at(new Date(), 1, 15)]];
  }
  opts.forEach(([l, d]) => { const b = document.createElement("button"); b.type = "button"; b.textContent = l; b.onclick = () => $("tWhen").value = toLocal(d); q.appendChild(b); });
}
/* t: 直す予定（無ければ新しく作る）。pre: 新しく作るときの初期値 {kind, shop, tel, apoWhen} */
function openTask(t, pre) {
  editingTask = t || null; pre = pre || {};
  tKind = t ? t.r : (pre.kind || "前確");
  tApoWhen = pre.apoWhen || null;
  $("tTitleH").textContent = t ? "予定を直す" : "予定を追加";
  $("tTitle").value = t ? t.title : (pre.kind === "前確" && pre.shop ? "前確の電話" : "");
  $("tWhen").value = t && t.memo.when ? toLocal(t.memo.when) : "";
  $("tShop").value = t ? t.memo.shop : (pre.shop || "");
  $("tTel").value = t ? t.memo.tel : (pre.tel || "");
  $("tText").value = t ? t.memo.text : "";
  $("tRemind").checked = t ? t.memo.remind !== false : true;
  const act = Object.entries(members).filter(([, m]) => m.status === "active").sort((a, b) => (a[0] === U ? -1 : b[0] === U ? 1 : (a[1].name || "").localeCompare(b[1].name || "", "ja")));
  $("tWho").innerHTML = act.map(([id, m]) => `<option value="${esc(id)}">${esc(m.name)}${id === U ? "（自分）" : ""}</option>`).join("");
  $("tWho").value = t ? t.uid : U;
  $("tDelete").hidden = !t; delete $("tDelete").dataset.arm; $("tDelete").textContent = "削除";
  drawTaskKinds(); setTaskQuick();
  $("tScrim").hidden = $("taskSheet").hidden = false;
  setTimeout(() => $(t ? "tTitle" : "tWhen").focus(), 50);
}
function closeTask() { $("tScrim").hidden = $("taskSheet").hidden = true; editingTask = null; }
$("tCancel").onclick = closeTask; $("tScrim").onclick = closeTask;
document.addEventListener("click", e => { if (e.target.closest("[data-newtask]")) openTask(null); });
["tShop", "tTel"].forEach(id => $(id).addEventListener("paste", e => {
  const t = (e.clipboardData || window.clipboardData).getData("text");
  if (fillFromList(t, "tShop", "tTel")) e.preventDefault();
}));
$("tPaste").onclick = async () => {
  try { const t = await navigator.clipboard.readText(); if (!fillFromList(t, "tShop", "tTel")) toast("店名と電話番号が見つかりませんでした"); }
  catch (_) { $("tShop").focus(); toast("店名の欄を長押しして貼り付けてください（自動で分けます）"); }
};
$("tSave").onclick = async () => {
  const w = $("tWhen").value ? new Date($("tWhen").value) : null;
  if (!w || isNaN(w)) { toast("日時を入れてください"); $("tWhen").focus(); return; }
  const data = {uid: $("tWho").value || U, kind: tKind, title: $("tTitle").value.trim(), shop: $("tShop").value.trim(), tel: $("tTel").value.trim(),
    text: $("tText").value.trim(), when: Timestamp.fromDate(w), remind: $("tRemind").checked};
  const t = editingTask;
  $("tSave").disabled = true;
  try {
    if (t) await updateDoc(doc(db, "tasks", t.id), data);
    else await setDoc(doc(collection(db, "tasks")), {...data, by: U, done: false, createdAt: serverTimestamp()});
    closeTask();
    toast((t ? "予定を直しました：" : "予定を入れました：") + md(w) + " " + hm(w) + (data.uid !== U ? "（担当 " + nameOf(data.uid) + "）" : ""));
  } catch (e) { toast(errMsg(e)); }
  finally { $("tSave").disabled = false; }
};
$("tDelete").onclick = () => {
  const t = editingTask; if (!t) return;
  const b = $("tDelete");
  if (!b.dataset.arm) { b.dataset.arm = "1"; b.textContent = "本当に削除"; setTimeout(() => { if (b.isConnected) { delete b.dataset.arm; b.textContent = "削除"; } }, 2500); return; }
  deleteDoc(doc(db, "tasks", t.id)).then(() => { closeTask(); toast("予定を削除しました"); }).catch(e => toast(errMsg(e)));
};
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("taskSheet").hidden) closeTask(); });

function closeMemo() { refreshHistSoon(); $("scrim").hidden = $("msheet").hidden = true; editing = null; }
$("mSkip").onclick = () => {
  const r = editing; closeMemo();
  if (r && r.uid === U && !r.draft && r.src !== "old" && r.r === "アポ" && !(r.memo && r.memo.when)) toast("日時未定のアポとして残しました");
};
$("scrim").onclick = closeMemo;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("msheet").hidden) closeMemo(); });
$("mWhen").addEventListener("input", checkClash);

/* クローザーの選択（"auto"＝空いている人におまかせ） */
function renderClosers() {
  const box = $("mClosers"); box.innerHTML = "";
  const d = $("mWhen").value ? new Date($("mWhen").value) : null;
  const list = closerList();
  [{id: "auto", name: "おまかせ"}, ...list].forEach(c => {
    const b = document.createElement("button"); b.type = "button"; b.className = "cl-chip";
    b.setAttribute("aria-pressed", selCloser === c.id);
    let state = "";
    if (d && isSlotTime(d)) state = c.id === "auto" ? (freeClosers(d, editing).length ? "" : "×") : (closerBusy(d, c.id, editing) ? "×" : "空き");
    if (c.id !== "auto") b.innerHTML = `<i style="background:${c.color}"></i>`;
    b.insertAdjacentHTML("beforeend", esc(c.name) + (state ? `<small class="${state === "×" ? "ng" : "okk"}">${state}</small>` : ""));
    b.disabled = editing && editing.uid !== U;
    b.onclick = () => { selCloser = c.id; renderClosers(); setQuick("アポ"); checkClash(); };
    box.appendChild(b);
  });
}
function checkClash() {
  const box = $("mClash");
  if (editing && editing.r === "アポ") renderClosers();
  if (!editing || editing.r !== "アポ" || !$("mWhen").value) { box.hidden = true; return; }
  const d = new Date($("mWhen").value);
  box.hidden = false;
  if (!isSlotTime(d)) { box.className = "clash"; box.textContent = "アポの枠の外です（10:00〜19:00・30分ごと・日曜休み）"; return; }
  const free = freeClosers(d, editing);
  const span = md(d) + " " + hm(d) + "〜" + hm(new Date(d.getTime() + APO_MIN * 6e4));
  const others = free.length ? "。この時間から入れられるのは " + free.map(c => c.name).join("・") : "";
  if (selCloser === "auto") {
    if (!free.length) { box.className = "clash"; box.textContent = "この時間からの1時間半は、クローザー全員が埋まっています"; return; }
    box.className = "clash ok"; box.textContent = span + " 空いているクローザー：" + free.map(c => c.name).join("・"); return;
  }
  const hit = apoOverlap(d, selCloser, editing);
  if (hit) { box.className = "clash"; box.textContent = CNAME(selCloser) + "さんは " + hm(hit.when) + "〜" + hm(apoEnd(hit)) + " に商談があります（" + nameOf(hit.uid) + "さんのアポ：" + (hit.shop || "店名なし") + "）。1時間半とれません" + others; return; }
  const gb = gBusyRange(d, selCloser);
  if (gb) { box.className = "clash"; box.textContent = CNAME(selCloser) + "さんは " + hm(gb.s) + "〜" + hm(gb.e) + " にほかの予定があります。1時間半とれません" + others; return; }
  box.className = "clash ok"; box.textContent = span + " " + CNAME(selCloser) + "さん 空いています";
}

$("mSave").onclick = async () => {
  const rec = editing; if (!rec || rec.uid !== U) return;
  const w = $("mWhen").value ? new Date($("mWhen").value) : null;
  const m = {shop: $("mShop").value.trim(), tel: $("mTel").value.trim(), text: $("mText").value.trim()};
  if (rec.r === "アポ") m.info = $("mInfo").value.trim();   // クローザーのカレンダーの説明に入る
  const remind = $("mRemind").checked;
  $("mSave").disabled = true;
  try {
    if (rec.r === "アポ" && w) {
      if (!isSlotTime(w)) { toast("アポの枠の外です（10:00〜19:00・30分ごと・日曜休み）"); return; }
      const cl = await bookSlot(rec, m, w, remind);
      /* サーバーからの通知を待たずに、自分のカレンダーへすぐ出す */
      const sid = slotIdOf(w, cl);
      slots = slots.filter(s => s.recId !== rec.id && s.id !== sid).concat([{id: sid, day: dk(w), time: hm(w), when: w, dur: APO_MIN, closer: cl, uid: U, recId: rec.id, shop: m.shop, tel: m.tel, text: m.text, info: m.info || ""}]);
      if (curTab === "cal") renderCal();
      closeMemo();
      toast((rec.draft ? "アポを登録しました（アポ+1）" : "保存しました。" + md(w) + " " + hm(w)) + "（クローザー " + CNAME(cl) + "）");
    } else if (rec.r === "アポ") {
      const b = writeBatch(db);
      b.update(doc(db, "records", rec.id), {memo: m, undated: rec.src !== "old", pending: false, slotId: null});   // 前のカウンターから来たアポは「日時未定」に出さない
      if (rec.slotId) b.delete(doc(db, "slots", rec.slotId));
      b.commit().catch(e => toast(errMsg(e)));
      closeMemo(); toast(rec.src === "old" ? "メモを保存しました" : "日時未定のアポとして保存しました");
    } else if (rec.r === "再架電") {
      updateDoc(doc(db, "records", rec.id), {memo: {...m, when: w ? Timestamp.fromDate(w) : null, remind}, pending: !!w && !rec.done}).catch(e => toast(errMsg(e)));
      closeMemo(); toast(w ? "保存しました。" + md(w) + " " + hm(w) + " にリマインドします" : "メモを保存しました");
    } else {
      updateDoc(doc(db, "records", rec.id), {memo: (m.shop || m.tel || m.text) ? m : null}).catch(e => toast(errMsg(e)));
      closeMemo(); toast("メモを保存しました");
    }
  } catch (e) { toast(errMsg(e)); }
  finally { $("mSave").disabled = false; }
};

/* アポの枠を取る。枠の文書は「日_開始時刻_クローザー」。
   商談は1時間半なので、同じクローザーの「1時間前・30分前・同時刻・30分後・1時間後」に始まる枠が
   ひとつも無いことをトランザクションの中で確かめる（同時に保存しても、重なる片方は必ず失敗する） */
const OVERLAP_STEPS = [-60, -30, 0, 30, 60];   // 30分刻みで、1時間半の商談と重なる開始時刻
async function bookSlot(rec, m, when, remind) {
  const cands = selCloser === "auto" ? freeClosers(when, rec).map(c => c.id).concat(closerList().map(c => c.id)) : [selCloser];
  const recRef = doc(db, "records", rec.id);
  let chosenId = null;
  await runTransaction(db, async tx => {
    let chosen = null;
    for (const c of [...new Set(cands)]) {
      let clash = false;
      for (const off of OVERLAP_STEPS) {
        const s = await tx.get(doc(db, "slots", slotIdOf(new Date(when.getTime() + off * 6e4), c)));
        if (s.exists() && s.data().recId !== rec.id) { clash = true; break; }
      }
      if (!clash) { chosen = {c, sref: doc(db, "slots", slotIdOf(when, c))}; break; }
    }
    if (!chosen) throw new Error("FULL");
    const memo = {...m, when: Timestamp.fromDate(when), remind, closer: chosen.c};
    const sdata = {day: dk(when), time: hm(when), when: Timestamp.fromDate(when), dur: APO_MIN, closer: chosen.c, uid: U, recId: rec.id,
      shop: m.shop, tel: m.tel, text: m.text, info: m.info || ""};
    if (rec.slotId && rec.slotId !== chosen.sref.id) tx.delete(doc(db, "slots", rec.slotId));
    tx.set(chosen.sref, sdata);
    if (rec.draft) {
      const t = new Date();
      tx.set(recRef, {uid: U, r: "アポ", t: Timestamp.fromDate(t), day: dk(t), hour: t.getHours(), mb: mbOf(t), memo, undated: false, pending: true, done: false, slotId: chosen.sref.id});
      tx.set(doc(db, "stats", dk(t)), statInc(U, "アポ", t.getHours(), 1, mbOf(t)), {merge: true});
    } else {
      tx.update(recRef, {memo, undated: false, pending: true, slotId: chosen.sref.id});
    }
    chosenId = chosen.c;
  });
  return chosenId;
}

/* ============================================================
   アポカレンダー
   ============================================================ */
const isSlotTime = d => d.getDay() !== 0 && d.getMinutes() % 30 === 0 && d.getHours() >= SLOT_H0 && d.getHours() < SLOT_H1;
const slotIdOf = (d, c) => dk(d) + "_" + pad(d.getHours()) + pad(d.getMinutes()) + "_" + c;
let extraSlots = [];      // 過去の週を見るときに一度だけ読んだ分
const allSlots = () => slots.concat(extraSlots.filter(x => !slots.some(s => s.id === x.id)));
function slotsAt(d, except) { const k = dk(d) + " " + hm(d); return allSlots().filter(s => s.day + " " + s.time === k && !(except && s.recId === except.id)); }
/* Googleカレンダーの「予定あり」（時間だけ）。busy/{uid}.blocks = [{s, e}] */
let busyMap = {};
const gBusyAt = (d, cid) => { const b = busyMap[cid]; if (!b) return null; const e = new Date(d.getTime() + 18e5); return (b.blocks || []).find(x => x.s < e && x.e > d) || null; };
/* 商談は1時間半。13:00の商談があると、そのクローザーは13:00〜14:30が埋まる */
const APO_MIN = 90;
const apoEnd = s => new Date(s.when.getTime() + (s.dur || APO_MIN) * 6e4);
const notMe = (s, except) => !(except && s.recId === except.id);
/* その30分の枠に、クローザー cid の商談がかかっているか（始まりの枠以外も） */
const apoCovering = (d, cid, except) => allSlots().find(s => s.closer === cid && s.when && notMe(s, except) && s.when <= d && d < apoEnd(s)) || null;
/* d から1時間半の商談を入れたら重なる商談 */
const apoOverlap = (d, cid, except) => { const e = new Date(d.getTime() + APO_MIN * 6e4); return allSlots().find(s => s.closer === cid && s.when && notMe(s, except) && s.when < e && apoEnd(s) > d) || null; };
/* d から1時間半のあいだに、Googleカレンダーの予定があるか */
const gBusyRange = (d, cid) => { const b = busyMap[cid]; if (!b) return null; const e = new Date(d.getTime() + APO_MIN * 6e4); return (b.blocks || []).find(x => x.s < e && x.e > d) || null; };
/* d から始める商談を、そのクローザーに入れられないか */
const closerBusy = (d, cid, except) => !!apoOverlap(d, cid, except) || !!gBusyRange(d, cid);
const freeClosers = (d, except) => closerList().filter(c => !closerBusy(d, c.id, except));
const slotOpen = (d, except, cid) => (!cid || cid === "auto" || cid === "all") ? freeClosers(d, except).length > 0 : !closerBusy(d, cid, except);
function freeSlots(from, n) {
  const out = []; let d = new Date(from); d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() === 0 ? 0 : d.getMinutes() <= 30 ? 30 : 60, 0, 0);
  for (let g = 0; out.length < n && g < 2000; g++, d = new Date(d.getTime() + 18e5)) if (isSlotTime(d) && slotOpen(d, editing, selCloser)) out.push(new Date(d));
  return out;
}
const monday = d => addDays(dayStart(d), -((d.getDay() + 6) % 7));
let wkStart = monday(new Date()), pickMode = false, pickReturn = "count", calCloser = "all";
/* 表示：週（月〜土）か日（クローザーごとの列）。スマホは日、PCは週から始める。選んだ方を覚える */
let calView = lsGet("team-calview", innerWidth < 640 ? "day" : "week");
let calDay = today(); if (calDay.getDay() === 0) calDay = addDays(calDay, 1);
const skipSun = (d, step) => { let x = addDays(d, step); if (x.getDay() === 0) x = addDays(x, step); return x; };
$("wkPrev").onclick = () => {
  if (calView === "day") { calDay = skipSun(calDay, -1); wkStart = monday(calDay); } else wkStart = addDays(wkStart, -7);
  loadPastWeek(); renderCal();
};
$("wkNext").onclick = () => {
  if (calView === "day") { calDay = skipSun(calDay, 1); wkStart = monday(calDay); } else wkStart = addDays(wkStart, 7);
  renderCal();
};
$("calFilter").onclick = e => { const b = e.target.closest("button"); if (!b) return; calCloser = b.dataset.c; renderCal(); };
$("calView").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  calView = b.dataset.v; lsSet("team-calview", calView);
  if (calView === "day") { calDay = wkStart <= today() && today() < addDays(wkStart, 7) ? today() : new Date(wkStart); if (calDay.getDay() === 0) calDay = addDays(calDay, 1); }
  else wkStart = monday(calDay);
  renderCal();
};
$("calToday").onclick = () => { calDay = today(); if (calDay.getDay() === 0) calDay = addDays(calDay, 1); wkStart = monday(calDay); renderCal(); };
async function loadPastWeek() {
  if (wkStart >= addDays(today(), -7)) return;
  try {
    const s = await getDocs(query(collection(db, "slots"), where("day", ">=", dk(wkStart)), where("day", "<=", dk(addDays(wkStart, 6)))));
    extraSlots = s.docs.map(d => ({id: d.id, ...d.data(), when: tsd(d.data().when)}));
    renderCal();
  } catch (_) {}
}
/* 今の時刻の赤い線（今日の、今の30分の枠にだけ入れる） */
function nowLine(d, now) {
  if (now < d || now >= new Date(d.getTime() + 18e5)) return "";
  return `<i class="nowline" style="top:${((now - d) / 18e5 * 100).toFixed(1)}%"></i>`;
}
function timeCell(h, mi) {
  return mi ? `<div class="tm half"><span>${h}:30</span></div>` : `<div class="tm"><span>${h}:00</span></div>`;
}
/* 商談は1時間半の帯で見せる：始まりの枠に置いて、下の枠へ重ねて伸ばす（行の高さは固定）。
   何枠ぶんか（19:00で切る）と、同じ列で時間が重なる商談を横に並べるための「レーン」 */
const spanOf = s => Math.max(1, Math.min(Math.ceil((s.dur || APO_MIN) / 30), (SLOT_H1 * 60 - s.when.getHours() * 60 - s.when.getMinutes()) / 30));
function laneLayout(list) {
  const ends = [], lane = {};
  list.slice().sort((a, b) => a.when - b.when || (a.closer < b.closer ? -1 : 1)).forEach(s => {
    let i = ends.findIndex(e => e <= s.when); if (i < 0) { i = ends.length; ends.push(0); }
    ends[i] = apoEnd(s); lane[s.id] = i;
  });
  return {lane, n: Math.max(1, ends.length)};
}
const blkStyle = (s, L) => { const i = L.lane[s.id] || 0, n = L.n; return `--span:${spanOf(s)};left:calc(2px + (100% - 4px) * ${i} / ${n});width:calc((100% - 4px) / ${n}${n > 1 ? " - 2px" : ""})`; };
function renderCal() {
  const now = new Date(), T = today(), cls = closerList();
  if (calCloser !== "all" && !cls.some(c => c.id === calCloser)) calCloser = "all";
  $("calView").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === calView));
  const cal = $("cal"); cal.innerHTML = "";
  cal.className = "cal " + calView;
  let free = 0, count = 0;

  if (calView === "day") {
    /* ---- 日表示：列＝クローザー ---- */
    const day = calDay;
    const off = Math.round((dayStart(day) - T) / 864e5);
    $("wkLbl").textContent = md(day);
    $("calFilter").hidden = true;
    $("legend").innerHTML = `<span><i style="background:transparent;outline:2px solid #FFD54F;outline-offset:-2px"></i>自分が取ったアポ</span><span>列＝クローザー（1人1枠）</span>`;
    cal.style.gridTemplateColumns = `50px repeat(${cls.length}, minmax(92px, 1fr))`;
    cal.insertAdjacentHTML("beforeend", `<div class="hd corner"></div>` + cls.map(c => {
      let f = 0;
      for (let h = SLOT_H0; h < SLOT_H1; h++) for (const mi of [0, 30]) { const d = new Date(day); d.setHours(h, mi, 0, 0); if (d >= now && !closerBusy(d, c.id, null)) f++; }
      const g = busyMap[c.id], gs = !g ? "" : g.status === "ok" ? `<em class="gc ok" title="Googleカレンダー連携中">G</em>` : `<em class="gc ng" title="Googleカレンダーが未共有">G</em>`;
      return `<div class="hd cl"><span><i class="dot-c" style="background:${c.color}"></i>${esc(c.name)}${gs}</span><small>空き ${f}枠</small></div>`;
    }).join(""));
    const lanesC = {};
    cls.forEach(c => lanesC[c.id] = laneLayout(allSlots().filter(s => s.closer === c.id && s.day === dk(day) && s.when)));
    for (let h = SLOT_H0; h < SLOT_H1; h++) for (const mi of [0, 30]) {
      cal.insertAdjacentHTML("beforeend", timeCell(h, mi));
      const d = new Date(day); d.setHours(h, mi, 0, 0);
      const at = slotsAt(d, null);
      cls.forEach(c => {
        const past = d < now;
        const list = at.filter(s => s.closer === c.id);                       // ここから始まる商談
        const cover = list.length ? null : apoCovering(d, c.id, null);         // 前の枠から続いている商談
        const gb = list.length || cover ? null : gBusyAt(d, c.id);
        const canStart = !closerBusy(d, c.id, null);                           // ここから1時間半とれるか
        if (!past && canStart) free++;
        count += list.length;
        const b = document.createElement("button");
        b.className = "sl" + (mi ? " half" : "") + (past ? " past" : canStart ? " free" : " full") + (!past && !canStart && !list.length && !cover && !gb ? " nostart" : "");
        b.setAttribute("aria-label", c.name + " " + hm(d) + (list.length ? " 商談あり" : cover ? " 商談中" : gb ? " ほかの予定あり" : past ? " 過ぎた枠" : canStart ? " 空き" : " ここからは1時間半とれない"));
        /* ほかの予定は、始まりの枠にだけ時間を書く */
        const gStart = gb && (gb.s >= d || +d === +new Date(new Date(day).setHours(SLOT_H0, 0, 0, 0)));
        /* 商談は始まりの枠から1時間半の帯。続きの枠（cover）は帯の下になるので何も書かない */
        b.innerHTML = list.map(s => `<span class="apd blk${s.uid === U ? " mine" : ""}" style="--cc:${c.color};${blkStyle(s, lanesC[c.id])}"><b>${esc(s.shop || "（店名なし）")}</b><small class="num">${hm(s.when)}〜${hm(apoEnd(s))}</small><small>獲得 ${esc(nameOf(s.uid))}</small></span>`).join("") +
          (gb ? `<span class="gbusy">${gStart ? `予定あり<small>${hm(gb.s)}〜${hm(gb.e)}</small>` : ""}</span>` : "") +
          (!past && canStart ? `<span class="free-mark">${hm(d)}</span>` : "") + (+dayStart(d) === +T ? nowLine(d, now) : "");
        b.onclick = () => slotTap(d, list.length ? list : cover ? [cover] : [], past, !canStart, c.id);
        cal.appendChild(b);
      });
    }
    $("wkSub").textContent = (off === 0 ? "今日" : off === 1 ? "明日" : off === -1 ? "昨日" : "") + "　アポ " + count + "件 ・ 空き " + free + "枠";
    $("calToday").hidden = off === 0;
    $("calDefs").textContent = "空いている枠を押すと、そのクローザーで、その時間から1時間半の商談を登録できます。商談を押すと詳細が出ます。";
  } else {
    /* ---- 週表示：月〜土 ---- */
    const days = [0, 1, 2, 3, 4, 5].map(i => addDays(wkStart, i));
    $("wkLbl").textContent = md(days[0]) + " 〜 " + md(days[5]);
    const wOff = Math.round((wkStart - monday(now)) / (7 * 864e5));
    const byC = s => calCloser === "all" || s.closer === calCloser;
    $("calFilter").hidden = false;
    $("calFilter").innerHTML = [{id: "all", name: "クローザー全員"}, ...cls].map(c =>
      `<button class="chip-btn" data-c="${esc(c.id)}" aria-pressed="${calCloser === c.id}">${c.id !== "all" ? `<i class="dot-c" style="background:${c.color}"></i>` : ""}${esc(c.name)}</button>`).join("");
    $("legend").innerHTML = `<span>色＝クローザー</span>` + cls.map(c => `<span><i style="background:${c.color}"></i>${esc(c.name)}</span>`).join("") +
      `<span><i style="background:transparent;outline:2px solid #FFD54F;outline-offset:-2px"></i>自分が取ったアポ</span>`;
    cal.style.gridTemplateColumns = "";
    cal.insertAdjacentHTML("beforeend", `<div class="hd corner"></div>` + days.map(d =>
      `<div class="hd${+d === +T ? " today" : ""}${d.getDay() === 6 ? " sat" : ""}">${WD[d.getDay()]}<small>${d.getMonth() + 1}/${d.getDate()}</small></div>`).join(""));
    const lanesD = {};   // 日ごとに、時間が重なる商談（別のクローザー）を横に並べる
    days.forEach(day => lanesD[dk(day)] = laneLayout(allSlots().filter(s => s.day === dk(day) && s.when && byC(s))));
    for (let h = SLOT_H0; h < SLOT_H1; h++) for (const mi of [0, 30]) {
      cal.insertAdjacentHTML("beforeend", timeCell(h, mi));
      days.forEach(day => {
        const d = new Date(day); d.setHours(h, mi, 0, 0);
        const list = slotsAt(d, null).filter(byC).sort((a, b) => a.closer < b.closer ? -1 : 1);
        const past = d < now, full = !slotOpen(d, null, calCloser);
        if (!past && !full) free++;
        count += list.length;
        const b = document.createElement("button");
        b.className = "sl" + (mi ? " half" : "") + (past ? " past" : full ? " full" : " free") + (+day === +T ? " today" : "");
        b.setAttribute("aria-label", md(d) + " " + hm(d) + (list.length ? " アポ" + list.length + "件" : past ? " 過ぎた枠" : " 空き"));
        /* クローザーを1人に絞っているときは、Googleの予定も出す。続きの枠（商談中）は帯の下になる（押すとその商談） */
        const cover = calCloser !== "all" && !list.length ? apoCovering(d, calCloser, null) : null;
        const gbw = calCloser !== "all" && !list.length && !cover ? gBusyAt(d, calCloser) : null;
        b.innerHTML = list.map(s => `<span class="ap blk${s.uid === U ? " mine" : ""}" style="background:${CCOL(s.closer)};${blkStyle(s, lanesD[dk(day)])}"><b>${esc(CNAME(s.closer)[0])}</b><span class="nm">${esc(s.shop || "")}</span><small>${hm(s.when)}〜${hm(apoEnd(s))}</small></span>`).join("") +
          (gbw ? `<span class="gbusy wk">予定あり</span>` : "") +
          (+day === +T ? nowLine(d, now) : "");
        b.onclick = () => slotTap(d, list.length ? list : cover ? [cover] : [], past, full, calCloser !== "all" ? calCloser : undefined);
        cal.appendChild(b);
      });
    }
    $("wkSub").textContent = (wOff === 0 ? "今週" : wOff === 1 ? "来週" : wOff === -1 ? "先週" : "") + "　アポ " + count + "件 ・ 空き " + free + "枠";
    $("calToday").hidden = wOff === 0;
    $("calDefs").textContent = "枠を押すと、商談の詳細を見るか、空いていればその時間から1時間半の商談を登録できます。クローザー1人につき同じ時間は1件まで" +
      (calCloser === "all" ? "で、全員が埋まっている時間だけ「埋まり」になります。" : "。今は" + CNAME(calCloser) + "さんの予定だけ表示しています。");
  }
  document.body.classList.toggle("picking", pickMode);
  $("pickBar").hidden = !pickMode;
  renderUndated();
  if (pickMode) $("undatedTeam").hidden = true;
}
/* closerId：日表示の列から押したときだけ入る（その人で決まる） */
/* ここから1時間半とれない理由 */
function whyNot(d, cid, except) {
  if (!cid || cid === "all" || cid === "auto") return "この時間からの1時間半は、クローザー全員が埋まっています";
  const hit = apoOverlap(d, cid, except);
  if (hit) return CNAME(cid) + "さんは " + hm(hit.when) + "〜" + hm(apoEnd(hit)) + " に商談があるので、ここからは1時間半とれません";
  const gb = gBusyRange(d, cid);
  if (gb) return CNAME(cid) + "さんは " + hm(gb.s) + "〜" + hm(gb.e) + " にほかの予定があるので、ここからは1時間半とれません";
  return "この枠は埋まっています";
}
function slotTap(d, list, past, full, closerId) {
  if (pickMode) {
    if (past) { toast("過ぎた時間は選べません"); return; }
    /* 日時を選び直しているアポ自身とは重なってもよい */
    const cid = closerId || (calCloser !== "all" ? calCloser : null);
    const blocked = cid ? closerBusy(d, cid, editing) : !slotOpen(d, editing, "all");
    if (blocked) { toast(whyNot(d, cid, editing)); return; }
    if (cid) selCloser = cid;
    $("mWhen").value = toLocal(d); finishPick(); setQuick("アポ"); checkClash(); return;
  }
  if (list.length) { showApoDetail(d, list, past); return; }
  if (full && !past) { toast(whyNot(d, closerId || calCloser, null)); return; }
  if (past) return;
  newApoAt(d, closerId);
}
function newApoAt(d, closerId) {
  const ref = doc(collection(db, "records"));
  const c = closerId || (calCloser === "all" ? undefined : calCloser);
  openMemo({id: ref.id, uid: U, t: new Date(), r: "アポ", memo: {when: new Date(d), remind: true, closer: c}, draft: true});
}
let adSlot = null;
function showApoDetail(d, list, past) {
  adSlot = d;
  $("adTitle").textContent = md(d) + " " + hm(d) + " の商談";
  const free = freeClosers(d, null);
  $("adBody").innerHTML = list.map(s => `<div class="ad-row"><b>${esc(s.shop || "（店名なし）")}</b>
    <small class="num">${md(s.when)} ${hm(s.when)}〜${hm(apoEnd(s))}</small>
    <small><i class="dot-c" style="background:${CCOL(s.closer)}"></i>クローザー ${esc(CNAME(s.closer))} ・ 獲得 ${esc(nameOf(s.uid))}</small>
    ${s.tel ? `<a class="ad-tel num" href="${telHref(s.tel)}">☎ ${esc(s.tel)}</a>` : ""}
    ${s.text ? `<div>${esc(s.text)}</div>` : ""}
    ${s.info ? `<div class="ad-info">${esc(s.info)}</div>` : ""}</div>`).join("") +
    (!past ? `<div class="ad-row"><small>この時間から1時間半とれるクローザー：${free.length ? free.map(c => esc(c.name)).join("・") : "なし"}</small></div>` : "");
  $("adNew").hidden = past || !slotOpen(d, null, calCloser);
  $("adScrim").hidden = $("apoDetail").hidden = false;
}
$("adNew").onclick = () => { $("adScrim").hidden = $("apoDetail").hidden = true; if (adSlot) newApoAt(adSlot); };
$("adClose").onclick = $("adScrim").onclick = () => { $("adScrim").hidden = $("apoDetail").hidden = true; };

/* 日切り：メモの画面 → カレンダーで空きを選ぶ → メモの画面に戻る */
$("mPick").onclick = () => {
  pickMode = true; pickReturn = curTab;
  $("scrim").hidden = $("msheet").hidden = true;
  const w = $("mWhen").value ? new Date($("mWhen").value) : new Date();
  wkStart = monday(w); calDay = dayStart(w); if (calDay.getDay() === 0) calDay = addDays(calDay, 1);
  calCloser = selCloser === "auto" ? "all" : selCloser;
  showTab("cal");
};
function finishPick() { pickMode = false; document.body.classList.remove("picking"); $("pickBar").hidden = true; showTab(pickReturn); $("scrim").hidden = $("msheet").hidden = false; }
function cancelPick() { pickMode = false; document.body.classList.remove("picking"); $("pickBar").hidden = true; $("scrim").hidden = $("msheet").hidden = false; }
$("pickCancel").onclick = () => { cancelPick(); showTab(pickReturn); };

/* 日時未定のアポ */
function renderUndated() {
  if (!started) return;
  const mine = undated.filter(r => r.uid === U), b = $("undatedMine");
  b.hidden = !mine.length;
  if (mine.length) { b.innerHTML = `<span>日時未定のアポ ${mine.length}件</span><span class="go2">日時を入れる →</span>`; b.onclick = () => openMemo(mine[0]); }
  const box = $("undatedTeam");
  box.hidden = !undated.length;
  if (undated.length) {
    box.innerHTML = `<div class="ttl">日時未定のアポ ${undated.length}件（カレンダーに入っていません）</div>` +
      undated.map((r, i) => `<button data-i="${i}"><b>${esc((r.memo && r.memo.shop) || "（店名なし）")}</b><small>獲得 ${esc(nameOf(r.uid))} ・ ${md(r.t)} ${hm(r.t)}</small><span class="fix">${r.uid === U ? "日時を入れる" : "見る"}</span></button>`).join("");
    box.querySelectorAll("button").forEach(x => x.onclick = () => openMemo(undated[+x.dataset.i]));
  }
}

/* ============================================================
   リマインド・通知
   ============================================================ */
/* 再架電と「予定」（前確など）は、過ぎても3日間は残す。アポは今日以降だけ */
const keepsLate = r => r.r === "再架電" || r.isTask;
function visiblePending(list) {
  const from = addDays(today(), -3);
  return list.filter(r => r.memo && r.memo.when && !r.done && (keepsLate(r) ? r.memo.when >= from : r.memo.when >= today()));
}

/* ============================================================
   テレアポ以外の予定（前確・折り返し待ちなど）。架電数には数えない
   tasks/{id} = {uid: 担当, by: 作った人, kind, title, shop, tel, text, when, remind, done, createdAt}
   リマインド・通知・今日の予定では、再架電と同じ形（memo.when など）に直して混ぜる
   ============================================================ */
const TASK_KINDS = [
  {k: "前確",       bg: "#D7CCF0", fg: "#4A2F8A"},
  {k: "再架電",     bg: "#BFE1F6", fg: "#0A53A8"},
  {k: "折り返し待ち", bg: "#FCE3B5", fg: "#7A4A00"},
  {k: "その他",     bg: "#E3E6EA", fg: "#3C4043"}
];
const TASK_COL = Object.fromEntries(TASK_KINDS.map(t => [t.k, t]));
let recPendMine = [], recPendTeam = [], taskMine = [], taskTeam = [];
function taskOf(snap) {
  const d = snap.data();
  return {id: snap.id, isTask: true, uid: d.uid, by: d.by, r: d.kind || "その他", done: !!d.done,
    t: tsd(d.createdAt) || new Date(), title: d.title || "",
    memo: {shop: d.shop || "", tel: d.tel || "", text: d.text || "", when: tsd(d.when), remind: d.remind !== false}};
}
function rebuildPending() {
  pendMine = recPendMine.concat(taskMine);
  pendTeam = recPendTeam.concat(taskTeam.filter(t => !recPendTeam.some(r => r.id === t.id)));
  renderAfterPending(); maybeDaySum();
}
const canEditTask = t => t.uid === U || t.by === U || (me && me.role === "admin");
const itemLabel = r => r.isTask ? (r.title || r.r) : r.r;
function todayMine() { const T = today(), E = addDays(T, 1); return visiblePending(pendMine).filter(r => r.memo.when >= T && r.memo.when < E).sort((a, b) => a.memo.when - b.memo.when); }
function renderAfterPending() { renderNext(); if (curTab === "remind") renderRemind(); updateRmDot(); }
function updateRmDot() {
  const n = visiblePending(pendMine).filter(r => r.memo.when < addDays(today(), 1)).length;
  $("rmDot").hidden = !n; $("rmDot").textContent = n;
}
function renderNext() {
  if (!started) return;
  const now = new Date(), list = todayMine(), r = list.find(x => x.memo.when >= now), late = list.filter(x => x.memo.when < now && keepsLate(x)).length;
  const box = $("nextUp");
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  if (r) {
    const mins = Math.round((r.memo.when - now) / 6e4);
    const left = mins >= 60 ? Math.floor(mins / 60) + "時間" + (mins % 60 ? mins % 60 + "分" : "") : mins + "分";
    box.innerHTML = `<span class="nu-lbl">次の予定</span><span class="num nu-t">${hm(r.memo.when)}</span><span class="nu-b">${resChip(r.r)} ${esc(r.isTask ? [r.title, r.memo.shop].filter(Boolean).join(" ") : (r.memo.shop || ""))}</span><span class="nu-left">あと${left}</span>`;
  } else box.innerHTML = `<span class="nu-lbl">次の予定</span><span class="nu-b">今日のこのあとの予定はありません</span>`;
  if (late) box.innerHTML += `<span class="badge late">過ぎた予定 ${late}件</span>`;
  if (r) box.innerHTML += `<span class="nu-go">詳細 ›</span>`;
  box.onclick = () => r ? openDetail(r) : showTab("remind");
}
setInterval(() => { if (started) renderNext(); }, 60000);

let rmF = "me";
$("rmFilter").onclick = e => { const b = e.target.closest("button"); if (!b) return; rmF = b.dataset.f; $("rmFilter").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderRemind(); };
function renderRemind() {
  const now = new Date(), tmr = addDays(today(), 1);
  const list = visiblePending(rmF === "me" ? pendMine : pendTeam).sort((a, b) => a.memo.when - b.memo.when);
  const groups = [["過ぎている予定", list.filter(r => r.memo.when < now)], ["今日", list.filter(r => r.memo.when >= now && r.memo.when < tmr)], ["明日以降", list.filter(r => r.memo.when >= tmr)]];
  const body = $("rmBody"); body.innerHTML = "";
  groups.forEach(([title, g]) => {
    const h = document.createElement("h2"); h.innerHTML = `${title} <span class="aside">${g.length}件</span>`; body.appendChild(h);
    const c = document.createElement("div"); c.className = "card";
    if (!g.length) c.innerHTML = `<div class="empty">ありません</div>`;
    g.slice(0, 30).forEach(r => {
      const late = r.memo.when < now, mine = r.uid === U;
      const row = document.createElement("div"); row.className = "rm" + (late ? " late" : "") + (r.isTask ? " task" : "");
      const head = r.isTask
        ? `${resChip(r.r)} ${esc(r.title || "")}${r.memo.shop ? ` <span class="t-shop">${esc(r.memo.shop)}</span>` : ""}`
        : `${esc(r.memo.shop || "（店名なし）")}${r.r === "アポ" ? `<span class="badge apo">商談</span>` : ""}`;
      const meta = r.isTask
        ? `担当 ${esc(nameOf(r.uid))}${r.by && r.by !== r.uid ? " ・ 作成 " + esc(nameOf(r.by)) : ""}`
        : `担当 ${esc(nameOf(r.uid))}${r.r === "アポ" && r.memo.closer ? " ・ クローザー " + esc(CNAME(r.memo.closer)) : ""} ・ ${md(r.t)} に${r.r === "アポ" ? "獲得" : "架電"}`;
      const btns = r.isTask && canEditTask(r) ? `<button class="done">${r.r === "再架電" ? "かけた" : "完了"}</button><button class="later">明日へ</button>`
        : r.r === "再架電" && mine ? `<button class="done">かけた</button><button class="later">明日へ</button>` : `<button class="edit">詳細</button>`;
      row.innerHTML = `<div class="time">${hm(r.memo.when)}<small>${md(r.memo.when)}</small></div>
        <div class="info"><div class="shop">${head}${late ? `<span class="badge late">期限切れ</span>` : ""}</div>
        <div class="meta">${meta}</div>
        ${r.memo.tel ? `<div class="tel-line num">☎ ${esc(r.memo.tel)}</div>` : ""}
        ${r.memo.text ? `<div class="memo">${esc(r.memo.text)}</div>` : ""}</div>
        <div class="btns">${btns}</div>`;
      const d = row.querySelector(".done"), l = row.querySelector(".later"), ed = row.querySelector(".edit");
      if (d) d.onclick = e => { e.stopPropagation(); markDone(r); };
      if (l) l.onclick = e => { e.stopPropagation(); postpone(r); };
      if (ed) ed.onclick = e => { e.stopPropagation(); openDetail(r); };
      row.classList.add("tap"); row.tabIndex = 0;
      row.onclick = () => openDetail(r);
      row.onkeydown = e => { if (e.key === "Enter") openDetail(r); };
      c.appendChild(row);
    });
    body.appendChild(c);
  });
}
function markDone(r) {
  if (r.isTask) {   // 予定は架電ではないので、終わりにするだけ（再架電の予定は、このあと結果ボタンで数える）
    updateDoc(doc(db, "tasks", r.id), {done: true, doneAt: serverTimestamp()}).catch(e => toast(errMsg(e)));
    if (r.r === "再架電") { showTab("count"); toast("今回の結果のボタンを押してください"); }
    else toast("「" + itemLabel(r) + "」を完了にしました");
    return;
  }
  histLoadedAt = 0;
  updateDoc(doc(db, "records", r.id), {done: true, pending: false}).catch(e => toast(errMsg(e)));
  showTab("count"); toast("今回の結果のボタンを押してください");
}
function postpone(r) {
  refreshHistSoon();
  const now = new Date();
  const w = addDays(dayStart(r.memo.when < now ? now : r.memo.when), 1); w.setHours(r.memo.when.getHours(), r.memo.when.getMinutes());
  const p = r.isTask ? updateDoc(doc(db, "tasks", r.id), {when: Timestamp.fromDate(w)}) : updateDoc(doc(db, "records", r.id), {"memo.when": Timestamp.fromDate(w)});
  p.catch(e => toast(errMsg(e)));
  toast(md(w) + " " + hm(w) + " に延期しました");
}

/* ---------- 記録の詳細（電話番号・日時・クローザー・メモ） ---------- */
const telHref = t => "tel:" + String(t || "").replace(/[^\d+]/g, "");
let detailRec = null;
function openDetail(r) {
  if (!r) return;
  detailRec = r;
  const m = r.memo || {}, mine = r.isTask ? canEditTask(r) : r.uid === U, w = m.when, now = new Date();
  $("rdTitle").innerHTML = resChip(r.r) + " " + esc(r.isTask ? ([r.title, m.shop].filter(Boolean).join(" ") || r.r) : (m.shop || "（店名なし）"));
  const rows = [];
  if (w) {
    const mins = Math.round((w - now) / 6e4);
    const left = mins > 0 && mins < 24 * 60 ? `<span class="rd-left">あと${mins >= 60 ? Math.floor(mins / 60) + "時間" + (mins % 60 ? mins % 60 + "分" : "") : mins + "分"}</span>` : mins <= 0 && keepsLate(r) && !r.done ? `<span class="badge late">過ぎています</span>` : "";
    rows.push([r.isTask ? "日時" : r.r === "アポ" ? "商談日時" : "かけ直す日時", `<b class="num">${dayWord(w)} ${md(w)} ${hm(w)}${r.r === "アポ" && !r.isTask ? "〜" + hm(new Date(w.getTime() + APO_MIN * 6e4)) : ""}</b>${left}`]);
  } else if (r.r === "アポ") rows.push(["面談日時", r.src === "old" ? OLD_BADGE + `<small>日時は残っていません</small>` : `<span class="badge late">日時未定</span>`]);
  if (r.isTask && m.shop && r.title) rows.push(["店名", esc(m.shop)]);
  if (r.r === "アポ" && m.closer) rows.push(["クローザー", `<i class="dot-c" style="background:${CCOL(m.closer)}"></i>${esc(CNAME(m.closer))}`]);
  if (r.isTask) rows.push(["担当", esc(nameOf(r.uid)) + (r.by && r.by !== r.uid ? `<small>作成 ${esc(nameOf(r.by))}</small>` : "")]);
  else rows.push([r.r === "アポ" ? "獲得" : "担当", esc(nameOf(r.uid)) + `<small>${md(r.t)} ${hm(r.t)}</small>`]);
  rows.push(["メモ", m.text ? `<span class="rd-memo">${esc(m.text)}</span>` : `<span class="rd-none">なし</span>`]);
  if (!r.isTask && r.r === "アポ") rows.push(["カレンダーの説明", m.info ? `<span class="rd-memo">${esc(m.info)}</span>` : `<span class="rd-none">なし（「メモを編集」から貼り付けると、クローザーのカレンダーに入ります）</span>`]);
  $("rdTel").innerHTML = m.tel
    ? `<a class="rd-call" href="${telHref(m.tel)}"><span>☎</span><b class="num">${esc(m.tel)}</b><small>押すと電話をかける</small></a><button class="rd-copy" id="rdCopy">コピー</button>`
    : `<div class="rd-notel">電話番号は入っていません${mine ? "（「" + (r.isTask ? "編集" : "メモを編集") + "」から入れられます）" : ""}</div>`;
  $("rdBody").innerHTML = rows.map(([k, v]) => `<div class="rd-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
  const acts = [];
  if (r.isTask && mine && !r.done) acts.push(`<button class="primary" data-a="done">${r.r === "再架電" ? "かけた（結果を押す）" : "完了にする"}</button>`, `<button data-a="later">明日へ延期</button>`);
  if (!r.isTask && mine && r.r === "再架電" && !r.done && w) acts.push(`<button class="primary" data-a="done">かけた（結果を押す）</button>`, `<button data-a="later">明日へ延期</button>`);
  /* アポからは、前確の予定をそのまま作れる */
  if (!r.isTask && r.r === "アポ") acts.push(`<button data-a="prec">＋ 前確の予定を作る</button>`);
  $("rdActs").innerHTML = acts.join(""); $("rdActs").hidden = !acts.length;
  $("rdEdit").hidden = !mine;
  $("rdEdit").textContent = r.isTask ? "編集" : "メモを編集";
  $("rdScrim").hidden = $("recDetail").hidden = false;
  if ($("rdCopy")) $("rdCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(m.tel); toast("電話番号をコピーしました"); }
    catch (_) { const s = getSelection(), rg = document.createRange(); rg.selectNodeContents($("rdTel").querySelector("b")); s.removeAllRanges(); s.addRange(rg); toast("選択しました。コピーしてください"); }
  };
}
function closeDetail() { $("rdScrim").hidden = $("recDetail").hidden = true; detailRec = null; }
$("rdClose").onclick = closeDetail; $("rdScrim").onclick = closeDetail;
$("rdEdit").onclick = () => { const r = detailRec; closeDetail(); if (r) (r.isTask ? openTask(r) : openMemo(r)); };
$("rdActs").onclick = e => {
  const b = e.target.closest("button"); if (!b || !detailRec) return;
  const r = detailRec; closeDetail();
  if (b.dataset.a === "done") markDone(r);
  if (b.dataset.a === "later") postpone(r);
  if (b.dataset.a === "prec") openTask(null, {kind: "前確", shop: (r.memo || {}).shop, tel: (r.memo || {}).tel, apoWhen: (r.memo || {}).when});
};
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("recDetail").hidden) closeDetail(); });
/* 3日以上前に終わった自分のアポは、リマインドの対象から外しておく */
function cleanupOldApos() {
  const limit = addDays(today(), -3);
  pendMine.filter(r => r.r === "アポ" && r.memo && r.memo.when && r.memo.when < limit).forEach(r => updateDoc(doc(db, "records", r.id), {pending: false}).catch(() => {}));
}

/* 通知の設定（機械ごと） */
const SW = ["swMorning", "swBefore", "swOnTime", "swSound", "swVib"];
const swSaved = lsGet("team-notif", {});
SW.forEach(id => { if (id in swSaved) $(id).checked = swSaved[id]; $(id).onchange = () => { swSaved[id] = $(id).checked; lsSet("team-notif", swSaved); }; });

function beep(times) {
  if (!$("swSound").checked) return;
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].slice(0, times || 2).forEach(d => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "sine"; o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.0001, ac.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + d + 0.3);
      o.start(ac.currentTime + d); o.stop(ac.currentTime + d + 0.32);
    });
  } catch (_) {}
}
let alertRec = null;
function showAlert(rec, mode, force) {
  const now = mode === "now";
  if (!force && !$(now ? "swOnTime" : "swBefore").checked) return;
  alertRec = rec;
  const kind = rec.isTask ? rec.r : rec.r === "アポ" ? "商談" : "再架電";
  const canDone = rec.r === "再架電" || rec.isTask;
  $("alertBar").classList.toggle("now", now);
  $("alTag").textContent = now ? kind + "の時間です" : kind + "まで あと15分";
  $("alTime").textContent = hm(rec.memo.when);
  $("alShop").textContent = rec.isTask ? ([rec.title, rec.memo.shop].filter(Boolean).join(" ") || rec.r) : (rec.memo.shop || "（店名なし）");
  $("alMemo").textContent = rec.memo.text || ""; $("alMemo").hidden = !rec.memo.text;
  $("alDone").hidden = !now || !canDone; $("alSnooze").hidden = !now;
  $("alDone").textContent = rec.isTask && rec.r !== "再架電" ? "完了" : "かけた";
  $("alOpen").classList.toggle("primary", !now || !canDone);
  $("alertBar").hidden = false;
  beep(now ? 3 : 2);
  if ($("swVib").checked && navigator.vibrate) navigator.vibrate(now ? [300, 100, 300, 100, 300] : [200, 100, 200]);
}
function hideAlert() { $("alertBar").hidden = true; alertRec = null; }
$("alOpen").onclick = () => { const r = alertRec; hideAlert(); if (r) openDetail(r); };
/* 通知の店名やメモの部分を押しても詳細を出す */
["alShop", "alMemo", "alTag", "alTime"].forEach(id => $(id).onclick = () => { const r = alertRec; hideAlert(); if (r) openDetail(r); });
$("alDone").onclick = () => { const r = alertRec; hideAlert(); if (r) markDone(r); };
$("alSnooze").onclick = () => { const r = alertRec; hideAlert(); if (r) { snoozed[r.id] = Date.now() + 5 * 6e4; } toast("5分後にもう一度出します"); };
$("alClose").onclick = hideAlert;

/* 15秒ごとに、自分の今日の予定を見て「15分前」「ちょうど」を1回ずつ出す */
const snoozed = {};
function checkNotifs() {
  if (!started) return;
  const now = Date.now(), key = "team-fired-" + dk(today());
  const fired = lsGet(key, {});
  for (const r of todayMine()) {
    if (r.memo.remind === false) continue;
    const w = r.memo.when.getTime();
    if (snoozed[r.id] && now >= snoozed[r.id]) { delete snoozed[r.id]; showAlert(r, "now"); return; }
    if (!fired[r.id + ":now"] && now >= w && now < w + 30 * 6e4) { fired[r.id + ":now"] = 1; fired[r.id + ":pre"] = 1; lsSet(key, fired); showAlert(r, "now"); return; }
    if (!fired[r.id + ":pre"] && now >= w - 15 * 6e4 && now < w) { fired[r.id + ":pre"] = 1; lsSet(key, fired); showAlert(r, "pre"); return; }
  }
}

/* その日はじめて開いたときの「今日の予定」（機械ごとに1日1回） */
let pendLoaded = false;
function maybeDaySum() {
  if (!loadedFlags.rec || !loadedFlags.task) return;
  if (!$("swMorning").checked) return;
  const k = "team-daysum";
  if (lsGet(k, "") === dk(today())) return;
  lsSet(k, dk(today()));
  showDaySum();
}
function showDaySum() {
  const list = todayMine(), now = new Date();
  $("dsDate").textContent = md(today());
  $("dsCount").textContent = list.length + "件";
  $("dsList").innerHTML = list.length ? list.map(r => {
    const past = r.memo.when < now;
    return `<div class="ds-row tap${past ? " past" : ""}" data-id="${esc(r.id)}" tabindex="0"><span class="num ds-t">${hm(r.memo.when)}</span><span class="ds-b">${resChip(r.r)} <b>${esc(r.isTask ? [r.title, r.memo.shop].filter(Boolean).join(" ") || r.r : (r.memo.shop || "（店名なし）"))}</b>${past ? `<span class="badge late">過ぎています</span>` : ""}${r.memo.text ? `<small>${esc(r.memo.text)}</small>` : ""}</span></div>`;
  }).join("") : `<div class="empty">今日の予定はありません</div>`;
  $("dsScrim").hidden = $("daySum").hidden = false;
  $("dsList").querySelectorAll(".ds-row").forEach(el => { const r = list.find(x => x.id === el.dataset.id); const go = () => { closeDaySum(); openDetail(r); }; el.onclick = go; el.onkeydown = e => { if (e.key === "Enter") go(); }; });
  if (list.length) beep(1);
}
function closeDaySum() { $("dsScrim").hidden = $("daySum").hidden = true; }
$("dsOk").onclick = closeDaySum; $("dsScrim").onclick = closeDaySum;
$("dsGo").onclick = () => { closeDaySum(); showTab("remind"); };
$("trySum").onclick = showDaySum;
const nextMine = () => todayMine().find(r => r.memo.when >= new Date()) || visiblePending(pendMine).sort((a, b) => a.memo.when - b.memo.when)[0];
$("tryPre").onclick = () => { const r = nextMine(); if (r) showAlert(r, "pre", true); else toast("自分の予定がありません"); };
$("tryNow").onclick = () => { const r = nextMine(); if (r) showAlert(r, "now", true); else toast("自分の予定がありません"); };

/* ============================================================
   KPI（stats/{日} だけを読む）
   ============================================================ */
let period = "today", member = "all";
$("period").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  period = b.dataset.p; $("period").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b));
  $("customRange").hidden = period !== "custom"; renderKpi();
};
$("from").value = dk(addDays(today(), -13)); $("to").value = dk(today());
$("from").onchange = $("to").onchange = renderKpi;
$("member").onchange = () => { member = $("member").value; renderKpi(); };
function range() {
  const T = today(), tmr = addDays(T, 1);
  if (period === "today") return [T, tmr];
  if (period === "yday") return [addDays(T, -1), T];
  if (period === "week") return [monday(T), tmr];
  if (period === "month") return [new Date(T.getFullYear(), T.getMonth(), 1), tmr];
  if (period === "d30") return [addDays(T, -29), tmr];
  const f = $("from").value ? new Date($("from").value + "T00:00") : addDays(T, -13);
  const t = $("to").value ? addDays(new Date($("to").value + "T00:00"), 1) : tmr;
  return f < t ? [f, t] : [addDays(t, -1), addDays(f, 1)];
}
const statCache = {};
async function loadStats(a, b) {
  const key = dk(a) + "~" + dk(b);
  if (statCache[key] && Date.now() - statCache[key].at < 30000) return statCache[key].data;
  const s = await getDocs(query(collection(db, "stats"), where(documentId(), ">=", dk(a)), where(documentId(), "<=", dk(addDays(b, -1)))));
  const data = {}; s.forEach(d => data[d.id] = d.data());
  statCache[key] = {at: Date.now(), data};
  return data;
}
/* 1人・1日の稼働時間（分）。1時間ごとに決める：
   ・その時間帯の架電が全部10分枠に入っている → 電話をかけた10分枠の数×10分
   ・10分枠に入っていない架電がある（この機能より前の記録や、古い版の画面からの記録）→ その1時間を60分
   ・架電が0の時間帯は数えない（古い版の画面で取り消して10分枠だけ残った分を除くため）
   10分枠の数はその時間帯の架電数を超えないように抑える */
function activeMin(dayDoc, uid) {
  const h = (dayDoc.h || {})[uid] || {}, m = (dayDoc.m || {})[uid] || {};
  const mSum = {}, mBuckets = {};
  Object.entries(m).forEach(([k, v]) => {
    if (v > 0) { const hr = +k.slice(0, 2); mSum[hr] = (mSum[hr] || 0) + v; mBuckets[hr] = (mBuckets[hr] || 0) + 1; }
  });
  let min = 0;
  Object.entries(h).forEach(([hr, v]) => {
    if (!(v > 0)) return;
    const k = +hr;
    min += v > (mSum[k] || 0) ? 60 : 10 * Math.min(mBuckets[k] || 0, v);
  });
  return min;
}
function sumStats(data, who) {
  const c = {}; let n = 0, mins = 0;
  Object.values(data).forEach(day => Object.entries(day.c || {}).forEach(([uid, m]) => {
    if (who !== "all" && uid !== who) return;
    Object.entries(m).forEach(([k, v]) => { c[k] = (c[k] || 0) + v; n += v; });
    mins += activeMin(day, uid);
  }));
  /* 接続＝アポ＋オーナー断り＋NG（項目名を「NG（業者系）」のように変えても数える） */
  const isNG = k => k === "NG" || k.startsWith("NG（") || k.startsWith("NG(");
  const apo = c["アポ"] || 0, conn = apo + (c["オーナー断り"] || 0) + Object.keys(c).filter(isNG).reduce((a, k) => a + c[k], 0);
  return {n, apo, c, apoRate: n ? apo / n * 100 : 0, connRate: n ? conn / n * 100 : 0,
    mins, perHour: mins ? n / (mins / 60) : 0};
}
/* 稼働時間の見せ方：10時間未満は「3時間20分」、それ以上は「42.5時間」 */
function fmtMins(mins) {
  if (!mins) return "0分";
  if (mins >= 600) return (mins / 60).toFixed(1) + "時間";
  const h = Math.floor(mins / 60), m = mins % 60;
  return (h ? h + "時間" : "") + (m ? m + "分" : "");
}
const workDays = (a, b) => { let n = 0; for (let d = new Date(a); d < b; d = addDays(d, 1)) if (d.getDay() !== 0) n++; return Math.max(n, 1); };
function delta(cur, prev, unit) {
  const d = cur - prev;
  const dec = unit === "%" || unit === "件/時" || unit === "時間";
  if (Math.abs(d) < (dec ? 0.05 : 0.5)) return `<span class="d flat">前期比 ±0</span>`;
  const s = (d > 0 ? "▲" : "▼") + (unit === "%" ? Math.abs(d).toFixed(1) + "pt" : dec ? Math.abs(d).toFixed(1) + (unit === "時間" ? "h" : "") : Math.round(Math.abs(d)));
  return `<span class="d ${d > 0 ? "up" : "down"}">前期比 ${s}</span>`;
}
let kpiSeq = 0;
async function renderKpi() {
  const seq = ++kpiSeq;
  const [a, b] = range(), days = Math.round((b - a) / 864e5), pa = addDays(a, -days);
  const ids = Object.keys(members).filter(id => members[id].status === "active" || members[id].status === "removed");
  const sel = $("member"), cur = sel.value || member;
  sel.innerHTML = `<option value="all">メンバー：全員</option>` + ids.filter(id => members[id].status === "active").map(id => `<option value="${esc(id)}">メンバー：${esc(members[id].name)}${id === U ? "（自分）" : ""}</option>`).join("");
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : "all"; member = sel.value;
  let data, pdata;
  try { [data, pdata] = await Promise.all([loadStats(a, b), loadStats(pa, a)]); }
  catch (e) { $("tiles").innerHTML = `<div class="empty">読み込めませんでした</div>`; return; }
  if (seq !== kpiSeq) return;
  const s = sumStats(data, member), p = sumStats(pdata, member);
  $("tiles").innerHTML = [
    ["架電", s.n, "", delta(s.n, p.n)], ["アポ", s.apo, "", delta(s.apo, p.apo)],
    ["アポ率", s.apoRate.toFixed(1), "%", delta(s.apoRate, p.apoRate, "%")], ["接続率", s.connRate.toFixed(1), "%", delta(s.connRate, p.connRate, "%")],
    ["1時間あたり", s.mins ? s.perHour.toFixed(1) : "–", s.mins ? "件" : "", s.mins ? delta(s.perHour, p.perHour, "件/時") : `<span class="d flat">&nbsp;</span>`],
    ["稼働時間", fmtMins(s.mins), "", delta(s.mins / 60, p.mins / 60, "時間")]
  ].map(([k, v, u, d]) => `<div class="card tile"><div class="k">${k}</div><div class="v">${v}<small>${u}</small></div>${d}</div>`).join("");

  const wd = workDays(a, b);
  const uids = new Set(ids); Object.values(data).forEach(d => Object.keys(d.c || {}).forEach(u => uids.add(u)));
  const rows = [...uids].map(u => ({u, s: sumStats(data, u)})).filter(r => r.s.n || (members[r.u] && members[r.u].status === "active"))
    .sort((x, y) => y.s.apo - x.s.apo || y.s.n - x.s.n);
  const maxN = Math.max(1, ...rows.map(r => r.s.n)), tot = sumStats(data, "all");
  const ph = s => s.mins ? s.perHour.toFixed(1) : "–";
  $("mtable").innerHTML = `<tr><th>メンバー</th><th>架電</th><th>1時間あたり</th><th>アポ</th><th>アポ率</th><th>接続率</th><th>稼働</th><th>1日平均</th></tr>` +
    rows.map(({u, s}) => `<tr class="pick${u === U ? " me" : ""}" data-u="${esc(u)}" style="${member !== "all" && member !== u ? "opacity:.45" : ""}">
      <td class="name">${esc(nameOf(u))}</td><td><span class="meter">${s.n}<i style="width:${Math.round(s.n / maxN * 56)}px"></i></span></td>
      <td><b>${ph(s)}</b></td><td>${s.apo}</td><td>${s.apoRate.toFixed(1)}%</td><td>${s.connRate.toFixed(1)}%</td><td>${fmtMins(s.mins)}</td><td>${(s.n / wd).toFixed(0)}</td></tr>`).join("") +
    `<tr><td class="name">チーム合計</td><td>${tot.n}</td><td><b>${ph(tot)}</b></td><td>${tot.apo}</td><td>${tot.apoRate.toFixed(1)}%</td><td>${tot.connRate.toFixed(1)}%</td><td>${fmtMins(tot.mins)}</td><td>${(tot.n / wd).toFixed(0)}</td></tr>`;
  $("mtable").querySelectorAll("tr.pick").forEach(tr => tr.onclick = () => { member = member === tr.dataset.u ? "all" : tr.dataset.u; $("member").value = member; renderKpi(); });

  const who = u => member === "all" || u === member;
  let buckets = [];
  if (days <= 1) {
    $("chartTitle").textContent = "時間帯別の架電数";
    const day = data[dk(a)] || {};
    for (let h = 9; h < 21; h++) {
      let n = 0; Object.entries(day.h || {}).forEach(([u, m]) => { if (who(u)) n += m[String(h)] || 0; });
      buckets.push({lbl: h + "時", tip: h + ":00〜", n, apo: null});
    }
  } else {
    $("chartTitle").textContent = "日別の架電数";
    for (let d = new Date(a); d < b; d = addDays(d, 1)) {
      const st = sumStats(data[dk(d)] ? {x: data[dk(d)]} : {}, member);
      buckets.push({lbl: (d.getMonth() + 1) + "/" + d.getDate(), tip: md(d), n: st.n, apo: st.apo, perHour: st.mins ? st.perHour : null});
    }
  }
  drawChart(buckets);
  const total = Math.max(1, s.n), keys = [...new Set([...ITEMS.map(i => i.k), ...Object.keys(s.c)])];
  const maxC = Math.max(1, ...keys.map(k => s.c[k] || 0));
  $("brk").innerHTML = keys.map(k => ({k, v: s.c[k] || 0})).sort((x, y) => y.v - x.v).map(({k, v}) =>
    `<div class="row">${resChip(k)}<div class="track"><i style="width:${v / maxC * 100}%"></i></div><span class="c">${v}</span><span class="p">${(v / total * 100).toFixed(1)}%</span></div>`).join("");
}
function niceMax(v) { if (v <= 5) return 5; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p; }
function drawChart(bk) {
  const W = 520, H = 190, L = 30, R = 6, T = 10, B = 22;
  const vals = bk.map(x => x.n), top = niceMax(Math.max(1, ...vals));
  const n = bk.length, slot = (W - L - R) / n, bw = Math.max(2, Math.min(28, slot - 2));
  const y = v => T + (H - T - B) * (1 - v / top);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc($("chartTitle").textContent)}">`;
  for (let i = 0; i <= 4; i++) { const v = top * i / 4, yy = y(v); s += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text class="axis" x="${L - 6}" y="${yy + 3}" text-anchor="end">${Math.round(v)}</text>`; }
  const every = Math.ceil(n / 10), mx = Math.max(...vals), maxI = mx > 0 ? vals.indexOf(mx) : -1;
  bk.forEach((x, i) => {
    const cx = L + slot * i + slot / 2, v = vals[i], yy = y(v), h = Math.max(0, y(0) - yy), r = Math.min(4, bw / 2, h);
    if (v > 0) s += `<path class="bar${i === maxI ? " hot" : ""}" d="M${cx - bw / 2},${y(0)} V${yy + r} Q${cx - bw / 2},${yy} ${cx - bw / 2 + r},${yy} H${cx + bw / 2 - r} Q${cx + bw / 2},${yy} ${cx + bw / 2},${yy + r} V${y(0)} Z"/>`;
    if (i % every === 0) s += `<text class="axis" x="${cx}" y="${H - 6}" text-anchor="middle">${x.lbl}</text>`;
    s += `<rect class="hit" data-i="${i}" x="${L + slot * i}" y="${T}" width="${slot}" height="${H - T - B}"/>`;
  });
  s += `</svg><div class="tip" id="tip" hidden></div>`;
  const box = $("chart"); box.innerHTML = s;
  const tip = $("tip"), svg = box.querySelector("svg");
  const show = e => {
    const r = e.target.closest(".hit"); if (!r) { tip.hidden = true; return; }
    const i = +r.dataset.i, x = bk[i], bb = svg.getBoundingClientRect(), sc = bb.width / W;
    tip.innerHTML = `${x.tip}　架電 <b>${x.n}</b>` + (x.apo != null ? `　アポ <b>${x.apo}</b>` : "") + (x.perHour != null ? `<br>1時間あたり <b>${x.perHour.toFixed(1)}</b>` : "");
    tip.style.left = Math.min(Math.max((L + slot * i + slot / 2) * sc + 12, 90), bb.width - 60) + "px"; tip.style.top = (y(vals[i]) * sc + 4) + "px"; tip.hidden = false;
  };
  svg.addEventListener("pointermove", show); svg.addEventListener("pointerdown", show); svg.addEventListener("pointerleave", () => tip.hidden = true);
}

/* ============================================================
   設定（自分・管理者）
   ============================================================ */
$("saveName").onclick = () => {
  const n = $("myName").value.trim(); if (!n) { toast("名前を入れてください"); return; }
  updateDoc(doc(db, "members", U), {name: n}).then(() => toast("名前を保存しました")).catch(e => toast(errMsg(e)));
};
/* Googleカレンダー連携の状態（クローザーだけ）。設定画面・カウント画面のボタン・手順の画面をまとめて更新 */
let busyLoaded = false;
const gcalLinked = () => !!(busyMap[U] && busyMap[U].status === "ok");
function gcalState() {
  const g = busyMap[U];
  const at = g && g.updatedAt ? hm(g.updatedAt) + " 確認" : "";
  if (!g) return {cls: "", pill: "確認待ち", text: "共有してから最大15分で確認されます"};
  if (g.status === "ok") return {cls: "ok", pill: "連携中", text: "予定を読み込めています（" + at + "）"};
  if (g.status === "no_email") return {cls: "ng", pill: "未共有", text: "アドレスが入っていません（" + at + "）"};
  return {cls: "ng", pill: "未共有", text: (g.email ? g.email + " の" : "") + "カレンダーがまだ共有されていません（" + at + "）"};
}
function renderGcal() {
  if (!me) return;
  const closer = !!me.closer, st = gcalState(), linked = gcalLinked();
  $("gcalBox").hidden = !closer;
  $("gcalNag").hidden = !closer || linked || !busyLoaded;
  if (!closer) return;
  if (document.activeElement !== $("gcalEmail")) $("gcalEmail").value = me.gcalEmail || me.email || "";
  $("gcalPill").className = "pill " + st.cls; $("gcalPill").textContent = st.pill;
  $("gcalStatus").textContent = st.text;
  $("gcalHow").hidden = linked; $("openGuide").hidden = linked;
  renderGuideStatus();
}
/* 手順の画面 */
function renderGuideStatus() {
  if ($("gcalGuide").hidden) return;
  const st = gcalState(), linked = gcalLinked();
  $("ggStatus").className = "gg-status " + (linked ? "ok" : st.cls === "ng" ? "ng" : "wait");
  $("ggStatus").innerHTML = linked ? "✓ 連携できました！ あなたの予定の時間が、チームのカレンダーに出ています" : `<b>今の状態：${esc(st.pill)}</b>　${esc(st.text)}`;
  $("ggSteps").hidden = linked;
  $("ggLater").hidden = linked;
  $("ggClose").textContent = linked ? "完了" : "閉じる";
}
function openGcalGuide() {
  if (!me) return;
  if (document.activeElement !== $("ggEmail")) $("ggEmail").value = me.gcalEmail || me.email || "";
  $("ggScrim").hidden = $("gcalGuide").hidden = false;
  renderGuideStatus();
}
function closeGcalGuide() { $("ggScrim").hidden = $("gcalGuide").hidden = true; }
/* まだ連携していないクローザーには、その日はじめて開いたときに1回だけ手順を出す（機械ごと） */
function maybeGcalGuide() {
  if (!me || !me.closer || !busyLoaded || gcalLinked()) return;
  if (!$("daySum").hidden || !$("msheet").hidden || !$("moveDlg").hidden) { setTimeout(maybeGcalGuide, 4000); return; }   // 今日の予定などが開いていたら後で
  const k = "team-gcal-guide";
  if (lsGet(k, "") === dk(today())) return;
  lsSet(k, dk(today()));
  openGcalGuide();
}
$("gcalNag").onclick = openGcalGuide;
$("openGuide").onclick = openGcalGuide;
$("ggLater").onclick = () => { lsSet("team-gcal-guide", dk(today())); closeGcalGuide(); toast("設定画面の「連携の手順を開く」から、いつでも見られます"); };
$("ggClose").onclick = closeGcalGuide; $("ggScrim").onclick = closeGcalGuide;
$("ggCopy").onclick = async () => {
  try { await navigator.clipboard.writeText(ADMIN_EMAIL); toast("コピーしました：" + ADMIN_EMAIL); }
  catch (_) { const s = getSelection(), rg = document.createRange(); rg.selectNodeContents($("gcalGuide").querySelector(".gg-mail")); s.removeAllRanges(); s.addRange(rg); toast("選択しました。コピーしてください"); }
};
function saveGcalEmail(v) {
  v = String(v || "").trim();
  if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { toast("アドレスの形が正しくありません"); return; }
  updateDoc(doc(db, "members", U), {gcalEmail: v}).then(() => toast("保存しました。15分以内に確認されます")).catch(e => toast(errMsg(e)));
}
$("saveGcal").onclick = () => saveGcalEmail($("gcalEmail").value);
$("ggSave").onclick = () => saveGcalEmail($("ggEmail").value);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("gcalGuide").hidden) closeGcalGuide(); });
$("myCloser").onchange = () => {
  const v = $("myCloser").checked;   // 押した瞬間の状態で決める（保存中に表示が戻ることがあるため）
  updateDoc(doc(db, "members", U), {closer: v}).then(() => {
    toast(v ? "クローザーに入りました" : "クローザーから外れました");
    if (v && !gcalLinked()) { lsSet("team-gcal-guide", dk(today())); openGcalGuide(); }   // オンにしたら、そのまま連携の手順へ
  }).catch(e => toast(errMsg(e)));
};
/* ============================================================
   前のカウンター（karte/counter/）からの引っ越し
   前のカウンターは同じサイトなので、この端末のブラウザに残っている記録
   （localStorage "kekka-counter-v1" = [{t: 押した時刻(ミリ秒), r: 結果}]）をそのまま読める。
   ・1件ずつ records（src:"old"）にして stats/{日} に足す → KPI・1時間あたり・稼働・履歴に、その日の分として出る
   ・アポでも日時・クローザーの記録が無いので、カレンダーや「日時未定のアポ」には出さない
   ・チーム版でも数えている日は、チーム版で数えていた時間（その日の最初〜最後の記録）の外の分だけを足す候補にして、
     足すかどうかを日ごとに選べる（両方で押した分を二重にしない）
   ・二重に足さない：imports/{uid}.days[日] = {n: 足した件数, last: 最後に足した時刻, done, skip}。
     記録・集計と同じトランザクションで書くので、途中で切れても続きから。ほかのタブで同時に押しても、印が合わなければ止める
   ・今日の分は done にしない（このあと前のカウンターで押した分も、次に開いたときに足せる）。過ぎた日で足すものが無い日は done
   ・前のカウンターの記録は消さない。引っ越した人をこのブラウザに覚えておき（ほかの人のアカウントには出さない）、
     前のカウンターの画面に「引っ越し済み」を出す
   ============================================================ */
const OLD_KEY = "kekka-counter-v1", MOVED_KEY = "kekka-counter-moved-v1", MOVE_SKIP = "team-move-skip";
const OLD_RENAME = {"使われていない": "使われてない"};   // チーム版で名前が違う項目
const MOVE_CHUNK = 400;                                  // 1回のトランザクションで入れる件数
let movePlan = null, moving = false;
/* 前のカウンターの項目名 → チーム版の項目名。名前の違う項目と、
   チーム版で「NG（業者系）」のように後ろに説明を足した項目は、チーム版の名前に合わせる */
function teamName(r) {
  if (COL[r]) return r;
  if (OLD_RENAME[r] && COL[OLD_RENAME[r]]) return OLD_RENAME[r];
  const hit = ITEMS.filter(i => i.k.startsWith(r + "（") || i.k.startsWith(r + "("));
  return hit.length === 1 ? hit[0].k : (OLD_RENAME[r] || r);
}
function oldEntries() {
  const raw = lsGet(OLD_KEY, []);
  if (!Array.isArray(raw)) return [];
  const lim = Date.now() + 6e4;
  return raw.filter(e => e && Number.isFinite(e.t) && e.t > 0 && e.t <= lim && typeof e.r === "string" && e.r.trim())
    .map(e => { const o = e.r.trim().slice(0, 30); return {t: e.t, o, r: teamName(o)}; })
    .filter(e => !/^__.*__$/.test(e.r))
    .sort((a, b) => a.t - b.t);
}
/* 日ごとに「何件足すか」を決める。足す件数・理由を画面に出す */
async function buildMovePlan() {
  const mv = lsGet(MOVED_KEY, null);
  if (mv && mv.uid && mv.uid !== U) return {rows: [], add: 0, has: true, owner: mv.name || "ほかの人"};   // このブラウザの記録は、別の人が引っ越し済み
  const list = oldEntries();
  if (!list.length) return {rows: [], add: 0, has: false};
  const byDay = {};
  list.forEach(e => { const d = dk(new Date(e.t)); (byDay[d] = byDay[d] || []).push(e); });
  const keys = Object.keys(byDay).sort(), T = dk(today());
  const mk = await getDoc(doc(db, "imports", U));
  const prog = (mk.exists() && mk.data().days) || {};
  const todo = keys.filter(d => !(prog[d] && prog[d].done));
  const st = {};
  if (todo.length) {
    const s = await getDocs(query(collection(db, "stats"), where(documentId(), ">=", todo[0]), where(documentId(), "<=", todo[todo.length - 1])));
    s.forEach(d => st[d.id] = d.data());
  }
  const rows = [], settle = {};
  for (const d of keys) {
    const p = prog[d], all = byDay[d];
    if (p && p.done) { rows.push({day: d, all: all.length, add: [], st: p.skip ? "skip" : "done", before: p.n || 0}); continue; }
    const before = p ? p.n || 0 : 0, last = p && p.last ? p.last : 0;
    const cand = all.filter(e => e.t > last);   // まだ足していない分
    const mine = Object.values(((st[d] || {}).c || {})[U] || {}).reduce((a, v) => a + v, 0) - before;
    let win = null;
    if (cand.length && mine > 0) {   // この日はチーム版でも数えている → チーム版で数えていた時間の外だけ
      const s = await getDocs(query(collection(db, "records"), where("uid", "==", U), where("day", "==", d)));
      const ts = s.docs.map(x => x.data()).filter(x => x.src !== "old").map(x => tsd(x.t)).filter(Boolean).map(x => x.getTime());
      if (ts.length) win = {from: Math.min(...ts), to: Math.max(...ts), n: ts.length};
    }
    const add = win ? cand.filter(e => e.t < win.from || e.t > win.to) : cand;
    if (!add.length && d < T) settle[d] = {done: true};   // 過ぎた日で足すものが無い → 次からは読まない
    rows.push({day: d, all: all.length, add, before, last, win, inWin: cand.length - add.length, st: add.length ? "add" : before ? "done" : "none", pick: true});
  }
  if (Object.keys(settle).length) setDoc(doc(db, "imports", U), {days: settle}, {merge: true}).catch(() => {});
  return {rows, add: rows.reduce((a, r) => a + r.add.length, 0), has: true};
}
async function refreshMove() {
  if (!U || !me || me.status !== "active" || moving) return;
  if (!itemsLoaded) { setTimeout(refreshMove, 1000); return; }   // 項目名を合わせるので、項目が届いてから
  const who = U;
  let plan = null;
  try { plan = await buildMovePlan(); } catch (e) { console.error("引っ越しの確認", e); }
  if (U !== who) return;   // 確かめている間に別の人に替わった
  movePlan = plan;
  renderMoveNag();
}
function renderMoveNag() {
  const p = movePlan, n = p ? p.add : 0;
  const days = p ? p.rows.filter(r => r.add.length).map(r => r.day) : [];
  $("moveNag").hidden = !n || !!lsGet(MOVE_SKIP, false);
  if (n) $("moveNag").innerHTML = `<span class="mt">📦 前のカウンターの記録が <b class="num">${n}</b>件あります（${days.map(d => md(new Date(d + "T00:00"))).join("・")}）</span><span class="mg">チーム版に引っ越す ›</span>`;
  $("moveState").textContent = !p ? "確かめています…" : p.owner ? "このブラウザの前の記録は、" + p.owner + "さんが引っ越し済みです"
    : !p.has ? "この端末のブラウザには、前のカウンターの記録がありません"
    : n ? "まだ引っ越していない記録が " + n + "件あります" : "引っ越し済みです（前のカウンターの記録は、そのまま残してあります）";
  $("openMove").hidden = !p || !p.has || !!p.owner;
}
const movePicked = () => movePlan ? movePlan.rows.filter(r => r.add.length && r.pick) : [];
function renderMoveGo() {
  const n = movePicked().reduce((a, r) => a + r.add.length, 0);
  $("mvCount").textContent = n ? n + "件" : "";
  $("mvGo").disabled = !n;
  $("mvGo").textContent = n ? "引っ越す" : movePlan && movePlan.add ? "足す日を選んでください" : "済んでいます";
}
function openMove() {
  const p = movePlan; if (!p || p.owner) return;
  const adds = p.rows.flatMap(r => r.add);
  const extra = [...new Set(adds.map(e => e.r))].filter(k => !COL[k]);
  const renamed = {}; adds.forEach(e => { if (e.o !== e.r) renamed[e.o] = e.r; });
  const span = w => w.from === w.to ? hm(new Date(w.from)) : hm(new Date(w.from)) + "〜" + hm(new Date(w.to));
  $("mvRows").innerHTML = p.rows.slice().reverse().map(r => {
    const d = new Date(r.day + "T00:00");
    const apo = r.add.filter(e => e.r === "アポ").length;
    const v = r.st === "skip" ? `<span class="mv-why">足さないことにした日です</span>`
      : r.st === "done" ? (r.before ? `<span class="badge done">引っ越し済み</span>` : `<span class="mv-why">足すものはありません</span>`)
      : r.st === "none" ? `<span class="mv-why">${r.win ? "チーム版で数えた時間（" + span(r.win) + "）と重なるので足しません" : "足すものはありません"}</span>`
      : `<b class="num">${r.add.length}</b>件を足す${apo ? `<small>（アポ ${apo}）</small>` : ""}` +
        (r.win ? `<span class="mv-why">この日はチーム版でも ${r.win.n}件 数えています（${span(r.win)}）。${r.inWin ? "その時間の " + r.inWin + "件は二重になるので足しません。" : ""}</span>` +
          `<label class="mv-pick"><input type="checkbox" data-day="${esc(r.day)}"${r.pick ? " checked" : ""}> この日を足す</label>` : "") +
        (r.before ? `<span class="mv-why">前回の続きから（${r.before}件は済み）</span>` : "");
    return `<div class="mv-row"><span class="mv-d">${md(d)}${r.day === dk(today()) ? "（今日）" : ""}</span><span class="mv-v">${v}</span></div>`;
  }).join("");
  $("mvWho").textContent = p.add ? "「" + ((me && me.name) || "") + "」さんの記録として入れます。" : "";
  $("mvNote").innerHTML = [
    Object.keys(renamed).map(k => `「${esc(k)}」は「${esc(renamed[k])}」として入れます。`).join(""),
    extra.length ? `チーム版のボタンに無い項目（${extra.map(esc).join("・")}）は、その名前のまま架電数とKPIの内訳に入ります。` : ""
  ].filter(Boolean).join("<br>");
  $("mvNote").hidden = !$("mvNote").innerHTML;
  $("mvSkip").hidden = !p.add;
  renderMoveGo();
  $("mvScrim").hidden = $("moveDlg").hidden = false;
}
$("mvRows").onchange = e => {
  const c = e.target.closest("input[data-day]"); if (!c || !movePlan) return;
  const r = movePlan.rows.find(x => x.day === c.dataset.day); if (r) r.pick = c.checked;
  renderMoveGo();
};
function closeMove() { if (moving) return; $("mvScrim").hidden = $("moveDlg").hidden = true; }
async function runMove() {
  const plan = movePlan, rows = movePicked();
  const total = rows.reduce((a, r) => a + r.add.length, 0);
  if (moving || !plan || !total) return;
  if (!navigator.onLine) { toast("オフラインです。つながってからもう一度押してください"); return; }
  const who = U, T = dk(today()), markRef = doc(db, "imports", who);
  moving = true; $("mvGo").disabled = true; $("mvSkip").hidden = true; $("mvClose").disabled = true;
  let doneAll = 0, failed = null;
  const inc = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, increment(v)]));
  try {
    for (const row of rows) {
      let n = row.before, last = row.last;
      for (let i = 0; i < row.add.length; i += MOVE_CHUNK) {
        if (U !== who) throw new Error("USER");
        const part = row.add.slice(i, i + MOVE_CHUNK), end = i + MOVE_CHUNK >= row.add.length;
        const wasN = n, wasLast = last, newLast = part[part.length - 1].t;
        $("mvGo").textContent = `引っ越し中… ${doneAll}/${total}`;
        await runTransaction(db, async tx => {
          const s = await tx.get(markRef);
          const cur = s.exists() && s.data().days ? s.data().days[row.day] : null;
          if ((cur ? cur.last || 0 : 0) !== wasLast || (cur && cur.done)) throw new Error("MOVED");   // ほかで進んだ → 止める
          const c = Object.create(null), h = Object.create(null), m = Object.create(null);   // 項目名をそのままキーにするので素の入れ物で
          part.forEach(e => {
            const t = new Date(e.t), hour = t.getHours(), mb = mbOf(t);
            tx.set(doc(collection(db, "records")), {uid: who, r: e.r, t: Timestamp.fromDate(t), day: row.day, hour, mb, memo: null, undated: false, pending: false, done: false, slotId: null, src: "old"});
            c[e.r] = (c[e.r] || 0) + 1; h[hour] = (h[hour] || 0) + 1; m[mb] = (m[mb] || 0) + 1;
          });
          tx.set(doc(db, "stats", row.day), {c: {[who]: inc(c)}, h: {[who]: inc(h)}, m: {[who]: inc(m)}}, {merge: true});
          tx.set(markRef, {days: {[row.day]: {n: wasN + part.length, last: newLast, done: end && row.day < T,
            from: row.win ? row.win.from : null, to: row.win ? row.win.to : null, at: serverTimestamp()}}}, {merge: true});
        });
        n = wasN + part.length; last = newLast; doneAll += part.length;
        lsSet(MOVED_KEY, {uid: who, name: (me && me.name) || "", at: Date.now()});   // このブラウザの記録は、この人のもの
      }
    }
    /* 「この日を足す」を外した日は、次から聞かない */
    const skip = {};
    plan.rows.filter(r => r.add.length && !r.pick).forEach(r => skip[r.day] = {done: true, skip: true});
    if (Object.keys(skip).length) await setDoc(markRef, {days: skip}, {merge: true});
  } catch (e) { console.error("引っ越し", e); failed = e; }
  moving = false; $("mvClose").disabled = false;
  Object.keys(statCache).forEach(k => delete statCache[k]);
  refreshHistSoon();
  if (failed) toast(failed.message === "MOVED" ? "ほかの画面で引っ越しが進んでいました。もう一度確かめます"
    : failed.message === "USER" ? "ログインしている人が替わったので止めました"
    : (doneAll ? doneAll + "件まで入れました。" : "") + errMsg(failed) + "。もう一度押すと続きから入れます");
  else toast(doneAll + "件を引っ越しました");
  if (!failed) { closeMove(); if (curTab === "kpi") renderKpi(); }
  await refreshMove();
  if (failed && !$("moveDlg").hidden) { if (movePlan && !movePlan.owner) openMove(); else closeMove(); }
}
$("moveNag").onclick = openMove;
$("openMove").onclick = openMove;
$("mvGo").onclick = runMove;
$("mvClose").onclick = closeMove; $("mvScrim").onclick = closeMove;
$("mvSkip").onclick = () => { lsSet(MOVE_SKIP, true); closeMove(); renderMoveNag(); toast("設定画面の「前のカウンターから引っ越す」から、いつでも引っ越せます"); };
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("moveDlg").hidden) closeMove(); });

$("appUrl").textContent = APP_URL + "?openExternalBrowser=1";
$("copyUrl").onclick = async () => {
  try { await navigator.clipboard.writeText(APP_URL + "?openExternalBrowser=1"); toast("リンクをコピーしました"); }
  catch (_) { const r = document.createRange(); r.selectNodeContents($("appUrl")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("選択しました。コピーしてください"); }
};
/* ============================================================
   フィードバック：全員が送れる → 竹内さん（管理者）にだけ届く
   feedback/{id} = {uid, name, kind, text, page, env, ver, status: open/done, reply, createdAt}
   送った人は自分の分と返事だけ見られる。ほかの人の分は見えない（ルールでも）
   ============================================================ */
const APP_VER = new URL(import.meta.url).searchParams.get("v") || "?";
let fbAll = [], fbKind = "不具合", fbF = "open";
function startFeedback() {
  const q = me && me.role === "admin" ? collection(db, "feedback") : query(collection(db, "feedback"), where("uid", "==", U));
  unsubs.push(onSnapshot(q, s => {
    fbAll = s.docs.map(d => ({id: d.id, ...d.data(), createdAt: tsd(d.data().createdAt) || new Date()})).sort((a, b) => b.createdAt - a.createdAt);
    renderFeedback(); renderAdmin();
  }, onErr("フィードバック")));
}
$("fbKinds").onclick = e => {
  const b = e.target.closest("button"); if (!b) return; fbKind = b.dataset.k;
  $("fbKinds").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b));
  $("fbNote").hidden = fbKind !== "不具合";
};
$("fbSend").onclick = async () => {
  const text = $("fbText").value.trim();
  if (!text) { toast("内容を書いてください"); $("fbText").focus(); return; }
  const env = fbKind === "不具合" ? `${navigator.userAgent} / 画面 ${innerWidth}x${innerHeight}` + (matchMedia("(display-mode: standalone)").matches ? " / ホーム画面から" : "") : "";
  $("fbSend").disabled = true;
  try {
    await setDoc(doc(collection(db, "feedback")), {uid: U, name: (me && me.name) || "", kind: fbKind, text, page: curTab, env, ver: APP_VER, status: "open", createdAt: serverTimestamp()});
    $("fbText").value = "";
    toast("送りました。ありがとうございます！");
  } catch (e) { toast(errMsg(e)); }
  finally { $("fbSend").disabled = false; }
};
$("fbFilter").onclick = e => { const b = e.target.closest("button"); if (!b) return; fbF = b.dataset.f; $("fbFilter").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderFeedback(); };
const fbChip = k => `<span class="fb-kind k-${k === "不具合" ? "bug" : k === "こうしてほしい" ? "req" : "etc"}">${esc(k)}</span>`;
const fbWhen = d => md(d) + " " + hm(d);
function renderFeedback() {
  const admin = me && me.role === "admin";
  /* 自分が送ったもの（返事も見える） */
  const mine = fbAll.filter(f => f.uid === U);
  $("fbMineBox").hidden = !mine.length;
  $("fbMine").innerHTML = mine.slice(0, 20).map(f => `<div class="fb-item">
      <div class="fb-head">${fbChip(f.kind)}<span class="fb-date">${fbWhen(f.createdAt)}</span><span class="badge ${f.status === "done" ? "done" : "pend"}">${f.status === "done" ? "対応済み" : "確認待ち"}</span></div>
      <div class="fb-text">${esc(f.text)}</div>
      ${f.reply ? `<div class="fb-reply"><b>竹内さんから：</b>${esc(f.reply)}</div>` : ""}</div>`).join("");
  if (!admin) return;
  /* 管理者：届いたもの */
  const open = fbAll.filter(f => f.status !== "done");
  $("fbCount").textContent = "未対応 " + open.length + "件";
  const list = fbF === "open" ? open : fbAll;
  const box = $("fbInbox");
  if (!list.length) { box.innerHTML = `<div class="empty">${fbF === "open" ? "未対応のフィードバックはありません" : "まだ届いていません"}</div>`; return; }
  box.innerHTML = list.slice(0, 50).map(f => `<div class="fb-item${f.status === "done" ? " is-done" : ""}" data-id="${esc(f.id)}">
      <div class="fb-head">${fbChip(f.kind)}<b>${esc(f.name || nameOf(f.uid))}</b><span class="fb-date">${fbWhen(f.createdAt)}</span>${f.status === "done" ? `<span class="badge done">対応済み</span>` : ""}</div>
      <div class="fb-text">${esc(f.text)}</div>
      ${f.env || f.page ? `<div class="fb-env">見ていた画面：${esc(f.page || "")}${f.ver ? "（版 " + esc(f.ver) + "）" : ""}${f.env ? "<br>" + esc(f.env) : ""}</div>` : ""}
      <div class="fb-replybox"><input type="text" class="fb-in" maxlength="300" placeholder="返事（送った人に見えます）" value="${esc(f.reply || "")}">
        <button class="fb-btn" data-a="reply">返事</button>
        <button class="fb-btn ${f.status === "done" ? "" : "ok"}" data-a="toggle">${f.status === "done" ? "未対応に戻す" : "対応済みにする"}</button></div>
    </div>`).join("");
}
$("fbInbox").onclick = e => {
  const b = e.target.closest("button.fb-btn"); if (!b) return;
  const item = b.closest(".fb-item"), id = item.dataset.id, f = fbAll.find(x => x.id === id); if (!f) return;
  const ref = doc(db, "feedback", id);
  if (b.dataset.a === "reply") {
    const reply = item.querySelector(".fb-in").value.trim();
    updateDoc(ref, {reply, repliedAt: serverTimestamp()}).then(() => toast(reply ? "返事を保存しました" : "返事を消しました")).catch(er => toast(errMsg(er)));
  }
  if (b.dataset.a === "toggle") updateDoc(ref, {status: f.status === "done" ? "open" : "done"}).catch(er => toast(errMsg(er)));
};

function renderAdmin() {
  const admin = me && me.role === "admin";
  const pend = Object.entries(members).filter(([, m]) => m.status === "pending");
  /* 設定タブの赤い数字＝承認待ち＋未対応のフィードバック（管理者だけ） */
  const fbOpen = admin ? fbAll.filter(f => f.status !== "done").length : 0;
  $("setDot").hidden = !(admin && pend.length + fbOpen); $("setDot").textContent = pend.length + fbOpen;
  if (!admin) return;
  $("pendCount").textContent = pend.length + "人";
  $("pendList").innerHTML = pend.length ? pend.map(([id, m]) => `<div class="row mrow"><div class="t">${esc(m.name)}<small>${esc(m.email)}${m.closer ? " ・ クローザー希望" : ""}</small></div>
    <div class="acts2"><button class="ok" data-a="ok" data-id="${esc(id)}">承認</button><button class="ng" data-a="rej" data-id="${esc(id)}">却下</button></div></div>`).join("")
    : `<div class="row"><div class="t"><small>承認待ちの人はいません</small></div></div>`;
  const act = Object.entries(members).filter(([, m]) => m.status !== "pending").sort((a, b) => (a[1].status === "removed") - (b[1].status === "removed"));
  $("memCount").textContent = act.filter(([, m]) => m.status === "active").length + "人";
  $("memList").innerHTML = act.map(([id, m]) => `<div class="row mrow"><div class="avatar" style="background:${colorOf(id)};width:28px;height:28px;font-size:12px">${esc((m.name || "?")[0])}</div>
    <div class="t">${esc(m.name)}${m.role === "admin" ? "（管理者）" : ""}${m.status === "removed" ? ` <span class="badge pend">外した人</span>` : ""}<small>${esc(m.email)}${m.closer ? (busyMap[id] ? (busyMap[id].status === "ok" ? " ・ Googleカレンダー連携中" : " ・ Googleカレンダー未共有") : "") : ""}</small></div>
    <div class="acts2">${m.status === "active" ? `<button data-a="closer" data-id="${esc(id)}" aria-pressed="${!!m.closer}" class="${m.closer ? "ok" : ""}">${m.closer ? "クローザー" : "クローザーにする"}</button>` : ""}
    ${m.role !== "admin" ? (m.status === "active" ? `<button class="ng" data-a="rm" data-id="${esc(id)}">外す</button>` : `<button data-a="back" data-id="${esc(id)}">戻す</button>`) : ""}</div></div>`).join("");
}
document.addEventListener("click", e => {
  const b = e.target.closest("#pendList button, #memList button"); if (!b) return;
  const id = b.dataset.id, a = b.dataset.a, ref = doc(db, "members", id), m = members[id] || {};
  const arm = label => { if (b.dataset.arm) return true; b.dataset.arm = "1"; const o = b.textContent; b.textContent = label; setTimeout(() => { if (b.isConnected) { delete b.dataset.arm; b.textContent = o; } }, 2500); return false; };
  if (a === "ok") updateDoc(ref, {status: "active"}).then(() => toast(m.name + "さんを承認しました")).catch(er => toast(errMsg(er)));
  if (a === "rej" && arm("本当に却下")) deleteDoc(ref).then(() => toast("却下しました")).catch(er => toast(errMsg(er)));
  if (a === "rm" && arm("本当に外す")) updateDoc(ref, {status: "removed"}).then(() => toast(m.name + "さんを外しました")).catch(er => toast(errMsg(er)));
  if (a === "back") updateDoc(ref, {status: "active"}).then(() => toast(m.name + "さんを戻しました")).catch(er => toast(errMsg(er)));
  if (a === "closer") updateDoc(ref, {closer: !m.closer}).catch(er => toast(errMsg(er)));
});

/* 結果の項目の編集（管理者） */
let draftItems = [];
$("editItems").onclick = () => { draftItems = ITEMS.map(i => ({...i, open: false})); drawItems(); $("itemSheet").hidden = false; };
$("itemCancel").onclick = () => $("itemSheet").hidden = true;
$("addItem").onclick = () => { const [bg, fg] = PALETTE[draftItems.length % PALETTE.length]; draftItems.push({k: "", bg, fg, open: false}); drawItems(); const ins = document.querySelectorAll("#itemList input"); ins[ins.length - 1].focus(); };
function drawItems() {
  const box = $("itemList"); box.innerHTML = "";
  draftItems.forEach((it, i) => {
    const wrap = document.createElement("div"); wrap.className = "item";
    const row = document.createElement("div"); row.className = "item-row";
    const sw = document.createElement("button"); sw.className = "swatch"; sw.style.background = it.bg; sw.style.color = it.fg; sw.textContent = "色";
    sw.onclick = () => { draftItems.forEach((d, j) => d.open = j === i ? !d.open : false); drawItems(); };
    const inp = document.createElement("input"); inp.value = it.k; inp.maxLength = 20; inp.placeholder = "項目の名前"; inp.oninput = () => { it.k = inp.value; inp.classList.remove("bad"); };
    const mk = (t, dis, f, cls) => { const b = document.createElement("button"); b.className = "ib" + (cls ? " " + cls : ""); b.textContent = t; b.disabled = dis; b.onclick = f; return b; };
    row.append(sw, inp,
      mk("↑", i === 0, () => { [draftItems[i - 1], draftItems[i]] = [draftItems[i], draftItems[i - 1]]; drawItems(); }),
      mk("↓", i === draftItems.length - 1, () => { [draftItems[i + 1], draftItems[i]] = [draftItems[i], draftItems[i + 1]]; drawItems(); }),
      mk("✕", false, () => { draftItems.splice(i, 1); drawItems(); }, "rm"));
    wrap.appendChild(row);
    if (it.open) {
      const pal = document.createElement("div"); pal.className = "pal";
      PALETTE.forEach(([bg, fg]) => { const p = document.createElement("button"); p.style.background = bg; p.style.color = fg; p.textContent = "あ"; if (bg === it.bg) p.className = "on"; p.onclick = () => { it.bg = bg; it.fg = fg; it.open = false; drawItems(); }; pal.appendChild(p); });
      wrap.appendChild(pal);
    }
    box.appendChild(wrap);
  });
}
$("itemSave").onclick = () => {
  draftItems.forEach(d => d.k = d.k.trim());
  const list = draftItems.filter(d => d.k);
  const seen = {}; let dup = null; list.forEach(d => { if (seen[d.k]) dup = d.k; seen[d.k] = 1; });
  if (dup) { toast("「" + dup + "」が2つあります"); return; }
  if (!list.length) { toast("項目が1つもありません"); return; }
  setDoc(doc(db, "config", "items"), {list: list.map(({k, bg, fg, strike}) => strike ? {k, bg, fg, strike: true} : {k, bg, fg})})
    .then(() => { $("itemSheet").hidden = true; toast("保存しました。全員の画面に反映されます"); }).catch(e => toast(errMsg(e)));
};
$("itemsNote").textContent = "全員のボタンが変わります";

/* ============================================================
   タブ
   ============================================================ */
const VIEWS = ["count", "log", "cal", "kpi", "remind", "set"];
let curTab = "count";
function showTab(v) {
  if (pickMode && v !== "cal") cancelPick();
  curTab = v;
  VIEWS.forEach(x => $("v-" + x).hidden = x !== v);
  document.querySelectorAll(".tabs button").forEach(b => { if (b.dataset.go === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  window.scrollTo(0, 0);
  if (v === "cal") renderCal(); if (v === "kpi") renderKpi(); if (v === "remind") renderRemind(); if (v === "log") { renderLog(); if (logMode === "hist") loadHist(false); } if (v === "set") { renderAdmin(); renderGcal(); renderFeedback(); if (movePlan) renderMoveNag(); else refreshMove(); }
}
document.addEventListener("click", e => { const b = e.target.closest("[data-go]"); if (b) showTab(b.dataset.go); });
COL = Object.fromEntries(ITEMS.map(i => [i.k, i]));
buildGrid();

/* 新しい版を出したら、開きっぱなしの画面も入れ替える。
   画面に戻ってきたときに新しい版を確かめ、入れ替わったら（入力中でなければ）読み込み直す */
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("./sw.js").then(reg => {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;                // 初めて入ったときは読み込み直さない
    const busy = () => ["msheet", "itemSheet", "taskSheet"].some(id => $(id) && !$(id).hidden);
    const go = () => { if (busy()) { setTimeout(go, 5000); return; } reloading = true; location.reload(); };
    go();
  });
}
