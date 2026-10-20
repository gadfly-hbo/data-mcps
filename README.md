# data-mcps · 外部数据集市与采集工作台

local-first 外部数据集市与采集工作台：发现 → 评估覆盖/口径/许可 → 连接 → 查询 → 预览与质量检查 → 保存固定快照 → 明确交付。本期为 R1 独立天气闭环（合成夹具边界），独立可运行，后续按现行 JuanerAI 插件合同以同源固定版本接入。

## 启动方式

```bash
双击「启动工作台.command」（macOS Finder）# 一键启动
./启动工作台.command                      # 或终端执行同一入口
```

沿用 metric-factory 的一键启动模式：依赖缺失自动安装 → 产物缺失或源码更新自动构建 → 起本机服务 → 健康检查 → 自动打开浏览器。端口默认 4173，占用时响亮提示并顺延 4174（`DATA_MCPS_PORT` 覆盖；`DATA_MCPS_NO_OPEN=1` 跳过开浏览器；`DATA_MCPS_DATA_ROOT` 覆盖数据根）。

等价手动步骤：

```bash
npm install
npm run build
node dist/cli.js ui -p 4173          # 或 npm start
# 打开 http://127.0.0.1:4173
```

- 仅监听 127.0.0.1；数据根默认 `<cwd>/.data-mcps`，可用 `--data-root <dir>` 指定。
- 端口占用时直接报错退出（不静默换端口）。
- 需要 Node ≥ 22.19。

## 测试与证据

```bash
npm test                    # 67 项单元/集成测试（vitest，真实 fs/tmp 与进程内 HTTP）
npm run typecheck           # tsc 0 错误
python3 run_browser_check.py  # 32 项浏览器验收（Playwright CLI + 本机 Chromium，驱动真实服务）
```

- 浏览器证据：`evidence/browser-checks.json` + `evidence/screenshots/*.png`（11 张）。
- 样例快照：`samples/` 三个真实生成快照（天气 complete 14/14、天气 partial 13/14、画像 complete），均为 synthetic 标识。

## 已实现（R1）

- **数据集市**：8 个精选条目（6 真实候选 + 2 合成样板），状态四面分别举证（文档/适配/账户/实测），搜索/分类/协议筛选；添加来源 → 本地研究草稿。
- **来源详情**：覆盖/粒度/时效/形态、许可与鉴权、成本已知性、接入状态证据。
- **我的连接**：显式授权确认建连（四权初值 + confirmScope）；连接检查与数据验证分开；凭据只用引用；撤权（使用/导出）服务端强制。
- **查询工作台**：参数表单（预置城市坐标已确认）、预期覆盖与最多请求数、费用已知性、执行前权限/许可检查；表格/JSON 双预览；质量检查（期望/实际、缺失清单、重复、单位/时区、分页）。
- **失败路径**：部分结果 13/14（不填零、显式确认受限快照）、429 二分（rate_limited + Retry-After / quota_exhausted）、401、超时、取消（取消处理中→已取消）、迟到结果隔离（结果未知）、过期缓存标识（72h）、参数 stale、保存失败重试不重查、进程重启恢复（查询中→结果未知）。
- **数据资产**：不可变快照（内容寻址 snap_ + SHA-256 清单 + 原子提交）、独立读回校验（坏 hash/缺文件拒绝）、JSON/CSV 导出（BOM、null=空格）、导出台账。
- **运行记录**：状态/错误类别/请求页数/费用已知性/参数指纹/授权快照；失败不推定未计费。
- **MCP 接缝**：最小 Client 封装 + 合成 in-process Server；工具白名单、目录指纹、工具变化冻结、readOnlyHint 不作权限依据（测试覆盖）。
- **权限**：使用/提取/导出/模型外发四分，服务端逐端点强制；模型外发本期恒关闭；错项目发送前拒绝（请求数 0）。

## 未实现（本期边界）

- 真实供应商请求、OAuth、密钥配置、付费调用、第三方 MCP 安装（需另行明确授权）。
- JuanerAI 宿主接线/交付回执（R3，按现行合同五步推进；本期仅独立版 + 文件导出交付）。
- Keychain 实际集成（已实现 `SessionMemoryCredentialResolver`：引用解析 + 会话内存语义 + 明确提示；系统存储读写未做）。
- 周期刷新、自然语言查数、派生快照（schema 预留 parentSnapshotId）、更多来源。
- MCP 接缝未进 UI 主流程（无已授权真实 Server）。

## 真实服务未验证项

- A16 真实对照未执行：Open-Meteo 适配器有真实实现（请求构造经官方文档形态测试），但未对真实端点发过请求；免费层限非商业用途，商业使用/额度/许可未核实。
- 真实 MCP Server 兼容（协议版本 skew、远程 OAuth、session 管理）未验证；合成 Server 只证明接缝与白名单语义。
- 取消/超时/迟到的语义在夹具挂起上验证；未证明真实远端停止与费用对账。
- 生产安全隔离、SSRF 防护实测、企业权限：不在首期。

## 后续接入说明（JuanerAI 最小接缝）

- 业务核心（core/adapters/store/server 业务路由）与装配分离；独立入口即未来 supplier 入口的共用业务。
- 接入按现行合同五步：盘点 → 对齐 → 接线 → 验证 → 接受与固定交付；固定物料从精确提交产出（bytes/SHA），不打包活动目录。
- 交付语义升级点：R1 的导出台账 → R3 的宿主稳定副本 + receipt 读回；快照身份（snap_ 内容寻址）与 manifest 字段已为此设计。

## 评审基线

- 产品方案与原型：`/Users/huangbo/Documents/Codex/2026-10-19/task-2/data-mcps-review/`（方案.md v0.1、demo.html、验证记录.md）。
- UI 视觉/行为基线：demo.html（用户 2026-10-20 批准直接使用，跳过 UI-GATE）。
- 开发决策记录：`.flow/prd.md`（GRILL 16 包决议）、`.flow/red-team.md`。
