/* 参加申請があったら、その会社の代表管理者(admin)と運営(super)にプッシュ通知を送る。
   users ドキュメントが「承認待ち(active=false, rejected!=true)」に“なった瞬間”だけ送信。
   デプロイ: firebase deploy --only functions   (Blazeプランが必要・無料枠内で運用可) */
const functions = require("firebase-functions/v1");   // v6でも従来(v1)記法をそのまま使う
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
  gemini: { key: process.env.GEMINI_KEY },              // 無料キー(1本目・後方互換)
  // 無料キーのプール: GEMINI_KEY, GEMINI_KEY_2..5 を順番に使い、枠切れ(429)なら次のキーへ。実質 無料枠×本数。
  geminiFree: [process.env.GEMINI_KEY, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3, process.env.GEMINI_KEY_4, process.env.GEMINI_KEY_5].filter(Boolean),
  geminiPaid: { key: process.env.GEMINI_KEY_PAID },     // 有料キー(全無料キーが枠切れした時の受け皿。任意)
  vision: { key: process.env.VISION_KEY },
  cse: { key: process.env.CSE_KEY, cx: process.env.CSE_CX },
  stripe: {
    secret: process.env.STRIPE_SECRET,
    wh: process.env.STRIPE_WH,
    price_month: process.env.STRIPE_PRICE_MONTH,   // 旧単一プラン(後方互換)
    price_year: process.env.STRIPE_PRICE_YEAR,
    // 3プラン×月/年の price ID
    prices: {
      na: { month: process.env.STRIPE_PRICE_NA_MONTH, year: process.env.STRIPE_PRICE_NA_YEAR },
      turbo: { month: process.env.STRIPE_PRICE_TURBO_MONTH, year: process.env.STRIPE_PRICE_TURBO_YEAR },
      twinturbo: { month: process.env.STRIPE_PRICE_TWIN_MONTH, year: process.env.STRIPE_PRICE_TWIN_YEAR },
    },
  },
  app: { url: process.env.APP_URL },
  // 営業ファネルのメール送信(SendGrid)。key=APIキー / from=認証済み送信元 / notify=運営通知先
  sendgrid: {
    key: process.env.SENDGRID_API_KEY,
    from: process.env.SENDGRID_FROM,
    fromName: process.env.SENDGRID_FROM_NAME || "メカノAI",
    notify: process.env.INQUIRY_NOTIFY || "cablueie.123@gmail.com",
    // 返信の受け口(SendGrid Inbound Parse用サブドメインのアドレス)。未設定ならnotify(Gmail)へ返信が届く従来動作。
    reply: process.env.REPLY_INBOUND || "",
  },
});
// 送信メールの Reply-To。Inbound Parse用アドレスがあればそちら(=AI自動返信の受け口)、無ければ運営Gmail。
const replyAddr = () => cfg().sendgrid.reply || cfg().sendgrid.notify;
/* SendGrid でメール送信(依存ライブラリ不要・HTTP API直叩き)。成功でtrue。 */
async function sendMail(to, subject, text, replyTo) {
  const sg = cfg().sendgrid;
  if (!sg.key || !sg.from) { console.error("SendGrid未設定のため送信スキップ"); return false; }
  try {
    const body = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: sg.from, name: sg.fromName },
      subject: subject,
      content: [{ type: "text/plain", value: text }],
    };
    if (replyTo) body.reply_to = { email: replyTo };
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": "Bearer " + sg.key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) { console.error("SendGrid送信失敗", r.status, await r.text().catch(() => "")); return false; }
    return true;
  } catch (e) { console.error("SendGrid例外", e); return false; }
}

/* ---- ③ 受信メール自動返信 用ヘルパー ---- */
// SendGrid Inbound Parse の multipart/form-data を解析(添付は無視)。
function parseInbound(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try { bb = require("busboy")({ headers: req.headers }); }
    catch (e) { return reject(e); }
    const fields = {};
    bb.on("field", (name, val) => { fields[name] = val; });
    bb.on("file", (name, stream) => { stream.resume(); }); // 添付は捨てる
    bb.on("close", () => resolve(fields));
    bb.on("finish", () => resolve(fields));
    bb.on("error", reject);
    if (req.rawBody) bb.end(req.rawBody); else req.pipe(bb);
  });
}
// SendGrid Inbound Parse は各フィールドの文字コードを charsets(JSON)で通知する。
// busboyはUTF-8前提で復号するため、ISO-2022-JP等の本文が化ける。charsetsを見て正しく再変換する。
// (ISO-2022-JPは7bitなのでlatin1でバイト列を復元→TextDecoderで変換。Shift_JIS/EUC-JPにも対応)
function decodeInbound(fields, key) {
  let v = fields[key];
  if (v == null) return "";
  v = String(v);
  let cs = {};
  try { cs = JSON.parse(fields.charsets || "{}"); } catch (e) { /* 無ければUTF-8扱い */ }
  const c = String(cs[key] || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!c || c === "utf8" || c === "utf-8" || c === "usascii" || c === "us-ascii" || c === "ascii") return v;
  try { return new TextDecoder(c).decode(Buffer.from(v, "latin1")); }
  catch (e) { return v; } // 未知のコードはそのまま
}
// "山田太郎 <info@ex.com>" 等から素のメールアドレスを取り出す。
function extractEmail(s) {
  const m = String(s || "").match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  return m ? m[0].toLowerCase() : "";
}
// 返信本文から引用(過去のやりとり)を粗く落とし、相手が今回書いた部分だけ残す。
function stripQuoted(t) {
  if (!t) return "";
  const out = [];
  for (const ln of String(t).split(/\r?\n/)) {
    if (/^\s*>/.test(ln)) break;
    if (/^\s*-{2,}\s*(Original Message|元のメッセージ|返信元メッセージ)/i.test(ln)) break;
    if (/^\s*On .+wrote:\s*$/.test(ln)) break;
    if (/^\s*\d{4}[年/-].*(書きました|wrote)\s*[:：]?\s*$/.test(ln)) break;
    if (/^\s*From:\s.+@/.test(ln)) break;
    out.push(ln);
  }
  return out.join("\n").trim();
}
// 運営(super)へ通知メール(Gmail)を送る。
async function notifySuperMail(subject, text) {
  const to = cfg().sendgrid.notify;
  if (!to) return;
  await sendMail(to, subject, text + "\n\n" + MAIL_SIGN, cfg().sendgrid.from).catch(() => {});
}
// 運営(super)へプッシュ通知。
async function pushSuper(title, body) {
  try {
    const supers = await admin.firestore().collection("users").where("role", "==", "super").get();
    const tokens = [];
    supers.forEach((u) => (u.data().fcmTokens || []).forEach((t) => t && tokens.push(t)));
    const uq = [...new Set(tokens)];
    if (uq.length) await admin.messaging().sendEachForMulticast({ tokens: uq, notification: { title, body }, webpush: { fcmOptions: { link: "/sales.html" } } });
  } catch (e) { console.error("pushSuper失敗", e); }
}
// メール共通署名(プレーンテキスト・実データ固定)
const MAIL_SIGN = "――――――――――――\n" +
  "メカノAI（MECHANO-AI）\n" +
  "Cablueie（カブリエ）　担当：中江\n" +
  "〒894-0062 鹿児島県奄美市名瀬有屋町36-2\n" +
  "TEL：080-3692-0101　Mail：cablueie.123@gmail.com\n" +
  "詳細・お申し込み：https://mechanoai-cablueie.com/biz.html\n" +
  "――――――――――――";
// price ID → プランコード(webフックで購入プランを店舗に反映するため)
function tierFromPriceId(pid) {
  if (!pid) return "";
  const P = cfg().stripe.prices;
  for (const code of ["na", "turbo", "twinturbo"]) {
    if (P[code] && (P[code].month === pid || P[code].year === pid)) return code;
  }
  return "";
}

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
// テナント(店舗)ごとの利用上限。.envで上書き可(未設定はこの既定値)。赤字防止の安全弁。
const usageLimits = () => ({
  // 契約店舗は実質無制限。以下はバグ暴走(無限ループ等)だけを止める高めの安全弁。.envで調整可。
  dayMecha: +(process.env.LIMIT_DAY_MECHA || 3000),
  monthMecha: +(process.env.LIMIT_MONTH_MECHA || 50000),
  dayVision: +(process.env.LIMIT_DAY_VISION || 400),
  monthVision: +(process.env.LIMIT_MONTH_VISION || 6000),
  dayImage: +(process.env.LIMIT_DAY_IMAGE || 100),
  monthImage: +(process.env.LIMIT_MONTH_IMAGE || 2000),
});
// 日次・月次カウントを記録しつつ上限判定。ok=falseなら上限超過。運営(super)は対象外。
// 記録先: usage/{tenantId} (Firestoreコンソールで各店舗の利用回数を確認できる=モニタリング)
async function enforceUsage(tid, kind, role) {
  if (role === "super") return { ok: true };   // 運営アカウントは制限しない
  const db = admin.firestore();
  const ref = db.collection("usage").doc(tid);
  const jst = new Date(Date.now() + 9 * 3600 * 1000);   // 日本時間で日次リセット
  const day = jst.toISOString().slice(0, 10);           // YYYY-MM-DD
  const month = day.slice(0, 7);                         // YYYY-MM
  const L = usageLimits();
  const dKey = kind === "vision" ? "dVision" : kind === "image" ? "dImage" : "dMecha";
  const mKey = kind === "vision" ? "mVision" : kind === "image" ? "mImage" : "mMecha";
  const dLimit = kind === "vision" ? L.dayVision : kind === "image" ? L.dayImage : L.dayMecha;
  const mLimit = kind === "vision" ? L.monthVision : kind === "image" ? L.monthImage : L.monthMecha;
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const u = snap.exists ? snap.data() : {};
      if (u.day !== day) { u.day = day; u.dMecha = 0; u.dVision = 0; }        // 日が変われば日次リセット
      if (u.month !== month) { u.month = month; u.mMecha = 0; u.mVision = 0; } // 月が変われば月次リセット
      if ((u[dKey] || 0) >= dLimit) return { ok: false, scope: "day", limit: dLimit };
      if ((u[mKey] || 0) >= mLimit) return { ok: false, scope: "month", limit: mLimit };
      u[dKey] = (u[dKey] || 0) + 1;
      u[mKey] = (u[mKey] || 0) + 1;
      u.updatedAt = Date.now();
      tx.set(ref, u, { merge: true });
      return { ok: true, used: u[dKey], dLimit };
    });
  } catch (e) { console.error("usage計測エラー", e); return { ok: true }; }   // 計測失敗時はブロックしない(サービス優先)
}
function usageErrMsg(cap) {
  const scope = cap.scope === "day" ? "本日" : "今月";
  return scope + "のAI利用上限（" + cap.limit + "回）に達しました。時間をおいて再度お試しください（上限は運営で調整できます）。";
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

/* 指定キーでGeminiを呼ぶ。成功={text,truncated} / 枠切れ={failed,quota:true} / その他失敗={failed}/{httpErr} */
async function callGeminiModels(key, models, parts, mode, search, maxTokens, thinkingBudget) {
  let lastErr = "", quota = false;
  for (const model of models) {
    const gc = { temperature: 0.2, maxOutputTokens: maxTokens || 16384 };
    // 思考トークン制御(2.5系・3系・-latest)。flash=512(3系は0が400・128だと空応答になり得るため余裕を持たせる)、pro=-1(動的)。2.0系は非対応。
    // thinkingBudget が数値で渡された場合はそれを使い、思考を短く切り上げて待機時間を短縮する。
    if (/gemini-(2\.5|3(\.\d+)?)[-.]/.test(model) || model.indexOf("-latest") >= 0) {
      const tb = (typeof thinkingBudget === "number") ? thinkingBudget : (mode === "pro" ? -1 : 512);
      gc.thinkingConfig = { thinkingBudget: tb };
    }
    const reqBody = { contents: [{ parts }], generationConfig: gc };
    if (search) reqBody.tools = [{ google_search: {} }];   // 検索グラウンディング(指定時のみ)
    // 過負荷(503/500)は一時的。1回だけ短く待って再試行(=タイムアウト防止のため試行回数を絞る)。
    // 429(枠切れ)は待たずに即failで返す → 呼び出し側が「次の無料キー」へ素早く切り替える。
    let r = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody),
        });
      } catch (e) { lastErr = "network"; r = null; break; }
      if ((r.status === 503 || r.status === 500) && attempt < 1) { lastErr = "busy " + r.status; await new Promise((rs) => setTimeout(rs, 400)); continue; }
      break;
    }
    if (!r) continue;                                  // network例外は次のモデルへ
    if (r.status === 429) { quota = true; lastErr = "quota 429"; continue; }   // 枠切れ → 次モデル/次キーへ
    if (r.status === 404 || r.status === 503 || r.status === 500) { lastErr = "model " + model + " " + r.status; continue; }
    if (!r.ok) { lastErr = "http " + r.status; continue; }   // 400等も次モデルへ(1モデルの不調で全体を落とさない)
    const j = await r.json();
    const cand = j.candidates && j.candidates[0];
    const text = ((cand && cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
    if (!text) { lastErr = "empty"; continue; }
    return { text: text, truncated: cand.finishReason === "MAX_TOKENS", model: model };
  }
  return { failed: true, quota: quota, lastErr: lastErr };
}
/* 思考上限(thinkingBudget)を安全な範囲に丸める。未指定/不正は undefined(=既定挙動)。 */
function clampThinking(v) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return undefined;
  if (n < 0) return -1;                 // -1=動的(無制限)
  return Math.min(Math.max(n, 0), 24576);
}
/* ストリーミング版: GeminiのstreamGenerateContent(SSE)を受け、本文deltaだけをresへ逐次書き出す。
   実テキストが出た時に初めてSSEヘッダを送る(=それまでは別モデル/別キーへフォールバック可能)。
   成功(=本文を1文字でも流した)={started:true,truncated} / 失敗(未送信)={failed,quota,lastErr}。 */
