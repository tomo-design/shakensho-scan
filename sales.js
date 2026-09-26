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
  const OWNER_EMAIL = "cablueie.123@gmail.com";   // 運営オーナー(本体アプリと一致)。roleが外れても自動でsuper復帰させる。
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
    // オーナー(運営)アカウントは、万一roleが外れていてもログイン時に自動でsuperへ復帰(コンソールがロックアウトされないように)
    if (role !== "super" && user.email && user.email.toLowerCase() === OWNER_EMAIL.toLowerCase()) {
      try { await db.collection("users").doc(user.uid).set({ email: user.email, role: "super", active: true }, { merge: true }); role = "super"; } catch (e) {}
    }
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
      show("tab-sns", tab === "sns");
      show("tab-camp", tab === "camp");
      show("tab-inbox", tab === "inbox");
      show("tab-issue", tab === "issue");
      if (teamView) setProduct(tab === "pocket" ? "pocket" : "works");
      if (tab === "camp") { updateCampCount(); loadDripConfig(); }
      if (tab === "research") loadArConfig();
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
          ${(l.phone || l.email || formUrlFromNote(l.note) || faxFromNote(l.note)) ? `<button class="btn btn-accent btn-sm" data-leadform="${l.id}">📣 営業文を作る</button>` : ""}
        </div>
      </div>`).join("");
    box.querySelectorAll("[data-leadform]").forEach((b) => b.onclick = () => {
      const l = leads.find((x) => x.id === b.dataset.leadform); if (!l) return;
      const addrM = String(l.note || "").match(/住所:\s*(.+)/);
      openFormAssist({ company: l.company, kind: l.kind, note: l.note || "", formUrl: formUrlFromNote(l.note), fax: faxFromNote(l.note), phone: l.phone || "", address: addrM ? addrM[1].trim() : "", lead: l });
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
          ${(c.formUrl || c.fax || c.phone || c.address) ? `<button class="btn btn-accent btn-sm" data-rsform="${i}">📣 営業文を作る</button>` : ""}
        </div>
      </div>`;
    }).join("");
    box.querySelectorAll("[data-rsadd]").forEach((b) => b.onclick = () => addCandidate(+b.dataset.rsadd, b));
    box.querySelectorAll("[data-rsform]").forEach((b) => b.onclick = () => {
      const c = rsCandidates[+b.dataset.rsform]; if (!c) return;
      openFormAssist({ company: c.company, kind: c.kind, note: c.note || "", formUrl: c.formUrl || "", fax: c.fax || "", phone: c.phone || "", address: c.address || "", source: c.source || "", leadId: "", candidate: c });
    });
  }
  function candidateToLead(c) {
    const noteLines = [];
    if (c.fax) noteLines.push("FAX: " + c.fax);
    if (c.address) noteLines.push("住所: " + c.address);
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
  // ---- 自動リサーチ設定(毎朝9:00の自動収集) ----
  async function loadArConfig() {
    try {
      const j = await api("getConfig"); const c = j.config || {};
      if ($("arEnabled")) $("arEnabled").checked = !!c.arEnabled;
      if ($("arAreas")) $("arAreas").value = c.arAreas || "";
      if ($("arKind")) $("arKind").value = c.arKind || "整備工場";
      if ($("arPerRun")) $("arPerRun").value = c.arPerRun || 10;
      if ($("arStat")) {
        let s = "";
        if (c.arLastRun) {
          const d = new Date(c.arLastRun);
          s = "前回自動実行: " + d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() +
            (typeof c.arLastAdded === "number" ? "（追加 " + c.arLastAdded + " 件）" : "");
        }
        $("arStat").textContent = s;
      }
    } catch (e) { if ($("arStat")) $("arStat").textContent = e.message; }
  }
  { const b = $("btnSaveAr"); if (b) b.onclick = async () => {
      b.disabled = true;
      try {
        await api("setConfig", { config: {
          arEnabled: $("arEnabled").checked, arAreas: $("arAreas").value,
          arKind: $("arKind").value, arPerRun: parseInt($("arPerRun").value, 10) || 10,
        } });
        toast("自動リサーチの設定を保存しました");
        loadArConfig();
      } catch (e) { toast(e.message); }
      finally { b.disabled = false; }
    };
  }

  // ---- フォーム営業アシスト(AI本文生成→コピー→相手フォームを開く。送信は人が行う) ----
  let fmCtx = null;
  const formUrlFromNote = (note) => { const m = String(note || "").match(/問い合わせフォーム:\s*(https?:\/\/\S+)/); return m ? m[1] : ""; };
  const faxFromNote = (note) => { const m = String(note || "").match(/FAX:\s*([\d\-+()\s]{6,})/); return m ? m[1].trim() : ""; };
  // チャネル別の原稿生成タスク
  function channelTask(ctx, ch) {
    const co = ctx.company, kind = ctx.kind || "整備関連", note = ctx.note || "（特記なし）";
    const sign = "メカノAI／Cablueie（カブリエ）担当:中江／TEL:080-3692-0101／Mail:cablueie.123@gmail.com";
    if (ch === "fax") {
      return `「${co}」（業種:${kind}）宛に送る、そのまま送信できる【FAX DM原稿】を作成してください。
・冒頭に簡単なFAX送信状(宛先:${co} 御中／差出:${sign}／送信枚数:1枚／日付は空欄)。
・本文はA4・1枚で読める分量。整備現場の『調べ物・記録の手間を減らす』『AI故障診断・修理手順』を要点で。人手不足・若手育成にも触れてよい。
・末尾に「FAX不要の場合はお手数ですがその旨ご返信ください」と一文＋署名(${sign})。
・誇張・煽りはしない。プレースホルダ([会社名]等)は使わない。`;
    }
    if (ch === "postal") {
      return `「${co}」（業種:${kind}）宛に送る【郵送DMの原稿】を作成してください。
・先頭に宛名ブロック（${ctx.address ? "住所:" + ctx.address + "／" : ""}${co} 御中）。
・丁寧な挨拶状の体裁で、A4・1枚程度。整備現場の『調べ物・記録の手間を減らす』『AI故障診断・修理手順』を中心に、人手不足・若手育成の時代背景を一言。
・「まずは無料でお試しいただけます（体験デモ: https://mechanoai-cablueie.com/?demo=1）」と案内。
・末尾に署名(${sign})。押し売りにしない。プレースホルダは使わない。`;
    }
    if (ch === "phone") {
      return `「${co}」（業種:${kind}）へ電話する【電話トークスクリプト】を作成してください。
・流れを台本形式で: 受付突破の一言→担当者へ→つかみ(整備現場の調べ物・記録を減らすツールのご案内)→用件(AI故障診断・修理手順・カルテ)→相手の反応別の切り返し(「間に合ってる」「高いのでは」「忙しい」への返し各1つ)→次アクション(体験デモ/資料送付の許可取り)。
・1回の電話は1〜2分で終わる長さ。台本の各行の頭に【受付】【担当】等のラベル。自然な口語で。
・相手メモ: ${note}`;
    }
    // form
    return `「${co}」（業種:${kind}）の"問い合わせフォーム"から送る、初回の問い合わせ文を作成してください。
・フォーム送信用なので簡潔に（180〜300字程度）。件名行や【】などの見出しは付けない。
・流れ: 軽い挨拶 → 自己紹介(メカノAI／Cablueie 中江) → 用件(整備現場の調べ物・記録の手間を減らすツールのご案内。資料やデモをご覧いただけます) → 返信先(${sign})。
・押し売りにしない。相手が読んで負担にならない自然な文章。プレースホルダは使わない。
・相手メモがあれば軽く反映: ${note}`;
  }
  function fmChannel() { return ($("fmChannel") && $("fmChannel").value) || "form"; }
  async function genFormBody(ctx, ch) {
    const j = await api("generate", { role: "writer", task: channelTask(ctx, ch), lead: { company: ctx.company, kind: ctx.kind, note: ctx.note }, product: "works" });
    return String(j.text || "").trim();
  }
  function fmSyncChannelUI(ctx) {
    const ch = fmChannel();
    show("fmOpen", ch === "form" && !!ctx.formUrl);
    if (ch === "form" && ctx.formUrl) $("fmOpen").href = ctx.formUrl;
    const contacts = [];
    if (ctx.phone) contacts.push("☎ " + ctx.phone);
    if (ctx.fax) contacts.push("📠 " + ctx.fax);
    if (ctx.address) contacts.push("📮 " + ctx.address);
    if (ctx.formUrl) contacts.push("📝 フォームあり");
    if ($("fmContacts")) $("fmContacts").textContent = contacts.length ? "連絡先: " + contacts.join("　") : "";
    const hint = { form: "フォームを開いて本文を貼り付け送信（CAPTCHA・最終送信はご自身で）。", fax: "コピーしてFAX送信システム/複合機で送ってください。", postal: "コピー/印刷して封書で郵送してください。", phone: "この台本を見ながら電話をかけてください。" };
    if ($("fmHint")) $("fmHint").textContent = hint[ch] || "";
  }
  function fmFill(ctx) {
    const ch = fmChannel();
    fmSyncChannelUI(ctx);
    $("fmBody").value = ""; $("fmBody").placeholder = "生成中…（10〜20秒）";
    genFormBody(ctx, ch).then((t) => { $("fmBody").value = t; }).catch((e) => { $("fmBody").placeholder = "生成に失敗しました: " + (e.message || e); });
  }
  function openFormAssist(ctx) {
    fmCtx = ctx;
    $("fmTitle").textContent = "営業文を作る — " + ctx.company;
    // 使えるチャネルの初期選択(フォーム→FAX→郵送→電話の優先)
    const def = ctx.formUrl ? "form" : (ctx.fax ? "fax" : (ctx.address ? "postal" : (ctx.phone ? "phone" : "form")));
    if ($("fmChannel")) $("fmChannel").value = def;
    show("formModal", true);
    fmFill(ctx);
  }
  window.openFormAssist = openFormAssist;
  { const b = $("fmClose"); if (b) b.onclick = () => show("formModal", false); }
  { const b = $("fmCopy"); if (b) b.onclick = () => copy($("fmBody").value || ""); }
  { const b = $("fmRegen"); if (b) b.onclick = () => { if (fmCtx) fmFill(fmCtx); }; }
  { const s = $("fmChannel"); if (s) s.onchange = () => { if (fmCtx) fmFill(fmCtx); }; }
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

  // ---------- SNS発信アシスト(投稿文生成→コピー→投稿画面を開く) ----------
  const SNS = {
    // Xのintent(事前入力)は短文のみ安定。長文はURLが巨大でXがエラーになるため、通常の投稿画面を開き貼り付け運用。
    x: { name: "X（Premium）", limit: 25000, prefill: true, prefillMax: 260,
      compose: (t) => (t && t.length <= 260) ? "https://x.com/intent/post?text=" + encodeURIComponent(t) : "https://x.com/compose/post",
      guide: "Premium契約なので長文OK（目安300〜1500字。読み手が飽きない範囲で）。冒頭1〜2行で引きを作り→本文→締め。ハッシュタグは2〜3個まで。過度な絵文字は避け、改行で読みやすく。短く刺したい時は260字前後でもよい。" },
    instagram: { name: "Instagram", limit: 2200, compose: () => "https://www.instagram.com/", prefill: false, guide: "写真に添えるキャプション。改行で読みやすく、共感→ひとこと訴求。ハッシュタグは末尾にまとめて5〜10個。" },
    facebook: { name: "Facebook", limit: 2000, compose: () => "https://www.facebook.com/", prefill: false, guide: "やや丁寧な語り口。段落で読みやすく。リンク誘導OK。" },
    line: { name: "LINE公式", limit: 500, compose: () => "https://manager.line.biz/", prefill: false, guide: "友だち向けのお知らせ調。短く親しみやすく、1メッセージで完結。" },
    note: { name: "note（記事）", limit: 6000, compose: () => "https://note.com/notes/new", prefill: false, guide: "note記事の体裁で書く。構成: 【1行目に記事タイトル(30字前後・思わず開きたくなる)】→空行→リード文(2〜3行で共感と『この記事で分かること』)→本文は見出し(『## 』記法)で3〜5セクションに分け、各セクションは具体例やエピソードを交えて読みやすく→まとめ→最後にやわらかいCTA(体験デモや無料お試し)。読者が最後まで読める語り口で、宣伝は最後だけ。1500〜3000字目安。" },
    tiktok: { name: "TikTok（縦型ショート動画）", limit: 2200, compose: () => "https://www.tiktok.com/upload", prefill: false,
      guide: "縦型ショート動画(15〜40秒)の【台本】として書く。構成: ①最初の2秒で必ず止める強いフック(セリフor大きめのテロップ)→②シーンを『◆シーン1／◆シーン2…』のように区切り、各シーンに【映像】(何を映すか)＋【テロップ】(画面に出す短い字幕・1行)＋【ナレ/セリフ】を書く→③オチ・気づき→④さいごに軽くCTA。テンポ命で1シーン2〜4秒。最後に別欄として『---』の下に『キャプション:』(共感1〜2行)と『ハッシュタグ:』(#整備士 #車のある生活 等3〜5個)を付ける。整備あるある・現場のリアルで、宣伝くささを消す。" },
    youtube: { name: "YouTube（Shorts台本）", limit: 3000, compose: () => "https://studio.youtube.com/channel/UC/videos/upload", prefill: false,
      guide: "縦型ショート動画(YouTube Shorts・目安25〜30秒)の【台本+メタ情報】として書く。構成: 【1行目にタイトル案】(40字以内・検索されやすく思わずタップしたくなる言葉)→空行→②シーンを『◆導入(0-10秒)／◆転換(10-20秒)／◆結末(20-30秒)』の3ブロックで区切り、各ブロックに【映像】(何を映すか・現場のリアルな一場面)＋【セリフ/ナレ】(短く自然な日本語・無ければ省略可)を書く→③最後に別欄として『---』の下に『説明欄:』(2〜3行の紹介文＋7日間無料などの導線を1行だけ)と『タグ:』(#整備士 #カーライフ #shorts 等4〜6個)を付ける。この本文はそのまま『📺 YouTube Shorts動画を作る』ボタンの元ネタになるので、3ブロックの起承転結がはっきり分かるように書く。宣伝くささは消し、現場のリアルとスカッと感を優先。" },
    // Threads: 公式Web Intent(/intent/post?text=)で本文を事前入力できる。1投稿500字上限(全アカウント共通)。
    threads: { name: "Threads", limit: 500, prefill: true, prefillMax: 500,
      compose: (t) => (t && t.length <= 500) ? "https://www.threads.com/intent/post?text=" + encodeURIComponent(t) : "https://www.threads.com/",
      guide: "Threads向けの1投稿。【文量設定に関わらず500字以内を厳守】（目安150〜400字）。Xより柔らかく会話的で、ポジティブ寄りの空気感が伸びやすい。1〜2行目で引き→共感や本音→ゆるい締め。問いかけで終えると返信が付きやすい。ハッシュタグ（トピックタグ）は1投稿につき1個だけ、または無し。絵文字は0〜2個。宣伝感はX以上に嫌われるので、導線は入れても最後に一言だけ。" },
  };
  const snsCfg = () => SNS[($("snsPlatform") && $("snsPlatform").value) || "x"] || SNS.x;
  function updateSnsCount() {
    const g = snsCfg(); const body = ($("snsBody").value || ""); const n = body.length;
    if ($("snsCount")) $("snsCount").textContent = "　" + n + " / " + g.limit + "字" + (n > g.limit ? " ⚠字数超過" : "");
    if ($("snsOpen")) $("snsOpen").href = g.compose(body);
    if ($("snsHint")) {
      if (!body) { $("snsHint").textContent = ""; }
      else if (g.prefill) {
        $("snsHint").textContent = (n <= (g.prefillMax || 260))
          ? "「投稿画面を開く」で本文入力済みの" + g.name + "投稿画面が開きます。画像添付・最終送信はご自身で。"
          : "長文のため事前入力できません。開くと本文は自動コピーされるので、" + g.name + "の投稿画面に貼り付けて投稿してください。";
      } else {
        $("snsHint").textContent = g.name + "は本文の事前入力に非対応です。「コピー」→「投稿画面を開く」→貼り付けで投稿してください（開くと自動コピー）。";
      }
    }
  }
  const SNS_STYLE = {
    balanced: "スタイル: 標準。価値の1つを分かりやすく伝え、最後にさりげなく体験導線(7日無料/デモ)を添える。",
    honne: "スタイル: 整備士の現場のリアルな本音・あるある(例:今の車は自動化・電動化で故障リスク増、診断が複雑化、修理費が高騰、余計な機能はいらない…等)に強く共感するところから入り、『その複雑化した診断・修理こそAIが手伝える』と自然にメカノAIへつなげる。宣伝は前面に出さず、共感が主役・導線は最後にひとことだけ。整備士が『それなー』と刺さる生々しさ・リアルさを大事に。押し売り厳禁。",
    tips: "スタイル: 整備士に役立つ豆知識・小ネタを1つ提供し、最後に『メカノAIならこれが一発で出る』等で自然に導線。",
    casual: "スタイル: 今風でカジュアルなユーザー体験レビュー風。『このアプリ、マジで便利…』のような素の一言から入り、実際に使って助かった具体シーン(例:診断で迷わなくなった/交換手順がすぐ出た/締付トルクを探さなくてよくなった 等)を1〜2個、テンションよくテンポよく語る。友達に『これ良かったよ』と勧める口調。硬い宣伝文句・かしこまった敬語は使わない。絵文字は使っても1〜3個まで。ステマにならないよう、あくまで感想ベースで自然に。最後に軽く『7日間無料だから試してみて』程度で締める。",
    campaign: "スタイル: 7日間無料・月¥500(Pocket)などの告知を主軸に、簡潔に魅力とCTAを伝える。",
    gag: "スタイル: Xで鉄板の『空想の聞いた話』ネタ(明らかにフィクションと分かるギャグ)。構成は【『さっき◯◯(日常の場所)で△△(場違いな人物=女子高生/近所のおばあちゃん/幼稚園児/コンビニ店員/居酒屋のサラリーマン 等)が「(整備・車のやたら専門的で核心を突いた一言)」って言ってた。』の1〜3行だけ】。笑いの核は『そんな人が言うわけない専門発言』のギャップ。誰が読んでも作り話のジョークと分かる振り切った設定にする(実在の人物・店・具体的数値の捏造はしない、あくまでネタ)。オチはセリフ自体のシュールさで完結させ、説明・解説・宣伝は基本つけない。どうしても入れるなら最後に(小声)や※みたいに一言だけボソッと自虐的に添える程度。整備士が『いや誰やねん』『それ本業やろw』とツッコみたくなる温度。絵文字ほぼ無し、ハッシュタグ0〜1個。短く。",
    sukatto: "スタイル: 『スカッとする』お客さんとの物語(整備現場の実話風フィクション)。構成は【①理不尽・失礼・上から目線・値切り・自己診断の押し付け・他店やネットの受け売りでマウント…等の“困った客”が女性整備士に絡んでくる導入で読者をモヤっとさせる→②女性整備士は感情的に言い返さず、プロとして淡々と正確に対応する(ここでメカノAIが根拠・診断・整備記録・トルク値・過去履歴などを即座に示し、思い込みを事実で覆す)→③客の間違い/見落としが客観的な事実として明らかになり、形勢が一気に逆転して“スカッと”する山場→④客が態度を改める/黙る/逆に感謝する等の気持ちいいオチ→⑤最後に、この『事実・根拠・整備履歴をその場でパッと示せる』ことこそメカノAIの価値だと、押し付けず一言で自然につなげる】。読者(整備士)が『いいぞ!』『スカッとした』と溜飲を下げるカタルシスが主役。ただし: 実在の人物・店舗・具体的な捏造数値は使わない/特定業者の誹謗中傷はしない/女性整備士は品よく冷静に(逆ギレ・暴言・見下しで勝つのはNG、あくまで“事実と実力”で気持ちよく勝つ)/過度な不安煽りや作り話の実績は禁止。会話は自然な口語、改行を効かせテンポよく。長めの文量が合う。誠実に、でも痛快に。",
    drama: "スタイル: 会話劇・寸劇形式(整備あるある)。構成は【①整備士(女性)と客の短いセリフの応酬でリアルな会話劇→②よくある誤解やすれ違い(例:『車検に通る』と『次の車検まで整備不要』は別、等)が浮かび上がる→③『半年後』のようにその後どうなったかのオチ→④数行のやさしい解説(なぜそうなるか)→⑤読者への具体的な行動アドバイスを箇条書きで(例:車検後に確認すべき=今回交換した部品/見送った部品/次に注意する場所/いつ頃交換が必要か)→⑥最後に、その『整備内容・見送り部品・次の交換時期を記録して伝える/共有する』ことこそメカノAIが助けになる、と自然につなげる】。テンポよく改行を効かせ、長めの文量が合う。誠実に。過度な不安煽り・特定業者の批判はしない。会話は自然な口語で。冒頭に短い状況説明(例:『車検にて』)を置いてよい。",
    buzz: "スタイル: バズ(拡散)狙い。最初の1行で必ずスクロールを止める強いフックを作る。共感・意外性・笑い・『え、そんなことできるの?』のいずれかを核に、思わずいいね/RT/保存したくなる要素を1つ仕込む。読み終えたら『面白そう、これは試したい/契約したい』と感じさせる。ただし誇張・嘘・過度な煽り・不快な釣りはNG。社会的証明を使う場合も具体的な数字・店名・実績は捏造せず『おかげさまで導入が増えています』程度に留める。",
    ask: "スタイル: 見てる人に問いかけて『リプ・引用・投票したくなる』エンゲージメント誘発型。整備士あるあるや現場の一場面を1〜3行でサッと出したあと、答えやすい具体的な質問で締める(例:『みんなはどう診てる?』『これ、あなたの工場ならどうする?』『最初に疑うのどこ?』『交換派? まだ乗れる派?』)。質問は1つだけに絞る。ぼんやりした『どう思いますか?』ではなく、経験を語りたくなる具体度にする。二択・あるある募集・体験談募集などリプのハードルを下げる形が有効。宣伝は入れない回が基本(入れても最後にボソッと一言)。押し付けない自然な口語で。絵文字0〜1個、ハッシュタグ0〜2個。短め。",
  };
  // 毎回変える"切り口"の素。ランダムに選んで指示に混ぜることで、同じ設定でも無限にパターンが変わる。
  const SNS_HOOKS = ["意外な事実・ギャップから入る", "強烈な共感あるあるから入る", "『こんな経験ない?』と問いかける", "失敗談→救われた話の起伏", "たとえ話・比喩で刺す", "一言ボケ/ユーモアから", "ビフォーアフターの対比", "3選/ランキング形式", "実況中継風のライブ感", "ベテラン女性整備士キャラのなりきり語り", "新人女性整備士の目線・成長物語", "逆張り・あえての本音", "へぇと言わせる豆知識トリビア", "現場の名言・格言風", "数字や比較でインパクト(作り話の数字は使わない)", "『昔は〇〇→今は〇〇』の時代の変化", "ちょっと笑える極端なあるある", "感情の急上昇(困った→解決してスカッと)"];
  const SNS_FORMATS = ["短い問いかけ＋オチ", "改行を活かしたテンポ重視", "会話・セリフ調", "ミニストーリー仕立て", "キャッチ1行＋ひとこと補足", "リスト風だが1点だけ強調"];
  // 題材(ネタ)の幅を強制的に広げるプール。故障コード(P0300等)に偏らせないため、毎回ここから1つ引いてヒントにする。
  const SNS_TOPICS = [
    "ブレーキ/パッド・ローターの摩耗と交換タイミング", "オイル交換・スラッジ・粘度選び", "タイヤの偏摩耗・空気圧・季節交換(スタッドレス)",
    "バッテリー上がり・アイドリングストップ車の劣化", "CVT/ATの変速不調・フルード", "エアコンの効き・ガス・エバポ臭",
    "異音・振動の原因切り分け(ハブベアリング/足回り/ブッシュ)", "オイル漏れ・にじみの見極め", "冷却水漏れ・オーバーヒート・サーモスタット",
    "警告灯が点いたけど原因が地味だった話", "タイミングベルト/チェーン交換の見送りリスク", "DPF/ディーゼルの煤・再生", "電装トラブル(暗電流・オルタ・配線)",
    "ハイブリッド/EVの整備現場での戸惑い", "見積りの伝え方・『車検通る』と『あと2年安心』は別問題", "代車が足りない・繁忙期のあるある",
    "部品の欠品・納期待ちの苦労", "若手が続かない・技術の継承", "出張/ロードサービスでの応急対応", "整備記録・カルテの引き継ぎで助かった/困った話",
    "リコール・サービスキャンペーンの対応", "旧車/過走行車の維持相談", "初めて診断機を使った時の衝撃", "客への説明が伝わらないもどかしさ",
    "夏/冬など季節ならではの入庫トラブル", "工具・リフト・設備投資の悩み", "点検で見つけた『あぶなかった』一件", "ネットの自己診断を鵜呑みにした客の話"
  ];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const SNS_LEN = {
    short: "短め・ひと言で刺す(目安120〜200字)",
    medium: "標準(目安300〜500字)",
    long: "じっくり長め(目安800〜1500字)",
  };
  // AIっぽさを徹底的に消すための最重要ルール(SNS専用)。書き手＝実在の整備士本人の"つぶやき"。
  const SNS_HUMAN = `【最重要・AIっぽさを消す（これを外すとスルーされる）】書き手は"宣伝担当"ではなく、実在の整備士本人がスマホでポツッとつぶやいた体で書く。営業・PR感を絶対に出さない。
・【主人公は女性】メインの主人公(書き手・語り手の整備士本人、会話劇やなりきりの中心人物)は女性として書く。主人公の一人称に『俺』は使わない(『私』『うち』か省略)。『〜だわよ』のような作った女性言葉や女性らしさの誇張はせず、現場のプロの自然な口語で。主人公以外の登場人物(先輩・後輩・工場長・同僚・お客さん等)は男性でも女性でもよい。
・使用禁止の言い回し: 「〜しませんか？」「ぜひ」「いかがでしたか」「〜な方も多いのではないでしょうか」「皆さん/みなさん」「私たち」「〜と言えるでしょう」「まとめると」「結論から言うと」「〜な時代です」、【】の見出し記法、絵文字の多用(使うなら0〜1個)、ハッシュタグの乱用(0〜2個まで)、きれいに整いすぎた起承転結、教科書みたいな説明口調、優等生の完璧な締め、抽象的な一般論。
・むしろOK: 口語・体言止め・言いさし・ぼやき・ツッコミ・独り言・自虐。文が短くて不揃いでいい。少し崩す。「で、結局〜」「いや〜」みたいな生っぽい入り。
・具体を1つ必ず入れる: 実際の部品名や現場の一場面(下記はあくまで例。毎回違う題材を使い、同じネタを繰り返さない): パッド残1mm、リフト満車、締付トルク◯◯、オイル量○L、スタッドレス山積み、代車が無い、ベテランが辞めた、部品欠品で納期待ち、暗電流でバッテリー上がり 等。
・【重要】故障コード(P0300や失火など特定のDTC)ばかりに偏らない。むしろ故障コードを出さない回のほうが多くていい。題材は毎回まったく別のものにする。
・感情や本音を先に出し、説明は最小限。読み手(整備士)が「わかる」「それなw」と反応する具体性と温度。
・宣伝は入れても最後に一言ボソッと。入れない回もあってよい。毎回リズム・語尾・入り方を変える。
・お手本の温度感(コピペ禁止・雰囲気だけ・題材は真似しない): 『パッド残1mm。"車検通るならいい"って言われたけど、たぶん半年でキーキー鳴って戻ってくるやつ。知ってる。』 / 『暗電流でバッテリー上がり、昔はテスター当てて配線たどって半日コース。今はだいぶ当たりが早くつくようになった。楽になったわ正直。』`;
  async function snsGen() {
    const product = ($("snsProduct").value === "pocket") ? "pocket" : "works";
    const g = snsCfg();
    const theme = ($("snsTheme").value || "").trim();
    const style = ($("snsStyle") && $("snsStyle").value) || "balanced";
    const len = ($("snsLen") && $("snsLen").value) || "medium";
    const isNote = ($("snsPlatform") && $("snsPlatform").value) === "note";
    const lenTxt = isNote ? "note記事として1500〜3000字程度（読み応えのある本文に）" : (SNS_LEN[len] || SNS_LEN.medium);
    const instruct = ($("snsInstruct") && $("snsInstruct").value || "").trim();
    const topicHint = theme ? "" : "／今回の題材=「" + pick(SNS_TOPICS) + "」(この題材を軸にする。前回までと必ず変える)";
    const seed = "今回の切り口(毎回変える・過去と被らせない): フック=「" + pick(SNS_HOOKS) + "」／形式=「" + pick(SNS_FORMATS) + "」" + topicHint + "。この切り口で新鮮な入りにする。";
    const task = `${g.name} に投稿する、メカノAI（${product === "pocket" ? "整備士個人向けアプリ Pocket" : "整備工場・法人向け Works"}）の投稿を1本、そのまま投稿できる完成形で作成してください。
${instruct ? "・【最優先の指示（他のスタイル設定より優先）】" + instruct + "\n" : ""}・${SNS_STYLE[style] || SNS_STYLE.balanced}
・${seed}
・${g.guide}
・${theme ? "テーマ: " + theme : "テーマはおまかせ（整備の現場に響く切り口を1つ選ぶ）"}
・毎回できるだけ違う表現・切り口にし、テンプレ的な言い回しの使い回しを避ける。読み手（${product === "pocket" ? "整備士本人" : "整備工場・経営者"}）が思わず反応する自然な投稿に。誇張・虚偽はしない。
・文量は ${lenTxt}。この範囲を目安にし、${g.limit} 字は超えないこと（冗長に引き伸ばさない）。
・前置きの説明や「以下が投稿文です」等は不要、本文だけ。
${SNS_HUMAN}`;
    $("snsStat").textContent = "生成中…"; $("btnSns").disabled = true;
    try {
      const j = await api("generate", { role: "marke", task, product, creative: true });
      const t = String(j.text || "").trim();
      $("snsBody").value = t; show("snsOutPanel", true); updateSnsCount(); updateSectBtn();
      $("snsStat").textContent = "";
    } catch (e) { $("snsStat").textContent = "⚠ " + (e.message || e); }
    finally { $("btnSns").disabled = false; }
  }
  { const b = $("btnSns"); if (b) b.onclick = snsGen; }
  { const b = $("snsRegen"); if (b) b.onclick = snsGen; }
  { const b = $("snsCopy"); if (b) b.onclick = () => copy($("snsBody").value || ""); }
  // 投稿画面を開く時、本文を自動でクリップボードへ(長文Xや事前入力非対応SNSで貼り付けしやすく)
  { const a = $("snsOpen"); if (a) a.addEventListener("click", () => { try { if (navigator.clipboard) navigator.clipboard.writeText($("snsBody").value || ""); } catch (e) {} }); }
  { const b = $("snsBody"); if (b) b.addEventListener("input", updateSnsCount); }
  { const s = $("snsPlatform"); if (s) s.onchange = updateSnsCount; }

  // 画像スタイルの素。毎回ランダムに選び、ありきたりを防ぎバズりやすい多彩なビジュアルに。
  // 画像・動画のメイン主人公は女性にする(ブランド方針)。脇役・背景の人物は男性でもよい。全プロンプト共通で差し込む。
  const PEOPLE_RULE = "PEOPLE (MANDATORY): The MAIN character — the protagonist / the most prominent central person in the frame — must be FEMALE (a woman or a girl). If only one person appears, she is a woman. Other supporting or background people (customers, colleagues, bosses, bystanders) may be men or women as fits the scene; keep them as the post describes. A woman mechanic should look like a real, capable professional in work clothes (no sexualized depiction).";
  const IMG_STYLES = [
    "cinematic dramatic lighting, shallow depth of field, film-like",
    "bold pop-art comic style with halftone, punchy colors",
    "clean modern flat vector illustration, friendly",
    "isometric 3D render, playful, detailed miniature scene",
    "dynamic action shot with motion blur and energy",
    "warm documentary photo, authentic garage atmosphere",
    "minimalist bold poster design, strong single focal point",
    "vibrant neon-accented night garage, cyber vibe",
    "retro Showa-era Japanese garage nostalgia",
    "cute cartoon mascot / character style, meme-friendly",
    "hyper-real close-up macro of hands and tools, gritty detail",
    "split before/after style composition, clear contrast",
  ];
  // 記事内の全見出し画像で共有する配色・雰囲気(1記事につき1つだけ選び、テイストを揃える)
  const IMG_PALETTES = [
    "warm amber & deep charcoal, cozy garage tones",
    "cool teal & slate blue, calm and modern",
    "bold red & off-white, high-energy poster feel",
    "muted earthy khaki & orange, retro Showa mood",
    "clean navy & bright cyan accent, trustworthy tech feel",
    "soft cream & sage green, gentle and friendly",
  ];
  // 媒体ごとの推奨アスペクト比(画像生成の指示に使う)
  const IMG_ASPECT = {
    x: "16:9 horizontal (landscape, about 1200x675px)",
    instagram: "1:1 square (1080x1080px)",
    facebook: "1.91:1 horizontal (landscape, about 1200x630px)",
    line: "1:1 square (1080x1080px)",
    note: "16:9 horizontal header banner (about 1280x670px)",
    tiktok: "9:16 vertical (portrait, 1080x1920px)",
    threads: "4:5 vertical portrait (1080x1350px, fills the Threads feed)",
    youtube: "9:16 vertical (portrait, 1080x1920px, YouTube Shorts)",
  };
  function buildImgPrompt(scene) {
    const post = ($("snsBody").value || "").trim();
    const product = ($("snsProduct").value === "pocket") ? "pocket" : "works";
    const platform = ($("snsPlatform") && $("snsPlatform").value) || "x";
    const aspect = IMG_ASPECT[platform] || IMG_ASPECT.x;
    const style = pick(IMG_STYLES);
    const subject = scene
      ? `DRAW EXACTLY THIS SCENE (this is the required subject — do not substitute a different one):\n${scene}`
      : `MOST IMPORTANT: Depict the actual scene / subject described in this Japanese post. Read it and illustrate what it is literally about (the specific part, tool, car system, or situation mentioned):\n"""${post.slice(0, 1200)}"""\nDraw THAT concrete subject — e.g. if it's about brake pads, show worn brake pads/rotor; if tires, show tires; if a battery, show a battery; if a garage moment, show that moment. Pick the subject from the post, not a default.`;
    return `Create a scroll-stopping, share-worthy social-media image for a Japanese automotive-repair audience (${product === "pocket" ? "individual car mechanics" : "auto repair shops / teams"}).
Aspect ratio / size (IMPORTANT — compose for this exact shape): ${aspect}. Fill the whole frame edge to edge in this ratio.
${subject}
Visual style (use this): ${style}. Make it striking, original and eye-catching — NOT a generic stock photo. Strong composition, bold focal point, emotion or humor if it fits.
Do NOT default to showing a smartphone or a phone screen — include a phone ONLY if the scene above is specifically about using a phone/app, otherwise leave it out entirely.
${PEOPLE_RULE}
IMPORTANT: Do NOT render any text, letters, words, logos or watermarks (text looks broken). Image only.`;
  }
  // 投稿文に見合う画像を生成(Gemini画像モデル)。文字は入れず、毎回違う映えるビジュアルに。
  const IMG_RATIO = { x: "16:9", instagram: "1:1", facebook: "16:9", line: "1:1", note: "16:9", tiktok: "9:16", threads: "4:5", youtube: "9:16" };
  const imgRatio = () => IMG_RATIO[($("snsPlatform") && $("snsPlatform").value) || "x"] || "16:9";
  let snsImgBase = "";   // 文字を載せる前の元画像(data URL)。文字だけ載せ直すのに使う。
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  // 生成画像の上に短い文字をキレイに合成(AIに日本語を描かせず、canvasで正確に描く)。
  // 位置はランダム、できるだけ1行に収める(フォントを自動縮小)、角丸の半透明パネル背景で位置を選ばず読みやすく。
  function overlayText(dataUrl, text) {
    return new Promise((resolve) => {
      text = String(text || "").replace(/\s*\n\s*/g, " ").trim();
      if (!text) return resolve(dataUrl);
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement("canvas");
          cv.width = img.naturalWidth || 1280; cv.height = img.naturalHeight || 720;
          const ctx = cv.getContext("2d");
          ctx.drawImage(img, 0, 0, cv.width, cv.height);
          const fam = (getComputedStyle(document.body).fontFamily) || "sans-serif";
          const pad = Math.round(cv.width * 0.045);
          const maxW = cv.width - pad * 2;
          // 1行で収まるフォントサイズを探す(大→縮小)。最小でも収まらなければ2行に折り返し(保険)
          let fs = Math.round(cv.width / 11);
          const minFs = Math.round(cv.width / 24);
          ctx.font = "800 " + fs + "px " + fam;
          while (fs > minFs && ctx.measureText(text).width > maxW) { fs -= 2; ctx.font = "800 " + fs + "px " + fam; }
          let lines = [text];
          if (ctx.measureText(text).width > maxW) {
            lines = []; let line = "";
            for (const ch of text.split("")) { const t = line + ch; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = ch; } else line = t; }
            if (line) lines.push(line);
          }
          const lh = fs * 1.25;
          const blockW = Math.min(maxW, Math.max.apply(null, lines.map((l) => ctx.measureText(l).width)));
          const blockH = lines.length * lh;
          // ランダム配置(左右×上中下。上下をやや多めに)
          const alignX = pick(["left", "center", "right"]);
          const posY = pick(["top", "top", "middle", "bottom", "bottom"]);
          const bx = alignX === "left" ? pad : (alignX === "right" ? (cv.width - pad - blockW) : (cv.width - blockW) / 2);
          const byTop = posY === "top" ? pad : (posY === "bottom" ? (cv.height - pad - blockH) : (cv.height - blockH) / 2);
          // 角丸パネル背景
          const bp = Math.round(fs * 0.42);
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          roundRect(ctx, bx - bp, byTop - bp, blockW + bp * 2, blockH + bp * 2, Math.round(fs * 0.35)); ctx.fill();
          // テキスト
          ctx.fillStyle = "#fff"; ctx.textBaseline = "top"; ctx.textAlign = "left";
          ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = Math.max(2, fs / 12);
          let y = byTop;
          for (const ln of lines) {
            const lw = ctx.measureText(ln).width;
            const x = alignX === "center" ? bx + (blockW - lw) / 2 : (alignX === "right" ? bx + (blockW - lw) : bx);
            ctx.fillText(ln, x, y); y += lh;
          }
          resolve(cv.toDataURL("image/png"));
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  async function snsShowImg(base) {
    snsImgBase = base;
    const text = ($("snsImgText") && $("snsImgText").value || "").trim();
    const url = await overlayText(base, text);
    $("snsImgEl").src = url; show("snsImgEl", true);
    $("snsImgDl").href = url; show("snsImgActs", true);
  }
  { const b = $("snsImgApplyText"); if (b) b.onclick = async () => { if (snsImgBase) await snsShowImg(snsImgBase); }; }
  async function snsGenImage() {
    const post = ($("snsBody").value || "").trim();
    if (!post) { toast("先に投稿文を作成してください"); return; }
    const aspect = imgRatio();
    // noteでサムネ文字が空なら、投稿1行目(タイトル)を短く自動提案
    if (($("snsPlatform") && $("snsPlatform").value) === "note" && $("snsImgText") && !$("snsImgText").value.trim()) {
      const firstLine = (post.split("\n")[0] || "").replace(/^#+\s*/, "").trim();
      if (firstLine) $("snsImgText").value = firstLine.slice(0, 24);
    }
    show("snsImgWrap", true); show("snsImgEl", false); show("snsImgActs", false);
    $("snsImgStat").textContent = "投稿内容を解析中…";
    if ($("snsImg")) $("snsImg").disabled = true; if ($("snsImgRegen")) $("snsImgRegen").disabled = true;
    try {
      let scene = ""; try { scene = await postToScene(post); } catch (e) {}
      const prompt = buildImgPrompt(scene);
      $("snsImgStat").textContent = "画像を生成中…（20〜40秒ほどかかることがあります）";
      const j = await api("image", { prompt, aspect });
      if (j.image) {
        const platform = ($("snsPlatform") && $("snsPlatform").value) || "x";
        const [pw, ph] = IMG_PXSIZE[platform] || IMG_PXSIZE.x;
        const fixed = await coverToSize(j.image, pw, ph);
        await snsShowImg(fixed);
        $("snsImgStat").textContent = "画像を生成しました（文字は上の欄で変更→「文字を反映」。保存して投稿に添付）";
      } else { $("snsImgStat").textContent = "画像を取得できませんでした。"; }
    } catch (e) { $("snsImgStat").textContent = "⚠ " + (e.message || e); }
    finally { if ($("snsImg")) $("snsImg").disabled = false; if ($("snsImgRegen")) $("snsImgRegen").disabled = false; }
  }
  { const b = $("snsImg"); if (b) b.onclick = snsGenImage; }
  { const b = $("snsImgRegen"); if (b) b.onclick = snsGenImage; }

  // モデルが返す画像はアスペクト比指定が効かない事があり、そのままだとサイズ/比率がバラつく。
  // 必ず指定ピクセルへ「cover」で合わせ込み、見た目のサイズ・比率を完全に統一する。
  /* cover配置(枠いっぱいに敷く)の描画矩形を計算する。
     ★縦を削る場合は中央ではなく“上寄り”で切る。生成画像は人物の頭が上の方に来るため、
       中央(0.5)で切ると頭が落ちる。0.28だと上の余白だけが削れて顔が残る。
     ※サムネ合成(composeThumb)と画像の比率合わせ(coverToSize)の両方で使う。
       以前は同じ計算が2か所にあり、片方だけ直して頭切れが残った。 */
  function coverRect(sw, sh, w, h) {
    const ar = sw / sh, tr = w / h;
    if (ar > tr) { const dh = h, dw = h * ar; return { dx: (w - dw) / 2, dy: 0, dw: dw, dh: dh }; }
    const dw = w, dh = w / ar;
    return { dx: 0, dy: (h - dh) * 0.28, dw: dw, dh: dh };
  }
  function coverToSize(dataUrl, w, h) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
          const ctx = cv.getContext("2d");
          const r = coverRect(img.naturalWidth, img.naturalHeight, w, h);
          ctx.drawImage(img, r.dx, r.dy, r.dw, r.dh);
          resolve(cv.toDataURL("image/png"));
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  const IMG_PXSIZE = { x: [1200, 675], instagram: [1080, 1080], facebook: [1200, 630], line: [1080, 1080], note: [1280, 670], tiktok: [1080, 1920], threads: [1080, 1350], youtube: [1080, 1920] };

  // note記事の「## 見出し」ごとに、その節の内容に合う差し込み画像を生成
  function parseSections() {
    const lines = ($("snsBody").value || "").split("\n");
    const secs = []; let cur = null;
    for (const ln of lines) {
      const m = ln.match(/^\s{0,3}#{1,4}\s+(.+?)\s*$/);
      if (m) { if (cur) secs.push(cur); cur = { head: m[1].trim(), body: "" }; }
      else if (cur) cur.body += ln + " ";
      // 見出し前の本文(リード)は無視
    }
    if (cur) secs.push(cur);
    return secs.filter((s) => s.head).slice(0, 6);   // 最大6見出し
  }
  function updateSectBtn() {
    const isNote = ($("snsPlatform") && $("snsPlatform").value) === "note";
    show("snsSectImg", isNote && parseSections().length > 0);
    show("snsThumb", isNote && ($("snsBody").value || "").trim().length > 0);
  }
  { const s = $("snsPlatform"); if (s) s.addEventListener("change", updateSectBtn); }
  { const b = $("snsBody"); if (b) b.addEventListener("input", updateSectBtn); }
  let snsSectStop = false;
  { const b = $("snsSectImg"); if (b) b.onclick = async () => {
      const secs = parseSections();
      if (!secs.length) { toast("『## 見出し』が見つかりません（note記事を作成してください）"); return; }
      const product = ($("snsProduct").value === "pocket") ? "pocket" : "works";
      snsSectStop = false; b.disabled = true;
      $("snsSectWrap").innerHTML = "";
      // ★1記事は同じテイストで統一する。画風・配色・雰囲気を最初に1回だけ決めて、全見出しで共有する。
      const style = pick(IMG_STYLES);
      const palette = pick(IMG_PALETTES);
      let sectionModel = "";   // 最初に成功したモデルをこの記事の全見出しで固定(モデル違いによるタッチの不一致を防ぐ)
      const artDirection = `ART DIRECTION (keep IDENTICAL across every section image of this article, so they read as one consistent set):
- Visual style: ${style}.
- Color palette / mood: ${palette}.
- Same rendering technique, same lighting mood, same level of detail and finish for all images. They must look like one coherent series by the same illustrator, NOT a random mix of styles.`;
      for (let i = 0; i < secs.length; i++) {
        if (snsSectStop) break;
        $("snsSectStat").textContent = "見出し画像を生成中… " + (i + 1) + "/" + secs.length + "（" + secs[i].head + "）";
        // 見出しに合った具体シーンを抽出(精度アップ)。失敗時は見出し＋本文にフォールバック。
        let scene = "";
        try { scene = await sectionToScene(secs[i].head, secs[i].body); } catch (e) {}
        const subject = scene
          ? `DEPICT EXACTLY THIS SCENE (it matches the heading — do not substitute):\n${scene}`
          : `Depict the concrete subject this section is about (the specific part, tool, car system or situation named in the heading "${secs[i].head}"), not a generic scene.`;
        const prompt = `Create a clean, editorial section image for a Japanese note.com article about automotive repair / the AI app "MECHANO-AI" (${product === "pocket" ? "for individual mechanics" : "for repair shops"}).
This image illustrates the section titled: "${secs[i].head}".
${subject}
Aspect ratio: 16:9 horizontal (about 1280x670px), fill the frame. Tasteful, magazine-like.
${artDirection}
Do NOT default to a smartphone/phone screen — include one only if the section is specifically about using a phone/app.
${PEOPLE_RULE}
IMPORTANT: Do NOT render any text, letters, words, logos or watermarks. Image only.`;
        const card = document.createElement("div");
        card.className = "secImgCard";
        card.innerHTML = `<div class="secImgHead">${esc(secs[i].head)}</div><div class="secImgBody muted">生成中…</div>`;
        $("snsSectWrap").appendChild(card);
        try {
          const j = await api("image", { prompt, aspect: "16:9", model: sectionModel });
          if (j.image) {
            if (!sectionModel && j.model) sectionModel = j.model;   // 以降の見出しも同じモデルに固定→タッチが揃う
            const fixed = await coverToSize(j.image, 1280, 670);     // サイズ/比率を必ず統一
            card.querySelector(".secImgBody").innerHTML = "";
            const im = document.createElement("img"); im.className = "snsImg"; im.src = fixed;
            const a = document.createElement("a"); a.className = "btn btn-dark btn-sm"; a.textContent = "⬇ 保存"; a.href = fixed; a.download = "mechanoai-note-" + (i + 1) + ".png";
            card.querySelector(".secImgBody").appendChild(im); card.querySelector(".secImgBody").appendChild(a);
          } else { card.querySelector(".secImgBody").textContent = "取得できませんでした"; }
        } catch (e) { card.querySelector(".secImgBody").textContent = "⚠ " + (e.message || e); }
      }
      $("snsSectStat").textContent = snsSectStop ? "中止しました" : "✓ 見出しごとの画像を生成しました（各画像を保存してnoteの該当箇所に挿入）";
      b.disabled = false;
    };
  }
  // ===== note用サムネ生成 =====
  // 背景はAI生成(文字なし)、タイトル文字はcanvasで崩れず合成。毎回レイアウト/配色を変えて飽きさせない。
  // 色テーマ(キーワード色/締め色)を巡回。[0]=キーワード, [1]=強調(2つ目), [2]=締めバッジ
  const THUMB_THEMES = [
    { kw: "#ff9500", hit: "#ff453a", badge: "#ff9500", ink: "#1a1204" }, // 橙×赤
    { kw: "#00d0ff", hit: "#ffffff", badge: "#00b4d8", ink: "#04222b" }, // シアン×白
    { kw: "#ffd60a", hit: "#ff9f0a", badge: "#ffd60a", ink: "#2a2100" }, // 黄×橙
    { kw: "#34e07a", hit: "#a0f0c0", badge: "#34e07a", ink: "#052014" }, // 緑
    { kw: "#ff5db1", hit: "#ffd0e8", badge: "#ff5db1", ink: "#2a0a1c" }, // マゼンタ
    { kw: "#7aa2ff", hit: "#ffffff", badge: "#5b8cff", ink: "#0a1330" }, // ブルー
  ];
  const THUMB_TONES = ["dark", "steel", "rust", "navy", "teal", "green", "plum", "slate"];
  const THUMB_ALIGN = ["left", "right", "center"];
  const THUMB_ANCHOR = ["top", "middle", "bottom"];
  const THUMB_SCRIM = ["bottom", "right", "left", "diag", "full"];
  const THUMB_ACCENT = ["none", "bar", "underline"];
  const THUMB_FOOT = ["badge", "solid"];
  const THUMB_BRAND = ["TL", "TR", "BL"];
  const TFONT = "'Hiragino Kaku Gothic ProN','Noto Sans JP','Yu Gothic UI',sans-serif";

  // AI(生成)に、note記事から「サムネ用の文字構成」を作らせる。JSONで受け取る。
  async function titleToThumbParts(post) {
    const task = `You design the TEXT for a Japanese note.com article thumbnail. From the article below, produce ONE punchy thumbnail copy set.
Return STRICT JSON only (no code fence), with this shape:
{"eyebrow": "<短い前フリ or 空文字>", "line1": "<見出し1行目>", "line2": "<見出し2行目 or 空文字>", "keyword": "<line1かline2の中の最も強調したい連続した部分文字列>", "hit": "<2つ目に強調したい連続部分文字列 or 空文字>", "footer": "<締めの一言(10〜14字) or 空文字>"}
Rules:
- 見出し(line1/line2)は記事タイトルを土台に、サムネ映えする短く力強い日本語に。1行は最大11〜12文字を目安、全体で2行以内。
- keyword/hit は line1/line2 の中に「そのままの連続文字列で必ず含まれる」こと(色を変える箇所として使う)。含まれない語は禁止。
- eyebrow は引用や煽りの前フリ(なければ空)。footer は記事の主張を一言で。
- 誇張しすぎず、記事の趣旨に忠実に。日本語のみ。
Article:
"""${post.slice(0, 1400)}"""`;
    const j = await api("generate", { role: "marke", task });
    let raw = String(j.text || "").trim().replace(/^```json\s*|\s*```$/g, "");
    let o; try { o = JSON.parse(raw); } catch (e) {
      const m = raw.match(/\{[\s\S]*\}/); o = m ? JSON.parse(m[0]) : {};
    }
    return o || {};
  }
  // 見出し文字列を、keyword/hitで色分けしたセグメント配列に分解
  function splitSeg(line, keyword, hit, theme) {
    if (!line) return null;
    let segs = [{ t: line, c: "#ffffff" }];
    const applyMark = (color, mark) => {
      if (!mark) return;
      const next = [];
      for (const s of segs) {
        if (s.c !== "#ffffff") { next.push(s); continue; }
        let idx = s.t.indexOf(mark);
        if (idx < 0) { next.push(s); continue; }
        if (idx > 0) next.push({ t: s.t.slice(0, idx), c: "#ffffff" });
        next.push({ t: mark, c: color });
        const rest = s.t.slice(idx + mark.length);
        if (rest) next.push({ t: rest, c: "#ffffff" });
      }
      segs = next;
    };
    applyMark(theme.kw, keyword);
    applyMark(theme.hit, hit);
    return segs;
  }
  // AI画像(背景)用プロンプト(文字は描かせない)
  async function thumbBgPrompt(post) {
    let scene = ""; try { scene = await postToScene(post); } catch (e) {}
    const style = pick(IMG_STYLES);
    const subject = scene
      ? `DEPICT EXACTLY THIS SCENE (main subject of the article):\n${scene}`
      : `Depict the concrete subject this Japanese article is about:\n"""${post.slice(0, 800)}"""`;
    return `Create a striking 16:9 background image (about 1280x670px, fill the frame) for a Japanese note.com article thumbnail about automotive repair / the app MECHANO-AI.
${subject}
Visual style: ${style}. Cinematic, bold focal point, strong mood. Leave some visually calmer area (darker or less busy) on one side so large title text can be overlaid there later.
Do NOT default to a smartphone/phone screen unless the article is literally about using a phone/app.
${PEOPLE_RULE}
CRITICAL: Do NOT render ANY text, letters, words, numbers, logos or watermarks anywhere. Image only (text is added afterward).`;
  }
  function tRoundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function tLineW(ctx, line, fs) { ctx.font = "900 " + fs + "px " + TFONT; let w = 0; for (const s of line) w += ctx.measureText(s.t).width; return w; }
  function tFit(ctx, line, fs, maxW) { while (fs > 30 && tLineW(ctx, line, fs) > maxW) fs -= 2; return fs; }
  function tDrawLine(ctx, line, fs, cx, y, align) {
    ctx.font = "900 " + fs + "px " + TFONT; ctx.textBaseline = "alphabetic";
    const total = tLineW(ctx, line, fs);
    let x = align === "left" ? cx : align === "right" ? cx - total : cx - total / 2;
    for (const s of line) {
      ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = fs / 8; ctx.shadowOffsetY = 3;
      ctx.fillStyle = s.c; ctx.fillText(s.t, x, y); x += ctx.measureText(s.t).width;
    }
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    return total;
  }
  function tScrim(ctx, W, H, type) {
    let g;
    if (type === "bottom") { g = ctx.createLinearGradient(0, H * 0.3, 0, H); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.72)"); }
    else if (type === "right") { g = ctx.createLinearGradient(W * 0.35, 0, W, 0); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.7)"); }
    else if (type === "left") { g = ctx.createLinearGradient(0, 0, W * 0.65, 0); g.addColorStop(0, "rgba(0,0,0,0.72)"); g.addColorStop(1, "rgba(0,0,0,0)"); }
    else if (type === "diag") { g = ctx.createLinearGradient(W, 0, 0, H); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.7)"); }
    else { ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(0, 0, W, H); }
    if (g) { ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
    ctx.save(); ctx.globalCompositeOperation = "multiply";
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.9);
    v.addColorStop(0, "rgba(255,255,255,1)"); v.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H); ctx.restore();
  }
  // 背景画像＋文字を1枚のcanvasに合成してdataURLを返す
  function composeThumb(bgImg, parts) {
    const W = 1280, H = 670;
    const theme = pick(THUMB_THEMES);
    const cfg = {
      align: pick(THUMB_ALIGN), anchor: pick(THUMB_ANCHOR), scrim: pick(THUMB_SCRIM),
      accent: pick(THUMB_ACCENT), foot: pick(THUMB_FOOT), brand: pick(THUMB_BRAND),
    };
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    // 背景(cover)。切り抜きの基準はcoverRectに集約(頭切れ防止のため上寄りで切る)
    const bg = coverRect(bgImg.width, bgImg.height, W, H);
    ctx.drawImage(bgImg, bg.dx, bg.dy, bg.dw, bg.dh);
    tScrim(ctx, W, H, cfg.scrim);
    const pad = 64, maxW = W - pad * 2;
    const align = cfg.align, cx = align === "left" ? pad : align === "right" ? W - pad : W / 2;
    const lines = [];
    const s1 = splitSeg(parts.line1, parts.keyword, parts.hit, theme); if (s1) lines.push(s1);
    const s2 = splitSeg(parts.line2, parts.keyword, parts.hit, theme); if (s2) lines.push(s2);
    if (!lines.length) lines.push([{ t: (parts.line1 || "MECHANO-AI"), c: "#fff" }]);
    const bigBase = lines.length > 1 ? 104 : 112, smallBase = 74;
    const fss = lines.map((ln, i) => tFit(ctx, ln, (i === lines.length - 1 ? bigBase : smallBase), maxW));
    const gap = bigBase * 0.14;
    const eyeFs = 32, eyeH = parts.eyebrow ? eyeFs * 1.6 : 0, footH = parts.footer ? 64 : 0;
    let blockH = 0; fss.forEach((f, i) => { blockH += f + (i ? gap : 0); });
    const totalH = eyeH + blockH + footH;
    let top = cfg.anchor === "top" ? pad + 40 : cfg.anchor === "bottom" ? H - pad - totalH + 10 : (H - totalH) / 2 + 10;
    let y = top;
    if (parts.eyebrow) {
      ctx.font = "700 " + eyeFs + "px " + TFONT; ctx.fillStyle = "#dbe4ee";
      ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
      const tw = ctx.measureText(parts.eyebrow).width;
      let ex = align === "left" ? cx : align === "right" ? cx - tw : cx - tw / 2;
      ctx.fillText(parts.eyebrow, ex, y + eyeFs);
      ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; y += eyeH;
    }
    if (cfg.accent === "bar") {
      ctx.fillStyle = theme.kw; const barY = y + fss[0] * 0.15;
      const bx = align === "left" ? cx : align === "right" ? cx - 90 : cx - 45;
      ctx.fillRect(bx, barY, 90, 10); y += 26;
    }
    let ly = y;
    fss.forEach((f, i) => {
      ly += f; tDrawLine(ctx, lines[i], f, cx, ly, align);
      if (cfg.accent === "underline" && i === 0) {
        const w = tLineW(ctx, lines[i], f);
        let ux = align === "left" ? cx : align === "right" ? cx - w : cx - w / 2;
        ctx.fillStyle = theme.kw; ctx.fillRect(ux, ly + 10, w, 8);
      }
      ly += gap;
    });
    y = ly + 8;
    if (parts.footer) {
      ctx.font = "800 26px " + TFONT; const fw = ctx.measureText(parts.footer).width;
      const bw = fw + 34, bh = 48; let fx = align === "left" ? cx : align === "right" ? cx - bw : cx - bw / 2;
      if (cfg.foot === "badge") {
        ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.strokeStyle = theme.badge; ctx.lineWidth = 2;
        tRoundRect(ctx, fx, y, bw, bh, 8); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#fff"; ctx.fillText(parts.footer, fx + 17, y + 32);
      } else {
        ctx.fillStyle = theme.badge; tRoundRect(ctx, fx, y, bw, bh, 8); ctx.fill();
        ctx.fillStyle = theme.ink; ctx.fillText(parts.footer, fx + 17, y + 32);
      }
    }
    // ブランド
    ctx.font = "900 22px " + TFONT; ctx.globalAlpha = 0.88;
    const full = ctx.measureText("MECHANOAI").width;
    const bx = cfg.brand.includes("R") ? W - 40 - full : 40, by = cfg.brand.includes("B") ? H - 34 : 52;
    ctx.fillStyle = "#fff"; ctx.fillText("MECHANO", bx, by);
    const mw = ctx.measureText("MECHANO").width; ctx.fillStyle = theme.kw; ctx.fillText("AI", bx + mw, by);
    ctx.globalAlpha = 1;
    return cv.toDataURL("image/png");
  }
  function loadImg(src) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }); }
  async function genOneThumb() {
    const post = ($("snsBody").value || "").trim();
    if (!post) { toast("先にnote記事を作成してください"); return; }
    const stat = $("snsThumbStat");
    stat.textContent = "サムネの文字を設計中…";
    let parts;
    try { parts = await titleToThumbParts(post); }
    catch (e) { const first = (post.split("\n")[0] || "").replace(/^#+\s*/, "").trim(); parts = { line1: first.slice(0, 12), line2: first.slice(12, 24), keyword: "", hit: "", eyebrow: "", footer: "" }; }
    stat.textContent = "背景画像を生成中…（20〜40秒ほど）";
    let bgImg;
    try {
      const prompt = await thumbBgPrompt(post);
      const j = await api("image", { prompt, aspect: "16:9" });
      if (!j.image) throw new Error("背景画像を取得できませんでした");
      bgImg = await loadImg(j.image);
    } catch (e) { stat.textContent = "⚠ " + (e.message || e); return; }
    stat.textContent = "文字を合成中…";
    let url; try { url = composeThumb(bgImg, parts); } catch (e) { stat.textContent = "⚠ 合成エラー: " + (e.message || e); return; }
    const card = document.createElement("div"); card.className = "secImgCard";
    const im = document.createElement("img"); im.className = "snsImg"; im.src = url;
    const a = document.createElement("a"); a.className = "btn btn-dark btn-sm"; a.textContent = "⬇ 保存"; a.href = url; a.download = "mechanoai-note-thumb.png";
    const re = document.createElement("button"); re.className = "btn btn-ghost btn-sm"; re.textContent = "↻ 別パターン(文字はそのまま)";
    re.onclick = () => { try { im.src = composeThumb(bgImg, parts); } catch (e) {} };
    const body = document.createElement("div"); body.className = "secImgBody";
    body.appendChild(im); body.appendChild(a); body.appendChild(re);
    card.appendChild(body);
    $("snsThumbWrap").insertBefore(card, $("snsThumbWrap").firstChild);
    stat.textContent = "✓ サムネを作りました（別パターンは同じ背景で文字レイアウトだけ変えられます／作り直すと背景も再生成）";
  }
  { const b = $("snsThumb"); if (b) b.onclick = async () => { b.disabled = true; try { await genOneThumb(); } finally { b.disabled = false; } }; }

  // 動画生成用プロンプトを組み立てる。日本語本文は動画AIが読めないため、英語の具体的な映像指示(scene)を受け取って使う。
  function buildVideoPrompt(story) {
    const product = ($("snsProduct").value === "pocket") ? "pocket" : "works";
    const platform = ($("snsPlatform") && $("snsPlatform").value) || "x";
    const vertical = (platform === "tiktok" || platform === "instagram" || platform === "threads" || platform === "youtube");
    const ratio = vertical ? "9:16 vertical (portrait, 1080x1920)" : (platform === "line" ? "1:1 square" : "16:9 horizontal");
    const dur = vertical ? "10-15 seconds (short-form vertical for TikTok/Reels)" : "8-12 seconds";
    return `Create a short, cinematic, STORY-DRIVEN ${vertical ? "VERTICAL " : ""}video for a Japanese automotive-repair audience (${product === "pocket" ? "individual car mechanics" : "auto repair shops / teams"}).
Aspect ratio: ${ratio}. Duration: ${dur}.
This must feel like a tiny FILM with a clear arc — NOT a single static shot with a slow zoom. Tell the story below through distinct beats that build and pay off.

STORYBOARD (film these beats in order, as one continuous, smoothly edited sequence — keep the SAME character, place and lighting continuity across beats):
${story}

DIRECTION:
- Beat 1 = a strong HOOK in the first 1 second (a striking visual or a problem/tension the viewer instantly feels).
- Middle = rising tension / the struggle or turning point — show change, not repetition.
- Final beat = a satisfying PAYOFF or emotional release (relief, a small triumph, a knowing smile, a resolved result). The viewer should FEEL the before→after change.
- Vary the shots across beats (e.g. wide establishing → tight detail of hands/tool → reaction close-up on her face → resolving wide). Use motivated camera movement (push-in, whip/handheld follow, rack focus, match-cut on an action). Realistic garage/workshop atmosphere and authentic lighting throughout.
- Keep it grounded and believable — real mechanic actions, no exaggeration or fantasy.
Do NOT default to showing a smartphone/phone screen — include one only if the storyboard specifically calls for it.
Do NOT render any on-screen text, captions, letters, logos or watermarks (captions are added later in the editor).
${PEOPLE_RULE}
AUDIO — VERY IMPORTANT: NO spoken narration, NO voice-over, NO AI-generated speech, NO talking, NO lip-sync of any language (AI Japanese speech sounds broken and unclear). Audio must be ONLY subtle ambient garage/workshop sounds (tools, air impact wrench, engine) and/or light background music that follows the emotional arc (calmer at tension, lifting at the payoff). Narration and Japanese captions will be added afterward by the creator.`;
  }
  // 投稿文 → 画像/動画AIが理解できる英語の具体的な映像指示に変換(これで内容と映像がズレなくなる)
  // note見出し → その節の内容に合う「具体的な英語シーン」に変換。見出しと画像がズレないようにする。
  async function sectionToScene(head, body) {
    const task = `You turn ONE section of a Japanese note.com article (about automotive repair / the app MECHANO-AI) into ONE concrete VISUAL scene for an AI image generator.
The section heading is: "${head}"
The section text is: """${(body || "").slice(0, 600)}"""
Rules:
- The scene MUST clearly illustrate what THIS heading is literally about (the specific car part, tool, system, symptom, person or situation named). This is the top priority — the image must match the heading at a glance.
- If the heading names a concrete object (e.g. brake pads, tire, battery, timing belt, warning light), show THAT object as the clear focal point.
- Do NOT show a smartphone, phone screen or app UI unless the heading/section is literally about using the app.
- Describe ONLY what the camera SEES, in ENGLISH: physical subject, setting, action, framing. 2-4 short sentences. No on-screen text, no metaphors, no marketing copy.
- The MAIN person (if any) must be described as FEMALE; supporting people may be male or female.
Output: the English scene description only.`;
    const j = await api("generate", { role: "marke", task });
    return String(j.text || "").trim();
  }
  async function postToScene(post) {
    const task = `You turn a Japanese social-media post (or short-video script) into ONE concrete VISUAL scene description for an AI image/video generator.
Rules:
- Pick the SINGLE most eye-catching, representative moment of the post. If it is a joke/gag, pick the FUNNY hook moment (the unexpected visual), NOT a product shot.
- If the post is a multi-scene script (has 「◆シーン」「映像:」etc.), choose the hook/opening scene, not the last CTA/product scene.
- Do NOT show a smartphone, phone screen, or app UI unless the whole post is literally a demo of using the app. Avoid a generic 'dirty mechanic bent over an engine' cliché unless that is truly the point.
- Describe ONLY what the camera SEES in ENGLISH: physical subject, setting, action, framing, camera movement. 3-5 short sentences. No dialogue, no on-screen text, no metaphors, no marketing.
- The MAIN person (protagonist / central figure) must be described as FEMALE (a woman / a girl); if only one person appears, she is a woman. Other supporting people may be male or female as in the post.
Japanese post:
"""${post.slice(0, 1500)}"""
Output: the English scene description only.`;
    const j = await api("generate", { role: "marke", task });
    return String(j.text || "").trim();
  }
  // 投稿文 → ストーリー性のある短編映像の絵コンテ(英語・複数ビート)に変換。単調な1カットを避ける。
  async function postToStoryboard(post) {
    const product = ($("snsProduct").value === "pocket") ? "pocket" : "works";
    const task = `You are a short-film director. Turn the Japanese post below into a compact but EMOTIONALLY COMPELLING storyboard for an 8-12 second AI-generated video (text-to-video).
Audience: Japanese automotive repair (${product === "pocket" ? "individual mechanics" : "repair shops / teams"}). The video promotes the message of the post, but must work as a tiny STORY, not an ad.
Write a THREE-BEAT arc that has a clear before → after change:
- BEAT 1 (Hook, ~0-2s): a striking opening image or an instantly-felt problem/tension that stops the scroll.
- BEAT 2 (Turn, ~2-6s): the struggle, decision, or turning point — something visibly CHANGES (an action, a discovery, a shift in her expression).
- BEAT 3 (Payoff, ~6-10s): a satisfying emotional release or result — relief, a small win, a confident/knowing smile, a resolved outcome. The viewer must feel the change.
Rules:
- Keep ONE consistent protagonist (FEMALE — a woman mechanic, real and capable, work clothes, not sexualized), one location, continuous lighting.
- Ground it in real mechanic reality that matches the post's topic (the specific part/tool/situation). No fantasy, no exaggeration.
- Do NOT show a smartphone/phone/app screen unless the post is literally about using the app.
- For EACH beat give: what the camera SEES + the shot type & camera movement + her emotion. English only. No dialogue, no on-screen text, no metaphors, no marketing copy.
- Output format EXACTLY:
BEAT 1: <...>
BEAT 2: <...>
BEAT 3: <...>
Japanese post:
"""${post.slice(0, 1500)}"""`;
    const j = await api("generate", { role: "marke", task, creative: true });
    return String(j.text || "").trim();
  }
  { const b = $("snsVideo"); if (b) b.onclick = async () => {
      const post = ($("snsBody").value || "").trim();
      if (!post) { toast("先に投稿文を作成してください"); return; }
      b.disabled = true; const old = b.textContent; b.textContent = "🎬 ストーリー構成中…";
      try {
        const story = await postToStoryboard(post);
        copy(buildVideoPrompt(story));
        window.open("https://grok.com/imagine", "_blank", "noopener");
        toast("動画プロンプトをコピー。Grok Imagineに貼り付けて『動画』で生成してください");
      } catch (e) { toast("⚠ " + (e.message || e)); }
      finally { b.disabled = false; b.textContent = old; }
    };
  }
  // Grok Imagine(X Premium)で画像/動画を作る: 最適プロンプトをコピーして grok.com/imagine を開く
  { const b = $("snsGrok"); if (b) b.onclick = async () => {
      const post = ($("snsBody").value || "").trim();
      if (!post) { toast("先に投稿文を作成してください"); return; }
      b.disabled = true; const old = b.textContent; b.textContent = "✨ ストーリー構成中…";
      try {
        const story = await postToStoryboard(post);
        copy(buildVideoPrompt(story));
        window.open("https://grok.com/imagine", "_blank", "noopener");
        toast("ストーリー動画プロンプトをコピー。Grokに貼り付けて『動画』で生成してください（静止画が欲しい時は『🖼 画像を生成』を使用）");
      } catch (e) { toast("⚠ " + (e.message || e)); }
      finally { b.disabled = false; b.textContent = old; }
    };
  }

  // ===== YouTube Shorts動画(β): Gemini Omni Flashで音声付き・ストーリー動画を作る =====
  // 実費が発生する(概算¥450/30秒・720p)。1本=最初のビート+Extend2回=計3回のサーバー呼び出し。
  // previous_interaction_idで同じ女性整備士・同じ場面を保ったまま延長するので、クリップ結合が不要。
  const SHORTS_AUDIO = "AUDIO: generate a fitting native audio track — ambient workshop/garage sound matched to the action, plus mood music that follows the emotional arc. A short natural Japanese line of dialogue is OK ONLY if it fits naturally and briefly (one short sentence, lips synced) — otherwise no dialogue, just sound and music. No on-screen captions/text.";
  // 投稿文からOmni Flash向けの3ビート日本語シナリオ(セリフ可・音声指示つき)を作る。
  async function postToOmniBeats(post) {
    const task = `You are directing a 30-second Japanese vertical short film (YouTube Shorts) for an automotive-repair audience, promoting the message of the post below AS A STORY, not an ad.
Write a THREE-BEAT arc with a clear before→after change:
- BEAT1 (~0-10s, opening): establish a striking hook/problem/tension. Multiple short shots are fine (the video model likes to cut between shots on its own).
- BEAT2 (~10-20s, turn): the struggle/decision/turning point — something visibly changes.
- BEAT3 (~20-30s, payoff): a satisfying emotional release/result — the viewer must feel the change.
Rules:
- ONE consistent protagonist: a FEMALE mechanic (real, capable, work clothes, not sexualized). Same location and lighting across all 3 beats.
- Ground it in the post's real topic (the specific part/tool/situation). No fantasy, no exaggeration.
- Do NOT show a smartphone/app screen unless the post is literally about using the app.
- A brief natural Japanese line of dialogue is allowed in at most ONE beat if it truly fits (write the exact Japanese line); otherwise no dialogue.
- Describe camera shot/movement + what happens + emotion, in ENGLISH (except an actual Japanese dialogue line, quoted as-is).
- Output format EXACTLY:
BEAT1: <...>
BEAT2: <...>
BEAT3: <...>
Japanese post:
"""${post.slice(0, 1500)}"""`;
    const j = await api("generate", { role: "marke", task, creative: true });
    const t = String(j.text || "").trim();
    const g = (n) => { const m = t.match(new RegExp("BEAT" + n + ":\\s*([\\s\\S]*?)(?:BEAT" + (n + 1) + ":|$)")); return m ? m[1].trim() : ""; };
    return { b1: g(1), b2: g(2), b3: g(3) };
  }
  function shortsCostNote(resolution, seconds) {
    const perSec = resolution === "1080p" ? 0.10 : 0.10; // Omni Flash 標準は720p/1080pともに実勢約$0.10/秒
    const usd = (perSec * seconds).toFixed(2);
    return "実費 約$" + usd + "（¥" + Math.round(usd * 155) + "前後・有料Geminiキーに課金）";
  }
  { const b = $("snsShorts"); if (b) b.onclick = async () => {
      const post = ($("snsBody").value || "").trim();
      if (!post) { toast("先に投稿文を作成してください"); return; }
      if (!confirm("YouTube Shorts動画(約30秒・音声付き)をGemini Omni Flashで生成します。\n" + shortsCostNote("720p", 30) + "\n生成には数分かかります。実行しますか？")) return;
      b.disabled = true; const old = b.textContent;
      const stat = $("snsShortsStat"); const wrap = $("snsShortsWrap"); wrap.innerHTML = "";
      const addClip = (label, videoUrl, note) => {
        const card = document.createElement("div"); card.className = "secImgCard";
        card.innerHTML = `<div class="secImgHead">${esc(label)}</div>`;
        const body = document.createElement("div"); body.className = "secImgBody";
        const v = document.createElement("video"); v.className = "snsImg"; v.src = videoUrl; v.controls = true; v.playsInline = true;
        const a = document.createElement("a"); a.className = "btn btn-dark btn-sm"; a.textContent = "⬇ 保存"; a.href = videoUrl; a.download = "mechanoai-shorts-" + label.replace(/\s/g, "") + ".mp4";
        body.appendChild(v); body.appendChild(a);
        if (note) { const n = document.createElement("div"); n.className = "muted"; n.style.fontSize = "12px"; n.textContent = note; body.appendChild(n); }
        card.appendChild(body); wrap.appendChild(card);
      };
      try {
        stat.textContent = "🎬 3ビートのシナリオを構成中…";
        const beats = await postToOmniBeats(post);
        let previousId = "";
        const runs = [
          { label: "パート1(導入)", build: () => `Vertical short film opening shot (about 8-10 seconds). ${beats.b1 || "A female mechanic faces a striking problem in her workshop."}\n${PEOPLE_RULE}\n${SHORTS_AUDIO}` },
          { label: "パート2(転換)", build: () => `Extend this video. Continue the SAME woman, SAME location, continuous lighting. ${beats.b2 || "The situation visibly turns/changes."}\n${SHORTS_AUDIO}` },
          { label: "パート3(結末)", build: () => `Extend this video. Continue the SAME woman, SAME location, continuous lighting. This is the FINAL payoff beat — bring the story to a satisfying, resolved conclusion. ${beats.b3 || "A satisfying emotional payoff/result."}\n${SHORTS_AUDIO}` },
        ];
        let lastVideo = "";
        for (let i = 0; i < runs.length; i++) {
          stat.textContent = "🎬 " + runs[i].label + "を生成中…（1〜3分ほどかかります）";
          const prompt = runs[i].build();
          const j = await api("shortsClip", { prompt, previousId, aspectRatio: "9:16", resolution: "720p" });
          if (!j.video) throw new Error("動画を取得できませんでした");
          lastVideo = j.video; previousId = j.interactionId || previousId;
          addClip(runs[i].label, j.video, i === runs.length - 1 ? "★合計約30秒まで積み重ねた結果のはずです。再生して繋がりを確認してください。" : "");
        }
        stat.textContent = "✓ 生成完了。各パートを再生して確認し、最後のパートが最終版になっているはずです（前パートも保険として残しています）。" + shortsCostNote("720p", 30);
      } catch (e) { stat.textContent = "⚠ " + (e.message || e) + "（途中まで生成できた分は上に残っています）"; }
      finally { b.disabled = false; b.textContent = old; }
    };
  }

  // 1週間分(7本)を一括生成。毎回スタイル/切り口を変えて、日替わり投稿ネタをまとめて用意。
  let snsWeekStop = false;
  { const b = $("btnSnsWeekStop"); if (b) b.onclick = () => { snsWeekStop = true; toast("中止しました"); }; }
  { const b = $("btnSnsWeek"); if (b) b.onclick = async () => {
      const product = ($("snsProduct").value === "pocket") ? "pocket" : "works";
      const g = snsCfg();
      const theme = ($("snsTheme").value || "").trim();
      const styles = ["honne", "casual", "tips", "drama", "buzz", "balanced", "gag"];   // 7本ぶん・多様に
      const weekTopics = [...SNS_TOPICS].sort(() => Math.random() - 0.5);   // 題材をシャッフルし各曜日で別ネタに
      snsWeekStop = false;
      show("btnSnsWeekStop", true); $("btnSnsWeek").disabled = true; $("btnSns").disabled = true;
      $("snsWeek").innerHTML = ""; $("snsStat").textContent = "1週間分を生成中… 0/7";
      for (let i = 0; i < 7; i++) {
        if (snsWeekStop) break;
        const style = styles[i];
        const len = (style === "drama") ? "long" : (Math.random() < 0.5 ? "short" : "medium");
        const lenTxt = SNS_LEN[len] || SNS_LEN.medium;
        const topicHint = theme ? "" : "／今回の題材=「" + (weekTopics[i] || pick(SNS_TOPICS)) + "」(この題材を軸に。他の曜日と必ず別ネタ)";
        const seed = "今回の切り口(毎回変える): フック=「" + pick(SNS_HOOKS) + "」／形式=「" + pick(SNS_FORMATS) + "」" + topicHint + "。";
        const task = `${g.name} に投稿する、メカノAI（${product === "pocket" ? "整備士個人向けアプリ Pocket" : "整備工場・法人向け Works"}）の投稿を1本、そのまま投稿できる完成形で作成してください。
・${SNS_STYLE[style] || SNS_STYLE.balanced}
・${seed}
・${g.guide}
・${theme ? "テーマ: " + theme : "テーマはおまかせ（整備の現場に響く切り口を1つ選ぶ）"}
・他の曜日の投稿と被らない新鮮な切り口に。誇張・虚偽はしない。文量は ${lenTxt}（${g.limit}字以内）。本文だけ。
${SNS_HUMAN}`;
        let text = "";
        try { const j = await api("generate", { role: "marke", task, product, creative: true }); text = String(j.text || "").trim(); }
        catch (e) { text = "⚠️ " + (e.message || e); }
        const dayN = i + 1;
        const div = document.createElement("div");
        div.className = "crcard";
        div.innerHTML = `<div class="crhead"><span class="crco">Day ${dayN}・${esc({ honne: "本音", casual: "カジュアル", tips: "豆知識", drama: "会話劇", buzz: "バズ", balanced: "標準" }[style] || style)}</span><span class="muted">${text.length}字</span></div>
          <div class="crtext"></div>
          <div class="crbtns"><button class="btn btn-ghost btn-sm wkcopy">コピー</button></div>`;
        div.querySelector(".crtext").textContent = text;
        div.querySelector(".wkcopy").onclick = () => copy(text);
        $("snsWeek").appendChild(div);
        $("snsStat").textContent = "1週間分を生成中… " + dayN + "/7";
      }
      $("snsStat").textContent = snsWeekStop ? "中止しました" : "✓ 1週間分（7本）を生成しました";
      show("btnSnsWeekStop", false); $("btnSnsWeek").disabled = false; $("btnSns").disabled = false;
    };
  }
  // 整備士の投稿を探すXライブ検索ショートカット(見つけたら下の欄に貼って返信を作成)
  (function renderXSearch() {
    const box = $("xsearch"); if (!box) return;
    const qs = [["整備士 あるある", "整備士 あるある"], ["車検 高い", "車検 高い"], ["整備工場 人手不足", "整備工場 人手不足"], ["自動車整備 疲れた", "自動車整備 疲れた"], ["ブレーキパッド 交換", "ブレーキパッド 交換"], ["メカニック", "メカニック"]];
    box.innerHTML = '<span class="muted" style="margin-right:6px">Xで探す:</span>' +
      qs.map(([label, q]) => `<a class="xchip" target="_blank" rel="noopener" href="https://x.com/search?q=${encodeURIComponent(q)}&f=live">🔎 ${esc(label)}</a>`).join("");
  })();

  // 他人のツイートへの返信コメント生成(共感→自然にメカノAI導線)
  function repCount() { const n = ($("repBody").value || "").length; if ($("repCount")) $("repCount").textContent = "　" + n + "字" + (n > 80 ? " ⚠長い（もっと短く）" : ""); }
  async function repGen() {
    const src = ($("repSrc").value || "").trim();
    if (!src) { toast("相手のツイート本文を貼り付けてください"); $("repSrc").focus(); return; }
    const product = ($("repProduct").value === "pocket") ? "pocket" : "works";
    const tone = { soft: "やわらかく共感する", frank: "現場の同僚のようにフランクに(ただし失礼にはならない)", polite: "丁寧に" }[$("repTone").value] || "やわらかく共感する";
    const push = ($("repPush") && $("repPush").value) || "subtle";
    const pushLine = push === "clear"
      ? "会話が合えば最後にひとことだけ『AIに聞くと早いよ』程度で軽く匂わせてOK(商品名の宣伝連呼はしない)。無理なら入れない。"
      : "宣伝・商品名・導線は入れない。ただの共感・相槌の返信でよい。";
    const task = `次のツイートに、整備士仲間としてサラッと返す「返信リプライ」を1つ。
【相手のツイート】
${src}

・とにかく短くあっさり。目安15〜50字、基本1文（長くても2文）。SNSの軽いリプの温度。
・${tone === "丁寧に" ? "軽い敬語" : "タメ口〜フランク"}で、相手に「わかる」と同調する相槌が主役。会話のキャッチボールの一言。
・${pushLine}
・きれいにまとめない。言いさし・体言止め・ぼやき・ツッコミでよい。説明しない。
・絵文字は基本なし(あっても1個)。ハッシュタグ・リンク・署名は絶対つけない。「返信案:」等の前置きも不要、本文だけ。
・お手本の短さ・温度感(コピペ禁止): 「それなーw まじで半年後に戻ってくるやつ」／「わかる。P0300で小一時間コースだったよな昔は」／「"車検通る"と"あと2年安心"は別物なんよな…」／「電動化、便利なのは分かるけど整備側は地獄よな」
${SNS_HUMAN}`;
    $("repStat").textContent = "生成中…"; $("btnRep").disabled = true;
    try {
      const j = await api("generate", { role: "marke", task, product, creative: true });
      $("repBody").value = String(j.text || "").trim();
      show("repOutWrap", true); repCount();
      $("repStat").textContent = "";
    } catch (e) { $("repStat").textContent = "⚠ " + (e.message || e); }
    finally { $("btnRep").disabled = false; }
  }
  { const b = $("btnRep"); if (b) b.onclick = repGen; }
  { const b = $("repRegen"); if (b) b.onclick = repGen; }
  { const b = $("repCopy"); if (b) b.onclick = () => copy($("repBody").value || ""); }
  { const b = $("repBody"); if (b) b.addEventListener("input", repCount); }

  // SNSのDM文生成(関係づくり主体・売り込みすぎない)
  function dmCount() { const n = ($("dmBody").value || "").length; if ($("dmCount")) $("dmCount").textContent = "　" + n + "字" + (n > 180 ? " ⚠長い" : ""); }
  async function dmGen() {
    const product = ($("dmProduct").value === "pocket") ? "pocket" : "works";
    const src = ($("dmSrc").value || "").trim();
    const goal = ($("dmGoal") && $("dmGoal").value) || "relate";
    const tone = ($("dmTone") && $("dmTone").value) === "polite" ? "軽い敬語で丁寧に" : "タメ口〜フランクに(失礼にはならない)";
    const goalLine = {
      relate: "目的は関係づくり。あいさつ＋相手の投稿への共感だけでよい。宣伝・商品名は出さない。",
      thanks: "フォロー/いいねのお礼を、さらっと一言。宣伝は入れない。",
      value: "見返りを求めず役立つ一言(現場のちょっとしたコツ等)を渡す。宣伝は入れない。",
      intro: "会話のきっかけを作ったうえで、最後に一度だけ『もし興味あれば』程度でメカノAIに軽く触れてよい(押し売り厳禁・リンクは貼らない)。",
    }[goal] || "関係づくり中心。";
    const task = `Xで整備士アカウントへ送る「DM(ダイレクトメッセージ)」を1通。
${src ? "【相手の情報/直近の投稿】\n" + src + "\n" : ""}
・${tone}。まず相手個人に向けた一言(投稿への共感など)から入り、テンプレ一斉送信っぽさを消す。
・${goalLine}
・短く。目安40〜120字。1〜3文。長い自己紹介・会社説明・URL・署名・ハッシュタグは入れない。
・いきなり営業しない。相手が「感じいいな」と思って返信したくなる温度。
・本文だけ出力(「DM案:」等の前置き不要)。
${SNS_HUMAN}`;
    $("dmStat").textContent = "生成中…"; $("btnDm").disabled = true;
    try {
      const j = await api("generate", { role: "marke", task, product, creative: true });
      $("dmBody").value = String(j.text || "").trim();
      show("dmOutWrap", true); dmCount();
      $("dmStat").textContent = "";
    } catch (e) { $("dmStat").textContent = "⚠ " + (e.message || e); }
    finally { $("btnDm").disabled = false; }
  }
  { const b = $("btnDm"); if (b) b.onclick = dmGen; }
  { const b = $("dmRegen"); if (b) b.onclick = dmGen; }
  { const b = $("dmCopy"); if (b) b.onclick = () => copy($("dmBody").value || ""); }
  { const b = $("dmBody"); if (b) b.addEventListener("input", dmCount); }

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
      if ($("faxEnabled")) $("faxEnabled").checked = !!c.faxEnabled;
      if ($("faxPerDay")) $("faxPerDay").value = c.faxPerDay || 3;
      if ($("faxToAddr")) $("faxToAddr").value = c.faxToAddr || "";
      if ($("faxStat")) {
        $("faxStat").textContent = !c.faxToAddr
          ? "⚠ 送信用アドレス未設定のため送信されません（業者の管理画面で発行して入力）"
          : (c.faxLastRun ? "前回: " + fmtDate(c.faxLastRun) + " / " + (c.faxLastSent || 0) + "件送信" : "");
      }
    } catch (e) { if ($("dripStat")) $("dripStat").textContent = e.message; }
  }
  const _sf = $("btnSaveFax");
  if (_sf) _sf.onclick = async () => {
    _sf.disabled = true;
    try {
      await api("setConfig", { config: {
        faxEnabled: $("faxEnabled").checked,
        faxPerDay: parseInt($("faxPerDay").value, 10) || 3,
        faxToAddr: ($("faxToAddr").value || "").trim(),
      } });
      toast("FAX自動送信の設定を保存しました");
      loadDripConfig();
    } catch (e) { toast(e.message); }
    finally { _sf.disabled = false; }
  };
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
