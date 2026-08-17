"use strict";
/*! メカノAI 営業ルーム(社内専用) © 2026 Cablueie. 運営(super)専用ツール。 */
(function () {
  const firebaseConfig = {
    apiKey: "AIzaSyAH5tBm9VDMYas1X0pNBBYHxKO3nfTrEYI",
    authDomain: "mecanoai.firebaseapp.com",
    projectId: "mecanoai",
    storageBucket: "mecanoai.firebasestorage.app",
    messagingSenderId: "126560659288",
    appId: "1:126560659288:web:627b913aef320e7e76a72d"
  };
  const FN_REGION = "asia-northeast1";
  const FN_BASE = "https://" + FN_REGION + "-" + firebaseConfig.projectId + ".cloudfunctions.net/";

  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const show = (id, v) => { const el = $(id); if (el) el.classList.toggle("hidden", !v); };
  let toastT = null;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 2200);
  }

  // ---- AI社員 ----
  const STAFF = [
    { id: "bucho", name: "営業部長 剛田", av: "剛", color: "#c0562a", role: "戦略・商談" },
    { id: "writer", name: "ライター 文乃", av: "文", color: "#2b6fb3", role: "提案文・メール" },
    { id: "marke", name: "マーケ 舞", av: "舞", color: "#7a4fb0", role: "集客・施策" },
    { id: "cs", name: "CS 円", av: "円", color: "#1f9d6b", role: "導入後サポート" },
    { id: "bell", name: "商談ロープレ", av: "練", color: "#5b6472", role: "練習相手" },
  ];
  const staffOf = (id) => STAFF.find((x) => x.id === id) || STAFF[0];
  const QUICK = {
    bucho: ["この見込み客の攻略戦略を立てて", "値段が高いと言われた時の切り返しは？", "7日間無料トライアルを武器にした売り方は？", "今週やるべき営業タスクを5つ"],
    writer: ["コールドメール（初回・特電法準拠）を書いて", "7日間無料トライアルを訴求したメールを書いて", "体験デモ(?demo=1)への案内メールを書いて", "整備工場向けチラシの文面を作って"],
    marke: ["整備工場に届く集客チャネルを提案して", "紹介キャンペーンの案を出して", "展示会で使う一言キャッチを5案"],
    cs: ["導入直後によくある質問と回答を作って", "解約を防ぐフォロー手順を教えて", "使い方の説明文を書いて"],
    bell: ["整備工場の社長役で商談練習して", "断り文句を言ってみて。切り返す練習がしたい"],
  };

  let me = null;
  let curStaff = "bucho";
  let curLeadId = "";
  let replyCtx = null;   // 問い合わせへの返信作成時の相手コンテキスト(見込み客未登録でも文脈に使う)
  let leads = [];
  const histByStaff = {}; // {staffId: [{role,text}]}

  // ---------- 認証 ----------
  async function api(action, payload) {
    const idToken = await auth.currentUser.getIdToken();
    const r = await fetch(FN_BASE + "salesRoom", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + idToken },
      body: JSON.stringify(Object.assign({ action }, payload || {})),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("エラー " + r.status));
    return j;
  }

  $("btnLogin").onclick = async () => {
    const email = $("liEmail").value.trim(), pass = $("liPass").value;
    $("loginMsg").textContent = "";
    if (!email || !pass) { $("loginMsg").textContent = "メールとパスワードを入力してください。"; return; }
    try { await auth.signInWithEmailAndPassword(email, pass); }
    catch (e) { $("loginMsg").textContent = "ログインに失敗しました。" + (e.code || ""); }
  };
  $("liPass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnLogin").click(); });
  $("btnLogout").onclick = () => auth.signOut();

  auth.onAuthStateChanged(async (user) => {
    if (!user) { me = null; show("loginPane", true); show("appPane", false); show("btnLogout", false); $("whoami").textContent = ""; return; }
    // super判定
    let role = "";
    try { role = (await db.collection("users").doc(user.uid).get()).data()?.role || ""; } catch (e) {}
    if (role !== "super") {
      show("loginPane", true); show("appPane", false);
      $("loginMsg").textContent = "このアカウントには営業ルームの権限がありません（運営専用）。";
      await auth.signOut();
      return;
    }
    me = user;
    $("whoami").textContent = user.email;
    show("loginPane", false); show("appPane", true); show("btnLogout", true);
    buildStaffbar();
    selectStaff("bucho");
    loadLeads();
    loadInbox(true);   // 未対応バッジを表示するため裏で読み込む
  });

  // ---------- タブ ----------
  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      const tab = t.dataset.tab;
      show("tab-team", tab === "team");
      show("tab-leads", tab === "leads");
      show("tab-camp", tab === "camp");
      show("tab-inbox", tab === "inbox");
      show("tab-issue", tab === "issue");
      if (tab === "camp") { updateCampCount(); loadDripConfig(); }
      if (tab === "inbox") loadInbox();
    };
  });

  // ---------- AI社員チーム ----------
  const avaHtml = (s, cls) => `<span class="ava${cls ? " " + cls : ""}" style="background:${s.color}">${esc(s.av)}</span>`;

  function buildStaffbar() {
    $("staffbar").innerHTML = STAFF.map((s) =>
      `<button class="staffcard" data-staff="${s.id}">${avaHtml(s)}<span><span class="nm">${esc(s.name.split(" ").slice(-1)[0] || s.name)}</span><span class="rl">${esc(s.role)}</span></span></button>`
    ).join("");
    $("staffbar").querySelectorAll(".staffcard").forEach((b) => b.onclick = () => selectStaff(b.dataset.staff));
  }
  function selectStaff(id) {
    curStaff = id;
    $("staffbar").querySelectorAll(".staffcard").forEach((b) => b.classList.toggle("on", b.dataset.staff === id));
    $("quickActions").innerHTML = (QUICK[id] || []).map((q) => `<button class="chip">${esc(q)}</button>`).join("");
    $("quickActions").querySelectorAll(".chip").forEach((b) => b.onclick = () => { $("taskInput").value = b.textContent; sendTask(); });
    renderChat();
  }
  function copy(text) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast("コピーしました")).catch(() => toast("コピーできませんでした"));
  }
  function renderChat() {
    const log = $("chatLog");
    const s = staffOf(curStaff);
    const hist = histByStaff[curStaff] || [];
    if (!hist.length) {
      log.innerHTML = `<div class="empty">${avaHtml(s)}<div><b>${esc(s.name)}</b><br>指示を入力するか、上のボタンから始めてください。</div></div>`;
      return;
    }
    log.innerHTML = hist.map((m, i) => {
      if (m.role === "user") return `<div class="turn me"><span class="ava">私</span><div class="bubble">${esc(m.text)}</div></div>`;
      return `<div class="turn ai">${avaHtml(s)}<div class="bubble"><span class="who">${esc(s.name)}</span>${esc(m.text)}<span class="copy" data-i="${i}">コピー</span></div></div>`;
    }).join("");
    log.querySelectorAll(".copy").forEach((c) => c.onclick = () => copy(hist[+c.dataset.i].text));
    log.scrollTop = log.scrollHeight;
  }

  const ta = $("taskInput");
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendTask(); } });
  $("btnSend").onclick = sendTask;

  async function sendTask() {
    const task = ta.value.trim();
    if (!task) return;
    const hist = histByStaff[curStaff] || (histByStaff[curStaff] = []);
    hist.push({ role: "user", text: task });
    ta.value = ""; ta.style.height = "auto";
    renderChat();
    // typing表示
    const log = $("chatLog");
    const s = staffOf(curStaff);
    const tip = document.createElement("div");
    tip.className = "turn ai typing";
    tip.innerHTML = `${avaHtml(s)}<div class="bubble">考え中…</div>`;
    log.appendChild(tip); log.scrollTop = log.scrollHeight;
    $("btnSend").disabled = true;
    const lead = replyCtx || (curLeadId ? leads.find((l) => l.id === curLeadId) : null);
    try {
      const j = await api("generate", { role: curStaff, task, lead, history: hist.slice(0, -1) });
      hist.push({ role: "ai", text: j.text || "(応答なし)" });
    } catch (e) {
      hist.push({ role: "ai", text: "⚠️ " + e.message });
    } finally {
      $("btnSend").disabled = false;
      renderChat();
    }
  }

  $("leadSelect").onchange = () => { curLeadId = $("leadSelect").value; replyCtx = null; updateReplyBanner(); };
  function updateReplyBanner() {
    var el = $("replyBanner"); if (!el) return;
    if (replyCtx) { el.classList.remove("hidden"); el.innerHTML = "✉ <b>" + esc(replyCtx.company) + "</b> の問い合わせに返信中 <button id='replyClear' class='rb-x'>解除</button>"; var x = $("replyClear"); if (x) x.onclick = () => { replyCtx = null; updateReplyBanner(); }; }
    else { el.classList.add("hidden"); el.innerHTML = ""; }
  }

  // ---------- 見込み客 ----------
  async function loadLeads() {
    try {
      const j = await api("listLeads");
      leads = j.leads || [];
    } catch (e) { toast(e.message); leads = []; }
    renderLeads();
    fillLeadSelect();
  }
  function fillLeadSelect() {
    const sel = $("leadSelect");
    sel.innerHTML = '<option value="">指定なし</option>' +
      leads.map((l) => `<option value="${l.id}">${esc(l.company)}（${esc(l.status)}）</option>`).join("");
    sel.value = curLeadId;
  }
  function renderLeads() {
    $("leadCount").textContent = leads.length ? leads.length + " 社" : "";
    const box = $("leadList");
    if (!leads.length) { box.innerHTML = '<div class="empty-block">まだ見込み客がありません。<br>右上の「＋ 追加」から登録してください。</div>'; return; }
    box.innerHTML = leads.map((l) => `
      <div class="leadcard">
        <div class="l">
          <div class="co">${esc(l.company)} <span class="pill st-${esc(l.status)}">${esc(l.status)}</span></div>
          <div class="meta">${esc(l.kind || "")}${l.contact ? " ／ " + esc(l.contact) : ""}${l.phone ? " ／ " + esc(l.phone) : ""}</div>
          ${l.note ? `<div class="note">${esc(l.note)}</div>` : ""}
        </div>
        <div class="acts">
          <button class="btn btn-ghost btn-sm" data-edit="${l.id}">編集</button>
          <button class="btn btn-dark btn-sm" data-ai="${l.id}">AIに相談</button>
        </div>
      </div>`).join("");
    box.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => openLead(b.dataset.edit));
    box.querySelectorAll("[data-ai]").forEach((b) => b.onclick = () => {
      curLeadId = b.dataset.ai;
      document.querySelector('.tab[data-tab="team"]').click();
      fillLeadSelect();
      selectStaff("bucho");
      toast("対象を設定しました。指示をどうぞ");
    });
  }

  // ---------- 問い合わせ受信(LPから) ----------
  let inquiries = [];
  async function loadInbox(silent) {
    try {
      const j = await api("listInquiries");
      inquiries = j.inquiries || [];
    } catch (e) { if (!silent) toast(e.message); return; }
    updateInboxBadge();
    if (!silent) renderInbox();
  }
  function updateInboxBadge() {
    const n = inquiries.filter((q) => q.status === "新規").length;
    const b = $("inboxBadge");
    if (b) { b.textContent = n; b.classList.toggle("hidden", n === 0); }
  }
  function fmtDate(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function renderInbox() {
    $("inboxCount").textContent = inquiries.length ? inquiries.length + " 件" : "";
    const box = $("inboxList");
    if (!inquiries.length) { box.innerHTML = '<div class="empty-block">まだ問い合わせはありません。<br>法人LP（biz.html）のフォームから届くとここに表示されます。</div>'; return; }
    box.innerHTML = inquiries.map((q) => `
      <div class="leadcard">
        <div class="l">
          <div class="co">${esc(q.company)} <span class="pill st-${q.status === "新規" ? "アプローチ中" : "見込み"}">${esc(q.status || "新規")}</span></div>
          <div class="meta">${esc(q.name || "")}${q.kind ? " ／ " + esc(q.kind) : ""}${q.plan ? " ／ 関心:" + esc(q.plan) : ""}</div>
          <div class="meta">${q.email ? "✉ " + esc(q.email) : ""}${q.phone ? "　☎ " + esc(q.phone) : ""}　<span class="muted">${fmtDate(q.createdAt)}</span></div>
          ${q.message ? `<div class="note">${esc(q.message)}</div>` : ""}
        </div>
        <div class="acts">
          <button class="btn btn-accent btn-sm" data-reply="${q.id}">✉ 返信文を作成</button>
          <button class="btn btn-dark btn-sm" data-tolead="${q.id}">見込み客に追加</button>
          <button class="btn btn-ghost btn-sm" data-done="${q.id}">対応済みに</button>
          <button class="btn btn-ghost btn-sm" data-delq="${q.id}">削除</button>
        </div>
      </div>`).join("");
    box.querySelectorAll("[data-reply]").forEach((b) => b.onclick = () => {
      const q = inquiries.find((x) => x.id === b.dataset.reply); if (q) replyToInquiry(q);
    });
    box.querySelectorAll("[data-tolead]").forEach((b) => b.onclick = async () => {
      try { await api("inquiryToLead", { id: b.dataset.tolead }); toast("見込み客に追加しました"); await Promise.all([loadInbox(), loadLeads()]); renderInbox(); }
      catch (e) { toast(e.message); }
    });
    box.querySelectorAll("[data-done]").forEach((b) => b.onclick = async () => {
      try { await api("inquiryStatus", { id: b.dataset.done, status: "対応済み" }); await loadInbox(); renderInbox(); }
      catch (e) { toast(e.message); }
    });
    box.querySelectorAll("[data-delq]").forEach((b) => b.onclick = async () => {
      if (!confirm("この問い合わせを削除しますか？")) return;
      try { await api("delInquiry", { id: b.dataset.delq }); await loadInbox(); renderInbox(); }
      catch (e) { toast(e.message); }
    });
  }
  const _rb = $("btnReloadInbox"); if (_rb) _rb.onclick = () => loadInbox();

  // 問い合わせから、そのまま返信メールをAI(ライター)に作らせる
  function replyToInquiry(q) {
    replyCtx = {
      company: q.company || "", contact: q.name || "", kind: q.kind || "",
      email: q.email || "", phone: q.phone || "", status: "資料請求・デモ申込",
      note: (q.plan ? "関心プラン:" + q.plan + " / " : "") + "問い合わせ本文: " + (q.message || "（本文なし）"),
    };
    curLeadId = "";
    document.querySelector('.tab[data-tab="team"]').click();
    selectStaff("writer");
    if ($("leadSelect")) $("leadSelect").value = "";
    updateReplyBanner();
    ta.value = "この会社からの資料請求・デモ申込への返信メールを作成して。相手の質問や関心（上記メモ）に触れ、お礼→サービス紹介資料の案内（https://mechanoai-cablueie.com/shiryou.html）→簡単な要点→無料で試せる導線（アプリ体験デモ https://mechanoai-cablueie.com/?demo=1、契約後は7日間無料トライアル）→次の一歩（オンラインで簡単な説明やお試しの日程調整）を丁寧に案内。署名は実データの固定署名（メカノAI／Cablueie（カブリエ）／担当:中江／TEL:080-3692-0101／Mail:cablueie.123@gmail.com）をそのまま使い、プレースホルダは使わない。押し売りにしない。";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    sendTask();
    toast("返信文を作成中…");
  }

  let editingId = "";
  function openLead(id) {
    editingId = id || "";
    const l = id ? leads.find((x) => x.id === id) : {};
    $("lmTitle").textContent = id ? "見込み客を編集" : "見込み客を追加";
    $("lmCompany").value = l.company || "";
    $("lmKind").value = l.kind || "整備工場";
    $("lmStatus").value = l.status || "見込み";
    $("lmContact").value = l.contact || "";
    $("lmPhone").value = l.phone || "";
    $("lmEmail").value = l.email || "";
    $("lmNote").value = l.note || "";
    show("lmDelete", !!id);
    show("leadModal", true);
  }
  $("btnNewLead").onclick = () => openLead("");
  $("lmCancel").onclick = () => show("leadModal", false);
  $("lmSave").onclick = async () => {
    const company = $("lmCompany").value.trim();
    if (!company) { toast("会社名を入力してください"); return; }
    const lead = {
      id: editingId || undefined, company,
      kind: $("lmKind").value, status: $("lmStatus").value,
      contact: $("lmContact").value.trim(), phone: $("lmPhone").value.trim(),
      email: $("lmEmail").value.trim(), note: $("lmNote").value.trim(),
    };
    try { await api("saveLead", { lead }); show("leadModal", false); await loadLeads(); toast("保存しました"); }
    catch (e) { toast(e.message); }
  };
  $("lmDelete").onclick = async () => {
    if (!editingId || !confirm("この見込み客を削除しますか？")) return;
    try { await api("delLead", { id: editingId }); show("leadModal", false); await loadLeads(); toast("削除しました"); }
    catch (e) { toast(e.message); }
  };

  // ---------- キャンペーン一括生成 ----------
  const CHANNEL_TXT = {
    cold: "面識のない相手に初めて送るコールドメール。件名＋本文＋末尾に配信停止の一文＋実データの固定署名を必ず付けた、特定電子メール法に準拠した完成形（そのまま送れる形）",
    mail: "件名と本文がそろった、そのまま送れる初回アプローチメール（ビジネスメール形式・末尾は実データの固定署名）",
    follow: "デモや初回接触の後に送るフォローメール（お礼＋次の一歩の提案）",
    letter: "郵送する挨拶状・DMの手紙文面（丁寧な体裁）",
    phone: "電話でのトークスクリプト（受付突破→担当者→つかみ→用件→アポ打診→想定反論の切り返し、の流れを台本形式で）",
    flyer: "1枚チラシの文面（キャッチコピー＋3つのベネフィット＋料金の触り＋問い合わせ導線）",
  };
  const ANGLE_TXT = {
    shortage: "整備士不足・高齢化と若手育成の観点",
    efficiency: "調べ物・記録作業の時短と効率化の観点",
    gs: "GS併設整備の少人数運営・生産性の観点",
    logi2024: "運送業の2024年問題・車両稼働率維持の観点",
    dx: "電子化・DX・車検証電子化の流れの観点",
    auto: "相手の業種にいちばん響く時事の観点（あなたが自動で選ぶ）",
  };

  function filteredLeads() {
    const kind = $("cpKind").value;
    const st = $("cpStatus").value;
    return leads.filter((l) => {
      if (kind && l.kind !== kind) return false;
      if (st === "new" && l.status !== "見込み") return false;
      return true;
    });
  }
  function updateCampCount() { $("cpTargetN").textContent = filteredLeads().length; }
  ["cpKind", "cpStatus"].forEach((id) => { const e = $(id); if (e) e.onchange = updateCampCount; });

  // ---------- 自動送信(ドリップ)設定 ----------
  async function loadDripConfig() {
    try {
      const j = await api("getConfig");
      const c = j.config || {};
      if ($("dripEnabled")) $("dripEnabled").checked = !!c.dripEnabled;
      if ($("dripPerDay")) $("dripPerDay").value = c.dripPerDay || 3;
      if ($("dripStat")) $("dripStat").textContent = j.sgReady ? "" : "⚠ メール送信(SendGrid)が未設定です。設定するまで実際の送信は行われません。";
    } catch (e) { if ($("dripStat")) $("dripStat").textContent = e.message; }
  }
  const _sd = $("btnSaveDrip");
  if (_sd) _sd.onclick = async () => {
    _sd.disabled = true;
    try {
      await api("setConfig", { config: { dripEnabled: $("dripEnabled").checked, dripPerDay: parseInt($("dripPerDay").value, 10) || 3 } });
      toast("自動送信の設定を保存しました");
      loadDripConfig();
    } catch (e) { toast(e.message); }
    finally { _sd.disabled = false; }
  };

  let campStop = false, campResults = [];
  $("btnStopCamp").onclick = () => { campStop = true; toast("中止しました"); };

  $("btnRunCamp").onclick = async () => {
    const targets = filteredLeads();
    if (!targets.length) { toast("対象の見込み客がいません"); return; }
    const channel = $("cpChannel").value, angle = $("cpAngle").value;
    const chTxt = CHANNEL_TXT[channel], anTxt = ANGLE_TXT[angle];
    campStop = false; campResults = [];
    show("btnStopCamp", true); show("btnCsv", false); $("btnRunCamp").disabled = true;
    show("cpProgress", true); $("cpBar").style.width = "0%";
    $("campResults").innerHTML = "";

    for (let i = 0; i < targets.length; i++) {
      if (campStop) break;
      const l = targets[i];
      const task = `${l.company}（業種:${l.kind || "整備関連"}）に送るための「${chTxt}」を作成してください。
訴求は${anTxt}を軸に、時事の背景を1つだけ自然に触れて「だからメカノAIが効く」に着地させること。
相手のメモがあれば反映：${l.note || "（特記なし）"}
誇張・虚偽・古い統計の断定はしない。すぐ使える完成形で、前置きの挨拶は不要。`;
      let text = "", err = false;
      try {
        const j = await api("generate", { role: "writer", task, lead: l });
        text = j.text || "(応答なし)";
      } catch (e) { text = "⚠️ " + e.message; err = true; }
      campResults.push({ company: l.company, kind: l.kind || "", channel, text });
      appendCampCard(l.company, l.kind || "", text, err);
      $("cpBar").style.width = Math.round(((i + 1) / targets.length) * 100) + "%";
    }
    $("btnRunCamp").disabled = false;
    show("btnStopCamp", false);
    show("btnCsv", campResults.length > 0);
    toast(campStop ? "中止しました" : "生成が完了しました（" + campResults.length + "件）");
  };

  function appendCampCard(company, kind, text, err) {
    const div = document.createElement("div");
    div.className = "crcard" + (err ? " err" : "");
    div.innerHTML = `<div class="crhead"><span class="crco">${esc(company)}</span><span class="muted">${esc(kind)}</span></div>
      <div class="crtext">${esc(text)}</div>
      <div class="crbtns"><button class="btn btn-ghost btn-sm cpcopy">コピー</button></div>`;
    div.querySelector(".cpcopy").onclick = () => copy(text);
    $("campResults").appendChild(div);
  }

  $("btnCsv").onclick = () => {
    if (!campResults.length) return;
    const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
    const rows = [["会社名", "業種", "チャネル", "本文"].map(q).join(",")]
      .concat(campResults.map((r) => [r.company, r.kind, r.channel, r.text].map(q).join(",")));
    const blob = new Blob(["﻿" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mechanoai-campaign-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click(); URL.revokeObjectURL(a.href);
  };

  // ---------- 契約発行(アカウント作成＋ID/パスワード/QR/案内メール) ----------
  let issuedMail = "";
  if ($("btnIssue")) $("btnIssue").onclick = async () => {
    const company = $("isCompany").value.trim();
    const name = $("isName").value.trim();
    const email = $("isEmail").value.trim();
    const plan = $("isPlan").value;
    if (!company || !email) { $("isStat").textContent = "会社名とメールアドレスは必須です。"; return; }
    $("btnIssue").disabled = true; $("isStat").textContent = "発行中…";
    try {
      const r = await api("issueAccount", { company, name, email, plan });
      issuedMail = r.body || "";
      $("isCreds").innerHTML =
        '<div class="isRow"><span>ログインID</span><b>' + esc(r.loginId) + '</b></div>' +
        '<div class="isRow"><span>メール</span><b>' + esc(r.email) + '</b></div>' +
        '<div class="isRow"><span>初期パスワード</span><b class="isPw">' + esc(r.password) + '</b></div>' +
        '<div class="isRow"><span>プラン</span><b>' + esc(r.planLabel) + '</b></div>' +
        '<div class="isRow"><span>アプリURL</span><b>' + esc(r.corpUrl) + '</b></div>';
      $("isQr").src = r.qrUrl;
      $("isMail").value = r.body || "";
      show("isResult", true);
      $("isStat").textContent = "✓ 発行しました（アカウントは有効・すぐログイン可）";
      $("isSendStat").textContent = "";
    } catch (e) {
      $("isStat").textContent = "⚠ " + (e.message || e);
    } finally { $("btnIssue").disabled = false; }
  };
  if ($("btnIssueCopy")) $("btnIssueCopy").onclick = () =>
    (window.copyText ? window.copyText(issuedMail) : navigator.clipboard.writeText(issuedMail)).then(() => toast("メール本文をコピーしました")).catch(() => toast("コピーできませんでした"));
  if ($("btnIssueSend")) $("btnIssueSend").onclick = async () => {
    const company = $("isCompany").value.trim(), name = $("isName").value.trim(), email = $("isEmail").value.trim(), plan = $("isPlan").value;
    if (!email) return;
    if (!confirm(email + " 宛に案内メールを送信します。よろしいですか？\n（※パスワードが変わるため、既に発行済みの場合は新しいパスワードで上書きされます）")) return;
    $("btnIssueSend").disabled = true; $("isSendStat").textContent = "送信中…";
    try {
      const r = await api("issueAccount", { company, name, email, plan, send: true });
      issuedMail = r.body || issuedMail;
      $("isMail").value = r.body || $("isMail").value;
      $("isCreds").querySelector(".isPw") && ($("isCreds").querySelector(".isPw").textContent = r.password);
      $("isSendStat").textContent = r.sent ? "✓ 送信しました" : "⚠ 送信できませんでした（メール設定をご確認ください）";
    } catch (e) { $("isSendStat").textContent = "⚠ " + (e.message || e); }
    finally { $("btnIssueSend").disabled = false; }
  };
})();