async function callGeminiStream(key, models, parts, mode, search, maxTokens, thinkingBudget, res) {
  let lastErr = "", quota = false;
  for (const model of models) {
    const gc = { temperature: 0.2, maxOutputTokens: maxTokens || 16384 };
    if (/gemini-(2\.5|3(\.\d+)?)[-.]/.test(model) || model.indexOf("-latest") >= 0) {
      gc.thinkingConfig = { thinkingBudget: (typeof thinkingBudget === "number") ? thinkingBudget : (mode === "pro" ? -1 : 512) };
    }
    const reqBody = { contents: [{ parts }], generationConfig: gc };
    if (search) reqBody.tools = [{ google_search: {} }];
    let r = null;
    try {
      r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":streamGenerateContent?alt=sse&key=" + encodeURIComponent(key), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody),
      });
    } catch (e) { lastErr = "network"; continue; }
    if (r.status === 429) { quota = true; lastErr = "quota 429"; continue; }
    if (r.status === 404 || r.status === 503 || r.status === 500) { lastErr = "model " + model + " " + r.status; continue; }
    if (!r.ok || !r.body) { lastErr = "http " + r.status; continue; }
    let full = "", truncated = false, headed = false, buf = "";
    const usedModel = model;
    const dec = new TextDecoder();
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (line.indexOf("data:") !== 0) continue;
          const js = line.slice(5).trim(); if (!js || js === "[DONE]") continue;
          try {
            const j = JSON.parse(js);
            const cand = j.candidates && j.candidates[0];
            const piece = ((cand && cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
            if (piece) {
              full += piece;
              if (!headed) { sendSseHeaders(res); headed = true; }
              res.write("data: " + JSON.stringify({ t: piece }) + "\n\n");
            }
            if (cand && cand.finishReason === "MAX_TOKENS") truncated = true;
          } catch (e) {}
        }
      }
    } catch (e) { lastErr = "stream " + (e && e.message); if (headed) return { started: true, truncated: truncated, model: usedModel }; continue; }
    if (full) return { started: true, truncated: truncated, model: usedModel };
    lastErr = "empty"; continue;   // 本文ゼロ(ヘッダ未送信) → 次モデル/次キーへ
  }
  return { failed: true, quota: quota, lastErr: lastErr };
}
function sendSseHeaders(res) {
  if (res.headersSent) return;
  res.set("Content-Type", "text/event-stream; charset=utf-8");
  res.set("Cache-Control", "no-cache, no-transform");
  res.set("Connection", "keep-alive");
  res.set("X-Accel-Buffering", "no");   // プロキシのバッファリングを抑止(可能な環境で)
  if (res.flushHeaders) res.flushHeaders();
}
/* 有料キーで実行した回数を usage/{tid} に記録(管理画面で目視できるように) */
async function bumpPaidUsage(tid) {
  try {
    const db = admin.firestore();
    const ref = db.collection("usage").doc(tid);
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const day = jst.toISOString().slice(0, 10), month = day.slice(0, 7);
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref); const u = s.exists ? s.data() : {};
      if (u.pDay !== day) { u.pDay = day; u.dPaid = 0; }
      if (u.pMonth !== month) { u.pMonth = month; u.mPaid = 0; }
      u.dPaid = (u.dPaid || 0) + 1; u.mPaid = (u.mPaid || 0) + 1;
      u.lastPaidAt = Date.now();
      tx.set(ref, u, { merge: true });
    });
  } catch (e) {}
}
/* 今月の有料(Pro＋検索)実行回数を返す。赤字防止の月次上限判定に使う。 */
async function paidCountThisMonth(tid) {
  try {
    const u = (await admin.firestore().collection("usage").doc(tid).get()).data() || {};
    const month = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
    return (u.pMonth === month) ? (u.mPaid || 0) : 0;
  } catch (e) { return 0; }
}
/* 無料枠を使い切った事実を記録(管理画面で目視できるように) */
async function markFreeExhausted(tid) {
  try {
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const day = jst.toISOString().slice(0, 10);
    await admin.firestore().collection("usage").doc(tid).set({ freeExhaustedDay: day, freeExhaustedAt: Date.now() }, { merge: true });
  } catch (e) {}
}
/* 無料枠が復活(無料キーで成功)したら「使い切り」フラグを消す。以前の使い切り記録が残っている時だけ書き込む。 */
async function clearFreeExhausted(tid) {
  try {
    const db = admin.firestore();
    const ref = db.collection("usage").doc(tid);
    const cur = (await ref.get()).data() || {};
    if (!cur.freeExhaustedDay) return;   // 元々立っていなければ何もしない(無駄書き込み回避)
    await ref.set({ freeExhaustedDay: admin.firestore.FieldValue.delete(), freeExhaustedAt: admin.firestore.FieldValue.delete() }, { merge: true });
  } catch (e) {}
}

/* 常に最新のGeminiを使う: モデル一覧から「数字付きの最新flash/pro」を動的に選ぶ(新モデル発表に自動追従)。
   1時間キャッシュ。取得失敗時は -latest 別名にフォールバック。 */
let _modelCache = { at: 0, flash: "", pro: "" };
async function latestModels(key) {
  const now = Date.now();
  if (_modelCache.flash && (now - _modelCache.at) < 3600e3) return _modelCache;
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(key) + "&pageSize=200");
    const j = await r.json();
    const names = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name || "").replace("models/", ""));
    const pickHighest = (re) => {
      let best = "", bestV = -1;
      for (const n of names) { const m = n.match(re); if (m) { const v = parseFloat(m[1]); if (v > bestV) { bestV = v; best = n; } } }
      return best;
    };
    // 例: gemini-3.6-flash を選ぶ。lite/image/tts/preview等は除外。pro は preview も対象(3系proはpreviewのみ)。
    const flash = pickHighest(/^gemini-(\d+(?:\.\d+)?)-flash$/);
    const pro = pickHighest(/^gemini-(\d+(?:\.\d+)?)-pro(?:-preview)?$/);
    if (flash || pro) _modelCache = { at: now, flash: flash, pro: pro };
  } catch (e) {}
  return _modelCache;
}
const uniq = (a) => a.filter((x, i) => x && a.indexOf(x) === i);

/* 店舗のAIプラン設定を返す。aiPlan: "na"|"turbo"|"twinturbo"(旧 aiPaidFallback も互換解釈)。
   searchCap: 0=検索なし / 500=月上限 / -1=無制限。 seats: 0=人数制限なし / N=検索を使える人数(月内)。 */
function planConfig(t) {
  t = t || {};
  let plan = t.aiPlan;
  if (!plan) plan = (t.aiPaidFallback === true) ? "twinturbo" : "na";   // 旧データ互換(有料ON=無制限扱い)
  if (plan === "turbo") return { plan: "turbo", searchCap: 500, seats: 0 };
  if (plan === "twinturbo") return { plan: "twinturbo", searchCap: -1, seats: Math.max(1, +(t.searchSeats || 3)) };
  return { plan: "na", searchCap: 0, seats: 0 };
}
function jstMonth() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7); }
/* ツインターボの席(=月内に検索を使える人数)を確保。空席があればuidを登録してtrue。満席で未登録ならfalse。 */
async function claimSeat(tid, uid, seats) {
  if (!uid) return true;
  try {
    const db = admin.firestore(); const ref = db.collection("usage").doc(tid);
    return await db.runTransaction(async (tx) => {
      const s = await tx.get(ref); const u = s.exists ? s.data() : {};
      const month = jstMonth();
      const list = (u.seatMonth === month) ? (u.seatUids || []).slice() : [];
      if (list.indexOf(uid) >= 0) return true;   // 既に席あり
      if (list.length >= seats) return false;    // 満席
      list.push(uid);
      tx.set(ref, { seatMonth: month, seatUids: list }, { merge: true });
      return true;
    });
  } catch (e) { return true; }   // 計測失敗時はサービス優先で許可
}

/* メカ君(Gemini)プロキシ: POST {prompt, mode:"flash"|"pro", media, search} → {text, truncated, tier, freeExhausted}
   検索(裏取り)はプラン(searchCap/seats)の範囲でのみ有料キーで実行。範囲外は検索なしFlashに自動フォールバック。 */
exports.mecha = functions.runWith({ timeoutSeconds: 120, memory: "512MB" }).region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const uidReq = await uidFromReq(req);
  const g = await checkPaid(uidReq);
  if (g.err) return res.status(g.err[0]).json({ error: g.err[1] });
  const freeKeys = cfg().geminiFree || [];               // 無料キーのプール(GEMINI_KEY, _2.._5)
  const paidKey = cfg().geminiPaid && cfg().geminiPaid.key;
  if (!freeKeys.length) return res.status(500).json({ error: "サーバーのGeminiキーが未設定です。" });
  const cap = await enforceUsage(g.tid, "mecha", g.u && g.u.role);   // 店舗ごとの回数上限(赤字防止の最終弁)
  if (!cap.ok) return res.status(429).json({ error: usageErrMsg(cap) });
  const data = req.body || {};
  const pc = planConfig(g.t);   // プラン: na(検索なし)/turbo(月500)/twinturbo(無制限・席数)
  // ★プラン準拠でPro可否を上限管理: NAはProを使わせず標準Flash。ターボ/ツインターボはPro(写真・動画も)。
  const mode = (data.mode === "pro" && pc.plan !== "na") ? "pro" : "flash";
  // 先頭のGoogle公式『-latest』別名は常に最新版を指す(新バージョンへ自動移行)。未対応時は固定版へフォールバック。
  // モデルは2つまで(先頭=最新の-latest / 予備1つ)。試行回数を絞ってタイムアウトを防ぐ。
  // 常に最新を先頭に。動的に取得した最新flash/pro(例 gemini-3.6-flash)→ -latest別名 → 安定版の順。
  const latest = await latestModels(freeKeys[0]);
  const models = mode === "pro"
    ? uniq([latest.pro, "gemini-pro-latest", latest.flash, "gemini-flash-latest"])
    : uniq([latest.flash, "gemini-flash-latest", "gemini-2.0-flash"]);   // 2.0はthinking非対応の最終受け皿
  const parts = [{ text: String(data.prompt || "") }];
  (data.media || []).forEach((m) => { if (m && m.data) parts.push({ inlineData: { mimeType: m.mimeType || "image/jpeg", data: m.data } }); });
  const maxTokens = Math.min(Math.max(parseInt(data.maxTokens, 10) || 0, 0), 32768);   // 諸元など長いJSONの途中切れ防止(上限32k)
  const tb = clampThinking(data.thinkingBudget);   // 思考上限(指定時のみ。待機短縮)

  const paidCapable = pc.plan !== "na" && !!paidKey;   // ターボ/ツインターボ=有料キー利用可(Pro・検索)
  const freeModels = uniq([latest.flash, "gemini-flash-latest", "gemini-2.0-flash"]);   // 無料キーはFlashのみ(Proは無料枠429)

  // 検索(裏取り)を実際に使えるか: 検索対応プラン && 今月上限内 && 席内。不可なら検索なしに落として必ず回答を返す。
  let effSearch = false;
  if (data.search && paidCapable && pc.searchCap !== 0) {
    const overCap = pc.searchCap > 0 && (await paidCountThisMonth(g.tid)) >= pc.searchCap;   // ターボ=月500回
    // ツインターボ=検索席を持つメンバーのみ(管理者が指名)。seatMembersにuidがあれば可。
    const seatOk = pc.seats > 0 ? (Array.isArray(g.t.seatMembers) && g.t.seatMembers.indexOf(uidReq) >= 0) : true;
    effSearch = !overCap && seatOk;
  }
  // 契約店舗(ターボ以上)は常に有料キーで実行する。無料キーは共有プールで429待ち→数十秒の遅延が出るため、
  // 検索なしのFlash諸元でも有料キーを使うことで安定して数秒で返す(検索課金はeffSearch時のみ計上)。na=常に無料Flash。
  const usePaid = paidCapable;

  let out = { failed: true, quota: true }, tier = "free", freeExhausted = false;

  // ① 有料キー(検索付き or Pro)。検索は無料枠では通らないので契約店舗のみここを通る。
  if (usePaid) {
    out = await callGeminiModels(paidKey, models, parts, mode, effSearch, maxTokens, tb);
    if (out.httpErr) return res.status(502).json({ error: "AI応答エラー (" + out.httpErr + ")" });
    if (!out.failed) { tier = "paid"; if (effSearch) await bumpPaidUsage(g.tid); }   // 課金カウントは検索のみ
    // 失敗しても下の無料Flashにフォールバックして回答を返す(out.failedのまま)。
  }

  // ② 無料キーでFlash(通常/検索不可/①失敗フォールバック): 全キー試して枠を使い切る。
  if (out.failed) {
    out = { failed: true, quota: true };
    const start = Math.floor(Math.random() * freeKeys.length);
    for (let i = 0; i < freeKeys.length; i++) {
      const key = freeKeys[(start + i) % freeKeys.length];
      out = await callGeminiModels(key, freeModels, parts, "flash", false, maxTokens, tb);
      if (out.httpErr) return res.status(502).json({ error: "AI応答エラー (" + out.httpErr + ")" });
      if (!out.failed) break;
      if (!out.quota) break;
    }
    if (out.failed && out.quota) {
      freeExhausted = true; await markFreeExhausted(g.tid);
      if (paidKey) { out = await callGeminiModels(paidKey, freeModels, parts, "flash", false, maxTokens, tb); if (!out.failed) tier = "paid"; }
      if (out.failed) return res.status(429).json({ error: "ただいまAIが混み合っています。時間をおいて再度お試しください。", freeExhausted: true });
    } else if (out.failed) {
      return res.status(502).json({ error: "AIから回答が得られませんでした (" + out.lastErr + ")" });
    }
  }
  if (tier === "free") clearFreeExhausted(g.tid);
  return res.json({ text: out.text, truncated: out.truncated, tier: tier, freeExhausted: freeExhausted, model: out.model || "" });
});

/* メカ君プロキシ(ストリーミング版): mechaと同じ判定で、本文を SSE(data:{t:"..."}) で逐次返す。
   最後に data:{done:true,truncated,tier} を送って終了。実テキストが出るまではヘッダを送らないので、
   失敗時は従来通りJSONエラーを返せる。ストリーム未対応の呼び出し側はmechaを使うこと。 */
