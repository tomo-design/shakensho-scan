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

  /* ---------- 認証フロー ---------- */
  $("btnCloudLogin") && $("btnCloudLogin").addEventListener("click", async () => {
    const email = $("cloudEmail").value.trim(), pw = $("cloudPw").value;
    if (!email || !pw) { $("cloudAuthStat").textContent = "メールとパスワードを入力してください。"; return; }
    $("cloudAuthStat").textContent = "ログイン中…";
    try { await auth.signInWithEmailAndPassword(email, pw); }
    catch (e) { $("cloudAuthStat").textContent = "⚠ " + authErr(e); }
  });
  $("lnkCloudSignup") && $("lnkCloudSignup").addEventListener("click", () => show("cloudSignupBox", $("cloudSignupBox").classList.contains("hidden")));
  $("btnSignupNew") && $("btnSignupNew").addEventListener("click", () => signup(true));
  $("btnSignupJoin") && $("btnSignupJoin").addEventListener("click", () => signup(false));
  $("btnCloudLogout") && $("btnCloudLogout").addEventListener("click", () => auth.signOut());

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
    if (!inLogged) return;
    const roleJa = profile ? ({ super: "運営管理者", admin: "代表管理者", staff: "従業員" }[profile.role] || profile.role) : "—";
    if (!profile) {
      $("cloudStat").textContent = me.email + " — プロフィール未作成。再登録してください。";
    } else if (!profile.active) {
      $("cloudStat").innerHTML = me.email + "<br>会社: " + (profile.tenantId || "—") + " / 役割: " + roleJa + "<br>⏳ <b>承認待ち</b>です。承認されると自動で同期が始まります。";
    } else {
      $("cloudStat").innerHTML = "✓ 同期中 — " + me.email + "<br>会社: <b>" + profile.tenantId + "</b> / 役割: " + roleJa;
    }
    // 管理ボタンは admin/super のみ
    show("btnCloudManage", profile && (profile.role === "admin" || profile.role === "super"));
    $("cloudManageBox").innerHTML = ""; show("cloudManageBox", false);
  }

  /* ---------- 同期 ---------- */
  function vinKey(r) { return String(r.vin || r.type || r.plate || r.id || Date.now()).replace(/[^A-Za-z0-9]/g, "_"); }
  function startSync(tid) {
    stopSync();
    // 車種DB(vehicles) → CUSTOM_DB を上書き同期
    unsubVeh = db.collection("tenants").doc(tid).collection("vehicles").onSnapshot(snap => {
      try {
        const arr = []; snap.forEach(d => arr.push(d.data()));
        if (typeof CUSTOM_DB !== "undefined") { CUSTOM_DB.length = 0; arr.forEach(v => CUSTOM_DB.push(v)); saveCustomDB(); try { renderDBList(); } catch (e) {} }
      } catch (e) {}
    }, err => console.warn("vehicles sync", err));
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
    }, err => console.warn("records sync", err));
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
      const rec = { vin: r.vin || null, plate: r.plate || null, name: r.name || null, type: r.type || null, kataShitei: r.kataShitei || null, engine: r.engine || null, specs: r.specs || null, faults: r.faults || null, recalls: r.recalls || null, at: r.at || new Date().toISOString() };
      db.collection("tenants").doc(profile.tenantId).collection("records").doc(vinKey(r)).set(rec, { merge: true }).catch(() => {});
    }
  };

  /* ---------- メンバー/会社 管理 ---------- */
  $("btnCloudManage") && $("btnCloudManage").addEventListener("click", async () => {
    const box = $("cloudManageBox");
    if (!box.classList.contains("hidden")) { show("cloudManageBox", false); return; }
    show("cloudManageBox", true); box.innerHTML = "読み込み中…";
    try {
      let html = "";
      if (profile.role === "super") {
        const ts = await db.collection("tenants").get();
        html += "<div class='hint' style='font-weight:700;margin:4px 0'>会社一覧（運営）</div>";
        ts.forEach(d => { const t = d.data(); html += rowHtml("t", d.id, d.id + (t.active ? "（有効）" : "（承認待ち）"), t.active); });
      }
      // 自社(または全社=super)の従業員
      let uq = db.collection("users");
      if (profile.role === "admin") uq = uq.where("tenantId", "==", profile.tenantId);
      const us = await uq.get();
      html += "<div class='hint' style='font-weight:700;margin:10px 0 4px'>メンバー</div>";
      us.forEach(d => { const u = d.data(); html += rowHtml("u", d.id, (u.email || d.id) + " / " + (u.role || "staff") + (u.tenantId ? " @" + u.tenantId : ""), u.active); });
      box.innerHTML = html || "なし";
      box.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => manageAction(b.dataset.kind, b.dataset.id, b.dataset.act)));
    } catch (e) { box.innerHTML = "⚠ 読み込み失敗: " + (e.message || e); }
  });
  function rowHtml(kind, id, label, active) {
    return "<div style='display:flex;align-items:center;gap:6px;margin:4px 0;font-size:13px'>" +
      "<span style='flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis'>" + esc(label) + "</span>" +
      (active
        ? "<button class='btn btn-ghost btn-sm' data-act='off' data-kind='" + kind + "' data-id='" + esc(id) + "'>無効化</button>"
        : "<button class='btn btn-amber btn-sm' data-act='on' data-kind='" + kind + "' data-id='" + esc(id) + "'>承認</button><button class='btn btn-ghost btn-sm' data-act='del' data-kind='" + kind + "' data-id='" + esc(id) + "'>却下</button>") +
      "</div>";
  }
  async function manageAction(kind, id, act) {
    try {
      const col = kind === "t" ? "tenants" : "users";
      if (act === "del") { if (!confirm("削除しますか？")) return; await db.collection(col).doc(id).delete(); }
      else await db.collection(col).doc(id).update({ active: act === "on" });
      $("btnCloudManage").click(); $("btnCloudManage").click(); // 再読み込み
    } catch (e) { alert("操作失敗: " + (e.message || e)); }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
})();
