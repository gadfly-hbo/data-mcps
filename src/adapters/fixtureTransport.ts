import { daySequence } from "../core/quality.js";
import type { CitySpec, Transport } from "./weatherDaily.js";

/**
 * 合成夹具 transport（外部数据边界，明确标注 synthetic）。
 * 数据形态仿 Open-Meteo 历史天气官方示例；全部数值为确定性合成，不声称来自任何供应商。
 * 场景注入用于确定性演练失败路径（PRD GRILL 包 7）。
 */
export interface FixtureScenario {
  failCity?: string;
  failStatus?: number;
  retryAfter?: string;
  quotaExhausted?: boolean;
  heldMs?: number;
  lateResultOnAbort?: boolean;
  missingDays?: string[];
  /** 每城逻辑页数（适配器层分页演练） */
  pagesPerCity?: number;
  /** 每城第 N 个请求失败（1 起计） */
  failAtPage?: number;
  /** 指定城市缺指定日（部分结果演练，缺而不补） */
  missingByCity?: Record<string, string[]>;
  /** 过期缓存演练：命中缓存年龄（小时） */
  staleHours?: number;
}

/** R1 预置城市（GRILL 包 8 封定，WGS84，用户已确认） */
export const PRESET_CITIES: CitySpec[] = [
  { id: "shanghai", name: "上海", lat: 31.2304, lon: 121.4737 },
  { id: "hangzhou", name: "杭州", lat: 30.2741, lon: 120.1551 },
];

const CITY_BY_COORD: Record<string, CitySpec> = Object.fromEntries(PRESET_CITIES.map((c) => [`${c.lat},${c.lon}`, c]));

/** 确定性合成：同一城市同一日期永远得到同一数值 */
function synthValue(cityId: string, date: string, kind: "temp" | "precip"): number {
  let h = 0;
  for (const ch of `${cityId}|${date}|${kind}`) h = (h * 31 + ch.charCodeAt(0)) % 100003;
  if (kind === "temp") return Math.round((22 + (h % 90) / 10) * 10) / 10; // 22.0–31.0 °C
  return h % 7 === 0 ? Math.round((h % 40) / 10) * 10 / 10 : 0; // 偶有降水
}

export function makeFixtureTransport(scenario: FixtureScenario = {}): Transport {
  const cityRequestCount = new Map<string, number>();
  return async ({ url, signal }) => {
    if (scenario.heldMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), scenario.heldMs);
        const onAbort = () => {
          if (scenario.lateResultOnAbort) return; // 不 reject：迟到结果照常返回
          clearTimeout(t);
          reject(new DOMException("已取消", "AbortError"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (signal.aborted && !scenario.lateResultOnAbort) {
      throw new DOMException("已取消", "AbortError");
    }

    const u = new URL(url);
    if (u.pathname.endsWith("/.well-known/data-mcps-handshake")) {
      // 协议握手端点（连接检查）：返回适配版本，不产生数据
      return { status: 200, headers: {}, body: JSON.stringify({ adapterVersion: "wx-fixture@1", synthetic: true }) };
    }
    const key = `${u.searchParams.get("latitude")},${u.searchParams.get("longitude")}`;
    const city = CITY_BY_COORD[key];
    if (!city) return { status: 400, headers: {}, body: JSON.stringify({ error: "unknown coordinate" }) };

    const nth = (cityRequestCount.get(city.id) ?? 0) + 1;
    cityRequestCount.set(city.id, nth);

    const shouldFail = scenario.failCity === city.id || scenario.failAtPage === nth;
    if (shouldFail) {
      const headers: Record<string, string> = {};
      if (scenario.retryAfter !== undefined) headers["retry-after"] = scenario.retryAfter;
      const body = scenario.quotaExhausted
        ? JSON.stringify({ error: "quota exhausted: 账户额度已耗尽" })
        : JSON.stringify({ error: `fixture HTTP ${scenario.failStatus ?? 500}` });
      return { status: scenario.failStatus ?? 500, headers, body };
    }

    const allDays = daySequence(u.searchParams.get("start_date")!, u.searchParams.get("end_date")!);
    const missing = new Set([...(scenario.missingDays ?? []), ...(scenario.missingByCity?.[city.id] ?? [])]);
    const days = allDays.filter((d) => !missing.has(d));
    const doc = {
      latitude: city.lat,
      longitude: city.lon,
      timezone: u.searchParams.get("timezone") ?? "Asia/Shanghai",
      daily: {
        time: days,
        temperature_2m_mean: days.map((d) => synthValue(city.id, d, "temp")),
        precipitation_sum: days.map((d) => synthValue(city.id, d, "precip")),
      },
      daily_units: { temperature_2m_mean: "°C", precipitation_sum: "mm" },
    };
    const headers: Record<string, string> = {};
    if (scenario.staleHours !== undefined) headers["x-cache-age-hours"] = String(scenario.staleHours);
    return { status: 200, headers, body: JSON.stringify(doc) };
  };
}
