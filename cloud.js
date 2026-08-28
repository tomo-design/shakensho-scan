"use strict";
/*! メカノAI (MECHANO-AI) © 2026 Cablueie. All Rights Reserved. 無断複製・改変・再配布・リバースエンジニアリングを禁じます。 */
/* =========================================================
   クラウド同期(社内共有) — Firebase(無料Sparkプラン)
   3階層: super(運営=あなた) / admin(会社の代表管理者) / staff(従業員)
   権限はusersドキュメント(role/active/tenantId)で管理しFirestoreルールで強制。
   同期対象: tenants/{tid}/vehicles(車種DB) と records(車両:ナンバー・使用者含む)
   ========================================================= */
(function () {
  const firebaseConfig = {
    apiKey: "AIzaSyAH5tBm9VDMYas1X0pNBBYHxKO3nfTrEYI",
    authDomain: "mecanoai.firebaseapp.com",
    projectId: "mecanoai",
    storageBucket: "mecanoai.firebasestorage.app",
    messagingSenderId: "126560659288",
    appId: "1:126560659288:web:627b913aef320e7e76a72d"
  };
  // このメールでログインした人は自動で「運営管理者(super)」になる(ログイン用・変更時は firestore.rules も要修正)
  const OWNER_EMAIL = "cablueie.123@gmail.com";
  // 利用者に見せる運営の問い合わせ先メール(表示用)
  const OPERATOR_EMAIL = "cablueie.123@gmail.com";
  // 申し込み(プラン選択・購入)ページのURL。決済サイト(Stripe等)を用意したらここに設定。
  // 空のあいだは「準備中」を表示する。事業所IDを付けて開き、支払い完了で運営に通知が届く設定にする。
  const SIGNUP_URL = "";   // 例: "https://buy.stripe.com/xxxx"
  const CANCEL_URL = "";   // 解約(サブスク管理)ページ。空なら問い合わせ導線。
  if (typeof firebase === "undefined") { console.warn("Firebase未読込(オフライン等)。クラウド同期はスキップ"); return; }

  let auth, db;
  const FN_REGION = "asia-northeast1";   // Cloud Functions のリージョン(AIプロキシ/決済)
  try { firebase.initializeApp(firebaseConfig); auth = firebase.auth(); db = firebase.firestore(); }
  catch (e) { console.warn("Firebase初期化失敗", e); return; }
  // ログイン状態を端末に永続化(自動ログアウトを防ぐ)。サインイン前に必ず確定させる
  const persistReady = (async () => {
    try { await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); }
    catch (e) { console.warn("setPersistence失敗(既定の永続化を使用)", e); }
  })();

  const $ = id => document.getElementById(id);
  const show = (id, v) => { const el = $(id); if (el) el.classList.toggle("hidden", !v); };
  let me = null;        // {uid,email}
  let profile = null;   // {tenantId, role, active, devices[], deviceLimit}
  let unsubVeh = null, unsubRec = null, unsubJoin = null, unsubTenant = null, unsubMembers = null;
  let tenantMembers = [];      // 同じ店舗のメンバー名簿(uid/name/nameKana/nameRoma) — カルテ担当者の照合に使用
  let deviceBlocked = false;   // この端末が未許可(制限超過)なら true
  let tenantDoc = null;        // {plan, paidUntil, ...} 店舗の契約状態
  let planBlocked = false;     // 店舗が未払い/停止なら true
  let planPageshowBound = false; // 支払いページから戻った時のリセット用リスナ登録済みフラグ

  /* ---------- 店舗プラン(月額) ---------- */
  // plan: "active"(課金中) / "trial"(試用) / "suspended"(停止)。未設定は当面「有効」とみなす(既存利用を壊さない)
  function planActive() {
    if (!tenantDoc) return true;                       // 情報が無ければ従来どおり有効
    if (tenantDoc.plan === "suspended") return false;  // 明示停止
    if (tenantDoc.paidUntil && Number(tenantDoc.paidUntil) < Date.now()) return false;  // 期限切れ
    return true;                                        // active / trial / 未設定
  }
  // AIプラン(検索裏取りの段階)。aiPlan: na/turbo/twinturbo。旧 aiPaidFallback も互換解釈。
  function tierCode(td) {
    td = td || tenantDoc || {};
    if (td.aiPlan === "turbo" || td.aiPlan === "twinturbo" || td.aiPlan === "na") return td.aiPlan;
    return td.aiPaidFallback === true ? "twinturbo" : "na";   // 旧データ互換
  }
  const TIER_NAME = { na: "NA", turbo: "ターボ", twinturbo: "ツインターボ" };
  function tierName(td) { return TIER_NAME[tierCode(td)] || "NA"; }
  function planLabel() {
    if (!tenantDoc) return "";
    const until = tenantDoc.paidUntil ? new Date(Number(tenantDoc.paidUntil)) : null;
    const u = until ? until.toLocaleDateString("ja-JP") : "";
    const tn = "／" + tierName();
    if (tenantDoc.plan === "suspended") return "⛔ 停止中";
    if (tenantDoc.paidUntil && Number(tenantDoc.paidUntil) < Date.now()) return "⛔ 期限切れ（" + u + "）";
    if (tenantDoc.plan === "active") return "✓ 契約中" + tn + (u ? "（〜" + u + "）" : "");
    if (tenantDoc.plan === "trial") return "試用中" + (u ? "（〜" + u + "）" : "");
    return "";
  }

  /* ---------- 端末制限(1従業員 無料2台/3台目以降は有料枠) ---------- */
  const FREE_DEVICE_LIMIT = 2;
  function getDeviceId() {
    let id = localStorage.getItem("ss_deviceId");
    if (!id) { id = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem("ss_deviceId", id); }
    return id;
  }
  function guessDeviceName() {
    const ua = navigator.userAgent || "";
    let os = /iPhone|iPad|iPod/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "端末";
    let br = /Edg/.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : /Firefox/.test(ua) ? "Firefox" : "";
    return (os + (br ? "・" + br : "")).trim();
  }
  function deviceLimitOf() { return (profile && Number(profile.deviceLimit)) || FREE_DEVICE_LIMIT; }
  /* この端末を登録・許可判定。既登録=可 / 空き枠あり=登録して可 / 上限超=不可 */
  async function ensureDeviceAllowed(uid) {
    const devId = getDeviceId();
    let devices = (profile && Array.isArray(profile.devices)) ? profile.devices.slice() : [];
    const limit = deviceLimitOf();
    const i = devices.findIndex(d => d && d.id === devId);
    if (i >= 0) {   // 既に許可された端末: 最終利用日時だけ更新
      devices[i] = Object.assign({}, devices[i], { at: Date.now(), name: devices[i].name || guessDeviceName() });
      try { await db.collection("users").doc(uid).update({ devices }); } catch (e) {}
      if (profile) profile.devices = devices;
      return { ok: true, devices, limit };
    }
    if (devices.length < limit) {   // 空き枠あり: 登録
      devices.push({ id: devId, name: guessDeviceName(), at: Date.now() });
      try { await db.collection("users").doc(uid).update({ devices }); if (profile) profile.devices = devices; return { ok: true, devices, limit }; }
      catch (e) { return { ok: false, devices: (profile && profile.devices) || [], limit, err: e }; }
    }
    // 再インストール救済: アプリを完全削除するとlocalStorageのdeviceIdが消え、同じ実機でも
    // 「新しい端末」として枠を消費してしまう。枠が満杯なら、同じ端末名で最も古い枠を引き継ぐ。
    // (枠の総数は変わらないので上限の意味は保たれる)
    const nm = guessDeviceName();
    const same = devices
      .map((d, idx) => ({ d, idx }))
      .filter(x => x.d && x.d.name === nm)
      .sort((a, b) => (a.d.at || 0) - (b.d.at || 0));
    if (same.length) {
      devices[same[0].idx] = { id: devId, name: nm, at: Date.now() };
      try {
        await db.collection("users").doc(uid).update({ devices });
        if (profile) profile.devices = devices;
        return { ok: true, devices, limit, reclaimed: true };
      } catch (e) { return { ok: false, devices, limit, err: e }; }
    }
    return { ok: false, devices, limit };   // 上限超過(有料枠が必要)
  }
  /* 端末の登録解除(枠を空ける)。本人のみ。 */
  async function removeDevice(devId) {
    if (!me) return;
    const devices = ((profile && profile.devices) || []).filter(d => d && d.id !== devId);
    try {
      await db.collection("users").doc(me.uid).update({ devices });
      if (profile) profile.devices = devices;
      // 自分の端末を外して枠が空いたら、この端末を再登録して同期を再開
      if (deviceBlocked) { const g = await ensureDeviceAllowed(me.uid); if (g.ok) { deviceBlocked = false; startSync(profile.tenantId); } }
      renderDevices(); renderAuthUI();
    } catch (e) { uiAlert("端末の解除に失敗しました: " + (e.message || e)); }
  }
  /* 店舗のお支払い(月額) — 折り畳み。代表管理者のみ表示。決済リンクは後で差し込む。 */
  function renderPlan() {
    const box = $("cloudPlan"); if (!box) return;
    const isAdmin = profile && (profile.role === "admin" || profile.role === "super");
    if (!me || !profile || !profile.active || !isAdmin) { box.innerHTML = ""; show("cloudPlan", false); return; }
    const canCancel = !!(tenantDoc && tenantDoc.plan === "active");
    const active = canCancel;
    const code = tierCode();                       // na / turbo / twinturbo
    const seats = (tenantDoc && tenantDoc.searchSeats) || 3;
    const TN = { na: "NA", turbo: "ターボ", twinturbo: "ツインターボ" };
    const PRICE = { na: "月¥7,980 / 年¥86,000", turbo: "月¥12,800 / 年¥138,000", twinturbo: "月¥19,800 / 年¥198,000" };
    // グレード別のAI特典(現在の契約グレードに応じて出し分け)
    const AI_PERK = {
      na: ["🔧 AIメンテナンス諸元・故障診断・修理サポート（標準）", "🔎 Web裏取り検索：なし"],
      turbo: ["🔧 AIメンテナンス諸元・故障診断・修理サポート", "⚡ AI Pro（高精度）", "🔎 Web裏取り検索：月500回まで"],
      twinturbo: ["🔧 AIメンテナンス諸元・故障診断・修理サポート", "⚡ AI Pro（高精度）", "🔎 Web裏取り検索：無制限", "👥 検索席：" + seats + "席（3席標準・4席目〜+¥3,000/席）"],
    };
    const COMMON = [
      "車両データ・車種DB・整備カルテを社内の全端末で自動共有",
      "メンバーは何人でも参加OK（1人2端末まで）",
      "車検証スキャン・整備カルテをフル機能で利用",
      "更新・新機能を随時反映／優先サポート",
    ];
    const li = a => a.map(x => "<li>" + x + "</li>").join("");
    // 契約中: 現在グレードの特典だけをきれいに表示。未契約: 案内のみ。
    // 契約期間(次回更新/終了日)。paidUntil(ms)がその期間の終わり。
    const paidUntil = tenantDoc && tenantDoc.paidUntil ? Number(tenantDoc.paidUntil) : 0;
    const periodText = paidUntil ? "〜" + new Date(paidUntil).toLocaleDateString("ja-JP") + " まで" : "";
    const perkBlock = active
      ? '<div class="planHead"><span class="planHeadTtl">現在のプラン</span> <span class="tierBadge tier-' + code + '">' + TN[code] + '</span>' +
          (periodText ? '<span class="planPeriod">' + periodText + '</span>' : '') +
        '</div>' +
        '<div class="planPriceRow"><span class="planPrice">' + PRICE[code] + '</span>' +
          (code === "twinturbo" ? '<button type="button" class="btn btn-ghost btn-sm planSeatBtn" id="btnSeatChange">➕ 有料席を追加</button>' : '') +
        '</div>' +
        '<div class="planPerk"><div class="planPerkTtl">このプランでできること</div>' +
          '<ul class="planPerkList">' + li(AI_PERK[code] || AI_PERK.na) + '</ul>' +
          '<div class="planPerkTtl">共通</div><ul class="planPerkList planPerkSub">' + li(COMMON) + '</ul>' +
        '</div>'
      : '<div class="planHead">現在の状態: <b>未契約（無料/試用）</b></div>' +
        '<div class="planNote">下から契約すると、社内共有・フル機能・AIサポートが使えます。</div>';
    // プラン変更/申し込み(契約中は折り畳みでスッキリ)
    const form =
      '<div class="signupForm">' +
        '<div class="fld">プラン</div>' +
        '<label class="signupRadio"><input type="radio" name="signupTier" value="na"' + (code === "na" ? " checked" : "") + '> <b>NA</b>（AI標準・検索なし）</label>' +
        '<label class="signupRadio"><input type="radio" name="signupTier" value="turbo"' + (code === "turbo" ? " checked" : "") + '> <b>ターボ</b>（Pro・検索月500）</label>' +
        '<label class="signupRadio"><input type="radio" name="signupTier" value="twinturbo"' + (code === "twinturbo" ? " checked" : "") + '> <b>ツインターボ</b>（Pro・検索無制限）</label>' +
        '<div class="fld" style="margin-top:8px">お支払い間隔</div>' +
        '<label class="signupRadio"><input type="radio" name="signupPlan" value="monthly" checked> 月額</label>' +
        '<label class="signupRadio"><input type="radio" name="signupPlan" value="yearly"> 年契約（約1ヶ月分お得）</label>' +
        '<div class="planBtns"><button class="btn btn-amber btn-sm" id="btnSignupSend">📝 ' + (active ? "プラン変更・お支払いへ" : "申し込み・お支払いへ進む") + '</button></div>' +
        '<div id="signupStat" class="planNote"></div>' +
      '</div>';
    const formBlock = active
      ? '<details class="planChange"><summary class="secSummary">プランを変更する</summary>' + form + '</details>'
      : form;
    // 8日目の決済導線: 無料お試しが残りわずか/終了なら、画面上にお支払いバナーを出す。
    let bannerBlock = "";
    if (tenantDoc && tenantDoc.plan === "trial" && paidUntil) {
      const dleft = Math.ceil((paidUntil - Date.now()) / 86400000);
      const ended = paidUntil <= Date.now();
      if (ended || dleft <= 2) {
        bannerBlock = '<div style="border-radius:12px;padding:12px 14px;margin-bottom:12px;font-size:13.5px;line-height:1.65;' +
          (ended ? 'background:#fdecea;border:1px solid #e79a9a' : 'background:#fff7e6;border:1px solid #f0c66b') + '">' +
          (ended
            ? '⏰ <b>無料お試し期間が終了しました。</b>続けてご利用いただくには、お支払いのお手続きをお願いします。'
            : '🎁 無料お試しは<b>残り' + Math.max(dleft, 0) + '日</b>です。期間終了（8日目）に、お支払いのご案内（請求書）をご登録のメールへお送りします。') +
          '<div style="margin-top:8px"><button class="btn btn-amber btn-sm" id="btnPayNow">お支払いへ進む</button></div>' +
          '<div id="payNowStat" class="planNote"></div></div>';
      }
    }
    const body = '<div class="sec-body">' + bannerBlock + perkBlock + formBlock +
      (canCancel ? '<div class="planCancel"><button class="textlink" id="btnPlanCancel" type="button">解約する</button></div>' : '') +
      '</div>';
    box.innerHTML = '<section><details><summary class="secSummary">契約・プラン</summary>' + body + '</details></section>';
    const pn = $("btnPayNow"); if (pn) pn.onclick = async () => {
      pn.disabled = true; const st = $("payNowStat"); if (st) st.textContent = "お支払いページを準備中…";
      try {
        let d = await window.Cloud.callFn("getPayLink", { tid: profile.tenantId });
        if (!d || !d.url) { try { await window.Cloud.callFn("syncPlan", { tid: profile.tenantId }); } catch (e) {} d = await window.Cloud.callFn("getPayLink", { tid: profile.tenantId }); }
        if (d && d.url) { window.location.href = d.url; return; }
        if (st) st.innerHTML = "まだ請求書が発行されていません。まもなくご登録のメールにお支払いのご案内が届きます。";
        pn.disabled = false;
      } catch (e) { if (st) st.textContent = "取得できませんでした：" + (e.message || e); pn.disabled = false; }
    };
    const send = $("btnSignupSend"); if (send) send.onclick = async () => {
      const planPref = (document.querySelector('input[name="signupPlan"]:checked') || {}).value || "monthly";
      const tierPref = (document.querySelector('input[name="signupTier"]:checked') || {}).value || "na";
      send.disabled = true; $("signupStat").textContent = "お支払いページを準備中…";
      // 請求書(お支払いページ)を作成。カード/銀行振込/コンビニを選べるページへ遷移。
      try {
        const d = await window.Cloud.callFn("createCheckout", { plan: planPref, tier: tierPref, email: me.email || "" });
        if (d && d.updated) {
          $("signupStat").innerHTML = "✓ プランを変更しました。差額は次回のご請求でまとめて精算されます。";
          send.disabled = false; renderPlan(); return;
        }
        if (d && d.trial) {
          const end = d.trialEnd ? new Date(d.trialEnd * 1000).toLocaleDateString("ja-JP") : "";
          $("signupStat").innerHTML = "✓ 7日間の無料トライアルを開始しました。全機能をお使いいただけます。" + (end ? "<br>初回のご請求書は " + end + " 頃にお送りします。" : "");
          send.disabled = false; return;
        }
        if (d && d.url) { $("signupStat").textContent = "お支払いページを開きます…"; window.location.href = d.url; return; }
        if (d && d.invoiceSent) { $("signupStat").innerHTML = "✓ 請求書メールを送りました。メール内のリンクからお支払いください。"; send.disabled = false; return; }
        throw new Error("お支払いページを取得できませんでした");
      } catch (e) {
        send.disabled = false; $("signupStat").textContent = "⚠ 手続きに失敗しました: " + (e.message || e);
      }
    };
    const seatBtn = $("btnSeatChange"); if (seatBtn) seatBtn.onclick = async () => {
      const now = (tenantDoc && tenantDoc.searchSeats) || 3;
      const ans = (prompt("検索を使える人数（席数）を入力してください。\n3席まで標準。4席目以降は +¥3,000/席（月額）または +¥36,000/席（年額）を、次回請求にまとめて自動計上します。", String(now)) || "").trim();
      if (!ans) return;
      const seats = parseInt(ans, 10);
      if (isNaN(seats) || seats < 1) { uiAlert("数字を入力してください。"); return; }
      seatBtn.disabled = true;
      try {
        const r = await window.Cloud.callFn("setSeats", { tid: profile.tenantId, seats: seats });
        uiAlert("検索席を " + r.seats + " 席に設定しました" + (r.extra > 0 ? "（追加 " + r.extra + "席）" : "") + "。\n" + (r.note || (r.billed ? "追加分は次回請求にまとめて計上されます。" : "")));
        renderPlan();
      } catch (e) { seatBtn.disabled = false; uiAlert("席数の変更に失敗しました: " + (e.message || e)); }
    };
    const cx = $("btnPlanCancel"); if (cx) cx.onclick = () => openCancelSurvey();
    // 支払いページから戻った(bfcache)とき、進行中表示を確実にリセット
    if (!planPageshowBound) { planPageshowBound = true; window.addEventListener("pageshow", e => { if (e.persisted && me && profile) renderPlan(); }); }
    show("cloudPlan", true);
  }
  /* 解約前アンケート(改善協力)。回答をFirestoreに保存してから解約(cancelPlan)を実行。 */
  function openCancelSurvey() {
    const REASONS = ["料金が高い", "使う機会が減った", "機能が不足している", "使い方が難しい", "不具合・エラーが多い", "他サービスへ乗り換え", "一時的に休止したい", "その他"];
    const ov = document.createElement("div"); ov.className = "uiModalOv";
    const m = document.createElement("div"); m.className = "uiModal csModal";
    m.innerHTML =
      '<div class="uiModalTitle">解約前に教えてください</div>' +
      '<div class="csLead">今後の改善のため、差し支えなければご回答ください（任意・匿名可）。</div>' +
      '<div class="csReasons">' + REASONS.map(r => '<label class="csR"><input type="radio" name="csReason" value="' + r + '"> <span>' + r + '</span></label>').join("") + '</div>' +
      '<textarea class="csComment" placeholder="改善してほしい点・ご意見（任意）"></textarea>' +
      '<div class="csBtns"><button type="button" class="btn btn-ghost btn-sm" id="csBack">やめる</button>' +
      '<button type="button" class="btn btn-amber btn-sm" id="csGo">回答して解約する</button></div>' +
      '<div class="planNote" id="csStat">解約すると、契約期間の終了日まで利用でき、その後は自動で停止します（追加請求なし）。</div>';
    ov.appendChild(m); document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    m.querySelector("#csBack").onclick = close;
    m.querySelector("#csGo").onclick = async () => {
      const reason = (m.querySelector('input[name="csReason"]:checked') || {}).value || "";
      const comment = (m.querySelector(".csComment").value || "").trim();
      const stat = m.querySelector("#csStat"); const go = m.querySelector("#csGo");
      go.disabled = true; stat.textContent = "解約手続き中…";
      try {
        // アンケートを保存(失敗しても解約は続行)
        try { await db.collection("cancelSurveys").add({ tid: (profile && profile.tenantId) || "", uid: (me && me.uid) || "", email: (me && me.email) || "", reason: reason, comment: comment, ts: Date.now() }); } catch (e) {}
        const d = await window.Cloud.callFn("cancelPlan", {});
        stat.textContent = "✓ 解約を受け付けました。" + (d && d.until ? new Date(d.until).toLocaleDateString("ja-JP") + " まで利用できます。" : "次回更新日以降の請求は停止されます。");
        go.textContent = "閉じる"; go.disabled = false; go.onclick = close; m.querySelector("#csBack").style.display = "none";
        renderPlan();
      } catch (e) { go.disabled = false; stat.textContent = "⚠ 解約に失敗しました: " + (e.message || e); }
    };
  }
  /* 登録端末の一覧＋追加端末(個人) — 折り畳み。制限超過時は自動で開く。 */
  function renderDevices() {
    const box = $("cloudDevices"); if (!box) return;
    if (!me || !profile || !profile.active) { box.innerHTML = ""; show("cloudDevices", false); return; }
    const devId = getDeviceId();
    const devices = (profile.devices || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    const limit = deviceLimitOf();
    let body = '<div class="foldBody">';
    body += '<div class="devHead">登録端末 <b>' + devices.length + '</b> / ' + limit + '台' + (limit > FREE_DEVICE_LIMIT ? '（無料' + FREE_DEVICE_LIMIT + '＋追加' + (limit - FREE_DEVICE_LIMIT) + '）' : '（無料枠）') + '</div>';
    body += '<div class="devList">';
    devices.forEach(d => {
      const cur = d.id === devId;
      const dt = d.at ? new Date(d.at) : null;
      const when = dt ? (dt.getFullYear() + "/" + String(dt.getMonth() + 1).padStart(2, "0") + "/" + String(dt.getDate()).padStart(2, "0")) : "";
      body += '<div class="devItem"><span class="devNm">' + esc(d.name || "端末") + (cur ? ' <span class="devCur">この端末</span>' : '') + '<br><span class="devWhen">最終利用: ' + when + '</span></span>' +
        '<button class="btn btn-ghost btn-sm devDel" data-id="' + esc(d.id) + '">解除</button></div>';
    });
    body += '</div>';
    if (deviceBlocked) {
      body += '<div class="devBlock">⛔ この端末は無料枠（' + FREE_DEVICE_LIMIT + '台）を超えています。<br>' +
        '・上の使わない端末を「解除」すると、この端末で使えます。<br>' +
        '・そのまま増やす場合は下の<b>「➕ 追加端末」</b>で登録できます（追加分は次回請求にまとめて計上）。<br>' +
        'それまでこの端末は<b>個人利用（ローカル保存）</b>で使えます（社内共有はされません）。</div>';
    }
    body += '<div class="planBtns"><button class="btn btn-ghost btn-sm" id="btnDevBuy">➕ 追加端末（3台目〜・有料）</button></div>' +
      '<div class="planNote">2台目まで無料。3台目以降は「➕ 追加端末」で登録でき、追加分は月額/年額に自動で合算されます。</div>';
    body += '</div>';
    const tag = deviceBlocked ? ' <span class="foldTag warn">要対応</span>' : '';
    box.innerHTML = '<details class="foldCard"' + (deviceBlocked ? ' open' : '') + '><summary>📱 登録端末（' + devices.length + '/' + limit + '台）' + tag + '</summary>' + body + '</details>';
    box.querySelectorAll(".devDel").forEach(b => b.addEventListener("click", () => {
      if (confirm("この端末の登録を解除しますか？（その端末では社内共有が使えなくなります）")) removeDevice(b.dataset.id);
    }));
    const buy = $("btnDevBuy"); if (buy) buy.onclick = async () => {
      if (!confirm("この端末を追加端末（3台目〜）として登録します。\n追加端末分は次回請求に自動でまとめて計上されます。よろしいですか？")) return;
      buy.disabled = true;
      try {
        const r = await window.Cloud.callFn("setDevices", { delta: 1 });
        if (profile) profile.deviceLimit = r.deviceLimit;           // 枠を反映
        const g = await ensureDeviceAllowed(me.uid);                 // この端末を登録
        if (g.ok) { deviceBlocked = false; startSync(profile.tenantId); }
        uiAlert("追加端末を登録しました（枠 " + r.deviceLimit + "台）。\n" + (r.note || (r.billed ? "追加分は次回請求にまとめて計上されます。" : "")));
        renderAuthUI(); renderDevices();
      } catch (e) { buy.disabled = false; uiAlert("追加に失敗しました: " + (e.message || e)); }
    };
    show("cloudDevices", true);
  }

  /* ---------- 認証フロー(モード選択 → フォーム出現) ---------- */
  let cloudMode = "login";
  function openForm(mode) {
    cloudMode = mode;
    show("cloudChoice", false); show("cloudForm", true);
    show("tenantField", mode !== "login");
    show("nameField", mode !== "login");
    show("officeLoginRow", true);   // 事務用の専用モードは ログイン・新規参加・会社登録 いずれでも選べる
    $("cloudFormTitle").textContent = mode === "new" ? "管理者として会社を新規登録（1社1名）" : mode === "join" ? "メンバーとして会社に参加（承認待ちになります）" : "ログイン";
    $("btnCloudSubmit").textContent = mode === "new" ? "会社を登録" : mode === "join" ? "参加を申請" : "ログイン";
    $("cloudAuthStat").textContent = "";
  }
  function closeForm() { show("cloudForm", false); show("cloudChoice", true); }
  $("btnModeLogin") && $("btnModeLogin").addEventListener("click", () => openForm("login"));
  $("btnModeNew") && $("btnModeNew").addEventListener("click", () => openForm("new"));
  $("btnModeJoin") && $("btnModeJoin").addEventListener("click", () => openForm("join"));
  $("btnCloudBack") && $("btnCloudBack").addEventListener("click", closeForm);
  $("btnCloudSubmit") && $("btnCloudSubmit").addEventListener("click", async () => {
    if (cloudMode === "login") {
      let email = $("cloudEmail").value.trim(); const pw = $("cloudPw").value;
      if (!email || !pw) { $("cloudAuthStat").textContent = "メール(またはログインID)とパスワードを入力してください。"; return; }
      $("cloudAuthStat").textContent = "ログイン中…";
      try {
        await persistReady;
        // メール形式でなければ「ログインID」とみなし、サーバーでメールに変換
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          const r = await fetch("https://" + FN_REGION + "-" + firebaseConfig.projectId + ".cloudfunctions.net/loginIdLookup", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: email }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.email) { $("cloudAuthStat").textContent = "⚠ そのログインIDは見つかりません。メールアドレスでもお試しください。"; return; }
          email = j.email;
        }
        await auth.signInWithEmailAndPassword(email, pw);
        // 事務用: 専用ログインが選択されていればこの端末を入庫管理専用モードに
        const off = $("officeLoginChk");
        if (off && off.checked) { localStorage.setItem("ss_office", "1"); if (typeof applyOfficeMode === "function") applyOfficeMode(); }
      }
      catch (e) { $("cloudAuthStat").textContent = "⚠ " + authErr(e); }
    } else { signup(cloudMode === "new"); }
  });
  $("btnCloudLogout") && $("btnCloudLogout").addEventListener("click", () => { try { localStorage.removeItem("ss_hadSession"); } catch (e) {} auth.signOut(); });
  /* パスワード変更(ログイン中の本人が任意のパスワードへ) */
  $("btnCloudChangePw") && $("btnCloudChangePw").addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user) { alert("ログインしてから変更してください。"); return; }
    const pw1 = (prompt("新しいパスワードを入力してください（6文字以上）") || "").trim();
    if (!pw1) return;
    if (pw1.length < 6) { alert("パスワードは6文字以上にしてください。"); return; }
    const pw2 = (prompt("確認のため、もう一度同じパスワードを入力してください") || "").trim();
    if (pw1 !== pw2) { alert("パスワードが一致しません。もう一度お試しください。"); return; }
    try {
      await user.updatePassword(pw1);
      alert("✓ パスワードを変更しました。次回から新しいパスワードでログインしてください。");
    } catch (e) {
      // 直近ログインから時間が経つと再認証が必要
      if (e && e.code === "auth/requires-recent-login") {
        const cur = (prompt("安全のため、現在のパスワード（一時パスワード等）を入力してください") || "").trim();
        if (!cur) return;
        try {
          const cred = firebase.auth.EmailAuthProvider.credential(user.email, cur);
          await user.reauthenticateWithCredential(cred);
          await user.updatePassword(pw1);
          alert("✓ パスワードを変更しました。次回から新しいパスワードでログインしてください。");
        } catch (e2) { alert("⚠ 変更できませんでした: " + authErr(e2)); }
      } else {
        alert("⚠ 変更できませんでした: " + authErr(e));
      }
    }
  });
  /* メールアドレス変更(ログイン中の本人。Auth＋Firestoreをサーバーで同時更新) */
  $("btnCloudChangeEmail") && $("btnCloudChangeEmail").addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user) { alert("ログインしてから変更してください。"); return; }
    const cur = user.email || "";
    const ne = (prompt("新しいメールアドレスを入力してください\n（現在: " + cur + "）") || "").trim();
    if (!ne) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ne)) { alert("メールアドレスの形式が正しくありません。"); return; }
    const ne2 = (prompt("確認のため、もう一度同じメールアドレスを入力してください") || "").trim();
    if (ne.toLowerCase() !== ne2.toLowerCase()) { alert("メールアドレスが一致しません。"); return; }
    try {
      await window.Cloud.callFn("changeMyEmail", { email: ne });
      try { await user.reload(); } catch (e) {}
      alert("✓ メールアドレスを変更しました。\n次回のログインからは新しいメールアドレスを使ってください。");
    } catch (e) { alert("⚠ 変更できませんでした: " + (e.message || e)); }
  });
  /* パスワード再設定メール */
  $("lnkResetPw") && $("lnkResetPw").addEventListener("click", async () => {
    const email = ($("cloudEmail").value || "").trim() || (prompt("再設定メールを送るメールアドレスを入力") || "").trim();
    if (!email) return;
    try { await auth.sendPasswordResetEmail(email); $("cloudAuthStat").innerHTML = "✓ " + esc(email) + " に再設定メールを送りました。<br><b>数分待っても届かない場合は「迷惑メール」フォルダをご確認ください</b>（差出人 noreply@mecanoai.firebaseapp.com）。それでも無い場合はメールアドレスの綴りをご確認ください。"; }
    catch (e) { $("cloudAuthStat").textContent = "⚠ " + authErr(e); }
  });
  /* 完全自動同期: リアルタイム購読に加え、アプリ復帰/オンライン復帰の度に取りこぼしを自動同期 */
  function autoResync() { if (profile && profile.active && profile.tenantId) startSync(profile.tenantId); }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) autoResync(); });
  window.addEventListener("online", autoResync);

  async function signup(isNewCompany) {
    // 会社(事業所)の新規登録は自由登録を廃止。契約後に運営(営業)が発行したアカウントでのみ利用可能。
    // 身に覚えのない事業所が「承認待ち」に並ぶのを防ぐため、クライアントからの新規会社作成はここで停止する。
    if (isNewCompany) {
      $("cloudAuthStat").innerHTML = "会社（事業所）の新規登録は、ご契約後に運営が発行するアカウントでのみ行えます。<br>まずは<b>お問い合わせ</b>からご連絡ください。契約後にお送りする<b>ログインID・初期パスワード</b>で「ログイン」してご利用いただけます。";
      return;
    }
    const name = $("cloudName").value.trim();
    const email = $("cloudEmail").value.trim(), pw = $("cloudPw").value;
    let tid = ($("cloudTenant").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""));
    if (!name) { $("cloudAuthStat").textContent = "氏名を入力してください。"; return; }
    if (!email || pw.length < 6) { $("cloudAuthStat").textContent = "メールと6文字以上のパスワードを入力してください。"; return; }
    if (!tid) { $("cloudAuthStat").textContent = "店舗コードを入力してください(半角英数)。"; return; }
    $("cloudAuthStat").textContent = "登録中…";
    // 従業員参加: 入力が別名の店舗コードなら実テナントIDに解決する
    if (!isNewCompany) {
      try {
        const rr = await fetch("https://" + FN_REGION + "-" + firebaseConfig.projectId + ".cloudfunctions.net/tenantResolve?q=" + encodeURIComponent(tid));
        const jj = await rr.json().catch(() => ({}));
        if (rr.ok && jj.tid) tid = jj.tid;
      } catch (e) {}
    }
    // 管理者の新規登録は1社1名: 既に会社が存在していたら拒否
    if (isNewCompany) {
      try {
        const t = await db.collection("tenants").doc(tid).get();
        if (t.exists) { $("cloudAuthStat").textContent = "⚠ この事業所IDは既に登録されています。メンバーとして参加してください。"; return; }
      } catch (e) {}
    }
    try {
      await persistReady;
      let cred;
      try {
        cred = await auth.createUserWithEmailAndPassword(email, pw);
      } catch (ce) {
        // 既にアカウントがある(却下後の再申請など)。従業員参加なら、そのパスワードでログインして再申請する。
        if (!isNewCompany && ce && ce.code && ce.code.includes("email-already-in-use")) {
          try { cred = await auth.signInWithEmailAndPassword(email, pw); }
          catch (se) {
            $("cloudAuthStat").innerHTML = "このメールは登録済みです。<b>パスワードが正しければ再申請できます</b>（もう一度お試しを）。<br>パスワードが分からない場合は下の「パスワードを忘れた（再設定メール）」から再設定してください。";
            return;
          }
        } else throw ce;
      }
      const uid = cred.user.uid;
      if (isNewCompany) {
        await db.collection("tenants").doc(tid).set({ name: tid, adminName: name, active: false, createdAt: Date.now() }, { merge: true });
        await db.collection("users").doc(uid).set({ name, email, tenantId: tid, role: "admin", active: false, rejected: false, createdAt: Date.now() });
        $("cloudAuthStat").textContent = "✓ 会社を登録しました。運営の承認後に有効化されます。";
      } else {
        await db.collection("users").doc(uid).set({ name, email, tenantId: tid, role: "staff", active: false, rejected: false, createdAt: Date.now() });
        $("cloudAuthStat").textContent = "✓ 参加申請しました。会社の代表管理者の承認をお待ちください。";
      }
      // 事務用: 選択されていればこの端末を入庫管理専用に(承認/ログイン後に反映されるようフラグのみ保存)
      const off = $("officeLoginChk");
      if (off && off.checked) {
        localStorage.setItem("ss_office", "1");
        $("cloudAuthStat").textContent += "（承認後、この端末は入庫管理画面になります）";
      }
    } catch (e) { $("cloudAuthStat").textContent = "⚠ " + authErr(e); }
  }
  function authErr(e) {
    const m = (e && e.code) || "";
    if (m.includes("email-already-in-use")) return "このメールは登録済みです。ログインしてください。";
    if (m.includes("wrong-password") || m.includes("invalid-credential")) return "メールまたはパスワードが違います。";
    if (m.includes("user-not-found")) return "アカウントが見つかりません。新規登録してください。";
    if (m.includes("weak-password")) return "パスワードは6文字以上にしてください。";
    if (m.includes("network")) return "ネットワークに接続できません。";
    return (e && e.message) || "エラーが発生しました。";
  }

  /* ---------- 認証状態 ---------- */
  auth.onAuthStateChanged(async user => {
    stopSync();
    if (!user) { me = null; profile = null; renderAuthUI(); return; }
    me = { uid: user.uid, email: user.email };
    try {
      let doc = await db.collection("users").doc(user.uid).get();
      profile = doc.exists ? doc.data() : null;
      // オーナー(あなた)は自動で運営管理者(super・有効)に昇格(コンソール操作不要)
      if (user.email && user.email.toLowerCase() === OWNER_EMAIL.toLowerCase() && (!profile || profile.role !== "super" || !profile.active)) {
        await db.collection("users").doc(user.uid).set({ email: user.email, role: "super", active: true, tenantId: (profile && profile.tenantId) || "admin", createdAt: (profile && profile.createdAt) || Date.now() }, { merge: true });
        doc = await db.collection("users").doc(user.uid).get();
        profile = doc.data();
      }
    } catch (e) { profile = null; }
    // ★エディション分離★ Pocket専用IDはWorksで、Works用IDはPocketで使わせない(運営/オーナーは除外)。
    try {
      const appMode = (window.getAppMode && window.getAppMode()) || "corp";
      const isOwnerAcct = user.email && user.email.toLowerCase() === OWNER_EMAIL.toLowerCase();
      const superRole = profile && profile.role === "super";
      if (profile && !isOwnerAcct && !superRole) {
        const acctEdition = profile.edition === "personal" ? "personal" : "works";
        const wantPersonal = appMode === "personal";
        if (wantPersonal !== (acctEdition === "personal")) {
          const msg = acctEdition === "personal"
            ? "このID・パスワードは個人版(Pocket)専用です。法人版(Works)ではログインできません。Pocket版アプリからログインしてください。"
            : "このID・パスワードは法人版(Works)専用です。個人版(Pocket)ではログインできません。";
          try { await auth.signOut(); } catch (e) {}
          me = null; profile = null; renderAuthUI();
          try { alert(msg); } catch (e) {}
          return;
        }
      }
    } catch (e) {}
    // 店舗の契約状態を読み込む
    deviceBlocked = false; planBlocked = false; tenantDoc = null;
    if (profile && profile.tenantId) {
      try { tenantDoc = (await db.collection("tenants").doc(profile.tenantId).get()).data() || null; } catch (e) { tenantDoc = null; }
      // 店舗情報(プラン/有料ONフラグ等)をリアルタイム購読 → 運営がトグルを変えたら端末に即反映(古い状態で検索を送るのを防ぐ)
      if (unsubTenant) { unsubTenant(); unsubTenant = null; }
      try {
        unsubTenant = db.collection("tenants").doc(profile.tenantId).onSnapshot(s => { tenantDoc = s.data() || tenantDoc; try { window.refreshPocketUI && window.refreshPocketUI(); } catch (e) {} });
      } catch (e) {}
      // 管理者/運営は、Stripe契約から自動でプランを同期(webフック取りこぼし救済・🔄手動不要)。
      if ((profile.role === "admin" || profile.role === "super") && tenantDoc && tenantDoc.stripeCustomerId) {
        try { await window.Cloud.callFn("syncPlan", { tid: profile.tenantId }); tenantDoc = (await db.collection("tenants").doc(profile.tenantId).get()).data() || tenantDoc; } catch (e) {}
      }
    }
    renderAuthUI();
    try { window.refreshPocketUI && window.refreshPocketUI(); } catch (e) {}   // 契約情報読込後にPocketの無料残日数バナーを再描画
    if (profile && profile.active && profile.tenantId) {
      // 店舗が未払い/停止なら社内共有を止める(個人利用=ローカルは継続)
      if (!planActive()) { planBlocked = true; renderAuthUI(); renderDevices(); return; }
      // 端末制限チェック(無料2台まで/3台目以降は有料枠が必要)。許可された端末のみ同期する。
      const gate = await ensureDeviceAllowed(user.uid);
      renderDevices();
      if (!gate.ok) { deviceBlocked = true; renderAuthUI(); return; }   // 未許可端末は同期させない
      // 最終ログイン日時を記録(管理画面に表示)
      try { db.collection("users").doc(user.uid).set({ lastLogin: Date.now() }, { merge: true }); } catch (e) {}
      startSync(profile.tenantId);
      startMembersWatch(profile.tenantId);   // 店舗メンバー名簿(カルテ担当者の照合用)
      if (profile.role === "admin" || profile.role === "super") { startJoinWatch(profile.tenantId); registerPush(); }
      else if (officeNow() && !pushExcluded()) { registerPush(); }   // 事務モード端末も入庫通知の配信先に登録
      try { if (window.syncPushBtn) window.syncPushBtn(); } catch (e) {}   // ログイン確定後に通知ボタン表示を最新化
      // 入庫管理(事務モード)はログイン時に最新版へ自動更新(新版があれば適用・無ければ何もしない)
      if (officeNow() && !pushExcluded()) { try { if (window.appAutoUpdate) window.appAutoUpdate(); } catch (e) {} }
    }
    // 運営ログイン後の遷移
    if (pendingSuperOpen) {
      if (profile && profile.active && profile.role === "super") { openAdminIfSuper(); }
      else { pendingSuperOpen = false; const s = $("superStat"); if (s) s.textContent = "⚠ このアカウントは運営管理者ではありません。"; }
    }
  });

  function renderAuthUI() {
    const inLogged = !!me;
    // 一度ログインした端末は記録。更新・再読込で認証復元が一瞬遅れてもログイン画面を出さない(再ログイン防止)
    try { if (inLogged) localStorage.setItem("ss_hadSession", "1"); } catch (e) {}
    if (typeof window.updateAuthGate === "function") window.updateAuthGate();   // 認証状態が確定したのでログインゲートを再評価
    if (typeof window.applyRoleUI === "function") window.applyRoleUI();   // 権限に応じたUI(データ管理/削除ボタン)を更新
    // ログイン/ログアウト/店舗切替で入庫ボードを再描画 → 自店舗以外のレコードを画面から即座に外す
    try { if (typeof renderIntakeBoard === "function") renderIntakeBoard(); } catch (e) {}
    try { if (typeof renderHomeIntake === "function") renderHomeIntake(); } catch (e) {}
    show("cloudLoggedOut", !inLogged);
    show("cloudLoggedIn", inLogged);
    const isSuperUser = !!(profile && profile.active && profile.role === "super");
    show("tabAdmin", isSuperUser);   // 運営の隠しタブはsuperのみ表示
    if (!inLogged) { closeForm(); show("tabAdmin", false); show("cloudDevices", false); show("cloudPlan", false); return; }
    const roleJa = profile ? ({ super: "運営管理者", admin: "代表管理者", staff: "メンバー" }[profile.role] || profile.role) : "—";
    const who = profile && profile.name ? profile.name + "（" + me.email + "）" : me.email;
    if (!profile) {
      $("cloudStat").innerHTML = esc(me.email) + " — プロフィール未作成です。<br><button class='btn btn-amber btn-sm' id='cloudRecover' style='margin-top:6px'>会社に参加（再申請）</button>";
      const rb = $("cloudRecover");
      if (rb) rb.onclick = async () => {
        const nm = (prompt("氏名を入力してください") || "").trim(); if (!nm) return;
        const tid = (prompt("事業所IDを入力してください（例: sakuragarage）") || "").toLowerCase().replace(/[^a-z0-9_-]/g, ""); if (!tid) return;
        try { await db.collection("users").doc(me.uid).set({ name: nm, email: me.email, tenantId: tid, role: "staff", active: false, rejected: false, createdAt: Date.now() }); uiAlert("再申請しました。管理者の承認をお待ちください。"); location.reload(); }
        catch (e) { uiAlert("失敗: " + (e.message || e)); }
      };
    } else if (profile.rejected) {
      $("cloudStat").innerHTML = who + "<br>会社: " + (profile.tenantId || "—") + "<br>⛔ <b>申請が却下されました。</b><br>下のボタンで再申請できます（会社の代表管理者の承認をお待ちください）。<br><button class='btn btn-amber btn-sm' id='cloudReapply' style='margin-top:8px'>もう一度 参加を申請する</button>";
      const rab = $("cloudReapply");
      if (rab) rab.onclick = async () => {
        try { await db.collection("users").doc(me.uid).set({ active: false, rejected: false }, { merge: true }); uiAlert("再申請しました。管理者の承認をお待ちください。"); }
        catch (e) { uiAlert("失敗: " + (e.message || e)); }
      };
    } else if (!profile.active) {
      $("cloudStat").innerHTML = who + "<br>会社: " + (profile.tenantId || "—") + " / 役割: " + roleJa + "<br>⏳ <b>承認待ち</b>です。承認されると自動で同期が始まります。";
    } else if (planBlocked) {
      $("cloudStat").innerHTML = who + "<br>会社: <b>" + profile.tenantId + "</b> / 役割: " + roleJa + "<br>⛔ <b>店舗の利用契約が停止中/期限切れ</b>です（社内共有は停止／個人利用は可）。代表管理者にお支払いをご確認ください。";
    } else if (deviceBlocked) {
      $("cloudStat").innerHTML = who + "<br>会社: <b>" + profile.tenantId + "</b> / 役割: " + roleJa + "<br>⛔ <b>この端末は無料枠を超えています</b>（社内共有は停止中／個人利用は可）。下の端末一覧をご確認ください。";
    } else {
      const storeCode = (tenantDoc && tenantDoc.code) || profile.tenantId;
      const canEditCode = (profile.role === "admin" || profile.role === "super");
      const codeLocked = !!(tenantDoc && tenantDoc.codeSetByAdmin) && profile.role !== "super";
      $("cloudStat").innerHTML = "✓ 同期中 — " + who +
        "<br>店舗コード: <b id='myStoreCode'>" + esc(storeCode) + "</b>" +
        (canEditCode && !codeLocked ? " <a href='#' id='btnChangeCode' style='font-size:12px;margin-left:8px;color:var(--cyan,#1b9);text-decoration:underline;background:none;border:0;padding:0;font-weight:600'>変更する</a>" : "") +
        (codeLocked ? " <span style='color:var(--dim,#89a);font-size:11px'>（変更済・再変更は運営へ）</span>" : "") +
        "<br>役割: " + roleJa;
      const bcc = $("btnChangeCode");
      if (bcc) bcc.onclick = async (ev) => {
        ev.preventDefault();
        const cur = storeCode;
        let nc = (prompt("新しい店舗コードを入力してください。\n（会社名など・半角英数字とハイフン・3〜24文字）\n※管理者による変更は1回のみです。以降は運営へお問い合わせください。", cur) || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (!nc || nc === cur) return;
        try {
          const rsp = await window.Cloud.callFn("setTenantCode", { tid: profile.tenantId, code: nc });
          if (tenantDoc) { tenantDoc.code = rsp.code || nc; if (rsp.byAdminLocked) tenantDoc.codeSetByAdmin = true; }
          const el = $("myStoreCode"); if (el) el.textContent = rsp.code || nc;
          uiAlert("店舗コードを変更しました：" + (rsp.code || nc) + "\n（変更は1回のみです。以降は運営へお問い合わせください）");
        } catch (e) { uiAlert("変更できませんでした：" + (e.message || e)); }
      };
    }
    renderPlan();
    renderDevices();
    // 会社内のメンバー管理は admin のみ(superは「運営」タブで全体管理)
    show("btnCloudManage", profile && profile.active && profile.role === "admin");
    // 通知の有効化は管理者(admin/super)＋事務モード端末向け。参加申請・入庫などのプッシュを受け取る端末で押す
    show("btnEnablePush", profile && profile.active && (profile.role === "admin" || profile.role === "super" || officeNow()) && !pushExcluded());
    $("cloudManageBox").innerHTML = ""; show("cloudManageBox", false);
  }

  /* ---------- 同期 ---------- */
  function vinKey(r) { return String(r.vin || r.type || r.plate || r.id || Date.now()).replace(/[^A-Za-z0-9]/g, "_"); }
  /* ドキュメントID: 車台番号があればそれ(端末間で同一車両を1件に)、無ければ不変ID(rid)で固定
     → 登録番号などを訂正しても同じドキュメントを更新でき、古い値が別レコードとして復活しない */
  function docKey(r) {
    if (r.vin) return String(r.vin).replace(/[^A-Za-z0-9]/g, "_");
    if (r.rid) return String(r.rid).replace(/[^A-Za-z0-9]/g, "_");
    return vinKey(r);
  }
  const clean = s => (typeof noEmail === "function" ? noEmail(s) : s) || null;   // メール混入除去
  function recordSubset(r) {
    return { rid: r.rid || null, vin: r.vin || null, plate: r.plate || null, name: clean(r.name), model: r.model || null, type: r.type || null, kataShitei: r.kataShitei || null, engine: r.engine || null, firstReg: r.firstReg || null, expiry: r.expiry || null, specs: r.specs || null, faults: r.faults || null, recalls: r.recalls || null, karte: r.karte || null, intakeKind: r.intakeKind || null, intakeAt: r.intakeAt || null, intakeOut: r.intakeOut || null, feePaid: (r.feePaid === true), feeStatus: r.feeStatus || null, officeMemo: r.officeMemo || null, comments: Array.isArray(r.comments) ? r.comments : null, staff: r.staff || null, confirms: Array.isArray(r.confirms) ? r.confirms : null, deleted: false, at: r.at || new Date().toISOString(), updatedAt: r.updatedAt || Date.now() };
  }
  function syncMsg(t) { const el = $("cloudSyncMsg"); if (el) el.textContent = t; }
  /* 既存のローカルデータをクラウドへ初回アップロード(ログイン前に作った分を共有) */
  async function uploadLocal(tid) {
    let vUp = 0, rUp = 0, errMsg = "";
    try {
      if (typeof CUSTOM_DB !== "undefined") {
        for (const v of CUSTOM_DB) {
          if (v && v.id) try { await db.collection("tenants").doc(tid).collection("vehicles").doc(String(v.id)).set(v, { merge: true }); vUp++; }
          catch (e) { errMsg = (e && e.code) || e.message || String(e); }
        }
      }
      let hist = JSON.parse(localStorage.getItem(LS.hist) || "[]");
      if (typeof dedupeHistory === "function") hist = dedupeHistory(hist);
      // 現状のクラウド記録を1回だけ取得して更新時刻を把握(古いローカルでの上書き＝出庫の復活を防ぐ)
      const cloudMap = {};
      try { const cs = await db.collection("tenants").doc(tid).collection("records").get(); cs.forEach(d => { cloudMap[d.id] = d.data() || {}; }); } catch (e) {}
      for (const h of hist) {
        if (!(h && (h.vin || h.rid) && !h.deleted)) continue;
        const c = cloudMap[docKey(h)];
        // クラウドが同等以上に新しい(出庫・削除など後の操作を含む)なら、古いローカルで上書きしない。
        // 新規/ローカルが新しい場合のみ送信。カルテ等の統合は購読側(onSnapshot)が担う。
        if (c && (c.updatedAt || 0) >= (h.updatedAt || 0)) continue;
        try { await db.collection("tenants").doc(tid).collection("records").doc(docKey(h)).set(recordSubset(h), { merge: true }); rUp++; }
        catch (e) { errMsg = (e && e.code) || e.message || String(e); }
      }
    } catch (e) { errMsg = (e && e.code) || e.message || String(e); }
    if (errMsg) syncMsg("⚠ アップロード失敗: " + errMsg + "（ルール設定をご確認ください）");
    else syncMsg("⬆ 送信: 車種DB " + vUp + "件 / 車両 " + rUp + "台");
    return { vUp, rUp, errMsg };
  }
  async function startSync(tid) {
    stopSync();
    syncMsg("同期を開始しています…");
    const up = await uploadLocal(tid);   // ←先にローカル分をクラウドへ(空クラウドでの消失を防止)
    // 車種DB(vehicles) → CUSTOM_DB へマージ同期(クラウド優先・ローカル限定分は保持)
    unsubVeh = db.collection("tenants").doc(tid).collection("vehicles").onSnapshot(snap => {
      try {
        if (typeof CUSTOM_DB === "undefined") return;
        const byId = {}; CUSTOM_DB.forEach(v => { if (v && v.id) byId[v.id] = v; });
        snap.forEach(d => {
          const v = d.data(); if (!v || !v.id) return;
          const local = byId[v.id];
          // ローカルの編集が新しければ上書きしない(編集リセット防止)。新しければクラウドを採用しクラウドへ戻す
          if (local && (local.updatedAt || 0) > (v.updatedAt || 0)) { try { db.collection("tenants").doc(profile.tenantId).collection("vehicles").doc(String(local.id)).set(local, { merge: true }); } catch (e) {} }
          else byId[v.id] = v;
        });
        CUSTOM_DB.length = 0; Object.keys(byId).forEach(k => CUSTOM_DB.push(byId[k]));
        saveCustomDB(); try { renderDBList(); } catch (e) {}
        if (!up.errMsg) syncMsg("✓ 同期OK: 車種DB " + snap.size + "件（クラウド）");
      } catch (e) {}
    }, err => syncMsg("⚠ 同期エラー(車種DB): " + (err.code || err.message) + "（ルール設定をご確認ください）"));
    // 車両レコード(records) → ローカル履歴へマージ(ナンバー検索が全端末で可能に)
    unsubRec = db.collection("tenants").doc(tid).collection("records").onSnapshot(snap => {
      try {
        let hist = JSON.parse(localStorage.getItem(LS.hist) || "[]");
        snap.forEach(d => {
          const r = d.data();
          // 照合は 車台番号 > 不変ID(rid) > ドキュメントID の順(登録番号だけの車両でも1件に固定)
          const ei = hist.findIndex(h =>
            (r.vin && h.vin === r.vin) ||
            (r.rid && h.rid === r.rid) ||
            (!r.vin && !r.rid && vinKey(h) === d.id));
          let e = ei >= 0 ? hist[ei] : null;
          // 墓標(削除済み): クラウドが新しければローカルからも消す(復活防止)
          if (r.deleted) {
            if (e && (e.updatedAt || 0) > (r.updatedAt || 0)) {
              // ローカルで削除後に再作成/編集された → ローカルを正としてクラウドへ復活送信
              try { db.collection("tenants").doc(tid).collection("records").doc(docKey(e)).set(recordSubset(e), { merge: true }); } catch (er) {}
            } else if (ei >= 0) { hist.splice(ei, 1); }
            return;
          }
          if (!e) { e = { id: Date.now() + Math.random(), rid: r.rid || d.id }; hist.unshift(e); }
          if (!e.rid) e.rid = r.rid || d.id;   // 既存エントリにも不変IDを付与(以降の照合を安定化)
          e._tid = tid;   // どの店舗のレコードか刻む(入庫ボードを自店舗のみに絞るため)
          // 整備カルテは追記のみ(削除しない)なので両端末の追加を失わないよう常にunion統合
          if (typeof mergeKarte === "function") e.karte = mergeKarte(e.karte, r.karte);
          // コメント履歴も追記のみ(削除しない)。両端末の投稿を失わないよう常にunion統合
          if (typeof mergeComments === "function") e.comments = mergeComments(e.comments, r.comments);
          // ★確認レ点はunionしない: unionすると片方で外しても相手の古い打刻と合算され復活してしまう。
          //   レコードの更新時刻(updatedAt)で新しい方の状態を採用し、外した状態も確実に反映する。
          if ((e.updatedAt || 0) > (r.updatedAt || 0)) {
            // ローカルの方が新しい(編集/クリア) → クラウドへ送り返して上書き
            try { db.collection("tenants").doc(tid).collection("records").doc(docKey(e)).set(recordSubset(e), { merge: true }); } catch (er) {}
          } else {
            // クラウドの方が新しい → 反映(名前=使用者はクラウド値をそのまま採用しクリアも反映)
            Object.assign(e, { type: r.type || e.type, vin: r.vin || e.vin, plate: r.plate || e.plate, name: clean(r.name), model: r.model || e.model, engine: r.engine || e.engine, kataShitei: r.kataShitei || e.kataShitei, firstReg: r.firstReg || e.firstReg, expiry: r.expiry || e.expiry, specs: r.specs || e.specs, faults: r.faults || e.faults, recalls: r.recalls || e.recalls, intakeKind: (r.intakeKind !== undefined ? r.intakeKind : e.intakeKind), intakeAt: (r.intakeAt !== undefined ? r.intakeAt : e.intakeAt), intakeOut: (r.intakeOut !== undefined ? r.intakeOut : e.intakeOut), feePaid: (r.feePaid !== undefined ? r.feePaid : e.feePaid), feeStatus: (r.feeStatus !== undefined ? r.feeStatus : e.feeStatus), officeMemo: (r.officeMemo !== undefined ? r.officeMemo : e.officeMemo), staff: (r.staff !== undefined ? r.staff : e.staff), confirms: (Array.isArray(r.confirms) ? r.confirms : (r.confirms === null ? [] : e.confirms)), at: e.at || r.at || new Date().toISOString(), updatedAt: r.updatedAt || e.updatedAt || 0 });
          }
          // 一覧プレビュー(officeMemo)は統合済みコメントの最新(削除済みは除く)に合わせる
          if (Array.isArray(e.comments)) { const live = e.comments.filter(c => c && !c.del); e.officeMemo = live.length ? live[live.length - 1].text : null; }
        });
        if (typeof dedupeHistory === "function") hist = dedupeHistory(hist);
        localStorage.setItem(LS.hist, JSON.stringify(hist.slice(0, 500)));
        try { renderHistory(); } catch (e) {}
      } catch (e) {}
    }, err => syncMsg("⚠ 同期エラー(車両): " + (err.code || err.message)));
  }
  function stopSync() { if (unsubVeh) { unsubVeh(); unsubVeh = null; } if (unsubRec) { unsubRec(); unsubRec = null; } if (unsubJoin) { unsubJoin(); unsubJoin = null; } if (unsubTenant) { unsubTenant(); unsubTenant = null; } if (unsubMembers) { unsubMembers(); unsubMembers = null; } tenantMembers = []; }

  /* 店舗メンバー名簿を購読(有効メンバーのみ)。カルテ担当者名→メンバー特定に使う。 */
  function startMembersWatch(tid) {
    if (unsubMembers) { unsubMembers(); unsubMembers = null; }
    try {
      unsubMembers = db.collection("users").where("tenantId", "==", tid).onSnapshot(snap => {
        const list = [];
        snap.forEach(d => { const u = d.data() || {}; if (u.active === true && (u.name || u.email)) list.push({ uid: d.id, name: u.name || "", nameKana: u.nameKana || "", nameRoma: u.nameRoma || "", email: u.email || "" }); });
        tenantMembers = list;
      }, () => {});
    } catch (e) {}
  }

  /* 氏名照合用の正規化: NFKC・小文字化・カタカナ→ひらがな・空白/記号除去 */
  function normNm(s) {
    s = String(s == null ? "" : s).normalize("NFKC").toLowerCase();
    s = s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));   // カタカナ→ひらがな
    return s.replace(/[\s・.,、。･･／\/\-]/g, "").trim();
  }
  /* カルテの担当者テキストから店舗メンバーを特定。苗字/名前・漢字/カナ/かな/ローマ字のいずれでも照合。
     一意に定まらない(同点で複数一致)場合は null を返し、誤った権限移譲を防ぐ。 */
  function resolveMember(text) {
    const q = normNm(text);
    if (!q) return null;
    const scored = [];
    for (const m of tenantMembers) {
      const parts = [];
      [m.name, m.nameKana, m.nameRoma].filter(Boolean).forEach(full => {
        parts.push(full);
        String(full).split(/[\s・／\/,、]+/).filter(Boolean).forEach(t => parts.push(t));   // 苗字/名前などのトークン
      });
      const norm = [...new Set(parts.map(normNm).filter(Boolean))];
      let score = 0;
      for (const n of norm) {
        if (n === q) score = Math.max(score, 3);                                            // 完全一致
        else if (q.length >= 2 && (n.startsWith(q) || q.startsWith(n))) score = Math.max(score, 2);  // 前方一致
        else if (q.length >= 2 && (n.includes(q) || q.includes(n))) score = Math.max(score, 1);      // 部分一致
      }
      if (score > 0) scored.push({ m, score });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 1 && scored[0].score === scored[1].score) return null;   // あいまい → 特定しない
    return { uid: scored[0].m.uid, name: scored[0].m.name };
  }

  /* ---------- プッシュ通知(FCM): 管理者はワンタップ許可のみ。設定作業は不要 ----------
     ↓ 運営(あなた)が一度だけ Firebase Console → Cloud Messaging → ウェブプッシュ証明書 で
       「鍵ペアを生成」して得られる公開鍵(VAPID)をここに貼るだけ。 */
  const VAPID_KEY = "BJyKrW5kitDImGcvoRr9UGJ1_yU4miwENlSbcuf_uBilFohE3lC8J1BGOW2lHADFYGvm23XQhyeE-CGxeHk6Qtw";
  // 事務(入庫管理)モードの端末か
  function officeNow() { try { return localStorage.getItem("ss_office") === "1"; } catch (e) { return false; } }
  // 個人版(ストア/個人モード)は通知の対象外
  function pushExcluded() {
    try { if (document.body.classList.contains("storeApp")) return true; } catch (e) {}
    try { if (window.getAppMode && window.getAppMode() === "personal") return true; } catch (e) {}
    return false;
  }
  /* 店舗レベルのトークン台帳に登録(office/adminを区別)。入庫・申請のプッシュ配信先に使う。 */
  async function writeTenantPushToken(token) {
    try {
      if (!token || !profile || !profile.tenantId || pushExcluded()) return;
      const isAdmin = profile.role === "admin" || profile.role === "super";
      let dev = null; try { dev = localStorage.getItem("ss_devId") || null; } catch (e) {}
      await db.collection("tenants").doc(profile.tenantId).collection("pushTokens").doc(token).set(
        { office: officeNow(), admin: isAdmin, uid: (me && me.uid) || null, dev: dev, at: Date.now() }, { merge: true });
    } catch (e) {}
  }
  async function registerPush() {
    try {
      // 通知対象: 管理者(admin/super) または 事務(入庫管理)モードの端末。個人版は除外。
      if (pushExcluded()) return;
      try { if (localStorage.getItem("ss_pushOn") === "0") return; } catch (e) {}   // ユーザーが明示的に無効化した端末は自動登録しない
      if (!(profile && (profile.role === "admin" || profile.role === "super" || officeNow()))) return;
      if (typeof firebase.messaging !== "function" || !("serviceWorker" in navigator)) return;
      if (!VAPID_KEY || VAPID_KEY.indexOf("PASTE_") === 0) return;   // 鍵未設定なら在アプリ通知のみで運用
      try { if (firebase.messaging && typeof firebase.messaging.isSupported === "function" && !(await firebase.messaging.isSupported())) return; } catch (e) { return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
      // 専用スコープに登録(アプリ本体SW '/' を置き換えない)
      const reg = await navigator.serviceWorker.register("firebase-messaging-sw.js", { scope: "/firebase-cloud-messaging-push-scope" });
      const messaging = firebase.messaging();
      const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
      if (token) {
        await db.collection("users").doc(me.uid).set(
          { fcmTokens: firebase.firestore.FieldValue.arrayUnion(token) }, { merge: true });
        await writeTenantPushToken(token);   // 店舗台帳にも登録(入庫通知の配信先)
        try { localStorage.setItem("ss_pushToken", token); localStorage.setItem("ss_pushOn", "1"); } catch (e) {}
      }
      // 前面にいる時に届いた通知も表示
      messaging.onMessage(p => {
        const n = (p && (p.data || p.notification)) || {};
        try { if (Notification.permission === "granted") new Notification(n.title || "メカノAI", { body: n.body || "", icon: "icons/icon-192.png" }); } catch (e) {}
      });
    } catch (e) { console.warn("プッシュ通知の登録に失敗", e); }
  }

  /* ---------- 参加申請の通知(代表管理者/運営) ---------- */
  let joinSeen = -1;
  function startJoinWatch(tid) {
    if (unsubJoin) { unsubJoin(); unsubJoin = null; }
    try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {}); } catch (e) {}
    // 複合インデックス不要にするため単一whereで購読し、残りはクライアント側で絞る
    const q = profile.role === "admin"
      ? db.collection("users").where("tenantId", "==", tid)
      : db.collection("users").where("active", "==", false);
    unsubJoin = q.onSnapshot(snap => {
      // 承認待ち(active=false かつ 却下でない)だけを数える
      const pending = snap.docs.map(d => d.data()).filter(u => u.active === false && !u.rejected);
      const n = pending.length;
      const el = $("joinNotice");
      if (el) {
        if (n > 0) {
          const names = pending.slice(0, 3).map(u => esc(u.name || u.email || "（無名）")).join("、");
          el.innerHTML = "🔔 <b>承認待ちの参加申請が " + n + "件</b> あります（" + names + (n > 3 ? " ほか" : "") + "）。<br><button class='btn btn-amber btn-sm' id='joinOpen' style='margin-top:6px'>会社管理で承認する</button>";
          el.classList.remove("hidden");
          const ob = $("joinOpen");
          if (ob) ob.onclick = () => {
            if (profile.role === "super" && typeof switchView === "function") { switchView("admin"); if (window.CloudAdmin) window.CloudAdmin.open(); }
            else { show("cloudManageBox", true); renderManage("cloudManageBox"); $("cloudManageBox").scrollIntoView({ behavior: "smooth" }); }
          };
        } else { el.classList.add("hidden"); el.innerHTML = ""; }
      }
      // 新規申請が増えたら端末通知(音＋アプリ内ポップアップ。iOSでも確実に鳴る)
      if (joinSeen >= 0 && n > joinSeen) {
        const openMgr = () => {
          if (profile.role === "super" && typeof switchView === "function") { switchView("admin"); if (window.CloudAdmin) window.CloudAdmin.open(); }
          else { show("cloudManageBox", true); renderManage("cloudManageBox"); const b = $("cloudManageBox"); if (b) b.scrollIntoView({ behavior: "smooth" }); }
        };
        if (typeof notifyAttention === "function") notifyAttention("新しい参加申請", "メンバーの参加申請が届きました（承認待ち " + n + "件）。承認してください。", openMgr);
        else try { if ("Notification" in window && Notification.permission === "granted") new Notification("メカノAI 参加申請", { body: "新しい参加申請が届きました（承認待ち " + n + "件）。" }); } catch (e) {}
      }
      joinSeen = n;
    }, () => {});
  }

  /* ---------- アプリからの書き込みフック ---------- */
  window.Cloud = {
    get active() { return !!(profile && profile.active && profile.tenantId && !deviceBlocked && !planBlocked); },
    myName() { return (profile && profile.name) || (me && me.email) || ""; },
    myUid() { return (me && me.uid) || ""; },
    myRole() { return (profile && profile.role) || ""; },
    tenantId() { return (profile && profile.tenantId) || ""; },
    isSuper() { return !!(profile && profile.role === "super"); },
    isLoggedIn() { return !!me; },
    // 契約状態(プラン・期限)。Web版Pocketの無料お試し残日数表示などに使用。
    trialInfo() {
      if (!tenantDoc) return null;
      return { plan: tenantDoc.plan || "", paidUntil: Number(tenantDoc.paidUntil) || 0 };
    },
    // メール(またはログインID)＋パスワードでログイン。Web版Pocketのログインモーダル等から使用。
    async login(emailOrId, pw) {
      await persistReady;
      let email = String(emailOrId || "").trim();
      if (!email || !pw) throw new Error("メール(またはログインID)とパスワードを入力してください。");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        const r = await fetch("https://" + FN_REGION + "-" + firebaseConfig.projectId + ".cloudfunctions.net/loginIdLookup", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: email }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.email) throw new Error("そのログインID／メールは見つかりません。");
        email = j.email;
      }
      await auth.signInWithEmailAndPassword(email, pw);
      return true;
    },
    // 管理者権限(未ログインの個人利用は自分が管理者扱い / ログイン中は admin・super のみ)
    isManager() { return !me || (profile && (profile.role === "admin" || profile.role === "super")); },
    // AIプロキシが使えるか(契約中の法人店舗)。真ならメカ君/OCRはサーバー経由=自分の鍵不要。
    //  ★個人版(Pocket=edition:personal)はサーバーAIを使わず「自分のGoogle APIキー」で動く設計。
    //    契約テナントでもPocketはサーバーAI対象外にして、運営のGemini枠を消費させない。
    aiReady() {
      if (tenantDoc && tenantDoc.edition === "personal") return false;
      return !!(this.active && tenantDoc && (tenantDoc.plan === "active" || tenantDoc.plan === "trial") && (!tenantDoc.paidUntil || Number(tenantDoc.paidUntil) >= Date.now()));
    },
    // この店舗が検索裏取りを使えるプランか(ターボ/ツインターボ)。真なら診断・修理で検索ONを送る。
    //  ※実際に検索できるか(月上限・席数)はサーバーが最終判定し、超過時は自動で検索なしに落とす。
    aiPaidOn() { const c = tierCode(); return c === "turbo" || c === "twinturbo"; },
    aiPlanCode() { return tierCode(); },
    aiPlanName() { return tierName(); },
    // 店舗メンバー名簿(uid/name)。カルテ担当者の候補表示などに使用。
    tenantMembers() { return tenantMembers.map(m => ({ uid: m.uid, name: m.name })); },
    // カルテ担当者テキスト→メンバー特定({uid,name} or null)。苗字/名前・漢字/カナ/かな/ローマ字で照合。
    resolveMember(text) { return resolveMember(text); },
    // Functions呼び出し(mecha/visionOcr/createCheckout)を通常HTTP+IDトークンで実行(callableは使わない)。
    async callFn(name, payload) {
      if (!me) throw new Error("ログインが必要です。");
      const idToken = await auth.currentUser.getIdToken();
      const r = await fetch("https://" + FN_REGION + "-" + firebaseConfig.projectId + ".cloudfunctions.net/" + name, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken },
        body: JSON.stringify(payload || {}),
      });
      let data = {}; try { data = await r.json(); } catch (e) {}
      if (!r.ok) throw new Error((data && data.error) || ("サーバーエラー " + r.status));
      return data;
    },
    /* ストリーミング版Functions呼び出し(mechaStream用)。SSE(data:{t}/{done})を受け、
       onChunk(累積テキスト, 完了フラグ)で逐次通知。{text,truncated}を返す。
       サーバーがSSEでなくJSONを返した場合(エラー/非対応)は従来通り処理する。 */
    async callFnStream(name, payload, onChunk) {
      if (!me) throw new Error("ログインが必要です。");
      const idToken = await auth.currentUser.getIdToken();
      const url = "https://" + FN_REGION + "-" + firebaseConfig.projectId + ".cloudfunctions.net/" + name;
      // iOS/Android(特にアプリ内ブラウザ)は fetch の ReadableStream を途中で打ち切ることがあり、
      // 回答が中途半端に終わる。モバイルでは XHR の responseText を逐次読み取る方式で全文を確実に受ける。
      const IS_MOBILE_CLIENT = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      if (IS_MOBILE_CLIENT) {
        return await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", url, true);
          xhr.setRequestHeader("Content-Type", "application/json");
          xhr.setRequestHeader("Authorization", "Bearer " + idToken);
          let seen = 0, full = "", truncated = false, usedModel = "", isStream = null;
          const parseSSE = (all) => {
            let chunk = all.slice(seen);
            let idx;
            while ((idx = chunk.indexOf("\n\n")) >= 0) {
              const evt = chunk.slice(0, idx); chunk = chunk.slice(idx + 2); seen = all.length - chunk.length;
              const line = evt.split("\n").find(l => l.indexOf("data:") === 0);
              if (!line) continue;
              const js = line.slice(5).trim(); if (!js) continue;
              try {
                const o = JSON.parse(js);
                if (o.t) { full += o.t; if (onChunk) onChunk(full, false); }
                if (o.done) { truncated = !!o.truncated; if (o.model) usedModel = o.model; }
              } catch (e) {}
            }
          };
          xhr.onprogress = () => {
            const ct = (xhr.getResponseHeader("content-type") || "");
            if (isStream === null) isStream = ct.indexOf("text/event-stream") >= 0;
            if (isStream) parseSSE(xhr.responseText);
          };
          xhr.onload = () => {
            const ct = (xhr.getResponseHeader("content-type") || "");
            const streamed = ct.indexOf("text/event-stream") >= 0;
            if (xhr.status >= 200 && xhr.status < 300 && streamed) {
              parseSSE(xhr.responseText);
              if (!full) return reject(new Error("AIから回答が得られませんでした"));
              if (onChunk) onChunk(full, true);
              return resolve({ text: full, truncated: truncated, model: usedModel || "proxy-stream" });
            }
            // 非ストリーム(エラーJSON or 通常JSON)
            let data = {}; try { data = JSON.parse(xhr.responseText); } catch (e) {}
            if (xhr.status < 200 || xhr.status >= 300) return reject(new Error((data && data.error) || ("サーバーエラー " + xhr.status)));
            if (data && typeof data.text === "string") { if (onChunk) onChunk(data.text, true); return resolve({ text: data.text, truncated: !!data.truncated, model: "proxy" }); }
            reject(new Error("AIから回答が得られませんでした"));
          };
          xhr.onerror = () => reject(new Error("通信に失敗しました"));
          xhr.send(JSON.stringify(payload || {}));
        });
      }
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken },
        body: JSON.stringify(payload || {}),
      });
      const ctype = r.headers.get("content-type") || "";
      if (!r.ok || !r.body || ctype.indexOf("text/event-stream") < 0) {
        // 非ストリーム応答(エラーJSON or 通常JSON)にフォールバック
        let data = {}; try { data = await r.json(); } catch (e) {}
        if (!r.ok) throw new Error((data && data.error) || ("サーバーエラー " + r.status));
        if (data && typeof data.text === "string") { if (onChunk) onChunk(data.text, true); return { text: data.text, truncated: !!data.truncated, model: "proxy" }; }
        throw new Error("AIから回答が得られませんでした");
      }
      const reader = r.body.getReader(); const dec = new TextDecoder();
      let buf = "", full = "", truncated = false, usedModel = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = evt.split("\n").find(l => l.indexOf("data:") === 0);
          if (!line) continue;
          const js = line.slice(5).trim(); if (!js) continue;
          try {
            const o = JSON.parse(js);
            if (o.t) { full += o.t; if (onChunk) onChunk(full, false); }
            if (o.done) { truncated = !!o.truncated; if (o.model) usedModel = o.model; }
          } catch (e) {}
        }
      }
      if (!full) throw new Error("AIから回答が得られませんでした");
      if (onChunk) onChunk(full, true);
      return { text: full, truncated: truncated, model: usedModel || "proxy-stream" };
    },
    fnsReady() { return true; },
    pushVehicle(rec) {
      if (!this.active || !rec || !rec.id) return;
      db.collection("tenants").doc(profile.tenantId).collection("vehicles").doc(String(rec.id)).set(rec, { merge: true }).catch(() => {});
    },
    deleteVehicle(id) {
      if (!this.active || !id) return;
      db.collection("tenants").doc(profile.tenantId).collection("vehicles").doc(String(id)).delete().catch(() => {});
    },
    pushRecord(r) {
      if (!this.active || !r || !(r.vin || r.rid)) return;
      db.collection("tenants").doc(profile.tenantId).collection("records").doc(docKey(r)).set(recordSubset(r), { merge: true }).catch(() => {});
    },
    /* レ点・費用など“小さな更新”を軽量に反映(specs/karte等の重いフィールドを送らず高速化・低コスト)。
       patch のフィールドだけをmerge。全端末への反映が速くなる。 */
    updateRecordFields(r, patch) {
      if (!this.active || !r || !(r.vin || r.rid) || !patch) return;
      const body = Object.assign({ vin: r.vin || null, rid: r.rid || null, deleted: false, updatedAt: r.updatedAt || Date.now() }, patch);
      db.collection("tenants").doc(profile.tenantId).collection("records").doc(docKey(r)).set(body, { merge: true }).catch(() => {});
    },
    deleteRecord(r) {
      if (!this.active || !r) return;
      // ハード削除ではなく墓標(deleted)で論理削除。古い端末の再アップロードで蘇るのを防ぐ
      db.collection("tenants").doc(profile.tenantId).collection("records").doc(docKey(r))
        .set({ deleted: true, vin: r.vin || null, rid: r.rid || null, updatedAt: Date.now() }, { merge: true }).catch(() => {});
    },
    signOut() { try { localStorage.removeItem("ss_hadSession"); } catch (e) {} try { auth.signOut(); } catch (e) {} },
    /* 明示的に通知を有効化(モバイルはユーザー操作が必要)。戻り値でUIに結果を返す */
    async enablePush() {
      const IAB = "この画面はアプリ内ブラウザで開かれています。通知を使うには、右上メニューから「Chrome / Safari で開く」か、ホーム画面に追加したアプリ（メカノAI）で開いてください。";
      // ブロック済みの時の解除手順(PC/スマホ共通の言い回し)
      const UNBLOCK = "ブラウザでこのサイトの通知が「ブロック」になっています。アドレスバー左の 🔒 または ⓘ アイコン → サイトの設定 →「通知」を『許可』に変更 → ページを再読み込みしてから、もう一度お試しください。（スマホのChromeは右上「⋮」→ サイト設定→通知）";
      try {
        if (!("Notification" in window) || !("serviceWorker" in navigator)) return { ok: false, msg: "この端末（またはアプリ内ブラウザ）は通知に対応していません。" + " " + IAB };
        // すでにブロック済みなら要求せず解除手順を案内(requestは即deniedを返すだけ)
        if (Notification.permission === "denied") return { ok: false, msg: UNBLOCK };
        // 端末/ブラウザがFCMに対応しているか事前判定(アプリ内ブラウザ等は非対応)
        let supported = true;
        try { if (firebase.messaging && typeof firebase.messaging.isSupported === "function") supported = await firebase.messaging.isSupported(); } catch (e) { supported = false; }
        if (!supported || typeof firebase.messaging !== "function") return { ok: false, msg: "この環境では通知（プッシュ）が使えません。" + IAB };
        const perm = await Notification.requestPermission();
        if (perm === "denied") return { ok: false, msg: UNBLOCK };
        if (perm !== "granted") return { ok: false, msg: "通知が許可されませんでした（保留）。もう一度「🔔通知を許可」を押し、表示されるダイアログで『許可』を選んでください。" };
        const reg = await navigator.serviceWorker.register("firebase-messaging-sw.js", { scope: "/firebase-cloud-messaging-push-scope" });
        const token = await firebase.messaging().getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
        if (!token) return { ok: false, msg: "通知トークンを取得できませんでした。もう一度お試しください。" };
        if (me) await db.collection("users").doc(me.uid).set({ fcmTokens: firebase.firestore.FieldValue.arrayUnion(token) }, { merge: true });
        await writeTenantPushToken(token);   // 店舗台帳にも登録(入庫・申請のプッシュ配信先)
        try { localStorage.setItem("ss_pushToken", token); localStorage.setItem("ss_pushOn", "1"); } catch (e) {}
        return { ok: true, msg: "✓ 通知を有効にしました。" + (officeNow() ? "新しい入庫がこの端末に届きます。" : "参加申請・入庫などがこの端末に届きます。") };
      } catch (e) {
        const m = (e && e.message) || String(e);
        if (/evaluation failed|unsupported|not supported|AbortError/i.test(m)) return { ok: false, msg: "この環境では通知（プッシュ）が使えません。" + IAB };
        return { ok: false, msg: "通知の有効化に失敗しました（" + m + "）" };
      }
    },
    /* この端末が通知ONかどうか(UIのボタン表示切替に使用)。
       ブラウザの許可が下りていれば通知は届く状態なので、明示的に無効化(ss_pushOn=0)していない限りONとみなす。
       →「更新」後の再読込でもボタンがOFFに戻って“許可がリセットされた”ように見える問題を防ぐ。 */
    pushEnabled() {
      try {
        if (localStorage.getItem("ss_pushOn") === "0") return false;   // ユーザーが明示的に無効化
        return ("Notification" in window) && Notification.permission === "granted";
      } catch (e) { return false; }
    },
    /* この端末の通知を無効化。配信先トークンを削除して以後届かないようにする */
    async disablePush() {
      let token = null;
      try { token = localStorage.getItem("ss_pushToken"); } catch (e) {}
      try {
        // 端末側のFCMトークンを無効化(再取得で別トークンになる)
        try { if (typeof firebase.messaging === "function") { const t = token || await firebase.messaging().getToken({ vapidKey: VAPID_KEY }).catch(() => null); if (t) { token = t; await firebase.messaging().deleteToken().catch(() => {}); } } } catch (e) {}
        if (token) {
          // 配信元台帳から削除(店舗の入庫/申請プッシュ先)
          try { if (profile && profile.tenantId) await db.collection("tenants").doc(profile.tenantId).collection("pushTokens").doc(token).delete(); } catch (e) {}
          try { if (me) await db.collection("users").doc(me.uid).set({ fcmTokens: firebase.firestore.FieldValue.arrayRemove(token) }, { merge: true }); } catch (e) {}
        }
        try { localStorage.removeItem("ss_pushToken"); localStorage.setItem("ss_pushOn", "0"); } catch (e) {}
        return { ok: true, msg: "通知を無効にしました。この端末には届かなくなります。（ブラウザ側の許可設定はそのままです）" };
      } catch (e) {
        try { localStorage.setItem("ss_pushOn", "0"); } catch (e2) {}
        return { ok: true, msg: "通知を無効にしました。" };
      }
    },
  };

  /* ---------- メンバー/会社 管理 (admin=自社cloudManageBox / super=運営タブadminBox) ---------- */
  $("btnCloudManage") && $("btnCloudManage").addEventListener("click", () => {
    const box = $("cloudManageBox");
    if (!box.classList.contains("hidden")) { show("cloudManageBox", false); return; }
    show("cloudManageBox", true); renderManage("cloudManageBox");
  });
  function syncEnablePushBtn() {
    const b = $("btnEnablePush"); if (!b) return;
    const on = window.Cloud && typeof window.Cloud.pushEnabled === "function" && window.Cloud.pushEnabled();
    b.textContent = on ? "🔕 通知を無効にする" : "🔔 通知を有効にする";
  }
  syncEnablePushBtn();
  $("btnEnablePush") && $("btnEnablePush").addEventListener("click", async () => {
    const b = $("btnEnablePush"); b.disabled = true; b.textContent = "設定中…";
    const on = window.Cloud.pushEnabled();
    const r = on ? await window.Cloud.disablePush() : await window.Cloud.enablePush();
    b.disabled = false; syncEnablePushBtn();
    const el = $("cloudSyncMsg"); if (el) el.textContent = r.msg;
    try { alert(r.msg); } catch (e) {}
  });
  // 運営管理者(自分)の情報を運営タブ上部に表示
  function renderOperatorInfo() {
    const el = $("adminOperator"); if (!el) return;
    if (!me || !profile || profile.role !== "super") { el.innerHTML = ""; return; }
    const who = profile.name ? esc(profile.name) : esc(me.email);
    const mode = (window.getAppMode && window.getAppMode()) || "corp";
    el.innerHTML = "<div class='opCard'><span class='opBadge'>運営管理者</span>" +
      "<span class='opNm'>" + who + "</span>" +
      "<div class='opMail'>" + esc(me.email) + "</div>" +
      "<div class='modeSwitch' id='appModeSw'>" +
        "<button data-mode='corp' class='" + (mode === "corp" ? "on" : "") + "'>Works</button>" +
        "<button data-mode='personal' class='" + (mode === "personal" ? "on" : "") + "'>Pocket</button>" +
      "</div>" +
      "</div>";
    const sw = $("appModeSw");
    if (sw) sw.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      if (window.setAppMode) window.setAppMode(b.dataset.mode);
      renderOperatorInfo();   // スイッチの選択状態を更新
    }));
  }
  // 契約申し込み(請求書送付先)の一覧。運営が請求書発行→対応完了にする。
  async function renderSignups() {
    const el = $("adminSignups"); if (!el) return;
    if (!me || !profile || profile.role !== "super") { el.innerHTML = ""; return; }
    el.innerHTML = "";
    let docs = [];
    try { const s = await db.collection("signups").where("status", "==", "requested").get(); docs = s.docs; } catch (e) { el.innerHTML = "<div class='hint'>申し込みの取得に失敗: " + esc(e.message || e) + "</div>"; return; }
    if (!docs.length) return;
    const planJa = p => p === "yearly" ? "年契約" : "月額";
    let html = "<div class='signupBox'><div class='signupTtl'>🔔 契約の申し込み <b>" + docs.length + "件</b></div>";
    docs.forEach(d => {
      const s = d.data();
      const when = s.at ? new Date(s.at).toLocaleDateString("ja-JP") : "";
      html += "<div class='signupItem'><div class='signupInfo'><b>" + esc(s.tenantId || "") + "</b> ／ " + esc(planJa(s.plan)) +
        "<div class='signupMail'>" + esc(s.email || "") + "</div>" +
        "<div class='signupMeta'>" + esc(s.byName || "") + " ・ " + esc(when) + "</div></div>" +
        "<div class='signupBtns'><a class='btn btn-ghost btn-sm' href='mailto:" + esc(s.email) + "?subject=" + encodeURIComponent("【メカノAI】ご契約の請求書") + "'>メール</a>" +
        "<button class='btn btn-ghost btn-sm' data-done='" + d.id + "'>対応完了</button></div></div>";
    });
    html += "</div>";
    el.innerHTML = html;
    el.querySelectorAll("[data-done]").forEach(b => b.addEventListener("click", async () => {
      try { await db.collection("signups").doc(b.dataset.done).update({ status: "done", handledAt: Date.now() }); renderSignups(); }
      catch (e) { uiAlert("更新失敗: " + (e.message || e)); }
    }));
  }
  $("btnAdminReload") && $("btnAdminReload").addEventListener("click", () => { renderOperatorInfo(); renderSignups(); renderManage("adminBox"); });
  window.CloudAdmin = { open() { renderOperatorInfo(); renderSignups(); renderManage("adminBox"); } };  // app.jsのタブ切替から呼ぶ
  async function renderManage(boxId) {
    const box = $(boxId); if (!box || !profile) return;
    box.innerHTML = "読み込み中…";
    try {
      // メンバー取得(super=全件 / admin=自社)
      let uq = db.collection("users");
      if (profile.role === "admin") uq = uq.where("tenantId", "==", profile.tenantId);
      const us = await uq.get();
      const byTenant = {};
      // 運営管理者(super)は独立。店舗のメンバー一覧には出さない(代表管理者からは見えない)
      us.forEach(d => { const u = d.data(); if (u.role === "super") return; const t = u.tenantId || "（未所属）"; (byTenant[t] = byTenant[t] || []).push({ id: d.id, u }); });

      let html = "", statTids = [];
      if (profile.role === "super") {
        const ts = await db.collection("tenants").get();
        const tlist = ts.docs.map(d => ({ id: d.id, t: d.data() }));
        // 会社ごとにカード化(会社→所属メンバー)
        tlist.forEach(({ id, t }) => {
          const sid = id.replace(/[^a-zA-Z0-9_-]/g, ""); statTids.push(id);
          const cnt = (byTenant[id] || []).length;
          html += "<div class='mTenant'><div class='mTenantHead' data-toggle>" +
            "<span class='mChevron'>▸</span>" +
            "<span class='mName'>" + esc(t.code || id) + (t.code ? " <span style='color:var(--dim,#89a);font-size:11px'>(" + esc(id) + ")</span>" : "") + (t.active ? "" : "<span style='color:var(--alert)'>（承認待ち）</span>") + "</span>" +
            "<span class='mCount'>👥 " + cnt + "</span>" +
            "<span class='mtBtns'>" + btn("plan", "t", id, "プラン") +
            btn("syncplan", "t", id, "🔄同期") +
            btn("tcode", "t", id, "コード変更") +
            btn("aitier", "t", id, "AI:" + tierName(t), tierCode(t) === "na" ? "btn-ghost" : "btn-amber") +
            (t.active ? btn("off", "t", id, "停止") : btn("on", "t", id, "承認", "btn-amber") + btn("del", "t", id, "削除")) + "</span></div>" +
            "<div class='mBody hidden'>" +
            "<div class='mStat' id='stat_" + sid + "'>利用状況を取得中…</div>" +
            membersHtml(byTenant[id], t) + "</div></div>";
          delete byTenant[id];
        });
        // どの会社にも紐づかないユーザー
        Object.keys(byTenant).forEach(t => {
          const cnt = (byTenant[t] || []).length;
          html += "<div class='mTenant'><div class='mTenantHead' data-toggle><span class='mChevron'>▸</span><span class='mName'>" + esc(t) + "</span><span class='mCount'>👥 " + cnt + "</span></div>" +
            "<div class='mBody hidden'>" + membersHtml(byTenant[t]) + "</div></div>";
        });
      } else {
        // admin: 自店舗のメンバーのみ(AI有料/無料の状態は運営専用のため非表示)
        html += "<div class='mTenant'><div class='mTenantHead'><span class='mName'>" + esc(profile.tenantId) + " のメンバー</span></div><div class='mBody'>" + membersHtml(byTenant[profile.tenantId], tenantDoc) + "</div></div>";
      }
      box.innerHTML = html || "メンバーがいません。";
      // 会社ヘッダーのタップでメンバーを開閉(ボタンのクリックは除外)
      box.querySelectorAll(".mTenantHead[data-toggle]").forEach(head => head.addEventListener("click", e => {
        if (e.target.closest("[data-act]")) return;
        const body = head.nextElementSibling;
        if (body) body.classList.toggle("hidden");
        head.classList.toggle("open", body && !body.classList.contains("hidden"));
      }));
      box.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", async e => { e.stopPropagation(); const r = await manageAction(b.dataset.kind, b.dataset.id, b.dataset.act, b); if (r !== "inplace") renderManage(boxId); }));
      statTids.forEach(t => fillTenantStats(t));
    } catch (e) { box.innerHTML = "⚠ 読み込み失敗: " + (e.message || e); }
  }
  function btn(act, kind, id, label, cls) { return "<button class='btn " + (cls || "btn-ghost") + " btn-sm' data-act='" + act + "' data-kind='" + kind + "' data-id='" + esc(id) + "'>" + label + "</button>"; }
  function membersHtml(list, t) {
    if (!list || !list.length) return "<div class='mStat'>メンバーなし</div>";
    // 代表管理者を先頭、従業員、運営管理者(在籍表示)は末尾に
    const rank = r => r === "admin" ? 2 : r === "super" ? 0 : 1;
    list.sort((a, b) => rank(b.u.role) - rank(a.u.role));
    return list.map(x => userRow(x.id, x.u, t)).join("");
  }
  function userRow(id, u, t) {
    const roleJa = ({ super: "運営管理者", admin: "代表管理者", staff: "メンバー" }[u.role] || u.role);
    // 運営管理者(super)は店舗の管理対象ではない。操作ボタン無しで「在籍」だけ表示(誤って無効化されない)
    if (u.role === "super") {
      const infoS = "<div class='mInfo'><div class='mTop'><span class='mNm'>" + esc(u.name || u.email || id) + "</span><span class='mRole adm'>運営管理者</span></div>" +
        (u.email ? "<div class='mMail'>" + esc(u.email) + "</div>" : "") +
        "<div class='mMeta'>運営（この店舗にはデータ共有のため在籍）</div></div>";
      return "<div class='mRow mRowSuper'>" + infoS + "</div>";
    }
    const isAdmin = u.role === "admin" || u.role === "super";
    const fmt = ms => { const d = new Date(ms); return d.toLocaleDateString("ja-JP") + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
    const reg = u.createdAt ? "登録 " + new Date(u.createdAt).toLocaleDateString("ja-JP") : "";
    const last = u.lastLogin ? "最終ログイン " + fmt(u.lastLogin) : "未ログイン";
    const devN = Array.isArray(u.devices) ? u.devices.length : 0;
    const devLimit = Number(u.deviceLimit) || 2;
    // 端末枠 +/- は名前行の右端に(運営=superのみ・有効ユーザーのみ)。−は枠2超のときだけ。
    const devCtrl = (u.active && profile && profile.role === "super")
      ? "<span class='mDev'>" + (devLimit > 2 ? "<button class='mDevBtn' data-act='devminus' data-kind='u' data-id='" + esc(id) + "'>−</button>" : "") +
        "<span class='mDevN'>" + devN + "/" + devLimit + "</span>" +
        "<button class='mDevBtn' data-act='devplus' data-kind='u' data-id='" + esc(id) + "'>＋</button></span>"
      : "";
    const info = "<div class='mInfo'>" +
      "<div class='mTop'><span class='mNm'>" + esc(u.name || u.email || id) + "</span>" +
      (isAdmin ? "<span class='mRole adm'>" + roleJa + "</span>" : "") + devCtrl + "</div>" +
      (u.email ? "<div class='mMail'>" + esc(u.email) + "</div>" : "") +
      "<div class='mMeta'>" + esc(last) + (reg ? " ・ " + esc(reg) : "") + " ・ 端末 " + devN + "/" + devLimit + "台</div></div>";
    // 検索席の指名トグル(ツインターボ店舗の有効メンバーのみ表示)。ON=このメンバーが検索を使える。
    let seatBtn = "";
    if (t && tierCode(t) === "twinturbo" && u.active) {
      const on = Array.isArray(t.seatMembers) && t.seatMembers.indexOf(id) >= 0;
      seatBtn = btn(on ? "seatoff" : "seaton", "u", id, on ? "🔎席 ✓" : "🔎席", on ? "btn-amber" : "btn-ghost");
    }
    let btns;
    if (u.active) {
      // 役割変更ボタン(staff→代表者に / admin→従業員に)。運営(super)は変更不可
      const roleBtn = u.role === "staff" ? btn("promote", "u", id, "代表者に")
        : u.role === "admin" ? btn("demote", "u", id, "メンバーに") : "";
      btns = seatBtn + btn("rename", "u", id, "✎ 名前") + roleBtn + btn("pwreset", "u", id, "🔑 パスワード") + btn("off", "u", id, "無効化");
    } else btns = btn("rename", "u", id, "✎ 名前") + btn("on", "u", id, "承認", "btn-amber") + btn("del", "u", id, "却下");
    return "<div class='mRow'>" + info + "<div class='mBtns'>" + btns + "</div></div>";
  }
  async function fillTenantStats(tid) {
    const el = $("stat_" + tid.replace(/[^a-zA-Z0-9_-]/g, "")); if (!el) return;
    try {
      let [v, r, u, usage, td] = await Promise.all([
        db.collection("tenants").doc(tid).collection("vehicles").get().then(s => s.size).catch(() => "?"),
        db.collection("tenants").doc(tid).collection("records").get().then(s => s.size).catch(() => "?"),
        db.collection("users").where("tenantId", "==", tid).get().then(s => s.size).catch(() => "?"),
        db.collection("usage").doc(tid).get().then(s => s.data() || {}).catch(() => ({})),
        db.collection("tenants").doc(tid).get().then(s => s.data() || {}).catch(() => ({})),
      ]);
      // Stripe契約がある店舗は、一覧表示時にプランを自動同期(🔄手動不要)。
      if (td && td.stripeCustomerId) {
        try { await window.Cloud.callFn("syncPlan", { tid: tid }); td = (await db.collection("tenants").doc(tid).get()).data() || td; } catch (e) {}
      }
      const jstDay = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const jstMonth = jstDay.slice(0, 7);
      const code = tierCode(td), cap = code === "turbo" ? 500 : (code === "twinturbo" ? -1 : 0);
      const mPaid = (usage.pMonth === jstMonth) ? (usage.mPaid || 0) : 0;
      let ai = " ／ 🔧 " + tierName(td);
      if (code === "turbo") ai += "（検索 今月 " + mPaid + "/500回）";
      else if (code === "twinturbo") {
        const assigned = Array.isArray(td.seatMembers) ? td.seatMembers.length : 0;
        ai += "（検索 今月 " + mPaid + "回・指名席 " + assigned + "/" + (td.searchSeats || 3) + "）";
      }
      if (usage.dMecha) ai += " ／ 🤖 AI本日 " + usage.dMecha + "回";
      el.textContent = "👥 メンバー " + u + "人 ／ 🚗 車種DB " + v + "件 ／ 📋 車両 " + r + "台" + ai;
    } catch (e) { el.textContent = "利用状況の取得に失敗"; }
  }
  async function manageAction(kind, id, act, btnEl) {
    try {
      const col = kind === "t" ? "tenants" : "users";
      if (act === "pwreset") {
        // その場で一時パスワードを発行(サーバーで再設定)。メール配信に依存しない復旧手段。
        const doc = await db.collection("users").doc(id).get(); const u = doc.data() || {};
        if (!confirm("「" + (u.name || u.email || id) + "」の一時パスワードを発行しますか？\n（今のパスワードは無効になります。発行後に画面へ表示します）")) return;
        try {
          const d = await window.Cloud.callFn("setMemberPassword", { targetUid: id });
          if (d && d.password) {
            prompt("一時パスワードを発行しました。\n本人にこのパスワードでログインしてもらい、後で各自で変更してください。\n（下の文字を長押しでコピーできます）", d.password);
          } else { uiAlert("発行に失敗しました。"); }
        } catch (e) { uiAlert("発行に失敗: " + (e.message || e)); }
        return;
      }
      if (act === "seaton" || act === "seatoff") {
        // 検索席の指名/解除。id=メンバーuid。店舗(tenantId)を引いて assignSeat を呼ぶ。
        //  ★一覧の全体再描画はカードが畳まれて変化が見えないため、ボタンをその場で切り替える。
        const d = await db.collection("users").doc(id).get(); const u = d.data() || {};
        if (!u.tenantId) { uiAlert("所属店舗が不明です。"); return "inplace"; }
        const on = act === "seaton";
        if (btnEl) btnEl.disabled = true;
        try {
          await window.Cloud.callFn("assignSeat", { tid: u.tenantId, uid: id, on: on });
          if (btnEl) {
            btnEl.dataset.act = on ? "seatoff" : "seaton";
            btnEl.textContent = on ? "🔎席 ✓" : "🔎席";
            btnEl.classList.toggle("btn-amber", on);
            btnEl.classList.toggle("btn-ghost", !on);
          }
        } catch (e) { uiAlert("検索席の変更に失敗: " + (e.message || e)); }
        finally { if (btnEl) btnEl.disabled = false; }
        return "inplace";
      }
      if (act === "tcode") {
        // 運営(super)は店舗コード(別名)を何度でも変更できる。
        const cur = (await db.collection("tenants").doc(id).get()).data() || {};
        let nc = (prompt("店舗「" + (cur.code || id) + "」の店舗コードを変更\n（会社名など・半角英数字とハイフン・3〜24文字）\n※運営は何度でも変更できます。空欄で取消。", cur.code || id) || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (!nc) return;
        try { const r = await window.Cloud.callFn("setTenantCode", { tid: id, code: nc }); uiAlert("店舗コードを変更しました：" + (r.code || nc)); }
        catch (e) { uiAlert("変更できませんでした：" + (e.message || e)); }
        return;
      }
      if (act === "syncplan") {
        // Stripeの現契約から plan/aiPlan/期限 を取り込む(webフックの取りこぼし救済)。
        try {
          const r = await window.Cloud.callFn("syncPlan", { tid: id });
          const nm = { na: "NA", turbo: "ターボ", twinturbo: "ツインターボ" }[r.aiPlan] || r.aiPlan;
          uiAlert("Stripeと同期しました。\nプラン: " + nm + (r.paidUntil ? "\n期限: " + new Date(r.paidUntil).toLocaleDateString("ja-JP") : ""));
        } catch (e) { uiAlert("同期に失敗: " + (e.message || e)); }
        return;
      }
      if (act === "aitier") {
        // AIプラン(検索裏取りの段階)を設定。1=NA(検索なし) 2=ターボ(月500) 3=ツインターボ(無制限・席数)
        const cur = (await db.collection("tenants").doc(id).get()).data() || {};
        const nowCode = (cur.aiPlan === "turbo" || cur.aiPlan === "twinturbo" || cur.aiPlan === "na") ? cur.aiPlan : (cur.aiPaidFallback === true ? "twinturbo" : "na");
        const ans = (prompt("店舗「" + id + "」のAIプラン\n1 = NA（検索なし・¥7,980）\n2 = ターボ（検索 月500回・¥12,800）\n3 = ツインターボ（検索 無制限・席数制・¥19,800）\n\n現在: " + ({ na: "NA", turbo: "ターボ", twinturbo: "ツインターボ" }[nowCode]), nowCode === "turbo" ? "2" : nowCode === "twinturbo" ? "3" : "1") || "").trim();
        if (!ans) return;
        const map = { "1": "na", "2": "turbo", "3": "twinturbo" };
        const plan = map[ans];
        if (!plan) { uiAlert("1〜3で入力してください。"); return; }
        await db.collection("tenants").doc(id).set({ aiPlan: plan, aiPaidFallback: (plan !== "na") }, { merge: true });   // aiPaidFallbackは後方互換で連動
        if (plan === "twinturbo") {
          const seatsAns = (prompt("ツインターボの検索『席数』（検索を使える人数／月）\n3席は標準。4席目以降は +¥3,000/席（月額）または +¥36,000/席（年額）を、次回請求にまとめて自動計上します。", String(cur.searchSeats || 3)) || "").trim();
          const seats = parseInt(seatsAns, 10);
          if (!isNaN(seats) && seats >= 1) {
            try {
              const r = await window.Cloud.callFn("setSeats", { tid: id, seats });
              uiAlert("ツインターボに設定しました。席数 " + r.seats + (r.extra > 0 ? "（追加 " + r.extra + "席）" : "") + "。\n" + (r.note || (r.billed ? "追加席は次回請求にまとめて計上されます。" : "")));
            } catch (e) { uiAlert("プランは設定しましたが、席数設定に失敗: " + (e.message || e)); }
          } else { uiAlert("AIプランを「ツインターボ」にしました（席数は据え置き）。"); }
        } else {
          uiAlert("AIプランを「" + ({ na: "NA", turbo: "ターボ" }[plan]) + "」にしました。");
        }
        return;
      }
      if (act === "rename") {
        const doc = await db.collection("users").doc(id).get(); const u = doc.data() || {};
        const nn = (prompt("新しい氏名を入力してください", u.name || "") || "").trim();
        if (!nn || nn === u.name) return;
        await db.collection("users").doc(id).update({ name: nn });
        if ((u.role === "admin" || u.role === "super") && u.tenantId) await db.collection("tenants").doc(u.tenantId).set({ adminName: nn }, { merge: true });
      } else if (act === "del") {
        if (!confirm("この申請を却下し、記録（氏名・メール）を完全に削除しますか？（取り消せません）")) return;
        await db.collection(col).doc(id).delete();
      } else if (act === "promote") {
        // 代表管理者に“追加”指名(複数人OK)。他の代表は降格しない。
        if (!confirm("このメンバーを代表管理者にしますか？\n（代表管理者は複数人でも設定できます）")) return;
        const tdoc = await db.collection("users").doc(id).get(); const tu = tdoc.data() || {};
        await db.collection("users").doc(id).update({ role: "admin", active: true });
        // 店舗の代表者名(tenants.adminName)は運営(super)のみ更新可。adminが実行しても失敗しないよう super時のみ・かつ try で握りつぶす。
        if (profile && profile.role === "super" && tu.tenantId) { try { await db.collection("tenants").doc(tu.tenantId).set({ adminName: tu.name || "" }, { merge: true }); } catch (e) {} }
        uiAlert("代表管理者に設定しました。");
      } else if (act === "demote") {
        if (!confirm("この代表管理者をメンバーに変更しますか？")) return;
        await db.collection("users").doc(id).update({ role: "staff" });
      } else if (act === "plan") {
        // 手動設定は「早期解除(停止・前倒し)」のみ。延長はできない(延長はStripeの年契約=webhookで行う)。
        const cur = await db.collection("tenants").doc(id).get(); const td = cur.data() || {};
        const curUntil = td.paidUntil ? Number(td.paidUntil) : 0;
        const msg = "店舗「" + id + "」の利用停止（早期解除）\n"
          + "0 = 今すぐ停止\n"
          + "数字 = ○日後に停止（現在の期限より前のみ）\n"
          + (curUntil ? "現在の期限: " + new Date(curUntil).toLocaleDateString("ja-JP") + "\n" : "")
          + "※延長はできません。延長したい場合はStripe（年契約）で更新してください。";
        const ans = (prompt(msg, "0") || "").trim();
        if (ans === "") return;
        const days = parseInt(ans, 10);
        if (isNaN(days) || days < 0) { uiAlert("数字を入力してください。"); return; }
        if (days === 0) { await db.collection("tenants").doc(id).set({ plan: "suspended" }, { merge: true }); uiAlert("停止しました。"); }
        else {
          const until = Date.now() + days * 24 * 3600 * 1000;
          if (curUntil && until >= curUntil) { uiAlert("延長はできません（現在の期限より前の日付のみ）。\n延長はStripe（年契約）で更新してください。"); return; }
          await db.collection("tenants").doc(id).set({ plan: "active", paidUntil: until }, { merge: true });
          uiAlert(new Date(until).toLocaleDateString("ja-JP") + " に停止するよう設定しました。");
        }
      } else if (act === "devplus") {
        // 端末枠+1。追加端末分は自動でStripe(月/年)に合算(次サイクル請求)。
        const r = await window.Cloud.callFn("setDevices", { uid: id, delta: 1 });
        uiAlert("端末枠を " + r.deviceLimit + " 台に増やしました。\n" + (r.note || (r.billed ? "追加分は次回請求にまとめて計上されます。" : "")));
      } else if (act === "devminus") {
        const r = await window.Cloud.callFn("setDevices", { uid: id, delta: -1 });
        uiAlert("端末枠を " + r.deviceLimit + " 台にしました。\n" + (r.note || ""));
      } else if (act === "on") { await db.collection(col).doc(id).update({ active: true, rejected: false }); }
      else await db.collection(col).doc(id).update({ active: false });
    } catch (e) { uiAlert("操作失敗: " + (e.message || e)); }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  /* ---------- 紹介用QR(アプリURL) ---------- */
  try {
    // ?corp=1 付き: このQRは法人メンバー紹介用。読み取ると法人版ログインをデフォルト表示する。
    const appUrl = (location.origin + location.pathname).replace(/index\.html$/, "") + "?corp=1";
    const qr = $("appQr");
    if (qr) {
      const enc = encodeURIComponent(appUrl);
      qr.src = "https://quickchart.io/qr?size=240&margin=1&text=" + enc;
      qr.onerror = () => { qr.onerror = null; qr.src = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=0&data=" + enc; };
    }
    const ut = $("appUrlText"); if (ut) ut.textContent = appUrl;
  } catch (e) {}

  /* ---------- 運営の隠し入口(ヘッダーを素早く5回タップ) ---------- */
  let pendingSuperOpen = false;
  function openAdminIfSuper() {
    if (profile && profile.active && profile.role === "super" && typeof switchView === "function") {
      show("superLogin", false); pendingSuperOpen = false; switchView("admin"); return true;
    }
    return false;
  }
  try {
    const hdr = document.querySelector("header"); let taps = 0, tm = null;
    if (hdr) hdr.addEventListener("click", () => {
      // 個人版(Pocket=ストア版/Web版とも)では管理者(運営)ログインへの5回タップ導線を無効化
      const isPersonal = document.body.classList.contains("storeApp") ||
        (typeof window.getAppMode === "function" && window.getAppMode() === "personal");
      if (isPersonal) { taps = 0; return; }
      taps++; clearTimeout(tm); tm = setTimeout(() => taps = 0, 1500);
      if (taps >= 5) {
        taps = 0;
        if (!openAdminIfSuper()) { show("superLogin", true); $("superStat").textContent = ""; }  // 未ログイン/非super → 運営ログイン
      }
    });
  } catch (e) {}
  $("btnSuperCancel") && $("btnSuperCancel").addEventListener("click", () => show("superLogin", false));
  $("btnSuperLogin") && $("btnSuperLogin").addEventListener("click", async () => {
    const email = ($("superEmail").value || "").trim(), pw = $("superPw").value;
    if (!email || !pw) { $("superStat").textContent = "メールとパスワードを入力してください。"; return; }
    $("superStat").textContent = "ログイン中…"; pendingSuperOpen = true;
    try { await persistReady; await auth.signInWithEmailAndPassword(email, pw); }
    catch (e) { pendingSuperOpen = false; $("superStat").textContent = "⚠ " + authErr(e); }
  });
})();
