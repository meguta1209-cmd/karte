/* ポケノート v1（2026-10-24）：社長専用のタスク・予定・メモ＋秘書。
   いまは「スマホの中だけ」（localStorage）に保存する。あとで Firebase（kekka-counter-2026 の hub/<社長のuid>/…）へ
   そのまま移せるように、1件＝1つの入れ物（id つき・日時は文字）で持つ。
     tasks:  {id, title, note, imp(重要), urg(急ぎ), due:"YYYY-MM-DD"|null, time:"HH:MM"|"", done, doneAt, createdAt, updatedAt, src:"me"}
     events: {id, title, date:"YYYY-MM-DD", allDay, start:"HH:MM", end:"HH:MM", note, color, createdAt, updatedAt, src:"me"}
     memos:  {id, text, status:"wait"(振り分け待ち)|"memo"(メモのまま)|"done"(振り分け済み), result:{kind,label}|null, createdAt, updatedAt}
     chat:   {id, role:"me"|"ai", text, at, status:"wait"(PCの秘書がまだ読んでいない)} */
(function () {
"use strict";
const KEY = "pocket-v1";
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
let tt = null;
function toast(msg) { const el = $("toast"); el.textContent = msg; el.classList.add("on"); clearTimeout(tt); tt = setTimeout(() => el.classList.remove("on"), 2400); }

/* ---------- 保存（スマホの中） ---------- */
let canSave = true;
function load() {
  try { const x = JSON.parse(localStorage.getItem(KEY)); if (x && x.v === 1) return Object.assign({tasks: [], events: [], memos: [], chat: []}, x); }
  catch (e) { canSave = false; }
  return {v: 1, tasks: [], events: [], memos: [], chat: []};
}
const db = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); canSave = true; }
  catch (e) { canSave = false; toast("保存できませんでした（このブラウザでは保存が使えません）"); }
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

