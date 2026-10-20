import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";

let srv: RunningServer;
let root: string;
let base: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "data-mcps-fail-"));
  srv = await startServer({ port: 0, dataRoot: root });
  base = `http://127.0.0.1:${srv.port}`;
});
afterEach(async () => {
  await srv.close();
  await rm(root, { recursive: true, force: true });
});

const api = {
  async get(p: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/v1${p}`);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  },
  async post(p: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/v1${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  },
};

const GRANT = { use: true, extract: true, export: true, modelEgress: false };
const WX = { cities: ["shanghai", "hangzhou"], start: "2026-09-01", end: "2026-09-07", timezone: "Asia/Shanghai", variables: ["tempMeanC", "precipSum"] };

async function connect(): Promise<string> {
  const res = await api.post("/connections", {
    projectId: "default",
    sourceId: "wx-synthetic",
    accountAlias: "演示账户",
    credentialRef: "keychain://demo-secret-ref",
    capabilities: ["wx.daily"],
    grant: GRANT,
    confirmScope: true,
  });
  await api.post(`/connections/${res.body.id}/check`);
  return res.body.id;
}

async function settle(runId: string, tries = 200): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const got = await api.get(`/runs/${runId}`);
    if (!["查询中", "取消处理中"].includes(got.body.run.status)) return got.body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("运行未收敛");
}

describe("失败路径（A02/A06/A07/A08/A11）", () => {
  it("A02 部分结果：13/14 缺失清单、保存需显式确认、缺口随快照绑定", async () => {
    const connId = await connect();
    const run = await api.post("/runs", {
      projectId: "default", connectionId: connId, capabilityId: "wx.daily",
      params: { ...WX, scenario: { missingByCity: { hangzhou: ["2026-09-03"] } } },
    });
    const settled = await settle(run.body.id);
    expect(settled.run.status).toBe("部分返回");
    expect(settled.run.quality.conclusion).toBe("partial");
    expect(settled.run.quality.missingKeys).toEqual(["杭州|2026-09-03"]);
    // 不填零
    expect(settled.preview.content.rows).toHaveLength(13);
    expect(settled.preview.content.rows.every((r: any) => typeof r.tempMeanC === "number")).toBe(true);
    // 未确认保存 → 422
    const denied = await api.post(`/runs/${run.body.id}/save`, { paramsFingerprint: run.body.paramsFingerprint });
    expect(denied.status).toBe(422);
    // 显式确认 → 受限快照
    const saved = await api.post(`/runs/${run.body.id}/save`, { paramsFingerprint: run.body.paramsFingerprint, acknowledgePartial: true });
    expect(saved.status).toBe(200);
    expect(saved.body.quality.missingKeys).toEqual(["杭州|2026-09-03"]);
  });

  it("A06 限流 429 + Retry-After：分类 rate_limited、秒数保留、不隐式重试", async () => {
    const connId = await connect();
    const run = await api.post("/runs", {
      projectId: "default", connectionId: connId, capabilityId: "wx.daily",
      params: { ...WX, scenario: { failCity: "hangzhou", failStatus: 429, retryAfter: "60" } },
    });
    const settled = await settle(run.body.id);
    expect(settled.run.status).toBe("失败");
    expect(settled.run.errorCategory).toBe("rate_limited");
    expect(settled.run.retryAfterSeconds).toBe(60);
    expect(settled.run.requestCount).toBe(2); // 上海 1 次成功 + 杭州 1 次被拒；无隐藏重试
    expect(settled.run.cost.knownness).toBe("demo_no_call");
  });

  it("A06 额度耗尽 429：quota_exhausted，与频率限流区分", async () => {
    const connId = await connect();
    const run = await api.post("/runs", {
      projectId: "default", connectionId: connId, capabilityId: "wx.daily",
      params: { ...WX, scenario: { failCity: "shanghai", failStatus: 429, quotaExhausted: true } },
    });
    const settled = await settle(run.body.id);
    expect(settled.run.errorCategory).toBe("quota_exhausted");
    expect(settled.run.retryAfterSeconds).toBeNull();
  });

  it("401 鉴权失效：auth_invalid，计费未知性单列", async () => {
    const connId = await connect();
    const run = await api.post("/runs", {
      projectId: "default", connectionId: connId, capabilityId: "wx.daily",
      params: { ...WX, scenario: { failCity: "shanghai", failStatus: 401 } },
    });
    const settled = await settle(run.body.id);
    expect(settled.run.errorCategory).toBe("auth_invalid");
    expect(settled.run.status).toBe("失败");
  });

  it("A07 取消：查询中取消 → 已取消，无迟到结果；重复取消 400", async () => {
    const connId = await connect();
    const run = await api.post("/runs", {
      projectId: "default", connectionId: connId, capabilityId: "wx.daily",
      params: { ...WX, scenario: { heldMs: 3000 } },
    });
    await new Promise((r) => setTimeout(r, 150));
    const cancel = await api.post(`/runs/${run.body.id}/cancel`);
    expect(cancel.body.status).toBe("取消处理中");
    const settled = await settle(run.body.id);
    expect(settled.run.status).toBe("已取消");
    expect(settled.run.requestCount).toBe(0);
    const again = await api.post(`/runs/${run.body.id}/cancel`);
    expect(again.status).toBe(400);
  });

  it("A07 取消后迟到结果：隔离不自动保存，状态「结果未知」，保存被拒", async () => {
    const connId = await connect();
    const run = await api.post("/runs", {
      projectId: "default", connectionId: connId, capabilityId: "wx.daily",
      params: { ...WX, scenario: { heldMs: 2500, lateResultOnAbort: true } },
    });
    await new Promise((r) => setTimeout(r, 150));
    await api.post(`/runs/${run.body.id}/cancel`);
    const settled = await settle(run.body.id);
    expect(settled.run.status).toBe("结果未知");
    expect(settled.run.errorCategory).toBe("unknown_outcome");
    const save = await api.post(`/runs/${run.body.id}/save`, { paramsFingerprint: run.body.paramsFingerprint });
    expect(save.status).toBe(422); // 运行状态不可保存
  });

  it("超时（挂起超过 10s 上限）→ 失败/timeout，提示不盲目重试", { timeout: 20000 }, async () => {
    const connId = await connect();
    const run = await api.post("/runs", {
      projectId: "default", connectionId: connId, capabilityId: "wx.daily",
      params: { ...WX, scenario: { heldMs: 12000 } },
    });
    const settled = await settle(run.body.id, 600); // 10s 超时上限 + 余量
    expect(settled.run.status).toBe("失败");
    expect(settled.run.errorCategory).toBe("timeout");
    expect(settled.run.errorMessage).toContain("未知");
  });

  it("A08 过期缓存：72h 标签保留，保存需显式确认，年龄随快照绑定", async () => {
    const connId = await connect();
    const run = await api.post("/runs", {
      projectId: "default", connectionId: connId, capabilityId: "wx.daily",
      params: { ...WX, scenario: { staleHours: 72 } },
    });
    const settled = await settle(run.body.id);
    expect(settled.run.status).toBe("完整返回");
    expect(settled.run.cacheAgeHours).toBe(72);
    const denied = await api.post(`/runs/${run.body.id}/save`, { paramsFingerprint: run.body.paramsFingerprint });
    expect(denied.status).toBe(422);
    const saved = await api.post(`/runs/${run.body.id}/save`, { paramsFingerprint: run.body.paramsFingerprint, acknowledgePartial: true });
    expect(saved.body.coverage.actual.cacheAgeHours).toBe(72);
  });

  it("A11 保存失败：无半快照；同运行重试保存不重新查询（请求数不变）", async () => {
    const connId = await connect();
    const run = await api.post("/runs", { projectId: "default", connectionId: connId, capabilityId: "wx.daily", params: WX });
    const settled = await settle(run.body.id);
    expect(settled.run.status).toBe("完整返回");

    process.env.DATA_MCPS_TEST_FAULTS = "failNextCommit";
    const failed = await api.post(`/runs/${run.body.id}/save`, { paramsFingerprint: run.body.paramsFingerprint });
    delete process.env.DATA_MCPS_TEST_FAULTS;
    expect(failed.status).toBe(500);
    expect(failed.body.error.category).toBe("save_failed");
    const afterFail = await api.get(`/runs/${run.body.id}`);
    expect(afterFail.body.run.saveStatus).toBe("保存失败");
    expect((await api.get("/snapshots?projectId=default")).body).toHaveLength(0);

    const retry = await api.post(`/runs/${run.body.id}/save`, { paramsFingerprint: run.body.paramsFingerprint });
    expect(retry.status).toBe(200);
    const finalRun = await api.get(`/runs/${run.body.id}`);
    expect(finalRun.body.run.requestCount).toBe(2); // 未重新查询供应商
    expect(finalRun.body.run.saveStatus).toBe("已保存");
  });

  it("进程重启恢复：查询中的运行标记「结果未知」，不可再保存", async () => {
    const connId = await connect();
    const run = await api.post("/runs", {
      projectId: "default", connectionId: connId, capabilityId: "wx.daily",
      params: { ...WX, scenario: { heldMs: 10000 } },
    });
    await new Promise((r) => setTimeout(r, 100));
    // 模拟进程重启：关闭服务，以同一 dataRoot 重启
    await srv.close();
    srv = await startServer({ port: 0, dataRoot: root });
    base = `http://127.0.0.1:${srv.port}`;
    const got = await api.get(`/runs/${run.body.id}`);
    expect(got.body.run.status).toBe("结果未知");
    expect(got.body.run.errorMessage).toContain("进程中断");
    const save = await api.post(`/runs/${run.body.id}/save`, { paramsFingerprint: run.body.paramsFingerprint });
    expect(save.status).toBe(422);
  });

  it("A15 敏感标记：凭据引用不出现在快照、导出与运行记录载荷", async () => {
    const connId = await connect(); // credentialRef = keychain://demo-secret-ref
    const run = await api.post("/runs", { projectId: "default", connectionId: connId, capabilityId: "wx.daily", params: WX });
    await settle(run.body.id);
    const saved = await api.post(`/runs/${run.body.id}/save`, { paramsFingerprint: run.body.paramsFingerprint });
    const snapshotId = saved.body.identity.snapshotId;
    const marker = "demo-secret-ref";
    const snapshotBody = JSON.stringify((await api.get(`/snapshots/${snapshotId}`)).body);
    expect(snapshotBody).not.toContain(marker);
    const exportRes = await fetch(`${base}/api/v1/snapshots/${snapshotId}/export?format=json&projectId=default`);
    expect(await exportRes.text()).not.toContain(marker);
    const runBody = JSON.stringify((await api.get(`/runs/${run.body.id}`)).body);
    expect(runBody).not.toContain(marker);
  });
});

