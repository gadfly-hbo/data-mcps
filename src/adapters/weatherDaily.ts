import { AppError, errors } from "../core/errors.js";
import { daySequence } from "../core/quality.js";
import type { AdapterOutcome } from "./types.js";

/**
 * Open-Meteo Historical Weather API 的真实 REST 适配器实现（PRD 天气适配器）。
 * transport 可注入：首期默认接明确标注的合成夹具；真实 base URL 路径存在但未授权不执行。
 * 请求拓扑（GRILL 包 7）：每城市一请求 × 逻辑页（日序列分段）；单请求超时 10s；无隐藏重试。
 */

export interface TransportRequest {
  url: string;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface CitySpec {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface WeatherQueryParams {
  cities: CitySpec[];
  start: string; // YYYY-MM-DD 闭区间
  end: string;
  timezone: string;
  variables: string[]; // ["tempMeanC", "precipSum"]
}

const VAR_MAP: Record<string, { api: string; unit: string }> = {
  tempMeanC: { api: "temperature_2m_mean", unit: "°C" },
  precipSum: { api: "precipitation_sum", unit: "mm" },
};

const DEFAULT_BASE = "https://archive-api.open-meteo.com/v1/archive";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export const WEATHER_ADAPTER_VERSION = "wx-fixture@1";

/** 真实网络 transport（本期产品内不接线；授权后由 composition root 注入） */
export const fetchTransport: Transport = async ({ url, signal }) => {
  const res = await fetch(url, { signal });
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, headers, body };
};

export class WeatherDailyAdapter {
  constructor(
    private readonly opts: { transport: Transport; baseUrl?: string; pagesPerCity?: number },
  ) {}

