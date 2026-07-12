/* 参加申請があったら、その会社の代表管理者(admin)と運営(super)にプッシュ通知を送る。
   users ドキュメントが「承認待ち(active=false, rejected!=true)」に“なった瞬間”だけ送信。
   デプロイ: firebase deploy --only functions   (Blazeプランが必要・無料枠内で運用可) */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

exports.notifyJoin = functions.firestore
  .document("users/{uid}")
  .onWrite(async (change) => {
    const after = change.after.exists ? change.after.data() : null;
    const before = change.before.exists ? change.before.data() : null;
    if (!after) return null;

    const isPendingNow = after.active === false && after.rejected !== true;
    const wasPending = !!before && before.active === false && before.rejected !== true;
    if (!isPendingNow || wasPending) return null;   // 新たに承認待ちになった時だけ

    const tid = after.tenantId;
    if (!tid) return null;

    const db = admin.firestore();
    const [admins, supers] = await Promise.all([
      db.collection("users").where("tenantId", "==", tid).where("role", "==", "admin").get(),
      db.collection("users").where("role", "==", "super").get(),
    ]);

    const tokens = [];
    const collect = (snap) => snap.forEach((d) => (d.data().fcmTokens || []).forEach((t) => tokens.push(t)));
    collect(admins);
    collect(supers);
    const uniq = [...new Set(tokens)].filter(Boolean);
    if (!uniq.length) return null;

    const name = after.name || after.email || "新しい申請者";
    const res = await admin.messaging().sendEachForMulticast({
      tokens: uniq,
      notification: {
        title: "メカノAI 参加申請",
        body: name + " さんが参加申請しました。アプリの会社管理から承認してください。",
      },
      webpush: { fcmOptions: { link: "/" } },
    });

    // 無効になったトークンを掃除(任意)
    const stale = [];
    res.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") stale.push(uniq[i]);
      }
    });
    if (stale.length) {
      const all = await db.collection("users").get();
      const batch = db.batch();
      all.forEach((d) => {
        const toks = d.data().fcmTokens || [];
        if (toks.some((t) => stale.includes(t))) {
          batch.update(d.ref, { fcmTokens: toks.filter((t) => !stale.includes(t)) });
        }
      });
      await batch.commit();
    }
    return null;
  });

/* =========================================================================
   AIプロキシ + Stripe自動有効化 (プロキシ方式: 鍵はサーバー内のみ。契約中の店舗だけ利用可)
   設定: functions/.env に鍵を記入する(.env.example を参照。.envはgit管理しない)。
   デプロイ: firebase deploy --only functions
   ========================================================================= */
const REGION = "asia-northeast1";
// 秘密情報は functions/.env から process.env に読み込まれる(Firebaseが自動ロード)
const cfg = () => ({
  gemini: { key: process.env.GEMINI_KEY },
  vision: { key: process.env.VISION_KEY },
  stripe: {
    secret: process.env.STRIPE_SECRET,
    wh: process.env.STRIPE_WH,
    price_month: process.env.STRIPE_PRICE_MONTH,
    price_year: process.env.STRIPE_PRICE_YEAR,
  },
  app: { url: process.env.APP_URL },
});

/* ---- 通常HTTP(onRequest)方式。callable(onCall)はMessagingのSW取得を巻き込み、
       GitHub Pagesのサブパス配信で404になるため、fetch+IDトークン方式にする。 ---- */
function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
async function uidFromReq(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  try { return (await admin.auth().verifyIdToken(m[1])).uid; } catch (e) { return null; }
}
// 有効アカウント＋契約中の店舗か検証。NGなら {err:[status,msg]} を返す。
async function checkPaid(uid) {
  if (!uid) return { err: [401, "ログインが必要です。"] };
  const db = admin.firestore();
  const u = (await db.collection("users").doc(uid).get()).data();
  if (!u || u.active !== true || !u.tenantId) return { err: [403, "有効なアカウントではありません。"] };
  const t = (await db.collection("tenants").doc(u.tenantId).get()).data() || {};
  const paid = (t.plan === "active" || t.plan === "trial");
  const notExpired = !t.paidUntil || Number(t.paidUntil) >= Date.now();
  if (!(paid && notExpired)) return { err: [402, "店舗の契約が有効ではありません。"] };
  return { u: u, t: t, tid: u.tenantId };
}

