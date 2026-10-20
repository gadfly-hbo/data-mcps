import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, type RunningServer } from "../src/server/app.js";
import { Engine } from "../src/server/engine.js";
import { FileStore } from "../src/store/fileStore.js";
import { SnapshotStore } from "../src/store/snapshotStore.js";
import { loadCatalog } from "../src/catalog/load.js";
import { SessionMemoryCredentialResolver } from "../src/adapters/credentials.js";
import { McpClientSeam, makeControllableSyntheticServer } from "../src/adapters/mcpClient.js";
import type { CatalogEntry } from "../src/core/types.js";

let srv: RunningServer;
let root: string;
let base: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "data-mcps-review-"));
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
  async put(p: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/v1${p}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  },
};

const GRANT = { use: true, extract: true, export: true, modelEgress: false };
const WX = { cities: ["shanghai", "hangzhou"], start: "2026-09-01", end: "2026-09-07", timezone: "Asia/Shanghai", variables: ["tempMeanC", "precipSum"] };

async function connect(grant = GRANT, credentialRef = "keychain://demo-secret-ref"): Promise<string> {
  const res = await api.post("/connections", {
    projectId: "default", sourceId: "wx-synthetic", accountAlias: "演示账户",
    credentialRef, capabilities: ["wx.daily"], grant, confirmScope: true,
  });
  return res.body.id;
}

describe("权限四分负例（PRD Testing 4 条无授权 HTTP 请求）", () => {
  it("extract=false → 运行发送前拒绝（请求数 0）", async () => {
    const connId = await connect({ ...GRANT, extract: false });
    const run = await api.post("/runs", { projectId: "default", connectionId: connId, capabilityId: "wx.daily", params: WX });
    expect(run.body.status).toBe("未发送");
    expect(run.body.errorCategory).toBe("permission_denied");
    expect(run.body.requestCount).toBe(0);
  });

  it("modelEgress 恒关：PUT grant 传 true 也被压回 false（R1 无开启端点）", async () => {
    const connId = await connect();
    const res = await api.put(`/connections/${connId}/grant`, { modelEgress: true });
    expect(res.body.grant.modelEgress).toBe(false);
    const view = await api.get("/grants/default");
    expect(view.status).toBe(200);
    expect(view.body[0].grant.modelEgress).toBe(false);
  });

  it("敏感标记不落入 stdout 日志（A15 + GRILL 包 15）", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const connId = await connect(); // credentialRef = keychain://demo-secret-ref
      await api.post(`/connections/${connId}/check`);
      const run = await api.post("/runs", { projectId: "default", connectionId: connId, capabilityId: "wx.daily", params: WX });
      for (let i = 0; i < 100; i++) {
        const got = await api.get(`/runs/${run.body.id}`);
        if (got.body.run.status === "完整返回") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await api.post(`/runs/${run.body.id}/save`, { paramsFingerprint: run.body.paramsFingerprint });
      const snaps = await api.get("/snapshots?projectId=default");
      await fetch(`${base}/api/v1/snapshots/${snaps.body[0].identity.snapshotId}/export?format=json&projectId=default`);
    } finally {
      spy.mockRestore();
    }
    const all = writes.join("");
    expect(all.length).toBeGreaterThan(0); // 确实有日志
    expect(all).not.toContain("demo-secret-ref");
  });
});

describe("连接检查真实握手（GRILL 包 11）", () => {
  it("握手记录适配版本；与目录一致 → 连接检查通过", async () => {
    const connId = await connect();
    const res = await api.post(`/connections/${connId}/check`);
    expect(res.body.status).toBe("连接检查通过");
    expect(res.body.adapterVersion).toBe("wx-fixture@1");
    // 凭据解析提示被持久化（系统存储不可用的会话内存提示）
    expect(res.body.credentialNotice).toContain("会话内存");
  });

  it("握手版本与目录登记不一致 → 工具已变化（不标通过）", async () => {
    const store = new FileStore(root);
    const catalog = new Map<string, CatalogEntry>((await loadCatalog()).map((e) => [e.id, e]));
    const tampered = { ...catalog.get("wx-synthetic")!, connector: { ...catalog.get("wx-synthetic")!.connector, adapterVersion: "wx-fixture@9" } };
    catalog.set("wx-synthetic", tampered);
    const engine = new Engine({ store, snapshots: new SnapshotStore(store), catalog });
    const conn = await engine.createConnection({
      projectId: "default", sourceId: "wx-synthetic", accountAlias: "a", credentialRef: "synthetic-none",
      capabilities: ["wx.daily"], grant: GRANT, confirmScope: true,
    });
    const checked = await engine.checkConnection(conn.id);
    expect(checked.status).toBe("工具已变化");
    expect(checked.adapterVersion).toBe("wx-fixture@1");
  });
});

describe("导出项目上下文（GRILL 包 1 收紧）", () => {
  it("缺 projectId → 400；错项目 → 403", async () => {
    const connId = await connect();
    const run = await api.post("/runs", { projectId: "default", connectionId: connId, capabilityId: "wx.daily", params: WX });
    for (let i = 0; i < 100; i++) {
      const got = await api.get(`/runs/${run.body.id}`);
      if (got.body.run.status === "完整返回") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await api.post(`/runs/${run.body.id}/save`, { paramsFingerprint: run.body.paramsFingerprint });
    const snaps = await api.get("/snapshots?projectId=default");
    const id = snaps.body[0].identity.snapshotId;
    const noProject = await fetch(`${base}/api/v1/snapshots/${id}/export?format=json`);
    expect(noProject.status).toBe(400);
    const other = await api.post("/projects", { name: "别的项目" });
    const wrong = await fetch(`${base}/api/v1/snapshots/${id}/export?format=json&projectId=${other.body.id}`);
    expect(wrong.status).toBe(403);
  });
});

describe("凭据解析器接缝", () => {
  it("synthetic 引用无需凭据；keychain:// 仅会话内存且有明确提示；空引用拒绝", () => {
    const r = new SessionMemoryCredentialResolver();
    expect(r.resolve("synthetic-none")).toEqual({ ok: true, sessionOnly: false, notice: null });
    const k = r.resolve("keychain://demo");
    expect(k.ok).toBe(true);
    expect(k.sessionOnly).toBe(true);
    expect(k.notice).toContain("系统凭据存储不可用");
    expect(r.resolve("  ").ok).toBe(false);
    expect(r.sessionSize).toBe(1); // 会话内登记，永不导出值
  });
});

describe("MCP 每次调用准入前指纹比对（GRILL 包 5 频次收紧）", () => {
  it("连接后目录新增工具 → 下一次调用冻结（tool_changed）", async () => {
    const { factory, addTool } = makeControllableSyntheticServer();
    const seam = await McpClientSeam.connect(factory, { allowedTools: ["demo_read"], expectedFingerprint: null });
    expect(await seam.callTool("demo_read", {})).toContain("synthetic");
    addTool("late_tool");
    await expect(seam.callTool("demo_read", {})).rejects.toMatchObject({ category: "tool_changed" });
    await seam.close();
  });
});
