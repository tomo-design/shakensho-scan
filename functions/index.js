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
});
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
async function callGeminiModels(key, models, parts, mode, search, maxTokens) {
  let lastErr = "", quota = false;
  for (const model of models) {
    const gc = { temperature: 0.2, maxOutputTokens: maxTokens || 16384 };
    // 思考トークン制御(2.5系・3系・-latest)。flash=512(3系は0が400・128だと空応答になり得るため余裕を持たせる)、pro=-1(動的)。2.0系は非対応。
    if (/gemini-(2\.5|3(\.\d+)?)[-.]/.test(model) || model.indexOf("-latest") >= 0) {
      gc.thinkingConfig = { thinkingBudget: mode === "pro" ? -1 : 512 };
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
    return { text: text, truncated: cand.finishReason === "MAX_TOKENS" };
  }
  return { failed: true, quota: quota, lastErr: lastErr };
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
  const mode = data.mode === "pro" ? "pro" : "flash";
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

  const pc = planConfig(g.t);   // プラン: na(検索なし)/turbo(月500)/twinturbo(無制限・席数)
  const paidCapable = pc.plan !== "na" && !!paidKey;   // ターボ/ツインターボ=有料キー利用可(Pro・検索)
  const freeModels = uniq([latest.flash, "gemini-flash-latest", "gemini-2.0-flash"]);   // 無料キーはFlashのみ(Proは無料枠429)

  // 検索(裏取り)を実際に使えるか: 検索対応プラン && 今月上限内 && 席内。不可なら検索なしに落として必ず回答を返す。
  let effSearch = false;
  if (data.search && paidCapable && pc.searchCap !== 0) {
    const overCap = pc.searchCap > 0 && (await paidCountThisMonth(g.tid)) >= pc.searchCap;   // ターボ=月500回
    const seatOk = pc.seats > 0 ? await claimSeat(g.tid, uidReq, pc.seats) : true;           // ツインターボ=席数
    effSearch = !overCap && seatOk;
  }
  // 有料キーで実行する条件: 検索する / 契約店舗(ターボ以上)が Pro(高精度診断)を要求。na=常に無料Flash。
  const usePaid = paidCapable && (effSearch || mode === "pro");

  let out = { failed: true, quota: true }, tier = "free", freeExhausted = false;

  // ① 有料キー(検索付き or Pro)。検索は無料枠では通らないので契約店舗のみここを通る。
  if (usePaid) {
    out = await callGeminiModels(paidKey, models, parts, mode, effSearch, maxTokens);
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
      out = await callGeminiModels(key, freeModels, parts, "flash", false, maxTokens);
      if (out.httpErr) return res.status(502).json({ error: "AI応答エラー (" + out.httpErr + ")" });
      if (!out.failed) break;
      if (!out.quota) break;
    }
    if (out.failed && out.quota) {
      freeExhausted = true; await markFreeExhausted(g.tid);
      if (paidKey) { out = await callGeminiModels(paidKey, freeModels, parts, "flash", false, maxTokens); if (!out.failed) tier = "paid"; }
      if (out.failed) return res.status(429).json({ error: "ただいまAIが混み合っています。時間をおいて再度お試しください。", freeExhausted: true });
    } else if (out.failed) {
      return res.status(502).json({ error: "AIから回答が得られませんでした (" + out.lastErr + ")" });
    }
  }
  if (tier === "free") clearFreeExhausted(g.tid);
  return res.json({ text: out.text, truncated: out.truncated, tier: tier, freeExhausted: freeExhausted });
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
  if (!me || me.active !== true) return res.status(403).json({ error: "有効なアカウントではありません。" });
  const isSuper = me.role === "super";
  const isAdmin = me.role === "admin";
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
    // 請求書送付方式のサブスク。請求書ページでカード/銀行振込/コンビニを選べる。
    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
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
    let inv = sub.latest_invoice;
    if (inv && inv.status === "draft") { try { inv = await stripe.invoices.finalizeInvoice(inv.id); } catch (e) {} }
    if (inv && inv.id) { try { await stripe.invoices.sendInvoice(inv.id); } catch (e) {} }   // メール送付
    const url = inv && (inv.hosted_invoice_url || null);
    return res.json({ url: url, invoiceSent: true });
  } catch (e) {
    return res.status(500).json({ error: "請求書の作成に失敗: " + (e.message || e) });
  }
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
      // 購入プラン(N/A・ターボ・ツインターボ)を店舗に反映(検索上限/席数の切替)。
      if (tier) { patch.aiPlan = tier; patch.aiPaidFallback = (tier !== "na"); }
      await ref.set(patch, { merge: true });
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
  try {
    const o = event.data.object;
    if (event.type === "checkout.session.completed") {
      const tid = (o.metadata && o.metadata.tenantId) || o.client_reference_id;
      let until = null, tier = "";
      if (o.subscription) { try { const sub = await stripe.subscriptions.retrieve(o.subscription); until = sub.current_period_end * 1000; tier = tierOfSub(sub); } catch (e) {} }
      await setPlan(tid, true, until, tier);
    } else if (event.type === "invoice.paid") {
      // 支払い確定(カードは即時、コンビニ/銀行振込は入金後)で契約を有効化
      let tid = (o.subscription_details && o.subscription_details.metadata && o.subscription_details.metadata.tenantId) || (o.metadata && o.metadata.tenantId);
      let tier = ""; try { tier = tierFromPriceId(o.lines.data[0].price.id); } catch (e) {}
      if (!tid && o.subscription) { try { const sub = await stripe.subscriptions.retrieve(o.subscription); tid = sub.metadata.tenantId; if (!tier) tier = tierOfSub(sub); } catch (e) {} }
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
    } else if (event.type === "customer.subscription.updated") {
      const tid = o.metadata && o.metadata.tenantId;
      // past_due/unpaid等の一時状態(再請求中)では止めない。canceled/失効のみ停止扱い。
      const ended = o.status === "canceled" || o.status === "incomplete_expired";
      await setPlan(tid, !ended, o.current_period_end ? o.current_period_end * 1000 : null, ended ? "" : tierOfSub(o));
    }
  } catch (e) { console.error("webhook処理エラー", e); }
  return res.json({ received: true });
});
