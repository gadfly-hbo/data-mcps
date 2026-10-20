import { canonicalize, sha256Hex } from "./canonical.js";

/**
 * 参数指纹（GRILL 包 5）：params 必须在调用前完成规范化
 * （城市取预置坐标而非显示名、时区/单位/变量集合显式包含）。
 */
export function paramsFingerprint(input: {
  connectorId: string;
  capabilityId: string;
  templateRevision: string;
  params: Record<string, unknown>;
}): string {
  return sha256Hex(canonicalize(input));
}

/** MCP 工具目录指纹：按 name 排序的 [{name, inputSchema, annotations(, outputSchema)}] */
export function toolCatalogFingerprint(
  tools: { name: string; inputSchema?: unknown; annotations?: unknown; outputSchema?: unknown }[],
): string {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Hex(
    canonicalize(
      sorted.map((t) => ({
        name: t.name,
        inputSchema: t.inputSchema ?? null,
        annotations: t.annotations ?? null,
        outputSchema: t.outputSchema ?? null,
      })),
    ),
  );
}
