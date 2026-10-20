import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, mkdir, readdir } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, errorBody, errors } from "../core/errors.js";
import { newId, nowUtc } from "../core/ids.js";
import type { CatalogEntry, Connection, ExportRecord, Project, Run, SourceDraft } from "../core/types.js";
import { loadCatalog } from "../catalog/load.js";
import { FileStore } from "../store/fileStore.js";
import { SnapshotStore, type SnapshotContent } from "../store/snapshotStore.js";
import { Engine } from "./engine.js";
import { PRESET_CITIES } from "../adapters/fixtureTransport.js";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));

/** UI 静态目录：兼容打包（dist/）与源码（src/server/）位置；缺资源拒绝服务该路径 */
async function resolveUiDir(): Promise<string> {
  for (const c of [join(HERE, "..", "ui"), join(HERE, "..", "..", "ui")]) {
    try {
      await readFile(join(c, "index.html"));
      return c;
    } catch {
      // 下一个候选
    }
  }
  throw new Error("UI 资源缺失（坏包/缺资源拒绝）");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export interface ServerOptions {
  port: number;
  dataRoot: string;
  catalogDir?: string;
}

export interface RunningServer {
  server: Server;
  url: string;
  port: number;
  engine: Engine;
  catalog: CatalogEntry[];
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw errors.badRequest("请求体必须是 JSON");
  }
}

