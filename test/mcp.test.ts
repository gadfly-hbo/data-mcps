import { describe, expect, it } from "vitest";
import { McpClientSeam, makeSyntheticMcpServer } from "../src/adapters/mcpClient.js";
import { toolCatalogFingerprint } from "../src/core/fingerprint.js";

describe("MCP 接缝（合成 Server，不证明外部连通）", () => {
  it("白名单内只读工具可调用", async () => {
    const seam = await McpClientSeam.connect(makeSyntheticMcpServer(), {
      allowedTools: ["demo_read"],
      expectedFingerprint: null,
    });
    const out = await seam.callTool("demo_read", { key: "a" });
    expect(out).toContain("synthetic");
    await seam.close();
  });

  it("白名单外工具默认拒绝（未发送调用）", async () => {
    const seam = await McpClientSeam.connect(makeSyntheticMcpServer(), {
      allowedTools: ["demo_read"],
      expectedFingerprint: null,
    });
    await expect(seam.callTool("demo_write", {})).rejects.toMatchObject({ category: "scope_insufficient" });
    await seam.close();
  });

  it("目录指纹可复算且与清单一致", async () => {
    const seam = await McpClientSeam.connect(makeSyntheticMcpServer(), {
      allowedTools: ["demo_read", "demo_write"],
      expectedFingerprint: null,
    });
    expect(seam.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(seam.fingerprint).toBe(toolCatalogFingerprint(seam.tools));
    await seam.close();
  });

  it("指纹不符 → 连接冻结对应能力（工具变化默认不准入）", async () => {
    await expect(
      McpClientSeam.connect(makeSyntheticMcpServer(), {
        allowedTools: ["demo_read"],
        expectedFingerprint: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ category: "tool_changed" });
  });

  it("工具目录变化（新增工具）→ 指纹变化可被检出", async () => {
    const seamA = await McpClientSeam.connect(makeSyntheticMcpServer(), { allowedTools: ["demo_read"], expectedFingerprint: null });
    const seamB = await McpClientSeam.connect(makeSyntheticMcpServer({ extraTool: true }), {
      allowedTools: ["demo_read"],
      expectedFingerprint: seamA.fingerprint,
    }).catch((err) => err);
    expect(seamB).toMatchObject({ category: "tool_changed" });
    await seamA.close();
  });

  it("readOnlyHint 只是提示：权限判断只看白名单", async () => {
    // demo_write 自报 readOnlyHint:true（不可信）；不在白名单仍拒绝
    const seam = await McpClientSeam.connect(makeSyntheticMcpServer({ lyingWrite: true }), {
      allowedTools: ["demo_read"],
      expectedFingerprint: null,
    });
    await expect(seam.callTool("demo_write", {})).rejects.toMatchObject({ category: "scope_insufficient" });
    await seam.close();
  });
});
