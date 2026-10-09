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
   ・変更履歴（最近の分。それより前は各所のコメントと project-kekka-counter.md）
       v50 2026-10-09 カレンダーの商談を押すと、リマインドから開いたときと同じ「記録の詳細」を出す（メモを編集・前確の予定・リスケ・取り消しが
                      同じ決まりで使える。社長「カレンダーの予定の編集もリマインド画面から予定を開いた時と同じ機能を追加して」）。
                      同じ時間に2件以上あるときは今までの一覧→行を押して詳細。「この時間にアポを追加」は詳細の中に残した。
                      ついでに：同じ日にリスケしたときも通知が出るよう、鳴らした印に日時を含めた（checkNotifs）／
                      リスケで「おまかせ」のまま日時もクローザーも変わらないときは何も書かない（管理者に「権限がありません」が出ていた。saveResched）
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, query, where, orderBy, documentId, onSnapshot, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  writeBatch, runTransaction, increment, Timestamp, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
/* 会社ごとの設定（2026-10-03 他社版）。置き場（/karte/team/・/karte/team2/ …）ごとに firebase-config.js だけが違う。
   * で読むのは、古い firebase-config.js（TENANT が無い）がとっておかれていても止まらないように */
import * as CFG from "./firebase-config.js";
const firebaseConfig = CFG.firebaseConfig;
const TENANT = CFG.TENANT || {};
const LS = TENANT.ls || "";                          // この端末に覚えておく物の名前の頭（同じサイトのほかの会社の分と混ぜない）
const PRE_LABEL = TENANT.preLabel || "10月より前";    // KPIに数えない「アプリを使う前に取った案件」の呼び方

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
/* ボタンの意味（迷ったときの目安）。項目の編集で説明を書けば、そちらが優先 */
const DEFAULT_DESC = {
  "留守": "誰も出なかった（呼び出し音だけ・留守番電話）",
  "受けブロ": "受付やスタッフに止められて、オーナーにつないでもらえなかった",
  "オーナー断り": "オーナー（決める人）と話せたけど、断られた",
  "接客中": "出た人に「接客中・手が離せない」と言われた（あとでかけ直す）",
  "ガチャ切り": "話の途中で一方的に切られた",
  "使われてない": "「この番号は使われていません」と流れた（閉店・番号ちがい）",
  "オーナー不在": "「オーナーは今いない・休み・外出中」と言われた",
  "繋がらない": "話し中・電波が届かない・すぐ切れるなどで、つながらなかった",
  "アポ": "商談の約束が取れた → 日時とクローザーを入れる",
  "本社管理": "「本社（本部）が決めているので、店では決められない」と言われた",
  "NG（業者系）": "「業者・営業の電話はお断り」と言われた（もうかけない）",
  "NG": "「もうかけてこないで」と言われた（もうかけない）",
  "再架電": "かけ直す約束をした・「また電話して」と言われた → 日時を入れるとリマインドが届く"
};
const descOf = it => (it.desc != null && it.desc !== "" ? it.desc : DEFAULT_DESC[it.k]) || "";
const PALETTE = [
  ["#E8EAED","#3C4043"], ["#D5D8DC","#3C4043"], ["#5F6368","#FFFFFF"],
  ["#BFE1F6","#0A53A8"], ["#C6DBE1","#215A6C"], ["#BDE7E0","#0B5B4F"], ["#D4EDBC","#11734B"],
  ["#FFD54F","#473822"], ["#FFC8AA","#753800"], ["#FFCFC9","#B10202"],
  ["#E6CFF2","#5A3286"], ["#E1D5C9","#5B4636"], ["#B10202","#FFFFFF"],
  ["#0A53A8","#FFFFFF"], ["#11734B","#FFFFFF"], ["#473822","#FFFFFF"]
];
const PEOPLE_COLORS = ["#1E4E86","#11734B","#8A4B08","#6B3FA0","#A33A5B","#0B6E7A","#5B6B1A","#9C3D10","#3D4F8F","#7A2E6E"];
/* クローザーの色。アポ可の枠が緑なので、緑は使わない（2026-10-06 社長「阪本さんと石川さんの予定の色が分かりにくい」。クローザーの緑が枠の緑とぶつかる） */
const CLOSER_COLORS = ["#2F6DB5","#C0561A","#7B4DB8","#B83B6B","#0E7F8C","#8A6A12"];
const KEYS = "1234567890qwertyuiop";
const SLOT_H0 = 10, SLOT_H1 = 22;          // アポ枠 10:00〜22:00・30分ごと・日曜休み

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
const lsGet = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (_) {} };
let tt;
/* 結果ボタンの意味の一覧 */
function openHelp() {
  $("hpList").innerHTML = ITEMS.map(it => `<div class="hp-row">${resChip(it.k)}<span>${esc(descOf(it) || "（説明はまだありません）")}</span></div>`).join("");
  $("hpScrim").hidden = $("helpDlg").hidden = false;
}
function closeHelp() { $("hpScrim").hidden = $("helpDlg").hidden = true; }
document.addEventListener("click", e => {
  if (e.target.closest("#openHelp")) openHelp();
  if (e.target.closest("#hpClose") || e.target.closest("#hpScrim")) closeHelp();
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("helpDlg").hidden) closeHelp(); });
/* toast(文, ボタン名, 押したとき, ボタン名2, 押したとき2 …)。ボタンはいくつでも */
function toast(msg, ...acts) {
  const ms = typeof acts[acts.length - 1] === "number" ? acts.pop() : 0;   // 最後に数を渡すと、その間（ミリ秒）出しておく
  const el = $("toast"); el.textContent = msg;
  for (let i = 0; i + 1 < acts.length; i += 2) {
    if (!acts[i]) continue;
    const b = document.createElement("button"), f = acts[i + 1]; b.textContent = acts[i];
    b.onclick = () => { el.classList.remove("on"); f(); }; el.appendChild(b);
  }
  el.classList.add("on"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("on"), ms || (acts.length > 2 ? 4500 : acts.length ? 3500 : 2200));
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
/* 外部クローザー（アプリにログインしない人。2026-10-06 阪本さん）。管理者が名簿に external:true で登録する。
   商談の担当（クローザー）にだけ出し、KPI・予定の担当・チームの人数には入れない */
const isExt = m => !!(m && m.external);
/* アポ可の枠のカレンダー（2026-10-06 石川さんの「ブロック」）。false＝枠の外も今まで通り入れられる（緑は目安）／true＝枠の中だけ入れられる */
const AVAIL_ONLY = !!TENANT.availOnly;
function colorOf(uid) {
  const ids = Object.keys(members).filter(id => !isExt(members[id]) || id === uid).sort();   // 外部クローザーを足しても、ほかの人の色が変わらないように
  const i = ids.indexOf(uid);
  return PEOPLE_COLORS[(i < 0 ? 0 : i) % PEOPLE_COLORS.length];
}
/* クローザーの並び＝自動で選ぶときの順番。社内の人が先、外部クローザーが後（社長「石川さん→阪本さん」2026-10-06）。
   名簿に closerOrder（数字）があればそれを優先 */
const closerRank = m => typeof m.closerOrder === "number" ? m.closerOrder : isExt(m) ? 1000 : 0;
function closerList() {
  const list = Object.entries(members).filter(([, m]) => m.status === "active" && m.closer)
    .sort((a, b) => closerRank(a[1]) - closerRank(b[1]) || (a[1].name || "").localeCompare(b[1].name || "", "ja"))
    .map(([id, m], i) => ({id, name: m.name, color: CLOSER_COLORS[i % CLOSER_COLORS.length], ext: isExt(m)}));
  return list.length ? list : [{id: "none", name: "担当未定", color: "#5F6368"}];
}
/* 見るだけのカレンダーの人（外部の人で、商談の担当ではない。2026-10-06 社長「阪本さんのカレンダーを見たいだけ」）。
   カレンダーの日表示に「（閲覧）」の列で予定ありだけ出す。アポは入れない・招待も送らない・おまかせの候補にもしない */
function viewList() {
  return Object.entries(members).filter(([, m]) => m.status === "active" && m.calView && !m.closer)
    .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || "", "ja"))
    .map(([id, m]) => ({id, name: m.name, color: "#9AA0A6", ext: true, view: true}));
}
const CNAME = id =>(closerList().find(c => c.id === id) || {name: id === "none" ? "担当未定" : nameOf(id)}).name;
const CCOL = id => (closerList().find(c => c.id === id) || {color: "#5F6368"}).color;
const OLD_BADGE = `<span class="badge old">前のカウンター</span>`;   // 前のカウンターから引っ越した記録の印
/* 10月より前（アプリを使う前）に取った案件。カレンダーには普通の商談と同じに入れるが、KPIに数えないので
   日ごとの集計（stats）には足さない。取った日は 9/30 として持つ（社長の指示 2026-10-02） */
const PRE_DAY = "2026-09-30";
const PRE_BADGE = `<span class="badge pre">${esc(PRE_LABEL)}</span>`;
$("mPreTxt").textContent = PRE_LABEL + "に取った案件（KPIに数えない）";
const CX_BADGE = `<span class="badge cx">キャンセル</span>`;
const isAdminMe = () => !!(me && me.role === "admin");
/* 予定を取り消せる人：アポを取った本人・管理者・そのアポのクローザー本人。
   「キャンセル」も「記録ごと消す」も3人とも使える（クローザーも記録ごと消せる＝社長の決定 2026-10-02「②でお願い」） */
const isCloserOf = r => r.r === "アポ" && !!(r.memo && r.memo.closer === U);
const canCancel = r => !r.isTask && (r.r === "アポ" || r.r === "再架電") && !r.canceled && (r.uid === U || isAdminMe() || isCloserOf(r));
const canErase = r => r.uid === U || isAdminMe() || isCloserOf(r);
/* 日時の無い記録の印：アポは「日時未定」、引っ越した再架電は「日時を入れる」（あとから入れられると分かるように） */
const noDateBadge = r => r.r === "アポ" ? `<span class="badge late">日時未定</span>` : r.src === "old" && r.r === "再架電" ? `<span class="badge pend">日時を入れる</span>` : "";
/* 自分の記録で、店名・電話・メモ・日時が何も無い → 押したら詳細ではなく入力画面を開く */
const needsInput = r => r.uid === U && !(r.memo && (r.memo.shop || r.memo.tel || r.memo.text || r.memo.when));
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
        await setDoc(doc(db, "members", u.uid), {name: "竹内", email: u.email, job: "管理職", closer: false, status: "active", role: "admin", createdAt: serverTimestamp()});
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

/* 役職（表示と、KPIの表に出すかどうかだけに使う。権限は role で別） */
const JOBS = ["プレイヤー", "事務", "管理職"];
const isPlayer = m => !m || (!isExt(m) && (!m.job || m.job === "プレイヤー"));   // まだ役職が無い人はプレイヤー扱い
let regJob = "プレイヤー";
$("regJob").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  regJob = b.dataset.j; $("regJob").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b));
};
$("btnRegister").onclick = async () => {
  const name = $("regName").value.trim();
  if (!name) { $("regErr").hidden = false; $("regErr").textContent = "名前を入れてください"; return; }
  $("btnRegister").disabled = true;
  try {
    await setDoc(doc(db, "members", U), {name, email: auth.currentUser.email, job: regJob, closer: $("regCloser").checked, status: "pending", role: "member", createdAt: serverTimestamp()});
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
    const spans = a => (a || []).map(b => ({s: tsd(b.s), e: tsd(b.e)})).filter(b => b.s && b.e);
    const deals = a => (a || []).map(b => ({s: tsd(b.s), e: tsd(b.e), t: String(b.t || ""), p: String(b.p || ""), m: String(b.m || "")})).filter(b => b.s && b.e);
    s.forEach(d => { const x = d.data(); busyMap[d.id] = {...x, updatedAt: tsd(x.updatedAt), blocks: spans(x.blocks), avail: spans(x.avail), deals: deals(x.deals)}; });
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
  if (TENANT.move !== false) setTimeout(() => { if (!lsGet(MOVE_SKIP, false)) refreshMove(); }, 1500);   // 前のカウンターの記録がこのブラウザに残っていれば、引っ越しの案内を出す（自社だけ）
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
  const act = Object.values(members).filter(m => m.status === "active" && !isExt(m)).length;
  $("teamName").textContent = "チーム " + (act || 1) + "人";
  $("todayLbl").textContent = md(today());
  $("myMail").textContent = auth.currentUser ? auth.currentUser.email : "";
  if (document.activeElement !== $("myName")) $("myName").value = me.name || "";
  $("myJob").textContent = me.job || "未設定";
  $("myJobNote").textContent = me.role === "admin" ? "上の「メンバー」の欄で変えられます（自分の分も）" : "変えるときは管理者（竹内さん）に伝えてください";
  $("myCloser").checked = !!me.closer;
  renderGcal();
  $("adminBox").hidden = me.role !== "admin";
  $("lineBox").hidden = me.role !== "admin" || TENANT.line === false;   // 準備中の事情はメンバーには見せない。他社版には出さない
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
    if (descOf(it)) b.title = descOf(it);   // PCはマウスを乗せると意味が出る
    grid.appendChild(b);
  });
  /* PC（マウスのある機械）だけ、キーボードでも押せることを一行で知らせる */
  const ks = KEYS.slice(0, ITEMS.length).toUpperCase();
  $("keyHelp").textContent = ks ? "キーボードの " + (ks.length <= 10 ? "1〜" + ks.slice(-1) : "1〜0・" + ks.slice(10).split("").join("・")) + " でも押せます／Backspace でひとつ戻す" : "";
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
  const rec = {...data, id: ref.id, t, fresh: true};   // fresh＝押した直後に開いたシート（押し間違いを取り消せる）
  if (k === "アポ" || k === "再架電") openMemo(rec);
  else toast(k + " +1",
    "取り消す", () => undoRec(rec, k),
    "メモを付ける", () => openMemo(myToday.find(r => r.id === rec.id) || rec));
}
/* 消した記録の番号を覚えておく（「ひとつ戻す」のあとにトーストの「取り消す」を押したなど、
   同じ記録を二度消して集計だけ二重に引かないように） */
