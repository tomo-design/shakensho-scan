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
    "保存": "Save", "取消": "Cancel", "キャンセル": "Cancel", "閉じる": "Close", "戻る": "Back", "実行": "Submit", "クリア": "Clear", "削除": "Delete", "編集": "Edit",
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
    "考えられる原因:": "Possible causes:", "確認手順:": "Check procedure:", "切り分け・確認:": "Isolation / check:", "理由": "Why",
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
    "クラウド同期": "Cloud sync",
    "ログイン": "Log in", "管理者として会社を新規登録": "Register a company (as admin)", "従業員として会社に参加": "Join a company (as staff)",
    "氏名": "Name", "メールアドレス": "Email", "パスワード": "Password",
    "事業所ID（会社の識別名・半角英数）": "Company ID (alphanumeric)",
    "パスワードを忘れた方（再設定メール）": "Forgot password (reset email)",
    "👥 メンバー管理": "👥 Manage members", "ログアウト": "Log out",
    "このアプリを紹介": "Share this app",
    "メカ君に相談機能": "Ask-Mecha feature",
    "回答の品質モード": "Answer quality mode", "標準（速い）": "Standard (fast)", "高精度（精度重視）": "High accuracy",
    "文字読み取り機能について": "Text recognition", "データ管理": "Data management", "部品の実写画像": "Real part photos", "お問い合わせ・よくある質問": "Contact & FAQ",
    "この操作は管理者のみ行えます。": "This action is available to administrators only.",
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

    // ===== 追加: 静的UIの網羅(ヘッダー/スキャン/フッター) =====
    "メカノAI - 車両整備サポート": "MECHANO-AI – Vehicle Service Assistant",
    "← 戻る": "← Back", "QRでScan": "Scan by QR", "写真でScan": "Scan by photo",
    "🔄 再スキャン": "🔄 Rescan", "QR解析": "Analyze QR", "ライト": "Light",
    "🔎 QR生データをコピー（不具合報告用）": "🔎 Copy raw QR data (for bug reports)",
    "※ データはこの端末に保存。": "※ Stored on this device.",
    "クラウド同期にログイン中は社内で共有されます。": "When signed in to cloud sync, it is shared within your company.",
    "利用規約・著作権": "Terms & Copyright", "プライバシーポリシー": "Privacy Policy",
    "カスタマーハラスメント対応ポリシー": "Customer Harassment Policy", "よくある質問": "FAQ",
    "お問い合わせ": "Contact", "運営のメール": "Operator email", "アプリQR": "App QR",
    "アプリ紹介用QRコード": "App promo QR code", "メカ君": "Mecha", "OCR対象画像": "OCR target image",
    // ===== リコール =====
    "国土交通省 リコール情報検索": "MLIT recall information search",
    "車台番号・型式で検索（公式）": "Search by chassis / model (official)",
    "メーカーのリコール検索ページ": "Manufacturer’s recall search page",
    "車台番号入力で対象確認": "Check affected units by chassis number",
    "「型式＋リコール」でWeb検索": "Web search “model + recall”",
    "最新の届出をまとめて確認": "Check the latest filings at once",
    // ===== 修理/診断 見出し =====
    "修理/その他": "Repair / Other", "過去の点検手引書": "Past inspection guides",
    "結果はこの端末に保存されます。項目タップで再表示、×で削除。":
      "Results are saved on this device. Tap an item to reopen, × to delete.",
    "故障診断/ダイアグ": "Fault diagnosis / DTC", "過去の診断結果": "Past diagnosis results",
    // ===== DB編集 =====
    "車種名（例: いすゞ ギガ）": "Model name (e.g. Isuzu Giga)",
    "型式マッチ正規表現（例: ^(CYL|CXZ)）": "Model-match regex (e.g. ^(CYL|CXZ))",
    "メーカー（リコールリンク用）": "Manufacturer (for recall links)",
    "いすゞ": "Isuzu", "日野": "Hino", "三菱ふそう": "Mitsubishi Fuso", "UDトラックス": "UD Trucks",
    "日産": "Nissan", "トヨタ": "Toyota", "ホンダ": "Honda", "マツダ": "Mazda",
    "スズキ": "Suzuki", "ダイハツ": "Daihatsu", "スバル": "Subaru", "その他": "Other",
    "定番故障・持病（1行に1件）": "Common faults (one per line)",
    "メンテナンス諸元（1行に1件、「項目: 値」形式）": "Maintenance specs (one per line, “item: value”)",
    "メモ（任意）": "Notes (optional)",
    "📷 写真から読み取り（整備書・諸元表・コーションプレート等）":
      "📷 Read from photo (service manual, spec sheet, caution plate, etc.)",
    "読み取り結果（不要な行を消してから反映してください）": "OCR result (delete unneeded lines before applying)",
    "「内蔵」は db/vehicles.json の初期データ、「カスタム」はこの端末で追加・編集したデータ（localStorage保存）です。同じ車種名のカスタムが内蔵より優先されます。ノウハウのバックアップにはエクスポートを使ってください。":
      "“Built-in” is the initial data in db/vehicles.json; “Custom” is data you added/edited on this device (saved in localStorage). Custom entries with the same model name take priority. Use Export to back up your know-how.",
    "履歴を全削除": "Delete all history", "カスタムDBを全削除": "Delete all custom DB",
    "🗑 DB内蔵データを全消去": "🗑 Erase all built-in DB data",
    "「DB内蔵データを全消去」は内蔵車種DB・カスタムDB・AIが学習した諸元/定番故障をすべて削除します（スキャン履歴は残ります）。":
      "“Erase all built-in DB data” deletes the built-in model DB, custom DB, and AI-learned specs/common faults (scan history is kept).",
    // ===== カルテ入力 =====
    "記録を追加": "Add record", "写真で入力": "Photo input", "任意": "Optional", "担当者名": "Staff name",
    "次回の申し送り・気づきなど（任意）": "Handover notes / observations (optional)",
    "例: 82000": "e.g. 82000",
    "例: エンジンオイル・エレメント交換、下回り点検（複数はカンマや改行で区切ると見やすく表示されます）":
      "e.g. Engine oil & filter change, underbody inspection (separate multiple items with commas or line breaks)",
    "例: 純正オイル4.0L、オイルエレメント(品番●●)": "e.g. Genuine oil 4.0L, oil filter (part no. ●●)",
    // ===== 診断/修理 入力ボタン(title) =====
    "音声で入力": "Voice input", "メカ君と会話": "Chat with Mecha",
    "写真を添付": "Attach photo", "写真を撮って添付": "Take & attach photo",
    "動画を添付": "Attach video", "動画を撮って添付": "Take & attach video",
    "修理・整備の質問（作業名だけでもOK 例:「パッド交換」）。🎤音声・🗣️会話・📷写真も。":
      "Ask about repair/maintenance (a task name is fine, e.g. “pad replacement”). 🎤 voice, 🗣️ chat, 📷 photo too.",
    "ダイアグコード（例: P0401）や症状を入力。🎤音声・写真/動画の添付も可。":
      "Enter a DTC (e.g. P0401) or symptom. 🎤 voice, photo/video attachments too.",
    "メッセージを入力…": "Type a message…", "送信": "Send",
    // ===== 直接入力の例(placeholder) =====
    "例: 2PG-FW74HZ / VY12": "e.g. 2PG-FW74HZ / VY12", "例: A09C / 6UZ1 / KF": "e.g. A09C / 6UZ1 / KF",
    "例: FW74HZ-510123": "e.g. FW74HZ-510123", "例: 品川 100 あ 12-34": "e.g. Shinagawa 100 A 12-34",
    "例: 〇〇運送": "e.g. ABC Transport",
    "例: 山田 太郎": "e.g. Taro Yamada", "6文字以上": "6+ characters", "例: sakuragarage": "e.g. sakuragarage",
    "エンジンオイル量: 約13L（フィルタ交換時）\nホイールナット締付: 550-600N·m（ISO・要確認）":
      "Engine oil: approx. 13L (with filter change)\nWheel nut torque: 550-600 N·m (ISO, verify)",
    // ===== サポート/設定 見出し =====
    "メカ君サポート": "Mecha support",
    "回答はAIによる案内です。契約・請求の確定情報は運営にご確認ください。":
      "Answers are AI guidance. For confirmed contract/billing details, please check with the operator.",
    "解決しない場合：": "If not resolved:",
    "バージョン情報を取得中…": "Loading version info…", "🔄 アプリを最新に更新": "🔄 Update app to latest",
    "🔑 パスワード変更": "🔑 Change password", "✉ メール変更": "✉ Change email", "↩ ログアウト": "↩ Log out",
    // ===== 従業員登録の手順 =====
    "📋 従業員の登録手順（はじめての方へ）": "📋 Staff registration steps (first-time users)",
    "既存の会社に参加": "Join an existing company", "自分のメール": "your email",
    "パスワード（6文字以上）": "password (6+ characters)", "事業所ID": "company ID",
    "④「承認待ち」と出る →": "④ “Pending approval” appears →",
    "会社の管理者が承認": "your company admin approves", "するまで待つ": "— wait until then",
    "⑤ 承認されると自動でログイン状態になり、社内の車両データ・車種DBが同期されます":
      "⑤ Once approved, you’re signed in automatically and your company’s vehicle data / model DB syncs",
    "※ 2回目以降は「ログイン」だけでOK。パスワードは各自で保管してください。":
      "※ After the first time, just “Log in”. Keep your password safe.",
    "ログインすると、車種DB・車両データ（ナンバー/使用者含む）を":
      "Sign in to automatically share the model DB and vehicle data (incl. plate/owner) across",
    "社内の全端末で自動共有": "all devices in your company",
    "できます。会社ごとに分離され、他社からは見えません。":
      ". Data is separated per company and invisible to other companies.",
    "ログインでお困りの場合は、会社の代表管理者または運営（":
      "If you have trouble signing in, contact your company admin or the operator (",
    "）へご連絡ください。": ").",
    // ===== APIキー設定の案内 =====
    "🔑 このアプリはご自身のAPIキーで動きます": "🔑 This app runs on your own API key",
    "下の「メカ君に相談機能」でGoogleの": "In “Ask-Mecha feature” below, get Google’s",
    "無料APIキー": "free API key",
    "を取得して貼ると、AI機能が使えます（カード登録不要）。":
      " and paste it to enable AI features (no card required).",
    "さらに": "Also, ", "文字読み取り（OCR）": "text recognition (OCR)",
    "も、Cloud Vision APIキーの登録で高精度になります（月1,000枚まで無料）。":
      " becomes high-accuracy by registering a Cloud Vision API key (free up to 1,000/month).",
    "🔑 AI用キー設定": "🔑 AI key setup", "📷 OCR用キー設定": "📷 OCR key setup",
    "APIキー": "API key", "を取る": " — get one",
    "開いたページで（Googleにログイン後）「": "On the page that opens (after signing in to Google),",
    "APIキーを作成": "Create API key", "」→ 出てきた": "→ copy the",
    "をコピー → 下に貼る。": " and paste it below.",
    "※「プロジェクトを選択」と出たら、一覧のどれかを選ぶ／無ければ「新しいプロジェクトで作成」でOK。":
      "※ If asked to “Select a project”, pick any from the list, or choose “Create in new project”.",
    "「無料枠の上限」をなくしたい場合（任意・従量課金）":
      "To remove the “free-tier limit” (optional, pay-as-you-go)",
    "同じキーのまま、紐づくプロジェクトの「課金」を有効にすると上限が大幅に上がります。":
      "Keep the same key and enable “Billing” on its project to greatly raise the limit.",
    "AI StudioのAPIキー画面 ↗": "AI Studio API keys ↗", "Google Cloud のお支払い ↗": "Google Cloud Billing ↗",
    "でカード登録 → キーの貼り替え不要": " register a card — no need to re-paste the key",
    "料金:": "Pricing:", "Gemini API 料金 ↗": "Gemini API pricing ↗",
    "文字読み取り（OCR）について": "About text recognition (OCR)",
    "高精度に読み取るには、Cloud Vision APIの登録を推奨します。":
      "For high-accuracy reading, registering the Cloud Vision API is recommended.",
    "整備書・諸元表・コーションプレート・手書き伝票などを正確に文字起こしできます（月1,000枚まで無料）。設定は下のSTEP 1〜2だけ、数分で完了します。":
      "Accurately transcribe service manuals, spec sheets, caution plates, handwritten slips, etc. (free up to 1,000/month). Setup is just STEP 1–2 below and takes a few minutes.",
    "おすすめ：Cloud Vision APIキーを登録": "Recommended: register a Cloud Vision API key",
    "（月1,000枚まで無料・高精度）": " (free up to 1,000/month, high accuracy)",
    "未登録でも、端末内の": "Even without it, on-device ",
    "Tesseract（無料・オフライン）": "Tesseract (free, offline)",
    "で読み取りは動きます（精度は控えめ。明るく大きく写すと向上）。":
      " still works (lower accuracy; improves with bright, large shots).",
    "を有効にする": " — enable it", "Vision APIを有効化する ↗": "Enable the Vision API ↗",
    "開いた画面で「": "On the screen that opens,", "有効にする": "Enable",
    "」を押す。プロジェクトが無ければ画面の案内で1つ作成（無料）。":
      " and press it. If you have no project, create one via the on-screen guide (free).",
    "APIキー発行ページを開く ↗": "Open the API key page ↗", "＋認証情報を作成": "+ Create credentials",
    "」→ 出た": "→ the",
    "※ 月1,000枚を超えると課金（ご自身のGoogle側）になります。料金:":
      "※ Over 1,000/month is billed (on your Google account). Pricing:",
    "Vision 料金 ↗": "Vision pricing ↗",
    "高精度OCR（Cloud Vision）を使う": "Use high-accuracy OCR (Cloud Vision)",
    "ON＋キー設定時のみ全OCRがCloud Visionに（課金はご自身のGoogle側）。":
      "Only when ON and a key is set, all OCR uses Cloud Vision (billed on your Google account).",
    "設定すると、": "Once set, ",
    "部品注文リストの部品名をタップしたときに実物の写真": "tapping a part name in the order list shows real photos",
    "が表示されます。未設定でもWeb画像検索リンクは使えます。":
      ". Even without it, web image-search links still work.",
    "ご契約中は設定不要です。": "No setup needed while you have a contract.",
    "そのままお使いいただけます。": "You can use it as is.",
    "検索エンジン": "search engine", "検索エンジンを作成する ↗": "Create a search engine ↗",
    "名前は自由（例：部品画像）。作成したら、その検索エンジンの設定画面で次の2つを行ってください。":
      "Any name (e.g. Part images). After creating it, do the following two things in its settings.",
    "検索設定": "Search settings", "画像検索": "Image search", "オン": "on",
    "にする（": " (",
    "オフのままだと画像が出ません": "if left off, no images appear",
    "ウェブ全体を検索": "Search the entire web",
    "にする（見つからない場合は、検索対象に": " (if not found, add one site such as",
    "ではなく": " instead of",
    "など任意のサイトを1つ追加してから、この項目をオンにしてください）。":
      " to the search targets, then turn this on).",
    "そのうえで「": "Then ", "検索エンジンID": "Search engine ID", "」をコピー → 下の①に貼る。": " — copy it and paste into ① below.",
    "Custom Search APIを有効にする ↗": "Enable the Custom Search API ↗",
    "次のSTEP3と同じプロジェクト": "the same project as STEP 3 below",
    "で行ってください（画面上部のプロジェクト名で確認）。ここが違うと「APIが有効になっていません」になります。":
      " (check the project name at the top). A mismatch causes “API not enabled”.",
    "をコピー → 下の②に貼る。": " — copy it and paste into ② below.",
    "※ 1日100回まで無料。超えると課金（ご自身のGoogle側）。料金:":
      "※ Free up to 100/day. Over that is billed (on your Google account). Pricing:",
    "Custom Search 料金 ↗": "Custom Search pricing ↗",
    "① 検索エンジンID をここに貼る": "① Paste the Search engine ID here",
    "② APIキー をここに貼る": "② Paste the API key here",
    "Cloud Vision APIキー（推奨）": "Cloud Vision API key (recommended)",
    "検索エンジンID（例 a1b2c3d4e5f6g7h8i）": "Search engine ID (e.g. a1b2c3d4e5f6g7h8i)",
    "Custom Search APIキー": "Custom Search API key",
    "※ 車両ごとに記録・社内共有。「写真から自動入力」は作業伝票やメモの写真をメカ君(AI)が読み取り各項目に下書きします（内容は保存前に確認・修正できます）。":
      "※ Records are per vehicle and shared in-house. “Auto-fill from photo” lets Mecha (AI) read a photo of a work slip/memo and draft each field (review and edit before saving).",
    // ===== 追加: 細かな断片(インライン要素で分割された文言) =====
    "」を押す": "”", "と": "and", "を入力": " — enter it",
    "に会社から伝えられたID（例:": " — enter the ID given by your company (e.g.",
    "）を入力 →「実行」": ") → “Submit”",
    "を作る": " — create one", "の「": " → “", "」を": "” ", "」を割り当て:": "” — assign:",
    "Gemini APIキー（": "A Gemini API key (", "無料・カード登録不要": "free, no card needed",
    "）を設定すると「メカ君に相談」が使えます。下のボタンで取得して貼るだけ。":
      ") enables “Ask Mecha”. Just get one with the button below and paste it.",

    // ===== 追加: app.js の動的UI(読み込み/状態/ボタン/ラベル) =====
    "ピント調整中…": "Adjusting focus…", "位置を調べ中…": "Looking up the location…",
    "メカ君が考え中…": "Mecha is thinking…", "メカ君が解析中…": "Mecha is analyzing…",
    "メカ君が調べ中…": "Mecha is looking it up…", "動画を圧縮中…": "Compressing video…",
    "🔄 更新中…": "🔄 Updating…", "✓ 読み取り完了": "✓ Read complete", "中断しました": "Cancelled",
    "取得に失敗しました": "Failed to load", "APIキー未設定": "No API key set", "キーが無効": "Key is invalid",
    "利用不可": "Unavailable", "は利用不可": " unavailable",
    "参考図を隠す": "Hide reference", "写真を追加": "Add photo", "📤 共有": "📤 Share",
    "締付トルク・規定値": "Tightening torque / spec values", "リコール 改善対策": "Recall / improvement",
    "前回の車両": "Last vehicle", "メカ君の見解": "Mecha’s view", "保存した診断結果": "Saved diagnosis results",
    "点検手引書": "Inspection guide", "高精度Pro": "High-accuracy Pro", "標準Flash": "Standard Flash",
    "通販で探す": "Find online", "楽天市場で探す": "Search on Rakuten", "Amazonで探す": "Search on Amazon",
    "参考図": "Reference", "疑う原因": "Suspected cause",
    // 油脂・冷却水など(諸元/修理でよく出る)
    "エンジンオイル量": "Engine oil capacity", "推奨オイル粘度": "Recommended oil viscosity",
    "クーラント量": "Coolant capacity", "デフオイル量": "Diff oil capacity",
    "エンジンオイル": "Engine oil", "エンジン油": "Engine oil", "オートマオイル": "ATF",
    "ミッションオイル": "Transmission oil", "デフオイル": "Diff oil", "ギヤオイル": "Gear oil", "ギアオイル": "Gear oil",
    "CVTフルード": "CVT fluid", "ブレーキフルード": "Brake fluid", "ブレーキ液": "Brake fluid", "ブレーキオイル": "Brake fluid",
    "パワステフルード": "Power steering fluid", "クーラント": "Coolant", "不凍液": "Antifreeze", "冷却水": "Coolant",
    "アドブルー": "AdBlue", "尿素水": "AdBlue (urea)", "ロングライフ": "Long-life",
    // 工具(別途必要な工具リストでよく出る)
    "トルクレンチ": "Torque wrench", "ソケット": "Socket", "プライヤー": "Pliers", "ニッパー": "Nippers",
    "ペンチ": "Pliers", "ラジオペンチ": "Needle-nose pliers", "モンキーレンチ": "Adjustable wrench",
    "六角レンチ": "Hex key", "貫通ドライバー": "Through-shank screwdriver", "プラスドライバー": "Phillips screwdriver",
    "マイナスドライバー": "Flat-head screwdriver", "インパクトレンチ": "Impact wrench",
    "トルクスソケット": "Torx socket", "トルクスドライバー": "Torx driver", "バイスプライヤー": "Vise-grip pliers",
    "ケーブルカッター": "Cable cutter", "ジャッキ": "Jack", "リジッドラック": "Jack stand", "輪止め": "Wheel chock",
    // ===== メカ君サポート(チャット) =====
    "こんにちは、サポートのメカ君です🔧 このツールの使い方や仕様について、なんでも聞いてください。":
      "Hi, I’m Mecha from support 🔧 Ask me anything about how to use this tool or its features.",
    "いまAIをご利用いただけません。個人利用の方は設定タブで無料のGeminiキーを登録、契約店舗の方はログイン後にお使いください。お急ぎの場合は cablueie.123@gmail.com へご連絡ください。":
      "AI isn’t available right now. Individual users: register a free Gemini key in Settings. Contracted shops: use it after signing in. If urgent, contact cablueie.123@gmail.com.",
    "うまく答えられませんでした。cablueie.123@gmail.com へお問い合わせください。":
      "I couldn’t answer that well. Please contact cablueie.123@gmail.com.",
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
    [/^エラーが発生しました（(.*)）。cablueie\.123@gmail\.com へお問い合わせください。$/,
      "An error occurred ($1). Please contact cablueie.123@gmail.com."],
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
