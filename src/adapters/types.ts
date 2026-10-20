import type { SnapshotContent } from "../store/snapshotStore.js";
import type { SnapshotManifest } from "../core/types.js";

/** 薄适配层与 core 之间的统一输出（不持有 SDK/传输私有类型） */
export interface AdapterOutcome {
  content: SnapshotContent;
  raw: Record<string, string>;
  requestCount: number;
  pageCount: number;
  paginationComplete: boolean;
  unitTimezoneOk: boolean;
  units: Record<string, string>;
  timezone: string | null;
  coordinates: { requested: [number, number][]; responded: [number, number][] } | null;
  /** 供应商未给更新时间则 "unknown" */
  sourceUpdatedAt: string | "unknown";
  /** 画像分母；天气为 undefined */
  denominator?: number | null;
  incompleteReasons: string[];
  /** 中止后仍返回的迟到结果（执行层据此判「结果未知」，隔离不自动保存） */
  lateAfterAbort?: boolean;
  /** 命中缓存的年龄（小时）；无缓存语义时缺省 */
  cacheAgeHours?: number;
  coverageExtra?: SnapshotManifest["coverage"]["actual"];
}
