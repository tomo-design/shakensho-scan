"use strict";
/*! メカノAI (MECHANO-AI) © 2026 Cablueie. All Rights Reserved. 無断複製・改変・再配布・リバースエンジニアリングを禁じます。 */
/* =========================================================
   車検証スキャン 整備サポート v1.0
   - QR読取(jsQR) + 国交省二次元コード仕様パーサ
   - 車両ノウハウDB(db/vehicles.json + localStorageカスタム)
   - スキャン履歴 / DB編集 / OCRフォールバック
   ========================================================= */

const APP_VER = "1.0.0";
/* 表示バージョン: Service Worker のキャッシュ名(shaken-scan-vNNN)から取得。無ければ APP_VER。 */
async function appVerDisplay() {
  try {
    const keys = await caches.keys();
    const nums = keys.map(k => (String(k).match(/shaken-scan-v(\d+)/) || [])[1]).filter(Boolean).map(Number);
    if (nums.length) return "v" + Math.max(...nums);
  } catch (e) {}
  return "v" + APP_VER;
}
const LS = { hist: "ss_history", custom: "ss_customdb", gemini: "ss_geminikey", aimode: "ss_aimode" };
/* AIが使えるか: 自分のGeminiキーがある or 契約中の店舗(サーバー経由=鍵不要)。*/
function aiOK() { if (typeof isDemo === "function" && isDemo()) return true; return !!localStorage.getItem(LS.gemini) || !!(window.Cloud && window.Cloud.aiReady && window.Cloud.aiReady()); }

const $ = id => document.getElementById(id);
/* クリップボードにコピー。navigator.clipboard は安全(HTTPS)コンテキストでしか動かないため、
   HTTP/非対応環境では execCommand('copy') にフォールバックする。成功で true。 */
async function copyText(txt) {
  txt = String(txt == null ? "" : txt);
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(txt); return true; }
  } catch (e) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = txt;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus(); ta.select(); ta.setSelectionRange(0, txt.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}
const toggle = (id, show) => { const el = $(id); if (el) el.classList.toggle("hidden", !show); };
/* ブラウザ標準alert(ドメイン名が出て不格好)の代わりの、アプリ内モーダル通知 */
function uiAlert(msg, title) {
  return new Promise(res => {
    const ov = document.createElement("div"); ov.className = "uiModalOv";
    const m = document.createElement("div"); m.className = "uiModal";
    if (title) { const h = document.createElement("div"); h.className = "uiModalTitle"; h.textContent = String(title); m.appendChild(h); }
    const body = document.createElement("div"); body.className = "uiModalBody"; body.textContent = String(msg == null ? "" : msg); m.appendChild(body);
    const ok = document.createElement("button"); ok.type = "button"; ok.className = "uiModalOk"; ok.textContent = "OK"; m.appendChild(ok);
    ov.appendChild(m); document.body.appendChild(ov);
    const close = () => { ov.remove(); res(); };
    ok.addEventListener("click", close);
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
  });
}
try { window.uiAlert = uiAlert; } catch (e) {}
/* アプリ内の確認ダイアログ(ネイティブconfirmに依存しない)。
   ブラウザで「追加のダイアログを表示しない」を選ぶとconfirm()が常にfalseになり操作不能になるため、自前UIで実装。 */
function uiConfirm(msg, opt) {
  opt = opt || {};
  return new Promise(res => {
    const ov = document.createElement("div"); ov.className = "uiModalOv";
    const m = document.createElement("div"); m.className = "uiModal";
    if (opt.title) { const h = document.createElement("div"); h.className = "uiModalTitle"; h.textContent = String(opt.title); m.appendChild(h); }
    const body = document.createElement("div"); body.className = "uiModalBody"; body.textContent = String(msg == null ? "" : msg); m.appendChild(body);
    const btns = document.createElement("div"); btns.className = "uiModalBtns";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "uiModalCancel"; cancel.textContent = opt.cancelText || "キャンセル";
    const ok = document.createElement("button"); ok.type = "button"; ok.className = "uiModalOk" + (opt.danger ? " danger" : ""); ok.textContent = opt.okText || "OK";
    btns.appendChild(cancel); btns.appendChild(ok); m.appendChild(btns);
    ov.appendChild(m); document.body.appendChild(ov);
    const done = v => { ov.remove(); res(v); };
    ok.addEventListener("click", () => done(true));
    cancel.addEventListener("click", () => done(false));
    ov.addEventListener("click", e => { if (e.target === ov) done(false); });
  });
}
try { window.uiConfirm = uiConfirm; } catch (e) {}
/* 部品注文リストの各部品→通販(モノタロウ/Amazon)の商品検索へ。アフィリエイトID/リンクを入れると自動でタグ付き。
   ※IDは秘密情報ではないためクライアント同梱で問題なし。空でも通常の商品検索として機能する。 */
const AFFIL = {
  amazonTag: "mechanoai-22",   // AmazonアソシエイトのトラッキングID。空ならタグ無し検索
  // もしもアフィリエイト経由(af.moshimo.com)で成果計測。各ネットのIDは かんたんリンクのHTMLから取得。
  // 未提携のネットは null にすると素の検索URL(計測なし)にフォールバック。Amazonは審査通過後に追加。
  moshimo: {
    rakuten: { a_id: 5743960, p_id: 54, pc_id: 54, pl_id: 27059 },
    yahoo:   { a_id: 5743973, p_id: 1225, pc_id: 1925, pl_id: 27061 },
  },
};
/* もしもの成果計測リンクで包む。net="rakuten"|"yahoo"。未設定なら素のURLを返す。 */
function moshimoWrap(net, targetUrl) {
  const m = AFFIL.moshimo && AFFIL.moshimo[net];
  if (!m) return targetUrl;
  return "https://af.moshimo.com/af/c/click?a_id=" + m.a_id + "&p_id=" + m.p_id +
    "&pc_id=" + m.pc_id + "&pl_id=" + m.pl_id + "&url=" + encodeURIComponent(targetUrl);
}
/* 楽天市場の検索(部品名で検索)。もしも経由で計測。 */
function rakutenSearchUrl(q) {
  return moshimoWrap("rakuten", "https://search.rakuten.co.jp/search/mall/" + encodeURIComponent(q) + "/");
}
/* 部品名タップ時に出す通販選択ポップアップ(楽天/Yahoo!/Amazon)。name=表示名, query=検索語 */
function openShopPopup(name, query) {
  const ov = document.createElement("div"); ov.className = "uiModalOv shopPopOv";
  const m = document.createElement("div"); m.className = "uiModal shopPop";
  const h = document.createElement("div"); h.className = "shopPopT"; h.textContent = name;
  const sub = document.createElement("div"); sub.className = "shopPopSub"; sub.textContent = "どのお店で探しますか？";
  m.append(h, sub);
  const wrap = document.createElement("div"); wrap.className = "shopPopBtns";
  const close = () => ov.remove();
  const mk = (cls, txt, href) => {
    const a = document.createElement("a"); a.className = "shopPopBtn " + cls;
    a.target = "_blank"; a.rel = "noopener sponsored"; a.href = href; a.textContent = txt;
    a.addEventListener("click", () => setTimeout(close, 150));
    return a;
  };
  wrap.append(
    mk("pShopR", "楽天市場で探す", rakutenSearchUrl(query)),
    mk("pShopY", "Yahoo!ショッピングで探す", yahooSearchUrl(query)),
    mk("pShopA", "Amazonで探す", amazonSearchUrl(query))
  );
  m.appendChild(wrap);
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "shopPopCancel"; cancel.textContent = "閉じる";
  cancel.addEventListener("click", close);
  m.appendChild(cancel);
  ov.appendChild(m); document.body.appendChild(ov);
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
}
/* 部品の検索クエリ: 品番が判明していれば「品番 + 名称」、無ければ名称のみ */
function partQuery(i) {
  const pn = i && i.partno ? String(i.partno).trim() : "";
  const hasPn = pn && pn.indexOf("要確認") < 0;
  return ((hasPn ? pn + " " : "") + (i && i.name ? i.name : "")).trim();
}
function amazonSearchUrl(q) {
  return "https://www.amazon.co.jp/s?k=" + encodeURIComponent(q) + (AFFIL.amazonTag ? "&tag=" + encodeURIComponent(AFFIL.amazonTag) : "");
}
function yahooSearchUrl(q) {
  return moshimoWrap("yahoo", "https://shopping.yahoo.co.jp/search?p=" + encodeURIComponent(q));
}
/* 部品検索用の車両プレフィックス: 車種名 + 型式の車種記号(例「ダイハツ タント L375S」)。
   車台番号(VIN)そのものは商品に一致しないため使わず、型式記号までで特定精度を上げる。 */
function vehPartPrefix() {
  const code = kataSuffix((current && current.type) || "").trim();   // 例 DBA-L375S → L375S
  let model = (currentVehicleFacts().model || "").trim();
  // DBの車種名に登録番号/車台番号/使用者名が混入している場合があるため、
  // 個人情報や検索を汚す文字列は除外し、車種名らしくない時は使わない(型式コードのみで検索)。
  if (isEmailLike(model)) model = "";
  if (/\d{3,}/.test(model)) model = "";                         // 登録番号・車台番号などの数字列
  if (/[A-Za-z0-9]{5,}-\d/.test(model)) model = "";            // 車台番号っぽい英数-数字
  if (/[0-9]{1,3}\s*[ぁ-んァ-ヶ]\s*[0-9]/.test(model)) model = ""; // ナンバー(例 480 あ 12)
  const looksCar = /(トヨタ|レクサス|日産|ホンダ|マツダ|スズキ|ダイハツ|スバル|三菱|ふそう|いすゞ|イスズ|日野|ヒノ|UD|ニッサン|[ァ-ヶ]{2,})/.test(model);
  if (!looksCar) model = "";
  return [model, code].filter(Boolean).join(" ").trim();
}
/* 工具(ソケット/ヘックス/トルクス)を検索しやすい語に整形 */
function toolQuery(sz) {
  const s = String(sz || "");
  let m;
  if (/^\d{1,2}(\.\d)?mm$/i.test(s)) return s + " ソケット";        // 例 14mm → 14mm ソケット
  if ((m = s.match(/^HEX(\d+)/i))) return m[1] + "mm 六角 ヘックスソケット";
  if ((m = s.match(/^T(\d+)/i))) return "T" + m[1] + " トルクスソケット";
  return s;   // 名前付き工具(プライヤー等)はそのまま検索
}
/* 表示モード: personal=個人版(クラウド同期/契約を隠す・BYOK) / corp=法人版(従来通り) */
function getAppMode() { return localStorage.getItem("ss_appmode") === "personal" ? "personal" : "corp"; }
function applyAppMode() {
  const personal = getAppMode() === "personal";
  document.body.classList.toggle("personalMode", personal);
  // 個人版(ストア版)は「アプリを最新に更新」不要(ストア経由更新)。法人Web/PWA版のみ表示。
  const upBtn = $("btnAppUpdate");
  if (upBtn) { const w = upBtn.closest("div") || upBtn; w.style.display = personal ? "none" : ""; }
  // 個人版はAPIキーが前提。キー設定を自動で開いて見つけやすく
  if (personal) { const f = $("secAiKeyFold"); if (f) f.open = true; }
  // よくある質問(FAQ)を版に合わせて表示(法人=corp/個人=personal)
  const faq = $("faqLink"); if (faq) faq.href = "faq.html?v=" + (personal ? "personal" : "corp");
  // ヘッダーのエディション表記(個人版=Pocket / 法人版=Works)
  const eb = $("editionBadge");
  if (eb) {
    eb.textContent = personal ? "Pocket" : "Works";
    eb.classList.toggle("ed-pocket", personal);
    eb.classList.toggle("ed-works", !personal);
  }
  updatePocketAccountBox();
}
/* Web版Pocket(個人モード・ストア版でない)でログイン中のときだけ、設定タブ最下部にログアウトを出す。 */
function updatePocketAccountBox() {
  const row = $("pocketLogoutRow");
  const pwRow = $("pocketPwRow");
  if (!row && !pwRow) return;
  const personal = getAppMode() === "personal";
  const isStore = document.body.classList.contains("storeApp");
  const loggedIn = !!(window.Cloud && typeof window.Cloud.isLoggedIn === "function" && window.Cloud.isLoggedIn());
  const show = personal && !isStore && loggedIn;
  if (row) row.classList.toggle("hidden", !show);
  if (pwRow) pwRow.classList.toggle("hidden", !show);
  updatePocketTrialBanner();
}
// テナント(契約情報)がログイン後に非同期で読み込まれた/変化した時、cloud.jsから呼んで
// Pocketの無料お試し残日数バナーを再描画させる(読込前に1回走って消えるのを防ぐ)。
window.refreshPocketUI = function () { try { updatePocketAccountBox(); } catch (e) {} };
/* Web版Pocket(個人モード・ストア版でない)でトライアル中なら、無料お試しの残日数を表示する。
   ・ストア版はpaywall.jsが担当。ここはWeb版Pocketのみ(テナントのpaidUntilから算出)。 */
let _pocketTrialShown = false, _pocketPaywallShown = false;
function updatePocketTrialBanner() {
  const personal = getAppMode() === "personal";
  const isStore = document.body.classList.contains("storeApp");
  const loggedIn = !!(window.Cloud && window.Cloud.isLoggedIn && window.Cloud.isLoggedIn());
  const trialRow = document.getElementById("pocketTrialRow");
  if (!(personal && !isStore && loggedIn)) { if (trialRow) trialRow.classList.add("hidden"); return; }
  let info = null; try { info = window.Cloud.trialInfo && window.Cloud.trialInfo(); } catch (e) {}
  if (!info || !info.paidUntil) { if (trialRow) trialRow.classList.add("hidden"); return; }
  const daysLeft = Math.ceil((info.paidUntil - Date.now()) / 86400000);
  // 契約中(active)は何も出さない。トライアル中は残日数、期限切れは登録ペイウォール。
  if (info.plan === "active" && daysLeft > 0) { if (trialRow) trialRow.classList.add("hidden"); return; }
  if (daysLeft <= 0) {
    if (trialRow) trialRow.classList.add("hidden");
    if (!_pocketPaywallShown) { _pocketPaywallShown = true; try { openPocketPaywall(true); } catch (e) {} }
    return;
  }
  if (info.plan !== "trial") { if (trialRow) trialRow.classList.add("hidden"); return; }
  // ① 設定タブ最下部の常設ボタン(常に最新の残日数に更新)
  if (trialRow) {
    trialRow.classList.remove("hidden");
    const btn = document.getElementById("pocketTrialBtn");
    if (btn) { btn.innerHTML = "🎁 無料お試し 残り" + daysLeft + "日<br>（タップで登録）"; btn.onclick = () => { try { openPocketPaywall(false); } catch (e) {} }; }
  }
  // ② 起動時のフローティングバナーは1回だけ。5秒表示 → フェードアウト → 削除(以後は設定タブに残る)。
  if (_pocketTrialShown || document.getElementById("pwBanner")) return;
  _pocketTrialShown = true;
  const b = document.createElement("div");
  b.id = "pwBanner";
  b.style.pointerEvents = "auto"; b.style.cursor = "pointer";
  b.style.textAlign = "center"; b.style.lineHeight = "1.35"; b.style.transition = "opacity .6s";
  b.innerHTML = "🎁 無料お試し 残り" + daysLeft + "日<br><span style=\"font-size:11px\">（タップで登録）</span>";
  b.title = "タップで月額プランに登録";
  b.addEventListener("click", () => { try { openPocketPaywall(false); } catch (e) {} });
  document.body.appendChild(b);
  setTimeout(() => { if (!b.parentNode) return; b.style.opacity = "0"; setTimeout(() => { if (b.parentNode) b.remove(); }, 650); }, 5000);
}
/* Web版Pocketの課金導線: 月額¥500 / 年額¥5,500 を選んで Stripe Checkout へ。
   ・blocking=true(無料期間終了)のときは閉じにくい案内文にする。 */
function openPocketPaywall(blocking) {
  let ov = document.getElementById("pocketPayOv");
  if (ov) ov.remove();
  ov = document.createElement("div"); ov.id = "pocketPayOv"; ov.className = "ikModal"; ov.style.zIndex = "700";
  ov.innerHTML =
    '<div class="ikCard" style="max-width:340px">' +
      '<div class="ikTitle">' + (blocking ? "無料期間が終了しました" : "Pocket 月額プランに登録") + '</div>' +
      '<div class="ikVeh" style="text-align:left;line-height:1.7">' + (blocking ? "これからも全機能を使うには、月額プランのご登録が必要です。" : "今すぐ登録できます。<b>初回のご請求は無料期間が終わってから</b>なので、残りの無料期間はそのまま使えます。") + '<br><span style="font-size:12px;color:var(--dim)">お支払いはStripeの安全な決済ページで行います。いつでも解約できます。</span></div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;margin-top:4px">' +
        '<button type="button" class="agBtn agPocketLoginBtn" data-plan="month" style="margin:0">月額 ¥500 <span style="font-weight:600;font-size:12px">／月</span></button>' +
        '<button type="button" class="agBtn" data-plan="year" style="margin:0">年額 ¥5,000 <span style="font-weight:600;font-size:12px;color:var(--dim)">／年（月あたり¥417）</span></button>' +
      '</div>' +
      '<div id="pocketPayMsg" style="font-size:12.5px;color:#c0392b;min-height:16px;margin:6px 0 0;text-align:left"></div>' +
      '<button type="button" class="ikLater" id="pocketPayCancel">' + (blocking ? "あとで" : "とじる") + '</button>' +
    '</div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  const cancel = document.getElementById("pocketPayCancel"); if (cancel) cancel.addEventListener("click", close);
  const msg = document.getElementById("pocketPayMsg");
  ov.querySelectorAll("[data-plan]").forEach(b => b.addEventListener("click", async () => {
    const plan = b.getAttribute("data-plan");
    b.disabled = true; const t0 = b.textContent; b.textContent = "決済ページを準備中…";
    msg.textContent = "";
    let uid = null; try { uid = (window.Cloud && window.Cloud.myUid && window.Cloud.myUid()) || null; } catch (e) {}
    try {
      const r = await fetch("https://asia-northeast1-mecanoai.cloudfunctions.net/createPocketCheckout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: plan, uid: uid, trial: 0 }),   // アプリ内で7日試用済み → 二重トライアルなし
      });
      const d = await r.json().catch(() => ({}));
      if (d && d.url) { location.href = d.url; return; }
      msg.textContent = (d && d.error) || "決済ページを開けませんでした。時間をおいて再度お試しください。";
    } catch (e) {
      msg.textContent = "通信に失敗しました: " + (e.message || e);
    }
    b.disabled = false; b.textContent = t0;
  }));
}
function setAppMode(m) { localStorage.setItem("ss_appmode", m === "personal" ? "personal" : "corp"); applyAppMode(); }
const setText = (id, t) => { const el = $(id); if (el) el.textContent = t; };
/* メールアドレスらしい文字列か(使用者名・車種名へのメール混入対策) */
const isEmailLike = s => typeof s === "string" && /\S+@\S+\.\S+/.test(s);
const noEmail = s => (isEmailLike(s) ? "" : s);
/* 全角数字→半角(表示用) */
const han = s => String(s == null ? "" : s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
/* 数値+単位や「N・m」を途中で改行させない。
   ・全角中黒(・U+30FB)は日本語で改行可能位置なので、単位の中黒は半角中黒(·)に置換
   ・数値と単位の間の空白は非改行スペース(NBSP)に置換 */
function keepUnit(s) {
  return String(s == null ? "" : s)
    .replace(/N\s*[・･·]\s*[mｍ]/gi, "N·m")   // ニュートンメートルは1かたまりに
    .replace(/(\d(?:[.．]\d+)?)\s+(N·m|Nm|mm|cm|km|ml|kgf|kg|L|°C|rpm|kPa|MPa|bar|V|A)\b/gi, "$1 $2");
}
/* AI(グラウンディング)が混ぜる引用マーカー・英語注釈を除去して読みやすくする。
   例: 「540〜590 N·m [cite: 17 (from previous search)]」→「540〜590 N·m」 */
const cleanCite = s => String(s == null ? "" : s)
  .replace(/\[\s*cite[^\]]*\]/gi, "")                       // [cite: 17 (from previous search), 29 ...]
  .replace(/【[^】]*(?:cite|search)[^】]*】/gi, "")           // 全角括弧版
  .replace(/\((?:from\s+)?previous\s+search[^)]*\)/gi, "")   // (from previous search)
  .replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, "")             // 裸の [17] / [17, 29, 36]
  .replace(/[ \t]{2,}/g, " ")
  .replace(/\s+([、。,.，])/g, "$1")
  .replace(/[\s、,，]+$/g, "")
  .trim();
/* 検索グラウンディング有効時に混入する引用マーカーを、オブジェクト内の全文字列から再帰的に除去 */
function cleanCiteDeep(v) {
  if (typeof v === "string") return cleanCite(v);
  if (Array.isArray(v)) return v.map(cleanCiteDeep);
  if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = cleanCiteDeep(v[k]); return o; }
  return v;
}
/* 表示用: 全角英数字・記号→半角、全角スペース→半角、連続スペースを1つに整える(履歴などの見栄え統一) */
const dispText = s => String(s == null ? "" : s)
  .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))   // 全角ASCII(英数字・記号)→半角
  .replace(/　/g, " ").replace(/\s+/g, " ").trim();
/* ボタンの処理中表示: メカ君アイコンを回しつつ「考え中…」に。完了でsetBtnLoading(btn,false) */
function setBtnLoading(btn, on, label) {
  if (!btn) return;
  if (on) {
    if (!btn.dataset.orig) btn.dataset.orig = btn.innerHTML;
    btn.disabled = true; btn.classList.add("btnLoading");
    btn.innerHTML = '<img src="img/thinking.png" class="btnMecha spin" alt="">' + (label || "メカ君が考え中…");
  } else {
    btn.disabled = false; btn.classList.remove("btnLoading");
    if (btn.dataset.orig) { btn.innerHTML = btn.dataset.orig; delete btn.dataset.orig; }
  }
}

/* ================= メーカーリコールリンク(2026-06検証済) ================= */
const MAKER_RECALL = {
  isuzu:  { label: "いすゞ自動車 リコール検索",   url: "https://www.isuzu.co.jp/recall/input" },
  hino:   { label: "日野自動車 リコール情報",     url: "https://www.hino.co.jp/recall/" },
  fuso:   { label: "三菱ふそう リコール情報",     url: "https://www.mitsubishi-fuso.com/ja/news-recall/recall-information/" },
  ud:     { label: "UDトラックス リコール関連情報", url: "https://www.udtrucks.com/japan/recall-info" },
  nissan: { label: "日産自動車 リコール検索",     url: "https://www.nissan.co.jp/RECALL/" },
  toyota: { label: "トヨタ リコール検索",         url: "https://toyota.jp/recall/" },
  honda:  { label: "ホンダ リコール検索",         url: "https://www.honda.co.jp/recall/" },
  mazda:  { label: "マツダ リコール情報",         url: "https://www2.mazda.co.jp/service/recall/" },
  suzuki: { label: "スズキ リコール情報",         url: "https://www.suzuki.co.jp/recall/" },
  daihatsu:{ label: "ダイハツ リコール情報",      url: "https://www.daihatsu.co.jp/info/recall/" },
  subaru: { label: "スバル リコール検索",         url: "https://www.subaru.co.jp/recall/" },
};
const MLIT_RECALL = "https://renrakuda.mlit.go.jp/renrakuda/recall-search.html";

/* ================= 車両DB ================= */
let BUILTIN_DB = [];
let CUSTOM_DB = [];   // {id,name,match,maker,faults[],checks[],notes}

function loadCustomDB() {
  try { CUSTOM_DB = JSON.parse(localStorage.getItem(LS.custom)) || []; }
  catch (e) { CUSTOM_DB = []; }
}
function saveCustomDB() { localStorage.setItem(LS.custom, JSON.stringify(CUSTOM_DB)); }
// 端末上でアカウントが切り替わった時(cloud.jsから呼ぶ)に、前アカウントのローカルデータを消す。
// これをしないと、ログイン時のuploadLocalで前アカウントの履歴・車種DBが新アカウントのクラウドに混入する。
window.clearLocalUserData = function () {
  try {
    localStorage.removeItem(LS.hist);            // スキャン履歴・整備カルテ
    localStorage.removeItem(LS.custom);          // カスタム車種DB
    localStorage.removeItem("ss_learnedspecs");  // AIが学習した諸元
    localStorage.removeItem("ss_katacache");     // 型式キャッシュ
    localStorage.removeItem("ss_intakeFilter");  // 入庫フィルタ
    CUSTOM_DB = [];                              // メモリ上の車種DBも空に(uploadLocalが参照するため必須)
  } catch (e) {}
  try { renderHistory(); } catch (e) {}
  try { renderDBList(); } catch (e) {}
};

async function loadBuiltinDB() {
  if (localStorage.getItem("ss_dbcleared") === "1") { BUILTIN_DB = []; return; }
  try {
    const res = await fetch("db/vehicles.json");
    BUILTIN_DB = (await res.json()).vehicles || [];
  } catch (e) { BUILTIN_DB = []; }
}
/* カスタム(同名は内蔵を上書き)→内蔵 の順で検索対象を構成 */
function mergedDB() {
  const customNames = new Set(CUSTOM_DB.map(v => v.name));
  return [...CUSTOM_DB, ...BUILTIN_DB.filter(v => !customNames.has(v.name))];
}
function findVehicle(typeCode) {
  for (const v of mergedDB()) {
    try { if (new RegExp(v.match, "i").test(typeCode)) return v; } catch (e) {}
  }
  return null;
}
/* 内蔵DBのみ検索(車種名の権威ソース。自動保存したカスタムレコードへの自己ヒットを避ける) */
function findBuiltinVehicle(typeCode) {
  for (const v of BUILTIN_DB) {
    try { if (new RegExp(v.match, "i").test(typeCode)) return v; } catch (e) {}
  }
  return null;
}

/* =========================================================
   QRパーサ — 国交省「二次元コード項目定義」(2023.1版)準拠
   区切り: "/"。二次元コード2(=2分割), 3(=3分割)。
   [二次元コード2] 1:バージョン 2:登録番号(全角) 3:標板コード
                   4:車台番号 5:原動機型式 6:帳票種別
   [二次元コード3] 1:バージョン 2:打刻位置 3:型式指定番号類別区分番号
                   4:有効期間満了日(YYMMDD/999999) 5:初度登録年月(YYMM/9999)
                   6:型式 7-10:軸重 11:騒音規制 12:近接排気騒音
                   13:駆動方式 14:オパシ 15:NOxPMモード 16:NOx 17:PM
                   18:保安基準適用年月日 19:燃料コード
   物理QRは分割印字のため、読取順に連結して再構成する。
   ========================================================= */

function reconstructCodes(payloadList) {
  // 各payloadが "数字/" で始まれば新コードの先頭、そうでなければ直前の続き
  const codes = [];
  for (const p of payloadList) {
    if (/^\d\//.test(p) || codes.length === 0) codes.push(p);
    else codes[codes.length - 1] += p;
  }
  // 連結順が逆だった場合の救済: フィールド数が合わなければ結合順を変えた候補も返す
  return codes;
}

const zen2han = s => s.replace(/[Ａ-Ｚａ-ｚ０-９]/g,
  c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, " ");

/* フィラー(埋め草)判定: 車検証二次元コードは非該当フィールドを 9999… / 0000… / **** 等で埋める。
   同一文字の連続(長さ4以上)は「未設定」とみなし、正しい値の位置に誤って固定されるのを防ぐ */
function isFiller(v) {
  if (!v) return true;
  const t = String(v).replace(/[\s\-\[\]]/g, "");
  if (t.length < 4) return false;
  return /^(.)\1+$/.test(t) || /^\*+$/.test(t);   // 9999999 / 0000000 / AAAAA / ***** など
}
/* 登録番号(ナンバー)の妥当性: 地名(漢字/かな)＋分類番号＋かな＋一連番号。数字のみ/記号のみは不可 */
function isValidPlate(v) {
  if (!v) return false;
  const t = String(v).trim();
  if (!t) return false;
  if (/^[\d\s\-ー－]+$/.test(t)) return false;          // 数字(と区切り)だけはナンバーではない
  return /[぀-ヿ゠-ヿ㐀-鿿一-龠]/.test(t);              // 地名(漢字)またはかなを含むこと
}

function parseYYMMDD(s) {
  if (!s || !/^\d{6}$/.test(s) || s === "999999") return null;
  const yy = +s.slice(0, 2), mm = +s.slice(2, 4), dd = +s.slice(4, 6);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const year = 2000 + yy; // 電子車検証制度上、有効期限が19xxはあり得ない
  return new Date(year, mm - 1, dd);
}
function parseYYMM(s) {
  if (!s || !/^\d{4}$/.test(s) || s === "9999") return null;
  const yy = +s.slice(0, 2), mm = +s.slice(2, 4);
  if (mm < 1 || mm > 12) return null;
  const now = new Date();
  // 下2桁の世紀補完: 今年+1より先なら19xx (旧車対応)
  const year = (2000 + yy <= now.getFullYear() + 1) ? 2000 + yy : 1900 + yy;
  return { year, month: mm };
}
const fmtDate = d => d ? `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}` : null;
/* 指定・類別の表示整形: 現行=9桁(5-4)/旧=7桁(5-2)/大型・特装・輸入=記載なし(空) */
function formatKata(k) {
  if (!k) return null;
  const s = String(k).replace(/[^0-9]/g, "");
  if (!s) return null;
  if (s.length >= 8) return s.slice(0, s.length - 4) + "-" + s.slice(s.length - 4); // 型式指定番号-類別区分番号(4桁)
  if (s.length >= 6) return s.slice(0, s.length - 2) + "-" + s.slice(s.length - 2); // 旧車: 類別2桁
  return s;
}

function parseStructured(codes) {
  const out = {};
  for (const code of codes) {
    const f = code.split("/").map(s => s.trim());
    if (f.length < 2 || !/^\d$/.test(f[0])) continue;

    // 二次元コード3 (19フィールド): 型式・満了日・初度登録
    if (f.length >= 17) {
      const kata = f[2] && /^\d{5,10}$/.test(f[2]) && !isFiller(f[2]) ? f[2] : null;
      if (kata) out.kataShitei = kata;
      const exp = parseYYMMDD(f[3]);
      if (exp) out.expiry = exp;
      const first = parseYYMM(f[4]);
      if (first) out.firstReg = first;
      const type = zen2han(f[5] || "").toUpperCase();
      if (type && !type.startsWith("*")) out.type = type;
      const fuel = f[18] || f[f.length - 1];
      if (/^\d{2}$/.test(fuel)) out.fuelCode = fuel;
      out.structured = true;
    }
    // 二次元コード2 (6フィールド): 登録番号・車台番号・原動機型式
    else if (f.length >= 5 && f.length <= 7) {
      const plateRaw = (f[1] || "").replace(/[　 ]+/g, " ").trim();
      if (isValidPlate(plateRaw)) out.plate = plateRaw;   // 地名(漢字/かな)を含むもののみ。数字のみは不可
      const vin = zen2han(f[3] || "").toUpperCase();
      if (/^[A-Z0-9\[\]\-]{4,23}$/.test(vin) && !isFiller(vin)) out.vin = vin;
      // f[4] = 原動機型式 (位置で確定。空欄/伏字/純数字の帳票種別・フィラーは除外)
      const eng = zen2han(f[4] || "").toUpperCase().trim();
      if (eng && !eng.startsWith("*") && /^[A-Z0-9\-]{2,10}$/.test(eng) && !/^\d+$/.test(eng) && !isFiller(eng)) out.engine = eng;
      out.structured = true;
    }
  }
  return out;
}

/* ---- 従来ヒューリスティック(維持・フォールバック) ----
   exclude: 原動機型式など「型式候補にしてはいけない」値の集合 */
function parseHeuristic(fields, exclude = new Set()) {
  let type = null, vin = null, plate = null, engine = null;
  for (const f of fields) {
    const u = zen2han(f).toUpperCase();
    if (!vin && /^[A-Z0-9]{2,8}-[0-9]{5,8}$/.test(u)) { vin = u; continue; }
    // ハイフン付き型式(排ガス記号-車種記号)は型式として確実(エンジン型式と紛れない)
    if (!type && /^[0-9A-Z]{2,4}-[A-Z][A-Z0-9]{2,8}$/.test(u) && !/^[0-9]+$/.test(u.split("-")[1])) { type = u; continue; }
    if (!plate && /[぀-ヿ㐀-鿿]/.test(f) && f.length <= 12) { plate = f; continue; }
    // 単独の短い英数字コード(K6A / EF / 3SZ 等)は原動機型式とみなす。
    // ※ 型式(車種)には入れない → 型式は車台番号の接頭辞 or コード3で確定させる(原動機型式の誤混入を防止)
    if (!engine && !exclude.has(u) && /^[A-Z0-9]{2,7}$/.test(u) && /[A-Z]/.test(u) && !/^\d+$/.test(u)) { engine = u; continue; }
  }
  return { type, vin, plate, engine };
}

function parsePayloads(payloadSet) {
  const list = [...payloadSet];
  const codes = reconstructCodes(list);
  const s = parseStructured(codes);

  const rawFields = [];
  list.forEach(p => p.split("/").forEach(f => { f = f.trim(); if (f) rawFields.push(f); }));
  const uniq = [...new Set(rawFields)];
  // 型式・車台番号・原動機型式(確定済み)はヒューリスティックの再判定から除外
  const exclude = new Set([s.engine, s.vin, s.type].filter(Boolean).map(x => zen2han(x).toUpperCase()));
  const h = parseHeuristic(uniq, exclude);

  // 型式は コード3(f[5]) 優先 → 無ければ車台番号の接頭辞(例 MK21S-149973 → MK21S) → ハイフン付き型式
  const vinVal = s.vin || h.vin || null;
  const vinPref = vinVal ? (vinVal.match(/^([A-Z0-9]{2,8})-\d{3,8}$/) || [])[1] : null;
  let type   = s.type || vinPref || h.type || null;
  let engine = s.engine || h.engine || null;
  // 誤混入是正: 原動機型式が型式欄に入っていたら車台番号接頭辞へ差し替え(無ければ空)
  if (type && engine && type === engine) type = vinPref || null;

  return {
    type:     type,
    vin:      vinVal,
    plate:    s.plate  || h.plate  || null,
    engine:   engine,
    expiry:   s.expiry || null,
    firstReg: s.firstReg || null,
    kataShitei: s.kataShitei || null,
    structured: !!s.structured,
    raw: uniq,
  };
}

/* ================= スキャン(ライブ/写真) ================= */
const payloads = new Set();
const video = $("video");
const cv = document.createElement("canvas"), ctx = cv.getContext("2d", { willReadFrequently: true });

/* QR解読: ZXing(ピンボケ・低コントラストに強い)優先 → jsQR フォールバック */
let zxReader = null, zxHints = null;
if (typeof ZXing !== "undefined") {
  try {
    zxHints = new Map(); zxHints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    zxReader = new ZXing.QRCodeReader();
  } catch (e) { zxReader = null; }
}
function decodeCanvas(canvas) {
  if (zxReader) {
    try {
      const lum = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
      const bb = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum));
      const r = zxReader.decode(bb, zxHints);
      if (r && r.getText()) return r.getText();
    } catch (e) {}
  }
  try {
    const id = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(id.data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" });
    if (code && code.data) return code.data;
  } catch (e) {}
  return null;
}
/* かすれ・低コントラストのQR向け: グレースケール+コントラスト強調(自動レベル補正) */
function boostContrast(canvas) {
  const c = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
  const id = c.getImageData(0, 0, w, h), d = id.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; d[i] = d[i + 1] = d[i + 2] = y; if (y < lo) lo = y; if (y > hi) hi = y; }
  const range = Math.max(1, hi - lo); const gain = 255 / range;
  // 5〜95パーセンタイル的に締めるのではなく、min-max を 0-255 に線形伸張(軽量)
  for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, Math.min(255, (d[i] - lo) * gain)); d[i] = d[i + 1] = d[i + 2] = v; }
  c.putImageData(id, 0, 0);
}

/* ===== ライブ連続スキャン: QRと文字(OCR)を同時に自動認識して蓄積 ===== */
let scanComplete = false;   // 直前に車両を確定表示したか(次の開始で新規)
let liveStream = null, scanning = false, scanRaf = null, tickBusy = false, tickN = 0, lastHitAt = 0, scanOkPending = false;
let scanStartAt = 0;   // スキャン開始時刻(開始直後に重い処理を走らせないため)

/* 統合アキュムレータ: QR・OCR・手動のどれからでも項目を埋めていく */
function freshAcc() { return { type: null, vin: null, engine: null, plate: null, expiry: null, firstReg: null, kataShitei: null, rid: null, raw: [] }; }
let acc = freshAcc();
function mergeAcc(d) {
  // 読み取り順に依存せず、正しい値を採用する:
  //  ・フィラー(9999999等)は取り込まない  ・既存がフィラーなら実値で上書き
  const fillable = new Set(["type", "vin", "engine", "plate", "kataShitei"]);
  for (const k of ["type", "vin", "engine", "plate", "expiry", "firstReg", "kataShitei"]) {
    const nv = d[k];
    if (!nv) continue;
    const isStr = typeof nv === "string";
    if (fillable.has(k) && isStr && isFiller(nv)) continue;                 // フィラーは無視
    if (k === "plate" && !isValidPlate(nv)) continue;                       // 登録番号は数字のみ不可(地名を含むこと)
    if (!acc[k] || (fillable.has(k) && typeof acc[k] === "string" && isFiller(acc[k]))) acc[k] = nv;  // 空 or 既存フィラーなら採用
  }
  if (d.rid && !acc.rid) acc.rid = d.rid;   // 表示中の車両IDを引き継ぐ(同じ車として追記・別レコード化を防ぐ)
  if (d.raw) { const s = new Set(acc.raw); d.raw.forEach(x => x && s.add(x)); acc.raw = [...s]; }
}
function accCode3() { return !!(acc.kataShitei || acc.type); } // コード3(指定・類別)を取得済みか
function accComplete() { return !!(acc.vin && acc.engine); } // 車台番号＋原動機型式が揃えば完了
function accResult() { return { ...acc, rid: acc.rid || null, raw: acc.raw.length ? acc.raw : [acc.type, acc.engine, acc.vin, acc.plate].filter(Boolean), qrRaw: [...payloads] }; }
function resetScan() { payloads.clear(); acc = freshAcc(); scanComplete = false; scanOkPending = false; tickBusy = false; nativeBusy = false; lastScanProc = 0; lastNewDataAt = Date.now(); lastOcrAt = 0; lastOcrCand = { type: null, vin: null }; if (typeof scanGrace !== "undefined" && scanGrace) { clearTimeout(scanGrace); scanGrace = null; } toggle("scanOK", false); }

$("btnStart").addEventListener("click", startLiveScan);
/* 再スキャン: 状態を初期化しカメラを開き直す(検出が固まった時の確実な復帰手段) */
async function rescanNow() {
  resetScan();
  updateScanProgress(acc);
  toggle("scanProgress", false); toggle("scanActions", false); toggle("qrPhotoStatus", false);
  if (!scanning) { startLiveScan(); return; }
  // スキャン中でもカメラを開き直してピント(AF)・検出状態を初期化 → 失敗後に読めなくなるのを防ぐ
  setScanMsg("カメラを再初期化中…ピントを合わせています");
  nativeBusy = false; tickBusy = false; ocrBusy = false;   // 固まったフラグを解除
  await openCamera(null);
  setScanMsg("再スキャン中: QRを枠内に大きく・はっきり写してください");
}
$("btnStop").addEventListener("click", rescanNow);
$("scanBack").addEventListener("click", goHome);   // スキャン中の「戻る」→ ホームへ

let camList = [], camIdx = 0;

async function startLiveScan() {
  resetScan();   // 新規スキャンは必ず状態を初期化(固まったフラグ・前回データの持ち越しを防ぐ)
  const ok = await openCamera(null);
  if (!ok) {
    toggle("qrPhotoStatus", true);
    $("qrPhotoStatus").innerHTML = "カメラを起動できませんでした（権限・対応状況をご確認ください）。<br>下の「写真で1枚ずつ撮影」もお試しください。";
    return;
  }
  toggle("scanWrap", true); toggle("scanCtrls", true); toggle("btnStart", false); toggle("btnStop", true); toggle("btnStopRow", true);
  toggle("scanActions", true);
  toggle("mechaHero", false); document.body.classList.add("scanningNow");   // スキャン中はメカ君を隠しカメラを画面中央へ
  updateScanProgress(acc);
  setScanMsg("自動で読み取り中… 車検証のQRを枠内に大きく写してください");
  scanning = true; tickBusy = false; tickN = 0;
  scanStartAt = Date.now(); lastOcrAt = Date.now();   // 開始直後は重いOCRを走らせない(固まり防止)
  scanTick();
}

/* カメラを開く(deviceId指定可)。AF/ズーム/ライト/レンズ一覧を設定 */
async function openCamera(deviceId) {
  if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
  // 指定が無ければ、前回ユーザーが選んだ「接写に強いレンズ」を優先(ラベルで照合)。
  // これで機種ごとに毎回カメラ切替をしなくて済む。初回は環境カメラ(背面)を使う。
  if (!deviceId) {
    try {
      const savedLabel = localStorage.getItem("ss_camLabel");
      if (savedLabel) {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const m = devs.find(d => d.kind === "videoinput" && d.label === savedLabel);
        if (m) deviceId = m.deviceId;
      }
    } catch (e) {}
  }
  const base = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode: { ideal: "environment" } };
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ video: { ...base, width: { ideal: 2560 }, height: { ideal: 1440 } } });
  } catch (e) {
    try { liveStream = await navigator.mediaDevices.getUserMedia({ video: base }); }
    catch (e2) { return false; }
  }
  video.srcObject = liveStream; try { await video.play(); } catch (e) {}
  const track = liveStream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  // 連続AF
  try { if (caps.focusMode && caps.focusMode.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (e) {}
  // ズームスライダー(対応端末のみ)
  const zw = $("zoomWrap"), zs = $("zoomSlider");
  if (caps.zoom && caps.zoom.max > (caps.zoom.min || 1)) {
    zs.min = caps.zoom.min || 1; zs.max = caps.zoom.max; zs.step = caps.zoom.step || 0.1;
    const cur = (track.getSettings && track.getSettings().zoom) || caps.zoom.min || 1;
    zs.value = cur; toggle("zoomWrap", true);
  } else toggle("zoomWrap", false);
  // ライト
  toggle("btnTorch", !!caps.torch);
  // 背面レンズ一覧(初回のみ。Samsung等は超広角が近接に強い)
  if (!camList.length) {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cams = devs.filter(d => d.kind === "videoinput");
      // 内側(フロント)カメラは使わないので除外。ラベルで判別できない場合は全て残す
      const backs = cams.filter(d => !/front|face|user|内|前面|selfie/i.test(d.label || ""));
      camList = backs.length ? backs : cams;
      const cur = track.getSettings ? track.getSettings().deviceId : null;
      const i = camList.findIndex(d => d.deviceId === cur); if (i >= 0) camIdx = i;
    } catch (e) {}
  }
  toggle("btnCamSwitch", camList.length > 1);
  return true;
}

/* カメラ(レンズ)切替: 近接で合わない時は別レンズへ */
$("btnCamSwitch").addEventListener("click", async () => {
  if (camList.length < 2) return;
  camIdx = (camIdx + 1) % camList.length;
  setScanMsg("カメラを切り替えました（" + (camIdx + 1) + "/" + camList.length + "）…ピントを確認");
  const ok = await openCamera(camList[camIdx].deviceId);
  if (ok) {
    // 選んだレンズを記憶(次回から自動でこのレンズを使う=毎回の切替が不要に)
    try { const lbl = camList[camIdx].label || (liveStream.getVideoTracks()[0] || {}).label; if (lbl) localStorage.setItem("ss_camLabel", lbl); } catch (e) {}
  } else setScanMsg("このカメラは使えませんでした。もう一度切替を");
});

/* ズーム調整 */
$("zoomSlider").addEventListener("input", async () => {
  if (!liveStream) return;
  try { await liveStream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: parseFloat($("zoomSlider").value) }] }); } catch (e) {}
});

/* タップでピント合わせ(対応端末) */
video.addEventListener("click", async () => {
  if (!liveStream) return;
  try {
    const track = liveStream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes("single-shot")) {
      await track.applyConstraints({ advanced: [{ focusMode: "single-shot" }] });
      setScanMsg("ピント調整中…");
      setTimeout(() => {
        if (scanning && caps.focusMode.includes("continuous"))
          track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
      }, 1500);
    }
  } catch (e) {}
});

function stopLiveScan(show) {
  scanning = false;
  if (scanRaf) cancelAnimationFrame(scanRaf);
  if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
  // 解析用の重いリソースを解放(iOSのメモリ上限で画面が固まるのを防ぐ)
  releaseOcrWorker();
  try { cv.width = cv.height = 1; ocrCv.width = ocrCv.height = 1; } catch (e) {}
  toggle("scanWrap", false); toggle("scanCtrls", false); toggle("btnStart", true); toggle("btnStop", false); toggle("btnStopRow", false); toggle("btnTorch", false);
  document.body.classList.remove("scanningNow");   // カメラ中央表示を解除
  if (show && (acc.type || acc.vin || acc.plate || acc.engine)) { scanComplete = true; showResult(accResult(), { fromScan: true }); }
  else { toggle("mechaHero", true); toggle("scanProgress", false); toggle("scanActions", false); toggle("qrPhotoStatus", false); }   // キャンセル時はメカ君を戻し進捗・やり直しを閉じる
}
const setScanMsg = t => setText("scanMsg", t);

/* ライト切替 */
$("btnTorch").addEventListener("click", async () => {
  if (!liveStream) return;
  const track = liveStream.getVideoTracks()[0];
  const on = !track.__torch;
  try { await track.applyConstraints({ advanced: [{ torch: on }] }); track.__torch = on; $("btnTorch").style.opacity = on ? "1" : ".55"; } catch (e) {}
});

/* QR検出時 */
function onLiveQr(data) {
  if (!data || payloads.has(data)) return;   // 同じQRの再読は無視(進捗にならない)
  payloads.add(data);
  lastNewDataAt = Date.now();   // 新しいQRを取得 → 進捗あり(直後は少しZXingを休ませる)
  if (navigator.vibrate) navigator.vibrate(50);
  flashScan();   // 読み取れた瞬間に緑フラッシュ(見える化)
  mergeAcc(parsePayloads(payloads));
  afterScanUpdate("QR");
}
/* 文字(OCR)検出時。壁の模様・影などの誤検出を防ぐため、
   同じ値が2回連続で読めた項目だけを採用する(1回だけの値は捨てる)。QRは正確なので対象外。 */
let lastOcrCand = { type: null, vin: null };
function onLiveText(d) {
  const use = {};
  if (d.type && d.type === lastOcrCand.type) use.type = d.type;   // 前回と一致した型式のみ採用
  if (d.vin && d.vin === lastOcrCand.vin) use.vin = d.vin;        // 前回と一致した車台番号のみ採用
  lastOcrCand = { type: d.type || null, vin: d.vin || null };
  if (!use.type && !use.vin) return;                              // 初回や不一致(ノイズ)は無視
  const before = acc.type + "|" + acc.vin + "|" + acc.engine;
  mergeAcc(use);
  if (acc.type + "|" + acc.vin + "|" + acc.engine !== before) {
    if (navigator.vibrate) navigator.vibrate(40);
    flashScan();
    afterScanUpdate("文字");
  }
}
/* 読み取れた瞬間に緑フラッシュ(端末差に依存せず「今読めた」を明示) */
function flashScan() {
  const el = $("scanFlash"); if (!el) return;
  el.classList.remove("hit"); void el.offsetWidth; el.classList.add("hit");
}
let scanGrace = null;
/* サッと1パスで確定: 全項目そろえば即、車両を識別できれば短い猶予で残りを拾って確定 */
function finalizeScan() {
  if (scanOkPending) return;
  if (!acc.vin) return;   // 車台番号が無ければ「✓完了」を出さない(誤OK防止の最後の砦)
  scanOkPending = true; scanning = false;
  if (scanGrace) { clearTimeout(scanGrace); scanGrace = null; }
  setScanMsg("✓ 読み取り完了");
  toggle("scanOK", true);
  if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
  setTimeout(() => { toggle("scanOK", false); scanOkPending = false; stopLiveScan(true); }, 550);  // OKをサッと見せて即表示
}
function afterScanUpdate(src) {
  updateScanProgress(acc);
  // 全項目そろえば即確定(両QRが1フレームに入れば一瞬)
  if (accComplete()) { finalizeScan(); return; }
  // 安定化: 確実な読取である「車台番号(コード2)」を基準に確定。型式だけの曖昧な状態では完了しない。
  if (acc.vin) {
    setScanMsg("✓ 読み取り中… そのままかざしてください");
    // 車台番号が取れたら短い猶予で残りQR(型式コード3)も拾って確定
    if (!scanGrace) scanGrace = setTimeout(() => { scanGrace = null; if (scanning && acc.vin) finalizeScan(); }, 500);
    return;
  }
  // 型式のみ(コード3先読み)の場合は、車台番号(コード2)を必須として待ち続ける。
  // ここで勝手に完了させない → 車台番号 未検出のまま「✓読み取り完了」を出さないため(誤OK防止)。
  if (acc.type) {
    setScanMsg("あと少し: 車台番号側の二次元コード(コード2)も枠に入れてください");
    return;
  }
  setScanMsg("QRを枠内に大きく写してください");
}

let lastScanProc = 0, nativeBusy = false, lastNewDataAt = 0;
async function scanTick() {
  if (!scanning) return;
  const ready = video.readyState >= 2 && video.videoWidth;
  // ① ネイティブ検出(BarcodeDetector=端末カメラと同じエンジン) → かざした瞬間に読める。
  //    一部端末でdetect()のPromiseが返らず固まる対策として700msでタイムアウト。
  //    ※nativeDetectorは殺さない(次フレームで再挑戦)。固まっても下の②ZXingが確実に拾う。
  // ネイティブ検出は毎フレーム全力で回す(精度最優先)。nativeBusyで多重起動は防いでおり負荷は増えない。
  if (ready && nativeDetector && !nativeBusy) {
    nativeBusy = true;
    Promise.race([
      nativeDetector.detect(video),
      new Promise((_, rej) => setTimeout(() => rej(0), 700)),
    ])
      .then(codes => { if (scanning && codes && codes.length) codes.forEach(c => onLiveQr(c.rawValue)); })
      .catch(() => {})            // タイムアウト/失敗は無視(nativeは残す)
      .finally(() => { nativeBusy = false; });
  }
  // ② ZXing/jsQR(重い同期解析)は保険。ネイティブが使える端末では「進捗が1.2秒止まった時だけ」に絞る。
  //    常時走らせるとメインスレッドを塞ぎ、スキャン開始直後に画面が固まるため。
  const zxWait = nativeDetector ? 800 : 400;   // ネイティブで読めない難QRに、少し早く高精度ZXingを併走させる
  const zxThrottle = nativeDetector ? 350 : 200;
  if (ready && !tickBusy && Date.now() - lastScanProc >= zxThrottle && Date.now() - lastNewDataAt > zxWait) {
    lastScanProc = Date.now(); tickBusy = true; tickN++;
    const vw = video.videoWidth, vh = video.videoHeight;
    try {
      const cropF = (tickN % 2 === 0) ? 0.75 : 0.55;
      const s = Math.floor(Math.min(vw, vh) * cropF);
      cv.width = s; cv.height = s;
      ctx.drawImage(video, (vw - s) >> 1, (vh - s) >> 1, s, s, 0, 0, s, s);
      let dt = decodeCanvas(cv);
      // 高解像度パス(最も重い)。この②ブロック自体がネイティブ機では「2秒読めない時だけ」なので、
      // 発動時は全端末で本気を出して難しいQRを拾う(=精度向上)。iOSのみ解像度は控えめに。
      if (!dt) {
        const cap = IS_IOS ? 1280 : 1920, sc = Math.min(1, cap / Math.max(vw, vh));
        const w = Math.round(vw * sc), h = Math.round(vh * sc);
        cv.width = w; cv.height = h; ctx.drawImage(video, 0, 0, w, h);
        dt = decodeCanvas(cv);
      }
      if (!dt && tickN % 2 === 0) {   // コントラスト強調(全画素ループ)も発動時は全端末で実行
        const s2 = Math.floor(Math.min(vw, vh) * 0.75);
        cv.width = s2; cv.height = s2;
        ctx.drawImage(video, (vw - s2) >> 1, (vh - s2) >> 1, s2, s2, 0, 0, s2, s2);
        boostContrast(cv);
        dt = decodeCanvas(cv);
      }
      if (dt) onLiveQr(dt);
    } catch (e) {}
    tickBusy = false;
  }
  // ③ 券面OCR(型式・車台番号の印字補完): 約2.2秒に1回、別スレッドで
  // 券面OCRはメインスレッドで重い前処理(全画素ループ)を伴うため、
  // ①開始から5秒間は動かさない ②QRで既に確定できていれば動かさない → 開始直後の固まりを防ぐ
  if (ready && !accComplete() && Date.now() - scanStartAt > 5000 &&
      Date.now() - lastOcrAt > (IS_IOS ? 3500 : 2600) && !ocrBusy) {
    lastOcrAt = Date.now(); ocrBusy = true;
    const oc = grabOcrFrame(video.videoWidth, video.videoHeight);
    getOcrWorker().then(w => w.recognize(oc)).then(({ data }) => {
      if (!scanning) return;
      const d = extractFromOcrText(data.text || "");
      if (d.type || d.vin) onLiveText(d);
    }).catch(() => {}).finally(() => { ocrBusy = false; });
  }
  scanRaf = requestAnimationFrame(scanTick);
}

/* ===== ライブOCR用: フレーム切り出し + 前処理(グレースケール+大津二値化) ===== */
const ocrCv = document.createElement("canvas"), ocrCtx = ocrCv.getContext("2d", { willReadFrequently: true });
let ocrWorker = null, ocrWorkerReady = null, ocrBusy = false, lastOcrAt = 0;
/* iOS(Safari)はBarcodeDetector非対応で常に重いZXing経路になり、タブのメモリ上限も厳しい。
   解析解像度を落とし、使い終わったOCRワーカーを解放して「画面が固まる」を防ぐ。 */
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
/* ライブスキャン終了時にTesseractワーカーを解放(常駐するとメモリを圧迫し続ける) */
function releaseOcrWorker() {
  const w = ocrWorker; ocrWorker = null; ocrWorkerReady = null; ocrBusy = false;
  if (w && w.terminate) { try { w.terminate(); } catch (e) {} }
}

function grabOcrFrame(vw, vh) {
  // 中央の横長帯(型式・車台番号の行が来やすい)を高解像度で取り、前処理して返す
  const sw = Math.floor(vw * 0.92), sh = Math.floor(vh * 0.55);
  const sx = (vw - sw) >> 1, sy = (vh - sh) >> 1;
  const targetW = IS_IOS ? 1100 : 1500, sc = targetW / sw;   // iOSはメモリ節約のため縮小
  ocrCv.width = targetW; ocrCv.height = Math.round(sh * sc);
  ocrCtx.drawImage(video, sx, sy, sw, sh, 0, 0, ocrCv.width, ocrCv.height);
  return preprocessOcr(ocrCv);
}
/* グレースケール + 大津の二値化(印字テキストのOCR精度を上げる) */
function preprocessOcr(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const id = srcCanvas.getContext("2d").getImageData(0, 0, w, h);
  const g = new Uint8ClampedArray(w * h), hist = new Array(256).fill(0);
  for (let i = 0, j = 0; i < id.data.length; i += 4, j++) {
    const y = (id.data[i] * 0.299 + id.data[i + 1] * 0.587 + id.data[i + 2] * 0.114) | 0;
    g[j] = y; hist[y]++;
  }
  const total = w * h; let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; thr = t; }
  }
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const octx = out.getContext("2d"), oid = octx.createImageData(w, h);
  for (let j = 0, k = 0; j < g.length; j++, k += 4) {
    const v = g[j] > thr ? 255 : 0;
    oid.data[k] = oid.data[k + 1] = oid.data[k + 2] = v; oid.data[k + 3] = 255;
  }
  octx.putImageData(oid, 0, 0);
  return out;
}
function getOcrWorker() {
  if (ocrWorkerReady) return ocrWorkerReady;
  ocrWorkerReady = (async () => {
    await loadTesseract();
    const w = await Tesseract.createWorker("eng", 1); // 型式・車台番号は英数 → engが高精度
    try { await w.setParameters({ tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-", tessedit_pageseg_mode: "6" }); } catch (e) {}
    ocrWorker = w; return w;
  })();
  return ocrWorkerReady;
}

/* 写真フォールバック (カメラ不可端末用。1枚ずつ撮影して蓄積) */
$("qrPhotoIn").addEventListener("change", async e => {
  const file = e.target.files[0]; $("qrPhotoIn").value = "";
  if (!file) return;
  if (scanComplete) resetScan();
  toggle("qrPhotoStatus", true); $("qrPhotoStatus").textContent = "画像を解析中…";
  try {
    const before = payloads.size;
    (await decodePhotoQR(file)).forEach(c => payloads.add(c));
    const added = payloads.size - before;
    mergeAcc(parsePayloads(payloads));
    updateScanProgress(acc); toggle("scanActions", acc.type || acc.vin || acc.plate);
    if (accComplete()) { scanComplete = true; showResult(accResult(), { fromScan: true }); }
    else if (added === 0) $("qrPhotoStatus").innerHTML = "QRを検出できませんでした。1つのQRが<b>画面いっぱい</b>になるまで近づけて撮影してください。";
    else {
      const need = [!acc.type && "型式", !acc.vin && "車台番号"].filter(Boolean).join("・");
      $("qrPhotoStatus").textContent = "✓ " + added + "件読取。続けて" + (need ? "「" + need + "」の" : "別の") + "QRを撮影してください。";
    }
  } catch (err) { $("qrPhotoStatus").textContent = "読み取りエラー: " + (err.message || err); }
});

/* 読み取り済み項目の進捗表示 */
function updateScanProgress(d) {
  const box = $("scanProgress");
  const items = [
    ["車台番号", d.vin], ["原動機型式", d.engine], ["登録番号", d.plate], ["指定・類別", formatKata(d.kataShitei)],
  ];
  box.innerHTML = items.map(([label, val]) =>
    '<div class="progRow ' + (val ? "got" : "") + '">' +
    '<span class="progIco">' + (val ? "✓" : "○") + '</span>' +
    '<span class="progLabel">' + label + '</span>' +
    '<span class="progVal">' + (val ? esc(String(val)) : "未取得") + '</span></div>'
  ).join("");
  toggle("scanProgress", true);
}

function loadImageEl(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("画像を読み込めませんでした")); };
    im.src = url;
  });
}

/* 1枚の写真からQRを抽出して配列で返す(純関数。グローバルは触らない) */
async function decodePhotoQR(file) {
  const out = new Set();
  // ① ネイティブ検出 (Android Chrome): 1枚で複数QRを一度に取得
  if (nativeDetector) {
    try {
      const bmp = await createImageBitmap(file);
      const codes = await nativeDetector.detect(bmp);
      if (bmp.close) bmp.close();
      codes.forEach(c => { if (c.rawValue) out.add(c.rawValue); });
      if (out.size) return [...out];
    } catch (e) {}
  }
  // ② jsQR (iPhone等): 複数QRが1枚に並ぶと全体スキャンは失敗するため、
  //    タイル分割して各領域を個別に読む
  const img = await loadImageEl(file);
  const W = img.width, H = img.height;
  // スキャン対象領域: 全体 + 3x2のオーバーラップタイル + 左右半分(QRが横一列の車検証向け)
  const regions = [[0, 0, W, H], [0, 0, W / 2, H], [W / 2, 0, W / 2, H]];
  const cols = 3, rows = 2, ov = 0.5;
  const tw = W / cols, th = H / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const sx = Math.max(0, c * tw - tw * ov * 0.5);
    const sy = Math.max(0, r * th - th * ov * 0.5);
    regions.push([sx, sy, Math.min(W - sx, tw * (1 + ov)), Math.min(H - sy, th * (1 + ov))]);
  }
  const cap = 1400;
  for (const [sx, sy, sw, sh] of regions) {
    const sc = Math.min(1, cap / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * sc)), h = Math.max(1, Math.round(sh * sc));
    cv.width = w; cv.height = h;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    const t = decodeCanvas(cv);
    if (t) out.add(t);
  }
  return [...out];
}

/* ネイティブQR検出器 (Android Chrome等。jsQRより高速・高精度) */
let nativeDetector = null;
if ("BarcodeDetector" in window) {
  try { nativeDetector = new BarcodeDetector({ formats: ["qr_code"] }); } catch (e) { nativeDetector = null; }
}

/* ===== QR生データをAIに渡して項目分け(端末パーサーで埋まらない時の確実な手段) ===== */
function buildQrParsePrompt(rawList) {
  return [
    "あなたは日本の自動車検査証(車検証)の二次元コード(QRコード)を解析する専門家です。",
    "以下はスマホで読み取った車検証QRコードの生データ(複数のQRを行ごとに記載、フィールドは「/」区切り)です。",
    "車検証の二次元コード仕様(二次元コード2: バージョン/登録番号/標板コード/車台番号/原動機型式/帳票種別。二次元コード3: バージョン/打刻位置/型式指定番号類別区分番号/有効期間満了日(YYMMDD)/初度登録年月(YYMM)/型式/以降に軸重・騒音・燃料種別等)を踏まえ、各データを正しい項目に振り分けてください。",
    "重要(配置ミス防止): kataShitei(型式指定番号・類別区分番号)は『型式指定番号(最大5桁)＋類別区分番号(最大4桁)』を連結した数字で、現行車は9桁・旧車は7桁になる。大型車・特装車・輸入車には存在しない(その場合はnull)。原動機型式や帳票種別の数字をkataShiteiに入れないこと。車台番号は英数字＋ハイフン、原動機型式は短い英数字、登録番号は地名(漢字)を含むことで区別する。各値を取り違えないよう、桁数と文字種で必ず検証すること。",
    "999999や9999は未設定を意味します。日付は西暦に変換(満了日・初度登録年月の下2桁年は20xxと解釈)。",
    "出力は厳密なJSONのみ(前後に文章やコードフェンス不要)。キーは以下、該当データが無ければnull:",
    '{"type":型式, "vin":車台番号, "engine":原動機型式, "plate":登録番号, "kataShitei":型式指定番号類別区分番号(数字のみ連結), "expiry":有効期間満了日(YYYY-MM-DD), "firstRegYear":初度登録の西暦年(数値), "firstRegMonth":初度登録の月(数値), "fuel":燃料種別}',
    "",
    "■QR生データ:",
    ...rawList.map((p, i) => (i + 1) + ": " + p),
  ].join("\n");
}
function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}
function applyAiQr(o) {
  const d = {};
  if (o.type) d.type = String(o.type).toUpperCase().trim();
  if (o.vin) d.vin = String(o.vin).toUpperCase().trim();
  if (o.engine) d.engine = String(o.engine).toUpperCase().trim();
  if (o.plate && isValidPlate(o.plate)) d.plate = String(o.plate).trim();
  if (o.kataShitei) d.kataShitei = String(o.kataShitei).replace(/[^0-9]/g, "");
  if (o.expiry) { const dt = new Date(o.expiry); if (!isNaN(dt.getTime())) d.expiry = dt; }
  if (o.firstRegYear && o.firstRegMonth) { const y = +o.firstRegYear, m = +o.firstRegMonth; if (y > 1980 && m >= 1 && m <= 12) d.firstReg = { year: y, month: m }; }
  mergeAcc(d);              // 未取得の項目だけ埋める(既存の正しい値は保持)
  showResult(accResult(), { fromScan: true, noAutoAi: true });  // AI補完も履歴保存。再度の自動AI解析は起動しない(ループ/画面のガタつき防止)
}
/* ===== 写真(車検証)をAI Vision(メカ君)で直接読み取る = 最高精度のフォールバック =====
   QRが読めない/印字が擦れている車検証でも、画像を理解して各項目を構造化抽出する。 */
function buildPhotoReadPrompt() {
  return [
    "あなたは日本の自動車の車両情報を写真から読み取る精密OCRエンジンです。",
    "添付は整備士が現場で撮影した写真で、次のいずれかです: (1)車検証(紙/電子車検証の閲覧アプリ画面) (2)車体のコーションプレート/コーションラベル(金属やシールの銘板。型式・車台番号・原動機型式・型式指定/類別番号等が刻印) (3)整備管理システムやFAINES等のパソコン画面 (4)その他 車両情報が写ったもの。",
    "どの種類の写真でも、写っている車両情報を最大限読み取ること。『車検証ではないから』と読み取りを諦めない。コーションプレートには登録番号や使用者は無いことが多い→その場合はnullでよい。",
    "重要(取り違え防止・桁数と文字種で必ず検証すること):",
    "・型式(type): 排出ガス等の識別記号+ハイフン+英数字。例 3BA-GK5 / 2PG-FW74HZ。",
    "・車台番号(vin): 英数字(+ハイフン)。例 GK5-1234567 / FW74HZ-510123。",
    "・原動機の型式(engine): 短い英数字。例 L15B / N04C / 2NR。",
    "・登録番号(plate): 地名(漢字)+分類番号+ひらがな+一連番号。例 品川 500 あ 12-34。地名を必ず含める。",
    "・kataShitei: 『型式指定番号(最大5桁)＋類別区分番号(最大4桁)』の連結数字。現行車は9桁/旧車は7桁。大型・特装・輸入車には無い(null)。原動機型式や帳票番号を入れない。",
    "読み取れない項目はnull。推測や9999等のダミーで埋めない。英数字は半角・大文字。日付は西暦。",
    "出力は厳密なJSONのみ(前後に文章・コードフェンス不要)。キーは以下:",
    '{"type":型式, "vin":車台番号, "engine":原動機型式, "plate":登録番号, "kataShitei":型式指定番号類別区分番号(数字のみ連結), "expiry":有効期間満了日(YYYY-MM-DD), "firstRegYear":初度登録の西暦年(数値), "firstRegMonth":初度登録の月(数値), "name":使用者の氏名又は名称, "model":車名(メーカー)}',
  ].join("\n");
}
/* 画像を長辺maxDimまで縮小しJPEG base64化(通信量削減・AI精度は維持) */
async function fileToJpegBase64(file, maxDim, quality) {
  try {
    const img = await loadImageEl(file);
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const sc = Math.min(1, (maxDim || 1800) / Math.max(w, h));
    w = Math.max(1, Math.round(w * sc)); h = Math.max(1, Math.round(h * sc));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    const durl = c.toDataURL("image/jpeg", quality || 0.85);
    const i = durl.indexOf("base64,");
    return i >= 0 ? durl.slice(i + 7) : durl.slice(durl.indexOf(",") + 1);
  } catch (e) { return await fileToBase64(file); }   // 変換失敗時は原本を送る
}
async function readShakenPhotoAI(file) {
  const data = await fileToJpegBase64(file, 1800, 0.85);
  const r = await geminiAskMedia(buildPhotoReadPrompt(), [{ mimeType: "image/jpeg", data }]);
  const obj = extractJson(r.text);
  if (!obj) throw new Error("AIの応答を解釈できませんでした");
  return obj;
}
let aiQrDone = false;   // 同じ読取で二重解析しない
async function runAiQrParse(fromAuto) {
  stopFieldMic();
  if (!aiOK()) {
    if (fromAuto) return;   // 自動時はキー未設定なら静かに何もしない(ボタンで手動可)
    uiAlert("QRのAI解析には無料のGemini APIキーの設定が必要です（設定タブ）。");
    switchView("settings"); return;
  }
  const raw = (current.qrRaw && current.qrRaw.length) ? current.qrRaw : [...payloads];
  if (!raw.length) { if (!fromAuto) { toggle("aiQrStatus", true); $("aiQrStatus").textContent = "QRの生データがありません(QRを読み取ってからお試しください)。"; } return; }
  aiQrDone = true;
  toggle("aiQrParse", true); toggle("aiQrStatus", true); $("aiQrStatus").textContent = "🔧 メカ君がQRデータを項目分け中…";
  setBtnLoading($("btnAiQr"), true, "メカ君が解析中…");
  try {
    const r = await geminiAsk(buildQrParsePrompt(raw), { mode: "flash" });   // 構造抽出はflashで高速
    const obj = extractJson(r.text);
    if (!obj) throw new Error("AIの応答を解釈できませんでした。もう一度お試しください。");
    applyAiQr(obj);
    const lines = [];
    if (obj.type) lines.push("型式: " + obj.type);
    if (obj.engine) lines.push("原動機型式: " + obj.engine);
    if (obj.vin) lines.push("車台番号: " + obj.vin);
    if (obj.plate) lines.push("登録番号: " + obj.plate);
    if (obj.kataShitei) lines.push("指定-類別: " + obj.kataShitei);
    if (obj.expiry) lines.push("有効期限: " + obj.expiry);
    if (obj.firstRegYear && obj.firstRegMonth) lines.push("初度登録: " + obj.firstRegYear + "年" + obj.firstRegMonth + "月");
    if (obj.fuel) lines.push("燃料: " + obj.fuel);
    const head = r.model === "cache" ? "🔧 前回のメカ君の解析結果を再利用しました" : "🔧 メカ君がQRを自動解析しました";
    toggle("aiQrParse", true); toggle("aiQrStatus", true);
    $("aiQrStatus").style.whiteSpace = "pre-wrap";
    $("aiQrStatus").textContent = head + "\n" + (lines.length ? "メカ君が読み取った内容:\n・" + lines.join("\n・") : "QRから抽出できる項目がありませんでした。");
  } catch (e) {
    aiQrDone = false;   // 失敗時は再試行できるように
    if (e.message !== "__cancelled__") { toggle("aiQrParse", true); toggle("aiQrStatus", true); $("aiQrStatus").textContent = "⚠ " + (e.message || e); }
  } finally {
    setBtnLoading($("btnAiQr"), false);
  }
}
$("btnAiQr").addEventListener("click", () => runAiQrParse(false));

/* ---- 手動入力 (複数項目) ---- */
$("btnManual").addEventListener("click", () => {
  const uc = id => $(id).value.trim().toUpperCase();
  const type = uc("manualType"), engine = uc("manualEngine"), vin = uc("manualVin");
  const plate = $("manualPlate").value.trim();
  const user = $("manualUser").value.trim();
  if (!type && !vin && !plate && !engine) { uiAlert("いずれか1項目以上を入力してください。"); return; }
  const d = { type: type || null, engine: engine || null, vin: vin || null, plate: plate || null,
    raw: [type, engine, vin, plate].filter(Boolean) };
  showResult(d, { fromScan: true });
  if (user) saveUserName(user);
  setText("rUser", user || "—");
});

/* =========================================================
   OCRフォールバック (Tesseract.js / Google Vision)
   ========================================================= */
const ocrIn = $("ocrIn");
const _btnOcr = $("btnOcr"); if (_btnOcr) _btnOcr.addEventListener("click", () => ocrIn.click());
ocrIn.addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  ocrIn.value = "";
  toggle("ocrBox", true);
  $("ocrPreview").src = URL.createObjectURL(file);
  // 既に車両を表示中に写真スキャンする場合、その車両を引き継いで“同じ車”として追記する
  // (車台番号を写真で取り切れなくても別レコード化・履歴欠落・入庫未記録を防ぐ)
  const keep = (current && (current.type || current.vin || current.plate || current.kataShitei)) ? current : null;
  if (scanComplete) resetScan();
  if (keep) mergeAcc({ type: keep.type, vin: keep.vin, engine: keep.engine, plate: keep.plate, kataShitei: keep.kataShitei, rid: keep.rid });
  // ① AI Vision(メカ君)が使えるなら、写真から全項目を高精度で直接読み取る(最優先)
  if (aiOK()) {
    $("ocrStatus").innerHTML = '<img src="img/kangae.png" class="btnMecha spin" alt=""> メカ君が車検証を読み取り中…（高精度）';
    try {
      const obj = await readShakenPhotoAI(file);
      if (obj && (obj.type || obj.vin || obj.plate || obj.engine || obj.kataShitei)) {
        applyAiQr(obj);   // 既存の項目マージ＋結果表示を再利用(型式/車台/原動機/登録番号/指定類別/有効期限/初度登録)
        if (obj.name) { try { const nm = String(obj.name).trim(); if (nm) { saveUserName(nm); setText("rUser", nm); } } catch (_) {} }
        const parts = [acc.type, acc.vin].filter(Boolean).join(" / ");
        $("ocrStatus").innerHTML = "✓ メカ君が読み取りました（" + (parts || "各項目") + "）。誤りがあれば各項目をタップして修正できます。";
        return;
      }
      $("ocrStatus").innerHTML = "AIが項目を特定できませんでした。通常OCRで再挑戦します…";
    } catch (err) {
      $("ocrStatus").innerHTML = "AI読み取りに失敗（" + (err.message || err) + "）→ 通常OCRに切替…";
    }
  }
  // ② フォールバック: OCR(Cloud Vision / 無料Tesseract) + 正規表現抽出
  try {
    if (!aiOK()) $("ocrStatus").innerHTML = "OCR を準備中…(初回はモデル取得に少し時間がかかります)";
    const text = await ocrTesseract(file);
    const d = extractFromOcrText(text);
    mergeAcc({ type: d.type, vin: d.vin, raw: d.rawCandidates });
    if (acc.type || acc.vin) {
      $("ocrStatus").innerHTML = "✓ OCR完了。<b>" + (acc.type || "型式未検出") + "</b> / " + (acc.vin || "車台番号未検出") + " — 誤りがあればRAWチップから修正してください。";
      scanComplete = true;
      showResult(accResult(), { fromScan: true });
    } else {
      $("ocrStatus").innerHTML = "型式・車台番号を特定できませんでした。下のRAW候補チップから手動割り当てするか、より大きく鮮明に撮影してください。";
      if (d.rawCandidates.length) showResult({ type: null, vin: null, plate: null, raw: d.rawCandidates }, { fromScan: false });
    }
  } catch (err) {
    $("ocrStatus").textContent = "OCRエラー: " + (err.message || err);
  }
});

let tesseractReady = null;
function loadTesseract() {
  if (tesseractReady) return tesseractReady;
  tesseractReady = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js";
    s.onload = res; s.onerror = () => rej(new Error("Tesseract.jsの読み込みに失敗(要ネット接続)"));
    document.head.appendChild(s);
  });
  return tesseractReady;
}
/* OCR入口: 高精度OCR(Cloud Vision)がON+キー設定済みならVision、無ければ無料Tesseract */
function visionEnabled() {
  if (localStorage.getItem("ss_usevision") === "1" && !!localStorage.getItem("ss_visionkey")) return true;
  return !!(window.Cloud && window.Cloud.aiReady && window.Cloud.aiReady());   // 契約店舗はサーバー経由で高精度OCR
}
async function ocrCloudVision(file) {
  const key = localStorage.getItem("ss_visionkey");
  const data = await fileToBase64(file);
  // ローカル鍵が無くても契約中の店舗はサーバー(visionOcr)経由でOCR
  if (!key && window.Cloud && window.Cloud.aiReady && window.Cloud.aiReady()) {
    const d = await window.Cloud.callFn("visionOcr", { imageBase64: data });
    return (d && d.text) || "";
  }
  if (!key) throw new Error("Cloud Vision APIキー未設定");
  const res = await fetch("https://vision.googleapis.com/v1/images:annotate?key=" + encodeURIComponent(key), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ image: { content: data }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }] })
  });
  if (!res.ok) throw new Error("Cloud Vision APIエラー (" + res.status + ")");
  const j = await res.json();
  const r = j.responses && j.responses[0];
  if (r && r.error) throw new Error(r.error.message || "Cloud Visionエラー");
  return (r && r.fullTextAnnotation && r.fullTextAnnotation.text) || "";
}
async function ocrTesseract(file, statusId = "ocrStatus") {
  if (visionEnabled()) {
    try {
      if ($(statusId)) $(statusId).textContent = "高精度OCR（Cloud Vision）で解析中…";
      const t = await ocrCloudVision(file);
      if (t) return t;
    } catch (e) {
      if ($(statusId)) $(statusId).textContent = "Cloud Vision失敗→無料OCRに切替（" + (e.message || e) + "）…";
    }
  }
  await loadTesseract();
  // 前処理: 拡大+二値化で印字の認識精度を上げる
  let target = file;
  try {
    const img = await loadImageEl(file);
    const tw = Math.min(2200, Math.max(1400, img.width)), sc = tw / img.width;
    const tmp = document.createElement("canvas"); tmp.width = tw; tmp.height = Math.round(img.height * sc);
    tmp.getContext("2d").drawImage(img, 0, 0, tmp.width, tmp.height);
    target = preprocessOcr(tmp);
  } catch (e) {}
  const worker = await Tesseract.createWorker("jpn", 1, {
    logger: m => {
      if (m.status === "recognizing text" && $(statusId))
        $(statusId).textContent = "文字認識中… " + Math.round(m.progress * 100) + "%";
    }
  });
  const { data } = await worker.recognize(target);
  await worker.terminate();
  return data.text || "";
}
function extractFromOcrText(text) {
  const norm = zen2han(text).toUpperCase();
  const lines = norm.split(/\n+/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  let type = null, vin = null;
  const rawCandidates = [];
  // ラベル付き行を最優先 (「型式 2PG-FW74HZ」「車台番号 FW74HZ-510123」)
  for (const l of lines) {
    let m;
    if (!vin && (m = l.match(/車台番号\s*[:：]?\s*([A-Z0-9\-\[\]]{5,23})/))) vin = m[1];
    if (!type && (m = l.match(/(?<!原動機の?)型式\s*[:：]?\s*([0-9A-Z]{2,4}-[A-Z][A-Z0-9]{2,8}|[A-Z]{1,4}[0-9]{1,3}[A-Z0-9]{0,4})/))) type = m[1];
  }
  // パターン抽出 (フォールバック + RAW候補)
  const tokens = norm.match(/[A-Z0-9\-\[\]]{4,23}/g) || [];
  for (const t of [...new Set(tokens)]) {
    if (/^[A-Z0-9]{2,8}-[0-9]{5,8}$/.test(t)) { if (!vin) vin = t; rawCandidates.push(t); }
    else if (/^[0-9A-Z]{2,4}-[A-Z][A-Z0-9]{2,8}$/.test(t) && !/^[0-9]+$/.test(t.split("-")[1])) { if (!type) type = t; rawCandidates.push(t); }
    else if (/^[A-Z]{2,4}[0-9]{2,3}[A-Z0-9]{0,4}$/.test(t) && t.length <= 9) rawCandidates.push(t);
  }
  if (type) rawCandidates.unshift(type);
  if (vin) rawCandidates.unshift(vin);
  return { type, vin, plate: null, rawCandidates: [...new Set(rawCandidates)].slice(0, 24) };
}

/* =========================================================
   結果表示
   ========================================================= */
let current = { type: null, vin: null, plate: null, raw: [] };

/* フォールバック手段の表示切替 (普段はリンクのみ) */
function foldEntryAreas() { toggle("ocrArea", false); toggle("manualArea", false); toggle("plateArea", false); }
$("lnkShowOcr").addEventListener("click", () => {
  if (typeof scanning !== "undefined" && scanning) stopLiveScan(false);   // QRモードを止める(起動したまま残らないように)
  toggle("scanProgress", false); toggle("scanActions", false);            // 未取得・やり直しを閉じる
  foldEntryAreas(); toggle("lastVehicle", false); toggle("ocrArea", true); ocrIn.click();
});
{ const lm = $("lnkShowManual"); if (lm) lm.addEventListener("click", () => {
  if (!$("manualArea").classList.contains("hidden")) { toggle("manualArea", false); return; }   // 再タップで閉じる
  foldEntryAreas(); toggle("lastVehicle", false); toggle("manualArea", true); $("manualType").focus();
}); }
$("lnkShowPlate").addEventListener("click", () => {
  if (!$("plateArea").classList.contains("hidden")) { toggle("plateArea", false); try { renderHomeIntake(); } catch (e) {} return; }   // 再タップで閉じる→入庫状況ボードを復帰
  foldEntryAreas(); toggle("lastVehicle", false); toggle("plateArea", true); renderPlateSearch();
  try { renderHomeIntake(); } catch (e) {}   // 車両検索を開いたら入庫状況ボードを閉じる
});

/* ナンバー検索 (使用者名でも引ける・部分一致) */
function renderPlateSearch() {
  const q = normPlate($("plateSearch").value);
  const qRaw = $("plateSearch").value.trim();
  const box = $("plateResults"); box.innerHTML = "";
  const hist = dedupeHistoryStore().filter(h => h.plate || h.name || h.model || h.type);
  if (!hist.length) { box.innerHTML = '<div class="empty">保存済みの車両がまだありません。<br>スキャンするとナンバーが自動保存されます。</div>'; return; }
  const matches = (q || qRaw)
    ? hist.filter(h =>
        (h.plate && normPlate(h.plate).includes(q)) ||
        (qRaw && h.name && h.name.includes(qRaw)) ||
        (qRaw && h.model && h.model.includes(qRaw)) ||
        (qRaw && h.type && h.type.toUpperCase().includes(qRaw.toUpperCase())))
    : hist.slice(0, 10);
  if (!matches.length) { box.innerHTML = '<div class="empty">一致する車両がありません。</div>'; return; }
  matches.slice(0, 20).forEach(h => {
    const div = document.createElement("div"); div.className = "histItem";
    const main = document.createElement("div"); main.className = "hMain";
    main.innerHTML = '<div class="hType">' + esc(dispText(h.plate) || "ナンバー未登録") + (h.name ? ' <span style="font-weight:400">／ ' + esc(dispText(h.name)) + '</span>' : '') + '</div>' +
      '<div class="hSub">' + esc(dispText(h.model || h.type) || "型式不明") + " ・ " + esc(dispText(h.vin) || "車台番号なし") + '</div>';
    main.addEventListener("click", () => { foldEntryAreas(); showResult(histToResult(h), { fromScan: false }); });
    div.appendChild(main); box.appendChild(div);
  });
}
$("plateSearch").addEventListener("input", renderPlateSearch);

/* ===== 車両データを直接修正(VEHICLE IDENTIFICATION) ===== */
function pad2(n) { return String(n).padStart(2, "0"); }
$("lnkFixRead").addEventListener("click", () => {
  $("vidType").value = current.type || "";
  $("vidEngine").value = current.engine || "";
  $("vidVin").value = current.vin || "";
  $("vidPlate").value = current.plate || "";
  $("vidUser").value = (findHistEntry(getHistory(), current) || {}).name || "";
  $("vidFirstReg").value = current.firstReg ? current.firstReg.year + "-" + pad2(current.firstReg.month) : "";
  $("vidExpiry").value = current.expiry ? current.expiry.getFullYear() + "-" + pad2(current.expiry.getMonth() + 1) + "-" + pad2(current.expiry.getDate()) : "";
  $("vidKata").value = current.kataShitei || "";
  toggle("vidEdit", true); $("vidEdit").scrollIntoView({ behavior: "smooth" });
});
$("btnVidCancel").addEventListener("click", () => toggle("vidEdit", false));
$("lnkRawChips").addEventListener("click", () => { toggle("secRaw", true); $("secRaw").scrollIntoView({ behavior: "smooth" }); });
{ const b = $("btnCopyQrRaw"); if (b) b.addEventListener("click", async () => {
  const raw = (current && current.qrRaw && current.qrRaw.length) ? current.qrRaw : [...payloads];
  const txt = raw.length ? raw.join("\n") : "(QR生データなし)";
  if (await copyText(txt)) { b.textContent = "✓ コピーしました"; setTimeout(() => b.textContent = "🔎 QR生データをコピー（不具合報告用）", 1600); }
  else { uiAlert(txt); }
}); }
$("btnVidSave").addEventListener("click", () => {
  const uc = id => $(id).value.trim().toUpperCase();
  current.type = uc("vidType") || null;
  current.engine = uc("vidEngine") || null;
  current.vin = uc("vidVin") || null;
  current.plate = $("vidPlate").value.trim() || null;
  current.kataShitei = $("vidKata").value.replace(/[^0-9]/g, "") || null;
  const fr = $("vidFirstReg").value;  // YYYY-MM
  current.firstReg = /^\d{4}-\d{2}$/.test(fr) ? { year: +fr.slice(0, 4), month: +fr.slice(5, 7) } : null;
  const ex = $("vidExpiry").value;    // YYYY-MM-DD
  current.expiry = /^\d{4}-\d{2}-\d{2}$/.test(ex) ? new Date(+ex.slice(0, 4), +ex.slice(5, 7) - 1, +ex.slice(8, 10)) : null;
  // accにも反映
  if (typeof acc !== "undefined") ["type", "engine", "vin", "plate", "kataShitei", "firstReg", "expiry"].forEach(k => acc[k] = current[k]);
  const user = $("vidUser").value.trim();
  toggle("vidEdit", false);
  // 手動修正後は自動AI-QR解析を起動しない(空白訂正がキャッシュのAI結果で元に戻るのを防ぐ)
  showResult(current, { fromScan: true, noAutoAi: true });   // 再描画＋履歴に統合保存(自動保存)
  saveUserName(user); setText("rUser", user || "—");   // 空欄なら空欄で上書き(誤入力の訂正クリアを反映)
  registerVehicleToDB();   // 保存と同時にDBの登録車種へ追加/更新
});

/* 「保存（DBに登録）」: 現在の車両をカスタムDB(登録車種一覧)へ追加/更新 */
function escRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
const VALID_MAKERS = new Set([...Object.keys(MAKER_RECALL), "other"]);
function registerVehicleToDB(opt = {}) {
  const d = current;
  if (!d || (!d.vin && !d.type && !d.plate)) { return false; }
  const histE = findHistEntry(getHistory(), d) || {};
  const learned = getLearned(vehicleKey(d)) || {};
  const user = noEmail(histE.name) || null;   // 使用者にメールが混入していたら使わない
  // 型式マッチ = 車台番号のハイフンより前の英数字(例: FW74HZ-510123 → FW74HZ)
  const prefixRaw = vinPrefix(d.vin);
  const prefix = prefixRaw ? prefixRaw.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
  // 車種名 = 車台番号(先頭)から内蔵DB検索した車種名 > メンテAIで取得した車種名 > 代替
  // ※自分が保存したカスタムレコードに自己ヒットしないよう内蔵DBのみを検索
  const found = prefix ? findBuiltinVehicle(prefix) : null;
  const aiModel = noEmail(histE.model || learned.model) || null;
  // 車種名は「内蔵DB名 > AI推定車種名 > 型式(車種記号)」のみ。
  // ※使用者名・登録番号・車台番号は個人情報なので車種名に入れない(検索や表示に漏らさない)。
  const name = noEmail((found && found.name) || aiModel)
    || d.type || prefixRaw
    || (d.kataShitei ? "型式指定 " + d.kataShitei : "")
    || "未特定車両";
  const match = prefix
    || (d.type ? escRegex(String(d.type.includes("-") ? d.type.split("-")[1] : d.type).toUpperCase()) : (d.kataShitei || escRegex(name)));
  // メーカー = DB一致のメーカー > AI推定メーカー(有効なキーのみ) > 既存 > other
  const aiMaker = histE.maker || learned.maker || null;
  const maker = (found && found.maker) || (VALID_MAKERS.has(aiMaker) ? aiMaker : null) || null;
  const specs = (histE.specs && histE.specs.length ? histE.specs : learned.specs) || [];
  const faults = (histE.faults && histE.faults.length ? histE.faults : learned.faults) || [];
  // DBは「登録車種」なので同じ型式は1件に統一(重複を避ける)。型式 > 車台番号 > 車種名+型式 の順で既存を探す
  let rec = (match && CUSTOM_DB.find(x => x.match && x.match === match))
    || (d.vin && CUSTOM_DB.find(x => x.vin && x.vin === d.vin))
    || CUSTOM_DB.find(x => x.name === name && x.match === match);
  const isNew = !rec;
  if (isNew) { rec = { id: "c" + Date.now(), maker: "other" }; CUSTOM_DB.unshift(rec); }
  // 手動編集済みレコードは車種名(と型式マッチ・メーカー)を「正データ」として尊重し、AI/内蔵推定で上書きしない。
  // 諸元・持病はユーザーの訂正で常に更新されるべきなのでロックしない(他端末へ反映させる)。
  const locked = !!rec.manual;
  Object.assign(rec, {
    name: locked ? rec.name : name,
    match: locked ? (rec.match || match) : match,
    maker: locked ? (rec.maker || "other") : (maker || rec.maker || "other"),
    vin: d.vin || rec.vin || null, engine: d.engine || rec.engine || null,
    plate: d.plate || rec.plate || null, kataShitei: d.kataShitei || rec.kataShitei || null,
    user: user || rec.user || null,
    faults: faults.length ? faults : (rec.faults || []),
    specs: specs.length ? specs : (rec.specs || []),
    specDone: learned.specDone || rec.specDone || false,   // 一度AI取得済み=他メンバーも再検索しない歯止め
    notes: rec.notes || "",
    updatedAt: Date.now(),   // 同期時に古いクラウドで上書きされないよう更新時刻を記録
  });
  saveCustomDB();
  if (window.Cloud) window.Cloud.pushVehicle(rec);   // 社内共有へ
  try { renderDBList(); } catch (e) {}
  if (!opt.silent) {
    const msg = $("vidSavedMsg");
    if (msg) { msg.textContent = "✓ DBの登録車種に" + (isNew ? "追加" : "更新保存") + "しました（「" + name + "」）。DB編集タブで確認できます。"; toggle("vidSavedMsg", true); }
  }
  return true;
}
// 「保存（DBに登録）」ボタンは廃止(スキャン/表示時点で自動保存されるため)。旧ID参照は安全にガード。
{ const _br = $("btnVidRegister"); if (_br) _br.addEventListener("click", () => registerVehicleToDB()); }

/* 認識後の行き先選択(メンテ/診断/部品交換は独立ページ) */
function goVehiclePage(name) {
  switchView(name);
  window.scrollTo(0, 0);
  if (name === "maint") {
    // 諸元が無い車両のときだけ自動でAI解析(保存済み/内蔵データがあればAIを使わない=消費節約)
    if (aiOK() && shownSpecs.length === 0 && !$("specAiBox").textContent.trim()) $("btnSpecAI").click();
  }
  // 診断・部品はタブを開いた時点では入力欄にフォーカスしない(自動でキーボードが出るのを防ぐ)
}
$("btnGoMaint").addEventListener("click", () => goVehiclePage("maint"));
$("btnGoDiag").addEventListener("click", () => goVehiclePage("diag"));
$("btnGoParts").addEventListener("click", () => goVehiclePage("parts"));
$("btnGoKarte").addEventListener("click", () => goVehiclePage("karte"));
/* 全ページ共通ナビ(← 車両 / メンテ / 診断 / 部品) */
document.querySelectorAll(".pageNav .navBtn").forEach(b =>
  b.addEventListener("click", () => {
    const go = b.dataset.go;
    if (go === "scan") switchView("scan"); else goVehiclePage(go);
  }));

/* ===== 部品の洗い出し + 部品商への注文リスト ===== */
function buildPartsBreakdownPrompt(part) {
  return [
    "あなたは日本の自動車整備士を支援するベテランメカニックです。次の車両で『指定の部品交換/作業』を行う際に、部品商へ注文すべき部品を洗い出してください。",
    "含めるもの: ①作業対象の本体部品(正式名称)、②同時交換が必須または強く推奨される部品(ガスケット/オイルシール/Oリング/一度使用のボルト・ナット/割ピン/クリップ/ロックワッシャ等)、③消耗品(オイル/クーラント/グリス/ブレーキフルード等)。",
    "各部品は日本の整備現場で通じる正式名称で。純正品番が推定できれば目安を書き、不確かなら「要確認」。数量も。分からない項目は正直に空/要確認。",
    "出力は厳密なJSONのみ(前後の文章・コードフェンス不要)。形式:",
    '{"official":"作業対象の正式部品名/作業名","note":"補足(あれば)","items":[{"name":"部品の正式名称","qty":"1","kind":"本体|同時交換必須|消耗品","partno":"純正品番の目安 または 要確認","memo":"補足(サイズ・容量・左右等)"}]}',
    "kindは必ず『本体』『同時交換必須』『消耗品』のいずれか。同時交換必須が無ければその項目は省略可。",
    "",
    "■対象車両: " + vehicleDesc(),
    "■部品/作業: " + part,
  ].join("\n");
}
let lastOrderText = "";
function renderPartsBreakdown(box, obj, part) {
  const items = Array.isArray(obj.items) ? obj.items.filter(i => i && i.name) : [];
  if (!items.length) { box.innerHTML = '<div class="hint">部品を洗い出せませんでした。表記を変えて再度お試しください。</div>'; return; }
  const kinds = [["本体", "部品本体"], ["同時交換必須", "同時交換が必須・推奨"], ["消耗品", "消耗品・油脂類"]];
  let html = '<div class="ai-h">' + esc(han(obj.official || part)) + ' に必要な部品</div>';
  if (obj.note) html += '<div class="ai-p">' + esc(han(obj.note)) + '</div>';
  kinds.forEach(([k, label]) => {
    const list = items.filter(i => (i.kind || "本体") === k);
    if (!list.length) return;
    html += '<div class="partsGroup"><div class="partsGroupT">' + label + '</div>';
    list.forEach(i => {
      const q = partQuery(i);
      const shops = q ? '<div class="pShops">' +
        '<a class="pShop pShopR" target="_blank" rel="noopener sponsored" href="' + rakutenSearchUrl(q) + '">🛒 楽天市場 ↗</a>' +
        '<a class="pShop pShopY" target="_blank" rel="noopener sponsored" href="' + yahooSearchUrl(q) + '">🛒 Yahoo!ショッピング ↗</a>' +
        '<a class="pShop pShopA" target="_blank" rel="noopener sponsored" href="' + amazonSearchUrl(q) + '">🛒 Amazon ↗</a>' +
        '</div>' : "";
      html += '<div class="partsItem"><div class="pName">' + esc(han(i.name)) + (i.qty ? ' <span class="pQty">×' + esc(han(String(i.qty))) + '</span>' : "") + '</div>' +
        '<div class="pMeta">' + (i.partno ? "品番: " + esc(han(i.partno)) : "品番: 要確認") + (i.memo ? " ／ " + esc(han(i.memo)) : "") + '</div>' + shops + '</div>';
    });
    html += '</div>';
  });
  // 部品商への注文リスト(コピー/共有しやすいテキスト)
  const head = "【部品注文リスト】\n車種: " + (currentVehicleFacts().model || "—") + " ／ 型式: " + (current.type || "—") +
    (current.vin ? " ／ 車台番号: " + current.vin : "") + "\n作業: " + (obj.official || part) + "\n";
  const lines = items.map(i => "・" + i.name + (i.qty ? " ×" + i.qty : "") + (i.partno && i.partno.indexOf("要確認") < 0 ? "（品番: " + i.partno + "）" : "") + (i.memo ? " " + i.memo : ""));
  lastOrderText = head + lines.join("\n") + "\n※品番は要確認。";
  html += '<div class="orderBox"><div class="orderT">📋 部品商への注文リスト</div><pre class="orderPre" id="orderPre"></pre>' +
    '<div class="btnRow"><button class="btn btn-amber btn-sm" id="btnOrderCopy">コピー</button><button class="btn btn-ghost btn-sm" id="btnOrderShare">共有・メール</button></div></div>';
  box.innerHTML = html;
  $("orderPre").textContent = lastOrderText;
  $("btnOrderCopy") && $("btnOrderCopy").addEventListener("click", async () => {
    if (await copyText(lastOrderText)) { $("btnOrderCopy").textContent = "✓ コピーしました"; setTimeout(() => { const b = $("btnOrderCopy"); if (b) b.textContent = "コピー"; }, 1500); }
    else { const p = $("orderPre"); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  });
  $("btnOrderShare") && $("btnOrderShare").addEventListener("click", async () => {
    const title = "部品注文リスト";
    if (navigator.share) { try { await navigator.share({ title, text: lastOrderText }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
    location.href = "mailto:?subject=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(lastOrderText);
  });
}
let partsBusy = false;
$("btnPartsGo") && $("btnPartsGo").addEventListener("click", async () => {
  stopFieldMic();
  const part = $("partName").value.trim();
  if (!part) { $("partName").focus(); return; }
  if (!vehicleKey(current)) { uiAlert("先に車両を読み込んでください(車台番号や型式が必要です)。"); return; }
  if (!aiOK()) {
    toggle("partsResult", true);
    $("partsResult").innerHTML = '<div class="hint">部品の洗い出しにはAI（無料Geminiキー）の設定が必要です。設定タブで登録してください。</div>';
    return;
  }
  if (partsBusy) return; partsBusy = true;
  const box = $("partsResult"); toggle("partsResult", true);
  box.innerHTML = '<div class="stepFigLoad">🔧 メカ君が必要な部品を洗い出しています…</div>';
  setBtnLoading($("btnPartsGo"), true, "メカ君が調べ中…");
  try {
    const r = await geminiAsk(buildPartsBreakdownPrompt(part));
    const obj = extractJson(r.text);
    if (obj && (obj.items || obj.official)) renderPartsBreakdown(box, obj, part);
    else renderAiAnswer(box, r.text);
  } catch (e) {
    if (e.message !== "__cancelled__") box.innerHTML = "⚠ " + esc(e.message || "AIへの接続に失敗しました");
  } finally {
    partsBusy = false; setBtnLoading($("btnPartsGo"), false);
  }
});
$("btnPartsClear") && $("btnPartsClear").addEventListener("click", () => {
  cancelAI();
  $("partName").value = "";
  $("partsResult").innerHTML = ""; toggle("partsResult", false);
  $("partsLinks").innerHTML = "";
  $("partsLoc").innerHTML = ""; toggle("partsLoc", false);
});

/* 部品の取り付け位置: この車両でどこにあるかを文章＋図＋Web画像リンクで表示 */
let partsLocBusy = false;
$("btnPartsLoc") && $("btnPartsLoc").addEventListener("click", async () => {
  stopFieldMic();
  const part = $("partName").value.trim();
  if (!part) { $("partName").focus(); return; }
  const carName = figureVehicleDesc();
  const q = ((currentVehicleFacts().model || current.type || "") + " " + part + " 取り付け位置").trim();
  const linkHtml = '<a class="linkbtn" target="_blank" rel="noopener" href="https://www.google.com/search?q='
    + encodeURIComponent(q) + '&tbm=isch">🔍 実物の取り付け位置をWebの画像で探す<span class="arr">↗</span></a>';
  const box = $("partsLoc"); toggle("partsLoc", true);
  if (!aiOK()) {
    box.innerHTML = '<div class="hint">AIの解説には無料Geminiキー設定が必要です（設定タブ）。Web画像リンクはそのまま使えます。</div>' + linkHtml;
    return;
  }
  if (partsLocBusy) return; partsLocBusy = true;
  box.innerHTML = '<div class="stepFigLoad">🔧 メカ君が「' + esc(part) + '」の取り付け位置を調べています…(十数秒〜30秒ほど)</div>';
  setBtnLoading($("btnPartsLoc"), true, "位置を調べ中…");
  try {
    // ①場所の文章解説
    const locPrompt = [
      "あなたは自動車整備士向けのアドバイザーです。次の車両で、指定部品が『どこに付いているか』を現場目線で簡潔に説明してください。",
      "含める: どの区画か(エンジンルーム/車両下部/室内/トランク等)、周囲の目印になる部品との位置関係、アクセス方法(上から/下から/カバーを外す等)、左右・前後。前置き不要。Markdown記号は使わず3〜5行で。確信が持てない点は「（要確認）」。",
      "■対象車両: " + vehicleDesc(),
      "■部品: " + part,
    ].join("\n");
    const r = await geminiAsk(locPrompt);
    // ②取り付け位置の図(実物に忠実な図→イラスト化の二段。失敗はスキップ)
    let imgHtml = "";
    try {
      let refDesc = ""; try { refDesc = await geminiStepVisualRef(part + " の取り付け位置", carName); } catch (e) { if (e && e.message === "__cancelled__") throw e; }
      let refInline = null;
      try { const p = await geminiGenImage(buildPartLocationPhotoPrompt(part, carName, refDesc)); if (p) refInline = dataUrlToInline(p); } catch (e) { if (e && e.message === "__cancelled__") throw e; }
      const dataUrl = await geminiGenImage(buildPartLocationImagePrompt(part, carName, refDesc, !!refInline), refInline ? { refImages: [refInline] } : undefined);
      if (dataUrl) imgHtml = '<div class="stepFigSvg"><img alt="取り付け位置" src="' + dataUrl + '"></div><div class="stepFigCap">メカ君が描いた取り付け位置の参考図（イメージ）</div>';
    } catch (e) { if (e && e.message === "__cancelled__") throw e; }
    const textHtml = '<div class="ai-answer">' + esc(r.text).replace(/\n/g, "<br>") + '</div>';
    box.innerHTML = textHtml + imgHtml + linkHtml;
  } catch (e) {
    box.innerHTML = (e && e.message === "__cancelled__" ? "" : '<div class="hint">⚠ ' + esc(e.message || "取得に失敗しました") + '</div>') + linkHtml;
  } finally {
    partsLocBusy = false; setBtnLoading($("btnPartsLoc"), false);
  }
});

/* この車両について質問(AI Q&A) */
let vehAskBusy = false;
$("btnVehClear").addEventListener("click", () => {
  cancelAI();
  $("qVehText").value = ""; autoGrow($("qVehText"));
  $("qVehResult").innerHTML = ""; toggle("qVehResult", false);
  clearVehAttachments();
});
$("btnVehAsk").addEventListener("click", () => runVehAsk());
/* 精度は運営管理のトグルで切替: 有料ON(Cloud.aiPaidOn)=Pro＋検索(正確)、OFF=無料Flash(検索なし)。 */
async function runVehAsk() {
  stopFieldMic();
  const q = $("qVehText").value.trim();
  if (!q && !vehAttachments.length) { $("qVehText").focus(); return; }
  if (!aiOK()) {
    uiAlert("質問するには設定タブで無料のGemini APIキーを設定してください。");
    switchView("settings"); return;
  }
  if (vehAskBusy) return; vehAskBusy = true;
  const box = $("qVehResult"); toggle("qVehResult", true);
  box.innerHTML = "";
  const load = document.createElement("div"); load.className = "stepFigLoad"; box.appendChild(load);
  const stopTimer = startThinkingTimer(load, "🔧 メカ君が考えています");   // 経過秒で待機の体感を軽減
  const btn = $("btnVehAsk"); setBtnLoading(btn, true, "メカ君が考え中…");
  try {
    const qFull = q || "添付した写真の部位について教えてください。";
    const accurate = !!(window.Cloud && window.Cloud.aiPaidOn && window.Cloud.aiPaidOn());   // 有料ON店舗のみPro＋検索
    let r;
    if (vehAttachments.length) {   // 写真/動画の添付あり: 一緒にメカ君へ送る(検索なし)。写真は自動圧縮。
      const media = [];
      for (const a of vehAttachments) media.push(await attachToMedia(a));
      const tot = media.reduce((s, m) => s + ((m.data && m.data.length) || 0), 0);
      if (tot * 0.75 > ATTACH_MAX) { stopTimer(); box.textContent = "⚠ 添付が大きすぎます。動画は30秒程度に、写真は枚数を減らしてください。"; vehAskBusy = false; setBtnLoading(btn, false); return; }
      // 思考量に上限を設けて高速化(診断と同様)。JSON応答なので逐次表示はしない。
      r = await geminiAskMediaStream(buildRepairPrompt(qFull, true), media, {}, null);
    } else {
      // 有料店舗: Pro＋検索でトルク等の実値を裏取り(要確認の乱発を防ぐ)。無料: Flash・検索なし。思考上限で高速化。
      r = await geminiAsk(buildRepairPrompt(qFull), accurate ? { mode: "pro", search: true, maxTokens: 8192, thinkingBudget: 3072 } : { mode: "flash", search: false });
    }
    stopTimer();
    const obj = cleanCiteDeep(extractJson(r.text));   // 検索グラウンディングの引用マーカーを全項目から除去
    // isWork=true なら手順が無くても構造化表示(位置/時間/部品/トルク等)。生JSONは絶対に出さない。
    let repairRec = null;
    if (obj && obj.isWork && (obj.location || (Array.isArray(obj.order) && obj.order.length) || (Array.isArray(obj.steps) && obj.steps.length))) { renderRepairAnswer(box, obj, qFull); repairRec = saveRepairRecord(qFull, obj); }
    else if (obj && obj.answer) { renderAiAnswer(box, obj.answer); repairRec = saveRepairRecord(qFull, obj); }
    else if (obj && obj.isWork) { renderRepairAnswer(box, obj, qFull); repairRec = saveRepairRecord(qFull, obj); }
    else { renderAiAnswer(box, r.text); repairRec = saveRepairRecord(qFull, { answer: r.text }); }
    if (repairRec) addRepairShareBar(box, repairRec);   // 初回の結果にも共有ボタン(過去の点検と同様に)
    appendAiFollowup(box, qFull, r.text, { kind: "repair" });   // 修理にも追加で質問できる欄
  } catch (e) {
    stopTimer();
    if (e.message !== "__cancelled__") box.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
  } finally {
    vehAskBusy = false; setBtnLoading(btn, false);
  }
}
/* 修理結果の先頭(右上)に共有ボタンを右寄せで置く */
function addRepairShareBar(box, rec) {
  const bar = document.createElement("div"); bar.className = "histMetaRow repairShareBar";
  bar.style.marginTop = "0"; bar.style.marginBottom = "2px";
  const sp = document.createElement("span"); sp.style.flex = "1 1 auto";
  const sh = document.createElement("button"); sh.type = "button"; sh.className = "histShareBtn"; sh.textContent = "📤 共有";
  sh.addEventListener("click", () => shareRepairRecord(rec));
  bar.append(sp, sh);
  box.insertBefore(bar, box.firstChild);   // 結果の先頭(右上)へ
}
/* 診断セクションの見出し右端に共有リンクを置く(ボタン式ではなくテキストリンク。バッジは左寄せ) */
function addDiagHeadShare(sec, rec) {
  if (!sec || !rec) return;
  const h2 = sec.querySelector("h2"); if (!h2 || h2.querySelector(".diagHeadShare")) return;
  const b = document.createElement("a"); b.href = "#"; b.className = "diagHeadShare";
  b.textContent = "📤 共有";
  b.style.cssText = "margin-left:auto;color:var(--cyan,#1b9);text-decoration:underline;font-size:13px;cursor:pointer;white-space:nowrap;";
  b.addEventListener("click", (e) => { e.preventDefault(); shareDiagRecord(rec); });
  h2.appendChild(b);
}
/* 診断結果(メディア/コード)の末尾に共有リンクを右寄せで置く(ボタン式ではなくテキストリンク) */
function addDiagShareBar(box, rec) {
  if (!rec) return;
  const bar = document.createElement("div"); bar.className = "histMetaRow repairShareBar";
  const sp = document.createElement("span"); sp.style.flex = "1 1 auto";
  const sh = document.createElement("a"); sh.href = "#"; sh.className = "diagShareLink"; sh.textContent = "📤 共有";
  sh.style.cssText = "color:var(--cyan,#1b9);text-decoration:underline;font-size:13px;cursor:pointer;white-space:nowrap;";
  sh.addEventListener("click", (e) => { e.preventDefault(); shareDiagRecord(rec); });
  bar.append(sp, sh); box.appendChild(bar);
}
/* 修理質問プロンプト(作業名なら構造化JSON、質問なら文章)。hasMedia=添付写真あり */
function buildRepairPrompt(q, hasMedia) {
  return [
    "あなたは『メカ君』。まじめで頼れるロボ整備士。次の車両の修理について答える。出力は厳密なJSONのみ(前後の文章・コードフェンス不要)。",
    hasMedia ? "添付された写真(複数の場合あり)をよく観察し、写っている部位・部品・損傷・警告灯・漏れ・摩耗などを踏まえて回答すること。写真から部品名や作業を推定できる場合は具体的に述べる。" : "",
    "入力が『パッド交換』のような作業名・部品名なら isWork=true とし、下記を埋める。単なる質問なら isWork=false とし answer に文章(見出しは■、箇条書きは・)で答える。",
    "形式: {\"isWork\":true,\"location\":\"取り付け位置の説明(区画・周囲の目印・アクセス方法・左右前後)\",\"time\":\"標準作業時間の目安(要確認可)\",\"order\":[{\"name\":\"部品名\",\"qty\":\"1\",\"kind\":\"本体\"または\"同時交換推奨\",\"step\":2}],\"specialTools\":[{\"name\":\"工具・道具名\",\"note\":\"用途・規格\",\"kind\":\"必須\"または\"便利\"}],\"torque\":\"締付トルク・規定値(調べた具体値。無ければ空)\",\"special\":\"特殊作業の注意(EPB/SAS/DPF再生/バッテリー登録等。無ければ特になし)\",\"manualService\":{\"name\":\"手動での◯◯移行・解除手順\",\"steps\":[\"操作1\",\"操作2\"]},\"steps\":[{\"text\":\"手順1(安全確保)\",\"tools\":[\"使用する工具1\",\"工具2\"]}],\"answer\":\"\"}",
    "【specialTools=別途必要な工具】2種類を挙げる。(A) kind=\"必須\": この作業に事実上必要な『専用工具(SST)・特殊工具』で、一般整備士が個人では持っていないことが多いもの。例: 各種プーラー、ベアリング圧入/抜き工具、ブレーキピストン戻し工具(専用カム式)、O2/ラムダセンサーソケット、インジェクターリムーバー、ボールジョイントセパレーター、スプリングコンプレッサー、専用オイルフィルターカップ、角度締めツール、整備モード用スキャンツール等。(B) kind=\"便利\": 必須ではないが『あると作業が楽・速い・確実になる』道具・ケミカル・消耗品。例: フレアナットレンチ、ロングラチェット、フレキシブルソケット、マグネットピックアップ、内張りはがしセット、ネジロック剤、シリコングリス、ラバーグリス、パーツクリーナー、ショップタオル、締結部の当たり出し用マーカー等(その作業に本当に役立つものだけ)。ごく一般的な手工具(普通のソケット・メガネ・スパナ・ドライバー・プライヤー)は(A)(B)とも入れない。各項目は name・note(用途/規格)・kind。必須も便利も無ければ空配列。",
    "【manualService=手動の整備モード手順】specialで整備モード/サービスモード(EPB電動パーキングブレーキ・DPF/DPD再生・ブレーキピストン戻し・SAS・バッテリー交換登録 等)に触れ、かつ『診断機(スキャンツール)を使わず手動で』移行・解除・実施できる方法がその車種に存在する場合のみ、その手動手順だけを manualService に入れる。手順はその車種で実際に通用する順序で具体的に(イグニッションON/OFFの回数・順序、ブレーキ/アクセルペダルの操作、待ち時間、キャリパーを手で戻す向き 等)。診断機でしか行えない/手動方法が無い/該当作業でない場合は manualService を出さない(キーごと省略)。診断機を使う方法は書かず、手動方法だけを簡潔にまとめる。",
    "【最重要】location・order・steps・tools・torque はすべて、下記『対象車両』(その車種・型式・原動機)に固有の内容にすること。一般論や別車種の情報にしない。取り付け位置も工具サイズもこの車両に合わせる。",
    "orderには『当該作業の本体部品』と『推奨される同時交換部品(ガスケット/シール/Oリング/一度使用ボルト/クリップ/油脂類等)』を含める。品番は書かない。",
    "各order項目の step は、その部品を実際に取り付け/交換する steps の手順番号(1始まり)。該当が無ければ step は省略。",
    "steps は安全確保→取り外し→取り付け→確認の順。各stepは {text:手順文, tools:その手順で使う工具・計測器の配列}。部品名は該当手順のtextにも登場させる。",
    "toolsは具体的に。ソケット(コマ)・メガネ・スパナは必ず実寸サイズ(mm)を明記(例『ラチェット＋14mmソケット』『12mmメガネレンチ』)、ヘックス/トルクスも番手明記(例『T30トルクス』『6mmヘックス』)。",
    "その手順で実際に手に持って使う工具は具体名で挙げる: 締める/緩める系(各サイズのソケット・メガネ・スパナ・モンキーレンチ・六角レンチ・トルクスドライバー・トルクレンチ・インパクトレンチ)、挟む系(プライヤー・ラジオペンチ・ウォーターポンププライヤー・スナップリングプライヤー・バイスプライヤー)、切る系(ニッパー・ケーブルカッター)、内張り作業(内張りはがし/クリップリムーバー)、ドライバー(プラス/マイナス/貫通)。その手順で本当に使うものだけを書く。",
    "ジャッキ・ウマ(リジッドラック)・ジャッキスタンド・輪止め・ウエス・受け皿・手袋・パーツクリーナー等の昇降/支持/補助用品はtoolsに入れない(手順textで触れるのは可)。",
    "【工具サイズは必ず調べてから答える】ボルト・ナットの二面幅サイズは、対象車両の整備要領書・部品情報・整備事例・分解レポート等をGoogle検索で実際に調べ、その車両の実サイズを書くこと。『サイズ要確認』『適合サイズを確認』のような逃げの表現は禁止。調べれば分かることを調べずに濁さない。",
    "toolsにトルクレンチが含まれる手順では、その工具名の直後にその締結部の規定トルク値も併記する(例『トルクレンチ(締付 108N·m)』)。トルク値も検索で調べて具体値を書く。",
    "【締付トルクは必ず調べて実値を出す】torque欄は、この型式・エンジンの整備要領書・整備解説・分解整備事例をGoogle検索で実際に調べ、部位ごとに『規定値(±公差があれば併記)』を具体数値で書く。『(要確認)』での逃げは禁止。どうしても一次情報が見つからない部位のみ、同種エンジン/一般的な締結(ボルト径・座面)から妥当な目安値を数値で示し、その旨(例:『一般的な目安』)を付す。数値を一切書かず要確認だけ、は不可。",
    "【要確認は最終手段】十分に検索しても確かな一次情報が得られなかった値に限り『（要確認）』とする(逃げの要確認は不可)。ただし誤った数値を書くのは最悪なので、本当に不明な場合のみ要確認とし、創作はしない。",
    "年式・グレードでサイズが異なる場合は、どの年式・グレードの値かを明記して具体値を書く。トルクは整備書(FAINES)での最終確認を促す。",
    "【ハブロックナット/ハブナット(ドライブシャフト・スピンドルのハブ固定ナット)】ホイールナット(ホイール取付ナット)とは別物として扱う。多くの車種で『段階締め付け(例: 一次締め付け→規定角度戻し→本締め、または 仮締め→緩め→規定値で本締め)』が指定されるため、単一トルクで済ませず、その車種の締め付け手順(数値と順序・戻し角度)を調べて具体的に書く。左右・前後で異なる場合や、ロックナット・ダブルナット・かしめの有無も明記する。乗用車は概ね150〜300N·m級、トラック等の大型は規定手順が別途あるため必ず車種別に確認する。段階手順が不明なときのみ一般的目安であると明示する。",
    "【足回り(サスペンション/ハブ/ブレーキ/ステアリング)・ドレンボルト・オイルフィルターのトルク】ロアアーム/アッパーアーム・ボールジョイント・タイロッドエンド・スタビリンク・ナックル・キャリパー(ブラケット/スライドピン)・ショック取付・ハブベアリング等の締結は、部位ごとにこの車種の規定値を調べて具体数値で書く。角度締め指定があれば順序も書く。エンジンオイルのドレンボルト(オイルパン)とオイルフィルター(エレメント/カートリッジ)の締め付けトルクも、聞かれた場合や関連作業時は車種別の規定値を出す(ドレンは概ね30〜45N·m級だが車種で異なるため確認、カートリッジ式は指定Nm、スピンオン式は『パッキン接触後◯回転』表記も可)。",
    "■対象車両: " + vehicleDesc(),
    officialSpecsText(),
    "■質問/作業: " + q,
    (window.APP_LANG === "en" ? "Fill every JSON string value (location, video title, order names, steps, tools, torque, special, answer) in natural technical English. Keep the JSON keys exactly as specified in English." : ""),
  ].filter(Boolean).join("\n");
}
function ytId(url) { const m = /(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/.exec(String(url || "")); return m ? m[1] : ""; }
/* 検索用の車名(読み取った車両の車種名。無ければ型式)。動画/画像検索がその車両に当たるように */
function searchCarName() { return (currentVehicleFacts().model || current.type || "").trim(); }
function renderRepairAnswer(box, obj, q) {
  const mainPart = (Array.isArray(obj.order) && (obj.order.find(o => o.kind === "本体") || obj.order[0]) || {}).name || q;
  const carName = searchCarName();
  box.innerHTML = "";
  const sec = (label) => { const h = document.createElement("div"); h.className = "ai-h"; h.textContent = label; box.appendChild(h); };
  // ① 取り付け位置(＋交換動画のサムネ・URL)
  if (obj.location) {
    sec("取り付け位置");
    const p = document.createElement("div"); p.className = "ai-p"; p.textContent = han(String(obj.location)); box.appendChild(p);
  }
  // 実物の位置をWeb画像で探す(設定不要)。動画検索の上に配置
  const iq = (carName + " " + mainPart + " 取り付け位置").trim();
  const ia = document.createElement("a"); ia.className = "linkbtn"; ia.target = "_blank"; ia.rel = "noopener";
  ia.href = "https://www.google.com/search?q=" + encodeURIComponent(iq) + "&tbm=isch";
  ia.innerHTML = "🔍 実物の位置をWeb画像で探す<span class='arr'>↗</span>"; box.appendChild(ia);
  // 動画検索
  const yq = (carName + " " + mainPart + " 交換").trim();
  const sa = document.createElement("a"); sa.className = "linkbtn"; sa.target = "_blank"; sa.rel = "noopener";
  sa.href = "https://www.youtube.com/results?search_query=" + encodeURIComponent(yq);
  sa.innerHTML = "▶ YouTubeで交換動画を探す<span class='arr'>↗</span>"; box.appendChild(sa);
  // ② 所要時間
  if (obj.time) { sec("所要時間の目安"); const p = document.createElement("div"); p.className = "ai-p"; p.textContent = han(String(obj.time)); box.appendChild(p); }
  // ③ 部品注文リスト(品番なし・当該作業＋推奨同時交換／部品名タップで手順へ)
  const order = Array.isArray(obj.order) ? obj.order.filter(o => o && o.name) : [];
  if (order.length) {
    const hasRec = order.some(o => o.kind === "同時交換推奨");
    // 見出し右端に凡例(※同時交換推奨)
    const h = document.createElement("div"); h.className = "ai-h orderHead";
    h.innerHTML = '<span>部品注文リスト</span>' + (hasRec ? '<span class="orderLegend">※同時交換推奨</span>' : "");
    box.appendChild(h);
    const list = document.createElement("div"); list.className = "orderBox";
    order.forEach(o => {
      const row = document.createElement("div"); row.className = "orderRow";
      const sq = han(o.name).trim();
      const labelText = han(o.name) + (o.qty ? " ×" + han(String(o.qty)) : "");
      let nm;
      if (sq) {
        // 部品名タップ → 楽天/Yahoo!/Amazon の選択ポップアップ。目印の▾を先頭に配置
        const query = (vehPartPrefix() + " " + sq).trim();
        nm = document.createElement("button"); nm.type = "button"; nm.className = "orderName orderNameTap";
        nm.innerHTML = '<span class="orderCaret">▾ </span>' + esc(labelText);
        nm.title = "通販で探す";
        nm.addEventListener("click", () => openShopPopup(han(o.name), query));
      } else {
        nm = document.createElement("span"); nm.className = "orderName"; nm.textContent = labelText;
      }
      row.appendChild(nm);
      if (o.kind === "同時交換推奨") { const meta = document.createElement("span"); meta.className = "orderMeta"; meta.textContent = "※"; row.appendChild(meta); }
      list.appendChild(row);
    });
    // コピー/共有テキスト(品番なし)
    const head = "【部品注文リスト】\n車種: " + (currentVehicleFacts().model || "—") + " ／ 型式: " + (current.type || "—") + "\n作業: " + q + "\n";
    const orderText = head + order.map(o => "・" + o.name + (o.qty ? " ×" + o.qty : "")).join("\n");
    const bar = document.createElement("div"); bar.className = "btnRow"; bar.style.marginTop = "8px";
    const copy = document.createElement("button"); copy.className = "btn btn-amber btn-sm"; copy.textContent = "コピー";
    copy.addEventListener("click", async () => { if (await copyText(orderText)) { copy.textContent = "✓ コピー"; setTimeout(() => copy.textContent = "コピー", 1500); } });
    const share = document.createElement("button"); share.className = "btn btn-ghost btn-sm"; share.textContent = "共有・メール";
    share.addEventListener("click", async () => { if (navigator.share) { try { await navigator.share({ title: "部品注文リスト", text: orderText }); return; } catch (e) { if (e && e.name === "AbortError") return; } } location.href = "mailto:?subject=" + encodeURIComponent("部品注文リスト") + "&body=" + encodeURIComponent(orderText); });
    bar.append(copy, share); list.appendChild(bar);
    box.appendChild(list);
  }
  // ③-2 別途必要な工具(SST・特殊工具・個人では持っていないことの多い工具)。部品と同じくタップで購入ポップアップ
  const sTools = Array.isArray(obj.specialTools) ? obj.specialTools.filter(t => t && t.name) : [];
  if (sTools.length) {
    const h = document.createElement("div"); h.className = "ai-h orderHead";
    h.innerHTML = '<span>別途必要な工具</span><span class="orderLegend">SST・特殊工具／あると便利</span>';
    box.appendChild(h);
    const list = document.createElement("div"); list.className = "orderBox";
    sTools.forEach(t => {
      const nameStr = han(String(t.name)).trim();
      const isBenri = /便利/.test(String(t.kind || ""));
      const row = document.createElement("div"); row.className = "orderRow";
      const nm = document.createElement("button"); nm.type = "button"; nm.className = "orderName orderNameTap";
      nm.innerHTML = '<span class="orderCaret">▾ </span>' + esc(nameStr) +
        (isBenri ? '<span class="toolTag toolTagBenri">あると便利</span>' : '<span class="toolTag toolTagMust">必須</span>');
      nm.title = "通販で探す";
      nm.addEventListener("click", () => openShopPopup(nameStr, nameStr));
      row.appendChild(nm);
      list.appendChild(row);
      if (t.note) { const nt = document.createElement("div"); nt.className = "orderToolNote"; nt.textContent = han(String(t.note)); list.appendChild(nt); }
    });
    box.appendChild(list);
  }
  // ④ 特殊作業(EPB/SAS/DPF再生/バッテリー登録等の注意)
  if (obj.special && !/特になし/.test(obj.special)) { sec("特殊作業"); const p = document.createElement("div"); p.className = "ai-p"; p.textContent = han(String(obj.special)); box.appendChild(p); }
  // 手動での整備モード移行手順(診断機不要)。目立たない折り畳みで表示
  const ms = obj.manualService;
  if (ms && Array.isArray(ms.steps) && ms.steps.length) {
    const det = document.createElement("details"); det.className = "manualMode";
    // 「（診断機非使用時）」「(診断機不要)」等の注記は表示名から除去
    let mname = han(String(ms.name || "手動での整備モード手順")).replace(/[（(][^（()）]*(診断機|スキャンツール|ツール)[^（()）]*[)）]/g, "").trim();
    const sm = document.createElement("summary"); sm.textContent = mname || "手動での整備モード手順";
    det.appendChild(sm);
    const ol = document.createElement("ol"); ol.className = "manualSteps";
    ms.steps.forEach(s => {
      const li = document.createElement("li");
      li.textContent = han(String(s)).replace(/^\s*\d+\s*[.．、)）]\s*/, "");   // 先頭の「1.」等はol側で振るため除去
      ol.appendChild(li);
    });
    det.appendChild(ol);
    box.appendChild(det);
  }
  // ⑤ 交換手順(タップでその手順の工具を表示・部品名からのジャンプ先アンカー)
  if (Array.isArray(obj.steps) && obj.steps.length) {
    sec("交換手順");
    const ol = document.createElement("ol"); ol.className = "guide-steps ai-list";
    obj.steps.forEach((s, i) => {
      const text = (s && typeof s === "object") ? (s.text || "") : String(s);
      const tools = (s && s.tools && s.tools.length) ? s.tools : [];
      const li = document.createElement("li"); li.id = "rstep-" + (i + 1); li.className = "hasTools";
      const d = document.createElement("div");
      const t = document.createElement("div"); t.className = "ai-cause stepBody";
      // 手順文は均一な文字で表示(先頭の「1.」等はol側の番号と重複するため除去)
      t.textContent = han(text).replace(/^\s*\d+\s*[.．、)）]\s*/, "");
      d.appendChild(t);
      const toolBox = document.createElement("div"); toolBox.className = "stepTools hidden";
      toolBox.innerHTML = tools.length ? '<b>使う工具:</b> ' + tools.map(x => esc(han(String(x)))).join(" ・ ") : "この手順の工具情報はありません。";
      d.appendChild(toolBox);
      li.appendChild(d);
      d.addEventListener("click", () => { toolBox.classList.toggle("hidden"); });   // 案内文言は出さずタップで開閉のみ
      ol.appendChild(li);
    });
    box.appendChild(ol);
  }
  // ⑥ 締付トルク・規定値(部位ごとに「部位 … 値」の2列で見やすく)
  if (obj.torque) {
    sec("締付トルク・規定値");
    const raw = keepUnit(han(String(obj.torque)));
    // 末尾の注記(（…FAINES/確認/推奨/目安…）)を分離
    let body = raw, note = "";
    const nm = raw.match(/[（(][^（()）]*(?:FAINES|確認|推奨|目安|参考)[^（()）]*[)）]\s*$/);
    if (nm) { note = nm[0].replace(/^[（(]/, "").replace(/[)）]\s*$/, ""); body = raw.slice(0, nm.index).trim().replace(/[、,／/;]\s*$/, ""); }
    // 「/」「、」「,」「;」いずれの区切りでも部位ごとに分割
    const items = body.split(/\s*[\/／、,;]\s*/).map(s => s.trim()).filter(Boolean);
    const list = document.createElement("div"); list.className = "torqueList";
    items.forEach(it => {
      const row = document.createElement("div"); row.className = "torqueRow";
      const m = it.match(/^(.+?)\s*[:：]\s*(.+)$/);
      if (m) {
        const val = m[2];
        // 多段トルク等で値が長い場合は、部位名の縦つぶれを防ぐため上下2段で表示
        const longVal = /→|段階|ステップ|step/i.test(val) || val.length > 16;
        if (longVal) row.classList.add("torqueRowStack");
        const k = document.createElement("span"); k.className = "tqK"; k.textContent = m[1];
        const v = document.createElement("span"); v.className = "tqV"; v.textContent = val;
        row.append(k, v);
      } else { row.textContent = it; }
      list.appendChild(row);
    });
    box.appendChild(list);
    if (note) { const n = document.createElement("div"); n.className = "torqueNote"; n.textContent = "※ " + note; box.appendChild(n); }
  }
  // 修理タブの各項目(見出し=ai-h単位)を折り畳み式(details)にまとめる。見出しの無い要素は直前セクション内へ。
  const kids = [...box.children];
  box.innerHTML = "";
  let curBody = null;
  kids.forEach(el => {
    if (el.classList.contains("ai-h")) {
      const det = document.createElement("details"); det.className = "repairSec";   // 初期は閉じる
      const sm = document.createElement("summary"); sm.className = "repairSecSum"; sm.innerHTML = el.innerHTML;
      const bd = document.createElement("div"); bd.className = "repairSecBody";
      det.append(sm, bd); box.appendChild(det); curBody = bd;
    } else if (curBody) { curBody.appendChild(el); }
    else { box.appendChild(el); }
  });
}
/* 交換手順の工具リストから、手で使う工具(締める/緩める/挟む/切る系)を抽出(重複除去)。
   ソケット/メガネ/スパナはmmサイズで、ヘックス/トルクスは番手で。
   さらにプライヤー・ペンチ・ニッパー・ドライバー・モンキー・トルクレンチ等の名前付き工具も追加。
   ジャッキ・ウマ(リジッドラック)・輪止め・ウエス等の支持/昇降/補助具は除外。 */
const TOOL_EXCLUDE = /(ジャッキ|ウマ|馬|リジッドラック|ジャッキスタンド|スタンド|輪止め|車止め|リフト|ウエス|布|ぼろ布|手袋|グローブ|受け皿|トレイ|トレー|バット|パーツクリーナー|ブレーキクリーナー|クリーナー|保護メガネ|ゴーグル|安全|脚立|ドレンパン)/;
/* サイズを持たない名前付き工具(挟む/切る/締緩の手工具のみ)。上から順に判定し最初の一致を採用 */
const NAMED_TOOLS = [
  { re: /(ウォーターポンププライヤー|ウォーポン)/, label: "ウォーターポンププライヤー" },
  { re: /(スナップリングプライヤー|サークリッププライヤー|スナップリング|サークリップ)/, label: "スナップリングプライヤー" },
  { re: /バイスプライヤー/, label: "バイスプライヤー" },
  { re: /ラジオペンチ/, label: "ラジオペンチ" },
  { re: /(コンビネーションプライヤー|プライヤー)/, label: "プライヤー" },
  { re: /ペンチ/, label: "ペンチ" },
  { re: /(ニッパー|ニッパ)/, label: "ニッパー" },
  { re: /(ケーブルカッター|ワイヤーカッター)/, label: "ケーブルカッター" },
  { re: /(貫通ドライバー)/, label: "貫通ドライバー" },
  { re: /(プラスドライバー|＋ドライバー|\+ドライバー|プラスドライバ)/, label: "プラスドライバー" },
  { re: /(マイナスドライバー|－ドライバー|-ドライバー|マイナスドライバ)/, label: "マイナスドライバー" },
  { re: /(トルクスドライバー|トルクスビット|ヘクスローブドライバー)/, label: "トルクスドライバー" },
  { re: /(六角(棒)?レンチ|ヘックスレンチ|アーレンキー|六角レンチ)/, label: "六角レンチ" },
  { re: /トルクレンチ/, label: "トルクレンチ" },
  { re: /(インパクトレンチ|電動インパクト|インパクトドライバー)/, label: "インパクトレンチ" },
  { re: /モンキー(レンチ)?/, label: "モンキーレンチ" },
  { re: /(内張り(はがし|剥がし)|クリップリムーバー|クリップクランプ|パネルはがし|リムーバー)/, label: "内張りはがし(クリップリムーバー)" }
];
function extractWrenchSizes(steps) {
  const sizes = new Set(), named = new Set();
  (Array.isArray(steps) ? steps : []).forEach(s => {
    const tools = (s && Array.isArray(s.tools)) ? s.tools : [];
    tools.forEach(t => {
      const str = han(String(t || ""));
      if (TOOL_EXCLUDE.test(str)) return;   // ジャッキ・ウマ等は工具一覧に載せない
      // ソケット/コマ/メガネ/スパナ/ボックスレンチ に付くmmサイズ
      if (/(ソケット|コマ|メガネ|スパナ|ボックス)/.test(str)) {
        (str.match(/\d{1,2}(?:\.\d)?\s*mm/gi) || []).forEach(m => sizes.add(m.replace(/\s+/g, "").toUpperCase().replace("MM", "mm")));
      }
      // ヘックス(六角)・トルクスは番手で
      let m;
      if ((m = str.match(/(?:ヘックス|HEX)[^0-9]{0,4}(\d{1,2})/i))) sizes.add("HEX" + m[1]);
      if ((m = str.match(/(?:トルクス|TORX|T)\s?(\d{2})/i))) sizes.add("T" + m[1]);
      // 名前付きの手工具(挟む/切る/締緩)
      for (const nt of NAMED_TOOLS) { if (nt.re.test(str)) { named.add(nt.label); break; } }
    });
  });
  return [...sizes, ...named];   // サイズ工具 → 名前付き工具 の順
}
function jumpToStep(box, n) {
  const li = box.querySelector("#rstep-" + n); if (!li) return;
  li.scrollIntoView({ behavior: "smooth", block: "center" });
  li.classList.remove("stepFlash"); void li.offsetWidth; li.classList.add("stepFlash");
}

/* 車両が変わったら診断・修理タブの前車両データを消す(混ざり防止) */
/* 車両ごとの作業内容(故障診断結果・修理質問)を保持。切替時に前車両を退避し、選んだ車両の内容を復元。 */
const vehWork = {};   // vehicleKey -> {diagText, diagNodes[], qVehText, qVehShown, qVehNodes[]}
function saveVehWork(key) {
  if (!key) return;
  vehWork[key] = {
    diagText: ($("diagText") || {}).value || "",
    diagNodes: $("diagResults") ? [...$("diagResults").childNodes] : [],
    qVehText: ($("qVehText") || {}).value || "",
    qVehShown: $("qVehResult") ? !$("qVehResult").classList.contains("hidden") : false,
    qVehNodes: $("qVehResult") ? [...$("qVehResult").childNodes] : [],
  };
}
function restoreVehWork(key) {
  const w = vehWork[key];
  const setNodes = (id, nodes) => { const el = $(id); if (!el) return; el.innerHTML = ""; (nodes || []).forEach(n => el.appendChild(n)); };
  if ($("diagText")) $("diagText").value = w ? w.diagText : "";
  setNodes("diagResults", w ? w.diagNodes : []);
  if ($("qVehText")) $("qVehText").value = w ? w.qVehText : "";
  setNodes("qVehResult", w ? w.qVehNodes : []);
  toggle("qVehResult", !!(w && w.qVehShown && w.qVehNodes && w.qVehNodes.length));
}

function showResult(d, opt = {}) {
  // 別車両に切り替わったら、前車両の作業内容を退避し、選んだ車両の内容を復元(診断・修理を保持)
  const oldKey = current ? vehicleKey(current) : null;
  const newKey = vehicleKey(d);
  if (oldKey !== newKey) {
    try { cancelAI(); } catch (e) {} saveVehWork(oldKey); restoreVehWork(newKey);
    // 別車両に変えたら、診断・修理の入力欄に残った写真/動画/コメント(添付ステージング)はクリア(前車両の物が混ざらない)
    try { clearDiagAttachments(); } catch (e) {}
    try { clearVehAttachments(); } catch (e) {}
    if ($("diagText")) $("diagText").value = "";
    if ($("qVehText")) $("qVehText").value = "";
  }
  current = d;
  if (typeof scanning !== "undefined" && scanning) stopLiveScan(false);
  switchView("scan");
  toggle("result", true);
  // 毎回まず「何をしますか？」の選択に戻す
  toggle("choicePanel", true); toggle("vidEdit", false); toggle("secRaw", false); toggle("vidSavedMsg", false);
  toggle("mechaHero", false);   // 車両表示中はメカ君ヒーローを隠す
  // フォールバックUI・スキャン進捗は畳む。次の撮影は新しい車両として開始
  foldEntryAreas();
  toggle("scanProgress", false); toggle("scanActions", false); toggle("qrPhotoStatus", false);
  scanComplete = true;
  // 保存済みの使用者名を表示
  const histEntry = findHistEntry(getHistory(), d);
  setText("rUser", noEmail(histEntry && histEntry.name) || "—");   // メール混入は表示しない
  // QR生データがあり、未取得項目があればAI解析(自動実行・タップ不要)
  current.qrRaw = d.qrRaw && d.qrRaw.length ? d.qrRaw : (current.qrRaw || []);
  // 限定表示項目: 車台番号 / 原動機型式 / 登録番号 / 指定・類別 / 使用者
  const missing = !d.engine || !d.plate || !d.kataShitei;
  toggle("aiQrParse", current.qrRaw.length > 0 && missing);
  toggle("aiQrStatus", false);
  aiQrDone = false;
  // スキャン由来で未取得項目がある時は、メカ君のQR解析を自動で開始(ワンタップ不要)
  if (opt && opt.fromScan && !opt.noAutoAi && current.qrRaw.length > 0 && missing) setTimeout(() => { if (!aiQrDone) runAiQrParse(true); }, 60);
  setText("rEngine", han(d.engine) || "—");
  setText("rVin", han(d.vin) || "未検出");
  setText("rPlate", han(d.plate) || "—");
  setText("rKata", han(formatKata(d.kataShitei)) || "記載なし");
  if (typeof renderCopyKata === "function") renderCopyKata();     // 修理タブのコピーを更新
  // 先に履歴へ統合保存(=ridを確定)してから「前回車両」カードを書く。
  // これをしないと、車台番号・登録番号が無い型式のみの車両で、カードのrid/使用者名/原動機型式が
  // 古いまま残り、再読み込み後に手動修正が元に戻る(rid未確定→findHistEntry不一致→古いカードに戻る)。
  // 解析(OCR/AI補完)と並行して、スキャン認識後すぐに区分・担当者ポップを出す(待たせない)。
  if (opt.fromScan && (d.type || d.vin)) { addHistory(d); setTimeout(() => openIntakePopup(d), 120); }
  if (typeof pushRecentVehicle === "function") pushRecentVehicle(d);  // 表示した車両を記録(前回=最後に表示していた車両)
  toggle("lastVehicle", false);   // 車両を表示中は「前回の車両」チップは出さない(ホームでのみ表示)
  try { updateVidIntakeBtn(d); } catch (e) {}   // カードの「区分選択」ボタンの表示/ラベルを更新

  // DB照合: 型式のハイフン以降(無ければ全体)
  let hit = null;
  if (d.type) {
    const code = (d.type.includes("-") ? d.type.split("-")[1] : d.type).toUpperCase();
    hit = findVehicle(code);
  }
  // 車台番号で登録済みカスタムレコードも照合(型式が無い/一致しない車両のため)
  if (d.vin) {
    const byVin = CUSTOM_DB.find(x => x.vin && x.vin === d.vin);
    if (byVin && (!hit || hit !== byVin)) hit = byVin;
  }
  const histEntry2 = findHistEntry(getHistory(), d);
  const learned = getLearned(vehicleKey(d));
  // DB(カスタム=ユーザーが直接編集できる正データ)を最優先。無ければ学習/履歴
  const dbFaults = (hit && hit.faults) || [];
  const learnedFaults = (histEntry2 && histEntry2.faults) || (learned && learned.faults) || [];
  const allFaults = dbFaults.length
    ? [...dbFaults, ...learnedFaults.filter(f => !dbFaults.includes(f))]
    : learnedFaults;

  // 手動修正済みの正データがあれば、履歴・学習の車種名もそれに揃える(誤特定名の残留を解消)
  if (hit && hit.manual && hit.name) {
    const hh = getHistory(); const te = findHistEntry(hh, d);
    if (te && te.model !== hit.name) { te.model = hit.name; te.updatedAt = Date.now(); localStorage.setItem(LS.hist, JSON.stringify(hh)); if (window.Cloud) window.Cloud.pushRecord(te); }
    if (!learned || learned.model !== hit.name) setLearned(vehicleKey(d), { model: hit.name });
  }
  const m = $("rMatch");
  if (hit) {
    m.textContent = "⚙ 車種DB一致: " + hit.name;
    if (hit.notes) { setText("notesBody", hit.notes); toggle("secNotes", true); } else toggle("secNotes", false);
  } else {
    m.textContent = "";   // 「未登録」表記は出さない(代わりに修正/保存ボタンを設置)
    toggle("secNotes", false);
  }
  renderFaultList(allFaults); toggle("secFault", allFaults.length > 0);
  // 諸元: 「最も新しく更新されたデータ」を表示する(端末間で別IDのDB重複があっても、訂正の取りこぼしを防ぐ)。
  // 候補: DBレコード(hit) / 車両レコード(履歴) / 学習。updatedAtが最大で諸元を持つものを採用。
  const learnedAt = learned && learned.at ? Date.parse(learned.at) || 0 : 0;
  const specCands = [
    { list: hit && hit.specs, t: (hit && hit.updatedAt) || 0, src: "db" },
    { list: histEntry2 && histEntry2.specs, t: (histEntry2 && histEntry2.updatedAt) || 0, src: "learned" },
    { list: learned && learned.specs, t: learnedAt, src: "learned" },
  ];
  let bestSpec = null;
  for (const c of specCands) if (c.list && c.list.length && (!bestSpec || c.t >= bestSpec.t)) bestSpec = c;
  if (bestSpec && bestSpec.list.length) renderSpecs(bestSpec.list, bestSpec.src);
  else renderSpecs([], "");

  // リコール: 同様に最新を優先
  const recallCands = [
    { list: hit && hit.recalls, t: (hit && hit.updatedAt) || 0 },
    { list: histEntry2 && histEntry2.recalls, t: (histEntry2 && histEntry2.updatedAt) || 0 },
    { list: learned && learned.recalls, t: learnedAt },
  ];
  let bestRecall = null;
  for (const c of recallCands) if (c.list && c.list.length && (!bestRecall || c.t >= bestRecall.t)) bestRecall = c;
  const recalls = (bestRecall && bestRecall.list) || [];
  renderRecalls(recalls);
  const mk = hit ? MAKER_RECALL[hit.maker] : null;
  toggle("secRecall", !!mk || recalls.length > 0 || !!d.vin);
  toggle("lnkMaker", !!mk);
  if (mk) {
    $("lnkMlit").href = MLIT_RECALL;
    const lm = $("lnkMaker");
    lm.firstChild.textContent = mk.label; lm.href = mk.url;
  }
  $("lnkGoogle").href = "https://www.google.com/search?q=" + encodeURIComponent((d.type || d.vin || "") + " リコール 改善対策");
  renderRecallVin(d.type, d.vin);   // 型式(車台番号から特定)と車台番号をそれぞれコピー

  // RAWチップ (「手動で修正する」リンクから開く。読取データが無ければリンク自体を隠す)
  const wrap = $("rawChips"); wrap.innerHTML = "";
  (d.raw || []).forEach(f => {
    const c = document.createElement("div"); c.className = "chip"; c.textContent = f;
    c.addEventListener("click", () => showAssign(f)); wrap.appendChild(c);
  });
  // 履歴への統合保存は上部(pushRecentVehicleの直前)で実施済み。
  toggle("karteForm", false); renderKarte();   // 整備カルテ(車両ごとの作業記録)
  $("result").scrollIntoView({ behavior: "smooth" });
}

/* 割り当てバー */
let pendingVal = null;
function showAssign(v) { pendingVal = v; setText("abVal", v); toggle("assignBar", true); }
function hideAssign() { toggle("assignBar", false); pendingVal = null; }
document.querySelectorAll("#assignBar [data-assign]").forEach(b =>
  b.addEventListener("click", () => {
    if (!pendingVal) return;
    const k = b.dataset.assign;
    const uc = zen2han(pendingVal).toUpperCase().trim();
    if (k === "type") current.type = uc;
    else if (k === "engine") current.engine = uc;
    else if (k === "vin") current.vin = uc;
    else if (k === "plate") current.plate = pendingVal.trim();              // 登録番号は大文字化しない(漢字含む)
    else if (k === "kataShitei") current.kataShitei = uc.replace(/[^0-9]/g, "");
    else if (k === "firstReg") {                                            // YYMM / YYYY年M月 等を解釈
      const m = uc.replace(/[^0-9]/g, "");
      if (m.length === 4) current.firstReg = parseYYMM(m);
      else if (m.length === 6) current.firstReg = { year: +m.slice(0, 4), month: +m.slice(4, 6) };
    } else if (k === "expiry") {
      const m = uc.replace(/[^0-9]/g, "");
      if (m.length === 6) current.expiry = parseYYMMDD(m);
      else if (m.length === 8) current.expiry = new Date(+m.slice(0, 4), +m.slice(4, 6) - 1, +m.slice(6, 8));
    }
    // accにも反映(上書き)してQR解析ボタンの状態と整合
    if (typeof acc !== "undefined") acc[k] = current[k];
    hideAssign(); showResult(current, { fromScan: true });  // 割り当てた値も履歴(DB)へ保存
  }));
$("abClose").addEventListener("click", hideAssign);

/* メンテナンス諸元 [{k,v}] を表形式で表示 */
let shownSpecs = [];        // 現在表示中の諸元(訂正の初期値に使う)
/* 初度登録年月からOBD検査(OBD確認検査)の対象時期かを端末側で判定して諸元行を返す。
   AI任せだと『確証なし』で省かれるため、初度登録が令和3年10月以降なら必ず表示する。 */
function obdSpec() {
  const d = current || {};
  const fr = d.firstReg;
  if (!fr || !fr.year || !fr.month) return null;
  const ym = fr.year * 100 + fr.month;
  if (ym < 202110) return null;   // 令和3年10月より前の初度登録は対象外
  const reg = fr.year + "年" + fr.month + "月";
  // 令和6年10月以降の初度登録は検査が実適用される時期。それ以前は対象車の可能性(型式指定日で確定)。
  const v = (ym >= 202410)
    ? "対象車（初度登録 " + reg + "・令和6年10月〜適用）"
    : "対象車の可能性（初度登録 " + reg + "／型式指定日で確定・車検証備考も確認）";
  return { k: "OBD検査", v: v };
}
function renderSpecs(specs, source) {
  shownSpecs = dedupSpecs(normalizeSpecs(specs || []));   // 固まった値は項目ごとに分解し、同義項目の重複は統合して表示
  const realCount = shownSpecs.length;
  // OBD検査対象は初度登録から端末側で判定して必ず表示(未収録なら先頭付近に追加)
  const obd = obdSpec();
  if (obd && !shownSpecs.some(s => /OBD/i.test(String(s.k || "")))) shownSpecs.push(obd);
  const dl = $("specList"); dl.innerHTML = "";
  toggle("specAiBox", false); $("specAiBox").innerHTML = "";  // 車両が変わったらAI結果をリセット
  toggle("specEditBox", false);
  shownSpecs.forEach(s => {
    const item = document.createElement("div"); item.className = "specItem";
    if (s.manual) item.classList.add("specManual");
    const k = document.createElement("div"); k.className = "specK"; k.textContent = cleanCite(han(s.k));
    const v = document.createElement("div"); v.className = "specV";
    // 引用マーカーを除去し、「／」区切りや改行を行分けして見やすく表示
    v.innerHTML = esc(keepUnit(cleanCite(han(s.v)))).replace(/\n/g, "<br>").replace(/\s*[／/]\s*/g, "<br>");
    const up = document.createElement("button"); up.className = "specItemUp"; up.title = "この項目だけAIで最新に更新"; up.textContent = "🔄";
    up.addEventListener("click", e => { e.stopPropagation(); refreshSpecItem(s.k, up); });
    const hint = document.createElement("div"); hint.className = "specTapHint"; hint.textContent = "タップで編集";
    item.append(up, k, v, hint); dl.appendChild(item);
    item.addEventListener("click", () => { if (!item.classList.contains("editing")) enterSpecItemEdit(item, s.k); });
  });
  toggle("specList", shownSpecs.length > 0);
  // 出所ラベル
  const lbl = source === "learned" ? "✓ 訂正保存済みのデータ（この端末に記憶）"
    : source === "db" ? "内蔵データ（参考値）" : "";
  setText("specSource", lbl); toggle("specSource", !!lbl);
  // 訂正ボタンは車両を識別できれば常に出す(保存先キーになる)
  const vk = vehicleKey(current);
  toggle("btnSpecEdit", !!vk);
  // AIで調べるボタンは「保存済み or 内蔵データが無い」時だけ表示
  toggle("btnSpecAI", shownSpecs.length === 0 && !!vk);
  // 最新に更新ボタンは、諸元が既にある時に表示(再取得して都度DB更新)
  toggle("btnSpecReload", shownSpecs.length > 0 && !!vk);
  // 内蔵データが無くても車両を識別できればセクションは出す
  toggle("secSpec", shownSpecs.length > 0 || !!vk);
}

/* 諸元項目をタップ → その場で項目名・値を編集して保存(手動修正) */
function enterSpecItemEdit(item, key) {
  if (!vehicleKey(current)) { uiAlert("車両を識別できないため編集できません(車台番号や指定・類別が必要です)。"); return; }
  const s = shownSpecs.find(x => x.k === key) || { k: key, v: "" };
  item.classList.add("editing"); item.innerHTML = "";
  const ik = document.createElement("input"); ik.type = "text"; ik.className = "seK"; ik.value = s.k; ik.placeholder = "項目名";
  const iv = document.createElement("textarea"); iv.className = "seV"; iv.value = s.v; iv.placeholder = "値・内容"; iv.rows = 2;
  const row = document.createElement("div"); row.className = "specEditInline";
  const save = document.createElement("button"); save.type = "button"; save.className = "btn btn-amber btn-sm"; save.textContent = "保存";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn-ghost btn-sm"; cancel.textContent = "取消";
  save.addEventListener("click", () => saveSpecItemInline(key, ik.value.trim(), iv.value.trim(), false));
  cancel.addEventListener("click", () => renderSpecs(shownSpecs, "learned"));
  iv.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save.click(); });
  row.append(save, cancel);
  if (isManager()) {   // 諸元の削除は管理者のみ(未ログインの個人利用も可)
    const del = document.createElement("button"); del.type = "button"; del.className = "btn btn-ghost btn-sm"; del.textContent = "削除";
    del.addEventListener("click", () => { if (confirm("この項目を削除しますか？")) saveSpecItemInline(key, "", "", true); });
    row.append(del);
  }
  item.append(ik, iv, row);
  iv.focus();
}
/* 新しい諸元項目を1件、その場編集で追加 */
function addSpecItemInline() {
  if (!vehicleKey(current)) { uiAlert("車両を識別できないため追加できません(車台番号や指定・類別が必要です)。"); return; }
  toggle("secSpec", true); toggle("specList", true);
  const item = document.createElement("div"); item.className = "specItem editing";
  const ik = document.createElement("input"); ik.type = "text"; ik.className = "seK"; ik.placeholder = "項目名(例: エンジンオイル量)";
  const iv = document.createElement("textarea"); iv.className = "seV"; iv.placeholder = "値・内容"; iv.rows = 2;
  const row = document.createElement("div"); row.className = "specEditInline";
  const save = document.createElement("button"); save.type = "button"; save.className = "btn btn-amber btn-sm"; save.textContent = "保存";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn-ghost btn-sm"; cancel.textContent = "取消";
  save.addEventListener("click", () => saveSpecItemInline(null, ik.value.trim(), iv.value.trim(), false));
  cancel.addEventListener("click", () => renderSpecs(shownSpecs, "learned"));
  ik.addEventListener("keydown", e => { if (e.key === "Enter") iv.focus(); });
  row.append(save, cancel);
  item.append(ik, iv, row);
  $("specList").appendChild(item);
  item.scrollIntoView({ block: "center", behavior: "smooth" });
  ik.focus();
}
function saveSpecItemInline(oldKey, newKey, newVal, remove) {
  let specs = shownSpecs.slice();
  const idx = specs.findIndex(x => x.k === oldKey);
  if (remove) { if (idx >= 0) specs.splice(idx, 1); }
  else {
    if (!newKey) { uiAlert("項目名を入力してください。"); return; }
    const item = { k: newKey, v: newVal, manual: true };   // 手動修正としてマーク(AI更新でも保持)
    if (idx >= 0) specs[idx] = item; else specs.push(item);
  }
  setLearned(vehicleKey(current), { specs });
  saveVehicleAiData(specs, null);
  registerVehicleToDB({ silent: true });
  renderSpecs(specs, "learned");
}

/* =========================================================
   整備カルテ(車両ごとの作業記録) — 写真OCR不要・手入力/音声入力
   履歴レコードの karte 配列に保存し、社内共有(union同期)
   ========================================================= */
/* 2端末で同時追加しても両方残るよう id で統合(削除は deleted フラグでソフト削除) */
function mergeKarte(a, b) {
  const m = {};
  [...(a || []), ...(b || [])].forEach(e => {
    if (!e || !e.id) return;
    const p = m[e.id];
    if (!p || String(e.at || "") > String(p.at || "")) m[e.id] = e;
  });
  return Object.values(m).sort((x, y) =>
    String(y.date || "").localeCompare(String(x.date || "")) || String(y.at || "").localeCompare(String(x.at || "")));
}
function getKarteList() {
  const e = findHistEntry(getHistory(), current);
  return mergeKarte(e && e.karte, []).filter(k => !k.deleted);
}
/* 担当者テキスト→店舗メンバーを特定。まず高速な文字照合、外れたらAIで漢字↔カナ↔かな↔ローマ字・
   苗字/名前だけの表記ゆれを判別する(よみの事前登録は不要)。結果{uid,name} or null。 */
async function resolveKarteOwner(staff) {
  staff = (staff || "").trim();
  if (!staff || !window.Cloud || !window.Cloud.resolveMember) return null;
  const quick = window.Cloud.resolveMember(staff);
  if (quick) return quick;
  const members = (window.Cloud.tenantMembers && window.Cloud.tenantMembers()) || [];
  if (!members.length) return null;
  // メンバーが1人＝担当者は自明。AIを使わず本人に割当。
  if (members.length === 1) return { uid: members[0].uid, name: members[0].name };
  try {
    const list = members.map((m, i) => (i + 1) + ". " + m.name).join("\n");
    const prompt = "整備カルテの『担当者』欄の入力が、下の店舗メンバー一覧の誰を指すか判定してください。\n" +
      "入力は氏名の一部(苗字だけ/名前だけ)のことや、漢字・カタカナ・ひらがな・ローマ字の違いがあります。読み(発音)が一致すれば同一人物とみなします。\n" +
      "担当者の入力: 「" + staff + "」\n\nメンバー一覧:\n" + list +
      "\n\n該当する人の番号を半角数字で1つだけ返してください。確信が持てない/該当なしは 0。数字以外は出力しないこと。";
    const r = await geminiAsk(prompt, { mode: "flash", maxTokens: 8 });
    const n = parseInt(String((r && r.text) || "").replace(/[^0-9]/g, ""), 10);
    if (n >= 1 && n <= members.length) return { uid: members[n - 1].uid, name: members[n - 1].name };
  } catch (e) {}
  return null;
}
/* 担当者をAI込みで特定してから保存(担当変更で編集権限を移すため)。 */
async function saveKarteSmart(entry) {
  try { entry._owner = await resolveKarteOwner(entry.staff || ""); } catch (e) { entry._owner = undefined; }
  saveKarteEntry(entry);
}
function saveKarteEntry(entry) {
  let e = findHistEntry(getHistory(), current);
  if (!e) { addHistory(current); e = findHistEntry(getHistory(), current); if (!e) return; }
  const h2 = getHistory();
  const t = findHistEntry(h2, current); if (!t) return;
  const list = (t.karte || []).slice();
  const idx = list.findIndex(k => k.id === entry.id);
  // 編集権限は「担当者(staff)」に従う。担当者名がメンバーとして特定できれば、その人を編集権限者(by)にする。
  // → 担当をAからBへ変更して保存すると、編集権限もBへ移る。特定できない自由入力時は記入者を維持。
  // 担当者の特定結果。事前にAIで判別済み(_owner)ならそれを優先、無ければ高速な文字照合。
  const owner = (entry._owner !== undefined) ? entry._owner
    : ((window.Cloud && window.Cloud.resolveMember) ? window.Cloud.resolveMember(entry.staff || "") : null);
  delete entry._owner;
  if (idx >= 0) {
    const prev = list[idx];
    if (owner) { entry.by = owner.uid; entry.byName = owner.name; }
    else { entry.by = prev.by || null; entry.byName = prev.byName || entry.staff || null; }
    list[idx] = entry;
  } else {
    if (owner) { entry.by = owner.uid; entry.byName = owner.name; }
    else {
      entry.by = (window.Cloud && window.Cloud.myUid && window.Cloud.myUid()) || null;
      entry.byName = (window.Cloud && window.Cloud.myName && window.Cloud.myName()) || entry.staff || null;
    }
    list.unshift(entry);
  }
  t.karte = list; t.updatedAt = Date.now();
  localStorage.setItem(LS.hist, JSON.stringify(h2));
  if (window.Cloud) window.Cloud.pushRecord(t);   // 社内共有へ
  if (!entry.auto) { try { reconcileFluidsFromKarte(entry); } catch (e) {} }   // 油脂類の実績量で諸元を自動更新(AI自動記録は対象外)
}
/* カルテ編集・削除の権限: 未ログイン(個人利用)=可 / 管理者=常に可 /
   従業員=「担当者」に指定された本人のみ。担当を別メンバーへ変えると編集権限もその人へ移る。 */
function canEditKarte(k) {
  if (!window.Cloud || !window.Cloud.isLoggedIn || !window.Cloud.isLoggedIn()) return true;
  if (window.Cloud.isManager && window.Cloud.isManager()) return true;
  const uid = (window.Cloud.myUid && window.Cloud.myUid()) || "";
  // 担当者名がメンバーとして特定できれば、その担当者だけが編集可(担当変更で権限が移る)
  const owner = (k && k.staff && window.Cloud.resolveMember) ? window.Cloud.resolveMember(k.staff) : null;
  if (owner) return owner.uid === uid;
  // 担当者が特定できない(自由入力/未登録)場合は、記入者本人のみ
  if (k && k.by) return k.by === uid;
  return !!(k && k.byName && k.byName === (window.Cloud.myName && window.Cloud.myName()));
}
function renderKarte() {
  const box = $("karteList"); if (!box) return;
  box.innerHTML = "";
  if (!current || !vehicleKey(current)) { box.innerHTML = '<div class="hint">車両を読み込むと、その車の作業記録を残せます。まず車検証をスキャンするか、履歴/検索から車両を開いてください。</div>'; return; }
  const list = getKarteList();
  if (!list.length) { box.innerHTML = '<div class="hint">まだ記録がありません。「＋ 記録を追加」から作業内容を残せます。</div>'; return; }
  list.forEach(k => {
    const card = document.createElement("div"); card.className = "karteItem";
    // ヘッダー: 日付/走行/担当 + 編集・削除
    const head = document.createElement("div"); head.className = "kHead";
    const metaBits = [dispText(k.date), k.odo ? han(String(k.odo)) + "km" : "", k.staff ? "担当: " + esc(han(k.staff)) : ""].filter(Boolean);
    head.innerHTML = '<span class="kDate">' + metaBits.join(' <i class="kSep">・</i> ') + '</span>';
    const btns = document.createElement("div"); btns.className = "kBtns";
    if (canEditKarte(k)) {   // 記入者本人・管理者のみ 編集/削除ボタンを表示
      const edit = document.createElement("button"); edit.className = "kEdit"; edit.textContent = "編集";
      edit.addEventListener("click", () => editKarteInline(card, k));
      const del = document.createElement("button"); del.className = "kDel"; del.textContent = "削除";
      del.addEventListener("click", () => {
        if (!confirm("この記録を削除しますか？")) return;
        saveKarteEntry(Object.assign({}, k, { deleted: true, at: new Date().toISOString() }));
        renderKarte();
      });
      btns.append(edit, del);
    }
    head.appendChild(btns);
    // 本文: 作業・部品は「、,改行」で分割して箇条書き。費用・メモは1行。
    const body = document.createElement("div"); body.className = "kBody";
    const block = (label, val) => {
      if (!val) return "";
      // 区切りは「改行・読点・カンマ」のみ。スペース/中黒(・)では分割しない(N・mや空けた表記を壊さない)
      const items = String(val).split(/[、,，\n]+/).map(s => han(s).trim()).filter(Boolean);
      if (items.length <= 1) return '<div class="kBlock"><span class="kLbl">' + label + '</span><div class="kVal">' + esc(keepUnit(han(String(val)))) + '</div></div>';
      return '<div class="kBlock"><span class="kLbl">' + label + '</span><ul class="kItems">' + items.map(i => '<li>' + esc(keepUnit(i)) + '</li>').join("") + '</ul></div>';
    };
    // 部品は「部品名＋数量」を1行に並べ、右側に数量列を作る(数字始まりのトークンを直前の部品名の数量とみなす)
    const partsBlock = (val) => {
      if (!val) return "";
      const toks = String(val).split(/[、,，・\s]+/).map(s => han(s).trim()).filter(Boolean);
      const rows = []; let name = [];
      toks.forEach(t => { if (/^\d/.test(t) && name.length) { rows.push({ n: name.join(" "), q: t }); name = []; } else name.push(t); });
      if (name.length) rows.push({ n: name.join(" "), q: "" });
      if (!rows.length) return "";
      // 見栄え: 末尾の(…)/（…）は改行して小さく別行に。ASSY等の長名は1行に収める(CSSで縮小)
      const fmtName = n => {
        const m = String(n).match(/^(.*?\S)\s*([（(].*[)）])\s*$/);
        if (m) return esc(m[1]) + '<span class="kPnSub">' + esc(m[2]) + '</span>';
        return esc(n);
      };
      return '<div class="kBlock kParts"><div class="kPartHead"><span class="kLbl">部品</span><span class="kQtyLbl">数量</span></div>' +
        '<ul class="kItems kPartRows">' + rows.map(r => '<li><span class="kPn">' + fmtName(r.n) + '</span><span class="kQty">' + esc(r.q) + '</span></li>').join("") + '</ul></div>';
    };
    // AI自動記録のメモは「・箇条書き」にせず、改行をそのまま活かして表示(見出し＋①②…の素の行)
    const noteBlock = (label, val) => {
      if (!val) return "";
      const html = esc(keepUnit(han(String(val)))).replace(/\n/g, "<br>");
      return '<div class="kBlock"><span class="kLbl">' + label + '</span><div class="kVal kValPre">' + html + '</div></div>';
    };
    body.innerHTML = block("作業", k.work) + partsBlock(k.parts) +
      (k.cost ? '<div class="kBlock"><span class="kLbl">費用</span><div class="kVal">¥' + han(String(k.cost)) + '</div></div>' : "") +
      (k.auto ? noteBlock("メモ", k.note) : block("メモ", k.note));
    card.append(head, body); box.appendChild(card);
  });
}
/* カード内でその場編集(別フォームに飛ばず直接編集) */
function editKarteInline(card, k) {
  card.innerHTML = "";
  const wrap = document.createElement("div"); wrap.className = "kEditBox";
  const row = (label, el) => { const r = document.createElement("div"); r.className = "kEditRow"; const l = document.createElement("label"); l.className = "fld"; l.textContent = label; r.append(l, el); return r; };
  const inp = (type, val) => { const i = document.createElement("input"); i.type = type; if (val != null) i.value = val; return i; };
  const ta = (val, ph) => { const t = document.createElement("textarea"); t.className = "kGrow"; t.style.minHeight = "48px"; if (val) t.value = val; if (ph) t.placeholder = ph; return t; };
  const nl = v => v ? String(v).replace(/[、,，]\s*/g, "\n").replace(/\n{2,}/g, "\n").trim() : "";   // 区切り(読点・カンマ)を改行に。中黒(・)は単位で使うため分割しない
  const dDate = inp("date", k.date || ""); const dOdo = inp("number", k.odo != null ? k.odo : ""); dOdo.inputMode = "numeric";
  const dWork = ta(nl(k.work), "1行に1件（作業内容）"); const dParts = ta(nl(k.parts), "1行に1件（交換部品・使用材料）");
  const dCost = inp("number", k.cost != null ? k.cost : ""); dCost.inputMode = "numeric"; const dStaff = inp("text", k.staff || "");
  const dNote = ta(k.note, "メモ");
  wrap.append(row("日付", dDate), row("走行距離(km)", dOdo), row("作業内容", dWork), row("交換部品・使用材料", dParts), row("費用(円)", dCost), row("担当者", dStaff), row("メモ", dNote));
  const btns = document.createElement("div"); btns.className = "btnRow"; btns.style.marginTop = "10px";
  const save = document.createElement("button"); save.className = "btn btn-amber"; save.textContent = "保存";
  const cancel = document.createElement("button"); cancel.className = "btn btn-ghost"; cancel.style.flex = "0 0 28%"; cancel.textContent = "取消";
  save.addEventListener("click", async () => {
    const work = dWork.value.trim(), parts = dParts.value.trim(), note = dNote.value.trim();
    if (!work && !parts && !note) { uiAlert("作業内容・交換部品・メモのいずれかを入力してください。"); return; }
    setBtnLoading(save, true);
    await saveKarteSmart({ id: k.id, date: dDate.value || "", odo: dOdo.value ? Number(dOdo.value) : null, work, parts, cost: dCost.value ? Number(dCost.value) : null, staff: dStaff.value.trim(), note, at: new Date().toISOString() });
    renderKarte();
  });
  cancel.addEventListener("click", renderKarte);
  btns.append(save, cancel); wrap.appendChild(btns);
  card.appendChild(wrap);
  autoGrowAll();
}
function openKarteForm(edit) {
  if (!vehicleKey(current)) { uiAlert("車両を識別できないため記録できません(車台番号や指定・類別が必要です)。"); return; }
  const today = new Date(); const iso = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  $("kDate").value = (edit && edit.date) || iso;
  $("kOdo").value = (edit && edit.odo) || "";
  $("kWork").value = (edit && edit.work) || "";
  $("kParts").value = (edit && edit.parts) || "";
  $("kCost").value = (edit && edit.cost) || "";
  $("kStaff").value = (edit && edit.staff) || (window.Cloud && window.Cloud.myName && window.Cloud.myName()) || "";
  $("kNote").value = (edit && edit.note) || "";
  karteEditId = edit ? edit.id : null;
  toggle("karteForm", true);
  autoGrowAll();   // 内容に合わせて入力欄の高さを調整
  $("karteForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
/* テキストエリアを内容量に応じて自動拡大 */
function autoGrow(el) { if (!el) return; el.style.height = "auto"; el.style.height = Math.max(el.clientHeight, el.scrollHeight) + "px"; }
function autoGrowAll() { document.querySelectorAll(".kGrow").forEach(autoGrow); }
document.addEventListener("input", e => { if (e.target && e.target.classList && e.target.classList.contains("kGrow")) autoGrow(e.target); });
let karteEditId = null;
$("btnKarteAdd") && $("btnKarteAdd").addEventListener("click", () => openKarteForm(null));
$("btnKarteCancel") && $("btnKarteCancel").addEventListener("click", () => { stopFieldMic(); toggle("karteForm", false); });
$("btnKarteSave") && $("btnKarteSave").addEventListener("click", () => {
  stopFieldMic();
  const work = $("kWork").value.trim();
  const parts = $("kParts").value.trim();
  const note = $("kNote").value.trim();
  if (!work && !parts && !note) { uiAlert("作業内容・交換部品・メモのいずれかを入力してください。"); return; }
  const entry = {
    id: karteEditId || ("k" + Date.now() + Math.floor(Math.random() * 1000)),
    date: $("kDate").value || "", odo: $("kOdo").value ? Number($("kOdo").value) : null,
    work, parts, cost: $("kCost").value ? Number($("kCost").value) : null,
    staff: $("kStaff").value.trim(), note,
    at: new Date().toISOString(),
  };
  const sb = $("btnKarteSave"); setBtnLoading(sb, true);
  saveKarteSmart(entry).then(() => { setBtnLoading(sb, false); toggle("karteForm", false); renderKarte(); });
});

/* 写真から自動入力: 作業伝票/メモ等の画像をAI(マルチモーダル)で解析し各項目に下書き */
let kartePhotoMedia = [];   // カメラで撮った写真(圧縮済み {mimeType,data})を蓄積 → まとめてAI読み取り
function renderKartePhotoStatus() {
  const st = $("kPhotoStatus"); if (!st) return;
  toggle("kPhotoStatus", true);
  const n = kartePhotoMedia.length;
  const thumbs = kartePhotoMedia.map(m => '<img class="kThumb" src="data:' + m.mimeType + ';base64,' + m.data + '" alt="">').join("");
  st.innerHTML =
    '<div class="kThumbRow">' + thumbs +
      '<button type="button" class="kThumbAdd" id="kPhotoMore" aria-label="写真を追加">＋</button></div>' +
    '<div class="kPhotoBtns">' +
      '<button type="button" class="btn btn-amber" id="kPhotoRun">読み取り（' + n + '枚）</button>' +
      '<button type="button" class="btn btn-ghost btn-sm kPhotoClear" id="kPhotoClear">クリア</button>' +
    '</div>';
  $("kPhotoMore").onclick = () => openKarteCamera();
  $("kPhotoRun").onclick = runKartePhotoOCR;
  $("kPhotoClear").onclick = () => { kartePhotoMedia = []; toggle("kPhotoStatus", false); };
}
$("btnKartePhoto") && $("btnKartePhoto").addEventListener("click", () => {
  if (!vehicleKey(current)) { uiAlert("車両を識別してから記録してください(車台番号や指定・類別が必要です)。"); return; }
  if (!aiOK()) {
    uiAlert("写真からの自動入力には無料のGemini APIキーの設定が必要です（設定タブ）。");
    switchView("settings"); return;
  }
  kartePhotoMedia = [];            // 新規スタート
  openKarteCamera();               // ライブカメラ(外カメラ)を起動
});
/* カルテ写真: ライブカメラ(getUserMedia facingMode=environment)で確実に外カメラ撮影。
   capture属性は端末により内カメラになるため、こちらを既定にする。非対応時はファイル入力へフォールバック。 */
let kcStream = null;
async function openKarteCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $("kPhotoIn").click(); return; }
  let ov = document.getElementById("kcOverlay");
  if (!ov) {
    ov = document.createElement("div"); ov.id = "kcOverlay"; ov.className = "kcOverlay";
    ov.innerHTML =
      '<video id="kcVideo" class="kcVideo" playsinline muted></video>' +
      '<div class="kcTip">書類を枠いっぱいに。丸ボタンで撮影、複数枚OK</div>' +
      '<div class="kcBar">' +
        '<button type="button" class="kcClose" id="kcClose" aria-label="閉じる">×</button>' +
        '<button type="button" class="kcShot" id="kcShot" aria-label="撮影"></button>' +
        '<button type="button" class="kcDone" id="kcDone">完了 <span id="kcCount">0</span></button>' +
      '</div>';
    document.body.appendChild(ov);
    document.getElementById("kcClose").onclick = () => { closeKarteCamera(); renderKartePhotoStatus(); };
    document.getElementById("kcShot").onclick = shotKarteCamera;
    document.getElementById("kcDone").onclick = () => { closeKarteCamera(); renderKartePhotoStatus(); };
  }
  ov.style.display = "flex";
  document.getElementById("kcCount").textContent = kartePhotoMedia.length;
  const v = document.getElementById("kcVideo");
  try {
    kcStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    v.srcObject = kcStream; await v.play();
  } catch (e) { closeKarteCamera(); $("kPhotoIn").click(); }   // カメラ不許可等はファイル入力へ
}
function shotKarteCamera() {
  const v = document.getElementById("kcVideo"); if (!v || !v.videoWidth) return;
  const maxDim = 1280, scale = Math.min(1, maxDim / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(1, Math.round(v.videoWidth * scale)), h = Math.max(1, Math.round(v.videoHeight * scale));
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(v, 0, 0, w, h);
  const durl = cv.toDataURL("image/jpeg", 0.7), i = durl.indexOf("base64,");
  if (i >= 0) kartePhotoMedia.push({ mimeType: "image/jpeg", data: durl.slice(i + 7) });
  document.getElementById("kcCount").textContent = kartePhotoMedia.length;
  const ov = document.getElementById("kcOverlay"); if (ov) { ov.classList.add("kcFlash"); setTimeout(() => ov.classList.remove("kcFlash"), 130); }
}
function closeKarteCamera() {
  if (kcStream) { try { kcStream.getTracks().forEach(t => t.stop()); } catch (e) {} kcStream = null; }
  const ov = document.getElementById("kcOverlay"); if (ov) ov.style.display = "none";
}
$("kPhotoIn") && $("kPhotoIn").addEventListener("change", async e => {
  const files = Array.from(e.target.files || []); e.target.value = ""; if (!files.length) return;
  const st = $("kPhotoStatus"); toggle("kPhotoStatus", true);
  st.innerHTML = '<img src="img/kangae.png" class="btnMecha spin" alt=""> 写真を圧縮しています…';
  // 撮影ごとに圧縮して蓄積(何枚でも追加可)。撮り終えたら「AIで読み取り」を押す。
  for (const f of files) {
    const data = await imageToCompressedBase64(f, 1280, 0.7);
    if (data) kartePhotoMedia.push({ mimeType: "image/jpeg", data: data });
  }
  renderKartePhotoStatus();
});
async function runKartePhotoOCR() {
  if (!kartePhotoMedia.length) return;
  const st = $("kPhotoStatus"); toggle("kPhotoStatus", true);
  const nPhotos = kartePhotoMedia.length;
  st.innerHTML = '<img src="img/kangae.png" class="btnMecha spin" alt=""> メカ君が写真' + (nPhotos > 1 ? nPhotos + "枚" : "") + 'を読み取っています…(数十秒かかる場合があります)';
  try {
    const prompt = [
      "次の画像は日本の自動車整備士が書いた『手書きの作業メモ』です(伝票やレシートの場合もあります)。字が崩れていたり略字・専門用語が多いので、整備の文脈で丁寧に判読してください。読み取った内容を整備カルテの各項目に整理してJSONで返します。",
      nPhotos > 1 ? "画像は複数枚ありますが、すべて同じ1件の整備作業に関するメモです。全ての画像の内容を統合して、1つのカルテにまとめて返してください(項目ごとに全画像の情報を合わせる。部品は全画像分を列挙)。" : "",
      "略号の展開(整備現場の頻出略号。書かれていれば正式名に展開してよい。※メーカー名・数量・品番など書かれていない情報は足さない): E/O=エンジンオイル, O/E=オイルエレメント(オイルフィルター), B/O=ブレーキオイル(ブレーキフルード), M/O=ミッションオイル, T/M=トランスミッション, A/T=オートマチックオイル, CVT/F=CVTフルード, D/O=デフオイル, P/S=パワステフルード, L/L=ロングライフクーラント(冷却水), F/パッド=フロントブレーキパッド, R/パッド=リアブレーキパッド, F/ローター=フロントローター, R/ローター=リアローター, W/ブレード=ワイパーブレード, バッテリ/BATT=バッテリー, プラグ=スパークプラグ, エレメント=フィルター, O/H=オーバーホール, 脱着=取り外し・取り付け。",
      "判読のヒント: 『OIL/オイル交換』『EG/エンジン』『ミッション/AT/CVT』『Fブレーキ/Rブレーキ』『パッド』『ローター』『バッテリー/BATT』『エレメント/フィルター』『点検』『下回り』等の整備略語を考慮。走行距離は『8.2万km』『82,000』『82000キロ』等どの表記でも数値(km)に統一。日付は和暦・年月日・『R7.6.1』等でも西暦YYYY-MM-DDに変換(年が無ければ空文字)。金額の『¥』『円』『,』は除いて数値のみ。",
      "各項目に振り分け: work=実施した作業/点検内容, parts=交換した部品・使用材料(品番があれば含む), cost=合計金額の数値, staff=担当者/記入者名, note=次回の申し送り・特記(不具合や気づき)。判読できない文字は無理に決めつけず、その項目は空にする。",
      "【最重要・厳守】メモに書かれていない情報を勝手に補完・推測・追加しないこと。特にメーカー名・銘柄・商品名・品番・数量・単位は、メモに明記されていない限り一切足さない(例: 『オイル 3.7L』とだけあれば、そのまま『オイル 3.7L』とし、メーカー名や『エンジンオイル』等の語を付け足さない)。あくまで書かれた文字をそのまま転記する。",
      "出力は厳密なJSONのみ(前後の文章・コードフェンス・説明は不要)。数字は半角。",
      "形式: {\"date\":\"\",\"odo\":null,\"work\":\"\",\"parts\":\"\",\"cost\":null,\"staff\":\"\",\"note\":\"\"}",
    ].join("\n");
    const r = await geminiAskMedia(prompt, kartePhotoMedia);   // 蓄積した圧縮済み写真をまとめて送信
    const obj = extractJson(r.text) || {};
    openKarteForm(null);   // フォームを開いてから流し込む(当日日付・担当者を初期化した上で上書き)
    if (obj.date) $("kDate").value = String(obj.date).trim();
    if (obj.odo != null && obj.odo !== "") $("kOdo").value = String(obj.odo).replace(/[^\d]/g, "");
    if (obj.work) $("kWork").value = String(obj.work).trim();
    if (obj.parts) $("kParts").value = String(obj.parts).trim();
    if (obj.cost != null && obj.cost !== "") $("kCost").value = String(obj.cost).replace(/[^\d]/g, "");
    if (obj.staff) $("kStaff").value = String(obj.staff).trim();
    if (obj.note) $("kNote").value = String(obj.note).trim();
    st.textContent = "✓ 写真" + (nPhotos > 1 ? nPhotos + "枚を統合して" : "を") + "読み取りました。内容を確認・修正して保存してください。";
    kartePhotoMedia = [];   // 読み取り完了 → 蓄積をクリア
  } catch (err) {
    st.textContent = "⚠ " + (err.message === "__cancelled__" ? "中断しました" : (err.message || "写真を読み取れませんでした")) + "（手入力・音声入力もできます）";
  }
}

/* 車両識別キー: 型式 > 指定・類別 > 車台番号 の順(型式を読まなくても記憶できる) */
function vehicleKey(d) {
  d = d || current;
  if (d.type) return d.type.toUpperCase();
  if (d.kataShitei) return "K:" + String(d.kataShitei).replace(/[^0-9]/g, "");
  if (d.vin) return "V:" + d.vin.toUpperCase();
  return null;
}
/* 学習データ(localStorage)。1キーに諸元(specs)と定番故障/持病(faults)をまとめて記憶し次回はAI不要 */
function getLearned(key) {
  if (!key) return null;
  try { return (JSON.parse(localStorage.getItem("ss_learnedspecs") || "{}"))[key] || null; } catch (e) { return null; }
}
function setLearned(key, patch) {
  if (!key) return;
  try {
    const c = JSON.parse(localStorage.getItem("ss_learnedspecs") || "{}");
    c[key] = Object.assign({}, c[key], patch, { key, at: new Date().toISOString() });
    localStorage.setItem("ss_learnedspecs", JSON.stringify(c));
  } catch (e) {}
}
function getLearnedSpecs(d) { const e = getLearned(vehicleKey(d)); return (e && e.specs) || null; }
/* AIで取得した諸元・故障を車両レコード(履歴=DB)へ自動保存(車台番号で同一車両を特定) */
function saveVehicleAiData(specs, faults, recalls, extra) {
  const hist = getHistory();
  let e = findHistEntry(hist, current);
  if (!e) { addHistory(current); e = findHistEntry(getHistory(), current); if (!e) return; }
  const h2 = getHistory();
  const t = findHistEntry(h2, current); if (!t) return;
  if (specs && specs.length) t.specs = specs;
  if (faults && faults.length) t.faults = faults;
  if (recalls && recalls.length) t.recalls = recalls;
  if (extra && extra.model) t.model = extra.model;
  if (extra && extra.maker) t.maker = extra.maker;
  t.aiAt = new Date().toISOString(); t.updatedAt = Date.now();
  localStorage.setItem(LS.hist, JSON.stringify(h2));
  if (window.Cloud) window.Cloud.pushRecord(t);   // 諸元・故障も社内共有へ
}
function specsToText(specs) { return (specs || []).map(s => s.k + ": " + s.v).join("\n"); }

/* 油脂類の種別グループ(カルテ部品名・諸元項目名の両方をこのキーワードで判定) */
const FLUID_GROUPS = [
  { canon: "エンジンオイル", kw: ["エンジンオイル", "エンジン油", "eo", "e/o"] },
  { canon: "ミッションオイル", kw: ["ミッションオイル", "ミッション", "トランスミッション", "ギヤオイル", "ギアオイル", "m/t", "mtオイル"] },
  { canon: "デフオイル", kw: ["デフオイル", "デフ", "デファレンシャル", "終減速", "ディファレンシャル"] },
  { canon: "ブレーキフルード", kw: ["ブレーキフルード", "ブレーキ液", "ブレーキオイル", "フルード"] },
  { canon: "パワステフルード", kw: ["パワステ", "パワーステアリング", "psf", "p/s"] },
  { canon: "クーラント", kw: ["クーラント", "冷却水", "llc", "ロングライフ", "不凍液"] },
  { canon: "ATF", kw: ["atf", "オートマオイル"] },
  { canon: "CVTフルード", kw: ["cvt"] },
  { canon: "アドブルー", kw: ["アドブルー", "adblue", "尿素水"] },
];
const fluidNorm = s => String(s || "").toLowerCase().replace(/[\s　]+/g, "");
function fluidGroupOf(name) { const n = fluidNorm(name); return FLUID_GROUPS.find(g => g.kw.some(k => n.includes(fluidNorm(k)))) || null; }
function parseLiters(v) { const m = String(v || "").match(/([\d]+(?:\.\d+)?)\s*[lLｌＬ]/); return m ? parseFloat(m[1]) : null; }
/* カルテの油脂類の実績量(L)を諸元(この車両の記憶値)へ反映。相違があれば諸元を実績値で更新して保存。 */
function reconcileFluidsFromKarte(entry) {
  if (!entry || entry.deleted || !entry.parts || !current) return;
  // 行・区切りごとに分解(改行/、/,/・/スペース)。1件ずつ油脂グループと量(L)を判定。
  const segs = String(entry.parts).split(/[\r\n、,，・]+/).map(s => han(s).trim()).filter(Boolean);
  const found = [];
  segs.forEach(seg => {
    const g = fluidGroupOf(seg); if (!g) return;                                  // 油脂類のみ
    // 粘度表記(例 5W-30 / 0w20)の数字を量と誤認しないよう先に除去
    const cleaned = seg.replace(/\d+\s*w[\s-]*\d+/gi, " ");
    let liters = null;
    // ① 単位付き(L/ℓ/リットル)を最優先
    let m = cleaned.match(/(\d+(?:\.\d+)?)\s*(?:[lLｌＬℓ]|リットル|ﾘｯﾄﾙ)/);
    if (m) liters = parseFloat(m[1]);
    // ② 単位が無くても、油脂行に現れる妥当な数量(0.1〜50L想定)を量として拾う
    if (liters == null) { const m2 = cleaned.match(/(?:^|[^0-9.])(\d+(?:\.\d+)?)(?![0-9.])/); if (m2) { const n = parseFloat(m2[1]); if (n > 0 && n <= 50) liters = n; } }
    if (liters == null) return;
    found.push({ g, liters, qtyStr: liters + "L" });
  });
  if (!found.length) return;
  // 同一グループが複数行あれば最後の値を採用(重複排除)
  { const map = new Map(); found.forEach(f => map.set(f.g.canon, f)); found.length = 0; map.forEach(v => found.push(v)); }
  const he = findHistEntry(getHistory(), current) || {};
  const learned = getLearned(vehicleKey(current)) || {};
  let specs = ((he.specs && he.specs.length ? he.specs : learned.specs) || []).map(s => s.manual ? { k: s.k, v: s.v, manual: true } : { k: s.k, v: s.v });
  const changes = [];
  found.forEach(f => {
    // 同じ油脂グループの諸元項目を探す
    const i = specs.findIndex(s => { const g = fluidGroupOf(s.k); return g && g.canon === f.g.canon; });
    if (i < 0) {
      // 諸元に該当項目が無ければ、カルテ実績から新規追加(緑=手動確定)
      specs.push({ k: f.g.canon + "量", v: f.qtyStr, manual: true });
      changes.push({ k: f.g.canon + "量", oldV: "", newV: f.qtyStr });
      return;
    }
    const cur = parseLiters(specs[i].v);
    if (cur != null && Math.abs(cur - f.liters) < 0.001) return;   // 一致していれば変更なし
    changes.push({ k: specs[i].k, oldV: specs[i].v, newV: f.qtyStr });
    specs[i] = { k: specs[i].k, v: f.qtyStr, manual: true };   // 実績確定値として緑で固定(AI再読込でも上書きされない)
  });
  if (!changes.length) return;
  saveVehicleAiData(specs);                          // 履歴(DB)＋社内共有へ
  setLearned(vehicleKey(current), { specs });        // この端末の記憶へ
  // メンテ画面を開いていれば即再描画
  const mv = document.getElementById("view-maint");
  if (mv && mv.classList.contains("active") && typeof renderSpecs === "function") renderSpecs(specs, "learned");
  // 表示は簡潔に。括弧書き(例:「デフオイル（デファレンシャルオイル）」)や末尾「量」を落として重複を防ぐ
  const shortK = k => String(k).replace(/[（(].*?[）)]/g, "").replace(/量$/, "").trim();
  showToast("諸元を更新しました\n" + changes.map(c => "・" + shortK(c.k) + " " + c.newV).join("\n"));
}
function textToSpecs(text) {
  return (text || "").split(/\n+/).map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.search(/[:：]/);
    return i > 0 ? { k: l.slice(0, i).trim(), v: l.slice(i + 1).trim() } : { k: l, v: "" };
  }).filter(s => s.k);
}
/* 諸元テキスト → [{k,v}] 抽出。改行が無く「項目: 値。項目: 値。」の文章でも分割できる */
let lastSpecAiText = "";
function splitSpecText(text) {
  let t = " " + (text || "").replace(/```/g, "").replace(/[■【][^。\n]*[】]?/g, " ");
  t = t.replace(/その他[^:：。\n]*[:：]/g, " ");   // 「その他…追加:」等のノイズを除去
  // 「。」「・」「番号.」「改行」の直後に来る『短いラベル:』の前で改行(値の途中の。では切らない)
  t = t.replace(/([。\n・]|\d+[.)、]\s)\s*(?=[^\s:：。、，)）]{2,16}[:：])/g, "$1\n");
  return t.split(/\n+/)
    .map(s => s.replace(/^[\s。・]+/, "").replace(/^\d+[.)、]\s*/, "").trim())
    .filter(Boolean)
    .map(seg => {
      const i = seg.search(/[:：]/); if (i <= 0) return null;
      const k = seg.slice(0, i).trim();
      const v = seg.slice(i + 1).trim().replace(/[。\s]+$/, "");
      return (k && v && k.length <= 16) ? { k, v } : null;
    })
    .filter(Boolean);
}
const aiTextToSpecs = splitSpecText;
/* 1項目に固まった値を項目ごとに分解(壊れた保存データの表示・編集を救済) */
function normalizeSpecs(specs) {
  const out = [];
  (specs || []).forEach(s => {
    // 値に複数の「ラベル:」が含まれる＝固まったデータ → 分解
    const merged = splitSpecText(s.k + ": " + s.v);
    if (merged.length > 1) out.push(...merged.map(m => s.manual ? { ...m, manual: true } : m));
    else out.push(s.manual ? { k: s.k, v: s.v, manual: true } : { k: s.k, v: s.v });
  });
  // 値が空 or「（要確認）」だけの項目は非表示(見苦しいため)。ただし手入力項目は残す
  const isEmptyish = v => { const t = String(v || "").replace(/[（）()\s]/g, ""); return t === "" || t === "要確認"; };
  // 「該当なし/非該当/装備なし/存在しない」等＝その車両に存在しない項目は表示しない
  const isNotApplicable = v => {
    const t = String(v || "").normalize("NFKC").replace(/[（）()\[\]【】\s　]/g, "").toLowerCase();
    return /^(該当なし|該当無し|該当せず|非該当|なし|無し|装備なし|設定なし|該当項目なし|存在しない|n\/?a|none)/.test(t)
      || /(該当なし|非該当|存在しない|装備されていない|設定されていない|該当する.*ない)/.test(t);
  };
  // 同名項目は先勝ちで重複排除。表示名は既知の正式名称に正規化(AI出力の表記ゆれ・文字化け対策)
  const seen = new Set();
  return out.filter(s => {
    if (!s.manual && isEmptyish(s.v)) return false;
    if (!s.manual && isNotApplicable(s.v)) return false;   // 該当なしは非表示
    if (!s.manual) s.k = canonDisplayKey(s.k);              // 例: クーラant量 → クーラント量
    const key = s.k; if (seen.has(key)) return false; seen.add(key); return true;
  });
}

/* 項目ごとの訂正フォーム(行ごとに 項目名／値) */
function addSpecRow(k, v) {
  const row = document.createElement("div"); row.className = "specEditRow";
  const ik = document.createElement("input"); ik.type = "text"; ik.className = "seK"; ik.placeholder = "項目"; ik.value = k || "";
  const iv = document.createElement("input"); iv.type = "text"; iv.className = "seV"; iv.placeholder = "値"; iv.value = v || "";
  const del = document.createElement("button"); del.type = "button"; del.className = "seDel"; del.textContent = "×";
  del.addEventListener("click", () => row.remove());
  row.append(ik, iv, del);
  $("specEditRows").appendChild(row);
}
function collectSpecRows() {
  // 直前の表示値と比較し、変更した項目(と新規項目)だけ「手動修正」フラグを付ける
  const prior = {}; (shownSpecs || []).forEach(s => { prior[s.k] = { v: s.v, manual: !!s.manual }; });
  const out = [];
  $("specEditRows").querySelectorAll(".specEditRow").forEach(r => {
    const k = r.querySelector(".seK").value.trim(), v = r.querySelector(".seV").value.trim();
    if (!k) return;
    const p = prior[k];
    const manual = p ? (p.v !== v ? true : p.manual) : true;   // 値が変わった/新規 → 手動
    out.push(manual ? { k, v, manual: true } : { k, v });
  });
  return out;
}
/* AI諸元に、手動修正済み項目を上書き保持してマージ(『最新に更新』で手入力が消えないように) */
function mergeKeepManual(aiSpecs, curSpecs) {
  const manual = {}; (curSpecs || []).forEach(s => { if (s.manual) manual[s.k] = s; });
  const used = new Set();
  const out = (aiSpecs || []).map(s => {
    if (manual[s.k]) { used.add(s.k); return { k: s.k, v: manual[s.k].v, manual: true }; }
    return s;
  });
  Object.keys(manual).forEach(k => { if (!used.has(k)) out.push({ k, v: manual[k].v, manual: true }); });
  return out;
}
$("btnSpecEdit").addEventListener("click", () => addSpecItemInline());
$("btnSpecAddRow").addEventListener("click", () => addSpecRow("", ""));
$("btnSpecEditCancel").addEventListener("click", () => toggle("specEditBox", false));
$("btnSpecSave").addEventListener("click", () => {
  const vk = vehicleKey(current);
  if (!vk) { uiAlert("車両を識別できないため保存できません(車台番号や指定・類別が必要です)。"); return; }
  const specs = collectSpecRows();
  if (!specs.length) { uiAlert("1件以上入力してください。"); return; }
  setLearned(vk, { specs });
  saveVehicleAiData(specs, null);
  registerVehicleToDB({ silent: true });   // 訂正した諸元をDB登録車種にも反映(更新)
  renderSpecs(specs, "learned");
  toggle("specEditBox", false);
});

function fillList(id, arr, chk) {
  const ul = $(id); ul.innerHTML = "";
  arr.forEach(t => { const li = document.createElement("li"); if (chk) li.className = "chk"; li.textContent = t; ul.appendChild(li); });
}
/* 修理タブへ移動して部品名/症状で手順検索 */
function gotoRepair(term) {
  switchView("parts"); window.scrollTo(0, 0);
  const inp = $("partName"); inp.value = term;
  $("btnPartsGo").click();
}
/* 故障/原因の文からAIで交換部品名を特定 → 修理タブの部品名へ挿入して検索 */
async function gotoRepairFromText(rawText, kind) {
  switchView("parts"); window.scrollTo(0, 0);
  const inp = $("partName");
  let part = rawText;
  if (aiOK()) {
    inp.value = "🔧 部品を特定中…";
    try {
      const lead = kind === "fault"
        ? "次の自動車の定番故障・不具合から、修理で交換する主要な部品名を1つだけ、日本語の部品名のみ短く答えてください(説明・記号・句読点なし)。\n不具合: "
        : "次の自動車の故障原因から、交換・修理対象となる主要な部品名を1つだけ、日本語の部品名のみ短く答えてください(説明・記号・句読点なし)。\n原因: ";
      const r = await geminiAsk(lead + rawText);
      const p = (r.text || "").split(/\n/)[0].replace(/[「」『』。、・*#:：\-]/g, "").trim();
      if (p) part = p.slice(0, 40);
    } catch (e) {}
  }
  inp.value = part;
  $("btnPartsGo").click();
}
/* 原因候補をタップ→修理タブの「点検手順」にAIで詳しい点検方法を表示 */
async function gotoInspection(text) {
  switchView("parts"); window.scrollTo(0, 0);
  toggle("secInspect", true);
  setText("inspectTarget", "点検対象: " + text);
  const box = $("inspectResult"); box.textContent = "🔧 メカ君が点検手順を調べています…(数秒〜十数秒)";
  $("secInspect").scrollIntoView({ behavior: "smooth" });
  if (!aiOK()) {
    box.textContent = "点検手順のAI調査には設定タブで無料Geminiキーが必要です。"; return;
  }
  try {
    const prompt = [
      "あなたは日本の自動車整備士を支援するベテラン整備士『メカ君』です。次の故障原因について、現場での点検方法を、経験の浅い整備士にも分かるよう具体的に説明してください。",
      "前置き・免責不要。Markdown記号(**、#、表)は使わず、必ず次の形式で:",
      "■準備する工具・計測器",
      "必要な工具・テスター等を列挙。",
      "■点検手順",
      "1. どこを どの工具で どう測る/見るか。判定の目安となる数値・状態を必ず添える。",
      "2.（番号順に具体的に。安全確保→分解/アクセス→計測→判定の順）",
      "■判定の目安",
      "正常値・異常値の境目を具体的に。",
      "■次のアクション",
      "点検結果に応じた次の一手を1〜2行。",
      "",
      "■対象車両: " + vehicleDesc(),
      "■点検する原因: " + text,
    ].join("\n");
    const r = await geminiAsk(prompt);
    renderAiAnswer(box, r.text);
  } catch (e) {
    if (e.message !== "__cancelled__") box.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
  }
}
/* 定番故障の重複除去: 言い換えただけの同一内容(2〜3件重複)をまとめる。
   正規化(記号・空白を除く)＋2-gramの類似度で判定し、より詳しい(長い)方を残す。 */
function dedupFaults(list) {
  // 記号除去＋末尾の飾り言葉(症状/不調/傾向 等)を落として「主題」で比較しやすくする
  const norm = s => String(s || "").replace(/[\s、。，,.・「」『』（）()\/／:：;；!！?？…\-–—~〜]/g, "").toLowerCase()
    .replace(/(という|による|といった)?(症状|不具合|不調|トラブル|故障|傾向|現象|問題|事例)(が(発生|多い|出る|見られる)?する?ことがある|が多い|が出る|になる|になりやすい)?$/g, "");
  const bigrams = s => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); if (s.length === 1) g.add(s); return g; };
  const sim = (a, b) => { if (!a.size || !b.size) return 0; let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter); };
  const out = [], keys = [];
  (list || []).forEach(item => {
    const n = norm(item); if (!n) return;
    const bg = bigrams(n);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (n === k.n || n.includes(k.n) || k.n.includes(n) || sim(bg, k.bg) >= 0.5) {
        if (String(item).length > String(out[i]).length) { out[i] = item; keys[i] = { n, bg }; }   // 詳しい方を残す
        return;
      }
    }
    out.push(item); keys.push({ n, bg });
  });
  return out;
}
/* 定番故障・持病の一覧(タップ機能なし) */
function renderFaultList(faults) {
  const ul = $("faultList"); ul.innerHTML = "";
  dedupFaults(faults || []).forEach(t => {
    const li = document.createElement("li"); li.textContent = t;
    ul.appendChild(li);
  });
}
/* AIが調べたリコール・改善対策の一覧を描画(参考情報の注記付き) */
function renderRecalls(recalls) {
  recalls = recalls || [];
  fillList("recallList", recalls, false);
  toggle("recallList", recalls.length > 0);
  toggle("recallNote", recalls.length > 0);
}
/* 車台番号→型式 のキャッシュ＆AI特定 */
function getCachedKata(vin) { try { return JSON.parse(localStorage.getItem("ss_katacache") || "{}")[vinPrefix(vin).toUpperCase()] || null; } catch (e) { return null; } }
function setCachedKata(vin, k) { try { const c = JSON.parse(localStorage.getItem("ss_katacache") || "{}"); c[vinPrefix(vin).toUpperCase()] = k; localStorage.setItem("ss_katacache", JSON.stringify(c)); } catch (e) {} }
async function resolveKatashiki(type, vin) {
  if (type && type.includes("-")) return type;          // 読み取った完全形の型式があればそれ
  if (!vin) return type || "";
  const cached = getCachedKata(vin); if (cached) return cached;
  if (!localStorage.getItem(LS.gemini)) return type || vinPrefix(vin);
  try {
    const prompt = "次の日本の自動車の車台番号から、車検証に記載される『型式』を1つだけ答えてください。型式のみ(例: QKG-FV60VX)、説明・記号・改行なし。車台番号: " + vin + (type ? " / 参考: " + type : "");
    const r = await geminiAsk(prompt);
    const k = (r.text || "").split(/\n/)[0].replace(/[「」『』。、\s]/g, "").trim().toUpperCase();
    if (/^[0-9A-Z]{2,4}-[A-Z0-9]{3,10}$/.test(k)) { setCachedKata(vin, k); return k; }
  } catch (e) {}
  return type || vinPrefix(vin);
}
function renderRecallVin(type, vin) {
  const box = $("recallVin"); box.innerHTML = "";
  if (!vin && !type) return;
  const head = document.createElement("div"); head.className = "hint"; head.style.margin = "0 0 6px";
  head.textContent = "型式・車台番号をコピーして、下のリコール検索サイトに貼り付けて確認できます。";
  box.appendChild(head);
  const cols = document.createElement("div"); cols.style.cssText = "display:flex;flex-direction:column;gap:8px";
  // 修理タブ下部のコピー(.copyKata)と同じ見た目のピルボタン。タップでコピー。
  const mkCol = (label, val) => {
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "copyKata"; btn.style.marginTop = "0";
    const code = document.createElement("b"); code.textContent = val;
    btn.append(document.createTextNode("📋 " + label + ": "), code, document.createTextNode(" をコピー"));
    btn.addEventListener("click", () => {
      copyText(code.textContent);
      btn.innerHTML = "✓ コピー";
      setTimeout(() => { btn.innerHTML = ""; btn.append(document.createTextNode("📋 " + label + ": "), code, document.createTextNode(" をコピー")); }, 1200);
    });
    return { col: btn, code };
  };
  // 型式: 車台番号から正しい型式を特定して表示(初期は仮表示→AI/キャッシュで更新)
  const kataInit = (type && type.includes("-")) ? type : (vin ? (getCachedKata(vin) || vinPrefix(vin)) : (type || ""));
  const kataCol = mkCol("型式", kataInit || "—");
  cols.appendChild(kataCol.col);
  if (vin) cols.appendChild(mkCol("車台番号", vin).col);
  box.appendChild(cols);
  if (vin) resolveKatashiki(type, vin).then(k => { if (k) kataCol.code.textContent = k; });
}

/* =========================================================
   スキャン履歴 (型式/車台番号/日時のみ。所有者情報は保存しない)
   ========================================================= */
function getHistory() {
  try { return JSON.parse(localStorage.getItem(LS.hist)) || []; } catch (e) { return []; }
}
/* 同一車両(車台番号 または ナンバー)の重複を1件に統合。新しい情報・updatedAtを優先して残す */
function dedupeHistory(list) {
  const out = []; const idx = {};
  for (const h of (list || [])) {
    if (!h) continue;
    const key = (h.vin && ("V:" + String(h.vin).toUpperCase())) || (h.plate && ("P:" + normPlate(h.plate))) || null;
    if (key == null) { out.push(h); continue; }
    if (idx[key] == null) { idx[key] = out.length; out.push(h); continue; }
    // 既存とマージ(各フィールドは値がある方/新しい方を採用)
    const a = out[idx[key]];
    const newer = (h.updatedAt || 0) >= (a.updatedAt || 0) ? h : a;
    const older = newer === h ? a : h;
    const pick = k => newer[k] != null ? newer[k] : older[k];
    out[idx[key]] = {
      id: a.id || h.id, rid: newer.rid || older.rid || a.rid || h.rid,
      vin: pick("vin"), plate: pick("plate"), type: pick("type"), engine: pick("engine"),
      name: newer.name != null ? newer.name : older.name,
      model: pick("model"), kataShitei: pick("kataShitei"), firstReg: pick("firstReg"), expiry: pick("expiry"),
      specs: pick("specs"), faults: pick("faults"), recalls: pick("recalls"), maker: pick("maker"),
      karte: mergeKarte(a.karte, h.karte),
      intakeKind: pick("intakeKind"), intakeAt: pick("intakeAt"), intakeOut: pick("intakeOut"),
      feePaid: pick("feePaid"), feeStatus: pick("feeStatus"), officeMemo: pick("officeMemo"), staff: pick("staff"),
      confirms: mergeConfirms(a.confirms, h.confirms),
      at: (newer.at || older.at), updatedAt: Math.max(a.updatedAt || 0, h.updatedAt || 0),
    };
  }
  return out;
}
/* 重複を統合して保存し、統合後の配列を返す(描画・検索の前に呼ぶ) */
function dedupeHistoryStore() {
  const before = getHistory();
  const after = dedupeHistory(before);
  if (after.length !== before.length) localStorage.setItem(LS.hist, JSON.stringify(after.slice(0, 500)));
  return after;
}
/* ナンバー比較用の正規化 (空白・記号除去、全角英数→半角) */
function normPlate(s) {
  if (!s) return "";
  return String(s)
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\-・･.．]/g, "")
    .toUpperCase();
}
/* 不変の識別ID(訂正で登録番号や型式が変わっても同じレコードを追える) */
function newRid() { return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
/* 同一車両の既存履歴を探す (不変ID > 車台番号 > ナンバー の順) */
function findHistEntry(hist, d) {
  return hist.find(h =>
    (d.rid && h.rid && h.rid === d.rid) ||
    (d.vin && h.vin && h.vin === d.vin) ||
    (!d.vin && d.plate && h.plate && normPlate(h.plate) === normPlate(d.plate)));
}
function addHistory(d) {
  const hist = getHistory();
  const exist = findHistEntry(hist, d);
  let target;
  if (exist) {
    // 同一車両: 情報を統合して先頭へ (使用者名・不変IDは保持)
    if (!exist.rid) exist.rid = d.rid || newRid();
    Object.assign(exist, {
      type: d.type || exist.type, vin: d.vin || exist.vin, plate: d.plate || exist.plate,
      engine: d.engine || exist.engine,
      expiry: d.expiry ? d.expiry.getTime() : exist.expiry,
      firstReg: d.firstReg || exist.firstReg, kataShitei: d.kataShitei || exist.kataShitei,
      at: new Date().toISOString(), updatedAt: Date.now(),
    });
    hist.splice(hist.indexOf(exist), 1); hist.unshift(exist);
    target = exist;
  } else {
    target = {
      id: Date.now(), rid: d.rid || newRid(), type: d.type || null, vin: d.vin || null, plate: d.plate || null, name: null,
      engine: d.engine || null,
      expiry: d.expiry ? d.expiry.getTime() : null,
      firstReg: d.firstReg || null, kataShitei: d.kataShitei || null,
      at: new Date().toISOString(), updatedAt: Date.now(),
    };
    hist.unshift(target);
  }
  if (d && !d.rid) d.rid = target.rid;   // current等にも不変IDを伝播(以降の訂正で同じレコードを更新)
  // 店舗ログイン中なら店舗ID(_tid)を刻む → 入庫ボードは自店舗のものだけ表示される(他店舗との混在防止)
  { const t = curTid(); if (t) target._tid = t; }
  localStorage.setItem(LS.hist, JSON.stringify(hist.slice(0, 200)));
  renderHistory();
  if (window.Cloud) window.Cloud.pushRecord(target);   // 社内共有へ
}
/* 現在表示中の車両に使用者名を保存 */
function saveUserName(name) {
  const hist = getHistory();
  let e = findHistEntry(hist, current);
  if (!e) { addHistory(current); e = findHistEntry(getHistory(), current); if (!e) return; }
  const h2 = getHistory();
  const t = findHistEntry(h2, current);
  // 空欄("")は「意図的に消した」印として保持し、統合時に古い名前へ戻らないようにする(null=未入力とは区別)
  if (t) { t.name = noEmail(name); t.updatedAt = Date.now(); localStorage.setItem(LS.hist, JSON.stringify(h2)); renderHistory(); if (window.Cloud) window.Cloud.pushRecord(t); }
}
/* ===== 入庫ボード: スキャンした車両を区分色で現在庫一覧 ===== */
const INTAKE_KINDS = {
  "車検": { label: "車検", cls: "ikShaken" },
  "点検": { label: "点検", cls: "ikTenken" },
  "修理": { label: "修理", cls: "ikRepair" },
  "事故": { label: "板金", cls: "ikJiko" },
};
/* ===== レ点(確認済み): 入庫管理ログイン者ごとに固定色。打つと自分の色の✓が横1列に並ぶ ===== */
const CONFIRM_COLORS = ["#2563EB", "#16A34A", "#EA8C00", "#DC2626", "#7C3AED", "#0891B2", "#DB2777", "#65A30D", "#CA8A04", "#4F46E5", "#0D9488", "#9333EA"];
/* uid/名前から固定色を決定的に割当(毎回同じ色) */
function colorForUser(key) {
  let h = 0; const s = String(key || "guest");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CONFIRM_COLORS[h % CONFIRM_COLORS.length];
}
/* この端末のログイン者の識別子・表示名・色 */
function myConfirmId() {
  const uid = (window.Cloud && typeof window.Cloud.myUid === "function" && window.Cloud.myUid()) || "";
  const nm = (window.Cloud && typeof window.Cloud.myName === "function" && window.Cloud.myName()) || "";
  let dev = ""; try { dev = localStorage.getItem("ss_devId") || ""; if (!dev) { dev = "d" + Math.random().toString(36).slice(2, 8); localStorage.setItem("ss_devId", dev); } } catch (e) {}
  const id = uid || dev;
  return { id, name: nm || "担当", color: colorForUser(id) };
}
/* 確認レ点の配列(uid重複なしでunion。最新atを保持) */
function mergeConfirms(a, b) {
  const map = {};
  (a || []).concat(b || []).forEach(c => { if (c && c.id) { const e = map[c.id]; if (!e || (c.at || 0) >= (e.at || 0)) map[c.id] = c; } });
  return Object.values(map);
}
/* 自分のレ点をトグル(打つ/外す) */
function toggleConfirm(rid) {
  const me = myConfirmId();
  const hist = getHistory(); const t = hist.find(h => h.rid === rid); if (!t) return;
  const arr = Array.isArray(t.confirms) ? t.confirms.slice() : [];
  const i = arr.findIndex(c => c.id === me.id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push({ id: me.id, name: me.name, color: me.color, at: Date.now() });
  t.confirms = arr; t.updatedAt = Date.now();
  localStorage.setItem(LS.hist, JSON.stringify(hist));
  // レ点だけを軽量に反映(全端末への同期を速く)。未対応環境はpushRecordにフォールバック。
  if (window.Cloud) {
    if (typeof window.Cloud.updateRecordFields === "function") window.Cloud.updateRecordFields(t, { confirms: t.confirms });
    else window.Cloud.pushRecord(t);
  }
  renderIntakeBoard();
}
/* 入庫ボードの区分フィルター(この端末で記憶)。"" =すべて / 区分キー */
function getIntakeFilter() { try { return localStorage.getItem("ss_intakeFilter") || ""; } catch (e) { return ""; } }
function setIntakeFilter(k) { try { if (k) localStorage.setItem("ss_intakeFilter", k); else localStorage.removeItem("ss_intakeFilter"); } catch (e) {} renderIntakeBoard(); }
/* 現在ログイン中の店舗(テナント)ID。未ログイン/取得不可なら空文字。 */
function curTid() { return (window.Cloud && typeof window.Cloud.tenantId === "function") ? window.Cloud.tenantId() : ""; }
/* このレコードを今のログイン状態で表示してよいか(店舗をまたいだ入庫ボードの混在を防ぐ)。
   ・未ログイン(個人利用): 店舗タグ(_tid)の無いローカルのみ表示
   ・運営(super): 全店舗を表示(仕様)
   ・店舗ログイン中: 自店舗(_tid一致)のみ表示 */
function recordInScope(h) {
  const loggedIn = !!(window.Cloud && typeof window.Cloud.isLoggedIn === "function" && window.Cloud.isLoggedIn());
  if (!loggedIn) return !h._tid;
  if (window.Cloud && typeof window.Cloud.isSuper === "function" && window.Cloud.isSuper()) return true;
  return !!h._tid && h._tid === curTid();
}
/* 現在入庫中(出庫していない)の履歴レコードを新しい順で返す。ログイン中の店舗のものだけに限定。 */
function activeIntakes() {
  return getHistory()
    .filter(h => h && h.intakeKind && INTAKE_KINDS[h.intakeKind] && !h.intakeOut && recordInScope(h))
    .sort((a, b) => (b.intakeAt || 0) - (a.intakeAt || 0));
}
/* 履歴レコードに入庫区分を設定(=ボードへ)。staff=担当者名(任意) */
function setIntake(rid, kind, staff) {
  if (!INTAKE_KINDS[kind]) return;
  const hist = getHistory();
  const t = hist.find(h => h.rid === rid) || (current && findHistEntry(hist, current));
  if (!t) return;
  t.intakeKind = kind; t.intakeAt = Date.now(); t.intakeOut = null; t.updatedAt = Date.now();
  if (staff !== undefined) t.staff = staff || null;
  localStorage.setItem(LS.hist, JSON.stringify(hist));
  if (window.Cloud) window.Cloud.pushRecord(t);   // 社内共有へ
  markIntakeSeen(rid);
  renderIntakeBoard(); renderHistory();
}
/* 入庫区分だけ変更(入庫日時はそのまま)。staff=担当者名(任意) */
function setIntakeKindOnly(rid, kind, staff) {
  if (!INTAKE_KINDS[kind]) return;
  const hist = getHistory(); const t = hist.find(h => h.rid === rid); if (!t) return;
  t.intakeKind = kind; if (t.intakeOut) { t.intakeOut = null; if (!t.intakeAt) t.intakeAt = Date.now(); }
  if (staff !== undefined) t.staff = staff || null;
  t.updatedAt = Date.now();
  localStorage.setItem(LS.hist, JSON.stringify(hist));
  if (window.Cloud) window.Cloud.pushRecord(t);
  markIntakeSeen(rid);
  renderHistory();   // 履歴のチップ表示も更新(内部でボードも再描画)
}
/* 出庫(ボードから外す。履歴・カルテは残る) */
function clearIntake(rid) {
  const hist = getHistory();
  const t = hist.find(h => h.rid === rid);
  if (!t) return;
  t.intakeOut = Date.now(); t.updatedAt = Date.now();
  // 出庫したらこの入庫のコメント記録・確認レ点はクリア(次回入庫に持ち越さない)。
  // コメントは削除フラグ(del)で消す=union同期で他端末でも復活しない。
  t.comments = rawComments(t).map(c => Object.assign({}, c, { del: true }));
  t.officeMemo = null; t.confirms = [];
  localStorage.setItem(LS.hist, JSON.stringify(hist));
  if (window.Cloud) window.Cloud.pushRecord(t);
  renderIntakeBoard(); renderHistory();
}
/* スキャン確定時の入庫区分ポップアップ。既に入庫中なら出さない */
function openIntakePopup(d) {
  const rid = d && d.rid;
  if (!rid) return;
  const cur = getHistory().find(h => h.rid === rid);
  if (cur && cur.intakeKind && !cur.intakeOut) return;   // 既に入庫中: 二重登録しない
  openIntakeModalFor(rid, [dispText(d.plate), dispText(d.name)].filter(Boolean).join(" ／ ") || dispText(d.type) || "この車両", "new");
}
/* 車両カード(VEHICLE IDENTIFICATION)の「区分選択」ボタン: 表示中の車両に入庫区分を設定/変更する。
   検索で開いた車両(スキャン以外)でも、ここからボードに追加・区分変更できる。 */
function updateVidIntakeBtn(d) {
  const btn = $("btnVidIntake"); if (!btn) return;
  const on = (typeof isManager === "function" && isManager()) && (typeof getAppMode !== "function" || getAppMode() !== "personal");
  toggle("btnVidIntake", !!on);
  if (!on) return;
  const e = d ? findHistEntry(getHistory(), d) : null;
  const active = e && e.intakeKind && INTAKE_KINDS[e.intakeKind] && !e.intakeOut;
  btn.textContent = active ? ("🚦 区分：" + INTAKE_KINDS[e.intakeKind].label + " ▾") : "🚦 区分選択";
}
function openIntakeForCurrent() {
  if (!current) return;
  let e = findHistEntry(getHistory(), current);
  if (!e) { addHistory(current); e = findHistEntry(getHistory(), current); }
  if (!e || !e.rid) { uiAlert("車両を識別できないため区分を設定できません(車台番号や登録番号が必要です)。"); return; }
  const already = e.intakeKind && INTAKE_KINDS[e.intakeKind] && !e.intakeOut;
  const label = [dispText(current.plate), dispText(current.name)].filter(Boolean).join(" ／ ") || dispText(current.type) || "この車両";
  openIntakeModalFor(e.rid, label, already ? "change" : "new");
}
$("btnVidIntake") && $("btnVidIntake").addEventListener("click", openIntakeForCurrent);
/* 区分の変更(既に入庫中の車両)。ボードの区分タグから呼ぶ */
function changeIntakeKind(rid) {
  const h = getHistory().find(x => x.rid === rid); if (!h) return;
  openIntakeModalFor(rid, [dispText(h.plate), dispText(h.name)].filter(Boolean).join(" ／ ") || dispText(h.type) || "この車両", "change");
}
function openIntakeModalFor(rid, label, mode) {
  const modal = $("intakeModal"); if (!modal) return;
  $("ikVeh").textContent = label;
  const ttl = modal.querySelector(".ikTitle"); if (ttl) ttl.textContent = mode === "change" ? "入庫区分を変更しますか？" : "この車の入庫目的は？";
  modal.dataset.rid = rid; modal.dataset.mode = mode || "new";
  setupIntakeStaff(rid);
  toggle("intakeModal", true);
}
/* 入庫モーダルの「担当者」: 枠付きセレクトではなくポップアップ式。
   ボタンに現在の担当者を表示し、タップで名簿ポップアップ(openStaffPicker)を開く。
   担当者は既存の record.staff フィールドを使用(ホーム入庫状況・詳細・クラウド同期と共通)。 */
function setupIntakeStaff(rid) {
  const btn = $("ikStaffBtn"), modal = $("intakeModal");
  if (!btn || !modal) return;
  const office = (typeof officeMode === "function" && officeMode()) || (typeof isManager === "function" && isManager());
  const business = (typeof getAppMode !== "function" || getAppMode() !== "personal");
  if (!office || !business) { toggle("ikStaffBtn", false); modal.dataset.staff = ""; return; }
  const myName = (window.Cloud && window.Cloud.myName && window.Cloud.myName()) || "";
  const rec = getHistory().find(h => h.rid === rid) || null;
  const preset = (rec && rec.staff) ? String(rec.staff) : myName;   // 既存の担当者があればそれ、無ければ自分
  modal.dataset.staff = preset || "";
  updateIntakeStaffLabel(preset, myName);
  toggle("ikStaffBtn", true);
}
function updateIntakeStaffLabel(name, myName) {
  const el = $("ikStaffName"); if (!el) return;
  if (myName === undefined) myName = (window.Cloud && window.Cloud.myName && window.Cloud.myName()) || "";
  el.textContent = name ? (name + (name === myName ? "（自分）" : "")) : "なし";
}
/* 担当者ボタン → 名簿ポップアップ。選んだら modal.dataset.staff とラベルを更新(この時点では保存しない)。 */
$("ikStaffBtn") && $("ikStaffBtn").addEventListener("click", () => {
  const modal = $("intakeModal"); if (!modal) return;
  const cur = modal.dataset.staff || "";
  if (typeof openStaffPicker === "function") {
    openStaffPicker(cur, name => { modal.dataset.staff = name || ""; updateIntakeStaffLabel(name || ""); });
  }
});
(function bindIntakeModal() {
  const modal = document.getElementById("intakeModal"); if (!modal) return;
  modal.querySelectorAll(".ikBtn").forEach(b => b.addEventListener("click", () => {
    const sb = $("ikStaffBtn");
    const staff = (sb && !sb.classList.contains("hidden")) ? (modal.dataset.staff || "") : undefined;   // 担当者ボタンが出ている時だけ反映
    const staffJa = staff ? ("／担当: " + staff) : "";
    if (modal.dataset.mode === "change") {
      setIntakeKindOnly(modal.dataset.rid, b.dataset.kind, staff);
      showToast("入庫区分を変更しました（" + (INTAKE_KINDS[b.dataset.kind] || {}).label + staffJa + "）");
    } else {
      setIntake(modal.dataset.rid, b.dataset.kind, staff);
      showToast("入庫ボードに追加しました（" + (INTAKE_KINDS[b.dataset.kind] || {}).label + staffJa + "）");
    }
    try { if (typeof updateVidIntakeBtn === "function") updateVidIntakeBtn(current); } catch (e) {}   // カードのボタン表示を即更新
    toggle("intakeModal", false);
  }));
  const later = document.getElementById("ikLater");
  if (later) later.addEventListener("click", () => toggle("intakeModal", false));
  modal.addEventListener("click", e => { if (e.target === modal) toggle("intakeModal", false); });
})();
/* ボード描画: ホームで現在庫を区分色カードで表示 */
const _intakePageLoadAt = Date.now();   // このページ読み込み時刻(起動直後グレース判定用)
let _ibSelected = null;   // PC2ペインで右側に表示中の車両rid
/* 通知済みの入庫ridを永続保存(再読み込み後も一度通知したものは二度通知しない) */
function loadIntakeSeen() { try { return new Set(JSON.parse(localStorage.getItem("ss_intakeSeen") || "[]")); } catch (e) { return new Set(); } }
function saveIntakeSeen(set) { try { localStorage.setItem("ss_intakeSeen", JSON.stringify([...set].slice(-500))); } catch (e) {} }
function markIntakeSeen(rid) { if (!rid) return; const s = loadIntakeSeen(); s.add(rid); saveIntakeSeen(s); }   // 自端末の登録等は既知として記録(自己通知を防ぐ)
function notifyNewIntakes(list) {
  const seen = loadIntakeSeen();
  const fresh = list.filter(h => h.rid && !seen.has(h.rid));   // 未通知のものだけ
  fresh.forEach(h => seen.add(h.rid));
  saveIntakeSeen(seen);   // 今ボードにある車両は「既知」として必ず記録(通知の有無に関わらず)
  // 起動直後(8秒)はログイン→クラウド同期の遅延で既存車両が"新規"扱いになるため、通知せず記録だけ。
  if ((Date.now() - _intakePageLoadAt) < 8000) return;
  if (!officeMode()) return;   // 通知は事務用モードの端末のみ(通常ログインには出さない)
  if (!fresh.length) return;
  const h = fresh[0];
  const info = INTAKE_KINDS[h.intakeKind] || { label: h.intakeKind };
  const name = [dispText(h.plate), dispText(h.name)].filter(Boolean).join(" ／ ") || dispText(h.type) || "車両";
  const more = fresh.length > 1 ? "（ほか" + (fresh.length - 1) + "台）" : "";
  notifyAttention("🚗 新しい入庫", "【" + info.label + "】" + name + more + " が入庫しました。", () => { try { goHome(); } catch (e) {} });
}
/* 事務モード(入庫管理専用): この端末をボードだけの全画面にする */
function officeMode() { return localStorage.getItem("ss_office") === "1"; }
/* 費用回収・コメントの編集ができるか(事務モード or 管理者) */
function canEditIntake() { return officeMode() || (typeof isManager === "function" && isManager()); }
/* 費用の状況: 未回収 / 回収済 / 自社立替(法定費用などを店が立て替え) */
const FEE_STATES = {
  unpaid: { label: "未回収", cls: "feeUnpaid" },
  paid: { label: "回収済", cls: "feePaid" },
  advance: { label: "自社立替", cls: "feeAdvance" },
};
const FEE_ORDER = ["unpaid", "paid", "advance"];
/* 旧データ(feePaid真偽)からも状況を判定 */
function feeStateOf(h) {
  if (h && FEE_STATES[h.feeStatus]) return h.feeStatus;
  return (h && h.feePaid === true) ? "paid" : "unpaid";
}
/* 費用の状況を次へ切替(未回収→回収済→自社立替→…) */
function cycleFee(rid) {
  const hist = getHistory(); const t = hist.find(h => h.rid === rid); if (!t) return;
  const next = FEE_ORDER[(FEE_ORDER.indexOf(feeStateOf(t)) + 1) % FEE_ORDER.length];
  t.feeStatus = next; t.feePaid = (next === "paid"); t.updatedAt = Date.now();
  localStorage.setItem(LS.hist, JSON.stringify(hist));
  if (window.Cloud) window.Cloud.pushRecord(t);
  renderIntakeBoard();
}
/* 担当者名の編集(手入力) */
function editIntakeStaff(rid) {
  const hist = getHistory(); const t = hist.find(h => h.rid === rid); if (!t) return;
  const v = prompt("担当者名を入力してください", t.staff || "");
  if (v === null) return;
  t.staff = v.trim() || null; t.updatedAt = Date.now();
  localStorage.setItem(LS.hist, JSON.stringify(hist));
  if (window.Cloud) window.Cloud.pushRecord(t);
  renderIntakeBoard();
}
/* 車両ごとのコメント履歴(複数人で追記・スレッド表示)。旧データ(単一officeMemo)も1件として扱う */
function rawComments(t) {
  if (t && Array.isArray(t.comments)) return t.comments;
  if (t && t.officeMemo) return [{ id: "legacy", name: "", text: t.officeMemo, at: t.updatedAt || Date.now() }];
  return [];
}
/* 表示用: 削除済み(del)を除いたコメント */
function getComments(t) { return rawComments(t).filter(c => c && !c.del); }
function cmtKey(c) { return (c.id || "") + "|" + (c.at || "") + "|" + (c.text || ""); }
/* コメントの複数端末統合(投稿を失わないようunion。削除(del)は優先して残す=消したものが復活しない) */
function mergeComments(a, b) {
  const map = {}; const order = [];
  (a || []).concat(b || []).forEach(c => {
    if (!c || !c.text) return;
    const k = cmtKey(c);
    if (!map[k]) { map[k] = Object.assign({}, c); order.push(k); }
    else if (c.del) map[k].del = true;   // どちらかで削除されていれば削除状態を採用
  });
  return order.map(k => map[k]).sort((x, y) => (x.at || 0) - (y.at || 0));
}
/* コメント削除(打ち間違い等)。物理削除ではなく削除フラグ(del)で他端末の復活を防ぐ */
function deleteComment(rid, target) {
  const hist = getHistory(); const t = hist.find(h => h.rid === rid); if (!t) return;
  const me = myConfirmId();
  const arr = rawComments(t).map(c => Object.assign({}, c));
  const k = cmtKey(target);
  const hit = arr.find(c => cmtKey(c) === k); if (!hit) return;
  if (hit.id !== me.id) return;   // 自分のコメントのみ削除可
  hit.del = true;
  t.comments = arr;
  const live = arr.filter(c => !c.del);
  t.officeMemo = live.length ? live[live.length - 1].text : null;   // プレビューを更新
  t.updatedAt = Date.now();
  localStorage.setItem(LS.hist, JSON.stringify(hist));
  if (window.Cloud) {
    if (typeof window.Cloud.updateRecordFields === "function") window.Cloud.updateRecordFields(t, { comments: t.comments, officeMemo: t.officeMemo });
    else window.Cloud.pushRecord(t);
  }
  if (typeof window.__cmtRefresh === "function") window.__cmtRefresh();
  renderIntakeBoard();
}
function fmtCommentTime(ts) {
  if (!ts) return "";
  const d = new Date(ts), n = new Date(), p = x => String(x).padStart(2, "0");
  const hm = p(d.getHours()) + ":" + p(d.getMinutes());
  return (d.toDateString() === n.toDateString()) ? hm : ((d.getMonth() + 1) + "/" + d.getDate() + " " + hm);
}
/* この端末の識別子(同一アカウントでも端末ごとに区別。コメント通知で自分の投稿端末だけ除外するため) */
function myDevId() {
  try { let d = localStorage.getItem("ss_devId"); if (!d) { d = "d" + Math.random().toString(36).slice(2, 8); localStorage.setItem("ss_devId", d); } return d; } catch (e) { return ""; }
}
/* コメントスレッドを開く(履歴＋追記・リアルタイム更新) */
function openIntakeComments(rid) {
  const getRec = () => getHistory().find(h => h.rid === rid);
  let t = getRec(); if (!t) return;
  const me = myConfirmId();
  document.querySelectorAll(".cmtOv").forEach(x => x.remove());
  const ov = document.createElement("div"); ov.className = "cmtOv";
  const title = dispText(t.plate) || dispText(t.name) || "この車両";
  ov.innerHTML =
    '<div class="cmtBox">' +
      '<div class="cmtHd"><b>💬 コメント</b><span class="cmtCar">' + esc(title) + '</span></div>' +
      '<div class="cmtList" id="cmtList"></div>' +
      '<div class="cmtInputRow">' +
        '<textarea id="cmtInput" class="cmtInput" rows="2" placeholder="連絡事項・費用の内訳・申し送りなど…"></textarea>' +
        '<button type="button" class="cmtSend" id="cmtSend">送信</button>' +
      '</div>' +
      '<div class="cmtHint">投稿すると他の担当者の端末に通知が届きます（Ctrl+Enterでも送信）。</div>' +
      '<button type="button" class="cmtClose" id="cmtClose">閉じる</button>' +
    '</div>';
  document.body.appendChild(ov);
  const listEl = ov.querySelector("#cmtList");
  const draw = () => {
    t = getRec() || t;   // 常に最新(他端末の投稿を反映)
    const cs = getComments(t).slice().sort((a, b) => (a.at || 0) - (b.at || 0));
    if (!cs.length) { listEl.innerHTML = '<div class="cmtEmpty">まだコメントはありません。最初のコメントを追加できます。</div>'; return; }
    listEl.innerHTML = cs.map((c, i) => {
      const mine = c.id === me.id;
      const col = colorForUser(c.id || "legacy");
      // 削除できるのは自分が残したコメントのみ(他人のコメントは消せない)
      const delBtn = mine ? '<button type="button" class="cmtDel" title="自分のコメントを削除" data-i="' + i + '">×</button>' : '';
      return '<div class="cmtItem' + (mine ? " mine" : "") + '" data-i="' + i + '">' +
        '<div class="cmtMeta"><span class="cmtDot" style="background:' + col + '"></span>' +
        '<span class="cmtNm">' + esc(c.name || "担当") + '</span>' +
        '<span class="cmtTime">' + esc(fmtCommentTime(c.at)) + '</span>' + delBtn + '</div>' +
        '<div class="cmtText">' + esc(c.text).replace(/\n/g, "<br>") + '</div></div>';
    }).join("");
    listEl.querySelectorAll(".cmtDel").forEach(btn => btn.addEventListener("click", async () => {
      const c = cs[Number(btn.dataset.i)]; if (!c) return;
      if (c.id !== me.id) { uiAlert("他の担当者のコメントは削除できません。"); return; }
      if (!(await uiConfirm("このコメントを削除しますか？", { okText: "削除", danger: true }))) return;
      deleteComment(rid, c);
    }));
    listEl.scrollTop = listEl.scrollHeight;
  };
  draw();
  const input = ov.querySelector("#cmtInput");
  const send = () => {
    const v = input.value.trim(); if (!v) return;
    const hist = getHistory(); t = hist.find(h => h.rid === rid); if (!t) return;   // 最新を取得してから追記(他端末の投稿を失わない)
    let arr = rawComments(t).map(c => Object.assign({}, c));
    arr.push({ id: me.id, name: me.name, text: v, at: Date.now(), dev: myDevId() });
    t.comments = arr;
    t.officeMemo = v;   // 一覧のプレビュー用に最新コメントを保持
    t.updatedAt = Date.now();
    localStorage.setItem(LS.hist, JSON.stringify(hist));
    if (window.Cloud) {
      if (typeof window.Cloud.updateRecordFields === "function") window.Cloud.updateRecordFields(t, { comments: t.comments, officeMemo: t.officeMemo });
      else window.Cloud.pushRecord(t);
    }
    input.value = ""; draw(); renderIntakeBoard();
  };
  ov.querySelector("#cmtSend").addEventListener("click", send);
  input.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); send(); } });
  const close = () => { window.__cmtRefresh = null; ov.remove(); };
  ov.querySelector("#cmtClose").addEventListener("click", close);
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  // クラウド購読(onSnapshot)で他端末の投稿が入ったら、開いているスレッドを自動更新
  window.__cmtRefresh = () => { if (!document.body.contains(ov)) { window.__cmtRefresh = null; return; } draw(); };
  setTimeout(() => { try { input.focus(); } catch (e) {} }, 50);
}
/* 手動で入庫を追加(電話予約など未スキャンの車)。ナンバー＋区分だけ */
function addManualIntake() {
  const plate = prompt("入庫する車のナンバー／使用者名を入力してください");
  if (plate === null || !plate.trim()) return;
  const kinds = Object.keys(INTAKE_KINDS);
  const kLabel = kinds.map((k, i) => (i + 1) + ":" + INTAKE_KINDS[k].label).join("  ");
  const sel = prompt("区分を番号で選んでください\n" + kLabel, "1");
  if (sel === null) return;
  const kind = kinds[(parseInt(sel, 10) || 1) - 1] || kinds[0];
  const rid = newRid();
  const t = { id: Date.now(), rid, type: null, vin: null, plate: plate.trim(), name: null,
    intakeKind: kind, intakeAt: Date.now(), intakeOut: null, feePaid: false, officeMemo: null,
    at: new Date().toISOString(), updatedAt: Date.now() };
  const hist = getHistory(); hist.unshift(t);
  localStorage.setItem(LS.hist, JSON.stringify(hist));
  if (window.Cloud) window.Cloud.pushRecord(t);
  markIntakeSeen(rid);
  renderIntakeBoard(); renderHistory();
  showToast("入庫を追加しました（" + INTAKE_KINDS[kind].label + "）");
}
/* 区分フィルターのチップを描画(すべて＋在庫のある区分)。件数付き・選択状態を記憶 */
function renderIntakeFilter(all, filter) {
  const box = $("ibFilter"); if (!box) return;
  box.innerHTML = "";
  const mk = (key, label, n, active) => {
    const b = document.createElement("button");
    b.className = "ibFchip" + (active ? " on " + (key ? (INTAKE_KINDS[key] || {}).cls : "ibFall") : "");
    b.textContent = label + "（" + n + "）";
    b.addEventListener("click", () => setIntakeFilter(key));
    return b;
  };
  box.appendChild(mk("", "すべて", all.length, !filter));
  Object.keys(INTAKE_KINDS).forEach(k => {
    const n = all.filter(h => h.intakeKind === k).length;
    if (n > 0 || filter === k) box.appendChild(mk(k, INTAKE_KINDS[k].label, n, filter === k));
  });
}
function renderIntakeBoard() {
  const sec = $("intakeBoard"), box = $("ibList"); if (!sec || !box) return;
  const all = activeIntakes();
  notifyNewIntakes(all);   // 他端末からの新規入庫を音＋ポップアップで通知
  const office = officeMode();
  const editable = canEditIntake();
  const oldAdd = $("ibAdd"); if (oldAdd) oldAdd.remove();   // 手動追加ボタンは廃止
  // 入庫ボードは事務用モードの端末のみ表示(通常ログインのホームには出さない)
  if (!office) { toggle("intakeBoard", false); box.innerHTML = ""; return; }
  // 区分フィルター(この端末で記憶): すべて / 車検 / 点検 / 修理 / 事故
  const filter = getIntakeFilter();
  renderIntakeFilter(all, filter);
  const list = filter ? all.filter(h => h.intakeKind === filter) : all;
  const cnt = $("ibCount"); if (cnt) cnt.textContent = all.length ? "（" + (filter ? list.length + "/" + all.length : all.length) + "台）" : "";
  const unpaid = all.filter(h => h.intakeKind === "車検" && feeStateOf(h) === "unpaid").length;
  const sm = $("ibSummary"); if (sm) sm.textContent = unpaid ? "未回収 " + unpaid + "件" : "";
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = '<div class="ibEmpty">' + (all.length ? "この区分の入庫車両はありません。" : "現在、入庫中の車両はありません。<br>整備士が車検証をスキャンすると、ここに自動で表示されます。") + '</div>';
    toggle("intakeBoard", true); renderIntakeDetail(list); return;
  }
  list.forEach(h => {
    const info = INTAKE_KINDS[h.intakeKind] || { label: h.intakeKind, cls: "" };
    const card = document.createElement("div"); card.className = "ibCard " + info.cls;
    card.dataset.rid = h.rid;
    const title = [dispText(h.plate), dispText(h.name)].filter(Boolean).join(" ／ ") || dispText(h.type) || "型式不明";
    const sub = [dispText(h.type), h.expiry ? ("満了 " + fmtYMD(h.expiry)) : "", h.staff ? ("担当: " + dispText(h.staff)) : ""].filter(Boolean).join(" ・ ");
    const days = h.intakeAt ? Math.floor((Date.now() - h.intakeAt) / 86400000) : 0;
    const info2 = document.createElement("div"); info2.className = "ibMain";
    info2.innerHTML = '<span class="ibTag">' + esc(info.label) + '</span>' +
      '<span class="ibTitle">' + esc(title) + '</span>' +
      '<span class="ibSub">' + esc(sub) + (days > 0 ? " ・ 入庫" + days + "日" : " ・ 本日入庫") + '</span>';
    // クリックで右ペインに詳細表示
    if (office) {
      if (h.rid === _ibSelected) card.classList.add("ibSel");
      info2.style.cursor = "pointer";
      info2.addEventListener("click", () => { _ibSelected = (_ibSelected === h.rid) ? null : h.rid; renderIntakeBoard(); });
    }
    card.appendChild(info2);

    // 右上: 上段=確認レ点(色付き✓)、下段=費用(車検のみ)
    if (editable) {
      const me = myConfirmId();
      const conf = Array.isArray(h.confirms) ? h.confirms : [];
      const others = conf.filter(c => c.id !== me.id);
      const mine = conf.some(c => c.id === me.id);
      // 右上: 他の担当のレ点(読み取り専用) ＋ 自分用のトグルボタン(単押し)
      const tr = document.createElement("div"); tr.className = "ibTopRight";
      others.forEach(c => {
        const ck = document.createElement("span"); ck.className = "ibCk";
        ck.style.background = c.color || "#888"; ck.textContent = "✓"; ck.title = (c.name || "担当") + " が確認済み";
        tr.appendChild(ck);
      });
      // 自分のレ点は単押しトグル。確認済み=色付き✓ / 未確認=空丸。カード選択(明暗)には影響しない。
      // ★未選択のカードはレ点操作も不可(コメントと同様。選択中のカードだけ操作できる)。
      const ckSel = (h.rid === _ibSelected);
      const ckBtn = document.createElement("button");
      ckBtn.type = "button";
      ckBtn.className = "ibCkBtn" + (mine ? " on" : "") + (ckSel ? "" : " locked");
      if (mine) { ckBtn.style.background = me.color; ckBtn.textContent = "✓"; ckBtn.title = ckSel ? "確認を外す" : "選択すると操作できます"; }
      else { ckBtn.textContent = ""; ckBtn.title = ckSel ? "確認レ点を付ける" : "選択すると操作できます"; }
      ckBtn.addEventListener("click", e => { e.stopPropagation(); if (h.rid !== _ibSelected) return; toggleConfirm(h.rid); });
      tr.appendChild(ckBtn);
      card.appendChild(tr);

      // コメント行: コメント(左)＋費用回収ボタン(右・車検のみ)
      const meta = document.createElement("div"); meta.className = "ibMeta";
      const memo = document.createElement("button");
      const memoSel = (h.rid === _ibSelected);
      const cs = getComments(h);
      memo.className = "ibMemo" + (cs.length ? " hasMemo" : "") + (memoSel ? "" : " locked");
      memo.title = cs.length ? (cs.length + "件のコメント") : "コメントを追加";
      memo.innerHTML = '<span class="ibMemoIc">💬</span>' +
        (cs.length ? '<span class="ibMemoN">' + cs.length + '</span>' : '<span class="ibMemoTxt">コメント</span>');
      // 未選択のカードはコメント不可(選択中のみ開ける)
      memo.addEventListener("click", e => { e.stopPropagation(); if (h.rid !== _ibSelected) return; openIntakeComments(h.rid); });
      meta.appendChild(memo);
      if (h.intakeKind === "車検") {
        const fee = document.createElement("button");
        const fs = FEE_STATES[feeStateOf(h)];
        fee.className = "ibFee " + fs.cls;
        fee.textContent = fs.label;
        fee.title = "費用の状況(タップで切替: 未回収→回収済→自社立替)";
        fee.addEventListener("click", e => { e.stopPropagation(); cycleFee(h.rid); });
        meta.appendChild(fee);
      }
      card.appendChild(meta);
    }
    box.appendChild(card);
  });
  renderIntakeDetail(list);
  try { bindIntakeCal(); } catch (e) {}
  try { bindBoardDrag(); } catch (e) {}
  toggle("intakeBoard", true);
}
/* フローティングカードの配置(位置・大きさ)を保存/復元(PC。次回同じ配置で開く) */
function saveFloatPos(key, el) {
  try { const r = el.getBoundingClientRect(); localStorage.setItem(key, JSON.stringify({ l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })); } catch (e) {}
}
function restoreFloatPos(key, el) {
  try {
    const s = JSON.parse(localStorage.getItem(key) || "null"); if (!s) return false;
    // 画面外に保存されていた場合に備えて可視範囲へ丸める
    const l = Math.min(Math.max(s.l, -el.offsetWidth + 160), window.innerWidth - 160);
    const t = Math.min(Math.max(s.t, 0), window.innerHeight - 60);
    el.style.position = "fixed"; el.style.left = l + "px"; el.style.top = t + "px";
    if (s.w) el.style.width = s.w + "px"; if (s.h) el.style.height = s.h + "px";
    el.style.margin = "0"; el.dataset.placed = "1"; return true;
  } catch (e) { return false; }
}
/* フローティングカードのクリックで最前面に出す(重なり順の管理。開いた順に隠れるのを解消) */
let _floatZ = 800;
function bringToFront(el) { if (!el) return; _floatZ += 1; el.style.zIndex = _floatZ; }
/* 指定カードにクリックで最前面化する挙動を1回だけ付与。topEl=重なり順を持つ最上位要素(既定はcard自身)。 */
function enableRaise(card, topEl) {
  if (!card || card._raiseOn) return; card._raiseOn = true;
  const t = topEl || card;
  card.addEventListener("pointerdown", () => bringToFront(t));
}
/* 任意のカードを指定ハンドルでドラッグ移動可能にする(PC限定) */
function makeDraggable(card, handle) {
  if (!card || !handle) return;
  const isDesk = () => window.matchMedia("(min-width:1024px)").matches;
  handle.style.cursor = "move"; handle.style.userSelect = "none"; handle.style.touchAction = "none";
  let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
  handle.addEventListener("pointerdown", e => {
    if (!isDesk() || e.target.closest("button")) return;
    drag = true; const r = card.getBoundingClientRect();
    ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
    card.style.position = "fixed"; card.style.left = ox + "px"; card.style.top = oy + "px"; card.style.margin = "0";
    try { handle.setPointerCapture(e.pointerId); } catch (er) {}
  });
  handle.addEventListener("pointermove", e => {
    if (!drag) return;
    let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
    nx = Math.min(Math.max(nx, -card.offsetWidth + 120), window.innerWidth - 120);
    ny = Math.min(Math.max(ny, 0), window.innerHeight - 60);
    card.style.left = nx + "px"; card.style.top = ny + "px";
  });
  const end = () => { drag = false; };
  handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end);
}
/* フローティングカードに四隅リサイズハンドルを付与(PC)。左上・右上・左下・右下すべてで大小変更可。 */
function makeResizable(el, minW, minH, saveKey) {
  if (!el || el._rzDone) return;
  el._rzDone = true;
  const isDesk = () => window.matchMedia("(min-width:1024px)").matches;
  [["nw", 0, 0], ["ne", 1, 0], ["sw", 0, 1], ["se", 1, 1]].forEach(([name, rx, ry]) => {
    const hnd = document.createElement("div"); hnd.className = "rzH rz-" + name; el.appendChild(hnd);
    let sx = 0, sy = 0, sw = 0, sh = 0, sl = 0, st = 0, drag = false;
    hnd.addEventListener("pointerdown", e => {
      if (!isDesk()) return;
      e.stopPropagation(); e.preventDefault();
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height; sl = r.left; st = r.top; drag = true;
      el.style.left = sl + "px"; el.style.top = st + "px"; el.style.margin = "0";
      try { hnd.setPointerCapture(e.pointerId); } catch (er) {}
    });
    hnd.addEventListener("pointermove", e => {
      if (!drag) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      let w, h, l = sl, t = st;
      if (rx === 1) w = Math.max(minW, sw + dx); else { w = Math.max(minW, sw - dx); l = sl + (sw - w); }
      if (ry === 1) h = Math.max(minH, sh + dy); else { h = Math.max(minH, sh - dy); t = st + (sh - h); }
      w = Math.min(w, window.innerWidth - 10); h = Math.min(h, window.innerHeight - 10);
      el.style.width = w + "px"; el.style.height = h + "px"; el.style.left = l + "px"; el.style.top = t + "px";
    });
    const end = () => { if (drag && saveKey) saveFloatPos(saveKey, el); drag = false; };
    hnd.addEventListener("pointerup", end); hnd.addEventListener("pointercancel", end);
  });
}
/* 入庫ボード(事務モード・PC)をヘッダーでドラッグ移動できるようにする(リサイズは四隅ハンドルで対応) */
let _ibDragBound = false;
function bindBoardDrag() {
  if (_ibDragBound) return;
  const board = $("intakeBoard"); const hd = board && board.querySelector(".ibHead");
  if (!board || !hd) return;
  _ibDragBound = true;
  try { makeResizable(board, 520, 360, "ss_boardPos"); } catch (e) {}
  try { enableRaise(board); } catch (e) {}   // クリックで最前面へ
  const isDesk = () => window.matchMedia("(min-width:1024px)").matches;
  if (isDesk()) { try { restoreFloatPos("ss_boardPos", board); } catch (e) {} }   // 前回の配置を復元
  let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
  hd.addEventListener("pointerdown", e => {
    if (!isDesk() || !officeMode() || e.target.closest("button")) return;   // ボタン(更新/カレンダー)はドラッグしない
    drag = true;
    const r = board.getBoundingClientRect();
    ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
    board.style.left = ox + "px"; board.style.top = oy + "px"; board.style.margin = "0";
    try { hd.setPointerCapture(e.pointerId); } catch (er) {}
  });
  hd.addEventListener("pointermove", e => {
    if (!drag) return;
    let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
    nx = Math.min(Math.max(nx, -board.offsetWidth + 160), window.innerWidth - 160);
    ny = Math.min(Math.max(ny, 0), window.innerHeight - 60);
    board.style.left = nx + "px"; board.style.top = ny + "px";
  });
  const end = () => { if (drag) { try { saveFloatPos("ss_boardPos", board); } catch (e) {} } drag = false; };
  hd.addEventListener("pointerup", end);
  hd.addEventListener("pointercancel", end);
}
/* カレンダーのポップアップ開閉を1回だけバインド */
let _icBound = false;
function bindIntakeCal() {
  if (_icBound) return;
  const modal = $("intakeCalModal"), open = $("icOpen"), close = $("icClose");
  if (!modal || !open) return;
  _icBound = true;
  const card = modal.querySelector(".icModalCard");
  try { makeResizable(card, 360, 320, "ss_calPos"); } catch (e) {}
  try { enableRaise(card, modal); } catch (e) {}   // クリックで最前面へ(重なり順管理)
  const isDesk = () => window.matchMedia("(min-width:1024px)").matches;
  const show = () => {
    try { renderIntakeCalendar(); } catch (e) {}
    toggle("intakeCalModal", true);
    // PC: 前回の配置を復元。無ければ初回は右寄せに配置。
    if (card && isDesk() && !card.dataset.placed) {
      if (!restoreFloatPos("ss_calPos", card)) {
        card.style.left = Math.max(20, window.innerWidth - 640) + "px";
        card.style.top = "84px"; card.style.margin = "0"; card.dataset.placed = "1";
      }
    }
  };
  const hide = () => toggle("intakeCalModal", false);
  open.addEventListener("click", show);
  if (close) close.addEventListener("click", hide);
  // PC限定: 背景クリックでは閉じない(独立ウィンドウとして扱う)。モバイルは従来どおり背景タップで閉じる。
  modal.addEventListener("click", e => { if (e.target === modal && !isDesk()) hide(); });
  // ヘッダーを掴んでドラッグ移動(PC)。
  const hd = modal.querySelector(".icModalHd");
  if (hd && card) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    hd.addEventListener("pointerdown", e => {
      if (!isDesk() || e.target.closest(".icClose")) return;
      dragging = true;
      const r = card.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      card.style.left = ox + "px"; card.style.top = oy + "px"; card.style.margin = "0"; card.dataset.placed = "1";
      modal.classList.add("dragging");
      try { hd.setPointerCapture(e.pointerId); } catch (er) {}
    });
    hd.addEventListener("pointermove", e => {
      if (!dragging) return;
      let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      // 画面外に出過ぎないよう軽く制限(ヘッダーが常に掴める範囲に)
      nx = Math.min(Math.max(nx, -card.offsetWidth + 120), window.innerWidth - 120);
      ny = Math.min(Math.max(ny, 0), window.innerHeight - 60);
      card.style.left = nx + "px"; card.style.top = ny + "px";
    });
    const endDrag = () => { if (dragging) { try { saveFloatPos("ss_calPos", card); } catch (e) {} } dragging = false; modal.classList.remove("dragging"); };
    hd.addEventListener("pointerup", endDrag);
    hd.addEventListener("pointercancel", endDrag);
  }
}
/* ===== 月間カレンダー: その月の入庫(intakeAt)・出庫(intakeOut)を日別に集計して表示 ===== */
let _icMonth = null;   // 表示中の月(その月1日のDate)
function icMonthRef() {
  if (!_icMonth) { const n = new Date(); _icMonth = new Date(n.getFullYear(), n.getMonth(), 1); }
  return _icMonth;
}
/* ログイン中の店舗の、入庫区分が付いた全レコード(出庫済み含む)。カレンダー集計用。 */
function intakeAllInScope() {
  return getHistory().filter(h => h && h.intakeKind && INTAKE_KINDS[h.intakeKind] && recordInScope(h));
}
function renderIntakeCalendar() {
  const grid = $("icGrid"); if (!grid) return;
  const ref = icMonthRef();
  const y = ref.getFullYear(), m = ref.getMonth();
  const tEl = $("icTitle"); if (tEl) tEl.textContent = y + "年 " + (m + 1) + "月";
  const monthStart = new Date(y, m, 1).getTime();
  const monthEnd = new Date(y, m + 1, 1).getTime();
  const inByDay = {}, outByDay = {};
  const put = (map, ts, h) => { if (ts >= monthStart && ts < monthEnd) { const k = new Date(ts).getDate(); (map[k] = map[k] || []).push(h); } };
  intakeAllInScope().forEach(h => { if (h.intakeAt) put(inByDay, h.intakeAt, h); if (h.intakeOut) put(outByDay, h.intakeOut, h); });
  let inTot = 0, outTot = 0;
  Object.keys(inByDay).forEach(k => inTot += inByDay[k].length);
  Object.keys(outByDay).forEach(k => outTot += outByDay[k].length);
  const totEl = $("icTotals"); if (totEl) totEl.innerHTML = '<span class="icTot icInT">▼ 入庫 ' + inTot + '台</span><span class="icTot icOutT">▲ 出庫 ' + outTot + '台</span>';
  const dots = arr => (arr || []).slice(0, 8).map(h => '<span class="icDot ' + ((INTAKE_KINDS[h.intakeKind] || {}).cls || '') + '"></span>').join('');
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const now = new Date(); const thisMonth = now.getFullYear() === y && now.getMonth() === m; const todayD = now.getDate();
  let html = '<div class="icDowRow">' + ["日", "月", "火", "水", "木", "金", "土"]
    .map((w, i) => '<div class="icDowC' + (i === 0 ? ' icSun' : i === 6 ? ' icSat' : '') + '">' + w + '</div>').join('') + '</div><div class="icCells">';
  for (let i = 0; i < firstDow; i++) html += '<div class="icCell icEmpty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const ins = inByDay[d] || [], outs = outByDay[d] || [];
    const has = ins.length || outs.length;
    const badges = (ins.length ? '<span class="icBadge icInB">▼' + ins.length + '</span>' : '') +
                   (outs.length ? '<span class="icBadge icOutB">▲' + outs.length + '</span>' : '');
    html += '<div class="icCell' + (thisMonth && d === todayD ? ' icToday' : '') + (has ? ' icHas' : '') + '" data-day="' + d + '">' +
      '<div class="icNum">' + d + '</div>' +
      '<div class="icBadges">' + badges + '</div>' + '</div>';
  }
  html += '</div>';
  grid.innerHTML = html;
  const lg = $("icLegend");
  if (lg) lg.innerHTML = Object.keys(INTAKE_KINDS).map(k => '<span class="icLeg"><span class="icDot ' + INTAKE_KINDS[k].cls + '"></span>' + INTAKE_KINDS[k].label + '</span>').join('') + '<span class="icLegNote">▼＝入庫日 ／ ▲＝出庫日</span>';
  const prev = $("icPrev"), next = $("icNext"), tod = $("icToday");
  if (prev) prev.onclick = () => { _icMonth = new Date(y, m - 1, 1); renderIntakeCalendar(); };
  if (next) next.onclick = () => { _icMonth = new Date(y, m + 1, 1); renderIntakeCalendar(); };
  if (tod) tod.onclick = () => { const n = new Date(); _icMonth = new Date(n.getFullYear(), n.getMonth(), 1); renderIntakeCalendar(); };
  grid.querySelectorAll('.icCell[data-day]').forEach(c => c.addEventListener('click', () => {
    const d = parseInt(c.dataset.day, 10);
    openIntakeDayDetail(y, m, d, inByDay[d] || [], outByDay[d] || []);
  }));
}
/* カレンダーの日をタップ → その日の入庫・出庫の明細を表示 */
function openIntakeDayDetail(y, m, d, ins, outs) {
  if (!ins.length && !outs.length) return;
  const row = h => {
    const info = INTAKE_KINDS[h.intakeKind] || { label: h.intakeKind, cls: "" };
    const title = [dispText(h.plate), dispText(h.name)].filter(Boolean).join(" ／ ") || dispText(h.type) || "車両";
    return '<div class="icDetRow"><span class="icDot ' + info.cls + '"></span><span class="icDetTitle">' + esc(title) + '</span></div>';
  };
  const ov = document.createElement("div"); ov.className = "ikModal"; ov.style.zIndex = "760";
  ov.innerHTML = '<div class="ikCard" style="max-width:380px;text-align:left">' +
    '<div class="ikTitle">' + (m + 1) + "月" + d + "日 の入出庫</div>" +
    '<div class="icDetSec"><div class="icDetHd icInT">▼ 入庫 ' + ins.length + '台</div>' + (ins.map(row).join('') || '<div class="icDetNone">なし</div>') + '</div>' +
    '<div class="icDetSec"><div class="icDetHd icOutT">▲ 出庫 ' + outs.length + '台</div>' + (outs.map(row).join('') || '<div class="icDetNone">なし</div>') + '</div>' +
    '<button type="button" class="ikLater" id="icDetClose">とじる</button></div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  const cb = ov.querySelector("#icDetClose"); if (cb) cb.addEventListener("click", close);
  // PC: このカードも独立フローティング(背景は透過して背後を操作可)＋タイトルでドラッグ移動。
  //     複数の日をタップすると重なるので、新規は最前面に出し、クリックで前面化する。
  if (window.matchMedia("(min-width:1024px)").matches) {
    ov.style.background = "transparent"; ov.style.pointerEvents = "none";
    const card = ov.querySelector(".ikCard"); const hd = ov.querySelector(".ikTitle");
    if (card) { card.style.pointerEvents = "auto"; card.style.boxShadow = "0 18px 60px rgba(0,0,0,.3)"; }
    if (card && hd) makeDraggable(card, hd);
    if (card) { enableRaise(card, ov); bringToFront(ov); }
  }
}
/* PC2ペインの右側: 選択中の入庫車両の情報＋出庫ボタン */
function renderIntakeDetail(list) {
  const box = $("ibDetail"); if (!box) return;
  const sel = (list || []).find(h => h.rid === _ibSelected) || null;
  box.classList.toggle("show", !!sel);   // 選択時のみ表示(モバイルでは一覧の下に詳細＋出庫が出る)
  if (!sel) {
    box.innerHTML = '<div class="ibDetEmpty">左の一覧から車両を選ぶと、ここに詳細が表示されます。</div>';
    return;
  }
  const info = INTAKE_KINDS[sel.intakeKind] || { label: sel.intakeKind, cls: "" };
  const rows = [
    ["区分", info.label],
    ["使用者", dispText(sel.name) || "—"],
    ["型式", dispText(sel.type) || "—"],
    ["車台番号", dispText(sel.vin) || "—"],
    ["原動機", dispText(sel.engine) || "—"],
    ["初度登録", (sel.firstReg && sel.firstReg.year) ? (sel.firstReg.year + "年" + (sel.firstReg.month || "") + "月") : "—"],
    ["満了日", sel.expiry ? fmtYMD(sel.expiry) : "—"],
    ["入庫", sel.intakeAt ? fmtYMD(sel.intakeAt) : "—"],
    ["担当", dispText(sel.staff) || "—"],
  ];
  // 担当者は事務ボードでは編集しない(メインツールのホーム入庫状況で設定)。ここでは表示のみ。
  // 上部の区分タグ・費用は廃止(費用はカード一覧側で操作)。ラベルは左端固定・値は全幅中央寄せ。
  const rowHtml = (k, vHtml) => '<div class="ibDetRow"><span class="k">' + esc(k) + '</span><span class="v">' + vHtml + '</span></div>';
  box.innerHTML = '<div class="ibDetCard ' + info.cls + '">' +
    '<div class="ibDetTitle">' + esc(dispText(sel.plate) || dispText(sel.type) || "車両") + '</div>' +
    '<div class="ibDetTbl">' + rows.map(r => rowHtml(r[0], esc(r[1]))).join("") + '</div>' +
    '<button type="button" class="ibDetOut" id="ibDetOut">出庫（ボードから外す）</button></div>';
  const ob = $("ibDetOut");
  if (ob) ob.addEventListener("click", async () => {
    const title = dispText(sel.plate) || dispText(sel.type) || "この車両";
    if (await uiConfirm("「" + title + "」を出庫にしてボードから外しますか？", { okText: "出庫", danger: true })) { _ibSelected = null; clearIntake(sel.rid); }
  });
}
/* 事務モードのON/OFFを画面へ反映(全画面ボード) */
function applyOfficeMode() {
  const on = officeMode();
  document.body.classList.toggle("officeMode", on);
  const hdr = $("officeBar"); if (hdr) toggle("officeBar", on);
  const chk = $("officeModeChk"); if (chk) chk.checked = on;
  if (on) { try { switchView("scan"); } catch (e) {} }
  try { renderIntakeBoard(); } catch (e) {}
  try { if (typeof window.syncPushBtn === "function") window.syncPushBtn(); } catch (e) {}   // 通知ボタン表示も最新化
}
(function bindOfficeMode() {
  const chk = document.getElementById("officeModeChk");
  if (chk) chk.addEventListener("change", () => {
    if (chk.checked) {
      if (!confirm("この端末を入庫管理画面にします。スキャンやAIなどは表示されなくなります。よろしいですか？")) { chk.checked = false; return; }
      localStorage.setItem("ss_office", "1");
    } else localStorage.removeItem("ss_office");
    applyOfficeMode();
  });
  // 事務モード端末で通知(プッシュ)を許可 → 新規入庫がアプリ未起動でも届く
  const push = document.getElementById("obPush");
  function syncPushBtn() {
    if (!push) return;
    const on = window.Cloud && typeof window.Cloud.pushEnabled === "function" && window.Cloud.pushEnabled();
    push.textContent = on ? "🔕 通知を無効にする" : "🔔 通知を許可";
    push.classList.toggle("on", !!on);
  }
  window.syncPushBtn = syncPushBtn;   // Cloud読込後/ログイン後にも再同期できるよう公開
  syncPushBtn();
  // 起動直後は cloud.js が未ロードのことがある→少し遅れて再同期(更新後にOFF表示へ戻る問題対策)
  setTimeout(syncPushBtn, 800); setTimeout(syncPushBtn, 2000);
  if (push) push.addEventListener("click", async () => {
    if (!(window.Cloud && typeof window.Cloud.enablePush === "function")) { uiAlert("通知はこの環境では使えません。"); return; }
    const on = typeof window.Cloud.pushEnabled === "function" && window.Cloud.pushEnabled();
    push.disabled = true; push.textContent = "設定中…";
    try {
      const r = on ? await window.Cloud.disablePush() : await window.Cloud.enablePush();
      uiAlert(r.msg);
    } catch (e) {}
    finally { push.disabled = false; syncPushBtn(); }
  });
  const exit = document.getElementById("obExit");
  if (exit) exit.addEventListener("click", () => {
    if (!confirm("入庫管理を終了してログアウトします。よろしいですか？")) return;
    localStorage.removeItem("ss_office");
    applyOfficeMode();
    try { switchView("settings"); } catch (e) {}
    // ログイン画面へ戻す(ログアウト)
    try { if (window.Cloud && typeof window.Cloud.signOut === "function") window.Cloud.signOut(); else { const b = document.getElementById("btnCloudLogout"); if (b) b.click(); } } catch (e) {}
  });
})();
/* ホームの入庫状況(管理者のみ・前回の車両の下)。閲覧＋出庫。入庫管理ボードと同じデータに反映 */
function renderHomeIntake() {
  const sec = $("homeIntake"), box = $("hiList"); if (!sec || !box) return;
  const onHome = !$("mechaHero") || !$("mechaHero").classList.contains("hidden");
  const isDemoNow = (typeof isDemo === "function" && isDemo());
  // デモ版では実データの入庫状況を出さない。ログイン中の管理者のみ表示
  const loggedInMgr = !!(window.Cloud && typeof window.Cloud.isLoggedIn === "function" && window.Cloud.isLoggedIn() && typeof window.Cloud.isManager === "function" && window.Cloud.isManager());
  // 車両検索を開いている間は入庫状況ボードを閉じる(重なり防止・検索に集中)
  const searchOpen = $("plateArea") && !$("plateArea").classList.contains("hidden");
  // 個人版には入庫状況(法人向け機能)は出さない
  const show = onHome && !searchOpen && !officeMode() && !isDemoNow && loggedInMgr && getAppMode() !== "personal";
  const list = show ? activeIntakes() : [];
  if (!list.length) { toggle("homeIntake", false); box.innerHTML = ""; return; }
  const cnt = $("hiCount"); if (cnt) cnt.textContent = "（" + list.length + "台）";
  box.innerHTML = "";
  list.forEach(h => {
    const info = INTAKE_KINDS[h.intakeKind] || { label: h.intakeKind, cls: "" };
    const title = [dispText(h.plate), dispText(h.name)].filter(Boolean).join(" ／ ") || dispText(h.type) || "型式不明";
    // 行 = 表示部(横スワイプで動く .hiSlide) + 背後の出庫ボタン(.hiOutWrap)
    const row = document.createElement("div"); row.className = "hiRow " + info.cls;
    const slide = document.createElement("div"); slide.className = "hiSlide";
    const main = document.createElement("div"); main.className = "hiMain";
    main.innerHTML = '<span class="hiTag">' + esc(info.label) + '</span><span class="hiTitle">' + esc(title) + '</span>';
    // 車両をタップ → コメント(申し送り)スレッドを開く。スワイプ直後のクリックはaddSwipeRevealが抑制する。
    main.addEventListener("click", () => { try { openIntakeComments(h.rid); } catch (e) {} });
    // 担当ボタン(旧・出庫の位置)。タップで名簿ポップアップ→担当者を設定
    const staff = document.createElement("button");
    staff.className = "hiStaff" + (h.staff ? " on" : "");
    staff.textContent = h.staff ? h.staff : "＋ 担当";
    staff.addEventListener("click", e => { e.stopPropagation(); pickStaff(h.rid); });
    slide.appendChild(main); slide.appendChild(staff);
    // 横スワイプで出現する出庫ボタン
    const outWrap = document.createElement("div"); outWrap.className = "hiOutWrap";
    const out = document.createElement("button"); out.className = "hiOut"; out.textContent = "出庫";
    out.addEventListener("click", e => { e.stopPropagation(); if (confirm("「" + title + "」を出庫にしますか？")) clearIntake(h.rid); });
    outWrap.appendChild(out);
    row.appendChild(slide); row.appendChild(outWrap); box.appendChild(row);
    addSwipeReveal(row, slide);
  });
  toggle("homeIntake", true);
}
/* 担当者の名簿(この事業所で共有せずローカル記憶。名前は後から追加編集できる) */
const STAFF_ROSTER_LS = "ss_staffRoster";
const STAFF_ROSTER_DEFAULT = ["中江", "元山", "中矢", "島田", "関", "積", "大川", "持永", "乾", "保島"];
function getStaffRoster() {
  try { const a = JSON.parse(localStorage.getItem(STAFF_ROSTER_LS) || "null"); if (Array.isArray(a)) return a.filter(Boolean); }
  catch (e) {}
  return STAFF_ROSTER_DEFAULT.slice();
}
function setStaffRoster(arr) {
  const uniq = []; (arr || []).forEach(n => { n = String(n || "").trim(); if (n && !uniq.includes(n)) uniq.push(n); });
  localStorage.setItem(STAFF_ROSTER_LS, JSON.stringify(uniq));
  return uniq;
}
/* 車両に担当者を設定(名簿ポップアップ) */
function pickStaff(rid) {
  const hist = getHistory(); const t = hist.find(h => h.rid === rid); if (!t) return;
  const apply = name => {
    t.staff = name || null; t.updatedAt = Date.now();
    localStorage.setItem(LS.hist, JSON.stringify(hist));
    if (window.Cloud) window.Cloud.pushRecord(t);
    renderHomeIntake(); try { renderIntakeBoard(); } catch (e) {}
  };
  openStaffPicker(t.staff || "", apply);
}
/* 名簿モーダルを表示。onPick(name|"") で確定 */
function openStaffPicker(current, onPick) {
  let ov = $("staffPickOv");
  if (ov) ov.remove();
  ov = document.createElement("div"); ov.id = "staffPickOv"; ov.className = "staffPickOv";
  const roster = getStaffRoster();
  const namesHtml = roster.length
    ? roster.map(n => '<button type="button" class="spName' + (n === current ? " on" : "") + '" data-n="' + esc(n) + '">' + esc(n) + '</button>').join("")
    : '<div class="spEmpty">名簿がまだありません。「＋ 名前を追加」から登録してください。</div>';
  ov.innerHTML =
    '<div class="staffPick">' +
      '<div class="spHead">担当者を選択</div>' +
      '<div class="spList">' + namesHtml + '</div>' +
      '<div class="spActs">' +
        '<button type="button" class="spAdd" id="spAdd">＋ 名前を追加</button>' +
        '<button type="button" class="spClear" id="spClear">担当なし</button>' +
        '<button type="button" class="spClose" id="spClose">閉じる</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  ov.querySelectorAll(".spName").forEach(b =>
    b.addEventListener("click", () => { onPick(b.getAttribute("data-n")); close(); }));
  const add = $("spAdd"); if (add) add.addEventListener("click", () => {
    const v = prompt("担当者名を入力してください"); if (v === null) return;
    const n = v.trim(); if (!n) return;
    setStaffRoster(getStaffRoster().concat(n));
    onPick(n); close();
  });
  const clr = $("spClear"); if (clr) clr.addEventListener("click", () => { onPick(""); close(); });
  const cls = $("spClose"); if (cls) cls.addEventListener("click", close);
}
/* 満了日等のYYYY/MM/DD整形(timestamp or Date) */
function fmtYMD(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return "";
  return d.getFullYear() + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getDate()).padStart(2, "0");
}
function histToResult(h) {
  return {
    rid: h.rid || null,
    type: h.type, vin: h.vin, plate: h.plate || null, engine: h.engine || null,
    model: h.model || null,
    expiry: h.expiry ? new Date(h.expiry) : null,
    firstReg: h.firstReg || null, kataShitei: h.kataShitei || null,
    raw: [h.type, h.vin, h.plate].filter(Boolean),
  };
}
function renderHistory() {
  try { renderIntakeBoard(); } catch (e) {}   // 入庫ボードも同期(クラウド反映時に最新化)
  try { renderHomeIntake(); } catch (e) {}   // ホームの入庫状況(管理者)も最新化
  try { if (typeof window.__cmtRefresh === "function") window.__cmtRefresh(); } catch (e) {}   // 開いているコメントスレッドをリアルタイム更新
  const hist = dedupeHistoryStore();
  const box = $("histList"); box.innerHTML = "";
  if (!hist.length) { box.innerHTML = '<div class="empty"><img src="img/mecha.png" class="mascot-mini" alt="メカ君"><br>履歴はまだないよ。<br>車検証をスキャンするとここに記録されます。</div>'; return; }
  hist.forEach(h => {
    const div = document.createElement("div"); div.className = "histItem";
    const slide = document.createElement("div"); slide.className = "hSlide";
    const main = document.createElement("div"); main.className = "hMain";
    const dt = new Date(h.at);
    const title = [h.plate, h.name].map(dispText).filter(Boolean).join(" ／ ") || dispText(h.type) || "型式不明";
    main.innerHTML = '<div class="hType">' + esc(title) + '</div>' +
      '<div class="hSub">' + esc(dispText(h.type) || "型式不明") + " ・ " + esc(dispText(h.vin) || "車台番号なし") + " ・ " +
      dt.getFullYear() + "/" + String(dt.getMonth()+1).padStart(2,"0") + "/" + String(dt.getDate()).padStart(2,"0") +
      " " + String(dt.getHours()).padStart(2,"0") + ":" + String(dt.getMinutes()).padStart(2,"0") + "</div>";
    main.addEventListener("click", () => showResult(histToResult(h), { fromScan: false }));
    slide.appendChild(main);
    // 入庫区分は法人版の管理者のみ表示(個人版には出さない)
    if (isManager() && getAppMode() !== "personal") {
      if (!h.rid) { h.rid = newRid(); localStorage.setItem(LS.hist, JSON.stringify(hist)); }   // 古い履歴にも不変IDを付与し永続化
      const active = h.intakeKind && INTAKE_KINDS[h.intakeKind] && !h.intakeOut;
      const ik = document.createElement("button");
      if (active) {
        const info = INTAKE_KINDS[h.intakeKind];
        ik.className = "hIntake " + info.cls; ik.textContent = info.label + " ▾";
        ik.title = "入庫区分（タップで変更）";
        ik.addEventListener("click", e => { e.stopPropagation(); changeIntakeKind(h.rid); });
      } else {
        ik.className = "hIntake hIntakeSet"; ik.textContent = "＋ 区分";
        ik.title = "入庫区分を設定してボードに追加";
        ik.addEventListener("click", e => { e.stopPropagation(); openIntakeModalFor(h.rid, title, "new"); });
      }
      slide.appendChild(ik);
    }
    div.appendChild(slide);
    // 削除(管理者のみ): 行を左にスワイプすると右側から出現
    if (isManager()) {
      const del = document.createElement("button"); del.className = "hDel"; del.textContent = "削除";
      del.addEventListener("click", () => {
        if (!confirm("この履歴を削除しますか？")) return;
        if (window.Cloud) window.Cloud.deleteRecord(h);   // クラウドからも削除(復活防止)
        localStorage.setItem(LS.hist, JSON.stringify(getHistory().filter(x => x.id !== h.id)));
        renderHistory();
      });
      div.appendChild(del);
      addSwipeReveal(div, slide);
    }
    box.appendChild(div);
  });
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* 管理者権限: 未ログインの個人利用は許可、ログイン中は admin/super のみ許可(従業員は不可) */
function isManager() { return (window.Cloud && typeof window.Cloud.isManager === "function") ? window.Cloud.isManager() : true; }
/* 権限に応じてUIを更新(データ管理セクションの表示 / 履歴・DBの削除ボタン再描画) */
function applyRoleUI() {
  const mgr = isManager();
  const dm = $("secDataMgmt"); if (dm) dm.classList.toggle("hidden", !mgr);
  if (typeof renderHistory === "function") renderHistory();
  if (typeof renderDBList === "function") renderDBList();
}
window.applyRoleUI = applyRoleUI;

/* =========================================================
   DB編集
   ========================================================= */
let editingId = null; // null=新規, string=カスタムid, "builtin:<name>"=内蔵を複製編集

function renderDBList() {
  const box = $("dbList"); box.innerHTML = "";
  const customNames = new Set(CUSTOM_DB.map(v => v.name));
  const rows = [
    ...CUSTOM_DB.map(v => ({ v, custom: true })),
    ...BUILTIN_DB.filter(v => !customNames.has(v.name)).map(v => ({ v, custom: false })),
  ];
  if (!rows.length) { box.innerHTML = '<div class="empty">車種が登録されていません。</div>'; return; }
  rows.forEach(({ v, custom }) => {
    const div = document.createElement("div"); div.className = "dbItem";
    div.innerHTML = '<div class="dRow"><div class="dName">' + esc(v.name) +
      '<small>' + esc(v.match) + '</small></div>' +
      '<span class="dTag ' + (custom ? 'custom">カスタム' : 'builtin">内蔵') + '</span></div>';
    const btns = document.createElement("div"); btns.className = "dBtns";
    const be = document.createElement("button"); be.className = "btn btn-ghost btn-sm"; be.textContent = custom ? "編集" : "複製して編集";
    be.addEventListener("click", () => openDBForm(v, custom));
    btns.appendChild(be);
    if (custom && isManager()) {   // DBの削除は管理者のみ
      const bd = document.createElement("button"); bd.className = "btn btn-alert btn-sm"; bd.textContent = "削除";
      bd.addEventListener("click", () => {
        if (!confirm("「" + v.name + "」を削除しますか？")) return;
        if (window.Cloud) window.Cloud.deleteVehicle(v.id);
        CUSTOM_DB = CUSTOM_DB.filter(x => x.id !== v.id); saveCustomDB(); renderDBList();
      });
      btns.appendChild(bd);
    }
    div.appendChild(btns); box.appendChild(div);
  });
}
function openDBForm(v, isCustom) {
  editingId = v ? (isCustom ? v.id : null) : null;
  toggle("dbOcrStatus", false); toggle("dbOcrResult", false); $("dbOcrText").value = "";
  setText("dbFormTitle", v ? (isCustom ? "車種を編集" : "内蔵車種を複製編集") : "車種を追加");
  $("dbfName").value = v ? v.name : "";
  $("dbfMatch").value = v ? v.match : "";
  $("dbfMaker").value = v ? (v.maker || "other") : "isuzu";
  $("dbfFaults").value = v ? (v.faults || []).join("\n") : "";
  $("dbfSpecs").value = v ? (v.specs || []).map(s => s.k + ": " + s.v).join("\n") : "";
  $("dbfNotes").value = v ? (v.notes || "") : "";
  toggle("dbFormSec", true);
  $("dbFormSec").scrollIntoView({ behavior: "smooth" });
}
$("btnDbAdd").addEventListener("click", () => openDBForm(null, false));
$("btnDbCancel").addEventListener("click", () => toggle("dbFormSec", false));

/* ---- DBフォーム: 写真OCR読み取り (整備書・諸元表・コーションプレート) ---- */
const dbOcrIn = $("dbOcrIn");
$("btnDbOcr").addEventListener("click", () => dbOcrIn.click());
dbOcrIn.addEventListener("change", e => {
  const f = e.target.files[0]; dbOcrIn.value = "";
  if (f) dbFormOcr(f);
});
document.addEventListener("paste", e => {
  if (!document.getElementById("view-db").classList.contains("active")) return;
  if ($("dbFormSec").classList.contains("hidden")) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
  if (item) { e.preventDefault(); dbFormOcr(item.getAsFile()); }
});
async function dbFormOcr(file) {
  toggle("dbOcrStatus", true); toggle("dbOcrResult", false);
  $("dbOcrStatus").textContent = "Tesseract OCR で解析中…(初回は少し時間がかかります)";
  try {
    const text = await ocrTesseract(file, "dbOcrStatus");
    const lines = cleanupOcrLines(text);
    if (!lines.length) { $("dbOcrStatus").textContent = "文字を読み取れませんでした。明るい場所で、文字部分が大きく写るように撮影してください。"; return; }
    $("dbOcrText").value = lines.join("\n");
    toggle("dbOcrResult", true);
    $("dbOcrStatus").textContent = "✓ " + lines.length + "行を読み取りました。不要な行を消して「→ 諸元に追記」等で反映してください。";
  } catch (err) {
    $("dbOcrStatus").textContent = "OCRエラー: " + (err.message || err);
  }
}
/* OCR結果の整形: ノイズ行を除去し、諸元らしい行は「項目: 値」に寄せる */
function cleanupOcrLines(text) {
  return zen2han(text).split(/\n+/)
    .map(l => l.replace(/\s+/g, " ").trim())
    .filter(l => l.length >= 2 && /[぀-ヿ㐀-鿿A-Za-z0-9]/.test(l))
    .map(l => {
      if (/[:：]/.test(l)) return l;
      // 「エンジンオイル 13L」のような行 → 数値・単位の手前にコロン挿入
      const m = l.match(/^(.{2,14}?)\s+([0-9.,〜~\-]+\s*(?:L|ML|KG|N・?M|NM|KM|V|A|W|MM|CC|度|本|個)\b.*)$/i);
      return m ? m[1] + ": " + m[2] : l;
    });
}
function appendLines(fieldId, textareaVal) {
  const cur = $(fieldId).value.trim();
  $(fieldId).value = (cur ? cur + "\n" : "") + textareaVal.trim();
}
$("btnDbOcrToSpecs").addEventListener("click", () => { if ($("dbOcrText").value.trim()) appendLines("dbfSpecs", $("dbOcrText").value); });
$("btnDbOcrToFaults").addEventListener("click", () => { if ($("dbOcrText").value.trim()) appendLines("dbfFaults", $("dbOcrText").value); });
$("btnDbOcrToNotes").addEventListener("click", () => { if ($("dbOcrText").value.trim()) appendLines("dbfNotes", $("dbOcrText").value); });
$("btnDbSave").addEventListener("click", () => {
  const name = $("dbfName").value.trim();
  const match = $("dbfMatch").value.trim();
  if (!name || !match) { uiAlert("車種名と型式マッチ正規表現は必須です。"); return; }
  try { new RegExp(match); } catch (e) { uiAlert("正規表現が不正です: " + e.message); return; }
  const lines = id => $(id).value.split("\n").map(s => s.trim()).filter(Boolean);
  const id = editingId || ("c" + Date.now());
  const prev = CUSTOM_DB.find(x => x.id === id) || {};
  const rec = {
    ...prev,   // vin/plate/engine/kataShitei/user など既存フィールドを維持
    id,
    name, match, maker: $("dbfMaker").value,
    faults: lines("dbfFaults"),
    specs: lines("dbfSpecs").map(l => {
      const i = l.search(/[:：]/);
      return i > 0 ? { k: l.slice(0, i).trim(), v: l.slice(i + 1).trim() } : { k: l, v: "" };
    }).filter(s => s.k),
    notes: $("dbfNotes").value.trim(),
    manual: true,   // 手動編集=正データ。AI/内蔵推定で上書きさせない
    updatedAt: Date.now(),
  };
  const i = CUSTOM_DB.findIndex(x => x.id === rec.id);
  if (i >= 0) CUSTOM_DB[i] = rec; else CUSTOM_DB.unshift(rec);
  saveCustomDB(); if (window.Cloud) window.Cloud.pushVehicle(rec); toggle("dbFormSec", false); renderDBList();
});

/* エクスポート / インポート */
$("btnDbExport").addEventListener("click", () => {
  const data = { version: 1, exportedAt: new Date().toISOString(), vehicles: mergedDB() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "vehicles-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click(); URL.revokeObjectURL(a.href);
});
$("btnDbImport").addEventListener("click", () => $("dbImportIn").click());
$("dbImportIn").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  e.target.value = "";
  try {
    const j = JSON.parse(await file.text());
    const list = j.vehicles || (Array.isArray(j) ? j : null);
    if (!list) throw new Error("vehicles配列が見つかりません");
    let n = 0;
    for (const v of list) {
      if (!v.name || !v.match) continue;
      try { new RegExp(v.match); } catch (err) { continue; }
      const rec = { id: v.id || ("c" + Date.now() + "_" + n), name: v.name, match: v.match,
        maker: v.maker || "other", faults: v.faults || [],
        specs: Array.isArray(v.specs) ? v.specs.filter(s => s && s.k) : [], notes: v.notes || "" };
      const i = CUSTOM_DB.findIndex(x => x.name === rec.name);
      if (i >= 0) CUSTOM_DB[i] = { ...rec, id: CUSTOM_DB[i].id }; else CUSTOM_DB.push(rec);
      n++;
    }
    saveCustomDB(); renderDBList();
    uiAlert(n + " 件の車種をインポートしました（カスタムDBに保存）。");
  } catch (err) { uiAlert("インポート失敗: " + err.message); }
});

/* =========================================================
   設定
   ========================================================= */
$("btnClearHist").addEventListener("click", async () => {
  if (!isManager()) { uiAlert("この操作は管理者のみ行えます。"); return; }
  const cloudOn = !!(window.Cloud && window.Cloud.active);
  if (!confirm("スキャン履歴をすべて削除しますか？" + (cloudOn ? "\n（クラウド・他の端末からも削除されます）" : ""))) return;
  localStorage.removeItem(LS.hist); renderHistory();
  // クラウドにも同期されている場合は、クラウド側も消す(これをしないと再ログイン時に復活する)。
  if (cloudOn) { try { await window.Cloud.clearCloudHistory(); } catch (e) {} }
});
$("btnClearCustom").addEventListener("click", async () => {
  if (!isManager()) { uiAlert("この操作は管理者のみ行えます。"); return; }
  const cloudOn = !!(window.Cloud && window.Cloud.active);
  if (!confirm("カスタム車種DBをすべて削除しますか？（内蔵DBは残ります）" + (cloudOn ? "\n（クラウド・他の端末からも削除されます）" : ""))) return;
  CUSTOM_DB = []; saveCustomDB(); renderDBList();
  if (cloudOn) { try { await window.Cloud.clearCloudVehicles(); } catch (e) {} }
});
/* DB内蔵データの全消去: 内蔵・カスタム・学習(諸元/定番故障)をすべて削除(履歴は残す) */
$("btnClearDb").addEventListener("click", () => {
  if (!isManager()) { uiAlert("この操作は管理者のみ行えます。"); return; }
  if (!confirm("DB内蔵データを全消去します。\n・内蔵車種DB\n・カスタムDB\n・AIが学習した諸元/定番故障\nをすべて削除します（スキャン履歴は残ります）。よろしいですか？")) return;
  localStorage.setItem("ss_dbcleared", "1");
  localStorage.removeItem(LS.custom);
  localStorage.removeItem("ss_learnedspecs");
  CUSTOM_DB = []; BUILTIN_DB = [];
  renderDBList();
  appVerDisplay().then(ver => setText("verNote", "メカノAI " + ver + " ／ DBデータを全消去しました。スキャンやAI調査で再び蓄積されます。"));
  uiAlert("DB内蔵データを全消去しました。");
});

/* =========================================================
   故障診断 (ダイアグコード検索 + 問診キーワード解析)
   ========================================================= */
let DTC_DB = { codes: [], fallback: [] };
let SYMPTOM_DB = [];
let GUIDE_DB = [];

let OIL_DB = null;   // HKS車種別オイル適合表(db/oil.json): 標準粘度・純正オイル量
let SPECS_DB = null; // メーカー公式の定期点検整備基準(db/specs.json): 型式別の正式値
async function loadDiagDB() {
  try { DTC_DB = await (await fetch("db/dtc.json")).json(); } catch (e) {}
  try { SYMPTOM_DB = (await (await fetch("db/symptoms.json")).json()).symptoms || []; } catch (e) {}
  try { GUIDE_DB = (await (await fetch("db/guides.json")).json()).guides || []; } catch (e) {}
  try { OIL_DB = await (await fetch("db/oil.json")).json(); } catch (e) {}
  try { SPECS_DB = (await (await fetch("db/specs.json")).json()).specs || []; } catch (e) {}
}
/* 公式整備基準(specs.json)から、この車両の型式に一致する正式値を返す。型式は "2KG-CVR60C" のように
   排出ガス記号が前置される場合があるので、コアコード(CVR60C)を含むかで一致させる。 */
function officialSpecsLookup(d) {
  d = d || current; if (!SPECS_DB || !d) return null;
  const norm = s => String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const type = norm(d.type);          // 例: 2KGCVR60C
  const eng = norm(d.engine);         // 例: 6NX1
  if (!type && !eng) return null;
  // 型式一致(コアコードを含む)を最優先。無ければ原動機型式一致で候補提示。
  let hit = SPECS_DB.find(s => { const m = norm(s.model); return m && type && type.indexOf(m) >= 0; });
  return hit || null;
}
/* 公式整備基準を、メカ君プロンプトに差し込む厳守ブロックとして整形。該当が無ければ空文字。 */
function officialSpecsText() {
  const s = officialSpecsLookup();
  if (!s || !s.items) return "";
  const lines = Object.keys(s.items).map(k => "・" + k + ": " + s.items[k]);
  return [
    "【メーカー公式・整備基準(最優先で使用)】次は " + (s.name || "") + " " + s.model + "(" + (s.engine || "") + ") のメーカー公式値。",
    "オイル量・冷却水量・締付トルク・バルブクリアランス・タイヤ空気圧・各種基準値は、以下の公式値をそのまま用いること(AIの推定値で上書きしない)。該当項目が下記に無い場合のみ推定・検索で補う。",
    ...lines
  ].join("\n");
}
/* HKSオイル適合表から、この車両(原動機型式 or 車両型式)の {visc,oil,oilFilter,name,engine} を探す */
function hksOilLookup(d) {
  d = d || current; if (!OIL_DB || !d) return null;
  const rows = OIL_DB.rows, be = OIL_DB.byEngine || {}, bm = OIL_DB.byModel || {};
  const normE = s => String(s || "").toUpperCase().replace(/[（(].*$/, "").replace(/[^0-9A-Z-]/g, "");
  let idx = null;
  const eng = normE(d.engine);
  if (eng) {
    if (be[eng]) idx = be[eng][0];
    else for (const k in be) { const a = k.replace(/-/g, ""), b = eng.replace(/-/g, ""); if (a === b || a.startsWith(b) || b.startsWith(a)) { idx = be[k][0]; break; } }
  }
  if (idx == null) {
    const toks = [];
    const t = d.type && d.type.includes("-") ? d.type.split("-")[1] : d.type;
    if (t) toks.push(String(t).toUpperCase().replace(/[^0-9A-Z]/g, ""));
    const vp = (typeof vinPrefix === "function") ? vinPrefix(d.vin) : ""; if (vp) toks.push(String(vp).toUpperCase());
    for (const tk of toks) { if (tk.length >= 3 && bm[tk]) { idx = bm[tk][0]; break; } }
  }
  if (idx == null) return null;
  const r = rows[idx];
  return { name: r[1], model: r[2], engine: r[3], visc: r[5], oil: r[6], oilFilter: r[7] };
}
/* HKSの値を諸元行に変換(エンジンオイル量・推奨オイル粘度) */
function hksOilSpecs(d) {
  const h = hksOilLookup(d); if (!h) return [];
  const out = [];
  if (h.oil || h.oilFilter) {
    let v = h.oil ? h.oil + "L（オイルのみ）" : "";
    if (h.oilFilter) v += (v ? " ／ " : "") + h.oilFilter + "L（エレメント交換時）";
    out.push({ k: "エンジンオイル量", v: v });
  }
  if (h.visc) out.push({ k: "推奨オイル粘度", v: h.visc });
  return out;
}
/* AI/学習の諸元に、HKSの油量・粘度を上書き反映(ユーザー手動確定は尊重して上書きしない) */
function withHksOil(specs, d) {
  const hs = hksOilSpecs(d); if (!hs.length) return specs;
  const out = (specs || []).slice();
  hs.forEach(h => {
    const c = canonSpecKey(h.k);
    const i = out.findIndex(s => canonSpecKey(s.k) === c);
    if (i >= 0) { if (!out[i].manual) out[i] = { k: out[i].k, v: h.v, hks: true }; }
    else out.push({ k: h.k, v: h.v, hks: true });
  });
  return out;
}

/* DTCコード/症状に対応する点検手引書を探す */
function findGuidesForCode(code) {
  return GUIDE_DB.filter(g => (g.codes || []).some(p => code.startsWith(p)));
}
function findGuidesForSymptom(s) {
  const hay = s.name + " " + (s.kw || []).join(" ");
  return GUIDE_DB.filter(g => (g.kw || []).some(k => hay.includes(k)));
}

/* 手引書を折りたたみ(details)で生成 */
function guideDetails(g) {
  const det = document.createElement("details"); det.className = "guide";
  const sum = document.createElement("summary");
  sum.textContent = "📖 点検手引書: " + g.title;
  det.appendChild(sum);
  const body = document.createElement("div"); body.className = "guide-body";

  const addPart = (label, el) => {
    const h = document.createElement("div"); h.className = "guide-h"; h.textContent = label;
    body.append(h, el);
  };
  if ((g.tools || []).length) {
    const p = document.createElement("div"); p.className = "guide-tools"; p.textContent = g.tools.join(" / ");
    addPart("準備する物", p);
  }
  if ((g.steps || []).length) {
    const ol = document.createElement("ol"); ol.className = "guide-steps";
    g.steps.forEach(s => { const li = document.createElement("li"); li.textContent = s; ol.appendChild(li); });
    addPart("点検手順（この順序で）", ol);
  }
  if ((g.judge || []).length) addPart("判定の目安", ulFlat(g.judge, true));
  if ((g.cautions || []).length) {
    const ul = ulFlat(g.cautions, false); ul.classList.add("guide-caution");
    addPart("⚠ 注意", ul);
  }
  det.appendChild(body);
  return det;
}

/* テキストからDTCコードを抽出 (P0401, P0401-00, ｐ０４０１ 等に対応) */
function extractDTCs(text) {
  const norm = zen2han(text).toUpperCase()
    .replace(/[PCBU]\s*([0-9A-FO]{4})/g, (m, d) => m[0] + d) // "P 0401"対策
    .replace(/([PCBU])([O])/g, "$10"); // OCRのO→0誤読(先頭桁)
  const found = norm.match(/\b[PCBU][0-9][0-9A-F]{3}\b/g) || [];
  return [...new Set(found)];
}

function lookupDTC(code) {
  const hit = DTC_DB.codes.find(c => c.code.split(",").map(s => s.trim()).includes(code) || c.code === code);
  if (hit) return { ...hit, code, exact: true };
  // 基幹コード参照 (P0301-P0312 → P0300 / P0202-08 → P0201 / C0205等 → C0200)
  const base = DTC_DB.codes.find(c =>
    (code >= "P0301" && code <= "P0312" && c.code === "P0300") ||
    (code >= "P0202" && code <= "P0208" && c.code === "P0201") ||
    (/^C02(05|10|15)$/.test(code) && c.code === "C0200"));
  if (base) return { ...base, code, exact: true, baseNote: "（" + base.code.split(" ")[0].split(",")[0] + " 系列）" };
  // 系統フォールバック
  const fb = (DTC_DB.fallback || []).filter(f => code.startsWith(f.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return { code, exact: false, name: fb ? "系統: " + fb.sys : "不明なコード", causes: [], checks: ["車種別資料・FAINESで正式定義を確認", "下の検索リンクで事例を調査"] };
}

/* 問診テキストを症状辞書と照合 */
function matchSymptoms(text) {
  const results = [];
  for (const s of SYMPTOM_DB) {
    const hits = s.kw.filter(k => text.includes(k));
    if (hits.length) results.push({ ...s, hits, score: hits.length });
  }
  return results.sort((a, b) => b.score - a.score);
}

/* スキャン済み車両の持病と問診の突き合わせ */
function matchVehicleFaults(text, dtcs) {
  if (!current.type) return null;
  const code = current.type.includes("-") ? current.type.split("-")[1] : current.type;
  const v = findVehicle(code);
  if (!v) return null;
  const tokens = text.split(/[\s、。,．・\n]+/).filter(t => t.length >= 2);
  const matched = (v.faults || []).filter(f => tokens.some(t => f.includes(t)));
  return { vehicle: v, matched, all: v.faults || [] };
}

async function runDiag() {
  const text = $("diagText").value.trim();
  if (!text) { $("diagResults").innerHTML = '<div class="empty">コードまたは症状を入力してください。</div>'; return; }
  diagGuideCache = {}; inspectPaneReg = []; currentDiagRec = null;   // 新しい診断: 事前生成キャッシュをリセット
  const dtcs = extractDTCs(text);
  const symptoms = matchSymptoms(text);
  const vf = matchVehicleFaults(text, dtcs);
  renderDiagResults(dtcs, symptoms, vf, text);
  await runDiagAI(text); // 解析と同時にAI思考を自動実行(ボタンの処理中表示が完了まで持続)
}
function updateDiagVehicleHint() {
  $("diagVehicleHint").textContent = current.type
    ? "🚚 スキャン済み車両: " + current.type + " — 検索リンクと持病照合に反映されます"
    : "車検証をスキャンしておくと、車種固有の持病との照合・型式付き事例検索ができます";
}
$("btnDiagRun").addEventListener("click", async () => {
  stopFieldMic();
  // 写真・動画の添付があればメディアAI解析、無ければ従来のコード/問診解析
  if (diagAttachments.length) { await diagMediaAnalyze(); return; }
  const btn = $("btnDiagRun"); setBtnLoading(btn, true, "メカ君が考え中…");
  try { await runDiag(); } finally { setBtnLoading(btn, false); }
});
$("btnDiagClear").addEventListener("click", () => {
  cancelAI();   // 考え中のメカ君を中断
  $("diagText").value = ""; autoGrow($("diagText")); $("diagResults").innerHTML = "";
  toggle("diagVideoStatus", false);
  clearDiagAttachments();
});

function diagSection(tagClass, tagText, title) {
  const sec = document.createElement("section");
  const h2 = document.createElement("h2");
  const tag = document.createElement("span"); tag.className = "tag" + (tagClass ? " " + tagClass : ""); tag.textContent = tagText;
  h2.append(tag, title);
  const body = document.createElement("div"); body.className = "sec-body";
  sec.append(h2, body);
  return { sec, body };
}
function ulFlat(items, chk) {
  const ul = document.createElement("ul"); ul.className = "flat";
  items.forEach(t => { const li = document.createElement("li"); if (chk) li.className = "chk"; li.textContent = t; ul.appendChild(li); });
  return ul;
}
function searchLink(q, label) {
  const a = document.createElement("a"); a.className = "linkbtn";
  a.href = "https://www.google.com/search?q=" + encodeURIComponent(q);
  a.target = "_blank"; a.rel = "noopener";
  a.append(label);
  const arr = document.createElement("span"); arr.className = "arr"; arr.textContent = "↗";
  a.appendChild(arr);
  return a;
}

function renderDiagResults(dtcs, symptoms, vf, text) {
  const box = $("diagResults"); box.innerHTML = "";
  const typeQ = current.type ? current.type + " " : "";

  if (!dtcs.length && !symptoms.length) {
    box.innerHTML = '<div class="empty">該当するコード・症状が見つかりませんでした。<br>症状は「白煙」「異音」「始動不良」のような言葉を含めると拾いやすくなります。</div>';
    return;
  }

  // DTC結果
  for (const code of dtcs) {
    const d = lookupDTC(code);
    const { sec, body } = diagSection("al", code, d.name + (d.baseNote || ""));
    if (d.causes && d.causes.length) {
      const h = document.createElement("div"); h.className = "hint"; h.textContent = "考えられる原因:";
      body.append(h, ulFlat(d.causes, false));
    }
    if (d.checks && d.checks.length) {
      const h = document.createElement("div"); h.className = "hint"; h.style.marginTop = "10px"; h.textContent = "確認手順:";
      body.append(h, ulFlat(d.checks, true));
    }
    findGuidesForCode(code).forEach(g => body.appendChild(guideDetails(g)));
    sec.appendChild(searchLink(typeQ + code + " 原因 修理", "「" + (typeQ ? current.type + "＋" : "") + code + "」で事例検索"));
    box.appendChild(sec);
  }

  // 問診マッチ結果
  for (const s of symptoms.slice(0, 5)) {
    const { sec, body } = diagSection("cy", "症状", s.name + "（キーワード: " + s.hits.join("・") + "）");
    if (s.causes.length) {
      const h = document.createElement("div"); h.className = "hint"; h.textContent = "考えられる原因:";
      body.append(h, ulFlat(s.causes, false));
    }
    if (s.checks.length) {
      const h = document.createElement("div"); h.className = "hint"; h.style.marginTop = "10px"; h.textContent = "切り分け・確認:";
      body.append(h, ulFlat(s.checks, true));
    }
    findGuidesForSymptom(s).forEach(g => body.appendChild(guideDetails(g)));
    if (current.type) sec.appendChild(searchLink(current.type + " " + s.hits[0] + " 原因", "「" + current.type + "＋" + s.hits[0] + "」で事例検索"));
    box.appendChild(sec);
  }

  // 車種固有の持病との突き合わせ
  if (vf && vf.all.length) {
    const { sec, body } = diagSection("", "車種", vf.vehicle.name + " の持病と照合");
    if (vf.matched.length) {
      const h = document.createElement("div"); h.className = "hint"; h.textContent = "⚠ 問診内容と一致する持病:";
      body.append(h, ulFlat(vf.matched, false));
    } else {
      const h = document.createElement("div"); h.className = "hint"; h.textContent = "直接一致なし。参考: この車種の定番故障:";
      body.append(h, ulFlat(vf.all, false));
    }
    box.appendChild(sec);
  }
  box.scrollIntoView({ behavior: "smooth" });
}

/* =========================================================
   AI相談 (Gemini API 無料枠 / 任意設定)
   ========================================================= */
/* モード別モデル候補 (上から順に試行。無料枠上限・未提供時は次へフォールバック) */
const GEMINI_MODELS = {
  // 先頭のGoogle公式『-latest』別名は常に最新版を指す → 新バージョンが出れば自動で移行。
  // 別名が未提供/未対応(404)の環境では、以降の固定版へ自動フォールバックする(壊れない)。
  // 現行3系を優先(2.5系は新規プロジェクトで404のため後方に)。先頭の-latestは自動で最新へ。
  flash: ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"],
  pro: ["gemini-pro-latest", "gemini-flash-latest", "gemini-2.5-flash"]
};
/* 画像生成モデル(通称Nano Banana=Gemini 2.5 Flash Image。同じキーで実画像を返す) */
const GEMINI_IMAGE_MODELS = ["gemini-2.5-flash-image", "gemini-2.5-flash-image-preview", "gemini-2.0-flash-preview-image-generation"];
/* AI結果キャッシュ: 同じ問い合わせは再消費しない(無料枠節約) */
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
function aiCacheGet(k) { try { return (JSON.parse(localStorage.getItem("ss_aicache") || "{}"))[k] || null; } catch (e) { return null; } }
function aiCacheSet(k, v) {
  try {
    const c = JSON.parse(localStorage.getItem("ss_aicache") || "{}");
    c[k] = v; const ks = Object.keys(c);
    while (ks.length > 150) delete c[ks.shift()];
    localStorage.setItem("ss_aicache", JSON.stringify(c));
  } catch (e) {}
}
function getAiMode() { return localStorage.getItem(LS.aimode) === "pro" ? "pro" : "flash"; }
/* 契約店舗(自分の鍵なし)の実効AIモード: 契約プランに合わせてProの利用可否を上限管理。
   NAプランはProを使わせない(標準Flash)。ターボ/ツインターボはProのまま。トライアル中も“選んだプラン”準拠。 */
function capModeByPlan(mode) {
  const c = window.Cloud;
  // 店舗にログイン中はプラン準拠を厳守。NA(無料)プランはProを使わせない=標準Flash。
  // 契約が一時的に未確定/期限切れでも、端末に残った個人キーでProに“抜ける”のを防ぐ。
  const loggedIn = !!(c && typeof c.isLoggedIn === "function" && c.isLoggedIn());
  if (loggedIn && typeof c.aiPaidOn === "function" && !c.aiPaidOn()) return "flash";
  return mode;
}
/* 契約店舗か(plan有効)。契約店舗は端末に個人キーが残っていてもプラン準拠のサーバー経路を最優先する。
   ← これが無いと、開発端末等に個人APIキーが残っていると個人利用経路(モード切替Pro)に流れ、
     NAプランなのに「高精度Pro」で解析されてしまう(プランゲート迂回)。 */
function contractAi() {
  return !!(window.Cloud && typeof window.Cloud.aiReady === "function" && window.Cloud.aiReady());
}
/* iOS(iPhone/iPad)判定。iOS Safariはfetchのストリーミング応答を最初のチャンクで打ち切ることがあり、
   SSEストリームだと「見解が1文字」になる不具合がある。iOSではストリーミングを使わず一括取得にする。 */
function isIOS() {
  const ua = navigator.userAgent || "";
  return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document);
}
/* モバイル(iOS/Android)。アプリ内ブラウザ等でfetchストリームが途中で切れるため、個人キーは一括取得に切替える */
function isMobile() { return isIOS() || /Android/i.test(navigator.userAgent || ""); }
/* 写真・動画解析のモード: プラン準拠。NA=標準Flash / ターボ・ツインターボ=高精度Pro(思考あり)。 */
function mediaModeByPlan() {
  return (window.Cloud && typeof window.Cloud.aiPaidOn === "function" && window.Cloud.aiPaidOn()) ? "pro" : "flash";
}
/* 写真・動画解析の思考量: Pro(有料プラン)は精度重視で多め、NA(Flash)は最小で高速。opts優先。 */
function mediaThinking(opts) {
  if (opts && typeof opts.thinkingBudget === "number") return opts.thinkingBudget;
  return mediaModeByPlan() === "pro" ? 1024 : 256;   // Proでも思考は抑えめにして速度を確保
}
function renderAiMode() {
  const mode = getAiMode();
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("mode-active", b.dataset.mode === mode));
}
document.querySelectorAll(".mode-btn").forEach(b => b.addEventListener("click", () => {
  localStorage.setItem(LS.aimode, b.dataset.mode);
  renderAiMode();
}));

// 個人モードのバナー「APIキーの設定へ」→ キー設定を開いてスクロール
$("btnJumpKey") && $("btnJumpKey").addEventListener("click", () => {
  const f = $("secAiKeyFold"); if (f) f.open = true;
  const s = $("secAiKey"); if (s) s.scrollIntoView({ behavior: "smooth", block: "start" });
});
// バナー「OCR用APIキー設定」→ 文字読み取り(Cloud Vision)セクションを開いてスクロール
$("btnJumpVision") && $("btnJumpVision").addEventListener("click", () => {
  const sec = $("secVisionKey"); if (!sec) return;
  const d = sec.querySelector("details"); if (d) d.open = true;
  sec.scrollIntoView({ behavior: "smooth", block: "start" });
});

function renderGeminiStat() {
  const has = !!localStorage.getItem(LS.gemini);
  $("geminiStat").textContent = has
    ? "✓ 設定済み — 診断タブで「メカ君に相談」が使えます。空欄で保存すると解除。"
    : "未設定 — キーはこの端末のみに保存され、Google以外には送信されません。";
}
$("btnGeminiSave").addEventListener("click", () => {
  const v = $("geminiKey").value.trim();
  if (v) localStorage.setItem(LS.gemini, v); else localStorage.removeItem(LS.gemini);
  $("geminiKey").value = "";
  renderGeminiStat();
});

/* ---- Cloud Vision(高精度OCR)設定 ---- */
function renderVisionStat() {
  const has = !!localStorage.getItem("ss_visionkey");
  const on = localStorage.getItem("ss_usevision") === "1";
  $("useVision").checked = on;
  $("visionStat").textContent = has
    ? (on ? "✓ 高精度OCR(Cloud Vision)を使用中。" : "キー設定済み（OFF）。ONにすると有料OCRを使います。")
    : "未設定 — キーはこの端末のみに保存。OFFまたは未設定なら無料Tesseractを使います。";
}
$("btnVisionSave").addEventListener("click", () => {
  const v = $("visionKey").value.trim();
  if (v) localStorage.setItem("ss_visionkey", v); else localStorage.removeItem("ss_visionkey");
  $("visionKey").value = "";
  if (!localStorage.getItem("ss_visionkey")) localStorage.removeItem("ss_usevision");
  renderVisionStat();
});
$("useVision").addEventListener("change", () => {
  if ($("useVision").checked && !localStorage.getItem("ss_visionkey")) {
    uiAlert("先にCloud Vision APIキーを保存してください。");
    $("useVision").checked = false; return;
  }
  localStorage.setItem("ss_usevision", $("useVision").checked ? "1" : "0");
  renderVisionStat();
});

/* ---- Google Programmable Search(実写画像) 設定 ---- */
/* 契約中の店舗はサーバー経由(運営のキー)で使えるため、自前キーの設定は不要 */
function cseCorp() { return !!(window.Cloud && window.Cloud.aiReady && window.Cloud.aiReady()); }
function cseReady() { return !!(localStorage.getItem("ss_cse_key") && localStorage.getItem("ss_cse_cx")) || cseCorp(); }
function renderCseStat() {
  const el = $("cseStat"); if (!el) return;
  const corp = cseCorp(), own = !!(localStorage.getItem("ss_cse_key") && localStorage.getItem("ss_cse_cx"));
  // 契約中は運営のキーで動くため手順を隠して「設定不要」と案内。
  // ただし自前キーが登録済みなら、修正・削除できるよう入力欄は残す。
  toggle("cseCorpNote", corp);
  toggle("cseSetup", !corp || own);
  el.textContent = corp ? "✓ ご契約中 — 部品名タップで実写画像を表示します（設定不要）。"
    : own ? "✓ 設定済み — 部品名タップで実写画像を表示します。"
    : "未設定 — 「Web画像で探す」リンクのみ使えます。";
}
$("btnCseSave") && $("btnCseSave").addEventListener("click", () => {
  const key = $("cseKey").value.trim(), cx = $("cseCx").value.trim();
  if (key) localStorage.setItem("ss_cse_key", key); else localStorage.removeItem("ss_cse_key");
  if (cx) localStorage.setItem("ss_cse_cx", cx); else localStorage.removeItem("ss_cse_cx");
  $("cseKey").value = "";
  renderCseStat();
});
/* Google Custom Search で画像を検索(CORS対応のJSON API)。結果配列[{thumb,link,ctx,title}] */
async function googleImageSearch(query, num) {
  const key = localStorage.getItem("ss_cse_key"), cx = localStorage.getItem("ss_cse_cx");
  // 契約中はサーバー(運営のキー)経由を優先 → 「設定不要」の案内どおりに動く。
  // 失敗しても自前キーがあればそちらで再試行する。
  if (cseCorp()) {
    try {
      const d = await window.Cloud.callFn("imageSearch", { q: query, num: num || 3 });
      return Array.isArray(d && d.items) ? d.items.filter(x => x && x.thumb) : [];
    } catch (e) {
      // 契約経由(サーバー=運営のキー)で失敗。自前キーが無ければ、どのキーが原因か明示して投げる。
      if (!key || !cx) {
        e.userMsg = "【契約経由（運営のキー）で失敗】" + (e.userMsg || e.message || "画像検索に失敗しました") +
          "\n※これはこの端末で設定したキーではなく、運営側のキーの問題です（運営側でCustom Search APIの有効化・デプロイが必要）。";
        throw e;
      }
      // 自前キーがある場合は下でそちらを使って再試行する
    }
  }
  if (!key || !cx) return [];
  const url = "https://www.googleapis.com/customsearch/v1?searchType=image&safe=active&num=" + (num || 3) +
    "&key=" + encodeURIComponent(key) + "&cx=" + encodeURIComponent(cx) + "&q=" + encodeURIComponent(query);
  const res = await fetch(url);
  if (!res.ok) {
    let reason = "";
    try { const ej = await res.json(); reason = (ej.error && ej.error.message) || ""; } catch (_) {}
    const r = reason.toLowerCase();
    let msg, enableUrl = "", fixUrl = "", fixLabel = "";
    if (res.status === 429 || /quota|rate limit/.test(r)) msg = "本日の無料枠(100回)を使い切りました。明日また使えます。";
    else if (/does not have the access|not have access|access to custom search/.test(r)) {
      // このメッセージ(プロジェクト番号なし)は「有効化」ではなく“APIキーのAPI制限”が原因のことが多い。
      fixUrl = "https://console.cloud.google.com/apis/credentials";
      fixLabel = "APIキーの設定を開く（APIの制限を直す）↗";
      msg = "このAPIキーが Custom Search API を使う権限を持っていません。多くの場合、原因は次のどちらかです。\n" +
        "① APIキーの「APIの制限」でCustom Search APIが許可されていない → 下のボタンからキーを開き、「APIの制限」を『キーを制限しない』にするか、許可APIにCustom Search APIを追加。\n" +
        "② Custom Search APIを有効にしたプロジェクトと、このキーのプロジェクトが違う → 両方を同じプロジェクトに揃える。\n" +
        "（設定変更後、反映に数分かかることがあります）";
    }
    else if (/has not been used|is disabled|not been enabled|api.*not.*enabled|blocked/.test(r)) {
      // Googleは「project 123456789 で有効化せよ」とプロジェクト番号付きURLを返す。
      // それをそのまま案内に出す(=キーが実際に属するプロジェクトが分かる)。
      const proj = (reason.match(/project\s+(\d{6,})/i) || [])[1] || "";
      enableUrl = (reason.match(/https:\/\/console\.[^\s"')]+/i) || [])[0] ||
        (proj ? "https://console.cloud.google.com/apis/api/customsearch.googleapis.com/overview?project=" + proj
              : "https://console.cloud.google.com/apis/library/customsearch.googleapis.com");   // 番号不明でも有効化ページへ
      msg = "「Custom Search API」がこのAPIキーのプロジェクト" + (proj ? "（番号: " + proj + "）" : "") + "で有効になっていません。\n" +
        "下のボタンから、そのプロジェクトの画面を直接開いて「有効にする」を押してください。\n" +
        "※すでに有効なのにこの表示が出る場合は、APIキー側の「APIの制限」でCustom Search APIが許可されていない可能性があります（キーの制限を『なし』にするか、Custom Search APIを許可）。";
    }
    else if (res.status === 403 && /referer|referrer|blocked|not authorized/.test(r)) msg = "APIキーに利用制限がかかっています。キーの制限を『なし』にするか、このサイトを許可してください。";
    else if (res.status === 400 && /invalid.*key|api key not valid/.test(r)) msg = "APIキーが正しくありません。②のキーを貼り直してください。";
    else if (res.status === 400 && (/invalid.*cx|invalid value|invalid argument/.test(r) || !localStorage.getItem("ss_cse_cx"))) msg = "検索エンジンID(①)が正しくないようです。Programmable Search Engineの「検索エンジンID」を貼り直し、その検索エンジンで『画像検索』がオンか確認してください。";
    else msg = "画像検索エラー(" + res.status + ")" + (reason ? "：" + reason : "");
    const err = new Error(msg); err.userMsg = msg; err.enableUrl = enableUrl; err.fixUrl = fixUrl; err.fixLabel = fixLabel; err.raw = reason; throw err;
  }
  const j = await res.json();
  return (j.items || []).map(it => ({
    thumb: (it.image && it.image.thumbnailLink) || it.link,
    link: it.link,
    ctx: (it.image && it.image.contextLink) || it.link,
    title: it.title || "",
  })).filter(x => x.thumb);
}

/* 進行中のAIリクエストを中断するためのコントローラ */
let aiAbort = null;
function cancelAI() {
  if (aiAbort) { try { aiAbort.abort(); } catch (e) {} aiAbort = null; }
  // 各処理の「考え中」状態を解除
  diagAiBusy = false; if (typeof diagMediaBusy !== "undefined") diagMediaBusy = false;
  if (typeof partsBusy !== "undefined") partsBusy = false; if (typeof vehAskBusy !== "undefined") vehAskBusy = false;
  ["btnDiagRun", "btnPartsGo", "btnSpecAI", "btnSpecReload", "btnVehAsk", "btnAiQr"].forEach(id => { const b = $(id); if (b) setBtnLoading(b, false); });
}
/* 英語モード時、AIに英語で回答させる指示を付ける(JSON構造・数値・型式・品番は保持) */
function langDirective(p) {
  if (window.APP_LANG !== "en") return p;
  return p + "\n\n[Output language] Respond in English. Every natural-language string in your answer — including all JSON string values — must be written in English. Keep JSON keys, structure, part numbers, model codes, DTC codes, and numeric values with their units unchanged. Use the Japanese-market values as-is; do not convert to other regions' specifications.";
}
async function geminiAsk(prompt, opts) {
  opts = opts || {};
  prompt = langDirective(prompt);
  if (typeof isDemo === "function" && isDemo()) return demoAnswer(prompt);   // デモ: API未使用の固定サンプル回答
  const mode = capModeByPlan(opts.mode || getAiMode());   // 会話など回数が多い用途は flash 指定で無料枠を節約。NA店舗は個人キーでもProに抜けさせない
  const key = localStorage.getItem(LS.gemini);
  // キャッシュ命中なら無料枠を消費せず即返す(noCache指定時は最新を取得)
  const ck = mode + (opts.search ? ":s" : "") + ":" + hashStr(prompt);
  if (!opts.noCache) {
    const cached = aiCacheGet(ck);
    if (cached) return { text: cached.text, truncated: cached.truncated, model: "cache" };
  }
  // 契約店舗はサーバー(mecha)経由=プラン準拠を最優先(個人キーが残っていてもプランゲートを効かせる)。非契約+自前キーのみローカル。
  if (contractAi()) {
    const d = await window.Cloud.callFn("mecha", { prompt, mode: capModeByPlan(mode), search: !!opts.search, maxTokens: opts.maxTokens || 0, thinkingBudget: opts.thinkingBudget });
    const r = { text: (d && d.text) || "", truncated: !!(d && d.truncated), model: (d && d.model) || "" };
    if (!r.text) throw new Error("AIから回答が得られませんでした");
    aiCacheSet(ck, { text: r.text, truncated: r.truncated }); return r;
  }
  let lastErr = null, waited429 = false;   // waited429: 429の短時間待ちは全体で1回だけ
  aiAbort = new AbortController();   // クリアで中断できるように
  for (const model of GEMINI_MODELS[mode]) {
    // 過負荷(503/500)は一時的なので、下位(無料)モデルへ落とす前に同じモデルで最大3回リトライ。
    // これで「高精度モードが一瞬の混雑で無料版に切り替わる」のを防ぐ。
    let dropToNext = false;
    for (let attempt = 0; attempt < 3 && !dropToNext; attempt++) {
      try {
        // 思考トークンと本文が両方収まるよう上限は大きめに確保(諸元など長いJSONは opts.maxTokens で拡張)
        const genCfg = { temperature: 0.2, maxOutputTokens: opts.maxTokens || 16384 };
        // 思考トークン制御(2.5系・3系・-latest)。flash=512(3系は0が400・128だと空応答になり得る)、pro=-1で自動調整。2.0系は非対応。
        if (/gemini-(2\.5|3(\.\d+)?)[-.]/.test(model) || model.indexOf("-latest") >= 0) {
          // opts.thinkingBudget 指定時はその値(有限)を使い、思考を短めに切り上げて待機時間を短縮できる。
          const tb = (typeof opts.thinkingBudget === "number") ? opts.thinkingBudget : (mode === "pro" ? -1 : 512);
          genCfg.thinkingConfig = { thinkingBudget: tb };
        }
        const res = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: aiAbort.signal,
            body: JSON.stringify(Object.assign({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: genCfg
            }, opts.search ? { tools: [{ google_search: {} }] } : {}))
          });
        if (res.status === 404) { lastErr = new Error(model + " は利用不可"); break; }   // 次のモデルへ
        if (res.status === 503 || res.status === 500) {
          lastErr = new Error("AIが混雑しています (" + res.status + ")。");
          if (attempt < 2) { await new Promise(r => setTimeout(r, 900 * (attempt + 1))); continue; }   // 同じモデルで再試行
          break;   // 3回だめなら次のモデルへ
        }
        if (res.status === 429) {
          // RPM(1分制限)の一時的429なら、retryDelay(例12s)だけ待って同じモデルで再試行(全体で1回)。日次枯渇や長い待ちは次モデルへ。
          if (!waited429 && attempt < 2) {
            let delay = 0;
            try { const ej = await res.json(); const ri = ((ej.error && ej.error.details) || []).find(d => String(d["@type"] || "").indexOf("RetryInfo") >= 0); if (ri && ri.retryDelay) delay = parseInt(ri.retryDelay, 10) || 0; } catch (e) {}
            if (delay > 0 && delay <= 20) { waited429 = true; await new Promise(r => setTimeout(r, (delay + 1) * 1000)); continue; }
          }
          lastErr = new Error("無料枠の上限に達しました。1分待つ／設定で標準モードにする／日本時間の夕方(米国0時)のリセットを待つ、をお試しください。"); break;
        }
        if (res.status === 400 || res.status === 403) throw new Error("APIキーが無効です。設定タブでキーを確認してください。");
        if (!res.ok) throw new Error("AI応答エラー (" + res.status + ")");
        const j = await res.json();
        const cand = j.candidates?.[0];
        // 思考パート(thought:true)を除いた本文のみ結合
        const text = cand?.content?.parts?.filter(p => !p.thought).map(p => p.text || "").join("") || "";
        if (!text) throw new Error("AIから回答が得られませんでした");
        const r = { text, truncated: cand?.finishReason === "MAX_TOKENS", model };
        aiCacheSet(ck, { text: r.text, truncated: r.truncated });
        return r;
      } catch (e) {
        if (e && e.name === "AbortError") throw new Error("__cancelled__");   // クリアで中断
        if (e.message && (e.message.includes("上限") || e.message.includes("キーが無効"))) throw e;
        lastErr = e; dropToNext = true;   // 例外は次のモデルへ
      }
    }
  }
  throw lastErr || new Error("AIに接続できませんでした(要ネット接続)");
}

/* ストリーミング版: 回答を逐次(SSE)受信し、onChunk(累積テキスト, 完了フラグ)で少しずつ表示する。
   → 全文がそろうまで待たずに読み始められ、待機の体感が大きく短くなる。
   自前キー(BYOK)のみ対応。契約店舗のプロキシ経由/デモ/キー無しは通常のgeminiAskへフォールバック。 */
async function geminiAskStream(prompt, opts, onChunk) {
  opts = opts || {};
  if (typeof isDemo === "function" && isDemo()) return geminiAsk(prompt, opts);
  // iOS + 自前キー直叩き(Google直のfetch SSE)は最初のチャンクで打ち切られる不具合があるため一括取得にする。
  // 契約店舗(サーバープロキシ)はXHRストリーミング対応済みなのでiOSでも逐次表示する(体感速度を確保)。
  if (isMobile() && !contractAi()) return geminiAsk(prompt, opts);
  const key = localStorage.getItem(LS.gemini);
  if (!key || contractAi()) {
    // 契約店舗はプラン準拠のサーバー経路を最優先(個人キーが残っていてもゲートを効かせる)。未対応時は従来のgeminiAsk(mecha)へ。
    if (contractAi() && typeof window.Cloud.callFnStream === "function") {
      try {
        return await window.Cloud.callFnStream("mechaStream",
          { prompt, mode: capModeByPlan(opts.mode || getAiMode()), search: !!opts.search, maxTokens: opts.maxTokens || 0, thinkingBudget: opts.thinkingBudget }, onChunk);
      } catch (e) { if (e && e.message === "__cancelled__") throw e; /* それ以外は従来経路へ */ }
    }
    if (!key) return geminiAsk(prompt, opts);
  }
  const mode = capModeByPlan(opts.mode || getAiMode());   // NA店舗は個人キー経路でもProに抜けさせない
  const ck = mode + (opts.search ? ":s" : "") + ":" + hashStr(prompt);
  if (!opts.noCache) {
    const cached = aiCacheGet(ck);
    if (cached) { if (onChunk) onChunk(cached.text, true); return { text: cached.text, truncated: cached.truncated, model: "cache" }; }
  }
  aiAbort = new AbortController();
  let lastErr = null;
  for (const model of GEMINI_MODELS[mode]) {
    try {
      const genCfg = { temperature: 0.2, maxOutputTokens: opts.maxTokens || 16384 };
      if (/gemini-(2\.5|3(\.\d+)?)[-.]/.test(model) || model.indexOf("-latest") >= 0) {
        const tb = (typeof opts.thinkingBudget === "number") ? opts.thinkingBudget : (mode === "pro" ? -1 : 512);
        genCfg.thinkingConfig = { thinkingBudget: tb };
      }
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":streamGenerateContent?alt=sse&key=" + encodeURIComponent(key),
        {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: aiAbort.signal,
          body: JSON.stringify(Object.assign({ contents: [{ parts: [{ text: prompt }] }], generationConfig: genCfg }, opts.search ? { tools: [{ google_search: {} }] } : {}))
        });
      if (res.status === 404) { lastErr = new Error(model + " は利用不可"); continue; }
      if (res.status === 503 || res.status === 500) { lastErr = new Error("AIが混雑しています (" + res.status + ")。"); continue; }
      if (res.status === 429) { lastErr = new Error("無料枠の上限に達しました。1分待つか設定で標準モードにしてください。"); continue; }
      if (res.status === 400 || res.status === 403) throw new Error("APIキーが無効です。設定タブでキーを確認してください。");
      if (!res.ok || !res.body) { lastErr = new Error("AI応答エラー (" + res.status + ")"); continue; }
      const reader = res.body.getReader(); const dec = new TextDecoder();
      let buf = "", text = "", finish = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (line.indexOf("data:") !== 0) continue;
          const js = line.slice(5).trim(); if (!js || js === "[DONE]") continue;
          try {
            const j = JSON.parse(js);
            const cand = j.candidates && j.candidates[0];
            const parts = (cand && cand.content && cand.content.parts) || [];
            const piece = parts.filter(p => !p.thought).map(p => p.text || "").join("");
            if (piece) { text += piece; if (onChunk) onChunk(text, false); }
            if (cand && cand.finishReason) finish = cand.finishReason;
          } catch (e) {}
        }
      }
      if (!text) throw new Error("AIから回答が得られませんでした");
      const r = { text, truncated: finish === "MAX_TOKENS", model };
      aiCacheSet(ck, { text: r.text, truncated: r.truncated });
      if (onChunk) onChunk(text, true);
      return r;
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("__cancelled__");
      if (e.message && (e.message.includes("上限") || e.message.includes("キーが無効"))) throw e;
      lastErr = e;
    }
  }
  // ストリーム経路が全滅した場合は通常呼び出しへフォールバック(壊さない)
  try { return await geminiAsk(prompt, opts); } catch (e) { throw lastErr || e; }
}

/* 画像生成: Geminiの画像モデルで実画像(PNG)を生成し data URL を返す。失敗時は "" */
const imgMemCache = new Map();   // セッション内キャッシュ(無料枠の節約)
function imgCacheGet(k) {
  if (imgMemCache.has(k)) return imgMemCache.get(k);
  try { const c = JSON.parse(localStorage.getItem("ss_imgcache") || "{}"); if (c[k]) { imgMemCache.set(k, c[k]); return c[k]; } } catch (e) {}
  return null;
}
function imgCacheSet(k, dataUrl) {
  imgMemCache.set(k, dataUrl);
  // localStorageは容量が小さいので最新数件のみ保持(超過時は古いものから捨てる)
  try {
    const c = JSON.parse(localStorage.getItem("ss_imgcache") || "{}");
    c[k] = dataUrl;
    let ks = Object.keys(c);
    while (ks.length > 8) delete c[ks.shift()];
    while (ks.length) {
      try { localStorage.setItem("ss_imgcache", JSON.stringify(c)); break; }
      catch (e) { delete c[ks.shift()]; }   // 容量超過なら古い順に減らして再試行
    }
  } catch (e) {}
}
/* dataURL("data:image/png;base64,...") → {mimeType,data} (参照画像として渡す用) */
function dataUrlToInline(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || "");
  return m ? { mimeType: m[1], data: m[2] } : null;
}
async function geminiGenImage(prompt, opts) {
  opts = opts || {};
  const key = localStorage.getItem(LS.gemini);
  if (!key) throw new Error("APIキー未設定");
  const refs = (opts.refImages || []).filter(Boolean);
  // 参照画像がある時はキャッシュキーにも反映(内容が変わるため)
  const ck = "img:" + hashStr(prompt + "|" + refs.map(r => (r.data || "").slice(0, 32)).join(","));
  if (!opts.noCache) { const c = imgCacheGet(ck); if (c) return c; }
  aiAbort = new AbortController();
  let lastErr = null;
  for (const model of GEMINI_IMAGE_MODELS) {
    try {
      const parts = [{ text: prompt }];
      refs.forEach(r => parts.push({ inlineData: { mimeType: r.mimeType || "image/png", data: r.data } }));
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: aiAbort.signal,
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseModalities: ["IMAGE", "TEXT"] }
          })
        });
      if (res.status === 404) { lastErr = new Error(model + " 利用不可"); continue; }
      if (res.status === 429) { lastErr = new Error("無料枠の上限"); continue; }
      if (res.status === 400 || res.status === 403) { lastErr = new Error("画像モデル非対応/キー権限不足"); continue; }
      if (!res.ok) { lastErr = new Error("画像生成エラー(" + res.status + ")"); continue; }
      const j = await res.json();
      const respParts = j.candidates?.[0]?.content?.parts || [];
      const img = respParts.find(p => p.inlineData && p.inlineData.data);
      if (!img) { lastErr = new Error("画像が返りませんでした"); continue; }
      const mime = img.inlineData.mimeType || "image/png";
      const dataUrl = "data:" + mime + ";base64," + img.inlineData.data;
      imgCacheSet(ck, dataUrl);
      return dataUrl;
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("__cancelled__");
      lastErr = e;
    }
  }
  throw lastErr || new Error("画像生成に失敗しました");
}

/* 出力言語の指示(UIが英語のときは英語で回答させる)。■等の見出し記号はそのまま維持させる */
function aiLangDirective() {
  return (window.APP_LANG === "en")
    ? "Write the entire answer in natural English (technical automotive English). Keep the section markers such as ■ and the numbering exactly as specified, but translate their labels and all content into English."
    : "";
}

/* 回答が途中で切れた(truncated)場合、続きを取得して結合する。最大2回まで自動継続。
   onChunk があれば、結合後の全文を逐次表示に反映する。 */
async function continueIfTruncated(basePrompt, r, opts, onChunk) {
  opts = opts || {};
  let tries = 0;
  while (r && r.truncated && tries < 2) {
    tries++;
    const full = String(r.text || "");
    // 途中で切れた最後の行は不完全なことが多い。行単位で区切って続きを生成し、継ぎ目を自然にする。
    const lastNl = full.lastIndexOf("\n");
    const head = lastNl > 0 ? full.slice(0, lastNl) : full;
    const ctx = head.slice(-800);
    const contPrompt = [
      "先ほどの回答が途中で切れました。下の【ここまで】の直後から、自然に続けて最後まで出力してください。",
      "重要: 【ここまで】に既にある内容は絶対に繰り返さない。続きだけを出す。前置き・見出しの言い直し・免責・挨拶は不要。",
      "元と同じ出力形式(番号付き候補／各候補に『理由:』『切り分け:』／最後に『■最初の1手』)を維持し、途中だった候補があれば次の番号から続ける。",
      "【当初の指示(要約)】" + String(basePrompt).slice(0, 700),
      "【ここまで】\n" + ctx,
    ].join("\n");
    let cont;
    try { cont = await geminiAsk(contPrompt, { mode: opts.mode || "flash", thinkingBudget: 512, noCache: true }); }
    catch (e) { break; }
    if (!cont || !cont.text) break;
    const add = String(cont.text).replace(/^[\s　]+/, "");
    r = { text: head + "\n" + add, truncated: !!cont.truncated, model: r.model };
    if (onChunk) onChunk(r.text, false);
  }
  return r;
}
function buildDiagPrompt(text) {
  const lines = [
    "あなたは『メカ君』。まじめで頼れるロボ整備士(一人称ボク)で、どこかおちゃめな愛嬌もあるが診断は正確第一。下記の形式は守りつつ、各説明は親しみやすく分かりやすい言葉で(冒頭か末尾に軽い一言を添えてもよいが、やりすぎない)。",
    "回答前に十分に考えてから答えること。正確性を最優先し、確信が持てない内容には「（要確認）」を付け、推測と確定的な事実を混同しないこと。一般論より、提示された車種・エンジンに固有の既知事例を優先すること。",
    "【最重要・統合診断】DTCが複数ある場合は、1つずつ別々に原因を挙げてはいけない。全DTCと症状を『1つの故障像』としてまとめて解釈し、それら複数のコードや症状を1つで説明できる根本原因(共通原因)を最優先で特定すること。",
    "・1つの根本原因(例: 電源/アース不良、コネクタ接触不良、センサ電源共有、CAN通信異常、特定ハーネス断線など)が、二次的に多数のDTCを誘発しているケースが多い。表面的なコード名に引っ張られず、どのコード群が『原因』でどれが『結果(二次的・巻き添え)』かを見分ける。",
    "・原因候補の第1位は、できるだけ多くのDTC・症状を一括で説明できる根本原因にする。各候補の『理由:』では、その原因がどのDTC群を説明するか(例: P0100系とP0130系を共通の◯◯で説明)を明示する。",
    "・単独で無関係と判断できるDTCがあれば、それは別枠として扱ってよい(無理に1つに統合しない)。",
    "以下の情報から原因を診断してください。前置き・免責・挨拶は一切不要。Markdown記号(**、#、表)は使わず、必ず次の出力形式に従うこと:",
    "",
    "■原因候補（可能性が高い順）",
    "1. 原因名（一言で）",
    "理由: なぜこの症状・DTCからこの原因を疑うのか、根拠を1文で簡潔に。",
    "切り分け: 確認方法。使用工具と測定値の目安を含める。1〜2文で簡潔に。",
    "2. （同様に最大5つまで。各候補に必ず『理由:』と『切り分け:』を付ける）",
    "",
    "■最初の1手",
    "現場で最初にやるべきことを1〜2文で。",
    ""
  ];
  if (current.type) {
    const code = current.type.includes("-") ? current.type.split("-")[1] : current.type;
    const v = findVehicle(code);
    lines.push("\n■車両: 型式 " + current.type + (v ? "（" + v.name + "）" : ""));
    if (v && (v.faults || []).length) lines.push("この車種の既知の持病: " + v.faults.join(" / "));
  }
  { const os = officialSpecsText(); if (os) lines.push(os); }
  const dtcs = extractDTCs(text);
  if (dtcs.length) {
    const named = dtcs.map(c => { const d = lookupDTC(c); return c + (d.exact ? "（" + d.name + "）" : ""); });
    lines.push("■診断機のDTC: " + named.join(", "));
  }
  lines.push("■症状・問診内容: " + text);
  const ld = aiLangDirective(); if (ld) lines.push("\n" + ld);
  return lines.join("\n");
}

/* 原因候補に「点検手引書」ボタンを付ける。タップでその候補を確定/除外する点検手順をAIが生成(初回のみ・折り畳み)。
   基本操作の解説ではなく、その原因を解決に導く具体的な点検を出す。 */
function buildInspectManualPrompt(cause, kirikake) {
  return [
    "あなたは経験豊富な整備士『メカ君』。指定された『疑う原因』を、実車で確定または除外するための点検手引書を作成する。",
    "対象車両: " + (typeof vehicleDesc === "function" ? vehicleDesc() : ""),
    officialSpecsText(),
    lastDiagInput ? "現在の症状・問診: " + lastDiagInput : "",
    "疑う原因: " + cause,
    kirikake ? "想定される切り分けの方針: " + kirikake : "",
    "この原因を実車で確定/除外するための点検手引書を、次の見出し構成で作成する。",
    "【出力フォーマット(厳守)】",
    "・見出しは行頭に ■ を付ける。見出しは順に: ■準備する物 / ■点検手順 / ■判定の目安 / ■この原因だった場合の対処 / ■注意。",
    "・各見出しの下は『1行に1項目』。1行に複数の内容を詰め込まない。①②③のような記号で1行にまとめない。",
    "・■点検手順 は番号付き(1. 2. 3. …)で、1手順=1動作の短い文にする。『部位』『使う工具』『測定/確認方法』『正常値の目安』を伝えたい時は、それぞれ別の手順(別の行)に分けて書く。",
    "・■判定の目安 は『◯◯なら正常/△△ならこの原因』を1項目ずつ、具体的な数値で。",
    "・■この原因だった場合の対処 は交換部品・処置を1〜2行で。",
    "・1文が長くなりすぎないように短く区切る(スマホで読みやすく)。",
    "その車両に即した具体的な内容にし、一般的なテスターの使い方の説明に終始しない。専門用語には短い補足を付ける。",
    "出力は上記の■見出しと項目だけ(前置き・免責・Markdown記号・引用マーカーは書かない)。",
    (window.APP_LANG === "en" ? "Answer in natural technical English." : "")
  ].filter(Boolean).join("\n");
}
/* 事前生成した点検手引書のキャッシュ(原因名→本文)。診断ごとにリセット。
   バックグラウンドで上位候補ぶんを先に作っておき、タップ時は待たずに開ける(時短)。 */
let diagGuideCache = {};
let inspectPaneReg = [];   // {cause, apply(text)} 事前生成完了時に該当ペインへ流し込むための登録
function attachInspectManual(itemDiv, cause) {
  const wrap = document.createElement("div"); wrap.className = "manualWrap";
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "manualBtn"; btn.textContent = "📖 点検手引書を作る";
  const pane = document.createElement("div"); pane.className = "manualPane hidden";
  wrap.append(btn, pane); itemDiv.appendChild(wrap);
  let loaded = false, loading = false, preparing = false;
  function fill(text) {   // 本文をペインへ描画し「作成済み」状態にする(表示状態は変えない)
    preparing = false; btn.classList.remove("preparing");
    pane.innerHTML = ""; renderInspectManual(pane, cleanCite(text)); loaded = true;
    btn.classList.add("ready");
    if (pane.classList.contains("hidden")) btn.textContent = "📖 点検手引書を開く";
  }
  function prep() {   // バックグラウンド生成中であることを示す
    if (loaded || loading) return;
    preparing = true; btn.classList.add("preparing");
    if (pane.classList.contains("hidden")) btn.textContent = "📖 点検手引書を準備中…";
  }
  function unprep() {   // 生成に失敗した場合は元に戻す(タップで手動生成できる)
    preparing = false; btn.classList.remove("preparing");
    if (!loaded && pane.classList.contains("hidden")) btn.textContent = "📖 点検手引書を作る";
  }
  // 既に事前生成済みなら即反映
  if (diagGuideCache[cause]) fill(diagGuideCache[cause]);
  inspectPaneReg.push({ cause, apply: (t) => { if (!loaded && !loading) fill(t); }, prep, unprep });
  btn.addEventListener("click", async () => {
    const open = pane.classList.toggle("hidden") === false;
    if (loaded) { btn.textContent = open ? "📖 点検手引書を閉じる" : "📖 点検手引書を開く"; return; }
    btn.textContent = open ? "📖 点検手引書を閉じる" : (preparing ? "📖 点検手引書を準備中…" : "📖 点検手引書を作る");
    if (!open || loading) return;
    if (!aiOK()) { pane.textContent = "点検手引書の生成には設定タブでGemini APIキーが必要です。"; return; }
    loading = true;
    pane.innerHTML = '<div class="hint">🔧 メカ君がこの原因の点検手引書を作成中…(数秒〜十数秒)</div>';
    try {
      const li = itemDiv.parentElement;   // 候補の<li>
      const kirikake = (li && li.dataset && li.dataset.kirikake) || "";
      const r = await geminiAsk(buildInspectManualPrompt(cause, kirikake), { mode: "pro" });
      diagGuideCache[cause] = r.text;
      if (typeof stashGuideToRecord === "function") stashGuideToRecord(cause, r.text);   // 履歴レコードにも保存
      pane.innerHTML = "";
      renderInspectManual(pane, cleanCite(r.text));   // 見出しタップで開閉するアコーディオン形式
      loaded = true; loading = false; btn.classList.add("ready");
    } catch (e) {
      loading = false;
      pane.innerHTML = '<div class="hint">⚠ ' + esc(e.message === "__cancelled__" ? "中断しました" : (e.message || "作成できませんでした")) + '</div>';
    }
  });
}
/* 上位の原因候補ぶんの点検手引書をバックグラウンドで先に生成しておく(時短)。
   逐次実行で無料枠への負荷を抑え、思考も短めに切り上げて速く仕上げる。完了ぶんは表示中のペインへ即反映。 */
const AUTO_GUIDE_COUNT = 3;   // 先行生成する候補数
async function autoGenGuides(causes, rec, statusEl) {
  const clearStatus = () => { if (statusEl && statusEl.parentNode) statusEl.remove(); };
  if (!aiOK() || !Array.isArray(causes)) { clearStatus(); return; }
  const targets = causes.filter(c => c && !diagGuideCache[c] && inspectPaneReg.some(p => p.cause === c)).slice(0, AUTO_GUIDE_COUNT);
  if (!targets.length) { clearStatus(); return; }
  const setStatus = (done) => { if (statusEl) statusEl.textContent = "🔧 点検手引書を準備中…（" + done + "/" + targets.length + "）"; };
  setStatus(0);
  // 本体診断の直後に連続でPro呼び出しすると無料枠(RPM)で429になりやすい → 少し間隔を空けて逐次実行。
  await sleep(600);
  let ok = 0;
  for (let i = 0; i < targets.length; i++) {
    const cause = targets[i];
    if (diagGuideCache[cause]) { ok++; setStatus(ok); continue; }
    const regs = inspectPaneReg.filter(p => p.cause === cause);
    if (!regs.length) continue;
    regs.forEach(p => p.prep && p.prep());
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try {
        const r = await geminiAsk(buildInspectManualPrompt(cause, ""), { mode: "pro", thinkingBudget: 2048 });
        diagGuideCache[cause] = r.text;
        if (rec) { rec.guides[cause] = r.text; saveDiagRecordObj(rec); }
        regs.forEach(p => p.apply(r.text));
        done = true; ok++;
      } catch (e) {
        // レート制限(上限)なら少し待って1回だけ再試行。それ以外/2回目失敗は諦める。
        if (attempt === 0 && e && /上限|429|混雑/.test(e.message || "")) { await sleep(6000); }
        else break;
      }
    }
    if (!done) regs.forEach(p => p.unprep && p.unprep());
    setStatus(ok);
    if (i < targets.length - 1) await sleep(1500);   // 次の生成まで少し間隔を空ける
  }
  if (statusEl) {
    if (ok) statusEl.textContent = "✅ 点検手引書を" + ok + "件用意しました（原因候補の「点検手引書を開く」から確認できます）";
    else clearStatus();
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* 点検手引書を「見出しタップで開閉するアコーディオン」で描画。
   ■/【】見出しごとに区切り、見出しをタップすると内容が開き、他の見出しを開くと前は閉じる(1つだけ開く)。 */
function renderInspectManual(container, text) {
  container.innerHTML = "";
  const clean = String(text || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "")
    .replace(/([^\n])[ 　]*(■)/g, "$1\n$2");   // 詰まった見出し■だけ改行(保険)
  const lines = clean.split(/\n/).map(l => l.trim()).filter(Boolean);
  // 見出し(■/【】)ごとにセクション分割
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^[■【]\s*(.+?)[】]?$/);
    if (h) { cur = { title: h[1], body: [] }; sections.push(cur); }
    else { if (!cur) { cur = { title: "点検手引書", body: [] }; sections.push(cur); } cur.body.push(line); }
  }
  sections.forEach((sec) => {
    const item = document.createElement("div"); item.className = "imSection";
    const head = document.createElement("button"); head.type = "button"; head.className = "imHead";
    head.innerHTML = '<span class="imChevron">▸</span><span class="imTitle"></span>';
    head.querySelector(".imTitle").textContent = sec.title;
    const body = document.createElement("div"); body.className = "imBody hidden";
    const numbered = /手順|手引|検査|作業/.test(sec.title);   // 点検手順は連番、その他は・で表示
    let n = 0;
    sec.body.forEach((raw) => {
      let t = raw.trim();
      if (/^\d+[.)]?$/.test(t)) return;                       // 番号だけの行(ゴミ)は捨てる
      t = t.replace(/^(?:\d{1,2}[.)、:：]|[①-⑳]|[・\-*])\s*/, "").trim();   // 先頭の番号/記号を除去
      if (!t) return;
      const row = document.createElement("div"); row.className = "imRow";
      const mk = document.createElement("span"); mk.className = "imMk";
      if (numbered) { n++; mk.textContent = n; mk.classList.add("num"); } else { mk.textContent = "・"; }
      const tx = document.createElement("span"); tx.className = "imTx"; tx.textContent = t;
      row.append(mk, tx); body.appendChild(row);
    });
    head.addEventListener("click", () => {
      const willOpen = body.classList.contains("hidden");
      container.querySelectorAll(".imBody").forEach(b => b.classList.add("hidden"));
      container.querySelectorAll(".imHead").forEach(h => h.classList.remove("open"));
      if (willOpen) {
        body.classList.remove("hidden"); head.classList.add("open");
        // 高さ変化でスクロールがズレて飛ぶのを防ぐ: 押した見出しを見える位置へ(固定ナビに隠れないよう余白)
        head.style.scrollMarginTop = "70px";
        setTimeout(() => head.scrollIntoView({ block: "start", behavior: "smooth" }), 30);
      }
    });
    item.append(head, body); container.appendChild(item);
  });
  // 先頭セクションだけ最初から開いておく
  const fh = container.querySelector(".imHead"); const fb = container.querySelector(".imBody");
  if (fh && fb) { fh.classList.add("open"); fb.classList.remove("hidden"); }
}

/* AI回答テキストを構造化して見やすく描画 */
function renderAiAnswer(container, text, opts) {
  opts = opts || {};
  container.innerHTML = "";
  // Markdown記号の残骸を除去
  const clean = text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "").replace(/^\s*[\*\-]\s+/gm, "・");
  const lines = clean.split(/\n/).map(l => l.trim()).filter(Boolean);
  let list = null;
  const flushList = () => { list = null; };
  for (const line of lines) {
    // 見出し (■〜 / 【〜】)
    const h = line.match(/^[■【]\s*(.+?)[】]?$/);
    if (h) {
      flushList();
      const el = document.createElement("div");
      el.className = "ai-h"; el.textContent = h[1];
      container.appendChild(el);
      continue;
    }
    // 番号付き項目 → バッジ付きリスト
    const n = line.match(/^(\d+)[.)、]\s*(.+)$/);
    if (n) {
      if (!list) { list = document.createElement("ol"); list.className = "guide-steps ai-list"; container.appendChild(list); }
      const li = document.createElement("li");
      const div = document.createElement("div"); div.className = "ai-item";
      const t = document.createElement("div"); t.className = "ai-cause"; t.textContent = n[2];
      div.appendChild(t);
      if (opts.illustrate) attachStepFigure(li, div, n[2]);   // タップで参考図を表示
      if (opts.linkCauses) attachInspectManual(div, n[2]);    // 診断の各原因候補に「点検手引書」を生成できるボタン
      li.appendChild(div);
      list.appendChild(li);
      continue;
    }
    // 「理由:」行 → 折り畳み(タップで開閉。他を開くと現在の理由は畳む=アコーディオン)
    const rz = line.match(/^[・]?\s*(理由|根拠)\s*[:：]\s*(.+)$/);
    if (rz && list && list.lastElementChild) {
      const wrap = document.createElement("div"); wrap.className = "ai-reason";
      const tog = document.createElement("button"); tog.type = "button"; tog.className = "ai-reason-toggle"; tog.textContent = "理由";
      const body = document.createElement("div"); body.className = "ai-reason-body"; body.textContent = rz[2];
      tog.addEventListener("click", () => {
        const willOpen = !wrap.classList.contains("open");
        container.querySelectorAll(".ai-reason.open").forEach(el => el.classList.remove("open"));   // 他の理由を畳む
        if (willOpen) wrap.classList.add("open");
      });
      wrap.append(tog, body);
      list.lastElementChild.firstElementChild.appendChild(wrap);
      continue;
    }
    // 「切り分け:」行 → 直前の項目にぶら下げ(ラベル文字は表示しない)
    const k = line.match(/^[・]?\s*(切り分け|確認|点検方法)\s*[:：]\s*(.+)$/);
    if (k && list && list.lastElementChild) {
      const d = document.createElement("div");
      d.className = "ai-check";
      d.textContent = k[2];   // 「切り分け」ラベルは付けず内容のみ
      // この候補の手引書生成に切り分け内容も渡せるよう保持
      const li0 = list.lastElementChild; if (li0) li0.dataset.kirikake = k[2];
      li0.firstElementChild.appendChild(d);
      continue;
    }
    // 箇条書き・通常文
    flushList();
    const p = document.createElement("div");
    p.className = "ai-p"; p.textContent = line;
    container.appendChild(p);
  }
}

/* 部品注文リストの部品名タップで、実物画像を下に開閉(初回のみ取得)。
   CSE(画像検索キー)設定済み→実写サムネ、未設定→Web画像検索リンクのみ。 */
function attachPartPicture(nameEl, pane, partName) {
  let loaded = false;
  nameEl.addEventListener("click", async () => {
    // アコーディオン: 同じリスト内で他に開いている画像パネルは閉じる
    const willOpen = pane.classList.contains("hidden");
    if (willOpen && pane.parentNode) {
      pane.parentNode.querySelectorAll(".partPic").forEach(p => { if (p !== pane) p.classList.add("hidden"); });
    }
    const open = pane.classList.toggle("hidden") === false;
    if (!open || loaded) return;
    loaded = true;
    const car = (currentVehicleFacts().model || (current && current.type) || "").trim();
    const q = (car + " " + han(partName) + " 部品").trim();
    const linkHtml = '<a class="linkbtn" target="_blank" rel="noopener" href="https://www.google.com/search?q='
      + encodeURIComponent(q) + '&tbm=isch">🔍 Web画像でもっと探す<span class="arr">↗</span></a>';
    if (!cseReady()) {
      pane.innerHTML = '<div class="partPicNote">実写画像を表示するには、設定タブで画像検索キーの登録が必要です。</div>' + linkHtml;
      return;
    }
    pane.innerHTML = '<div class="partPicNote">画像を探しています…</div>';
    try {
      const imgs = await googleImageSearch(q, 3);
      if (!imgs.length) { pane.innerHTML = '<div class="partPicNote">画像が見つかりませんでした。</div>' + linkHtml; return; }
      pane.innerHTML = '<div class="partPicRow">' + imgs.map(im =>
        '<a href="' + esc(im.ctx) + '" target="_blank" rel="noopener"><img src="' + esc(im.thumb) + '" alt="' + esc(partName) + '" loading="lazy"></a>'
      ).join("") + '</div><div class="partPicCap">' + esc(han(partName)) + '（Web画像・参考）</div>' + linkHtml;
    } catch (e) {
      // 原因に応じたワンタップの修正ボタンを出す(キー制限の修正 or プロジェクトの有効化)
      const fix =
        (e && e.fixUrl)
          ? '<a class="btn btn-cyan btnWide" style="margin-top:8px" target="_blank" rel="noopener" href="' + esc(e.fixUrl) + '">' + esc(e.fixLabel || "APIキーの設定を開く ↗") + '</a>'
          : (e && e.enableUrl)
            ? '<a class="btn btn-cyan btnWide" style="margin-top:8px" target="_blank" rel="noopener" href="' + esc(e.enableUrl) + '">このプロジェクトでCustom Search APIを有効にする ↗</a>'
            : "";
      const raw = (e && e.raw) ? '<div class="partPicNote" style="margin-top:6px;opacity:.7;word-break:break-all">Googleからの応答: ' + esc(e.raw) + '</div>' : "";
      pane.innerHTML = '<div class="partPicNote" style="white-space:pre-line">' + esc((e && e.userMsg) || "画像を取得できませんでした。") + '</div>' + fix + raw + linkHtml;
    }
  });
}

/* 手順の li をタップ可能にして、参考図(メカ君の図解＋画像検索)を下に開く */
function attachStepFigure(li, div, stepText) {
  li.classList.add("hasFig");
  const fig = document.createElement("div"); fig.className = "stepFig hidden";
  div.appendChild(fig);
  const hint = document.createElement("div"); hint.className = "stepFigHint"; hint.textContent = "参考図";
  div.appendChild(hint);
  let loaded = false;
  div.addEventListener("click", async () => {
    const open = fig.classList.toggle("hidden") === false;
    hint.textContent = open ? "参考図を隠す" : "参考図";
    if (!open || loaded) return;
    loaded = true;
    fig.innerHTML = '<div class="stepFigLoad">🔧 メカ君が実物を確認して図を描いています…(十数秒〜30秒ほど)</div>';
    // 画像検索リンク(AIキーが無くても使える保険)
    const carName = figureVehicleDesc();
    const q = ((currentVehicleFacts().model || current.type || "") + " " + stepText).trim();
    const linkHtml = '<a class="linkbtn" target="_blank" rel="noopener" href="https://www.google.com/search?q='
      + encodeURIComponent(q) + '&tbm=isch">🔍 実物の参考画像をWebで探す<span class="arr">↗</span></a>';
    if (!aiOK()) { fig.innerHTML = linkHtml; return; }
    try {
      // ①「実物の特徴」を文章で正確に洗い出す(実写知識で図の精度を上げる。失敗しても続行)
      let refDesc = "";
      try { refDesc = await geminiStepVisualRef(stepText, carName); } catch (e) { if (e && e.message === "__cancelled__") throw e; }
      // ②実物に忠実な写実リファレンス画像を生成(部品形状・取付位置の再現性の土台)
      let refInline = null;
      try {
        const photo = await geminiGenImage(buildPartPhotoPrompt(stepText, carName, refDesc));
        if (photo) refInline = dataUrlToInline(photo);
      } catch (e) { if (e && e.message === "__cancelled__") throw e; }
      // ③リファレンスの構造(形状・取付位置・工具の当たり)を保持したまま、今のイラストタッチで描き直す
      let body = "";
      try {
        const dataUrl = await geminiGenImage(
          buildStepImagePrompt(stepText, carName, refDesc, !!refInline),
          refInline ? { refImages: [refInline] } : undefined
        );
        if (dataUrl) body = '<div class="stepFigSvg"><img alt="参考図" src="' + dataUrl + '"></div><div class="stepFigCap">メカ君が描いた参考イラスト（イメージ）</div>';
      } catch (e) { if (e && e.message === "__cancelled__") throw e; }
      if (!body) {
        const svg = await geminiStepFigure(stepText);
        if (svg) body = '<div class="stepFigSvg">' + svg + '</div><div class="stepFigCap">メカ君のイメージ図（参考）</div>';
      }
      fig.innerHTML = body + linkHtml;
    } catch (e) {
      fig.innerHTML = (e && e.message === "__cancelled__" ? "" : '<div class="hint">図を描けませんでした。</div>') + linkHtml;
      loaded = false;
    }
  });
}
/* 図解用の車両記述(読み取った車両データを作画へ反映) */
function figureVehicleDesc() {
  const f = currentVehicleFacts();
  const makerJa = { isuzu: "いすゞ", hino: "日野", fuso: "三菱ふそう", ud: "UD", nissan: "日産", toyota: "トヨタ", honda: "ホンダ", mazda: "マツダ", suzuki: "スズキ", daihatsu: "ダイハツ", subaru: "スバル" };
  const code = current.type && current.type.includes("-") ? current.type.split("-")[1] : current.type;
  const hit = code ? findVehicle(code) : null;
  const mk = hit && makerJa[hit.maker] ? makerJa[hit.maker] : null;
  const parts = [];
  if (f.model) parts.push(f.model); else if (mk) parts.push(mk);
  if (current.type) parts.push("型式 " + current.type);
  if (current.engine) parts.push("原動機 " + current.engine);
  return parts.length ? parts.join(" / ") : "一般的な自動車";
}
/* 写実リファレンス画像用プロンプト(構造再現の土台。イラスト化はしない) */
/* 取り付け位置の写実リファレンス(区画全体＋対象部品が文脈で分かる) */
function buildPartLocationPhotoPrompt(part, carName, refDesc) {
  const lines = [
    "自動車整備の資料用に、指定部品の『取り付け位置』が分かる実物に忠実なクローズアップ画像を1枚生成してください。",
    "目的: その部品が車両のどの区画(エンジンルーム/車両下部/室内/トランク等)の、どこに・どんな向きで付いているかを、周囲の部品との位置関係が分かる引き〜中距離で正確に示す。",
    "対象車両: " + (carName || "一般的な自動車") + "。この車種・車格に実在する該当部品と周辺レイアウトの正しい形にする。別車種にしない。",
    "写実・正確第一。文字/数字/ロゴ/透かしは入れない。イラスト化・誇張はしない(資料写真)。",
  ];
  if (refDesc) { lines.push("【実物の特徴メモ(反映)】"); lines.push(refDesc); }
  lines.push("対象部品: " + part);
  return lines.join("\n");
}
/* 取り付け位置のイラスト(区画を示し、対象部品を丸/矢印で強調) */
function buildPartLocationImagePrompt(part, carName, refDesc, hasRef) {
  const lines = [
    "自動車整備マニュアル用の『部品の取り付け位置イラスト』を1枚生成してください。",
    "目的: 指定部品が車両のどこに付いているかが一目で分かる図。該当区画(エンジンルーム/下部/室内等)を示し、対象部品を控えめな丸囲みまたは矢印で1か所だけ強調する。周囲の目印部品も描いて位置関係が分かるように。",
    "対象車両(実物に合わせる): " + (carName || "一般的な自動車") + "。車格・レイアウトをこの車種に合わせ、別車格の部品を描かない。",
  ];
  if (hasRef) lines.push("【最重要】添付の参照画像に厳密に従い、部品の形状・位置・周囲との関係を正確に再現(構造は保持)。画風だけ下記イラストに変える。");
  if (refDesc && !hasRef) { lines.push("【実物の特徴(反映)】"); lines.push(refDesc); }
  lines.push(
    "スタイル(厳守): 清潔感のある半写実イラスト(整備教本の挿絵風)。やわらかい陰影と分かりやすい色分け。1コマのみ。写真そのものにはしない。",
    "禁止: 文字/数字/ロゴ/寸法線/透かし、人物の顔や全身、過度な誇張。強調の丸/矢印以外の余計な装飾は避ける。",
    "強調する対象部品: " + part
  );
  return lines.join("\n");
}
function buildPartPhotoPrompt(stepText, carName, refDesc) {
  const lines = [
    "自動車整備の資料用に、実物に忠実な写実的クローズアップ画像を1枚生成してください。",
    "目的: 部品の実際の形状・取り付け位置・向き・締結部(ボルト/クリップ)・周囲の部品との位置関係を、現車と同等の再現性で正確に示すこと。",
    "対象車両: " + (carName || "一般的な自動車") + "。この車種・車格に実在する該当部品の正しい形状とレイアウトにすること。別車種・別車格の部品にしない。",
    "構図: 作業対象の部品を画面中央に大きく、実際の取り付け状態(車体上の位置関係が分かる範囲)で。整備士の手や工具は入れても入れなくてもよいが、部品の形状を隠さない。",
    "写実・正確第一。文字/数字/ロゴ/寸法線/透かしは入れない。誇張やイラスト化はしない(これは資料写真)。",
  ];
  if (refDesc) { lines.push("【実物の特徴メモ(反映する)】"); lines.push(refDesc); }
  lines.push("作業/対象: " + stepText);
  return lines.join("\n");
}
/* 画像生成モデル向けプロンプト(整備イラスト)。carName=車両 / refDesc=特徴資料 / hasRef=参照画像あり */
function buildStepImagePrompt(stepText, carName, refDesc, hasRef) {
  const lines = [
    "自動車整備マニュアルの『作業手順イラスト』を1枚生成してください。",
    "最重要: 車の外観カタログ写真ではなく、その作業を“今まさに行っている動作”が一目で分かる図にすること。",
    "対象車両(この車の実物に合わせて描く): " + (carName || "一般的な自動車") + "。この車種の車格・ボディタイプ(軽/乗用/ミニバン/トラック等)や、該当部品の実際の形状・レイアウトに合わせること。別の車格の部品を描かない。",
  ];
  if (hasRef) {
    lines.push("【最重要・添付の参照画像に厳密に従う】添付画像は実物に忠実な資料です。部品の形状・比率・取り付け位置・向き・締結部・周囲部品との位置関係を、参照画像どおりに正確に再現(トレースするつもりで構造を保持)すること。位置や形を勝手に変えない。");
    lines.push("変えるのは画風だけ: 参照画像の構造はそのまま、下記のイラストタッチに描き直す。");
  }
  lines.push(
    "視点・構図: 作業対象の部品を画面中央に大きく配置(寄りのクローズアップ)。整備士の手と工具が、その部品のどこに・どの向きで当たり、どう動かすかが明確に分かる角度で描く。",
    "動作の明示: 工具の回転方向や部品の着脱方向を、控えめな矢印で1〜2本だけ示す。手は作業に必要な分だけ(1〜2本)描き、部品を隠さない。",
    "正確さ: 工具の種類(レンチ/ラチェット/ドライバー/ジャッキ等)と部品の形状・取り付け位置を、その作業として技術的に正しく描く。ボルト本数や向きなど分かる範囲で実機に忠実に。誤った構造は描かない。"
  );
  if (refDesc && !hasRef) { lines.push("【実物の特徴(忠実に反映)】"); lines.push(refDesc); }
  lines.push(
    "スタイル(厳守・変更禁止): 清潔感のある半写実イラスト(整備教本の挿絵風)。やわらかい陰影と分かりやすい色分け。背景は薄いガレージ床/単色でごく簡素にし、作業部位を最も目立たせる。1コマのみ(複数コマ・分割なし)。写真そのものにはしない。",
    "禁止: 車全体の外観・テールランプ・エンブレム等“車種が分かるだけ”の絵、文字/数字/ロゴ/寸法線/透かし、人物の顔や全身、過度な誇張やマンガ的効果。",
    "作業内容(これを描く): " + stepText
  );
  return lines.join("\n");
}
/* 実物の見た目を文章で正確に洗い出す(実写知識ベースの資料。イラスト精度向上用。キャッシュあり) */
async function geminiStepVisualRef(stepText, carName) {
  const prompt = [
    "あなたは自動車整備の資料担当です。次の作業を図解するための『実物の見た目メモ』を作ってください。",
    "実際の写真を思い出すつもりで、事実に基づいて具体的に。箇条書きで4〜6行、各行短く。",
    "含める観点: 作業対象の部品の形状・色・素材感 / 使う工具の種類と当て方 / 手の位置と動かす方向 / 周囲にある目印になる部品 / 一番分かりやすいカメラ視点。",
    "推測が混じる場合はその旨は書かず、最も一般的で確からしい実物の特徴を書く。前置き・説明・見出しは不要、メモ本文だけ。",
    "対象車両: " + (carName || "一般的な自動車"),
    "作業: " + stepText,
  ].join("\n");
  const r = await geminiAsk(prompt, { mode: "flash" });
  return String(r.text || "").trim().slice(0, 700);
}
/* 手順テキストから、シンプルな線画SVGをGeminiに描かせる(キャッシュあり) */
async function geminiStepFigure(stepText) {
  const prompt = [
    "あなたは整備マニュアル用の図を描くイラストレーターです。",
    "次の自動車整備の手順を理解しやすくする、シンプルな線画の説明イラストを SVG で1枚描いてください。",
    "条件: 出力は <svg> ～ </svg> のみ(前後の文章・コードフェンス・説明は一切不要)。",
    "viewBox=\"0 0 400 300\" を指定し、width/heightは付けない。背景は描かない(透明)。",
    "線は stroke=\"#1f2a44\" stroke-width=\"3\" fill=\"none\" を基本に、必要な部分だけ薄い塗り(fill=\"#dbe4f3\")。",
    "要点を矢印で示し、日本語の短いラベルを <text fill=\"#1f2a44\" font-size=\"15\"> で2〜4個まで添える。",
    "写実的でなくてよい。記号的・模式的に、工具や部品の位置関係が伝わることを最優先。",
    "<script> や外部参照(href, image)は使わないこと。",
    "■対象車両: " + ((current && (current.model || current.type)) || "一般車両"),
    "■描く手順: " + stepText,
  ].join("\n");
  const r = await geminiAsk(prompt, { mode: "flash" });
  let s = String(r.text || "").trim();
  const i = s.indexOf("<svg"); const j = s.lastIndexOf("</svg>");
  if (i < 0 || j < 0) return "";
  s = s.slice(i, j + 6);
  // 安全化: scriptや外部参照を除去
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+="[^"]*"/gi, "")
       .replace(/(href|xlink:href|src)\s*=\s*"[^"]*"/gi, "");
  return /<svg[\s\S]*<\/svg>/i.test(s) ? s : "";
}

/* 「解析する」から自動実行されるAI診断 (キー未設定なら案内カードのみ) */
let diagAiBusy = false;
let lastDiagInput = "";   // 直近の診断入力(症状/DTC)。原因候補ごとの点検手引書生成に使う
async function runDiagAI(text) {
  lastDiagInput = text || "";
  const box = $("diagResults");
  if (!aiOK()) {
    const { sec, body } = diagSection("", "AI", "AI診断を使うには");
    const p = document.createElement("div");
    p.className = "hint";
    p.textContent = "無料のGemini APIキーを設定すると、ここにAIの診断見解も表示されます(クレジットカード不要)。";
    const go = document.createElement("button");
    go.type = "button"; go.className = "btn btn-ghost btn-sm"; go.style.marginTop = "8px";
    go.textContent = "⚙ 設定画面でキーを取得・保存する";
    go.addEventListener("click", () => switchView("settings"));
    body.append(p, go);
    box.prepend(sec);
    return;
  }
  if (diagAiBusy) return;
  diagAiBusy = true;
  const { sec, body } = diagSection("", "メカ君", "メカ君の見解");
  const p = document.createElement("div");
  p.className = "ai-answer";
  const stopTimer = startThinkingTimer(p, "🔧 メカ君が考えています");   // 経過秒を出して待機の体感を軽くする
  body.appendChild(p);
  box.prepend(sec);
  let streamed = false;
  try {
    // ストリーミングで逐次表示＋思考量に上限を設けて、結果が出るまでの待ち時間を短縮する。
    const dp = buildDiagPrompt(text);
    let r = await geminiAskStream(dp, { mode: "pro", thinkingBudget: 3072 }, (acc, done) => {
      if (done) return;
      if (!streamed) { streamed = true; stopTimer(); p.classList.add("streaming"); }
      p.textContent = acc;   // 生成されたぶんから先に読める
    });
    // 途中で切れていたら続きを自動取得して結合(ジェミニのストリーム途中終了対策)
    if (r && r.truncated) { p.textContent = (r.text || "") + "\n…続きを取得中…"; r = await continueIfTruncated(dp, r, { mode: "flash" }, (acc) => { p.textContent = acc; }); }
    stopTimer();
    p.classList.remove("streaming");
    renderAiAnswer(p, r.text, { linkCauses: true });
    const eb = engineBadge(r.model); if (eb) { const h2 = sec.querySelector("h2"); if (h2) h2.appendChild(eb); }
    const note = document.createElement("div");
    note.className = "hint"; note.style.marginTop = "10px";
    note.textContent = (r.truncated ? "⚠ 回答が長いため一部省略された可能性があります。 " : "")
      + "※ AIの回答は参考情報です。必ず実測・実点検で裏取りしてください。";
    body.appendChild(note);
    // 結果を履歴に保存(別車両を検索して画面がクリアされても後から一覧で閲覧できる)
    const rec = saveDiagRecord(text, r.text, getAiMode());
    addDiagHeadShare(sec, rec);   // 見出し右端に共有(バッジは左寄せ)
    // 上位の原因候補ぶんの点検手引書をバックグラウンドで先に作っておく(時短)。進捗を表示。
    const guideNote = document.createElement("div"); guideNote.className = "hint guidePrep";
    body.appendChild(guideNote);
    const causes = [...p.querySelectorAll(".ai-cause")].map(e => e.textContent.trim()).filter(Boolean);
    autoGenGuides(causes, rec, guideNote);
    appendAiFollowup(body, text, r.text);
  } catch (e) {
    stopTimer();
    if (e.message !== "__cancelled__") p.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
  } finally {
    diagAiBusy = false;
  }
}
/* 実際に使われたAIエンジンのバッジ(高精度Pro / 標準Flash)。モデル名にproを含むかで判定。
   店舗版で「Proが使われているか」を現場で目視確認できるようにする。 */
function engineBadge(model) {
  if (!model || model === "cache" || model === "proxy" || model === "demo") return null;
  const pro = /pro/i.test(model) && !/^proxy$/i.test(model);
  const b = document.createElement("span");
  b.className = "engBadge " + (pro ? "pro" : "flash");
  b.textContent = pro ? "高精度Pro" : "標準Flash";
  b.title = "使用エンジン: " + model;
  return b;
}
/* 「考えています…(n秒)」と経過秒を1秒ごとに更新。stop()で停止。待機の体感を軽減する。 */
function startThinkingTimer(el, label) {
  const t0 = Date.now(); let stopped = false;
  const upd = () => { if (stopped) return; const s = Math.round((Date.now() - t0) / 1000); el.textContent = label + "…(" + s + "秒)"; };
  upd(); const iv = setInterval(upd, 1000);
  return () => { stopped = true; clearInterval(iv); };
}

/* =========================================================
   診断結果の保存・履歴・共有
   別車両の検索で画面がクリアされても、出した結果は端末に残り後から閲覧できる。
   各レコードには入力・見解・(事前生成した)点検手引書をまとめて保存し、そのまま共有もできる。
   ========================================================= */
const DIAG_HIST_KEY = "ss_diaghist";
const DIAG_HIST_MAX = 40;
let currentDiagRec = null;   // いま表示中の結果に対応するレコード(手引書を後から追記するため保持)
function getDiagHist() { try { return JSON.parse(localStorage.getItem(DIAG_HIST_KEY) || "[]"); } catch (e) { return []; } }
function setDiagHist(arr) { try { localStorage.setItem(DIAG_HIST_KEY, JSON.stringify((arr || []).slice(0, DIAG_HIST_MAX))); } catch (e) {} }
function curVehLabel() {
  const f = (typeof currentVehicleFacts === "function") ? currentVehicleFacts() : {};
  return { model: f.model || "", type: (current && current.type) || "", vin: (current && current.vin) || "" };
}
/* 新しい診断結果を履歴に保存し、レコードを返す(以後の手引書追記に使う) */
function saveDiagRecord(input, aiText, mode) {
  const rec = { id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    ts: Date.now(), veh: curVehLabel(), input: String(input || ""), aiText: String(aiText || ""),
    mode: mode || getAiMode(), guides: {} };
  const list = getDiagHist(); list.unshift(rec); setDiagHist(list);
  currentDiagRec = rec; renderDiagHistList();
  autoKarteRecord("diag", input, summarizeDiagText(aiText));   // カルテには「要約」だけ記録(全文は診断履歴/共有で確認)
  return rec;
}
/* 診断結果を短い要約に(カルテのメモ用)。原因候補(番号付き)の上位3件を「考えられる原因: …」にまとめる。 */
function summarizeDiagText(t) {
  const clean = String(t == null ? "" : t).replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "");
  const lines = clean.split(/\n/).map(l => l.trim()).filter(Boolean);
  const causes = [];
  for (const line of lines) {
    const n = line.match(/^(\d+)[.)、]\s*(.+)$/);
    if (n) {
      let c = n[2].replace(/^(原因候補|原因)\s*[:：]?\s*/, "");
      c = c.split(/[。：:（(]/)[0].trim();
      if (c) causes.push(c);
      if (causes.length >= 3) break;
    }
  }
  if (causes.length) {
    const circ = ["①", "②", "③", "④", "⑤"];
    return "考えられる原因\n" + causes.map((c, i) => (circ[i] || (i + 1) + ".") + " " + c).join("\n");
  }
  const first = lines.filter(l => !/^[■【]/.test(l)).join(" ").replace(/\s+/g, " ").trim();
  return first.slice(0, 120);
}
/* 修理(点検手引書)結果を短い要約に(カルテのメモ用)。位置・所要時間・手順数などを1行に。 */
function summarizeRepairText(obj, q) {
  obj = obj || {};
  const parts = [];
  if (obj.location) parts.push("位置: " + String(obj.location).replace(/\s+/g, " ").trim().slice(0, 40));
  if (obj.time) parts.push("所要: " + String(obj.time).replace(/\s+/g, " ").trim().slice(0, 30));
  const steps = Array.isArray(obj.order) ? obj.order.length : (Array.isArray(obj.steps) ? obj.steps.length : 0);
  if (steps) parts.push("手順: " + steps + " ステップ");
  if (parts.length) return parts.join("\n");
  const a = String(obj.answer == null ? "" : obj.answer).replace(/\*\*(.+?)\*\*/g, "$1").replace(/\s+/g, " ").trim();
  return a.slice(0, 120);
}
/* 診断・修理の結果を整備カルテに自動記録する(=永続保存＋クラウド同期で社内共有)。
   ・車両が特定できている時のみ / デモでは保存しない / 空結果は保存しない。 */
function autoKarteRecord(kind, input, noteText) {
  try {
    if (typeof isDemo === "function" && isDemo()) return;
    if (!current || !vehicleKey(current)) return;
    const note = String(noteText == null ? "" : noteText).trim();
    if (!note) return;
    const d = new Date();
    const ymd = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const label = kind === "repair" ? "AI点検・修理手引書" : "AI故障診断";
    const entry = {
      id: "k" + Date.now() + Math.floor(Math.random() * 1000),
      date: ymd, odo: null,
      work: "🔧 " + label + (input ? "：" + String(input).replace(/\s+/g, " ").trim().slice(0, 60) : ""),
      parts: "", cost: null,
      staff: (window.Cloud && window.Cloud.myName && window.Cloud.myName()) || "",
      note: note.slice(0, 4000),
      at: new Date().toISOString(),
      auto: true, autoKind: kind,
    };
    saveKarteEntry(entry);
    try { if ($("karteList")) renderKarte(); } catch (e) {}
  } catch (e) {}
}
function saveDiagRecordObj(rec) {
  if (!rec) return;
  const list = getDiagHist(); const i = list.findIndex(r => r.id === rec.id);
  if (i >= 0) list[i] = rec; else list.unshift(rec);
  setDiagHist(list); renderDiagHistList();
}
/* 手動でタップ生成した手引書を、いま表示中のレコードにも保存 */
function stashGuideToRecord(cause, text) {
  if (!currentDiagRec) return;
  currentDiagRec.guides[cause] = text; saveDiagRecordObj(currentDiagRec);
}
/* 共有本文の整形: Markdown記号を除去し、■見出しは前に空行＋◆、番号候補の前にも空行を入れて
   LINE等に貼っても読みやすい間隔にする(詰まってごちゃごちゃにならないように)。 */
function shareCleanBody(s) {
  let t = String(s || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "");
  t = t.replace(/^[■【]\s*(.+?)】?\s*$/gm, "\n◆ $1");     // 見出し: 前に空行＋◆
  t = t.replace(/^\s*(\d+)[.)、]\s*/gm, "\n$1. ");        // 番号候補: 前に空行
  t = t.replace(/^\s*[・･]\s*/gm, "・");                   // 箇条書き記号を統一
  // 「理由:」はラベルの後で改行して本文を次行へ(読みやすく)。行頭の箇条書き記号も許容
  t = t.replace(/^[・･]?\s*(理由|根拠)\s*[:：]\s*(.+)$/gm, "理由:\n$2");
  // 「切り分け:」→「点検内容:」に改称し、ラベルの後で改行して本文を次行へ
  t = t.replace(/^[・･]?\s*(切り分け|確認|点検方法)\s*[:：]\s*(.+)$/gm, "点検内容:\n$2");
  return t.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").trim();
}
/* 共有用テキストを組み立て(見やすい間隔で) */
function diagShareText(rec) {
  const v = rec.veh || {}; const L = ["🔧 メカノAI 診断結果"];
  L.push("車両: " + (v.model || v.type || "不明"));
  if (rec.input) L.push("症状/コード: " + rec.input);
  L.push("──────────", shareCleanBody(rec.aiText));
  const gk = Object.keys(rec.guides || {});
  if (gk.length) { gk.forEach(c => { L.push("", "──────────", "🔧 点検手引書：" + c, shareCleanBody(rec.guides[c])); }); }
  L.push("", "──────────", "※参考情報です。最終判断は実測・実点検で。 — メカノAI");
  return L.join("\n");
}
async function shareDiagRecord(rec) {
  const text = diagShareText(rec);
  try { if (navigator.share) { await navigator.share({ title: "メカノAI 診断結果", text }); return; } }
  catch (e) { if (e && e.name === "AbortError") return; }
  const ok = await copyText(text);
  uiAlert(ok ? "診断結果をコピーしました。メール・LINE・チャット等に貼り付けて共有できます。" : "コピーできませんでした。", "共有");
}
/* 修理(点検手引書)の共有テキスト */
function repairShareText(rec) {
  const o = rec.repairObj || {}; const v = rec.veh || {};
  const L = ["🔧 メカノAI 点検手引書", "車両: " + (v.model || v.type || "不明")];
  if (rec.input) L.push("作業: " + rec.input);
  const sec = (title, lines) => { L.push("", "◆ " + title, ...lines); };   // 各セクションの前に空行
  if (o.location) sec("取り付け位置", [String(o.location)]);
  if (o.time) sec("所要時間の目安", [String(o.time)]);
  if (Array.isArray(o.order) && o.order.length) {
    sec("部品注文リスト", o.order.map(p => "・" + (p.name || "") + (p.qty ? " ×" + p.qty : "") + (p.kind && p.kind !== "本体" ? "（" + p.kind + "）" : "")));
  }
  if (Array.isArray(o.steps) && o.steps.length) {
    const stepLines = [];
    o.steps.forEach((s, i) => { if (i) stepLines.push(""); stepLines.push((i + 1) + ". " + (s.text || s)); });   // 手順ごとに空行を入れて読みやすく
    sec("手順", stepLines);
  }
  if (o.torque) sec("締付トルク", [String(o.torque)]);
  if (o.special && o.special !== "特になし") sec("注意", [String(o.special)]);
  // 構造化されていない通常回答(答えのみ)も共有できるように
  if (!o.location && !(Array.isArray(o.order) && o.order.length) && !(Array.isArray(o.steps) && o.steps.length) && o.answer) sec("回答", [String(o.answer)]);
  L.push("", "──────────", "※参考情報です。作業前にFAINES等で正式値を確認してください。 — メカノAI");
  return L.join("\n");
}
async function shareRepairRecord(rec) {
  const text = repairShareText(rec);
  try { if (navigator.share) { await navigator.share({ title: "メカノAI 点検手引書", text }); return; } }
  catch (e) { if (e && e.name === "AbortError") return; }
  const ok = await copyText(text);
  uiAlert(ok ? "点検手引書をコピーしました。メール・LINE・チャット等に貼り付けて共有できます。" : "コピーできませんでした。", "共有");
}
/* 表示中の保存結果を閉じる(その画面のみクリア。履歴は残る) */
function closeSavedResult(kind) {
  if (kind === "repair") { const b = $("qVehResult"); if (b) { b.innerHTML = ""; b.classList.add("hidden"); } }
  else { const b = $("diagResults"); if (b) b.innerHTML = ""; }
}
/* 保存結果カードのヘッダー右に「✕閉じる」「📤共有」を並べて置く */
function addSavedHeaderControls(sec, rec, kind) {
  const h2 = sec.querySelector("h2"); if (!h2) return;
  const close = document.createElement("button"); close.type = "button"; close.className = "histCloseBtn"; close.title = "閉じる"; close.textContent = "✕";
  close.style.marginLeft = "auto";
  close.addEventListener("click", () => closeSavedResult(kind));
  const share = document.createElement("button"); share.type = "button"; share.className = "histShareBtn"; share.textContent = "📤 共有";
  share.addEventListener("click", () => (kind === "repair" ? shareRepairRecord(rec) : shareDiagRecord(rec)));
  h2.append(close, share);
}
/* 修理(点検手引書)の結果も同じ履歴ストアに保存(kind:"repair")。再表示時にrenderRepairAnswerで復元。 */
function saveRepairRecord(q, obj) {
  const rec = { id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    ts: Date.now(), kind: "repair", veh: curVehLabel(), input: String(q || ""), repairObj: obj };
  const list = getDiagHist(); list.unshift(rec); setDiagHist(list);
  renderRepairHistList();
  try { autoKarteRecord("repair", q, summarizeRepairText(obj, q)); } catch (e) {}   // カルテへ自動記録(要約のみ)
  return rec;
}
/* 保存済み診断結果を「1つのブロック」で再表示(見解＋保存済み手引書を復元) */
function viewDiagRecord(rec) {
  if (rec.kind === "repair") { viewRepairRecord(rec); return; }
  currentDiagRec = rec;
  diagGuideCache = Object.assign({}, rec.guides || {});   // 保存済み手引書を即開けるように
  inspectPaneReg = [];
  lastDiagInput = rec.input || "";
  const box = $("diagResults"); box.innerHTML = "";
  const v = rec.veh || {};
  const { sec, body } = diagSection("", "メカ君", "保存した診断結果" + (v.model || v.type ? "（" + (v.model || v.type) + "）" : ""));
  addSavedHeaderControls(sec, rec, "diag");   // ヘッダー右に「✕閉じる」「📤共有」
  const meta = document.createElement("div"); meta.className = "histMeta";
  meta.textContent = "🕒 " + new Date(rec.ts).toLocaleString("ja-JP") + (rec.input ? " ／ " + rec.input : "");
  body.appendChild(meta);
  const p = document.createElement("div"); p.className = "ai-answer";
  renderAiAnswer(p, rec.aiText || "", { linkCauses: true });
  body.appendChild(p); box.appendChild(sec);
  // カード上辺(見出し)まで見えるようにスクロール(固定ナビに隠れないよう余白を確保)
  sec.style.scrollMarginTop = "70px";
  sec.scrollIntoView({ behavior: "smooth", block: "start" });
}
/* 保存済み修理(点検手引書)を修理タブで再表示 */
function viewRepairRecord(rec) {
  switchView("parts");
  const box = $("qVehResult"); toggle("qVehResult", true); box.innerHTML = "";
  const v = rec.veh || {};
  const metaRow = document.createElement("div"); metaRow.className = "histMetaRow";
  const meta = document.createElement("div"); meta.className = "histMeta";
  meta.textContent = "🕒 " + new Date(rec.ts).toLocaleString("ja-JP") + (v.model || v.type ? " ／ " + (v.model || v.type) : "") + (rec.input ? " ／ " + rec.input : "");
  const close = document.createElement("button"); close.type = "button"; close.className = "histCloseBtn"; close.title = "閉じる"; close.textContent = "✕";
  close.style.marginLeft = "auto";
  close.addEventListener("click", () => closeSavedResult("repair"));
  const sh = document.createElement("button"); sh.type = "button"; sh.className = "histShareBtn"; sh.textContent = "📤 共有";
  sh.addEventListener("click", () => shareRepairRecord(rec));
  metaRow.append(meta, close, sh); box.appendChild(metaRow);
  const ans = document.createElement("div"); box.appendChild(ans);
  if (rec.repairObj) renderRepairAnswer(ans, rec.repairObj, rec.input);
  else ans.textContent = "この履歴には表示できる内容がありません。";
  box.style.scrollMarginTop = "70px";
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}
/* 履歴パネル(診断/修理で共通)の描画。kindでフィルタし、行タップで再表示・×で削除。 */
function renderHistPanel(listId, panelId, kindFilter, openFn) {
  const list = $(listId); if (!list) return;
  const recs = getDiagHist().filter(kindFilter);
  const panel = $(panelId); if (panel) panel.classList.toggle("hidden", !recs.length);
  list.innerHTML = "";
  recs.forEach(rec => {
    const row = document.createElement("div"); row.className = "histRow";
    const main = document.createElement("button"); main.type = "button"; main.className = "histOpen";
    const v = rec.veh || {};
    const title = document.createElement("div"); title.className = "histTitle";
    title.textContent = (v.model || v.type || "車両不明") + (rec.input ? "：" + rec.input : "");
    const sub = document.createElement("div"); sub.className = "histSub";
    const ng = Object.keys(rec.guides || {}).length;
    sub.textContent = new Date(rec.ts).toLocaleString("ja-JP") + (ng ? " ・手引書" + ng + "件" : "");
    main.append(title, sub);
    main.addEventListener("click", () => openFn(rec));
    const del = document.createElement("button"); del.type = "button"; del.className = "histIco"; del.title = "削除"; del.textContent = "×";
    del.addEventListener("click", (e) => { e.stopPropagation(); setDiagHist(getDiagHist().filter(r => r.id !== rec.id)); renderDiagHistList(); renderRepairHistList(); });
    row.append(main, del); list.appendChild(row);
  });
}
function renderDiagHistList() { renderHistPanel("diagHistList", "diagHistPanel", r => r.kind !== "repair", viewDiagRecord); }
function renderRepairHistList() { renderHistPanel("repairHistList", "repairHistPanel", r => r.kind === "repair", viewRepairRecord); }

/* 各診断/修理の下に「追加で相談」欄(テキスト＋写真/動画添付、会話モードは除く)。回答後さらに追い相談を連鎖。
   opts.kind: "diag"(既定・故障診断) / "repair"(修理・作業手順) */
function appendAiFollowup(body, origText, prevAnswer, opts) {
  opts = opts || {};
  const kind = (opts.kind === "repair") ? "repair" : "diag";
  const wrap = document.createElement("div");
  wrap.style.marginTop = "12px"; wrap.style.paddingTop = "12px"; wrap.style.borderTop = "1px dashed var(--line)";
  const lab = document.createElement("div");
  lab.className = "hint"; lab.style.marginBottom = "6px";
  lab.textContent = (kind === "repair")
    ? "追加で質問したい場合 — 作業の続き・別の箇所・トルクや手順などを書く／写真・動画を添付して、メカ君にもう一度相談できます。"
    : "解決しない・追加で相談したい場合 — 実施内容や追加の症状を書く／写真・動画を添付して、メカ君にもう一度相談できます。";
  const ta = document.createElement("textarea");
  ta.placeholder = (kind === "repair")
    ? "例: 次にラジエーターを外す手順は？ タイミングチェーンのボルト締め付けトルクは？ — 写真や動画も添付できます。"
    : "例: EGRを清掃したが まだ白煙が出る。圧縮圧は正常。— 写真や動画も添付できます。";
  ta.style.minHeight = "64px";

  // 追加相談用の添付(音声入力/写真/写真撮影/動画/動画撮影)
  const atts = [];
  const icons = document.createElement("div"); icons.className = "fuIcons";
  // 音声入力ボタン
  const micBtn = document.createElement("button"); micBtn.type = "button"; micBtn.className = "diagIco txt"; micBtn.title = "音声で入力"; micBtn.textContent = "🎤";
  let fuRec = null, fuListening = false, fuAccum = "";
  micBtn.addEventListener("click", () => {
    if (fuListening) { fuListening = false; if (fuRec) { try { fuRec.stop(); } catch (e) {} } micBtn.textContent = "🎤"; micBtn.classList.remove("sel"); return; }
    if (!getSpeechRecognition()) { uiAlert("この端末/ブラウザは音声入力に対応していません(Chrome等をお試しください)。"); return; }
    const base = ta.value ? ta.value + " " : "";
    fuAccum = ""; fuListening = true; micBtn.textContent = "●"; micBtn.classList.add("sel");
    const startFu = () => {
      const rec = getSpeechRecognition(); if (!rec) { fuListening = false; return; }
      rec.continuous = true; rec.interimResults = true; fuRec = rec;
      let sf = "", fatal = false;
      rec.onresult = e => { let f = "", interim = ""; for (let i = 0; i < e.results.length; i++) { if (e.results[i].isFinal) f += e.results[i][0].transcript; else interim += e.results[i][0].transcript; } sf = f; ta.value = base + dedupRepeats(fuAccum + f + interim); };
      rec.onerror = e => { const err = e && e.error; if (err === "not-allowed" || err === "service-not-allowed" || err === "audio-capture") fatal = true; };
      rec.onend = () => {
        fuAccum += sf; sf = ""; fuRec = null; ta.value = base + dedupRepeats(fuAccum);
        // 無音で切れても停止を押すまで自動再開(喋るたびに押す不便を解消)
        if (fuListening && !fatal) { setTimeout(() => { if (fuListening) startFu(); }, 120); return; }
        fuListening = false; micBtn.textContent = "🎤"; micBtn.classList.remove("sel");
      };
      try { rec.start(); } catch (e) { fuListening = false; micBtn.textContent = "🎤"; micBtn.classList.remove("sel"); }
    };
    startFu();
  });
  icons.appendChild(micBtn);
  const preview = document.createElement("div"); preview.id = ""; preview.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px";
  function renderPv() {
    preview.innerHTML = "";
    atts.forEach((a, i) => {
      const d = document.createElement("div"); d.className = "attachThumb";
      const m = document.createElement(a.kind === "video" ? "video" : "img"); m.src = a.url; if (a.kind === "video") { m.muted = true; m.playsInline = true; }
      const del = document.createElement("button"); del.className = "axDel"; del.textContent = "×";
      del.addEventListener("click", () => { URL.revokeObjectURL(a.url); atts.splice(i, 1); renderPv(); });
      d.append(m, del); preview.appendChild(d);
    });
  }
  const defs = [
    ["img/ic-photo.png", "写真を添付", "image/*", false],
    ["img/ic-photo-cam.png", "写真を撮って添付", "image/*", true],
    ["img/ic-video.png", "動画を添付", "video/*", false],
    ["img/ic-video-cam.png", "動画を撮って添付", "video/*", true],
  ];
  defs.forEach(([src, title, accept, cap]) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "diagIco"; b.title = title;
    const im = document.createElement("img"); im.src = src; b.appendChild(im);
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = accept; if (cap) inp.capture = "environment"; inp.className = "hidden";
    b.addEventListener("click", () => inp.click());
    inp.addEventListener("change", async e => {
      let f = e.target.files[0]; inp.value = ""; if (!f) return;
      const isV = (f.type || "").startsWith("video");
      if (isV && f.size > ATTACH_MAX) { try { f = await compressVideo(f, ATTACH_MAX); } catch (er) {} if (f.size > ATTACH_MAX) { uiAlert("動画が大きすぎます。短く撮り直してください。"); return; } }
      atts.push({ file: f, kind: isV ? "video" : "image", url: URL.createObjectURL(f) }); renderPv();
    });
    icons.appendChild(b); wrap.appendChild(inp);
  });

  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "btn btn-ghost btn-sm"; btn.style.marginTop = "8px";
  btn.innerHTML = '<img src="img/kangae.png" class="btnMecha" alt="">メカ君に追加で相談';
  const ans = document.createElement("div"); ans.className = "ai-answer hidden"; ans.style.marginTop = "10px";
  btn.addEventListener("click", async () => {
    // マイクがオンのまま押されたら自動でオフにする(録りっぱなし防止)
    if (fuListening) { fuListening = false; if (fuRec) { try { fuRec.stop(); } catch (e) {} } micBtn.textContent = "🎤"; micBtn.classList.remove("sel"); }
    stopFieldMic();
    const tried = ta.value.trim();
    if (!tried && !atts.length) { ta.focus(); return; }
    if (diagAiBusy) return;
    diagAiBusy = true; setBtnLoading(btn, true, "メカ君が考え中…");
    ans.classList.remove("hidden"); ans.textContent = "";
    // 追加相談も経過秒を表示(初回と同じ体感)。ストリーム開始 or 応答到着で停止。
    const stopFbTimer = startThinkingTimer(ans, "🔧 メカ君が追加で考え中");
    let streamedFb = false;
    // 精度優先。NAでも思考量を確保(2048)、有料は4096。
    const paidOn = !!(window.Cloud && typeof window.Cloud.aiPaidOn === "function" && window.Cloud.aiPaidOn());
    const fbBudget = paidOn ? 4096 : 2048;
    // 会話が続いても対象車両を見失わないよう、毎回プロンプトへ車両情報を固定で入れる。
    const vDesc = (function () { try { return vehicleDesc(); } catch (e) { return "不明"; } })();
    try {
      let r;
      if (kind === "repair") {
        // 修理の追加質問: 前回の回答＋今回の質問を文脈にして、修理フォーマット(JSON)で続きを回答。
        const q = "【対象車両: " + vDesc + "】この車両に限定して回答すること。\n【この車両の作業についての追加質問です】\n前回の回答(要約): " + String(prevAnswer).slice(0, 1200) +
          "\n当初の質問: " + origText +
          "\n今回の追加質問・状況: " + (tried || "(テキストなし。添付の写真・動画を参照)");
        if (atts.length) {
          const media = [];
          for (const a of atts) media.push(await attachToMedia(a));
          r = await geminiAskMediaStream(buildRepairPrompt(q, true), media, { thinkingBudget: fbBudget }, null);
        } else {
          r = await geminiAsk(buildRepairPrompt(q), paidOn ? { mode: "pro", search: true, maxTokens: 8192, thinkingBudget: 3072 } : { mode: "flash", search: false });
        }
        stopFbTimer(); ans.classList.remove("streaming");
        const obj = cleanCiteDeep(extractJson(r.text));
        if (obj && obj.isWork && (obj.location || (Array.isArray(obj.order) && obj.order.length) || (Array.isArray(obj.steps) && obj.steps.length))) { renderRepairAnswer(ans, obj, tried || origText); }
        else if (obj && obj.answer) renderAiAnswer(ans, obj.answer);
        else renderAiAnswer(ans, r.text);
      } else {
        const prompt = [
          "あなたは日本の自動車整備士を支援するベテラン診断アドバイザー『メカ君』です。同じ不具合の“続きの相談”です。前回の診断結果と、整備士が追加で入力したコメント・写真・動画を必ず統合し、精度の高い2回目の原因候補を出してください。",
          "【対象車両（厳守）】" + vDesc + " ―― 診断はこの車両に限定すること。DTC(故障コード)の意味・原因は必ずこの車両のメーカー/車種の定義で解釈し、別メーカー・別車種のコード定義と照らし合わせない。車両が特定できない項目は推測に『（要確認）』を付ける。",
          "【最重要・臨機応変】前回の原因候補を全て点検・排除したとは限りません。整備士は点検の途中で気づいたこと・実施した内容・新たな症状を追記しています。追加情報から『すでに確認できた／正常だった』ことは候補から外し、まだ疑わしいもの・新たに浮上した原因を、追加情報＋前回の手がかりを合わせて可能性の高い順に組み直すこと。前回の1位に固執せず、追加情報を最優先で反映する。写真・動画があれば必ず観察して統合する。断定できないことには『（要確認）』を付ける。",
          "前置き・免責・挨拶は一切不要。Markdown記号(**、#、表)は使わず、必ず次の出力形式に従うこと:",
          "",
          "■原因候補（可能性が高い順）",
          "1. 原因名（一言で）",
          "理由: なぜこの症状・情報からこの原因を疑うのか、根拠を1文で簡潔に。可能なら追加情報のどの記述・映像と整合するかに触れる。",
          "切り分け: 確認方法。使用工具と測定値の目安を含める。1〜2文で簡潔に。",
          "2.（同様に最大5つまで。各候補に必ず『理由:』と『切り分け:』を付ける）",
          "",
          "■最初の1手",
          "現場で最初にやるべきことを1〜2文で。",
          "",
          "■当初の相談内容: " + origText,
          "■前回の原因候補(診断結果): " + String(prevAnswer).slice(0, 1600),
          "■今回の追加情報(点検途中で気づいたこと・実施内容・結果・追加症状): " + (tried || "(テキストなし。添付の写真・動画を参照)"),
        ].join("\n");
        if (atts.length) {
          const media = [];
          for (const a of atts) media.push({ mimeType: cleanMime(a.file.type, a.kind === "video" ? "video/mp4" : "image/jpeg"), data: await fileToBase64(a.file) });
          r = await geminiAskMediaStream(prompt, media, { thinkingBudget: fbBudget }, (acc, done) => {
            if (done) return;
            if (!streamedFb) { streamedFb = true; stopFbTimer(); ans.classList.add("streaming"); }
            ans.textContent = acc;
          });
        } else {
          r = await geminiAsk(prompt, { mode: "pro", thinkingBudget: fbBudget });
        }
        stopFbTimer(); ans.classList.remove("streaming");
        if (r && r.truncated) { ans.textContent = (r.text || "") + "\n…続きを取得中…"; r = await continueIfTruncated(prompt, r, { mode: "flash" }, acc => { ans.textContent = acc; }); }
        lastDiagInput = origText + (tried ? " / " + tried : "");   // 手引書生成に文脈を反映
        renderAiAnswer(ans, r.text, { linkCauses: true });
      }
      // この相談欄は使い終わったので入力部を畳み、質問内容だけ残す(入力枠が重複して並ぶのを防ぐ)
      [lab, ta, icons, preview, btn].forEach(el => { try { el.remove(); } catch (e) {} });
      const asked = document.createElement("div"); asked.className = "hint"; asked.style.marginBottom = "6px";
      asked.textContent = (kind === "repair" ? "🔧 追加質問: " : "🔧 追加相談: ") + (tried || "(添付のみ)");
      wrap.insertBefore(asked, ans);
      // さらに追い相談できるよう、回答の下に次の相談欄を1つだけ連鎖(種別を維持)
      appendAiFollowup(body, origText + " / " + tried, (kind === "repair" ? (r.text || "") : r.text), { kind });
    } catch (e) {
      try { stopFbTimer(); } catch (_) {}
      if (e.message !== "__cancelled__") ans.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
    } finally {
      diagAiBusy = false; setBtnLoading(btn, false);
    }
  });
  wrap.append(lab, ta, icons, preview, btn, ans);
  body.appendChild(wrap);
}

/* 対象車両の説明文(型式が無くても指定・類別/原動機/車台番号で識別) */
/* 現在の車両について分かっている事実(車種名・諸元・持病)をまとめて返す。
   車種名は 正データ(手動編集DB) > DB一致 > 履歴/学習 の優先で確定 */
function currentVehicleFacts() {
  const d = current || {};
  const code = d.type && d.type.includes("-") ? d.type.split("-")[1] : d.type;
  const v = code ? findVehicle(code) : null;
  const byVin = d.vin ? CUSTOM_DB.find(x => x.vin && x.vin === d.vin) : null;
  const he = findHistEntry(getHistory(), d) || {};
  const learned = getLearned(vehicleKey(d)) || {};
  // 手動編集済みの正データを最優先
  const hit = (byVin && byVin.manual && byVin) || (v && v.manual && v) || byVin || v || null;
  const model = (hit && hit.name) || he.model || learned.model || null;
  const faults = (hit && hit.faults && hit.faults.length ? hit.faults : null) || he.faults || learned.faults || [];
  const specs = (he.specs && he.specs.length ? he.specs : learned.specs) || (hit && hit.specs) || [];
  return { d, model, faults, specs };
}
function vehicleDesc() {
  const parts = [];
  const f = currentVehicleFacts();
  if (f.model) parts.push("車種 " + f.model);
  if (current.type) parts.push("型式 " + current.type);
  if (current.kataShitei) parts.push("型式指定番号・類別区分番号 " + current.kataShitei);
  if (current.engine) parts.push("原動機型式 " + current.engine);
  if (current.vin) parts.push("車台番号 " + current.vin);
  if (current.firstReg && current.firstReg.year) parts.push("初度登録 " + current.firstReg.year + "年" + (current.firstReg.month || "") + "月");
  return parts.length ? parts.join(" / ") : "不明";
}
/* 必須諸元7項目。学習キャッシュに揃っていれば再取得(＝課金)しない判定に使う */
const SPEC_REQUIRED = [
  { name: "エンジンオイル量", test: k => /エンジンオイル/.test(k) },
  { name: "ミッションオイル量", test: k => /(ミッション|トランスミッション|ATF|CVT|MTF|ギヤオイル|ギアオイル)/.test(k) },
  { name: "デフオイル量", test: k => /(デフ|デファレンシャル)/.test(k) },
  { name: "ホイールナット締付トルク", test: k => /ホイールナット/.test(k) },
  { name: "リアアクスルシャフト（フランジ）締付トルク", test: k => /(アクスル|ドライブシャフト|フランジ)/.test(k) },
  { name: "フロントハブベアリングナット締付トルク", test: k => /(フロント|前)/.test(k) && /ハブ/.test(k) },
  { name: "リアハブベアリングナット締付トルク", test: k => /(リア|後)/.test(k) && /ハブ/.test(k) },
  { name: "車台番号の打刻位置", test: k => /車台番号/.test(k) && /打刻|位置/.test(k) },
  { name: "エンジン型式の打刻位置", test: k => /(エンジン型式|原動機)/.test(k) && /打刻|位置/.test(k) },
];
/* 既知の諸元(specs)に照らして、まだ揃っていない必須項目名の配列を返す */
function missingRequiredSpecs(specs) {
  const keys = (specs || []).map(s => String(s.k || ""));
  return SPEC_REQUIRED.filter(r => !keys.some(k => r.test(k))).map(r => r.name);
}
/* 社内共有DB(mergedDB=内蔵+同期カスタム)から、この車両の型式に一致するレコードを返す。
   別メンバー/別端末が既に取得・保存した諸元をここから再利用し、無駄な再検索(課金)を防ぐ。 */
function companyRecordFor(d) {
  d = d || current; if (!d) return null;
  let hit = null;
  if (d.type) { const code = (d.type.includes("-") ? d.type.split("-")[1] : d.type).toUpperCase(); hit = findVehicle(code); }
  if (d.vin) { const byVin = CUSTOM_DB.find(x => x.vin && x.vin === d.vin); if (byVin) hit = byVin; }
  return hit;
}
/* specsリストを統合(キー名重複は先勝ち=aを優先) */
/* 諸元キーを正規化して同義項目をまとめる(重複統合用)。括弧注釈・空白・全半角差を無視し、主要な同義語を1つに。 */
function canonSpecKey(k) {
  let s = String(k == null ? "" : k).normalize("NFKC").toLowerCase();
  s = s.replace(/[（(][^（()）]*[)）]/g, "");        // 括弧内の注釈を除去(クーラント（冷却水）量→クーラント量)
  s = s.replace(/[\s　・･:：]/g, "");
  if (/(クーラント|冷却水|llc|ll)/.test(s) && /(量|容量)/.test(s)) return "クーラント量";
  if (/エンジン(オイル|油)量/.test(s)) return "エンジンオイル量";
  if (/オイル粘度/.test(s)) return "推奨オイル粘度";
  if (/ホイール(ナット)?(締付|締め付け|トルク)/.test(s)) return "ホイールナット締付トルク";
  // ハブベアリングナット(前後で別項目) と アクスルシャフト(フランジ)締付は別物として区別する
  const side = /(フロント|前)/.test(s) ? "フロント" : /(リア|後)/.test(s) ? "リア" : "";
  if (/ハブ(ベアリング)?ナット|ハブベアリング/.test(s) && /(締付|締め付け|トルク|ナット)/.test(s)) return (side || "") + "ハブベアリングナット締付トルク";
  if (/(リアアクスル|アクスルシャフト|ドライブシャフト|フランジ)/.test(s) && /(締付|締め付け|トルク|フランジ|ナット|ボルト)/.test(s)) return "リアアクスルシャフト（フランジ）締付トルク";
  return s;
}
/* 表示用の項目名を正式名称へ正規化。AI出力の表記ゆれ・文字化け(例 クーラant量→クーラント量)を吸収。
   canonSpecKeyより緩めにマッチさせ、未知の項目は元の表記のまま返す。 */
function canonDisplayKey(k) {
  const orig = String(k == null ? "" : k);
  const s = orig.normalize("NFKC").replace(/[（(][^（()）]*[)）]/g, "").replace(/[\s　・･:：]/g, "").toLowerCase();
  const has = re => re.test(s);
  const amt = /(量|容量)/.test(s);
  const trq = /(締付|締め付け|トルク|ナット|ボルト)/.test(s);
  // 冷却水: 「クーラ」始まり(ント/ant等の文字化けも許容)＋量、または冷却水/LLC/不凍液
  if (amt && (/^クーラ/.test(orig) || has(/(冷却水|llc|ロングライフ|不凍液)/))) return "クーラント量";
  if (amt && has(/エンジン/) && has(/(オイル|オイ|油)/)) return "エンジンオイル量";
  if (has(/(オイル|オイ)/) && has(/粘度/)) return "推奨オイル粘度";
  if (has(/ホイール/) && trq) return "ホイールナット締付トルク";
  const side = /(フロント|前)/.test(s) ? "フロント" : /(リア|後)/.test(s) ? "リア" : "";
  if (has(/ハブ/) && trq) return side + "ハブベアリングナット締付トルク";
  if (has(/(アクスル|ドライブシャフト|フランジ)/) && trq) return "リアアクスルシャフト（フランジ）締付トルク";
  return orig;
}
/* 同義キーで重複を除去(先頭を優先。手動確定値があればそれを優先的に残す)。 */
function dedupSpecs(list) {
  const map = new Map();
  (list || []).forEach(s => {
    if (!s || !s.k) return;
    const c = canonSpecKey(s.k);
    const cur = map.get(c);
    if (!cur) { map.set(c, s); return; }
    if (s.manual && !cur.manual) map.set(c, s);   // 手動確定を優先して残す
  });
  return [...map.values()];
}
function mergeSpecLists(a, b) {
  return dedupSpecs([...(a || []), ...(b || [])]);   // a(既存/優先)→b の順で同義キー重複を統合
}
/* メンテナンス諸元＋定番故障/持病をAIから一括取得(JSON)。
   known: 既に判明している値(再検索させない)。missOnly: 今回補完したい不足項目名。 */
function buildSpecPrompt(known, missOnly) {
  const partial = Array.isArray(missOnly) && missOnly.length && Array.isArray(known) && known.length;
  const head = [
    "あなたは日本の自動車整備士向けのデータアドバイザーです。",
    "次の車両について、(A)整備に必要なメンテナンス諸元、(B)この車種の定番故障・持病、(C)過去に届出された主なリコール・改善対策・サービスキャンペーンの有無 を答えてください。",
    "型式が不明な場合は、型式指定番号・類別区分番号や車台番号・原動機型式から車種を推定して構いません。",
    "【必ず調べてから答える】記憶や勘で数値を出さない。付与されたGoogle検索ツールを使い、メーカー公式諸元・整備解説・信頼できる情報源で、この車種・型式・原動機・年式に固有の実際の値を確認してから答えること。オイル量・冷却水量・各種容量・締付トルクは車種差が大きいので必ず裏取りする。",
    "【値は具体的に出す・安易な要確認は禁止】検索して得られた実値を、できる限り具体的な数値で書くこと。少し調べれば分かる値を『（要確認）』で済ませない。値が交換条件で変わるなら『値＋条件』(例: エンジンオイル量『9.0L（オイルのみ）／10.0L（エレメント同時交換）』)。締付トルクは『規定値±公差』(例: ホイールナット『600±50 N·m』)。範囲だけ(550〜650)や創作値は不可。",
    "【要確認は最終手段】十分に検索しても確かな一次情報が得られなかった値に限り『（要確認）』とする(逃げの要確認は不可)。ただし誤った数値を書くのは最悪なので、本当に不明なら創作せず要確認にする。",
    "【リコールも必ず検索して調べる】記憶や心当たりで書かない。Google検索で『国土交通省 リコール届出情報』やメーカー公式のリコール・改善対策・サービスキャンペーン情報を、この型式・車種・年式で実際に調べること。見つかった届出は『年月・対象部位・不具合内容・対策』が分かる形で1件1文にまとめる(最大5件、新しい順)。検索しても該当が確認できなければrecallsは空配列にし、憶測で埋めない。",
    "【定番故障も検索して裏取り】faultsも記憶頼みにせず、この車種・型式の整備事例・故障事例・不具合報告を検索し、実際に多発が確認できた症状のみを書く。症状だけでなく『原因部位』と『出やすい時期(走行距離・年式)』が分かれば併記する。創作・一般論(どの車にも言える話)は不可。確認できなければ空配列でよい。",
    "【重複禁止】faultsは1つの症状につき1件だけ。同じ内容を言い換えただけ・表現違いの重複は絶対に入れない(例『オイル漏れ』と『オイルにじみ』を別々に出さず1件に統合)。",
    "あわせて、推定できる車種名(メーカー名+車種名、例『日野 プロフィア』)と、メーカーを次のローマ字キーのいずれかで答えること: isuzu,hino,fuso,ud,nissan,toyota,honda,mazda,suzuki,daihatsu,subaru,other。判別できなければmodelは空文字、makerは\"other\"。",
    "【表記ルール】各値は日本語＋数値のみで簡潔に。引用・出典マーカー([cite:...]、[17]、(from previous search)等)や英語の注釈は絶対に本文へ入れない。検索は内部で行い、結果の数値だけを書く。",
    "出力は厳密なJSONのみ(前後に文章やコードフェンス不要)。形式:",
    '{"model":"日野 プロフィア","maker":"hino","specs":[{"k":"エンジンオイル量","v":"12.0L（オイルのみ）／13.0L（エレメント同時交換）"},{"k":"推奨オイル粘度","v":"…"},{"k":"クーラント量","v":"…"},{"k":"ホイールナット締付トルク","v":"600±50 N·m"},{"k":"リアアクスルシャフト（フランジ）締付トルク","v":"…±… N·m"},{"k":"フロントハブベアリングナット締付トルク","v":"…±… N·m"},{"k":"リアハブベアリングナット締付トルク","v":"…±… N·m"},{"k":"ATF/CVT/ミッションオイル","v":"…"},{"k":"デフオイル（デファレンシャルオイル）","v":"…(粘度・油量・該当する場合は前後/LSD有無も)"},{"k":"車台番号の打刻位置","v":"…(例: 助手席足元のフロア、右フロントシート下など)"},{"k":"エンジン型式の打刻位置","v":"…(例: シリンダーブロック前面など)"}],"faults":["定番故障・持病を1件1文で複数"],"recalls":["主なリコール/改善対策を1件1文(年式・対象部位が分かれば併記)"]}',
    "【OBD検査の対象判定】この車両がOBD検査(OBD確認検査)の対象車かを、型式・初度登録年月・燃料種別・車種区分から判定する。対象と判断できる場合のみ、specsに {\"k\":\"OBD検査\",\"v\":\"対象車（◯年◯月〜適用）\"} を含める。対象でない・判定できない場合はこの項目を一切出さない(記載しない)。判定の要点: 令和3年(2021年)10月1日以降に型式指定を受けた新型車が対象。継続生産車はガソリン等が令和4年(2022年)10月〜・ディーゼルが令和5年(2023年)10月〜、輸入車はさらに後(令和6年10月〜)。二輪・大型特殊・被牽引車・一部の特種用途車は対象外。初度登録年月が令和3年10月より前の車両は基本的に対象外。確証が持てない場合は対象にしない(項目を出さない)。",
    "【必須項目】次の項目は、その車両に存在する限り必ず調べて具体値で含めること: ①エンジンオイル量 ②ミッションオイル量(MT/AT/CVTのいずれか該当するもの) ③デフオイル量 ④ホイールナット締付トルク ⑤リアアクスルシャフト（フランジ）締付トルク＝アクスルシャフトを固定するフランジ(ドライブフランジ)のボルト/ナットの締付値 ⑥フロントハブベアリングナット締付トルク ⑦リアハブベアリングナット締付トルク ⑧車台番号の打刻位置 ⑨エンジン型式の打刻位置。これらは検索して実値を探し出すこと。『（要確認）』で逃げない。",
    "【締付トルクは部位を厳密に区別する】『アクスルシャフト（フランジ）締付』と『ハブベアリングナット締付』は別の部位・別の規定値である。混同して1つにまとめない。ハブベアリングナット(ハブナット)は前輪(フロント)と後輪(リア)で値が異なる場合が多いので、必ず『フロントハブベアリングナット締付トルク』と『リアハブベアリングナット締付トルク』を別々の行で出すこと。存在しない/駆動方式上該当しない場合のみ省略可。",
    "【必須項目は必ず1行ずつ出す】上記①〜⑨は、その車両に存在する限り必ずspecsに個別の行として含めること。特に②ミッションオイル量・③デフオイル量・⑤アクスルフランジ・⑥⑦前後ハブベアリングナットの出し忘れが多い。トラック等の大型車ではこれらは通常存在するので省略しないこと。",
    "ただし、その車両に構造上存在しない項目(例: FF車のデフオイル、リジッドアクスル/FF車のアクスルフランジ・ハブナット、CVT車のミッションオイル量など)は、その行自体をspecsに含めない(省略する)。『該当なし』『非該当』『装備なし』等の行は出力しないこと。存在するのに値が見つからない場合のみ最終手段として（要確認）とする。",
    "【表記は正しい日本語で】項目名・値のカタカナや漢字を崩さない(例『クーラント』を『クーラant』のようにローマ字混じりにしない)。正式な日本語表記で書く。",
    "『オイルエレメント』『オイル交換目安』の項目は出力しないこと。整備で重要かつ確証のある項目は上記以外も追加してよい。",
    "【諸元の重複禁止】同じ項目を表記違いで二重に出さない。例:『クーラント量』と『クーラント（冷却水）量』/『リアアクスルシャフト締付トルク』と『リアアクスルシャフト（フランジ）締付トルク』は同一項目なので必ず1行に統合する。1つの部位・値につきspecsは1行だけにする。ただし『アクスルシャフト（フランジ）締付』『フロントハブベアリングナット締付』『リアハブベアリングナット締付』は別部位なので統合せず、それぞれ別行で出す。",
    "【ホイールナット締付トルクの基準】メーカー整備書の指定を最優先しつつ、判明しない場合は次の一般基準を目安にする(数値は目安・車両区分に合わせる):",
    "・普通乗用車: おおむね 103〜120 N·m(例 トヨタ約103、ホンダ/日産/マツダ/スバル約108、三菱約108)。ハブボルトは M12×1.25 または M12×1.5 が主流。",
    "・軽自動車: おおむね 85〜100 N·m。",
    "・大型トラック/バス(全日本トラック協会の締付トルク基準): ISO方式(M22×1.5・球面座・片側10穴等)は約 570〜630 N·m(概ね600±)。JIS方式(複輪の内外ナット)は方式・サイズにより約 400〜590 N·m。車両が採用する方式(ISO/JIS)とナットサイズに合わせて示す。",
    "・リアアクスルシャフト（フランジ）締付トルク＝アクスルシャフトを固定するフランジ(ドライブフランジ)のボルト/ナット。ハブベアリングナット(ハブナット)＝ホイールハブのベアリングを予圧調整・固定するナットで、両者は別部位・別規定値。ハブベアリングナットは前後で値が異なることが多いのでフロント・リアを分けて示す。いずれもメーカー整備書の規定値に従い、判明しない場合は（要確認）とする。",
    "【オイル粘度・油量の基準】メーカー純正指定を最優先。新しい省燃費指定(例 0W-16/0W-20)がある車はそれを優先し、旧型は 5W-30/10W-30 等。ディーゼル大型はメーカー指定のディーゼル用粘度と規格(例 10W-30/15W-40、DL-1/DH-2 等)を示す。油量は『オイルのみ／エレメント同時交換』を併記する。",
    ""
  ];
  // 部分補完モード: 既知の値は再検索させず、不足項目だけを検索して埋めさせる(検索コスト削減)
  if (partial) {
    head.push(
      "【重要・コスト削減】次の値は既に判明済みです。これらは再検索せず、specsにそのまま含めて返すこと(値を変えない):",
      known.map(s => "・" + s.k + " = " + s.v).join("\n"),
      "今回あなたが検索して新たに埋めるのは、次の『不足項目』だけです(既知項目は検索禁止): " + missOnly.join("、"),
      "出力のspecsには『既知の値＋今回埋めた不足項目』の両方を含めること。faults・recallsも既に分かっていれば無理に再検索しなくてよい。"
    );
  }
  head.push("■対象車両: " + vehicleDesc());
  { const os = officialSpecsText(); if (os) head.push(os); }
  return head.join("\n");
}
async function runSpecAI(srcBtn) {
  stopFieldMic();
  if (!aiOK()) {
    uiAlert("AIで調べるには無料のGemini APIキーの設定が必要です。\n\n設定タブ →「AI相談機能」の手順でキーを取得・保存してください(クレジットカード不要)。");
    switchView("settings");
    return;
  }
  // 「最新に更新」で既存の(訂正含む)データを上書きする前に確認
  if (srcBtn && srcBtn.id === "btnSpecReload" && shownSpecs && shownSpecs.length) {
    if (!confirm("最新のAI結果で諸元を取り直します。手動で訂正した項目はそのまま保持します。よろしいですか？")) return;
  }
  const box = $("specAiBox");
  const btn = srcBtn || $("btnSpecAI");
  const force = srcBtn && srcBtn.id === "btnSpecReload";   // 「最新に更新」はキャッシュを使わず再取得

  // ★コスト削減: 同じ型式の既存データ(この端末の学習＋社内共有DB)が揃っていれば、APIを一切叩かず表示。
  //   別メンバーが取得済みの型式は再検索しない=検索グラウンディング(高額)を会社全体で1回に集約。
  //   取り直したい時は「最新に更新」ボタン(force)を使う。
  const lk = vehicleKey(current);
  const cached = getLearned(lk) || {};
  const cachedSpecs = Array.isArray(cached.specs) ? cached.specs : [];
  const hit = companyRecordFor(current);                                   // 社内共有DBの同型式レコード
  const hitSpecs = (hit && Array.isArray(hit.specs)) ? hit.specs : [];
  const known = mergeSpecLists(cachedSpecs, hitSpecs);                     // 端末学習＋社内共有を統合
  const missReq = missingRequiredSpecs(known);
  // 取得済みフラグ: 一度きちんと取得した型式は、必須が一部埋まらなくても再検索しない(課金の歯止め)。
  const attemptedBefore = !!(cached.specDone || (hit && hit.specDone));
  if (!force && known.length && (!missReq.length || attemptedBefore)) {
    const specs = mergeKeepManual(withHksOil(known.slice()), shownSpecs);
    const cf = dedupFaults([...(Array.isArray(cached.faults) ? cached.faults : []), ...((hit && hit.faults) || [])]);
    const rc = (Array.isArray(cached.recalls) && cached.recalls.length) ? cached.recalls : ((hit && hit.recalls) || []);
    toggle("specAiBox", false);
    renderSpecs(specs, "learned");
    if (cf.length) { renderFaultList(cf); toggle("secFault", true); }
    renderRecalls(rc);
    setLearned(lk, { specs, faults: cf, recalls: rc });                   // この端末にも記憶し次回さらに高速化
    showToast("この型式の記憶データを表示しました（AI未使用）");
    return;
  }

  toggle("specAiBox", true);
  box.textContent = "🔧 メカ君が諸元・定番故障を調べています…(数秒〜十数秒)";
  setBtnLoading(btn, true, "メカ君が調べ中…");
  try {
    // ★方針: 精度は運営管理のトグルで切替。
    //   無料のみ(OFF)=初回も更新もFlash(検索なし・無料)。有料ON=Pro＋検索(正確)。
    const partial = !force && known.length > 0;                      // 一部だけ判明済み → 不足のみ補完
    const prompt = partial ? buildSpecPrompt(known, missReq) : buildSpecPrompt();
    // 諸元は「事実の取得」。検索グラウンディングは遅く(30〜54秒)・無料枠では429・有料でも重いので使わない。
    //   gemini-flash-latest(最新Flash)単体で事実諸元は十分＆4〜11秒で確実に返る(実測)。速度と安定を優先。
    const r = await geminiAsk(prompt, {
      noCache: force,
      mode: "flash",                     // 事実取得は常にFlash(低コスト・高速)
      search: false,                     // ★検索は使わない(遅延・429の原因)。最新Flashの知識で取得
      maxTokens: 12288                   // 諸元JSONが途中で切れない余裕を確保
    });
    const obj = extractJson(r.text);
    let specs = [], faults = [], recalls = [], model = "", maker = "";
    if (obj) {
      specs = Array.isArray(obj.specs) ? obj.specs.filter(s => s && s.k).map(s => ({ k: cleanCite(String(s.k)), v: cleanCite(String(s.v || "")) })).filter(s => s.k && s.v) : [];
      faults = dedupFaults(Array.isArray(obj.faults) ? obj.faults.map(x => cleanCite(String(x))).filter(Boolean) : []);   // 言い換え重複を除去して保存
      recalls = Array.isArray(obj.recalls) ? obj.recalls.map(x => cleanCite(String(x))).filter(Boolean) : [];
      model = obj.model ? String(obj.model).trim() : "";
      maker = obj.maker ? String(obj.maker).trim().toLowerCase() : "";
    }
    // JSONで取れない時はテキストを諸元へフォールバック分解
    if (!specs.length) { lastSpecAiText = r.text; specs = aiTextToSpecs(r.text); }
    if (!specs.length && !faults.length && !recalls.length) { renderAiAnswer(box, r.text); return; }
    // 既知(端末学習＋社内DB)とも統合 → HKS適合表の油量/粘度を上書き → 手動修正を尊重
    specs = mergeSpecLists(specs, known);
    specs = withHksOil(specs);
    if (specs.length) specs = mergeKeepManual(specs, shownSpecs);
    // ※以前ここで「不足項目の追い取得(Pro+検索を追加でもう1回)」をしていたが、無料枠の1日消費を倍増させ枠切れを
    //   早めていたため廃止。諸元取得は1回のみに戻す(不足項目は各項目右上の🔄で個別に補完できる)。
    // 部分補完で今回faults/recallsを再取得しなかった場合は、既存の記憶を消さず引き継ぐ
    if (partial && !faults.length) faults = dedupFaults([...(cached.faults || []), ...((hit && hit.faults) || [])]);
    if (partial && !recalls.length) recalls = (cached.recalls && cached.recalls.length) ? cached.recalls : ((hit && hit.recalls) || []);
    if (partial && !model) model = cached.model || (hit && hit.name) || "";
    if (partial && !maker) maker = cached.maker || (hit && hit.maker) || "";
    // DB(車両レコード)＋学習キーへ自動保存 → 次回はAI不要。specDone=一度取得済み(以後は再検索しない歯止め)
    setLearned(vehicleKey(current), { specs, faults, recalls, model, maker, specDone: true });
    saveVehicleAiData(specs, faults, recalls, { model, maker });
    registerVehicleToDB({ silent: true });   // 諸元・故障・車種名・メーカーをDB登録車種へ自動反映
    // 表示: 諸元は表で、定番故障/持病はFAULTセクション、リコールはRECALLセクションへ
    toggle("specAiBox", false);
    if (specs.length) renderSpecs(specs, "learned");
    if (faults.length) { renderFaultList(faults); toggle("secFault", true); }
    renderRecalls(recalls);
  } catch (e) {
    if (e.message === "__cancelled__") { return; }
    // 更新に失敗しても、この端末/社内に既存データがあれば消さずに表示して現場を止めない。
    if (known.length) {
      const specs = mergeKeepManual(known.slice(), shownSpecs);
      toggle("specAiBox", false);
      renderSpecs(specs, "learned");
      const cf = dedupFaults([...(Array.isArray(cached.faults) ? cached.faults : []), ...((hit && hit.faults) || [])]);
      const rc = (Array.isArray(cached.recalls) && cached.recalls.length) ? cached.recalls : ((hit && hit.recalls) || []);
      if (cf.length) { renderFaultList(cf); toggle("secFault", true); }
      renderRecalls(rc);
      showToast("更新できませんでした。既存の記憶データを表示しています。");
    } else {
      box.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
    }
  } finally {
    setBtnLoading(btn, false);
  }
}
$("btnSpecAI").addEventListener("click", () => runSpecAI($("btnSpecAI")));
$("btnSpecReload").addEventListener("click", () => runSpecAI($("btnSpecReload")));  // 最新に更新(都度DB更新)

/* 項目ごとに最新値だけ取り直す(右上の🔄) */
async function refreshSpecItem(key, btn) {
  stopFieldMic();
  if (!aiOK()) {
    uiAlert("AIで調べるには無料のGemini APIキーの設定が必要です。\n\n設定タブ →「AI相談機能」の手順でキーを取得・保存してください(クレジットカード不要)。");
    switchView("settings"); return;
  }
  if (btn) { btn.classList.add("loading"); btn.disabled = true; }
  try {
    const prompt = [
      "あなたは日本の自動車整備士向けのデータアドバイザーです。",
      "次の車両の整備諸元のうち、指定された1項目だけを答えてください。",
      "【要確認の書き方】確信が持てない場合のみ『（要確認）』とだけ書く。長い但し書きは不要。",
      "【曖昧禁止】『オイルパンの仕様により異なる』等の逃げは禁止。車台番号・原動機型式から特定して確定値を出すこと。交換条件で変わる場合のみ『値＋条件』を簡潔に。",
      "【締付トルク】範囲ではなく『規定値±公差』の形(例 600±50 N·m)。",
      "出力は厳密なJSONのみ。形式: {\"v\":\"値\"}",
      "",
      "■対象車両: " + vehicleDesc(),
      "■知りたい項目: " + key
    ].join("\n");
    const r = await geminiAsk(prompt, { noCache: true, mode: "flash", search: false });   // 項目補完も検索なしFlash(速く確実)
    const obj = extractJson(r.text);
    const nv = obj && obj.v != null ? String(obj.v).trim() : String(r.text || "").trim();
    if (!nv) return;
    const idx = shownSpecs.findIndex(s => s.k === key);
    if (idx >= 0) shownSpecs[idx] = { k: key, v: nv }; else shownSpecs.push({ k: key, v: nv });
    const specs = shownSpecs.slice();
    setLearned(vehicleKey(current), { specs });
    saveVehicleAiData(specs);
    registerVehicleToDB({ silent: true });
    renderSpecs(specs, "learned");
  } catch (e) {
    if (e.message !== "__cancelled__") uiAlert("⚠ " + (e.message || "更新に失敗しました"));
  } finally {
    if (btn) { btn.classList.remove("loading"); btn.disabled = false; }
  }
}

/* ---- 写真・動画の添付AI解析(Geminiマルチモーダル) ---- */
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      // data URL の mime に codecs="vp8,opus" などコンマが含まれる場合があるため "base64," 以降を厳密に取り出す
      const s = String(r.result);
      const i = s.indexOf("base64,");
      res(i >= 0 ? s.slice(i + 7) : s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => rej(new Error("ファイルを読み込めませんでした"));
    r.readAsDataURL(file);
  });
}
/* 画像を送信前に自動縮小(長辺maxDim・JPEG品質quality)してbase64を返す。大きな写真を多数添付しても収まる。 */
async function imageToCompressedBase64(file, maxDim, quality) {
  maxDim = maxDim || 1280; quality = quality || 0.7;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const dataUrl = cv.toDataURL("image/jpeg", quality);
    cv.width = cv.height = 1;   // メモリ解放
    const i = dataUrl.indexOf("base64,");
    return i >= 0 ? dataUrl.slice(i + 7) : null;
  } catch (e) { return null; }
}
/* 添付(写真/動画)を送信用 {mimeType,data} に変換。写真は自動圧縮、動画はそのまま。 */
async function attachToMedia(a) {
  const f = a.file;
  if (/^image\//.test(f.type || "") && (a.kind !== "video")) {
    const data = await imageToCompressedBase64(f, 1024, 0.65);   // 送信軽量化で解析を高速化
    if (data) return { mimeType: "image/jpeg", data: data };
  }
  return { mimeType: cleanMime(f.type, a.kind === "video" ? "video/mp4" : "image/jpeg"), data: await fileToBase64(f) };
}
/* inlineData用にmimeTypeからcodecsなどのパラメータをはずしてGeminiが受け付ける形に */
function cleanMime(m, fallback) {
  m = (m || fallback || "").split(";")[0].trim();
  return m || fallback;
}
/* 動画(＋プロンプト)をGeminiに送って解析。textのみ版geminiAskと別系統(キャッシュなし) */
/* 動画・画像対応モデル(liteは動画非対応のことがあるため除外) */
const GEMINI_MEDIA_MODELS = {
  // 先頭の『-latest』別名で自動的に最新版へ。未対応なら固定版へフォールバック。
  flash: ["gemini-flash-latest", "gemini-2.5-flash"],
  pro: ["gemini-pro-latest", "gemini-flash-latest", "gemini-2.5-flash"]
};
async function geminiAskMedia(prompt, media) {
  prompt = langDirective(prompt);
  if (typeof isDemo === "function" && isDemo()) return demoAnswer(prompt);   // デモ: 固定サンプル回答
  const key = localStorage.getItem(LS.gemini);
  // 契約店舗はサーバー(mecha)経由=プラン準拠を最優先(個人キーが残っていてもゲートを効かせる)。
  if (contractAi()) {
    const d = await window.Cloud.callFn("mecha", { prompt, mode: mediaModeByPlan(), media });
    if (d && d.text) return { text: d.text, truncated: !!d.truncated, model: (d && d.model) || "" };
    throw new Error("AIから回答が得られませんでした");
  }
  if (!key) throw new Error("Gemini APIキーが未設定です。");
  let lastErr = null;
  for (const model of GEMINI_MEDIA_MODELS[getAiMode()]) {
    let dropToNext = false;
    for (let attempt = 0; attempt < 3 && !dropToNext; attempt++) {
      try {
        const genCfg = { temperature: 0.2, maxOutputTokens: 16384 };
        if (model.startsWith("gemini-2.5")) genCfg.thinkingConfig = { thinkingBudget: -1 };
        const parts = [{ text: prompt }, ...media.map(m => ({ inlineData: { mimeType: m.mimeType, data: m.data } }))];
        const res = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts }], generationConfig: genCfg }) });
        if (res.status === 404) { lastErr = new Error(model + " は利用不可"); break; }
        if (res.status === 503 || res.status === 500) {   // 過負荷は少し待って同モデルで再試行(無料版へ落とす前に)
          lastErr = new Error("AIが混雑しています (" + res.status + ")。");
          if (attempt < 2) { await new Promise(r => setTimeout(r, 900 * (attempt + 1))); continue; }
          break;   // 3回だめなら次のモデルへ
        }
        if (res.status === 429) { lastErr = new Error("無料枠の上限に達しました。1分待つ／標準モードにする等をお試しください。"); break; }
        if (res.status === 403) throw new Error("APIキーが無効です。設定タブでキーを確認してください。");
        if (res.status === 400) {   // 400は次モデルでも試す(モデル非対応やサイズ等の切り分け)
          let detail = ""; try { detail = (await res.json()).error?.message || ""; } catch (e) {}
          lastErr = new Error("送信できませんでした(" + model + "): " + (detail || "動画が大きすぎる可能性。10〜15秒に短く／低画質でお試しを"));
          break;
        }
        if (!res.ok) { lastErr = new Error("AI応答エラー (" + res.status + ")"); break; }
        const j = await res.json();
        const cand = j.candidates?.[0];
        const text = cand?.content?.parts?.filter(p => !p.thought).map(p => p.text || "").join("") || "";
        if (!text) throw new Error("AIから回答が得られませんでした");
        return { text, truncated: cand?.finishReason === "MAX_TOKENS", model };
      } catch (e) {
        if (e.message && (e.message.includes("上限") || e.message.includes("キーが無効"))) throw e;
        lastErr = e; dropToNext = true;
      }
    }
  }
  throw lastErr || new Error("AIに接続できませんでした(要ネット接続)");
}
/* 写真・動画診断のストリーミング版。思考量に上限を設けて逐次表示し、待ち時間を短縮する。
   自前キー(BYOK)のみ対応。デモ/契約店舗プロキシ/キー無しは通常のgeminiAskMediaへフォールバック。 */
async function geminiAskMediaStream(prompt, media, opts, onChunk) {
  opts = opts || {};
  prompt = langDirective(prompt);
  if (typeof isDemo === "function" && isDemo()) return geminiAskMedia(prompt, media);
  // iOS + 自前キー直叩きは1チャンクで切れるため一括取得。契約店舗はXHRストリーミング対応済みでiOSでも逐次表示。
  if (isMobile() && !contractAi()) return geminiAskMedia(prompt, media);
  const key = localStorage.getItem(LS.gemini);
  if (!key || contractAi()) {
    // 契約店舗はプラン準拠のサーバー経路を最優先(個人キーが残っていてもゲートを効かせる)。未対応時は従来のgeminiAskMediaへ。
    if (contractAi() && typeof window.Cloud.callFnStream === "function") {
      try {
        // 写真・動画解析はプラン準拠(NA=Flash / ターボ・ツインターボ=Pro)。Proでも思考は抑えめで最速化。
        return await window.Cloud.callFnStream("mechaStream",
          { prompt, mode: mediaModeByPlan(), media, thinkingBudget: mediaThinking(opts) }, onChunk);
      } catch (e) { if (e && e.message === "__cancelled__") throw e; }
    }
    if (!key) return geminiAskMedia(prompt, media);
  }
  const mode = getAiMode();   // 自前キー(個人利用)はトグル準拠
  aiAbort = new AbortController();
  let lastErr = null;
  for (const model of GEMINI_MEDIA_MODELS[mode]) {
    try {
      const genCfg = { temperature: 0.2, maxOutputTokens: 16384 };
      // 3系/2.5系/-latest は思考量に上限を設けて速く仕上げる(写真解析は無制限思考まで不要)
      if (/gemini-(2\.5|3(\.\d+)?)[-.]/.test(model) || model.indexOf("-latest") >= 0) {
        const tb = (typeof opts.thinkingBudget === "number") ? opts.thinkingBudget : (mode === "pro" ? 1024 : 256);
        genCfg.thinkingConfig = { thinkingBudget: tb };
      }
      const parts = [{ text: prompt }, ...media.map(m => ({ inlineData: { mimeType: m.mimeType, data: m.data } }))];
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":streamGenerateContent?alt=sse&key=" + encodeURIComponent(key),
        { method: "POST", headers: { "Content-Type": "application/json" }, signal: aiAbort.signal, body: JSON.stringify({ contents: [{ parts }], generationConfig: genCfg }) });
      if (res.status === 404) { lastErr = new Error(model + " は利用不可"); continue; }
      if (res.status === 503 || res.status === 500) { lastErr = new Error("AIが混雑しています (" + res.status + ")。"); continue; }
      if (res.status === 429) { lastErr = new Error("無料枠の上限に達しました。1分待つか標準モードにしてください。"); continue; }
      if (res.status === 403) throw new Error("APIキーが無効です。設定タブでキーを確認してください。");
      if (res.status === 400) { let detail = ""; try { detail = (await res.json()).error?.message || ""; } catch (e) {} lastErr = new Error("送信できませんでした(" + model + "): " + (detail || "動画が大きすぎる可能性。短く/低画質でお試しを")); continue; }
      if (!res.ok || !res.body) { lastErr = new Error("AI応答エラー (" + res.status + ")"); continue; }
      const reader = res.body.getReader(); const dec = new TextDecoder();
      let buf = "", text = "", finish = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (line.indexOf("data:") !== 0) continue;
          const js = line.slice(5).trim(); if (!js || js === "[DONE]") continue;
          try {
            const j = JSON.parse(js);
            const cand = j.candidates && j.candidates[0];
            const piece = ((cand && cand.content && cand.content.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("");
            if (piece) { text += piece; if (onChunk) onChunk(text, false); }
            if (cand && cand.finishReason) finish = cand.finishReason;
          } catch (e) {}
        }
      }
      if (!text) throw new Error("AIから回答が得られませんでした");
      if (onChunk) onChunk(text, true);
      return { text, truncated: finish === "MAX_TOKENS", model };
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("__cancelled__");
      if (e.message && (e.message.includes("上限") || e.message.includes("キーが無効"))) throw e;
      lastErr = e;
    }
  }
  try { return await geminiAskMedia(prompt, media); } catch (e) { throw lastErr || e; }
}
function buildMediaDiagPrompt() {
  const extra = $("diagText").value.trim();
  const lines = [
    "あなたは日本の自動車整備士を支援するベテラン診断アドバイザーです。",
    "【最重要・3点統合の診断】この診断では次の3種類の情報を必ず全て突き合わせ、1つの故障像として統合すること: (1)整備士のコメント/説明、(2)添付の写真、(3)添付の動画(音声を含む)。どれか1つだけで判断しない。",
    "とりわけ整備士のコメントは、現場で実際に起きている症状・発生条件・作業経緯を伝える最重要の手がかりであり、絶対に無視しないこと。映像から読み取れる事実とコメントの両方を満たす原因を優先する。映像とコメントが食い違う場合は、その食い違い自体を手がかりとして扱い、コメントが示す症状を説明できる原因を重視する。"
  ];
  if (extra) {
    lines.push("", "■整備士のコメント/説明（最重要・必ず診断に反映）:", extra, "");
  } else {
    lines.push("", "※整備士のコメントは未入力です。写真・動画のみから判断してください。", "");
  }
  lines.push(
    "添付の写真・動画を観察し、判断できる症状(異音の種類・発生タイミング、煙や排気の色、振動、警告灯、液漏れ、損傷、異常な挙動など)を読み取ってください。動画に音声があれば異音の特徴も考慮すること。映像・音声・コメントから判断できないことは断定せず、推測には「（要確認）」を付けること。",
    "【統合診断】複数のDTCや複数の症状がある場合は、1つずつ別々に原因を挙げず、全ての手がかり(コメント＋写真＋動画)を『1つの故障像』としてまとめ、それらを一括で説明できる根本原因を最優先で特定する。表面的なコード名や1つの症状に引っ張られず、原因(一次)と結果(二次)を見分ける。第1位は、コメントの症状を含めできるだけ多くの手がかりを1つで説明できる、最も可能性が高い根本原因にすること。",
    "前置き・免責・挨拶は不要。Markdown記号(**、#、表)は使わず、必ず次の形式で:",
    "■読み取れた症状・状況",
    "・コメントと写真・動画から読み取れた症状/状況を箇条書き(判別できなければ『判別不可』)。整備士コメントの内容も必ず1項目以上反映する。",
    "■原因候補（可能性が高い順）",
    "1. 原因名（一言で）",
    "理由: なぜこの症状・映像・コメントからこの原因を疑うのか、根拠を1文で簡潔に。可能ならコメントのどの記述と整合するかに触れる。",
    "切り分け: 確認方法。使用工具と測定値の目安を含める。1〜2文で簡潔に。",
    "2.（同様に最大5つまで。各候補に必ず『理由:』と『切り分け:』を付ける）",
    "■最初の1手",
    "現場で最初にやるべきことを1〜2文で。",
    ""
  );
  if (current.type || current.vin) {
    const code = current.type && current.type.includes("-") ? current.type.split("-")[1] : current.type;
    const v = code ? findVehicle(code) : null;
    lines.push("■車両: " + (current.type ? "型式 " + current.type : "車台番号 " + current.vin) + (v ? "（" + v.name + "）" : ""));
    if (v && (v.faults || []).length) lines.push("この車種の既知の持病: " + v.faults.join(" / "));
  }
  { const os = officialSpecsText(); if (os) lines.push(os); }
  const ld = aiLangDirective(); if (ld) lines.push("\n" + ld);
  return lines.join("\n");
}
/* ===== 診断: 写真・動画の添付(4方式) + 自動圧縮 + メディアAI解析 ===== */
/* 汎用ライブカメラ(外カメラ固定・複数枚撮影)。撮影ごとに onShot(File[jpeg]) を呼ぶ。完了/閉じるで onDone()。
   capture属性(内カメラになる端末あり)を避け、getUserMedia facingMode=environment を使う。非対応は false を返す。 */
let lcStream = null, lcShot = null, lcDone = null, lcCount = 0;
async function openLiveCamera(onShot, onDone) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  lcShot = onShot; lcDone = onDone || null; lcCount = 0;
  let ov = document.getElementById("lcOverlay");
  if (!ov) {
    ov = document.createElement("div"); ov.id = "lcOverlay"; ov.className = "kcOverlay";
    ov.innerHTML =
      '<video id="lcVideo" class="kcVideo" playsinline muted></video>' +
      '<div class="kcTip">枠いっぱいに写す。丸ボタンで撮影、複数枚OK</div>' +
      '<div class="kcBar">' +
        '<button type="button" class="kcClose" id="lcClose" aria-label="閉じる">×</button>' +
        '<button type="button" class="kcShot" id="lcShotBtn" aria-label="撮影"></button>' +
        '<button type="button" class="kcDone" id="lcDoneBtn">完了 <span id="lcCount">0</span></button>' +
      '</div>';
    document.body.appendChild(ov);
    document.getElementById("lcClose").onclick = closeLiveCamera;
    document.getElementById("lcShotBtn").onclick = shotLiveCamera;
    document.getElementById("lcDoneBtn").onclick = closeLiveCamera;
  }
  document.getElementById("lcCount").textContent = "0";
  ov.style.display = "flex";
  const v = document.getElementById("lcVideo");
  try {
    lcStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    v.srcObject = lcStream; await v.play();
  } catch (e) { closeLiveCamera(); return false; }
  return true;
}
function shotLiveCamera() {
  const v = document.getElementById("lcVideo"); if (!v || !v.videoWidth) return;
  const maxDim = 1600, scale = Math.min(1, maxDim / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(1, Math.round(v.videoWidth * scale)), h = Math.max(1, Math.round(v.videoHeight * scale));
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(v, 0, 0, w, h);
  cv.toBlob(blob => {
    if (!blob) return;
    const file = new File([blob], "photo_" + Date.now() + ".jpg", { type: "image/jpeg" });
    lcCount++; const c = document.getElementById("lcCount"); if (c) c.textContent = lcCount;
    if (lcShot) lcShot(file);
  }, "image/jpeg", 0.72);
  const ov = document.getElementById("lcOverlay"); if (ov) { ov.classList.add("kcFlash"); setTimeout(() => ov.classList.remove("kcFlash"), 130); }
}
function closeLiveCamera() {
  if (lcStream) { try { lcStream.getTracks().forEach(t => t.stop()); } catch (e) {} lcStream = null; }
  const ov = document.getElementById("lcOverlay"); if (ov) ov.style.display = "none";
  const done = lcDone; lcShot = null; lcDone = null; if (done) done();
}

const diagAttachments = [];          // {file, kind:'image'|'video', url}
const ATTACH_MAX = 12 * 1024 * 1024;   // インライン送信の安全上限(base64で約1.37倍に膨らむため raw 12MB ≒ 16.5MB)
const VIDEO_TARGET = 9 * 1024 * 1024;  // 圧縮の目標サイズ(余裕を持って)

const attachMap = [
  ["btnAttachPhoto", "inAttachPhoto"],
  ["btnAttachPhotoCam", "inAttachPhotoCam"],
  ["btnAttachVideo", "inAttachVideo"],
  ["btnAttachVideoCam", "inAttachVideoCam"],
];
attachMap.forEach(([btn, input]) => {
  $(btn).addEventListener("click", async () => {
    if (typeof closeVoiceChat === "function") closeVoiceChat();   // 添付選択で会話モードを閉じる
    document.querySelectorAll(".diagIco").forEach(b => b.classList.remove("sel"));
    $(btn).classList.add("sel");
    if (input === "inAttachPhotoCam") {   // 写真カメラ=ライブカメラ(外カメラ・複数撮影)。非対応時はファイル入力へ
      const ok = await openLiveCamera(async f => { await addDiagAttachment(f); }, null);
      if (!ok) $(input).click();
      return;
    }
    $(input).click();
  });
  $(input).addEventListener("change", async e => {
    const files = [...e.target.files]; e.target.value = "";
    for (const f of files) await addDiagAttachment(f);
  });
});

async function addDiagAttachment(file) {
  const isVideo = (file.type || "").startsWith("video");
  const st = $("diagVideoStatus");
  let f = file;
  if (isVideo && file.size > ATTACH_MAX) {
    toggle("diagVideoStatus", true);
    st.textContent = "動画が大きい(" + Math.round(file.size / 1048576) + "MB)ので自動圧縮しています…";
    try {
      f = await compressVideo(file, VIDEO_TARGET);
      st.textContent = "✓ 圧縮しました(" + Math.round(f.size / 1048576) + "MB)。";
    } catch (e) {
      f = file;
      st.textContent = "⚠ 自動圧縮できませんでした。短い動画で撮り直すか、低画質で撮影してください。";
    }
    if (f.size > ATTACH_MAX) {
      st.textContent = "⚠ 圧縮しても大きすぎます(" + Math.round(f.size / 1048576) + "MB)。30秒程度に短く撮り直してください。";
      return;
    }
  }
  diagAttachments.push({ file: f, kind: isVideo ? "video" : "image", url: URL.createObjectURL(f) });
  renderDiagAttachList();
}
function renderDiagAttachList() {
  const box = $("diagAttachList");
  box.innerHTML = "";
  diagAttachments.forEach((a, i) => {
    const d = document.createElement("div"); d.className = "attachThumb";
    const media = document.createElement(a.kind === "video" ? "video" : "img");
    media.src = a.url; if (a.kind === "video") { media.muted = true; media.playsInline = true; }
    const kind = document.createElement("span"); kind.className = "axKind"; kind.textContent = a.kind === "video" ? "動画" : "写真";
    const del = document.createElement("button"); del.className = "axDel"; del.textContent = "×";
    del.addEventListener("click", () => { URL.revokeObjectURL(a.url); diagAttachments.splice(i, 1); renderDiagAttachList(); });
    d.append(media, kind, del); box.appendChild(d);
  });
  toggle("diagAttachList", diagAttachments.length > 0);
}
function clearDiagAttachments() {
  diagAttachments.forEach(a => URL.revokeObjectURL(a.url));
  diagAttachments.length = 0; renderDiagAttachList();
  document.querySelectorAll(".diagIco").forEach(b => b.classList.remove("sel"));
}

/* ===== 修理タブ「修理について質問」の写真・動画添付(診断と同じ自動圧縮) ===== */
const vehAttachments = [];   // {file, url, kind}
[["btnVehPhoto", "inVehPhoto"], ["btnVehPhotoCam", "inVehPhotoCam"], ["btnVehVideo", "inVehVideo"], ["btnVehVideoCam", "inVehVideoCam"]].forEach(([btn, input]) => {
  const b = $(btn), inp = $(input); if (!b || !inp) return;
  b.addEventListener("click", async () => {
    if (input === "inVehPhotoCam") {   // 写真カメラ=ライブカメラ(外カメラ・複数撮影)。非対応時はファイル入力へ
      const ok = await openLiveCamera(async f => { await addVehAttachment(f); renderVehAttachList(); }, null);
      if (!ok) inp.click();
      return;
    }
    inp.click();
  });
  inp.addEventListener("change", async e => {
    const files = [...e.target.files]; e.target.value = "";
    for (const f of files) await addVehAttachment(f);
    renderVehAttachList();
  });
});
async function addVehAttachment(file) {
  const isVideo = (file.type || "").startsWith("video");
  const st = $("vehVideoStatus");
  let f = file;
  if (isVideo && file.size > ATTACH_MAX) {
    if (st) { toggle("vehVideoStatus", true); st.textContent = "動画が大きい(" + Math.round(file.size / 1048576) + "MB)ので自動圧縮しています…"; }
    try {
      f = await compressVideo(file, VIDEO_TARGET);
      if (st) st.textContent = "✓ 圧縮しました(" + Math.round(f.size / 1048576) + "MB)。";
    } catch (e) {
      f = file;
      if (st) st.textContent = "⚠ 自動圧縮できませんでした。短い動画で撮り直すか、低画質で撮影してください。";
    }
    if (f.size > ATTACH_MAX) {
      if (st) st.textContent = "⚠ 圧縮しても大きすぎます(" + Math.round(f.size / 1048576) + "MB)。30秒程度に短く撮り直してください。";
      return;
    }
  } else if (st) { toggle("vehVideoStatus", false); }
  vehAttachments.push({ file: f, kind: isVideo ? "video" : "image", url: URL.createObjectURL(f) });
}
function renderVehAttachList() {
  const box = $("vehAttachList"); if (!box) return;
  box.innerHTML = "";
  vehAttachments.forEach((a, i) => {
    const d = document.createElement("div"); d.className = "attachThumb";
    const media = document.createElement(a.kind === "video" ? "video" : "img");
    media.src = a.url; if (a.kind === "video") { media.muted = true; media.playsInline = true; }
    const kind = document.createElement("span"); kind.className = "axKind"; kind.textContent = a.kind === "video" ? "動画" : "写真";
    const del = document.createElement("button"); del.className = "axDel"; del.textContent = "×";
    del.addEventListener("click", () => { URL.revokeObjectURL(a.url); vehAttachments.splice(i, 1); renderVehAttachList(); });
    d.append(media, kind, del); box.appendChild(d);
  });
  toggle("vehAttachList", vehAttachments.length > 0);
}
function clearVehAttachments() {
  vehAttachments.forEach(a => URL.revokeObjectURL(a.url));
  vehAttachments.length = 0; renderVehAttachList();
}

/* 大きい動画をcanvas+MediaRecorderで縮小再エンコード(音声も維持。短時間クリップ向け) */
function compressVideo(file, targetBytes) {
  return new Promise((resolve, reject) => {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) { reject(new Error("非対応")); return; }
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.src = url;
    v.onloadedmetadata = () => {
      const maxDim = 540;                       // 長辺540pxへ縮小(送信サイズ優先)
      const scale = Math.min(1, maxDim / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.max(2, Math.round(v.videoWidth * scale) & ~1);
      const h = Math.max(2, Math.round(v.videoHeight * scale) & ~1);
      const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      const cx = canvas.getContext("2d");
      const cstream = canvas.captureStream(24);
      // 元動画の音声トラックを合成(取得できる端末のみ)
      try {
        const vs = v.captureStream ? v.captureStream() : null;
        const at = vs && vs.getAudioTracks ? vs.getAudioTracks()[0] : null;
        if (at) cstream.addTrack(at);
      } catch (e) {}
      const dur = v.duration && isFinite(v.duration) ? v.duration : 12;
      const bitrate = Math.max(250000, Math.min(1800000, Math.floor(targetBytes * 8 / Math.max(1, dur) * 0.8)));
      let mime = "video/webm;codecs=vp8,opus";
      if (!MediaRecorder.isTypeSupported(mime)) mime = MediaRecorder.isTypeSupported("video/webm") ? "video/webm" : "";
      let rec;
      try { rec = new MediaRecorder(cstream, mime ? { mimeType: mime, videoBitsPerSecond: bitrate } : { videoBitsPerSecond: bitrate }); }
      catch (e) { URL.revokeObjectURL(url); reject(e); return; }
      const chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        URL.revokeObjectURL(url);
        const blob = new Blob(chunks, { type: mime || "video/webm" });
        resolve(new File([blob], "compressed.webm", { type: cleanMime(blob.type, "video/webm") }));
      };
      const st0 = $("diagVideoStatus");
      const draw = () => {
        if (v.ended || v.paused) return;
        cx.drawImage(v, 0, 0, w, h);
        if (st0 && dur) st0.textContent = "動画を圧縮中… " + Math.min(99, Math.round(v.currentTime / dur * 100)) + "%（動画の長さ分かかります）";
        requestAnimationFrame(draw);
      };
      v.onplay = () => draw();
      v.onended = () => { try { rec.stop(); } catch (e) {} };
      rec.start();
      v.play().catch(err => { URL.revokeObjectURL(url); reject(err); });
      // 保険: 想定尺+3秒で強制停止
      setTimeout(() => { if (rec.state !== "inactive") { try { v.pause(); rec.stop(); } catch (e) {} } }, (dur + 3) * 1000);
    };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error("動画を読み込めませんでした")); };
  });
}

let diagMediaBusy = false;
async function diagMediaAnalyze() {
  if (!aiOK()) {
    uiAlert("写真・動画のAI解析には無料のGemini APIキーの設定が必要です（設定タブ）。");
    switchView("settings"); return;
  }
  if (diagMediaBusy) return;
  diagMediaBusy = true;
  diagGuideCache = {}; inspectPaneReg = []; currentDiagRec = null;   // 新しい診断: 事前生成キャッシュをリセット
  const runBtn = $("btnDiagRun"); setBtnLoading(runBtn, true, "メカ君が解析中…");
  const st = $("diagVideoStatus"); toggle("diagVideoStatus", true);
  st.textContent = "写真を最適化しています…";
  // テキストにコード/症状があれば内蔵DB照合も表示
  const text = $("diagText").value.trim();
  if (text) { const dtcs = extractDTCs(text); renderDiagResults(dtcs, matchSymptoms(text), matchVehicleFaults(text, dtcs), text); }
  let stopTimer = null;
  try {
    // 写真は自動圧縮してから送信(枚数が多くても収まる)。複数枚は並列圧縮で最適化を高速化。
    const media = await Promise.all(diagAttachments.map(a => attachToMedia(a)));
    const totalB64 = media.reduce((s, m) => s + ((m.data && m.data.length) || 0), 0);
    if (totalB64 * 0.75 > ATTACH_MAX) {
      st.textContent = "⚠ 添付の合計サイズが大きすぎます(" + Math.round(totalB64 * 0.75 / 1048576) + "MB)。動画は1本・30秒程度に、写真は枚数を減らしてください。";
      diagMediaBusy = false; setBtnLoading(runBtn, false); return;
    }
    st.textContent = "メカ君が写真・動画を解析しています…";
    const box = $("diagResults");
    const { sec, body } = diagSection("", "メカ君", "写真・動画からのメカ君診断");
    const p = document.createElement("div"); p.className = "ai-answer";
    body.appendChild(p); box.prepend(sec); sec.scrollIntoView({ behavior: "smooth" });
    lastDiagInput = (text || "") || "写真・動画による診断";   // 手引書生成に文脈を反映
    stopTimer = startThinkingTimer(p, "🔧 メカ君が写真・動画を解析中");
    let streamed = false;
    const mdp = buildMediaDiagPrompt();
    // 故障診断は精度優先。写真・動画・コメントの統合をしっかり推論させるため思考量を引き上げる
    // (NA=Flashでも256→2048、有料=Proは4096)。会話等の軽用途とは別枠で確保。
    const diagBudget = (mediaModeByPlan() === "pro") ? 4096 : 2048;
    let r = await geminiAskMediaStream(mdp, media, { thinkingBudget: diagBudget }, (acc, done) => {
      if (done) return;
      if (!streamed) { streamed = true; stopTimer(); p.classList.add("streaming"); }
      p.textContent = acc;
    });
    if (r && r.truncated) { p.textContent = (r.text || "") + "\n…続きを取得中…"; r = await continueIfTruncated(mdp, r, { mode: "flash" }, (acc) => { p.textContent = acc; }); }
    stopTimer(); p.classList.remove("streaming");
    renderAiAnswer(p, r.text, { linkCauses: true });
    const eb = engineBadge(r.model); if (eb) { const h2 = sec.querySelector("h2"); if (h2) h2.appendChild(eb); }
    const note = document.createElement("div"); note.className = "hint"; note.style.marginTop = "10px";
    note.textContent = (r.truncated ? "⚠ 回答が長いため一部省略された可能性があります。 " : "") + "※ 映像・音声からの推定です。必ず実測・実点検で裏取りしてください。";
    body.appendChild(note);
    const rec = saveDiagRecord(text || "写真・動画による診断", r.text, getAiMode());   // 結果を履歴に保存
    addDiagHeadShare(sec, rec);   // 見出し右端に共有(バッジは左寄せ)
    const guideNote = document.createElement("div"); guideNote.className = "hint guidePrep"; body.appendChild(guideNote);
    const causes = [...p.querySelectorAll(".ai-cause")].map(e => e.textContent.trim()).filter(Boolean);
    autoGenGuides(causes, rec, guideNote);   // 上位候補の点検手引書を先に用意(時短)
    appendAiFollowup(body, text || "(添付の写真・動画による相談)", r.text);  // この診断にも追加相談欄
    st.textContent = "✓ 解析が完了しました。下に結果を表示しています。";
  } catch (err) {
    if (stopTimer) stopTimer();
    if (err.message !== "__cancelled__") st.textContent = "⚠ " + (err.message || "解析に失敗しました");
  } finally {
    diagMediaBusy = false; setBtnLoading(runBtn, false);
  }
}

/* ===== 音声入力(Web Speech API) ===== */
function getSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR(); r.lang = "ja-JP"; r.interimResults = true; r.continuous = false;
  return r;
}
let micRec = null, micListening = false, micBtnCur = null;
/* 検索/相談ボタン押下時に音声入力を終了させる */
function stopFieldMic() { micListening = false; if (micRec) { try { micRec.stop(); } catch (e) {} } }
/* 音声で文字入力: 押すと認識開始。無音で切れても押すまで自動再開し続ける。再押下で停止 */
function wireFieldMic(btnId, fieldId, idleLabel) {
  const btn = $(btnId); if (!btn) return;
  btn.addEventListener("click", () => {
    if (typeof closeVoiceChat === "function") closeVoiceChat();
    if (micListening && micBtnCur === btn) {      // 停止
      micListening = false;
      if (micRec) { try { micRec.stop(); } catch (e) {} }
      btn.textContent = idleLabel; btn.classList.remove("sel");
      return;
    }
    if (micRec) { try { micRec.stop(); } catch (e) {} micRec = null; }
    if (!getSpeechRecognition()) { uiAlert("この端末/ブラウザは音声入力に対応していません(Chrome等をお試しください)。"); return; }
    const fld = $(fieldId);
    const base = fld.value ? fld.value + " " : "";
    let accum = "", sessionFinal = "";
    micListening = true; micBtnCur = btn; btn.textContent = "●"; btn.classList.add("sel");
    const startSession = () => {
      const rec = getSpeechRecognition(); if (!rec) { micListening = false; return; }
      rec.continuous = true; rec.interimResults = true; micRec = rec; sessionFinal = "";
      let sessionFatal = false;
      rec.onresult = e => {
        let f = "", interim = "";
        for (let i = 0; i < e.results.length; i++) { if (e.results[i].isFinal) f += e.results[i][0].transcript; else interim += e.results[i][0].transcript; }
        sessionFinal = f;
        fld.value = base + dedupRepeats(accum + f + interim);
        if (typeof autoGrow === "function") autoGrow(fld);
      };
      rec.onerror = e => { const err = e && e.error; if (err === "not-allowed" || err === "service-not-allowed" || err === "audio-capture") sessionFatal = true; };
      rec.onend = () => {
        accum += sessionFinal; sessionFinal = ""; micRec = null;
        fld.value = base + dedupRepeats(accum);
        // ★無音で切れても、停止ボタンを押すまで自動再開して話し続けられるようにする(喋るたびに押す不便を解消)
        if (micListening && !sessionFatal) { setTimeout(() => { if (micListening) startSession(); }, 120); return; }
        micListening = false; btn.textContent = idleLabel; btn.classList.remove("sel");
      };
      try { rec.start(); } catch (e) { micListening = false; btn.textContent = idleLabel; btn.classList.remove("sel"); }
    };
    startSession();
  });
}
wireFieldMic("btnDiagMic", "diagText", "🎤");
wireFieldMic("btnPartsMic", "partName", "🎤");
wireFieldMic("btnVehMic", "qVehText", "🎤");
wireFieldMic("btnKarteMic", "kWork", "🎤");

/* ===== メカ君と音声会話(STT → Gemini → TTS) ===== */
let voiceRec = null, voiceHistory = [], voiceActive = false;
/* 音声会話セクションを開く。呼び出し元(診断/質問)の直下へ移動して表示 */
function openVoiceChat(afterEl) {
  if (!aiOK()) {
    uiAlert("音声会話には無料のGemini APIキーの設定が必要です（設定タブ）。");
    switchView("settings"); return;
  }
  if (!getSpeechRecognition()) { uiAlert("この端末/ブラウザは音声認識に対応していません(Chrome等をお試しください)。"); return; }
  const sec = $("voiceChatSec");
  if (afterEl && afterEl.parentNode) afterEl.parentNode.insertBefore(sec, afterEl.nextSibling);
  toggle("voiceChatSec", true);
  sec.scrollIntoView({ behavior: "smooth" });
}
$("btnDiagVoiceChat") && $("btnDiagVoiceChat").addEventListener("click", e => openVoiceChat(e.currentTarget.closest("section")));
$("btnVehVoiceChat") && $("btnVehVoiceChat").addEventListener("click", e => openVoiceChat(e.currentTarget.closest("section")));
/* 会話モードを閉じる(履歴・ログは保持し、再開で続きから) */
function closeVoiceChat() {
  voiceActive = false; voiceListening = false;
  if (voiceRec) { try { voiceRec.stop(); } catch (e) {} voiceRec = null; }
  try { window.speechSynthesis.cancel(); } catch (e) {}
  toggle("voiceChatSec", false);
}
$("btnVoiceStop").addEventListener("click", closeVoiceChat);
function vcAppend(role, text) {
  const d = document.createElement("div"); d.className = "vcMsg " + (role === "user" ? "user" : "mecha");
  if (role === "user") {
    d.textContent = "あなた: " + text;
  } else {
    const ic = document.createElement("img"); ic.className = "vcIco"; ic.src = "img/speak.png"; ic.alt = "メカ君";
    d.append(ic, document.createTextNode(text));
  }
  $("voiceLog").appendChild(d); $("voiceLog").scrollTop = $("voiceLog").scrollHeight;
}
function speak(text) {
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[■#*]/g, "")); u.lang = "ja-JP"; u.rate = 1.5;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}
/* 連続する同一フレーズの重複を1回に圧縮(音声認識の重複バグ対策) */
function dedupRepeats(s) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  // 正規表現(.{3,}?)\1+ は長文で破滅的バックトラック→主スレッド停止(端末フリーズ)を招く。
  // 長すぎる入力には適用せず、反復回数も上限を設けて必ず有限時間で返す。
  if (s.length > 2000) return s;
  let prev, guard = 0;
  do { prev = s; s = s.replace(/(.{3,}?)\1+/g, "$1"); } while (s !== prev && ++guard < 20);
  return s;
}
let voiceListening = false, voiceAccum = "", voiceSessionFinal = "";
/* メカ君の読み上げだけ止める */
$("btnVoiceMute").addEventListener("click", () => {
  try { window.speechSynthesis.cancel(); } catch (e) {}
  $("voiceStatus").textContent = "読み上げを止めました。「押して話す」で続けられます。";
});
/* 1セッションの音声認識(無音で切れても voiceListening 中は自動再開して待ち続ける) */
function startVoiceSession() {
  const rec = getSpeechRecognition(); if (!rec) { voiceListening = false; return; }
  rec.continuous = true; rec.interimResults = true;
  voiceRec = rec; voiceSessionFinal = "";
  rec.onresult = e => {
    // 毎回 全結果から作り直す(重複・連結バグ防止)
    let f = "", interim = "";
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) f += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
    }
    voiceSessionFinal = f;
    $("voiceStatus").textContent = "🎤 " + dedupRepeats(voiceAccum + f + interim);
  };
  rec.onerror = () => {};
  rec.onend = () => {
    // 自動再開しない(ピコ音の連発防止)。話し終わり(無音)または再押下で1回分を送信
    voiceAccum += voiceSessionFinal; voiceSessionFinal = ""; voiceRec = null; voiceListening = false;
    $("btnVoiceTalk").textContent = "🎤 押して話す";
    finishVoiceTurn();
  };
  try { rec.start(); } catch (e) { voiceRec = null; }
}
async function finishVoiceTurn() {
  $("btnVoiceTalk").textContent = "🎤 押して話す";
  const said = dedupRepeats(voiceAccum); voiceAccum = "";
  if (!said) { $("voiceStatus").textContent = "聞き取れませんでした。もう一度「押して話す」を。"; return; }
  vcAppend("user", said); voiceHistory.push({ role: "user", text: said });
  $("voiceStatus").textContent = "🔧 メカ君が考えています…";
  try {
    const r = await geminiAsk(buildVoiceChatPrompt(), { mode: "flash" });  // 会話は標準モードで無料枠を節約
    voiceHistory.push({ role: "mecha", text: r.text });
    vcAppend("mecha", r.text); speak(r.text);
    $("voiceStatus").textContent = "「押して話す」でさらに質問できます。読み上げ中は🔇停止や「押して話す」で止められます。";
  } catch (err) {
    $("voiceStatus").textContent = "⚠ " + (err.message || "メカ君に接続できませんでした");
  }
}
$("btnVoiceTalk").addEventListener("click", () => {
  try { window.speechSynthesis.cancel(); } catch (e) {}   // 読み上げ中なら止めて聞き取りへ
  if (voiceListening) {            // 2回目の押下=話し終わり → 停止して送信
    voiceListening = false;
    if (voiceRec) { try { voiceRec.stop(); } catch (e) {} } else { finishVoiceTurn(); }
    $("btnVoiceTalk").textContent = "🎤 押して話す";
    return;
  }
  voiceActive = true; voiceListening = true; voiceAccum = ""; voiceSessionFinal = "";
  $("voiceStatus").textContent = "🎤 聞いています…話し終わったら、もう一度ボタンを押してください。";
  $("btnVoiceTalk").textContent = "■ 話し終えたらタップ";
  startVoiceSession();
});
function buildVoiceChatPrompt() {
  const lines = [
    "あなたは『メカ君』。基本はまじめで頼れるロボット整備士だが、どこかおちゃめで愛嬌がある。一人称は『ボク』。",
    "丁寧で分かりやすい口調(です・ます調)で噛み砕いて話し、時々ちょっとした軽口やユーモアを一言だけ添える(やりすぎない・本題を邪魔しない)。安全と正確さは最優先で、確信が持てない点は正直に『要確認』と伝える。",
    "音声で読み上げるので、簡潔に話し言葉で。箇条書き記号やMarkdown記号は使わず、2〜4文程度で要点を。",
  ];
  const f = currentVehicleFacts();
  if (f.d && (f.d.type || f.d.vin || f.model)) {
    lines.push("");
    lines.push("【この相談は下記の特定車両についてです。一般論ではなく、必ずこの車両を前提に具体的に答えること。車種・型式が分かっているのに『車種が分かりません』『一般的には』と逃げない】");
    lines.push("対象車両: " + vehicleDesc());
    if (f.faults && f.faults.length) lines.push("この車種の既知の持病・定番故障: " + f.faults.slice(0, 8).join(" / "));
    if (f.specs && f.specs.length) lines.push("把握済みの整備諸元: " + f.specs.slice(0, 12).map(s => s.k + "=" + s.v).join(" / "));
  } else {
    lines.push("(まだ車両が読み取られていません。車両が必要な質問なら、車検証スキャンを促してください。)");
  }
  lines.push("");
  lines.push("これまでの会話:");
  voiceHistory.slice(-8).forEach(m => lines.push((m.role === "user" ? "整備士" : "メカ君") + ": " + m.text));
  lines.push("メカ君として次の返答を述べてください。");
  if (window.APP_LANG === "en") lines.push("Reply in natural spoken English (2-4 short sentences, no markdown).");
  return lines.join("\n");
}

/* =========================================================
   タブ切替・初期化
   ========================================================= */
let curView = "scan";        // 現在の主要ビュー
let lastVehPage = "scan";    // 車両表示中に最後に開いていたページ(scan/maint/diag/parts/karte)
function switchView(name) {
  if (name !== "scan" && typeof scanning !== "undefined" && scanning) stopLiveScan(false);
  curView = name;
  if (["scan", "maint", "diag", "parts", "karte"].includes(name)) lastVehPage = name;
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  // 車両のサブページ(メンテ/診断/部品)は下部タブ上「スキャン」を選択状態に
  const tabName = ["maint", "diag", "parts", "karte"].includes(name) ? "scan" : name;
  if (name === "karte") { toggle("karteForm", false); renderKarte(); }
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === tabName));
  // 共通ナビの現在ページをハイライト(枠だけ色)
  document.querySelectorAll(".pageNav .navBtn").forEach(b => b.classList.toggle("navActive", b.dataset.go === name));
  if (name === "diag") updateDiagVehicleHint();
  if (name === "parts") renderCopyKata();
  if (name === "scan") renderLastVehicle();
  if (name === "admin" && window.CloudAdmin) window.CloudAdmin.open();
  // 表示に切り替わった時、内容のある自動拡大欄の高さを再計算(タブ移動で縮むのを防ぐ)
  if (typeof autoGrowAll === "function") requestAnimationFrame(autoGrowAll);
  window.scrollTo(0, 0);
  // 設定画面(ログインフォーム)から離れたら一時退避を解除し、未ログインならログインゲートを再表示
  // (未認証のまま「戻る」でメイン画面へ入れてしまう不具合の対策)
  if (name !== "settings") { window._gateBypass = false; }
  try { if (typeof refreshAuthGate === "function") refreshAuthGate(); } catch (e) {}
}
document.querySelectorAll("#tabs button").forEach(b =>
  b.addEventListener("click", () => {
    if (b.dataset.view === "scan") {
      const vehLoaded = current && (current.type || current.vin || current.kataShitei);
      const vehViews = ["scan", "maint", "diag", "parts", "karte"];
      // 設定/履歴/DB編集など非車両ビューに居て車両が読込済みなら、車両の最後のページ(修理/診断等)へ戻す
      if (vehLoaded && !vehViews.includes(curView)) { switchView(lastVehPage || "scan"); toggle("result", true); return; }
      // 車両ページに居る時は従来どおりホーム(3つの入口)へ
      if (!$("result").classList.contains("hidden")) { goHome(); return; }
    }
    switchView(b.dataset.view);
  }));

/* ホーム(スキャン初期画面)に戻す: 車両表示・進捗を畳み、メカ君ヒーローとスキャンボタンを出す */
function goHome() {
  if (typeof scanning !== "undefined" && scanning) stopLiveScan(false);
  switchView("scan");
  toggle("result", false);
  toggle("mechaHero", true);
  foldEntryAreas();
  toggle("scanWrap", false); toggle("scanCtrls", false);
  toggle("scanProgress", false); toggle("scanActions", false); toggle("qrPhotoStatus", false);
  toggle("btnStart", true); toggle("btnStop", false); toggle("btnStopRow", false);
  document.body.classList.remove("scanningNow");
  toggle("fallbackLinks", true);
  // ホームへ戻る際、閲覧中だった車両を「前回の車両」にする。
  // 診断/修理の作業内容は保存しておき、チップから開き直したとき復元できるようにする。
  if (current && (current.type || current.vin || current.kataShitei)) {
    try { saveVehWork(vehicleKey(current)); } catch (e) {}
  }
  current = null;
  renderLastVehicle();
  renderIntakeBoard();   // 事務モードの入庫ボード
  renderHomeIntake();    // ホームの入庫状況(管理者のみ)
  window.scrollTo(0, 0);
}
/* iOS対策: カメラ起動中にアプリを背面化/画面ロックするとWKWebViewが固まることがある。
   非表示になったらライブスキャンを止めカメラ・OCRワーカーを解放する(復帰後は再スキャンで再開)。 */
function suspendScanForBackground() {
  try { if (typeof scanning !== "undefined" && scanning) stopLiveScan(false); } catch (e) {}
}
document.addEventListener("visibilitychange", () => { if (document.hidden) suspendScanForBackground(); });
window.addEventListener("pagehide", suspendScanForBackground);
window.addEventListener("freeze", suspendScanForBackground);   // Page Lifecycle API(対応端末)

/* ヘッダーのロゴ/文字タップでホームへ戻る */
(() => { const h = document.querySelector("header"); if (h) { h.style.cursor = "pointer"; h.addEventListener("click", goHome); } })();

/* 型式のハイフンより後ろ(車種記号)だけ取り出す。例 2PG-FW74HZ → FW74HZ */
function kataSuffix(t) { const s = String(t || "").trim(); if (!s) return ""; const i = s.indexOf("-"); return i >= 0 ? s.slice(i + 1).trim() : s; }
/* 車台番号のハイフンより前(打刻の車種記号部)。例 RK5-1028429 → RK5 / NKR85Y-70123 → NKR85Y
   ハイフンが無い打刻(例 NKR85Y7012345)は、末尾の一連番号(英字の後に続く5桁以上の数字)を除いた記号部を返す */
function vinPrefix(v) {
  let s = String(v || "").trim(); if (!s) return "";
  const i = s.indexOf("-"); if (i >= 0) s = s.slice(0, i).trim();   // ハイフンがあれば前半のみ
  // FAINESの車台番号キーワード検索は「英字＋数字」までで一致する。末尾の英字・一連番号は落とす。
  //   例: CYG60CM → CYG60 ／ NKR85Y7012345 → NKR85 ／ RK5(-1028429) → RK5
  const m = s.match(/^([A-Za-z]+\d+)/);
  return (m ? m[1] : s).trim();
}
/* 修理タブ: FAINES検索用に車台番号(ハイフン前)をコピー。無ければ型式(車種記号)で代替 */
function renderCopyKata() {
  const el = $("copyKata"); if (!el) return;
  const code = vinPrefix(current && current.vin) || kataSuffix(current && current.type);
  if (!code) { toggle("copyKata", false); return; }
  el.innerHTML = '📋 <b>' + esc(code) + '</b> をコピー';
  toggle("copyKata", true);
  el.onclick = async () => {
    await copyText(code);
    const orig = el.innerHTML; el.innerHTML = '✓ コピー';
    setTimeout(() => { el.innerHTML = orig; }, 1200);
  };
  // 年式(初度登録年)を横に表示(参考表示・コピー不可)
  const yEl = $("kataYear"); if (yEl) {
    const fr = current && current.firstReg; const yr = fr && fr.year;
    if (yr) { yEl.textContent = "年式: " + yr + "年" + (fr.month ? "/" + fr.month + "月" : ""); toggle("kataYear", true); }
    else toggle("kataYear", false);
  }
}
/* 最近表示した車両を記録(表示のたびに更新。前回=最後に表示していた車両) */
function vehId(v) { return [(v && v.type) || "", (v && v.vin) || "", (v && v.kataShitei) || "", (v && v.plate) || ""].join("|"); }
function pushRecentVehicle(d) {
  if (!d || !(d.type || d.vin || d.kataShitei)) return;
  try {
    let arr = JSON.parse(localStorage.getItem("ss_recentVeh") || "[]");
    const he = findHistEntry(getHistory(), d) || {};
    const nm = he.name || d.name || null;
    const card = { type: d.type || null, vin: d.vin || null, kataShitei: d.kataShitei || null, plate: d.plate || null, engine: d.engine || he.engine || null, name: nm, rid: d.rid || he.rid || null, at: Date.now() };
    arr = arr.filter(v => vehId(v) !== vehId(card));   // 同一車両は重複させない
    arr.unshift(card);
    localStorage.setItem("ss_recentVeh", JSON.stringify(arr.slice(0, 6)));
  } catch (e) {}
}
/* 型式が空の車両を、車台番号(打刻)からAIで特定して自動保存する。返り値=特定できた型式 or null */
const typeInferBusy = new Set();
async function inferTypeFromVin(d) {
  if (!d || d.type || !d.vin) return null;
  if (!localStorage.getItem(LS.gemini)) return null;
  const id = vehId(d);
  if (typeInferBusy.has(id)) return null; typeInferBusy.add(id);
  try {
    const prompt = [
      "あなたは日本の自動車整備士向けデータアドバイザーです。",
      "次の車台番号(と分かれば原動機型式)から、この車両の『型式』(排出ガス記号-車種記号。例 2PG-FW74HZ / SKG-NKR85YN)を特定してください。",
      "車台番号の打刻(例 NKR85-7012345 の『NKR85』)は車種記号に対応します。排ガス記号・年式まで確実でなくても、少なくとも車種記号部分は答えること。",
      "確実に判断できない場合のみ type は空文字。憶測での断定は避ける。出力は厳密なJSONのみ: {\"type\":\"...\"}",
      "車台番号: " + d.vin + (d.engine ? "\n原動機型式: " + d.engine : "")
    ].join("\n");
    const r = await geminiAsk(prompt, { mode: "flash" });
    const obj = extractJson(r.text);
    let ty = obj && obj.type ? String(obj.type).toUpperCase().trim() : "";
    if (!ty || /不明|^[-\s]*$/.test(ty)) return null;
    d.type = ty;
    // 履歴(=車両データ)へ自動保存＋社内共有
    const h2 = getHistory(); const e = findHistEntry(h2, d);
    if (e) { e.type = ty; e.updatedAt = Date.now(); localStorage.setItem(LS.hist, JSON.stringify(h2)); if (window.Cloud) window.Cloud.pushRecord(e); }
    return ty;
  } catch (e) { return null; } finally { typeInferBusy.delete(id); }
}
/* スキャン済み履歴のうち、型式が空で車台番号がある車両をまとめてVINから特定・保存(起動後に静かに実行) */
async function backfillTypesFromVin() {
  if (!localStorage.getItem(LS.gemini) || !navigator.onLine) return;
  const targets = getHistory().filter(h => h.vin && !h.type).slice(0, 15);
  let changed = false;
  for (const h of targets) {
    const ty = await inferTypeFromVin({ type: null, vin: h.vin, engine: h.engine, plate: h.plate, kataShitei: h.kataShitei, rid: h.rid });
    if (ty) changed = true;
    await new Promise(r => setTimeout(r, 700));   // 無料枠に配慮して間隔をあける
  }
  if (changed) { renderHistory(); renderLastVehicle(); }
}
/* ホーム: 前回の車両チップ(=現在表示中を除いた、最後に表示していた車両) */
function renderLastVehicle() {
  const el = $("lastVehicle"); if (!el) return;
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem("ss_recentVeh") || "[]"); } catch (e) {}
  const curId = (current && (current.type || current.vin || current.kataShitei)) ? vehId(current) : "";
  const last = arr.find(v => vehId(v) !== curId);
  if (!last) { toggle("lastVehicle", false); return; }
  const label = [dispText(last.plate), dispText(last.name)].filter(Boolean).join(" / ") || dispText(last.type) || "前回の車両";
  el.innerHTML = '🕒 前回の車両: <b>' + esc(label) + '</b> ›';
  toggle("lastVehicle", true);
  el.onclick = () => { const e2 = findHistEntry(getHistory(), last); showResult(e2 ? histToResult(e2) : last, { fromScan: false }); };
}

/* さりげないトースト通知(数秒で自動的に消える) */
function showToast(msg) {
  let t = document.getElementById("appToast");
  if (!t) { t = document.createElement("div"); t.id = "appToast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 2800);
}

/* 長押し検出(タッチ/マウス両対応)。長押し後の通常クリックは抑制する */
function addLongPress(el, cb, ms) {
  ms = ms || 500; let timer = null, fired = false, sx = 0, sy = 0;
  const start = e => { fired = false; const p = (e.touches && e.touches[0]) || e; sx = p.clientX; sy = p.clientY; timer = setTimeout(() => { fired = true; try { cb(); } catch (_) {} if (navigator.vibrate) try { navigator.vibrate(15); } catch (_) {} }, ms); };
  const move = e => { const p = (e.touches && e.touches[0]) || e; if (Math.abs(p.clientX - sx) > 10 || Math.abs(p.clientY - sy) > 10) clearTimeout(timer); };
  const end = () => clearTimeout(timer);
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchmove", move, { passive: true });
  el.addEventListener("touchend", end);
  el.addEventListener("mousedown", start);
  el.addEventListener("mousemove", move);
  el.addEventListener("mouseup", end);
  el.addEventListener("mouseleave", end);
  el.addEventListener("click", e => { if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; } }, true);
}
/* 左スワイプで削除ボタンを出す(iOS風)。slideを左へ最大Wまで移動、半分超で開いた状態を保持 */
function addSwipeReveal(item, slide) {
  const W = 84; let x0 = 0, y0 = 0, drag = false, moved = false, open = false;
  slide.style.touchAction = "pan-y";   // 縦スクロールはブラウザに任せる
  const setTx = v => { slide.style.transform = "translateX(" + v + "px)"; };
  const start = e => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    x0 = e.clientX; y0 = e.clientY; drag = true; moved = false; slide.style.transition = "none";
    // ここではポインタを捕捉しない(縦スクロールを妨げないため)。横スワイプ確定後に捕捉する。
  };
  const move = e => {
    if (!drag) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!moved) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;          // まだ方向が定まらない
      if (Math.abs(dx) <= Math.abs(dy)) { drag = false; return; } // 縦方向 → スワイプ扱いしない(削除は出さない)
      moved = true;
      try { slide.setPointerCapture(e.pointerId); } catch (_) {}  // 横スワイプ確定後のみ捕捉
    }
    item.classList.add("revealing");   // スワイプ中だけ背後のボタン(赤)を見せる。静止時は隠して赤線の露出を防ぐ
    let tx = (open ? -W : 0) + dx; tx = Math.max(-W, Math.min(0, tx)); setTx(tx);
  };
  const end = e => {
    if (!drag) return; drag = false; slide.style.transition = "transform .18s";
    if (!moved) { setTx(open ? -W : 0); if (!open) item.classList.remove("revealing"); return; }
    const base = (open ? -W : 0) + (e.clientX - x0); open = base < -W / 2; setTx(open ? -W : 0);
    if (!open) item.classList.remove("revealing");
  };
  slide.addEventListener("pointerdown", start);
  slide.addEventListener("pointermove", move);
  slide.addEventListener("pointerup", end);
  slide.addEventListener("pointercancel", end);
  // スワイプ操作の直後のクリック(車両を開く/区分変更)を抑制
  slide.addEventListener("click", e => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
}
/* ===== 確実に鳴る通知(音＋アプリ内ポップアップ) =====
   iOS Safari/PWAでは new Notification() が動かず無音で失敗するため、
   システム通知に頼らず WebAudio のビープ音 + 画面内モーダルで確実に知らせる。 */
let _audioCtx = null;
function unlockAudio() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
  } catch (e) {}
}
// 初回の操作で音声を解禁(iOSはユーザー操作が必須)
["pointerdown", "touchstart", "keydown"].forEach(ev =>
  window.addEventListener(ev, unlockAudio, { once: false, passive: true }));
/* ピンポン♪ の注意音を2回鳴らす */
function playChime() {
  try {
    unlockAudio(); if (!_audioCtx) return;
    const ctx = _audioCtx, t0 = ctx.currentTime;
    [[880, 0], [1174, 0.18], [880, 0.5], [1174, 0.68]].forEach(([f, dt]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.16);
      o.connect(g).connect(ctx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.18);
    });
  } catch (e) {}
}
/* 画面内の注意ポップアップ(音付き)。onOpenで詳細画面へ誘導できる */
function notifyAttention(title, body, onOpen) {
  playChime();
  if (navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) {} }
  let m = document.getElementById("notifyPop");
  if (!m) {
    m = document.createElement("div"); m.id = "notifyPop"; m.className = "notifyPop hidden";
    m.innerHTML = '<div class="npCard"><div class="npIcon">🔔</div>' +
      '<div class="npBody"><div class="npTitle"></div><div class="npText"></div></div>' +
      '<div class="npBtns"><button type="button" class="npOpen">確認</button>' +
      '<button type="button" class="npClose">閉じる</button></div></div>';
    document.body.appendChild(m);
  }
  m.querySelector(".npTitle").textContent = title || "お知らせ";
  m.querySelector(".npText").textContent = body || "";
  const openBtn = m.querySelector(".npOpen"), closeBtn = m.querySelector(".npClose");
  openBtn.style.display = onOpen ? "" : "none";
  openBtn.onclick = () => { toggle("notifyPop", false); try { onOpen && onOpen(); } catch (e) {} };
  closeBtn.onclick = () => toggle("notifyPop", false);
  toggle("notifyPop", true);
  // システム通知が使える環境ではそれも出す(バックグラウンド時の保険)
  try { if ("Notification" in window && Notification.permission === "granted") new Notification(title || "メカノAI", { body: body || "", icon: "icons/icon-192.png" }); } catch (e) {}
}
window.notifyAttention = notifyAttention;
window.playChime = playChime;

(async function init() {
  applyAppMode();   // 個人/法人モードを反映(同期・契約タブの表示切替)
  loadCustomDB();
  await Promise.all([loadBuiltinDB(), loadDiagDB()]);
  renderHistory();
  renderLastVehicle();   // ホームに前回車両チップ
  renderDBList();
  applyRoleUI();   // 権限に応じてデータ管理/削除ボタンを制御
  renderGeminiStat();
  renderVisionStat();
  renderCseStat();
  renderAiMode();
  renderDiagHistList();   // 保存済み診断結果の一覧を復元
  renderRepairHistList();   // 保存済み点検手引書の一覧を復元
  applyOfficeMode();   // 事務用: 入庫管理専用モードならボード全画面に
  // Stripe決済から戻ってきた時のお礼(?paid=1)。プラン有効化は数秒後にサーバー側で反映される。
  try {
    if (/[?&]paid=1/.test(location.search)) {
      showToast("お支払いありがとうございます。数秒後に契約が有効になります。");
      history.replaceState(null, "", location.pathname);
    }
  } catch (e) {}
  // 表示バージョンは Service Worker のキャッシュ番号(shaken-scan-vNNN)から自動取得(二重管理を避ける)
  appVerDisplay().then(ver => {
    if (sessionStorage.getItem("ss_justUpdated")) { sessionStorage.removeItem("ss_justUpdated"); showToast("最新版に更新しました（" + ver + "）"); }
    setText("verNote", "メカノAI " + ver + " ／ 内蔵DB " + BUILTIN_DB.length + "車種 ＋ カスタム " + CUSTOM_DB.length + "車種。データはすべてこの端末内に保存されます。");
  });
  if ("serviceWorker" in navigator) {
    // 更新は「起動直後(操作前)」だけ適用。使用中は絶対にリロードしない(閲覧・入力が飛ぶのを防ぐ)。
    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false, startupWindow = true;
    setTimeout(() => { startupWindow = false; }, 4000);   // 起動から数秒だけ自動適用を許可
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing || !hadController) return;
      refreshing = true;
      try { sessionStorage.setItem("ss_justUpdated", "1"); } catch (e) {}   // 更新後にさりげなく通知するため
      location.reload();
    });
    // updateViaCache:'none' … sw.js を常にネットから取得し、起動時に必ず新版を検出(古いまま固まるのを防ぐ)
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
      // 前回セッションでDL済みの新版が待機していれば、この起動直後(操作前)に一度だけ適用
      if (reg.waiting && navigator.serviceWorker.controller) { try { reg.waiting.postMessage("skipWaiting"); } catch (e) {} }
      // 起動時に一度だけ更新チェック。今回セッション中に見つかった新版は「待機」のまま(次回起動で適用)。
      // 起動直後の短い間に用意できた場合のみ自動適用し、以降は使用中に勝手に切り替えない。
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing; if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller && startupWindow) {
            try { nw.postMessage("skipWaiting"); } catch (e) {}   // 起動直後だけ適用
          }
        });
      });
      try { reg.update(); } catch (e) {}
    }).catch(() => {});
  }
  // ストア(App Store/Google Play)配布のネイティブ版は、更新はストアが行うのでこのボタンは不要 → 隠す。
  //  判定: Capacitorラッパー / TWA(android-app://からの起動) / ?native=1 / 保存フラグ。
  // ?corp=1(法人紹介QR): 法人版をデフォルトに。ストア判定より優先し、過去に付いた個人版フラグも解除。
  const forceCorp = new URLSearchParams(location.search).get("corp") === "1";
  if (forceCorp) { try { localStorage.removeItem("ss_nativeApp"); setAppMode("corp"); } catch (e) {} }
  const isNativeApp = !forceCorp && (() => {
    try {
      return !!(window.Capacitor) ||
        (document.referrer || "").startsWith("android-app://") ||
        new URLSearchParams(location.search).get("native") === "1" ||
        localStorage.getItem("ss_nativeApp") === "1";
    } catch (e) { return false; }
  })();
  if (!forceCorp && new URLSearchParams(location.search).get("native") === "1") { try { localStorage.setItem("ss_nativeApp", "1"); } catch (e) {} }
  // ストア(App Store/Play)配布=個人版固定: ログイン/法人/プラン/決済UIを隠す(Appleの課金ルール対策)。
  if (isNativeApp) { try { document.body.classList.add("storeApp"); setAppMode("personal"); } catch (e) {} }   // 個人版モード強制(AIキー表示/同期・契約非表示)
  // 手動更新ボタン: キャッシュが古いままの端末を、その場で確実に最新へ(Web/PWA版のみ)。
  const upBtn = document.getElementById("btnAppUpdate");
  // 個人版(ストア版/personalモード)はストア経由で更新されるため不要。法人(Web/PWA)版のみ表示。
  if (upBtn && (isNativeApp || getAppMode() === "personal")) { const w = upBtn.closest("div"); if (w) w.style.display = "none"; else upBtn.style.display = "none"; }
  // 更新処理(設定の更新ボタン・入庫ボードの更新アイコン 共通)。何があっても必ずリロードして固まり防止。
  async function runAppUpdate() {
    let done = false;
    const hardReload = () => { if (done) return; done = true; try { location.reload(); } catch (e) {} };
    const fallback = setTimeout(hardReload, 3500);   // 新SW有効化(controllerchange)か3.5秒の早い方
    try {
      if (!("serviceWorker" in navigator)) { clearTimeout(fallback); hardReload(); return; }
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) { clearTimeout(fallback); hardReload(); return; }
      navigator.serviceWorker.addEventListener("controllerchange", hardReload, { once: true });   // 新版が効いたら即リロード
      await reg.update();
      if (reg.waiting) reg.waiting.postMessage("skipWaiting");
      else if (reg.installing) { const nw = reg.installing; nw.addEventListener("statechange", () => { if (nw.state === "installed") nw.postMessage("skipWaiting"); }); }
    } catch (e) { clearTimeout(fallback); hardReload(); }
  }
  if (upBtn && !(isNativeApp || getAppMode() === "personal")) upBtn.addEventListener("click", () => {
    upBtn.disabled = true; upBtn.textContent = "🔄 更新中…"; runAppUpdate();
  });
  // 入庫ボード右上の更新アイコン(事務端末が一目で最新化できるように)
  const ibUp = document.getElementById("ibUpdate");
  if (ibUp) ibUp.addEventListener("click", () => { ibUp.classList.add("spin"); ibUp.disabled = true; runAppUpdate(); });
  // 事務(入庫管理)モードのログイン時に自動で最新版チェック→新版があれば適用(controllerchangeで一度だけリロード)。
  // 新版が無ければ何もしない(=リロードループにならない)。cloud.js のログイン処理から呼ばれる。
  window.appAutoUpdate = async function () {
    try {
      if (isNativeApp || getAppMode() === "personal") return;   // 個人版(ストア)はストア更新のため対象外
      if (!("serviceWorker" in navigator)) return;
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      await reg.update();
      if (reg.waiting) reg.waiting.postMessage("skipWaiting");
      else if (reg.installing) { const nw = reg.installing; nw.addEventListener("statechange", () => { if (nw.state === "installed" && reg.waiting) reg.waiting.postMessage("skipWaiting"); }); }
    } catch (e) {}
  };
})();

/* ============ お問い合わせ AIサポートチャット（メカ君） ============
   このツールの使い方・仕様を熟知したAIが回答。geminiAsk(既存のプロキシ/自前キー)を使用。 */
const SUPPORT_KB = [
  "あなたは車両整備サポートアプリ「メカノAI」の専属サポートAI『メカ君』です。整備士ユーザーの相棒として、親しみやすく頼れる敬語で答えます。",
  "回答方針: (1)まず結論・手順を具体的に示す(番号付きの操作手順が有効なら箇条書きで)。(2)簡潔に(必要十分。長すぎない)。(3)下記仕様に該当機能があれば『できます』と答え、必ず操作場所まで案内する。『仕様にありません』と安易に断らない。(4)本当に仕様に無い/個別の契約・請求・不具合の確定対応のみ、運営(cablueie.123@gmail.com)へ案内。(5)アプリと無関係な質問は丁寧にお断り。前置き・自己紹介は不要。",
  "",
  "【概要】整備士向けアプリ。車検証をスキャンして車両を識別し、メンテナンス諸元・AI故障診断・修理手順・整備カルテを現場で使える。データは端末内に保存。契約店舗は社内の全端末で自動共有。個人向けの「MECHANO-AI Pocket」(Web版・ブラウザ)は7日無料→月額¥500。法人向けは「MECHANO-AI Works」。",
  "【画面】下タブ=スキャン/履歴/DB編集/設定。車両を開くと上部に 車両/メンテ/診断/修理/カルテ。",
  "【車検証スキャン】QRを枠いっぱいに明るく撮る。読めなければ『写真でScan(全体)』。QRが複数ある車検証は『2つずつ』写す。",
  "【メンテナンス諸元(メンテ)】AIがエンジンオイル量・締付トルク(ホイールナット/前後ハブベアリングナット/アクスルフランジ等)・油脂類・粘度・車台/エンジン打刻位置・OBD検査対象などを取得。国産乗用車のオイル量・粘度はHKS適合表の実データを内蔵し検索なしでも即表示。『最新に更新』で取り直し、各項目右上の🔄で個別取り直し。手動訂正値は緑で固定・保持。",
  "【診断】DTC(ダイアグコード)を入力、または写真・動画(約30秒まで自動圧縮)を添付。複数のDTC・症状は『1つの故障像』に統合し最有力の根本原因を特定。",
  "【修理】作業名を入れると 取り付け位置/所要時間/部品注文リスト/別途必要な工具(SST・あると便利)/特殊作業/交換手順/締付トルク を表示。各項目はタップで開く折り畳み式。部品名や工具をタップすると楽天/Yahoo!/Amazonの購入リンクがポップアップ。写真・動画添付可。",
  "【整備カルテ】作業記録を残す。『📷写真で入力』はアウトカメラで直接撮影、何枚でも追加・自動圧縮、AIが手書きメモを読み取り各項目に整理。カルテの『交換部品・使用材料』欄に油脂類を量付きで書いて保存すると(例:エンジンオイル 4.5L)、その実績量がメンテ諸元に自動反映(緑で確定)。担当者に指定された本人が編集権限を持ち、担当者変更で編集権限も移る(苗字/名前・漢字/カナ/かな/ローマ字で本人特定)。",
  "【会社共有・参加】契約店舗は車両・カルテを全端末で共有。メンバーは代表管理者の承認で参加(設定→クラウド同期→『会社に参加』でメール・パスワード・事業所IDを入力→承認待ち)。1人2端末まで。代表管理者は複数人指名できる(メンバー管理→『代表者に』)。",
  "【入庫管理ボード(法人)】車検証をスキャンすると区分ポップアップ(車検/定期点検/一般修理/板金)が出て、選ぶと『入庫ボード』に色分け表示。区分フィルター、費用回収の状態(未回収→回収済→自社立替、車検のみ・タップで切替)、車両ごとのコメント、確認レ点(カード右上の丸を1タップでON/OFF・担当ごとの色。未選択カードは選択してから操作)を管理。手動で入庫追加も可。ホーム画面の『入庫状況』(管理者・ログイン中)で、担当者を名簿から選んで設定、行を横スワイプで出庫。事務専用モード(ログイン画面で選択、または設定)にすると入庫ボードだけのシンプル画面になりスキャン/AIは非表示。すべて全端末で自動同期。",
  "【通知(プッシュ)】アプリを開いていなくても届く通知。新しい入庫→事務モード端末＋管理者、参加申請→運営管理者、へプッシュ。有効化は設定または入庫管理バーの『🔔通知を許可』を1回タップ。Android Chromeやホーム画面に追加したアプリで動作(iPhoneはホーム画面に追加したPWAのみ・Safariのタブ単体やLINE等のアプリ内ブラウザは不可)。通知が『許可されませんでした』の場合はブラウザ側でこのサイトの通知がブロックされている→アドレスバー左の鍵/ⓘアイコン→サイトの設定→通知を『許可』→再読み込み。MECHANO-AI Pocket（個人向け）には通知機能はなし。",
  "【追加で相談/質問】診断・修理の結果の下に相談欄。実施内容・追加の症状・写真・動画を足して『メカ君に追加で相談/質問』すると、前回の結果と統合して精度高く再回答(対象車両を保持し他メーカーのコードと混同しない)。修理でも追加質問でき、手順やトルクの続きを聞ける。何度でも連鎖可能。",
  "【音声入力】各入力欄の🎤ボタンで声で入力。話の途中で無音になっても自動で認識を続けるので、話すたびに押し直す必要はない。停止はもう一度🎤、または相談/解析ボタンを押すと自動でオフ。",
  "【調べる車両の切替】別の車両を開くと、診断・修理の入力欄に残っていた写真・動画・コメントは自動でクリア(前の車両のものが混ざらない)。保存済みの診断結果は車両ごとに保持。",
  "【ログイン・パスワード・メール】設定→クラウド同期。◆パスワードを変更したい: ログイン中に『🔑パスワード変更』ボタン→新パスワード(6文字以上)を入力。◆メールを変更したい: 『✉メール変更』ボタン→新メールを入力(Auth・社内データ両方更新)。◆パスワードを忘れた: ログイン画面の『パスワードを忘れた方(再設定メール)』でメール送信(届かない時は迷惑メール確認/差出人 noreply@mecanoai.firebaseapp.com)。メールが届かない場合は、代表管理者がメンバー管理→『パスワード』で一時パスワードを発行→本人がそれでログイン→『🔑パスワード変更』で任意のパスワードに変更、が確実(メール不要)。",
  "【AIの用意】個人利用は設定タブで無料のGeminiキー(カード不要)を登録。契約店舗はサーバー経由で鍵登録不要。常に最新のGeminiを使用。",
  "【料金プラン(法人)】3段階。NA=裏取り検索なし(標準AI・全機能可)。ターボ=AI Pro＋裏取り検索(月500回)。ツインターボ=AI Pro＋裏取り検索(無制限・検索を使えるのは席数まで=標準3席、4席目〜+¥3,000/席)。『裏取り検索』はGoogle検索で実データを確認し精度を上げる機能(診断・修理で有効)。現在の契約特典は設定→『契約・プラン』にグレード別に表示。プラン変更・席追加は同画面(代表管理者)または運営。支払いは月額/年契約。",
  "【MECHANO-AI Pocket（個人向け・Web版）】ブラウザで利用(mechanoai-cablueie.com)。最初の7日間は全機能無料、8日目以降は月額¥500。ログイン画面の『Pocket ＞ 7日間無料ではじめる』でメール入力→ID・パスが自動で届く。スマホはホーム画面に追加すればアプリのように使える。※App Store/Google Playのストア版は現在準備中。",
  "【困った時】『AIが混み合っています』は少し時間をおいて再試行。諸元が遅い/出ない時は『最新に更新』や個別🔄、契約店舗はプラン有効期限を確認。データは端末を削除すると消えるので大切な記録は控えを。アプリが古い時は設定下部『アプリを最新に更新』(MECHANO-AI Pocketはブラウザの再読み込みで最新に)。",
  "【連絡先】解決しない場合・契約や不具合の確定対応は cablueie.123@gmail.com。",
].join("\n");
(function initSupportChat() {
  const msgs = document.getElementById("scMsgs"), inp = document.getElementById("scIn"),
    send = document.getElementById("scSend");
  if (!msgs || !inp || !send) return;
  const history = [];   // {role:"user"|"bot", text}
  let busy = false;
  // Botの返答に含まれる簡易マークダウン(**太字**・箇条書き)を、見やすいHTMLに整形する。
  //  ・「**」がそのまま表示される問題の対策。AI出力なので必ずHTMLエスケープしてから装飾。
  function escHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function formatBotHtml(text) {
    return String(text == null ? "" : text).split(/\n/).map(ln => {
      let t = ln.replace(/^\s*(?:[\*\-•]|\d+[.)])\s+/, "・");   // 行頭の箇条書き/番号記号 → ・
      t = escHtml(t);
      t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/__(.+?)__/g, "<b>$1</b>");   // **太字** / __太字__
      t = t.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1$2");   // 残った単独 * を除去(斜体記法は非対応)
      return t;
    }).join("<br>");
  }
  function setBot(el, text) { el.innerHTML = formatBotHtml(text); }
  function append(role, text) {
    const row = document.createElement("div");
    row.className = "scRow " + (role === "user" ? "scRowUser" : "scRowBot");
    if (role !== "user") { const av = document.createElement("div"); av.className = "scAv"; av.innerHTML = '<img src="img/mecha.png" alt="メカ君">'; row.appendChild(av); }
    const el = document.createElement("div");
    el.className = "scMsg " + (role === "user" ? "scUser" : "scBot");
    if (role === "user") el.textContent = text; else el.innerHTML = formatBotHtml(text);
    row.appendChild(el);
    msgs.appendChild(row); msgs.scrollTop = msgs.scrollHeight;
    return el;
  }
  // 入力欄を文字量に応じて自動拡大(最大6行)
  function grow() { inp.style.height = "auto"; inp.style.height = Math.min(inp.scrollHeight, 150) + "px"; }
  inp.addEventListener("input", grow);
  async function ask(q) {
    q = (q || "").trim(); if (!q || busy) return;
    if (!aiOK()) {
      append("user", q);
      append("bot", "いまAIをご利用いただけません。個人利用の方は設定タブで無料のGeminiキーを登録、契約店舗の方はログイン後にお使いください。お急ぎの場合は cablueie.123@gmail.com へご連絡ください。");
      inp.value = ""; return;
    }
    busy = true; send.disabled = true; inp.value = ""; grow();
    append("user", q); history.push({ role: "user", text: q });
    const bot = append("bot", "メカ君が考え中…");
    try {
      const convo = history.slice(-6).map(m => (m.role === "user" ? "ユーザー: " : "メカ君: ") + m.text).join("\n");
      const prompt = SUPPORT_KB + "\n\n【これまでの会話】\n" + convo + "\n\n【ユーザーの質問】\n" + q + "\n\n【回答】";
      const r = await geminiAsk(prompt, { mode: "flash", noCache: true, maxTokens: 1024 });
      const ans = (r && r.text) ? r.text.trim() : "うまく答えられませんでした。cablueie.123@gmail.com へお問い合わせください。";
      setBot(bot, ans); history.push({ role: "bot", text: ans });
    } catch (e) {
      bot.textContent = "エラーが発生しました（" + (e.message || e) + "）。cablueie.123@gmail.com へお問い合わせください。";
    } finally { busy = false; send.disabled = false; msgs.scrollTop = msgs.scrollHeight; }
  }
  send.addEventListener("click", () => ask(inp.value));
  // Enterで送信 / Shift+Enterで改行
  inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(inp.value); } });
  // 初回あいさつ
  append("bot", "こんにちは、サポートのメカ君です🔧 このツールの使い方や仕様について、なんでも聞いてください。");
})();

/* ============================================================
   法人向け 無料デモ(ログイン不要・サンプルデータ・APIコストゼロ)
   URL に ?demo=1 を付けると起動。営業チラシ/QRから飛ばせる。
   AIはサーバーを呼ばず固定サンプルを返すため課金ゼロ。
   ============================================================ */
const DEMO_VEHICLE = {
  type: "3BD-S710V", vin: "S710V-0012345", plate: "大阪 480 あ 12-34",
  engine: "KF", kataShitei: "1234-5678", name: "デモ整備工場 サンプル車両",
  firstReg: { year: 2023, month: 4 }, qrRaw: []
};
const DEMO_SPECS = [
  { k: "エンジンオイル量", v: "2.9L（オイルのみ）／3.1L（エレメント同時交換）" },
  { k: "推奨オイル粘度", v: "0W-20（省燃費指定。無ければ5W-30）" },
  { k: "クーラント量", v: "約4.0L（スーパーLLC）" },
  { k: "ホイールナット締付トルク", v: "85 N·m" },
  { k: "ミッション（CVTフルード）", v: "約3.5L（要点検・規定に従う）" },
  { k: "車台番号の打刻位置", v: "助手席シート下のフロア（めくりカバー内）" },
  { k: "エンジン型式の打刻位置", v: "シリンダーブロック前面" }
];
const DEMO_FAULTS = [
  "イグニッションコイル劣化による失火（アイドリング不調・チェックランプ点灯）が中〜高走行で出やすい",
  "CVTの発進ジャダー（微振動）。フルード劣化時に顕著",
  "タイミングチェーン系の冷間始動時異音（高走行車）"
];
const DEMO_RECALLS = [];
const DEMO_REPAIR = {
  isWork: true,
  location: "フロント左右のブレーキキャリパー。タイヤを外し、ディスクローターを挟むキャリパー内にパッドがあります（軽トラは作業スペースが狭いので注意）。",
  time: "約0.5〜0.8時間（左右）",
  order: [
    { name: "フロントブレーキパッド", qty: "1", kind: "本体", step: 3 },
    { name: "パッド鳴き止めグリス", qty: "1", kind: "同時交換推奨" }
  ],
  torque: "キャリパー取付ボルト: 27 N·m / ホイールナット: 85 N·m",
  special: "EPB（電動パーキングブレーキ）装着車は整備モードへの移行・解除が必要（診断機または手動操作）",
  manualService: {
    name: "手動でのEPB整備モード移行・解除手順（診断機不要）",
    steps: [
      "イグニッションをON（エンジンはかけない）にする",
      "ブレーキペダルを踏み込んだまま、EPBスイッチを引き上げてから押し下げる操作を指定回数行い、作動音でリリースを確認",
      "パッド交換後は逆手順でEPBを復帰させ、数回作動させて当たりを出す",
      "最後にイグニッションOFF→ONでDTC（故障コード）が出ていないか確認する"
    ]
  },
  steps: [
    { text: "車両を安全にジャッキアップし、輪止め・リジッドラックで固定する", tools: ["ジャッキ", "リジッドラック", "輪止め"] },
    { text: "タイヤを外す", tools: ["ラチェット＋21mmソケット"] },
    { text: "キャリパーを外して古いパッドを取り出し、ピストンを戻して新品を組む", tools: ["12mmメガネレンチ", "14mmソケット", "ウォーターポンププライヤー", "マイナスドライバー"] },
    { text: "組付け・規定トルクで締付、ブレーキを数回踏んで当たりを出す", tools: ["トルクレンチ(締付 85N·m)"] }
  ],
  answer: ""
};
function isDemo() { try { return sessionStorage.getItem("ss_demo") === "1"; } catch (e) { return false; } }
/* ログインゲート: 法人モードで未ログイン&非デモなら全画面のログイン案内を出す(誰でも使える状態にしない) */
let _authResolved = false;
window._gateBypass = window._gateBypass || false;   // ログインフォーム操作中だけゲートを一時退避(設定画面に居る間のみ)
// 一度でもゲートが必要になったら、ログイン/デモを完了するまで必須にする(モード切替や「戻る」で回避させない)
function needAuthSticky() { try { return sessionStorage.getItem("ss_needAuth") === "1"; } catch (e) { return false; } }
function refreshAuthGate() {
  const gate = $("authGate"); if (!gate) return;
  const loggedIn = !!(window.Cloud && typeof window.Cloud.isLoggedIn === "function" && window.Cloud.isLoggedIn());
  const personal = (typeof getAppMode === "function" && getAppMode() === "personal");
  // 一度ログインした端末は再ログインを求めない(更新・再読込で認証復元が遅れてもゲートを出さない)
  let hadSession = false; try { hadSession = localStorage.getItem("ss_hadSession") === "1"; } catch (e) {}
  // 認証状態が未解決の初回はゲートを出さない(ログイン済みユーザーへのちらつき防止)
  // 未ログインなら法人・個人どちらのモードでもゲートを出す(未認証のままメイン画面へ入れない)。
  let gated = _authResolved && !isDemo() && !loggedIn && !hadSession;
  // 一度ゲートが立ったら、ログイン/デモ完了まで必須を維持(モードを個人へ切替えても解除しない)
  if (gated) { try { sessionStorage.setItem("ss_needAuth", "1"); } catch (e) {} }
  else if (loggedIn || isDemo()) { try { sessionStorage.removeItem("ss_needAuth"); } catch (e) {} }
  if (!gated && needAuthSticky() && !loggedIn && !isDemo() && !hadSession) gated = _authResolved;
  // 設定画面でログインフォームを操作している間だけ、ゲートを一時的に隠す
  const block = gated && !(window._gateBypass && curView === "settings");
  gate.classList.toggle("hidden", !block);
  document.body.classList.toggle("gated", block);
  try { updatePocketAccountBox(); } catch (e) {}
}
window.updateAuthGate = function () { _authResolved = true; refreshAuthGate(); };
(function bindAuthGate() {
  const g = document.getElementById("authGate"); if (!g) return;
  const toSettings = (mode) => {
    window._gateBypass = true;   // ログインフォーム操作のため一時退避
    try { switchView("settings"); } catch (e) {}
    refreshAuthGate();    // bypass中かつ設定画面なのでゲートは隠れる
    setTimeout(() => {
      if (mode === "login") {
        const b = document.getElementById("btnModeLogin"); if (b) b.click();
      } else {
        // 新規登録/メンバー参加は「選択画面」を表示(管理者として新規登録 / メンバーとして参加を自分で選べる)
        const form = document.getElementById("cloudForm"); if (form) form.classList.add("hidden");
        const ch = document.getElementById("cloudChoice"); if (ch) ch.classList.remove("hidden");
      }
      const el = document.getElementById("secCloudSync"); if (el) el.scrollIntoView({ behavior: "smooth" });
    }, 60);
  };
  // Works=法人モード / Pocket=個人モードに切替えてからログイン(発行IDのエディションと一致させる)
  const l = document.getElementById("agLogin"); if (l) l.addEventListener("click", () => { try { setAppMode("corp"); } catch (e) {} toSettings("login"); });
  const n = document.getElementById("agNew"); if (n) n.addEventListener("click", () => { try { setAppMode("corp"); } catch (e) {} toSettings("choice"); });
  const d = document.getElementById("agDemo"); if (d) d.addEventListener("click", () => { try { startDemo(); } catch (e) {} refreshAuthGate(); });
  // Web版Pocketのログアウト(設定のアカウント欄)
  const plo = document.getElementById("btnPocketLogout");
  if (plo) plo.addEventListener("click", () => {
    if (!confirm("ログアウトしますか？")) return;
    // 既存の同期セクションのログアウト処理(hadSession削除＋signOut)を再利用(個人モードで非表示でもclickは有効)
    const b = document.getElementById("btnCloudLogout");
    if (b) { try { b.click(); } catch (e) {} }
    try { updatePocketAccountBox(); } catch (e) {}
  });
  // Web版Pocketのパスワード変更(既存の同期セクションのボタンを再利用)
  const ppw = document.getElementById("btnPocketChangePw");
  if (ppw) ppw.addEventListener("click", () => {
    const b = document.getElementById("btnCloudChangePw");
    if (b) { try { b.click(); } catch (e) {} }
    else alert("ログインしてからお試しください。");
  });
  const ps = document.getElementById("agPocketStart");
  if (ps) ps.addEventListener("click", () => { try { openPocketApply(); } catch (e) {} });
  const pl = document.getElementById("agPocketLogin"); if (pl) pl.addEventListener("click", () => {
    try { setAppMode("personal"); } catch (e) {}
    // Web版Pocketは専用ログインモーダルを表示(個人モードでは設定内の同期フォームが隠れているため)。
    // Playストア(storeApp)版は従来動作のまま(このモーダルは出さない)。
    if (document.body.classList.contains("storeApp")) { toSettings("login"); return; }
    try { openPocketLogin(); } catch (e) { toSettings("login"); }
  });
  // スマホ・タブレット: Works/Pocket 横スワイプの現在位置をドットに反映 / ドットタップで移動
  const panels = document.querySelector("#authGate .agPanels");
  const dots = document.getElementById("agDots");
  if (panels && dots) {
    const swEls = Array.prototype.slice.call(dots.querySelectorAll(".agSw"));
    const sync = () => {
      const idx = panels.clientWidth ? Math.round(panels.scrollLeft / panels.clientWidth) : 0;
      swEls.forEach((d, i) => d.classList.toggle("agSwOn", i === idx));
    };
    panels.addEventListener("scroll", () => { window.requestAnimationFrame(sync); }, { passive: true });
    swEls.forEach(d => d.addEventListener("click", () => {
      const i = +d.getAttribute("data-idx") || 0;
      panels.scrollTo({ left: i * panels.clientWidth, behavior: "smooth" });
    }));
  }
})();
/* Web版Pocketのログイン: メール(またはID)＋パスワードのモーダルで直接ログイン。
   ・個人モードでは設定内の同期フォームが隠れているため、専用モーダルで受け付ける。
   ・Playストア(storeApp)版では呼ばない(従来動作のまま)。 */
function openPocketLogin() {
  let ov = document.getElementById("pocketLoginOv");
  if (ov) ov.remove();
  ov = document.createElement("div"); ov.id = "pocketLoginOv"; ov.className = "ikModal";
  ov.style.zIndex = "700";   // ログインゲート(z-index:600)より前面に
  ov.innerHTML =
    '<div class="ikCard" style="max-width:360px">' +
      '<div class="ikTitle">Pocket（個人版）にログイン</div>' +
      '<div class="ikVeh" style="text-align:left;line-height:1.6;margin-bottom:6px">発行されたID（メールアドレス）とパスワードを入力してください。</div>' +
      '<input type="email" id="pocketLoginEmail" inputmode="email" autocomplete="username" placeholder="ログインID（メールアドレス）" ' +
        'style="width:100%;box-sizing:border-box;margin:4px 0;padding:12px;border:1px solid var(--line);border-radius:10px;font-size:15px" />' +
      '<input type="password" id="pocketLoginPw" autocomplete="current-password" placeholder="パスワード" ' +
        'style="width:100%;box-sizing:border-box;margin:4px 0 2px;padding:12px;border:1px solid var(--line);border-radius:10px;font-size:15px" />' +
      '<div id="pocketLoginMsg" style="font-size:12.5px;color:#c0392b;min-height:16px;margin:2px 0 6px;text-align:left"></div>' +
      '<button type="button" class="agBtn agPocketLoginBtn" id="pocketLoginSend" style="margin:0">ログイン</button>' +
      '<button type="button" class="ikLater" id="pocketLoginCancel">やめる</button>' +
    '</div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  const cancel = document.getElementById("pocketLoginCancel"); if (cancel) cancel.addEventListener("click", close);
  const emailEl = document.getElementById("pocketLoginEmail");
  const pwEl = document.getElementById("pocketLoginPw");
  const msg = document.getElementById("pocketLoginMsg");
  const send = document.getElementById("pocketLoginSend");
  if (emailEl) emailEl.focus();
  const doLogin = async () => {
    const email = (emailEl.value || "").trim(); const pw = pwEl.value || "";
    if (!email || !pw) { msg.style.color = "#c0392b"; msg.textContent = "IDとパスワードを入力してください。"; return; }
    msg.style.color = "var(--dim)"; msg.textContent = "ログイン中…";
    send.disabled = true; const t0 = send.textContent; send.textContent = "ログイン中…";
    try {
      await window.Cloud.login(email, pw);
      close();   // 認証確定後はonAuthStateChangeがゲートを閉じてメイン画面へ
    } catch (e) {
      msg.style.color = "#c0392b";
      const m = (e && e.message) || String(e);
      msg.textContent = /password|user-not-found|invalid|credential|見つかりません/i.test(m)
        ? "IDまたはパスワードが正しくありません。" : ("ログインに失敗しました: " + m);
      send.disabled = false; send.textContent = t0;
    }
  };
  send.addEventListener("click", doLogin);
  pwEl.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
}
/* 個人版(Pocket)の申込: メールアドレスを受け取り、その場でPocket専用ID/パスを自動発行する。
   ・発行されるアカウントはPocket専用(Worksでは使用不可)。7日間無料 → 月額¥500。 */
function openPocketApply() {
  let ov = document.getElementById("pocketApplyOv");
  if (ov) ov.remove();
  ov = document.createElement("div"); ov.id = "pocketApplyOv"; ov.className = "ikModal";
  ov.style.zIndex = "700";   // ログインゲート(z-index:600)より前面に出す(背面に隠れて入力欄が見えない不具合の対策)
  ov.innerHTML =
    '<div class="ikCard" style="max-width:360px">' +
      '<div class="ikTitle">Pocket（個人版）を始める</div>' +
      '<div class="ikVeh" style="text-align:left;line-height:1.7">' +
        'メールアドレスをご登録ください。<b>Pocket専用のID・初期パスワード</b>を自動で発行し、すぐにメールでお送りします。<br>' +
        '<span style="font-size:12px;color:var(--dim)">7日間無料 → 月額¥500。このIDは個人版(Pocket)専用で、法人版(Works)ではご利用いただけません。</span>' +
      '</div>' +
      '<input type="email" id="pocketApplyEmail" inputmode="email" autocomplete="email" placeholder="you@example.com" ' +
        'style="width:100%;box-sizing:border-box;margin:4px 0 2px;padding:12px;border:1px solid var(--line);border-radius:10px;font-size:15px" />' +
      '<div id="pocketApplyMsg" style="font-size:12.5px;color:#c0392b;min-height:16px;margin:2px 0 6px;text-align:left"></div>' +
      '<button type="button" class="agBtn agPocketLoginBtn" id="pocketApplySend" style="margin:0">この内容で申し込む</button>' +
      '<button type="button" class="ikLater" id="pocketApplyCancel">やめる</button>' +
    '</div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  const cancel = document.getElementById("pocketApplyCancel"); if (cancel) cancel.addEventListener("click", close);
  const input = document.getElementById("pocketApplyEmail");
  const msg = document.getElementById("pocketApplyMsg");
  const send = document.getElementById("pocketApplySend");
  if (input) input.focus();
  send.addEventListener("click", async () => {
    const email = (input.value || "").trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { msg.textContent = "メールアドレスの形式をご確認ください。"; return; }
    msg.textContent = "";
    send.disabled = true; const t0 = send.textContent; send.textContent = "送信中…";
    try {
      const r = await fetch("https://asia-northeast1-mecanoai.cloudfunctions.net/bizInquiry", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "pocket", intent: "pocket", email: email,
          company: "個人（Pocket）", name: "", plan: "Pocket 個人版",
          message: "Pocket（個人版）の利用申込。Pocket専用ID/パスの発行を希望。" }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d && d.ok !== false) {
        ov.querySelector(".ikCard").innerHTML =
          '<div class="ikTitle">お申し込みを受け付けました</div>' +
          '<div class="ikVeh" style="text-align:left;line-height:1.8">' +
            '<b>' + email.replace(/</g, "&lt;") + '</b> 宛に、<b>Pocket専用のID・初期パスワード</b>を自動でお送りしました。<br>' +
            '<span style="font-size:12px;color:var(--dim)">ログインIDは今のメールアドレスです。メールに記載の初期パスワードで「Pocket ＞ ログイン」からご利用ください（数分で届かない場合は迷惑メールもご確認ください）。</span>' +
          '</div>' +
          '<button type="button" class="agBtn agPocketLoginBtn" id="pocketApplyDone" style="margin:0">閉じる</button>';
        const done = document.getElementById("pocketApplyDone"); if (done) done.addEventListener("click", close);
        return;
      }
      msg.style.color = "#c0392b"; msg.textContent = (d && d.error) || "送信に失敗しました。時間をおいて再度お試しください。";
    } catch (e) {
      msg.style.color = "#c0392b"; msg.textContent = "通信に失敗しました: " + (e.message || e);
    }
    send.disabled = false; send.textContent = t0;
  });
}
/* デモ用のAI固定回答。プロンプト内容から諸元/修理/会話を判定して返す(ネットワーク未使用) */
function demoAnswer(prompt) {
  const p = String(prompt || "");
  let text;
  if (/"isWork"|修理|作業/.test(p) && /JSON/.test(p)) {
    text = JSON.stringify(DEMO_REPAIR);
  } else if (/"specs"|メンテナンス諸元|諸元/.test(p)) {
    text = JSON.stringify({ model: "ダイハツ ハイゼットカーゴ", maker: "daihatsu", specs: DEMO_SPECS, faults: DEMO_FAULTS, recalls: DEMO_RECALLS });
  } else {
    text = (window.APP_LANG === "en")
      ? "(Demo sample answer) Thanks for your question. In the full version, Mecha AI tailors specific maintenance advice, cause isolation, required tools and tightening torque to the scanned vehicle's model, engine and year. Let's check the inspection points one by one."
      : "（デモ用サンプル回答）ご質問ありがとうございます。本契約版では、読み込んだ車両の型式・原動機・年式に合わせて、メカ君AIが具体的な整備アドバイス・原因の切り分け・必要な工具や締付トルクまで回答します。まずは点検箇所を順に確認していきましょう。";
  }
  return Promise.resolve({ text, truncated: false, model: "demo" });
}
function showDemoBanner() {
  if (document.getElementById("demoBanner")) return;
  const b = document.createElement("div"); b.id = "demoBanner";
  b.innerHTML = '<span class="demoTxt">🎬 これは<b>無料デモ</b>です（ログイン不要・サンプルデータ）。本契約で全機能・自社データが使えます。</span>' +
    '<span class="demoBtns"><a class="demoCta" href="mailto:ai@reply.mechanoai-cablueie.com?subject=' + encodeURIComponent("MECHANO-AI Works の申込・相談") + '">申込・相談</a>' +
    '<button type="button" id="demoExit" class="demoExit">デモ終了</button></span>';
  document.body.appendChild(b);
  document.body.classList.add("hasDemoBanner");
  const ex = document.getElementById("demoExit");
  if (ex) ex.addEventListener("click", () => { try { sessionStorage.removeItem("ss_demo"); } catch (e) {} location.href = location.pathname; });
}
function startDemo() {
  try { sessionStorage.setItem("ss_demo", "1"); } catch (e) {}
  document.body.classList.add("demoMode");
  showDemoBanner();
  // サンプル車両の諸元・故障を端末に記憶させ、AIを呼ばずにメンテ/診断へ表示
  try { setLearned(vehicleKey(DEMO_VEHICLE), { model: "ダイハツ ハイゼットカーゴ", maker: "daihatsu", specs: DEMO_SPECS, faults: DEMO_FAULTS, recalls: DEMO_RECALLS, specDone: true }); } catch (e) {}
  try { showResult(Object.assign({}, DEMO_VEHICLE), {}); } catch (e) {}
  // ★URL(?demo=1)経由でもログインゲートを確実に解除(でないとゲートが前面に残り体験ガイドが操作できない)
  try { if (typeof refreshAuthGate === "function") refreshAuthGate(); } catch (e) {}
  // ★デモUIが整ってから体験ガイドを確実に開始。デモを開いたら毎回自動で走らせる(force=true)。
  try { setTimeout(function () { if (window.mechaStartTour) window.mechaStartTour(true); }, 900); } catch (e) {}
}
(function initDemo() {
  let on = false;
  try { on = new URLSearchParams(location.search).get("demo") === "1" || sessionStorage.getItem("ss_demo") === "1"; } catch (e) {}
  if (!on) return;
  const go = () => setTimeout(startDemo, 350);
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go);
})();
/* Pocket決済(Stripe Checkout)からの戻り。?pocket=success で登録完了メッセージ、cancel で軽い案内。 */
(function initPocketReturn() {
  let p = ""; try { p = new URLSearchParams(location.search).get("pocket") || ""; } catch (e) { return; }
  if (!p) return;
  try { history.replaceState(null, "", location.pathname); } catch (e) {}
  setTimeout(() => {
    if (p === "success") {
      alert("✓ ご登録ありがとうございます。月額プランが有効になりました。反映まで数十秒かかる場合があります。");
      try { const b = document.getElementById("pwBanner"); if (b) b.remove(); const ov = document.getElementById("pocketPayOv"); if (ov) ov.remove(); } catch (e) {}
    } else if (p === "cancel") {
      alert("登録はキャンセルされました。いつでも設定タブや残日数バナーから登録できます。");
    }
  }, 600);
})();