exports.mechaStream = functions.runWith({ timeoutSeconds: 300, memory: "512MB" }).region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const uidReq = await uidFromReq(req);
  const g = await checkPaid(uidReq);
  if (g.err) return res.status(g.err[0]).json({ error: g.err[1] });
  const freeKeys = cfg().geminiFree || [];
  const paidKey = cfg().geminiPaid && cfg().geminiPaid.key;
  if (!freeKeys.length) return res.status(500).json({ error: "サーバーのGeminiキーが未設定です。" });
  const cap = await enforceUsage(g.tid, "mecha", g.u && g.u.role);
  if (!cap.ok) return res.status(429).json({ error: usageErrMsg(cap) });
  const data = req.body || {};
  const pc = planConfig(g.t);
  // ★プラン準拠でPro可否を上限管理: NAはProを使わせず標準Flash。ターボ/ツインターボはPro(写真・動画も)。
  const mode = (data.mode === "pro" && pc.plan !== "na") ? "pro" : "flash";
  const latest = await latestModels(freeKeys[0]);
  const models = mode === "pro"
    ? uniq([latest.pro, "gemini-pro-latest", latest.flash, "gemini-flash-latest"])
    : uniq([latest.flash, "gemini-flash-latest", "gemini-2.0-flash"]);
  const parts = [{ text: String(data.prompt || "") }];
  (data.media || []).forEach((m) => { if (m && m.data) parts.push({ inlineData: { mimeType: m.mimeType || "image/jpeg", data: m.data } }); });
  const maxTokens = Math.min(Math.max(parseInt(data.maxTokens, 10) || 0, 0), 32768);
  const tb = clampThinking(data.thinkingBudget);
  const paidCapable = pc.plan !== "na" && !!paidKey;
  const freeModels = uniq([latest.flash, "gemini-flash-latest", "gemini-2.0-flash"]);
  let effSearch = false;
  if (data.search && paidCapable && pc.searchCap !== 0) {
    const overCap = pc.searchCap > 0 && (await paidCountThisMonth(g.tid)) >= pc.searchCap;
    const seatOk = pc.seats > 0 ? (Array.isArray(g.t.seatMembers) && g.t.seatMembers.indexOf(uidReq) >= 0) : true;
    effSearch = !overCap && seatOk;
  }
  const usePaid = paidCapable;
  const finish = (truncated, tier, model) => { if (res.headersSent) { res.write("data: " + JSON.stringify({ done: true, truncated: !!truncated, tier: tier, model: model || "" }) + "\n\n"); res.end(); } };

  // ① 有料キー(Pro/検索)
  if (usePaid) {
    const out = await callGeminiStream(paidKey, models, parts, mode, effSearch, maxTokens, tb, res);
    if (out.started) { if (effSearch) await bumpPaidUsage(g.tid); finish(out.truncated, "paid", out.model); return; }
  }
  // ② 無料キー(Flash) → ①失敗のフォールバック
  const start = Math.floor(Math.random() * freeKeys.length);
  let quotaAll = true;
  for (let i = 0; i < freeKeys.length; i++) {
    const key = freeKeys[(start + i) % freeKeys.length];
    const out = await callGeminiStream(key, freeModels, parts, "flash", false, maxTokens, tb, res);
    if (out.started) { clearFreeExhausted(g.tid); finish(out.truncated, "free", out.model); return; }
    if (!out.quota) { quotaAll = false; break; }
  }
  if (quotaAll) {
    await markFreeExhausted(g.tid);
    if (paidKey) { const out = await callGeminiStream(paidKey, freeModels, parts, "flash", false, maxTokens, tb, res); if (out.started) { finish(out.truncated, "paid", out.model); return; } }
  }
  // 一度も本文を送れていない(ヘッダ未送信) → JSONエラーで返す
  if (!res.headersSent) return res.status(429).json({ error: "ただいまAIが混み合っています。時間をおいて再度お試しください。" });
  res.end();
});

/* Cloud Vision OCR プロキシ: POST {imageBase64} → {text} */
exports.visionOcr = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const g = await checkPaid(await uidFromReq(req));
  if (g.err) return res.status(g.err[0]).json({ error: g.err[1] });
  const key = cfg().vision && cfg().vision.key;
  if (!key) return res.status(500).json({ error: "サーバーのVisionキーが未設定です。" });
  const cap = await enforceUsage(g.tid, "vision", g.u && g.u.role);
  if (!cap.ok) return res.status(429).json({ error: usageErrMsg(cap) });
  const r = await fetch("https://vision.googleapis.com/v1/images:annotate?key=" + encodeURIComponent(key), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ image: { content: (req.body && req.body.imageBase64) || "" }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }], imageContext: { languageHints: ["ja", "en"] } }] }),
  });
  if (!r.ok) return res.status(502).json({ error: "OCRエラー (" + r.status + ")" });
  const j = await r.json();
  const r0 = (j.responses || [])[0] || {};
  const text = (r0.fullTextAnnotation && r0.fullTextAnnotation.text) || ((r0.textAnnotations || [])[0] || {}).description || "";
  return res.json({ text: text });
});


/* 個人版(Google Play)サブスクの購入検証・承認。
   POST {token, sku} → Google Play Developer API で定期購入の状態を確認し、
   未承認なら acknowledge する。ログイン不要(有効な purchaseToken が本人性の担保)。
   ※事前準備: (1)functions のサービスアカウントを Play Console の
     「API アクセス」でユーザー招待し「財務データ/注文の閲覧」権限付与、
     (2)Google Play Android Developer API を GCP で有効化。 */
exports.verifyPlaySub = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const PKG = "com.cablueie.mechanoai";
  const token = (req.body && req.body.token) || "";
  const sku = (req.body && req.body.sku) || "personal_monthly";
  if (!token) return res.status(400).json({ error: "purchaseToken がありません。" });
  try {
    const { google } = require("googleapis");   // 遅延require(他関数のコールドスタートに影響させない)
    const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/androidpublisher"] });
    const ap = google.androidpublisher({ version: "v3", auth });
    // subscriptionsv2: token だけで購入全体の状態を取得できる
    const r = await ap.purchases.subscriptionsv2.get({ packageName: PKG, token });
    const d = r.data || {};
    const state = d.subscriptionState || "";
    const active = state === "SUBSCRIPTION_STATE_ACTIVE" || state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD";
    // 未承認なら acknowledge(3日以内に承認しないと自動返金される)
    if (d.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING") {
      try { await ap.purchases.subscriptions.acknowledge({ packageName: PKG, subscriptionId: sku, token, requestBody: {} }); } catch (e) {}
    }
    const expiry = (d.lineItems && d.lineItems[0] && d.lineItems[0].expiryTime) || null;
    return res.json({ ok: active, state: state, expiry: expiry });
  } catch (e) {
    return res.status(500).json({ error: "検証エラー: " + String((e && e.message) || e) });
  }
});

/* 部品の実写画像検索(Google Custom Search): POST {q, num} → {items:[{thumb,link,ctx,title}]}。
   契約中の店舗は自前キー不要で使える(運営のキーをサーバー側で使用)。 */
exports.imageSearch = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const g = await checkPaid(await uidFromReq(req));
  if (g.err) return res.status(g.err[0]).json({ error: g.err[1] });
  const c = cfg().cse || {};
  if (!c.key || !c.cx) return res.status(500).json({ error: "サーバーの画像検索キーが未設定です。" });
  const cap = await enforceUsage(g.tid, "image", g.u && g.u.role);
  if (!cap.ok) return res.status(429).json({ error: usageErrMsg(cap) });
  const q = String((req.body && req.body.q) || "").slice(0, 200);
  if (!q) return res.json({ items: [] });
  const num = Math.min(Math.max(parseInt((req.body && req.body.num) || 3, 10) || 3, 1), 10);
  const url = "https://www.googleapis.com/customsearch/v1?searchType=image&safe=active&num=" + num +
    "&key=" + encodeURIComponent(c.key) + "&cx=" + encodeURIComponent(c.cx) + "&q=" + encodeURIComponent(q);
  let r;
  try { r = await fetch(url); } catch (e) { return res.status(502).json({ error: "画像検索に接続できませんでした。" }); }
  if (!r.ok) {
    let reason = "";
    try { const ej = await r.json(); reason = (ej.error && ej.error.message) || ""; } catch (_) {}
    if (r.status === 429 || /quota|rate limit/i.test(reason)) return res.status(429).json({ error: "本日の画像検索の上限に達しました。明日また使えます。" });
    return res.status(502).json({ error: "画像検索エラー (" + r.status + ")" });
  }
  const j = await r.json();
  const items = (j.items || []).map((it) => ({
    thumb: (it.image && it.image.thumbnailLink) || it.link,
    link: it.link,
    ctx: (it.image && it.image.contextLink) || it.link,
    title: it.title || "",
  })).filter((x) => x.thumb);
  return res.json({ items: items });
});

/* メンバーの一時パスワード発行: POST {targetUid} → {password}。
   代表管理者(admin)は自店舗のメンバーのみ、運営(super)は全員に対して実行可。
   メール配信に依存せず、その場でパスワードを再設定して管理者に知らせる(＝忘れた+メール来ない を解決)。 */
exports.setMemberPassword = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "ログインが必要です。" });
  const db = admin.firestore();
  const me = (await db.collection("users").doc(uid).get()).data();
  if (!me) return res.status(403).json({ error: "有効なアカウントではありません。" });
  const isSuper = me.role === "super";
  const isAdmin = me.role === "admin";
  // 運営(super)は active フラグに関わらず許可。代表管理者は active===true 必須。
  if (!isSuper && me.active !== true) return res.status(403).json({ error: "有効なアカウントではありません。" });
  if (!isSuper && !isAdmin) return res.status(403).json({ error: "代表管理者または運営のみ実行できます。" });
  const targetUid = String((req.body && req.body.targetUid) || "");
  if (!targetUid) return res.status(400).json({ error: "対象ユーザーが指定されていません。" });
  if (targetUid === uid) return res.status(400).json({ error: "自分自身には発行できません。ログイン中の方はアプリの「パスワードを忘れた」をご利用ください。" });
  const target = (await db.collection("users").doc(targetUid).get()).data();
  if (!target) return res.status(404).json({ error: "対象ユーザーが見つかりません。" });
  // 代表管理者は「同じ店舗のメンバー」に限定。運営(super)への操作は不可(運営は対象外)。
  if (!isSuper) {
    if (target.tenantId !== me.tenantId) return res.status(403).json({ error: "自分の店舗のメンバーのみ対象にできます。" });
    if (target.role === "super") return res.status(403).json({ error: "この相手には実行できません。" });
  }
  // 読みやすい一時パスワードを生成(紛らわしい文字は除外)
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let pw = "";
  for (let i = 0; i < 10; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  try {
    await admin.auth().updateUser(targetUid, { password: pw });
    await db.collection("users").doc(targetUid).set({ pwResetAt: Date.now(), pwResetBy: uid }, { merge: true });
    return res.json({ password: pw });
  } catch (e) {
    return res.status(500).json({ error: "パスワード発行に失敗しました: " + (e.message || String(e)) });
  }
});

/* 本人のメールアドレス変更: POST {email} → Auth と users/{uid}.email を同時更新。
   認証済み本人のみ(uidはIDトークンから)。Firestoreルール上クライアントからは email を書けないためサーバーで実施。 */
exports.changeMyEmail = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "ログインが必要です。" });
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "メールアドレスの形式が正しくありません。" });
  try {
    await admin.auth().updateUser(uid, { email: email, emailVerified: false });
    await admin.firestore().collection("users").doc(uid).set({ email: email }, { merge: true });
    return res.json({ ok: true });
  } catch (e) {
    if (e && e.code === "auth/email-already-exists") return res.status(409).json({ error: "このメールアドレスは既に使われています。" });
    if (e && e.code === "auth/invalid-email") return res.status(400).json({ error: "メールアドレスの形式が正しくありません。" });
    return res.status(500).json({ error: "変更に失敗しました: " + (e.message || String(e)) });
  }
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
  // tier: "na"|"turbo"|"twinturbo"(既定na) / plan: "yearly"|"monthly"
  const tier = ["na", "turbo", "twinturbo"].includes(data.tier) ? data.tier : "na";
  const interval = (data.plan === "yearly") ? "year" : "month";
  const P = cfg().stripe.prices[tier] || {};
  const priceId = P[interval] || ((interval === "year") ? cfg().stripe.price_year : cfg().stripe.price_month);
  if (!priceId) return res.status(500).json({ error: "価格(Price)が未設定です。" });
  const email = data.email || u.email;
  const tid = u.tenantId;
  try {
    // 顧客(Customer)を用意(店舗ごとに再利用)
    const tRef = db.collection("tenants").doc(tid);
    const tData = (await tRef.get()).data() || {};
    let customerId = tData.stripeCustomerId;
    if (customerId) { try { await stripe.customers.update(customerId, { email: email }); } catch (e) { customerId = null; } }
    if (!customerId) {
      const c = await stripe.customers.create({ email: email, metadata: { tenantId: tid } });
      customerId = c.id;
      await tRef.set({ stripeCustomerId: customerId }, { merge: true });
    }
    // ★プラン変更: 既に有効な契約がある場合は「新規作成」せず既存サブスクの price を更新する。
    //   → 契約が2本並ぶ二重課金を防ぐ。差額はStripeが日割り精算(次回請求に計上)。
    const existSubs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
    const existingSub = (existSubs.data || []).find((s) => ["active", "trialing", "past_due", "unpaid"].includes(s.status));
    if (existingSub) {
      const mainItem = existingSub.items.data.find((it) => tierFromPriceId(it.price.id)) || existingSub.items.data[0];
      const items = [{ id: mainItem.id, price: priceId }];
      // プラン変更で不要になった席item(ツインターボ以外/間隔変更)を掃除
      const seatMonth = process.env.STRIPE_PRICE_SEAT_MONTH, seatYear = process.env.STRIPE_PRICE_SEAT_YEAR;
      existingSub.items.data.forEach((it) => {
        if ((it.price.id === seatMonth || it.price.id === seatYear) && tier !== "twinturbo") items.push({ id: it.id, deleted: true });
      });
      const upd = await stripe.subscriptions.update(existingSub.id, {
        items: items,
        proration_behavior: "create_prorations",   // 差額は次回請求にまとめて計上
        metadata: { tenantId: tid, aiPlan: tier },
      });
      const until = upd.current_period_end ? upd.current_period_end * 1000 : (Number(tData.paidUntil) || null);
      await tRef.set({ plan: "active", aiPlan: tier, aiPaidFallback: (tier !== "na"), paidUntil: until }, { merge: true });
      return res.json({ updated: true, tier: tier });
    }
    // 請求書送付方式のサブスク。請求書ページでカード/銀行振込/コンビニを選べる。
    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      trial_period_days: 7,          // ★契約から7日間は無料トライアル(status:trialing)。8日目に初回請求書。
      collection_method: "send_invoice",
      days_until_due: 14,
      metadata: { tenantId: tid, aiPlan: tier },   // 購入プランをwebフックで店舗に反映
      payment_settings: {
        payment_method_types: ["card", "konbini", "customer_balance"],
        save_default_payment_method: "on_subscription",
        payment_method_options: {
          customer_balance: { bank_transfer: { type: "jp_bank_transfer" }, funding_type: "bank_transfer" },
        },
      },
      expand: ["latest_invoice"],
    });
    // トライアル中は初回請求が¥0のため請求書は送らない。実請求(amount_due>0)がある時だけ送付。
    const trial = sub.status === "trialing";
    let inv = sub.latest_invoice, url = null, invoiceSent = false;
    if (inv && (inv.amount_due || 0) > 0) {
      if (inv.status === "draft") { try { inv = await stripe.invoices.finalizeInvoice(inv.id); } catch (e) {} }
      if (inv && inv.id) { try { await stripe.invoices.sendInvoice(inv.id); invoiceSent = true; } catch (e) {} }
      url = inv && (inv.hosted_invoice_url || null);
    }
    return res.json({ url: url, invoiceSent: invoiceSent, trial: trial, trialEnd: sub.trial_end || null });
  } catch (e) {
    return res.status(500).json({ error: "請求書の作成に失敗: " + (e.message || e) });
  }
});

