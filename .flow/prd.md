# data-mcps 首期 PRD · 独立天气闭环（R1）

> spec 链：`.flow/proposal.md`（根） → 本文。本文细化与填补空白，不推翻 proposal 已记录的决定。无 issue tracker（新仓），按 dev-flow 降级写入 `.flow/prd.md`。

## Problem Statement

业务用户需要外部数据（首期：多城市逐日天气；次要：品牌聚合画像感知流程）回答经营问题，但当前不知道来源是否覆盖、口径是否匹配、许可是否允许，拿到数据也无法复现来源与限制。评审原型（demo.html，46/46 检查通过）证明了界面与流程，但它是 localStorage 演示：无真实服务、无持久化、无服务端权限强制、无真实适配器接缝。

## Solution

交付一个 local-first 本地 Web 产品（独立仓、独立可运行）：数据集市 → 来源详情 → 项目连接 → 查询工作台 → 预览与质量检查 → 保存不可变快照 → 数据资产/运行记录 → 许可允许的文件导出。天气走真实 REST 适配器实现（传输层可注入，外部数据边界为明确标注的合成夹具）；MCP 作为业务边界内独立协议接缝保留（合成 Server 测试、工具白名单、目录指纹）；权限四分（使用/提取/导出/模型外发，默认外发关闭）由服务端强制；快照原子保存、不可原地覆盖、独立读回校验。UI 直接移植评审原型（用户 2026-10-20 决定，跳过 UI-GATE）。

## User Stories

1. 作为分析师，我要在数据集市按关键词/领域/协议/接入状态筛选精选来源卡片，以便找到候选数据。
2. 作为分析师，我要在来源详情看到 Provider、协议/适配版本、覆盖/粒度/时效、示例结构、鉴权方式、许可提示、成本已知性与核实日期，以便判断能否用于我的问题。
3. 作为分析师，我要在来源详情看到「文档已核对/适配待验证/账户权限待核对/已在当前环境实测」的分级状态，以便不被「可直接用」误导。
4. 作为连接维护者，我要为当前项目建立连接实例（账户别名、credential_ref、最小能力/工具白名单、授权范围），未确认范围前不能建立。
5. 作为连接维护者，我要把「连接检查」（协议/鉴权握手）与「数据验证」（一份受限测试查询）分开执行和显示，以便不把握手成功当数据可用。
6. 作为分析师，我要在查询工作台用带标签的参数表单选择城市、日期范围、变量、时区，并在执行前看到预期覆盖（城市×日数）、最多请求数、费用已知性与许可检查。
7. 作为分析师，我要在费用未知时被默认阻断，除非明确接受未知成本且授权绑定单次请求上限/有效期。
8. 作为分析师，我要在授权不足或错项目时在发送前被拒绝（请求数 0、无伪成功），且系统不读取其他项目凭据。
9. 作为分析师，我要在查询后看到表格与 JSON 两种预览，未映射内容不被强制表格化，外链不被自动抓取。
10. 作为分析师，我要看到质量检查：期望/实际条目、关键字段缺失、重复、单位/时区/日界线、分页结束、来源与响应坐标说明；结论分为完整/部分/有警告/不可消费，不用统一绿分遮掩。
11. 作为分析师，当 13/14 时我要看到缺失的城市-日清单，缺失不填零、不标完整；可选择显式保存「受限/部分」快照并绑定缺口说明。
12. 作为分析师，我要保存固定快照：来源、脱敏参数、范围、单位、时区、采集时间 UTC、源更新时间（未知则 unknown）、质量、缺失清单、许可与使用限制全部随快照保存。
13. 作为分析师，我改参数后旧结果标「与当前参数不同」，保存按钮禁用，不能用旧结果保存成新参数的产物；旧快照不变。
14. 作为分析师，我要在数据资产页读回快照（同字节/同元数据）、下载许可允许的 JSON/CSV 文件；刷新是另建运行，不覆盖旧快照。
15. 作为分析师，我要快照保存失败时不产生半快照；同一运行重试保存不再请求供应商。
16. 作为分析师，我要快照损坏（坏 hash/缺文件）时读回拒绝，不回退到伪成功。
17. 作为分析师，我要在 429/额度不足时看到准确分类（频率限流 vs 账户额度）、有证据的 Retry-After、已取页/请求数与费用状态；默认不自动重试。
18. 作为分析师，我要取消查询：停止新请求，状态先「取消处理中」，证实停止才「已取消」，否则保留结果/费用未知；迟到结果隔离，不自动保存/交付。
19. 作为分析师，我要网络中断/超时时看到「是否已发送、已收到部分页、结果/费用何者未知」，不盲目重放。
20. 作为分析师，我要过期缓存有明确年龄标识与源时效；未明确历史用途时不能当作新鲜数据交付。
21. 作为分析师，我要在工具/结构变化时看到哪个工具/参数/输出变了，对应能力被冻结，旧快照保持原身份。
22. 作为分析师，我要在运行记录页看到每次运行的时间、模板/参数修订、请求/页数、状态、错误类别、成本已知性、结果引用；不出现「失败=未计费」。
23. 作为分析师，我要在画像合成样板看到虚构品牌、演示平台、观察窗、分母、重叠/抑制规则说明；合成标识不能改成真源；未授权商业画像在准入前阻断（请求数 0）。
24. 作为业务负责人，我要权限四分可解释：项目使用权、提取权、导出权、模型外发权分别控制，默认模型外发关闭；许可禁止导出时文件交付也被拒绝；撤权阻断新调用但历史保留。
25. 作为连接维护者，我要凭据只存 credential_ref，系统存储不可用时仅会话内存并明确提示；任何日志/导出/浏览器载荷不含密钥。
26. 作为后续接入者，我要业务核心与 MCP/REST/凭据/文件系统适配层分离，独立入口与未来 JuanerAI supplier 入口共用核心，固定源提交/版本可指认。