const deletedIds = new Set();
function undoRec(rec, k) {
  if (deletedIds.has(rec.id)) { toast("もう取り消されています"); return; }
  deleteRec(myToday.find(r => r.id === rec.id) || rec).then(() => toast("「" + k + "」を取り消しました")).catch(e => toast(errMsg(e)));
}
function deleteRec(rec) {
  if (deletedIds.has(rec.id)) return Promise.resolve();
  deletedIds.add(rec.id);
  const b = writeBatch(db);
  b.delete(doc(db, "records", rec.id));
  if (!rec.pre) b.set(doc(db, "stats", rec.day), statInc(rec.uid, rec.r, rec.hour, -1, rec.mb), {merge: true});   // 10月より前の案件は元から数えていない
  if (rec.slotId) b.delete(doc(db, "slots", rec.slotId));
  return b.commit().catch(e => { deletedIds.delete(rec.id); throw e; });   // 失敗したら、もう一度消せるように
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
  /* 対応＝電話に出てもらった数（KPIの「対応数」と同じ。留守・繋がらない・使われてない以外）。渡邉さんのフィードバック 2026-10-03「応答した数も」 */
  const ans = n - NO_ANSWER.reduce((a, k) => a + (c[k] || 0), 0);
  $("cSide").innerHTML = `アポ <b>${apo}</b>　再架電 <b>${c["再架電"] || 0}</b>　<span title="電話に出てもらった数（留守・繋がらない・使われてない以外）">対応 <b>${ans}</b></span><br>アポ率 <b>${n ? (apo / n * 100).toFixed(1) : "0.0"}%</b>　対応率 <b>${n ? (ans / n * 100).toFixed(1) : "0.0"}%</b>`;
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
  if (!started || curTab !== "count" || !$("itemSheet").hidden || e.isComposing || e.altKey || e.metaKey) return;
  if (document.querySelector('[role="dialog"]:not([hidden])')) return;   // 手順・今日の予定・詳細などの画面が出ている間は、後ろで +1 や「戻す」をしない
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
    const [s, sp] = await Promise.all([
      getDocs(query(collection(db, "records"), where("uid", "==", U), where("r", "in", ["アポ", "再架電"]),
        where("day", ">=", dk(from)), where("day", "<", dk(to)), orderBy("day", "desc"))),
      /* 10月より前に取った案件は取った日を 9/30 として持つので、期間に関係なく最初にまとめて読む */
      more ? null : getDocs(query(collection(db, "records"), where("uid", "==", U), where("pre", "==", true))).catch(() => null)]);
    const got = s.docs.map(recOf);
    if (sp) sp.docs.map(recOf).forEach(r => { if (!got.some(g => g.id === r.id)) got.push(r); });
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
  all.forEach(r => { const k = r.pre ? "pre" : r.day; (byDay[k] = byDay[k] || []).push(r); });   // 10月より前の案件は、取った日が分からないので一番下にまとめる
  const days = Object.keys(byDay).filter(k => k !== "pre").sort().reverse().concat(byDay.pre ? ["pre"] : []);
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
    const h = document.createElement("h2");
    h.innerHTML = `${k === "pre" ? esc(PRE_LABEL) + "に取った案件" : md(new Date(k + "T00:00")) + (k === dk(today()) ? "（今日）" : "")} <span class="aside">${a ? "アポ" + a : ""}${a && c ? "・" : ""}${c ? "再架電" + c : ""}${k === "pre" ? "（KPIに数えない）" : ""}</span>`;
    body.appendChild(h);
    const card = document.createElement("div"); card.className = "card";
    list.forEach(r => {
      const m = r.memo || {}, w = m.when;
      let st = "";
      if (r.canceled) st = CX_BADGE;
      else if (r.src === "old" && !w) st = noDateBadge(r) + OLD_BADGE;
      else if (r.r === "アポ") st = !w ? `<span class="badge late">日時未定</span>` : w < now ? `<span class="badge done">面談済み</span>` : "";
      else st = r.done ? `<span class="badge done">かけた</span>` : w && w < now ? `<span class="badge late">期限切れ</span>` : !w ? `<span class="badge pend">日時なし</span>` : "";
      if (r.pre) st += PRE_BADGE;
      const row = document.createElement("div"); row.className = "rec hrow tap"; row.tabIndex = 0;
      row.innerHTML = `<span class="tm">${r.pre ? "—" : hm(r.t)}</span><span class="body">${resChip(r.r)}${w ? `<span class="when">${r.r === "アポ" ? "面談" : "再架電"} ${md(w)} ${hm(w)}</span>` : ""}${st}
        <div class="memo"><b>${esc(m.shop || "（店名なし）")}</b>${m.tel ? `　<span class="tel-line num">☎ ${esc(m.tel)}</span>` : ""}</div>
        ${m.text ? `<div class="memo">${esc(m.text)}</div>` : ""}</span>`;
      row.onclick = () => needsInput(r) ? openMemo(r) : openDetail(r);   // 何も入っていない（引っ越した記録など）は入力画面へ
      row.onkeydown = e => { if (e.key === "Enter") row.onclick(); };
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
    const when = (w ? `<span class="when">${r.r === "アポ" ? "面談" : "再架電"} ${md(w)} ${hm(w)}</span>` : r.canceled ? "" : noDateBadge(r) + (r.src === "old" ? OLD_BADGE : "")) + (r.canceled ? CX_BADGE : "");
    row.innerHTML = `<span class="tm">${hm(r.t)}</span><span class="body">${resChip(r.r)}${when}` +
      (r.memo && (r.memo.shop || r.memo.text) ? `<div class="memo">${memoLine(r.memo)}</div>` : `<div class="add">＋メモ</div>`) + `</span>`;
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
  /* rs＝日程を変える（リスケ）：日時とクローザーだけ選び直す。取った本人・管理者・そのアポのクローザーが使える（中身は見るだけ） */
  const kind = rec.r, timed = kind === "アポ" || kind === "再架電", rs = !!rec.rs, mine = rec.uid === U && !rs;
  $("mTitle").innerHTML = resChip(kind) + (rs ? " 日程を変える（リスケ）" : kind === "アポ" ? " アポの詳細" : kind === "再架電" ? " 再架電の予定" : " メモ");
  $("mHint").textContent = rs ? "今：" + md(m.when) + " " + hm(m.when) + "〜" + hm(new Date(m.when.getTime() + APO_MIN * 6e4)) + "（クローザー " + CNAME(m.closer) + "）。新しい日時" +
      (rsCloserFixed(rec) ? "" : "とクローザー") + "を選んで［日程を変える］を押してください。同じアポのまま日時だけ変わります（KPIの数はそのまま。クローザーのGoogleカレンダーと営業結果シートも新しい日時に変わります）" :
    !mine ? nameOf(rec.uid) + "さんの記録です（見るだけ）" :
    rec.draft ? "カレンダーから登録します。保存するとアポが1件増えます" :
    rec.canceled ? "キャンセルした記録です" + (m.when ? "（元の日時 " + md(m.when) + " " + hm(m.when) + "）" : "") + "。日時を入れずに保存するとメモだけ保存（キャンセルのまま）。新しい日時を入れて保存すると、もう一度" + (kind === "アポ" ? "アポ" : "予定") + "として入ります" :
    hm(rec.t) + " の記録" + (timed ? "。日時を入れるとリマインドに出ます" : "");
  $("mShop").value = m.shop || ""; $("mTel").value = m.tel || ""; $("mText").value = m.text || "";
  $("mInfo").value = m.info || ""; $("mInfoBox").hidden = kind !== "アポ";
  $("mWhenBox").hidden = !timed; $("mRemindBox").hidden = !timed || rs;
  $("mPick").hidden = kind !== "アポ" || !(mine || rs);
  $("mCloserBox").hidden = kind !== "アポ";
  if (timed) {
    selCloser = m.closer || "auto";
    $("mWhenLbl").textContent = kind === "アポ" ? "商談日時（1時間半）" : "かけ直す日時";
    $("mWhen").value = m.when && !rec.canceled ? toLocal(m.when) : ""; $("mRemind").checked = m.remind !== false; setQuick(kind);   // キャンセルした記録は日時を空で開く（メモを足して保存しただけで復活しないように）
  }
  ["mShop", "mTel", "mText", "mInfo"].forEach(id => $(id).readOnly = !mine);
  $("mWhen").readOnly = !(mine || rs);
  $("mPaste").hidden = !mine;
  $("mSave").hidden = !(mine || rs); $("mSave").textContent = rs ? "日程を変える" : "保存";
  $("mSkip").textContent = rs ? "やめる" : mine ? "あとで" : "閉じる";
  $("mUndo").hidden = !(rec.fresh && mine && !rec.draft && rec.src !== "old");
  /* カレンダーから新しく入れるアポだけ：10月より前に取った案件として（KPIに数えずに）入れられる。管理者は取った人を選べる */
  const preOk = !!rec.draft && kind === "アポ";
  $("mPreBox").hidden = !preOk; $("mPre").checked = false; $("mByBox").hidden = true;
  if (preOk && isAdminMe()) fillBy();
  checkClash();
  $("scrim").hidden = $("msheet").hidden = false;
  memoSnap = sheetSnap("msheet") + selCloser; delete $("msheet").dataset.armClose;
  if (mine) setTimeout(() => $(timed ? "mShop" : "mText").focus(), 50);
  if (rs) setTimeout(() => $("mWhen").focus(), 50);
}
function fillBy() {
  const list = Object.entries(members).filter(([, m]) => m.status === "active" && !isExt(m)).sort((a, b) => (a[1].name || "").localeCompare(b[1].name || "", "ja"));
  $("mBy").innerHTML = list.map(([id, m]) => `<option value="${esc(id)}"${id === U ? " selected" : ""}>${esc(m.name)}${id === U ? "（自分）" : ""}</option>`).join("");
}
$("mPre").onchange = () => {
  const on = $("mPre").checked;
  $("mByBox").hidden = !(on && isAdminMe());
  $("mHint").textContent = on ? PRE_LABEL + "に取った案件として、カレンダーに入れます。KPI（架電数・アポ数）には数えません" : "カレンダーから登録します。保存するとアポが1件増えます";
};
/* 入力の途中で、暗いところを押したり Esc を押したりして閉じても消えないように：
   開いた時から中身が変わっていたら、1回目は知らせるだけ（保存ボタンを揺らす）、もう一度で閉じる */
let memoSnap = "", taskSnap = "";
const sheetSnap = id => [...$(id).querySelectorAll("input, textarea, select")].map(e => e.type === "checkbox" ? e.checked : e.value).join("\u0001");
function guardClose(id, changed, close, saveId) {
  const sheet = $(id);
  if (!changed || sheet.dataset.armClose) { delete sheet.dataset.armClose; close(); return; }
  sheet.dataset.armClose = "1"; setTimeout(() => { delete sheet.dataset.armClose; }, 3000);
  const s = $(saveId); s.classList.remove("shake"); void s.offsetWidth; s.classList.add("shake");
  toast("入力した内容が消えます。閉じるときは、もう一度押してください");
}
const memoChanged = () => !$("msheet").hidden && sheetSnap("msheet") + selCloser !== memoSnap;
const taskChanged = () => !$("taskSheet").hidden && sheetSnap("taskSheet") + tKind !== taskSnap;
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
/* 担当は役職ごとのタブ（プレイヤー／事務／管理職）で分けて選ぶ（社長の指示 2026-10-03「案②でいこう」）。
   管理者も自分の役職のところに出す（社長「出して！」。前の v28 で管理者を外したのは、渡邉さんが「管理職」のことを書いていたため。
   SHOW_ADMIN_IN_TASK を false にすると、前と同じく管理者を出さない＝自分ともう担当になっている人だけ出す） */
const WHO_GROUPS = ["プレイヤー", "事務", "管理職"];
const SHOW_ADMIN_IN_TASK = true;
let whoTab = 0;
function whoGroups() {
  const t = editingTask;
  const act = Object.entries(members).filter(([id, m]) => m.status === "active" && !isExt(m) && (SHOW_ADMIN_IN_TASK || m.role !== "admin" || id === U || (t && t.uid === id)))
    .sort((a, b) => (a[0] === U ? -1 : b[0] === U ? 1 : (a[1].name || "").localeCompare(b[1].name || "", "ja")));
  return WHO_GROUPS.map(g => act.filter(([, m]) => (WHO_GROUPS.includes(m.job) ? m.job : "プレイヤー") === g));   // 役職なし＝プレイヤー
}
function renderWho() {
  const groups = whoGroups(), cur = $("tWho").value;
  $("tWhoTabs").innerHTML = WHO_GROUPS.map((g, i) => groups[i].length ? `<button type="button" role="tab" data-i="${i}" aria-selected="${i === whoTab}">${g}<small>${groups[i].length}</small></button>` : "").join("");
  $("tWhoChips").innerHTML = (groups[whoTab] || []).map(([id, m]) => `<button type="button" data-id="${esc(id)}" aria-pressed="${id === cur}">${esc(m.name)}${id === U ? "（自分）" : ""}</button>`).join("");
  const sel = members[cur];
  $("tWhoNow").innerHTML = sel ? `担当：<b>${esc(sel.name)}${cur === U ? "（自分）" : ""}</b><small>${esc(WHO_GROUPS.includes(sel.job) ? sel.job : "プレイヤー")}</small>` : "";
}
$("tWhoTabs").onclick = e => { const b = e.target.closest("button[data-i]"); if (!b) return; whoTab = Number(b.dataset.i); renderWho(); };
$("tWhoChips").onclick = e => { const b = e.target.closest("button[data-id]"); if (!b) return; $("tWho").value = b.dataset.id; renderWho(); };
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
  $("tWho").value = t ? t.uid : U;
  const g = whoGroups().findIndex(list => list.some(([id]) => id === $("tWho").value));
  whoTab = g < 0 ? 0 : g;   // 今の担当がいる役職のタブから開く
  renderWho();
  $("tDelete").hidden = !t; delete $("tDelete").dataset.arm; $("tDelete").textContent = "削除";
  drawTaskKinds(); setTaskQuick();
  $("tScrim").hidden = $("taskSheet").hidden = false;
  taskSnap = sheetSnap("taskSheet") + tKind; delete $("taskSheet").dataset.armClose;
  setTimeout(() => $(t ? "tTitle" : "tWhen").focus(), 50);
}
function closeTask() { $("tScrim").hidden = $("taskSheet").hidden = true; editingTask = null; }
$("tCancel").onclick = closeTask;   // 「やめる」は押した人が決めているので、そのまま閉じる
const tryCloseTask = () => guardClose("taskSheet", taskChanged(), closeTask, "tSave");
$("tScrim").onclick = tryCloseTask;
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
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("taskSheet").hidden) tryCloseTask(); });

function closeMemo() { refreshHistSoon(); $("scrim").hidden = $("msheet").hidden = true; editing = null; }
/* 押し間違い：結果ボタンを押した直後に開いたシートから、その記録を取り消す */
$("mUndo").onclick = () => { const r = editing; if (!r) return; closeMemo(); undoRec(r, r.r); };
/* 「あとで」：日時と枠はそのままにして、入れた店名・電話・メモ（アポはカレンダーの説明も）は残す。
   カレンダーから開いた新しいアポ（draft、まだ記録が無い）は何も作らずに閉じる */
function skipMemo() {
  const r = editing, changed = memoChanged();
  const shop = $("mShop").value.trim(), tel = $("mTel").value.trim(), text = $("mText").value.trim(), info = $("mInfo").value.trim();
  closeMemo();
  if (!r || r.uid !== U || r.draft || r.rs) return;   // リスケの画面の「やめる」は何も保存しない
  const undatedApo = r.r === "アポ" && !(r.memo && r.memo.when) && !r.canceled;   // キャンセルした記録は「日時未定のアポ」に戻さない
  if (!changed) { if (undatedApo) toast("日時未定のアポとして残しました"); return; }
  const m = {...(r.memo || {}), shop, tel, text};
  if (r.r === "アポ") m.info = info;
  if (m.when instanceof Date) m.when = Timestamp.fromDate(m.when);
  Object.keys(m).forEach(k => { if (m[k] === undefined) delete m[k]; });
  const empty = !shop && !tel && !text && !m.info && !m.when && r.r !== "アポ" && r.r !== "再架電";
  const b = writeBatch(db);
  b.update(doc(db, "records", r.id), undatedApo ? {memo: m, undated: true} : {memo: empty ? null : m});   // 日時の無いアポは必ず「日時未定のアポ」に出す（古いデータでも）
  if (r.slotId) b.update(doc(db, "slots", r.slotId), {shop, tel, text, info});   // カレンダーの予定の中身も合わせる（日時はそのまま）
  b.commit().catch(e => toast(errMsg(e)));
  toast(r.r === "アポ" ? (undatedApo ? "店名などを保存しました。日時は未定のままです" : "店名などを保存しました（日時はそのまま）")
    : r.r === "再架電" && !(r.memo && r.memo.when) ? "メモを保存しました。日時はまだ入っていません" : "メモを保存しました");
}
$("mSkip").onclick = skipMemo;
/* 外側を押した・Esc：自分の記録で入力が変わっていたら「あとで」と同じく保存して閉じる（どう閉じても消えない）。
   カレンダーから開いた新しいアポ（draft）は保存すると件数が増えるので、今まで通り1回目は知らせるだけ */
