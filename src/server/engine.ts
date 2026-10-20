import { AppError, errors } from "../core/errors.js";
import { paramsFingerprint } from "../core/fingerprint.js";
import { newId, nowUtc } from "../core/ids.js";
import type { CatalogEntry, Connection, Run } from "../core/types.js";
import type { AdapterOutcome } from "../adapters/types.js";
import { SessionMemoryCredentialResolver, type CredentialResolver } from "../adapters/credentials.js";
import type { FixtureScenario } from "../adapters/fixtureTransport.js";
import type { FileStore } from "../store/fileStore.js";
import { SnapshotStore, type SnapshotInput } from "../store/snapshotStore.js";
import type { SnapshotManifest } from "../core/types.js";
import { mustCapability } from "./capabilities.js";

export interface EngineDeps {
  store: FileStore;
  snapshots: SnapshotStore;
  catalog: Map<string, CatalogEntry>;
  credentials?: CredentialResolver;
  /** 仅测试：注入运行级故障/挂起 */
  runScenario?: FixtureScenario;
}

interface Inflight {
  controller: AbortController;
  outcome?: AdapterOutcome;
}

const RUNS = "runs";
const CONNECTIONS = "connections";

export class Engine {
  private inflight = new Map<string, Inflight>();
  private readonly credentials: CredentialResolver;

  constructor(private readonly deps: EngineDeps) {
    this.credentials = deps.credentials ?? new SessionMemoryCredentialResolver();
  }

  get store(): FileStore {
    return this.deps.store;
  }

  get snapshots(): SnapshotStore {
    return this.deps.snapshots;
  }

  // ---------- 连接 ----------

  async createConnection(input: {
    projectId: string;
    sourceId: string;
    accountAlias: string;
    credentialRef: string;
    capabilities: string[];
    grant: Connection["grant"];
    confirmScope?: boolean;
  }): Promise<Connection> {
    const project = await this.store.read("projects", input.projectId);
    if (!project) throw errors.notFound(`项目不存在：${input.projectId}`);
    const entry = this.deps.catalog.get(input.sourceId);
    if (!entry) throw errors.notFound(`来源不存在：${input.sourceId}`);
    if (!entry.connectable) {
      throw errors.permissionDenied(`来源「${entry.name}」当前不可连接（${entry.status.adaptationVerified.ok ? "账户权限待核对" : "适配待验证"}）；接入条件见来源详情`, { sourceId: entry.id });
    }
    if (input.confirmScope !== true) {
      throw errors.validationFailed("建立连接前必须显式确认授权范围（confirmScope）");
    }
    if (!input.grant || typeof input.grant !== "object") {
      throw errors.validationFailed("建立连接必须携带四权初值（grant）");
    }
    const offered = new Set(entry.capabilities.map((c) => c.id));
    for (const cap of input.capabilities) {
      if (!offered.has(cap)) throw errors.scopeInsufficient(`能力 ${cap} 不在来源提供范围`, { capability: cap });
    }
    // 凭据只按引用解析（方案 §09）；系统存储不可用时记录会话内存提示
    const cred = this.credentials.resolve(input.credentialRef.trim() || "synthetic-none");
    if (!cred.ok) throw errors.authInvalid(cred.notice ?? "凭据引用无效");
    const now = nowUtc();
    const conn: Connection = {
      id: newId("conn"),
      projectId: input.projectId,
      sourceId: input.sourceId,
      accountAlias: input.accountAlias.trim() || "未命名账户",
      credentialRef: input.credentialRef.trim() || "synthetic-none",
      capabilities: input.capabilities,
      revision: 1,
      grant: { ...input.grant, modelEgress: false }, // R1 恒关（GRILL 包 2）
      status: "待配置",
      dataValidation: "未验证",
      adapterVersion: null,
      credentialNotice: cred.sessionOnly ? cred.notice : null,
      createdAtUtc: now,
      updatedAtUtc: now,
    };
    await this.store.write(CONNECTIONS, conn.id, conn);
    return conn;
  }