## Implementation Decisions

### 技术栈（延续 metric-factory，依据：同作者同机、已验证工具链、local-first 一致形态）

- Node ≥ 22.19（本机 v24.21.0），TypeScript ESM，tsup 构建，vitest 测试，zod 校验。
- 无前端框架：静态 SPA（原生 ES modules）由本地服务托管；UI 移植自评审 demo.html，视觉 token 沿用 metric-factory style.css（中性色/绿色、230px 侧栏、14px 正文、亮暗主题）。
- CLI 入口 `data-mcps ui -p <port>`（commander）；服务仅监听 127.0.0.1；dataRoot = `--data-root` 或启动 cwd 下 `.data-mcps/`。
- 依赖白名单：commander、zod、@modelcontextprotocol/sdk（仅 MCP 接缝与合成 Server 测试）。不引入 Web 框架、ORM、SQLite。

### 架构分层（方案 §13：六个职责，核心不持有 SDK 私有类型）

- `core/`（纯业务，无 I/O 私有类型）：目录与来源说明、连接与授权（Grant）、受限查询执行编排、响应整理与质量检查、快照/交付领域逻辑、运行记录。实体：Provider / Connector / Connection / Capability / QueryTemplate / Run / Snapshot / Grant / License 按方案 §03。
- `adapters/`（薄）：天气 REST 适配器（真实实现，transport 为可注入 fetch 兼容函数）；合成夹具适配器（独立 synthetic 身份，fixture 场景可确定性注入部分结果/429/挂起/401/工具变化）；MCP client 接缝（最小封装，工具白名单 + 目录指纹）；凭据解析器（会话内存实现 + 明确提示；Keychain 留接口不实现）；文件系统存储。
- `server/`：node:http 路由 + 服务端权限强制（每个端点核对 Grant；UI 隐藏按钮只是镜像）；静态资源托管；JSON API。
- `ui/`：移植 demo.html 的五页结构（数据集市/我的连接/查询工作台/数据资产/运行记录 + 来源详情）改为调用真实 API。
- `catalog/`：精选静态目录数据（Open-Meteo、QWeather、NOAA、Alpha Vantage MCP、Wind、QuestMobile 六候选 + 合成天气夹具源 + 合成画像源，状态分级按方案 §12，均标证据日期 2026-10-19）。