const tryCloseMemo = () => (editing && !editing.draft && !editing.rs && editing.uid === U && memoChanged()) ? skipMemo() : guardClose("msheet", memoChanged(), closeMemo, "mSave");
$("scrim").onclick = tryCloseMemo;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("msheet").hidden) tryCloseMemo(); });
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
    if (d && isSlotTime(d)) state = c.id === "auto" ? (freeClosers(d, editing).length ? "" : "×") : (closerBusy(d, c.id, editing) ? "×" : inAvail(d, c.id) ? "アポ可" : "空き");
    if (c.id !== "auto") b.innerHTML = `<i style="background:${c.color}"></i>`;
    b.insertAdjacentHTML("beforeend", esc(c.name) + (c.ext ? "（外部）" : "") + (state ? `<small class="${state === "×" ? "ng" : "okk"}">${state}</small>` : ""));
    b.disabled = editing && (editing.rs ? rsCloserFixed(editing) && c.id !== (editing.memo || {}).closer : editing.uid !== U);   // リスケのクローザーは自分のまま
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
  if (!isSlotTime(d)) { box.className = "clash"; box.textContent = "アポの枠の外です（10:00〜22:00・30分ごと・日曜休み）"; return; }
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
  if (outOfAvail(d, selCloser)) { box.className = "clash"; box.textContent = CNAME(selCloser) + "さんのアポ可の枠の外です（1時間半まるごと枠の中の時間だけ入れられます）" + others; return; }
  box.className = "clash ok"; box.textContent = span + " " + CNAME(selCloser) + "さん 空いています" + (availOf(selCloser) ? (inAvail(d, selCloser) ? "（アポ可の枠の中）" : "（アポ可の枠の外）") : "");
}

$("mSave").onclick = async () => {
  if (editing && editing.rs) { saveResched(editing); return; }
  const rec = editing; if (!rec || rec.uid !== U) return;
  const w = $("mWhen").value ? new Date($("mWhen").value) : null;
  const m = {shop: $("mShop").value.trim(), tel: $("mTel").value.trim(), text: $("mText").value.trim()};
  if (rec.r === "アポ") m.info = $("mInfo").value.trim();   // クローザーのカレンダーの説明に入る
  const remind = $("mRemind").checked;
  $("mSave").disabled = true;
  if (rec.draft) {   // カレンダーから新しく入れるアポ：10月より前の案件か、だれの分か
    rec.pre = !$("mPreBox").hidden && $("mPre").checked;
    rec.owner = rec.pre && isAdminMe() && $("mBy").value ? $("mBy").value : U;
  }
  try {
    if (rec.canceled && !w) {
      /* キャンセルした記録に日時を入れずに保存：メモだけ書いて、キャンセルのまま（元の日時・クローザーは残す） */
      const keep = {...(rec.memo || {}), ...m};
      if (keep.when instanceof Date) keep.when = Timestamp.fromDate(keep.when);
      Object.keys(keep).forEach(k => { if (keep[k] === undefined) delete keep[k]; });
      updateDoc(doc(db, "records", rec.id), {memo: keep}).catch(e => toast(errMsg(e)));
      closeMemo(); toast("メモを保存しました（キャンセルのまま）");
    } else if (rec.r === "アポ" && w) {
      if (!isSlotTime(w)) { toast("アポの枠の外です（10:00〜22:00・30分ごと・日曜休み）"); return; }
      const cl = await bookSlot(rec, m, w, remind);
      /* サーバーからの通知を待たずに、自分のカレンダーへすぐ出す */
      const sid = slotIdOf(w, cl);
      slots = slots.filter(s => s.recId !== rec.id && s.id !== sid).concat([{id: sid, day: dk(w), time: hm(w), when: w, dur: APO_MIN, closer: cl, uid: rec.owner || U, recId: rec.id, shop: m.shop, tel: m.tel, text: m.text, info: m.info || "", ...(rec.pre ? {pre: true} : {})}]);
      if (curTab === "cal") renderCal();
      closeMemo();
      toast((rec.draft ? (rec.pre ? PRE_LABEL + "の案件として登録しました（KPIには数えません）" : "アポを登録しました（アポ+1）") : "保存しました。" + md(w) + " " + hm(w)) + "（クローザー " + CNAME(cl) + (rec.pre && rec.owner !== U ? "・獲得 " + nameOf(rec.owner) : "") + "）");
    } else if (rec.r === "アポ") {
      const b = writeBatch(db);
      b.update(doc(db, "records", rec.id), {memo: m, undated: true, pending: false, slotId: null});   // 日時が無いアポは「日時未定のアポ」に出す（前のカウンターから来たアポも同じ）
      if (rec.slotId) b.delete(doc(db, "slots", rec.slotId));
      b.commit().catch(e => toast(errMsg(e)));
      closeMemo(); toast("日時未定のアポとして保存しました");
    } else if (rec.r === "再架電") {
      updateDoc(doc(db, "records", rec.id), {memo: {...m, when: w ? Timestamp.fromDate(w) : null, remind}, pending: !!w && !rec.done, ...(rec.canceled && w ? {canceled: false} : {})}).catch(e => toast(errMsg(e)));
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
    const owner = rec.draft ? (rec.owner || U) : rec.uid;   // 枠の持ち主＝アポを取った人（10月より前の案件は管理者が代わりに入れることがある）
    const sdata = {day: dk(when), time: hm(when), when: Timestamp.fromDate(when), dur: APO_MIN, closer: chosen.c, uid: owner, recId: rec.id,
      shop: m.shop, tel: m.tel, text: m.text, info: m.info || ""};
    if (rec.pre) sdata.pre = true;
    if (rec.slotId && rec.slotId !== chosen.sref.id) tx.delete(doc(db, "slots", rec.slotId));
    tx.set(chosen.sref, sdata);
    if (rec.draft && rec.pre) {
      /* 10月より前に取った案件：記録は作るが、集計（stats）には足さない＝架電数にもアポ数にも入らない */
      tx.set(recRef, {uid: owner, r: "アポ", pre: true, enteredBy: U, t: Timestamp.fromDate(new Date(PRE_DAY + "T12:00:00")), day: PRE_DAY, hour: 12, mb: null,
        memo, undated: false, pending: true, done: false, slotId: chosen.sref.id});
    } else if (rec.draft) {
      const t = new Date();
      tx.set(recRef, {uid: U, r: "アポ", t: Timestamp.fromDate(t), day: dk(t), hour: t.getHours(), mb: mbOf(t), memo, undated: false, pending: true, done: false, slotId: chosen.sref.id});
      tx.set(doc(db, "stats", dk(t)), statInc(U, "アポ", t.getHours(), 1, mbOf(t)), {merge: true});
    } else {
      tx.update(recRef, {memo, undated: false, pending: true, slotId: chosen.sref.id, ...(rec.canceled ? {canceled: false} : {})});   // キャンセルしたアポに日時を入れ直したら、もう一度アポとして入る
    }
    chosenId = chosen.c;
  });
  return chosenId;
}

/* ============================================================
   日程を変える（リスケ）（社長 2026-10-06「架電以外のアポで、リスケになったとき、すでにカレンダーに入れている予定を簡単に日程変更できる機能」）
   ・同じ記録のまま、日時（とクローザー）だけ動かす。KPI（取った日・数）は変わらない。店名などの中身もそのまま
   ・クローザーのGoogleカレンダーの招待は連携の係（5分おき）が同じ予定の日時を書き換え、営業結果シートは同じ行の I（商談日）を書き直す
   ・使えるのは、取った本人・管理者・そのアポのクローザー（クローザーは自分を担当のまま動かすだけ）
   ・前は「消して入れ直す」しかなく、KPIが減ったりシートに取り消しの行が残ったりしていた
   ============================================================ */
const canResched = r => !r.isTask && r.r === "アポ" && !r.canceled && !!(r.memo && r.memo.when) && (r.uid === U || isAdminMe() || isCloserOf(r));
const rsCloserFixed = r => !(r.uid === U || isAdminMe());   // そのアポのクローザーとして動かす人は、クローザーを変えられない
function openResched(r) {
  if (!canResched(r)) { toast("日程を変えられるのは、アポを取った本人・管理者・そのアポのクローザーだけです"); return; }
  openMemo({...r, rs: true});
}
async function openReschedById(id) {
  const r = await recById(id);
  if (!r) { toast("記録が見つかりませんでした"); return; }
  hideApoDetail();
  openResched(r);
}
/* 記録を番号で取る：手元の予定（購読中の pending のアポ・再架電）にあればそれ、無ければ読む（3日より前に終わったアポなど）。
   ほかの人の記録もメンバーなら読める（ルール records read: isActive）。読めなければ null */
async function recById(id) {
  const r = pendTeam.concat(pendMine).find(x => x.id === id && !x.isTask);
  if (r) return r;
  return getDoc(doc(db, "records", id)).then(s => s.exists() ? recOf(s) : null).catch(() => null);
}
async function saveResched(rec) {
  const w = $("mWhen").value ? new Date($("mWhen").value) : null;
  if (!w) { toast("新しい日時を選んでください"); return; }
  if (!isSlotTime(w)) { toast("アポの枠の外です（10:00〜22:00・30分ごと・日曜休み）"); return; }
  const old = rec.memo.when, oldC = rec.memo.closer;
  const cid = rsCloserFixed(rec) ? oldC : selCloser;
  /* カレンダーと同じく、Googleの予定・アポ可の枠も見て決める（おまかせは空いている人だけ） */
  const cands = cid === "auto" ? freeClosers(w, rec).map(c => c.id) : closerBusy(w, cid, rec) ? [] : [cid];
  /* 日時もクローザーも今のまま（おまかせなら、空いている人の先頭＝今の人）なら何も書かない。
     前は「おまかせ」だとこの判定を通り抜けて同じ枠に書き直そうとし、管理者には「権限がありません」が出ていた（テスター 2026-10-09。
     枠の書き換えは取った本人しかできないルールのため。日時やクローザーが変わるときは「消して作る」なので管理者・クローザーも通る） */
  if (+w === +old && (cid === "auto" ? cands[0] === oldC : cid === oldC)) { toast("日時もクローザーも今のままです"); return; }
  if (!cands.length) { toast(whyNot(w, cid, rec)); return; }
  $("mSave").disabled = true;
  try {
    const got = await moveApo(rec.id, w, cands);
    closeMemo();
    toast("日程を変えました：" + md(old) + " " + hm(old) + " → " + md(w) + " " + hm(w) + "（クローザー " + CNAME(got.closer) + "）。招待も5分以内に変わります",
      "元に戻す", () => moveApo(rec.id, old, [oldC]).then(() => toast("元の日時に戻しました")).catch(e => toast(e && e.message === "FULL" ? "元の時間に別の商談が入ったため、戻せませんでした" : errMsg(e))), 10000);
  } catch (e) {
    toast(e && e.message === "FULL" ? "その時間は、ほかの商談と重なるため入れられませんでした（今入ったかもしれません）" :
      e && e.message === "GONE" ? "このアポは消されています" : e && e.message === "CANCELED" ? "このアポは取り消されています" : errMsg(e));
  } finally { $("mSave").disabled = false; }
}
/* アポを when へ動かす（cands の中で、重なる商談が無い最初のクローザー）。記録・枠をトランザクションで書く。戻り値 {closer, sid} */
async function moveApo(recId, when, cands) {
  const recRef = doc(db, "records", recId);
  let out = null;
  await runTransaction(db, async tx => {
    const rs = await tx.get(recRef);
    if (!rs.exists()) throw new Error("GONE");
    const raw = rs.data();
    if (raw.canceled) throw new Error("CANCELED");
    const oldRef = raw.slotId ? doc(db, "slots", raw.slotId) : null;
    const oldS = oldRef ? await tx.get(oldRef) : null;
    let chosen = null;
    for (const c of [...new Set(cands)]) {
      let clash = false;
      for (const off of OVERLAP_STEPS) {
        const s = await tx.get(doc(db, "slots", slotIdOf(new Date(when.getTime() + off * 6e4), c)));
        if (s.exists() && s.data().recId !== recId) { clash = true; break; }
      }
      if (!clash) { chosen = c; break; }
    }
    if (!chosen) throw new Error("FULL");
    const m = raw.memo || {};
    const base = oldS && oldS.exists() ? oldS.data()
      : {uid: raw.uid, recId, dur: APO_MIN, shop: m.shop || "", tel: m.tel || "", text: m.text || "", info: m.info || "", ...(raw.pre ? {pre: true} : {})};
    const sid = slotIdOf(when, chosen);
    if (oldS && oldS.exists() && raw.slotId !== sid) tx.delete(oldRef);
    tx.set(doc(db, "slots", sid), {...base, day: dk(when), time: hm(when), when: Timestamp.fromDate(when), closer: chosen});
    tx.update(recRef, {"memo.when": Timestamp.fromDate(when), "memo.closer": chosen, slotId: sid, pending: true});
    out = {closer: chosen, sid, base};
  });
  /* サーバーからの通知を待たずに、自分のカレンダーへすぐ出す */
  slots = slots.filter(s => s.recId !== recId).concat([{...out.base, id: out.sid, day: dk(when), time: hm(when), when, closer: out.closer}]);
  if (curTab === "cal") renderCal();
  refreshHistSoon();
  return out;
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
/* 外部の人のGoogleカレンダーの【商談】【契約】（busy/{uid}.deals。連携の係が題・時間・場所・説明欄を書く）。
   社長 2026-10-06「阪本さんの予定で、商談の予定があるところはアポの予定として表示して！表示内容は石川さんと同じで、押したらアポの内容が表示されるように」。
   アプリのアポと同じ帯で出す（アプリの記録ではないので見るだけ）。帯の置き方はアポと同じにするため、
   その日の 10:00〜22:00 に切り、始まりの30分の枠（when）から終わりまでの長さ（dur）にする */
const DEAL_HEAD = /^【(商談|契約)】\s*/;
const dealShop = x => x.t.replace(DEAL_HEAD, "") || "（店名なし）";
const dealKind = x => (x.t.match(DEAL_HEAD) || [, "商談"])[1];
let dealIdx = {};   // 帯の番号 → 予定（押したときに中身を出す）
function dealsOn(day, cid) {
  const b = busyMap[cid]; if (!b || !b.deals || !b.deals.length) return [];
  const d0 = new Date(day); d0.setHours(SLOT_H0, 0, 0, 0);
  const d1 = new Date(day); d1.setHours(SLOT_H1, 0, 0, 0);
  return b.deals.filter(x => x.s < d1 && x.e > d0).map((x, i) => {
    const w = new Date(Math.max(+x.s, +d0)); w.setMinutes(w.getMinutes() < 30 ? 0 : 30, 0, 0);
    const id = "deal_" + cid + "_" + (+x.s) + "_" + i;
    dealIdx[id] = {...x, cid};
    return {id, closer: cid, when: w, dur: Math.max(30, Math.ceil((Math.min(+x.e, +d1) - w) / 18e5) * 30), deal: x, isDeal: true};
  });
}
const dealCovering = (list, d) => list.find(x => x.when <= d && d < apoEnd(x)) || null;
function showDeal(id) {
  const x = dealIdx[id]; if (!x) return;
  const who = (members[x.cid] || {}).name || "外部の人";
  adSlot = null;
  $("adTitle").textContent = md(x.s) + " " + hm(x.s) + " の" + dealKind(x);
  $("adBody").innerHTML = `<div class="ad-row"><b>${esc(dealShop(x))}</b>${dealKind(x) === "契約" ? `<em class="deal-tag">契約</em>` : ""}
    <small class="num">${md(x.s)} ${hm(x.s)}〜${hm(x.e)}</small>
    <small><i class="dot-c" style="background:${CCOL(x.cid)}"></i>${esc(who)}さんのGoogleカレンダーの予定</small>
    ${x.p ? `<div class="ad-place">場所：${esc(x.p)}</div>` : ""}
    ${x.m ? `<div class="ad-info">${esc(x.m)}</div>` : ""}</div>
    <div class="ad-row"><small>${esc(who)}さんのカレンダーにある予定です（アプリの記録ではないので、ここからは直せません）</small></div>`;
  $("adNew").hidden = true;
  $("adScrim").hidden = $("apoDetail").hidden = false;
}
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
/* アポ可の枠（石川さんの「ブロック」など）。枠のカレンダーがつながって読めている人だけ。
   inAvail＝d から1時間半の商談がまるごと枠の中に入るか（社長の決定 2026-10-06：1時間半まるごと） */
const availOf = cid => { const b = busyMap[cid]; return b && b.availStatus === "ok" ? b.avail || [] : null; };
const inAvail = (d, cid) => { const a = availOf(cid); if (!a) return false; const e = new Date(d.getTime() + APO_MIN * 6e4); return a.some(w => w.s <= d && w.e >= e); };
function availLegend(list) {
  const w = list.filter(c => availOf(c.id));
  if (!w.length) return "";
  return `<span><i class="lg-avail"></i>緑＝アポ可の枠（${w.map(c => esc(c.name)).join("・")}）</span>` +
    (AVAIL_ONLY ? `<span><i class="lg-outav"></i>灰色＝枠の外（入れられない）</span>` : "");
}
/* 枠の外で入れられない（AVAIL_ONLY のときだけ。ふだんは緑が目安になるだけで、枠の外にも入れられる） */
const outOfAvail = (d, cid) => AVAIL_ONLY && !!availOf(cid) && !inAvail(d, cid);
/* d から始める商談を、そのクローザーに入れられないか */
const closerBusy = (d, cid, except) => !!apoOverlap(d, cid, except) || !!gBusyRange(d, cid) || outOfAvail(d, cid);
const freeClosers = (d, except) => closerList().filter(c => !closerBusy(d, c.id, except));
const slotOpen = (d, except, cid) => (!cid || cid === "auto" || cid === "all") ? freeClosers(d, except).length > 0 : !closerBusy(d, cid, except);
function freeSlots(from, n) {
  const out = []; let d = new Date(from); d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() === 0 ? 0 : d.getMinutes() <= 30 ? 30 : 60, 0, 0);
  for (let g = 0; out.length < n && g < 2000; g++, d = new Date(d.getTime() + 18e5)) if (isSlotTime(d) && slotOpen(d, editing, selCloser)) out.push(new Date(d));
  return out;
}
const monday = d => addDays(dayStart(d), -((d.getDay() + 6) % 7));
let wkStart = monday(new Date()), pickMode = false, pickReturn = "count", calCloser = null;   // null＝まだ決めていない（開いたときに決める）
/* 週表示で最初に出す人（社長 2026-10-06「クローザー全員」は残して B：最初は、自分がクローザーなら自分、そうでなければ並び順の先頭の人）。
   そのスマホで最後に選んだ人（「全員」も）を覚えておき、次からはその人。名簿が届く前は決めない */
