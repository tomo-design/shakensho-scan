"use strict";
/*! メカノAI 個人版ペイウォール (Google Play サブスク / Play Billing)
   仕様: インストール〜7日間は全機能フリー。8日目以降は月額¥500(personal_monthly)の
   Google Play定期購入で解放。Web版/法人版(TWA以外)にはペイウォールを一切かけない。 */
(function () {
  const SUB_ID = "personal_monthly";                 // Play Console の定期購入 商品ID と一致必須
  const BILLING = "https://play.google.com/billing";  // Digital Goods API 支払い方式
  const TRIAL_DAYS = 7;
  const LS_TRIAL = "ss_trialStart";       // トライアル開始時刻(ms)
  const LS_ENTITLED = "ss_subEntitled";   // 直近の課金判定キャッシュ("1"=契約中)
  const PRICE_LABEL = "月額 ¥500";

  /* ストア(Google Play / TWA)配布版でのみペイウォールを有効化する */
  function isNative() {
    try {
      return !!window.Capacitor ||
        (document.referrer || "").startsWith("android-app://") ||
        new URLSearchParams(location.search).get("native") === "1" ||
        localStorage.getItem("ss_nativeApp") === "1";
    } catch (e) { return false; }
  }

  /* --- トライアル管理 --- */
  function trialStart() {
    let t = +localStorage.getItem(LS_TRIAL);
    if (!t || isNaN(t)) { t = Date.now(); try { localStorage.setItem(LS_TRIAL, String(t)); } catch (e) {} }
    return t;
  }
  function msLeft() { return TRIAL_DAYS * 86400000 - (Date.now() - trialStart()); }
  function inTrial() { return msLeft() > 0; }
  function daysLeft() { return Math.max(0, Math.ceil(msLeft() / 86400000)); }

  /* --- Digital Goods API (Play Billing) --- */
  async function getService() {
    if (!("getDigitalGoodsService" in window)) return null;
    try { return await window.getDigitalGoodsService(BILLING); } catch (e) { return null; }
  }
  async function hasActiveSub(svc) {
    if (!svc) return false;
    try {
      const list = await (svc.listPurchases ? svc.listPurchases() : []);
      return Array.isArray(list) && list.some(p => p.itemId === SUB_ID);
    } catch (e) { return false; }
  }
  function setEntitled(on) { try { localStorage.setItem(LS_ENTITLED, on ? "1" : "0"); } catch (e) {} }

  /* 購入フロー: PaymentRequest + Play Billing。成功でサーバー検証(可能なら)→解放。 */
  async function purchase() {
    const svc = await getService();
    if (!svc || typeof PaymentRequest === "undefined") {
      alert("この端末では購入手続きができません。Google Play からインストールしたアプリでお試しください。");
      return false;
    }
    let btn = document.getElementById("pwBuyBtn");
    if (btn) { btn.disabled = true; btn.textContent = "処理中…"; }
    try {
      const pr = new PaymentRequest(
        [{ supportedMethods: BILLING, data: { sku: SUB_ID } }],
        { total: { label: "メカノAI " + PRICE_LABEL, amount: { currency: "JPY", value: "500" } } }
      );
      const resp = await pr.show();
      const d = resp.details || {};
      const token = d.token || d.purchaseToken || (d.purchase && d.purchase.token) || "";
      // サーバー検証・承認(acknowledge)。未設定でも購入自体は成立させる。
      try { await verifyOnServer(token); } catch (e) {}
      await resp.complete("success");
      setEntitled(true);
      hidePaywall();
      return true;
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "続ける（" + PRICE_LABEL + "）"; }
      return false;
    }
  }

  /* Cloud Function に purchaseToken を渡してPlay Developer APIで検証・承認。
     関数URLが未配備でも例外を握りつぶし、UIは進める(検証は後追い可)。 */
  const FN_BASE = "https://asia-northeast1-mecanoai.cloudfunctions.net";
  async function verifyOnServer(token) {
    if (!token) return;
    await fetch(FN_BASE + "/verifyPlaySub", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token, sku: SUB_ID })
    });
  }

  /* --- ペイウォールUI --- */
  function buildPaywall() {
    if (document.getElementById("pwOverlay")) return;
    const ov = document.createElement("div");
    ov.id = "pwOverlay";
    ov.innerHTML =
      '<div class="pwCard">' +
      '  <img src="icons/icon-192.png" alt="" class="pwLogo">' +
      '  <h2>無料期間が終了しました</h2>' +
      '  <p class="pwLead">メカノAI をこれからも使うには、月額プランのご登録が必要です。</p>' +
      '  <div class="pwPrice"><span class="pwYen">¥500</span><span class="pwPer">／月</span></div>' +
      '  <ul class="pwFeat">' +
      '    <li>車検証スキャン・車両DB・整備カルテ</li>' +
      '    <li>AIメンテナンス諸元・締付トルク</li>' +
      '    <li>AI故障診断・修理サポート</li>' +
      '  </ul>' +
      '  <button id="pwBuyBtn" class="pwBuy">続ける（' + PRICE_LABEL + '）</button>' +
      '  <button id="pwRestore" class="pwRestore">購入を復元</button>' +
      '  <p class="pwNote">お支払いはGoogle Playを通じて行われ、いつでも解約できます。' +
      '<br><a href="terms.html" target="_blank" rel="noopener">利用規約</a> ・ ' +
      '<a href="privacy.html" target="_blank" rel="noopener">プライバシーポリシー</a></p>' +
      '</div>';
    document.body.appendChild(ov);
    document.getElementById("pwBuyBtn").addEventListener("click", purchase);
    document.getElementById("pwRestore").addEventListener("click", async () => {
      const svc = await getService();
      if (await hasActiveSub(svc)) { setEntitled(true); hidePaywall(); }
      else alert("有効な購入が見つかりませんでした。");
    });
  }
  function showPaywall() { buildPaywall(); document.body.classList.add("pwLocked"); }
  function hidePaywall() { document.body.classList.remove("pwLocked"); const ov = document.getElementById("pwOverlay"); if (ov) ov.remove(); }

  /* トライアル中の残日数バナー(任意・控えめ) */
  function showTrialBanner() {
    if (document.getElementById("pwBanner")) return;
    const n = daysLeft();
    const b = document.createElement("div");
    b.id = "pwBanner";
    b.textContent = "無料お試し 残り" + n + "日";
    document.body.appendChild(b);
    setTimeout(() => { if (b.parentNode) b.remove(); }, 6000);
  }

  /* --- 起動時ゲート --- */
  async function gate() {
    if (!isNative()) return;   // Web/法人版はペイウォール対象外
    trialStart();
    const svc = await getService();
    if (svc) {                 // Play課金が使える環境: listPurchasesが正
      const active = await hasActiveSub(svc);
      setEntitled(active);
      if (active) return;
      if (inTrial()) { showTrialBanner(); return; }
      showPaywall();
      return;
    }
    // 課金サービスが取れない(オフライン等): キャッシュ or トライアルで判定
    if (localStorage.getItem(LS_ENTITLED) === "1") return;
    if (inTrial()) { showTrialBanner(); return; }
    showPaywall();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", gate);
  else gate();

  window.Paywall = { gate: gate, purchase: purchase, daysLeft: daysLeft, inTrial: inTrial };
})();