/* =========================================================================
   契約者の自動オンボーディング(専用リンク方式)。
   法人LPで「契約希望」が届いたら、テナント＋Stripe 7日トライアルを自動作成し、
   専用セットアップリンク(トークン)とログインIDを発行してメール送信。
   相手はリンクでパスワードだけ設定→即ログイン→7日お試し→8日目に決済(既存Stripe)。
   ========================================================================= */
const crypto = require("crypto");
function planCodeFromLabel(s) { s = String(s || ""); if (/ツイン|twin/i.test(s)) return "twinturbo"; if (/ターボ|turbo/i.test(s)) return "turbo"; return "na"; }
function planLabelFromCode(c) { return c === "twinturbo" ? "ツインターボ" : c === "turbo" ? "ターボ" : "NA"; }
function asciiSlug(s) { const a = (String(s || "").match(/[a-zA-Z0-9]+/g) || []).join("").toLowerCase().slice(0, 12); return a || "shop"; }
async function genLoginId(db, company) {
  const base = asciiSlug(company);
  for (let i = 0; i < 15; i++) {
    const cand = base + "-" + Math.random().toString(36).slice(2, 6);
    const q = await db.collection("users").where("loginId", "==", cand).limit(1).get();
    if (q.empty) return cand;
  }
  return base + "-" + Date.now().toString(36).slice(-5);
}
// 会社名ベースのシンプルな店舗コード(テナントID)を生成。既存のIDやコードと重複しないもの。
async function genTenantId(db, company) {
  const base = asciiSlug(company);
  const cands = [];
  if (base !== "shop") cands.push(base);
  for (let i = 0; i < 40; i++) cands.push(base + (Math.floor(Math.random() * 9000) + 1000));
  for (const c of cands) {
    const doc = await db.collection("tenants").doc(c).get();
    if (doc.exists) continue;
    const codeDup = await db.collection("tenants").where("code", "==", c).limit(1).get();
    if (codeDup.empty) return c;
  }
  return base + "-" + Date.now().toString(36).slice(-5);
}
// 契約者のテナントとStripeトライアルを自動作成し、オンボーディング用トークンを発行して返す。
async function provisionContract(db, info) {
  const planCode = planCodeFromLabel(info.plan);
  const tid = await genTenantId(db, info.company);
  let stripeCustomerId = null, trialEnd = null;
  try {
    const stripe = require("stripe")(cfg().stripe.secret);
    const c = await stripe.customers.create({ email: info.email, metadata: { tenantId: tid, company: info.company } });
    stripeCustomerId = c.id;
    const P = cfg().stripe.prices[planCode] || {};
    const priceId = P.month || cfg().stripe.price_month;
    if (priceId) {
      const sub = await stripe.subscriptions.create({
        customer: c.id, items: [{ price: priceId }], trial_period_days: 7,
        collection_method: "send_invoice", days_until_due: 14,
        metadata: { tenantId: tid, aiPlan: planCode },
        payment_settings: {
          payment_method_types: ["card", "konbini", "customer_balance"],
          save_default_payment_method: "on_subscription",
          payment_method_options: { customer_balance: { bank_transfer: { type: "jp_bank_transfer" }, funding_type: "bank_transfer" } },
        },
      });
      trialEnd = sub.trial_end ? sub.trial_end * 1000 : null;
    }
  } catch (e) { console.error("provision Stripe失敗", e); }
  if (!trialEnd) trialEnd = Date.now() + 7 * 86400000;
  const loginId = await genLoginId(db, info.company);
  await db.collection("tenants").doc(tid).set({
    name: info.company, aiPlan: planCode, plan: "trial", aiPaidFallback: (planCode !== "na"),
    paidUntil: trialEnd, stripeCustomerId: stripeCustomerId, seats: 1,
    provisioned: true, provisionedAt: Date.now(), contactEmail: info.email,
  }, { merge: true });
  const token = crypto.randomBytes(24).toString("hex");
  await db.collection("onboardTokens").doc(token).set({
    tid, email: String(info.email || "").toLowerCase(), name: info.name || "", company: info.company,
    planCode, loginId, used: false, exp: Date.now() + 14 * 86400000, createdAt: Date.now(),
  });
  return { token, loginId, planCode, trialEnd, tid };
}

// 契約者アカウントを直接発行(テナント＋7日トライアル＋Authユーザー＋初期パスワード)し、
// ログイン情報＋アプリQR＋案内メール本文一式を返す。自動返信・営業コンソール両方で共用。
async function issueContractAccount(db, info) {
  const pr = await provisionContract(db, info);
  const planLabel = planLabelFromCode(pr.planCode);
  const email = String(info.email || "").trim().toLowerCase();
  const name = String(info.name || "").trim();
  const company = String(info.company || "").trim();
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let pw = ""; for (let i = 0; i < 10; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  let uid;
  try { const u = await admin.auth().getUserByEmail(email); uid = u.uid; await admin.auth().updateUser(uid, { password: pw }); }
  catch (e) { const u = await admin.auth().createUser({ email, password: pw, displayName: name || company }); uid = u.uid; }
  let loginId = pr.loginId;
  const dup = await db.collection("users").where("loginId", "==", loginId).limit(1).get();
  if (!dup.empty && dup.docs[0].id !== uid) loginId = loginId + "-" + Math.random().toString(36).slice(2, 5);
  await db.collection("users").doc(uid).set({ name: name || company, email, tenantId: pr.tid, role: "admin", active: true, rejected: false, loginId, deviceLimit: 2, createdAt: Date.now() }, { merge: true });
  try { await db.collection("onboardTokens").doc(pr.token).set({ used: true }, { merge: true }); } catch (e) {}
  const appUrl = (cfg().app.url || "https://mechanoai-cablueie.com/").replace(/\/?$/, "/");
  const corpUrl = appUrl + "?corp=1";
  const qrUrl = "https://quickchart.io/qr?size=300&margin=1&text=" + encodeURIComponent(corpUrl);
  const storeCode = pr.tid;   // 店舗コード(従業員の参加用) = テナントID
  const subject = "【メカノAI】お申し込みありがとうございます（ログイン情報のご案内）";
  const body = (name ? name + " 様" : company + " 御中") + "\n\n" +
    "この度はメカノAI（" + planLabel + "プラン）にお申し込みいただき、誠にありがとうございます。\n" +
    "下記の情報で、すぐにご利用いただけます。\n\n" +
    "▼ログインID\n" + loginId + "\n（メールアドレス " + email + " でもログインできます）\n\n" +
    "▼初期パスワード\n" + pw + "\n（安全のため、初回ログイン後に『設定 → クラウド同期 → 🔑パスワード変更』で任意のパスワードへ変更してください）\n\n" +
    "▼店舗コード（従業員の参加用）\n" + storeCode + "\n（従業員の方は、アプリの『設定 → クラウド同期 → 会社に参加』で、この店舗コードとご自身のメール・パスワードを入力して参加を申請します。代表管理者であるあなたが承認すると、車両データやカルテが社内メンバー全員で共有されます）\n\n" +
    "▼ご契約プラン\n" + planLabel + "（お申し込みから7日間は無料でお試しいただけます。初回のご請求は8日目からで、請求書をメールでお送りします）\n\n" +
    "▼アプリを開く\n" + corpUrl + "\n" +
    "　スマホで下のQRコードを読み取っても開けます（社内メンバーへの参加案内にもお使いいただけます）:\n" + qrUrl + "\n\n" +
    "▼はじめ方\n① 設定 → クラウド同期 でログイン → 車検証をスキャンして開始。\n② 従業員の方は同じ画面の『会社に参加』から、上記の店舗コードで参加申請 →（代表管理者の）あなたが承認すると追加されます。\n\n" +
    MAIL_SIGN;
  return { loginId, email, password: pw, planLabel, tid: pr.tid, corpUrl, qrUrl, subject, body };
}

// 専用リンクを開いた時: トークンの内容(会社名・プラン・メール・ログインID)を返す。
exports.onboardStart = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const token = String((req.query && req.query.t) || (req.body && req.body.t) || "").trim();
  if (!token) return res.status(400).json({ error: "リンクが正しくありません。" });
  const db = admin.firestore();
  const d = (await db.collection("onboardTokens").doc(token).get()).data();
  if (!d) return res.status(404).json({ error: "リンクが無効です。お手数ですがお問い合わせください。" });
  if (d.used) return res.status(409).json({ error: "このリンクは既にセットアップ済みです。ログインしてご利用ください。" });
  if (d.exp && Date.now() > d.exp) return res.status(410).json({ error: "リンクの有効期限が切れています。お問い合わせください。" });
  return res.json({ ok: true, company: d.company, email: d.email, name: d.name || "", loginId: d.loginId, planLabel: planLabelFromCode(d.planCode) });
});

// パスワード設定後: 作成済みのFirebase認証アカウント(idToken)にadmin権限とテナントを付与し有効化。
exports.onboardActivate = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ。" });
  const b = req.body || {};
  const token = String(b.t || "").trim();
  const idToken = String(b.idToken || "").trim();
  if (!token || !idToken) return res.status(400).json({ error: "情報が不足しています。" });
  const db = admin.firestore();
  const ref = db.collection("onboardTokens").doc(token);
  const d = (await ref.get()).data();
  if (!d) return res.status(404).json({ error: "リンクが無効です。" });
  if (d.used) return res.status(409).json({ error: "既にセットアップ済みです。" });
  if (d.exp && Date.now() > d.exp) return res.status(410).json({ error: "リンクの有効期限が切れています。" });
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); } catch (e) { return res.status(401).json({ error: "認証に失敗しました。" }); }
  const uid = decoded.uid;
  const email = String(decoded.email || "").toLowerCase();
  if (email !== String(d.email || "").toLowerCase()) return res.status(403).json({ error: "リンクのメールアドレスと一致しません。" });
  let loginId = d.loginId;
  const dup = await db.collection("users").where("loginId", "==", loginId).limit(1).get();
  if (!dup.empty && dup.docs[0].id !== uid) loginId = loginId + "-" + Math.random().toString(36).slice(2, 5);
  await db.collection("users").doc(uid).set({
    name: d.name || d.company, email: d.email, tenantId: d.tid, role: "admin",
    active: true, rejected: false, loginId: loginId, createdAt: Date.now(),
  }, { merge: true });
  await ref.set({ used: true, usedAt: Date.now(), uid: uid }, { merge: true });
  return res.json({ ok: true, tenantId: d.tid, loginId: loginId });
});

// ログインID → メールアドレス を引く(ログイン画面でID入力を許可するため)。
exports.loginIdLookup = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const id = String((req.body && req.body.loginId) || "").trim();
  if (!id) return res.status(400).json({ error: "IDを入力してください。" });
  const db = admin.firestore();
  const q = await db.collection("users").where("loginId", "==", id).limit(1).get();
  if (q.empty) return res.status(404).json({ error: "IDが見つかりません。" });
  return res.json({ email: q.docs[0].data().email || "" });
});

// 店舗コード(表示用の別名)を設定/変更する。
//  ・代表管理者(admin): 自店舗のみ、変更は1回だけ(2回目以降は運営へ)。
//  ・運営(super): 任意の店舗を何度でも変更可。
// ※実データのテナントID(ドキュメントID)は変えず、表示・参加用の別名 code を設定(データ移行不要)。
exports.setTenantCode = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ。" });
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "ログインが必要です。" });
  const db = admin.firestore();
  const u = (await db.collection("users").doc(uid).get()).data();
  if (!u) return res.status(403).json({ error: "権限がありません。" });
  const isSup = u.role === "super";
  const tid = String((req.body && req.body.tid) || u.tenantId || "");
  if (!tid) return res.status(400).json({ error: "店舗が特定できません。" });
  if (!isSup && !(u.role === "admin" && u.tenantId === tid)) return res.status(403).json({ error: "代表管理者のみ変更できます。" });
  const tRef = db.collection("tenants").doc(tid);
  const t = (await tRef.get()).data() || {};
  if (!isSup && t.codeSetByAdmin) return res.status(409).json({ error: "店舗コードの変更は1回のみです。再変更は運営へお問い合わせください。" });
  let code = String((req.body && req.body.code) || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (code.length < 3 || code.length > 24) return res.status(400).json({ error: "コードは半角英数字・ハイフンで3〜24文字にしてください。" });
  if (code !== tid) {
    const asDoc = await tRef.firestore.collection("tenants").doc(code).get();
    if (asDoc.exists) return res.status(409).json({ error: "そのコードは既に使われています。別のコードをお試しください。" });
    const asCode = await db.collection("tenants").where("code", "==", code).limit(1).get();
    if (!asCode.empty && asCode.docs[0].id !== tid) return res.status(409).json({ error: "そのコードは既に使われています。別のコードをお試しください。" });
  }
  const patch = { code: code };
  if (!isSup) patch.codeSetByAdmin = true;   // 管理者の変更は1回で締める(super変更ではフラグを立てない=以後もsuperは可)
  await tRef.set(patch, { merge: true });
  return res.json({ ok: true, code: code, byAdminLocked: !isSup });
});

// 店舗コード(別名 or 実ID) → 実テナントID を解決(参加申請でコード入力を許可するため)。
exports.tenantResolve = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const q = String((req.query && req.query.q) || (req.body && req.body.q) || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!q) return res.status(400).json({ error: "コードを入力してください。" });
  const db = admin.firestore();
  const doc = await db.collection("tenants").doc(q).get();
  if (doc.exists) return res.json({ tid: q });
  const byCode = await db.collection("tenants").where("code", "==", q).limit(1).get();
  if (!byCode.empty) return res.json({ tid: byCode.docs[0].id });
  return res.status(404).json({ error: "その店舗コードは見つかりません。" });
});

// ログイン中の本人が自分のログインIDを設定/変更する(重複不可)。
exports.setLoginId = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ。" });
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "ログインが必要です。" });
  let id = String((req.body && req.body.loginId) || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (id.length < 3 || id.length > 24) return res.status(400).json({ error: "IDは半角英数字・ハイフンで3〜24文字にしてください。" });
  const db = admin.firestore();
  const dup = await db.collection("users").where("loginId", "==", id).limit(1).get();
  if (!dup.empty && dup.docs[0].id !== uid) return res.status(409).json({ error: "このログインIDは既に使われています。別のIDをお試しください。" });
  await db.collection("users").doc(uid).set({ loginId: id }, { merge: true });
  return res.json({ ok: true, loginId: id });
});

