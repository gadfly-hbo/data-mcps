import { createHash } from "node:crypto";

/**
 * 全仓唯一 canonical JSON 约定（GRILL 包 5）：
 * 对象键按码点排序、无冗余空白、undefined 字段丢弃、数组保序、UTF-8。
 * 服务于参数指纹、工具目录指纹、快照内容寻址三种摘要。
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, val]) => [k, sortValue(val)] as const);
    return Object.fromEntries(entries);
  }
  return v;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 内容寻址 ID：`${prefix}_${sha256 前 16 hex}`。 */
export function contentId(prefix: string, ...parts: unknown[]): string {
  const h = sha256Hex(parts.map(canonicalize).join("|"));
  return `${prefix}_${h.slice(0, 16)}`;
}
