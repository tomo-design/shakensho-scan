"use strict";
/* ===== 簡易多言語化(日本語⇄英語) =====
   HTMLは編集せず、テキストノード/placeholder/titleを辞書で置換。
   辞書に無い文字列は日本語のまま(安全)。動的生成分はMutationObserverで追従。 */
(function () {
  // JA -> EN 辞書(完全一致・トリム後)。ブランド名(メカノAI/メカ君)は共通のため未登録=そのまま。
  const DICT = {
    // 下部タブ / ナビ
    "スキャン": "Scan", "履歴": "History", "DB編集": "DB", "設定": "Settings",
    "← 車両": "← Vehicle", "🔧 メンテ": "🔧 Maint", "🩺 診断": "🩺 Diagnose",
    "🛠 修理": "🛠 Repair", "📋 カルテ": "📋 Records",
    // スキャン画面
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
    "車両データを修正": "Edit vehicle data", "型式": "Model", "使用者名": "User name",
    "初度登録": "First registration", "有効期限": "Expiry",
    "保存": "Save", "取消": "Cancel", "キャンセル": "Cancel", "閉じる": "Close", "戻る": "Back", "実行": "Submit", "クリア": "Clear",
    "QRの生データから選んで割り当てる": "Assign from raw QR data",
    "この車両で何をしますか？": "What would you like to do with this vehicle?",
    "🔧 メンテナンスデータを見る": "🔧 View maintenance data",
    "オイル量・トルク・定番故障・リコール": "Oil capacity, torque, common faults, recalls",
    "🩺 故障診断をする": "🩺 Run diagnosis",
    "ダイアグコード・問診から原因究明": "Find causes from DTCs & symptoms",
    "🛠 修理（部品・注文リスト）": "🛠 Repair (parts & order list)",
    "必要部品の洗い出し・取付位置・注文リスト作成": "List parts, locations & order sheet",
    "📋 整備カルテ（作業記録）": "📋 Service record",
    "作業内容を記録・社内で共有／写真で入力も": "Log work & share; photo input too",
    "QRから読み取った全フィールド": "All fields read from QR",
    "自動判定が間違っている場合は、正しい値のチップをタップ →「型式」or「車台番号」に割り当てできます。":
      "If auto-detection is wrong, tap the correct chip and assign it to “Model” or “Chassis”.",
    "※ データはこの端末に保存。クラウド同期にログイン中は社内で共有されます。":
      "※ Data is stored on this device. When signed in to cloud sync, it is shared within your company.",
    // メンテ
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
    // カルテ
    "整備カルテ（作業記録）": "Service records", "＋ 記録を追加": "＋ Add record", "📷 写真で入力": "📷 Photo input",
    "日付": "Date", "走行距離(km)": "Odometer (km)", "作業内容": "Work performed",
    "交換部品・使用材料": "Parts / materials", "費用(円)": "Cost (JPY)", "担当者": "Staff", "メモ": "Notes",
    // 修理
    "修理について質問": "Ask about repairs",
    "📗 FAINESで正式な整備手順・品番・トルクを確認": "📗 Check official procedures, part numbers & torque on FAINES",
    "※ 回答・部品番号はAIの参考情報です。注文・作業前にFAINESや部品商で正式値を確認してください。":
      "※ Answers and part numbers are AI references. Verify with FAINES or a parts dealer before ordering/working.",
    // 診断
    "ダイアグコード/故障診断": "DTC / Fault diagnosis",
    "メカ君と音声会話": "Voice chat with Mecha", "🎤 押して話す": "🎤 Push to talk", "🔇 読み上げ停止": "🔇 Stop speaking", "終了": "End",
    "「押して話す」を押し、症状を話してください。メカ君が音声で答えます。":
      "Press “Push to talk” and describe the symptom. Mecha will answer by voice.",
    "※ 原因候補は参考情報です。最終判断は実測・実点検で。":
      "※ Possible causes are references. Make the final call with actual measurement/inspection.",
    // 履歴
    "スキャン履歴": "Scan history",
    "履歴には型式・車台番号・日時のみ保存されます（この端末内のみ）。":
      "History stores only model, chassis number and date/time (on this device only).",
    // DB編集
    "＋ 車種を追加": "＋ Add model", "⬇ JSONエクスポート": "⬇ Export JSON", "⬆ JSONインポート": "⬆ Import JSON",
    "車種を追加": "Add model", "登録車種一覧": "Registered models",
    // 設定
    "クラウド同期（社内共有）": "Cloud sync (company share)",
    "ログイン": "Log in", "管理者として会社を新規登録": "Register a company (as admin)",
    "従業員として会社に参加": "Join a company (as staff)",
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
    // 割り当てバー
    "初度登録": "First reg.",
  };

  const ORIG = "__i18n_orig";
  let lang = localStorage.getItem("ss_lang") || null;   // 未設定なら起動時に選択
  window.APP_LANG = lang || "ja";

  const has = k => Object.prototype.hasOwnProperty.call(DICT, k);

  function trTextNode(node, toEn) {
    if (toEn) {
      const base = node[ORIG] != null ? node[ORIG] : node.nodeValue;
      const key = (base || "").trim();
      if (has(key)) { if (node[ORIG] == null) node[ORIG] = node.nodeValue; node.nodeValue = base.replace(key, DICT[key]); }
    } else if (node[ORIG] != null) {
      node.nodeValue = node[ORIG]; delete node[ORIG];
    }
  }
  function trAttr(el, attr, toEn) {
    const k = "__i18n_" + attr;
    if (toEn) {
      const base = el[k] != null ? el[k] : el.getAttribute(attr);
      const key = (base || "").trim();
      if (has(key)) { if (el[k] == null) el[k] = el.getAttribute(attr); el.setAttribute(attr, DICT[key]); }
    } else if (el[k] != null) {
      el.setAttribute(attr, el[k]); delete el[k];
    }
  }
  function walk(root, toEn) {
    // テキストノード
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const texts = []; let n; while ((n = tw.nextNode())) texts.push(n);
    texts.forEach(t => trTextNode(t, toEn));
    // 属性(placeholder / title)
    const els = root.nodeType === 1 ? [root, ...root.querySelectorAll("[placeholder],[title]")] : [...root.querySelectorAll ? root.querySelectorAll("[placeholder],[title]") : []];
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

  // 動的に追加される要素も翻訳(英語時のみ)
  const mo = new MutationObserver(muts => {
    if (window.APP_LANG !== "en") return;
    for (const m of muts) m.addedNodes.forEach(nd => {
      if (nd.nodeType === 3) trTextNode(nd, true);
      else if (nd.nodeType === 1) walk(nd, true);
    });
  });

  // ===== 小さく目立たない言語トグル(右上) =====
  let toggleEl;
  function updateToggle() { if (toggleEl) toggleEl.textContent = (window.APP_LANG === "en") ? "日本語" : "EN"; }
  function makeToggle() {
    toggleEl = document.createElement("button");
    toggleEl.id = "langToggle";
    toggleEl.type = "button";
    toggleEl.title = "Language / 言語";
    toggleEl.addEventListener("click", () => applyLang(window.APP_LANG === "en" ? "ja" : "en"));
    document.body.appendChild(toggleEl);
    updateToggle();
  }

  // ===== 起動時の言語選択(小さなバー) =====
  function askLanguage() {
    const bar = document.createElement("div");
    bar.id = "langPick";
    bar.innerHTML = '<span>Language / 言語</span>' +
      '<button type="button" data-l="ja">日本語</button>' +
      '<button type="button" data-l="en">English</button>';
    bar.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      applyLang(b.dataset.l); bar.remove();
    });
    document.body.appendChild(bar);
  }

  function init() {
    mo.observe(document.body, { childList: true, subtree: true });
    makeToggle();
    if (!lang) { document.documentElement.lang = "ja"; askLanguage(); }   // 初回のみ選択を促す
    else applyLang(lang);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
