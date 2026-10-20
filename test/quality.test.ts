import { describe, expect, it } from "vitest";
import { checkWeatherDaily, checkPersona, type WeatherExpected, type PersonaExpected } from "../src/core/quality.js";
import type { SnapshotContent } from "../src/store/snapshotStore.js";

const expected: WeatherExpected = {
  kind: "wx.daily",
  cities: ["上海", "杭州"],
  start: "2026-09-01",
  end: "2026-09-07",
  timezone: "Asia/Shanghai",
  variables: ["tempMeanC", "precipSum"],
};

function rows14(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const city of ["上海", "杭州"]) {
    for (let d = 1; d <= 7; d++) {
      rows.push({ city, date: `2026-09-0${d}`, tempMeanC: 25 + d, precipSum: 0 });
    }
  }
  return rows;
}

function content(rows: Record<string, unknown>[]): SnapshotContent {
  return {
    fields: [
      { name: "city", type: "string" },
      { name: "date", type: "string" },
      { name: "tempMeanC", type: "number", unit: "°C" },
      { name: "precipSum", type: "number", unit: "mm" },
    ],
    rows,
  };
}

describe("checkWeatherDaily（wx-quality@1）", () => {
  it("14/14 键齐、日期连续、单位时区明确 → complete", () => {
    const r = checkWeatherDaily(expected, content(rows14()), { unitTimezoneOk: true, paginationComplete: true });
    expect(r.conclusion).toBe("complete");
    expect(r.expectedCount).toBe(14);
    expect(r.actualCount).toBe(14);
    expect(r.missingKeys).toEqual([]);
  });

  it("13/14 缺一个城市日 → partial + 缺失清单，不填零不标完整（A02）", () => {
    const rows = rows14().filter((r) => !(r.city === "杭州" && r.date === "2026-09-03"));
    const r = checkWeatherDaily(expected, content(rows), { unitTimezoneOk: true, paginationComplete: true });
    expect(r.conclusion).toBe("partial");
    expect(r.actualCount).toBe(13);
    expect(r.missingKeys).toEqual(["杭州|2026-09-03"]);
  });

  it("主键重复 → partial 并列出重复键", () => {
    const rows = [...rows14(), { city: "上海", date: "2026-09-01", tempMeanC: 26, precipSum: 0 }];
    const r = checkWeatherDaily(expected, content(rows), { unitTimezoneOk: true, paginationComplete: true });
    expect(r.conclusion).toBe("partial");
    expect(r.duplicateKeys).toEqual(["上海|2026-09-01"]);
  });

  it("关键字段缺值（undefined）是 fieldIssue；null 与 0 区分", () => {
    const rows = rows14();
    delete rows[0]!.tempMeanC;
    rows[1]!.precipSum = null; // 显式 null ≠ 缺失；记录为 null 值 issue 但不同于 0
    rows[2]!.precipSum = 0;
    const r = checkWeatherDaily(expected, content(rows), { unitTimezoneOk: true, paginationComplete: true });
    const kinds = r.fieldIssues.map((f) => `${f.field}:${f.kind}`);
    expect(kinds).toContain("tempMeanC:missing");
    expect(kinds).toContain("precipSum:null_value");
    expect(r.fieldIssues.find((f) => f.field === "precipSum" && f.kind === "null_value")).toBeDefined();
    expect(rows[2]!.precipSum).toBe(0); // 0 不产生 issue
    expect(r.fieldIssues.filter((f) => f.field === "precipSum")).toHaveLength(1);
    expect(r.conclusion).toBe("partial");
  });

  it("分页未结束 → 不为 complete", () => {
    const r = checkWeatherDaily(expected, content(rows14()), { unitTimezoneOk: true, paginationComplete: false });
    expect(r.conclusion).toBe("partial");
    expect(r.paginationComplete).toBe(false);
  });

  it("单位/时区不明 → unusable（阻断条件）", () => {
    const r = checkWeatherDaily(expected, content(rows14()), { unitTimezoneOk: false, paginationComplete: true });
    expect(r.conclusion).toBe("unusable");
  });

  it("期望键 = 城市 × 时区本地闭区间日序列", () => {
    const e2: WeatherExpected = { ...expected, cities: ["上海"], start: "2026-09-05", end: "2026-09-07" };
    const rows = [5, 6, 7].map((d) => ({ city: "上海", date: `2026-09-0${d}`, tempMeanC: 25, precipSum: 0 }));
    const r = checkWeatherDaily(e2, content(rows), { unitTimezoneOk: true, paginationComplete: true });
    expect(r.expectedCount).toBe(3);
    expect(r.conclusion).toBe("complete");
  });
});

describe("checkPersona（persona-quality@1）", () => {
  const pexp: PersonaExpected = {
    kind: "persona.ageBands",
    brand: "青禾生活",
    platform: "演示平台",
    window: "2026-09",
    dimensions: ["ageBand"],
  };
  const prows = {
    fields: [
      { name: "ageBand", type: "string" },
      { name: "share", type: "number", unit: "%" },
      { name: "suppressed", type: "boolean" },
    ],
    rows: [
      { ageBand: "18-23", share: 20.0, suppressed: false },
      { ageBand: "24-30", share: 35.0, suppressed: false },
      { ageBand: "31-40", share: 25.0, suppressed: false },
      { ageBand: "41-50", share: 12.5, suppressed: false },
      { ageBand: "51+", share: 7.5, suppressed: false },
    ],
  };

  it("分母/观察窗/平台齐全、比例有单位 → complete", () => {
    const r = checkPersona(pexp, prows, { denominator: 1200 });
    expect(r.conclusion).toBe("complete");
  });

  it("分母缺失 → unusable（关键口径不明为阻断）", () => {
    const r = checkPersona(pexp, prows, { denominator: null });
    expect(r.conclusion).toBe("unusable");
  });

  it("小样本抑制段保留标注且不计缺失（抑制 ≠ 缺数据）", () => {
    const withSuppressed = {
      ...prows,
      rows: [...prows.rows.slice(0, 4), { ageBand: "51+", share: null, suppressed: true }],
    };
    const r = checkPersona(pexp, withSuppressed, { denominator: 1200 });
    expect(r.conclusion).toBe("complete");
    expect(r.fieldIssues.some((f) => f.kind === "suppressed")).toBe(true);
  });

  it("比例单位缺失 → warning（可选口径问题）", () => {
    const noUnit = { ...prows, fields: prows.fields.map((f) => (f.name === "share" ? { name: "share", type: "number" } : f)) };
    const r = checkPersona(pexp, noUnit as typeof prows, { denominator: 1200 });
    expect(r.conclusion).toBe("warning");
  });
});