/* ---------- 予定の部品 ---------- */
const COLORS = {blue: ["var(--blue)", "rgba(0,122,255,.14)"], orange: ["var(--orange)", "rgba(255,149,0,.16)"], purple: ["var(--purple)", "rgba(175,82,222,.14)"], green: ["var(--green)", "rgba(52,199,89,.16)"], red: ["var(--red)", "rgba(255,59,48,.14)"]};
const colorOf = e => COLORS[e.color] || COLORS.blue;
const eventsOn = s => db.events.filter(e => e.date === s).sort((a, b) => (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || toMin(a.start) - toMin(b.start));
function eventCell(e) {
  return `<div class="cell" data-eedit="${esc(e.id)}"><div class="time">${e.allDay ? "終日" : esc(e.start)}${e.allDay ? "" : `<small>${esc(e.end)}</small>`}</div><div class="bar" style="background:${colorOf(e)[0]}"></div>
    <div class="grow"><div class="t">${esc(e.title || "（予定）")}</div>${e.note ? `<div class="s">${esc(e.note.split("\n")[0])}</div>` : ""}</div></div>`;
}

/* ---------- 今日 ---------- */
function renderToday() {
  const n = new Date(), T = todayStr();
  $("tDate").textContent = `${n.getMonth() + 1}月${n.getDate()}日 ${WD[n.getDay()]}曜日`;
  const evs = eventsOn(T);
  const open = db.tasks.filter(t => !t.done);
  const over = open.filter(isOver), todays = open.filter(t => isToday(t) && !isOver(t));
  const doneToday = db.tasks.filter(t => t.done && t.doneAt && ymd(new Date(t.doneAt)) === T);
  const waiting = db.memos.filter(m => m.status === "wait").length;
  const next = evs.find(e => !e.allDay && toMin(e.end || e.start) > n.getHours() * 60 + n.getMinutes());
  const hello = n.getHours() < 11 ? "おはようございます。" : n.getHours() < 18 ? "おつかれさまです。" : "おつかれさまでした。";
  const say = hello + `今日は予定が${evs.length}件、今日のタスクが${todays.length}件です。` + (over.length ? `期限切れのタスクが${over.length}件あります。` : "") +
    (next ? `次は ${next.start}「${next.title}」。` : "") + (waiting ? `振り分け待ちのメモが${waiting}件。` : "");
  let h = `<div class="hisho"><div class="av">秘</div><div class="grow"><div class="t">${esc(say)}</div><div class="s">ポケノートのまとめ ・ ${hm(n)}</div></div></div>`;
  h += `<div class="sec"><span>予定</span><button data-goto="cal">すべて</button></div><div class="group">${evs.map(eventCell).join("") || `<div class="empty">今日の予定はありません</div>`}</div>`;
  const list = [...over.sort(byDue), ...todays.sort(byDue), ...doneToday];
  h += `<div class="sec"><span>今日のタスク</span><button data-goto="task">すべて</button></div><div class="group">${list.map(t => taskCell(t, true)).join("") || `<div class="empty">今日のタスクはありません</div>`}</div>`;
  h += `<p class="note">データはこのスマホの中に保存しています（あとでクラウドに移して、パソコンの秘書・Googleカレンダーとつなぎます）。${canSave ? "" : "<b>このブラウザでは保存が使えません。</b>"}</p>`;
  $("todayBody").innerHTML = h;
}

/* ---------- タスク ---------- */
let taskF = "quad";
$("taskSeg").addEventListener("click", e => { const b = e.target.closest("[data-f]"); if (!b) return; taskF = b.dataset.f; $("taskSeg").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); renderTasks(); });
$("taskAdd").onclick = () => taskForm(null, {});
function renderTasks() {
  const open = db.tasks.filter(t => !t.done);
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
    const done = db.tasks.filter(t => t.done).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
    $("taskBody").innerHTML = done.length ? `<div class="group">${done.slice(0, 200).map(t => taskCell(t, false)).join("")}</div><button class="btn danger" id="clearDone">完了したタスクを全部消す</button>`
      : `<div class="group"><div class="empty">完了したタスクはまだありません</div></div>`;
    const c = $("clearDone"); if (c) c.onclick = () => { if (!confirm("完了したタスク " + done.length + "件を消します。よろしいですか？")) return; db.tasks = db.tasks.filter(t => !t.done); save(); render(); toast("消しました"); };
  }
}
function toggleTask(id) {
  const t = db.tasks.find(x => x.id === id); if (!t) return;
  t.done = !t.done; t.doneAt = t.done ? nowIso() : null; t.updatedAt = nowIso(); save(); render();
  toast(t.done ? "完了にしました" : "未完了に戻しました");
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
    return `<button class="wd${s === T ? " today" : ""}${calMode === "day" && s === sel ? " sel" : ""}" data-day="${s}">${WD[i]}<b>${d.getDate()}</b><i class="${db.events.some(e => e.date === s) ? "on" : ""}"></i></button>`;
  }).join("") + `<button class="arrow" data-wk="1" aria-label="次の週">›</button>`;
  if (calMode === "week") {
    $("calBody").innerHTML = [0, 1, 2, 3, 4, 5, 6].map(i => { const s = ymd(addDays(ws, i)), evs = eventsOn(s);
      return `<div class="sec"><span>${mdw(s)}${s === T ? " ・ 今日" : ""}</span><button data-dadd="${s}">＋</button></div><div class="group">${evs.map(eventCell).join("") || `<div class="empty">予定なし</div>`}</div>`; }).join("");
    return;
  }
  const evs = eventsOn(sel), all = evs.filter(e => e.allDay), timed = evs.filter(e => !e.allDay);
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
  tl += timed.map(e => {
    const s = toMin(e.start), en = Math.max(s + 20, toMin(e.end || e.start)), n = groupN[e.id] || 1, l = laneOf[e.id] || 0, c = colorOf(e);
    return `<button class="ev2" data-eedit="${esc(e.id)}" style="top:${s / 60 * HOUR}px;height:${Math.max(22, (en - s) / 60 * HOUR - 2)}px;left:calc(52px + (100% - 56px) * ${l} / ${n});width:calc((100% - 56px) / ${n} - 2px);background:${c[1]};border-color:${c[0]};color:${c[0]}">${esc(e.title || "（予定）")}<small>${esc(e.start)}〜${esc(e.end)}</small></button>`;
  }).join("");
  if (sel === T) tl += `<div class="now" style="top:${nowMin / 60 * HOUR}px"></div>`;
  $("calBody").innerHTML = (all.length ? `<div class="allday">${all.map(e => `<button data-eedit="${esc(e.id)}" style="background:${colorOf(e)[1]};color:${colorOf(e)[0]}">終日 ${esc(e.title || "（予定）")}</button>`).join("")}</div>` : "") +
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
  if (e.target.closest("[data-eedit]")) return;
  const s = e.target.closest("[data-slot]"); if (s) { const h = Number(s.dataset.slot); eventForm(null, {date: ymd(calDate), start: pad(h) + ":00", end: pad(Math.min(23, h + 1)) + ":00"}); return; }
  const d = e.target.closest("[data-dadd]"); if (d) eventForm(null, {date: d.dataset.dadd});
});

