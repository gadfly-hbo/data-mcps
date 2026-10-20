import type { AdapterOutcome } from "./types.js";

/**
 * 合成画像夹具（独立 synthetic 身份）。
 * 「青禾生活」为虚构品牌，平台为「演示平台」，观察窗 2026-09，分母 1,200 仅为演示设定；
 * 无真实抽样、加权或消费者信息；小样本抑制为原型规则，不代表任何供应商承诺或合规认证。
 */
export interface PersonaQueryParams {
  brand: string;
  platform: string;
  window: string;
}

const DENOMINATOR = 1200;

export function queryPersonaFixture(params: PersonaQueryParams): AdapterOutcome {
  const rows: Record<string, unknown>[] = [
    { ageBand: "18-23", share: 20.0, suppressed: false },
    { ageBand: "24-30", share: 35.0, suppressed: false },
    { ageBand: "31-40", share: 25.0, suppressed: false },
    { ageBand: "41-50", share: 12.5, suppressed: false },
    { ageBand: "51+", share: 7.5, suppressed: false },
    { ageBand: "17 及以下", share: null, suppressed: true },
  ];
  const doc = {
    synthetic: true,
    brand: params.brand,
    platform: params.platform,
    window: params.window,
    population: "演示期品牌互动人群（合成）",
    denominator: DENOMINATOR,
    note: "年龄段互斥、合计 100% 仅为演示设定；兴趣标签类维度可重叠、不能相加；抑制为原型规则。",
    rows,
  };
  return {
    content: {
      fields: [
        { name: "ageBand", type: "string" },
        { name: "share", type: "number", unit: "%" },
        { name: "suppressed", type: "boolean" },
      ],
      rows,
    },
    raw: { "persona.json": JSON.stringify(doc) },
    requestCount: 0, // 演示无真实调用
    pageCount: 0,
    paginationComplete: true,
    unitTimezoneOk: true,
    units: { share: "%" },
    timezone: null,
    coordinates: null,
    sourceUpdatedAt: "unknown",
    denominator: DENOMINATOR,
    incompleteReasons: [],
    coverageExtra: { brand: params.brand, platform: params.platform, window: params.window, denominator: DENOMINATOR },
  };
}
