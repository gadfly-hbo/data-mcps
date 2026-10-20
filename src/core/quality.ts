import type { QualityReport } from "./types.js";
import type { SnapshotContent } from "../store/snapshotStore.js";

/**
 * 质量检查器（GRILL 包 6）：纯函数，无 I/O。
 * 完整 = 已知预期 + 实际检查同时满足；缺失不填零；关键口径不明为阻断。
 */

export interface WeatherExpected {
  kind: "wx.daily";
  cities: string[];
  /** 闭区间本地日，YYYY-MM-DD，按请求时区解释 */
  start: string;
  end: string;
  timezone: string;
  variables: string[];
}

export interface PersonaExpected {
  kind: "persona.ageBands";
  brand: string;
  platform: string;
  window: string;
  dimensions: string[];
}

export interface QualityContext {
  unitTimezoneOk: boolean;
  paginationComplete: boolean;
}

function baseReport(ruleVersion: string): QualityReport {
  return {
    expectedCount: null,
    actualCount: 0,
    missingKeys: [],
    duplicateKeys: [],
    fieldIssues: [],
    unitTimezoneOk: true,
    paginationComplete: true,
    conclusion: "unusable",
    ruleVersion,
    checkedAtUtc: new Date().toISOString(),
  };
}

/** 本地闭区间日序列（YYYY-MM-DD，按 UTC 日推进；日期为日历日串，无需时区换算） */
export function daySequence(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  if (Number.isNaN(cur.getTime()) || Number.isNaN(last.getTime()) || cur > last) return out;
  while (cur <= last) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export function checkWeatherDaily(
  expected: WeatherExpected,
  content: SnapshotContent,
  ctx: QualityContext,
): QualityReport {
  const report = baseReport("wx-quality@1");
  report.unitTimezoneOk = ctx.unitTimezoneOk;
  report.paginationComplete = ctx.paginationComplete;

  const days = daySequence(expected.start, expected.end);
  const expectedKeys: string[] = [];
  for (const city of expected.cities) for (const day of days) expectedKeys.push(`${city}|${day}`);
  report.expectedCount = expectedKeys.length;
  report.actualCount = content.rows.length;

  const seen = new Map<string, number>();
  for (const row of content.rows) {
    const key = `${String(row.city)}|${String(row.date)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  report.missingKeys = expectedKeys.filter((k) => !seen.has(k));
  report.duplicateKeys = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);

  for (const [i, row] of content.rows.entries()) {
    for (const v of expected.variables) {
      const val = row[v];
      if (val === undefined) {
        report.fieldIssues.push({ field: v, kind: "missing", message: `第 ${i + 1} 行 ${String(row.city)}|${String(row.date)} 缺字段值` });
      } else if (val === null) {
        report.fieldIssues.push({ field: v, kind: "null_value", message: `第 ${i + 1} 行 ${String(row.city)}|${String(row.date)} 为 null（显式空，区别于 0 与缺失）` });
      } else if (typeof val !== "number") {
        report.fieldIssues.push({ field: v, kind: "wrong_type", message: `第 ${i + 1} 行 ${v} 类型 ${typeof val} ≠ number` });
      }
    }
  }

  // 结论：关键口径不明阻断 → 缺键/重复/字段缺失/分页未完 → partial → 字段空值类 → warning → complete
  if (!ctx.unitTimezoneOk) {
    report.conclusion = "unusable";
  } else if (report.missingKeys.length > 0 || report.duplicateKeys.length > 0 || !ctx.paginationComplete) {
    report.conclusion = "partial";
  } else if (report.fieldIssues.some((f) => f.kind === "missing" || f.kind === "wrong_type")) {
    report.conclusion = "partial";
  } else if (report.fieldIssues.length > 0) {
    report.conclusion = "warning";
  } else {
    report.conclusion = "complete";
  }
  return report;
}

export function checkPersona(
  expected: PersonaExpected,
  content: SnapshotContent,
  ctx: { denominator: number | null },
): QualityReport {
  const report = baseReport("persona-quality@1");
  report.expectedCount = null; // 画像无“键”预期；完整性以口径齐备判断
  report.actualCount = content.rows.length;

  const shareField = content.fields.find((f) => f.name === "share");
  const shareHasUnit = Boolean(shareField && "unit" in shareField && shareField.unit);

  for (const row of content.rows) {
    if (row.suppressed === true) {
      report.fieldIssues.push({
        field: "share",
        kind: "suppressed",
        message: `${String(row[expected.dimensions[0] ?? "segment"])} 已按小样本抑制规则隐藏（原型规则，非供应商承诺）`,
      });
      continue;
    }
    if (typeof row.share !== "number") {
      report.fieldIssues.push({ field: "share", kind: "missing", message: `分段 ${JSON.stringify(row)} 缺比例值` });
    }
  }

  if (ctx.denominator === null) {
    report.conclusion = "unusable"; // 分母不明 = 关键口径阻断
  } else if (report.fieldIssues.some((f) => f.kind === "missing")) {
    report.conclusion = "partial";
  } else if (!shareHasUnit) {
    report.conclusion = "warning";
  } else {
    report.conclusion = "complete";
  }
  return report;
}
