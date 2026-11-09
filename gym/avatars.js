/* 筋トレアプリ：トレーナーのアバター（絵は全部この場で描いた自作のSVG。人の写真や、ある作品のキャラは使っていない）
   言うことは、アプリの数字から決まりで作る（AIは使わない）。v = その時の数字（app.js の coachContext）。
   v.day = "A日"、v.ex = 種目、v.last = "50kg×8回"、v.next = "52.5kg"、v.nextText = "52.5kgで8回" など */
(function () {
  const ane = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <rect width="100" height="100" fill="#ffe3ea"/>
  <path d="M66 26 q24 6 17 42 q-5 -15 -17 -22z" fill="#4a2c1d"/>
  <path d="M16 100 q2 -25 34 -27 q32 2 34 27z" fill="#2b3a67"/>
  <path d="M38 74 l12 9 l12 -9" fill="none" stroke="#ff5a7a" stroke-width="3.2" stroke-linejoin="round"/>
  <path d="M50 83 v17" stroke="#c9d3f0" stroke-width="2"/>
  <rect x="44" y="60" width="12" height="15" rx="5" fill="#eebf9f"/>
  <ellipse cx="50" cy="44" rx="20" ry="22" fill="#f8d6bd"/>
  <path d="M29 46 q-3 -28 21 -29 q25 1 21 29 q-3 -11 -10 -15 q-9 9 -27 10 q-3 1 -5 5z" fill="#4a2c1d"/>
  <path d="M31 31 q19 -11 38 0" fill="none" stroke="#ff5a7a" stroke-width="3.6" stroke-linecap="round"/>
  <path d="M37 39.5 l8 2.2" stroke="#3a2418" stroke-width="2.3" stroke-linecap="round"/>
  <path d="M63 39.5 l-8 2.2" stroke="#3a2418" stroke-width="2.3" stroke-linecap="round"/>
  <ellipse cx="42" cy="46.5" rx="2.5" ry="3.1" fill="#2a1a12"/><ellipse cx="58" cy="46.5" rx="2.5" ry="3.1" fill="#2a1a12"/>
  <circle cx="43" cy="45.5" r=".9" fill="#fff"/><circle cx="59" cy="45.5" r=".9" fill="#fff"/>
  <circle cx="37" cy="53" r="3" fill="#ff8fa3" opacity=".45"/><circle cx="63" cy="53" r="3" fill="#ff8fa3" opacity=".45"/>
  <path d="M45 56 q5 2.4 10 -1" stroke="#b5524a" stroke-width="2.2" fill="none" stroke-linecap="round"/>
</svg>`;
  const ani = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <rect width="100" height="100" fill="#dcecff"/>
  <path d="M16 100 q2 -25 34 -27 q32 2 34 27z" fill="#ff8a1f"/>
  <path d="M41 74 q9 7 18 0" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  <rect x="43" y="60" width="14" height="15" rx="5" fill="#d9a07a"/>
  <ellipse cx="50" cy="44" rx="20" ry="22" fill="#e8b38d"/>
  <path d="M29 42 l3 -14 l6 5 l4 -10 l6 7 l5 -9 l5 9 l6 -6 l3 10 l5 -2 l-2 12 q-5 -9 -20 -10 q-14 1 -21 8z" fill="#1f1f24"/>
  <path d="M36 38 l9 -1.5" stroke="#1f1f24" stroke-width="3" stroke-linecap="round"/>
  <path d="M64 38 l-9 -1.5" stroke="#1f1f24" stroke-width="3" stroke-linecap="round"/>
  <ellipse cx="42" cy="45" rx="2.4" ry="2.9" fill="#1f1f24"/><ellipse cx="58" cy="45" rx="2.4" ry="2.9" fill="#1f1f24"/>
  <path d="M41 53 q9 9 18 0 z" fill="#fff" stroke="#8a3b22" stroke-width="2" stroke-linejoin="round"/>
</svg>`;
  const gori = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <rect width="100" height="100" fill="#dff3d6"/>
  <path d="M10 100 q4 -30 40 -31 q36 1 40 31z" fill="#3b3b40"/>
  <circle cx="27" cy="44" r="7" fill="#3b3b40"/><circle cx="73" cy="44" r="7" fill="#3b3b40"/>
  <circle cx="27" cy="44" r="3.5" fill="#8c7b6e"/><circle cx="73" cy="44" r="3.5" fill="#8c7b6e"/>
  <ellipse cx="50" cy="42" rx="23" ry="25" fill="#3b3b40"/>
  <path d="M33 40 q0 -10 17 -10 q17 0 17 10 q4 18 -17 24 q-21 -6 -17 -24z" fill="#a08e80"/>
  <path d="M33 37 q17 -8 34 0" fill="none" stroke="#2a2a2e" stroke-width="5" stroke-linecap="round"/>
  <circle cx="42" cy="42" r="2.6" fill="#1a1a1c"/><circle cx="58" cy="42" r="2.6" fill="#1a1a1c"/>
  <ellipse cx="46" cy="51" rx="2" ry="1.5" fill="#2a2a2e"/><ellipse cx="54" cy="51" rx="2" ry="1.5" fill="#2a2a2e"/>
  <path d="M42 57 q8 6 16 0" fill="none" stroke="#2a2a2e" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;
  const chibi = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <rect width="100" height="100" fill="#fff4c7"/>
  <path d="M30 100 q1 -16 20 -17 q19 1 20 17z" fill="#34c759"/>
  <circle cx="50" cy="50" r="30" fill="#ffe0c4"/>
  <path d="M20 50 q-2 -32 30 -32 q32 0 30 32 q-6 -16 -16 -18 q-4 6 -14 6 q-10 0 -14 -6 q-12 2 -16 18z" fill="#7a4e2d"/>
  <path d="M21 38 q29 -12 58 0" fill="none" stroke="#34c759" stroke-width="5" stroke-linecap="round"/>
  <ellipse cx="39" cy="53" rx="5" ry="6" fill="#3a2a20"/><ellipse cx="61" cy="53" rx="5" ry="6" fill="#3a2a20"/>
  <circle cx="41" cy="51" r="2" fill="#fff"/><circle cx="63" cy="51" r="2" fill="#fff"/>
  <circle cx="31" cy="62" r="4" fill="#ff9db0" opacity=".55"/><circle cx="69" cy="62" r="4" fill="#ff9db0" opacity=".55"/>
  <path d="M45 64 q5 4 10 0" fill="none" stroke="#a8553f" stroke-width="2.2" stroke-linecap="round"/>
</svg>`;

  window.GYM_AVATARS = {
    ane: {name: "みうちゃん", label: "トレーナー みうちゃん", svg: ane, say: {
      wDown:    v => `体重、前より${v.d}kg減ってるやん。その調子や。`,
      setup:    v => "まずは設定で、身長・体重・年齢を入れてな。数字がないと、目標も出せへんで。",
      going:    v => `${v.day}、やりかけやで。続きからいくで。`,
      doneToday:v => `${v.day}、おつかれさん。ようやった。でも、食べるまでがトレーニングやで。`,
      planToday:v => `今日はジムの日やろ？ ${v.day}やで。`,
      gap:      v => `${v.gap}日空いたな。言い訳はええから、今日は行くで。`,
      first:    v => `はじめましてやな。最初は軽めでええ。フォームを覚えるのが先やで。次は${v.day}。`,
      next:     v => `次は${v.day}やで。`,
      up:       v => `前回${v.ex} ${v.last}やったから、${v.next}いってみ。`,
      rep:      v => `${v.ex}は${v.last}やったな。同じ重さで、${v.nextText}めざし。`,
      again:    v => `${v.ex}、前回は届かんかったな。同じ重さで、もう一回や。`,
      down:     v => `${v.ex}は2回続けて届かんかったな。いったん${v.nextText}に落として、形からやり直しや。`,
      againBw:  v => `${v.ex}、前回は${v.last}だけやったな。今日は${v.nextText}やりきるで。`,
      pLeft:    v => `たんぱく質あと${v.p}g、足りてへんで。`,
      pOk:      v => `たんぱく質は足りてる。ええ感じやん。`,
      kOver:    v => `カロリー、目標より${v.k}kcal多いで。明日で取り返そか。`,
      noMeal:   v => `今日の食事、まだ入ってへんで。食べたら入れときや。`,
      backup:   v => `バックアップ、${v.days}日してへんで。設定から書き出しとき。`,
      restEnd:  v => "はい、次のセットいくで。",
      light:    v => `${v.cond}か。ほな今日は軽めにしとくで。セット1つ減らして、重さも1割落としや。`,
      sick:     v => "体調悪い日は休むのも練習のうちや。今日は無理したらあかんで。",
      lightDone:v => "軽めでも、来ただけ えらい。次はいつもどおりいくで。"
    }},
    ani: {name: "お兄さん", label: "ノリのいいお兄さん", svg: ani, say: {
      wDown:    v => `体重、前より${v.d}kgダウン！いい流れ！`,
      setup:    v => "よろしく！まずは設定で、身長・体重・年齢を教えてね！",
      going:    v => `${v.day}の途中だよ！続きからいこう！`,
      doneToday:v => `${v.day}クリア！最高！あとはしっかり食べて回復しよう！`,
      planToday:v => `今日はジムの日！${v.day}、アゲていこう！`,
      gap:      v => `${v.gap}日ぶり！リセットなんて気にしない、今日から再スタート！`,
      first:    v => `はじめまして！最初は軽めでフォーム重視でいこう！次は${v.day}！`,
      next:     v => `次は${v.day}！`,
      up:       v => `前回${v.ex} ${v.last}！今日は${v.next}いっちゃおう！`,
      rep:      v => `${v.ex}は${v.last}だったね。同じ重さで${v.nextText}をめざそう！`,
      again:    v => `${v.ex}、前回はあと少し！同じ重さでリベンジだ！`,
      down:     v => `${v.ex}は一回リセット！${v.nextText}で、きれいに決めよう！`,
      againBw:  v => `${v.ex}、前回は${v.last}！今日は${v.nextText}いこう！`,
      pLeft:    v => `たんぱく質あと${v.p}g！もうひと押し！`,
      pOk:      v => `たんぱく質バッチリ！`,
      kOver:    v => `今日はちょっと食べすぎ（+${v.k}kcal）。明日で調整しよう！`,
      noMeal:   v => `ごはん食べたら、入れておいてね！`,
      backup:   v => `バックアップ、${v.days}日してないよ！設定から書き出しておこう！`,
      restEnd:  v => "休けい終わり！次のセットいこう！",
      light:    v => `${v.cond}なんだね。今日は軽めモード！セット1つ減らして、重さも1割ダウンでいこう！`,
      sick:     v => "体調が悪い日は、休むのも立派なトレーニング！今日はゆっくりしよう！",
      lightDone:v => "軽めでもやりきった！次はいつもどおりいこう！"
    }},
    gori: {name: "ゴリラ", label: "豪快なゴリラ", svg: gori, say: {
      wDown:    v => `体重が${v.d}kg減ったぞ！ウホ！`,
      setup:    v => "ウホ！まずは設定で、身長・体重・年齢を入れるのだ！",
      going:    v => `ウホ！${v.day}の途中だ！続きをやるぞ！`,
      doneToday:v => `ウホホ！${v.day}完了！よく食べて、よく寝るのだ！`,
      planToday:v => `今日はジムの日だ！${v.day}！ウホ！`,
      gap:      v => `${v.gap}日も空いたぞ！ジムへ行くのだ！ウホ！`,
      first:    v => `ウホ！はじめは軽い重さでいい！次は${v.day}だ！`,
      next:     v => `次は${v.day}だ！`,
      up:       v => `前回${v.ex} ${v.last}！今日は${v.next}だ！ウホ！`,
      rep:      v => `${v.ex}は${v.last}だった！同じ重さで${v.nextText}だ！`,
      again:    v => `${v.ex}、前回は届かなかった！同じ重さでもう一度だ！`,
      down:     v => `${v.ex}は少し軽くするのだ！${v.nextText}だ！ウホ！`,
      againBw:  v => `${v.ex}、前回は${v.last}だった！今日は${v.nextText}だ！`,
      pLeft:    v => `たんぱく質、あと${v.p}g！肉だ！卵だ！`,
      pOk:      v => `たんぱく質は十分だ！ウホ！`,
      kOver:    v => `食べすぎだ（+${v.k}kcal）！明日は少しひかえるのだ！`,
      noMeal:   v => `食べた物を入れるのだ！ウホ！`,
      backup:   v => `バックアップを${v.days}日してないぞ！設定から書き出すのだ！`,
      restEnd:  v => "ウホ！次のセットだ！",
      light:    v => `${v.cond}か！今日は軽めだ！セットを1つ減らして、重さも1割落とすのだ！`,
      sick:     v => "体調が悪い日は休むのだ！ゴリラもよく寝るぞ！ウホ。",
      lightDone:v => "ウホ！軽めでもよくやった！次はいつもどおりだ！"
    }},
    chibi: {name: "ちびキャラ", label: "やさしいちびキャラ", svg: chibi, say: {
      wDown:    v => `体重、前より${v.d}kg減ったね。すごいね。`,
      setup:    v => "はじめまして。まずは設定で、身長・体重・年齢を入れてね。",
      going:    v => `${v.day}の途中だよ。続きからやってみよう。`,
      doneToday:v => `${v.day}、おつかれさま。がんばったね。ゆっくり休んでね。`,
      planToday:v => `今日はジムの日だよ。${v.day}、いっしょにがんばろう。`,
      gap:      v => `${v.gap}日ぶりだね。むりせず、できる日に行こうね。`,
      first:    v => `最初は軽めで大丈夫だよ。次は${v.day}。`,
      next:     v => `次は${v.day}だよ。`,
      up:       v => `前回${v.ex} ${v.last}できたから、${v.next}にしてみよう。`,
      rep:      v => `${v.ex}は${v.last}だったね。同じ重さで${v.nextText}をめざそうね。`,
      again:    v => `${v.ex}、前回はおしかったね。同じ重さでもう一回やってみよう。`,
      down:     v => `${v.ex}は、少し軽くして${v.nextText}にしようね。`,
      againBw:  v => `${v.ex}、前回は${v.last}だったね。今日は${v.nextText}めざそうね。`,
      pLeft:    v => `たんぱく質、あと${v.p}gだよ。`,
      pOk:      v => `たんぱく質、とれてるね。えらい。`,
      kOver:    v => `今日はちょっと多めだったね（+${v.k}kcal）。明日でだいじょうぶ。`,
      noMeal:   v => `ごはんを食べたら、入れてね。`,
      backup:   v => `バックアップ、${v.days}日してないよ。設定から書き出してね。`,
      restEnd:  v => "休けいおわり。次のセット、いけるかな？",
      light:    v => `${v.cond}なんだね。今日は軽めにしようね。セットを1つ減らして、重さも少し軽くするよ。`,
      sick:     v => "体調がわるい日は、ゆっくり休んでね。むりしないでね。",
      lightDone:v => "軽めでも、ちゃんとできたね。えらいよ。"
    }}
  };
  window.GYM_AVATAR_ORDER = ["ane", "ani", "gori", "chibi"];

  /* ---- 絵を画像に差し替える時は、ここだけ書く ----
     1. 画像を site\img\ に置く（正方形・512×512 の JPEG、1枚 60KB くらいまで。ホームでは大きく4:3ほどに切って出す〔上寄せ〕、設定では丸）
     2. 下の img に、表情ごとのファイル名を書く。表情（app.js の coachMood）：
          normal＝ふつう、welcome＝あいさつ（はじめて・ジムの日）、check＝確認・注意（設定がまだ・体調で軽め）、
          great＝やり終えた、cheer＝たんぱく質OK・休けい終わり、proud＝体重が前より減った、
          angry＝怒る（3〜6日空いた・13時を過ぎて食事が空・少し食べすぎ）、rage＝激怒（+500kcal以上の食べすぎ・7日以上空いた）
        足りない表情は、近い物 → normal の順で使う（welcome・check→normal／great・cheer・proud→praise→normal／rage→angry→normal）。
        画像が読めない時は、SVG の絵に自動で戻る
     3. sw.js と index.html の版（gym-vN・?v=N）を1つ上げて公開
     みうちゃんの絵：社長が画像生成AI（Gemini）で作った自分用の画像を、秘書が512pxに切り分け、デベロッパーが512pxのJPEG（品質82・1枚40KB前後）にした（2026-11-09）。
     元の画像：AI開発\筋トレアプリ_イメージ\みうちゃん_切り出し\（1_笑顔歓迎〜8_怒り爆発） */
  window.GYM_AVATAR_ORDER.forEach(id => { window.GYM_AVATARS[id].img = null; });
  window.GYM_AVATARS.ane.img = {
    welcome: "img/miu_1.jpg",   /* 笑顔歓迎 */
    cheer:   "img/miu_2.jpg",   /* 励まし喜び */
    normal:  "img/miu_3.jpg",   /* 集中やる気 */
    proud:   "img/miu_4.jpg",   /* 誇り応援 */
    great:   "img/miu_5.jpg",   /* Great Job */
    check:   "img/miu_6.jpg",   /* 疑問確認 */
    angry:   "img/miu_7.jpg",   /* 怒り警告 */
    rage:    "img/miu_8.jpg"    /* 怒り爆発 */
  };
})();