function defaultCalCloser(cls, vws) {
  const saved = lsGet("team-calCloser", null);
  if (saved && (saved === "all" || cls.some(c => c.id === saved) || vws.some(c => c.id === saved))) return saved;
  if (cls.some(c => c.id === U)) return U;
  return cls.length && cls[0].id !== "none" ? cls[0].id : "all";
}
let calBeforePick = null, calAuto = false;   // 空きを選ぶ（日切り）あいだだけ「全員」などにするので、終わったら元の人に戻す
/* 表示：週（月〜土）か日（クローザーごとの列）。スマホは日、PCは週から始める。選んだ方を覚える */
let calView = lsGet("team-calview", innerWidth < 640 ? "day" : "week");
/* 日表示の最初の日：ふだんは今日。営業が終わった時間（22:00）を過ぎたら明日。日曜は次の月曜 */
const calStartDay = () => { let d = today(); if (new Date().getHours() >= SLOT_H1) d = addDays(d, 1); if (d.getDay() === 0) d = addDays(d, 1); return d; };
let calDay = calStartDay();
/* 開いたままで22:00を過ぎたとき：日表示が今日のままなら、カレンダーを開いた時に明日へ */
function rollCalDay() { if (calView === "day" && !pickMode && +calDay === +today() && +calStartDay() !== +today()) { calDay = calStartDay(); wkStart = monday(calDay); } }
const skipSun = (d, step) => { let x = addDays(d, step); if (x.getDay() === 0) x = addDays(x, step); return x; };
$("wkPrev").onclick = () => {
  if (calView === "day") { calDay = skipSun(calDay, -1); wkStart = monday(calDay); } else wkStart = addDays(wkStart, -7);
  loadPastWeek(); renderCal();
};
$("wkNext").onclick = () => {
  if (calView === "day") { calDay = skipSun(calDay, 1); wkStart = monday(calDay); } else wkStart = addDays(wkStart, 7);
  renderCal();
};
$("calFilter").onclick = e => { const b = e.target.closest("button"); if (!b) return; calCloser = b.dataset.c; calAuto = false; if (!pickMode) lsSet("team-calCloser", calCloser); renderCal(); };
$("calView").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  calView = b.dataset.v; lsSet("team-calview", calView);
  if (calView === "day") { calDay = wkStart <= today() && today() < addDays(wkStart, 7) ? today() : new Date(wkStart); if (calDay.getDay() === 0) calDay = addDays(calDay, 1); }
  else wkStart = monday(calDay);
  renderCal();
};
$("calToday").onclick = () => { calDay = calStartDay(); wkStart = monday(calView === "day" ? calDay : new Date()); renderCal(); };
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
   何枠ぶんか（カレンダーの終わり 22:00 で切る）と、同じ列で時間が重なる商談を横に並べるための「レーン」 */
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
  const now = new Date(), T = today(), cls = closerList(), vws = viewList();
  /* 名簿が届く前は仮に「全員」で出し（calAuto）、届いたら決め直す */
  const known = Object.keys(members).length > 0;
  if (!calCloser || calAuto || (calCloser !== "all" && !cls.some(c => c.id === calCloser) && !vws.some(c => c.id === calCloser))) {
    calCloser = known ? defaultCalCloser(cls, vws) : "all"; calAuto = !known;
  }
  const viewTap = c => toast(c.name + "さんの予定を見るだけの列です（アポはクローザーの列から入れてください）");
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
    $("legend").innerHTML = `<span><i style="background:transparent;outline:2px solid #FFD54F;outline-offset:-2px"></i>自分が取ったアポ</span><span>列＝クローザー（1人1枠）</span>` +
      `<span><i class="lg-dot"></i>点線＝ここから始めると、ほかの商談と重なる</span><span><i class="lg-hatch"></i>斜線＝過ぎた時間・ほかの予定</span><span><em class="gc ok">G</em>＝Googleカレンダー連携中（<em class="gc ng">G</em>＝まだ共有されていない）</span>` + availLegend(cls) +
      (vws.length ? `<span><em class="ext-tag">閲覧</em>＝予定を見るだけの列（予定ありの時間だけ出る・アポは入らない）</span>` : "");
    cal.style.gridTemplateColumns = `50px repeat(${cls.length + vws.length}, minmax(92px, 1fr))`;
    cal.insertAdjacentHTML("beforeend", `<div class="hd corner"></div>` + cls.map(c => {
      let f = 0;
      for (let h = SLOT_H0; h < SLOT_H1; h++) for (const mi of [0, 30]) { const d = new Date(day); d.setHours(h, mi, 0, 0); if (d >= now && !closerBusy(d, c.id, null)) f++; }
      const g = busyMap[c.id], gs = !g ? "" : linkedSt(g.status) ? `<em class="gc ok" title="Googleカレンダー連携中${g.status === "partial" ? "（2つ目は未共有）" : ""}">G</em>` : `<em class="gc ng" title="Googleカレンダーが未共有">G</em>`;
      return `<div class="hd cl"><span><i class="dot-c" style="background:${c.color}"></i>${esc(c.name)}${gs}${c.ext ? `<em class="ext-tag" title="アプリにログインしない外部のクローザー">外部</em>` : ""}</span><small>空き ${f}枠</small></div>`;
    }).join("") + vws.map(c => {
      const g = busyMap[c.id], gs = !g ? "" : linkedSt(g.status) ? `<em class="gc ok" title="Googleカレンダー連携中">G</em>` : `<em class="gc ng" title="Googleカレンダーが未共有">G</em>`;
      return `<div class="hd cl view"><span><i class="dot-c" style="background:${c.color}"></i>${esc(c.name)}${gs}<em class="ext-tag" title="予定を見るだけ（アポは入らない）">閲覧</em></span><small>予定を見るだけ</small></div>`;
    }).join(""));
    const lanesC = {}, dealsC = {};
    dealIdx = {};
    cls.concat(vws).forEach(c => dealsC[c.id] = dealsOn(day, c.id));   // 外部の人の【商談】【契約】（アプリのアポと同じ帯）
    cls.concat(vws).forEach(c => lanesC[c.id] = laneLayout(allSlots().filter(s => s.closer === c.id && s.day === dk(day) && s.when).concat(dealsC[c.id])));
    const dealBand = (x, c) => `<span class="apd blk deal" data-deal="${esc(x.id)}" style="--cc:${c.color};${blkStyle(x, lanesC[c.id])}"><b>${esc(dealShop(x.deal))}${dealKind(x.deal) === "契約" ? `<em class="pre-tag">契約</em>` : ""}</b><small class="num">${hm(x.deal.s)}〜${hm(x.deal.e)}</small><small>${esc(c.name)}さんの予定</small></span>`;
    /* 帯（【商談】）を押したら中身。選び直し中（pickMode）はふつうの枠と同じ */
    const onDeal = (e, fn) => { const t = !pickMode && e.target.closest("[data-deal]"); if (t) showDeal(t.dataset.deal); else fn(); };
    for (let h = SLOT_H0; h < SLOT_H1; h++) for (const mi of [0, 30]) {
      cal.insertAdjacentHTML("beforeend", timeCell(h, mi));
      const d = new Date(day); d.setHours(h, mi, 0, 0);
      const at = slotsAt(d, null);
      cls.forEach(c => {
        const past = d < now;
        const list = at.filter(s => s.closer === c.id);                       // ここから始まる商談
        const cover = list.length ? null : apoCovering(d, c.id, null);         // 前の枠から続いている商談
        const dls = dealsC[c.id].filter(x => +x.when === +d);                  // ここから始まる【商談】（外部の人のカレンダー）
        const dcov = dealCovering(dealsC[c.id], d);
        const gb = list.length || cover || dcov ? null : gBusyAt(d, c.id);
        const canStart = !closerBusy(d, c.id, null);                           // ここから1時間半とれるか
        const av = !past && canStart && inAvail(d, c.id);                      // アポ可の枠の中（薄い緑）
        const out = !past && !list.length && !cover && !dcov && !gb && outOfAvail(d, c.id);   // 枠の外で入れられない（AVAIL_ONLY のとき）
        if (!past && canStart) free++;
        count += list.length;
        const b = document.createElement("button");
        b.className = "sl" + (mi ? " half" : "") + (past ? " past" : canStart ? " free" : " full") + (av ? " avail" : "") + (out ? " outav" : "") +
          (!past && !canStart && !list.length && !cover && !dcov && !gb && !out ? " nostart" : "");
        b.setAttribute("aria-label", c.name + " " + hm(d) + (list.length ? " 商談あり" : cover ? " 商談中" : dcov ? " " + dealKind(dcov.deal) + "（" + dealShop(dcov.deal) + "）" : gb ? " ほかの予定あり" : past ? " 過ぎた枠" : out ? " アポ可の枠の外" : canStart ? (av ? " 空き・アポ可" : " 空き") : " ここからは1時間半とれない"));
        /* ほかの予定は、始まりの枠にだけ時間を書く */
        const gStart = gb && (gb.s >= d || +d === +new Date(new Date(day).setHours(SLOT_H0, 0, 0, 0)));
        /* 商談は始まりの枠から1時間半の帯。続きの枠（cover）は帯の下になるので何も書かない */
        b.innerHTML = list.map(s => `<span class="apd blk${s.uid === U ? " mine" : ""}${s.pre ? " pre" : ""}" style="--cc:${c.color};${blkStyle(s, lanesC[c.id])}"><b>${esc(s.shop || "（店名なし）")}${s.pre ? `<em class="pre-tag">以前</em>` : ""}</b><small class="num">${hm(s.when)}〜${hm(apoEnd(s))}</small><small>獲得 ${esc(nameOf(s.uid))}</small></span>`).join("") +
          dls.map(x => dealBand(x, c)).join("") +
          (gb ? `<span class="gbusy">${gStart ? `予定あり<small>${hm(gb.s)}〜${hm(gb.e)}</small>` : ""}</span>` : "") +
          (!past && canStart ? `<span class="free-mark">${hm(d)}</span>` : "") + (+dayStart(d) === +T ? nowLine(d, now) : "");
        b.onclick = e => onDeal(e, () => slotTap(d, list.length ? list : cover ? [cover] : [], past, !canStart, c.id));
        cal.appendChild(b);
      });
      /* 見るだけの列：予定ありの斜線だけ（押してもアポは入らない） */
      vws.forEach(c => {
        const dls = dealsC[c.id].filter(x => +x.when === +d), dcov = dealCovering(dealsC[c.id], d);
        const past = d < now, gb = dcov ? null : gBusyAt(d, c.id);
        const gStart = gb && (gb.s >= d || +d === +new Date(new Date(day).setHours(SLOT_H0, 0, 0, 0)));
        const b = document.createElement("button");
        b.className = "sl view" + (mi ? " half" : "") + (past ? " past" : "");
        b.setAttribute("aria-label", c.name + "（閲覧） " + hm(d) + (dcov ? " " + dealKind(dcov.deal) + "（" + dealShop(dcov.deal) + "）" : gb ? " 予定あり" : ""));
        b.innerHTML = dls.map(x => dealBand(x, c)).join("") + (gb ? `<span class="gbusy">${gStart ? `予定あり<small>${hm(gb.s)}〜${hm(gb.e)}</small>` : ""}</span>` : "") + (+dayStart(d) === +T ? nowLine(d, now) : "");
        b.onclick = e => onDeal(e, () => viewTap(c));
        cal.appendChild(b);
      });
    }
    $("wkSub").textContent = (off === 0 ? "今日" : off === 1 ? "明日" : off === -1 ? "昨日" : "") + "　アポ " + count + "件 ・ 空き " + free + "枠";
    $("calToday").hidden = +calDay === +calStartDay();
    $("calToday").textContent = +calStartDay() === +today() ? "今日へ" : "明日へ";
    $("calDefs").textContent = "空いている枠を押すと、そのクローザーで、その時間から1時間半の商談を登録できます。商談を押すと詳細が出ます。";
  } else {
    /* ---- 週表示：月〜土 ---- */
    const days = [0, 1, 2, 3, 4, 5].map(i => addDays(wkStart, i));
    $("wkLbl").textContent = md(days[0]) + " 〜 " + md(days[5]);
    const wOff = Math.round((wkStart - monday(now)) / (7 * 864e5));
    const byC = s => calCloser === "all" || s.closer === calCloser;
    const viewSel = vws.find(c => c.id === calCloser) || null;   // 見るだけの人を選んでいる（予定ありだけ・アポは入らない）
    $("calFilter").hidden = false;
    $("calFilter").innerHTML = [{id: "all", name: "クローザー全員"}, ...cls, ...vws].map(c =>
      `<button class="chip-btn" data-c="${esc(c.id)}" aria-pressed="${calCloser === c.id}">${c.id !== "all" ? `<i class="dot-c" style="background:${c.color}"></i>` : ""}${esc(c.name)}${c.view ? "（閲覧）" : ""}</button>`).join("");
    $("legend").innerHTML = `<span>色＝クローザー</span>` + cls.map(c => `<span><i style="background:${c.color}"></i>${esc(c.name)}${c.ext ? "（外部）" : ""}</span>`).join("") +
      `<span><i style="background:transparent;outline:2px solid #FFD54F;outline-offset:-2px"></i>自分が取ったアポ</span><span><i class="lg-hatch"></i>斜線＝過ぎた時間・クローザーのほかの予定（Googleカレンダー）</span>` +
      `<span>色つきの斜線と頭の字＝だれの予定か（帯も同じ色）</span>` +
      (cls.concat(vws).some(c => busyMap[c.id] && busyMap[c.id].deals && busyMap[c.id].deals.length) ? `<span>外部の人のカレンダーの【商談】も、アポと同じ帯で出ます（押すと中身）</span>` : "") +
      availLegend(calCloser === "all" ? cls : cls.filter(c => c.id === calCloser));
    cal.style.gridTemplateColumns = "";
    cal.insertAdjacentHTML("beforeend", `<div class="hd corner"></div>` + days.map(d =>
      `<div class="hd${+d === +T ? " today" : ""}${d.getDay() === 6 ? " sat" : ""}">${WD[d.getDay()]}<small>${d.getMonth() + 1}/${d.getDate()}</small></div>`).join(""));
    const availCnt = cls.filter(c => availOf(c.id)).length;   // 枠のカレンダーがある人が2人以上なら、緑の枠に誰の枠かを添える
    /* 人ごとの色と頭の字（社長 2026-10-06「クローザー全員のとこで、阪本さんと石川さんの予定の色が分かりにくいから、分けて」）。
       帯・予定ありの斜線の両方に、その人の色と名字の頭の字を付ける。頭の字が同じ人がいれば2文字 */
    const people = cls.concat(vws);
    const pc = id => (people.find(c => c.id === id) || {color: "#5F6368"}).color;
    const ini = id => { const n = (people.find(c => c.id === id) || {name: CNAME(id)}).name || "?"; return people.some(o => o.id !== id && (o.name || "")[0] === n[0]) ? n.slice(0, 2) : n[0]; };
    const hatch = (id, label) => `<span class="gbusy wk pp" style="--pc:${pc(id)}"><b>${esc(ini(id))}</b>${label || ""}</span>`;
    /* 外部の人の【商談】【契約】（Googleカレンダー）：「全員」ならクローザー全員の分、1人に絞っていればその人の分 */
    dealIdx = {};
    const dealsW = {};
    days.forEach(day => dealsW[dk(day)] = (calCloser === "all" ? cls : people.filter(c => c.id === calCloser)).flatMap(c => dealsOn(day, c.id)));
    const lanesD = {};   // 日ごとに、時間が重なる商談（別のクローザー）を横に並べる
    days.forEach(day => lanesD[dk(day)] = laneLayout(allSlots().filter(s => s.day === dk(day) && s.when && byC(s)).concat(dealsW[dk(day)])));
    for (let h = SLOT_H0; h < SLOT_H1; h++) for (const mi of [0, 30]) {
      cal.insertAdjacentHTML("beforeend", timeCell(h, mi));
      days.forEach(day => {
        const d = new Date(day); d.setHours(h, mi, 0, 0);
        const list = slotsAt(d, null).filter(byC).sort((a, b) => a.closer < b.closer ? -1 : 1);
        const past = d < now, full = viewSel ? true : !slotOpen(d, null, calCloser);
        if (!past && !full) free++;
        count += list.length;
        /* アポ可の枠：1人に絞っているときはその人の枠、「全員」のときは枠の中で空いている人がいれば緑（名字の1文字目を添える） */
        const avC = past || full ? [] : calCloser !== "all" ? (inAvail(d, calCloser) ? cls.filter(c => c.id === calCloser) : [])
          : cls.filter(c => inAvail(d, c.id) && !closerBusy(d, c.id, null));
        const outW = !viewSel && !past && !list.length && calCloser !== "all" && outOfAvail(d, calCloser) && !apoCovering(d, calCloser, null) && !gBusyAt(d, calCloser);
        const b = document.createElement("button");
        b.className = "sl" + (mi ? " half" : "") + (viewSel ? " view" + (past ? " past" : "") : (past ? " past" : full ? " full" : " free")) + (avC.length ? " avail" : "") + (outW ? " outav" : "") + (+day === +T ? " today" : "");
        b.setAttribute("aria-label", md(d) + " " + hm(d) + (list.length ? " アポ" + list.length + "件" : past ? " 過ぎた枠" : " 空き"));
        /* Googleの予定も出す。クローザーを1人に絞っているときはその人の分、「全員」のときは予定がある人の名字の1文字目を添える
           （社長「カレンダーに石川さんの予定って反映されてなくない？」2026-10-02。前は絞ったときだけ出していた）。
           続きの枠（商談中）は帯の下になる（押すとその商談） */
        const cover = calCloser !== "all" && !list.length ? apoCovering(d, calCloser, null) : null;
        const dW = dealsW[dk(day)], dls = dW.filter(x => +x.when === +d);
        const dcovOf = id => dealCovering(dW.filter(x => x.closer === id), d);
        const gbw = calCloser !== "all" && !list.length && !cover && !dcovOf(calCloser) ? gBusyAt(d, calCloser) : null;
        const gAll = calCloser === "all" && !list.length ? cls.filter(c => !apoCovering(d, c.id, null) && !dcovOf(c.id) && gBusyAt(d, c.id)) : [];
        b.innerHTML = list.map(s => `<span class="ap blk${s.uid === U ? " mine" : ""}${s.pre ? " pre" : ""}" style="background:${CCOL(s.closer)};${blkStyle(s, lanesD[dk(day)])}"><b>${esc(ini(s.closer))}</b>${s.pre ? `<em class="pre-tag">以前</em>` : ""}<span class="nm">${esc(s.shop || "")}</span><small>${hm(s.when)}〜${hm(apoEnd(s))}</small></span>`).join("") +
          dls.map(x => `<span class="ap blk deal" data-deal="${esc(x.id)}" style="background:${pc(x.closer)};${blkStyle(x, lanesD[dk(day)])}"><b>${esc(ini(x.closer))}</b>${dealKind(x.deal) === "契約" ? `<em class="pre-tag">契約</em>` : ""}<span class="nm">${esc(dealShop(x.deal))}</span><small>${hm(x.deal.s)}〜${hm(x.deal.e)}</small></span>`).join("") +
          (gbw ? hatch(calCloser, "予定あり") : "") +
          (gAll.length ? `<span class="gb-row">${gAll.map(c => hatch(c.id, gAll.length === 1 ? "予定あり" : "")).join("")}</span>` : "") +
          (calCloser === "all" && avC.length && !list.length && availCnt > 1 ? `<span class="avail-wk">${avC.map(c => esc(ini(c.id))).join("・")}</span>` : "") +
          (+day === +T ? nowLine(d, now) : "");
        const tapW = viewSel ? () => viewTap(viewSel) : () => slotTap(d, list.length ? list : cover ? [cover] : [], past, full, calCloser !== "all" ? calCloser : undefined);
        b.onclick = e => { const t = !pickMode && e.target.closest("[data-deal]"); if (t) showDeal(t.dataset.deal); else tapW(); };
        cal.appendChild(b);
      });
    }
    $("wkSub").textContent = (wOff === 0 ? "今週" : wOff === 1 ? "来週" : wOff === -1 ? "先週" : "") + "　アポ " + count + "件 ・ 空き " + free + "枠";
    $("calToday").hidden = wOff === 0; $("calToday").textContent = "今週へ";
    $("calDefs").textContent = viewSel ? "今は" + viewSel.name + "さんの予定（見るだけ）を表示しています。斜線の時間が予定ありです。アポはここからは入れられません。"
      : "枠を押すと、商談の詳細を見るか、空いていればその時間から1時間半の商談を登録できます。クローザー1人につき同じ時間は1件まで" +
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
  if (list.length) { openSlotDetail(d, list, past); return; }
  if (full && !past) { toast(whyNot(d, closerId || calCloser, null)); return; }
  if (past) return;
  newApoAt(d, closerId);
}
/* カレンダーの商談を押したとき（社長 2026-10-09「カレンダーの予定の編集もリマインド画面から予定を開いた時と同じ機能を追加して」）：
   1件なら、リマインドから開いたときと同じ「記録の詳細」（openDetail。メモを編集・前確の予定・リスケ・取り消しが同じ決まりで使える）。
   同じ時間に2件以上（クローザーが別）なら今まで通りの一覧（showApoDetail）を出し、行を押すとその商談の詳細。
   詳細に出すのは記録（records）なので、枠の recId から記録を取る。読めなければ（消された記録など）一覧のまま */
