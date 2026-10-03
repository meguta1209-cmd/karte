// Firebase の接続先（kekka-counter-2026）。
// これは「どのプロジェクトにつなぐか」の住所で、パスワードではない。
// 守りは firestore.rules（誰が読み書きできるか）で行う。
export const firebaseConfig = {
  apiKey: "AIzaSyCb2b1fEs8hbJYyY7T1VvV5OSA80wtTAV8",
  authDomain: "kekka-counter-2026.firebaseapp.com",
  projectId: "kekka-counter-2026",
  storageBucket: "kekka-counter-2026.firebasestorage.app",
  messagingSenderId: "356518254585",
  appId: "1:356518254585:web:28789f8cb9111b6be58f28"
};

// 会社ごとの設定（2026-10-03 他社版を作るときに足した）。自社＝株式会社ARIA
//  ls：この端末に覚えておく物の名前の頭（自社は空＝前と同じ）
//  preLabel：KPIに数えない「アプリを使う前に取った案件」の呼び方
//  move：前のカウンターからの引っ越しを出すか／line：LINE日報の欄（管理者だけ）を出すか
export const TENANT = { id: "aria", ls: "", preLabel: "10月より前", move: true, line: true };
