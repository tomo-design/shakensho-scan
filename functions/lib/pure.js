"use strict";
/* 依存のない純粋ロジック。index.js から利用し、Jestで単体テストする。
   ここには Firebase/Stripe/network に触れない関数だけを置く(テスト容易性のため)。 */

/* 契約プラン → 検索上限・席数の決定。旧データ(aiPaidFallback)互換も含む。 */
function planConfig(t) {
  t = t || {};
  let plan = t.aiPlan;
  if (!plan) plan = (t.aiPaidFallback === true) ? "twinturbo" : "na";   // 旧データ互換(有料ON=無制限扱い)
  if (plan === "turbo") return { plan: "turbo", searchCap: 500, seats: 0 };
  if (plan === "twinturbo") return { plan: "twinturbo", searchCap: -1, seats: Math.max(1, +(t.searchSeats || 3)) };
  return { plan: "na", searchCap: 0, seats: 0 };
}

/* Stripeの priceId から契約ティア(na/turbo/twinturbo)を逆引き。prices は cfg().stripe.prices 形。 */
function tierFromPriceId(pid, prices) {
  if (!pid || !prices) return "";
  for (const code of ["na", "turbo", "twinturbo"]) {
    const p = prices[code];
    if (p && (p.month === pid || p.year === pid)) return code;
  }
  return "";
}

/* Geminiモデル名リストから、正規表現に一致する中で最も新しいバージョンを選ぶ。
   例: ["gemini-2.5-flash","gemini-3-flash-preview"] → "gemini-3-flash-preview"。 */
function pickHighestModel(names, re) {
  let best = "", bestV = -1;
  for (const n of (names || [])) {
    const m = String(n).match(re);
    if (m) { const v = parseFloat(m[1]); if (v > bestV) { bestV = v; best = n; } }
  }
  return best;
}

// index.jsが使う正規表現(flash/pro。previewも対象)。テストと本番で同じ定義を共有する。
const FLASH_RE = /^gemini-(\d+(?:\.\d+)?)-flash(?:-preview)?$/;
const PRO_RE = /^gemini-(\d+(?:\.\d+)?)-pro(?:-preview)?$/;

/* JSTの年月(YYYY-MM)。使用回数の月次集計キー。now を渡せるようにしテスト可能に。 */
function jstMonth(now) {
  return new Date((now == null ? Date.now() : now) + 9 * 3600 * 1000).toISOString().slice(0, 7);
}

/* JSTの暦日(1日)の範囲[from,to)をUTCミリ秒で返す。offsetDays=-1で「昨日」。
   日報の集計境界をJSTで揃えるために使う。label は "YYYY-MM-DD"(JST)。 */
function jstDayRange(now, offsetDays) {
  const JST = 9 * 3600 * 1000;
  const day = Math.floor(((now == null ? Date.now() : now) + JST) / 86400000) + (offsetDays || 0);
  const from = day * 86400000 - JST;
  return { from: from, to: from + 86400000, label: new Date(day * 86400000).toISOString().slice(0, 10) };
}

/* JSTの日付(YYYY-MM-DD)。 */
function jstDay(now) { return jstDayRange(now, 0).label; }

/* 無料お試しの残日数。アプリ画面の表示(ceil)と必ず一致させる。 */
function trialDaysLeft(paidUntil, now) {
  return Math.ceil(((Number(paidUntil) || 0) - (now == null ? Date.now() : now)) / 86400000);
}

/* 無料お試しの満了案内を「どの段階として送るか」。送らない場合は ""。
   pre  = 満了前(残り1〜3日)
   end  = 満了直後(当日〜翌日)
   last = 最後のご案内(満了から2〜7日)
   幅を持たせているのは、定期実行が1日飛んでも取りこぼさないようにするため
   (残り2日ちょうどで判定すると、その日に失敗したら永久に送られない)。 */
function trialStage(paidUntil, now) {
  if (!(Number(paidUntil) || 0)) return "";
  const d = trialDaysLeft(paidUntil, now);
  if (d >= 1 && d <= 3) return "pre";
  if (d <= 0 && d >= -1) return "end";
  if (d <= -2 && d >= -7) return "last";
  return "";
}

/* 顧客の状態から「今日どの案内を送るか」を1つだけ決める。送らない場合は ""。
   t は tenants ドキュメント(plan / paidUntil / provisionedAt / payFail)。
   優先順は「お金の話 → 使い方の話」。同じ日に2通送らないため、必ず1つに絞る。
     payfail  = 決済に失敗した(Webhookが記録。サービスは止めないので、知らせないと回収できない)
     pre/end/last = 無料お試しの満了前・満了直後・最後の案内(trialStage)
     onboard1/3   = 使い始めの案内(申込から1〜2日目 / 3〜4日目)
     win14/win45  = 失効してから14日後・45日後の再接触
   窓に幅を持たせているのは、定期実行が1日飛んでも取りこぼさないため。 */
function lifecycleStage(t, now) {
  t = t || {};
  const D = 86400000;
  const ms = (now == null ? Date.now() : now);
  if (t.payFail && t.payFail.invoiceId) return "payfail";
  const plan = t.plan || "";
  const until = Number(t.paidUntil) || 0;
  if (plan === "active") return "";                     // 支払い済みで正常。何も送らない
  if (plan === "trial") {
    const ts = trialStage(until, ms);
    if (ts) return ts;                                  // 満了の話があるときは、そちらを優先
    const from = Number(t.provisionedAt) || 0;
    if (from) {
      const age = ms - from;
      if (age >= 1 * D && age < 3 * D) return "onboard1";
      if (age >= 3 * D && age < 5 * D) return "onboard3";
    }
  }
  // 失効後の再接触。無料のまま終わったPocket(planはtrialのまま)と、停止した契約の両方が対象。
  if (until && (plan === "trial" || plan === "suspended")) {
    const lapsed = ms - until;
    if (lapsed >= 14 * D && lapsed < 28 * D) return "win14";
    if (lapsed >= 45 * D && lapsed < 75 * D) return "win45";
  }
  return "";
}

/* Stripeのサブスク1件を月額(円)に正規化する。年額は1/12にする。
   JPYはStripeのゼロ十進通貨なので unit_amount がそのまま円。 */
function monthlyAmountFromSub(sub) {
  let yen = 0;
  for (const it of (((sub || {}).items || {}).data || [])) {
    const pr = it.price || {}, rec = pr.recurring || {};
    const months = rec.interval === "year" ? 12 * (Number(rec.interval_count) || 1)
      : rec.interval === "month" ? (Number(rec.interval_count) || 1)
      : rec.interval === "week" ? (Number(rec.interval_count) || 1) / 4.345
      : rec.interval === "day" ? (Number(rec.interval_count) || 1) / 30.4 : 0;
    if (months <= 0) continue;
    yen += (Number(pr.unit_amount) || 0) * (Number(it.quantity) || 1) / months;
  }
  return Math.round(yen);
}

module.exports = { planConfig, tierFromPriceId, pickHighestModel, FLASH_RE, PRO_RE, jstMonth, lifecycleStage,
  jstDayRange, jstDay, trialDaysLeft, trialStage, monthlyAmountFromSub };
