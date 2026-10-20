/**
 * 领域类型（方案.md §03 对象边界 + PRD manifest 八组 + GRILL 包 1/2/4/8）。
 * core 不持有任何 SDK/传输私有类型。
 */

// ---------- 目录与来源 ----------

export interface StatusFacet {
  ok: boolean;
  /** 核实日期，如 "2026-10-19" */
  at: string;
  /** 证据链接；无证据为 null，不得伪造 */
  evidence: string | null;
}

/** 来源状态四面，分别举证，不存在汇总徽标（方案 §01/§12） */
export interface SourceStatus {
  docsVerified: StatusFacet;
  adaptationVerified: StatusFacet;
  accountChecked: StatusFacet;
  envTested: StatusFacet;
}

/** 费用已知性。"demo_no_call"（演示无调用）≠ 供应商免费（方案 §08） */
export type CostKnownness = "doc_hint" | "account_verified" | "unknown" | "demo_no_call";

export interface SourceLicense {
  summary: string;
  sourceUrl: string;
  checkedAt: string;
  exportAllowed: boolean;
  modelAllowed: boolean;
  retentionNote: string;
}

export interface CapabilitySpec {
  /** 如 "wx.daily" */
  id: string;
  label: string;
  /** 模板修订号，如 "wx.daily@1"（GRILL 包 5） */
  templateRevision: string;
  /** 质量规则版本，如 "wx-quality@1"；null = 完整性未知（第五档） */
  qualityRuleVersion: string | null;
}

export interface CatalogEntry {
  id: string;
  name: string;
  summary: string;
  domain: string;
  provider: { name: string; url: string };
  connector: {
    protocol: "rest" | "mcp" | "none";
    adapterVersion: string | null;
    coverage: string;
    granularity: string;
    latency: string;
  };
  status: SourceStatus;
  cost: { knownness: CostKnownness; note: string; checkedAt: string };
  license: SourceLicense;
  auth: { kind: "none" | "api_key" | "jwt" | "oauth" | "mcp"; note: string };
  /** 示例结构说明（US2：返回长什么样；未适配来源为「待核实」） */
  exampleShape: string;
  /** 合成身份是条目身份的一部分；真实源与合成源是不同条目，无翻转字段 */
  synthetic: boolean;
  /** 本期仅合成夹具源可连接；真实源仅有研究卡 */
  connectable: boolean;
  capabilities: CapabilitySpec[];
}

// ---------- 项目、连接与授权 ----------

export interface Project {
  id: string;
  name: string;
  createdAtUtc: string;
}

/** 权限四分（方案 §06）：分别控制，默认模型外发关闭 */
export interface Grant {
  use: boolean;
  extract: boolean;
  export: boolean;
  modelEgress: boolean;
}

export type ConnectionStatus =
  | "待配置"
  | "待授权"
  | "连接检查通过"
  | "失效"
  | "工具已变化"
  | "已停用";

export interface Connection {
  id: string;
  projectId: string;
  sourceId: string;
  accountAlias: string;
  /** 凭据引用；服务端解析，浏览器不持有长期密钥 */
  credentialRef: string;
  /** 精确能力/工具白名单 */
  capabilities: string[];
  /** 连接修订单调整数；范围变化形成新修订 */
  revision: number;
  grant: Grant;
  status: ConnectionStatus;
  /** 数据验证与连接检查分开（方案 §04 步骤 4） */
  dataValidation: "未验证" | "通过" | "未通过";
  /** 连接检查握手记录的适配版本；与目录登记不一致 → 工具已变化 */
  adapterVersion: string | null;
  /** 凭据解析提示（系统存储不可用时的会话内存提示等；GRILL 包 15/方案 §09） */
  credentialNotice: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}

// ---------- 运行 ----------

export type RunStatus =
  | "未发送"
  | "查询中"
  | "完整返回"
  | "部分返回"
  | "失败"
  | "取消处理中"
  | "已取消"
  | "结果未知";

