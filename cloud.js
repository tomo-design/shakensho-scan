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
  let unsubVeh = null, unsubRec = null, unsubJoin = null;
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
  function planLabel() {
    if (!tenantDoc) return "";
    const until = tenantDoc.paidUntil ? new Date(Number(tenantDoc.paidUntil)) : null;
    const u = until ? until.toLocaleDateString("ja-JP") : "";
    if (tenantDoc.plan === "suspended") return "⛔ 停止中";
    if (tenantDoc.paidUntil && Number(tenantDoc.paidUntil) < Date.now()) return "⛔ 期限切れ（" + u + "）";
    if (tenantDoc.plan === "active") return "✓ 契約中" + (u ? "（〜" + u + "）" : "");
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
    } catch (e) { alert("端末の解除に失敗しました: " + (e.message || e)); }
  }
  /* 店舗のお支払い(月額) — 折り畳み。代表管理者のみ表示。決済リンクは後で差し込む。 */
  function renderPlan() {
    const box = $("cloudPlan"); if (!box) return;
    const isAdmin = profile && (profile.role === "admin" || profile.role === "super");
    if (!me || !profile || !profile.active || !isAdmin) { box.innerHTML = ""; show("cloudPlan", false); return; }
    const lbl = planLabel();
    const canCancel = !!(tenantDoc && tenantDoc.plan === "active");
    const body = '<div class="sec-body">' +
      '<div class="planHead">現在の状態: <b>' + (lbl || "未契約（無料/試用）") + '</b></div>' +
      '<div class="planPerk"><div class="planPerkTtl">契約の特典</div><ul class="planPerkList">' +
        '<li>車両データ・車種DB・整備カルテを<b>社内の全端末で自動共有</b></li>' +
        '<li>従業員は<b>何人でも参加OK</b>（1人2端末まで無料）</li>' +
        '<li>車検証スキャン・メカ君AI・整備カルテを<b>フル機能</b>で利用</li>' +
        '<li>更新・追加機能を随時反映／メール優先サポート</li>' +
      '</ul></div>' +
      '<div class="signupForm">' +
        '<div class="fld">ご希望のプラン</div>' +
        '<label class="signupRadio"><input type="radio" name="signupPlan" value="monthly" checked> 月額</label>' +
        '<label class="signupRadio"><input type="radio" name="signupPlan" value="yearly"> 年契約（お得）</label>' +
        '<div class="planBtns"><button class="btn btn-amber btn-sm" id="btnSignupSend">📝 申し込み・お支払いへ進む</button></div>' +
        '<div id="signupStat" class="planNote"></div>' +
      '</div>' +
      (canCancel ? '<div class="planCancel"><button class="textlink" id="btnPlanCancel" type="button">解約する</button></div>' : '') +
      '</div>';
    box.innerHTML = '<section><details><summary class="secSummary">契約・解約</summary>' + body + '</details></section>';
    const send = $("btnSignupSend"); if (send) send.onclick = async () => {
      const planPref = (document.querySelector('input[name="signupPlan"]:checked') || {}).value || "monthly";
      send.disabled = true; $("signupStat").textContent = "お支払いページを準備中…";
      // 請求書(お支払いページ)を作成。カード/銀行振込/コンビニを選べるページへ遷移。
      try {
        const d = await window.Cloud.callFn("createCheckout", { plan: planPref, email: me.email || "" });
        if (d && d.url) { $("signupStat").textContent = "お支払いページを開きます…"; window.location.href = d.url; return; }
        if (d && d.invoiceSent) { $("signupStat").innerHTML = "✓ 請求書メールを送りました。メール内のリンクからお支払いください。"; send.disabled = false; return; }
        throw new Error("お支払いページを取得できませんでした");
      } catch (e) {
        send.disabled = false; $("signupStat").textContent = "⚠ 手続きに失敗しました: " + (e.message || e);
      }
    };
    const cx = $("btnPlanCancel"); if (cx) cx.onclick = async () => {
      if (!confirm("解約しますか？\n現在の契約期間の終了日まで利用でき、その後は自動で停止します（追加の請求はありません）。")) return;
      cx.disabled = true; const st = $("signupStat"); if (st) st.textContent = "解約手続き中…";
      try {
        const d = await window.Cloud.callFn("cancelPlan", {});
        if (st) st.textContent = "✓ 解約を受け付けました。" + (d && d.until ? new Date(d.until).toLocaleDateString("ja-JP") + " まで利用できます。" : "次回更新日以降の請求は停止されます。");
      } catch (e) { cx.disabled = false; if (st) st.textContent = "⚠ 解約に失敗しました: " + (e.message || e); }
    };
    // 支払いページから戻った(bfcache)とき、進行中表示を確実にリセット
    if (!planPageshowBound) { planPageshowBound = true; window.addEventListener("pageshow", e => { if (e.persisted && me && profile) renderPlan(); }); }
    show("cloudPlan", true);
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
        '・端末を増やしたい場合は<b>追加端末（有料）</b>の登録が必要です（準備中）。<br>' +
        'それまでこの端末は<b>個人利用（ローカル保存）</b>で使えます（社内共有はされません）。</div>';
    }
    body += '<div class="planBtns"><button class="btn btn-ghost btn-sm" id="btnDevBuy">➕ 追加端末（3台目〜・有料）</button></div>' +
      '<div class="planNote">2台目まで無料。3台目以降は追加端末の登録が必要です（お支払いは準備中）。</div>';
    body += '</div>';
    const tag = deviceBlocked ? ' <span class="foldTag warn">要対応</span>' : '';
    box.innerHTML = '<details class="foldCard"' + (deviceBlocked ? ' open' : '') + '><summary>📱 登録端末（' + devices.length + '/' + limit + '台）' + tag + '</summary>' + body + '</details>';
    box.querySelectorAll(".devDel").forEach(b => b.addEventListener("click", () => {
      if (confirm("この端末の登録を解除しますか？（その端末では社内共有が使えなくなります）")) removeDevice(b.dataset.id);
    }));
    const buy = $("btnDevBuy"); if (buy) buy.onclick = () => alert("追加端末の購入は準備中です。\n\n現在は「無料2台まで」。使わない端末を『解除』すれば別の端末で使えます。");
    show("cloudDevices", true);
  }

  /* ---------- 認証フロー(モード選択 → フォーム出現) ---------- */
  let cloudMode = "login";
  function openForm(mode) {
    cloudMode = mode;
    show("cloudChoice", false); show("cloudForm", true);
    show("tenantField", mode !== "login");
    show("nameField", mode !== "login");
    $("cloudFormTitle").textContent = mode === "new" ? "管理者として会社を新規登録（1社1名）" : mode === "join" ? "従業員として会社に参加（承認待ちになります）" : "ログイン";
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
      const email = $("cloudEmail").value.trim(), pw = $("cloudPw").value;
      if (!email || !pw) { $("cloudAuthStat").textContent = "メールとパスワードを入力してください。"; return; }
      $("cloudAuthStat").textContent = "ログイン中…";
      try { await persistReady; await auth.signInWithEmailAndPassword(email, pw); }
      catch (e) { $("cloudAuthStat").textContent = "⚠ " + authErr(e); }
    } else { signup(cloudMode === "new"); }
  });
  $("btnCloudLogout") && $("btnCloudLogout").addEventListener("click", () => auth.signOut());
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
    const name = $("cloudName").value.trim();
    const email = $("cloudEmail").value.trim(), pw = $("cloudPw").value;
    const tid = ($("cloudTenant").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""));
    if (!name) { $("cloudAuthStat").textContent = "氏名を入力してください。"; return; }
    if (!email || pw.length < 6) { $("cloudAuthStat").textContent = "メールと6文字以上のパスワードを入力してください。"; return; }
    if (!tid) { $("cloudAuthStat").textContent = "事業所IDを入力してください(半角英数)。"; return; }
    $("cloudAuthStat").textContent = "登録中…";
    // 管理者の新規登録は1社1名: 既に会社が存在していたら拒否
    if (isNewCompany) {
      try {
        const t = await db.collection("tenants").doc(tid).get();
        if (t.exists) { $("cloudAuthStat").textContent = "⚠ この事業所IDは既に登録されています。従業員として参加してください。"; return; }
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
    // 店舗の契約状態を読み込む
    deviceBlocked = false; planBlocked = false; tenantDoc = null;
    if (profile && profile.tenantId) {
      try { tenantDoc = (await db.collection("tenants").doc(profile.tenantId).get()).data() || null; } catch (e) { tenantDoc = null; }
    }
    renderAuthUI();
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
      if (profile.role === "admin" || profile.role === "super") { startJoinWatch(profile.tenantId); registerPush(); }
    }
    // 運営ログイン後の遷移
    if (pendingSuperOpen) {
      if (profile && profile.active && profile.role === "super") { openAdminIfSuper(); }
      else { pendingSuperOpen = false; const s = $("superStat"); if (s) s.textContent = "⚠ このアカウントは運営管理者ではありません。"; }
    }
  });

  function renderAuthUI() {
    const inLogged = !!me;
    if (typeof window.applyRoleUI === "function") window.applyRoleUI();   // 権限に応じたUI(データ管理/削除ボタン)を更新
    show("cloudLoggedOut", !inLogged);
    show("cloudLoggedIn", inLogged);
    const isSuperUser = !!(profile && profile.active && profile.role === "super");
    show("tabAdmin", isSuperUser);   // 運営の隠しタブはsuperのみ表示
    if (!inLogged) { closeForm(); show("tabAdmin", false); show("cloudDevices", false); show("cloudPlan", false); return; }
    const roleJa = profile ? ({ super: "運営管理者", admin: "代表管理者", staff: "従業員" }[profile.role] || profile.role) : "—";
    const who = profile && profile.name ? profile.name + "（" + me.email + "）" : me.email;
    if (!profile) {
      $("cloudStat").innerHTML = esc(me.email) + " — プロフィール未作成です。<br><button class='btn btn-amber btn-sm' id='cloudRecover' style='margin-top:6px'>会社に参加（再申請）</button>";
      const rb = $("cloudRecover");
      if (rb) rb.onclick = async () => {
        const nm = (prompt("氏名を入力してください") || "").trim(); if (!nm) return;
        const tid = (prompt("事業所IDを入力してください（例: sakuragarage）") || "").toLowerCase().replace(/[^a-z0-9_-]/g, ""); if (!tid) return;
        try { await db.collection("users").doc(me.uid).set({ name: nm, email: me.email, tenantId: tid, role: "staff", active: false, rejected: false, createdAt: Date.now() }); alert("再申請しました。管理者の承認をお待ちください。"); location.reload(); }
        catch (e) { alert("失敗: " + (e.message || e)); }
      };
    } else if (profile.rejected) {
      $("cloudStat").innerHTML = who + "<br>会社: " + (profile.tenantId || "—") + "<br>⛔ <b>申請が却下されました。</b><br>下のボタンで再申請できます（会社の代表管理者の承認をお待ちください）。<br><button class='btn btn-amber btn-sm' id='cloudReapply' style='margin-top:8px'>もう一度 参加を申請する</button>";
      const rab = $("cloudReapply");
      if (rab) rab.onclick = async () => {
        try { await db.collection("users").doc(me.uid).set({ active: false, rejected: false }, { merge: true }); alert("再申請しました。管理者の承認をお待ちください。"); }
        catch (e) { alert("失敗: " + (e.message || e)); }
      };
    } else if (!profile.active) {
      $("cloudStat").innerHTML = who + "<br>会社: " + (profile.tenantId || "—") + " / 役割: " + roleJa + "<br>⏳ <b>承認待ち</b>です。承認されると自動で同期が始まります。";
    } else if (planBlocked) {
      $("cloudStat").innerHTML = who + "<br>会社: <b>" + profile.tenantId + "</b> / 役割: " + roleJa + "<br>⛔ <b>店舗の利用契約が停止中/期限切れ</b>です（社内共有は停止／個人利用は可）。代表管理者にお支払いをご確認ください。";
    } else if (deviceBlocked) {
      $("cloudStat").innerHTML = who + "<br>会社: <b>" + profile.tenantId + "</b> / 役割: " + roleJa + "<br>⛔ <b>この端末は無料枠を超えています</b>（社内共有は停止中／個人利用は可）。下の端末一覧をご確認ください。";
    } else {
      $("cloudStat").innerHTML = "✓ 同期中 — " + who + "<br>会社: <b>" + profile.tenantId + "</b> / 役割: " + roleJa;
    }
    renderPlan();
    renderDevices();
    // 会社内のメンバー管理は admin のみ(superは「運営」タブで全体管理)
    show("btnCloudManage", profile && profile.active && profile.role === "admin");
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
    return { rid: r.rid || null, vin: r.vin || null, plate: r.plate || null, name: clean(r.name), model: r.model || null, type: r.type || null, kataShitei: r.kataShitei || null, engine: r.engine || null, specs: r.specs || null, faults: r.faults || null, recalls: r.recalls || null, karte: r.karte || null, at: r.at || new Date().toISOString(), updatedAt: r.updatedAt || Date.now() };
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
      for (const h of hist) {
        if (h && (h.vin || h.rid) && !h.deleted) try { await db.collection("tenants").doc(tid).collection("records").doc(docKey(h)).set(recordSubset(h), { merge: true }); rUp++; }
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
          // 整備カルテは両端末の追加を失わないよう常にunion統合(勝敗判定より前に実施)
          if (typeof mergeKarte === "function") e.karte = mergeKarte(e.karte, r.karte);
          if ((e.updatedAt || 0) > (r.updatedAt || 0)) {
            // ローカルの方が新しい(編集/クリア) → クラウドへ送り返して上書き
            try { db.collection("tenants").doc(tid).collection("records").doc(docKey(e)).set(recordSubset(e), { merge: true }); } catch (er) {}
          } else {
            // クラウドの方が新しい → 反映(名前=使用者はクラウド値をそのまま採用しクリアも反映)
            Object.assign(e, { type: r.type || e.type, vin: r.vin || e.vin, plate: r.plate || e.plate, name: clean(r.name), model: r.model || e.model, engine: r.engine || e.engine, kataShitei: r.kataShitei || e.kataShitei, specs: r.specs || e.specs, faults: r.faults || e.faults, recalls: r.recalls || e.recalls, at: e.at || r.at || new Date().toISOString(), updatedAt: r.updatedAt || e.updatedAt || 0 });
          }
        });
        if (typeof dedupeHistory === "function") hist = dedupeHistory(hist);
        localStorage.setItem(LS.hist, JSON.stringify(hist.slice(0, 500)));
        try { renderHistory(); } catch (e) {}
      } catch (e) {}
    }, err => syncMsg("⚠ 同期エラー(車両): " + (err.code || err.message)));
  }
  function stopSync() { if (unsubVeh) { unsubVeh(); unsubVeh = null; } if (unsubRec) { unsubRec(); unsubRec = null; } if (unsubJoin) { unsubJoin(); unsubJoin = null; } }

  /* ---------- プッシュ通知(FCM): 管理者はワンタップ許可のみ。設定作業は不要 ----------
     ↓ 運営(あなた)が一度だけ Firebase Console → Cloud Messaging → ウェブプッシュ証明書 で
       「鍵ペアを生成」して得られる公開鍵(VAPID)をここに貼るだけ。 */
  const VAPID_KEY = "BJyKrW5kitDImGcvoRr9UGJ1_yU4miwENlSbcuf_uBilFohE3lC8J1BGOW2lHADFYGvm23XQhyeE-CGxeHk6Qtw";
  async function registerPush() {
    try {
      if (!(profile && (profile.role === "admin" || profile.role === "super"))) return;   // 通知対象は管理者のみ
      if (typeof firebase.messaging !== "function" || !("serviceWorker" in navigator)) return;
      if (!VAPID_KEY || VAPID_KEY.indexOf("PASTE_") === 0) return;   // 鍵未設定なら在アプリ通知のみで運用
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
      const reg = await navigator.serviceWorker.register("firebase-messaging-sw.js");
      const messaging = firebase.messaging();
      const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
      if (token) {
        await db.collection("users").doc(me.uid).set(
          { fcmTokens: firebase.firestore.FieldValue.arrayUnion(token) }, { merge: true });
      }
      // 前面にいる時に届いた通知も表示
      messaging.onMessage(p => {
        const n = (p && p.notification) || {};
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
      // 新規申請が増えたら端末通知(アプリを開いている間)
      if (joinSeen >= 0 && n > joinSeen) {
        try { if ("Notification" in window && Notification.permission === "granted") new Notification("メカノAI 参加申請", { body: "新しい参加申請が届きました（承認待ち " + n + "件）。" }); } catch (e) {}
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
    isLoggedIn() { return !!me; },
    // 管理者権限(未ログインの個人利用は自分が管理者扱い / ログイン中は admin・super のみ)
    isManager() { return !me || (profile && (profile.role === "admin" || profile.role === "super")); },
    // AIプロキシが使えるか(契約中の店舗)。真ならメカ君/OCRはサーバー経由=自分の鍵不要。
    aiReady() { return !!(this.active && tenantDoc && (tenantDoc.plan === "active" || tenantDoc.plan === "trial") && (!tenantDoc.paidUntil || Number(tenantDoc.paidUntil) >= Date.now())); },
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
    deleteRecord(r) {
      if (!this.active || !r) return;
      // ハード削除ではなく墓標(deleted)で論理削除。古い端末の再アップロードで蘇るのを防ぐ
      db.collection("tenants").doc(profile.tenantId).collection("records").doc(docKey(r))
        .set({ deleted: true, vin: r.vin || null, rid: r.rid || null, updatedAt: Date.now() }, { merge: true }).catch(() => {});
    }
  };

  /* ---------- メンバー/会社 管理 (admin=自社cloudManageBox / super=運営タブadminBox) ---------- */
  $("btnCloudManage") && $("btnCloudManage").addEventListener("click", () => {
    const box = $("cloudManageBox");
    if (!box.classList.contains("hidden")) { show("cloudManageBox", false); return; }
    show("cloudManageBox", true); renderManage("cloudManageBox");
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
        "<button data-mode='corp' class='" + (mode === "corp" ? "on" : "") + "'>法人モード</button>" +
        "<button data-mode='personal' class='" + (mode === "personal" ? "on" : "") + "'>個人モード</button>" +
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
      catch (e) { alert("更新失敗: " + (e.message || e)); }
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
            "<span class='mName'>" + esc(id) + (t.active ? "" : "<span style='color:var(--alert)'>（承認待ち）</span>") + "</span>" +
            "<span class='mCount'>👥 " + cnt + "</span>" +
            "<span class='mtBtns'>" + btn("plan", "t", id, "プラン") +
            btn("paidai", "t", id, t.aiPaidFallback ? "⚡有料ON" : "無料のみ", t.aiPaidFallback ? "btn-amber" : "btn-ghost") +
            (t.active ? btn("off", "t", id, "停止") : btn("on", "t", id, "承認", "btn-amber") + btn("del", "t", id, "削除")) + "</span></div>" +
            "<div class='mBody hidden'>" +
            "<div class='mStat' id='stat_" + sid + "'>利用状況を取得中…</div>" +
            membersHtml(byTenant[id]) + "</div></div>";
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
        html += "<div class='mTenant'><div class='mTenantHead'><span class='mName'>" + esc(profile.tenantId) + " のメンバー</span></div><div class='mBody'>" + membersHtml(byTenant[profile.tenantId]) + "</div></div>";
      }
      box.innerHTML = html || "メンバーがいません。";
      // 会社ヘッダーのタップでメンバーを開閉(ボタンのクリックは除外)
      box.querySelectorAll(".mTenantHead[data-toggle]").forEach(head => head.addEventListener("click", e => {
        if (e.target.closest("[data-act]")) return;
        const body = head.nextElementSibling;
        if (body) body.classList.toggle("hidden");
        head.classList.toggle("open", body && !body.classList.contains("hidden"));
      }));
      box.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", async e => { e.stopPropagation(); await manageAction(b.dataset.kind, b.dataset.id, b.dataset.act); renderManage(boxId); }));
      statTids.forEach(t => fillTenantStats(t));
    } catch (e) { box.innerHTML = "⚠ 読み込み失敗: " + (e.message || e); }
  }
  function btn(act, kind, id, label, cls) { return "<button class='btn " + (cls || "btn-ghost") + " btn-sm' data-act='" + act + "' data-kind='" + kind + "' data-id='" + esc(id) + "'>" + label + "</button>"; }
  function membersHtml(list) {
    if (!list || !list.length) return "<div class='mStat'>メンバーなし</div>";
    // 代表管理者を先頭、従業員、運営管理者(在籍表示)は末尾に
    const rank = r => r === "admin" ? 2 : r === "super" ? 0 : 1;
    list.sort((a, b) => rank(b.u.role) - rank(a.u.role));
    return list.map(x => userRow(x.id, x.u)).join("");
  }
  function userRow(id, u) {
    const roleJa = ({ super: "運営管理者", admin: "代表管理者", staff: "従業員" }[u.role] || u.role);
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
      "<span class='mRole" + (isAdmin ? " adm" : "") + "'>" + roleJa + "</span>" + devCtrl + "</div>" +
      (u.email ? "<div class='mMail'>" + esc(u.email) + "</div>" : "") +
      "<div class='mMeta'>" + esc(last) + (reg ? " ・ " + esc(reg) : "") + " ・ 端末 " + devN + "/" + devLimit + "台</div></div>";
    let btns;
    if (u.active) {
      // 役割変更ボタン(staff→代表者に / admin→従業員に)。運営(super)は変更不可
      const roleBtn = u.role === "staff" ? btn("promote", "u", id, "代表者に")
        : u.role === "admin" ? btn("demote", "u", id, "従業員に") : "";
      btns = btn("rename", "u", id, "✎ 名前") + roleBtn + btn("pwreset", "u", id, "🔑 パスワード") + btn("off", "u", id, "無効化");
    } else btns = btn("rename", "u", id, "✎ 名前") + btn("on", "u", id, "承認", "btn-amber") + btn("del", "u", id, "却下");
    return "<div class='mRow'>" + info + "<div class='mBtns'>" + btns + "</div></div>";
  }
  async function fillTenantStats(tid) {
    const el = $("stat_" + tid.replace(/[^a-zA-Z0-9_-]/g, "")); if (!el) return;
    try {
      const [v, r, u, usage] = await Promise.all([
        db.collection("tenants").doc(tid).collection("vehicles").get().then(s => s.size).catch(() => "?"),
        db.collection("tenants").doc(tid).collection("records").get().then(s => s.size).catch(() => "?"),
        db.collection("users").where("tenantId", "==", tid).get().then(s => s.size).catch(() => "?"),
        db.collection("usage").doc(tid).get().then(s => s.data() || {}).catch(() => ({})),
      ]);
      const jstDay = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      let ai = "";
      if (usage.dMecha) ai += " ／ 🤖 AI本日 " + usage.dMecha + "回";
      if (usage.freeExhaustedDay === jstDay) ai += " ／ ⚠無料枠 使い切り";
      if (usage.dPaid) ai += " ／ ⚡有料 本日 " + usage.dPaid + "回";
      el.textContent = "👥 メンバー " + u + "人 ／ 🚗 車種DB " + v + "件 ／ 📋 車両 " + r + "台" + ai;
    } catch (e) { el.textContent = "利用状況の取得に失敗"; }
  }
  async function manageAction(kind, id, act) {
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
          } else { alert("発行に失敗しました。"); }
        } catch (e) { alert("発行に失敗: " + (e.message || e)); }
        return;
      }
      if (act === "paidai") {
        // 有料フォールバック(無料枠を超えた分だけ有料キーで継続)の店舗ごとON/OFF
        const cur = (await db.collection("tenants").doc(id).get()).data() || {};
        const turnOn = !cur.aiPaidFallback;
        if (turnOn && !confirm("店舗「" + id + "」で『有料利用（無料枠を超えた分だけ課金）』をONにします。\n無料枠を使い切ると自動で有料キーに切り替わり、超過分に課金が発生します。よろしいですか？")) return;
        await db.collection("tenants").doc(id).set({ aiPaidFallback: turnOn }, { merge: true });
        alert(turnOn ? "有料利用をONにしました（無料枠の超過分のみ課金）。" : "有料利用をOFFにしました（無料枠のみ・超過で停止）。");
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
        // 代表管理者の引き継ぎ。
        // 重要: 先に対象を admin に昇格する(この時点では実行者はまだ admin/super で権限がある)。
        // 先に自分を降格すると権限を失い、対象の昇格がルールで拒否され「代表不在」になるため順序厳守。
        const tdoc = await db.collection("users").doc(id).get(); const tu = tdoc.data() || {};
        const tid = tu.tenantId;
        if (tid) {
          await db.collection("users").doc(id).update({ role: "admin", active: true });
          await db.collection("tenants").doc(tid).set({ adminName: tu.name || "" }, { merge: true });
          // 対象以外の既存 admin を従業員に降格(実行者自身の降格はこの後=まだ権限保持中に実施)
          const admins = await db.collection("users").where("tenantId", "==", tid).where("role", "==", "admin").get();
          for (const a of admins.docs) { if (a.id !== id) { try { await db.collection("users").doc(a.id).update({ role: "staff" }); } catch (e) {} } }
        }
        alert("代表管理者を引き継ぎました。");
      } else if (act === "demote") {
        if (!confirm("この代表管理者を従業員に降格しますか？")) return;
        await db.collection("users").doc(id).update({ role: "staff" });
      } else if (act === "plan") {
        // 店舗プランの設定(運営のみ)。何ヶ月分 有効にするか入力。0=停止。
        const cur = await db.collection("tenants").doc(id).get(); const td = cur.data() || {};
        const now = td.paidUntil && Number(td.paidUntil) > Date.now() ? Number(td.paidUntil) : Date.now();
        const ans = (prompt("店舗「" + id + "」のプラン\n何ヶ月分 有効にしますか？（0=停止、例 1・12）", "1") || "").trim();
        if (ans === "") return;
        const months = parseInt(ans, 10);
        if (isNaN(months) || months < 0) { alert("数字を入力してください。"); return; }
        if (months === 0) { await db.collection("tenants").doc(id).set({ plan: "suspended" }, { merge: true }); alert("停止にしました。"); }
        else { const until = now + months * 30 * 24 * 3600 * 1000; await db.collection("tenants").doc(id).set({ plan: "active", paidUntil: until }, { merge: true }); alert("契約中にしました（〜" + new Date(until).toLocaleDateString("ja-JP") + "）。"); }
      } else if (act === "devplus") {
        const d = await db.collection("users").doc(id).get(); const u = d.data() || {};
        const nl = (Number(u.deviceLimit) || 2) + 1;
        await db.collection("users").doc(id).update({ deviceLimit: nl });
        alert("端末枠を " + nl + " 台に増やしました（追加端末の支払い確認後に付与してください）。");
      } else if (act === "devminus") {
        const d = await db.collection("users").doc(id).get(); const u = d.data() || {};
        const nl = Math.max(2, (Number(u.deviceLimit) || 2) - 1);
        await db.collection("users").doc(id).update({ deviceLimit: nl });
        alert("端末枠を " + nl + " 台にしました。");
      } else if (act === "on") { await db.collection(col).doc(id).update({ active: true, rejected: false }); }
      else await db.collection(col).doc(id).update({ active: false });
    } catch (e) { alert("操作失敗: " + (e.message || e)); }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  /* ---------- 紹介用QR(アプリURL) ---------- */
  try {
    const appUrl = (location.origin + location.pathname).replace(/index\.html$/, "");
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
