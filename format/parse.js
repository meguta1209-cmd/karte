/* フォーマット入力 — 貼った文を「入力欄」と「そのまま残す行」に分ける（AIは使わない・ルールだけ）
   2026-11-17 デベロッパー。
   parse(src, tw) → {lines, res, fields, list}。build(model, values, {withList}) → 行ごとの部品（できた文・空欄の印）。
   tw は手直し：{"<項目のid>": {label, skip, multi, add:[…], asText, type}, "L<行>": {toField:true}} */
(function (root) {
  "use strict";
  const BLANK_RE = /^[ \t　＿_]*$/;                                        // 空白・下線だけ＝空欄
  const BOX_RE = /[□☐■◻▢☑]/g;                                                 // チェックの四角
  const NUM_RE = /^[ \t　]*(?:(?:[0-9０-９]{1,3}|[A-Za-zＡ-Ｚａ-ｚ])[.．)）、](?![0-9０-９])|[（(][0-9０-９]{1,3}[）)]|[①-⑳㉑-㉟]|Q[0-9０-９]{1,3}[.．:：]?)[ \t　]*/;   // 番号（1. ① (1) A. Q1）
  const BUL_CH = "・･•●○◆◇▼▽▶►★☆◎-";
  const BUL_RE = /^[ \t　]*([・･•●○◆◇▼▽▶►★☆◎-])[ \t　]*/;          // 箇条書きの印
  const BRACKET_RE = /^[ \t　]*(【[^】]{1,30}】|＜[^＞]{1,30}＞|<[^>]{1,30}>|［[^］]{1,30}］|\[[^\]]{1,30}\]|≪[^≫]{1,30}≫|《[^》]{1,30}》)/;
  const DECO_RE = /^[ \t　]*([-=━─―＝~〜＊*_＿・･]{3,}|[■□◆◇●○★☆]{3,})[ \t　]*$/;   // 区切り線
  const NOTE_RE = /^[ \t　]*(※|注[)）:：]|注意[)）:：]|＊注)/;
  const SEP_RE = /[：:＝]/;
  const PLACE_RE = /^[ \t　]*(?:[○〇◯]{2,}.*|[XxＸｘ×]{2,}.*|[＿_]{2,}|[･・]{3,}|…+|（[ \t　]*）|\([ \t　]*\)|「[ \t　]*」|例[)）]?[：:].*|（例[：:].*）|\(例[：:].*\))[ \t　]*$/;
  const UNIT_RE = /^([ \t　＿_]*)(円|万円|千円|台|枚|件|名|人|歳|才|ヶ月|か月|カ月|ヵ月|年|%|％|坪|席|店舗|回|個|本)([ \t　]*)$/;
  const YMD_RE = /^[ \t　]*((?:令和|平成|昭和|大正|西暦)(?:[・／/、 \t　]*(?:令和|平成|昭和|大正|西暦))*)?[ \t　＿_]*年[ \t　＿_]*月[ \t　＿_]*日[ \t　]*([（(][ \t　＿_]*(?:歳|才)?[ \t　＿_]*[）)])?[ \t　]*$/;
  const MD_RE = /^[ \t　＿_]*月[ \t　＿_]*日[ \t　]*([（(][ \t　＿_]*[）)])?[ \t　]*$/;
  const UNITS2_RE = /^[ \t　＿_]*(?:(?:年|ヶ月|か月|カ月|ヵ月|月|日|時間|時|分|歳|才)[ \t　＿_]*){2,}$/;
  const DASH_BLANK_RE = /^[ \t　＿_－\-ー‐−〜~]*$/;
  const HM_RE = /^[ \t　＿_]*時[ \t　＿_]*分[ \t　]*$/;
  const OTHER_RE = /[（(]([ \t　＿_]*)[）)]/;                                // 「その他（　　）」の中
  const CHECK_HEAD_RE = /(必要|提出|添付|持参|準備|用意)[^。]{0,6}(書類|資料|もの|物)|(書類|資料)一覧|持ち物|チェックリスト/;   // ここから下は持ち物リスト
  const MULTI_RE = /複数(回答|選択)?(可|OK|ＯＫ)|複数回答|複数選択|いくつでも|すべて選|全て選|当てはまるもの全て/;
  const SOFT_RE =/スキップ|省略|任意|同じであれば|同じ場合|なければ|無い場合|ない場合|わかれば|分かれば/;
  const PAIRS = [["あり", "なし"], ["有", "無"], ["有り", "無し"], ["はい", "いいえ"], ["要", "不要"], ["済", "未"], ["男", "女"], ["男性", "女性"], ["法人", "個人"], ["する", "しない"], ["可", "不可"], ["新規", "既存"]];
  const VOCAB = new Set(PAIRS.flat().concat(["普通", "当座", "貯蓄", "一括", "分割", "その他", "未定", "済み", "未済"]));

  const trimJ = s => String(s).replace(/^[ \t　]+|[ \t　]+$/g, "");
  const endOf = s => s.replace(/[ \t　]+$/, "").length;
  const stripNum = s => s.replace(NUM_RE, "").replace(BUL_RE, "");
  function cleanLabel(s) {
    let req = false;
    s = trimJ(stripNum(trimJ(s)).replace(/^[■□◆◇]+[ \t　]*/, ""));
    const b = s.match(/^(?:【(.*)】|＜(.*)＞|<(.*)>|［(.*)］|\[(.*)\]|≪(.*)≫|《(.*)》)$/);
    if (b) s = b.slice(1).find(x => x != null);
    s = s.replace(/^(?:[（(]必須[）)]|※必須|【必須】|＜必須＞|\[必須\]|［必須］)[ \t　]*/, () => { req = true; return ""; });   // 頭の【必須】（テスター A14）
    s = s.replace(/[ \t　]*(?:[（(]必須[）)]|※必須|【必須】|＜必須＞|必須)$/, () => { req = true; return ""; });
    s = s.replace(/[ \t　]*[*＊]$/, () => { req = true; return ""; });
    return {label: trimJ(s), req};
  }
  /* 項目名（と補足）から入力の種類 */
  function typeOf(l, hint) {
    l = String(l).replace(/[ \t　]/g, "");   // 「電　話」も電話（テスター A13）
    const s = l + " " + (hint || ""), core = l.replace(/[（(][^（）()]*[）)]$/, "");   // 後ろのかっこ（日中など）は外して見る
    if (/郵便|〒/.test(l)) return "zip";
    if (/メール|e-?mail|E-?mail|EMAIL|Email|ﾒｰﾙ/.test(l)) return "email";
    /* 電話のキーボードは「〜電話・〜番号・TEL・FAX」で終わる物だけ（「携帯キャリア」「固定電話オプション」は文字。テスター A4） */
    if (/(電話|携帯|TEL|Tel|tel|ＴＥＬ|FAX|Fax|fax|ＦＡＸ|ファックス)(番号)?$/.test(core) || /(電話|携帯|TEL|ＴＥＬ|FAX|ＦＡＸ)番号/.test(core) || (/^(ご)?連絡先$/.test(core) && /携帯|電話|番号/.test(s))) return "tel";
    if (/生年月日|年月日|日付|(?:申込|申し込み|契約|開業|開店|設立|予定|希望|設置|工事|訪問|締結|記入|作成|入金|支払|引渡|納品|利用開始|営業開始|開始|終了|誕生)日/.test(l)) return "date";
    if (/金額|料金|価格|費用|売上|売り上げ|月商|年商|単価|手数料|資本金|取扱高|予算/.test(l)) return "money";
    if (/台数|枚数|件数|人数|個数|席数|店舗数|従業員数|社員数|年齢|数量|坪数|口座番号/.test(l) || /コード$|コード[（(]/.test(l)) return "num";   // 「店舗名（QRコード決済用）」は文字
    if (/備考|メモ|詳細|特記|補足|要望|コメント|ご意見|理由/.test(l)) return "long";
    return "text";
  }
  /* 値のところに書いてある選択肢（あり・なし／①A ②B／（はい・いいえ）） */
  function parseChoices(v) {
    let s = trimJ(v);
    const pm = s.match(/^[（(【［\[](.*)[）)】］\]]$/);
    if (pm) s = trimJ(pm[1]);
    if (!s || s.length > 80) return null;
    const mk = /[①-⑳]|[（(][0-9０-９]{1,2}[）)]|(?:^|[ \t　])[A-Za-zＡ-Ｚ0-9０-９][.．)）](?![0-9０-９])/g;
    const marks = [...s.matchAll(mk)];
    if (marks.length >= 2 && marks[0].index === 0) {
      const out = marks.map((m, i) => trimJ(s.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : s.length))).filter(Boolean);
      if (out.length >= 2 && out.every(p => p.length <= 30)) return out;
    }
    /* 「あり or なし」「持家or賃貸」（テスター A3） */
    const orp = s.split(/[ \t　]*(?:\bor\b|(?<=[^A-Za-z])or(?=[^A-Za-z])|ＯＲ|ｏｒ|\bOR\b)[ \t　]*/).map(trimJ).filter(Boolean);
    if (orp.length >= 2 && orp.length <= 6 && orp.every(p => p.length <= 16 && !/[。：:＝]/.test(p))) return orp;
    if (/[・／\/｜|、,，]/.test(s) && !/https?:|www\./.test(s)) {
      const KEEP = "¤";   // 「1,000円」の数字の間のカンマでは分けない（テスター A5）
      const parts = s.replace(/([0-9０-９])[,，](?=[0-9０-９]{3})/g, "$1" + KEEP).split(/[ \t　]*[・／\/｜|、,，][ \t　]*/).map(p => trimJ(p.split(KEEP).join(","))).filter(Boolean);
      if (parts.length >= 2 && parts.length <= 10 && parts.every(p => p.length <= 14 && !/[。：:＝]/.test(p))) return parts;
    }
    const sp = s.split(/[ \t　]+/).filter(Boolean);
    if (sp.length === 2 && PAIRS.some(([a, b]) => sp[0] === a && sp[1] === b)) return sp;
    return null;
  }
  /* 項目名のうしろの（あり・なし）＝選択肢を項目名に書いてある形。決まった言葉だけ（「（店番号・支店番号）」は選択肢にしない） */
  function labelChoices(label) {
    /* 項目名そのものが「男性or女性」「ネット＋光電話orネットのみ」＝選択肢（項目名はそのまま。テスター A3） */
    if (/or|ＯＲ|ｏｒ|OR/.test(label) && !/[（(]/.test(label)) {
      const ch = parseChoices(label);
      if (ch && ch.length >= 2) return {label: String(label), options: ch, whole: true};
    }
    const m = String(label).match(/^(.*?)[ \t　]*[（(]([^（）()]+)[）)]$/);
    if (!m || !m[1]) return null;
    const ch = parseChoices(m[2]);
    return ch && ch.every(c => VOCAB.has(c.replace(/^[①-⑳]|^[（(][0-9０-９]+[）)]/, "").trim())) ? {label: m[1], options: ch} : null;
  }
  /* 番号の付いた選択肢だけの行（「A. はい　B. いいえ」「①あり ②なし」。テスター A7） */
  function markerChoices(raw) {
    if (SEP_RE.test(raw)) return null;
    const s = trimJ(raw);
    const marks = [...s.matchAll(/[①-⑳]|[（(][0-9０-９]{1,2}[）)]|(?:^|[ \t　])[A-Za-zＡ-Ｚ0-9０-９][.．)）](?![0-9０-９])/g)];
    if (marks.length < 2 || marks[0].index !== 0) return null;
    const out = marks.map((m, i) => trimJ(s.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : s.length))).filter(Boolean);
    return out.length >= 2 && out.every(p => p.length <= 30 && trimJ(p.replace(/^[①-⑳]|^[（(][0-9０-９]+[）)]|^[A-Za-zＡ-Ｚ0-9０-９][.．)）]/, ""))) ? out : null;
  }
  /* 箇条書きの1かたまり「代表者名 ※…」「連絡先（必ず携帯番号で…）」→ 項目名・補足 */
  function parseSeg(text) {
    let t = trimJ(text), hint = "";
    const nm = t.indexOf("※");
    if (nm > 0) { hint = trimJ(t.slice(nm + 1)); t = trimJ(t.slice(0, nm)); }
    t = t.replace(/[ \t　]*[（(]([^（）()]*)[）)]/g, (all, inner) => (inner.length > 12 || /[。、]/.test(inner)) ? (hint = trimJ((hint ? hint + " " : "") + inner), "") : all);
    const cl = cleanLabel(t);
    return {label: cl.label, req: cl.req, hint, soft: SOFT_RE.test(hint)};
  }
  /* 「● A ● B」のように同じ印が行の中にもう一度（前が空白）出たら、そこで分ける。返す：[{s,e}]（印の後ろ〜次の印の前） */
  function bulletSegs(raw) {
    const m = raw.match(BUL_RE);
    if (!m) return null;
    const ch = m[1], first = raw.indexOf(ch);
    const idx = [first];
    for (let i = first + 1; i < raw.length; i++) if (raw[i] === ch && /[ \t　]/.test(raw[i - 1])) idx.push(i);
    return idx.map((p, k) => ({s: p + 1, e: k + 1 < idx.length ? idx[k + 1] : raw.length}));
  }

  /* 1行を調べる。{kind:"text"} / {kind:"fields", fields} / 候補（bracket・bare・boxonly） */
  function parseLine(raw, li) {
    if (BLANK_RE.test(raw) || DECO_RE.test(raw) || NOTE_RE.test(raw)) return {kind: "text"};
    const mc = markerChoices(raw);
    if (mc) return {kind: "choiceonly", options: mc, line: li, start: raw.length - raw.replace(/^[ \t　]+/, "").length, end: endOf(raw)};
    const preM = raw.match(NUM_RE) || raw.match(BUL_RE);
    const pre = preM ? preM[0].length : 0;
    const body = raw.slice(pre);
    /* ① チェックの四角（□あり □なし） */
    const boxes = [...body.matchAll(BOX_RE)].map(m => m.index);
    if (boxes.length) {
      const head = body.slice(0, boxes[0]);
      const opts = boxes.map((p, i) => {
        const end = i + 1 < boxes.length ? boxes[i + 1] : body.length;
        const seg = body.slice(p + 1, end), t = trimJ(seg), om = t.match(OTHER_RE);
        let other = null;
        if (om) { const at = body.indexOf(om[0], p + 1); other = {start: pre + at + 1, end: pre + at + 1 + om[1].length}; }
        return {line: li, pos: pre + p, glyph: body[p], text: trimJ(t.replace(OTHER_RE, "")) || t, other};
      }).filter(o => o.text);
      /* 「■ 新規お申込み」のように ■ が1つだけ＝見出しの印（四角ではない） */
      /* 「■お申込書■」「□題名□」のように両はしが四角で中が1つ＝題名（テスター A6） */
      const headMark = opts.length === 1 && BLANK_RE.test(head) && (body[boxes[0]] === "■" || (boxes.length === 2 && BLANK_RE.test(body.slice(boxes[1] + 1))));
      if (!headMark && opts.length && (boxes.length >= 2 || opts.length === 1)) {
        const hl = cleanLabel(head.replace(/[：:＝][ \t　]*$/, ""));
        if (hl.label) return {kind: "fields", fields: [{kind: "box", label: hl.label, req: hl.req, options: opts, multi: false, line: li}]};
        return {kind: "boxonly", options: opts, line: li};
      }
    }
    /* ② 項目名：値 */
    const sm = body.match(SEP_RE);
    if (sm && !/^https?$/i.test(trimJ(body.slice(0, sm.index)))) {
      const sepAt = pre + sm.index;
      const ps = parseSeg(raw.slice(0, sepAt));
      if (!ps.label || ps.label.length > 40 || /[。]$/.test(ps.label)) return {kind: "text"};
      const segs = splitMulti(raw, sepAt + 1);
      if (segs) {
        const fs = [mkText(ps, li, sepAt + 1, segs[0].labStart)].concat(segs.map((s, k) => mkText(parseSeg(s.label), li, s.sepEnd, k + 1 < segs.length ? segs[k + 1].labStart : raw.length)));
        fs.forEach((f, k) => { if (k < fs.length - 1) f.keepTail = true; });
        return {kind: "fields", fields: fs};
      }
      return valueField(raw, li, ps, sepAt + 1);
    }
    /* ③ 項目名（　　　） */
    const pm = body.match(/^(.+?)[ \t　]*([（(])([ \t　＿_]+)([）)])[ \t　]*$/);
    if (pm && !BRACKET_RE.test(body)) {
      const ps = parseSeg(raw.slice(0, pre) + pm[1]);
      const st = pre + body.lastIndexOf(pm[2] + pm[3] + pm[4]) + 1;
      if (ps.label && ps.label.length <= 40) return {kind: "fields", fields: [Object.assign(mkText(ps, li, st, st + pm[3].length))]};
    }
    /* ④ 【項目】・＜項目＞ */
    const bm = body.match(BRACKET_RE);
    if (bm && bm.index === 0) {
      const cl = cleanLabel(bm[1]), restAt = pre + bm[1].length, rest = raw.slice(restAt);
      if (BLANK_RE.test(rest)) return {kind: "bracket", label: cl.label, req: cl.req, line: li, at: endOf(raw)};
      const vf = valueField(raw, li, {label: cl.label, req: cl.req, hint: ""}, restAt);
      if (vf.kind === "text") vf.heading = true;   // 【契約者情報】個人事業主 ＝ 見出し
      return vf;
    }
    /* ⑤ 印・番号の付いた短い項目名（● 代表者名 ／ 1. 代表者名 ／ ● A ● B は2つ） */
    if (preM) {
      const segs = (raw.match(NUM_RE) ? null : bulletSegs(raw)) || [{s: pre, e: raw.length}];
      const items = segs.map(g => Object.assign(parseSeg(raw.slice(g.s, g.e)), {at: g.s + endOf(raw.slice(g.s, g.e))}));
      if (items.some(x => !x.label || x.label.length > 30 || /[。！？!?]/.test(x.label))) return {kind: "text", bullet: true};
      if (items.length === 1) return Object.assign({kind: "bare", line: li, bullet: true, num: NUM_RE.test(raw)}, items[0]);
      return {kind: "fields", fields: items.map(x => bareField(x, li))};
    }
    return {kind: "text"};
  }
  function mkText(ps, li, start, end) {
    return {kind: "text", type: typeOf(ps.label, ps.hint), label: ps.label, req: ps.req, hint: ps.hint || "", soft: !!ps.soft, line: li, start, end};
  }
  function bareField(x, li) {
    const lc = labelChoices(x.label);
    const f = lc ? {kind: "inline", label: lc.label, options: lc.options} : {kind: "text", type: typeOf(x.label, x.hint), label: x.label};
    return Object.assign(f, {req: x.req, hint: x.hint || "", soft: !!x.soft, line: li, start: x.at, end: x.at, append: true, glue: "："});
  }
  /* 区切りのうしろに「空白＋項目名：」が続く（氏名：　　電話：　　） */
  function splitMulti(raw, from) {
    const re = /([ \t　＿_－\-ー‐−]+)([^ \t　：:＝－\-ー‐−]{1,20})[ \t　]*[：:＝]/y;   // 「TEL：　－　－　FAX：」も2つ
    const segs = [];
    let p = from;
    for (let g = 0; g < 10; g++) {
      re.lastIndex = p;
      const m = re.exec(raw);
      if (!m) break;
      segs.push({labStart: m.index + m[1].length, label: m[2], sepEnd: m.index + m[0].length});
      p = m.index + m[0].length;
    }
    return segs.length && DASH_BLANK_RE.test(raw.slice(p)) ? segs : null;
  }
  /* 〒の欄：項目名が郵便番号なら1つ。「ご住所：〒　－」なら 郵便番号（数字）＋ 住所（文字・後ろに入れる）の2つ（テスター R1：iPhone で住所の漢字が打てるように） */
  function zipAddr(ps, li, f, raw) {
    f.type = "zip";
    if (typeOf(ps.label) === "zip" || !/住所|所在地|住まい|送付先|届け先|設置場所|現住所/.test(ps.label)) return {kind: "fields", fields: [f]};
    const zipF = Object.assign(f, {label: ps.label + "（郵便番号）"});
    const addr = Object.assign(mkText(ps, li, raw.length, raw.length), {type: "text", append: true, glue: "　", hint: ""});
    return {kind: "fields", fields: [zipF, addr]};
  }
  /* 区切りのうしろの値から、入力欄か・選択肢か・書いてある行かを決める */
  function valueField(raw, li, ps, vStart) {
    const zm = raw.slice(vStart).match(/^[ \t　]*〒/);   // 「郵便番号：〒」の〒は残して、その後ろに入れる
    if (zm) vStart += zm[0].length;
    const v = raw.slice(vStart), vEnd = Math.max(vStart, endOf(raw));
    const base = {req: ps.req, hint: ps.hint || "", soft: !!ps.soft, line: li};
    const lc = labelChoices(ps.label);
    /* 空白とハイフンだけ（〒　－　／TEL：　－　－）・後ろに 印・㊞（お名前：　　印）＝空欄。印は残す（テスター A2） */
    const seal = v.match(/[（(]?[印㊞][）)]?[ \t　]*$/);
    const vNoSeal = seal ? v.slice(0, v.length - seal[0].length) : v;
    if (!BLANK_RE.test(v) && DASH_BLANK_RE.test(vNoSeal) && (seal || /[－\-ー‐−]/.test(vNoSeal))) {
      const f = mkText(ps, li, vStart, vStart + vNoSeal.length);
      if (seal) f.keepTail = true;
      if (zm && !seal) return zipAddr(ps, li, f, raw);   // 「ご住所：〒　－」は郵便番号（＋住所）
      return {kind: "fields", fields: [f]};
    }
    if (zm && BLANK_RE.test(v)) return zipAddr(ps, li, mkText(ps, li, vStart, raw.length), raw);
    /* 「名前：（　　　）」はかっこの中に入れる（テスター A10） */
    const pin = v.match(/^([ \t　]*[（(])([ \t　＿_]+)[）)][ \t　]*$/);
    if (pin) return {kind: "fields", fields: [mkText(ps, li, vStart + pin[1].length, vStart + pin[1].length + pin[2].length)]};
    if (BLANK_RE.test(v)) {
      if (lc) return {kind: "fields", fields: [Object.assign({kind: "inline", label: lc.label, options: lc.options, start: vStart, end: raw.length}, base)]};
      return {kind: "fields", fields: [Object.assign(mkText(ps, li, vStart, raw.length))]};
    }
    const um = v.match(UNIT_RE);
    if (um) {
      const t = typeOf(ps.label, ps.hint);
      return {kind: "fields", fields: [Object.assign({kind: "text", type: t === "text" || t === "long" ? (/円/.test(um[2]) ? "money" : "num") : t, unit: um[2], label: ps.label, start: vStart, end: vStart + um[1].length}, base)]};
    }
    /* 日付：「　年　月　日」「令和　年…」「昭和・平成　年…（　歳）」「　月　日（　）」（テスター A11） */
    const ym = v.match(YMD_RE);
    if (ym) {
      const eras = (ym[1] || "").split(/[・／/、 \t　]+/).filter(e => e && e !== "西暦");
      return {kind: "fields", fields: [Object.assign({kind: "text", type: "date", fmt: eras.length > 1 ? "era:auto" : eras.length ? "era:" + eras[0] : "ymd", paren: ym[2] ? (/[歳才]/.test(ym[2]) ? "age" : "wday") : "", label: ps.label, start: vStart, end: vEnd}, base)]};
    }
    const md = v.match(MD_RE);
    if (md) return {kind: "fields", fields: [Object.assign({kind: "text", type: "date", fmt: "md", paren: md[1] ? "wday" : "", label: ps.label, start: vStart, end: vEnd}, base)]};
    if (HM_RE.test(v)) return {kind: "fields", fields: [Object.assign({kind: "text", type: "time", fmt: "hm", label: ps.label, start: vStart, end: vEnd}, base)]};
    /* 「勤続年数：　年　ヶ月」のように単位が2つ以上＝文字で入れる（形を見本に出す） */
    if (UNITS2_RE.test(v)) return {kind: "fields", fields: [Object.assign(mkText(ps, li, vStart, vEnd), {hint: "形：" + trimJ(v).replace(/[ \t　＿_]+/g, "〇").replace(/^(?!〇)/, "〇")})]};
    const ch = parseChoices(v);
    if (ch) return {kind: "fields", fields: [Object.assign({kind: "inline", label: ps.label, options: ch, start: vStart, end: vEnd}, base)]};
    if (PLACE_RE.test(v)) return {kind: "fields", fields: [Object.assign(mkText(ps, li, vStart, vEnd), {hint: trimJ(v)})]};
    return {kind: "text"};
  }

  function parse(src, tw) {
    tw = tw || {};
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    const res = lines.map((l, i) => parseLine(l, i));
    /* 持ち物リスト（「提出必須資料一覧」など）：その行から、次の【見出し】か最後まで。印の付いた行はチェックだけ（文には入れない） */
    const list = [];
    let listFrom = -1;
    for (let i = 0; i < lines.length; i++) {
      if (listFrom < 0) {
        if (res[i].kind === "text" && !res[i].bullet && CHECK_HEAD_RE.test(lines[i]) && trimJ(lines[i]).length <= 30) { listFrom = i; res[i] = {kind: "text", heading: true, listHead: true}; }
        continue;
      }
      if (BRACKET_RE.test(lines[i]) && /^[ \t　]*【/.test(lines[i])) { listFrom = -2; break; }
      if (BUL_RE.test(lines[i]) || NUM_RE.test(lines[i])) {
        const t = trimJ(stripNum(lines[i]));
        if (t) { res[i] = {kind: "list", text: t, li: list.length}; list.push({line: i, text: t}); continue; }
      }
      if (res[i].kind !== "text") res[i] = {kind: "text"};
    }
    const listStart = res.findIndex(r => r.listHead);
    let listEnd = lines.length;
    if (listStart >= 0) for (let i = listStart + 1; i < lines.length; i++) if (/^[ \t　]*【/.test(lines[i])) { listEnd = i; break; }
    /* 四角だけの行が続く（□あり／□なし を1行ずつ）＝1つの選択。項目名は、すぐ上の行 */
    for (let i = 0; i < res.length; i++) {
      if (res[i].kind !== "boxonly") continue;
      let j = i; const opts = [];
      const agree = r => r.options.length === 1 && /(同意|承諾|確認)(する|します|しました|済み?)?$/.test(r.options[0].text);   // 「□ 〜に同意する」は1つで別の項目
      if (agree(res[i])) j = i + 1;
      else while (j < res.length && res[j].kind === "boxonly" && !agree(res[j])) { opts.push(...res[j].options); j++; }
      if (j === i + 1 && !opts.length) opts.push(...res[i].options);
      const {label, req, hint} = agree(res[i]) ? {label: null, req: false} : labelAbove(i);
      res[i] = {kind: "fields", fields: [opts.length === 1 && !label ? {kind: "box", label: opts[0].text, req: false, options: opts, multi: false, line: i, check: true}
        : {kind: "box", label: label || "（選択）", req, hint: hint || "", options: opts, multi: false, line: i}]};
      for (let x = i + 1; x < j; x++) res[x] = {kind: "covered"};
      i = j - 1;
    }
    /* 「A. はい　B. いいえ」だけの行＝選択。項目名はすぐ上の行（テスター A7） */
    for (let i = 0; i < res.length; i++) {
      const r = res[i];
      if (r.kind !== "choiceonly") continue;
      const {label, req, hint} = labelAbove(i);
      res[i] = {kind: "fields", fields: [{kind: "inline", label: label || "（選択）", req, hint: hint || "", options: r.options, line: i, start: r.start, end: r.end}]};
    }
    /* すぐ上の行を項目名にする（使った行は見出しか、ただの文になる） */
    function labelAbove(i) {
      let k = i - 1; while (k >= 0 && BLANK_RE.test(lines[k])) k--;
      const up = k >= 0 ? res[k] : null;
      if (up && (up.kind === "bracket" || up.kind === "bare")) { res[k] = {kind: "text", heading: up.kind === "bracket"}; return {label: up.label, req: up.req}; }
      if (up && up.kind === "fields" && up.fields.length === 1 && up.fields[0].kind === "text" && !up.fields[0].append && BLANK_RE.test(lines[k].slice(up.fields[0].start))) { res[k] = {kind: "text"}; return {label: up.fields[0].label, req: up.fields[0].req}; }
      const upT = trimJ(lines[k] || "").replace(/[ \t　]*[（(][^（）()]*[）)]$/, "");   // 「〜ますか？（はい・いいえ）」の後ろのかっこは外して見る（テスター R3）
      if (up && up.kind === "text" && !NOTE_RE.test(lines[k]) && !DECO_RE.test(lines[k]) && (/[：:？?]$/.test(upT) && upT.length <= 40 || upT.length <= 20 && !/[。]/.test(upT))) {
        const cl = cleanLabel(upT.replace(/[：:]$/, "")), pm = trimJ(lines[k]).match(/[（(]([^（）()]*)[）)]$/);
        return {label: cl.label, req: cl.req, hint: pm ? pm[1] : ""};   // 外したかっこ（複数回答可 など）は補足に
      }
      return {label: null, req: false};
    }
    /* 【項目】だけの行：すぐ下が入力欄なら見出し、そうでなければ入力欄（値は同じ行の後ろ）。● 項目名だけの行は入力欄 */
    for (let i = 0; i < res.length; i++) {
      const r = res[i];
      if (r.kind !== "bracket" && r.kind !== "bare") continue;
      let k = i + 1; while (k < res.length && BLANK_RE.test(lines[k])) k++;
      const nx = k < res.length ? res[k] : null;
      if (r.kind === "bracket" && nx && (nx.kind === "fields" || nx.kind === "covered" || nx.kind === "bare")) { res[i] = {kind: "text", heading: true}; continue; }
      /* 「10.番ポ情報」のすぐ下に「・番ポ電話番号：」のような入力欄が続く＝見出し（テスター A9） */
      if (r.kind === "bare" && r.num && nx && nx.kind === "fields" && (BUL_RE.test(lines[k]) || /^[ \t　]+\S/.test(lines[k]))) { res[i] = {kind: "text", heading: true}; continue; }
      res[i] = {kind: "fields", fields: [Object.assign(bareField(r, i), r.kind === "bracket" ? {glue: ""} : {})]};
    }
    /* 見出しっぽい行（【お客様情報】・■店舗情報） */
    res.forEach((r, i) => { if (r.kind === "text" && !r.heading && (/^[ \t　]*【/.test(lines[i]) || /^[ \t　]*[■◆▼◎][^：:]{1,24}$/.test(lines[i]))) r.heading = true; });
    /* 手直し：書いてある行を入力欄にする（区切りがあればその後ろ、無ければ行の後ろに「：」） */
    res.forEach((r, i) => {
      if (r.kind !== "text" || !(tw["L" + i] && tw["L" + i].toField)) return;
      const raw = lines[i], sm = raw.match(SEP_RE), ps = parseSeg(sm ? raw.slice(0, sm.index) : raw), end = endOf(raw);
      if (!ps.label) ps.label = "（入力）";
      res[i] = {kind: "fields", made: true, fields: [sm ? Object.assign(mkText(ps, i, sm.index + 1, Math.max(sm.index + 1, end)), {hint: trimJ(raw.slice(sm.index + 1)) || ps.hint})
        : Object.assign(mkText(ps, i, end, end), {append: true, glue: /^[ \t　]*【[^】]*】[ \t　]*$/.test(raw) ? "" : "："})]};
    });
    const fields = [];
    res.forEach((r, i) => {
      if (r.kind !== "fields") return;
      r.fields.forEach((f, j) => {
        f.id = i + ":" + j;
        const t = tw[f.id] || {};
        f.origLabel = f.label;
        if (t.label) f.label = t.label;
        if (t.skip) f.skip = true;
        if ((f.kind === "box" || f.kind === "inline") && MULTI_RE.test(f.label + " " + (f.hint || ""))) f.multi = true;   // 複数回答可（テスター A12）
        if ((f.kind === "box" || f.kind === "inline") && t.multi != null) f.multi = !!t.multi;
        if (f.kind === "inline" && t.asText) { f.kind = "text"; f.type = "text"; f.hint = f.options.join("・"); delete f.options; }
        if (f.kind === "text" && Array.isArray(t.add) && t.add.length) { f.kind = "inline"; f.options = []; f.free = true; }   // 自由入力に選択肢を足した＝選択も入力もできる
        if ((f.kind === "box" || f.kind === "inline") && Array.isArray(t.add)) f.added = t.add.filter(Boolean);
        if (f.kind === "text" && t.type) f.type = t.type;
        fields.push(f);
      });
    });
    return {lines, res, fields, list, listStart, listEnd};
  }

  /* ---------- できた文 ---------- */
  const toHalf = s => String(s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  function fmtValue(f, v) {
    v = String(v == null ? "" : v);
    if (!v.trim()) return "";
    if (f.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [y, m, d] = v.split("-").map(Number), dt = new Date(y, m - 1, d);
      let paren = "";
      if (f.paren === "wday") paren = `（${"日月火水木金土"[dt.getDay()]}）`;
      if (f.paren === "age") { const now = new Date(); let a = now.getFullYear() - y; if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) a--; paren = `（${a}歳）`; }
      if (f.fmt === "md") return `${m}月${d}日${paren}`;
      if (f.fmt && f.fmt.indexOf("era:") === 0) {
        let era = f.fmt.slice(4);
        if (era === "auto") era = v >= "2019-05-01" ? "令和" : v >= "1989-01-08" ? "平成" : v >= "1926-12-25" ? "昭和" : "大正";
        const base = {令和: 2018, 平成: 1988, 昭和: 1925, 大正: 1911}[era];
        if (base) { const ey = y - base; return `${era}${ey === 1 ? "元" : ey}年${m}月${d}日${paren}`; }
      }
      return `${y}年${m}月${d}日${paren}`;
    }
    if (f.type === "time" && /^\d{2}:\d{2}$/.test(v)) { const [h, mi] = v.split(":").map(Number); return f.fmt === "hm" ? `${h}時${mi}分` : v; }
    if (f.type === "zip") { const d = toHalf(v).replace(/[^0-9]/g, ""); if (d.length === 7) return d.slice(0, 3) + "-" + d.slice(3); }
    if (f.type === "money" && /^[0-9０-９,，]+$/.test(v.trim())) {
      const n = Number(toHalf(v).replace(/[,，\s]/g, ""));
      if (isFinite(n)) return n.toLocaleString("ja-JP") + (f.unit ? "" : "円");
    }
    return f.type === "long" ? v.replace(/\n+$/, "") : v.replace(/[\r\n]+/g, " ");
  }
  function optsOf(f) { return (f.kind === "box" ? f.options.map(o => o.text) : (f.options || []).slice()).concat(f.added || []); }
  /* 値が入っているか（text は文字、選択は1つ以上・自由入力つきの選択は文字でも可） */
  function filled(f, v) {
    if (f.kind === "text") return !!String(v == null ? "" : v).trim();
    return !!(v && ((v.sel && v.sel.length) || (f.free && v.text && String(v.text).trim())));
  }
  /* 行ごとの部品：[{t, empty, fid}]。持ち物リストは withList のときだけ（無いときはその行を null） */
  function build(model, values, opt) {
    values = values || {}; opt = opt || {};
    const reps = model.lines.map(() => []);
    const blankOf = f => model.lines[f.line].slice(f.start, f.end);
    model.fields.forEach(f => {
      if (f.skip) return;
      const v = values[f.id];
      if (f.kind === "text") {
        const out = fmtValue(f, v);
        if (out) reps[f.line].push({start: f.start, end: f.end, text: (f.append ? f.glue || "" : "") + out + (f.keepTail ? "　" : ""), fid: f.id});
        else reps[f.line].push({start: f.start, end: f.end, text: blankOf(f), empty: true, soft: f.soft, fid: f.id});
        return;
      }
      const opts = optsOf(f), sel = ((v && v.sel) || []).filter(i => i < opts.length);
      if (f.kind === "inline") {
        const fillOther = (o, i) => { const ot = v && v.other && v.other[i]; return ot && String(ot).trim() && OTHER_RE.test(o) ? o.replace(OTHER_RE, a => a[0] + String(ot).trim() + a[a.length - 1]) : o; };   // 「その他（　）」の中（テスター A15）
        const parts = sel.map(i => fillOther(opts[i], i)).concat(f.free && v && v.text && String(v.text).trim() ? [String(v.text).trim()] : []);
        if (!parts.length) { reps[f.line].push({start: f.start, end: f.end, text: blankOf(f), empty: true, soft: f.soft, fid: f.id}); return; }
        reps[f.line].push({start: f.start, end: f.end, text: (f.append ? f.glue || "" : "") + parts.join("・") + (f.keepTail ? "　" : ""), fid: f.id});
        return;
      }
      /* box：選んだ□を■に。足した選択肢は、選んだ時だけ最後の□の行の後ろに「　■○○」 */
      if (!sel.length) { const o = f.options[0]; reps[o.line].push({start: o.pos, end: o.pos + 1, text: o.glyph, empty: true, soft: f.soft, fid: f.id}); return; }
      f.options.forEach((o, i) => {
        const on = sel.includes(i);
        const g = on ? "■" : (o.glyph === "■" || o.glyph === "☑" ? "□" : o.glyph);
        reps[o.line].push({start: o.pos, end: o.pos + 1, text: g, fid: f.id});
        const ot = v.other && v.other[i];
        if (on && o.other && ot && String(ot).trim()) reps[o.line].push({start: o.other.start, end: o.other.end, text: String(ot).trim(), fid: f.id});
      });
      const last = f.options[f.options.length - 1], lend = endOf(model.lines[last.line]);
      const extra = sel.filter(i => i >= f.options.length).map(i => opts[i]).filter(Boolean);
      if (extra.length) reps[last.line].push({start: lend, end: lend, text: extra.map(t => "　■" + t).join(""), fid: f.id});
    });
    return model.lines.map((raw, li) => {
      if (!opt.withList && model.listStart >= 0 && li >= model.listStart && li < model.listEnd) return null;
      const rs = reps[li].sort((a, b) => a.start - b.start || a.end - b.end);
      const parts = []; let p = 0;
      rs.forEach(r => {
        if (r.start < p) return;
        if (r.start > p) parts.push({t: raw.slice(p, r.start)});
        parts.push({t: r.text, empty: !!r.empty, soft: !!r.soft, fid: r.fid});
        p = r.end;
      });
      if (p < raw.length) parts.push({t: raw.slice(p)});
      return parts;
    });
  }
  /* 文にする（持ち物リストを抜いた所は行ごと消す・最後の空行は1つにそろえる） */
  const toText = parts => parts.filter(l => l).map(l => l.map(x => x.t).join("").replace(/[ \t　]+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");

  root.FmtParse = {parse, build, toText, filled, fmtValue, optsOf, typeOf, parseChoices, cleanLabel, OTHER_RE};
})(typeof window !== "undefined" ? window : globalThis);