/* メカ君(Gemini)プロキシ: POST {prompt, mode:"flash"|"pro", media:[{mimeType,data}]} → {text, truncated} */
exports.mecha = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const g = await checkPaid(await uidFromReq(req));
  if (g.err) return res.status(g.err[0]).json({ error: g.err[1] });
  const key = cfg().gemini && cfg().gemini.key;
  if (!key) return res.status(500).json({ error: "サーバーのGeminiキーが未設定です。" });
  const data = req.body || {};
  const mode = data.mode === "pro" ? "pro" : "flash";
  const models = mode === "pro" ? ["gemini-2.5-pro", "gemini-2.5-flash"] : ["gemini-2.5-flash", "gemini-2.0-flash-lite"];
  const parts = [{ text: String(data.prompt || "") }];
  (data.media || []).forEach((m) => { if (m && m.data) parts.push({ inlineData: { mimeType: m.mimeType || "image/jpeg", data: m.data } }); });
  let lastErr = "";
  for (const model of models) {
    const gc = { temperature: 0.2, maxOutputTokens: 16384 };
    if (model.indexOf("gemini-2.5") === 0) gc.thinkingConfig = { thinkingBudget: mode === "pro" ? -1 : 0 };
    let r;
    try {
      r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: gc }),
      });
    } catch (e) { lastErr = "network"; continue; }
    if (r.status === 404 || r.status === 429) { lastErr = "model " + model + " " + r.status; continue; }
    if (!r.ok) return res.status(502).json({ error: "AI応答エラー (" + r.status + ")" });
    const j = await r.json();
    const cand = j.candidates && j.candidates[0];
    const text = ((cand && cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    if (!text) { lastErr = "empty"; continue; }
    return res.json({ text: text, truncated: cand.finishReason === "MAX_TOKENS" });
  }
  return res.status(502).json({ error: "AIから回答が得られませんでした (" + lastErr + ")" });
});

/* Cloud Vision OCR プロキシ: POST {imageBase64} → {text} */
exports.visionOcr = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const g = await checkPaid(await uidFromReq(req));
  if (g.err) return res.status(g.err[0]).json({ error: g.err[1] });
  const key = cfg().vision && cfg().vision.key;
  if (!key) return res.status(500).json({ error: "サーバーのVisionキーが未設定です。" });
  const r = await fetch("https://vision.googleapis.com/v1/images:annotate?key=" + encodeURIComponent(key), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ image: { content: (req.body && req.body.imageBase64) || "" }, features: [{ type: "TEXT_DETECTION" }] }] }),
  });
  if (!r.ok) return res.status(502).json({ error: "OCRエラー (" + r.status + ")" });
  const j = await r.json();
  const text = (((j.responses || [])[0] || {}).fullTextAnnotation || {}).text || "";
  return res.json({ text: text });
});

/* Stripe Checkout セッション作成: POST {plan:"monthly"|"yearly", email} → {url}。代表管理者のみ。 */
exports.createCheckout = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "ログインが必要です。" });
  const db = admin.firestore();
  const u = (await db.collection("users").doc(uid).get()).data();
  if (!u || !u.tenantId) return res.status(403).json({ error: "所属がありません。" });
  if (!(u.role === "admin" || u.role === "super")) return res.status(403).json({ error: "代表管理者のみ手続きできます。" });
  const data = req.body || {};
  const stripe = require("stripe")(cfg().stripe.secret);
  const priceId = (data.plan === "yearly") ? cfg().stripe.price_year : cfg().stripe.price_month;
  if (!priceId) return res.status(500).json({ error: "価格(Price)が未設定です。" });
  const appUrl = (cfg().app && cfg().app.url) || "https://tomo-design.github.io/shakensho-scan/";
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: appUrl + "?paid=1",
      cancel_url: appUrl,
      customer_email: data.email || u.email,
      client_reference_id: u.tenantId,
      metadata: { tenantId: u.tenantId },
      subscription_data: { metadata: { tenantId: u.tenantId } },
      invoice_creation: { enabled: true },
    });
    return res.json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: "決済ページの作成に失敗: " + (e.message || e) });
  }
});

/* Stripe Webhook: 支払い成功で店舗プランを自動ON / 解約・失効で停止。
   Stripeダッシュボードで stripeWebhook のURLをエンドポイント登録し、署名シークレットを stripe.wh に設定する。 */
exports.stripeWebhook = functions.region(REGION).https.onRequest(async (req, res) => {
  const stripe = require("stripe")(cfg().stripe.secret);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], cfg().stripe.wh);
  } catch (e) { console.error("署名検証失敗", e.message); return res.status(400).send("bad signature"); }
  const db = admin.firestore();
  const setPlan = async (tid, active, untilMs) => {
    if (!tid) return;
    await db.collection("tenants").doc(tid).set({ plan: active ? "active" : "suspended", paidUntil: untilMs || null }, { merge: true });
  };
  try {
    const o = event.data.object;
    if (event.type === "checkout.session.completed") {
      const tid = (o.metadata && o.metadata.tenantId) || o.client_reference_id;
      let until = null;
      if (o.subscription) { try { const sub = await stripe.subscriptions.retrieve(o.subscription); until = sub.current_period_end * 1000; } catch (e) {} }
      await setPlan(tid, true, until);
    } else if (event.type === "invoice.paid") {
      const tid = o.subscription_details && o.subscription_details.metadata && o.subscription_details.metadata.tenantId;
      let until = null; try { until = o.lines.data[0].period.end * 1000; } catch (e) {}
      if (tid) await setPlan(tid, true, until);
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const tid = o.metadata && o.metadata.tenantId;
      const active = o.status === "active" || o.status === "trialing";
      await setPlan(tid, active, o.current_period_end ? o.current_period_end * 1000 : null);
    }
  } catch (e) { console.error("webhook処理エラー", e); }
  return res.json({ received: true });
});