  /** 协议握手（连接检查用，与数据验证分开）：只核对适配层存活与版本，不取数据 */
  async handshake(): Promise<{ adapterVersion: string }> {
    const res = await this.opts.transport({
      url: `${this.opts.baseUrl ?? DEFAULT_BASE}/.well-known/data-mcps-handshake`,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status !== 200) throw new AppError(502, "network", `握手失败：HTTP ${res.status}`);
    const doc = JSON.parse(res.body) as { adapterVersion?: string };
    return { adapterVersion: doc.adapterVersion ?? "unknown" };
  }


  private buildUrl(city: CitySpec, start: string, end: string, params: WeatherQueryParams): string {
    const u = new URL(this.opts.baseUrl ?? DEFAULT_BASE);
    u.searchParams.set("latitude", String(city.lat));
    u.searchParams.set("longitude", String(city.lon));
    u.searchParams.set("start_date", start);
    u.searchParams.set("end_date", end);
    u.searchParams.set("daily", params.variables.map((v) => VAR_MAP[v]?.api ?? v).join(","));
    u.searchParams.set("timezone", params.timezone);
    return u.toString();
  }

  /** 把一城的日序列分成 pagesPerCity 个逻辑页（GRILL 包 7） */
  private pagesFor(start: string, end: string): { start: string; end: string }[] {
    const n = Math.max(1, this.opts.pagesPerCity ?? 1);
    const days = daySequence(start, end);
    const per = Math.ceil(days.length / n);
    const pages: { start: string; end: string }[] = [];
    for (let i = 0; i < days.length; i += per) {
      pages.push({ start: days[i]!, end: days[Math.min(i + per - 1, days.length - 1)]! });
    }
    return pages;
  }

  private mapHttpError(status: number, headers: Record<string, string>, body: string, city: string): AppError {
    if (status === 401) return errors.authInvalid(`鉴权失效（${city}），未得到可用结果，计费未知性单列`);
    if (status === 403) return errors.scopeInsufficient(`缺少具体授权范围（${city}）`);
    if (status === 429) {
      const ra = headers["retry-after"];
      if (ra !== undefined && /^\d+$/.test(ra)) {
        return errors.rateLimited(`频率限流（${city}）`, Number.parseInt(ra, 10));
      }
      if (/quota|额度/i.test(body)) return errors.quotaExhausted(`账户额度不足（${city}）`);
      return errors.rateLimited(`频率限流（${city}），Retry-After 未知`);
    }
    return new AppError(502, "network", `来源响应异常（${city}）：HTTP ${status}`);
  }

  async query(params: WeatherQueryParams, signal: AbortSignal): Promise<AdapterOutcome> {
    if (signal.aborted) throw new DOMException("已取消", "AbortError");
    const rows: Record<string, unknown>[] = [];
    const raw: Record<string, string> = {};
    const requestedCoords: [number, number][] = [];
    const respondedCoords: [number, number][] = [];
    const incompleteReasons: string[] = [];
    let requestCount = 0;
    let pageCount = 0;
    let timezone: string | null = null;
    let unitTimezoneOk = true;
    let cacheAgeHours: number | undefined;
    /** 迟到结果：中止后 transport 仍 resolve —— 停止新请求，已得内容如实返回（由执行层判定「结果未知」语义） */
    let lateAfterAbort = false;

    for (const city of params.cities) {
      if (signal.aborted) break;
      requestedCoords.push([city.lat, city.lon]);
      let cityHadFailure = false;
      for (const page of this.pagesFor(params.start, params.end)) {
        if (signal.aborted) break;
        const url = this.buildUrl(city, page.start, page.end, params);
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const combined = AbortSignal.any([signal, timeout]);
        let res: TransportResponse;
        try {
          res = await this.opts.transport({ url, signal: combined });
        } catch (err) {
          if (signal.aborted) throw new DOMException("已取消", "AbortError");
          if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") {
            throw new AppError(504, "timeout", `请求超时（${city}）：是否已发送、费用何者未知，不盲目重试`);
          }
          throw new AppError(502, "network", `网络中断（${city}）：结果与费用未知，先按请求标识核对`, undefined);
        }
        requestCount += 1;
        if (res.status !== 200) {
          // 城市级失败：记录不完整原因，继续其他城市（天然部分结果面）
          const mapped = this.mapHttpError(res.status, res.headers, res.body, city.name);
          if (mapped.category === "rate_limited" || mapped.category === "quota_exhausted" || mapped.category === "auth_invalid" || mapped.category === "scope_insufficient") {
            // 授权/限流类：整次运行按此分类；请求/页计数随错误保留（A06 已取页/请求可见）
            throw new AppError(mapped.status, mapped.category, mapped.message, { ...(mapped.details ?? {}), requestCount, pageCount }, mapped.retryAfterSeconds);
          }
          incompleteReasons.push(`${city.name} 第 ${requestCount} 请求 HTTP ${res.status}`);
          cityHadFailure = true;
          break;
        }
        if (Buffer.byteLength(res.body) > MAX_RESPONSE_BYTES) {
          throw new AppError(502, "network", `响应超出大小上限（${city.name}）`);
        }
        if (signal.aborted) lateAfterAbort = true; // 中止后仍返回：如实计入，停止后续请求
        if (res.headers["x-cache-age-hours"] !== undefined) {
          cacheAgeHours = Number.parseInt(res.headers["x-cache-age-hours"], 10);
        }
        pageCount += 1;
        const doc = JSON.parse(res.body) as {
          latitude?: number;
          longitude?: number;
          timezone?: string;
          daily?: { time?: string[]; temperature_2m_mean?: (number | null)[]; precipitation_sum?: (number | null)[] };
          daily_units?: Record<string, string>;
        };
        raw[`${city.id}.json`] = res.body;
        timezone = doc.timezone ?? null;
        if (typeof doc.latitude === "number" && typeof doc.longitude === "number") {
          respondedCoords.push([doc.latitude, doc.longitude]);
        }
        if (!doc.daily_units || !doc.timezone) unitTimezoneOk = false;
        const times = doc.daily?.time ?? [];
        const temps = doc.daily?.temperature_2m_mean ?? [];
        const precips = doc.daily?.precipitation_sum ?? [];
        for (let i = 0; i < times.length; i++) {
          const row: Record<string, unknown> = { city: city.name, date: times[i] };
          if (params.variables.includes("tempMeanC")) row.tempMeanC = i < temps.length ? temps[i] : undefined;
          if (params.variables.includes("precipSum")) row.precipSum = i < precips.length ? precips[i] : undefined;
          rows.push(row);
        }
        if (lateAfterAbort) break;
      }
      if (cityHadFailure) incompleteReasons.push(`${city.name} 未完成全部页`);
      if (lateAfterAbort) break;
    }

    const units: Record<string, string> = {};
    for (const v of params.variables) units[v] = VAR_MAP[v]?.unit ?? "unknown";

    return {
      content: {
        fields: [
          { name: "city", type: "string" },
          { name: "date", type: "string" },
          ...params.variables.map((v) => ({ name: v, type: "number", unit: units[v] ?? "unknown" })),
        ],
        rows,
      },
      raw,
      requestCount,
      pageCount,
      paginationComplete: incompleteReasons.length === 0,
      unitTimezoneOk,
      units,
      timezone,
      coordinates: { requested: requestedCoords, responded: respondedCoords },
      sourceUpdatedAt: "unknown",
      incompleteReasons,
      lateAfterAbort,
      ...(cacheAgeHours !== undefined ? { cacheAgeHours } : {}),
    };
  }
}
