import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errors, AppError } from "../core/errors.js";
import { toolCatalogFingerprint } from "../core/fingerprint.js";

/**
 * MCP Client 最小接缝（PRD MCP 接缝，≤3 工件之一；红队 K4 限定投入）。
 * - 只进业务边界，不进 UI 主流程；无 OAuth/远程传输/stdio 任意命令。
 * - 工具白名单 + 目录指纹：连接时与每次 call 准入前各比对一次（方案 §09）。
 * - readOnlyHint 不作为权限依据（第三方工具说明是不可信输入）。
 */

export interface McpToolInfo {
  name: string;
  inputSchema?: unknown;
  annotations?: unknown;
  outputSchema?: unknown;
}

export interface McpSeamOptions {
  /** 精确工具白名单（连接授权范围的一部分） */
  allowedTools: string[];
  /** 期望目录指纹；null = 首次接入（记录指纹），非 null 且不匹配 → 冻结 */
  expectedFingerprint: string | null;
}

export class McpClientSeam {
  private constructor(
    private readonly client: Client,
    readonly tools: McpToolInfo[],
    readonly fingerprint: string,
    private readonly allowed: Set<string>,
  ) {}

  private static async listTools(client: Client): Promise<{ tools: McpToolInfo[]; fingerprint: string }> {
    const listed = await client.listTools();
    const tools: McpToolInfo[] = (listed.tools ?? []).map((t) => ({
      name: t.name,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
    }));
    return { tools, fingerprint: toolCatalogFingerprint(tools) };
  }

  /** transportFactory：返回「客户端侧已连接的 in-memory 对」或未来的远程 transport（授权后再议） */
  static async connect(transportFactory: () => InMemoryTransport, opts: McpSeamOptions): Promise<McpClientSeam> {
    const client = new Client({ name: "data-mcps", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transportFactory());
    const { tools, fingerprint } = await McpClientSeam.listTools(client);
    if (opts.expectedFingerprint !== null && opts.expectedFingerprint !== fingerprint) {
      await client.close().catch(() => {});
      throw new AppError(
        409,
        "tool_changed",
        "工具目录指纹不匹配：哪个工具/参数/输出变化需人工复核；对应能力已冻结，新工具默认不准入",
        { expected: opts.expectedFingerprint.slice(0, 16), actual: fingerprint.slice(0, 16) },
      );
    }
    return new McpClientSeam(client, tools, fingerprint, new Set(opts.allowedTools));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // 每次调用准入前重新比对目录指纹（GRILL 包 5/方案 §09）：会话中目录变化 → 冻结
    const { fingerprint } = await McpClientSeam.listTools(this.client);
    if (fingerprint !== this.fingerprint) {
      throw new AppError(409, "tool_changed", "工具目录在会话中发生变化：对应能力已冻结，需人工复核后重新授权", {
        connected: this.fingerprint.slice(0, 16),
        actual: fingerprint.slice(0, 16),
      });
    }
    if (!this.allowed.has(name)) {
      throw errors.scopeInsufficient(`工具 ${name} 不在白名单：未发送调用（readOnlyHint 不作为权限依据）`, { tool: name });
    }
    const res = await this.client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as { type: string; text?: string }[];
    const text = content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
    return text;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** 合成 MCP Server（仅测试接缝）：两只工具，一只只读、一只“写入”演示白名单拒绝 */
export function makeSyntheticMcpServer(opts: { extraTool?: boolean; lyingWrite?: boolean } = {}): () => InMemoryTransport {
  const { factory } = makeControllableSyntheticServer(opts);
  return factory;
}

/** 可控合成 Server：测试可在连接后追加工具，演练「会话中目录变化」 */
export function makeControllableSyntheticServer(opts: { extraTool?: boolean; lyingWrite?: boolean } = {}): {
  factory: () => InMemoryTransport;
  addTool: (name: string) => void;
} {
  const server = new McpServer({ name: "synthetic-mcp", version: "0.1.0" });
  server.registerTool(
    "demo_read",
    { description: "读取合成值（只读）", inputSchema: { key: z.string().optional() }, annotations: { readOnlyHint: true } },
    async ({ key }) => ({ content: [{ type: "text", text: `synthetic value for ${key ?? "default"}` }] }),
  );
  server.registerTool(
    "demo_write",
    {
      description: "演示写入工具（白名单外）",
      inputSchema: { value: z.string().optional() },
      annotations: opts.lyingWrite ? { readOnlyHint: true } : { readOnlyHint: false }, // lyingWrite：自报只读的不可信输入
    },
    async () => ({ content: [{ type: "text", text: "write executed (synthetic)" }] }),
  );
  if (opts.extraTool) {
    server.registerTool("demo_extra", { description: "新增工具（目录变化演练）" }, async () => ({ content: [{ type: "text", text: "extra" }] }));
  }
  return {
    factory: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void server.connect(serverSide);
      return clientSide;
    },
    addTool: (name: string) => {
      server.registerTool(name, { description: "会话中新增（变化演练）" }, async () => ({ content: [{ type: "text", text: name }] }));
    },
  };
}
