/* 筋トレアプリ（社長専用）：2026-11-09 デベロッパー
   データは全部この端末の中（localStorage）。サーバーには何も送らない。
   ?demo を付けて開くと、見本のデータ（本物とは別の置き場）で動く。 */
(function () {
  "use strict";
  const DEMO = /[?&]demo\b/.test(location.search);
  const KEY = DEMO ? "gym-demo-v1" : "gym-v1";
  const DAYS = window.GYM_DAYS, FOODS = window.GYM_FOODS, CATS = window.GYM_FOOD_CATS;
  const AV = window.GYM_AVATARS, AV_ORDER = window.GYM_AVATAR_ORDER;
  const $ = s => document.querySelector(s);
  const main = $("#main");

  /* ---------------- 日付 ---------------- */
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toDate = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return ymd(d); };
  const diffDays = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
  const WD = ["日", "月", "火", "水", "木", "金", "土"];
  const jp = s => { const d = toDate(s); return `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`; };
  const jpShort = s => { const d = toDate(s); return `${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`; };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const r1 = n => Math.round(n * 10) / 10;
  const fmtKg = n => String(Math.round(n * 100) / 100);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const short = name => name.replace(/（.*?）/g, "").replace(/\s+/g, "");

  /* ---------------- 置き場 ---------------- */
  function blank() {
    return {ver: 1, profile: {sex: "m", age: null, height: null, activity: 1.375, cut: 15, pkg: 1.8},
      avatar: "ane", weights: [], nextDay: "A", sessions: [], cur: null, meals: {}, myFoods: [], recent: [],
      plans: [], lastBackup: null, rest: 90, sound: true, combos: [], cond: null};
  }
  function migrate(o) {
    const b = blank();
    if (!o || typeof o !== "object") return b;
    const out = Object.assign(b, o);
    out.profile = Object.assign(blank().profile, o.profile || {});
    ["weights", "sessions", "myFoods", "recent", "plans", "combos"].forEach(k => { if (!Array.isArray(out[k])) out[k] = []; });
    if (!out.meals || typeof out.meals !== "object") out.meals = {};
    if (!AV[out.avatar]) out.avatar = "ane";
    if (!DAYS[out.nextDay]) out.nextDay = "A";
    /* 壊れた記録で画面が出なくならないように：A/B 以外の日・形のおかしい物は外す */
    const okDate = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const okItems = items => Array.isArray(items) && items.every(i => i && typeof i.id === "string" && Array.isArray(i.sets));
    out.sessions = out.sessions.filter(s => s && DAYS[s.day] && okDate(s.date) && okItems(s.items));
    if (out.cur && !(DAYS[out.cur.day] && okDate(out.cur.date) && okItems(out.cur.items))) out.cur = null;
    if (out.cur) out.cur.items = out.cur.items.filter(i => Object.keys(DAYS).some(k => DAYS[k].items.some(e => e.id === i.id)));
    out.weights = out.weights.filter(w => w && okDate(w.date));
    out.plans = out.plans.filter(okDate);
    Object.keys(out.meals).forEach(d => { if (!okDate(d) || !Array.isArray(out.meals[d])) delete out.meals[d]; });
    out.myFoods = out.myFoods.filter(f => f && typeof f.n === "string");
    out.recent = out.recent.filter(f => f && typeof f.n === "string");
    out.combos = out.combos.filter(c => c && typeof c.name === "string" && Array.isArray(c.items));
    return out;
  }
  let S;
  try { S = migrate(JSON.parse(localStorage.getItem(KEY) || "null")); } catch (e) { S = blank(); }
  if (DEMO && !S.sessions.length) S = demoData();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { alert("保存できませんでした（端末の空きが足りない、またはプライベートモードの可能性があります）。設定からバックアップを書き出してください。"); }
  }
  if (!DEMO && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* ---------------- 計算（目安） ---------------- */
  function latestWeight() { const w = S.weights.filter(x => x.kg > 0).sort((a, b) => a.date < b.date ? -1 : 1); return w.length ? w[w.length - 1].kg : null; }

  /* 体調：今日の分だけ使う。軽め＝セットを1つ減らし、重さを1割ほど下げる（軽めの日の記録は、次の提案の材料にしない） */
  const CONDS = [
    {id: "ok", name: "元気"}, {id: "sore", name: "筋肉痛"}, {id: "tired", name: "疲れてる"},
    {id: "sleep", name: "寝不足"}, {id: "sick", name: "体調わるい"}
  ];
  const condToday = () => (S.cond && S.cond.date === today()) ? S.cond.v : "ok";
  const isLight = () => condToday() !== "ok";
  const condName = id => (CONDS.find(c => c.id === id) || CONDS[0]).name;
  function condHtml() {
    const c = condToday();
    return `<div class="cats cond">${CONDS.map(x => `<button data-act="cond" data-v="${x.id}" class="${x.id === c ? "on" : ""}">${x.name}</button>`).join("")}</div>`;
  }
  /* 重さを下げる（「少し軽く」と、体調で軽めの日の両方で使う）：
     だいたい1割下げる。前回より1刻み以上は下げるが、前回の8割より下にはしない・0kg にはしない。
     下げられない時（小さい重さ）は、前回と同じ重さを返す */
  function reduceKg(kg, ex) {
    const st = ex.inc || 2.5;
    if (!(kg > 0)) return kg;
    let nk = Math.min(Math.floor(kg * 0.9 / st + 1e-9) * st, kg - st);
    nk = Math.max(nk, Math.ceil(kg * 0.8 / st - 1e-9) * st);
    nk = Math.round(nk * 100) / 100;
    return (nk > 0 && nk < kg) ? nk : kg;
  }
  /* 前回（軽めの日はのぞく）の、いちばん重いセットの重さ。軽めの日は、提案の重さではなく、これを元に下げる */
  function lastKg(ex) { const h = exHistory(ex.id); return h.length ? Math.max(...h[0].sets.map(x => Number(x.kg) || 0)) : null; }
  function lightHint(ex, plan) {
    const L = plan || lightPlan(ex), u = ex.timed ? "秒" : "回";
    const same = !ex.bw && L.kg != null && lastKg(ex) === L.kg;
    return `<span class="same">今日は軽め</span>（${L.kg != null && !ex.bw ? `${fmtKg(L.kg)}kg × ` : ""}${L.reps}${u}・${L.sets}セット${same ? "・重さは下げられないので同じ" : ""}）`;
  }
  function lightPlan(ex) {   /* 軽めの日のメニュー：{kg, reps, sets} */
    const s = suggest(ex), lk = lastKg(ex);
    const kg = ex.bw ? null : (lk > 0 ? reduceKg(lk, ex) : (s.kg != null ? s.kg : null));
    return {kg, reps: ex.timed || ex.bw ? Math.max(ex.min, Math.min(s.reps, ex.max)) : ex.min, sets: Math.max(1, ex.sets - 1)};
  }
  /* Mifflin-St Jeor の式：男性 10×体重 + 6.25×身長 − 5×年齢 + 5、女性は最後が −161。
     それに動く量の係数をかけて「1日に使う量」。目標はそこから cut% 減らす（基礎代謝より下にはしない）。
     たんぱく質は 体重 × pkg g。どれも目安（医療の助言ではない） */
  function calc() {
    const p = S.profile, w = latestWeight();
    if (!p.age || !p.height || !w) return null;
    const bmr = 10 * w + 6.25 * p.height - 5 * p.age + (p.sex === "f" ? -161 : 5);
    const tdee = bmr * p.activity;
    const kcal = Math.round(Math.max(tdee * (1 - p.cut / 100), bmr) / 10) * 10;
    return {w, bmr: Math.round(bmr), tdee: Math.round(tdee), kcal, p: Math.round(w * p.pkg)};
  }
  function dayTotal(d) {
    const list = S.meals[d] || [];
    return list.reduce((t, m) => ({kcal: t.kcal + m.kcal * m.q, p: t.p + m.p * m.q}), {kcal: 0, p: 0});
  }

  /* ---------------- 筋トレの提案 ---------------- */
  const allEx = () => Object.keys(DAYS).flatMap(k => DAYS[k].items);
  const exById = id => allEx().find(e => e.id === id);
  function exHistory(exId) {
    const out = [];
    const normal = S.sessions.filter(s => !s.light);
    (normal.some(s => (s.items || []).some(i => i.id === exId)) ? normal : S.sessions).slice().sort((a, b) => (a.date + (a.end || "")) < (b.date + (b.end || "")) ? 1 : -1).forEach(s => {
      const it = (s.items || []).find(i => i.id === exId);
      const sets = it ? it.sets.filter(x => x.done && Number(x.reps) > 0) : [];
      if (sets.length) out.push({date: s.date, sets});
    });
    return out;
  }
  function lastText(ex, sets) {
    const reps = sets.map(s => Number(s.reps)).join("・");
    if (ex.timed) return `${reps}秒`;
    if (ex.bw) return `${reps}回`;
    const kgs = [...new Set(sets.map(s => fmtKg(Number(s.kg) || 0)))];
    return kgs.length === 1 ? `${kgs[0]}kg × ${reps}回` : sets.map(s => `${fmtKg(Number(s.kg) || 0)}kg×${s.reps}`).join("・");
  }
  /* 増やし方（data.js の説明と同じ）。kind：first / up / rep / again / down / keep */
  function suggest(ex) {
    const h = exHistory(ex.id);
    if (!h.length) return {kind: "first", kg: null, reps: ex.min,
      text: ex.timed ? `はじめて：${ex.min}秒から。きれいな形でできる長さで` : `はじめて：軽めの重さで、きれいに${ex.max}回できる重さを探しましょう`};
    const last = h[0].sets, lt = lastText(ex, last);
    const full = last.length >= ex.sets;
    if (ex.timed || ex.bw) {
      const low = Math.min(...last.map(s => Number(s.reps)));
      const step = ex.timed ? 5 : 1, u = ex.timed ? "秒" : "回";
      if (full && low >= ex.max) return {kind: "keep", kg: null, reps: ex.max, last: lt, lastShort: `${low}${u}`, nextText: `${ex.max}${u}`, text: `${ex.max}${u}まで届きました。このままキープ`};
      if (full) { const n = Math.min(low + step, ex.max); return {kind: "rep", kg: null, reps: n, last: lt, lastShort: `${low}${u}`, nextText: `${n}${u}`, text: `次は +${step}${u}（${n}${u}をめざす）`}; }
      return {kind: "againBw", kg: null, reps: Math.max(low, ex.min), last: lt, lastShort: `${last.length}セット`, nextText: `${ex.sets}セット`, text: `<span class="same">前回は${last.length}セット</span>。次は${ex.sets}セットをめざす`};
    }
    const kg = Math.max(...last.map(s => Number(s.kg) || 0));
    const work = last.filter(s => (Number(s.kg) || 0) === kg);
    const reps = work.map(s => Number(s.reps)), low = Math.min(...reps);
    const okFull = work.length >= ex.sets;
    if (okFull && low >= ex.max) {
      const nk = kg + ex.inc;
      return {kind: "up", kg: nk, reps: ex.min, last: lt, lastShort: `${fmtKg(kg)}kg×${low}回`, next: `${fmtKg(nk)}kg`, nextText: `${fmtKg(nk)}kgで${ex.min}回`,
        text: `次は <span class="up">+${fmtKg(ex.inc)}kg</span>（${fmtKg(nk)}kg × ${ex.min}回）`};
    }
    if (okFull && low >= ex.min) {
      const n = Math.min(low + 1, ex.max);
      return {kind: "rep", kg, reps: n, last: lt, lastShort: `${fmtKg(kg)}kg×${low}回`, nextText: `${n}回`,
        text: `次は <span class="up">+1回</span>（${fmtKg(kg)}kg × ${n}回をめざす）`};
    }
    const prev = h[1];
    const prevFail = prev && (() => {
      const pk = Math.max(...prev.sets.map(s => Number(s.kg) || 0));
      const pw = prev.sets.filter(s => (Number(s.kg) || 0) === pk);
      return pk === kg && (pw.length < ex.sets || Math.min(...pw.map(s => Number(s.reps))) < ex.min);
    })();
    const nkDown = prevFail && kg > 0 ? reduceKg(kg, ex) : kg;
    if (prevFail && nkDown < kg) {
      const nk = nkDown;
      return {kind: "down", kg: nk, reps: ex.min, last: lt, lastShort: `${fmtKg(kg)}kg×${low}回`, nextText: `${fmtKg(nk)}kgで${ex.min}回`,
        text: `<span class="same">2回続けて届かなかったので、少し軽く</span>（${fmtKg(nk)}kg × ${ex.min}回）`};
    }
    return {kind: "again", kg, reps: ex.min, last: lt, lastShort: `${fmtKg(kg)}kg×${low}回`, nextText: `${ex.min}回`,
      text: `<span class="same">同じ重さでもう一度</span>（${fmtKg(kg)}kg × ${ex.min}回をめざす）`};
  }

  /* ---------------- トレーナーの言うこと ---------------- */
  /* 絵：avatars.js の img に PNG があれば表情ごとに使い、無い・読めない時は SVG */
  let coachMood = "normal";
  /* 表情が無い時に使う、近い表情（avatars.js の説明と同じ） */
  const MOOD_NEAR = {welcome: ["normal"], check: ["normal"], great: ["praise", "normal"], cheer: ["praise", "normal"], proud: ["praise", "normal"],
    praise: ["great", "cheer", "normal"], rage: ["angry", "normal"], angry: ["rage", "normal"], normal: []};
  function moodSrc(id, mood) {
    const a = AV[id] || AV.ane, im = a.img;
    return im && [mood, ...(MOOD_NEAR[mood] || []), "normal"].map(k => im[k]).find(Boolean);
  }
  function faceHtml(id, mood) {
    const a = AV[id] || AV.ane, src = moodSrc(id, mood);
    return src ? `<img class="avimg" data-av="${esc(AV[id] ? id : "ane")}" src="${esc(src)}" alt="">` : a.svg;
  }
  document.addEventListener("error", e => {
    const el = e.target;
    if (el && el.classList && el.classList.contains("avimg")) { const a = AV[el.dataset.av] || AV.ane; const span = document.createElement("span"); span.innerHTML = a.svg; const svg = span.firstElementChild; if (el.closest(".stage")) svg.setAttribute("preserveAspectRatio", "xMidYMid slice"); el.replaceWith(svg); }
  }, true);
  function coachLines() {
    const a = AV[S.avatar] || AV.ane, say = a.say, t = today(), c = calc();
    const dayName = DAYS[S.cur ? S.cur.day : S.nextDay].name.replace("（全身）", "");
    const v = {day: dayName};
    /* 表情：最初の一言で決め、食事の一言で上書きする時がある。
       welcome＝はじめて・ジムの日、check＝設定がまだ・体調、great＝やり終えた、cheer＝たんぱく質OK、proud＝体重が減った、
       angry＝3〜6日空いた・13時を過ぎて食事が空、rage＝7日以上空いた・食べすぎ */
    coachMood = "normal";
    if (!c) { coachMood = "check"; return [say.setup(v)]; }
    const lines = [];
    const doneToday = S.sessions.filter(s => s.date === t);
    const lastS = S.sessions.map(s => s.date).sort().pop();
    let wantSugg = false;
    const cd = condToday();
    const calm = () => coachMood === "normal" || coachMood === "welcome";
    if (S.cur) lines.push(say.going(v));
    else if (doneToday.length) { const ls = doneToday[doneToday.length - 1]; lines.push(ls.light ? say.lightDone({}) : say.doneToday({day: DAYS[ls.day].name.replace("（全身）", "")})); coachMood = "great"; }
    else if (cd === "sick") { lines.push(say.sick({})); coachMood = "check"; }
    else if (cd !== "ok") { lines.push(say.light({cond: condName(cd)})); coachMood = "check"; }
    else if (S.plans.includes(t)) { lines.push(say.planToday(v)); wantSugg = true; coachMood = "welcome"; }
    else if (lastS && diffDays(lastS, t) >= 3) { const g = diffDays(lastS, t); lines.push(say.gap({gap: g})); wantSugg = true; coachMood = g >= 7 ? "rage" : "angry"; }
    else if (!lastS) { lines.push(say.first(v)); coachMood = "welcome"; }
    else { lines.push(say.next(v)); wantSugg = true; }
    if (wantSugg) {
      const sg = DAYS[S.nextDay].items.map(ex => ({ex, s: suggest(ex)})).filter(x => x.s.kind !== "first" && x.s.kind !== "keep");
      const pick = ["up", "rep", "down"].map(k => sg.find(x => x.s.kind === k)).find(Boolean) || sg[0];
      if (pick) {
        const w = {ex: short(pick.ex.name), last: pick.s.lastShort, next: pick.s.next, nextText: pick.s.nextText};
        const k = pick.s.kind;
        lines.push(k === "up" ? say.up(w) : k === "rep" ? say.rep(w) : k === "down" ? say.down(w) : k === "againBw" ? say.againBw(w) : say.again(w));
      }
    }
    const meals = S.meals[t] || [], tot = dayTotal(t), h = new Date().getHours();
    if (!meals.length) { if (h >= 13) { lines.push(say.noMeal({})); if (calm()) coachMood = "angry"; } }
    else if (tot.kcal > c.kcal + 100) { const k = Math.round(tot.kcal - c.kcal); lines.push(say.kOver({k})); coachMood = k >= 500 ? "rage" : "angry"; }   /* 少しの食べすぎは怒る、+500kcal 以上は激怒 */
    else if (tot.p < c.p) lines.push(say.pLeft({p: Math.round(c.p - tot.p)}));
    else { lines.push(say.pOk({})); if (calm()) coachMood = "cheer"; }
    /* 体重が前より減った（最後の記録が3日以内）→ ほめる */
    const ws = S.weights.filter(x => x.kg > 0).sort((a, b) => a.date < b.date ? -1 : 1);
    const greeting = lastS ? diffDays(lastS, t) >= 3 : true;   /* はじめて・3日以上空いた時は、ほめる一言を出さない */
    if (!greeting && ws.length >= 2 && diffDays(ws[ws.length - 1].date, t) <= 3) {
      const d = r1(ws[ws.length - 2].kg - ws[ws.length - 1].kg);
      if (d > 0 && lines.length < 3) { lines.push(say.wDown({d: fmtKg(d)})); if (calm()) coachMood = "proud"; }
    }
    if (lines.length < 3 && S.sessions.length >= 3) {
      const days = S.lastBackup ? diffDays(S.lastBackup.slice(0, 10), t) : null;
      if (days === null || days >= 14) lines.push(say.backup({days: days === null ? (diffDays(S.sessions.map(s => s.date).sort()[0], t) || 1) : days}));
    }
    return lines.slice(0, 3);
  }

  /* ---------------- 画面のしくみ ---------------- */
  const TABS = [
    {id: "home", name: "ホーム", ic: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>'},
    {id: "train", name: "筋トレ", ic: '<path d="M6.5 6v12M17.5 6v12M3 9.5v5M21 9.5v5M6.5 12h11"/>'},
    {id: "food", name: "食事", ic: '<path d="M3 11h18a9 9 0 0 1-18 0zM9 7.5c0-1.6 1.6-1.6 1.6-3.5M13.4 7.5c0-1.6 1.6-1.6 1.6-3.5"/>'},
    {id: "cal", name: "予定", ic: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'},
    {id: "set", name: "設定", ic: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'}
  ];
  let tab = (location.hash || "").slice(1);
  if (!TABS.some(x => x.id === tab)) tab = "home";
  let foodDay = today(), calMonth = today().slice(0, 7), pickDay = null, openMemo = {};
  function go(t) { tab = t; history.replaceState(null, "", location.pathname + location.search + "#" + t); render(); window.scrollTo(0, 0); }
  function renderTabs() {
    $("#tabs").innerHTML = TABS.map(x => `<button data-tab="${x.id}" class="${x.id === tab ? "on" : ""}" aria-label="${x.name}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${x.ic}</svg>${x.name}</button>`).join("");
  }
  $("#tabs").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) go(b.dataset.tab); });
  function render() {
    renderTabs();
    const band = DEMO ? `<div class="demo-band">見本のデータです（本物の記録とは別の場所。さわっても本物は変わりません）</div>` : "";
    try { main.innerHTML = band + ({home: vHome, train: vTrain, food: vFood, cal: vCal, set: vSet}[tab])(); }
    catch (e) {   /* どこかがおかしくても、真っ白にしない（設定からバックアップの読み込み・戻しができるように） */
      main.innerHTML = band + `<h1 class="large">表示できませんでした</h1><div class="card"><div class="s">この画面を出す途中で止まりました：${esc(e && e.message)}</div>
        <div class="row2"><button class="btn sub small" data-tab-go="set">設定へ</button><button class="btn sub small" data-tab-go="home">ホームへ</button></div></div>`;
    }
  }
  main.addEventListener("click", e => { const b = e.target.closest("[data-tab-go]"); if (b) { e.stopPropagation(); go(b.dataset.tabGo); } }, true);
  function toast(msg) {
    const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
  }
  function sheet(html, onClick) {
    closeSheet();
    const bg = document.createElement("div"); bg.className = "sheet-bg"; bg.id = "sheetbg";
    bg.innerHTML = `<div class="sheet" role="dialog"><div class="grab"></div>${html}</div>`;
    bg.addEventListener("click", e => {
      if (e.target === bg || e.target.closest("[data-close]")) { closeSheet(); return; }
      if (onClick) onClick(e);
    });
    document.body.appendChild(bg);
    return bg;
  }
  function closeSheet() { const b = $("#sheetbg"); if (b) b.remove(); }
  const meter = (label, have, goal, unit, cls) => {
    const pct = goal ? Math.min(100, have / goal * 100) : 0, over = goal && have > goal;
    const left = goal - have;
    return `<div class="meter"><div class="top"><span>${label}</span><span class="num"><b>${Math.round(have).toLocaleString()}</b> / ${goal.toLocaleString()}${unit}</span></div>
      <div class="track"><div class="fillbar ${cls || ""} ${over && cls !== "p" ? "over" : ""}" style="width:${pct}%"></div></div>
      <div class="left">${left > 0 ? `あと <b class="num">${Math.round(left).toLocaleString()}${unit}</b>` : (cls === "p" ? "目標に届きました" : `目標より <b class="num">${Math.round(-left).toLocaleString()}${unit}</b> 多い`)}</div></div>`;
  };

  /* ---------------- ホーム ---------------- */
  function coachHtml() {
    const a = AV[S.avatar] || AV.ane;
    const lines = coachLines();   /* 先に言うことを決める（表情 coachMood もここで決まる） */
    /* 画像があるトレーナーは、ゲームの会話画面のように大きく（絵の下に吹き出しを重ねる）。SVG の時は小さい丸 */
    /* 引きで見せる：絵は頭から肩まで全部（縮めて真ん中）、左右は同じ絵をぼかして敷く */
    if (a.img) return `<div class="stage"><div class="pic"><div class="bg" style="background-image:url(&quot;${esc(moodSrc(S.avatar, coachMood))}&quot;)"></div>${faceHtml(S.avatar, coachMood)}</div><div class="talk"><div class="nm">${esc(a.name)}</div>${lines.map(l => `<p>${esc(l)}</p>`).join("")}</div></div>`;
    return `<div class="coach"><div class="face">${faceHtml(S.avatar, coachMood)}</div><div class="bubble"><div class="who">${esc(a.label)}</div>${lines.map(l => `<p>${esc(l)}</p>`).join("")}</div></div>`;
  }
  function vHome() {
    const t = today(), c = calc(), dk = S.cur ? S.cur.day : S.nextDay, D = DAYS[dk];
    const tot = dayTotal(t);
    const nextPlan = S.plans.filter(d => d >= t).sort()[0];
    const lastS = S.sessions.map(s => s.date).sort().pop();
    const ws = S.weights.slice().sort((a, b) => a.date < b.date ? -1 : 1);
    return `<h1 class="large">今日</h1><div class="date">${jp(t)}</div>
    ${coachHtml()}
    <div class="sec" style="margin-top:4px">今日の体調（押すとメニューが変わります）</div>${condHtml()}
    <div class="sec">${S.cur ? "やりかけのメニュー" : "次のメニュー"}</div>
    <div class="card">
      <div style="display:flex;align-items:center;gap:8px"><span class="pill ${dk}">${dk}日</span><b style="font-size:19px">${D.name}</b></div>
      <div class="s" style="margin-top:6px">${D.items.map(ex => esc(short(ex.name))).join("・")}</div>
      ${!S.cur && isLight() ? `<div class="s" style="margin-top:6px;color:var(--orange);font-weight:600">今日は軽め（セット−1・重さ−1割）</div>` : ""}
      <div style="margin-top:12px"><button class="btn" data-act="startgo">${S.cur ? "続きからやる" : `${dk}日をはじめる`}</button></div>
    </div>
    <div class="sec">今日の食事<button data-act="addfood">＋ 足す</button></div>
    <div class="card">${c ? meter("カロリー", tot.kcal, c.kcal, "kcal") + meter("たんぱく質", tot.p, c.p, "g", "p") + `<div class="note" style="margin:8px 0 0">目標は目安です（設定の数字から計算）。</div>`
      + (S.combos.length ? `<div class="cats" style="margin-top:10px;padding-bottom:0">${S.combos.map(cb => `<button data-act="combo" data-id="${cb.id}">＋ ${esc(cb.name)}</button>`).join("")}</div>` : "")
      : `<div class="s">設定で身長・体重・年齢を入れると、1日の目標が出ます。</div><div style="margin-top:10px"><button class="btn sub" data-act="toset">設定をひらく</button></div>`}</div>
    <div class="sec">体の記録<button data-act="weight">＋ 記録</button></div>
    <div class="card">${bodyCard()}</div>
    <div class="sec">ジム</div>
    <div class="group">
      <button class="cell" data-act="tocal"><div class="grow"><div class="t">次に行く予定</div><div class="s">${nextPlan ? jp(nextPlan) : "まだ決めていません（予定のタブで置けます）"}</div></div><span class="chev">›</span></button>
      <button class="cell" data-act="tocal"><div class="grow"><div class="t">前に行った日</div><div class="s">${lastS ? `${jp(lastS)}${diffDays(lastS, t) > 0 ? `（${diffDays(lastS, t)}日前）` : "（今日）"}` : "まだありません"}</div></div><span class="chev">›</span></button>
    </div>`;
  }
  const diffSign = n => (n > 0 ? "+" : n < 0 ? "−" : "±") + fmtKg(Math.abs(n));
  /* 体重・ウエストのグラフ（日付つきの折れ線。最後の60件） */
  let bodyTab = "kg";
  function bodyCard() {
    const key = bodyTab, unit = key === "kg" ? "kg" : "cm";
    const pts = S.weights.filter(w => w[key] > 0).sort((a, b) => a.date < b.date ? -1 : 1);
    const seg = `<div class="seg" style="width:100%;margin-bottom:10px"><button data-act="btab" data-v="kg" class="${key === "kg" ? "on" : ""}">体重</button><button data-act="btab" data-v="waist" class="${key === "waist" ? "on" : ""}">ウエスト</button></div>`;
    if (!pts.length) return seg + `<div class="s">まだ記録がありません。「＋ 記録」から${key === "kg" ? "体重" : "ウエスト"}を入れてください。</div>`;
    const L = pts[pts.length - 1], P = pts[pts.length - 2];
    return seg + `<div style="display:flex;justify-content:space-between;align-items:baseline"><span class="num" style="font-size:26px;font-weight:700">${fmtKg(L[key])}<small style="font-size:15px"> ${unit}</small></span><span class="s">${jpShort(L.date)}${P ? `・前より ${diffSign(r1(L[key] - P[key]))}${unit}` : ""}</span></div>
      ${lineChart(pts.slice(-60).map(p => ({date: p.date, v: p[key]})), unit)}
      <button class="memo-btn" style="margin-top:4px" data-act="bodylist">日付つきの一覧を見る ›</button>`;
  }
  function lineChart(pts, unit) {
    if (pts.length < 2) return `<div class="s" style="margin-top:6px">2回以上記録すると、グラフになります。</div>`;
    const vs = pts.map(p => p.v), mn = Math.min(...vs), mx = Math.max(...vs), pd = Math.max(.5, (mx - mn) * .15);
    const lo = mn - pd, hi = mx + pd, X0 = 40, X1 = 310, Y0 = 12, Y1 = 108;
    const t0 = toDate(pts[0].date).getTime(), t1 = toDate(pts[pts.length - 1].date).getTime();
    const xy = p => [X0 + (t1 > t0 ? (toDate(p.date).getTime() - t0) / (t1 - t0) : .5) * (X1 - X0), Y1 - (p.v - lo) / (hi - lo) * (Y1 - Y0)];
    const d = pts.map((p, i) => (i ? "L" : "M") + xy(p).map(n => n.toFixed(1)).join(" ")).join(" ");
    const md = s => { const x = toDate(s); return `${x.getMonth() + 1}/${x.getDate()}`; };
    const yMx = Y1 - (mx - lo) / (hi - lo) * (Y1 - Y0), yMn = Y1 - (mn - lo) / (hi - lo) * (Y1 - Y0);
    return `<svg class="wchart" viewBox="0 0 320 130" aria-label="${unit === "kg" ? "体重" : "ウエスト"}のグラフ">
      <line x1="${X0}" x2="${X1}" y1="${yMx.toFixed(1)}" y2="${yMx.toFixed(1)}" stroke="var(--line)" stroke-dasharray="3 3"/>
      <line x1="${X0}" x2="${X1}" y1="${yMn.toFixed(1)}" y2="${yMn.toFixed(1)}" stroke="var(--line)" stroke-dasharray="3 3"/>
      <text x="${X0 - 6}" y="${(yMx + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--sub)">${fmtKg(mx)}</text>
      <text x="${X0 - 6}" y="${(yMn + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--sub)">${fmtKg(mn)}</text>
      <path d="${d}" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.map(p => { const [x, y] = xy(p); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--blue)"/>`; }).join("")}
      <text x="${X0}" y="126" font-size="11" fill="var(--sub)">${md(pts[0].date)}</text>
      <text x="${X1}" y="126" text-anchor="end" font-size="11" fill="var(--sub)">${md(pts[pts.length - 1].date)}</text>
    </svg>`;
  }
  function bodyList() {
    const ws = S.weights.slice().sort((a, b) => a.date < b.date ? 1 : -1);
    sheet(`<div class="stitle"><h2>体の記録</h2><button data-close>とじる</button></div>
      <div class="group">${ws.length ? ws.map(w => `<div class="cell"><div class="grow"><div class="t">${jp(w.date)}</div><div class="s num">${w.kg > 0 ? `体重 ${fmtKg(w.kg)}kg` : ""}${w.kg > 0 && w.waist > 0 ? "・" : ""}${w.waist > 0 ? `ウエスト ${fmtKg(w.waist)}cm` : ""}</div></div><button class="memo-btn" style="color:var(--red)" data-act="wdel" data-d="${w.date}">消す</button></div>`).join("") : `<div class="empty">まだありません</div>`}</div>`, e => {
      const b = e.target.closest("[data-act=wdel]");
      if (b && confirm(`${jp(b.dataset.d)}の記録を消しますか？`)) { S.weights = S.weights.filter(w => w.date !== b.dataset.d); save(); closeSheet(); render(); bodyList(); }
    });
  }

  /* ---------------- 筋トレ ---------------- */
  let chooseDay = null;
  function vTrain() {
    if (S.cur) return vSession();
    const dk = chooseDay || S.nextDay, D = DAYS[dk];
    const recent = S.sessions.slice().sort((a, b) => (a.date + (a.end || "")) < (b.date + (b.end || "")) ? 1 : -1).slice(0, 6);
    return `<h1 class="large">筋トレ</h1><div class="date">次は <b>${DAYS[S.nextDay].name}</b>（1回やると、次は反対の日になります）</div>
    <div class="sec" style="margin-top:14px">今日の体調</div>${condHtml()}
    ${isLight() ? `<div class="card lightbox"><b>今日は軽めのメニュー</b>（${esc(condName(condToday()))}）<br>セットを1つ減らして、重さを1割ほど下げます。この日の記録は、次の「+2.5kg」などの提案には使いません。${condToday() === "sick" ? "<br><b>体調がわるい日は、休むのがいちばんです。</b>" : ""}<br><small>痛みがある所は、むりに動かさないでください。</small></div>` : ""}
    <div class="daypick">${Object.keys(DAYS).map(k => `<button data-act="pickday" data-day="${k}" class="${k === dk ? "on" : ""}">${k}日${k === S.nextDay ? "（次）" : ""}</button>`).join("")}</div>
    ${D.items.map(ex => { const s = suggest(ex), L = isLight(); return `<div class="ex"><div class="head"><div class="name">${esc(ex.name)}</div><button class="memo-btn" data-act="memo" data-ex="${ex.id}">${openMemo[ex.id] ? "とじる" : "やり方"}</button></div>
      ${openMemo[ex.id] ? `<div class="memo">${esc(ex.memo)}</div>` : ""}
      <div class="s">${L ? Math.max(1, ex.sets - 1) : ex.sets}セット × ${ex.min}〜${ex.max}${ex.timed ? "秒" : "回"}${ex.inc && !ex.bw ? `・上げる時は +${fmtKg(ex.inc)}kg` : ""}</div>
      ${s.last ? `<div class="last">前回：${esc(s.last)}</div>` : ""}<div class="hint">${L ? lightHint(ex) : s.text}</div></div>`; }).join("")}
    <div style="margin-top:16px"><button class="btn" data-act="start" data-day="${dk}">${dk}日をはじめる</button></div>
    <div class="sec">最近の記録</div>
    <div class="group">${recent.length ? recent.map(s => `<button class="cell" data-act="sess" data-id="${s.id}"><span class="pill ${s.day}">${s.day}</span><div class="grow"><div class="t">${jp(s.date)}</div><div class="s">${s.items.filter(i => i.sets.some(x => x.done)).length}種目</div></div><span class="chev">›</span></button>`).join("") : `<div class="empty">まだありません</div>`}</div>`;
  }
  function startSession(dk) {
    const light = isLight();
    S.cur = {day: dk, date: today(), start: new Date().toISOString(), light, cond: condToday(), items: DAYS[dk].items.map(ex => {
      const s = suggest(ex), h = exHistory(ex.id);
      if (light) {   /* 軽めの日：前回の重さから下げる（提案の重さからさらに下げない） */
        const L = lightPlan(ex), kg = L.kg != null ? fmtKg(L.kg) : "";
        return {id: ex.id, sets: Array.from({length: L.sets}, () => ({kg, reps: L.reps, done: false}))};
      }
      let kg = ex.bw ? "" : (s.kg != null ? s.kg : (h[0] ? Math.max(...h[0].sets.map(x => Number(x.kg) || 0)) : ""));
      if (kg !== "") kg = fmtKg(kg);
      return {id: ex.id, sets: Array.from({length: ex.sets}, () => ({kg, reps: s.reps, done: false}))};
    })};
    chooseDay = null; save();
  }
  function vSession() {
    const c = S.cur, D = DAYS[c.day];
    const done = c.items.reduce((n, i) => n + i.sets.filter(s => s.done).length, 0), all = c.items.reduce((n, i) => n + i.sets.length, 0);
    return `<h1 class="large">${c.day}日の途中${c.light ? `<span class="pill gray" style="font-size:14px;vertical-align:middle;margin-left:8px">軽め</span>` : ""}</h1><div class="date">${jp(c.date)}にはじめました・${done} / ${all}セット</div>
    <div class="note" style="margin:0 4px 4px">重さと回数は、前回からの提案が入っています${c.light ? "（今日は軽め）" : ""}。やったら右の ○ を押してください（休けいのタイマーが動きます）。</div>
    <div style="margin:8px 0 0"><button class="btn sub small" style="width:100%" data-act="restnow">⏱ 休けいタイマーだけ動かす（${S.rest ? fmtRest(S.rest) : "1分30秒"}）</button></div>
    ${c.items.map((it, ii) => { const ex = exById(it.id) || D.items[ii]; const s = suggest(ex); return `<div class="ex"><div class="head"><div class="name">${esc(ex.name)}</div><button class="memo-btn" data-act="memo" data-ex="${ex.id}">${openMemo[ex.id] ? "とじる" : "やり方"}</button></div>
      ${openMemo[ex.id] ? `<div class="memo">${esc(ex.memo)}</div>` : ""}
      ${s.last ? `<div class="last">前回：${esc(s.last)}</div>` : ""}<div class="hint">${c.light ? lightHint(ex) : s.text}</div>
      ${it.sets.map((st, si) => `<div class="setrow ${st.done ? "done" : ""}" data-i="${ii}" data-s="${si}"><span class="no">${si + 1}</span>
        ${ex.bw ? "" : `<div class="step"><button data-act="kg-" aria-label="重さを減らす">−</button><input type="number" inputmode="decimal" step="any" data-f="kg" value="${esc(st.kg)}" aria-label="重さ"><span class="u">kg</span><button data-act="kg+" aria-label="重さを増やす">＋</button></div>`}
        <div class="step"><button data-act="r-" aria-label="減らす">−</button><input type="number" inputmode="numeric" data-f="reps" value="${esc(st.reps)}" aria-label="${ex.timed ? "秒" : "回数"}"><span class="u">${ex.timed ? "秒" : "回"}</span><button data-act="r+" aria-label="増やす">＋</button></div>
        <button class="chk ${st.done ? "on" : ""}" data-act="chk" aria-label="このセットをやった">✓</button></div>`).join("")}
      <div style="display:flex;justify-content:space-between;margin-top:6px"><button class="memo-btn" data-act="addset" data-i="${ii}">＋ セットを足す</button>${it.sets.length > 1 ? `<button class="memo-btn" style="color:var(--sub)" data-act="delset" data-i="${ii}">− 最後のセットを消す</button>` : ""}</div></div>`; }).join("")}
    <div style="margin-top:16px"><button class="btn green" data-act="finish">おわって記録する</button></div>
    <div class="row2"><button class="btn red small" data-act="quit">やめる（記録しない）</button></div>`;
  }
  function finishSession() {
    const c = S.cur;
    const items = c.items.map(i => ({id: i.id, sets: i.sets.filter(s => s.done && Number(s.reps) > 0).map(s => ({kg: s.kg === "" ? null : Number(s.kg), reps: Number(s.reps), done: true}))})).filter(i => i.sets.length);
    if (!items.length) { if (!confirm("✓ が1つもありません。記録しないで終わりますか？")) return; S.cur = null; save(); render(); return; }
    S.sessions.push({id: uid(), date: c.date, day: c.day, start: c.start, end: new Date().toISOString(), items, light: !!c.light});
    S.nextDay = c.day === "A" ? "B" : "A";
    S.cur = null; stopRest(); save();
    toast(`記録しました。次は${S.nextDay}日です`);
    go("home");
  }
  function sessDetail(id) {
    const s = S.sessions.find(x => x.id === id); if (!s) return;
    sheet(`<div class="stitle"><h2>${jp(s.date)}・${s.day}日</h2><button data-close>とじる</button></div>
      <div class="group">${s.items.map(i => { const ex = exById(i.id); return `<div class="cell"><div class="grow"><div class="t">${esc(ex ? ex.name : i.id)}</div><div class="s">${esc(ex ? lastText(ex, i.sets) : "")}</div></div></div>`; }).join("")}</div>
      <div style="margin-top:14px"><button class="btn red" data-act="delsess" data-id="${s.id}">この記録を消す</button></div>`, e => {
      const b = e.target.closest("[data-act=delsess]");
      if (b && confirm("この日の記録を消しますか？（元に戻せません）")) { S.sessions = S.sessions.filter(x => x.id !== id); save(); closeSheet(); render(); toast("消しました"); }
    });
  }

  /* 休けいタイマー */
  /* 音：ボタンを押した時に音の部品を起こしておく（iPhone は、押した時でないと音を出せないため）。
     iPhone の Safari は振動（vibrate）が使えないので、音と画面の色で知らせる。画面を閉じている間は、タイマーは止まる */
  let actx = null;
  function wakeAudio() {
    try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === "suspended") actx.resume(); } catch (e) {}
  }
  function beep() {
    if (!S.sound || !actx) return;
    try {
      [0, .28, .56].forEach((t, i) => {
        const o = actx.createOscillator(), g = actx.createGain(), at = actx.currentTime + t;
        o.type = "sine"; o.frequency.value = i === 2 ? 1320 : 880;
        g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.4, at + .02); g.gain.exponentialRampToValueAtTime(0.0001, at + .22);
        o.connect(g); g.connect(actx.destination); o.start(at); o.stop(at + .25);
      });
    } catch (e) {}
  }
  const fmtRest = s => s >= 60 ? `${Math.floor(s / 60)}分${s % 60 ? (s % 60) + "秒" : ""}` : `${s}秒`;
  let restEnd = 0, restTimer = null;
  function startRest(sec) {
    wakeAudio();
    restEnd = Date.now() + sec * 1000; tickRest();
    clearInterval(restTimer); restTimer = setInterval(tickRest, 250);
  }
  function stopRest() { clearInterval(restTimer); restTimer = null; $("#rest").hidden = true; }
  function tickRest() {
    const el = $("#rest"), left = Math.ceil((restEnd - Date.now()) / 1000);
    el.hidden = false;
    if (left <= 0) {
      const a = AV[S.avatar] || AV.ane;
      el.className = "rest end"; el.innerHTML = `<div class="rface ${a.img ? "sq" : ""}">${faceHtml(S.avatar, "cheer")}</div><div class="tm" style="font-size:18px">${esc(a.say.restEnd({}))}</div><button data-r="x">とじる</button>`;
      clearInterval(restTimer); restTimer = null;
      beep();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      setTimeout(() => { if (!restTimer) el.hidden = true; }, 8000);
      return;
    }
    el.className = "rest";
    el.innerHTML = `<div class="tm"><small>休けい</small>${Math.floor(left / 60)}:${pad(left % 60)}</div><button data-r="30">＋30秒</button><button data-r="x">とめる</button>`;
  }
  $("#rest").addEventListener("click", e => {
    const b = e.target.closest("[data-r]"); if (!b) return;
    if (b.dataset.r === "30") { restEnd += 30000; tickRest(); } else stopRest();
  });

  /* ---------------- 食事 ---------------- */
  function vFood() {
    const d = foodDay, c = calc(), list = S.meals[d] || [], tot = dayTotal(d), t = today();
    return `<h1 class="large">食事</h1>
    <div class="daynav"><button data-act="fday" data-n="-1" aria-label="前の日">‹</button><span class="d">${d === t ? "今日・" : ""}${jp(d)}</span><button data-act="fday" data-n="1" aria-label="次の日" ${d >= t ? 'style="visibility:hidden"' : ""}>›</button></div>
    <div class="card">${c ? meter("カロリー", tot.kcal, c.kcal, "kcal") + meter("たんぱく質", tot.p, c.p, "g", "p")
      : `<div class="t num">${Math.round(tot.kcal).toLocaleString()}kcal・たんぱく質 ${r1(tot.p)}g</div><div class="s" style="margin-top:6px">設定で身長・体重・年齢を入れると、目標とあと何gかが出ます。</div>`}</div>
    <div class="note">目標と食べ物の数字は目安です（体の状態の判断や、医療の助言ではありません）。</div>
    <div style="margin-top:14px"><button class="btn" data-act="addfood">＋ 食べた物を足す</button></div>
    <div class="sec">いつもの食事（1回押すと、まとめて足す）<button data-act="combonew">＋ 作る</button></div>
    <div class="group">${S.combos.length ? S.combos.map(cb => { const k = cb.items.reduce((s, m) => s + m.kcal * m.q, 0), p = cb.items.reduce((s, m) => s + m.p * m.q, 0); return `<div class="cell pick"><button class="grow" style="text-align:left" data-act="combo" data-id="${cb.id}"><div class="t">${esc(cb.name)}</div><div class="s">${cb.items.map(m => esc(short(m.n)) + (m.q !== 1 ? "×" + m.q : "")).join("・")}<br><span class="num">${Math.round(k)}kcal・たんぱく質 ${r1(p)}g</span></div></button><button class="memo-btn" style="color:var(--red)" data-act="combodel" data-id="${cb.id}">消す</button><button class="plus" data-act="combo" data-id="${cb.id}" aria-label="まとめて足す">＋</button></div>`; }).join("")
      : `<div class="empty">「＋ 作る」で、よく食べる組み合わせ（例：朝＝おにぎり2個＋プロテイン）を入れておくと、1回押すだけで記録できます。</div>`}</div>
    <div class="sec">${d === t ? "今日" : "この日"}食べた物（${list.length}）</div>
    <div class="group">${list.length ? list.map(m => `<button class="cell food" data-act="meal" data-id="${m.id}"><div class="grow"><div class="t">${esc(m.n)}${m.q !== 1 ? ` <span class="amt">× ${m.q}</span>` : ""}</div><div class="s num">${Math.round(m.kcal * m.q)}kcal・たんぱく質 ${r1(m.p * m.q)}g</div></div><span class="chev">›</span></button>`).join("")
      : `<div class="empty">まだありません。上のボタンから足してください。</div>`}</div>`;
  }
  let pickCat = "recent", pickQ = "";
  function foodList() {
    let items;
    if (pickQ) {
      const q = pickQ.toLowerCase();
      const pool = [...S.myFoods.map(f => Object.assign({mine: true}, f)), ...FOODS];
      items = pool.filter(f => f.n.toLowerCase().includes(q));
    } else if (pickCat === "recent") items = S.recent;
    else if (pickCat === "mine") items = S.myFoods.map(f => Object.assign({mine: true}, f));
    else items = FOODS.filter(f => f.c === pickCat);
    const empty = pickCat === "recent" && !pickQ ? "まだありません。ほかのタブから選ぶと、ここに出ます。" : pickCat === "mine" && !pickQ ? "まだありません。下の「表に無い物を入れる」から足すと、ここに入ります。" : "見つかりません。表に無い物は、下から入れてください。";
    return `<div class="group">${items.length ? items.map((f, i) => `<div class="cell pick"><button class="grow" style="text-align:left" data-act="pickfood" data-i="${i}"><div class="t">${esc(f.n)}</div><div class="s num">${f.kcal}kcal・たんぱく質 ${f.p}g</div></button>${f.mine && !pickQ ? `<button class="memo-btn" style="color:var(--red)" data-act="delmine" data-i="${i}">消す</button>` : ""}<button class="plus" data-act="pickfood" data-i="${i}" aria-label="足す">＋</button></div>`).join("") : `<div class="empty">${empty}</div>`}</div>`;
  }
  let pickItems = [];
  function openPicker() {
    pickQ = ""; if (!S.recent.length && pickCat === "recent") pickCat = "konbini";
    const draw = () => {
      const bg = $("#sheetbg"); if (!bg) return;
      bg.querySelector(".cats").innerHTML = CATS.map(c => `<button data-act="cat" data-c="${c.id}" class="${c.id === pickCat && !pickQ ? "on" : ""}">${c.name}</button>`).join("");
      const box = bg.querySelector("#plist");
      box.innerHTML = foodList();
      pickItems = currentItems();
    };
    sheet(`<div class="stitle"><h2>食べた物を足す</h2><button data-close>おわる</button></div>
      <div class="s" style="margin:-4px 4px 8px">${jp(foodDay)}に足します。押すたびに1つ足します。</div>
      <input class="search" type="search" placeholder="名前でさがす（例：おにぎり）" id="fq">
      <div class="cats"></div><div id="plist"></div>
      <div style="margin-top:12px"><button class="btn sub" data-act="custom">＋ 表に無い物を入れる</button></div>`, e => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      if (b.dataset.act === "cat") { pickCat = b.dataset.c; pickQ = ""; $("#fq").value = ""; draw(); }
      else if (b.dataset.act === "pickfood") { const f = pickItems[Number(b.dataset.i)]; if (f) { addMeal(f, 1); toast(`足しました：${f.n}`); } }
      else if (b.dataset.act === "delmine") { const f = pickItems[Number(b.dataset.i)]; if (f && confirm(`「${f.n}」を自分の表から消しますか？（食べた記録は残ります）`)) { S.myFoods = S.myFoods.filter(x => x.n !== f.n); save(); draw(); } }
      else if (b.dataset.act === "custom") customFood();
    });
    $("#fq").addEventListener("input", e => { pickQ = e.target.value.trim(); draw(); });
    draw();
  }
  function currentItems() {
    if (pickQ) { const q = pickQ.toLowerCase(); return [...S.myFoods.map(f => Object.assign({mine: true}, f)), ...FOODS].filter(f => f.n.toLowerCase().includes(q)); }
    if (pickCat === "recent") return S.recent;
    if (pickCat === "mine") return S.myFoods.map(f => Object.assign({mine: true}, f));
    return FOODS.filter(f => f.c === pickCat);
  }
  function addMeal(f, q) {
    (S.meals[foodDay] = S.meals[foodDay] || []).push({id: uid(), n: f.n, kcal: Number(f.kcal), p: Number(f.p), q});
    S.recent = [{n: f.n, kcal: Number(f.kcal), p: Number(f.p)}, ...S.recent.filter(x => x.n !== f.n)].slice(0, 20);
    save(); if (tab === "food" || tab === "home") render();
  }
  function customFood() {
    sheet(`<div class="stitle"><h2>表に無い物を入れる</h2><button data-close>やめる</button></div>
      <div class="lb">名前（1回分の量も書くと分かりやすい）</div><input class="in" id="cn" maxlength="40" placeholder="例：家のカレー 1皿">
      <div class="lb">カロリー（kcal）</div><input class="in" id="ck" type="number" inputmode="numeric" placeholder="例：700">
      <div class="lb">たんぱく質（g）</div><input class="in" id="cp" type="number" inputmode="decimal" step="any" placeholder="例：20">
      <div class="note" style="margin:0 4px 12px">商品の袋の「栄養成分表示」の数字を入れると正確です。1回入れると「自分の表」に入り、次から選べます。</div>
      <button class="btn" data-act="csave">表に入れて、${foodDay === today() ? "今日" : jpShort(foodDay)}に足す</button>`, e => {
      if (!e.target.closest("[data-act=csave]")) return;
      const n = $("#cn").value.trim(), k = Number($("#ck").value), p = Number($("#cp").value || 0);
      if (!n) return alert("名前を入れてください");
      if (!(k >= 0) || $("#ck").value === "") return alert("カロリーを数字で入れてください");
      if (!(p >= 0)) return alert("たんぱく質を数字で入れてください");
      const f = {n, kcal: Math.round(k), p: r1(p)};
      S.myFoods = [f, ...S.myFoods.filter(x => x.n !== n)];
      closeSheet(); addMeal(f, 1); toast(`自分の表に入れて、足しました`);
    });
    setTimeout(() => $("#cn") && $("#cn").focus(), 50);
  }
  /* いつもの食事：名前＋食べ物（量つき）のセット。候補は、その日に食べた物と、最近・自分の表 */
  function comboSheet() {
    const cand = [];
    (S.meals[foodDay] || []).forEach(m => cand.push({n: m.n, kcal: m.kcal, p: m.p, q: m.q}));
    [...S.recent, ...S.myFoods].forEach(f => { if (!cand.some(c => c.n === f.n)) cand.push({n: f.n, kcal: f.kcal, p: f.p, q: 1}); });
    const QS = [0.5, 1, 2, 3];
    sheet(`<div class="stitle"><h2>いつもの食事を作る</h2><button data-close>やめる</button></div>
      <div class="lb">名前</div><input class="in" id="cbn" maxlength="20" placeholder="例：朝いつもの">
      <div class="lb">入れる物（押して選ぶ・数は右で変える）</div>
      ${cand.length ? `<div class="group">${cand.map((c, i) => `<div class="cell"><label class="grow" style="display:flex;gap:12px;align-items:center"><input type="checkbox" data-ci="${i}" style="width:24px;height:24px;flex:none"><span><span class="t" style="display:block">${esc(c.n)}</span><span class="s num">${c.kcal}kcal・${c.p}g</span></span></label><select data-cq="${i}" style="min-height:40px;border:0;border-radius:10px;background:var(--fill);padding:0 8px;font-size:16px">${QS.map(q => `<option value="${q}" ${q === c.q ? "selected" : ""}>×${q}</option>`).join("")}</select></div>`).join("")}</div>`
        : `<div class="empty">先に「食べた物を足す」で1回入れると、ここから選べます。</div>`}
      <div class="note" style="margin:8px 4px 12px">候補は「${foodDay === today() ? "今日" : jpShort(foodDay)}食べた物」「最近」「自分の表」から出ます。無い物は、先に「食べた物を足す」で入れてください。</div>
      <button class="btn" data-act="cbsave">この組み合わせを入れる</button>`, e => {
      if (!e.target.closest("[data-act=cbsave]")) return;
      const name = $("#cbn").value.trim();
      const items = cand.map((c, i) => ({c, i})).filter(x => document.querySelector(`[data-ci="${x.i}"]`).checked)
        .map(x => ({n: x.c.n, kcal: x.c.kcal, p: x.c.p, q: Number(document.querySelector(`[data-cq="${x.i}"]`).value)}));
      if (!name) return alert("名前を入れてください（例：朝いつもの）");
      if (!items.length) return alert("入れる物を1つ以上えらんでください");
      S.combos.push({id: uid(), name, items}); save(); closeSheet(); render(); toast(`「${name}」を作りました`);
    });
  }
  function addCombo(id) {
    const cb = S.combos.find(x => x.id === id); if (!cb) return;
    cb.items.forEach(m => (S.meals[foodDay] = S.meals[foodDay] || []).push({id: uid(), n: m.n, kcal: m.kcal, p: m.p, q: m.q}));
    save(); render(); toast(`「${cb.name}」を足しました（${cb.items.length}品）`);
  }
  function mealSheet(id) {
    const list = S.meals[foodDay] || [], m = list.find(x => x.id === id); if (!m) return;
    const QS = [0.5, 1, 1.5, 2, 3];
    sheet(`<div class="stitle"><h2>${esc(m.n)}</h2><button data-close>とじる</button></div>
      <div class="lb">量（1回分の何倍か）</div>
      <div class="qty" style="flex-wrap:wrap">${QS.map(q => `<button data-q="${q}" class="${q === m.q ? "on" : ""}">${q}</button>`).join("")}</div>
      <div class="s num" style="margin:12px 4px">1回分：${m.kcal}kcal・たんぱく質 ${m.p}g</div>
      <button class="btn red" data-act="mdel">これを消す</button>`, e => {
      const q = e.target.closest("[data-q]");
      if (q) { m.q = Number(q.dataset.q); save(); closeSheet(); render(); return; }
      if (e.target.closest("[data-act=mdel]")) { S.meals[foodDay] = list.filter(x => x.id !== id); if (!S.meals[foodDay].length) delete S.meals[foodDay]; save(); closeSheet(); render(); }
    });
  }

  /* ---------------- 予定（カレンダー） ---------------- */
  function vCal() {
    const [y, m] = calMonth.split("-").map(Number), first = new Date(y, m - 1, 1), t = today();
    const nDays = new Date(y, m, 0).getDate(), lead = first.getDay();
    const done = {}; S.sessions.forEach(s => { (done[s.date] = done[s.date] || []).push(s.day); });
    let cells = "";
    for (let i = 0; i < lead; i++) cells += `<button class="out" tabindex="-1" aria-hidden="true"></button>`;
    for (let d = 1; d <= nDays; d++) {
      const ds = `${y}-${pad(m)}-${pad(d)}`, did = done[ds], plan = S.plans.includes(ds);
      cells += `<button data-act="cday" data-d="${ds}" class="${ds === t ? "today" : ""} ${did ? "did" : plan ? "plan" : ""}"><span>${d}</span>${did ? did.map(k => `<span class="mk ${k}">${k}</span>`).join("") : plan ? `<span class="mk plan">予定</span>` : ""}</button>`;
    }
    const ups = S.plans.filter(d => d >= t).sort().slice(0, 5);
    const monthCount = S.sessions.filter(s => s.date.startsWith(calMonth)).length;
    return `<h1 class="large">予定</h1><div class="date">日にちを押すと、行く予定を置けます</div>
    <div class="card"><div class="calhead"><button data-act="cmon" data-n="-1" aria-label="前の月">‹</button><span class="m">${y}年${m}月</span><button data-act="cmon" data-n="1" aria-label="次の月">›</button></div>
    <div class="cal">${WD.map((w, i) => `<div class="w ${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</div>`).join("")}${cells}</div>
    <div class="legend"><span><i style="background:rgba(0,122,255,.35)"></i>行く予定</span><span><i style="background:var(--a)"></i>A日をやった</span><span><i style="background:var(--b)"></i>B日をやった</span></div>
    <div class="s" style="margin-top:8px">この月に行った回数：<b>${monthCount}回</b></div></div>
    <div class="sec">これからの予定</div>
    <div class="group">${ups.length ? ups.map(d => `<button class="cell" data-act="cday" data-d="${d}"><div class="grow"><div class="t">${jp(d)}</div><div class="s">${d === t ? "今日" : `${diffDays(t, d)}日後`}</div></div><span class="chev">›</span></button>`).join("") : `<div class="empty">まだありません。カレンダーの日にちを押して置いてください。</div>`}</div>`;
  }
  function daySheet(d) {
    const ss = S.sessions.filter(s => s.date === d), plan = S.plans.includes(d), tot = dayTotal(d), meals = S.meals[d] || [];
    sheet(`<div class="stitle"><h2>${jp(d)}</h2><button data-close>とじる</button></div>
      ${ss.length ? ss.map(s => `<div class="lb"><span class="pill ${s.day}">${s.day}日</span> をやりました</div><div class="group" style="margin-bottom:10px">${s.items.map(i => { const ex = exById(i.id); return `<div class="cell"><div class="grow"><div class="t">${esc(ex ? ex.name : i.id)}</div><div class="s">${esc(ex ? lastText(ex, i.sets) : "")}</div></div></div>`; }).join("")}</div>`).join("") : ""}
      ${meals.length ? `<div class="lb">食事：${Math.round(tot.kcal).toLocaleString()}kcal・たんぱく質 ${r1(tot.p)}g（${meals.length}品）</div>` : ""}
      <div style="margin-top:12px"><button class="btn ${plan ? "red" : ""}" data-act="plan">${plan ? "行く予定を外す" : "この日に行く予定にする"}</button></div>`, e => {
      if (!e.target.closest("[data-act=plan]")) return;
      if (plan) S.plans = S.plans.filter(x => x !== d); else S.plans = [...S.plans, d].sort();
      save(); closeSheet(); render(); toast(plan ? "予定を外しました" : "予定に入れました");
    });
  }

  /* ---------------- 設定 ---------------- */
  function vSet() {
    const p = S.profile, c = calc(), w = latestWeight();
    const opt = (list, val) => list.map(([v, l]) => `<option value="${v}" ${String(v) === String(val) ? "selected" : ""}>${l}</option>`).join("");
    return `<h1 class="large">設定</h1>
    <div class="sec">トレーナー（選べます）</div>
    <div class="avatars">${AV_ORDER.map(id => `<button data-act="avatar" data-id="${id}" class="${id === S.avatar ? "on" : ""}">${faceHtml(id, "normal")}${AV[id].name}</button>`).join("")}</div>
    <div class="sec">あなたのこと</div>
    <div class="group">
      <div class="field"><label>性別</label><div class="seg"><button data-act="sex" data-v="m" class="${p.sex === "m" ? "on" : ""}">男性</button><button data-act="sex" data-v="f" class="${p.sex === "f" ? "on" : ""}">女性</button></div></div>
      <div class="field"><label for="pa">年齢</label><input id="pa" data-p="age" type="number" inputmode="numeric" placeholder="例：25" value="${p.age || ""}"></div>
      <div class="field"><label for="ph">身長（cm）</label><input id="ph" data-p="height" type="number" inputmode="decimal" step="any" placeholder="例：172" value="${p.height || ""}"></div>
      <div class="field"><label for="pw">体重（kg）</label><input id="pw" data-p="weight" type="number" inputmode="decimal" step="any" placeholder="例：70" value="${w != null ? fmtKg(w) : ""}"></div>
      <div class="field"><label for="pact">ふだん動く量</label><select id="pact" data-p="activity">${opt([[1.2, "ほぼ座る"], [1.375, "少し動く"], [1.55, "よく動く"], [1.725, "とても動く"]], p.activity)}</select></div>
      <div class="field"><label for="pcut">カロリーの減らし方</label><select id="pcut" data-p="cut">${opt([[10, "−10%"], [15, "−15%"], [20, "−20%"]], p.cut)}</select></div>
      <div class="field"><label for="ppk">たんぱく質</label><select id="ppk" data-p="pkg">${opt([[1.6, "体重×1.6g"], [1.8, "体重×1.8g"], [2.0, "体重×2.0g"]], p.pkg)}</select></div>
    </div>
    <div class="note">ふだん動く量：ほぼ座る＝運動なし／少し動く＝週1〜3回／よく動く＝週3〜5回／とても動く＝ほぼ毎日。カロリーの減らし方：−15%がふつう。<br>体重を変えると、今日の体重として記録されます（ホームの「体の記録」にも出ます）。</div>
    <div class="sec">1日の目標（目安）</div>
    <div class="card calc">${c ? `体を動かさなくても使う量（基礎代謝）：<b class="num">${c.bmr.toLocaleString()}</b>kcal<br>1日に使う量（だいたい）：<b class="num">${c.tdee.toLocaleString()}</b>kcal<br>目標のカロリー：<b class="num">${c.kcal.toLocaleString()}</b>kcal（${p.cut}%減らす）<br>目標のたんぱく質：<b class="num">${c.p}</b>g（体重×${p.pkg}g）`
      : "年齢・身長・体重を入れると、ここに出ます。"}
      <div class="note" style="margin:10px 0 0">計算は Mifflin-St Jeor という式を使った<b>目安です</b>。医療の助言ではありません。持病がある時や体調に不安がある時は、お医者さんに相談してください。</div></div>
    <div class="sec">休けいのタイマー</div>
    <div class="group"><div class="field"><label for="prest">○ を押した後の休けい</label><select id="prest" data-p="rest">${opt([[60, "1分"], [90, "1分30秒"], [120, "2分"], [180, "3分"], [0, "使わない"]], S.rest)}</select></div>
      <div class="field"><label>終わった時の音</label><div class="seg"><button data-act="sound" data-v="1" class="${S.sound ? "on" : ""}">鳴らす</button><button data-act="sound" data-v="0" class="${S.sound ? "" : "on"}">鳴らさない</button></div></div></div>
    <div class="note">iPhone はマナーモードの時、音が出ないことがあります。振動は iPhone では使えないので、画面の色とトレーナーの一言で知らせます。画面を消している間は音が鳴りません（開き直すと、終わったことが出ます）。</div>
    <div class="sec">バックアップ</div>
    <div class="card"><div class="s">記録はこのスマホの中だけにあります。機種変更や、もしもの時のために、ときどき書き出してください。</div>
      <div class="s" style="margin-top:6px">最後に書き出した日：<b>${S.lastBackup ? jp(S.lastBackup.slice(0, 10)) : "まだ"}</b></div>
      <div class="row2"><button class="btn small" data-act="export">書き出す</button><button class="btn sub small" data-act="import">読み込む</button></div>
      <input type="file" id="impf" accept="application/json,.json" hidden>
      ${hasBefore() ? `<div class="s" style="margin-top:12px">バックアップを読み込む前の記録が、1つだけ残っています。</div><div class="row2"><button class="btn red small" data-act="undoimport">読み込む前に戻す</button></div>` : ""}</div>
    <div class="note">ホーム画面に追加して、そこから開いてください（Safari で開いたままだと、しばらく使わない時に記録が消えることがあります）。</div>
    <div class="note" style="margin-bottom:10px">筋トレアプリ v1・${DEMO ? "見本のデータ" : "記録 " + S.sessions.length + "回"}</div>`;
  }
  function setProfile(k, val) {
    if (k === "weight") { const kg = Number(val); if (kg > 20 && kg < 300) { upsertWeight(today(), kg); } else if (val !== "") { alert("体重は kg の数字で入れてください"); } }
    else if (k === "rest") S.rest = Number(val);
    else if (k === "age" || k === "height") {
      const n = Number(val), [lo, hi, msg] = k === "age" ? [10, 100, "年齢は 10〜100 の数字で入れてください"] : [100, 250, "身長は cm で、100〜250 の数字で入れてください（例：172）"];
      if (val === "") S.profile[k] = null;
      else if (n >= lo && n <= hi) S.profile[k] = n;
      else { alert(msg); render(); return; }
    }
    else S.profile[k] = Number(val);
    save(); render();
  }
  function upsertWeight(d, kg, waist) {
    const old = S.weights.find(w => w.date === d) || {date: d};
    const nw = {date: d, kg: kg != null ? r1(kg) : (old.kg || null), waist: waist != null ? r1(waist) : (old.waist || null)};
    S.weights = [...S.weights.filter(w => w.date !== d), nw].sort((a, b) => a.date < b.date ? -1 : 1);
  }
  function weightSheet() {
    const t = today(), w = latestWeight(), tw = S.weights.find(x => x.date === t) || {};
    const lastWaist = (S.weights.filter(x => x.waist > 0).pop() || {}).waist;
    sheet(`<div class="stitle"><h2>体の記録</h2><button data-close>やめる</button></div>
      <div class="lb">日付</div><input class="in" id="wd" type="date" value="${t}" max="${t}">
      <div class="lb">体重（kg）</div><input class="in" id="wk" type="number" inputmode="decimal" step="any" placeholder="例：70.5" value="${tw.kg ? fmtKg(tw.kg) : w != null ? fmtKg(w) : ""}">
      <div class="lb">ウエスト（cm・はかった時だけ）</div><input class="in" id="ww" type="number" inputmode="decimal" step="any" placeholder="${lastWaist ? "前回 " + fmtKg(lastWaist) : "例：82"}" value="${tw.waist ? fmtKg(tw.waist) : ""}">
      <div class="note" style="margin:0 4px 12px">毎回同じ時間（朝おきてトイレのあと など）にはかると、くらべやすいです。ウエストは、おへその高さで。体重を記録すると、食事の目標も変わります。</div>
      <button class="btn" data-act="wsave">記録する</button>`, e => {
      if (!e.target.closest("[data-act=wsave]")) return;
      const d = $("#wd").value || t, kv = $("#wk").value.trim(), wv = $("#ww").value.trim();
      const kg = kv === "" ? null : Number(kv), waist = wv === "" ? null : Number(wv);
      if (kg == null && waist == null) return alert("体重かウエストを入れてください");
      if (kg != null && !(kg > 20 && kg < 300)) return alert("体重を kg の数字で入れてください");
      if (waist != null && !(waist > 30 && waist < 250)) return alert("ウエストを cm の数字で入れてください");
      if (d > t) return alert("先の日付には記録できません");
      upsertWeight(d, kg, waist); save(); closeSheet(); render(); toast("記録しました");
    });
    setTimeout(() => $("#wk") && $("#wk").select(), 50);
  }
  async function exportData() {
    const name = `kintore_${today().replace(/-/g, "")}.json`;
    const blob = new Blob([JSON.stringify({app: "gym", ver: 1, exportedAt: new Date().toISOString(), data: S}, null, 1)], {type: "application/json"});
    try {
      const file = new File([blob], name, {type: "application/json"});
      if (navigator.canShare && navigator.canShare({files: [file]})) {
        await navigator.share({files: [file], title: "筋トレアプリのバックアップ"});
      } else {
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
      S.lastBackup = new Date().toISOString(); save(); render(); toast("書き出しました。「ファイル」などに保存してください");
    } catch (e) { if (e && e.name !== "AbortError") alert("書き出せませんでした：" + e.message); }
  }
  const BEFORE = KEY + "-before-import";
  function hasBefore() { try { return !!localStorage.getItem(BEFORE); } catch (e) { return false; } }
  function undoImport() {
    let o; try { o = JSON.parse(localStorage.getItem(BEFORE)); } catch (e) { o = null; }
    if (!o) return alert("戻せる記録がありません");
    if (!confirm(`バックアップを読み込む前の記録（筋トレ ${(o.sessions || []).length}回）に戻します。今の記録は消えます。よろしいですか？`)) return;
    S = migrate(o); save();
    try { localStorage.removeItem(BEFORE); } catch (e) {}
    render(); toast("読み込む前に戻しました");
  }
  function importData(file) {
    const r = new FileReader();
    r.onload = () => {
      let o; try { o = JSON.parse(r.result); } catch (e) { return alert("このファイルは読めませんでした（筋トレアプリのバックアップではないようです）"); }
      if (!o || o.app !== "gym" || !o.data || !Array.isArray(o.data.sessions)) return alert("筋トレアプリのバックアップのファイルではないようです");
      const d = o.data, ed = new Date(o.exportedAt), when = o.exportedAt && !isNaN(ed) ? jp(ymd(ed)) : "日付不明";
      if (!confirm(`${when}に書き出した記録（筋トレ ${d.sessions.length}回・体重 ${(d.weights || []).length}件）に、今の記録を置きかえます。よろしいですか？\n（今の記録は控えを1つ残すので、設定の「読み込む前に戻す」で戻せます）`)) return;
      try { localStorage.setItem(BEFORE, JSON.stringify(S)); } catch (e) {}
      S = migrate(d); save(); render(); toast("読み込みました");
    };
    r.readAsText(file);
  }

  /* ---------------- 押した時 ---------------- */
  main.addEventListener("click", e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const a = b.dataset.act;
    if (a === "startgo") { if (!S.cur) startSession(S.nextDay); go("train"); }
    else if (a === "addfood") { foodDay = tab === "home" ? today() : foodDay; openPicker(); }
    else if (a === "toset") go("set");
    else if (a === "tocal") go("cal");
    else if (a === "weight") weightSheet();
    else if (a === "pickday") { chooseDay = b.dataset.day; render(); }
    else if (a === "memo") { openMemo[b.dataset.ex] = !openMemo[b.dataset.ex]; render(); }
    else if (a === "start") { startSession(b.dataset.day); render(); window.scrollTo(0, 0); }
    else if (a === "sess") sessDetail(b.dataset.id);
    else if (a === "finish") finishSession();
    else if (a === "quit") { if (confirm("記録しないで、やめますか？（入れた数字は消えます）")) { S.cur = null; stopRest(); save(); render(); } }
    else if (a === "addset" || a === "delset") {
      const it = S.cur.items[Number(b.dataset.i)];
      if (a === "addset") { const l = it.sets[it.sets.length - 1]; it.sets.push({kg: l ? l.kg : "", reps: l ? l.reps : "", done: false}); }
      else if (it.sets.length > 1) it.sets.pop();
      save(); render();
    }
    else if (["kg-", "kg+", "r-", "r+", "chk"].includes(a)) {
      const row = b.closest(".setrow"), it = S.cur.items[Number(row.dataset.i)], st = it.sets[Number(row.dataset.s)];
      const ex = exById(it.id);
      if (a === "chk") {
        st.done = !st.done; b.classList.toggle("on", st.done); row.classList.toggle("done", st.done);
        if (st.done && S.rest > 0) startRest(S.rest);
        const dn = S.cur.items.reduce((n, i) => n + i.sets.filter(s => s.done).length, 0), all = S.cur.items.reduce((n, i) => n + i.sets.length, 0);
        const dt = main.querySelector(".date"); if (dt) dt.textContent = `${jp(S.cur.date)}にはじめました・${dn} / ${all}セット`;
      } else if (a[0] === "k") {
        const step = ex.inc || 2.5, cur = Number(st.kg) || 0;
        st.kg = fmtKg(Math.max(0, cur + (a === "kg+" ? step : -step)));
        row.querySelector('[data-f="kg"]').value = st.kg;
      } else {
        const step = ex.timed ? 5 : 1, cur = Number(st.reps) || 0;
        st.reps = Math.max(0, cur + (a === "r+" ? step : -step));
        row.querySelector('[data-f="reps"]').value = st.reps;
      }
      save();
    }
    else if (a === "fday") { foodDay = addDays(foodDay, Number(b.dataset.n)); if (foodDay > today()) foodDay = today(); render(); }
    else if (a === "meal") mealSheet(b.dataset.id);
    else if (a === "cmon") { const [y, m] = calMonth.split("-").map(Number); const d = new Date(y, m - 1 + Number(b.dataset.n), 1); calMonth = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; render(); }
    else if (a === "cday") daySheet(b.dataset.d);
    else if (a === "cond") {
      const v = b.dataset.v;
      if (S.cur && v !== condToday()) toast("やりかけのメニューは、そのままです（次にはじめる時から変わります）");
      S.cond = {date: today(), v}; save(); render();
      if (v !== "ok") toast(`今日は「${condName(v)}」。メニューを軽めにしました`);
    }
    else if (a === "restnow") startRest(S.rest || 90);
    else if (a === "btab") { bodyTab = b.dataset.v; render(); }
    else if (a === "bodylist") bodyList();
    else if (a === "combonew") comboSheet();
    else if (a === "combo") { if (tab === "home") foodDay = today(); addCombo(b.dataset.id); }
    else if (a === "combodel") { const cb = S.combos.find(x => x.id === b.dataset.id); if (cb && confirm(`「${cb.name}」を消しますか？（食べた記録は残ります）`)) { S.combos = S.combos.filter(x => x !== cb); save(); render(); } }
    else if (a === "sound") { S.sound = b.dataset.v === "1"; wakeAudio(); if (S.sound) beep(); save(); render(); }
    else if (a === "avatar") { S.avatar = b.dataset.id; save(); render(); toast(`トレーナーを「${AV[S.avatar].name}」にしました`); }
    else if (a === "sex") { S.profile.sex = b.dataset.v; save(); render(); }
    else if (a === "export") exportData();
    else if (a === "undoimport") undoImport();
    else if (a === "import") $("#impf").click();
  });
  main.addEventListener("change", e => {
    const el = e.target;
    if (el.id === "impf") { if (el.files[0]) importData(el.files[0]); el.value = ""; return; }
    if (el.dataset.p) { setProfile(el.dataset.p, el.value.trim()); return; }
    if (el.dataset.f && S.cur) {
      const row = el.closest(".setrow"), st = S.cur.items[Number(row.dataset.i)].sets[Number(row.dataset.s)];
      const v = el.value.trim();
      if (el.dataset.f === "kg") st.kg = v === "" ? "" : fmtKg(Math.max(0, Number(v) || 0));
      else st.reps = v === "" ? "" : Math.max(0, Math.round(Number(v) || 0));
      el.value = st[el.dataset.f]; save();
    }
  });

  /* ---------------- 見本のデータ（?demo の時だけ。本物とは別の置き場） ---------------- */
  function demoData() {
    const s = blank(), t = today();
    s.profile = {sex: "m", age: 30, height: 172, activity: 1.375, cut: 15, pkg: 1.8};
    [[-21, 74.2, 86], [-18, 74.0, null], [-14, 73.6, 85.2], [-11, 73.7, null], [-7, 73.2, 84.5], [-4, 73.0, null], [-1, 72.8, 84]].forEach(([n, kg, waist]) => s.weights.push({date: addDays(t, n), kg, waist}));
    const mk = (n, day, items) => s.sessions.push({id: "d" + n, date: addDays(t, n), day, start: "", end: addDays(t, n) + "T20:00", items: items.map(([id, kg, reps]) => ({id, sets: reps.map(r => ({kg, reps: r, done: true}))}))});
    mk(-9, "A", [["squat", 50, [10, 9, 8]], ["bench", 47.5, [10, 10, 10]], ["latpd", 40, [12, 11, 10]], ["dbsp", 10, [12, 10, 10]], ["legcurl", 30, [12, 12, 11]], ["plank", null, [40, 35, 30]]]);
    mk(-6, "B", [["legpress", 80, [12, 12, 10]], ["rdl", 40, [10, 10, 9]], ["incdb", 14, [10, 9, 8]], ["row", 40, [12, 12, 12]], ["sideraise", 5, [15, 14, 12]], ["abcrunch", 25, [15, 15, 13]]]);
    mk(-3, "A", [["squat", 50, [10, 10, 9]], ["bench", 50, [10, 10, 10]], ["latpd", 40, [12, 12, 11]], ["dbsp", 10, [12, 12, 11]], ["legcurl", 30, [12, 12, 12]], ["plank", null, [45, 40, 40]]]);
    s.nextDay = "B";
    s.plans = [addDays(t, -9), addDays(t, -6), addDays(t, -3), t, addDays(t, 3), addDays(t, 5)];
    const F = n => FOODS.find(f => f.n.startsWith(n));
    s.meals[t] = [F("おにぎり（鮭）"), F("サラダチキン"), F("しょうが焼き定食")].map((f, i) => ({id: "m" + i, n: f.n, kcal: f.kcal, p: f.p, q: 1}));
    s.recent = [F("しょうが焼き定食"), F("サラダチキン"), F("おにぎり（鮭）"), F("ゆで卵"), F("牛丼（並）")].map(f => ({n: f.n, kcal: f.kcal, p: f.p}));
    s.myFoods = [{n: "家のカレー 1皿", kcal: 700, p: 20}];
    const it = (n, q) => { const f = F(n); return {n: f.n, kcal: f.kcal, p: f.p, q}; };
    s.combos = [{id: "c1", name: "朝いつもの", items: [it("おにぎり（鮭）", 2), it("プロテイン飲料", 1)]},
      {id: "c2", name: "昼コンビニ", items: [it("サラダチキン", 1), it("おにぎり（梅", 1), it("ゆで卵", 1)]}];
    s.lastBackup = addDays(t, -2) + "T21:00:00.000Z";
    return s;
  }

  render();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("./sw.js").catch(() => {});
})();
