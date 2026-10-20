# data-mcps R1 · 任务切片（tracer bullets）

> 来源：`.flow/prd.md`（含 GRILL 16 包决议）。无 issue tracker，按 dev-flow 降级写入本文件。拆分自批准（auto/gated 均同），依据：每片端到端可验证、按依赖排序。

- [x] 1. 仓脚手架与存储核心（原子写、快照 manifest、canonical 指纹、损坏演练）
- [x] 2. 天气闭环垂直切片（目录→连接→查询→质量→保存→读回→导出，全栈最小可跑）
- [x] 3. 权限与授权失败路径（四权服务端强制、错项目、费用未知阻断、许可禁导出、撤权、运行记录）
- [x] 4. 执行层失败路径（部分结果、429 二分、超时/未知、取消竞态、保存失败重试、参数 stale、过期缓存）
- [x] 5. MCP 接缝（合成 Server、工具白名单、目录指纹、工具变化冻结）
- [x] 6. 画像合成样板与目录补全（完整管道、商业画像阻断、六候选卡、添加来源草稿）
- [x] 7. UI 完整移植收尾与交付证据（46 项行为对照、亮暗/响应式、Playwright 证据、README/handoff）

---

## 1. 仓脚手架与存储核心

**Blocked by**：无。**User stories**：US 12/14/15/16（存储部分）、US 26。

### What to build

独立仓可构建可测试的最小地基：git 初始化；package.json（type:module、engines node>=22.19、bin data-mcps）；tsconfig/tsup/vitest 配置；依赖白名单（commander、zod、@modelcontextprotocol/sdk；dev: typescript/tsup/vitest/@types/node）。core 领域类型（Provider/Connector/Connection/Run/Snapshot/Grant/License 按方案 §03 + PRD manifest 八组）；canonical JSON stringifier（键码点排序、ISO 时间，配乱序键契约测试）；文件存储：dataRoot 布局（projects/connections/runs/snapshots/exports/grants/catalog-drafts），写临时+rename 原子提交，进程内互斥串行化写；快照保存（manifest+content.json+raw/，snapshotId 内容寻址派生）与读回校验（坏 hash/缺文件拒绝）；同 runId 幂等保存（计数证明不重复执行保存外动作）；fault-injection hook（DATA_MCPS_TEST_FAULTS，仅测试）。

### Acceptance criteria

- [ ] `npm run build && npm test` 绿；typecheck 0 错
- [ ] canonical：乱序键输入得同哈希（契约测试）
- [ ] 快照往返同字节/同元数据；字节翻转 → 读回拒绝；tmp 目录残留 → 登记无此快照且运行可读回
- [ ] 同 runId 重复保存返回同一 snapshotId，不产生第二个快照
- [ ] failNextCommit 注入 → 保存失败状态，无半快照

## 2. 天气闭环垂直切片

**Blocked by**：1。**User stories**：US 1/2/3/4/5/6/9/10/12/13/14、A01 主路径。

### What to build

端到端最小可跑：catalog 两条目（Open-Meteo 真实研究卡：docsVerified ok、适配/账户/实测分级 false、cost=doc_hint；合成天气夹具源：synthetic 身份、可连接）；默认项目播种 + grants 播种（use/extract/export=true、modelEgress=false 恒关）；连接创建（显式授权确认，缺省拒绝）与 check/validate 分离（check=握手，validate=1 城 1 日测试查询）；天气适配器真实实现（Open-Meteo 参数构造/响应映射/错误分类，transport 可注入；默认走合成夹具：上海/杭州 2026-09-01—07 双城 14 键官方示例形态数据）；POST /runs 执行编排（Run 开始即落盘、每城一请求、AbortSignal 贯穿、请求/分页计数）；checkQuality 纯函数（wx-quality@1：14 期望键、日期连续、主键唯一、单位/时区、null≠0、分页结束）；保存 → 快照 → 读回；导出 JSON（{manifest,content}）/CSV（BOM、null=空格）；node:http 服务（127.0.0.1、Host/Origin 守卫、/api/v1、统一错误信封）；UI 最小五页移植（集市/来源详情/连接/工作台/资产+运行记录），工作台双城 7 日全流程可走通。

### Acceptance criteria

- [ ] A01：双城 7 日 → 预期 14 → 查询 14/14 complete → 保存 → 重开读回同字节/同元数据 → 导出 JSON/CSV 各 14 行
- [ ] 连接检查通过与数据验证待完成分别显示（不混一徽）
- [ ] 执行前显示预期覆盖/最多请求数（=2）/费用已知性（演示无真实调用）/许可检查
- [ ] 未确认授权范围不能建立连接；改参后旧预览标 stale、保存禁用
- [ ] 服务仅 loopback；错误信封 category 表封存；敏感标记不入 API 响应

## 3. 权限与授权失败路径

**Blocked by**：2。**User stories**：US 7/8/22/24/25、A04/A05/A15。

### What to build

四权服务端强制矩阵：use/extract/export/modelEgress 各一条无授权 HTTP 负例（403 + category，请求数 0，无伪成功）；错项目访问（连接在项目 A、项目 B 调用 → 403 且不读 A 凭据）；费用未知默认阻断（真实源条目 cost=doc_hint/unknown 时真实执行不准入，UI 显示授权条件）；许可禁导出（license.exportAllowed=false 时导出 403）；撤权（PUT /grants 后新调用拒绝、历史快照/运行保留）；导出台账 exports/（grant+license 双查、资产页可见历史）；模型外发恒关（无端点无 UI 路径，导出/预览载荷无密钥）；敏感标记扫描测试（stdout 捕获 + API 响应 + 导出文件无 credential 明文）；运行记录页完整字段（时间/修订/请求页数/状态/错误类别/成本已知性/结果引用，无「失败=未计费」）。