// トライアル満了後の決済リンク(未払い/送付済みの請求書のURL)を返す。8日目の画面導線用。POST {tid}。
exports.getPayLink = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "ログインが必要です。" });
  const db = admin.firestore();
  const u = (await db.collection("users").doc(uid).get()).data();
  const tid = (req.body && req.body.tid) || (u && u.tenantId);
  if (!u || !tid || (u.tenantId !== tid && u.role !== "super")) return res.status(403).json({ error: "権限がありません。" });
  const t = (await db.collection("tenants").doc(tid).get()).data() || {};
  if (!t.stripeCustomerId) return res.json({ url: null });
  try {
    const stripe = require("stripe")(cfg().stripe.secret);
    const invs = await stripe.invoices.list({ customer: t.stripeCustomerId, limit: 5 });
    const open = (invs.data || []).find((i) => i.status === "open") || (invs.data || []).find((i) => (i.amount_due || 0) > 0);
    return res.json({ url: open ? (open.hosted_invoice_url || null) : null });
  } catch (e) { return res.json({ url: null }); }
});

/* Stripeの現契約から店舗のプランを取り込んで同期(webフックの取りこぼし救済)。POST {tid}。
   運営(super) or 自店舗の代表管理者(admin)が実行可。契約のプラン(NA/ターボ/ツインターボ)・期限を反映する。 */
exports.syncPlan = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "ログインが必要です。" });
  const db = admin.firestore();
  const me = (await db.collection("users").doc(uid).get()).data();
  const tid = (req.body || {}).tid;
  if (!tid) return res.status(400).json({ error: "店舗IDがありません。" });
  const allowed = me && (me.role === "super" || (me.role === "admin" && me.tenantId === tid));
  if (!allowed) return res.status(403).json({ error: "権限がありません。" });
  const tRef = db.collection("tenants").doc(tid);
  const t = (await tRef.get()).data() || {};
  if (!t.stripeCustomerId) return res.status(400).json({ error: "この店舗にStripe契約情報がありません（手動契約の可能性）。" });
  try {
    const stripe = require("stripe")(cfg().stripe.secret);
    const subs = await stripe.subscriptions.list({ customer: t.stripeCustomerId, status: "all", limit: 10 });
    const sub = (subs.data || []).find((s) => ["active", "trialing", "past_due", "unpaid"].includes(s.status));
    if (!sub) return res.status(400).json({ error: "有効なStripe契約が見つかりません。" });
    // プラン判定: サブスクmetadata優先、無ければ price ID から判定
    let tier = (sub.metadata && sub.metadata.aiPlan) || "";
    if (!tier) { try { tier = tierFromPriceId(sub.items.data[0].price.id); } catch (e) {} }
    if (!tier) tier = "na";
    const until = sub.current_period_end ? sub.current_period_end * 1000 : null;
    const existing = Number(t.paidUntil) || 0;
    const patch = { plan: "active", paidUntil: Math.max(existing, Number(until) || 0) || null, aiPlan: tier, aiPaidFallback: (tier !== "na") };
    await tRef.set(patch, { merge: true });
    return res.json({ ok: true, aiPlan: tier, paidUntil: patch.paidUntil });
  } catch (e) { return res.status(500).json({ error: "同期に失敗: " + (e.message || e) }); }
});

/* 店舗の『追加端末数』(3台目以降の合計)をStripeサブスクに数量反映。席と同じ方式(proration=none・次サイクル合算)。
   追加端末数 = 店舗の全メンバーの Σ max(0, deviceLimit-2)。 */
async function syncDeviceQty(tid) {
  const db = admin.firestore();
  const snap = await db.collection("users").where("tenantId", "==", tid).get();
  let extra = 0; snap.forEach(d => { const dl = Number((d.data() || {}).deviceLimit) || 2; extra += Math.max(0, dl - 2); });
  const t = (await db.collection("tenants").doc(tid).get()).data() || {};
  const dm = process.env.STRIPE_PRICE_DEVICE_MONTH, dy = process.env.STRIPE_PRICE_DEVICE_YEAR;
  let billed = false, note = "";
  if (t.stripeCustomerId) {
    try {
      const stripe = require("stripe")(cfg().stripe.secret);
      const subs = await stripe.subscriptions.list({ customer: t.stripeCustomerId, status: "all", limit: 10 });
      const sub = (subs.data || []).find((s) => ["active", "trialing", "past_due", "unpaid"].includes(s.status));
      if (sub) {
        const mainItem = sub.items.data.find((it) => tierFromPriceId(it.price.id)) || sub.items.data[0];
        const interval = (mainItem && mainItem.price.recurring && mainItem.price.recurring.interval) || "month";
        const devPrice = interval === "year" ? dy : dm;
        const devItem = sub.items.data.find((it) => it.price.id === dm || it.price.id === dy);
        const items = [];
        if (devItem) items.push({ id: devItem.id, deleted: true });
        if (extra > 0 && devPrice) items.push({ price: devPrice, quantity: extra });
        if (items.length) { await stripe.subscriptions.update(sub.id, { items: items, proration_behavior: "none" }); billed = extra > 0; }
      } else { note = "有効な契約が無いため端末枠のみ更新しました。"; }
    } catch (e) { note = "Stripe更新に失敗(端末枠のみ更新): " + (e.message || e); }
  } else { note = "Stripe契約が無いため端末枠のみ更新しました(手動契約)。"; }
  return { extra: extra, billed: billed, note: note };
}
/* 端末枠(deviceLimit)を増減し、追加端末分を自動でStripeに合算(次サイクル請求)。POST {uid?, delta}。
   本人=自分の端末を追加/削減。運営(super)/同店舗の代表管理者(admin)=対象メンバーを操作可。 */
exports.setDevices = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "ログインが必要です。" });
  const db = admin.firestore();
  const me = (await db.collection("users").doc(uid).get()).data();
  if (!me || me.active !== true) return res.status(403).json({ error: "有効なアカウントではありません。" });
  const data = req.body || {};
  const targetUid = data.uid || uid;
  const delta = (parseInt(data.delta, 10) === -1) ? -1 : 1;
  const tu = (await db.collection("users").doc(targetUid).get()).data();
  if (!tu) return res.status(404).json({ error: "対象が見つかりません。" });
  const isSelf = targetUid === uid;
  const allowed = isSelf || me.role === "super" || (me.role === "admin" && me.tenantId === tu.tenantId);
  if (!allowed) return res.status(403).json({ error: "権限がありません。" });
  const newLimit = Math.max(2, (Number(tu.deviceLimit) || 2) + delta);
  await db.collection("users").doc(targetUid).update({ deviceLimit: newLimit });
  const bill = tu.tenantId ? await syncDeviceQty(tu.tenantId) : { extra: 0, billed: false, note: "" };
  return res.json({ ok: true, deviceLimit: newLimit, extra: bill.extra, billed: bill.billed, note: bill.note });
});

/* ツインターボの検索席メンバーを指名/解除。POST {tid, uid, on}。運営 or 自店舗の代表管理者が実行可。
   tenants/{tid}.seatMembers に uid を追加/削除。指名数は searchSeats(既定3)まで。 */
exports.assignSeat = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const callerUid = await uidFromReq(req);
  if (!callerUid) return res.status(401).json({ error: "ログインが必要です。" });
  const db = admin.firestore();
  const me = (await db.collection("users").doc(callerUid).get()).data();
  const data = req.body || {};
  const tid = data.tid, uid = data.uid, on = !!data.on;
  if (!tid || !uid) return res.status(400).json({ error: "パラメータ不足です。" });
  const allowed = me && (me.role === "super" || (me.role === "admin" && me.tenantId === tid));
  if (!allowed) return res.status(403).json({ error: "権限がありません。" });
  const tu = (await db.collection("users").doc(uid).get()).data();
  if (!tu || tu.tenantId !== tid) return res.status(400).json({ error: "対象メンバーが店舗に属していません。" });
  const tRef = db.collection("tenants").doc(tid);
  // この店舗に現在属するメンバーのuid集合。退職者・重複が seatMembers に残って
  // 席数を多重カウントする不具合(3人なのに4人)を防ぐため、有効メンバーだけを数える。
  const memSnap = await db.collection("users").where("tenantId", "==", tid).get();
  const validUids = new Set(memSnap.docs.map((d) => d.id));
  validUids.add(uid);
  try {
    const result = await db.runTransaction(async (tx) => {
      const t = (await tx.get(tRef)).data() || {};
      const seats = Math.max(1, +(t.searchSeats || 3));
      // 重複除去＋現メンバーのみに正規化してから数える(不正な席残りを掃除)
      let list = (Array.isArray(t.seatMembers) ? t.seatMembers : []).filter((x, i, a) => x && a.indexOf(x) === i && validUids.has(x));
      const idx = list.indexOf(uid);
      if (on) {
        if (idx < 0) {
          if (list.length >= seats) return { err: "検索席が上限（" + seats + "席）に達しています。先に席数を増やすか、他のメンバーを解除してください。" };
          list.push(uid);
        }
      } else if (idx >= 0) { list.splice(idx, 1); }
      tx.set(tRef, { seatMembers: list }, { merge: true });
      return { seatMembers: list, seats: seats };
    });
    if (result.err) return res.status(400).json({ error: result.err });
    return res.json({ ok: true, seatMembers: result.seatMembers, seats: result.seats });
  } catch (e) { return res.status(500).json({ error: "席の更新に失敗: " + (e.message || e) }); }
});

/* ツインターボの検索『席数』を設定(運営のみ)。POST {tid, seats}。
   3席は標準(無料)。4席目以降は Stripe のサブスクに『追加席』priceを“数量”として付与し、
   proration_behavior="none" で当月は請求せず、次サイクルでメイン料金にまとめて自動請求する。
   契約(サブスク)の請求間隔(月/年)に合わせて月額/年額の席priceを使い分ける。 */
exports.setSeats = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "ログインが必要です。" });
  const db = admin.firestore();
  const u = (await db.collection("users").doc(uid).get()).data();
  const data = req.body || {};
  const tid = data.tid;
  // 運営(super)は全店舗、代表管理者(admin)は自店舗のみ席数を変更できる。
  const allowed = u && (u.role === "super" || (u.role === "admin" && u.tenantId === tid));
  if (!allowed) return res.status(403).json({ error: "運営または自店舗の代表管理者のみ設定できます。" });
  const seats = Math.max(1, parseInt(data.seats, 10) || 3);
  if (!tid) return res.status(400).json({ error: "店舗IDがありません。" });
  const extra = Math.max(0, seats - 3);   // 4席目以降が課金対象
  const tRef = db.collection("tenants").doc(tid);
  const t = (await tRef.get()).data() || {};
  let billed = false, note = "";
  const seatMonth = process.env.STRIPE_PRICE_SEAT_MONTH, seatYear = process.env.STRIPE_PRICE_SEAT_YEAR;
  const customerId = t.stripeCustomerId;
  if (customerId) {
    try {
      const stripe = require("stripe")(cfg().stripe.secret);
      const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
      const sub = (subs.data || []).find((s) => ["active", "trialing", "past_due", "unpaid"].includes(s.status));
      if (sub) {
        // 契約の請求間隔を判定(メインplanのpriceから)。席priceも同じ間隔に合わせる。
        const mainItem = sub.items.data.find((it) => tierFromPriceId(it.price.id)) || sub.items.data[0];
        const interval = (mainItem && mainItem.price.recurring && mainItem.price.recurring.interval) || "month";
        const seatPrice = interval === "year" ? seatYear : seatMonth;
        const seatItem = sub.items.data.find((it) => it.price.id === seatMonth || it.price.id === seatYear);
        const items = [];
        if (seatItem) items.push({ id: seatItem.id, deleted: true });   // 既存の席itemは一旦外す(間隔変更にも対応)
        if (extra > 0 && seatPrice) items.push({ price: seatPrice, quantity: extra });   // 正しい間隔で付け直す
        if (items.length) {
          await stripe.subscriptions.update(sub.id, { items: items, proration_behavior: "none" });   // 当月は請求せず次回にまとめる
          billed = extra > 0;
        }
      } else { note = "有効な契約が無いためStripe請求は付けず、席数のみ更新しました。"; }
    } catch (e) { note = "Stripe更新に失敗(席数のみ更新): " + (e.message || e); }
  } else { note = "Stripe契約が無いため席数のみ更新しました(手動契約)。"; }
  await tRef.set({ searchSeats: seats }, { merge: true });
  return res.json({ ok: true, seats: seats, extra: extra, billed: billed, note: note });
});

/* 解約(自動): POST {} → 現契約を期間終了で自動キャンセル。代表管理者のみ。
   cancel_at_period_end=true にするので、支払い済み期間の終了まで利用可→その後 webhook で自動停止。 */