export type ErrorCategory =
  | "auth_invalid"
  | "scope_insufficient"
  | "permission_denied"
  | "rate_limited"
  | "quota_exhausted"
  | "timeout"
  | "network"
  | "partial_result"
  | "cancelled"
  | "unknown_outcome"
  | "save_failed"
  | "tool_changed"
  | "validation_failed"
  | "license_denied"
  | "stale_params"
  | "not_found"
  | "bad_request";

export interface RunCost {
  /** 费用已知性直接取自目录条目；不得把调用数换算成金额 */
  knownness: CostKnownness;
  note: string;
}

export interface Run {
  id: string;
  projectId: string;
  connectionId: string;
  sourceId: string;
  capabilityId: string;
  templateRevision: string;
  connectionRevision: number;
  /** 脱敏参数（不得含凭据） */
  params: Record<string, unknown>;
  /** 参数指纹：stale 判定依据（GRILL 包 5） */
  paramsFingerprint: string;
  /** 授权快照：执行时的 Grant 固化 */
  grantSnapshot: Grant;
  status: RunStatus;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
  /** 有证据的 Retry-After 秒数；无证据保持 null（未知） */
  retryAfterSeconds: number | null;
  requestCount: number;
  pageCount: number;
  cost: RunCost;
  /** 质量报告（完成检查时写入）；缺失清单双写运行记录与快照 */
  quality: QualityReport | null;
  /** 结果是否已保存为快照 */
  snapshotId: string | null;
  /** 保存层状态（方案 §08）：未保存/保存中/已保存/保存失败 */
  saveStatus: "未保存" | "保存中" | "已保存" | "保存失败";
  /** 命中缓存年龄（小时）；非缓存结果 null（A08 过期标识） */
  cacheAgeHours: number | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}

// ---------- 质量 ----------

export type QualityConclusion = "complete" | "partial" | "warning" | "unusable" | "完整性未知";

export interface QualityReport {
  expectedCount: number | null;
  actualCount: number;
  missingKeys: string[];
  duplicateKeys: string[];
  fieldIssues: { field: string; kind: string; message: string }[];
  unitTimezoneOk: boolean;
  paginationComplete: boolean;
  conclusion: QualityConclusion;
  ruleVersion: string;
  checkedAtUtc: string;
}

// ---------- 快照 ----------

export interface SnapshotManifest {
  schemaVersion: 1;
  identity: {
    snapshotId: string;
    parentSnapshotId: string | null;
    createdAtUtc: string;
  };
  source: {
    sourceId: string;
    providerName: string;
    protocol: string;
    adapterVersion: string | null;
    toolCatalogFingerprint: string | null;
    synthetic: boolean;
  };
  query: {
    capabilityId: string;
    templateRevision: string;
    connectionRevision: number;
    params: Record<string, unknown>;
    paramsFingerprint: string;
    requestCount: number;
    pageCount: number;
  };
  coverage: {
    requested: Record<string, unknown>;
    actual: Record<string, unknown>;
    timezone: string | null;
    units: Record<string, string>;
    coordinates: { requested: [number, number][]; responded: [number, number][] } | null;
  };
  time: {
    collectedAtUtc: string;
    /** 供应商未给更新时间则明确 "unknown"，不用采集时间替代 */
    sourceUpdatedAt: string | "unknown";
    sourceTimezone: string | null;
  };
  quality: QualityReport;
  license: SourceLicense & { synthetic: boolean };
  cost: RunCost;
  files: { path: string; sha256: string; size: number }[];
  /** 原响应是否保留及原因（方案 §07） */
  rawRetained: boolean;
  rawRetainedReason: string;
}

// ---------- 导出台账 ----------

export interface ExportRecord {
  id: string;
  snapshotId: string;
  projectId: string;
  format: "json" | "csv";
  licenseCheck: { exportAllowed: boolean; checkedAt: string };
  grantCheck: Grant;
  createdAtUtc: string;
  filename: string;
}

// ---------- 来源研究草稿 ----------

export interface SourceDraft {
  id: string;
  name: string;
  note: string;
  status: "研究草稿";
  createdAtUtc: string;
}
