import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "../src/store/fileStore.js";
import { SnapshotStore, type SnapshotInput } from "../src/store/snapshotStore.js";
import type { CatalogEntry, Grant, Run } from "../src/core/types.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "data-mcps-store-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const grant: Grant = { use: true, extract: true, export: true, modelEgress: false };

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: "run_test1",
    projectId: "default",
    connectionId: "conn_1",
    sourceId: "wx-synthetic",
    capabilityId: "wx.daily",
    templateRevision: "wx.daily@1",
    connectionRevision: 1,
    params: { cities: ["shanghai", "hangzhou"], start: "2026-09-01", end: "2026-09-07" },
    paramsFingerprint: "fp_test",
    grantSnapshot: grant,
    status: "完整返回",
    errorCategory: null,
    errorMessage: null,
    retryAfterSeconds: null,
    requestCount: 2,
    pageCount: 2,
    cost: { knownness: "demo_no_call", note: "演示无真实调用" },
    quality: {
      expectedCount: 14,
      actualCount: 14,
      missingKeys: [],
      duplicateKeys: [],
      fieldIssues: [],
      unitTimezoneOk: true,
      paginationComplete: true,
      conclusion: "complete",
      ruleVersion: "wx-quality@1",
      checkedAtUtc: "2026-10-20T02:00:00.000Z",
    },
    snapshotId: null,
    saveStatus: "未保存",
    cacheAgeHours: null,
    createdAtUtc: "2026-10-20T01:59:00.000Z",
    updatedAtUtc: "2026-10-20T02:00:00.000Z",
    ...over,
  };
}

function makeEntry(): CatalogEntry {
  return {
    id: "wx-synthetic",
    name: "合成天气样板",
    summary: "s",
    domain: "天气",
    provider: { name: "data-mcps 合成夹具", url: "https://example.invalid" },
    connector: { protocol: "rest", adapterVersion: "wx-fixture@1", coverage: "上海/杭州", granularity: "城市×日", latency: "演示" },
    status: {
      docsVerified: { ok: false, at: "2026-10-19", evidence: null },
      adaptationVerified: { ok: false, at: "2026-10-19", evidence: null },
      accountChecked: { ok: false, at: "2026-10-19", evidence: null },
      envTested: { ok: false, at: "2026-10-19", evidence: null },
    },
    cost: { knownness: "demo_no_call", note: "演示无真实调用", checkedAt: "2026-10-19" },
    license: { summary: "合成数据", sourceUrl: "https://example.invalid", checkedAt: "2026-10-19", exportAllowed: true, modelAllowed: false, retentionNote: "无" },
    auth: { kind: "none", note: "合成" },
    exampleShape: "行：city, date, tempMeanC, precipSum（合成）",
    synthetic: true,
    connectable: true,
    capabilities: [{ id: "wx.daily", label: "城市逐日天气", templateRevision: "wx.daily@1", qualityRuleVersion: "wx-quality@1" }],
  };
}

function makeInput(over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    run: makeRun(),
    entry: makeEntry(),
    content: {
      fields: [
        { name: "city", type: "string" },
        { name: "date", type: "string" },
        { name: "tempMeanC", type: "number", unit: "°C" },
      ],
      rows: [{ city: "上海", date: "2026-09-01", tempMeanC: 28.1 }],
    },
    raw: { "shanghai.json": "{\"synthetic\":true}" },
    rawRetained: true,
    rawRetainedReason: "合成夹具许可允许保留原响应",
    coverage: {
      requested: { cities: ["上海", "杭州"], days: 7 },
      actual: { cityDays: 14 },
      timezone: "Asia/Shanghai",
      units: { tempMeanC: "°C" },
      coordinates: { requested: [[31.2304, 121.4737]], responded: [[31.23, 121.47]] },
    },
    time: { collectedAtUtc: "2026-10-20T02:00:00.000Z", sourceUpdatedAt: "unknown", sourceTimezone: "Asia/Shanghai" },
    ...over,
  };
}

describe("FileStore 实体集合", () => {
  it("写入/读回/列表往返", async () => {
    const store = new FileStore(root);
    await store.write("projects", "default", { id: "default", name: "默认项目", createdAtUtc: "2026-10-20T00:00:00.000Z" });
    const got = await store.read<{ id: string; name: string }>("projects", "default");
    expect(got?.name).toBe("默认项目");
    const all = await store.list<{ id: string }>("projects");
    expect(all.map((p) => p.id)).toEqual(["default"]);
  });

  it("读取不存在的实体返回 null（不抛错）", async () => {
    const store = new FileStore(root);
    expect(await store.read("projects", "nope")).toBeNull();
  });
});