exports.cancelPlan = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const uid = await uidFromReq(req);
  if (!uid) return res.status(401).json({ error: "ログインが必要です。" });
  const db = admin.firestore();
  const u = (await db.collection("users").doc(uid).get()).data();
  if (!u || !u.tenantId) return res.status(403).json({ error: "所属がありません。" });
  if (!(u.role === "admin" || u.role === "super")) return res.status(403).json({ error: "代表管理者のみ手続きできます。" });
  const tRef = db.collection("tenants").doc(u.tenantId);
  const tData = (await tRef.get()).data() || {};
  const customerId = tData.stripeCustomerId;
  if (!customerId) return res.status(400).json({ error: "契約情報が見つかりません。" });
  const stripe = require("stripe")(cfg().stripe.secret);
  try {
    const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
    const active = (subs.data || []).find((s) => s.status === "active" || s.status === "trialing" || s.status === "past_due" || s.status === "unpaid");
    if (!active) return res.status(400).json({ error: "有効な契約が見つかりません。" });
    const updated = await stripe.subscriptions.update(active.id, { cancel_at_period_end: true });
    const until = updated.current_period_end ? updated.current_period_end * 1000 : null;
    return res.json({ ok: true, until: until });
  } catch (e) {
    return res.status(500).json({ error: "解約に失敗: " + (e.message || e) });
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
  const setPlan = async (tid, active, untilMs, tier) => {
    if (!tid) return;
    const ref = db.collection("tenants").doc(tid);
    const cur = (await ref.get()).data() || {};
    if (active) {
      // paidUntilは「延長のみ」。既存期限とStripe期限の“遅い方”を採用し、更新イベントで
      // 期間が短く上書きされて勝手に期限切れになるのを防ぐ。
      const existing = Number(cur.paidUntil) || 0;
      const next = Math.max(Number(untilMs) || 0, existing);
      const patch = { plan: "active", paidUntil: next || null };
      // 購入プラン(NA・ターボ・ツインターボ)を店舗に反映(検索上限/席数の切替)。
      if (tier) { patch.aiPlan = tier; patch.aiPaidFallback = (tier !== "na"); }
      await ref.set(patch, { merge: true });
      // ④ 契約時の自動お礼・はじめ方メール(初回のみ)。送信成功時だけwelcomeSentを立てる。
      if (tier && !cur.welcomeSent) {
        try {
          let toEmail = "";
          if (cur.stripeCustomerId) { const c = await stripe.customers.retrieve(cur.stripeCustomerId); toEmail = (c && c.email) || ""; }
          if (toEmail) {
            const TNAME = { na: "NA", turbo: "ターボ", twinturbo: "ツインターボ" }[tier] || tier;
            const welcome =
              "この度はメカノAI（" + TNAME + "プラン）にお申し込みいただき、誠にありがとうございます。\n\n" +
              "▼ ご利用の始め方\n" +
              "1. アプリを開く　https://mechanoai-cablueie.com/\n" +
              "2. 代表管理者のメール・パスワードでログイン\n" +
              "3. 車検証をスキャン → 諸元・故障診断・整備カルテがすぐ使えます\n" +
              "　（従業員は『会社に参加』で店舗コードを入力し申請 → あなたが承認。1人2端末まで。車両DB・記録は社内で自動共有されます）\n\n" +
              "▼ 無料トライアル\n" +
              "お申し込みから7日間は無料です。自社の実データのまま全機能をお試しください（初回請求は8日目以降）。\n\n" +
              "▼ こまったときは\n" +
              "使い方のご相談・設定サポートは本メールへの返信、またはお電話で承ります。\n\n" +
              "今後ともよろしくお願いいたします。\n\n" +
              MAIL_SIGN;
            const ok = await sendMail(toEmail, "【メカノAI】お申し込みありがとうございます（はじめ方のご案内）", welcome, replyAddr());
            if (ok) await ref.set({ welcomeSent: true }, { merge: true });
          }
        } catch (e) { console.error("welcomeメール失敗", e); }
      }
    } else {
      await ref.set({ plan: "suspended" }, { merge: true });
    }
  };
  // サブスクから購入プランコードを取得(メタデータ優先、無ければprice IDから判定)
  const tierOfSub = (sub) => {
    if (!sub) return "";
    let t = (sub.metadata && sub.metadata.aiPlan) || "";
    if (!t) { try { t = tierFromPriceId(sub.items.data[0].price.id); } catch (e) {} }
    return t;
  };
  // metadataにtenantIdが無い契約でも、Stripe顧客IDから店舗を逆引きして紐付ける(取りこぼし防止)。
  const tidFromCustomer = async (customerId) => {
    if (!customerId) return "";
    try { const q = await db.collection("tenants").where("stripeCustomerId", "==", customerId).limit(1).get(); return q.empty ? "" : q.docs[0].id; } catch (e) { return ""; }
  };
  try {
    const o = event.data.object;
    if (event.type === "checkout.session.completed") {
      let tid = (o.metadata && o.metadata.tenantId) || o.client_reference_id;
      let until = null, tier = "";
      if (o.subscription) { try { const sub = await stripe.subscriptions.retrieve(o.subscription); until = sub.current_period_end * 1000; tier = tierOfSub(sub); } catch (e) {} }
      if (!tid) tid = await tidFromCustomer(o.customer);
      await setPlan(tid, true, until, tier);
    } else if (event.type === "invoice.paid") {
      // 支払い確定(カードは即時、コンビニ/銀行振込は入金後)で契約を有効化
      let tid = (o.subscription_details && o.subscription_details.metadata && o.subscription_details.metadata.tenantId) || (o.metadata && o.metadata.tenantId);
      let tier = ""; try { tier = tierFromPriceId(o.lines.data[0].price.id); } catch (e) {}
      if (!tid && o.subscription) { try { const sub = await stripe.subscriptions.retrieve(o.subscription); tid = sub.metadata.tenantId; if (!tier) tier = tierOfSub(sub); } catch (e) {} }
      if (!tid) tid = await tidFromCustomer(o.customer);
      let until = null; try { until = o.lines.data[0].period.end * 1000; } catch (e) {}
      if (tid) await setPlan(tid, true, until, tier);
      // カードで支払われた場合は、次回以降を自動更新(自動引き落とし)に切り替える
      try {
        if (o.subscription && o.payment_intent) {
          const pi = await stripe.paymentIntents.retrieve(o.payment_intent);
          if (pi && pi.payment_method) {
            const pm = await stripe.paymentMethods.retrieve(pi.payment_method);
            if (pm && pm.type === "card") {
              await stripe.subscriptions.update(o.subscription, { collection_method: "charge_automatically", default_payment_method: pi.payment_method });
            }
          }
        }
      } catch (e) { console.error("自動更新切替エラー", e); }
    } else if (event.type === "customer.subscription.deleted") {
      const tid = o.metadata && o.metadata.tenantId;
      await setPlan(tid, false, null);   // 契約が完全終了 → 停止
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
      // 送付インボイス方式では作成時点でactiveになるため、created でもプランを反映(=契約したら即切替)。
      let tid = o.metadata && o.metadata.tenantId;
      if (!tid) tid = await tidFromCustomer(o.customer);
      // past_due/unpaid等の一時状態(再請求中)では止めない。canceled/失効のみ停止扱い。
      const ended = o.status === "canceled" || o.status === "incomplete_expired";
      await setPlan(tid, !ended, o.current_period_end ? o.current_period_end * 1000 : null, ended ? "" : tierOfSub(o));
    }
  } catch (e) { console.error("webhook処理エラー", e); }
  return res.json({ received: true });
});

/* 配信停止(オプトアウト): GET /unsub?e=メール → mailSuppress に登録して以後ドリップ送信しない。 */
exports.unsub = functions.region(REGION).https.onRequest(async (req, res) => {
  const email = String((req.query && req.query.e) || "").trim().toLowerCase();
  res.set("Content-Type", "text/html; charset=utf-8");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).send("<meta charset='utf-8'><p style='font-family:sans-serif'>メールアドレスが正しくありません。</p>");
  }
  try {
    const id = Buffer.from(email).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
    await admin.firestore().collection("mailSuppress").doc(id).set({ email: email, ts: Date.now() }, { merge: true });
  } catch (e) { console.error("unsub失敗", e); }
  return res.send("<meta charset='utf-8'><div style='font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;line-height:1.8'>" +
    "<h2 style='color:#1e5aa8'>配信を停止しました</h2><p>" + email.replace(/[<>&]/g, "") + " 宛の営業メールは今後お送りしません。<br>ご不便をおかけしました。</p>" +
    "<p style='color:#888;font-size:13px'>メカノAI（Cablueie）</p></div>");
});

/* ① 営業メールの自動ドリップ送信(1日数件)。毎朝スケジュール実行。
   salesConfig/main.dripEnabled=true のときだけ、salesLeads(status=見込み・email有)へ
   AI生成のコールドメール(配信停止＋署名つき)を dripPerDay 件送り、状況を「アプローチ中」に更新。 */