### 存储决策（回应红队 K3；先于保存路径落地）

- **版本化文件，无数据库**。依据：方案 §13 建议轻量本地索引与版本化文件；metric-factory 同路线已验证；数据量小（精选目录 + 单用户项目）；快照原子保存用「临时目录 + 同目录 rename」（APFS 原子）+ manifest SHA-256 读回校验即可满足，无需 SQLite 迁移语义。
- dataRoot 布局：`projects/<id>.json`、`connections/<id>.json`、`runs/<runId>.json`、`snapshots/<snapshotId>/{content.*,manifest.json}`、`snapshots/index.json`（写临时+rename）、`grants/<projectId>.json`、会话外无秘密。
- 身份与幂等：runId 在执行编排开始时生成；保存以 runId 为幂等键——一个运行至多一个快照；保存失败重试复用同一 runId 与已取内容，不重新请求。snapshotId = 内容寻址（manifest 摘要派生），内容不可原地编辑；派生快照记录 parentSnapshotId。
- 损坏演练（K3 要求）：字节翻转 → 读回拒绝；提交中途（tmp 目录残留）→ 登记中无该快照、可读回原记录。

### 执行层（回应红队 K2）

- 每次查询一个 Run 对象贯穿：参数指纹、授权快照、AbortSignal 贯穿适配器、分页计数、请求计数、成本已知性。
- 夹具支持「挂起响应」（held promise）以制造真实取消竞态：取消 → 停止新分页 → 状态「取消处理中」→ 适配器确认中断 → 「已取消」；迟到 resolve 的结果被隔离，不进快照。
- 结果未知（已发送未确认）与失败（未发送/已拒绝）是不同状态；未知不盲目重试。
- 参数指纹变化 → 旧预览标 stale，保存禁用。

### 权限模型（方案 §06/§09）

- Grant 按项目 × 连接：`use`（项目使用权）、`extract`（提取/查询权）、`export`（文件导出权）、`modelEgress`（默认 false）。
- 服务端每个 API 端点强制核对；测试含 4 条无授权 HTTP 请求各打一次（红队建议）。
- 模型外发：本期无任何模型调用；导出/预览载荷不含密钥；合成敏感标记测试验证日志/导出不泄漏。

### MCP 接缝（回应红队 K4，限定投入）

- 工件 ≤3：MCP client 薄封装（连接/tools/list/tools/call、白名单比对、目录指纹 SHA-256）、合成 in-process MCP Server（@modelcontextprotocol/sdk）、白名单/指纹/工具变化测试。
- 不进 UI 主流程、不引入 OAuth/远程传输；目录中 Alpha Vantage 仅研究卡（协议标「官方 MCP，适配待验证」）。
- 指纹变化 → 冻结对应能力；新增工具默认不准入。

### 天气适配器

- Open-Meteo Historical Weather API 的真实 REST 实现：参数构造（经纬度、日期范围、daily 变量、timezone）、响应映射（单位、时区、坐标）、错误分类（401/403/429/超时/5xx）。
- transport 注入：测试与首期运行默认接**合成夹具**（官方示例形态的 14 行双城数据，标 synthetic）；真实 base URL 调用代码路径存在但未授权不执行（UI 显示「真实调用未授权」）。
- 地理编码：城市→坐标在目录中预置（上海/杭州等），用户确认；不静默选第一个同名城市。

### 质量检查（方案 §07）

- 天气：期望键 = 城市×日；日期连续、主键唯一、字段类型/单位明确、null 与 0 区分、分页结束标记、请求/响应坐标记录。
- 画像（合成）：品牌×平台×观察窗×分群；分母、单位、重叠不强制求和 100%、小样本抑制按样板规则展示并标注为原型规则。
- 结论：complete / partial / warning / unusable；无法建立预期 → 「完整性未知」。

### R1 退出条件（修订，回应红队 K5）