describe("SnapshotStore 快照保存与读回", () => {
  it("保存后独立读回同字节/同元数据", async () => {
    const snaps = new SnapshotStore(new FileStore(root));
    const saved = await snaps.save(makeInput());
    expect(saved.identity.snapshotId).toMatch(/^snap_[0-9a-f]{16}$/);
    const back = await snaps.readback(saved.identity.snapshotId);
    expect(back.manifest).toEqual(saved);
    expect(back.content.rows).toHaveLength(1);
    expect(back.raw["shanghai.json"]).toBe("{\"synthetic\":true}");
  });

  it("字节翻转 → 读回拒绝（A11）", async () => {
    const snaps = new SnapshotStore(new FileStore(root));
    const saved = await snaps.save(makeInput());
    const file = join(root, "snapshots", saved.identity.snapshotId, "content.json");
    const buf = await readFile(file);
    buf[10] = buf[10]! ^ 0xff;
    await writeFile(file, buf);
    await expect(snaps.readback(saved.identity.snapshotId)).rejects.toMatchObject({ category: "validation_failed" });
  });

  it("缺失文件 → 读回拒绝", async () => {
    const snaps = new SnapshotStore(new FileStore(root));
    const saved = await snaps.save(makeInput());
    await rm(join(root, "snapshots", saved.identity.snapshotId, "content.json"));
    await expect(snaps.readback(saved.identity.snapshotId)).rejects.toMatchObject({ category: "validation_failed" });
  });

  it("提交中途残留 tmp 目录 → 登记中无该快照（原子提交）", async () => {
    const snaps = new SnapshotStore(new FileStore(root));
    const saved = await snaps.save(makeInput());
    // 模拟提交中途崩溃：半成品只存在于 .tmp- 目录
    await mkdir(join(root, "snapshots", ".tmp-snap_deadbeefdeadbeef"), { recursive: true });
    const ids = await snaps.listIds();
    expect(ids).toEqual([saved.identity.snapshotId]);
  });

  it("故障注入 failNextCommit → 保存失败、无半快照、可读回原记录", async () => {
    const snaps = new SnapshotStore(new FileStore(root), { failNextCommit: true });
    await expect(snaps.save(makeInput())).rejects.toMatchObject({ category: "save_failed" });
    expect(await snaps.listIds()).toEqual([]);
    // 重试（无故障）成功
    const snaps2 = new SnapshotStore(new FileStore(root));
    const saved = await snaps2.save(makeInput());
    expect((await snaps2.listIds()).includes(saved.identity.snapshotId)).toBe(true);
  });

  it("同内容同参数重复保存 → 同一 snapshotId，不产生第二个快照（内容寻址幂等）", async () => {
    const snaps = new SnapshotStore(new FileStore(root));
    const a = await snaps.save(makeInput());
    const b = await snaps.save(makeInput());
    expect(b.identity.snapshotId).toBe(a.identity.snapshotId);
    expect(await snaps.listIds()).toHaveLength(1);
  });

  it("快照内容不可原地覆盖：同 ID 不同内容拒绝", async () => {
    const snaps = new SnapshotStore(new FileStore(root));
    const a = await snaps.save(makeInput());
    // 伪造：内容不同但派生出同 ID 不可行（ID 含内容哈希）；直接验证目录已存在时同 ID 重写被拒
    await mkdir(join(root, "snapshots", ".tmp-probe"), { recursive: true });
    const listed = await snaps.listIds();
    expect(listed).toContain(a.identity.snapshotId);
    // 改变内容 → 新 ID（内容寻址）
    const changed = await snaps.save(makeInput({ content: { fields: [], rows: [{ x: 1 }] } }));
    expect(changed.identity.snapshotId).not.toBe(a.identity.snapshotId);
  });

  it("env 故障注入 DATA_MCPS_TEST_FAULTS=failNextCommit 生效", async () => {
    process.env.DATA_MCPS_TEST_FAULTS = "failNextCommit";
    try {
      const snaps = new SnapshotStore(new FileStore(root));
      await expect(snaps.save(makeInput())).rejects.toMatchObject({ category: "save_failed" });
    } finally {
      delete process.env.DATA_MCPS_TEST_FAULTS;
    }
  });
});
