"use strict";
/* ===== 多言語化(日本語⇄英語) =====
   ・EXACT: 完全一致(トリム後)の置換。DOMテキスト/placeholder/title/alert/confirm に適用。
   ・PH: 「静的な前置き＋動的な値」の連結文言を、前置きだけ英訳(値は保持)。
   ・辞書に無い文字列は日本語のまま(安全)。ユーザー入力値は基本そのまま。
   ・動的生成分は MutationObserver で追従。alert/confirm/prompt はラップして翻訳。 */
(function () {
  const EXACT = {
    // ===== 下部タブ / ナビ =====
    "スキャン": "Scan", "履歴": "History", "DB編集": "DB", "設定": "Settings",
    "← 車両": "← Vehicle", "🔧 メンテ": "🔧 Maint", "🩺 診断": "🩺 Diagnose", "🛠 修理": "🛠 Repair", "📋 カルテ": "📋 Records",
    // ===== スキャン画面 =====
    "QRを枠内いっぱいに写してください": "Fill the frame with the QR code",
    "🔄 カメラ切替": "🔄 Switch camera", "ズーム": "Zoom",
    "📷 カメラでスキャン": "📷 Scan with camera", "QRを写すだけ・シャッター不要": "Just aim at the QR — no shutter needed",
    "✓ 終了して表示": "✓ Finish & show", "最初からやり直す": "Start over",
    "車両検索": "Vehicle search", "型式を直接入力": "Enter model manually",
    "登録ナンバー / 使用者名 / 車種名で検索": "Search by plate / owner / model name",
    "🔍 券面を撮影して読み取り（OCR）": "🔍 Capture document (OCR)",
    "車両情報を直接入力": "Enter vehicle info manually",
    "型式（必須でなくてもOK）": "Model code (optional)",
    "原動機型式": "Engine model", "車台番号": "Chassis (VIN)",
    "登録番号（ナンバー）": "Registration plate", "登録番号": "Registration plate",
    "使用者名（任意）": "User name (optional)", "使用者名": "User name",
    "この内容で表示": "Show this", "使用者": "User", "指定・類別": "Designation / class",
    "指定-類別": "Designation-class", "指定-類別（数字）": "Designation-class (digits)",
    "✎ 車両データを修正": "✎ Edit vehicle data", "💾 保存（DBに登録）": "💾 Save (to DB)",
    "車両データを修正": "Edit vehicle data", "型式": "Model",
    "初度登録": "First registration", "有効期限": "Expiry",
    "保存": "Save", "取消": "Cancel", "キャンセル": "Cancel", "閉じる": "Close", "戻る": "Back", "実行": "Submit", "クリア": "Clear", "削除": "Delete",
    "QRの生データから選んで割り当てる": "Assign from raw QR data",
    "この車両で何をしますか？": "What would you like to do with this vehicle?",
    "🔧 メンテナンスデータを見る": "🔧 View maintenance data",
    "オイル量・トルク・定番故障・リコール": "Oil capacity, torque, common faults, recalls",
    "🩺 故障診断をする": "🩺 Run diagnosis", "ダイアグコード・問診から原因究明": "Find causes from DTCs & symptoms",
    "🛠 修理（部品・注文リスト）": "🛠 Repair (parts & order list)",
    "必要部品の洗い出し・取付位置・注文リスト作成": "List parts, locations & order sheet",
    "📋 整備カルテ（作業記録）": "📋 Service record", "作業内容を記録・社内で共有／写真で入力も": "Log work & share; photo input too",
    "QRから読み取った全フィールド": "All fields read from QR",
    "自動判定が間違っている場合は、正しい値のチップをタップ →「型式」or「車台番号」に割り当てできます。":
      "If auto-detection is wrong, tap the correct chip and assign it to “Model” or “Chassis”.",
    "※ データはこの端末に保存。クラウド同期にログイン中は社内で共有されます。":
      "※ Data is stored on this device. When signed in to cloud sync, it is shared within your company.",
    "画像を解析中…": "Analyzing image…",
    "QRを検出できませんでした。1つのQRが<b>画面いっぱい</b>になるまで近づけて撮影してください。":
      "No QR detected. Move closer until a single QR fills the screen.",
    "QRの生データがありません(QRを読み取ってからお試しください)。": "No raw QR data yet (scan a QR first).",
    "🔧 メカ君がQRデータを項目分け中…": "🔧 Mecha is sorting the QR data…",
    // ===== メンテ =====
    "メンテナンス諸元（参考値）": "Maintenance specs (reference)",
    "メカ君に聞く": "Ask Mecha", "🔄 最新に更新": "🔄 Refresh", "＋ 項目を追加": "＋ Add item",
    "保存（次回からAI不要）": "Save (skip AI next time)",
    "※ 参考値です。年式・型式で異なるため整備書で確認を。訂正保存するとこの車両に記憶され次回も表示します。":
      "※ Reference values. They vary by year/model — verify with the service manual. Edited values are remembered for this vehicle.",
    "この型式の定番故障・持病": "Common faults for this model",
    "メモ・自社ノウハウ": "Notes / in-house know-how",
    "リコール・改善対策の確認": "Recall / improvement check",
    "※ AIの参考情報です。下記の公式ページで車台番号により対象を確認してください。":
      "※ AI reference. Verify affected units by chassis number on the official pages below.",
    "タップで編集": "Tap to edit", "項目名": "Item name", "値・内容": "Value / details",
    "項目名(例: エンジンオイル量)": "Item name (e.g. Engine oil capacity)", "項目": "Item", "値": "Value",
    "型式・車台番号をコピーして、下のリコール検索サイトに貼り付けて確認できます。":
      "Copy the model/chassis number and paste it into the recall search sites below.",
    // ===== 修理 =====
    "修理について質問": "Ask about repairs",
    "📗 FAINESで正式な整備手順・品番・トルクを確認": "📗 Check official procedures, part numbers & torque on FAINES",
    "※ 回答・部品番号はAIの参考情報です。注文・作業前にFAINESや部品商で正式値を確認してください。":
      "※ Answers and part numbers are AI references. Verify with FAINES or a parts dealer before ordering/working.",
    "🔍 実物の位置をWeb画像で探す": "🔍 Find the real location in web images",
    "▶ YouTubeで交換動画を探す": "▶ Search replacement videos on YouTube",
    "取り付け位置": "Location", "所要時間の目安": "Estimated time", "部品注文リスト": "Parts order list",
    "※同時交換推奨": "※ Recommended to replace together", "コピー": "Copy", "✓ コピー": "✓ Copied", "✓ コピーしました": "✓ Copied",
    "共有・メール": "Share / Email", "参考図": "Reference", "締付トルク": "Tightening torque", "特殊工具・整備モード": "Special tools / service mode",
    "交換手順": "Procedure", "使用工具": "Tools",
    // ===== カルテ =====
    "整備カルテ（作業記録）": "Service records", "＋ 記録を追加": "＋ Add record", "📷 写真で入力": "📷 Photo input",
    "日付": "Date", "走行距離(km)": "Odometer (km)", "作業内容": "Work performed",
    "交換部品・使用材料": "Parts / materials", "費用(円)": "Cost (JPY)", "担当者": "Staff", "メモ": "Notes",
    "作業": "Work", "部品": "Parts", "費用": "Cost",
    "まだ記録がありません。「＋ 記録を追加」から作業内容を残せます。": "No records yet. Use “＋ Add record” to log your work.",
    "車両を読み込むと、その車の作業記録を残せます。まず車検証をスキャンするか、履歴/検索から車両を開いてください。":
      "Load a vehicle to keep its service records. Scan the inspection certificate, or open a vehicle from History/Search.",
    "🔧 メカ君が写真を読み取っています…(数十秒かかる場合があります)": "🔧 Mecha is reading the photo… (may take tens of seconds)",
    "✓ 読み取りました。内容を確認・修正して保存してください。": "✓ Read. Please review, edit and save.",
    // ===== 診断 =====
    "ダイアグコード/故障診断": "DTC / Fault diagnosis",
    "メカ君と音声会話": "Voice chat with Mecha", "🎤 押して話す": "🎤 Push to talk", "🔇 読み上げ停止": "🔇 Stop speaking", "終了": "End",
    "「押して話す」を押し、症状を話してください。メカ君が音声で答えます。":
      "Press “Push to talk” and describe the symptom. Mecha will answer by voice.",
    "※ 原因候補は参考情報です。最終判断は実測・実点検で。":
      "※ Possible causes are references. Make the final call with actual measurement/inspection.",
    "考えられる原因:": "Possible causes:", "確認手順:": "Check procedure:", "切り分け・確認:": "Isolation / check:",
    "切り分け ": "Isolate ", "⚠ 問診内容と一致する持病:": "⚠ Known issues matching the symptoms:",
    "直接一致なし。参考: この車種の定番故障:": "No direct match. FYI, common faults for this model:",
    "🔧 メカ君が考えています…(数秒〜十数秒)": "🔧 Mecha is thinking… (a few to a dozen seconds)",
    "🔧 メカ君が考えています…": "🔧 Mecha is thinking…", "🔧 メカ君が追加で考えています…": "🔧 Mecha is thinking more…",
    "無料のGemini APIキーを設定すると、ここにAIの診断見解も表示されます(クレジットカード不要)。":
      "Set a free Gemini API key to also see Mecha’s diagnosis here (no credit card needed).",
    "⚙ 設定画面でキーを取得・保存する": "⚙ Get & save a key in Settings",
    "解決しない・追加で相談したい場合 — 実施内容や追加の症状を書く／写真・動画を添付して、メカ君にもう一度相談できます。":
      "Not solved / need more help — write what you tried or new symptoms, attach photos/videos, and ask Mecha again.",
    "例: EGRを清掃したが まだ白煙が出る。圧縮圧は正常。— 写真や動画も添付できます。":
      "e.g. Cleaned the EGR but white smoke remains. Compression is normal. — photos/videos can be attached.",
    "メカ君が写真・動画を解析しています…(数十秒かかる場合があります)": "Mecha is analyzing the photos/videos… (may take tens of seconds)",
    "✓ 解析が完了しました。下に結果を表示しています。": "✓ Analysis complete. Results are shown below.",
    "🔧 メカ君が諸元・定番故障を調べています…(数秒〜十数秒)": "🔧 Mecha is looking up specs & common faults… (a few to a dozen seconds)",
    "読み上げを止めました。「押して話す」で続けられます。": "Speech stopped. Press “Push to talk” to continue.",
    "聞き取れませんでした。もう一度「押して話す」を。": "Didn’t catch that. Press “Push to talk” again.",
    "「押して話す」でさらに質問できます。読み上げ中は🔇停止や「押して話す」で止められます。":
      "Press “Push to talk” to ask more. While speaking, use 🔇 or “Push to talk” to stop.",
    "🎤 聞いています…話し終わったら、もう一度ボタンを押してください。": "🎤 Listening… press the button again when you finish.",
    "■ 話し終えたらタップ": "■ Tap when finished",
    // ===== 履歴 / DB =====
    "スキャン履歴": "Scan history",
    "履歴には型式・車台番号・日時のみ保存されます（この端末内のみ）。":
      "History stores only model, chassis number and date/time (on this device only).",
    "＋ 車種を追加": "＋ Add model", "⬇ JSONエクスポート": "⬇ Export JSON", "⬆ JSONインポート": "⬆ Import JSON",
    "車種を追加": "Add model", "登録車種一覧": "Registered models",
    "📷 撮影してOCR読み取り": "📷 Capture & OCR", "→ 諸元に追記": "→ Add to specs", "→ 持病に追記": "→ Add to faults", "→ メモに追記": "→ Add to notes",
    "Tesseract OCR で解析中…(初回は少し時間がかかります)": "Analyzing with Tesseract OCR… (first run takes a moment)",
    "文字を読み取れませんでした。明るい場所で、文字部分が大きく写るように撮影してください。":
      "Couldn’t read any text. Shoot in bright light with the text large in the frame.",
    // ===== 設定 / クラウド =====
    "クラウド同期（社内共有）": "Cloud sync (company share)",
    "ログイン": "Log in", "管理者として会社を新規登録": "Register a company (as admin)", "従業員として会社に参加": "Join a company (as staff)",
    "氏名": "Name", "メールアドレス": "Email", "パスワード": "Password",
    "事業所ID（会社の識別名・半角英数）": "Company ID (alphanumeric)",
    "パスワードを忘れた方（再設定メール）": "Forgot password (reset email)",
    "👥 メンバー管理": "👥 Manage members", "ログアウト": "Log out",
    "このアプリを紹介（QRコード）": "Share this app (QR code)",
    "メカ君に相談機能（無料・任意）": "Ask-Mecha feature (free / optional)",
    "回答の品質モード": "Answer quality mode", "標準（速い）": "Standard (fast)", "高精度（精度重視）": "High accuracy",
    "OCRについて": "About OCR", "データ管理": "Data management",
    "APIキーを取得する ↗": "Get an API key ↗", "APIキーをここに貼る": "Paste your API key here",
    "運営管理（会社・メンバー）": "Operations (companies / members)",
    "メールとパスワードを入力してください。": "Enter your email and password.",
    "ログイン中…": "Signing in…", "登録中…": "Registering…", "読み込み中…": "Loading…", "利用状況を取得中…": "Loading usage…",
    "氏名を入力してください。": "Enter your name.",
    "メールと6文字以上のパスワードを入力してください。": "Enter an email and a password of 6+ characters.",
    "事業所IDを入力してください(半角英数)。": "Enter a company ID (alphanumeric).",
    "⚠ この事業所IDは既に登録されています。従業員として参加してください。": "⚠ This company ID already exists. Please join as staff.",
    "✓ 会社を登録しました。運営の承認後に有効化されます。": "✓ Company registered. It will be activated after operator approval.",
    "✓ 参加申請しました。会社の代表管理者の承認をお待ちください。": "✓ Join request sent. Please wait for your company admin’s approval.",
    "会社を登録": "Register company", "参加を申請": "Request to join",
    "管理者として会社を新規登録（1社1名）": "Register a company (as admin, one per company)",
    "従業員として会社に参加（承認待ちになります）": "Join a company as staff (pending approval)",
    "このメールは登録済みです。ログインしてください。": "This email is already registered. Please log in.",
    "メールまたはパスワードが違います。": "Wrong email or password.",
    "アカウントが見つかりません。新規登録してください。": "Account not found. Please register.",
    "パスワードは6文字以上にしてください。": "Password must be at least 6 characters.",
    "ネットワークに接続できません。": "Cannot connect to the network.",
    "エラーが発生しました。": "An error occurred.",
    "⚠ このアカウントは運営管理者ではありません。": "⚠ This account is not an operator.",
    "運営管理者": "Operator", "代表管理者": "Company admin", "従業員": "Staff",
    "メンバーがいません。": "No members.", "メンバーなし": "No members", "未ログイン": "Never logged in",
    "🔄 最新に更新 ": "🔄 Refresh ", "🛡️ 運営管理者ログイン": "🛡️ Operator login",
    "承認": "Approve", "却下": "Reject", "停止": "Suspend", "無効化": "Deactivate", "代表者に": "Make admin", "従業員に": "Make staff",
    "会社の承認/停止、各社の利用状況、全メンバーの管理ができます（運営管理者のみ）。":
      "Approve/suspend companies, view usage, and manage all members (operators only).",
    "下のQRを読み取るとこのアプリが開きます。整備士仲間・他事業所への紹介にどうぞ。":
      "Scan the QR below to open this app. Share it with fellow mechanics and other shops.",
    "Gemini APIキー（<b>無料・カード登録不要</b>）を設定すると「メカ君に相談」が使えます。下のボタンで取得して貼るだけ。":
      "Set a Gemini API key (<b>free, no card needed</b>) to use “Ask Mecha”. Just get one with the button below and paste it.",
    "高精度モードは複雑な複合症状向け。無料枠の上限時は自動で標準に切替。":
      "High-accuracy mode is for complex, combined symptoms. Falls back to Standard automatically when the free quota is reached.",
  };

  // 「前置き(静的) + 値(動的)」— 前置きだけ英訳。^ 固定でユーザー入力への誤爆を防ぐ。
  const PH = [
    [/^画像を解析中…$/, "Analyzing image…"],
    [/^読み取りエラー: (.*)$/, "Read error: $1"],
    [/^OCRエラー: (.*)$/, "OCR error: $1"],
    [/^文字認識中… (.*)$/, "Recognizing text… $1"],
    [/^高精度OCR（Cloud Vision）で解析中…$/, "Analyzing with high-accuracy OCR (Cloud Vision)…"],
    [/^Cloud Vision失敗→無料OCRに切替（(.*)）…$/, "Cloud Vision failed → switching to free OCR ($1)…"],
    [/^⚙ 車種DB一致: (.*)$/, "⚙ Model DB match: $1"],
    [/^📖 点検手引書: (.*)$/, "📖 Inspection guide: $1"],
    [/^手順(\d+)へ$/, "Go to step $1"],
    [/^✓ DBの登録車種に(追加|更新保存)しました（「(.*)」）。DB編集タブで確認できます。$/,
      (m, a, n) => "✓ " + (a === "追加" ? "Added to" : "Updated in") + " the model DB (“" + n + "”). Check it in the DB tab."],
    [/^動画が大きい\((\d+)MB\)ので自動圧縮しています…$/, "Video is large ($1MB); compressing automatically…"],
    [/^✓ 圧縮しました\((\d+)MB\)。$/, "✓ Compressed ($1MB)."],
    [/^⚠ 自動圧縮できませんでした。短い動画で撮り直すか、低画質で撮影してください。$/, "⚠ Auto-compression failed. Re-shoot a shorter or lower-quality video."],
    [/^⚠ 圧縮しても大きすぎます\((\d+)MB\)。10秒程度に短く撮り直してください。$/, "⚠ Still too large after compression ($1MB). Re-shoot ~10 seconds."],
    [/^動画を圧縮中… (\d+)%（動画の長さ分かかります）$/, "Compressing video… $1% (takes about the clip length)"],
    [/^⚠ 添付の合計サイズが大きすぎます\((\d+)MB\)。動画は1本・10秒程度に、写真は枚数を減らしてください。$/,
      "⚠ Attachments are too large ($1MB). Use one ~10s video and fewer photos."],
    [/^あなた: (.*)$/, "You: $1"],
    [/^✓ (.*@.*) に再設定メールを送りました。受信箱をご確認ください。$/, "✓ Sent a reset email to $1. Please check your inbox."],
    [/^会社: (.*)$/, "Company: $1"],
    [/^✓ 同期中 — (.*)$/, "✓ Syncing — $1"],
    [/^⏳ (.*)$/, "⏳ $1"],
    [/^👥 メンバー (\d+)人 ／ 🚗 車種DB (\d+)件 ／ 📋 車両 (\d+)台$/, "👥 $1 members / 🚗 $2 models / 📋 $3 vehicles"],
    [/^⬆ 送信: 車種DB (\d+)件 \/ 車両 (\d+)台$/, "⬆ Sent: $1 models / $2 vehicles"],
    [/^✓ 同期OK: 車種DB (\d+)件（クラウド）$/, "✓ Synced: $1 models (cloud)"],
    [/^同期を開始しています…$/, "Starting sync…"],
    [/^最終ログイン (.*)$/, "Last login $1"],
    [/^登録 (.*)$/, "Registered $1"],
    [/^役割: (.*)$/, "Role: $1"],
  ];

  const has = k => Object.prototype.hasOwnProperty.call(EXACT, k);
  function translate(s) {
    if (s == null) return s;
    const key = String(s).trim();
    if (has(key)) return String(s).replace(key, EXACT[key]);
    for (const [re, rep] of PH) { if (re.test(key)) return String(s).replace(key, key.replace(re, rep)); }
    return s;
  }

  const ORIG = "__i18n_orig";
  let lang = localStorage.getItem("ss_lang") || null;
  window.APP_LANG = lang || "ja";

  function trTextNode(node, toEn) {
    const cur = node.nodeValue;
    if (toEn) {
      const base = node[ORIG] != null ? node[ORIG] : cur;
      const out = translate(base);
      if (out !== cur) { if (node[ORIG] == null) node[ORIG] = cur; node.nodeValue = out; }  // 現在値と差がある時だけ更新(ループ防止)
    } else if (node[ORIG] != null && node[ORIG] !== cur) { node.nodeValue = node[ORIG]; delete node[ORIG]; }
  }
  function trAttr(el, attr, toEn) {
    const k = "__i18n_" + attr;
    if (toEn) {
      const base = el[k] != null ? el[k] : el.getAttribute(attr);
      const out = translate(base);
      if (out !== base) { if (el[k] == null) el[k] = el.getAttribute(attr); el.setAttribute(attr, out); }
    } else if (el[k] != null) { el.setAttribute(attr, el[k]); delete el[k]; }
  }
  function walk(root, toEn) {
    if (root.nodeType === 3) { trTextNode(root, toEn); return; }
    if (root.nodeType !== 1) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const texts = []; let n; while ((n = tw.nextNode())) texts.push(n);
    texts.forEach(t => trTextNode(t, toEn));
    const els = [root, ...root.querySelectorAll("[placeholder],[title]")];
    els.forEach(el => { if (el.hasAttribute && (el.hasAttribute("placeholder") || el.hasAttribute("title"))) { trAttr(el, "placeholder", toEn); trAttr(el, "title", toEn); } });
  }

  function applyLang(l) {
    lang = l; window.APP_LANG = l;
    localStorage.setItem("ss_lang", l);
    document.documentElement.lang = l;
    walk(document.body, l === "en");
    updateToggle();
  }
  window.applyLang = applyLang;

  // childListのみ監視。textContent= は要素の子テキストノードを差し替える=childListで拾える。
  // characterDataは監視しない(自分の書き換えが再通知され無限ループになるため)。
  let applying = false;
  const mo = new MutationObserver(muts => {
    if (window.APP_LANG !== "en" || applying) return;
    applying = true;
    try { for (const m of muts) m.addedNodes.forEach(nd => { if (nd.nodeType === 3) trTextNode(nd, true); else if (nd.nodeType === 1) walk(nd, true); }); }
    finally { applying = false; }
  });

  // ===== alert / confirm / prompt を翻訳 =====
  const _alert = window.alert.bind(window), _confirm = window.confirm.bind(window), _prompt = window.prompt.bind(window);
  window.alert = msg => _alert(window.APP_LANG === "en" ? translate(msg) : msg);
  window.confirm = msg => _confirm(window.APP_LANG === "en" ? translate(msg) : msg);
  window.prompt = (msg, def) => _prompt(window.APP_LANG === "en" ? translate(msg) : msg, def);

  // ===== 言語トグル(右上・小さく目立たない) =====
  let toggleEl;
  function updateToggle() { if (toggleEl) toggleEl.textContent = (window.APP_LANG === "en") ? "日本語" : "EN"; }
  function makeToggle() {
    toggleEl = document.createElement("button");
    toggleEl.id = "langToggle"; toggleEl.type = "button"; toggleEl.title = "Language / 言語";
    toggleEl.addEventListener("click", () => applyLang(window.APP_LANG === "en" ? "ja" : "en"));
    document.body.appendChild(toggleEl); updateToggle();
  }
  // ===== 起動時の言語選択(小さなバー) =====
  function askLanguage() {
    const bar = document.createElement("div");
    bar.id = "langPick";
    bar.innerHTML = '<span>Language / 言語</span><button type="button" data-l="ja">日本語</button><button type="button" data-l="en">English</button>';
    bar.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; applyLang(b.dataset.l); bar.remove(); });
    document.body.appendChild(bar);
  }

  function init() {
    mo.observe(document.body, { childList: true, subtree: true });
    makeToggle();
    if (!lang) { document.documentElement.lang = "ja"; askLanguage(); }
    else applyLang(lang);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