/** 快照 → CSV（GRILL 包 9：UTF-8 BOM、RFC 4180、null=空单元格 ≠ 0） */
export function toCsv(content: SnapshotContent): string {
  const header = content.fields.map((f) => f.name);
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [header.map(esc).join(",")];
  for (const row of content.rows) {
    lines.push(header.map((h) => esc(row[h])).join(","));
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
/** 日志边界（GRILL 包 15）：仅脱敏摘要，禁密钥/签名 URL/个人数据 */
function log(line: string): void {
  process.stdout.write(`${nowUtc()} ${line}\n`);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const store = new FileStore(opts.dataRoot);
  const snapshots = new SnapshotStore(store);
  const catalogList = await loadCatalog(opts.catalogDir);
  const catalog = new Map(catalogList.map((e) => [e.id, e]));
  const engine = new Engine({ store, snapshots, catalog });

  await mkdir(opts.dataRoot, { recursive: true });

  // 播种默认项目（GRILL 包 2）
  if (!(await store.exists("projects", "default"))) {
    await store.write<Project>("projects", "default", { id: "default", name: "默认项目", createdAtUtc: nowUtc() });
  }
  // 进程重启恢复（GRILL 包 3）
  const recovered = await engine.recoverOnStart();
  if (recovered > 0) log(`启动恢复：${recovered} 个中断运行标记为「结果未知/保存失败」`);

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const seg = path.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    // GET /api/v1/sources / GET /api/v1/sources/:id
    if (seg[0] === "sources" && method === "GET") {
      if (seg.length === 1) return send(res, 200, catalogList);
      const entry = catalog.get(seg[1]!);
      if (!entry) throw errors.notFound(`来源不存在：${seg[1]}`);
      return send(res, 200, entry);
    }

    if (seg[0] === "cities" && method === "GET") return send(res, 200, PRESET_CITIES);

    if (seg[0] === "projects") {
      if (method === "GET") return send(res, 200, await store.list<Project>("projects"));
      if (method === "POST") {
        const body = await readBody(req);
        const name = String(body.name ?? "").trim();
        if (!name) throw errors.badRequest("项目名不能为空");
        const p: Project = { id: newId("proj"), name, createdAtUtc: nowUtc() };
        await store.write("projects", p.id, p);
        return send(res, 201, p);
      }
    }

    if (seg[0] === "connections") {
      if (seg.length === 1 && method === "GET") {
        const projectId = url.searchParams.get("projectId");
        const all = await store.list<Connection>("connections");
        return send(res, 200, projectId ? all.filter((c) => c.projectId === projectId) : all);
      }
      if (seg.length === 1 && method === "POST") {
        const body = await readBody(req);
        const conn = await engine.createConnection({
          projectId: String(body.projectId ?? ""),
          sourceId: String(body.sourceId ?? ""),
          accountAlias: String(body.accountAlias ?? ""),
          credentialRef: String(body.credentialRef ?? ""),
          capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
          grant: (body.grant ?? {}) as Connection["grant"],
          ...(body.confirmScope !== undefined ? { confirmScope: body.confirmScope === true } : {}),
        });
        return send(res, 201, conn);
      }
      if (seg.length === 3 && seg[2] === "check" && method === "POST") {
        return send(res, 200, await engine.checkConnection(seg[1]!));
      }
      if (seg.length === 3 && seg[2] === "validate" && method === "POST") {
        return send(res, 200, await engine.validateConnection(seg[1]!));
      }
      if (seg.length === 3 && seg[2] === "grant" && method === "PUT") {
        const body = await readBody(req);
        return send(res, 200, await engine.updateGrant(seg[1]!, body as Partial<Connection["grant"]>));
      }
    }

    if (seg[0] === "runs") {
      if (seg.length === 1 && method === "POST") {
        const body = await readBody(req);
        const run = await engine.createRun({
          projectId: String(body.projectId ?? ""),
          connectionId: String(body.connectionId ?? ""),
          capabilityId: String(body.capabilityId ?? ""),
          params: (body.params ?? {}) as Record<string, unknown>,
        });
        return send(res, 201, run);
      }
      if (seg.length === 1 && method === "GET") {
        const projectId = url.searchParams.get("projectId");
        const all = await store.list<Run>("runs");
        return send(res, 200, projectId ? all.filter((r) => r.projectId === projectId) : all);
      }
      if (seg.length === 2 && method === "GET") {
        const { run, outcome } = await engine.preview(seg[1]!);
        return send(res, 200, {
          run,
          preview: outcome
            ? { content: outcome.content, incompleteReasons: outcome.incompleteReasons, lateAfterAbort: outcome.lateAfterAbort ?? false }
            : null,
        });
      }
      if (seg.length === 3 && seg[2] === "cancel" && method === "POST") {
        return send(res, 200, await engine.cancelRun(seg[1]!));
      }
      if (seg.length === 3 && seg[2] === "save" && method === "POST") {
        const body = await readBody(req);
        const manifest = await engine.saveRun(seg[1]!, {
          paramsFingerprint: String(body.paramsFingerprint ?? ""),
          ...(body.acknowledgePartial !== undefined ? { acknowledgePartial: body.acknowledgePartial === true } : {}),
        });
        return send(res, 200, manifest);
      }
    }

    if (seg[0] === "snapshots") {
      if (seg.length === 1 && method === "GET") {
        const projectId = url.searchParams.get("projectId");
        const runs = await store.list<Run>("runs");
        const ids = new Set(
          runs.filter((r) => r.snapshotId && (!projectId || r.projectId === projectId)).map((r) => r.snapshotId!),
        );
        const out = [];
        for (const id of [...ids].sort()) {
          try {
            out.push((await snapshots.readback(id)).manifest);
          } catch {
            out.push({ identity: { snapshotId: id }, corrupt: true });
          }
        }
        return send(res, 200, out);
      }
      if (seg.length === 2 && method === "GET") {
        const back = await snapshots.readback(seg[1]!);
        return send(res, 200, back);
      }
      if (seg.length === 3 && seg[2] === "export" && method === "GET") {
        return handleExport(res, seg[1]!, url.searchParams.get("format") ?? "json", url.searchParams.get("projectId") ?? "");
      }
    }

    if (seg[0] === "exports" && method === "GET") {
      const projectId = url.searchParams.get("projectId");
      const all = await store.list<ExportRecord>("exports");
      return send(res, 200, projectId ? all.filter((e) => e.projectId === projectId) : all);
    }

    if (seg[0] === "grants" && seg.length === 2 && method === "GET") {
      // 项目授权视图（REVIEW 收敛：grant 按项目×连接存放于连接记录，此处为派生视图）
      const conns = (await store.list<Connection>("connections")).filter((c) => c.projectId === seg[1]);
      return send(res, 200, conns.map((c) => ({ connectionId: c.id, sourceId: c.sourceId, revision: c.revision, grant: c.grant })));
    }

    if (seg[0] === "source-drafts") {
      if (method === "GET") return send(res, 200, await store.list<SourceDraft>("catalog-drafts"));
      if (method === "POST") {
        const body = await readBody(req);
        const name = String(body.name ?? "").trim();
        if (!name) throw errors.badRequest("来源草稿名称不能为空");
        const draft: SourceDraft = { id: newId("draft"), name, note: String(body.note ?? ""), status: "研究草稿", createdAtUtc: nowUtc() };
        await store.write("catalog-drafts", draft.id, draft);
        return send(res, 201, draft);
      }
    }

    throw errors.notFound(`未知端点：${method} ${url.pathname}`);
  }

  async function handleExport(res: ServerResponse, snapshotId: string, format: string, projectId: string): Promise<void> {
    if (format !== "json" && format !== "csv") throw errors.badRequest("format 仅支持 json|csv");
    // 项目上下文必须显式（GRILL 包 1）：缺失/跨项目一律拒绝
    if (!projectId) throw errors.badRequest("导出必须显式携带 projectId");
    // 读回校验（坏 hash/缺文件拒绝；不回退伪成功）
    const back = await snapshots.readback(snapshotId);
    const runs = await store.list<Run>("runs");
    const run = runs.find((r) => r.snapshotId === snapshotId);
    if (!run) throw errors.notFound("快照无来源运行记录");
    if (run.projectId !== projectId) {
      throw errors.permissionDenied("快照不属于当前项目", { snapshotId });
    }
    const conn = await store.read<Connection>("connections", run.connectionId);
    // 双查：grant.export 与 license.exportAllowed（A05）
    if (!conn || !conn.grant.export) {
      throw errors.permissionDenied("导出权未授予或已撤销：文件交付被拒绝", { snapshotId });
    }
    if (!back.manifest.license.exportAllowed) {
      throw errors.licenseDenied("许可禁止导出：文件交付被拒绝", { snapshotId });
    }
    const record: ExportRecord = {
      id: newId("exp"),
      snapshotId,
      projectId: run.projectId,
      format: format as "json" | "csv",
      licenseCheck: { exportAllowed: true, checkedAt: back.manifest.license.checkedAt },
      grantCheck: { ...conn.grant },
      createdAtUtc: nowUtc(),
      filename: `${snapshotId}.${format}`,
    };
    await store.write("exports", record.id, record);
    const body =
      format === "json"
        ? JSON.stringify({ manifest: back.manifest, content: back.content }, null, 2) + "\n"
        : toCsv(back.content);
    log(`导出 ${format} snapshot=${snapshotId} project=${run.projectId} exportId=${record.id}`);
    res.writeHead(200, {
      "content-type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${record.filename}"`,
    });
    res.end(body);
  }

  function send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(text);
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const UI_DIR = await resolveUiDir();
    let rel = pathname === "/" ? "/index.html" : pathname;
    let file = normalize(join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR)) throw errors.notFound("not found");
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      // SPA 回退
      const body = await readFile(join(UI_DIR, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      // 同源守卫（GRILL 包 1）：Host 仅回环；变更类端点要求 Origin 空或同源
      const host = req.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        return send(res, 403, errorBody(errors.permissionDenied("仅允许本机回环访问")));
      }
      const mutating = req.method !== "GET" && req.method !== "HEAD";
      const origin = req.headers.origin;
      if (mutating && origin !== undefined) {
        const o = new URL(origin);
        if (o.host !== host) return send(res, 403, errorBody(errors.permissionDenied("跨源变更被拒绝")));
      }
      try {
        if (url.pathname.startsWith("/api/")) {
          await handleApi(req, res, url);
          log(`${req.method} ${url.pathname} ${res.statusCode}`);
        } else {
          await serveStatic(res, url.pathname);
        }
      } catch (err) {
        if (err instanceof AppError) {
          send(res, err.status, errorBody(err));
          log(`${req.method} ${url.pathname} ${err.status} ${err.category}`);
        } else {
          send(res, 500, errorBody(new AppError(500, "unknown_outcome", `内部错误：${(err as Error).message}`)));
          log(`${req.method} ${url.pathname} 500`);
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });
  const actualPort = (server.address() as { port: number }).port;

  return {
    server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    engine,
    catalog: catalogList,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