  /** 连接检查（协议/鉴权握手）：与数据验证分开（方案 §04 步骤 4；GRILL 包 11） */
  async checkConnection(connId: string): Promise<Connection> {
    const conn = await this.mustConnection(connId);
    const entry = this.deps.catalog.get(conn.sourceId)!;
    if (!conn.grant.use) throw errors.permissionDenied("项目使用权已撤销，不能检查连接");
    if (!entry.synthetic) throw errors.permissionDenied("真实来源未授权，连接检查未执行");
    // 真实握手：调适配器握手端点，核对适配版本与目录登记是否一致
    const handler = mustCapability(conn.capabilities[0] ?? "");
    const { adapterVersion } = await handler.handshake();
    conn.adapterVersion = adapterVersion;
    conn.status = adapterVersion === entry.connector.adapterVersion ? "连接检查通过" : "工具已变化";
    conn.updatedAtUtc = nowUtc();
    await this.store.write(CONNECTIONS, conn.id, conn);
    return conn;
  }

  /** 数据验证：一次受限测试查询（天气 1 城 1 日 / 画像单档），不产生快照 */
  async validateConnection(connId: string): Promise<Connection> {
    const conn = await this.mustConnection(connId);
    if (!conn.grant.use || !conn.grant.extract) throw errors.permissionDenied("缺少提取权，数据验证未发送");
    try {
      const handler = mustCapability(conn.capabilities[0] ?? "");
      conn.dataValidation = (await handler.validate()) ? "通过" : "未通过";
    } catch {
      conn.dataValidation = "未通过";
    }
    conn.updatedAtUtc = nowUtc();
    await this.store.write(CONNECTIONS, conn.id, conn);
    return conn;
  }

  async updateGrant(connId: string, grant: Partial<Connection["grant"]>): Promise<Connection> {
    const conn = await this.mustConnection(connId);
    conn.grant = { ...conn.grant, ...grant, modelEgress: false }; // R1 恒关
    conn.revision += 1; // 授权范围变化形成新修订
    conn.updatedAtUtc = nowUtc();
    await this.store.write(CONNECTIONS, conn.id, conn);
    return conn;
  }

  // ---------- 运行 ----------

  /** Run 工厂（REVIEW 收敛：createRun/persistBlockedRun 共享初始化，加字段只改此处） */
  private baseRun(input: {
    projectId: string;
    connectionId: string;
    sourceId: string;
    capabilityId: string;
    templateRevision: string;
    connectionRevision: number;
    params: Record<string, unknown>;
    paramsFingerprint: string;
    conn: Connection;
    entry: CatalogEntry;
    status: Run["status"];
    errorCategory?: Run["errorCategory"];
    errorMessage?: string | null;
  }): Run {
    const now = nowUtc();
    return {
      id: newId("run"),
      projectId: input.projectId,
      connectionId: input.connectionId,
      sourceId: input.sourceId,
      capabilityId: input.capabilityId,
      templateRevision: input.templateRevision,
      connectionRevision: input.connectionRevision,
      params: input.params,
      paramsFingerprint: input.paramsFingerprint,
      grantSnapshot: { ...input.conn.grant },
      status: input.status,
      errorCategory: input.errorCategory ?? null,
      errorMessage: input.errorMessage ?? null,
      retryAfterSeconds: null,
      requestCount: 0,
      pageCount: 0,
      cost: { knownness: input.entry.cost.knownness, note: input.entry.cost.note },
      quality: null,
      snapshotId: null,
      saveStatus: "未保存",
      cacheAgeHours: null,
      createdAtUtc: now,
      updatedAtUtc: now,
    };
  }