/* ---------- メモ ---------- */
$("memoAdd").onclick = () => memoForm(null);
$("memoSearch").addEventListener("input", () => renderMemos());
function memoTag(m) {
  if (m.status === "done" && m.result) return `<div class="tag">→ ${esc(m.result.label)}</div>`;
  if (m.status === "memo") return `<div class="tag gray">メモのまま</div>`;
  return `<div class="tag gray">振り分け待ち（PCの秘書がつながったら振り分けます）</div>`;
}
function whenText(iso) {
  const d = new Date(iso), s = ymd(d), T = todayStr();
  return s === T ? "今日 " + hm(d) : s === ymd(addDays(new Date(), -1)) ? "昨日 " + hm(d) : (d.getMonth() + 1) + "月" + d.getDate() + "日";
}
function renderMemos() {
  const q = $("memoSearch").value.trim().toLowerCase();
  const list = db.memos.filter(m => !q || String(m.text).toLowerCase().includes(q)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $("memoBody").innerHTML = `<div class="group">${list.map(m => {
    const lines = String(m.text || "").split("\n"), head = lines[0] || "（空のメモ）", rest = lines.slice(1).join(" ").trim();
    return `<button class="memo" data-medit="${esc(m.id)}"><div class="t">${esc(head)}</div>${rest ? `<div class="s">${esc(rest)}</div>` : ""}${memoTag(m)}<div class="s" style="font-size:12px;margin-top:4px">${whenText(m.createdAt)}</div></button>`;
  }).join("") || `<div class="empty">${q ? "見つかりません" : "メモはまだありません。右上の✎か、下の欄から書けます"}</div>`}</div>`;
}
function addMemo(text) {
  const m = {id: newId(), text, status: "wait", result: null, createdAt: nowIso(), updatedAt: nowIso()};
  db.memos.push(m); save(); return m;
}

/* ---------- 秘書 ---------- */
function renderAi() {
  $("pcState").className = "pc";
  $("pcState").innerHTML = `<i></i>PCの秘書：まだつながっていません（送った文はためておきます）`;
  let h = `<div class="msg ai">ここに頼みごとを書いてください。いまはスマホの中にためておいて、PCの秘書とつながったら、まとめて届けます。</div>`, last = "";
  const list = db.chat.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  list.forEach((c, i) => {
    const d = new Date(c.at), day = ymd(d);
    const stamp = day === todayStr() ? "今日 " + hm(d) : (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm(d);
    if (day + pad(d.getHours()) !== last) { h += `<div class="when">${stamp}</div>`; last = day + pad(d.getHours()); }
    h += `<div class="msg ${c.role === "me" ? "me" : "ai"}" data-cedit="${esc(c.id)}">${esc(c.text)}</div>`;
    if (c.role === "me" && c.status === "wait" && i === list.length - 1) h += `<div class="stat">未送信（PCの秘書がつながったら届きます）</div>`;
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
  openSheet(t ? "タスクを直す" : "タスクを足す", `
    <input class="field" id="fTitle" placeholder="やること" value="${esc(v.title)}" autocomplete="off" enterkeyhint="done">
    <div class="lab">分け方（4マス）</div>
    <div class="fgroup"><div class="frow">重要${sw("fImp", v.imp)}</div><div class="frow">急ぎ${sw("fUrg", v.urg)}</div></div>
    <div class="lab">期限</div>
    <div class="fgroup"><div class="frow">日付<input type="date" id="fDate" value="${esc(v.due || "")}"></div><div class="frow">時刻（なくてもOK）<input type="time" id="fTime" value="${esc(v.time || "")}"></div></div>
    <div class="chips" id="fQuick">${quick.map(([l, d]) => `<button type="button" class="chip" data-q="${d}" aria-pressed="${(v.due || "") === d}">${l}</button>`).join("")}</div>
    <div class="lab">メモ</div>
    <textarea class="field" id="fNote" placeholder="（なくてもOK）">${esc(v.note || "")}</textarea>
    ${t ? `<button type="button" class="btn" id="fDone">${t.done ? "未完了に戻す" : "完了にする"}</button><button type="button" class="btn danger" id="fDel">このタスクを消す</button>` : ""}`, () => saveTask(t, v));
  $("fQuick").addEventListener("click", e => { const b = e.target.closest("[data-q]"); if (!b) return; $("fDate").value = b.dataset.q; if (!b.dataset.q) $("fTime").value = ""; $("fQuick").querySelectorAll("[data-q]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); });
  $("fDate").addEventListener("input", () => $("fQuick").querySelectorAll("[data-q]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.q === $("fDate").value))));
  if (t) {
    $("fDone").onclick = () => { closeSheet(); toggleTask(t.id); };
    $("fDel").onclick = () => { if (!confirm("このタスクを消します。よろしいですか？")) return; db.tasks = db.tasks.filter(x => x.id !== t.id); save(); closeSheet(); render(); toast("消しました"); };
  } else setTimeout(() => $("fTitle").focus(), 80);
}
function saveTask(t, v) {
  const title = $("fTitle").value.trim();
  if (!title) { toast("やることを入れてください"); return; }
  const due = $("fDate").value || null, time = due ? $("fTime").value || "" : "";
  const data = {title, note: $("fNote").value.trim(), imp: $("fImp").checked, urg: $("fUrg").checked, due, time, updatedAt: nowIso()};
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
  const n = new Date(), next = fromMin(Math.min(23 * 60, (n.getHours() + 1) * 60));
  const v = e || Object.assign({title: "", date: todayStr(), allDay: false, start: next, end: fromMin(Math.min(23 * 60 + 59, toMin(next) + 60)), note: "", color: "blue"}, pre);
  openSheet(e ? "予定を直す" : "予定を足す", `
    <input class="field" id="eTitle" placeholder="予定の名前" value="${esc(v.title)}" autocomplete="off" enterkeyhint="done">
    <div class="lab">日時</div>
    <div class="fgroup"><div class="frow">終日${sw("eAll", v.allDay)}</div><div class="frow">日付<input type="date" id="eDate" value="${esc(v.date)}"></div>
      <div class="frow" id="eRowS">開始<input type="time" id="eStart" value="${esc(v.start || "09:00")}"></div><div class="frow" id="eRowE">終了<input type="time" id="eEnd" value="${esc(v.end || "10:00")}"></div></div>
    <div class="lab">色</div>
    <div class="chips" id="eColor">${Object.keys(COLORS).map(k => `<button type="button" class="chip" data-c="${k}" aria-pressed="${(v.color || "blue") === k}" style="color:${(v.color || "blue") === k ? "#fff" : COLORS[k][0]};${(v.color || "blue") === k ? "background:" + COLORS[k][0] : ""}">●</button>`).join("")}</div>
    <div class="lab">メモ</div>
    <textarea class="field" id="eNote" placeholder="場所・相手など（なくてもOK）">${esc(v.note || "")}</textarea>
    ${e ? `<button type="button" class="btn danger" id="eDel">この予定を消す</button>` : ""}
    <p class="note">いまはこのスマホの中だけの予定です（Googleカレンダーとそろえるのは次の段階）。</p>`, () => saveEvent(e, v));
  const syncAll = () => { const a = $("eAll").checked; $("eRowS").hidden = $("eRowE").hidden = a; };
  $("eAll").addEventListener("change", syncAll); syncAll();
  $("eStart").addEventListener("change", () => { if (toMin($("eEnd").value) <= toMin($("eStart").value)) $("eEnd").value = fromMin(Math.min(23 * 60 + 59, toMin($("eStart").value) + 60)); });
  $("eColor").addEventListener("click", ev => { const b = ev.target.closest("[data-c]"); if (!b) return; $("eColor").querySelectorAll("[data-c]").forEach(x => { const on = x === b; x.setAttribute("aria-pressed", String(on)); x.style.background = on ? COLORS[x.dataset.c][0] : ""; x.style.color = on ? "#fff" : COLORS[x.dataset.c][0]; }); });
  if (e) $("eDel").onclick = () => { if (!confirm("この予定を消します。よろしいですか？")) return; db.events = db.events.filter(x => x.id !== e.id); save(); closeSheet(); render(); toast("消しました"); };
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
  const data = {title, date, allDay, start, end, note: $("eNote").value.trim(), color: c ? c.dataset.c : "blue", updatedAt: nowIso()};
  if (e) Object.assign(e, data);
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
    ${m ? `<div class="chips"><button type="button" class="chip" id="mTask">タスクにする</button><button type="button" class="chip" id="mEvent">予定にする</button><button type="button" class="chip" id="mKeep" aria-pressed="${m.status === "memo"}">メモのまま（振り分けない）</button></div>
      <p class="note">${m.status === "done" && m.result ? "→ " + esc(m.result.label) + "<br>" : ""}書いた日時：${esc(whenText(m.createdAt))}</p>
      <button type="button" class="btn danger" id="mDel">このメモを消す</button>` : `<p class="note">書いたメモは、PCの秘書がつながったら「予定・タスク・メモのまま」に振り分けます。</p>`}`, () => saveMemo(m));
  if (m) {
    const firstLine = () => ($("mText").value.split("\n")[0] || "").trim().slice(0, 60);
    $("mTask").onclick = () => { saveMemoText(m); taskForm(null, {title: firstLine(), note: $("mText").value.split("\n").slice(1).join("\n").trim(), memoId: m.id}); };
    $("mEvent").onclick = () => { saveMemoText(m); eventForm(null, {title: firstLine(), date: todayStr(), note: $("mText").value.split("\n").slice(1).join("\n").trim(), memoId: m.id}); };
    $("mKeep").onclick = () => { saveMemoText(m); m.status = m.status === "memo" ? "wait" : "memo"; m.result = null; m.updatedAt = nowIso(); save(); closeSheet(); render(); toast(m.status === "memo" ? "メモのままにしました" : "振り分け待ちに戻しました"); };
    $("mDel").onclick = () => { if (!confirm("このメモを消します。よろしいですか？")) return; db.memos = db.memos.filter(x => x.id !== m.id); save(); closeSheet(); render(); toast("消しました"); };
  } else setTimeout(() => $("mText").focus(), 80);
}
function saveMemoText(m) { const t = $("mText").value.trim(); if (t && t !== m.text) { m.text = t; m.updatedAt = nowIso(); save(); } }
function saveMemo(m) {
  const text = $("mText").value.trim();
  if (!text) { if (!m) { closeSheet(); return; } toast("中身が空です（消すときは下のボタン）"); return; }
  if (m) { m.text = text; m.updatedAt = nowIso(); } else addMemo(text);
  save(); closeSheet(); render(); toast(m ? "直しました" : "メモしました");
}
function markMemo(id, kind, label) { const m = db.memos.find(x => x.id === id); if (!m) return; m.status = "done"; m.result = {kind, label}; m.updatedAt = nowIso(); }

/* ---------- 押したとき（まとめて） ---------- */
document.addEventListener("click", e => {
  const t = e.target;
  const gt = t.closest("[data-goto]"); if (gt) { go(gt.dataset.goto); return; }
  const dn = t.closest("[data-tdone]"); if (dn) { e.stopPropagation(); toggleTask(dn.dataset.tdone); return; }
  const qa = t.closest("[data-qadd]"); if (qa) { const k = qa.dataset.qadd; taskForm(null, {imp: k[0] === "1", urg: k[1] === "1"}); return; }
  const te = t.closest("[data-tedit]"); if (te) { const x = db.tasks.find(y => y.id === te.dataset.tedit); if (x) taskForm(x); return; }
  const ee = t.closest("[data-eedit]"); if (ee) { const x = db.events.find(y => y.id === ee.dataset.eedit); if (x) eventForm(x); return; }
  const me = t.closest("[data-medit]"); if (me) { const x = db.memos.find(y => y.id === me.dataset.medit); if (x) memoForm(x); return; }
});

function render() {
  if (view === "today") renderToday(); else if (view === "task") renderTasks(); else if (view === "cal") renderCal(); else if (view === "memo") renderMemos(); else renderAi();
}
/* 日付が変わったら・別のタブで直したら、描き直す */
setInterval(() => { if ($("sheet").hidden && (view === "today" || view === "cal")) render(); }, 60000);
window.addEventListener("storage", ev => { if (ev.key === KEY) { Object.assign(db, load()); render(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden && $("sheet").hidden) render(); });
window.addEventListener("resize", () => { if (view === "cal") renderCal(); });

go("today");
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