- 方案 §14 原文含「获准的小样真实读取」。本期修订为：**合成正负例全部可复现 + 适配器真实实现与可替换接缝 + 快照独立读回 + 许可/费用边界可解释 + 浏览器证据；真实小样读取移至用户另行授权后（A16 保持未执行）**。依据：用户指令 #2（合成夹具边界）与授权条款（真实供应商请求需另行授权）。此项列入 GRILL 集中确认。

## Testing Decisions

- 好测试的标准：只测外部可观察行为（API 响应、文件产物、状态机可见状态），不测内部实现；负例与正例成对。
- 模块与接缝：
  - 存储：快照往返同字节、原子提交（tmp 残留演练）、字节翻转读回拒绝、同 runId 重复保存幂等且不重新请求（用计数 transport 证明）。
  - 执行层：挂起夹具的取消竞态（K2 测试）、429 分类与不自动重试、部分结果 13/14 缺失清单、参数指纹 stale、未知 vs 失败状态区分。
  - 权限：4 条无授权 HTTP 请求（use/extract/export/modelEgress）各被服务端拒绝；错项目拒绝且请求数 0。
  - 天气适配器：官方示例形态夹具的请求构造与响应映射、单位/时区、错误分类表。
  - MCP 接缝：合成 Server 白名单通过/拒绝、指纹比对、工具变化冻结。
  - 导出：JSON/CSV 内容与快照一致、许可禁止导出时拒绝。
  - 敏感标记：合成 credential 标记不出现在日志/导出/API 响应。
- 浏览器证据（VERIFY 阶段）：Playwright 走 A01 主路径 + A02/A04/A06 关键失败显示，截图留档 `evidence/`。
- Prior art：metric-factory vitest 配置与 contract 测试模式；评审包 Playwright 检查脚本思路。
- 真实依赖案例（dev-flow VERIFY 强制）：本期无已授权真实外部依赖；降级声明——所有外部数据为合成夹具，VERIFY 记录「partially verified — no real-dependency case（授权约束）」，真实对照 A16 留「未执行」。

## Out of Scope

- 真实供应商请求、OAuth、密钥配置、付费调用、第三方 MCP 安装（需另行明确授权）。
- 修改 JuanerAI、宿主接线、远程推送、发布部署。
- 自然语言查数助手、周期刷新、团队协作、更多行业来源、stdio 来源、通用插件市场、Agent Runtime、分析核心、企业 IAM。
- 个人级画像、绕过平台导出或许可限制。
- Keychain 实际集成（仅接口 + 会话内存实现 + 明确提示）。

## Further Notes

- 启动方式目标：`npm install && npm run build && node dist/cli.js ui -p 4173`（或 `npm start`），浏览器打开 http://127.0.0.1:4173。
- 交付物按用户指令：启动方式、可操作产品、测试与浏览器证据、样例快照、已实现/未实现清单、真实服务未验证项及后续接入说明（进 `.flow/handoff.md` 与仓 README）。
- 红队 K1 监控：首个垂直切片完成后评估 turn 燃烧率，超 30% 则按 K1 降级顺序砍范围（MCP 桩 → 画像静态页 → 失败路径保留 3 条）。

## PRD diff gate 记录（auto，2026-10-20）

相对 proposal.md 的增改删决策点：
- **纯增量（自批准）**：技术栈与依赖白名单、core/adapters/server/ui/catalog 分层、dataRoot 布局与身份/幂等键设计、执行层 AbortSignal/挂起夹具设计、Grant 四字段与端点强制点、MCP 接缝 ≤3 工件上限、天气适配器参数/错误分类表、测试矩阵与浏览器证据计划。
- **变更/删除 proposal 决定**：无。R1 退出条件修订、UI-GATE 跳过均为 proposal 已记录决定，此处仅细化。
- 结论：PRD faithful to proposal + additive detail，自批准通过（history 已记）。

## GRILL 决议记录

### Round 1（author-blind 子代理，9 包，全部采纳）

