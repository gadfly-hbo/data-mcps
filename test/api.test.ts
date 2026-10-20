import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";

let srv: RunningServer;
let root: string;
let base: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "data-mcps-api-"));
  srv = await startServer({ port: 0, dataRoot: root });
  base = `http://127.0.0.1:${srv.port}`;
});
afterEach(async () => {
  await srv.close();
  await rm(root, { recursive: true, force: true });
});

const api = {
  async get(path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/v1${path}`);
    return { status: res.status, body: (await res.json()) as any };
  },
  async post(path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? "{}" : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  },
  async put(path: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/v1${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  },
};

const GRANT = { use: true, extract: true, export: true, modelEgress: false };

async function makeConnection() {
  const res = await api.post("/connections", {
    projectId: "default",
    sourceId: "wx-synthetic",
    accountAlias: "演示账户",
    credentialRef: "synthetic-none",
    capabilities: ["wx.daily"],
    grant: GRANT,
    confirmScope: true,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const WX_PARAMS = { cities: ["shanghai", "hangzhou"], start: "2026-09-01", end: "2026-09-07", timezone: "Asia/Shanghai", variables: ["tempMeanC", "precipSum"] };

async function runUntilSettled(runId: string) {
  for (let i = 0; i < 50; i++) {
    const got = await api.get(`/runs/${runId}`);
    if (got.body.run.status !== "查询中" && got.body.run.status !== "取消处理中") return got.body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("运行未收敛");
}

describe("A01 天气完整交付（服务端真实路径）", () => {
  it("双城 7 日 → 14/14 → 保存 → 读回同字节/同元数据 → 导出 JSON/CSV", async () => {
    // 目录与来源详情
    const sources = await api.get("/sources");
    expect(sources.body.length).toBe(8);
    const detail = await api.get("/sources/wx-synthetic");
    expect(detail.body.synthetic).toBe(true);
    expect(detail.body.status.envTested.ok).toBe(true);

    // 连接：检查与数据验证分开
    const connId = await makeConnection();
    const checked = await api.post(`/connections/${connId}/check`);
    expect(checked.body.status).toBe("连接检查通过");
    expect(checked.body.dataValidation).toBe("未验证"); // 连接检查 ≠ 数据验证
    const validated = await api.post(`/connections/${connId}/validate`);
    expect(validated.body.dataValidation).toBe("通过");

    // 查询
    const created = await api.post("/runs", { projectId: "default", connectionId: connId, capabilityId: "wx.daily", params: WX_PARAMS });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("查询中");
    expect(created.body.cost.knownness).toBe("demo_no_call");

    const settled = await runUntilSettled(created.body.id);
    expect(settled.run.status).toBe("完整返回");
    expect(settled.run.quality.conclusion).toBe("complete");
    expect(settled.run.quality.expectedCount).toBe(14);
    expect(settled.run.quality.actualCount).toBe(14);
    expect(settled.run.requestCount).toBe(2);
    expect(settled.preview.content.rows).toHaveLength(14);
    expect(settled.preview.content.fields.map((f: { name: string }) => f.name)).toEqual(["city", "date", "tempMeanC", "precipSum"]);

    // 保存
    const saved = await api.post(`/runs/${created.body.id}/save`, { paramsFingerprint: created.body.paramsFingerprint });
    expect(saved.status).toBe(200);
    const snapshotId = saved.body.identity.snapshotId as string;
    expect(snapshotId).toMatch(/^snap_/);
    expect(saved.body.license.synthetic).toBe(true);
    expect(saved.body.license.modelAllowed).toBe(false);
    expect(saved.body.time.sourceUpdatedAt).toBe("unknown");
    expect(saved.body.coverage.timezone).toBe("Asia/Shanghai");

    // 重开读回同字节/同元数据
    const back = await api.get(`/snapshots/${snapshotId}`);
    expect(back.status).toBe(200);
    expect(back.body.manifest).toEqual(saved.body);
    expect(back.body.content.rows).toHaveLength(14);

    // 同运行重复保存 → 同一快照（幂等）
    const again = await api.post(`/runs/${created.body.id}/save`, { paramsFingerprint: created.body.paramsFingerprint });
    expect(again.body.identity.snapshotId).toBe(snapshotId);
    const list = await api.get("/snapshots?projectId=default");
    expect(list.body).toHaveLength(1);

    // 导出 JSON / CSV
    const j = await fetch(`${base}/api/v1/snapshots/${snapshotId}/export?format=json&projectId=default`);
    expect(j.status).toBe(200);
    expect(j.headers.get("content-disposition")).toContain(snapshotId);
    const jbody = (await j.json()) as any;
    expect(jbody.content.rows).toHaveLength(14);

    const c = await fetch(`${base}/api/v1/snapshots/${snapshotId}/export?format=csv&projectId=default`);
    const csvBytes = new Uint8Array(await c.arrayBuffer());
    expect([...csvBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM 字节级断言
    const csv = new TextDecoder().decode(csvBytes.subarray(3));
    expect(csv.trim().split("\r\n")).toHaveLength(15); // 表头 + 14 行

    // 导出台账
    const exports_ = await api.get("/exports?projectId=default");
    expect(exports_.body).toHaveLength(2);
  });
});

describe("授权与阻断（A04/A05 面）", () => {
  it("未确认授权范围不能建立连接", async () => {
    const res = await api.post("/connections", {
      projectId: "default",
      sourceId: "wx-synthetic",
      accountAlias: "x",
      credentialRef: "x",
      capabilities: ["wx.daily"],
      grant: GRANT,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.category).toBe("validation_failed");
  });

  it("错项目运行：发送前拒绝、请求数 0、阻断记录保留", async () => {
    const connId = await makeConnection();
    const other = await api.post("/projects", { name: "其他项目" });
    const run = await api.post("/runs", { projectId: other.body.id, connectionId: connId, capabilityId: "wx.daily", params: WX_PARAMS });
    expect(run.status).toBe(201); // 返回的是阻断记录
    expect(run.body.status).toBe("未发送");
    expect(run.body.errorCategory).toBe("permission_denied");
    expect(run.body.requestCount).toBe(0);
    const listed = await api.get(`/runs?projectId=${other.body.id}`);
    expect(listed.body).toHaveLength(1); // 阻断记录保留
  });

  it("不可连接来源（真实/商业）建立连接被拒", async () => {
    const res = await api.post("/connections", {
      projectId: "default",
      sourceId: "open-meteo",
      accountAlias: "x",
      credentialRef: "x",
      capabilities: [],
      grant: GRANT,
      confirmScope: true,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.category).toBe("permission_denied");
  });

  it("能力不在白名单：未发送", async () => {
    const connId = await makeConnection();
    const run = await api.post("/runs", { projectId: "default", connectionId: connId, capabilityId: "persona.ageBands", params: {} });
    expect(run.body.status).toBe("未发送");
    expect(run.body.errorCategory).toBe("scope_insufficient");
    expect(run.body.requestCount).toBe(0);
  });

  it("撤销导出权后导出被拒（A05）；许可/外发边界保留", async () => {
    const connId = await makeConnection();
    const created = await api.post("/runs", { projectId: "default", connectionId: connId, capabilityId: "wx.daily", params: WX_PARAMS });
    await runUntilSettled(created.body.id);
    const saved = await api.post(`/runs/${created.body.id}/save`, { paramsFingerprint: created.body.paramsFingerprint });
    const snapshotId = saved.body.identity.snapshotId as string;

    await api.put(`/connections/${connId}/grant`, { export: false });
    const denied = await fetch(`${base}/api/v1/snapshots/${snapshotId}/export?format=json&projectId=default`);
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as any;
    expect(body.error.category).toBe("permission_denied");

    // 恢复导出权 → 可导出（历史快照不受撤权抹除）
    await api.put(`/connections/${connId}/grant`, { export: true });
    const ok = await fetch(`${base}/api/v1/snapshots/${snapshotId}/export?format=json&projectId=default`);
    expect(ok.status).toBe(200);
  });

  it("撤权（use=false）后新运行发送前拒绝；旧快照仍可读回", async () => {
    const connId = await makeConnection();
    const created = await api.post("/runs", { projectId: "default", connectionId: connId, capabilityId: "wx.daily", params: WX_PARAMS });
    await runUntilSettled(created.body.id);
    const saved = await api.post(`/runs/${created.body.id}/save`, { paramsFingerprint: created.body.paramsFingerprint });

    await api.put(`/connections/${connId}/grant`, { use: false });
    const blocked = await api.post("/runs", { projectId: "default", connectionId: connId, capabilityId: "wx.daily", params: WX_PARAMS });
    expect(blocked.body.status).toBe("未发送");
    const back = await api.get(`/snapshots/${saved.body.identity.snapshotId}`);
    expect(back.status).toBe(200);
  });

  it("改参保存旧结果被拒（A03 stale）", async () => {
    const connId = await makeConnection();
    const created = await api.post("/runs", { projectId: "default", connectionId: connId, capabilityId: "wx.daily", params: WX_PARAMS });
    await runUntilSettled(created.body.id);
    const res = await api.post(`/runs/${created.body.id}/save`, { paramsFingerprint: "fp_别的参数" });
    expect(res.status).toBe(409);
    expect(res.body.error.category).toBe("stale_params");
  });
});

describe("守卫", () => {
  it("非回环 Host 被拒", async () => {
    // fetch 不允许覆盖 Host；用原生 http 构造恶意 Host
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: srv.port, path: "/api/v1/sources", headers: { host: "evil.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("跨源 Origin 的变更请求被拒", async () => {
    const res = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });
});