describe("画像合成样板管道（A12）", () => {
  it("完整管道：连接 → 查询 → 质量（分母/抑制）→ 快照 synthetic 标识", async () => {
    const conn = await api.post("/connections", {
      projectId: "default", sourceId: "persona-synthetic", accountAlias: "演示",
      credentialRef: "synthetic-none", capabilities: ["persona.ageBands"], grant: GRANT, confirmScope: true,
    });
    expect(conn.status).toBe(201);
    await api.post(`/connections/${conn.body.id}/check`);
    const run = await api.post("/runs", {
      projectId: "default", connectionId: conn.body.id, capabilityId: "persona.ageBands",
      params: { brand: "青禾生活", platform: "演示平台", window: "2026-09" },
    });
    const settled = await settle(run.body.id);
    expect(settled.run.status).toBe("完整返回");
    expect(settled.run.quality.ruleVersion).toBe("persona-quality@1");
    expect(settled.run.quality.fieldIssues.some((f: any) => f.kind === "suppressed")).toBe(true);
    const saved = await api.post(`/runs/${run.body.id}/save`, { paramsFingerprint: run.body.paramsFingerprint });
    expect(saved.body.license.synthetic).toBe(true);
    expect(saved.body.coverage.actual.denominator).toBe(1200);
    // 口径校验：错误窗口被拒
    const bad = await api.post("/runs", {
      projectId: "default", connectionId: conn.body.id, capabilityId: "persona.ageBands",
      params: { brand: "青禾生活", platform: "演示平台", window: "2026-10" },
    });
    expect(bad.status).toBe(422);
  });
});