let slotOpening = false;
async function openSlotDetail(d, list, past) {
  if (list.length === 1 && list[0].recId) {
    if (slotOpening) return;   // 読んでいる間に二度押ししても1回だけ
    slotOpening = true;
    let r = null;
    try { r = await recById(list[0].recId); } finally { slotOpening = false; }
    if (r) { openDetail(r, {at: d, past}); return; }
  }
  showApoDetail(d, list, past);
}
function newApoAt(d, closerId) {
  const ref = doc(collection(db, "records"));
  const c = closerId || (calCloser === "all" ? undefined : calCloser);
  openMemo({id: ref.id, uid: U, t: new Date(), r: "アポ", memo: {when: new Date(d), remind: true, closer: c}, draft: true});
}
/* 同じ時間の商談の一覧（2件以上のとき。1件は openSlotDetail から記録の詳細へ）。行を押すとその商談の詳細（openDetail）。
   外部の人の【商談】（showDeal）もこの画面を使う（見るだけ・行は押せない） */
let adSlot = null, adList = [], adPast = false;
const hideApoDetail = () => { $("adScrim").hidden = $("apoDetail").hidden = true; };
function showApoDetail(d, list, past) {
  adSlot = d; adList = list; adPast = !!past;
  $("adTitle").textContent = md(d) + " " + hm(d) + " の商談";
  const free = freeClosers(d, null);
  $("adBody").innerHTML = list.map(s => `<div class="ad-row${s.recId ? " tap" : ""}"${s.recId ? ` data-open="${esc(s.recId)}" role="button" tabindex="0" aria-label="${esc(s.shop || "（店名なし）")}の詳細"` : ""}><b>${esc(s.shop || "（店名なし）")}</b>${s.pre ? PRE_BADGE : ""}${s.recId ? `<span class="ad-go">詳細 ›</span>` : ""}
    <small class="num">${md(s.when)} ${hm(s.when)}〜${hm(apoEnd(s))}</small>
    <small><i class="dot-c" style="background:${CCOL(s.closer)}"></i>クローザー ${esc(CNAME(s.closer))} ・ 獲得 ${esc(nameOf(s.uid))}${s.pre ? "（" + esc(PRE_LABEL) + "・KPIに数えない）" : ""}</small>
    ${s.tel ? `<a class="ad-tel num" href="${telHref(s.tel)}">☎ ${esc(s.tel)}</a>` : ""}
    ${s.text ? `<div>${esc(s.text)}</div>` : ""}
    ${s.info ? `<div class="ad-info">${esc(s.info)}</div>` : ""}
    ${s.recId && (s.uid === U || isAdminMe() || s.closer === U) ? `<div class="ad-acts"><button type="button" class="ad-rs" data-rec="${esc(s.recId)}">日程を変える（リスケ）</button><button type="button" class="ad-cx" data-rec="${esc(s.recId)}">予定を取り消す</button></div>` : ""}</div>`).join("") +
    (!past ? `<div class="ad-row"><small>この時間から1時間半とれるクローザー：${free.length ? free.map(c => esc(c.name)).join("・") : "なし"}</small></div>` : "");
  $("adNew").hidden = past || !slotOpen(d, null, calCloser);
  $("adScrim").hidden = $("apoDetail").hidden = false;
}
$("adNew").onclick = () => { hideApoDetail(); if (adSlot) newApoAt(adSlot); };
$("adClose").onclick = $("adScrim").onclick = hideApoDetail;
$("adBody").addEventListener("click", e => {
  const b = e.target.closest(".ad-cx"); if (b) { openCancelById(b.dataset.rec); return; }
  const r = e.target.closest(".ad-rs"); if (r) { openReschedById(r.dataset.rec); return; }
  if (e.target.closest("a, button")) return;   // 電話のリンクはそのまま電話をかける
  const row = e.target.closest("[data-open]"); if (row) openDetailFromList(row.dataset.open);
});
$("adBody").addEventListener("keydown", e => { const id = e.key === "Enter" && e.target.dataset && e.target.dataset.open; if (id) openDetailFromList(id); });
/* 一覧の行 → その商談の記録の詳細。一覧はいったん閉じ、詳細を「閉じる」と一覧に戻る（別の行も見られるように） */
async function openDetailFromList(id) {
  const r = await recById(id);
  if (!r) { toast("記録が見つかりませんでした"); return; }
  const back = {d: adSlot, list: adList, past: adPast};
  hideApoDetail();
  openDetail(r, {at: adSlot, past: adPast, back});
}

/* 日切り：メモの画面 → カレンダーで空きを選ぶ → メモの画面に戻る */
$("mPick").onclick = () => {
  pickMode = true; pickReturn = curTab;
  $("scrim").hidden = $("msheet").hidden = true;
  const w = $("mWhen").value ? new Date($("mWhen").value) : new Date();
  wkStart = monday(w); calDay = dayStart(w); if (calDay.getDay() === 0) calDay = addDays(calDay, 1);
  calBeforePick = calCloser; calAuto = false;
  calCloser = selCloser === "auto" ? "all" : selCloser;
  showTab("cal");
};
const endPick = () => { pickMode = false; document.body.classList.remove("picking"); $("pickBar").hidden = true; if (calBeforePick) calCloser = calBeforePick; calBeforePick = null; };
function finishPick() { endPick(); showTab(pickReturn); $("scrim").hidden = $("msheet").hidden = false; }
function cancelPick() { endPick(); $("scrim").hidden = $("msheet").hidden = false; }
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
        : r.r === "再架電" ? `${resChip(r.r)} ${esc(r.memo.shop || "（店名なし）")}`
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
  if (w.getDay() === 0) w.setDate(w.getDate() + 1);   // 日曜は休みなので月曜へ
  const p = r.isTask ? updateDoc(doc(db, "tasks", r.id), {when: Timestamp.fromDate(w)}) : updateDoc(doc(db, "records", r.id), {"memo.when": Timestamp.fromDate(w)});
  p.catch(e => toast(errMsg(e)));
  toast(md(w) + " " + hm(w) + " に延期しました");
}

/* ---------- 記録の詳細（電話番号・日時・クローザー・メモ） ----------
   cal＝カレンダーの商談から開いたとき {at: 押した枠の時刻, past: 過ぎた枠か, back: 同じ時間の一覧から開いたなら、閉じたときに戻る一覧 {d, list, past}}。
   リマインド・記録・通知から開くときは無し（2026-10-09 v50） */