### Acceptance criteria

- [ ] 4 条无授权请求各被服务端拒绝（测试证据）
- [ ] A04：错项目发送前拒绝、请求数 0；A05：可提取保存但外发拒绝、许可禁导出时文件交付也拒绝
- [ ] A15：合成敏感标记不出现在日志/导出/API 响应
- [ ] 撤权后新运行被拒绝，旧快照可读回

## 4. 执行层失败路径

**Blocked by**：2。**User stories**：US 11/13/17/18/19/20/21、A02/A03/A06/A07/A08/A11。

### What to build

夹具场景注入（{pagesPerCity, failAtPage?, httpStatus?, heldMs?}）：部分结果 13/14（缺失城市-日清单、不填零、partial 结论、显式确认后保存受限快照绑定缺口说明）；429 二分（Retry-After→rate_limited 展示秒数 / 无头→quota_exhausted / 皆无→rate_limited+未知；默认不自动重试；已取页/请求/费用状态保留）；超时与网络中断（已发送未确认→结果未知，区分失败，不盲目重放）；取消竞态（held promise 挂起 → 取消处理中 → 已取消；迟到 resolve 隔离不入快照；无法证实停止则保留未知）；保存失败重试（同 runId 复用内存结果，不重查供应商——计数 transport 证明）；参数指纹 stale；过期缓存标识（缓存年龄 72h 标签、未明确历史用途不作为新鲜交付）；工具/结构变化占位语义（REST 适配版本变化 → 能力冻结提示）。进程重启恢复：查询中/取消处理中 → 结果未知；保存中 → 损坏演练规则。

### Acceptance criteria

- [ ] A02：13/14 partial、缺失清单、确认后受限快照绑定缺口；A03：改参 stale、旧快照不变
- [ ] A06：429 分类准确、无隐式重试、费用未知不写成 0；A07：取消各态与迟到隔离（held-promise 测试）
- [ ] A11：保存失败无半快照、重试不重查（请求计数不变）；A08：过期标签与历史用途限制
- [ ] 重启恢复规则测试（查询中→结果未知；保存中 tmp 残留→保存失败可读回）

## 5. MCP 接缝

**Blocked by**：2。**User stories**：US 21（MCP 面）、US 26、A10（接缝部分）。

### What to build

≤3 工件：MCP client 薄封装（initialize、tools/list、tools/call、白名单比对、目录指纹 sha256(canonical(按 name 排序的 [{name,inputSchema,annotations(,outputSchema)}]))，连接时与每次 call 准入前各比对）；合成 in-process MCP Server（@modelcontextprotocol/sdk，只读工具两只：白名单内/外各一）；测试：白名单内工具可调、白名单外默认拒绝、新增/变更工具指纹变化 → 能力冻结、readOnlyHint 不作为权限依据。目录：Alpha Vantage 研究卡（协议标「官方 MCP，适配待验证」，不可连接）；业务边界内 Connector.protocol = "mcp" 与 "rest" 区分。不进 UI 主流程、无 OAuth/远程传输/stdio 任意命令。

### Acceptance criteria

- [ ] 合成 Server 白名单通过/拒绝各有测试；指纹变化冻结对应能力、旧快照身份不变
- [ ] 目录卡 MCP 与 REST 协议标识区分；无安装/执行第三方 MCP 的路径
- [ ] 不可信返回内容作为数据隔离展示（UI 转义，不执行脚本——A10 显示面）

## 6. 画像合成样板与目录补全

**Blocked by**：2。**User stories**：US 2/3/23、A12。

### What to build

合成画像源（独立 synthetic 身份）走完整管道：连接（占位 credential_ref）→ 查询（虚构品牌「青禾生活」、演示平台、观察窗 2026-09、分母 1,200）→ persona-quality@1（分母/单位/重叠不求和/小样本抑制标注为原型规则）→ 快照（synthetic 标识不可改成真源）。商业画像（QuestMobile）目录研究卡：未授权 → 准入前阻断（模拟/真实请求均 0），保留需求草稿。其余候选目录卡（QWeather、NOAA、Wind）按方案 §12 状态四面转录。「添加来源」表单 → catalog-drafts/ 研究草稿（不进目录、不可连接、不执行粘贴配置）。

### Acceptance criteria

- [ ] A12：合成标识不可改真源；分母/观察窗/平台/重叠/抑制规则可读；禁止个人级数据与未许可导出
- [ ] 商业画像阻断：请求数 0、阻断记录保留、可切合成样板且身份不混淆
- [ ] 六候选 + 两合成 = 八条目 status 四面与方案 §12 一致；草稿不落目录

## 7. UI 完整移植收尾与交付证据

**Blocked by**：3、4、5、6。**User stories**：全部可见行为面、A01–A15 显示面、交付物要求。

### What to build

对照 demo.html 完成全部页面与可见行为移植（亮暗主题、响应式 1440/390、键盘焦点与 Escape、46 项检查对应行为）；README（启动方式、已实现/未实现清单、真实服务未验证项、后续接入说明）；样例快照随仓（samples/ 下双城天气快照 + 画像快照，synthetic 标识）；Playwright 浏览器证据：A01 主路径 + A02 部分结果 + A04 授权阻断 + A06 限流显示，截图与检查 JSON 留档 evidence/；.flow/handoff.md（开放依赖、下一批前置、A16 接续点）。

### Acceptance criteria

- [ ] 浏览器证据 4 场景通过并留档；亮暗两主题与 390px 无页面级横溢
- [ ] README 三清单（已实现/未实现/未验证）与实际测试证据一致，无越界宣称
- [ ] 样例快照可读回校验通过；交付说明含 JuanerAI 后续最小接缝指引（按现行合同五步）
