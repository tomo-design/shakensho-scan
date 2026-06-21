"use strict";
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
  // このメールでログインした人は自動で「運営管理者(super)」になる(あなた専用・コンソール操作不要)
  const OWNER_EMAIL = "banana19870729@gmail.com";
  if (typeof firebase === "undefined") { console.warn("Firebase未読込(オフライン等)。クラウド同期はスキップ"); return; }

  let auth, db;
  try { firebase.initializeApp(firebaseConfig); auth = firebase.auth(); db = firebase.firestore(); }
  catch (e) { console.warn("Firebase初期化失敗", e); return; }

  const $ = id => document.getElementById(id);
  const show = (id, v) => { const el = $(id); if (el) el.classList.toggle("hidden", !v); };
  let me = null;        // {uid,email}
  let profile = null;   // {tenantId, role, active}
  let unsubVeh = null, unsubRec = null;

  /* ---------- 認証フロー(モード選択 → フォーム出現) ---------- */
  let cloudMode = "login";
  function openForm(mode) {
    cloudMode = mode;
    show("cloudChoice", false); show("cloudForm", true);
    show("tenantField", mode !== "login");
    $("cloudFormTitle").textContent = mode === "new" ? "この会社を新規作成（あなたが代表管理者）" : mode === "join" ? "既存の会社に参加（承認待ちになります）" : "ログイン";
    $("btnCloudSubmit").textContent = mode === "new" ? "会社を作成" : mode === "join" ? "参加を申請" : "ログイン";
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
      try { await auth.signInWithEmailAndPassword(email, pw); }
      catch (e) { $("cloudAuthStat").textContent = "⚠ " + authErr(e); }
    } else { signup(cloudMode === "new"); }
  });
  $("btnCloudLogout") && $("btnCloudLogout").addEventListener("click", () => auth.signOut());
  $("btnCloudResync") && $("btnCloudResync").addEventListener("click", () => {
    if (profile && profile.active && profile.tenantId) startSync(profile.tenantId);
    else { const el = $("cloudSyncMsg"); if (el) el.textContent = "未承認のため同期できません（承認待ち）。"; }
  });

  async function signup(isNewCompany) {
    const email = $("cloudEmail").value.trim(), pw = $("cloudPw").value;
    const tid = ($("cloudTenant").value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""));
    if (!email || pw.length < 6) { $("cloudAuthStat").textContent = "メールと6文字以上のパスワードを入力してください。"; return; }
    if (!tid) { $("cloudAuthStat").textContent = "事業所IDを入力してください(半角英数)。"; return; }
    $("cloudAuthStat").textContent = "登録中…";
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, pw);
      const uid = cred.user.uid;
      if (isNewCompany) {
        await db.collection("tenants").doc(tid).set({ name: tid, active: false, createdAt: Date.now() }, { merge: true });
        await db.collection("users").doc(uid).set({ email, tenantId: tid, role: "admin", active: false, createdAt: Date.now() });
        $("cloudAuthStat").textContent = "✓ 会社を作成しました。運営の承認後に有効化されます。";
      } else {
        await db.collection("users").doc(uid).set({ email, tenantId: tid, role: "staff", active: false, createdAt: Date.now() });
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
    renderAuthUI();
    if (profile && profile.active && profile.tenantId) startSync(profile.tenantId);
  });

  function renderAuthUI() {
    const inLogged = !!me;
    show("cloudLoggedOut", !inLogged);
    show("cloudLoggedIn", inLogged);
    const isSuperUser = !!(profile && profile.active && profile.role === "super");
    show("tabAdmin", isSuperUser);   // 運営の隠しタブはsuperのみ表示
    if (!inLogged) { closeForm(); show("tabAdmin", false); return; }
    const roleJa = profile ? ({ super: "運営管理者", admin: "代表管理者", staff: "従業員" }[profile.role] || profile.role) : "—";
    if (!profile) {
      $("cloudStat").textContent = me.email + " — プロフィール未作成。再登録してください。";
    } else if (!profile.active) {
      $("cloudStat").innerHTML = me.email + "<br>会社: " + (profile.tenantId || "—") + " / 役割: " + roleJa + "<br>⏳ <b>承認待ち</b>です。承認されると自動で同期が始まります。";
    } else {
      $("cloudStat").innerHTML = "✓ 同期中 — " + me.email + "<br>会社: <b>" + profile.tenantId + "</b> / 役割: " + roleJa;
    }
    // 会社内のメンバー管理は admin のみ(superは「運営」タブで全体管理)
    show("btnCloudManage", profile && profile.active && profile.role === "admin");
    $("cloudManageBox").innerHTML = ""; show("cloudManageBox", false);
  }

  /* ---------- 同期 ---------- */
  function vinKey(r) { return String(r.vin || r.type || r.plate || r.id || Date.now()).replace(/[^A-Za-z0-9]/g, "_"); }
  function recordSubset(r) {
    return { vin: r.vin || null, plate: r.plate || null, name: r.name || null, type: r.type || null, kataShitei: r.kataShitei || null, engine: r.engine || null, specs: r.specs || null, faults: r.faults || null, recalls: r.recalls || null, at: r.at || new Date().toISOString() };
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
      const hist = JSON.parse(localStorage.getItem(LS.hist) || "[]");
      for (const h of hist) {
        if (h && h.vin) try { await db.collection("tenants").doc(tid).collection("records").doc(vinKey(h)).set(recordSubset(h), { merge: true }); rUp++; }
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
        snap.forEach(d => { const v = d.data(); if (v && v.id) byId[v.id] = v; });
        CUSTOM_DB.length = 0; Object.keys(byId).forEach(k => CUSTOM_DB.push(byId[k]));
        saveCustomDB(); try { renderDBList(); } catch (e) {}
        if (!up.errMsg) syncMsg("✓ 同期OK: 車種DB " + snap.size + "件（クラウド）");
      } catch (e) {}
    }, err => syncMsg("⚠ 同期エラー(車種DB): " + (err.code || err.message) + "（ルール設定をご確認ください）"));
    // 車両レコード(records) → ローカル履歴へマージ(ナンバー検索が全端末で可能に)
    unsubRec = db.collection("tenants").doc(tid).collection("records").onSnapshot(snap => {
      try {
        const hist = JSON.parse(localStorage.getItem(LS.hist) || "[]");
        snap.forEach(d => {
          const r = d.data();
          let e = hist.find(h => r.vin && h.vin === r.vin);
          if (!e) { e = { id: Date.now() + Math.random() }; hist.unshift(e); }
          Object.assign(e, { type: r.type || e.type, vin: r.vin || e.vin, plate: r.plate || e.plate, name: r.name || e.name, engine: r.engine || e.engine, kataShitei: r.kataShitei || e.kataShitei, specs: r.specs || e.specs, faults: r.faults || e.faults, recalls: r.recalls || e.recalls, at: e.at || r.at || new Date().toISOString() });
        });
        localStorage.setItem(LS.hist, JSON.stringify(hist.slice(0, 500)));
        try { renderHistory(); } catch (e) {}
      } catch (e) {}
    }, err => syncMsg("⚠ 同期エラー(車両): " + (err.code || err.message)));
  }
  function stopSync() { if (unsubVeh) { unsubVeh(); unsubVeh = null; } if (unsubRec) { unsubRec(); unsubRec = null; } }

  /* ---------- アプリからの書き込みフック ---------- */
  window.Cloud = {
    get active() { return !!(profile && profile.active && profile.tenantId); },
    pushVehicle(rec) {
      if (!this.active || !rec || !rec.id) return;
      db.collection("tenants").doc(profile.tenantId).collection("vehicles").doc(String(rec.id)).set(rec, { merge: true }).catch(() => {});
    },
    deleteVehicle(id) {
      if (!this.active || !id) return;
      db.collection("tenants").doc(profile.tenantId).collection("vehicles").doc(String(id)).delete().catch(() => {});
    },
    pushRecord(r) {
      if (!this.active || !r || !r.vin) return;
      db.collection("tenants").doc(profile.tenantId).collection("records").doc(vinKey(r)).set(recordSubset(r), { merge: true }).catch(() => {});
    }
  };

  /* ---------- メンバー/会社 管理 (admin=自社cloudManageBox / super=運営タブadminBox) ---------- */
  $("btnCloudManage") && $("btnCloudManage").addEventListener("click", () => {
    const box = $("cloudManageBox");
    if (!box.classList.contains("hidden")) { show("cloudManageBox", false); return; }
    show("cloudManageBox", true); renderManage("cloudManageBox");
  });
  $("btnAdminReload") && $("btnAdminReload").addEventListener("click", () => renderManage("adminBox"));
  window.CloudAdmin = { open() { renderManage("adminBox"); } };  // app.jsのタブ切替から呼ぶ
  async function renderManage(boxId) {
    const box = $(boxId); if (!box || !profile) return;
    box.innerHTML = "読み込み中…";
    try {
      let html = "", superTenants = null;
      if (profile.role === "super") {
        const ts = await db.collection("tenants").get();
        superTenants = ts;
        html += "<div class='hint' style='font-weight:700;margin:4px 0'>会社一覧（運営）</div>";
        ts.forEach(d => {
          const t = d.data();
          html += rowHtml("t", d.id, d.id + (t.active ? "（有効）" : "（承認待ち）"), t.active);
          html += "<div class='hint' id='stat_" + d.id.replace(/[^a-zA-Z0-9_-]/g, "") + "' style='margin:-2px 0 8px;color:var(--dim);font-size:12px'>利用状況を取得中…</div>";
        });
      }
      let uq = db.collection("users");
      if (profile.role === "admin") uq = uq.where("tenantId", "==", profile.tenantId);
      const us = await uq.get();
      html += "<div class='hint' style='font-weight:700;margin:10px 0 4px'>メンバー</div>";
      us.forEach(d => { const u = d.data(); html += rowHtml("u", d.id, (u.email || d.id) + " / " + (u.role || "staff") + (u.tenantId ? " @" + u.tenantId : ""), u.active); });
      box.innerHTML = html || "なし";
      box.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", async () => { await manageAction(b.dataset.kind, b.dataset.id, b.dataset.act); renderManage(boxId); }));
      if (superTenants) superTenants.forEach(d => fillTenantStats(d.id));
    } catch (e) { box.innerHTML = "⚠ 読み込み失敗: " + (e.message || e); }
  }
  function rowHtml(kind, id, label, active) {
    return "<div style='display:flex;align-items:center;gap:6px;margin:4px 0;font-size:13px'>" +
      "<span style='flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis'>" + esc(label) + "</span>" +
      (active
        ? "<button class='btn btn-ghost btn-sm' data-act='off' data-kind='" + kind + "' data-id='" + esc(id) + "'>無効化</button>"
        : "<button class='btn btn-amber btn-sm' data-act='on' data-kind='" + kind + "' data-id='" + esc(id) + "'>承認</button><button class='btn btn-ghost btn-sm' data-act='del' data-kind='" + kind + "' data-id='" + esc(id) + "'>却下</button>") +
      "</div>";
  }
  async function fillTenantStats(tid) {
    const el = $("stat_" + tid.replace(/[^a-zA-Z0-9_-]/g, "")); if (!el) return;
    try {
      const [v, r, u] = await Promise.all([
        db.collection("tenants").doc(tid).collection("vehicles").get().then(s => s.size).catch(() => "?"),
        db.collection("tenants").doc(tid).collection("records").get().then(s => s.size).catch(() => "?"),
        db.collection("users").where("tenantId", "==", tid).get().then(s => s.size).catch(() => "?"),
      ]);
      el.textContent = "👥 メンバー " + u + "人 ／ 🚗 車種DB " + v + "件 ／ 📋 車両 " + r + "台";
    } catch (e) { el.textContent = "利用状況の取得に失敗"; }
  }
  async function manageAction(kind, id, act) {
    try {
      const col = kind === "t" ? "tenants" : "users";
      if (act === "del") { if (!confirm("削除しますか？")) return; await db.collection(col).doc(id).delete(); }
      else await db.collection(col).doc(id).update({ active: act === "on" });
    } catch (e) { alert("操作失敗: " + (e.message || e)); }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  /* ---------- 紹介用QR(アプリURL) ---------- */
  try {
    const appUrl = (location.origin + location.pathname).replace(/index\.html$/, "");
    const qr = $("appQr"); if (qr) qr.src = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=0&data=" + encodeURIComponent(appUrl);
    const ut = $("appUrlText"); if (ut) ut.textContent = appUrl;
  } catch (e) {}

  /* ---------- 運営タブの隠し入口(ヘッダーを素早く5回タップ・superのみ) ---------- */
  try {
    const hdr = document.querySelector("header"); let taps = 0, tm = null;
    if (hdr) hdr.addEventListener("click", () => {
      taps++; clearTimeout(tm); tm = setTimeout(() => taps = 0, 1500);
      if (taps >= 5) {
        taps = 0;
        if (profile && profile.active && profile.role === "super" && typeof switchView === "function") switchView("admin");
      }
    });
  } catch (e) {}
})();