1. **API 面**：资源式 `/api/v1`：`GET /sources`、`GET /sources/:id`、`GET/POST /projects`、`GET/POST /connections`、`POST /connections/:id/check`、`POST /connections/:id/validate`、`POST /runs`、`GET /runs`、`GET /runs/:id`、`POST /runs/:id/cancel`、`POST /runs/:id/save`、`GET /snapshots`、`GET /snapshots/:id`、`GET /snapshots/:id/export?format=json|csv`、`GET/PUT /grants/:projectId`。项目上下文显式 `projectId`，跨项目 403 且请求数 0。错误信封 `{error:{category,message,details?,retryAfterSeconds?}}`，HTTP 状态码与 category 对应表封存。同源守卫：Host 仅 127.0.0.1/localhost:port，变更类端点要求 Origin 空或同源；无 cookie/session token。
2. **项目与 Grant 播种**：首启播种「默认项目」；一连接属一项目；建立连接 = 显式授权确认（body 必含能力白名单 + 四权初值，缺省拒绝）；播种默认 `use=true, extract=true, export=true, modelEgress=false`；R1 无 modelEgress 开启端点与 UI 路径（schema 恒 false）；撤权走 `PUT /grants`，撤权阻断新调用、历史保留。
3. **Run 持久化与崩溃恢复**：Run 编排开始即落盘（参数指纹、授权快照、连接/模板修订、状态），每次迁移原子重写（tmp+rename）；未保存结果驻留进程内存（runId → rows/raw/计数），保存只从内存取、永不重查；重启后 `查询中/取消处理中` → 标 `结果未知`（附注进程中断），不可再保存；`保存中` → 按损坏演练核对（tmp 残留 = 无快照，运行回退 `保存失败`）；并发运行允许，文件写进程内互斥串行化。
4. **快照布局与 manifest v1**：`content.json`（规范化行+字段/单位映射，唯一事实源）+ `raw/`（夹具原始响应逐请求一份，manifest 记 `rawRetained` 及原因）；CSV 不落盘、导出时生成。manifest 八组：identity / source（别名化、适配版本、工具指纹或 null）/ query（脱敏参数、参数指纹、模板修订、分页/请求计数）/ coverage（请求/实际范围、时区、单位、请求/响应坐标）/ time（采集 UTC、源更新或 "unknown"）/ quality（结论、期望/实际、缺失清单、规则版本）/ license（条款引用、导出/模型允许位、核实日期、synthetic 标记）/ files（sha256+size）。snapshotId = sha256（内容哈希 + 参数指纹 + 修订 + 质量结论，不含 createdAtUtc/自身）前 16 hex + `snap_` 前缀；R1 parentSnapshotId 恒 null。
5. **指纹 canonicalization**：全仓唯一 canonical JSON（键码点排序、无冗余空白、ISO 8601 时间、最短精确数字），自写确定性 stringifier（不新增依赖）+ 乱序键契约测试。参数指纹含 connectorId/capabilityId/templateRevision/规范化 params（城市取预置坐标非显示名）；工具目录指纹 = sha256(canonical(按 name 排序的 [{name,inputSchema,annotations(,outputSchema)}]))，连接时与每次 tools/call 准入前各比对一次；修订号：模板 `<capability>@<整数>`（如 `wx.daily@1`），连接修订单调整数。
6. **质量检查器合同**：纯函数 `checkQuality(expectedSpec, actualRows, mappingSpec, ruleVersion) → QualityReport`（core，无 I/O）；报告字段 expectedCount/actualCount/missingKeys/duplicateKeys/fieldIssues/unitTimezoneOk/paginationComplete/conclusion/ruleVersion/checkedAtUtc；期望键 = 城市集 × 请求时区本地闭区间日序列；结论：缺键→partial（不填零）、可选字段缺失/坐标偏移可解释→warning、关键标识/日期/单位/许可不明→unusable、无规则能力→「完整性未知」（第五值，R1 不触发）；规则版本 `wx-quality@1`/`persona-quality@1`；缺失清单双写运行记录与 manifest.quality。
7. **天气请求拓扑与上限**：每城市一请求，maxRequests = 城市数（A01=2）；「分页」= 适配器内部逻辑页，夹具场景配置 `{pagesPerCity, failAtPage?, httpStatus?, heldMs?}`；上限：单请求超时 10s、单响应 5 MB、无隐藏重试；429 二分：有 Retry-After → rate_limited（展示秒数），无头但语义额度耗尽 → quota_exhausted，皆无 → rate_limited 且 Retry-After 显示「未知」；夹具两种 429 各一例。
8. **目录条目 schema**：`catalog/*.json` 静态随仓；status 四面独立 `{docsVerified, adaptationVerified, accountChecked, envTested}` 各为 `{ok, at, evidence}`，分行展示、无汇总徽标；cost `{knownness: doc_hint|account_verified|unknown, note, checkedAt}`；license `{summary, sourceUrl, checkedAt, exportAllowed, modelAllowed, retentionNote}`；auth `{kind: none|api_key|jwt|oauth|mcp, note}`；`synthetic: boolean` 为条目身份、真实/合成不同条目无翻转字段。预置城市 R1 封定仅上海 (31.2304,121.4737)、杭州 (30.2741,120.1551) WGS84 已确认展示；八条目（六候选+合成天气+合成画像）status 初值按方案 §12 逐格转录。
9. **画像管道路径与 R1 交付语义**：(a) 合成画像源走完整管道（连接→查询→`persona-quality@1` 质量→快照，独立 synthetic 身份、占位 credential_ref）；商业画像入口仅目录研究卡+准入阻断（请求数 0），无可连接适配器。(b) R1「交付」= 许可允许的文件导出，不建 Delivery 实体；新增导出台账 `exports/<exportId>.json`（snapshotId、projectId、format、licenseCheck、grantCheck、createdAtUtc、filename），资产页可见导出历史；导出先查 grant.export 再查 license.exportAllowed，任一拒绝 → 403；JSON=单文件 {manifest, content}；CSV=UTF-8 带 BOM、RFC 4180、null=空单元格（≠0）、文件名 `<snapshotId>.<json|csv>` Content-Disposition 下载；回执体系推迟 R3（A14 不在 R1）。

