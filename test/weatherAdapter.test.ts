import { describe, expect, it } from "vitest";
import { WeatherDailyAdapter, type Transport } from "../src/adapters/weatherDaily.js";
import { makeFixtureTransport, PRESET_CITIES, type FixtureScenario } from "../src/adapters/fixtureTransport.js";

const cities = PRESET_CITIES; // 上海、杭州
const baseParams = {
  cities,
  start: "2026-09-01",
  end: "2026-09-07",
  timezone: "Asia/Shanghai",
  variables: ["tempMeanC", "precipSum"],
};

function queryWith(scenario: FixtureScenario = {}, params = baseParams, signal = new AbortController().signal) {
  const adapter = new WeatherDailyAdapter({
    transport: makeFixtureTransport(scenario),
    ...(scenario.pagesPerCity !== undefined ? { pagesPerCity: scenario.pagesPerCity } : {}),
  });
  return adapter.query(params, signal);
}

describe("WeatherDailyAdapter + 合成夹具 transport", () => {
  it("双城七日 → 14 行、每城一请求、单位/时区/坐标齐全", async () => {
    const out = await queryWith();
    expect(out.content.rows).toHaveLength(14);
    expect(out.requestCount).toBe(2);
    expect(out.pageCount).toBe(2);
    expect(out.paginationComplete).toBe(true);
    expect(out.unitTimezoneOk).toBe(true);
    expect(out.units).toEqual({ tempMeanC: "°C", precipSum: "mm" });
    expect(out.timezone).toBe("Asia/Shanghai");
    expect(out.coordinates!.requested).toEqual([
      [31.2304, 121.4737],
      [30.2741, 120.1551],
    ]);
    expect(out.coordinates!.responded).toHaveLength(2);
    expect(out.sourceUpdatedAt).toBe("unknown");
    expect(out.raw["shanghai.json"]).toContain("\"daily\"");
  });

  it("failCity 注入 → 仅成功城市行返回，分页不完整（部分结果输入）", async () => {
    const out = await queryWith({ failCity: "hangzhou", failStatus: 500 });
    expect(out.content.rows).toHaveLength(7);
    expect(out.content.rows.every((r) => r.city === "上海")).toBe(true);
    expect(out.paginationComplete).toBe(false);
    expect(out.incompleteReasons.join(" ")).toContain("杭州");
  });

  it("missingDays 注入 → 缺键由行缺失体现（不填零）", async () => {
    const out = await queryWith({ missingDays: ["2026-09-03"] });
    expect(out.content.rows).toHaveLength(12);
    expect(out.content.rows.some((r) => r.date === "2026-09-03")).toBe(false);
  });

  it("429 + Retry-After → rate_limited 且有证据的秒数", async () => {
    await expect(queryWith({ failCity: "shanghai", failStatus: 429, retryAfter: "30" })).rejects.toMatchObject({
      category: "rate_limited",
      retryAfterSeconds: 30,
    });
  });

  it("429 无 Retry-After 且额度语义 → quota_exhausted", async () => {
    await expect(queryWith({ failCity: "shanghai", failStatus: 429, quotaExhausted: true })).rejects.toMatchObject({
      category: "quota_exhausted",
    });
  });

  it("429 无 Retry-After 无额度语义 → rate_limited 且 Retry-After 未知", async () => {
    await expect(queryWith({ failCity: "shanghai", failStatus: 429 })).rejects.toMatchObject({
      category: "rate_limited",
      retryAfterSeconds: undefined,
    });
  });

  it("401 → auth_invalid；403 → scope_insufficient", async () => {
    await expect(queryWith({ failCity: "shanghai", failStatus: 401 })).rejects.toMatchObject({ category: "auth_invalid" });
    await expect(queryWith({ failCity: "shanghai", failStatus: 403 })).rejects.toMatchObject({ category: "scope_insufficient" });
  });

  it("heldMs 挂起 + 中止 → 适配器确认中断（AbortError）", async () => {
    const ctl = new AbortController();
    const p = queryWith({ heldMs: 5000 }, baseParams, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("heldMs 挂起 + lateResultOnAbort → 中止后仍迟到 resolve（迟到结果隔离输入）", async () => {
    const ctl = new AbortController();
    const p = queryWith({ heldMs: 30, lateResultOnAbort: true }, baseParams, ctl.signal);
    ctl.abort();
    const out = await p; // 迟到结果：正常返回
    expect(out.content.rows.length).toBeGreaterThan(0);
  });

  it("多页（pagesPerCity=2）→ 页数/请求数翻倍且数据仍完整", async () => {
    const out = await queryWith({ pagesPerCity: 2 });
    expect(out.requestCount).toBe(4);
    expect(out.pageCount).toBe(4);
    expect(out.content.rows).toHaveLength(14);
  });

  it("failAtPage=2 → 每城第二页失败 → 各城缺后半段（已取页保留计数）", async () => {
    const out = await queryWith({ pagesPerCity: 2, failAtPage: 2, failStatus: 500 });
    expect(out.content.rows.length).toBeLessThan(14);
    expect(out.pageCount).toBe(2); // 每城只完成第 1 页
    expect(out.paginationComplete).toBe(false);
  });

  it("真实 transport 路径：请求构造符合 Open-Meteo 历史 API 形态（可替换接缝）", async () => {
    const seen: string[] = [];
    const transport: Transport = async ({ url }) => {
      seen.push(url);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          latitude: 31.23,
          longitude: 121.47,
          timezone: "Asia/Shanghai",
          daily: { time: ["2026-09-01"], temperature_2m_mean: [28.1], precipitation_sum: [0] },
          daily_units: { temperature_2m_mean: "°C", precipitation_sum: "mm" },
        }),
      };
    };
    const adapter = new WeatherDailyAdapter({ transport, baseUrl: "https://archive-api.open-meteo.com/v1/archive" });
    const one = { ...baseParams, cities: [cities[0]!], start: "2026-09-01", end: "2026-09-01" };
    const out = await adapter.query(one, new AbortController().signal);
    expect(out.content.rows).toHaveLength(1);
    const u = new URL(seen[0]!);
    expect(u.origin + u.pathname).toBe("https://archive-api.open-meteo.com/v1/archive");
    expect(u.searchParams.get("latitude")).toBe("31.2304");
    expect(u.searchParams.get("longitude")).toBe("121.4737");
    expect(u.searchParams.get("start_date")).toBe("2026-09-01");
    expect(u.searchParams.get("daily")).toBe("temperature_2m_mean,precipitation_sum");
    expect(u.searchParams.get("timezone")).toBe("Asia/Shanghai");
  });
});