  async createRun(input: {
    projectId: string;
    connectionId: string;
    capabilityId: string;
    params: Record<string, unknown>;
  }): Promise<Run> {
    const conn = await this.mustConnection(input.connectionId);
    const entry = this.deps.catalog.get(conn.sourceId)!;
    const cap = entry.capabilities.find((c) => c.id === input.capabilityId);
    // 发送前阻断（A04/授权/白名单/费用）：保留阻断记录，请求数 0，无伪成功
    const blocked = (category: Run["errorCategory"] & string, message: string) =>
      this.baseRun({
        ...input,
        sourceId: conn.sourceId,
        templateRevision: cap?.templateRevision ?? "unknown",
        connectionRevision: conn.revision,
        paramsFingerprint: "blocked",
        conn,
        entry,
        status: "未发送",
        errorCategory: category,
        errorMessage: message,
      });
    let run: Run;
    if (conn.projectId !== input.projectId) {
      run = blocked("permission_denied", "连接不属于当前项目：发送前拒绝，请求数 0；不读取其他项目凭据");
    } else if (!conn.grant.use || !conn.grant.extract) {
      run = blocked("permission_denied", "缺少项目使用权/提取权：授权不足，未发送请求");
    } else if (!conn.capabilities.includes(input.capabilityId) || !cap) {
      run = blocked("scope_insufficient", `能力 ${input.capabilityId} 不在连接白名单：未发送请求`);
    } else if (!entry.synthetic) {
      // 费用已知性：真实源非已核对账户一律阻断（GRILL 包 2/US 7）；合成源为演示无调用
      run = blocked("permission_denied", "真实来源未授权：费用/许可未核实，默认不执行");
    } else {
      const normalized = mustCapability(input.capabilityId).normalize(input.params);
      const fp = paramsFingerprint({
        connectorId: entry.id,
        capabilityId: input.capabilityId,
        templateRevision: cap.templateRevision,
        params: normalized,
      });
      run = this.baseRun({
        ...input,
        sourceId: entry.id,
        templateRevision: cap.templateRevision,
        connectionRevision: conn.revision,
        params: normalized,
        paramsFingerprint: fp,
        conn,
        entry,
        status: "查询中",
      });
    }
    await this.store.write(RUNS, run.id, run);
    if (run.status !== "查询中") return run;

    const controller = new AbortController();
    const inflight: Inflight = { controller };
    this.inflight.set(run.id, inflight);
    void this.execute(run.id, controller.signal).catch(() => {});
    return run;
  }

