/* 架電と休憩のタイマー（社長 2026-10-12「毎時間49分まで架電して、そっから休憩。49分になったら通知。11時と17時は59分まで」
   2026-10-13「12時〜13時は昼休憩やから出さなくてOK」「休憩開始は49分で、休憩終了は59分の10分間」
   2026-10-13「稼働終了のタイミングと、昼休憩明けのタイミングでなんかメッセージ出してや」）
   ・架電の時間帯は 10:00〜18:00（日報の「10〜18時テレアポ」に合わせた）。日曜は休み
   ・ふつうの時間は 49分〜59分の10分だけ休憩（59分に架電再開）。11時台・17時台は 59分まで架電（休憩なし）
   ・12時台は昼休憩：タイマーも帯も出さない。13:00 に「昼休憩明けです！」、18:00 に「おつかれさまでした！」の帯
   ・時刻はこの端末の時計（サーバーは使わない）
   ・画面を閉じている・スマホの画面が消えている・PCで別のタブを見ている間は通知できない。
     その間の最後の切り替えを覚えておき、10分以内に戻ってきたらそのとき出す
   Firebase に依存しないふつうのスクリプト（見本 mock/timer.html からも同じものを使うため）。window.BreakTimer に入る */
(function () {
  const H0 = 10, H1 = 18;        // 架電の時間帯
  const FULL = [11, 17];         // 59分まで架電する時間（休憩なし）
  const LUNCH = [12];            // 昼休憩の時間（何も出さない）
  const BREAK_MIN = 49;          // 休憩に入る分
  const RESUME_MIN = 59;         // 架電を再開する分（49〜59 の10分が休憩）
  const LATE_MS = 10 * 6e4;      // 切り替えから何分以内なら、あとから通知を出すか
  const pad = n => String(n).padStart(2, "0");
  const hm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
  const noBreak = h => FULL.includes(h);

  /* 今の状態。phase: "call"（架電中）/ "break"（休憩中）/ "off"（時間外・昼休憩）。until: 次の切り替え。
     end: 切り替わったあと "break"/"call"/"lunch"/"end"。lunch: 昼休憩（13:00 の帯のため）。finished: 18:00 以降（稼働終了の帯のため。日曜は付かない） */
  function state(now) {
    const h = now.getHours(), m = now.getMinutes();
    const at = (hh, mm) => { const d = new Date(now); d.setHours(hh, mm, 0, 0); return d; };
    if (now.getDay() === 0 || h < H0) return {phase: "off", until: null, end: "call"};
    if (h >= H1) return {phase: "off", until: null, end: "call", finished: true};
    if (LUNCH.includes(h)) return {phase: "off", until: at(h + 1, 0), end: "call", lunch: true};
    if (!noBreak(h) && m >= BREAK_MIN && m < RESUME_MIN) return {phase: "break", until: at(h, RESUME_MIN), end: "call"};
    /* 架電中：次の休憩は、この時間の49分（もう過ぎていれば次の時間）。休憩なしの時間は次の時間へ（昼休憩・18時になるならそこで区切り） */
    for (let x = m >= BREAK_MIN ? h + 1 : h; ; x++) {
      if (x >= H1) return {phase: "call", until: at(H1, 0), end: "end", noBreak: noBreak(h)};
      if (LUNCH.includes(x)) return {phase: "call", until: at(x, 0), end: "lunch", noBreak: noBreak(h)};
      if (!noBreak(x)) return {phase: "call", until: at(x, BREAK_MIN), end: "break", noBreak: noBreak(h)};
    }
  }
  const minsLeft = (now, until) => Math.max(1, Math.ceil((until - now) / 6e4));

  /* 小さな表示（カウント画面）。時間外・昼休憩は出さない */
  function render(el, now) {
    const s = state(now);
    el.hidden = s.phase === "off";
    el.classList.toggle("bkt-break", s.phase === "break");
    if (s.phase === "off") return s;
    const left = minsLeft(now, s.until);
    if (s.phase === "break") {
      el.innerHTML = `<span class="bkt-ic">☕</span><b>休憩中</b><span class="bkt-left num">あと ${left}分</span><small>${hm(s.until)} に架電再開</small>`;
    } else {
      const to = s.end === "end" ? hm(s.until) + " で今日のテレアポ終了" : s.end === "lunch" ? hm(s.until) + " から昼休憩" : hm(s.until) + " から休憩";
      el.innerHTML = `<span class="bkt-ic">☎</span><b>架電中</b><span class="bkt-left num">あと ${left}分</span>` +
        `<small>${to}${s.noBreak ? "・" + now.getHours() + "時台は休憩なし" : ""}</small>`;
    }
    return s;
  }

  /* 大きな通知（画面の上）。kind: "break"（休憩の時間です）/ "call"（架電再開）/ "lunch"（昼休憩明け）/ "end"（稼働終了） */
  const BAR = {
    break: {ic: "☕", ttl: "休憩の時間です"},
    call:  {ic: "☎", ttl: "架電再開です"},
    lunch: {ic: "🍱", ttl: "昼休憩明けです！午後もいきましょう"},
    end:   {ic: "🎉", ttl: "おつかれさまでした！本日の稼働終了です"}
  };
  let hideT = 0;
  function showBar(bar, kind, now) {
    const s = state(now), b = BAR[kind] || BAR.call;
    bar.className = "brkbar " + kind;
    const until = s.until ? hm(s.until) : "";
    bar.querySelector(".bb-ic").textContent = b.ic;
    bar.querySelector(".bb-ttl").textContent = b.ttl;
    bar.querySelector(".bb-sub").textContent = kind === "break" ? (until ? "〜" + until + " まで休憩（" + minsLeft(now, s.until) + "分）" : "")
      : kind === "end" ? "今日もありがとうございました。また明日！"
      : (s.end === "end" ? until + " まで架電（今日はここまで）" : until ? until + " まで架電" : "");
    bar.hidden = false;
    clearTimeout(hideT); hideT = setTimeout(() => { bar.hidden = true; }, 90 * 1000);   // 90秒で自分で消える
  }

  /* 動かす。opts: {timer: 小さな表示の要素, bar: 通知の要素, now: () => Date, notify: (kind) => 音・ふるえ} */
  function mount(opts) {
    const now = opts.now || (() => new Date());
    let last = null;    // 前の tick の状態
    let pend = null;    // まだ出していない切り替え {at: 切り替わった時刻, kind}。隠れている間に2回切り替わっても最後の1つを覚える
    const tick = () => {
      const t = now();
      const s = render(opts.timer, t);
      if (last && last.phase !== s.phase) {
        /* 出すのは 架電→休憩(break)・休憩→架電(call)・昼休憩→架電(lunch)・架電→18:00(end)。昼休憩に入るときは出さない */
        const kind = s.phase === "break" && last.phase !== "off" ? "break"
          : s.phase === "call" && last.lunch ? "lunch"
          : s.phase === "call" && last.phase !== "off" ? "call"
          : s.phase === "off" && s.finished && last.phase === "call" ? "end" : null;
        pend = kind ? {at: last.until || t, kind} : null;
      }
      last = s;
      /* 見えているときだけ出す。切り替えから10分を過ぎていたら出さずに忘れる */
      if (pend && document.visibilityState === "visible") {
        if (t - pend.at < LATE_MS) { showBar(opts.bar, pend.kind, t); if (opts.notify) opts.notify(pend.kind); }
        pend = null;
      }
    };
    tick();
    const iv = setInterval(tick, 5000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick(); });
    const close = opts.bar.querySelector(".bb-x");
    if (close) close.onclick = () => { opts.bar.hidden = true; };
    return {stop: () => clearInterval(iv), tick};
  }

  window.BreakTimer = {state, render, showBar, mount, H0, H1, FULL, LUNCH, BREAK_MIN, RESUME_MIN};
})();
