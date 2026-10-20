# data-mcps R1 · handoff

## 本批交付

- 独立可运行产品：`npm install && npm run build && node dist/cli.js ui -p 4173`。
- 67 项 vitest（存储/质量/适配器/API/失败路径/MCP/权限）+ tsc 0 错 + 32 项浏览器验收全绿。
- 样例快照 `samples/`×3；浏览器证据 `evidence/`；决策链 `.flow/`。

## 开放依赖与下一批前置

| 事项 | 前置 | 接续点 |
| --- | --- | --- |
| A16 真实小样对照（Open-Meteo） | 用户明确授权：用途/账户/预算/许可核对 | `src/adapters/weatherDaily.ts` 真实 base URL 路径已就绪（fetchTransport），composition root 注入即可；需先核对免费层非商业限制 |
| R2 商业画像 | 用户提供已授权供应商合同与正式文档/样本 | 走 adapters 新增 + catalog 条目转 connectable；合成样板身份不可复用 |
| R3 JuanerAI 固定插件 | 宿主启动五步接入（盘点→对齐） | 业务核心已分层；交付=导出台账升级为宿主稳定副本+receipt；就绪握手/owner token 由宿主 Adapter 定义 |
| Keychain 凭据解析 | 用户批准系统凭据存储集成 | credentialRef 引用语义已就位；`src/adapters/credentials.ts` 会话内存解析器已实现（含明确提示）；Keychain 实现留接口 |
| MCP 真实 Server | 用户授权具体 Server（如 Alpha Vantage 官方 MCP）+ 协议兼容验证 | `src/adapters/mcpClient.ts` 接缝与指纹/白名单语义已验证（合成） |

## 降级与已知限制

- VERIFY 真实依赖案例：无已授权外部依赖 ——「partially verified — no real-dependency case」（授权约束，非遗漏）。
- 快照登记 = 目录扫描（.tmp- 前缀过滤），未建 index.json；量小可接受，R3+ 若需跨项目索引再评。
- R1 无 per-connection 速率限制器；请求上限 = 城市数（分页演练时 = 城市×逻辑页数，UI 如实显示）。
- 画像质量第五档「完整性未知」本期不触发（两能力均有规则）。

## 授权边界（仍未授权）

真实供应商请求、OAuth、密钥配置、付费调用、第三方 MCP 安装、JuanerAI 修改、远程推送、发布部署。
