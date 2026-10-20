import { errors } from "../core/errors.js";
import { checkPersona, checkWeatherDaily, type PersonaExpected, type WeatherExpected } from "../core/quality.js";
import type { QualityReport, Run } from "../core/types.js";
import type { AdapterOutcome } from "../adapters/types.js";
import { WeatherDailyAdapter, type WeatherQueryParams } from "../adapters/weatherDaily.js";
import { makeFixtureTransport, PRESET_CITIES, type FixtureScenario } from "../adapters/fixtureTransport.js";
import { queryPersonaFixture, type PersonaQueryParams } from "../adapters/personaFixture.js";

/**
 * 能力注册表（REVIEW 收敛：normalize/execute/checkQuality/handshake 按 capabilityId 键控，
 * 新增能力只改这一处；替代 engine 内三处 if-级联）。
 */
export interface CapabilityHandler {
  /** 规范化参数（城市取预置坐标等），规范化结果是参数指纹与运行的唯一事实源 */
  normalize(raw: Record<string, unknown>): Record<string, unknown>;
  /** 连接检查握手：返回适配版本（与目录登记比对，不一致 → 工具已变化） */
  handshake(): Promise<{ adapterVersion: string }>;
  /** 数据验证：一次受限测试查询（不产生快照、不进资产） */
  validate(): Promise<boolean>;
  execute(normalized: Record<string, unknown>, signal: AbortSignal, runScenario?: FixtureScenario): Promise<AdapterOutcome>;
  checkQuality(run: Run, outcome: AdapterOutcome): QualityReport;
}

/** 规范化天气参数：城市取预置坐标（用户确认），不静默选同名城市（GRILL 包 5/8） */
export function normalizeWeatherParams(raw: Record<string, unknown>): WeatherQueryParams & { scenario?: FixtureScenario } {
  const cityIds = raw.cities;
  if (!Array.isArray(cityIds) || cityIds.length === 0) throw errors.badRequest("cities 必须是非空城市 ID 数组");
  const cities = cityIds.map((id) => {
    const c = PRESET_CITIES.find((p) => p.id === id);
    if (!c) throw errors.validationFailed(`城市 ${String(id)} 不在预置确认清单（仅上海/杭州）；新增城市需先确认坐标`, { city: id });
    return c;
  });
  const start = String(raw.start ?? "");
  const end = String(raw.end ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    throw errors.badRequest("start/end 必须是 YYYY-MM-DD 且 start ≤ end");
  }
  const timezone = String(raw.timezone ?? "Asia/Shanghai");
  if (timezone !== "Asia/Shanghai") throw errors.validationFailed("R1 仅支持 Asia/Shanghai（日界线口径已确认）");
  const variables = Array.isArray(raw.variables) ? raw.variables.map(String) : ["tempMeanC", "precipSum"];
  for (const v of variables) {
    if (!["tempMeanC", "precipSum"].includes(v)) throw errors.badRequest(`不支持的变量 ${v}`);
  }
  const scenario = (raw.scenario ?? undefined) as FixtureScenario | undefined;
  return { cities, start, end, timezone, variables, ...(scenario ? { scenario } : {}) };
}

export function normalizePersonaParams(raw: Record<string, unknown>): PersonaQueryParams {
  const brand = String(raw.brand ?? "");
  const platform = String(raw.platform ?? "");
  const win = String(raw.window ?? "");
  if (brand !== "青禾生活" || platform !== "演示平台" || win !== "2026-09") {
    throw errors.validationFailed("合成画像样板仅有一档口径：青禾生活 × 演示平台 × 2026-09", { brand, platform, window: win });
  }
  return { brand, platform, window: win };
}

const weatherHandler: CapabilityHandler = {
  normalize: (raw) => normalizeWeatherParams(raw) as unknown as Record<string, unknown>,
  handshake: async () => {
    const adapter = new WeatherDailyAdapter({ transport: makeFixtureTransport() });
    return adapter.handshake();
  },
  validate: async () => {
    const adapter = new WeatherDailyAdapter({ transport: makeFixtureTransport() });
    const out = await adapter.query(
      { cities: [PRESET_CITIES[0]!], start: "2026-09-01", end: "2026-09-01", timezone: "Asia/Shanghai", variables: ["tempMeanC"] },
      new AbortController().signal,
    );
    return out.content.rows.length === 1;
  },
  execute: (normalized, signal, runScenario) => {
    const { scenario, ...params } = normalized as unknown as WeatherQueryParams & { scenario?: FixtureScenario };
    const effective = scenario ?? runScenario ?? {};
    const adapter = new WeatherDailyAdapter({
      transport: makeFixtureTransport(effective),
      ...(effective.pagesPerCity !== undefined ? { pagesPerCity: effective.pagesPerCity } : {}),
    });
    return adapter.query(params, signal);
  },
  checkQuality: (run, outcome) => {
    const p = run.params as unknown as WeatherQueryParams;
    const expected: WeatherExpected = {
      kind: "wx.daily",
      cities: p.cities.map((c) => c.name),
      start: p.start,
      end: p.end,
      timezone: p.timezone,
      variables: p.variables,
    };
    return checkWeatherDaily(expected, outcome.content, {
      unitTimezoneOk: outcome.unitTimezoneOk,
      paginationComplete: outcome.paginationComplete,
    });
  },
};

const personaHandler: CapabilityHandler = {
  normalize: (raw) => normalizePersonaParams(raw) as unknown as Record<string, unknown>,
  handshake: () => Promise.resolve({ adapterVersion: "persona-fixture@1" }),
  validate: () => {
    const out = queryPersonaFixture({ brand: "青禾生活", platform: "演示平台", window: "2026-09" });
    return Promise.resolve(out.content.rows.length > 0);
  },
  execute: (normalized) => Promise.resolve(queryPersonaFixture(normalized as unknown as PersonaQueryParams)),
  checkQuality: (run, outcome) => {
    const p = run.params as unknown as PersonaQueryParams;
    const expected: PersonaExpected = { kind: "persona.ageBands", brand: p.brand, platform: p.platform, window: p.window, dimensions: ["ageBand"] };
    return checkPersona(expected, outcome.content, { denominator: outcome.denominator ?? null });
  },
};

export const CAPABILITIES: Record<string, CapabilityHandler> = {
  "wx.daily": weatherHandler,
  "persona.ageBands": personaHandler,
};

export function mustCapability(capabilityId: string): CapabilityHandler {
  const handler = CAPABILITIES[capabilityId];
  if (!handler) throw errors.badRequest(`未知能力 ${capabilityId}：无质量规则时完整性未知，不予执行`);
  return handler;
}