### Round 2（主 agent 自审，7 包，全部采纳；此后无新增开放问题，GRILL 收敛）

10. **UI 移植形态**：拆分为 `ui/index.html + style.css + app.js`（原生 ES modules）；视觉/文案/交互 1:1 移植 demo.html（亮暗主题、响应式、键盘/Escape、46 项可见行为）；全部 localStorage 状态改调真实 API；「模拟」按钮改真实运行；不新增原型没有的页面/交互。
11. **连接检查 vs 数据验证的夹具语义**：`check` = 适配器握手（REST 夹具返回握手 ok + 适配版本；MCP = initialize + tools/list + 指纹比对）；`validate` = 一次最小受限测试查询（天气 1 城 1 日、画像单维度），结果只影响「数据验证」状态展示，不产生快照、不进资产。
12. **成本已知性展示来源**：执行前检查与运行记录的费用已知性取 catalog 条目 `cost.knownness`；合成源恒「演示无真实调用」（≠「供应商免费」）；Open-Meteo 为 `doc_hint`（免费层限非商业用途）；无调用数→金额换算。
13. **「添加来源」草稿**：表单 → 写 `catalog-drafts/<id>.json`（状态「研究草稿」），不进精选目录、不可连接；不执行粘贴配置、不安装包（方案 §05/§13）。
14. **保存失败注入接缝**：store 构造参数/`DATA_MCPS_TEST_FAULTS` env 的 fault-injection hook（仅测试）：`failNextCommit` 演练保存失败；UI 演示用夹具场景而非故障注入。
15. **日志边界**：仅 stdout：时间、端点、状态码、runId/别名、脱敏参数摘要、请求/页数、成本已知性；禁写 Authorization/key/cookie/签名 URL/个人数据；不落独立日志文件（runs/*.json 即持久记录）；敏感标记测试扫描 stdout 捕获与 API 响应。
16. **端口与启动**：默认 4173；占用即报错退出并提示 `-p` 换端口（不静默换端口）。

**GRILL 收敛声明**：Round 2 结束后无新增开放问题，"GRILL converged after 2 rounds"。**升级项（全流程唯一一次）**：红队 K5——R1 退出条件修订需用户确认（见对话中的集中提问；其余实质问题无）。
