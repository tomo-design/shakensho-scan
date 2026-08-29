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
  // 個人版(Pocket)を選んでいる時のクイック指示。B2C・ストア配信向け。
  const POCKET_QUICK = {
    bucho: ["個人整備士に刺さる訴求ポイントを3つ挙げて", "Pocketを広めるための今週の一手は？", "『月¥500は高い』への切り返しは？"],
    writer: ["App Store/Google Play用のアプリ説明文を書いて", "個人整備士向けのX(旧Twitter)投稿を3案", "『7日間無料→月¥500』を伝える紹介文を書いて", "整備士に刺さる短いキャッチを5案"],
    marke: ["個人整備士にPocketを届ける集客チャネルを提案して", "★5レビューを増やすお願い文を作って", "YouTube動画の概要欄テンプレを作って"],
    cs: ["初回セットアップ(無料APIキー)の説明文を作って", "『AIが使えない』時の個人向けFAQ回答を作って", "解約を防ぐ使いこなしTipsをLINE/SNS用に"],
    bell: ["Pocketを勧める練習相手になって（個人整備士役）", "『無料アプリで十分』への切り返しを練習したい"],
  };

  let me = null;
  let curStaff = "bucho";
  let curProduct = "works";   // works=法人(Works) / pocket=個人(Pocket)
  let curLeadId = "";
  let replyCtx = null;   // 問い合わせへの返信作成時の相手コンテキスト(見込み客未登録でも文脈に使う)
  let leads = [];
  const histByStaff = {}; // {"product:staffId": [{role,text}]} 商材ごとに履歴を分離(Works/Pocketの文脈が混ざらない)
  const histKey = () => curProduct + ":" + curStaff;

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
    setProduct("works");   // 既定はWorks(AI営業チームタブ)。Pocket文面タブでpocketに切替
    loadLeads();
    loadInbox(true);   // 未対応バッジを表示するため裏で読み込む
  });

  // ---------- タブ ----------
  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      const tab = t.dataset.tab;
      const teamView = (tab === "team" || tab === "pocket");   // Pocket文面タブもチーム画面を共用(商材だけ切替)
      show("tab-team", teamView);
      show("tab-leads", tab === "leads");
      show("tab-research", tab === "research");
      show("tab-camp", tab === "camp");
      show("tab-inbox", tab === "inbox");
      show("tab-issue", tab === "issue");
      if (teamView) setProduct(tab === "pocket" ? "pocket" : "works");
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
    renderQuick();
    renderChat();
  }
  function renderQuick() {
    const src = curProduct === "pocket" ? POCKET_QUICK : QUICK;
    $("quickActions").innerHTML = (src[curStaff] || []).map((q) => `<button class="chip">${esc(q)}</button>`).join("");
    $("quickActions").querySelectorAll(".chip").forEach((b) => b.onclick = () => { $("taskInput").value = b.textContent; sendTask(); });
  }
  // 商材は「タブ」で確定する(AI営業チーム=Works / Pocket文面タブ=Pocket)。
  // タブ＝商材なので切替忘れによるWorks/Pocketの混同が起きない。UIも商材に合わせて切り替える。
  function setProduct(p) {
    curProduct = p === "pocket" ? "pocket" : "works";
    const pk = curProduct === "pocket";
    if (document.body) document.body.classList.toggle("mode-pocket", pk);
    // ヘッダのタイトル・説明・バッジ
    if ($("teamTitle")) $("teamTitle").firstChild.nodeValue = pk ? "AI営業チーム（Pocket） " : "AI営業チーム ";
    const tmb = $("teamModeBadge");
    if (tmb) { tmb.textContent = pk ? "Pocket・個人" : "Works・法人"; tmb.classList.toggle("pocket", pk); tmb.classList.toggle("works", !pk); }
    if ($("teamSub")) $("teamSub").textContent = pk
      ? "個人整備士向けのPocket用文面（ストア説明文・SNS・紹介文など）を作成します。会社・見込み客の文脈は使いません。"
      : "部門の担当に相談。提案文・戦略・切り返しをその場で作成します。";
    // 見込み客(会社)コンテキストはWorksのみ
    if ($("leadContext")) $("leadContext").style.display = pk ? "none" : "";
    // 生成結果デスクの商材バッジ
    const badge = $("outProdBadge");
    if (badge) { badge.textContent = pk ? "Pocket" : "Works"; badge.classList.toggle("pocket", pk); badge.classList.toggle("works", !pk); }
    if ($("taskInput")) $("taskInput").placeholder = pk
      ? "個人整備士向けの指示を入力（例：Pocketをすすめる紹介文を書いて）"
      : "担当への指示を入力（例：この会社への初回アプローチメールを書いて）";
    renderQuick();
    renderChat();
  }
  function copy(text) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast("コピーしました")).catch(() => toast("コピーできませんでした"));
  }
  // AI生成文をそのまま見込み客へメール送信(件名は本文先頭「件名：」を自動抽出。宛先は選択中の見込み客)
  async function sendMailFromChat(text) {
    text = String(text || "").trim(); if (!text) return;
    let subject = "", body = text;
    const lines = text.split("\n");
    const m = lines[0].match(/^\s*(?:件名|タイトル|subject)\s*[:：]\s*(.+)$/i);
    if (m) { subject = m[1].trim(); body = lines.slice(1).join("\n").replace(/^\s+/, ""); }
    const lead = curLeadId ? leads.find((l) => l.id === curLeadId) : null;
    let to = (prompt("送信先メールアドレス", (lead && lead.email) || "") || "").trim();
    if (!to) return;
    subject = (prompt("件名", subject || "メカノAI のご案内") || "").trim();
    if (!subject) return;
    if (!confirm(to + " 宛に送信します。よろしいですか？\n件名: " + subject + "\n（署名・差出人は自動付与されます）")) return;
    try { await api("sendMail", { to, subject, body, leadId: (lead && lead.id) || "" }); toast("✓ 送信しました"); }
    catch (e) { toast("送信失敗"); alert("送信に失敗しました: " + (e.message || e)); }
  }
  function renderChat() {
    const log = $("chatLog");
    const s = staffOf(curStaff);
    const hist = histByStaff[histKey()] || [];
    if (!hist.length) {
      log.innerHTML = `<div class="empty">${avaHtml(s)}<div><b>${esc(s.name)}</b><br>指示を入力するか、上のボタンから始めてください。</div></div>`;
      renderOutput();
      return;
    }
    log.innerHTML = hist.map((m, i) => {
      if (m.role === "user") return `<div class="turn me"><span class="ava">私</span><div class="bubble">${esc(m.text)}</div></div>`;
      return `<div class="turn ai">${avaHtml(s)}<div class="bubble"><span class="who">${esc(s.name)}</span>${esc(m.text)}<span class="msgacts"><span class="copy" data-i="${i}">📋 コピー</span><span class="sendmail" data-i="${i}">✉ メール送信</span></span></div></div>`;
    }).join("");
    log.querySelectorAll(".copy").forEach((c) => c.onclick = () => copy(hist[+c.dataset.i].text));
    log.querySelectorAll(".sendmail").forEach((c) => c.onclick = () => sendMailFromChat(hist[+c.dataset.i].text));
    log.scrollTop = log.scrollHeight;
    renderOutput();
  }
  // ===== 右側「メール作成デスク」: 最新のAI生成文を宛先/件名/本文に流し込み、編集して送信 =====
  let deskSource = null;   // 現在デスクに読み込んでいるAI原文(再描画時の二重反映防止)
  let deskAiTexts = [];    // 現スタッフのAI生成文一覧(「前の版」用)

  function currentTargetEmail() {
    if (curProduct === "pocket") return "";
    const lead = replyCtx || (curLeadId ? leads.find((l) => l.id === curLeadId) : null);
    return (lead && lead.email) || "";
  }
  // AI原文をデスクの各欄へ。forceTo=true なら宛先も上書き、falseなら空のときだけ補完(手入力を保持)
  function loadDesk(text, forceTo) {
    deskSource = text;
    if ($("outSubject")) $("outSubject").value = extractSubject(text) || "";
    if ($("outBodyText")) $("outBodyText").value = bodyWithoutSubject(text);
    if ($("outTo")) {
      const em = currentTargetEmail();
      if (forceTo) $("outTo").value = em;
      else if (!$("outTo").value.trim() && em) $("outTo").value = em;
    }
  }
  function renderOutput() {
    if (!$("outDesk")) return;
    const hist = histByStaff[histKey()] || [];
    deskAiTexts = hist.filter((m) => m.role === "ai" && !/^⚠️/.test(m.text)).map((m) => m.text);
    const last = deskAiTexts.length ? deskAiTexts[deskAiTexts.length - 1] : "";
    show("outActs", !!last);
    show("outDesk", !!last);
    show("outEmpty", !last);
    show("outRevert", deskAiTexts.length > 1);
    if (!last) { deskSource = null; return; }
    if (last !== deskSource) loadDesk(last, false);   // 新しい生成のときだけ流し込む(編集中の内容を消さない)
  }
  { const _c = $("outCopy"); if (_c) _c.onclick = () => {
      const subj = ($("outSubject").value || "").trim();
      const body = $("outBodyText").value || "";
      copy((subj ? "件名：" + subj + "\n\n" : "") + body);
    };
  }
  { const _r = $("outRevert"); if (_r) _r.onclick = () => {
      if (deskAiTexts.length < 2) return;
      let idx = deskAiTexts.lastIndexOf(deskSource);
      if (idx < 0) idx = deskAiTexts.length - 1;
      if (idx <= 0) { toast("これ以上前の版はありません"); return; }
      loadDesk(deskAiTexts[idx - 1], false);
      toast("前の版に戻しました");
    };
  }
  { const _s = $("outSend"); if (_s) _s.onclick = async () => {
      const to = ($("outTo").value || "").trim();
      const subject = ($("outSubject").value || "").trim();
      const body = ($("outBodyText").value || "").trim();
      if (!to) { toast("宛先を入力してください"); $("outTo").focus(); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { toast("宛先のメール形式が正しくありません"); $("outTo").focus(); return; }
      if (!subject) { toast("件名を入力してください"); $("outSubject").focus(); return; }
      if (!body) { toast("本文がありません"); return; }
      if (!confirm(to + " 宛に送信します。よろしいですか？\n件名: " + subject + "\n（署名・差出人は自動付与されます）")) return;
      const lead = curProduct === "pocket" ? null : (curLeadId ? leads.find((l) => l.id === curLeadId) : null);
      _s.disabled = true;
      try { await api("sendMail", { to, subject, body, leadId: (lead && lead.id) || "" }); toast("✓ 送信しました"); }
      catch (e) { toast("送信失敗"); alert("送信に失敗しました: " + (e.message || e)); }
      finally { _s.disabled = false; }
    };
  }

  const ta = $("taskInput");
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendTask(); } });
  $("btnSend").onclick = sendTask;

  async function sendTask() {
    const task = ta.value.trim();
    if (!task) return;
    const k = histKey();
    const hist = histByStaff[k] || (histByStaff[k] = []);
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
    const lead = curProduct === "pocket" ? null : (replyCtx || (curLeadId ? leads.find((l) => l.id === curLeadId) : null));
    try {
      const j = await api("generate", { role: curStaff, task, lead, history: hist.slice(0, -1), product: curProduct });
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
  function visibleLeads() {
    const q = (($("leadSearch") && $("leadSearch").value) || "").trim().toLowerCase();
    const fk = ($("leadFilterKind") && $("leadFilterKind").value) || "";
    const fs = ($("leadFilterStatus") && $("leadFilterStatus").value) || "";
    return leads.filter((l) => {
      if (fk && l.kind !== fk) return false;
      if (fs && l.status !== fs) return false;
      if (q) {
        const hay = [l.company, l.contact, l.note, l.email, l.phone, l.kind].join(" ").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  function renderLeads() {
    const box = $("leadList");
    const list = visibleLeads();
    const filtered = list.length !== leads.length;
    $("leadCount").textContent = leads.length ? (filtered ? list.length + " / " + leads.length + " 社" : leads.length + " 社") : "";
    if (!leads.length) { box.innerHTML = '<div class="empty-block">まだ見込み客がありません。<br>右上の「＋ 追加」から登録してください。</div>'; return; }
    if (!list.length) { box.innerHTML = '<div class="empty-block">条件に一致する見込み客がありません。<br>検索・絞り込みを変更してください。</div>'; return; }
    box.innerHTML = list.map((l) => `
      <div class="leadcard">
        <div class="l">
          <div class="co">${esc(l.company)} <span class="pill st-${esc(l.status)}">${esc(l.status)}</span></div>
          <div class="meta">${esc(l.kind || "")}${l.contact ? " ／ " + esc(l.contact) : ""}${l.phone ? " ／ " + esc(l.phone) : ""}</div>
          ${l.note ? `<div class="note">${esc(l.note)}</div>` : ""}
        </div>
        <div class="acts">
          <button class="btn btn-ghost btn-sm" data-edit="${l.id}">編集</button>
          <button class="btn btn-dark btn-sm" data-ai="${l.id}">AIに相談</button>
          ${formUrlFromNote(l.note) ? `<button class="btn btn-accent btn-sm" data-leadform="${l.id}">📝 フォームで営業</button>` : ""}
        </div>
      </div>`).join("");
    box.querySelectorAll("[data-leadform]").forEach((b) => b.onclick = () => {
      const l = leads.find((x) => x.id === b.dataset.leadform); if (!l) return;
      openFormAssist({ company: l.company, kind: l.kind, note: l.note || "", formUrl: formUrlFromNote(l.note), lead: l });
    });
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
  function visibleInquiries() {
    const q = (($("inboxSearch") && $("inboxSearch").value) || "").trim().toLowerCase();
    const fs = ($("inboxFilterStatus") && $("inboxFilterStatus").value) || "";
    return inquiries.filter((x) => {
      if (fs && (x.status || "新規") !== fs) return false;
      if (q) {
        const hay = [x.company, x.name, x.message, x.email, x.phone, x.kind, x.plan].join(" ").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  function renderInbox() {
    const box = $("inboxList");
    const list = visibleInquiries();
    const filtered = list.length !== inquiries.length;
    $("inboxCount").textContent = inquiries.length ? (filtered ? list.length + " / " + inquiries.length + " 件" : inquiries.length + " 件") : "";
    if (!inquiries.length) { box.innerHTML = '<div class="empty-block">まだ問い合わせはありません。<br>法人LP（biz.html）のフォームから届くとここに表示されます。</div>'; return; }
    if (!list.length) { box.innerHTML = '<div class="empty-block">条件に一致する問い合わせがありません。<br>検索・絞り込みを変更してください。</div>'; return; }
    box.innerHTML = list.map((q) => `
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
  ["inboxSearch", "inboxFilterStatus"].forEach((id) => {
    const e = $(id); if (e) e.addEventListener("input", renderInbox);
  });

  // パスワード再設定リンクを発行し、それを本文に埋め込んだ返信文をAI(CS)に作らせる
  const _rl = $("btnResetLink");
  if (_rl) _rl.onclick = async () => {
    const email = (prompt("パスワード再設定リンクを発行する相手のメールアドレスを入力してください。\n（登録済みのメール／ログインIDに紐づくメール）") || "").trim();
    if (!email) return;
    let j;
    try { j = await api("resetLink", { email }); }
    catch (e) { toast(e.message); return; }
    try { await navigator.clipboard.writeText(j.link); } catch (e) {}
    replyCtx = null; curLeadId = "";
    document.querySelector('.tab[data-tab="team"]').click();
    selectStaff("cs");
    if ($("leadSelect")) $("leadSelect").value = "";
    updateReplyBanner();
    ta.value = "パスワードをお忘れの方への返信メールを作成して。流れは、お礼とお詫び → 下記の『パスワード再設定リンク』を本文にそのまま明記 → リンクを開いて新しいパスワードを設定する手順（3ステップ程度）→ セキュリティのためリンクには有効期限がある旨、を丁寧に。リンクのURLは一字一句そのまま貼ること（短縮・改変しない）。\n\n【パスワード再設定リンク（そのまま本文に貼る）】\n" + j.link;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    sendTask();
    toast("再設定リンクを発行（コピー済み）。返信文を作成中…");
  };

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
  ["leadSearch", "leadFilterKind", "leadFilterStatus"].forEach((id) => {
    const e = $(id); if (e) e.addEventListener("input", renderLeads);
  });
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

  // ---------- 店舗リサーチ(公開情報から営業先候補を収集) ----------
  let rsCandidates = [];   // 直近の検索で返ってきた"新規"候補(既出を除外済み)
  const _rsUrl = (u, label) => u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(label)}</a>` : "";
  // 取得済み(重複除外)の記憶。ブラウザに保存し、再検索で同じ店を出さない。 {key: 店名}
  const RS_SEEN_KEY = "ss_rsSeen";
  const rsNorm = (s) => String(s || "").toLowerCase().replace(/[\s　]|株式会社|有限会社|（株）|\(株\)|（有）|\(有\)/g, "");
  function rsLoadSeen() { try { return JSON.parse(localStorage.getItem(RS_SEEN_KEY) || "{}") || {}; } catch (e) { return {}; } }
  let rsSeen = rsLoadSeen();
  function rsSaveSeen() { try { localStorage.setItem(RS_SEEN_KEY, JSON.stringify(rsSeen)); } catch (e) {} }
  const rsSeenKey = (c) => rsNorm(c.company) + "|" + rsNorm(c.area);
  // 除外に送る名前: これまでの収集済み + 既存の見込み客(重複登録も防ぐ)
  function rsExcludeNames() {
    const names = Object.values(rsSeen);
    const leadNames = (leads || []).map((l) => l.company).filter(Boolean);
    return Array.from(new Set(names.concat(leadNames))).slice(0, 250);
  }
  // 絞り込み(メールあり/フォームあり)を適用した表示対象
  function rsVisible() {
    const f = ($("rsFilter") && $("rsFilter").value) || "all";
    return rsCandidates.filter((c) => {
      if (f === "email") return !!c.email;
      if (f === "form") return !!c.formUrl;
      if (f === "fax") return !!c.fax;
      if (f === "reach") return !!(c.email || c.formUrl || c.fax);
      return true;
    });
  }
  function renderResearch() {
    const box = $("rsResults");
    const list = rsVisible();
    show("btnRsAddAll", list.length > 0);
    if (!rsCandidates.length) { box.innerHTML = ""; return; }
    if (!list.length) { box.innerHTML = '<div class="empty-block">この絞り込み条件に合う候補がありません。<br>絞り込みを「すべて」に戻すか、再検索してください。</div>'; return; }
    box.innerHTML = list.map((c) => {
      const i = rsCandidates.indexOf(c);
      return `
      <div class="leadcard rscard">
        <div class="l">
          <div class="co">${esc(c.company)} <span class="pill st-見込み">${esc(c.kind || "")}</span></div>
          <div class="meta">${esc(c.area || "")}</div>
          <div class="meta">${c.phone ? "☎ " + esc(c.phone) : '<span class="rsNo">☎ 電話 非公開</span>'}　${c.fax ? "📠 " + esc(c.fax) : '<span class="rsNo">📠 FAX 非公開</span>'}　${c.email ? "✉ " + esc(c.email) : '<span class="rsNo">✉ メール 非公開</span>'}</div>
          <div class="meta rslinks">${_rsUrl(c.source, "🔗 出典")}${c.formUrl ? "　" + _rsUrl(c.formUrl, "📝 問い合わせフォーム") : ""}</div>
          ${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}
        </div>
        <div class="acts">
          <button class="btn btn-dark btn-sm" data-rsadd="${i}">見込み客に追加</button>
          ${c.formUrl ? `<button class="btn btn-accent btn-sm" data-rsform="${i}">📝 フォームで営業</button>` : ""}
        </div>
      </div>`;
    }).join("");
    box.querySelectorAll("[data-rsadd]").forEach((b) => b.onclick = () => addCandidate(+b.dataset.rsadd, b));
    box.querySelectorAll("[data-rsform]").forEach((b) => b.onclick = () => {
      const c = rsCandidates[+b.dataset.rsform]; if (!c) return;
      openFormAssist({ company: c.company, kind: c.kind, note: c.note || "", formUrl: c.formUrl, source: c.source || "", leadId: "", candidate: c });
    });
  }
  function candidateToLead(c) {
    const noteLines = [];
    if (c.fax) noteLines.push("FAX: " + c.fax);
    if (c.formUrl) noteLines.push("問い合わせフォーム: " + c.formUrl);
    if (c.source) noteLines.push("出典: " + c.source);
    if (c.note) noteLines.push(c.note);
    noteLines.push("（店舗リサーチで自動収集・要確認）");
    return { company: c.company, kind: c.kind || "整備工場", status: "見込み", contact: "", phone: c.phone || "", email: c.email || "", note: noteLines.join("\n") };
  }
  async function addCandidate(i, btn) {
    const c = rsCandidates[i]; if (!c) return;
    if (btn) { btn.disabled = true; btn.textContent = "追加中…"; }
    try { await api("saveLead", { lead: candidateToLead(c) }); if (btn) btn.textContent = "✓ 追加済み"; toast("見込み客に追加しました"); }
    catch (e) { toast(e.message); if (btn) { btn.disabled = false; btn.textContent = "見込み客に追加"; } }
  }
  // ---- フォーム営業アシスト(AI本文生成→コピー→相手フォームを開く。送信は人が行う) ----
  let fmCtx = null;
  const formUrlFromNote = (note) => { const m = String(note || "").match(/問い合わせフォーム:\s*(https?:\/\/\S+)/); return m ? m[1] : ""; };
  function formTask(ctx) {
    return `「${ctx.company}」（業種:${ctx.kind || "整備関連"}）の"問い合わせフォーム"から送る、初回の問い合わせ文を作成してください。
・フォーム送信用なので簡潔に（180〜300字程度）。件名行や【】などの見出しは付けない。
・流れ: 軽い挨拶 → 自己紹介(メカノAI／Cablueie 中江) → 用件(整備現場の調べ物・記録の手間を減らすツールのご案内。資料やデモをご覧いただけます) → 返信先(メール cablueie.123@gmail.com ／ TEL 080-3692-0101)。
・押し売りにしない。相手が読んで負担にならない自然な文章。プレースホルダ([会社名]等)は使わない。
・相手メモがあれば軽く反映: ${ctx.note || "（特記なし）"}`;
  }
  async function genFormBody(ctx) {
    const j = await api("generate", { role: "writer", task: formTask(ctx), lead: { company: ctx.company, kind: ctx.kind, note: ctx.note }, product: "works" });
    return String(j.text || "").trim();
  }
  function fmFill(ctx) {
    $("fmBody").value = ""; $("fmBody").placeholder = "生成中…（10〜20秒）";
    genFormBody(ctx).then((t) => { $("fmBody").value = t; }).catch((e) => { $("fmBody").placeholder = "生成に失敗しました: " + (e.message || e); });
  }
  function openFormAssist(ctx) {
    fmCtx = ctx;
    $("fmTitle").textContent = "フォーム営業 — " + ctx.company;
    $("fmOpen").href = ctx.formUrl || "#";
    show("formModal", true);
    fmFill(ctx);
  }
  window.openFormAssist = openFormAssist;
  { const b = $("fmClose"); if (b) b.onclick = () => show("formModal", false); }
  { const b = $("fmCopy"); if (b) b.onclick = () => copy($("fmBody").value || ""); }
  { const b = $("fmRegen"); if (b) b.onclick = () => { if (fmCtx) fmFill(fmCtx); }; }
  { const b = $("fmDone"); if (b) b.onclick = async () => {
      if (!fmCtx) return;
      b.disabled = true;
      try {
        let lead;
        if (fmCtx.lead) lead = Object.assign({}, fmCtx.lead, { status: "アプローチ中" });
        else if (fmCtx.candidate) { lead = candidateToLead(fmCtx.candidate); lead.status = "アプローチ中"; }
        if (lead) { await api("saveLead", { lead }); await loadLeads(); }
        toast("「アプローチ中」にしました");
        show("formModal", false);
      } catch (e) { toast(e.message); }
      finally { b.disabled = false; }
    };
  }

  const _rsBtn = $("btnResearch");
  if (_rsBtn) _rsBtn.onclick = async () => {
    const area = ($("rsArea").value || "").trim();
    const kind = $("rsKind").value;
    const count = parseInt($("rsCount").value, 10) || 10;
    if (!area) { toast("地域を入力してください"); $("rsArea").focus(); return; }
    _rsBtn.disabled = true; $("rsStat").textContent = "検索中…（30秒ほどかかることがあります）";
    $("rsResults").innerHTML = ""; rsCandidates = []; show("btnRsAddAll", false);
    try {
      const j = await api("research", { area, kind, count, exclude: rsExcludeNames() });
      // 念のためクライアント側でも既出・既存見込み客を除外(サーバ除外と二重の安全網)
      const fresh = (j.candidates || []).filter((c) => {
        if (rsSeen[rsSeenKey(c)]) return false;
        if ((leads || []).some((l) => rsNorm(l.company) === rsNorm(c.company))) return false;
        return true;
      });
      // 返ってきた新規候補は「取得済み」として記憶(次回以降は出さない)
      fresh.forEach((c) => { rsSeen[rsSeenKey(c)] = c.company; });
      rsSaveSeen();
      rsCandidates = fresh;
      $("rsStat").textContent = fresh.length
        ? fresh.length + " 件の新しい候補（既出は自動除外）"
        : "新しい候補が見つかりませんでした。地域・業種を変えるか、「収集履歴をリセット」で集め直せます。";
      renderResearch();
    } catch (e) { $("rsStat").textContent = "⚠ " + (e.message || e); }
    finally { _rsBtn.disabled = false; }
  };
  $("rsArea") && $("rsArea").addEventListener("keydown", (e) => { if (e.key === "Enter") _rsBtn.click(); });
  { const _f = $("rsFilter"); if (_f) _f.onchange = renderResearch; }
  { const _rr = $("btnRsReset"); if (_rr) _rr.onclick = () => {
      if (!confirm("「取得済み(重複除外)」の記録を消します。次の検索から、以前に出た店舗も再び候補に含まれます。よろしいですか？")) return;
      rsSeen = {}; rsSaveSeen();
      $("rsStat").textContent = "収集履歴をリセットしました";
      toast("収集履歴をリセットしました");
    };
  }
  const _rsAll = $("btnRsAddAll");
  if (_rsAll) _rsAll.onclick = async () => {
    const list = rsVisible();
    if (!list.length) return;
    if (!confirm(list.length + " 件（表示中）をすべて見込み客に追加します。よろしいですか？")) return;
    _rsAll.disabled = true; let ok = 0;
    for (let i = 0; i < list.length; i++) {
      try { await api("saveLead", { lead: candidateToLead(list[i]) }); ok++; $("rsStat").textContent = "追加中… " + ok + "/" + list.length; } catch (e) {}
    }
    $("rsStat").textContent = "✓ " + ok + " 件を見込み客に追加しました";
    _rsAll.disabled = false;
    toast(ok + " 件を追加しました");
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

  const _setCampBusy = (busy) => {
    if ($("btnRunCamp")) $("btnRunCamp").disabled = busy;
    if ($("btnRunSend")) $("btnRunSend").disabled = busy;
  };
  // 対象の見込み客ぶんの文面を順に生成。完了後 true(生成あり&中止なし)を返す。
  async function runGeneration() {
    const targets = filteredLeads();
    if (!targets.length) { toast("対象の見込み客がいません"); return false; }
    const channel = $("cpChannel").value, angle = $("cpAngle").value;
    const chTxt = CHANNEL_TXT[channel], anTxt = ANGLE_TXT[angle];
    campStop = false; campResults = [];
    show("btnStopCamp", true); show("btnCsv", false); show("btnBulkSend", false); _setCampBusy(true);
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
      campResults.push({ company: l.company, kind: l.kind || "", channel, text, email: (l.email || "").trim(), id: l.id || "", err });
      appendCampCard(l.company, l.kind || "", text, err);
      $("cpBar").style.width = Math.round(((i + 1) / targets.length) * 100) + "%";
    }
    _setCampBusy(false);
    show("btnStopCamp", false);
    show("btnCsv", campResults.length > 0);
    show("btnBulkSend", campResults.length > 0);
    toast(campStop ? "中止しました" : "生成が完了しました（" + campResults.length + "件）");
    return !campStop && campResults.length > 0;
  }
  $("btnRunCamp").onclick = runGeneration;

  // 生成した文面を、対象の見込み客へメールで一括送信
  function extractSubject(text) {
    const first = String(text || "").split("\n")[0] || "";
    const m = first.match(/^\s*(?:件名|タイトル|subject)\s*[:：]\s*(.+)$/i);
    return m ? m[1].trim() : "";
  }
  function bodyWithoutSubject(text) {
    const lines = String(text || "").split("\n");
    if (/^\s*(?:件名|タイトル|subject)\s*[:：]/i.test(lines[0] || "")) return lines.slice(1).join("\n").replace(/^\n+/, "");
    return text;
  }
  // 生成済みの文面を、メール登録済みの対象へ一括送信(送信前に1回だけ確認)
  async function sendCampaign(opt) {
    const sendable = campResults.filter((r) => !r.err && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
    const noMail = campResults.filter((r) => !r.err && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)).length;
    if (!sendable.length) { toast("送信できる宛先（メール登録済み）がありません"); return; }
    let msg = (opt && opt.prefix ? opt.prefix : "") + sendable.length + " 件へメールを送信します。よろしいですか？";
    if (noMail) msg += "\n（メール未登録の " + noMail + " 件は送信されません。フォーム/電話でご連絡ください）";
    if (!confirm(msg)) return;
    _setCampBusy(true); show("btnCsv", false); if ($("btnBulkSend")) $("btnBulkSend").disabled = true;
    show("cpSendBar", true); $("cpSendBarInner").style.width = "0%";
    let ok = 0, ng = 0;
    for (let i = 0; i < sendable.length; i++) {
      const r = sendable[i];
      $("cpSendStat").textContent = "送信中… " + (i + 1) + "/" + sendable.length + "（" + r.company + "）";
      const subject = extractSubject(r.text) || "メカノAI のご案内";
      const body = bodyWithoutSubject(r.text);
      try {
        await api("sendMail", { to: r.email, subject, body, leadId: r.id });
        ok++;
      } catch (e) { ng++; }
      $("cpSendBarInner").style.width = Math.round(((i + 1) / sendable.length) * 100) + "%";
    }
    $("cpSendStat").textContent = "完了：送信 " + ok + " 件" + (ng ? " / 失敗 " + ng + " 件" : "") + (noMail ? " / 未送信(メール未登録) " + noMail + " 件" : "");
    _setCampBusy(false); if ($("btnBulkSend")) $("btnBulkSend").disabled = false; show("btnCsv", true);
    toast("一括送信が完了しました（成功 " + ok + " 件）");
  }
  { const _bs = $("btnBulkSend"); if (_bs) _bs.onclick = () => sendCampaign(); }
  // ★作成→即送信を1クリックで(生成完了後、送信前に確認を1回)
  { const _rsend = $("btnRunSend"); if (_rsend) _rsend.onclick = async () => {
      const okGen = await runGeneration();
      if (okGen && !campStop) await sendCampaign({ prefix: "作成が完了しました。続けて " });
    };
  }

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
    const edition = ($("isEdition") && $("isEdition").value === "personal") ? "personal" : "works";
    if (!company || !email) { $("isStat").textContent = "会社名とメールアドレスは必須です。"; return; }
    $("btnIssue").disabled = true; $("isStat").textContent = "発行中…";
    try {
      const r = await api("issueAccount", { company, name, email, plan, edition });
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
    const edition = ($("isEdition") && $("isEdition").value === "personal") ? "personal" : "works";
    if (!email) return;
    if (!confirm(email + " 宛に案内メールを送信します。よろしいですか？\n（※パスワードが変わるため、既に発行済みの場合は新しいパスワードで上書きされます）")) return;
    $("btnIssueSend").disabled = true; $("isSendStat").textContent = "送信中…";
    try {
      const r = await api("issueAccount", { company, name, email, plan, send: true, edition });
      issuedMail = r.body || issuedMail;
      $("isMail").value = r.body || $("isMail").value;
      $("isCreds").querySelector(".isPw") && ($("isCreds").querySelector(".isPw").textContent = r.password);
      $("isSendStat").textContent = r.sent ? "✓ 送信しました" : "⚠ 送信できませんでした（メール設定をご確認ください）";
    } catch (e) { $("isSendStat").textContent = "⚠ " + (e.message || e); }
    finally { $("btnIssueSend").disabled = false; }
  };
})();