exports.dripSend = functions.region(REGION).runWith({ timeoutSeconds: 300, memory: "512MB" })
  .pubsub.schedule("every day 09:30").timeZone("Asia/Tokyo").onRun(async () => {
    const db = admin.firestore();
    const conf = (await db.collection("salesConfig").doc("main").get()).data() || {};
    if (!conf.dripEnabled) { console.log("drip: 無効のためスキップ"); return null; }
    if (!(cfg().sendgrid.key && cfg().sendgrid.from)) { console.log("drip: SendGrid未設定のためスキップ"); return null; }
    const perDay = Math.min(Math.max(parseInt(conf.dripPerDay, 10) || 3, 1), 20);
    const freeKeys = cfg().geminiFree || [];
    if (!freeKeys.length) { console.log("drip: Geminiキー未設定"); return null; }
    const latest = await latestModels(freeKeys[0]);
    const models = uniq([latest.flash, "gemini-flash-latest", "gemini-2.0-flash"]);
    // 対象候補(見込み・メール有)を古い順に多めに取得(スキップ分の余裕を持たせる)
    const snap = await db.collection("salesLeads").where("status", "==", "見込み").orderBy("createdAt", "asc").limit(perDay * 4).get();
    let sent = 0;
    for (const doc of snap.docs) {
      if (sent >= perDay) break;
      const l = doc.data(); const email = String(l.email || "").trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      // 配信停止チェック
      const supId = Buffer.from(email).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
      const sup = await db.collection("mailSuppress").doc(supId).get();
      if (sup.exists) { await doc.ref.set({ status: "配信停止", updatedAt: Date.now() }, { merge: true }); continue; }
      // 本文をAI生成(本文のみ。件名・署名・配信停止文はこちらで付ける)
      const prompt = SALES_STAFF.writer.sys + "\n\n" + PRODUCT_KB + "\n\n" + NEWS_KB + "\n\n" +
        "次の見込み先へ送る初回コールドメールの【本文のみ】を書いてください（件名・署名・配信停止文は付けない＝こちらで付けます）。\n" +
        "・宛先: " + (l.company || "") + "（業種:" + (l.kind || "整備関連") + "）" + (l.contact ? " 担当:" + l.contact : "") + "\n" +
        "・メモ: " + (l.note || "（特記なし）") + "\n" +
        "・訴求は『整備士不足・若手の即戦力化』を主軸に、業種に合う時事を1つだけ自然に触れて『だからメカノAIが効く』に着地。\n" +
        "・30秒で読める短さ。押し売り・誇張・古い統計の断定はしない。CTAは体験デモ/LPの1つに集約。\n" +
        "・宛名（例：〇〇 御中）から書き出し、前置きの自己説明は最小限に。";
      let body = "";
      try { const r = await callGeminiModels(freeKeys[0], models, [{ text: prompt }], "flash", false, 2048); if (!r.failed) body = (r.text || "").trim(); }
      catch (e) { console.error("drip生成エラー", e); }
      if (!body) continue;
      const unsubUrl = "https://" + REGION + "-mecanoai.cloudfunctions.net/unsub?e=" + encodeURIComponent(email);
      const optout = "――――――――――――\n本メールは、貴社が公開されている連絡先へ整備業向けツールのご案内としてお送りしています。\n今後の配信を希望されない場合は本メールに「配信停止」とご返信いただくか、次のリンクからお手続きください（以後お送りしません）。\n配信停止：" + unsubUrl;
      const text = body + "\n\n" + optout + "\n\n" + MAIL_SIGN;
      const subject = "整備現場の“調べ物”を減らすツールのご案内（メカノAI）";
      const ok = await sendMail(email, subject, text, replyAddr());
      if (ok) {
        await doc.ref.set({ status: "アプローチ中", approachedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
        await db.collection("salesOutbound").add({ leadId: doc.id, company: l.company || "", email: email, subject: subject, body: text, ts: Date.now() });
        sent++;
      }
    }
    console.log("drip: 送信 " + sent + " 件");
    return null;
  });

/* ③ 受信メールへのAI自動返信。SendGrid Inbound Parse からの POST(multipart)を受ける。
   相手の返信/質問を営業チーム(CS担当)のAIが読み、
     ・料金/契約/見積 に関する質問 → 自動送信せず、下書き付きで運営(Gmail+プッシュ)へ通知(＝人が確認)
     ・それ以外 → AIが返信文を作成し自動送信
   「配信停止」返信は mailSuppress に登録。すべて inboundMails に記録。
   ※常に 200 を返す(SendGrid が再送しないように)。 */
exports.inboundMail = functions.region(REGION).runWith({ timeoutSeconds: 120, memory: "512MB" })
  .https.onRequest(async (req, res) => {
    if (req.method !== "POST") return res.status(200).send("ok");
    const db = admin.firestore();
    let fields = {};
    try { fields = await parseInbound(req); }
    catch (e) { console.error("inbound解析失敗", e); return res.status(200).send("ok"); }

    const fromEmail = extractEmail(fields.from);
    if (!fromEmail) return res.status(200).send("ok");
    const subject = decodeInbound(fields, "subject").slice(0, 300);
    let text = decodeInbound(fields, "text").trim();
    if (!text && fields.html) text = decodeInbound(fields, "html").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const cleanBody = stripQuoted(text).slice(0, 4000);

    // ループ/自動応答/エラー通知は無視
    const sgFrom = String(cfg().sendgrid.from || "").toLowerCase();
    if (fromEmail === sgFrom || /sendgrid\.net$/.test(fromEmail) ||
        /(mailer-daemon|no-?reply|postmaster|do-?not-?reply)/i.test(fromEmail)) {
      return res.status(200).send("ok");
    }

    const inRef = await db.collection("inboundMails").add({
      from: fromEmail, to: String(fields.to || "").slice(0, 300),
      subject, body: cleanBody, raw: text.slice(0, 8000),
      status: "新規", ts: Date.now(),
    });

    // 配信停止
    if (/配信停止|配信を停止|停止希望|unsubscribe/i.test(text)) {
      const supId = Buffer.from(fromEmail).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
      await db.collection("mailSuppress").doc(supId).set({ email: fromEmail, ts: Date.now(), via: "reply" }, { merge: true });
      const ls = await db.collection("salesLeads").where("email", "==", fromEmail).limit(5).get();
      for (const d of ls.docs) await d.ref.set({ status: "配信停止", updatedAt: Date.now() }, { merge: true });
      await inRef.set({ status: "配信停止処理済み" }, { merge: true });
      return res.status(200).send("ok");
    }

    // 対象リード・直近の送信内容(文脈)
    let lead = null, leadId = null;
    const ls = await db.collection("salesLeads").where("email", "==", fromEmail).limit(1).get();
    if (!ls.empty) { lead = ls.docs[0].data(); leadId = ls.docs[0].id; }
    let lastOut = "";
    try {
      const os = await db.collection("salesOutbound").where("email", "==", fromEmail).orderBy("ts", "desc").limit(1).get();
      if (!os.empty) lastOut = String(os.docs[0].data().body || "").slice(0, 1500);
    } catch (e) { /* 索引未作成でも致命ではない */ }

    // AIで「分類＋返信文」を生成(CS担当 円)
    const freeKeys = cfg().geminiFree || [];
    const paidKey = cfg().geminiPaid && cfg().geminiPaid.key;
    if (!freeKeys.length) { console.error("inbound: Geminiキー未設定"); return res.status(200).send("ok"); }
    const latest = await latestModels(freeKeys[0]);
    const models = uniq([latest.flash, "gemini-flash-latest", "gemini-2.0-flash"]);
    const staff = SALES_STAFF.cs;
    const prompt = `${staff.sys}

${PRODUCT_KB}

${NEWS_KB}

以下は見込み客/問い合わせ主から届いたメールです。あなたはこれに返信します。
【送信元】${lead ? ("会社:" + (lead.company || "-") + " 担当:" + (lead.contact || "-") + " 業種:" + (lead.kind || "-")) : fromEmail}
【件名】${subject || "(なし)"}
【相手の本文】
${cleanBody || "(本文なし)"}
${lastOut ? "\n【こちらが直前に送った内容(参考)】\n" + lastOut + "\n" : ""}

やること:
1) この相手の用件が「料金・価格・費用・見積・支払・契約条件・割引」に関する質問や交渉を含むか判定する。
2) 返信メールの本文を、CS担当として丁寧かつ簡潔に作成する。製品KBの事実のみを根拠にし、金額はKB記載の範囲で正確に。答えられない点は「担当より折り返す」と案内。誇張・虚偽は書かない。CTAは押しつけない。

出力形式(厳守):
1行目: 「CATEGORY: pricing」または「CATEGORY: other」だけを書く
2行目: 「---」
3行目以降: そのまま送れる返信本文の完成形(宛名から書き出す)。末尾に下記の署名をそのまま入れる:
${SIGNATURE}`;

    let out = { failed: true };
    if (paidKey) out = await callGeminiModels(paidKey, models, [{ text: prompt }], "flash", false, 4096);
    if (out.failed) {
      const start = Math.floor(Math.random() * freeKeys.length);
      for (let i = 0; i < freeKeys.length; i++) {
        out = await callGeminiModels(freeKeys[(start + i) % freeKeys.length], models, [{ text: prompt }], "flash", false, 4096);
        if (!out.failed) break;
      }
    }
    if (out.failed) {
      console.error("inbound: AI生成失敗");
      await notifySuperMail("【メカノAI・要対応】受信メール(AI生成に失敗)",
        "AIの返信生成に失敗しました。手動で対応してください。\n\n差出人: " + fromEmail + "\n件名: " + subject + "\n本文:\n" + cleanBody);
      await inRef.set({ status: "要対応(生成失敗)" }, { merge: true });
      return res.status(200).send("ok");
    }

    // 出力パース(CATEGORY 行 → 本文)
    const rawTxt = String(out.text || "").trim();
    let category = "other", reply = rawTxt;
    const mm = rawTxt.match(/^\s*CATEGORY:\s*(pricing|other)\b/i);
    if (mm) { category = mm[1].toLowerCase(); reply = rawTxt.replace(/^[\s\S]*?---\s*/, "").trim(); }
    // 保険: 本文に料金系ワードがあれば pricing 扱いに寄せる(取りこぼし防止)
    if (category !== "pricing" && /(料金|価格|費用|見積|支払|契約|金額|割引|いくら|コスト)/.test(cleanBody)) category = "pricing";

    const replySubject = /^re:/i.test(subject) ? subject : ("Re: " + (subject || "お問い合わせの件"));

    if (category === "pricing") {
      // 料金/契約系 → 自動送信しない。運営が確認して手動返信。
      await inRef.set({ status: "要確認(料金)", category, draft: reply, leadId: leadId || null }, { merge: true });
      await notifySuperMail("【メカノAI・要確認】料金の質問が届きました（返信下書きあり）",
        "料金・契約に関するご質問のため、自動返信は行っていません。内容をご確認のうえ手動で返信してください。\n\n" +
        "▼差出人\n" + fromEmail + (lead ? "（" + (lead.company || "") + "）" : "") + "\n\n" +
        "▼相手の本文\n" + (cleanBody || "(本文なし)") + "\n\n" +
        "▼AIが用意した返信の下書き（このまま/修正して使えます）\n――――――\n" + reply + "\n――――――");
      await pushSuper("料金の質問が届きました", fromEmail + " さんから料金の質問。確認して返信してください。");
      return res.status(200).send("ok");
    }

    // それ以外 → AIの返信を自動送信
    const ok = await sendMail(fromEmail, replySubject, reply, replyAddr());
    await inRef.set({ status: ok ? "AI自動返信済み" : "送信失敗", category, reply, leadId: leadId || null }, { merge: true });
    if (ok) {
      await db.collection("salesOutbound").add({
        leadId: leadId || null, company: lead ? (lead.company || "") : "",
        email: fromEmail, subject: replySubject, body: reply, kind: "auto-reply", ts: Date.now(),
      });
      if (leadId) await db.collection("salesLeads").doc(leadId).set({ status: "商談中", updatedAt: Date.now() }, { merge: true });
      await pushSuper("AIが自動返信しました", fromEmail + " さんへ返信済み(料金以外)。");
    }
    return res.status(200).send("ok");
  });

/* =========================================================================
   営業ルーム(社内専用) — AI社員が働く疑似会社ツール。運営(super)専用。
   メカノAIを法人へ売り込むための「営業支援＋AI社員チーム」。
   POST {action, ...} :
     - "generate": {role, task, lead, history} → {text}  AI社員が提案文/メール/戦略等を生成
     - "listLeads": → {leads:[...]}                        見込み客一覧
     - "saveLead": {lead} → {id}                           見込み客を保存/更新
     - "delLead": {id} → {ok}                              見込み客を削除
   見込み客は salesLeads コレクションに保存(Admin SDK経由・ルール不要)。
   鍵はサーバー内のみ。営業文の送信・投稿は行わない(下書き生成まで)。
   ========================================================================= */

// メカノAIの製品情報(AI社員が営業トークに使う共有ナレッジ)。事実に基づいて話させる土台。
const PRODUCT_KB = `【製品】メカノAI（MECHANO-AI）— 自動車・トラック整備士向けの現場ツール(PWA)。
【提供元】Cablueie（読み: カブリエ）。
【アプリURL】https://mechanoai-cablueie.com/ ← これは"アプリ本体"のURL（体験・紹介用）。★お問い合わせ先ではない。
【重要】このURLを文面に載せるときは「アプリ体験・詳細はこちら」等と書く。絶対に「お問い合わせ先」「連絡先」として書かない。
問い合わせ・申込みの宛先は、営業担当自身の署名欄（[会社名/担当者名/電話/メール]のプレースホルダ）を使うこと。
【主な機能】
・車検証をQR/カメラでスキャン → 車両情報を即取得
・メンテナンス諸元(締付トルク・オイル粘度/量・各種容量)をAIが即表示
・故障診断/修理サポート(DTC・症状から原因と対処をAIが提案。裏取り検索対応)
・整備カルテ(作業記録・写真・担当者管理。カルテは担当者のみ編集可)
・法人向けクラウド同期(店舗内で車両DB・記録を共有。席指名・端末管理)
【料金(法人)】3プラン。①NA: 月¥7,980/年¥86,000(AI検索なし)。②ターボ: 月¥12,800/年¥138,000(月500回検索)。③ツインターボ: 月¥19,800/年¥198,000(検索無制限・指名3席、4席目〜+¥3,000/月)。端末追加も可。年額は約2か月分お得。
【無料トライアル】法人はご契約から7日間無料。期間中は自社の実データで全機能を試せ、初回請求は8日目から。カード登録なしでも開始できる（クロージングの後押しに使える強力な材料）。
【体験デモ】ログイン不要で操作を体験できる無料デモがある → https://mechanoai-cablueie.com/?demo=1 （サンプルの軽トラで、スキャン→諸元→診断→カルテを実際に触れる。ガイド付き）。営業文では「まず無料で触ってみてください」と案内可。
【お申し込み専用フォーム】1分で申し込める短いフォーム → https://mechanoai-cablueie.com/apply.html 。★メールで「申し込む・話を進めたい」相手にはLPではなくこのフォームへ誘導する（本文で説明済みなので、行動導線はフォームに集約）。?plan=turbo 等でプラン事前選択も可。
【法人向けLP】機能・料金・導入の流れ・FAQをまとめたページ → https://mechanoai-cablueie.com/biz.html （じっくり検討したい人向けの詳細ページ。まだ迷っている相手のみ案内）。
【サービス紹介資料】そのまま送れる資料ページ（印刷・PDF化も可）→ https://mechanoai-cablueie.com/shiryou.html 。★「資料請求」への返信では、この資料リンクを必ず案内する（相手はここで機能・料金・会社概要をまとめて確認できる）。
【個人版】App Store/Google Playで提供予定。基本無料。
【多言語対応】画面は日本語・英語に対応。外国人スタッフや技能実習生でも使え、人手不足の現場で戦力化しやすい（人手不足の訴求と直結する強み）。
【安心材料】特定商取引法に基づく表記・プライバシーポリシーを公開済み。訪問営業や電話勧誘はしない方針（問い合わせは相手が選んだ手段のみ）。
【強み】現場の紙作業・調べ物を削減。車検証から一気通貫。最新Geminiで高精度。整備士目線のUI。`;

// 時事ネタ(営業トークのフック)。使えるものだけ自然に織り込ませる。誇張・古い断定はしない。
const NEWS_KB = `【営業に使える時事の背景(2026年時点)】
・整備士不足/高齢化【最重要・主軸】: 自動車整備士は人手不足と高齢化が深刻。若手が入らず、ベテランの退職で技術継承が課題。メカノAIは「ベテランの勘・経験に頼っていた“調べ物”を標準化し、入って間もない若手でも締付トルクや諸元に即到達＝即戦力化」できる。教育・OJTの負担も軽くなる。この『人手不足の解消／若手の即戦力化』は、特に断りがなければ全ての営業文で主軸の訴求として前面に出す。
・物流2024年問題の余波: ドライバー・車両の稼働を止められない運送/GS併設整備では、点検整備の効率化・ダウンタイム短縮の価値が高い。
・電子化/DX圧力: 車検証の電子化(ICタグ)、点検記録のデジタル化の流れ。紙・手書き作業からの脱却ニーズ。
・車両の高度化: 電動車(HV/EV)や先進安全装備の普及で、参照すべき整備情報・締付トルク/専用手順が増加。都度調べる負担が増えている。
・GS併設整備の事情: 給油客対応と整備を少人数で回すため、1人当たりの生産性・段取りの速さが死活的。車検証から一気に情報を出せる価値が大きい。
使い方: 相手の業種に合うものを1つだけ自然に触れる。ニュースの受け売りにせず「だからメカノAIが効く」に必ず着地させる。数値の断定や古い統計の捏造はしない。`;

// コールドメール(飛び込みメール)作成ルール。特定電子メール法に準拠させるための固定要件と署名。
// ★署名ブロックは事実情報。改変せずそのまま末尾に付けること。
const COLD_EMAIL_GUIDE = `【コールドメール(初回営業メール)を書くときの必須ルール — 特定電子メール法に準拠】
1. 件名は誇大・釣りにしない。会社名や用件が分かる簡潔なものにする（例：整備現場の調べ物を減らすツールのご案内／メカノAI）。
2. 本文は短く（読むのに30秒）。「相手の課題→メカノAIで解決→興味あれば返信/LP」の流れ。押し売り・不安を煽る表現は禁止。
3. 相手が企業サイト等に公開しているアドレス宛を想定。売り込みは1リンク（LP）に集約する。
4. 本文末尾に、まず下記の【配信停止の一文】を入れ、その直後に共通署名（後述のSIGNATURE）をそのまま付ける（削除・改変しない）。配信停止の導線が無いと違法。
5. URLは「アプリ体験・詳細はこちら」等と書く。お問い合わせ先はメール（署名内）。虚偽の実績・数値は書かない。

【配信停止の一文（コールドメールのみ、署名の直前に入れる）】
本メールは、貴社が公開されている連絡先へ、整備業向けツールのご案内としてお送りしています。今後の配信を希望されない場合は、本メールに「配信停止」とご返信ください。以後お送りしません。`;

// メール共通署名（実データ・固定）。★[会社名]等のプレースホルダは絶対に使わず、この実際の情報をそのまま書く。
const SIGNATURE = `【メール署名（実データ・固定）。メール類の末尾に必ずこのまま入れる。[会社名]/[担当者名]/[電話番号]/[メールアドレス] のようなプレースホルダは絶対に使わない】
――――――――――――
メカノAI（MECHANO-AI）
Cablueie（カブリエ）　担当：中江
〒894-0062 鹿児島県奄美市名瀬有屋町36-2
TEL：080-3692-0101　Mail：cablueie.123@gmail.com
お申し込み（専用フォーム・1分）：https://mechanoai-cablueie.com/apply.html
サービス詳細（LP）：https://mechanoai-cablueie.com/biz.html
――――――――――――`;

// AI社員(疑似会社の各部門)。role → {name, sys}
const SALES_STAFF = {
  bucho: {
    name: "営業部長 剛田",
    sys: "あなたはメカノAI販売会社の営業部長。B2B法人営業(自動車整備工場・運送会社・ディーラー)のプロ。戦略立案・優先順位付け・商談の進め方・切り返しトークを、現実的で具体的に指示する。精神論でなく数字と手順で語る。",
  },
  writer: {
    name: "セールスライター 文乃",
    sys: "あなたはメカノAI販売会社のセールスライター。整備工場の経営者・工場長に響く提案メール/DM/チラシ文面を書く。専門用語を使いすぎず、導入メリット(時間短縮・ミス削減・若手教育)を具体的に。CTA(無料デモ・問い合わせ)で締める。過度な誇張・虚偽は書かない。",
  },
  marke: {
    name: "マーケ担当 舞",
    sys: "あなたはメカノAI販売会社のマーケティング担当。ターゲット選定・訴求軸・チャネル(展示会/SNS/紹介/飛び込み)・キャンペーン案を出す。ペルソナと数値目標を意識し、施策を箇条書きで実行可能な形にする。",
  },
  cs: {
    name: "カスタマーサクセス 円",
    sys: "あなたはメカノAI販売会社のカスタマーサクセス担当。導入後の質問・クレーム・解約防止に対応。落ち着いた丁寧な口調で、手順を分かりやすく案内する。製品KBの範囲で正確に答え、不明点は運営に確認と案内する。",
  },
  bell: {
    name: "商談ロープレ相手",
    sys: "あなたは整備工場の“渋い”経営者役。営業担当(ユーザー)の商談練習相手として、値段・使いこなせるか・既存のやり方で十分では、という現実的な反論をする。最後に良かった点と改善点を1つずつフィードバックする。",
  },
};

async function isSuper(uid) {
  if (!uid) return false;
  try {
    const u = (await admin.firestore().collection("users").doc(uid).get()).data();
    return !!u && u.role === "super";
  } catch (e) { return false; }
}

exports.salesRoom = functions.runWith({ timeoutSeconds: 120, memory: "512MB" }).region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  const uid = await uidFromReq(req);
  if (!(await isSuper(uid))) return res.status(403).json({ error: "運営(super)専用の機能です。" });
  const db = admin.firestore();
  const data = req.body || {};
  const action = data.action || "generate";

  // ---- 見込み客リスト(CRUD) ----
  if (action === "listLeads") {
    const snap = await db.collection("salesLeads").orderBy("updatedAt", "desc").limit(500).get();
    return res.json({ leads: snap.docs.map((d) => Object.assign({ id: d.id }, d.data())) });
  }
  if (action === "saveLead") {
    const l = data.lead || {};
    const doc = {
      company: String(l.company || "").slice(0, 200),
      contact: String(l.contact || "").slice(0, 120),
      phone: String(l.phone || "").slice(0, 60),
      email: String(l.email || "").slice(0, 200),
      kind: String(l.kind || "").slice(0, 60),        // 整備工場/運送/ディーラー 等
      status: String(l.status || "見込み").slice(0, 40), // 見込み/アプローチ中/商談/契約/見送り
      note: String(l.note || "").slice(0, 4000),
      updatedAt: Date.now(),
    };
    let ref;
    if (l.id) { ref = db.collection("salesLeads").doc(l.id); await ref.set(doc, { merge: true }); }
    else { doc.createdAt = Date.now(); ref = await db.collection("salesLeads").add(doc); }
    return res.json({ id: ref.id });
  }
  if (action === "delLead") {
    if (data.id) await db.collection("salesLeads").doc(String(data.id)).delete();
    return res.json({ ok: true });
  }

  // ---- 自動送信(ドリップ)の設定 ----
  if (action === "getConfig") {
    const c = (await db.collection("salesConfig").doc("main").get()).data() || {};
    const sgReady = !!(cfg().sendgrid.key && cfg().sendgrid.from);
    return res.json({ config: { dripEnabled: !!c.dripEnabled, dripPerDay: c.dripPerDay || 3 }, sgReady: sgReady });
  }
  if (action === "setConfig") {
    const c = data.config || {};
    await db.collection("salesConfig").doc("main").set({
      dripEnabled: !!c.dripEnabled,
      dripPerDay: Math.min(Math.max(parseInt(c.dripPerDay, 10) || 3, 1), 20),
      updatedAt: Date.now(),
    }, { merge: true });
    return res.json({ ok: true });
  }

  // ---- 法人LPからの問い合わせ受信(inbound) ----
  if (action === "listInquiries") {
    const snap = await db.collection("bizInquiries").orderBy("createdAt", "desc").limit(300).get();
    return res.json({ inquiries: snap.docs.map((d) => Object.assign({ id: d.id }, d.data())) });
  }
  if (action === "inquiryStatus") {
    if (data.id) await db.collection("bizInquiries").doc(String(data.id)).set({ status: String(data.status || "対応中").slice(0, 40) }, { merge: true });
    return res.json({ ok: true });
  }
  if (action === "delInquiry") {
    if (data.id) await db.collection("bizInquiries").doc(String(data.id)).delete();
    return res.json({ ok: true });
  }
  if (action === "inquiryToLead") {
    const q = data.id ? (await db.collection("bizInquiries").doc(String(data.id)).get()).data() : null;
    if (!q) return res.status(404).json({ error: "問い合わせが見つかりません。" });
    const doc = {
      company: (q.company || "").slice(0, 200), contact: (q.name || "").slice(0, 120),
      phone: (q.phone || "").slice(0, 60), email: (q.email || "").slice(0, 200),
      kind: (q.kind || "").slice(0, 60), status: "アプローチ中",
      note: ("【LP問い合わせ】" + (q.plan ? "関心プラン:" + q.plan + " / " : "") + (q.message || "")).slice(0, 4000),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    const ref = await db.collection("salesLeads").add(doc);
    await db.collection("bizInquiries").doc(String(data.id)).set({ status: "見込み客化" }, { merge: true });
    return res.json({ id: ref.id });
  }

  // ---- 契約者アカウントの直接発行(ログインID＋パスワード＋QR＋案内メール)。自動返信と同じ処理を共用 ----
  if (action === "issueAccount") {
    const company = String(data.company || "").trim();
    const name = String(data.name || "").trim();
    const email = String(data.email || "").trim().toLowerCase();
    const plan = String(data.plan || "ターボ");
    if (!company || !email) return res.status(400).json({ error: "会社名とメールアドレスは必須です。" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "メールアドレスの形式が正しくありません。" });
    const acc = await issueContractAccount(db, { company, name, email, plan });
    let sent = false;
    if (data.send === true) { try { await sendMail(acc.email, acc.subject, acc.body, replyAddr()); sent = true; } catch (e) {} }
    return res.json({ ok: true, loginId: acc.loginId, email: acc.email, password: acc.password, planLabel: acc.planLabel, tid: acc.tid, corpUrl: acc.corpUrl, qrUrl: acc.qrUrl, subject: acc.subject, body: acc.body, sent: sent });
  }

  // ---- 営業コンソールから直接メール送信 ----
  if (action === "sendMail") {
    const to = String(data.to || "").trim().toLowerCase();
    const subject = (String(data.subject || "").replace(/\s+/g, " ").trim().slice(0, 200)) || "メカノAI のご案内";
    let body = String(data.body || "").replace(/\r\n/g, "\n").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "送信先メールアドレスが正しくありません。" });
    if (!body) return res.status(400).json({ error: "本文が空です。" });
    if (body.indexOf("――") < 0) body += "\n\n" + MAIL_SIGN;   // 署名が無ければ付与(差出人・連絡先)
    try { await sendMail(to, subject, body, replyAddr()); }
    catch (e) { return res.status(502).json({ error: "送信に失敗しました: " + (e.message || String(e)) }); }
    if (data.leadId) { try { await db.collection("salesLeads").doc(String(data.leadId)).set({ status: "アプローチ中", lastMailAt: Date.now(), updatedAt: Date.now() }, { merge: true }); } catch (e) {} }
    return res.json({ ok: true, sent: true });
  }

  // ---- AI社員による生成 ----
  const staff = SALES_STAFF[data.role] || SALES_STAFF.bucho;
  const freeKeys = cfg().geminiFree || [];
  const paidKey = cfg().geminiPaid && cfg().geminiPaid.key;
  if (!freeKeys.length) return res.status(500).json({ error: "サーバーのGeminiキーが未設定です。" });
  const latest = await latestModels(freeKeys[0]);
  const models = uniq([latest.flash, "gemini-flash-latest", "gemini-2.0-flash"]);

  const lead = data.lead || null;
  const leadBlock = lead ? `\n【対象の見込み客】\n会社名:${lead.company || "-"} / 業種:${lead.kind || "-"} / 担当:${lead.contact || "-"} / 状況:${lead.status || "-"}\nメモ:${lead.note || "-"}\n` : "";
  const hist = Array.isArray(data.history) ? data.history.slice(-8) : [];
  const histBlock = hist.length ? "\n【これまでのやりとり】\n" + hist.map((h) => (h.role === "user" ? "指示" : staff.name) + ": " + String(h.text || "").slice(0, 1200)).join("\n") + "\n" : "";

  const prompt = `${staff.sys}

以下は取り扱う製品の正確な情報です。ここに書かれた事実のみを根拠に話し、値段や機能をでっち上げないこと。
${PRODUCT_KB}

${NEWS_KB}

${COLD_EMAIL_GUIDE}

${SIGNATURE}
${leadBlock}${histBlock}
【あなたへの指示】
${String(data.task || "").slice(0, 4000)}

出力ルール: 日本語。すぐ使える具体的な内容。提案文やメールを頼まれたらそのまま送れる完成形で。前置きの挨拶や「承知しました」は不要。
署名ルール: メール・DM・手紙を作る時は、末尾に必ず上記SIGNATUREの実データ署名（メカノAI／Cablueie（カブリエ）／担当:中江／TEL:080-3692-0101／Mail:cablueie.123@gmail.com／URL）をそのまま入れる。[会社名][担当者名][電話番号][メールアドレス] のようなプレースホルダは絶対に使わない。
訴求の主軸: 特に別の指定がない限り、『整備士の人手不足の解消』と『若手を即戦力化できる（ベテランの調べ物を標準化し、経験の浅いスタッフでも諸元・トルクに即到達）』を中心メッセージに据え、冒頭でこの課題に触れてから解決策としてメカノAIを提示する。ただし誇張や虚偽は書かない。`;

  const parts = [{ text: prompt }];
  // まず有料キー(あれば)→ ダメなら無料キーを順に試す
  let out = { failed: true };
  if (paidKey) out = await callGeminiModels(paidKey, models, parts, "flash", false, 8192);
  if (out.failed) {
    const start = Math.floor(Math.random() * freeKeys.length);
    for (let i = 0; i < freeKeys.length; i++) {
      out = await callGeminiModels(freeKeys[(start + i) % freeKeys.length], models, parts, "flash", false, 8192);
      if (!out.failed) break;
    }
  }
  if (out.failed) return res.status(503).json({ error: "AIが混みあっています。少し待って再度お試しください。" });
  return res.json({ text: out.text, truncated: !!out.truncated, staff: staff.name });
});

