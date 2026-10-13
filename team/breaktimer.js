/* 架電と休憩のタイマー（社長 2026-10-12「毎時間49分まで架電して、そっから休憩。49分になったら通知。11時と17時は59分まで」）
   ・架電の時間帯は 10:00〜18:00（日報の「10〜18時テレアポ」に合わせた）。日曜は休み
   ・ふつうの時間は 00分〜49分が架電、49分〜次の00分が休憩。11時台・17時台は 59分まで架電（休憩なし）
   ・時刻はこの端末の時計（サーバーは使わない）
   ・画面を閉じている・スマホの画面が消えている間は通知できない。切り替えから10分以内に戻ってきたら、そのとき出す
   Firebase に依存しないふつうのスクリプト（見本 mock/timer.html からも同じものを使うため）。window.BreakTimer に入る */
(function () {
  const H0 = 10, H1 = 18;        // 架電の時間帯
  const FULL = [11, 17];         // 59分まで架電する時間（休憩なし）
  const BREAK_MIN = 49;          // 休憩に入る分
  const LATE_MS = 10 * 6e4;      // 切り替えから何分以内なら、あとから通知を出すか
  const pad = n => String(n).padStart(2, "0");
  const hm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
  const noBreak = h => FULL.includes(h);

  /* 今の状態。phase: "call"（架電中）/ "break"（休憩中）/ "off"（時間外）。until: 次の切り替え。end: 切り替わったあと "break"/"call"/"end" */
  function state(now) {
    const h = now.getHours(), m = now.getMinutes();
    const at = (hh, mm) => { const d = new Date(now); d.setHours(hh, mm, 0, 0); return d; };
    if (now.getDay() === 0 || h < H0 || h >= H1) return {phase: "off", until: null, end: "call"};
    if (!noBreak(h) && m >= BREAK_MIN) return {phase: "break", until: at(h + 1, 0), end: "call"};
    /* 架電中：次の休憩は、この時間の49分。休憩なしの時間なら次の時間の49分（18時になるなら終了） */
    let bh = h;
    while (bh < H1 && noBreak(bh)) bh++;
    if (bh >= H1) return {phase: "call", until: at(H1, 0), end: "end", noBreak: noBreak(h)};
    return {phase: "call", until: at(bh, BREAK_MIN), end: "break", noBreak: noBreak(h)};
  }
  const minsLeft = (now, until) => Math.max(1, Math.ceil((until - now) / 6e4));

  /* 小さな表示（カウント画面）。時間外は出さない */
  function render(el, now) {
    const s = state(now);
    el.hidden = s.phase === "off";
    el.classList.toggle("bkt-break", s.phase === "break");
    if (s.phase === "off") return s;
    const left = minsLeft(now, s.until);
    if (s.phase === "break") {
      el.innerHTML = `<span class="bkt-ic">☕</span><b>休憩中</b><span class="bkt-left num">あと ${left}分</span><small>${hm(s.until)} に架電再開</small>`;
    } else {
      el.innerHTML = `<span class="bkt-ic">☎</span><b>架電中</b><span class="bkt-left num">あと ${left}分</span>` +
        `<small>${s.end === "end" ? hm(s.until) + " で今日のテレアポ終了" : hm(s.until) + " から休憩"}${s.noBreak ? "・" + now.getHours() + "時台は休憩なし" : ""}</small>`;
    }
    return s;
  }

  /* 大きな通知（画面の上）。kind: "break"（休憩の時間です）/ "call"（架電再開） */
  let hideT = 0;
  function showBar(bar, kind, now) {
    const s = state(now);
    bar.className = "brkbar " + kind;
    const until = s.until ? hm(s.until) : "";
    bar.querySelector(".bb-ic").textContent = kind === "break" ? "☕" : "☎";
    bar.querySelector(".bb-ttl").textContent = kind === "break" ? "休憩の時間です" : "架電再開です";
    bar.querySelector(".bb-sub").textContent = kind === "break" ? (until ? "〜" + until + " まで休憩（" + minsLeft(now, s.until) + "分）" : "")
      : (s.end === "end" ? until + " まで架電（今日はここまで）" : until ? until + " まで架電" : "");
    bar.hidden = false;
    clearTimeout(hideT); hideT = setTimeout(() => { bar.hidden = true; }, 90 * 1000);   // 90秒で自分で消える
  }

  /* 動かす。opts: {timer: 小さな表示の要素, bar: 通知の要素, now: () => Date, notify: (kind) => 音・ふるえ} */
  function mount(opts) {
    const now = opts.now || (() => new Date());
    let last = null;    // 前の tick の状態
    const tick = () => {
      const t = now();
      const s = render(opts.timer, t);
      const switched = !!(last && last.phase !== s.phase && last.until && (s.phase === "break" || s.phase === "call") && last.phase !== "off");
      /* 切り替わったのに画面が見えていない（PCで別のタブを見ている・スマホの画面が消えている）：
         まだ「済んだ」と覚えず、見えるようになったとき（visibilitychange → tick）に10分以内なら出す（テスター 2026-10-13） */
      if (switched && document.visibilityState !== "visible") return;
      if (switched && t - last.until < LATE_MS) {
        showBar(opts.bar, s.phase, t);
        if (opts.notify) opts.notify(s.phase);
      }
      last = s;   // 毎回入れ替える（見えていない間に切り替えを飛ばしても、until が古いままにならないように）
    };
    tick();
    const iv = setInterval(tick, 5000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick(); });
    const close = opts.bar.querySelector(".bb-x");
    if (close) close.onclick = () => { opts.bar.hidden = true; };
    return {stop: () => clearInterval(iv), tick};
  }

  window.BreakTimer = {state, render, showBar, mount, H0, H1, FULL, BREAK_MIN};
})();
