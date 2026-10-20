import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize, contentId, sha256Hex } from "../core/canonical.js";
import { AppError, errors } from "../core/errors.js";
import type { CatalogEntry, Run, SnapshotManifest } from "../core/types.js";
import type { FileStore } from "./fileStore.js";

export interface SnapshotContent {
  fields: { name: string; type: string; unit?: string }[];
  rows: Record<string, unknown>[];
}

export interface SnapshotInput {
  run: Run;
  entry: CatalogEntry;
  content: SnapshotContent;
  /** 原响应（文件名 → 内容）；许可不允许保留时为空并说明原因 */
  raw?: Record<string, string>;
  rawRetained: boolean;
  rawRetainedReason: string;
  coverage: SnapshotManifest["coverage"];
  time: SnapshotManifest["time"];
}

export interface SnapshotFaults {
  /** 仅测试：下一次提交在 rename 前失败（PRD GRILL 包 14） */
  failNextCommit?: boolean;
}

/**
 * 快照存储：不可变、原子提交、独立读回校验（方案 §07）。
 * 提交 = 写 snapshots/.tmp-<id>/ → 校验文件与元数据 → rename → snapshots/<id>/。
 * tmp 残留不进入登记（listIds 过滤 .tmp- 前缀）。
 */
export class SnapshotStore {
  constructor(
    private readonly store: FileStore,
    private readonly faults: SnapshotFaults = {},
  ) {}

  private get root(): string {
    return this.store.root;
  }

  private injectedFailNext(): boolean {
    if (this.faults.failNextCommit) return true;
    return (process.env.DATA_MCPS_TEST_FAULTS ?? "").split(",").includes("failNextCommit");
  }

  async save(input: SnapshotInput): Promise<SnapshotManifest> {
    const { run, entry, content } = input;
    if (!run.quality) throw errors.validationFailed("运行缺少质量报告，不能保存");

    // 1) 组装内容文件字节
    const files: { path: string; body: string }[] = [{ path: "content.json", body: canonicalize(content) }];
    for (const [name, body] of Object.entries(input.raw ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
      files.push({ path: `raw/${name}`, body });
    }
    const fileHashes = files.map((f) => ({ path: f.path, sha256: sha256Hex(f.body), size: Buffer.byteLength(f.body) }));

    // 2) 内容寻址 ID：内容哈希 + 参数指纹 + 修订 + 质量结论（不含 createdAtUtc/自身）
    const snapshotId = contentId(
      "snap",
      fileHashes,
      run.paramsFingerprint,
      run.templateRevision,
      run.connectionRevision,
      run.quality.conclusion,
    );

    const finalDir = join(this.root, "snapshots", snapshotId);
    // 内容寻址幂等：同 ID 已存在且可读回 → 直接返回既有 manifest，不重写（不可原地覆盖）
    const existing = await this.tryReadManifest(snapshotId);
    if (existing) return existing;

    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      identity: { snapshotId, parentSnapshotId: null, createdAtUtc: new Date().toISOString() },
      source: {
        sourceId: entry.id,
        providerName: entry.provider.name,
        protocol: entry.connector.protocol,
        adapterVersion: entry.connector.adapterVersion,
        toolCatalogFingerprint: null,
        synthetic: entry.synthetic,
      },
      query: {
        capabilityId: run.capabilityId,
        templateRevision: run.templateRevision,
        connectionRevision: run.connectionRevision,
        params: run.params,
        paramsFingerprint: run.paramsFingerprint,
        requestCount: run.requestCount,
        pageCount: run.pageCount,
      },
      coverage: input.coverage,
      time: input.time,
      quality: run.quality,
      license: { ...entry.license, synthetic: entry.synthetic },
      cost: run.cost,
      files: fileHashes,
      rawRetained: input.rawRetained,
      rawRetainedReason: input.rawRetainedReason,
    };

    // 3) 原子提交
    const tmpDir = join(this.root, "snapshots", `.tmp-${snapshotId}`);
    try {
      await mkdir(join(tmpDir, "raw"), { recursive: true });
      for (const f of files) {
        await writeFile(join(tmpDir, f.path), f.body, "utf8");
      }
      await writeFile(join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
      if (this.injectedFailNext()) {
        throw errors.saveFailed("注入故障：提交前失败（failNextCommit）");
      }
      await rename(tmpDir, finalDir);
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      if (err instanceof AppError) throw err;
      throw errors.saveFailed(`快照提交失败：${(err as Error).message}`);
    }
    return manifest;
  }

  /** 独立读回：校验每个文件 sha256+size，坏 hash/缺文件拒绝（A11） */
  async readback(snapshotId: string): Promise<{ manifest: SnapshotManifest; content: SnapshotContent; raw: Record<string, string> }> {
    const dir = join(this.root, "snapshots", snapshotId);
    const manifest = await this.tryReadManifest(snapshotId);
    if (!manifest) throw errors.notFound(`快照不存在或未完成提交：${snapshotId}`);
    const raw: Record<string, string> = {};
    let content: SnapshotContent | null = null;
    for (const f of manifest.files) {
      let body: string;
      try {
        body = await readFile(join(dir, f.path), "utf8");
      } catch {
        throw errors.validationFailed(`快照损坏：缺文件 ${f.path}`, { snapshotId, file: f.path });
      }
      const actual = sha256Hex(body);
      if (actual !== f.sha256 || Buffer.byteLength(body) !== f.size) {
        throw errors.validationFailed(`快照损坏：哈希/大小不匹配 ${f.path}`, { snapshotId, file: f.path });
      }
      if (f.path === "content.json") content = JSON.parse(body) as SnapshotContent;
      else if (f.path.startsWith("raw/")) raw[f.path.slice(4)] = body;
    }
    if (!content) throw errors.validationFailed("快照损坏：缺 content.json", { snapshotId });
    return { manifest, content, raw };
  }

  async listIds(): Promise<string[]> {
    const dir = join(this.root, "snapshots");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names.filter((n) => n.startsWith("snap_")).sort();
  }

  private async tryReadManifest(snapshotId: string): Promise<SnapshotManifest | null> {
    try {
      const body = await readFile(join(this.root, "snapshots", snapshotId, "manifest.json"), "utf8");
      return JSON.parse(body) as SnapshotManifest;
    } catch {
      return null;
    }
  }
}
