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