const telHref = t => "tel:" + String(t || "").replace(/[^\d+]/g, "");
let detailRec = null, detailBack = null;
function openDetail(r, cal) {
  if (!r) return;
  detailRec = r; detailBack = (cal && cal.back) || null;
  const m = r.memo || {}, mine = r.isTask ? canEditTask(r) : r.uid === U, w = m.when, now = new Date();
  $("rdTitle").innerHTML = resChip(r.r) + " " + esc(r.isTask ? ([r.title, m.shop].filter(Boolean).join(" ") || r.r) : (m.shop || "（店名なし）"));
  const rows = [];
  if (r.canceled) rows.push(["状態", CX_BADGE + (r.canceledAt ? ` <small>${md(tsd(r.canceledAt))} ${hm(tsd(r.canceledAt))} に取り消し${r.canceledBy && r.canceledBy !== r.uid ? "（" + esc(nameOf(r.canceledBy)) + "）" : ""}</small>` : "")]);
  if (w) {
    const mins = Math.round((w - now) / 6e4);
    const left = mins > 0 && mins < 24 * 60 ? `<span class="rd-left">あと${mins >= 60 ? Math.floor(mins / 60) + "時間" + (mins % 60 ? mins % 60 + "分" : "") : mins + "分"}</span>` : mins <= 0 && keepsLate(r) && !r.done ? `<span class="badge late">過ぎています</span>` : "";
    rows.push([r.isTask ? "日時" : r.r === "アポ" ? "商談日時" : "かけ直す日時", `<b class="num">${dayWord(w)} ${md(w)} ${hm(w)}${r.r === "アポ" && !r.isTask ? "〜" + hm(new Date(w.getTime() + APO_MIN * 6e4)) : ""}</b>${left}`]);
  } else if (r.r === "アポ") rows.push(["面談日時", `<span class="badge late">日時未定</span>` + (r.src === "old" ? OLD_BADGE : "")]);
  if (r.isTask && m.shop && r.title) rows.push(["店名", esc(m.shop)]);
  if (r.r === "アポ" && m.closer) rows.push(["クローザー", `<i class="dot-c" style="background:${CCOL(m.closer)}"></i>${esc(CNAME(m.closer))}`]);
  if (r.isTask) rows.push(["担当", esc(nameOf(r.uid)) + (r.by && r.by !== r.uid ? `<small>作成 ${esc(nameOf(r.by))}</small>` : "")]);
  else rows.push([r.r === "アポ" ? "獲得" : "担当", esc(nameOf(r.uid)) + (r.pre ? " " + PRE_BADGE + `<small>KPIに数えない${r.enteredBy && r.enteredBy !== r.uid ? "・入力 " + esc(nameOf(r.enteredBy)) : ""}</small>` : `<small>${md(r.t)} ${hm(r.t)}</small>`)]);
  rows.push(["メモ", m.text ? `<span class="rd-memo">${esc(m.text)}</span>` : `<span class="rd-none">なし</span>`]);
  if (!r.isTask && r.r === "アポ") rows.push(["カレンダーの説明", m.info ? `<span class="rd-memo">${esc(m.info)}</span>` : `<span class="rd-none">なし（「メモを編集」から貼り付けると、クローザーのカレンダーに入ります）</span>`]);
  $("rdTel").innerHTML = m.tel
    ? `<a class="rd-call" href="${telHref(m.tel)}"><span>☎</span><b class="num">${esc(m.tel)}</b><small>押すと電話をかける</small></a><button class="rd-copy" id="rdCopy">コピー</button>`
    : `<div class="rd-notel">電話番号は入っていません${mine ? "（「" + (r.isTask ? "編集" : "メモを編集") + "」から入れられます）" : ""}</div>`;
  $("rdBody").innerHTML = rows.map(([k, v]) => `<div class="rd-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
  const acts = [];
  if (r.isTask && mine && !r.done) acts.push(`<button class="primary" data-a="done">${r.r === "再架電" ? "かけた（結果を押す）" : "完了にする"}</button>`, `<button data-a="later">明日へ延期</button>`);
  if (!r.isTask && mine && r.r === "再架電" && !r.done && !r.canceled && w) acts.push(`<button class="primary" data-a="done">かけた（結果を押す）</button>`, `<button data-a="later">明日へ延期</button>`);
  /* アポからは、前確の予定をそのまま作れる */
  if (canResched(r)) acts.push(`<button data-a="rs">日程を変える（リスケ）</button>`);
  if (!r.isTask && r.r === "アポ" && !r.canceled) acts.push(`<button data-a="prec">＋ 前確の予定を作る</button>`);
  /* 予定を取り消す（キャンセル／入れ間違いで消す）：取った本人・管理者・そのアポのクローザー */
  if (canCancel(r)) acts.push(`<button class="cx-btn" data-a="cx">予定を取り消す</button>`);
  $("rdActs").innerHTML = acts.join(""); $("rdActs").hidden = !acts.length;
  $("rdEdit").hidden = !mine;
  $("rdEdit").textContent = r.isTask ? "編集" : "メモを編集";
  /* カレンダーから開いたときだけ：同じ時間にもう1件（ほかのクローザーで）入れる。前の一覧にあった「この時間にアポを追加」と同じ条件・同じ動き */
  const at = cal && cal.at;
  $("rdNew").hidden = !(at && !cal.past && slotOpen(at, null, calCloser));
  $("rdNew").onclick = () => { closeDetail({noBack: true}); newApoAt(at); };
  $("rdScrim").hidden = $("recDetail").hidden = false;
  if ($("rdCopy")) $("rdCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(m.tel); toast("電話番号をコピーしました"); }
    catch (_) { const s = getSelection(), rg = document.createRange(); rg.selectNodeContents($("rdTel").querySelector("b")); s.removeAllRanges(); s.addRange(rg); toast("選択しました。コピーしてください"); }
  };
}
/* 閉じる。カレンダーの同じ時間の一覧から開いた詳細なら、一覧に戻る（編集などへ進むときは noBack で戻らない）。
   戻るときの一覧は、その間に変わった枠があれば今の中身に差し替える */
function closeDetail(opt) {
  $("rdScrim").hidden = $("recDetail").hidden = true; detailRec = null;
  const back = detailBack; detailBack = null;
  if (back && !(opt && opt.noBack)) showApoDetail(back.d, back.list.map(s => allSlots().find(x => x.id === s.id) || s), back.past);
}
$("rdClose").onclick = () => closeDetail(); $("rdScrim").onclick = () => closeDetail();
$("rdEdit").onclick = () => { const r = detailRec; closeDetail({noBack: true}); if (r) (r.isTask ? openTask(r) : openMemo(r)); };
$("rdActs").onclick = e => {
  const b = e.target.closest("button"); if (!b || !detailRec) return;
  const r = detailRec; closeDetail({noBack: true});
  if (b.dataset.a === "done") markDone(r);
  if (b.dataset.a === "later") postpone(r);
  if (b.dataset.a === "prec") openTask(null, {kind: "前確", shop: (r.memo || {}).shop, tel: (r.memo || {}).tel, apoWhen: (r.memo || {}).when});
  if (b.dataset.a === "cx") openCancel(r);
  if (b.dataset.a === "rs") openResched(r);
};

/* ============================================================
   予定を取り消す（社長の指示 2026-10-02「既に入ってる予定を削除する機能」）
   ・キャンセル（記録は残す）：記録に「キャンセル」の印。KPIの数はそのまま。カレンダーの枠を空ける
   ・入れ間違い（記録ごと消す）：記録を消し、KPIの数も1件減らす（10月より前の案件は元から数えていない）
   どちらもクローザーのGoogleカレンダーの招待は、カレンダー連携の係（5分おき）が枠の無くなったアポを見て消す。
   消したあと10秒は［元に戻す］で、記録・枠・数を元どおりにする（その間に枠が別の商談で埋まったら戻せない）
   ============================================================ */
let cxRec = null;
async function openCancelById(id) {
  const r = await recById(id);
  if (!r) { toast("記録が見つかりませんでした"); return; }
  openCancel(r);
}
function openCancel(r) {
  if (!canCancel(r)) { toast("取り消せるのは、アポを取った本人・管理者・そのアポのクローザーだけです"); return; }
  cxRec = r;
  const m = r.memo || {}, w = m.when, apo = r.r === "アポ", erase = canErase(r);
  hideApoDetail();
  $("cxTitle").textContent = apo ? "このアポを取り消しますか？" : "この再架電の予定を取り消しますか？";
  $("cxTarget").innerHTML = `${resChip(r.r)} <b>${esc(m.shop || "（店名なし）")}</b>${r.pre ? PRE_BADGE : ""}` +
    `<small>${w ? (apo ? "商談 " : "かけ直し ") + md(w) + " " + hm(w) : "日時なし"}${apo && m.closer ? " ・ クローザー " + esc(CNAME(m.closer)) : ""} ・ ${apo ? "獲得" : "担当"} ${esc(nameOf(r.uid))}</small>`;
  const slot = apo && r.slotId ? "カレンダーの枠が空き、クローザーのGoogleカレンダーからも5分以内に消えます。" : "";
  $("cxCancelT").textContent = apo ? "キャンセルになった（記録は残す）" : "予定から外す（記録は残す）";
  $("cxCancelD").textContent = slot + (apo ? (r.pre ? "KPIには元から数えていません。" : "KPIのアポ数はそのまま（取った実績は残ります）。") : "リマインドから外れます。KPIの架電数はそのまま。") + "記録に「キャンセル」の印が付きます";
  $("cxDelete").hidden = !erase;
  $("cxNote").textContent = (erase ? "どちらも、" : "") + "消したあと10秒間は画面の下の［元に戻す］で戻せます" + (erase ? "" : "（記録ごと消せるのは、アポを取った本人と管理者だけです）");
  $("cxDeleteD").textContent = (r.pre ? "記録ごと消えます（KPIには元から数えていません）。" : "記録ごと消えて、KPIの" + (apo ? "アポ数と" : "") + "架電数も1件減ります（" + md(new Date(r.day + "T00:00")) + " の分）。") + slot;
  closeDetail({noBack: true});
  $("cxScrim").hidden = $("cxDlg").hidden = false;
}
function closeCancel() { $("cxScrim").hidden = $("cxDlg").hidden = true; cxRec = null; }
$("cxClose").onclick = closeCancel; $("cxScrim").onclick = closeCancel;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("cxDlg").hidden) closeCancel(); });
$("cxCancel").onclick = () => runCancel("cx");
$("cxDelete").onclick = () => runCancel("del");
async function runCancel(kind) {
  const r = cxRec; if (!r) return;
  closeCancel();
  try {
    const rs = await getDoc(doc(db, "records", r.id));
    if (!rs.exists()) { toast("もう消えています"); return; }
    const raw = rs.data();   // 元に戻すために、消す前の中身をそのまま取っておく
    let sraw = null;
    if (raw.slotId) { const ss = await getDoc(doc(db, "slots", raw.slotId)); if (ss.exists()) sraw = ss.data(); }
    if (kind === "cx") {
      const b = writeBatch(db);
      b.update(doc(db, "records", r.id), {pending: false, canceled: true, canceledAt: Timestamp.now(), canceledBy: U, slotId: null, undated: false});
      if (sraw) b.delete(doc(db, "slots", raw.slotId));
      await b.commit();
    } else {
      if (!canErase(r)) return;
      await deleteRec({...raw, id: r.id, slotId: sraw ? raw.slotId : null});
    }
    if (raw.slotId) { slots = slots.filter(s => s.id !== raw.slotId); if (curTab === "cal") renderCal(); }
    refreshHistSoon();
    toast(kind === "cx" ? "取り消しました（記録は「キャンセル」として残っています）" : "記録ごと消しました", "元に戻す", () => restoreCancel(kind, r.id, raw, sraw), 10000);
  } catch (e) { toast(errMsg(e)); }
}
async function restoreCancel(kind, id, raw, sraw) {
  try {
    await runTransaction(db, async tx => {
      if (sraw) {   // その間に同じクローザーの重なる時間へ別の商談が入っていたら戻さない
        const when = tsd(sraw.when);
        for (const off of OVERLAP_STEPS) {
          const s = await tx.get(doc(db, "slots", slotIdOf(new Date(when.getTime() + off * 6e4), sraw.closer)));
          if (s.exists() && s.data().recId !== id) throw new Error("TAKEN");
        }
      }
      if (kind === "del") {
        tx.set(doc(db, "records", id), raw);
        if (!raw.pre) tx.set(doc(db, "stats", raw.day), statInc(raw.uid, raw.r, raw.hour, 1, raw.mb), {merge: true});
      } else {
        tx.update(doc(db, "records", id), {pending: !!raw.pending, canceled: false, canceledAt: null, canceledBy: null, slotId: raw.slotId || null, undated: !!raw.undated});
      }
      if (sraw) tx.set(doc(db, "slots", raw.slotId), sraw);
    });
    deletedIds.delete(id);
    refreshHistSoon();
    toast("元に戻しました");
  } catch (e) { toast(e && e.message === "TAKEN" ? "その時間に別の商談が入ったため、戻せませんでした" : errMsg(e)); }
}
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

/* 15秒ごとに、自分の今日の予定を見て「15分前」「ちょうど」を1回ずつ出す。
   鳴らした印は「記録の番号＠日時」で覚える（前は番号だけだったので、同じ日の中でリスケすると新しい日時の通知が出なかった。テスター 2026-10-09） */
const snoozed = {};
function checkNotifs() {
  if (!started) return;
  const now = Date.now(), key = "team-fired-" + dk(today());
  const fired = lsGet(key, {});
  for (const r of todayMine()) {
    if (r.memo.remind === false) continue;
    const w = r.memo.when.getTime(), k = r.id + "@" + w;
    if (snoozed[r.id] && now >= snoozed[r.id]) { delete snoozed[r.id]; showAlert(r, "now"); return; }
    if (!fired[k + ":now"] && now >= w && now < w + 30 * 6e4) { fired[k + ":now"] = 1; fired[k + ":pre"] = 1; lsSet(key, fired); showAlert(r, "now"); return; }
    if (!fired[k + ":pre"] && now >= w - 15 * 6e4 && now < w) { fired[k + ":pre"] = 1; lsSet(key, fired); showAlert(r, "pre"); return; }
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
/* 予定が0件の日に出す、前向きになる一言（日ごとに替わる。同じ日は同じ言葉） */
const CHEERS = [
  "今日の1本目が、未来のアポ。いってらっしゃい！",
  "今日の予定は、今日つくれる。いきましょう！",
  "まずは1本。声があったまったら、流れは来ます",
  "断られても大丈夫。アポはその先で待ってます",
  "今日のヒーローは、あなたかも。いきましょう！",
  "笑顔の声は、電話の向こうにもちゃんと届きます",
  "1本ずつ、ていねいに。それがいちばんの近道です",
  "昨日の自分を1本こえたら、今日は勝ち！"
];
/* 毎朝の一言は、予定があってもなくても出す。言葉は開くたびにランダム（社長のフィードバック 2026-10-02） */
const cheerOf = () => CHEERS[Math.floor(Math.random() * CHEERS.length)];
function showDaySum() {
  const list = todayMine(), now = new Date();
  $("dsDate").textContent = md(today());
  $("dsCheer").textContent = cheerOf();
  $("dsCount").textContent = list.length + "件";
  $("dsList").innerHTML = list.length ? list.map(r => {
    const past = r.memo.when < now;
    return `<div class="ds-row tap${past ? " past" : ""}" data-id="${esc(r.id)}" tabindex="0"><span class="num ds-t">${hm(r.memo.when)}</span><span class="ds-b">${resChip(r.r)} <b>${esc(r.isTask ? [r.title, r.memo.shop].filter(Boolean).join(" ") || r.r : (r.memo.shop || "（店名なし）"))}</b>${past ? `<span class="badge late">過ぎています</span>` : ""}${r.memo.text ? `<small>${esc(r.memo.text)}</small>` : ""}</span></div>`;
  }).join("") : `<div class="ds-empty">今日の予定はまだありません。取れたアポや再架電は、ここに並びます</div>`;
  $("dsGo").hidden = !list.length;
  $("dsOk").textContent = list.length ? "確認した" : "いってきます！";
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
/* 「↻ 最新にする」：とっておいた数字を捨てて読み直す（KPIは開いたとき・期間を変えたときにしか読まないため。社長の指示） */
$("kpiRefresh").onclick = async () => {
  const b = $("kpiRefresh"); b.disabled = true;
  Object.keys(statCache).forEach(k => delete statCache[k]);
  try { await renderKpi(); toast("最新の数字にしました（" + hm(new Date()) + "）"); } finally { b.disabled = false; }
};
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
const NO_ANSWER = ["留守", "繋がらない", "使われてない", "使われていない"];   // 電話に出てもらえなかった結果
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
  /* 対応数（電話に出てもらった数）＝架電から 留守・繋がらない・使われてない を引いたもの */
  const ans = n - NO_ANSWER.reduce((a, k) => a + (c[k] || 0), 0);
  return {n, apo, c, ans, apoRate: n ? apo / n * 100 : 0, connRate: n ? conn / n * 100 : 0, ansRate: n ? ans / n * 100 : 0,
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
  /* 表の行を押して絞れるのも、選択肢に出る人（有効なプレイヤー）だけ。ほかの人の行は押せない（テスターの指摘） */
  const pickable = id => !!members[id] && members[id].status === "active" && isPlayer(members[id]);
  /* 選べるメンバーは「プレイヤー」の人だけ（社長のフィードバック 2026-10-02。役職がまだ無い人はプレイヤー扱い） */
  sel.innerHTML = `<option value="all">メンバー：全員</option>` + ids.filter(pickable).map(id => `<option value="${esc(id)}">メンバー：${esc(members[id].name)}${id === U ? "（自分）" : ""}</option>`).join("");
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : "all"; member = sel.value;
  let data, pdata;
  try { [data, pdata] = await Promise.all([loadStats(a, b), loadStats(pa, a)]); }
  catch (e) { $("tiles").innerHTML = `<div class="empty">読み込めませんでした</div>`; return; }
  if (seq !== kpiSeq) return;
  $("kpiAt").textContent = hm(new Date()) + " 時点";
  const s = sumStats(data, member), p = sumStats(pdata, member);
  $("tiles").innerHTML = [
    ["架電", s.n, "", delta(s.n, p.n)], ["対応数", s.ans, "", delta(s.ans, p.ans)],
    ["アポ", s.apo, "", delta(s.apo, p.apo)], ["アポ率", s.apoRate.toFixed(1), "%", delta(s.apoRate, p.apoRate, "%")],
    ["対応率", s.ansRate.toFixed(1), "%", delta(s.ansRate, p.ansRate, "%")], ["接続率", s.connRate.toFixed(1), "%", delta(s.connRate, p.connRate, "%")],
    ["1時間あたり", s.mins ? s.perHour.toFixed(1) : "–", s.mins ? "件" : "", s.mins ? delta(s.perHour, p.perHour, "件/時") : `<span class="d flat">&nbsp;</span>`],
    ["稼働時間", fmtMins(s.mins), "", delta(s.mins / 60, p.mins / 60, "時間")]
  ].map(([k, v, u, d]) => `<div class="card tile"><div class="k">${k}</div><div class="v">${v}<small>${u}</small></div>${d}</div>`).join("");

  const wd = workDays(a, b);
  const uids = new Set(ids); Object.values(data).forEach(d => Object.keys(d.c || {}).forEach(u => uids.add(u)));
  /* 表に出すのは、その期間に電話をかけた人と、プレイヤーの人（事務・管理職で0件の人は出さない） */
  const rows = [...uids].map(u => ({u, s: sumStats(data, u)})).filter(r => r.s.n || (members[r.u] && members[r.u].status === "active" && isPlayer(members[r.u])))
    .sort((x, y) => y.s.apo - x.s.apo || y.s.n - x.s.n);
  const maxN = Math.max(1, ...rows.map(r => r.s.n)), tot = sumStats(data, "all");
  const ph = s => s.mins ? s.perHour.toFixed(1) : "–";
  $("mtable").innerHTML = `<tr><th>メンバー</th><th>架電</th><th>対応</th><th>1時間あたり</th><th>アポ</th><th>アポ率</th><th>対応率</th><th>接続率</th><th>稼働</th><th>1日平均</th></tr>` +
    rows.map(({u, s}) => `<tr class="${pickable(u) ? "pick" : "nopick"}${u === U ? " me" : ""}" data-u="${esc(u)}" style="${member !== "all" && member !== u ? "opacity:.45" : ""}">
      <td class="name">${esc(nameOf(u))}</td><td><span class="meter">${s.n}<i style="width:${Math.round(s.n / maxN * 56)}px"></i></span></td><td>${s.ans}</td>
      <td><b>${ph(s)}</b></td><td>${s.apo}</td><td>${s.apoRate.toFixed(1)}%</td><td>${s.ansRate.toFixed(1)}%</td><td>${s.connRate.toFixed(1)}%</td><td>${fmtMins(s.mins)}</td><td>${(s.n / wd).toFixed(0)}</td></tr>`).join("") +
    `<tr><td class="name">チーム合計</td><td>${tot.n}</td><td>${tot.ans}</td><td><b>${ph(tot)}</b></td><td>${tot.apo}</td><td>${tot.apoRate.toFixed(1)}%</td><td>${tot.ansRate.toFixed(1)}%</td><td>${tot.connRate.toFixed(1)}%</td><td>${fmtMins(tot.mins)}</td><td>${(tot.n / wd).toFixed(0)}</td></tr>`;
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
/* カレンダーは2つ（2アカウント）まで（2026-10-03 社長の指示・石川さんの要望）。
   連携できている＝1つ目が読めている。2つ目は任意で、2つ目だけ未共有のときは status が partial */
const linkedSt = s => s === "ok" || s === "partial";
const gcalLinked = () => !!(busyMap[U] && linkedSt(busyMap[U].status));
const gcalAddr1 = () => String((me && (me.gcalEmail || me.email)) || "").trim();
const gcalAddr2 = () => String((me && me.gcalEmail2) || "").trim();
/* アドレスごとの状態（カレンダー連携の係が15分おきに確かめた結果） */
function addrState(a) {
  const g = busyMap[U], k = String(a || "").toLowerCase();
  const s = ((g && g.emails) || []).find(x => x && x.email === k);
  if (s) return s.status === "ok" ? "連携中" : "未共有";
  if (g && g.email === k) return linkedSt(g.status) ? "連携中" : g.status === "not_shared" ? "未共有" : "確認待ち";   // 前の版の係が書いた分
  return "確認待ち（15分以内）";
}
const invLabel = (v, a1, a2) => v === "2" ? "2つ目だけ（" + a2 + "）" : v === "both" ? "両方（同じ招待が2通）" : "1つ目だけ（" + a1 + "）";
function gcalState() {
  const g = busyMap[U];
  const at = g && g.updatedAt ? hm(g.updatedAt) + " 確認" : "";
  if (!g) return {cls: "", pill: "未共有", text: "まだ共有されていません。共有すると15分以内に「連携できました」に変わります"};
  if (g.status === "ok") return {cls: "ok", pill: "連携中", text: "予定を読み込めています（" + at + "）"};
  if (g.status === "partial") return {cls: "ok", pill: "連携中", text: "1つ目は読み込めています。2つ目はまだ共有されていません（" + at + "）"};
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
  if (document.activeElement !== $("gcalEmail2")) $("gcalEmail2").value = me.gcalEmail2 || "";
  $("gcalPill").className = "pill " + st.cls; $("gcalPill").textContent = st.pill;
  $("gcalStatus").textContent = st.text;
  const a1 = gcalAddr1(), a2 = gcalAddr2();
  $("gcalAddrs").innerHTML = a2 ? [a1, a2].map((a, i) => `${i + 1}つ目 ${esc(a)}：<b>${esc(addrState(a))}</b>`).join("<br>") : "";
  $("invRow").hidden = !a2;
  $("invNow").textContent = invLabel(me.gcalInvite, a1, a2);
  if (document.activeElement !== $("gcalAvail")) $("gcalAvail").value = me.gcalAvail || "";
  $("gcalAvailSt").textContent = availState(me.gcalAvail, busyMap[U]);
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
  $("ggNag").hidden = $("ggLater").hidden = $("ggOpenCal").hidden = linked;
  $("ggClose").hidden = !linked;   // 共有がまだのうちは「あとで」と「設定を開く」だけ。済んだら「完了」
  const a2 = gcalAddr2();
  $("ggSt2").textContent = a2 ? "2つ目 " + a2 + "：" + addrState(a2) + "（アポの招待：" + invLabel(me.gcalInvite, gcalAddr1(), a2) + "）" : "使わない人は空のままでOK";
}
function openGcalGuide() {
  if (!me) return;
  if (document.activeElement !== $("ggEmail")) $("ggEmail").value = me.gcalEmail || me.email || "";
  if (document.activeElement !== $("ggEmail2")) $("ggEmail2").value = me.gcalEmail2 || "";
  $("ggScrim").hidden = $("gcalGuide").hidden = false;
  renderGuideStatus();
}
function closeGcalGuide() { $("ggScrim").hidden = $("gcalGuide").hidden = true; }
/* まだ共有していないクローザーには、共有が済むまでアプリを開くたびに手順を出す
   （社長の指示 2026-10-02「共有が済むまで毎回催促」。前は1日1回だった）。
   「あとで」で閉じても、読み込み直したとき・30分以上ほかの画面にいて戻ってきたときにまた出す */
let ggShown = false, ggWait = null, hiddenAt = 0;
function maybeGcalGuide() {
  if (!me || !me.closer || !busyLoaded || gcalLinked() || ggShown) return;
  if (document.querySelector('[role="dialog"]:not([hidden]):not(#gcalGuide)') || !$("alertBar").hidden) { clearTimeout(ggWait); ggWait = setTimeout(maybeGcalGuide, 4000); return; }   // 今日の予定・入力・取り消しなどの画面や、電話のリマインドが出ていたら後で
  ggShown = true;
  openGcalGuide();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt >= 30 * 60000) { ggShown = false; maybeGcalGuide(); }
  hiddenAt = 0;
});
$("gcalNag").onclick = openGcalGuide;
$("openGuide").onclick = openGcalGuide;
$("ggLater").onclick = () => { closeGcalGuide(); toast("共有が済むまで、開くたびにこのお知らせが出ます"); };
$("ggOpenCal").onclick = () => window.open("https://calendar.google.com/calendar/u/0/r/settings", "_blank", "noopener");
$("ggClose").onclick = closeGcalGuide; $("ggScrim").onclick = closeGcalGuide;
$("ggCopy").onclick = async () => {
  try { await navigator.clipboard.writeText(ADMIN_EMAIL); toast("コピーしました：" + ADMIN_EMAIL); }
  catch (_) { const s = getSelection(), rg = document.createRange(); rg.selectNodeContents($("gcalGuide").querySelector(".gg-mail")); s.removeAllRanges(); s.addRange(rg); toast("選択しました。コピーしてください"); }
};
/* アドレスの掃除。チャットやメールのリンクからコピーすると付く「mailto:」・< >・まわりのかっこや引用符・末尾の句読点・
   前後の空白（見えない空白も）を取り、全角の英数字・＠・．は半角に（2026-10-06 阪本さんの登録が「mailto:…」のまま保存され、
   カレンダーが読めなかった。句読点・かっこ・全角はテスター案） */
const cleanAddr = v => {
  let s = String(v || "").normalize("NFKC").replace(/[\u200b-\u200d\u2060\ufeff]/g, "").trim();
  const inner = s.match(/<([^<>]+)>/); if (inner) s = inner[1].trim();   // 「名前 <x@y.com>」の形 → 中だけ
  if (/^mailto:/i.test(s)) s = s.slice(7).split("?")[0];
  return s.replace(/^[\s<(\[「『"'“”‘’]+|[\s>)\]」』"'“”‘’.,;:、。]+$/g, "");
};
/* メールの形（…@group.calendar.google.com も同じ形）。後ろ（ドメイン）は英数字・点・ハイフンだけ */
const calIdOk = v => /^[^@\s:<>()「」『』、。,;]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v);
function saveGcalEmail(v) {
  v = cleanAddr(v);
  if (v && !calIdOk(v)) { toast("アドレスの形が正しくありません"); return; }
  updateDoc(doc(db, "members", U), {gcalEmail: v}).then(() => toast("保存しました。15分以内に確認されます")).catch(e => toast(errMsg(e)));
}
$("saveGcal").onclick = () => saveGcalEmail($("gcalEmail").value);
$("ggSave").onclick = () => saveGcalEmail($("ggEmail").value);
/* アポ可の枠のカレンダーの状態（連携の係が15分おきに確かめた結果） */
function availState(a, g) {
  a = String(a || "").trim().toLowerCase();
  if (!a) return "";
  if (!g || String(g.availCal || "").toLowerCase() !== a) return "確認待ち（15分以内）";
  if (g.availStatus !== "ok") return "まだ共有されていません（meguta1209@gmail.com に共有してください）";
  const days = new Set((g.avail || []).map(w => dk(w.s))).size;
  /* 終日の予定や「予定なし」にした予定は読めない（freeBusy に出ない）ので、0日のときは入れ方を知らせる（テスター指摘） */
  return days ? "連携中（これから3週間で " + days + "日分の枠）" : "連携中ですが、これから3週間の枠が0日です（枠の予定は時間を決めて「予定あり」で入れてください。終日・「予定なし」は読めません）";
}
function saveGcalAvail(v) {
  v = cleanAddr(v);
  if (v && !calIdOk(v)) { toast("カレンダーIDの形が正しくありません（…@group.calendar.google.com）"); return; }
  if (v && [gcalAddr1(), gcalAddr2()].some(a => a && a.toLowerCase() === v.toLowerCase())) { toast("予定を見るカレンダーと同じです。枠用の別のカレンダーを入れてください"); return; }
  updateDoc(doc(db, "members", U), {gcalAvail: v}).then(() => toast(v ? "保存しました。15分以内に緑の枠が出ます" : "枠のカレンダーを外しました")).catch(e => toast(errMsg(e)));
}
$("saveGcalAvail").onclick = () => saveGcalAvail($("gcalAvail").value);
function closeAvHow() { $("avScrim").hidden = $("avDlg").hidden = true; }
$("openAvHow").onclick = () => { $("avScrim").hidden = $("avDlg").hidden = false; };
$("avClose").onclick = closeAvHow; $("avScrim").onclick = closeAvHow;
$("avOpenCal").onclick = () => window.open("https://calendar.google.com/calendar/u/0/r/settings", "_blank", "noopener");
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("avDlg").hidden) closeAvHow(); });
/* 2つ目のカレンダー。新しく入れた・変えたときは、アポの招待をどちらに届けるかを選んでもらう */
function saveGcalEmail2(v) {
  v = cleanAddr(v);
  if (v && !calIdOk(v)) { toast("アドレスの形が正しくありません"); return; }
  if (v && v.toLowerCase() === gcalAddr1().toLowerCase()) { toast("1つ目と同じアドレスです"); return; }
  const before = gcalAddr2();
  const upd = {gcalEmail2: v};
  if (!v) upd.gcalInvite = "1";   // 2つ目を消したら、招待は1つ目へ
  updateDoc(doc(db, "members", U), upd).then(() => {
    toast(v ? "2つ目を保存しました。15分以内に確認されます" : "2つ目を消しました（アポの招待は1つ目に届きます）");
    if (v && v.toLowerCase() !== before.toLowerCase()) openInvite(v);
  }).catch(e => toast(errMsg(e)));
}
$("saveGcal2").onclick = () => saveGcalEmail2($("gcalEmail2").value);
$("ggSave2").onclick = () => saveGcalEmail2($("ggEmail2").value);
/* アポの招待はどちらに届けますか？（1つ目だけ／2つ目だけ／両方。あとから設定で変えられる） */
function openInvite(a2) {
  a2 = a2 || gcalAddr2(); if (!a2) return;
  const a1 = gcalAddr1(), cur = me.gcalInvite || "1";
  $("invOpts").innerHTML = [["1", "1つ目だけに届ける", a1], ["2", "2つ目だけに届ける", a2], ["both", "両方に届ける", "同じ招待が2通届きます（" + a1 + " と " + a2 + "）"]]
    .map(([v, t, s]) => `<button type="button" class="inv-opt${v === cur ? " on" : ""}" data-v="${v}" data-a2="${esc(a2)}" aria-pressed="${v === cur}"><b>${t}</b><small>${esc(s)}</small></button>`).join("");
  $("invLater").textContent = "あとで決める（今は" + (cur === "2" ? "2つ目" : cur === "both" ? "両方" : "1つ目") + "に届く）";   // 今の設定のまま届く
  $("invScrim").hidden = $("invDlg").hidden = false;
}
function closeInvite() { $("invScrim").hidden = $("invDlg").hidden = true; }
$("invOpts").onclick = e => {
  const b = e.target.closest(".inv-opt"); if (!b) return;
  const v = b.dataset.v, a2 = b.dataset.a2;
  closeInvite();
  updateDoc(doc(db, "members", U), {gcalInvite: v}).then(() => toast("アポの招待の届け先：" + invLabel(v, gcalAddr1(), a2))).catch(er => toast(errMsg(er)));
};
$("invLater").onclick = closeInvite; $("invScrim").onclick = closeInvite;
$("invChange").onclick = () => openInvite();
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("invDlg").hidden) { e.stopImmediatePropagation(); closeInvite(); } });   // 下の手順の画面までは閉じない
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("gcalGuide").hidden && $("invDlg").hidden) closeGcalGuide(); });
$("myCloser").onchange = () => {
  const v = $("myCloser").checked;   // 押した瞬間の状態で決める（保存中に表示が戻ることがあるため）
  updateDoc(doc(db, "members", U), {closer: v}).then(() => {
    toast(v ? "クローザーに入りました" : "クローザーから外れました");
    if (v && !gcalLinked()) { ggShown = true; openGcalGuide(); }   // オンにしたら、そのまま連携の手順へ
  }).catch(e => toast(errMsg(e)));
};
/* ============================================================
   前のカウンター（karte/counter/）からの引っ越し
   前のカウンターは同じサイトなので、この端末のブラウザに残っている記録
   （localStorage "kekka-counter-v1" = [{t: 押した時刻(ミリ秒), r: 結果}]）をそのまま読める。
   ・1件ずつ records（src:"old"）にして stats/{日} に足す → KPI・1時間あたり・稼働・履歴に、その日の分として出る
   ・アポには日時・クローザーの記録が無いので、カレンダーには入らず「日時未定のアポ」に出る（あとで日時を入れる。2026-10-02 社長の指示で変更）
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
const MOVE_FROM = "2026-10-01";                          // この日から後の分だけ入れる（それより前の日は入れない。竹内さんの指定）
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
  const list = oldEntries().filter(e => dk(new Date(e.t)) >= MOVE_FROM);
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
  if (TENANT.move === false) { $("moveNag").hidden = $("moveRow").hidden = true; return; }   // 他社版：前のカウンターは無い（同じ端末に自社の前の記録があっても読まない）
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
  if (n) $("moveOpen").innerHTML = `<span class="mt">📦 前のカウンターの記録が <b class="num">${n}</b>件あります（${days.map(d => md(new Date(d + "T00:00"))).join("・")}）</span><span class="mg">チーム版に引っ越す ›</span>`;
  $("moveState").textContent = !p ? "確かめています…" : p.owner ? "このブラウザの前の記録は、" + p.owner + "さんが引っ越し済みです"
    : !p.has ? "この端末のブラウザには、" + md(new Date(MOVE_FROM + "T00:00")) + "からの前のカウンターの記録はありません"
    : n ? "まだ引っ越していない記録が " + n + "件あります" : "引っ越し済みです（前のカウンターの記録は、そのまま残してあります）";
  $("openMove").hidden = !p || !p.has || !!p.owner;
  $("moveRow").hidden = !p || !p.has;   // このブラウザに前のカウンターの記録が無い人には出さない
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
            tx.set(doc(collection(db, "records")), {uid: who, r: e.r, t: Timestamp.fromDate(t), day: row.day, hour, mb, memo: null, undated: e.r === "アポ", pending: false, done: false, slotId: null, src: "old"});   // 引っ越したアポも日時未定として出す（あとで日時を入れられるように）
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
$("moveOpen").onclick = openMove;
/* 引っ越すものが無い人・引っ越さない人は、×で案内を消せる（設定からはいつでも開ける） */
$("moveX").onclick = () => { lsSet(MOVE_SKIP, true); renderMoveNag(); toast("消しました。設定の「前のカウンターから引っ越す」から、いつでも引っ越せます"); };
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
  $("pendList").innerHTML = pend.length ? pend.map(([id, m]) => `<div class="row mrow"><div class="t">${esc(m.name)}<span class="badge job">${esc(m.job || "役職未設定")}</span><small>${esc(m.email)}${m.closer ? " ・ クローザー希望" : ""}</small></div>
    <div class="acts2"><button class="ok" data-a="ok" data-id="${esc(id)}">承認</button><button class="ng" data-a="rej" data-id="${esc(id)}">却下</button></div></div>`).join("")
    : `<div class="row"><div class="t"><small>承認待ちの人はいません</small></div></div>`;
  const act = Object.entries(members).filter(([, m]) => m.status !== "pending").sort((a, b) => (a[1].status === "removed") - (b[1].status === "removed") || isExt(a[1]) - isExt(b[1]));
  const extN = act.filter(([, m]) => m.status === "active" && isExt(m)).length;
  $("memCount").textContent = act.filter(([, m]) => m.status === "active" && !isExt(m)).length + "人" + (extN ? "＋外部 " + extN + "人" : "");
  $("memList").innerHTML = act.map(([id, m]) => isExt(m) ? extRow(id, m) : `<div class="row mrow"><div class="avatar" style="background:${colorOf(id)};width:28px;height:28px;font-size:12px">${esc((m.name || "?")[0])}</div>
    <div class="t">${esc(m.name)}${m.role === "admin" ? "（管理者）" : ""}${m.status === "removed" ? ` <span class="badge pend">外した人</span>` : ""}<small>${esc(m.email)}${m.closer ? (busyMap[id] ? (linkedSt(busyMap[id].status) ? " ・ Googleカレンダー連携中" + (busyMap[id].status === "partial" ? "（2つ目は未共有）" : "") : " ・ Googleカレンダー未共有") : "") : ""}</small>
      ${m.status === "active" ? `<select class="job-sel" data-id="${esc(id)}" aria-label="${esc(m.name)}さんの役職">${m.job ? "" : `<option value="" selected>役職を選ぶ</option>`}${JOBS.map(j => `<option${m.job === j ? " selected" : ""}>${j}</option>`).join("")}</select>` : (m.job ? `<span class="badge job">${esc(m.job)}</span>` : "")}</div>
    <div class="acts2">${m.status === "active" ? `<button data-a="closer" data-id="${esc(id)}" aria-pressed="${!!m.closer}" class="${m.closer ? "ok" : ""}">${m.closer ? "クローザー" : "クローザーにする"}</button>` : ""}
    ${m.role !== "admin" ? (m.status === "active" ? `<button class="ng" data-a="rm" data-id="${esc(id)}">外す</button>` : `<button data-a="back" data-id="${esc(id)}">戻す</button>`) : ""}</div></div>`).join("");
}
/* 外部クローザーの行（名簿）：ログインなしの印・招待のアドレス・カレンダーの状態。編集と外す／戻す */
function extRow(id, m) {
  const g = busyMap[id];
  const cal = !g ? "カレンダー確認待ち" : linkedSt(g.status) ? "カレンダー連携中" : "カレンダー未共有";
  const av = m.gcalAvail ? " ・ 枠：" + availState(m.gcalAvail, g) : "";
  return `<div class="row mrow"><div class="avatar" style="background:var(--ink3);width:28px;height:28px;font-size:12px">${esc((m.name || "?")[0])}</div>
    <div class="t">${esc(m.name)} <em class="ext-tag">外部・${m.closer ? "商談の担当" : "見るだけ"}</em>${m.status === "removed" ? ` <span class="badge pend">外した人</span>` : ""}<small>${m.closer ? "招待" : "アドレス"}：${esc(m.email || "")} ・ ${esc(cal)}${esc(av)}</small></div>
    <div class="acts2">${m.status === "active" ? `<button data-a="extEdit" data-id="${esc(id)}">編集</button><button class="ng" data-a="rm" data-id="${esc(id)}">外す</button>` : `<button data-a="back" data-id="${esc(id)}">戻す</button>`}</div></div>`;
}
let extEditing = null;
function openExt(id) {
  extEditing = id || null;
  const m = (id && members[id]) || {};
  $("extTitle").textContent = id ? "外部の人のカレンダーを直す" : "外部の人のカレンダーを足す";
  $("extName").value = m.name || "";
  $("extCloser").checked = !!m.closer;   // 新しく足すときは「見るだけ」（社長 2026-10-06「見たいだけ」）
  /* 前に「mailto:」付きで保存された人も、開いて保存し直せば直る */
  $("extMail").value = cleanAddr(m.email);
  $("extCal").value = m.gcalEmail && cleanAddr(m.gcalEmail) !== cleanAddr(m.email) ? cleanAddr(m.gcalEmail) : "";
  $("extAvail").value = cleanAddr(m.gcalAvail);
  $("extScrim").hidden = $("extDlg").hidden = false;
  setTimeout(() => $("extName").focus(), 50);
}
function closeExt() { $("extScrim").hidden = $("extDlg").hidden = true; extEditing = null; }
$("addExt").onclick = () => openExt(null);
$("extCancel").onclick = closeExt; $("extScrim").onclick = closeExt;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("extDlg").hidden) closeExt(); });
$("extSave").onclick = () => {
  const name = $("extName").value.trim(), mail = cleanAddr($("extMail").value), cal = cleanAddr($("extCal").value), avail = cleanAddr($("extAvail").value);
  if (!name) { toast("名前を入れてください"); return; }
  if (!calIdOk(mail)) { toast("アドレスの形が正しくありません"); return; }
  if (cal && !calIdOk(cal)) { toast("予定を見るカレンダーの形が正しくありません"); return; }
  if (avail && !calIdOk(avail)) { toast("枠のカレンダーIDの形が正しくありません"); return; }
  if (avail && [mail, cal].some(a => a && a.toLowerCase() === avail.toLowerCase())) { toast("枠のカレンダーは、予定を見るカレンダーとは別のものにしてください"); return; }
  if (mail.toLowerCase() === ADMIN_EMAIL) { toast("管理者のアドレスは使えません"); return; }
  /* 商談の担当（closer）か、見るだけ（calView）か。見るだけの人はアポ入力・おまかせ・招待に出ない */
  const asCloser = $("extCloser").checked;
  const data = {name, email: mail, gcalEmail: cal || mail, gcalAvail: avail, closer: asCloser, calView: !asCloser};
  const id = extEditing;
  const p = id ? updateDoc(doc(db, "members", id), data)
    : setDoc(doc(db, "members", "ext_" + randomId(12)), {...data, status: "active", role: "member", external: true, job: "外部", createdAt: serverTimestamp()});
  p.then(() => { toast((id ? name + "さんを直しました" : name + "さんを足しました（" + (asCloser ? "商談の担当" : "見るだけ") + "）") + "。15分以内にカレンダーが確認されます"); closeExt(); }).catch(e => toast(errMsg(e)));
};
function randomId(n) {
  const cs = "abcdefghijklmnopqrstuvwxyz0123456789", a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, x => cs[x % cs.length]).join("");
}
/* 役職を変える（管理者） */
document.addEventListener("change", e => {
  const s = e.target.closest("#memList select.job-sel"); if (!s || !s.value) return;
  const m = members[s.dataset.id] || {};
  updateDoc(doc(db, "members", s.dataset.id), {job: s.value}).then(() => toast(m.name + "さんを「" + s.value + "」にしました")).catch(er => toast(errMsg(er)));
});
document.addEventListener("click", e => {
  const b = e.target.closest("#pendList button, #memList button"); if (!b) return;
  const id = b.dataset.id, a = b.dataset.a, ref = doc(db, "members", id), m = members[id] || {};
  const arm = label => { if (b.dataset.arm) return true; b.dataset.arm = "1"; const o = b.textContent; b.textContent = label; setTimeout(() => { if (b.isConnected) { delete b.dataset.arm; b.textContent = o; } }, 2500); return false; };
  if (a === "ok") updateDoc(ref, {status: "active"}).then(() => toast(m.name + "さんを承認しました")).catch(er => toast(errMsg(er)));
  if (a === "rej" && arm("本当に却下")) deleteDoc(ref).then(() => toast("却下しました")).catch(er => toast(errMsg(er)));
  if (a === "rm" && arm("本当に外す")) updateDoc(ref, {status: "removed"}).then(() => toast(m.name + "さんを外しました")).catch(er => toast(errMsg(er)));
  if (a === "back") updateDoc(ref, {status: "active"}).then(() => toast(m.name + "さんを戻しました")).catch(er => toast(errMsg(er)));
  if (a === "closer") updateDoc(ref, {closer: !m.closer}).catch(er => toast(errMsg(er)));
  if (a === "extEdit") openExt(id);
});

/* 結果の項目の編集（管理者） */
let draftItems = [];
$("editItems").onclick = () => { draftItems = ITEMS.map(i => ({...i, desc: descOf(i), open: false})); drawItems(); $("itemSheet").hidden = false; };   // 説明は今出ているもの（決まった文も）を入れておく
$("itemCancel").onclick = () => $("itemSheet").hidden = true;
$("addItem").onclick = () => { const [bg, fg] = PALETTE[draftItems.length % PALETTE.length]; draftItems.push({k: "", bg, fg, open: false}); drawItems(); const ins = document.querySelectorAll("#itemList input:not(.desc)"); ins[ins.length - 1].focus(); };
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
    const ds = document.createElement("input"); ds.className = "desc"; ds.value = it.desc || ""; ds.maxLength = 80; ds.placeholder = "説明（どんなときに押すか）"; ds.oninput = () => { it.desc = ds.value; };
    wrap.appendChild(ds);
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
  setDoc(doc(db, "config", "items"), {list: list.map(({k, bg, fg, strike, desc}) => Object.assign({k, bg, fg}, strike ? {strike: true} : {}, (desc || "").trim() ? {desc: desc.trim()} : {}))})
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
  if (v === "cal") { rollCalDay(); renderCal(); } if (v === "kpi") renderKpi(); if (v === "remind") renderRemind(); if (v === "log") { renderLog(); if (logMode === "hist") loadHist(false); } if (v === "set") { renderAdmin(); renderGcal(); renderFeedback(); if (movePlan) renderMoveNag(); else refreshMove(); }
}
document.addEventListener("click", e => { const b = e.target.closest("[data-go]"); if (b) showTab(b.dataset.go); });
COL = Object.fromEntries(ITEMS.map(i => [i.k, i]));
buildGrid();

/* PC（広い画面）のカウント画面は2列：左＝結果ボタン、右＝次の予定・日時未定・戻す・直近の記録。
   スマホ・狭い画面は今まで通りの1列（並びを覚えておいて戻す） */
const WIDE = matchMedia("(min-width: 1000px)");
const SIDE_IDS = ["nextUp", "undatedMine", "gcalNag", "moveNag", "cntActs", "cntNote", "recentH", "recent", "recentAll"];
const COUNT_ORDER = [...$("v-count").children];
function layoutCount() {
  const sec = $("v-count");
  if (WIDE.matches) {
    const main = $("cntMain") || Object.assign(document.createElement("div"), {id: "cntMain", className: "cnt-main"});
    const side = $("cntSide") || Object.assign(document.createElement("div"), {id: "cntSide", className: "cnt-side"});
    COUNT_ORDER.forEach(el => (SIDE_IDS.includes(el.id) ? side : main).appendChild(el));
    sec.append(main, side); sec.classList.add("two-col");
  } else {
    COUNT_ORDER.forEach(el => sec.appendChild(el));
    ["cntMain", "cntSide"].forEach(id => { if ($(id)) $(id).remove(); });
    sec.classList.remove("two-col");
  }
}
layoutCount();
WIDE.addEventListener("change", layoutCount);

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
