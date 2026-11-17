/* フォーマット入力 — 画面（2026-11-17 デベロッパー）
   型（貼った文と手直し）は端末に保存（localStorage）。入れた値はメモリーだけ（閉じると消える・どこにも送らない） */
(function () {
  "use strict";
  const P = window.FmtParse;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const KEY = "fmtinput.templates.v1";

  /* 今の状態 */
  const st = {src: "", tw: {}, tplId: null, tplName: "", dirty: false, values: {}, checked: {}, withList: false, fix: false, view: "fmt", model: null, warnedCopy: false};

  /* ---------- 保存（型だけ） ---------- */
  function loadTpls() { try { const a = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
  function saveTpls(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); return true; } catch (_) { toast("この端末には保存できませんでした（プライベートブラウズなど）"); return false; } }

  /* ---------- 小物 ---------- */
  let toastT = 0;
  function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2200); }
  function ask(title, val, okLabel) {
    return new Promise(res => {
      $("dlgT").textContent = title; $("dlgIn").value = val || ""; $("dlgOk").textContent = okLabel || "保存";
      $("scrim").hidden = $("dlg").hidden = false; setTimeout(() => $("dlgIn").focus(), 50);
      const done = v => { $("scrim").hidden = $("dlg").hidden = true; $("dlgOk").onclick = $("dlgNo").onclick = $("scrim").onclick = $("dlgIn").onkeydown = null; res(v); };
      $("dlgOk").onclick = () => done($("dlgIn").value.trim() || null);
      $("dlgNo").onclick = $("scrim").onclick = () => done(null);
      $("dlgIn").onkeydown = e => { if (e.key === "Enter") done($("dlgIn").value.trim() || null); };
    });
  }
  const hasValues = () => Object.keys(st.values).some(k => { const f = st.model && st.model.fields.find(x => x.id === k); return f && P.filled(f, st.values[k]); });

  /* ---------- 画面の切りかえ ---------- */
  function go(v) {
    st.view = v;
    $("vFmt").hidden = v !== "fmt"; $("vForm").hidden = v !== "form"; $("vOut").hidden = v !== "out";
    document.querySelectorAll(".tabs button").forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.go === v)); b.disabled = b.dataset.go !== "fmt" && !st.model; });
    $("bar").hidden = v === "fmt";
    $("barBack").hidden = v !== "out";
    $("barMain").textContent = v === "out" ? "コピーする" : "できた文を見る";
    if (v === "fmt") renderTpls();
    if (v === "form") renderForm();
    if (v === "out") { st.warnedCopy = false; renderOut(); }
    updateLeft();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => { if (!b.disabled) go(b.dataset.go); });

  /* ---------- ① 型 ---------- */
  function renderTpls() {
    const a = loadTpls();
    $("tplList").innerHTML = a.length ? a.map(t => `<div class="card tpl" data-id="${esc(t.id)}">
        <button type="button" class="t" data-act="use"><b>${esc(t.name)}</b><small>${esc(fmtDate(t.at))}・項目 ${P.parse(t.src, t.tw).fields.length}</small></button>
        <button type="button" class="btn small" data-act="ren">名前</button>
        <button type="button" class="btn small" data-act="del">消す</button></div>`).join("")
      : `<div class="empty">まだありません。①の画面で型を貼って［入力フォームにする］を押すと、その型がここに残ります。次からは選ぶだけで使えます。</div>`;
  }
  const fmtDate = ms => { const d = new Date(ms || 0); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} 保存`; };
  $("tplList").onclick = async e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const id = b.closest("[data-id]").dataset.id, a = loadTpls(), t = a.find(x => x.id === id); if (!t) return;
    if (b.dataset.act === "use") {
      if (hasValues() && !confirm("入れた値を消して、この型にしますか？")) return;
      closeDrawer(); open(t.src, t.tw, t.id, t.name);
    } else if (b.dataset.act === "ren") {
      const n = await ask("型の名前を変える", t.name, "変える"); if (!n) return;
      t.name = n; saveTpls(a); if (st.tplId === id) { st.tplName = n; $("title").textContent = n; } renderTpls();
    } else if (b.dataset.act === "del") {
      if (!confirm(`「${t.name}」の型を消しますか？（元には戻せません）`)) return;
      saveTpls(a.filter(x => x.id !== id)); if (st.tplId === id) st.tplId = null; renderTpls(); toast("消しました");
    }
  };
  /* 保存した型の一覧は左上の☰から出す（v4・社長 11/18「ハンバーガーメニューで表示」） */
  function openDrawer() { renderTpls(); $("dScrim").hidden = $("drawer").hidden = false; $("menuBtn").setAttribute("aria-expanded", "true"); $("drawer").scrollTop = 0; }
  function closeDrawer() { $("dScrim").hidden = $("drawer").hidden = true; $("menuBtn").setAttribute("aria-expanded", "false"); }
  $("menuBtn").onclick = () => $("drawer").hidden ? openDrawer() : closeDrawer();
  $("drawerClose").onclick = $("dScrim").onclick = closeDrawer;
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("drawer").hidden && $("dlg").hidden) closeDrawer(); });

  function open(src, tw, id, name) {
    st.src = src; st.tw = JSON.parse(JSON.stringify(tw || {})); st.tplId = id || null; st.tplName = name || ""; st.dirty = !id;
    st.values = {}; st.checked = {}; st.withList = false; st.fix = false;
    reparse();
    $("title").textContent = st.tplName || "（まだ保存していない型）";
    if (!st.model.fields.length) { toast("入力欄が見つかりませんでした。［手直し］で行を入力欄にできます"); st.fix = true; }
    go("form");
  }
  $("toForm").onclick = () => {
    const s = $("src").value;
    if (!s.trim()) { toast("フォーマットの文を貼ってください"); $("src").focus(); return; }
    if (hasValues() && !confirm("入れた値を消して、新しい型にしますか？")) return;
    /* 一度使った型は自動で一覧に残す（v3・社長 11/18「型だけ自動で保存」）。入れた値は今まで通り保存しない */
    const a = loadTpls(), same = a.find(x => x.src.trim() === s.trim());
    if (same) { open(same.src, same.tw, same.id, same.name); toast(`保存済みの型「${same.name}」で開きました`); return; }
    const pii = piiIn(s);
    if (pii && !confirm(`貼った文に、お客さんの情報（「${pii}」など）が入っていませんか？\n型は、貼った文ごとこの端末に保存されます。\n\n型として保存しますか？\n（［キャンセル］なら保存せずにフォームだけ開きます）`)) { open(s, {}, null, ""); toast("型は保存していません"); return; }
    const t = {id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: uniqName(a, firstLine(s)), src: s, tw: {}, at: Date.now()};
    a.unshift(t);
    if (saveTpls(a)) { open(t.src, t.tw, t.id, t.name); toast(`型を「${t.name}」で保存しました（名前は左上の☰で変えられます）`); }
    else open(s, {}, null, "");
  };
  function piiIn(s) { const m = /0\d{1,4}[-ー\s]\d{1,4}[-ー\s]\d{3,4}|0[789]0\d{8}|[\w.+-]+@[\w-]+\.[\w.-]+|〒?\s*\d{3}[-ー]\d{4}/.exec(s.normalize("NFKC")); return m ? m[0] : null; }   // 全角の数字・＠も（テスター R2）
  function firstLine(s) { return (s.split("\n").find(l => l.trim()) || "").trim().replace(/^[【＜<■●・]+|[】＞>]+$/g, "").slice(0, 24) || "名前なしの型"; }
  function uniqName(a, n) { if (!a.some(x => x.name === n)) return n; let i = 2; while (a.some(x => x.name === `${n}（${i}）`)) i++; return `${n}（${i}）`; }
  $("pasteBtn").onclick = async () => {
    try { const t = await navigator.clipboard.readText(); if (t) { $("src").value = t; toast("貼りました"); } else toast("コピーした文がありません"); }
    catch (_) { $("src").focus(); toast("欄を長押しして「ペースト」を選んでください"); }
  };
  $("sampleBtn").onclick = () => {
    $("src").value = ["【お客様情報】", "● 店舗名", "● 代表者名（フリガナ）", "● 電話番号 ● メールアドレス", "● 郵便番号", "● 住所", "生年月日：　　年　　月　　日", "",
      "【ご契約内容】", "決済端末：□あり □なし", "支払方法：①一括 ②分割", "月額料金：　　　円", "ご担当者名 ※代表者と同じならスキップOK：", "備考：", "",
      "提出書類一覧", "・身分証明書", "・通帳のコピー"].join("\n");
    toast("見本を入れました");
  };

  $("srcClearBtn").onclick = () => {
    if (!$("src").value) { toast("消す文はありません"); return; }
    if (!confirm("貼った文を全部消しますか？（保存した型はそのまま）")) return;
    $("src").value = ""; $("src").focus(); toast("消しました");
  };

  /* ---------- ② 入力 ---------- */
  function reparse() { st.model = P.parse(st.src, st.tw); }
  const typeAttr = f => {
    switch (f.type) {
      case "tel": return `type="tel" inputmode="tel" autocomplete="off"`;
      case "email": return `type="email" inputmode="email" autocomplete="off" autocapitalize="off"`;
      case "zip": return `type="text" inputmode="numeric" placeholder="例 5420081（ハイフンなしでOK）" autocomplete="off"`;
      case "num": return `type="text" inputmode="numeric" autocomplete="off"`;
      case "money": return f.unit ? `type="text" inputmode="numeric" autocomplete="off"` : `type="text" inputmode="text" placeholder="例 3000000（数字だけならカンマと円を付けます）" autocomplete="off"`;
      case "date": return `type="date"`;
      case "time": return `type="time"`;
      default: return `type="text" autocomplete="off"`;
    }
  };
  function fieldHtml(f) {
    const v = st.values[f.id], ok = P.filled(f, v);
    const badge = f.req ? `<span class="req">必須</span>` : f.soft ? `<span class="opt">空でもOK</span>` : "";
    const unit = f.unit ? `<span class="hint">単位「${esc(f.unit)}」は文に付いています</span>` : "";
    let body = "";
    if (f.skip) body = `<div class="hint">入力しない行にしてあります（文はそのまま）</div>`;
    else if (f.kind === "text") {
      body = f.type === "long" ? `<textarea data-in="${f.id}" rows="3">${esc(v || "")}</textarea>`
        : `<input ${typeAttr(f)} data-in="${f.id}" value="${esc(v || "")}"${f.hint && !/^例/.test(f.hint) ? "" : f.hint ? ` placeholder="${esc(f.hint)}"` : ""}>`;
    } else {
      const opts = P.optsOf(f), sel = (v && v.sel) || [];
      body = `<div class="opts" role="group">${opts.map((o, i) => `<button type="button" data-opt="${f.id}" data-i="${i}" aria-pressed="${sel.includes(i)}">${esc(o)}</button>`).join("")}</div>`;
      if (f.kind === "box") f.options.forEach((o, i) => { if (o.other && sel.includes(i)) body += `<input class="other" type="text" data-other="${f.id}" data-i="${i}" placeholder="「${esc(o.text)}」の中身" value="${esc((v && v.other && v.other[i]) || "")}">`; });
      if (f.kind === "inline") opts.forEach((o, i) => { if (P.OTHER_RE.test(o) && sel.includes(i)) body += `<input class="other" type="text" data-other="${f.id}" data-i="${i}" placeholder="「${esc(o.replace(P.OTHER_RE, ""))}」の中身" value="${esc((v && v.other && v.other[i]) || "")}">`; });   // 値の所の「その他（　）」（テスター A15）
      if (f.free) body += `<input class="other" type="text" data-free="${f.id}" placeholder="選ばずに、文字で入れる" value="${esc((v && v.text) || "")}">`;
      if (f.multi) body = `<div class="hint">いくつでも選べます</div>` + body;
    }
    const hint = f.hint && !(f.kind === "text" && /^例/.test(f.hint)) ? `<div class="hint">${esc(f.hint)}</div>` : "";
    return `<div class="f${ok ? " ok" : ""}${f.soft ? " soft" : ""}${f.skip ? " skip" : ""}" data-f="${f.id}">
      <div class="lb">${esc(f.label)}${badge}</div>${hint}${unit}${body}${st.fix ? fixHtml(f) : ""}</div>`;
  }
  function fixHtml(f) {
    const choice = f.kind === "box" || f.kind === "inline";
    return `<div class="fix">
      <input type="text" data-ren="${f.id}" value="${esc(f.label)}" aria-label="項目の名前">
      <div class="row">
        <button type="button" class="btn small" data-fx="skip" data-id="${f.id}">${f.skip ? "入力欄に戻す" : "入力しない行にする"}</button>
        ${choice ? `<button type="button" class="btn small" data-fx="multi" data-id="${f.id}">${f.multi ? "1つだけ選ぶにする" : "いくつでも選べるにする"}</button>` : ""}
        ${f.kind === "inline" && !f.free ? `<button type="button" class="btn small" data-fx="astext" data-id="${f.id}">選ばずに文字で入れる</button>` : ""}
        ${(st.tw[f.id] || {}).asText ? `<button type="button" class="btn small" data-fx="unastext" data-id="${f.id}">選択肢に戻す</button>` : ""}
        ${String(f.id).split(":")[1] === "0" && (st.tw["L" + f.line] || {}).toField ? `<button type="button" class="btn small" data-fx="unfield" data-id="${f.id}">書いてある行に戻す</button>` : ""}
      </div>
      ${f.skip ? "" : `<div class="row"><input type="text" data-addin="${f.id}" placeholder="選択肢を足す（例 普通）" style="flex:1"><button type="button" class="btn small" data-fx="add" data-id="${f.id}">足す</button></div>`}
      ${(f.added || []).length ? `<div class="row">${f.added.map((a, i) => `<button type="button" class="btn small" data-fx="rmadd" data-id="${f.id}" data-i="${i}">「${esc(a)}」を消す</button>`).join("")}</div>` : ""}
    </div>`;
  }
  function renderForm() {
    const m = st.model, out = [];
    $("fixBtn").setAttribute("aria-pressed", String(st.fix)); $("fixBtn").textContent = st.fix ? "手直しを終える" : "手直し";
    $("fixNote").hidden = !st.fix;
    $("saveBtn").textContent = st.tplId ? (st.dirty ? "型を上書き保存" : "保存済み") : "型を保存";
    const done = new Set();
    m.res.forEach((r, i) => {
      const raw = m.lines[i];
      if (r.kind === "fields") {
        r.fields.forEach(f => {
          if (done.has(f.id)) return; done.add(f.id);
          const mf = m.fields.find(x => x.id === f.id);
          if (mf && (!mf.skip || st.fix)) out.push(fieldHtml(mf));
        });
        return;
      }
      if (r.kind === "covered") return;
      if (r.kind === "list") { out.push(`<label class="chk"><input type="checkbox" data-chk="${r.li}"${st.checked[r.li] ? " checked" : ""}><span>${esc(r.text)}</span></label>`); return; }
      if (r.heading && st.fix && !r.listHead) { out.push(`<div class="head made"><span>${esc(raw.trim())}</span><button type="button" class="btn small" data-tofield="${i}">入力欄にする</button></div>`); return; }   // 見出しも入力欄にできる（テスター A8）
      if (r.heading) { out.push(`<div class="head">${esc(raw.trim())}</div>`); if (r.listHead && m.list.length) out.push(`<div class="hint" style="margin:0 4px 4px">持ち物のチェック（自分用。できた文には入りません）</div>`); return; }
      if (!raw.trim() || /^[ \t　]*([-=━─―＝~〜＊*_＿・･]{3,}|[■□◆◇●○★☆]{3,})[ \t　]*$/.test(raw)) return;
      const inList = m.listStart >= 0 && i > m.listStart && i < m.listEnd;
      if (st.fix && !inList) out.push(`<div class="txt made"><span>${esc(raw.trim())}</span><button type="button" class="btn small" data-tofield="${i}">入力欄にする</button></div>`);
      else out.push(`<div class="txt">${esc(raw.trim())}</div>`);
    });
    $("form").innerHTML = out.join("") || `<div class="empty">入力欄がありません。［手直し］で行を入力欄にしてください。</div>`;
    updateLeft();
  }
  /* 入力（打つたびに全部は描き直さない＝文字を打っている欄がそのまま） */
  $("form").addEventListener("input", e => {
    const t = e.target;
    if (t.dataset.in) { st.values[t.dataset.in] = t.value; mark(t.dataset.in); }
    else if (t.dataset.other) { const v = st.values[t.dataset.other] || (st.values[t.dataset.other] = {sel: []}); v.other = v.other || {}; v.other[t.dataset.i] = t.value; }
    else if (t.dataset.free) { const v = st.values[t.dataset.free] || (st.values[t.dataset.free] = {sel: []}); v.text = t.value; mark(t.dataset.free); }
  });
  $("form").addEventListener("change", e => {
    const t = e.target;
    if (t.dataset.chk != null) st.checked[t.dataset.chk] = t.checked;
    else if (t.dataset.ren) {
      const f = st.model.fields.find(x => x.id === t.dataset.ren), n = t.value.trim();
      tw(t.dataset.ren).label = n && n !== f.origLabel ? n : undefined;
      changed();
    }
  });
  function mark(id) {
    const f = st.model.fields.find(x => x.id === id), el = $("form").querySelector(`[data-f="${CSS.escape(id)}"]`);
    if (f && el) el.classList.toggle("ok", P.filled(f, st.values[id]));
    updateLeft();
  }
  const tw = id => st.tw[id] || (st.tw[id] = {});
  function changed() {
    Object.keys(st.tw).forEach(k => { Object.keys(st.tw[k]).forEach(x => { if (st.tw[k][x] === undefined) delete st.tw[k][x]; }); if (!Object.keys(st.tw[k]).length) delete st.tw[k]; });
    st.dirty = true; reparse(); renderForm();
  }
  $("form").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.opt) {
      const f = st.model.fields.find(x => x.id === b.dataset.opt), i = Number(b.dataset.i);
      const v = st.values[f.id] || (st.values[f.id] = {sel: []});
      if (v.sel.includes(i)) v.sel = v.sel.filter(x => x !== i);
      else v.sel = f.multi ? v.sel.concat([i]) : [i];
      const card = b.closest("[data-f]");
      card.outerHTML = fieldHtml(f);   // 選んだ時だけ出る「その他」の欄のため、この項目だけ描き直す
      updateLeft();
      return;
    }
    if (b.dataset.tofield) { tw("L" + b.dataset.tofield).toField = true; changed(); toast("入力欄にしました"); return; }
    const id = b.dataset.id, fx = b.dataset.fx; if (!fx) return;
    const f = st.model.fields.find(x => x.id === id), t = tw(id);
    if (fx === "skip") t.skip = f.skip ? undefined : true;
    else if (fx === "multi") { t.multi = !f.multi; const v = st.values[id]; if (v && !t.multi && v.sel.length > 1) v.sel = v.sel.slice(0, 1); }
    else if (fx === "astext") { t.asText = true; delete st.values[id]; }
    else if (fx === "unastext") { t.asText = undefined; delete st.values[id]; }
    else if (fx === "unfield") { delete st.tw["L" + f.line]; delete st.values[id]; }
    else if (fx === "add") {
      const inp = b.parentElement.querySelector("[data-addin]"), n = inp.value.trim();
      if (!n) { toast("足す選択肢を入れてください"); inp.focus(); return; }
      if (P.optsOf(f).includes(n)) { toast("もうあります"); return; }
      t.add = (t.add || []).concat([n]);
      if (f.kind === "text") { const old = st.values[id]; st.values[id] = {sel: [], text: typeof old === "string" ? old : ""}; }
    } else if (fx === "rmadd") {
      const i = Number(b.dataset.i), base = P.optsOf(f).length - (f.added || []).length;
      t.add = (t.add || []).filter((_, k) => k !== i); if (!t.add.length) t.add = undefined;
      const v = st.values[id];
      if (v && v.sel) v.sel = v.sel.filter(x => x !== base + i).map(x => x > base + i ? x - 1 : x);
      if (f.free && !t.add) { const tx = v && v.text; st.values[id] = tx || ""; }
    }
    changed();
  });
  $("fixBtn").onclick = () => { st.fix = !st.fix; renderForm(); };
  $("saveBtn").onclick = async () => {
    const a = loadTpls();
    if (st.tplId && a.some(x => x.id === st.tplId)) {
      if (!st.dirty) { toast("保存済みです"); return; }
      const t = a.find(x => x.id === st.tplId); t.src = st.src; t.tw = st.tw; t.at = Date.now();
      if (saveTpls(a)) { st.dirty = false; renderForm(); toast("上書き保存しました"); }
      return;
    }
    /* 貼った文に、お客さんの情報らしい物（電話番号・メール・郵便番号）が入っていたら1回確かめる（秘書の決定 11/17） */
    const pii = /0\d{1,4}[-ー\s]\d{1,4}[-ー\s]\d{3,4}|0[789]0\d{8}|[\w.+-]+@[\w-]+\.[\w.-]+|〒?\s*\d{3}[-ー]\d{4}/.exec(st.src.normalize("NFKC"));   // 全角の数字・＠も（テスター R2）
    if (pii && !confirm(`貼った文に、お客さんの情報（「${pii[0]}」など）が入っていませんか？\n型は、貼った文ごとこの端末に保存されます。\n\nこのまま保存しますか？`)) return;
    const first = (st.src.split("\n").find(l => l.trim()) || "").trim().replace(/^[【＜<■●・]+|[】＞>]+$/g, "").slice(0, 24);
    const n = await ask("型の名前（例 USEN PAY 個人事業主）", first, "保存"); if (!n) return;
    const t = {id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: n, src: st.src, tw: st.tw, at: Date.now()};
    a.unshift(t);
    if (saveTpls(a)) { st.tplId = t.id; st.tplName = n; st.dirty = false; $("title").textContent = n; renderForm(); toast("保存しました（入れた値は保存していません）"); }
  };
  $("clearBtn").onclick = () => {
    if (!hasValues() && !Object.values(st.checked).some(Boolean)) { toast("消す値はありません"); return; }
    if (!confirm("入れた値を全部消しますか？（型はそのまま）")) return;
    st.values = {}; st.checked = {}; renderForm(); toast("消しました");
  };

  /* ---------- 残りの数 ---------- */
  function counts() {
    const fs = (st.model ? st.model.fields : []).filter(f => !f.skip);
    const need = fs.filter(f => !f.soft), left = need.filter(f => !P.filled(f, st.values[f.id]));
    return {all: need.length, left: left.length, softLeft: fs.filter(f => f.soft && !P.filled(f, st.values[f.id])).length};
  }
  function updateLeft() {
    const el = $("left");
    if (!st.model || st.view === "fmt") { el.hidden = true; return; }
    const c = counts();
    el.hidden = false; el.className = "chip" + (c.left ? "" : " done");
    el.textContent = c.left ? `残り ${c.left}／${c.all}` : "全部入りました";
  }

  /* ---------- ③ できた文 ---------- */
  function renderOut() {
    const m = st.model;
    $("listSw").hidden = !m.list.length; $("withList").checked = st.withList;
    const parts = P.build(m, st.values, {withList: st.withList});
    $("out").innerHTML = parts.filter(l => l).map(l => l.map(x => x.empty ? `<mark class="${x.soft ? "soft" : ""}">${esc(x.t)}</mark>` : esc(x.t)).join("").replace(/[ \t　]+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
    const c = counts();
    $("outMsg").innerHTML = c.left ? `<div class="warnbox">まだ入っていない所が ${c.left} か所あります（黄色）。穴あきで送らないように、入力にもどって入れてください。</div>`
      : `<div class="okbox">全部入りました${c.softLeft ? `（「空でもOK」の所が ${c.softLeft} か所空いています）` : ""}。［コピーする］で、LINEやメールに貼れます。</div>`;
  }
  $("withList").onchange = () => { st.withList = $("withList").checked; renderOut(); };
  async function copyOut() {
    const c = counts();
    if (c.left && !st.warnedCopy) { st.warnedCopy = true; toast(`空欄が ${c.left} か所あります。このままコピーする時は、もう一度押してください`); return; }
    const text = P.toText(P.build(st.model, st.values, {withList: st.withList}));
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
      const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "-1000px";
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
      ta.remove();
    }
    toast(ok ? "コピーしました" : "コピーできませんでした。文を長押しして選んでください");
  }
  $("barMain").onclick = () => { if (st.view === "out") copyOut(); else go("out"); };
  $("barBack").onclick = () => go("form");

  /* 入れた値があるまま閉じようとしたら止める（値は保存しないので） */
  window.addEventListener("beforeunload", e => { if (hasValues()) { e.preventDefault(); e.returnValue = ""; } });

  /* 試し用（テストのページから中を見る） */
  window.__fmt = {st, go, open, counts, renderForm};
  go("fmt");
})();
