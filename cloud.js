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
  // ログイン状態を端末に永続化(自動ログアウトを防ぐ)。サインイン前に必ず確定させる
  const persistReady = (async () => {
    try { await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); }
    catch (e) { console.warn("setPersistence失敗(既定の永続化を使用)", e); }
  })();

  const $ = id => document.getElementById(id);
  const show = (id, v) => { const el = $(id); if (el) el.classList.toggle("hidden", !v); };
  let me = null;        // {uid,email}
  let profile = null;   // {tenantId, role, active}
  let unsubVeh = null, unsubRec = null, unsubJoin = null;

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
    try { await auth.sendPasswordResetEmail(email); $("cloudAuthStat").textContent = "✓ " + email + " に再設定メールを送りました。受信箱をご確認ください。"; }
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
      const cred = await auth.createUserWithEmailAndPassword(email, pw);
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
    renderAuthUI();
    if (profile && profile.active && profile.tenantId) {
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
    if (!inLogged) { closeForm(); show("tabAdmin", false); return; }
    const roleJa = profile ? ({ super: "運営管理者", admin: "代表管理者", staff: "従業員" }[profile.role] || profile.role) : "—";
    const who = profile && profile.name ? profile.name + "（" + me.email + "）" : me.email;
    if (!profile) {
      $("cloudStat").innerHTML = esc(me.email) + " — プロフィール未作成です。<br><button class='btn btn-amber btn-sm' id='cloudRecover' style='margin-top:6px'>会社に参加（再申請）</button>";
      const rb = $("cloudRecover");
      if (rb) rb.onclick = async () => {
        const nm = (prompt("氏名を入力してください") || "").trim(); if (!nm) return;
        const tid = (prompt("事業所IDを入力してください（例: marukouseibi）") || "").toLowerCase().replace(/[^a-z0-9_-]/g, ""); if (!tid) return;
        try { await db.collection("users").doc(me.uid).set({ name: nm, email: me.email, tenantId: tid, role: "staff", active: false, rejected: false, createdAt: Date.now() }); alert("再申請しました。管理者の承認をお待ちください。"); location.reload(); }
        catch (e) { alert("失敗: " + (e.message || e)); }
      };
    } else if (profile.rejected) {
      $("cloudStat").innerHTML = who + "<br>会社: " + (profile.tenantId || "—") + "<br>⛔ <b>申請が却下されました。</b><br>会社の代表管理者に承認をご相談ください。再申請が必要な場合は管理者が再承認できます。";
    } else if (!profile.active) {
      $("cloudStat").innerHTML = who + "<br>会社: " + (profile.tenantId || "—") + " / 役割: " + roleJa + "<br>⏳ <b>承認待ち</b>です。承認されると自動で同期が始まります。";
    } else {
      $("cloudStat").innerHTML = "✓ 同期中 — " + who + "<br>会社: <b>" + profile.tenantId + "</b> / 役割: " + roleJa;
    }
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
  const VAPID_KEY = "PASTE_YOUR_WEB_PUSH_VAPID_PUBLIC_KEY_HERE";
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
    get active() { return !!(profile && profile.active && profile.tenantId); },
    myName() { return (profile && profile.name) || (me && me.email) || ""; },
    myUid() { return (me && me.uid) || ""; },
    myRole() { return (profile && profile.role) || ""; },
    isLoggedIn() { return !!me; },
    // 管理者権限(未ログインの個人利用は自分が管理者扱い / ログイン中は admin・super のみ)
    isManager() { return !me || (profile && (profile.role === "admin" || profile.role === "super")); },
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
  $("btnAdminReload") && $("btnAdminReload").addEventListener("click", () => renderManage("adminBox"));
  window.CloudAdmin = { open() { renderManage("adminBox"); } };  // app.jsのタブ切替から呼ぶ
  async function renderManage(boxId) {
    const box = $(boxId); if (!box || !profile) return;
    box.innerHTML = "読み込み中…";
    try {
      // メンバー取得(super=全件 / admin=自社)
      let uq = db.collection("users");
      if (profile.role === "admin") uq = uq.where("tenantId", "==", profile.tenantId);
      const us = await uq.get();
      const byTenant = {};
      us.forEach(d => { const u = d.data(); const t = u.tenantId || "（未所属）"; (byTenant[t] = byTenant[t] || []).push({ id: d.id, u }); });

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
            (t.active ? btn("off", "t", id, "停止") : btn("on", "t", id, "承認", "btn-amber") + btn("del", "t", id, "削除")) + "</div>" +
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
        // admin: 自社のメンバーのみ(1社なので常に開いた状態)
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
    // 代表管理者を先頭に
    list.sort((a, b) => (b.u.role === "admin" || b.u.role === "super" ? 1 : 0) - (a.u.role === "admin" || a.u.role === "super" ? 1 : 0));
    return list.map(x => userRow(x.id, x.u)).join("");
  }
  function userRow(id, u) {
    const roleJa = ({ super: "運営管理者", admin: "代表管理者", staff: "従業員" }[u.role] || u.role);
    const isAdmin = u.role === "admin" || u.role === "super";
    const fmt = ms => { const d = new Date(ms); return d.toLocaleDateString("ja-JP") + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
    const reg = u.createdAt ? "登録 " + new Date(u.createdAt).toLocaleDateString("ja-JP") : "";
    const last = u.lastLogin ? "最終ログイン " + fmt(u.lastLogin) : "未ログイン";
    const info = "<div class='mInfo'><span class='mNm'>" + esc(u.name || u.email || id) + "</span>" +
      "<span class='mRole" + (isAdmin ? " adm" : "") + "'>" + roleJa + "</span>" +
      (u.email ? "<div class='mMail'>" + esc(u.email) + "</div>" : "") +
      "<div class='mMeta'>" + esc(last) + (reg ? " ・ " + esc(reg) : "") + "</div></div>";
    let btns;
    if (u.active) {
      // 役割変更ボタンで無効化の隣を埋める(staff→代表者に / admin→従業員に)。運営(super)は変更不可
      const roleBtn = u.role === "staff" ? btn("promote", "u", id, "代表者に", "btn-amber")
        : u.role === "admin" ? btn("demote", "u", id, "従業員に") : "";
      btns = btn("rename", "u", id, "✎ 名前") + roleBtn + btn("off", "u", id, "無効化");
    } else btns = btn("rename", "u", id, "✎ 名前") + btn("on", "u", id, "承認", "btn-amber") + btn("del", "u", id, "却下");
    return "<div class='mRow'>" + info + "<div class='mBtns'>" + btns + "</div></div>";
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
        // 代表管理者の引き継ぎ: 対象を admin に、その会社の既存 admin を staff に降格
        const tdoc = await db.collection("users").doc(id).get(); const tu = tdoc.data() || {};
        const tid = tu.tenantId;
        if (tid) {
          const admins = await db.collection("users").where("tenantId", "==", tid).where("role", "==", "admin").get();
          for (const a of admins.docs) { if (a.id !== id) await db.collection("users").doc(a.id).update({ role: "staff" }); }
          await db.collection("users").doc(id).update({ role: "admin", active: true });
          await db.collection("tenants").doc(tid).set({ adminName: tu.name || "" }, { merge: true });
        }
        alert("代表管理者を引き継ぎました。");
      } else if (act === "demote") {
        if (!confirm("この代表管理者を従業員に降格しますか？")) return;
        await db.collection("users").doc(id).update({ role: "staff" });
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
