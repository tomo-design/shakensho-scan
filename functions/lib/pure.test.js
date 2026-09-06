"use strict";
const { planConfig, tierFromPriceId, pickHighestModel, FLASH_RE, PRO_RE, jstMonth } = require("./pure");

describe("planConfig", () => {
  test("NA=検索なし", () => {
    expect(planConfig({ aiPlan: "na" })).toEqual({ plan: "na", searchCap: 0, seats: 0 });
  });
  test("ターボ=月500・席0", () => {
    expect(planConfig({ aiPlan: "turbo" })).toEqual({ plan: "turbo", searchCap: 500, seats: 0 });
  });
  test("ツインターボ=無制限・席は最低1・既定3", () => {
    expect(planConfig({ aiPlan: "twinturbo" })).toEqual({ plan: "twinturbo", searchCap: -1, seats: 3 });
    expect(planConfig({ aiPlan: "twinturbo", searchSeats: 5 }).seats).toBe(5);
    expect(planConfig({ aiPlan: "twinturbo", searchSeats: 0 }).seats).toBe(3); // 0はfalsyのため既定3
    expect(planConfig({ aiPlan: "twinturbo", searchSeats: -2 }).seats).toBe(1); // 負数はMath.maxで1に丸め
  });
  test("旧データ互換: aiPaidFallback=true は twinturbo 扱い", () => {
    expect(planConfig({ aiPaidFallback: true }).plan).toBe("twinturbo");
  });
  test("未設定/空/nullは na にフォールバック", () => {
    expect(planConfig({}).plan).toBe("na");
    expect(planConfig(null).plan).toBe("na");
    expect(planConfig(undefined).plan).toBe("na");
  });
});

describe("tierFromPriceId", () => {
  const prices = {
    na: { month: "price_na_m", year: "price_na_y" },
    turbo: { month: "price_tb_m", year: "price_tb_y" },
    twinturbo: { month: "price_tw_m", year: "price_tw_y" },
  };
  test("月額・年額どちらでも正しいティアを返す", () => {
    expect(tierFromPriceId("price_na_m", prices)).toBe("na");
    expect(tierFromPriceId("price_tb_y", prices)).toBe("turbo");
    expect(tierFromPriceId("price_tw_m", prices)).toBe("twinturbo");
  });
  test("未知/空/pricesなしは空文字", () => {
    expect(tierFromPriceId("price_unknown", prices)).toBe("");
    expect(tierFromPriceId("", prices)).toBe("");
    expect(tierFromPriceId("price_na_m", null)).toBe("");
  });
});

describe("pickHighestModel", () => {
  test("flash: 最新バージョン(previewも対象)を選ぶ", () => {
    const names = ["gemini-2.5-flash", "gemini-3-flash-preview", "gemini-flash-lite-latest", "gemini-2.0-flash"];
    expect(pickHighestModel(names, FLASH_RE)).toBe("gemini-3-flash-preview");
  });
  test("小数バージョン比較(3.6 > 3)", () => {
    expect(pickHighestModel(["gemini-3-flash", "gemini-3.6-flash"], FLASH_RE)).toBe("gemini-3.6-flash");
  });
  test("2.5-flash単体(旧404の再現防止の回帰): 他が無ければそれを返す", () => {
    expect(pickHighestModel(["gemini-2.5-flash"], FLASH_RE)).toBe("gemini-2.5-flash");
  });
  test("pro: liteやimageは拾わない", () => {
    const names = ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-3-pro-image"];
    expect(pickHighestModel(names, PRO_RE)).toBe("gemini-3-pro-preview");
  });
  test("該当なし/空は空文字", () => {
    expect(pickHighestModel(["text-embedding-004"], FLASH_RE)).toBe("");
    expect(pickHighestModel([], FLASH_RE)).toBe("");
    expect(pickHighestModel(null, FLASH_RE)).toBe("");
  });
});

describe("jstMonth", () => {
  test("JST(+9h)でYYYY-MMを返す", () => {
    // 2026-01-31 20:00 UTC = 2026-02-01 05:00 JST → 月境界がJSTで切り替わる
    const t = Date.UTC(2026, 0, 31, 20, 0, 0);
    expect(jstMonth(t)).toBe("2026-02");
  });
  test("UTCとJSTで同月のケース", () => {
    expect(jstMonth(Date.UTC(2026, 5, 15, 3, 0, 0))).toBe("2026-06");
  });
});
