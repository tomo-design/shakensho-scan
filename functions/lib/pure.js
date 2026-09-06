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

module.exports = { planConfig, tierFromPriceId, pickHighestModel, FLASH_RE, PRO_RE, jstMonth };