  private async execute(runId: string, signal: AbortSignal): Promise<void> {
    const run = (await this.store.read<Run>(RUNS, runId))!;
    const inflight = this.inflight.get(runId)!;
    try {
      const outcome = await mustCapability(run.capabilityId).execute(run.params, signal, this.deps.runScenario);
      run.requestCount = outcome.requestCount;
      run.pageCount = outcome.pageCount;
      if (outcome.lateAfterAbort || run.status === "取消处理中") {
        // 迟到结果：隔离，不自动保存/交付；结果与费用保持未知（方案 §08）
        run.status = "结果未知";
        run.errorCategory = "unknown_outcome";
        run.errorMessage = "取消后仍收到迟到结果：已隔离，未保存；费用是否发生未知";
      } else {
        const quality = mustCapability(run.capabilityId).checkQuality(run, outcome);
        run.quality = quality;
        if (quality.conclusion === "unusable") {
          run.status = "失败";
          run.errorCategory = "validation_failed";
          run.errorMessage = "关键口径不明（标识/日期/单位/授权），不可消费";
        } else {
          run.status = quality.conclusion === "partial" ? "部分返回" : "完整返回";
          run.cacheAgeHours = outcome.cacheAgeHours ?? null;
          inflight.outcome = outcome;
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        run.status = "已取消";
        run.errorCategory = "cancelled";
        run.errorMessage = "已证实停止新请求";
      } else if (err instanceof AppError) {
        run.status = "失败";
        run.errorCategory = err.category;
        run.errorMessage = err.message;
        if (err.retryAfterSeconds !== undefined) run.retryAfterSeconds = err.retryAfterSeconds;
        const rc = err.details?.requestCount;
        const pc = err.details?.pageCount;
        if (typeof rc === "number") run.requestCount = rc;
        if (typeof pc === "number") run.pageCount = pc;
      } else {
        run.status = "结果未知";
        run.errorCategory = "unknown_outcome";
        run.errorMessage = `未分类异常：${(err as Error).message}；结果与费用未知`;
      }
    }
    run.updatedAtUtc = nowUtc();
    await this.store.write(RUNS, runId, run);
  }

  async cancelRun(runId: string): Promise<Run> {
    const run = await this.mustRun(runId);
    if (run.status !== "查询中") {
      throw errors.badRequest(`仅「查询中」可取消；当前状态：${run.status}`);
    }
    run.status = "取消处理中";
    run.updatedAtUtc = nowUtc();
    await this.store.write(RUNS, runId, run);
    this.inflight.get(runId)?.controller.abort();
    return run;
  }

  /** 预览：结果驻留进程内存（GRILL 包 3） */
  async preview(runId: string): Promise<{ run: Run; outcome: AdapterOutcome | null }> {
    const run = await this.mustRun(runId);
    const outcome = this.inflight.get(runId)?.outcome ?? null;
    return { run, outcome };
  }

  async saveRun(runId: string, opts: { paramsFingerprint: string; acknowledgePartial?: boolean }): Promise<SnapshotManifest> {
    const run = await this.mustRun(runId);
    if (run.saveStatus === "已保存" && run.snapshotId) {
      // 幂等：同运行重试保存返回同一快照，不重查供应商（A11）
      return (await this.snapshots.readback(run.snapshotId)).manifest;
    }
    if (opts.paramsFingerprint !== run.paramsFingerprint) {
      throw errors.staleParams("结果与当前参数不同：不能用旧结果保存成新参数的产物");
    }
    if (run.status !== "完整返回" && run.status !== "部分返回") {
      throw errors.validationFailed(`运行状态 ${run.status} 不可保存`);
    }
    const outcome = this.inflight.get(runId)?.outcome;
    if (!outcome) {
      throw new AppError(409, "unknown_outcome", "查询结果不在内存（可能进程已重启）：不盲目重放，请显式新建运行");
    }
    const restricted = run.quality?.conclusion === "partial" || (run.cacheAgeHours ?? 0) > 0;
    if (restricted && opts.acknowledgePartial !== true) {
      throw errors.validationFailed("受限结果（部分/过期缓存）需显式确认后才可保存，缺口与年龄随快照绑定", {
        missingKeys: run.quality?.missingKeys ?? [],
        cacheAgeHours: run.cacheAgeHours,
      });
    }
    const conn = await this.mustConnection(run.connectionId);
    if (!conn.grant.use || !conn.grant.extract) {
      throw errors.permissionDenied("授权已撤销：保存被阻断（历史记录保留）");
    }
    const entry = this.deps.catalog.get(run.sourceId)!;

    run.saveStatus = "保存中";
    run.updatedAtUtc = nowUtc();
    await this.store.write(RUNS, runId, run);

    const input: SnapshotInput = {
      run,
      entry,
      content: outcome.content,
      raw: outcome.raw,
      rawRetained: true,
      rawRetainedReason: entry.synthetic ? "合成夹具许可允许保留原响应" : "按来源许可核对",
      coverage: {
        requested: run.params,
        actual: {
          rows: outcome.content.rows.length,
          incompleteReasons: outcome.incompleteReasons,
          cacheAgeHours: outcome.cacheAgeHours ?? null,
          ...(outcome.coverageExtra ?? {}),
        },
        timezone: outcome.timezone,
        units: outcome.units,
        coordinates: outcome.coordinates,
      },
      time: {
        collectedAtUtc: nowUtc(),
        sourceUpdatedAt: outcome.sourceUpdatedAt,
        sourceTimezone: outcome.timezone,
      },
    };
    try {
      const manifest = await this.snapshots.save(input);
      run.snapshotId = manifest.identity.snapshotId;
      run.saveStatus = "已保存";
      run.updatedAtUtc = nowUtc();
      await this.store.write(RUNS, runId, run);
      return manifest;
    } catch (err) {
      run.saveStatus = "保存失败";
      run.updatedAtUtc = nowUtc();
      await this.store.write(RUNS, runId, run);
      throw err;
    }
  }

  /** 进程重启恢复（GRILL 包 3） */
  async recoverOnStart(): Promise<number> {
    const runs = await this.store.list<Run>(RUNS);
    let recovered = 0;
    for (const run of runs) {
      if (run.status === "查询中" || run.status === "取消处理中") {
        run.status = "结果未知";
        run.errorCategory = "unknown_outcome";
        run.errorMessage = "进程中断：结果与费用未知，不盲目重放";
        run.updatedAtUtc = nowUtc();
        await this.store.write(RUNS, run.id, run);
        recovered += 1;
      } else if (run.saveStatus === "保存中") {
        run.saveStatus = "保存失败";
        run.errorMessage = "进程中断于保存中：无半快照，可读回原记录";
        run.updatedAtUtc = nowUtc();
        await this.store.write(RUNS, run.id, run);
        recovered += 1;
      }
    }
    return recovered;
  }

  async mustRun(runId: string): Promise<Run> {
    const run = await this.store.read<Run>(RUNS, runId);
    if (!run) throw errors.notFound(`运行不存在：${runId}`);
    return run;
  }

  async mustConnection(connId: string): Promise<Connection> {
    const conn = await this.store.read<Connection>(CONNECTIONS, connId);
    if (!conn) throw errors.notFound(`连接不存在：${connId}`);
    return conn;
  }
}