/* =========================================================================
   法人LP(biz.html)からの資料請求・デモ申込を受け付ける公開エンドポイント。
   認証不要(誰でも送信可)。運営(super)にプッシュ通知し、bizInquiries に保存。
   POST {company, name, email, phone, kind, plan, message, hp(ハニーポット)}
   ========================================================================= */
exports.bizInquiry = functions.region(REGION).https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ。" });
  const d = req.body || {};
  // ボット対策: 非表示欄(hp)に入力があれば黙って成功を返す(保存しない)
  if (String(d.hp || "").trim()) return res.json({ ok: true });

  const clean = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
  const company = clean(d.company, 200), name = clean(d.name, 120);
  const email = clean(d.email, 200), phone = clean(d.phone, 60);
  const kind = clean(d.kind, 60), plan = clean(d.plan, 40), message = clean(d.message, 4000);
  // 申込の種類: contract=契約手続きを進めたい / doc=資料・デモ希望(既定)
  const intent = clean(d.intent, 20) === "contract" ? "contract" : "doc";
  if (!company || !name) return res.status(400).json({ error: "会社名とお名前は必須です。" });
  if (!email && !phone) return res.status(400).json({ error: "メールまたは電話のいずれかは必須です。" });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "メールアドレスの形式が正しくありません。" });

  const db = admin.firestore();
  try {
    // 簡易レート制限: 同一メール/電話が直近1分に3件以上なら弾く(いたずら連投防止)
    const since = Date.now() - 60000;
    const recent = await db.collection("bizInquiries").where("createdAt", ">=", since).get();
    let dup = 0; recent.forEach((x) => { const q = x.data(); if ((email && q.email === email) || (phone && q.phone === phone)) dup++; });
    if (dup >= 3) return res.status(429).json({ error: "送信が多すぎます。しばらくして再度お試しください。" });

    const inqRef = await db.collection("bizInquiries").add({
      company, name, email, phone, kind, plan, message, intent,
      status: intent === "contract" ? "申込希望" : "新規", source: "biz-lp",
      ua: clean(req.headers["user-agent"], 300),
      createdAt: Date.now(),
    });

    // ② 自動返信。申込の種類で分岐。契約希望かつメール有→専用リンクを自動発行(完全自動)。
    let provisioned = false;
    if (email) {
      const head = name + " 様" + (company ? "（" + company + "）" : "") + "\n\n";
      const planLine = plan ? "【ご関心のプラン】" + plan + "\n" : "";
      const msgLine = message ? "【ご記入内容】\n" + message + "\n\n" : "";
      const appUrl = (cfg().app.url || "https://mechanoai-cablueie.com/").replace(/\/?$/, "/");

      if (intent === "contract" && cfg().stripe.secret) {
        // 契約希望 → テナント＋7日トライアル＋Authユーザー＋初期パスワードを自動発行し、
        // ログインID・初期パスワード・アプリQR入りの案内メールを自動返送(運営の手作業ゼロ)。
        try {
          const acc = await issueContractAccount(db, { company, name, email, plan });
          provisioned = true;
          sendMail(email, acc.subject, acc.body, replyAddr()).catch(() => {});
        } catch (e) {
          console.error("契約自動発行エラー", e);
        }
      }

      if (!provisioned) {
        // 資料・デモ希望、または契約自動発行できなかった場合のフォールバック
        const subject = "【メカノAI】お問い合わせありがとうございます（自動返信）";
        const ack = head +
          "この度はメカノAIへお問い合わせ・資料請求いただきありがとうございます。\n" +
          "以下の内容で受け付けました。担当より2営業日以内にご連絡いたします。\n\n" +
          planLine + msgLine +
          "まずは、機能・料金・導入の流れをまとめた法人向けページをご覧ください。\n" +
          "▼メカノAI 法人向けページ\n" + appUrl + "biz.html\n\n" +
          "・詳しいサービス紹介資料（PDF）のご送付や、実際の操作を体験できるデモをご希望の場合は、\n" +
          "　お手数ですが本メールにそのままご返信ください。折り返しご案内・発行いたします。\n\n" +
          "※ご契約から7日間は無料でお試しいただけます（実データのまま全機能・初回請求は8日目から）。\n\n" +
          "※本メールは送信専用の自動返信ではありません。ご返信いただければ担当（またはAIアシスタント）がご対応します。\n\n" +
          MAIL_SIGN;
        sendMail(email, subject, ack, replyAddr()).catch(() => {});
      }
    }
    if (provisioned) { try { await inqRef.set({ status: "自動発行済み" }, { merge: true }); } catch (e) {} }

    // 運営(super)にプッシュ通知
    try {
      const supers = await db.collection("users").where("role", "==", "super").get();
      const tokens = [];
      supers.forEach((u) => (u.data().fcmTokens || []).forEach((t) => t && tokens.push(t)));
      const uniqTokens = [...new Set(tokens)];
      if (uniqTokens.length) {
        await admin.messaging().sendEachForMulticast({
          tokens: uniqTokens,
          notification: {
            title: intent === "contract" ? "メカノAI 【契約】法人申込" : "メカノAI 法人問い合わせ",
            body: company + " / " + name + " さんから" +
              (intent === "contract"
                ? (provisioned ? "契約申込→専用リンクを自動発行しました。" : "契約手続きの希望が届きました（要対応）。")
                : "資料請求・デモ申込が届きました。") + (plan ? " プラン:" + plan : ""),
          },
          webpush: { fcmOptions: { link: "/sales.html" } },
        });
      }
    } catch (e) { console.error("問い合わせ通知エラー", e); }

    return res.json({ ok: true });
  } catch (e) {
    console.error("bizInquiry保存エラー", e);
    return res.status(500).json({ error: "送信に失敗しました。時間をおいて再度お試しください。" });
  }
});
