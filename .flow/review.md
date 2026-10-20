# REVIEW 报告（base 72c571e，2026-10-20）

双轴并行评审（fresh subagents），随后 CONVERGE 修复并全量复验通过。

## Standards（Fowler 坏味基线；本仓无文档化标准）

修复 4 项：① `newId/nowUtc` 重复 → `core/ids.ts`；② 日序列逻辑 ×3 → 统一 `daySequence`；③ Run 字面量构造两遍 → `baseRun` 工厂；④ capabilityId if-级联 ×3 → `server/capabilities.ts` 注册表（normalize/handshake/validate/execute/checkQuality 五口）。
保留判断项：UI `restricted` 判定、grant 开关对、`e()/b()` 简写、`fetchTransport` 预留接缝、路由级联形态等——均记录在案。

## Spec（对照 prd.md / proposal.md / 方案.md）

修复 7 项：连接检查真实握手（适配版本核对 + 工具已变化态）；MCP 每次调用前重比指纹（会话内变化冻结）；导出 projectId 必填；补 extract/modelEgress/stdout 负例测试；集市「接入状态」筛选；详情页「示例结构」；凭据解析器接缝落地（SessionMemoryCredentialResolver）。
记录修订 5 项（见 prd.md「REVIEW 修订记录」）：`/cities` 与 `/grants/:projectId` 端点、`demo_no_call` 枚举（方案 §08 强制）、分页演练请求数口径、snapshots index.json 降级、`.playwright-cli/` 移出版控。

## 复验

build ✓ · tsc 0 错 ✓ · vitest 75/75 ✓ · 浏览器 34/34 ✓（evidence/ 留档 11 截图 + 检查 JSON）。
