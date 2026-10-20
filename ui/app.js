/* data-mcps 独立工作台 UI。
 * 结构与文案移植自已批准原型 demo.html；全部状态来自本地服务真实 API（/api/v1）。
 * 外部数据边界为明确标注的合成夹具；无真实供应商调用。
 */
'use strict';

const PROJECT = 'default';
const PROJECT_NAME = '默认项目';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `HTTP ${res.status}`);
    err.category = data?.error?.category;
    err.status = res.status;
    err.details = data?.error?.details;
    err.retryAfterSeconds = data?.error?.retryAfterSeconds;
    throw err;
  }
  return data;
}
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b ?? {});
const put = (p, b) => api('PUT', p, b);

// ---------- 通用 ----------
const icons = { market: 'M3 5h18v14H3z M3 9h18 M8 9v10 M13 9v10', plug: 'M8 3v5 M16 3v5 M6 8h12v3a6 6 0 0 1-12 0z M12 17v4', query: 'M3 4h18v16H3z M7 9l3 3-3 3 M13 15h4', asset: 'M3 7l9-4 9 4-9 4z M3 12l9 4 9-4 M3 17l9 4 9-4', history: 'M3 11a9 9 0 1 1 3 8 M3 4v7h7 M12 7v6l4 2', search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M16 16l5 5', arrow: 'M4 12h16 M14 6l6 6-6 6', close: 'M5 5l14 14 M19 5L5 19', shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6', cloud: 'M6 18h12a4 4 0 0 0 0-8 6 6 0 0 0-11-2 5 5 0 0 0-1 10', back: 'M20 12H4 M10 6l-6 6 6 6', check: 'M5 12l4 4L19 6' };
const icon = (n) => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="${icons[n] || icons.asset}"/></svg>`;
const badge = (s, kind = '') => `<span class="badge ${kind}">${e(s)}</span>`;
const b = (label, act, extra = '', cls = '') => `<button class="btn ${cls}" data-act="${act}" ${extra}>${label}</button>`;

let route = '';
let toastTimer = null;
let dialogReturn = null;
let previewTab = 'table';
let filter = { search: '', category: '全部', protocol: '全部接法', status: '全部状态' };
let catalog = [];
let cities = [];
let pollTimer = null;

// 查询工作台本地表单状态（仅 UI；真值在服务端）
const qform = {
  sourceId: 'wx-synthetic',
  cities: 'both',
  start: '2026-09-01',
  end: '2026-09-07',
  scenario: 'success',
  grant: false,
  lastRun: null, // 最近一次完成的 {run, preview}
};

const SCENARIOS = [
  ['success', '完整返回'],
  ['partial', '部分数据缺失（13/14）'],
  ['rate', '限流 429（Retry-After 60s 演示值）'],
  ['quota', '额度耗尽 429'],
  ['auth', '凭据失效 401'],
  ['stale', '过期缓存（72 小时）'],
  ['slow', '慢速 3s（可演示取消）'],
  ['late', '慢速 3s + 取消后迟到结果'],
  ['unknown', '超时（12s 超过 10s 上限）'],
];
const SCENARIO_BODY = {
  success: {},
  partial: { missingByCity: { hangzhou: ['2026-09-03'] } },
  rate: { failCity: 'hangzhou', failStatus: 429, retryAfter: '60' },
  quota: { failCity: 'hangzhou', failStatus: 429, quotaExhausted: true },
  auth: { failCity: 'shanghai', failStatus: 401 },
  stale: { staleHours: 72 },
  slow: { heldMs: 3000 },
  late: { heldMs: 3000, lateResultOnAbort: true },
  unknown: { heldMs: 12000 },
};

function toast(s) {
  clearTimeout(toastTimer);
  $('#toast').textContent = s;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 4200);
}
function formatDate(s) {
  return new Date(s).toLocaleString('zh-CN', { hour12: false, timeZone: 'UTC' }) + ' UTC';
}
function go(path) {
  if (location.hash === '#' + path) render(true);
  else location.hash = path;
  closeMenu();
}
function closeMenu() {
  $('#sidebar').classList.remove('open');
  $('#overlay').hidden = true;
  $('#menu').setAttribute('aria-expanded', 'false');
}

const RUN_LABEL = {
  未发送: '未发送 · 阻断',
  查询中: '查询中',
  完整返回: '完整返回',
  部分返回: '部分返回',
  失败: '失败',
  取消处理中: '取消处理中',
  已取消: '已取消',
  结果未知: '结果未知',
};
function runColor(status) {
  if (status === '完整返回') return 'good';
  if (['失败', '未发送'].includes(status)) return 'bad';
  if (['部分返回', '结果未知', '查询中', '取消处理中'].includes(status)) return 'warn';
  return '';
}
const CATEGORY_LABEL = {
  auth_invalid: '鉴权失效',
  scope_insufficient: '授权范围不足',
  permission_denied: '权限拒绝',
  rate_limited: '频率限流',
  quota_exhausted: '账户额度不足',
  timeout: '超时',
  network: '网络异常',
  partial_result: '部分结果',
  cancelled: '已取消',
  unknown_outcome: '结果未知',
  save_failed: '保存失败',
  tool_changed: '工具已变化',
  validation_failed: '校验未通过',
  license_denied: '许可禁止',
  stale_params: '参数已变化',
  not_found: '不存在',
  bad_request: '请求有误',
};
const COST_LABEL = { demo_no_call: '演示无真实调用', doc_hint: '文档提示（账户未核对）', account_verified: '账户已核对', unknown: '费用未知' };

async function connectionsOf(sourceId) {
  const all = await get(`/connections?projectId=${PROJECT}`);
  return all.filter((c) => c.sourceId === sourceId);
}

// ---------- 框架 ----------
function sidebar(counts) {
  const name = route.split('/')[0] || 'catalog';
  $('#sidebar').innerHTML = `
    <div class="brand"><div class="brand-mark">${icon('asset')}<span>data<span style="color:var(--ink)">-mcps</span></span></div><p>外部数据工作台</p></div>
    <div class="project-switch"><span class="fine">当前项目</span><strong>${PROJECT_NAME}</strong><span class="fine">本地独立工作区</span></div>
    <nav aria-label="主要功能"><div class="nav-label">工作空间</div>
      ${[['catalog', 'market', '数据集市', null], ['connections', 'plug', '我的连接', counts.connections], ['query', 'query', '查询工作台', null], ['assets', 'asset', '数据资产', counts.snapshots], ['runs', 'history', '运行记录', counts.runs]]
        .map(([id, ic, label, count]) => `<button class="nav-link ${name === id || (name === 'detail' && id === 'catalog') ? 'active' : ''}" data-act="nav" data-path="${id}" ${name === id ? 'aria-current="page"' : ''}>${icon(ic)}${label}${count !== null ? `<span class="count">${count}</span>` : ''}</button>`)
        .join('')}
    </nav>
    <div class="side-bottom">
      <p class="fine">本地服务 · 快照不可变<br>外部数据为明确标注的合成夹具<br>真实供应商调用未授权</p>
    </div>`;
}

const head = (title, desc, action = '') => `<div class="page-head"><div><h1>${title}</h1><p>${desc}</p></div>${action}</div>`;
const steps = (n) => `<div class="steps" aria-label="数据流程">${['评估来源', '连接检查', '查询与质量', '保存与交付'].map((x, i) => `<span class="step ${i <= n ? 'active' : ''}">${i + 1} ${x}</span>`).join('')}</div>`;

async function render(focus = false) {
  route = location.hash.slice(1) || 'catalog';
  document.documentElement.dataset.theme = localStorage.getItem('data-mcps-theme') || 'light';
  const page = route.split('/')[0];
  $('#breadcrumb').textContent = { catalog: '数据集市', detail: '评估来源', connections: '我的连接', query: '查询工作台', assets: '数据资产', runs: '运行记录' }[page] || '数据集市';
  let counts = { connections: 0, snapshots: 0, runs: 0 };
  try {
    const [conns, runs, cityList] = await Promise.all([
      get(`/connections?projectId=${PROJECT}`),
      get(`/runs?projectId=${PROJECT}`),
      get('/cities'),
    ]);
    cities = cityList;
    counts = { connections: conns.length, snapshots: new Set(runs.filter((r) => r.snapshotId).map((r) => r.snapshotId)).size, runs: runs.length };
  } catch (err) {
    $('#main').innerHTML = `<div class="notice bad"><strong>本地服务不可达</strong><p>${e(err.message)}</p></div>`;
    sidebar(counts);
    return;
  }
  sidebar(counts);
  if (page === 'detail') await renderDetail(route.split('/')[1]);
  else if (page === 'connections') await renderConnections();
  else if (page === 'query') await renderQuery();
  else if (page === 'assets') await renderAssets();
  else if (page === 'runs') await renderRuns();
  else await renderCatalog();
  if (focus) {
    $('#main').focus();
    window.scrollTo(0, 0);
  }
}

// ---------- 数据集市 ----------
function statusBadge(entry) {
  if (entry.synthetic) return badge('合成样板', 'good');
  if (entry.connectable) return badge('可连接', 'good');
  return badge('适配待验证', 'warn');
}

function card(s) {
  const logo = s.synthetic ? 'SYN' : s.name.slice(0, 2).toUpperCase();
  return `<article class="source-card">
    <div class="source-title"><span class="source-logo">${e(logo)}</span><div><h3>${e(s.name)}</h3><p>${e(s.provider.name)} · ${e(s.domain)}</p></div></div>
    <p class="source-description">${e(s.summary)}</p>
    <div class="tags">${badge(s.connector.protocol === 'mcp' ? '官方 MCP' : s.connector.protocol === 'rest' ? 'REST API' : '接入协议待核实', s.connector.protocol === 'mcp' ? 'good' : '')}${statusBadge(s)}${s.synthetic ? '' : badge(COST_LABEL[s.cost.knownness] ?? s.cost.knownness, 'warn')}</div>
    <dl class="source-spec"><dt>覆盖</dt><dd>${e(s.connector.coverage)}</dd><dt>授权</dt><dd>${e(s.license.summary)}</dd></dl>
    <footer><span class="fine">文档研究 · 非服务可用性认证</span>${b('评估与接入 ' + icon('arrow'), 'detail', `data-id="${s.id}"`, 'small')}</footer>
  </article>`;
}

function matches() {
  const protoMap = { 全部接法: null, 'REST API': 'rest', '官方 MCP': 'mcp', 接入协议待核实: 'none' };
  const statusMap = { 全部状态: null, 可连接: 'connectable', 合成样板: 'synthetic', 适配待验证: 'pending' };
  return catalog.filter((s) => {
    if (filter.category !== '全部') {
      const cat = { 天气环境: '天气', 品牌人群: '品牌画像', 金融商业: '金融' }[filter.category];
      if (s.domain !== cat) return false;
    }
    const proto = protoMap[filter.protocol];
    if (proto && s.connector.protocol !== proto) return false;
    const st = statusMap[filter.status];
    if (st === 'connectable' && !s.connectable) return false;
    if (st === 'synthetic' && !s.synthetic) return false;
    if (st === 'pending' && (s.connectable || s.synthetic)) return false;
    if (filter.search && !(s.name + s.domain + s.summary + s.connector.protocol).toLowerCase().includes(filter.search.toLowerCase())) return false;
    return true;
  });
}

async function renderCatalog() {
  catalog = await get('/sources');
  $('#main').innerHTML = `
    <section class="catalog-intro"><div><div class="eyebrow">DATA MARKETPLACE / 数据集市</div><h1>找到数据，也看清它的边界。</h1><p>从来源、覆盖与授权开始，把外部数据整理为可追溯的数据资产。</p></div>
    <div class="intro-meta"><strong>精选来源，完整交付</strong>发现 → 评估 → 查询 → 保存<br>本期仅合成夹具可连接，真实来源未授权</div></section>
    <div class="notice">当前页面展示候选来源与接入设计。「文档已核对」不表示服务已接通；真实供应商请求、OAuth 与付费调用未授权，本期不执行。</div>
    <div class="search-bar"><div class="search-wrap">${icon('search')}<label class="sr-only" for="source-search">搜索数据来源</label><input id="source-search" type="search" value="${e(filter.search)}" placeholder="搜索数据来源、领域或接法"></div>
      <label class="sr-only" for="protocol-filter">协议筛选</label><select id="protocol-filter">${['全部接法', 'REST API', '官方 MCP', '接入协议待核实'].map((x) => `<option ${filter.protocol === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <label class="sr-only" for="status-filter">接入状态筛选</label><select id="status-filter">${['全部状态', '可连接', '合成样板', '适配待验证'].map((x) => `<option ${filter.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
      ${b('+ 添加来源', 'add-source')}</div>
    <div class="categories" aria-label="数据分类">${['全部', '天气环境', '品牌人群', '金融商业'].map((x) => `<button class="category ${x === filter.category ? 'active' : ''}" data-act="category" data-cat="${x}" aria-pressed="${x === filter.category}">${x}</button>`).join('')}</div>
    <div class="section-head"><div><h2>精选来源</h2><p>先评估可得性，再决定接入</p></div><span class="fine" id="source-count"></span></div>
    <div class="source-grid" id="source-grid"></div>
    <section class="demo-section"><div class="section-head"><div><h2>用合成样板走一遍</h2><p>无真实服务、无账户、无消费者数据</p></div>${badge('SYNTHETIC', 'good')}</div>
      <div class="sample-card"><div class="source-title"><span class="source-logo">${icon('cloud')}</span><div><h3>城市逐日天气 → 数据资产</h3><p>两城市、七天、14 个预期条目；可演示缺失、限流、取消与过期缓存。</p></div></div>${b('开始天气样板', 'detail', 'data-id="wx-synthetic"', 'primary')}</div>
      <div class="sample-card"><div class="source-title"><span class="source-logo">SYN</span><div><h3>品牌聚合人群 → 口径与限制</h3><p>虚构品牌“青禾生活”；分母、观察窗与抑制值保持可见。</p></div></div>${b('打开合成画像', 'detail', 'data-id="persona-synthetic"')}</div></section>
    <p class="footnote">官方资料核对日期：2026-10-19 · 无安装人数、排行榜或未经证实的认证 · 候选证据见评审方案第 12 节</p>`;
  renderCards();
}

function renderCards() {
  const xs = matches();
  $('#source-count').textContent = xs.length + ' 个来源';
  $('#source-grid').innerHTML = xs.length
    ? xs.map(card).join('')
    : `<div class="empty" style="grid-column:1/-1"><h2>没有匹配的来源</h2><p>试试“天气”“品牌”或清除筛选。未检索到不代表已有可用服务。</p>${b('清除筛选', 'clear-filters')}</div>`;
}

// ---------- 来源详情 ----------
async function renderDetail(id) {
  const s = await get(`/sources/${id}`).catch(() => null);
  if (!s) return go('catalog');
  const facets = [
    ['官方文档已核对', s.status.docsVerified],
    ['适配已验证', s.status.adaptationVerified],
    ['账户权限已核对', s.status.accountChecked],
    ['当前环境已实测', s.status.envTested],
  ];
  const action = s.connectable
    ? b('在当前项目配置连接', 'connect', `data-source="${s.id}"`, 'primary')
    : s.id === 'questmobile-truth'
      ? b('演示授权不足阻断', 'blocked', `data-source="${s.id}"`, 'primary')
      : '';
  $('#main').innerHTML = `
    ${b(icon('back') + ' 返回集市', 'nav', 'data-path="catalog"', 'quiet small')}<div style="height:20px"></div>
    ${head(e(s.name), '评估覆盖、口径、许可与成本，避免把连接当作数据可用。', action)}
    ${steps(0)}
    <div class="detail-layout"><section>
      <p class="detail-lead">${e(s.summary)}</p>
      <div class="tags" style="margin-bottom:22px">${badge(s.connector.protocol.toUpperCase())}${s.synthetic ? badge('SYNTHETIC', 'good') : badge('真实来源 · 未接通', 'warn')}</div>
      <div class="panel"><h2>这份数据是否适合你的问题</h2>
        <dl class="detail-grid">
          <div><dt>覆盖与粒度</dt><dd>${e(s.connector.coverage)} · ${e(s.connector.granularity)}</dd></div>
          <div><dt>数据形态</dt><dd>${e(s.connector.protocol === 'mcp' ? 'MCP 工具/资源' : 'REST JSON')} → 表格 / JSON 预览</dd></div>
          <div><dt>示例结构</dt><dd>${e(s.exampleShape ?? '待核实')}</dd></div>
          <div><dt>时效</dt><dd>${e(s.connector.latency)}</dd></div>
          <div><dt>适配版本</dt><dd>${e(s.connector.adapterVersion ?? '无（未适配）')}</dd></div>
        </dl>
      </div>
      <div class="panel"><h2>接入状态 · 四面分别举证</h2>
        <div class="check-list">${facets.map(([label, f]) => `<div class="check-line"><strong>${label}</strong><span class="state-text ${f.ok ? '' : 'warn'}">${f.ok ? '是' : '否'} · ${e(f.at)}${f.evidence ? ` · <a href="${e(f.evidence)}" target="_blank" rel="noopener noreferrer">依据 ↗</a>` : ' · 无证据'}</span></div>`).join('')}</div>
      </div>
      <div class="panel"><h2>许可与账户需要单独核对</h2>
        <ul class="row-list">
          <li><strong>许可</strong>${e(s.license.summary)}（导出：${s.license.exportAllowed ? '允许' : '未允许'} · 模型外发：${s.license.modelAllowed ? '允许' : '未允许'}）</li>
          <li><strong>鉴权</strong>${e(s.auth.kind)} — ${e(s.auth.note)}</li>
          <li><strong>成本状态</strong>${e(COST_LABEL[s.cost.knownness] ?? s.cost.knownness)}。${e(s.cost.note)}</li>
          <li><strong>模型外发</strong>默认关闭。数据可提取不代表可把样本、摘要或日志发送到模型。</li>
        </ul>
      </div>
      ${!s.connectable && !s.synthetic ? `<div class="notice warn">此候选仅展示评估设计。本期不会安装 MCP、启动进程或打开 OAuth；接入条件齐备前不可连接。</div>` : ''}
      ${s.id === 'questmobile-truth' ? `<div class="notice warn">没有已验证商业授权或可验导出接口。授权不足演示会在请求前阻断；合成画像是另一个来源身份，不能互相替代。</div>` : ''}
    </section>
    <aside>
      <div class="panel"><h2>资料依据</h2><p class="fine">核对时间 · ${e(s.license.checkedAt)}<br>文档事实不代表用户服务可用。</p>
      <p style="margin-top:15px"><a href="${e(s.license.sourceUrl)}" target="_blank" rel="noopener noreferrer">供应商官方资料 ↗</a></p></div>
      <div class="panel"><h2>凭据</h2><p class="fine">连接仅保存 credential_ref 引用；不扫描本机秘密，不在浏览器持有长期密钥。系统凭据存储不可用时仅会话内存，并明确提示。</p></div>
    </aside></div>`;
}

// ---------- 我的连接 ----------
async function renderConnections() {
  const conns = await get(`/connections?projectId=${PROJECT}`);
  const rows = conns
    .map((c) => {
      const src = catalog.find((x) => x.id === c.sourceId);
      return `<tr>
      <td class="wrap"><strong>${e(src?.name ?? c.sourceId)}</strong><br><span class="fine">${e(c.id)} · ${src?.synthetic ? 'synthetic' : 'real'} · 修订 ${c.revision}</span></td>
      <td>${PROJECT_NAME}</td>
      <td>${badge(c.status, c.status === '连接检查通过' ? 'good' : 'warn')}<br><span class="fine">数据验证：${e(c.dataValidation)}</span></td>
      <td class="wrap"><span class="mono">${e(c.credentialRef)}</span><br><span class="fine">使用${c.grant.use ? '✓' : '✗'} 提取${c.grant.extract ? '✓' : '✗'} 导出${c.grant.export ? '✓' : '✗'} 外发✗</span>${c.credentialNotice ? `<br><span class="fine state-text warn">${e(c.credentialNotice)}</span>` : ''}</td>
      <td><div class="actions">
        ${b('连接检查', 'check-conn', `data-id="${e(c.id)}"`, 'small')}
        ${b('数据验证', 'validate-conn', `data-id="${e(c.id)}"`, 'small')}
        ${b('去查询', 'use-conn', `data-id="${e(c.id)}" ${c.status !== '连接检查通过' ? 'disabled' : ''}`, 'small')}
        ${b(c.grant.export ? '撤销导出权' : '恢复导出权', 'toggle-export', `data-id="${e(c.id)}"`, 'quiet small')}
        ${b(c.grant.use ? '撤销使用权' : '恢复使用权', 'toggle-use', `data-id="${e(c.id)}"`, 'quiet small')}
      </div></td></tr>`;
    })
    .join('');
  $('#main').innerHTML = `
    ${head('我的连接', '连接检查与数据验证分别记录；每个连接只属于当前项目。', b('从集市选择', 'nav', 'data-path="catalog"'))}
    <div class="notice">凭据只存引用；连接检查（协议/鉴权）通过不表示数据可用，数据验证是独立的受限测试查询。</div>
    ${conns.length ? `<div class="table-wrap"><table><caption>当前项目的连接</caption><thead><tr><th>连接</th><th>项目</th><th>两个检查状态</th><th>凭据与四权</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">${icon('plug')}<h2>还没有连接</h2><p>从天气样板开始，先看覆盖和使用条件，再配置当前项目的只读范围。</p>${b('评估天气来源', 'detail', 'data-id="wx-synthetic"', 'primary')}</div>`}
    <p class="footnote">供应商费用与额度未核实。撤权阻断新调用，保留历史运行和快照；模型外发本期恒为关闭。</p>`;
}

// ---------- 对话框 ----------
function openDialog(title, body, foot) {
  dialogReturn = document.activeElement;
  $('#dialog').innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${title}</h2>${b(icon('close'), 'close', 'aria-label="关闭对话框"', 'quiet icon-btn')}</div><div class="dialog-body">${body}</div><div class="dialog-foot">${foot}</div>`;
  $('#dialog').showModal();
  const first = $('#dialog').querySelector('input:not([readonly]),select,button');
  if (first) first.focus();
}
function closeDialog() {
  $('#dialog').close();
  if (dialogReturn?.isConnected) dialogReturn.focus();
  else $('#main').focus();
}

function connectDialog(sourceId) {
  const s = catalog.find((x) => x.id === sourceId);
  if (!s) return;
  openDialog(
    `配置连接 · ${e(s.name)}`,
    `<p>仅建立本地合成样板连接：不安装程序、不请求供应商、不打开 OAuth。</p>
     <div class="notice">数据来源：${e(s.name)} · ${PROJECT_NAME}<br>真实服务费用、账户范围和许可仍未核实。</div>
     <div class="field"><label for="conn-alias">账户别名</label><input id="conn-alias" value="演示账户"></div>
     <div class="field"><label for="credential-ref">凭据引用（不是密钥）</label><input id="credential-ref" readonly value="synthetic://credential/demo-ref"></div>
     <dl class="detail-grid" style="margin-top:18px">
       <div><dt>允许能力</dt><dd>${s.capabilities.map((c) => e(c.label)).join('、') || '无'}</dd></div>
       <div><dt>真实调用与费用</dt><dd>0 次 / 未发生</dd></div>
       <div><dt>四权初值</dt><dd>使用 ✓ 提取 ✓ 导出 ✓ 模型外发 ✗（本期不可开启）</dd></div>
       <div><dt>项目边界</dt><dd>仅当前项目</dd></div>
     </dl>
     <label class="check-row"><input id="connect-consent" type="checkbox">我理解这是合成样板，并确认当前项目的授权范围（confirmScope）。</label>
     <p id="connect-error" class="form-error" role="alert"></p>`,
    b('取消', 'close') + b('建立连接', 'commit-connect', `data-source="${sourceId}"`, 'primary'),
  );
}

// ---------- 查询工作台 ----------
function currentParams() {
  if (qform.sourceId === 'wx-synthetic') {
    const cityIds = qform.cities === 'both' ? cities.map((c) => c.id) : ['shanghai'];
    return { cities: cityIds, start: qform.start, end: qform.end, timezone: 'Asia/Shanghai', variables: ['tempMeanC', 'precipSum'], scenario: SCENARIO_BODY[qform.scenario] };
  }
  return { brand: '青禾生活', platform: '演示平台', window: '2026-09' };
}

function daysBetween(start, end) {
  const out = [];
  for (let d = new Date(start + 'T00:00:00Z'), last = new Date(end + 'T00:00:00Z'); d <= last; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

function paramsStale() {
  const r = qform.lastRun?.run;
  if (!r) return false;
  const p = r.params;
  if (qform.sourceId === 'wx-synthetic') {
    const ids = (p.cities ?? []).map((c) => c.id).join(',');
    const cur = currentParams();
    return ids !== cur.cities.join(',') || p.start !== cur.start || p.end !== cur.end || JSON.stringify(p.scenario ?? {}) !== JSON.stringify(cur.scenario ?? {});
  }
  return false;
}

async function renderQuery() {
  catalog = catalog.length ? catalog : await get('/sources');
  const connectable = catalog.filter((x) => x.connectable);
  const entry = connectable.find((x) => x.id === qform.sourceId) ?? connectable[0];
  qform.sourceId = entry.id;
  const conns = await connectionsOf(entry.id);
  const conn = conns[0] ?? null;
  const running = qform.lastRun && ['查询中', '取消处理中'].includes(qform.lastRun.run.status) ? qform.lastRun : null;
  const isWeather = entry.id === 'wx-synthetic';
  const usable = conn && conn.status === '连接检查通过' && conn.grant.use && conn.grant.extract;
  const expected = isWeather ? daysBetween(qform.start, qform.end).length * (qform.cities === 'both' ? 2 : 1) : 6;
  // 请求上限 = 城市数 × 逻辑页数（REVIEW 收敛：分页演练时如实显示，GRILL 包 7 修订口径）
  const pagesPerCity = (SCENARIO_BODY[qform.scenario] ?? {}).pagesPerCity ?? 1;
  const maxRequests = isWeather ? (qform.cities === 'both' ? 2 : 1) * pagesPerCity : 0;

  $('#main').innerHTML = `
    ${head('查询工作台', '先确认范围与效果，再预览、检查和保存。外部边界为合成夹具。', b('查看运行记录', 'nav', 'data-path="runs"'))}
    ${steps(qform.lastRun ? 2 : usable ? 1 : 0)}
    <div class="work-layout"><section><div class="panel">
      <div class="section-head"><h2 style="margin:0">${isWeather ? '城市逐日天气' : '品牌聚合画像'}</h2>${badge('SYNTHETIC', 'good')}</div>
      <div class="form-grid">
        <div class="field wide"><label for="query-source">数据样板</label><select id="query-source">${connectable.map((x) => `<option value="${x.id}" ${qform.sourceId === x.id ? 'selected' : ''}>${e(x.name)}</option>`).join('')}</select></div>
        ${isWeather ? `
        <div class="field wide"><label for="query-cities">地域范围</label><select id="query-cities">
          <option value="both" ${qform.cities === 'both' ? 'selected' : ''}>上海 + 杭州 · 两城市（坐标已确认 WGS84）</option>
          <option value="shanghai" ${qform.cities === 'shanghai' ? 'selected' : ''}>上海 · 单城市</option></select></div>
        <div class="field"><label for="query-start">开始日期（本地日）</label><input id="query-start" type="date" min="2026-09-01" max="2026-09-07" value="${e(qform.start)}" aria-describedby="date-help"></div>
        <div class="field"><label for="query-end">结束日期（本地日）</label><input id="query-end" type="date" min="2026-09-01" max="2026-09-07" value="${e(qform.end)}" aria-describedby="date-help"></div>
        <p class="help field wide" id="date-help">样板支持 9 月 1—7 日。Asia/Shanghai · 日均气温 °C / 日降水 mm；不含真实天气。</p>
        <div class="field wide"><label for="query-scenario">返回情形 · 失败路径演示</label><select id="query-scenario">${SCENARIOS.map(([v, t]) => `<option value="${v}" ${qform.scenario === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>` : `
        <dl class="detail-grid field wide">
          <div><dt>品牌 / 平台</dt><dd>青禾生活（虚构） / 演示平台</dd></div>
          <div><dt>观察窗</dt><dd>2026-09</dd></div>
          <div><dt>目标总体 / 分母</dt><dd>演示期品牌互动人群 / 1,200（合成）</dd></div>
          <div><dt>样本与抑制</dt><dd>无真实抽样；小样本抑制为原型规则（演示阈值，非供应商承诺）</dd></div>
        </dl>`}
      </div>
      <div class="notice ${usable ? '' : 'warn'}" style="margin:18px 0 0">
        ${usable ? `连接检查通过（${e(conn.accountAlias)}）；数据完整性需查询后检查。数据验证：${e(conn.dataValidation)}。` : conn ? `连接尚未通过连接检查或授权不足。${b('去检查连接', 'nav', 'data-path="connections"', 'small')}` : `当前样板尚未建立连接。${b('配置连接', 'connect', `data-source="${entry.id}"`, 'small')}`}
      </div>
      <label class="check-row"><input id="query-grant" type="checkbox" ${qform.grant ? 'checked' : ''}>确认读取当前范围的合成样本；不外发模型、不请求真实服务。</label>
      <p id="query-error" class="form-error" role="alert"></p>
      <div class="query-actions">
        <span class="fine">预期 ${expected} ${isWeather ? '个城市日' : '个人群段'} · 最多请求 ${maxRequests} 次 · 费用：${e(COST_LABEL[entry.cost.knownness])}<br>真实供应商执行未准入；失败不推定未计费</span>
        <div class="actions">${running ? b('取消查询', 'cancel-run', `data-id="${running.run.id}"`) : ''}${b(running ? '查询中…' : '执行查询', 'run', `${!usable || running ? 'disabled' : ''}`, 'primary')}</div>
      </div>
    </div>
    <div id="result-area">${await renderResult()}</div></section>
    <aside>
      <div class="panel"><h2>本次范围与权限</h2><dl class="meta-list">
        <div><dt>项目</dt><dd>${PROJECT_NAME} · 本地独立工作区</dd></div>
        <div><dt>能力 / 参数</dt><dd>白名单：${conn ? conn.capabilities.map(e).join('、') : '无连接'}；范围以左侧参数为准</dd></div>
        <div><dt>模型外发</dt><dd>关闭。保存与交付不自动取得外发权。</dd></div>
        <div><dt>成本</dt><dd>合成样板无真实调用；供应商实际费用未知。</dd></div>
        <div><dt>后续真实准入</dt><dd>需明确许可、账户、端点与请求上限；不会从合成自动切换。</dd></div>
      </dl></div>
      <div class="panel"><h2>保存前检查什么</h2><ul class="row-list">
        <li>实际范围与期望覆盖是否一致</li><li>单位、时区、分母与样本能否解释</li><li>缺失、分页、时效与许可限制</li><li>可读内容与来源说明同时保存</li>
      </ul></div>
    </aside></div>`;
}

async function renderResult() {
  const cur = qform.lastRun;
  if (cur && ['查询中', '取消处理中'].includes(cur.run.status)) {
    return `<div class="panel"><div class="loading"><span class="spinner" aria-hidden="true"></span><div><h2 style="margin:0">${cur.run.status === '取消处理中' ? '取消处理中' : '查询中'}</h2><p class="fine">${cur.run.status === '取消处理中' ? '先停止新请求；能证实停下才称已取消，否则保留结果/费用未知。' : '查询执行中。可取消以查看取消/未知语义。'}</p></div></div></div>`;
  }
  if (!cur) {
    return '<div class="empty"><h2>预览与质量检查将在这里出现</h2><p>运行前先完成连接检查，并确认当前读取范围。</p></div>';
  }
  const { run, preview } = cur;
  if (!preview) {
    // 失败 / 阻断 / 未知 / 取消
    const cat = run.errorCategory ? (CATEGORY_LABEL[run.errorCategory] ?? run.errorCategory) : '';
    return `<div class="panel" data-run-id="${e(run.id)}">
      <div class="notice ${['结果未知'].includes(run.status) ? 'warn' : 'bad'}"><strong>${e(RUN_LABEL[run.status] ?? run.status)}${cat ? ` · ${e(cat)}` : ''}</strong><p>${e(run.errorMessage ?? '')}</p></div>
      <dl class="detail-grid">
        <div><dt>请求 / 页数</dt><dd>${run.requestCount} / ${run.pageCount}</dd></div>
        <div><dt>费用结论</dt><dd>${run.status === '未发送' ? '本地阻断 · 未发送' : '未知，不能按失败推定为 0'}</dd></div>
        ${run.retryAfterSeconds !== null ? `<div><dt>Retry-After</dt><dd>${run.retryAfterSeconds} 秒（演示值，非供应商实测）</dd></div>` : ''}
      </dl>
      <div class="actions">${b('查看运行记录', 'nav', 'data-path="runs"')}</div></div>`;
  }
  const stale = paramsStale();
  const q = run.quality;
  const restricted = q?.conclusion === 'partial' || (run.cacheAgeHours ?? 0) > 0;
  return `<div class="panel" data-run-id="${e(run.id)}">
    ${stale ? '<div class="notice warn">参数已变化。下方是旧范围结果；重新运行后才能按当前参数保存。已有快照保持原版本。</div>' : ''}
    <div class="section-head"><h2 style="margin:0">预览与检查</h2>${badge(RUN_LABEL[run.status] ?? run.status, runColor(run.status))}${run.saveStatus === '已保存' ? badge('已保存快照', 'good') : ''}</div>
    ${q?.conclusion === 'partial' ? `<div class="notice warn">实际 ${q.actualCount}/${q.expectedCount}，缺少 ${e(q.missingKeys.join('、'))}。没有把缺失填成 0。可显式保存受限快照。</div>` : ''}
    ${(run.cacheAgeHours ?? 0) > 0 ? `<div class="notice warn">命中过期缓存（年龄 ${run.cacheAgeHours} 小时）。可查看或保存历史材料，默认不能作为新鲜数据交付。</div>` : ''}
    ${q?.conclusion === 'complete' && !(run.cacheAgeHours > 0) ? '<div class="notice">合成样本通过本次范围检查。完整不代表供应商数据真实或可商用。</div>' : ''}
    <div class="metric-row">
      <div class="metric"><strong>${q ? `${q.actualCount} / ${q.expectedCount ?? '—'}` : '—'}</strong><span>${run.capabilityId === 'wx.daily' ? '城市日覆盖' : '人群段覆盖'}</span></div>
      <div class="metric"><strong>${run.requestCount} / ${run.pageCount}</strong><span>请求数 / 页数</span></div>
      <div class="metric"><strong>${(run.cacheAgeHours ?? 0) > 0 ? run.cacheAgeHours + 'h' : COST_LABEL[run.cost.knownness] ?? ''}</strong><span>${(run.cacheAgeHours ?? 0) > 0 ? '缓存年龄' : '费用已知性'}</span></div>
    </div>
    <div class="preview-tabs">
      <button class="btn small ${previewTab === 'table' ? 'active' : ''}" data-act="preview-tab" data-tab="table">表格预览</button>
      <button class="btn small ${previewTab === 'json' ? 'active' : ''}" data-act="preview-tab" data-tab="json">JSON 预览</button>
    </div>
    ${previewTab === 'json' ? `<pre>${e(JSON.stringify(preview.content, null, 2))}</pre>` : previewTable(preview.content)}
    <div class="check-list" style="margin-top:15px">
      ${[
        ['覆盖与分页', q ? `${q.actualCount}/${q.expectedCount ?? '—'}；${q.paginationComplete ? '分页结束' : '分页未结束'}` : '—', q && (!q.paginationComplete || q.missingKeys.length > 0)],
        [run.capabilityId === 'wx.daily' ? '单位与日界线' : '分母与人群口径', run.capabilityId === 'wx.daily' ? '°C / mm · Asia/Shanghai' : '1,200 合成 · 年龄段互斥', false],
        ['来源更新时间', 'unknown；采集时间单独记录', true],
        ['使用许可', '仅合成演示；不是供应商授权', false],
        ['时效', (run.cacheAgeHours ?? 0) > 0 ? `过期缓存 · ${run.cacheAgeHours}h · 仅历史材料` : '固定合成数据 · 无实时性声明', (run.cacheAgeHours ?? 0) > 0],
      ]
        .map(([l, v, w]) => `<div class="check-line"><strong>${l}</strong><span class="state-text ${w ? 'warn' : ''}">${e(v)}</span></div>`)
        .join('')}
    </div>
    <div class="query-actions"><span class="fine">采集时间 ${e(formatDate(run.updatedAtUtc))}<br>内容来源 synthetic · 未验证真实服务</span>
    <div class="actions">${run.saveStatus === '已保存' ? b('查看快照', 'nav', 'data-path="assets"', 'small') : ''}${b(run.saveStatus === '已保存' ? '再次保存（幂等）' : '保存数据快照', 'save', stale || !preview.content.rows.length ? 'disabled' : '', 'primary')}</div></div>
  </div>
  ${run.capabilityId === 'wx.daily' ? '<p class="footnote">与销量关联不证明因果。天气网格、门店映射、促销与节假日等需在分析中另外处理。</p>' : '<p class="footnote">年龄段占比可加总只是本样板设定，不推广到所有画像；兴趣标签类可重叠、不能相加。无真实个人级数据。</p>'}`;
}

function previewTable(content) {
  const fields = content.fields.map((f) => f.name);
  return `<div class="table-wrap"><table><caption>合成数据 · 全部 ${content.rows.length} 行 · 非供应商返回</caption>
    <thead><tr>${fields.map((f) => `<th>${e(f)}</th>`).join('')}</tr></thead>
    <tbody>${content.rows.map((r) => `<tr>${fields.map((f) => `<td>${r[f] === null ? '<span class="state-text warn">已抑制</span>' : e(r[f])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// ---------- 保存 ----------
async function saveDialog() {
  const cur = qform.lastRun;
  if (!cur || !cur.preview) return;
  const run = cur.run;
  const restricted = run.quality?.conclusion === 'partial' || (run.cacheAgeHours ?? 0) > 0;
  openDialog(
    '保存固定数据快照',
    `<p>内容、参数、来源、质量与限制一起保存；后续查询不会覆盖这个版本。快照不可原地编辑。</p>
     <div class="delivery-note" style="margin-top:16px">来源 synthetic · ${run.quality ? `${run.quality.actualCount}/${run.quality.expectedCount ?? '—'}` : '—'} · ${e(RUN_LABEL[run.status])}<br>供应商许可证：不适用此合成样本；不代表真实服务授权。</div>
     ${restricted ? `<label class="check-row"><input id="restricted-save" type="checkbox">我确认保存受限${run.quality?.conclusion === 'partial' ? '（部分）' : ''}${(run.cacheAgeHours ?? 0) > 0 ? '（过期缓存/历史材料）' : ''}快照，保留缺口；不把它当作完整新鲜数据。</label>` : ''}
     <p class="form-error" id="save-error" role="alert"></p>`,
    b('取消', 'close') + b('保存快照', 'commit-save', `data-id="${run.id}"`, 'primary'),
  );
}

// ---------- 数据资产 ----------
async function renderAssets() {
  const snaps = await get(`/snapshots?projectId=${PROJECT}`);
  const exports_ = await get(`/exports?projectId=${PROJECT}`);
  $('#main').innerHTML = `
    ${head('数据资产', '读取精确快照与限制；刷新另建运行，旧快照保持原身份。', b('去查询', 'nav', 'data-path="query"'))}
    <div class="notice">快照内容不可变、原子保存、读回校验。下载文件受「导出权 + 许可」双重检查；每次导出记入台账。</div>
    ${snaps.length ? `<div class="asset-list">${snaps
      .map((m) => {
        const id = m.identity.snapshotId;
        const q = m.quality;
        return `<article class="asset-item"><div>
        <div class="run-title"><h2>${e(id)}</h2>${badge(m.license.synthetic ? 'SYNTHETIC' : '真实来源', m.license.synthetic ? 'good' : '')}</div>
        <p>${e(m.source.sourceId)} · ${e(m.query.capabilityId)} · ${q ? `${q.actualCount}/${q.expectedCount ?? '—'} 条` : ''} · ${e(formatDate(m.identity.createdAtUtc))}</p>
        <div class="tags">${badge(q ? { complete: '完整', partial: '部分', warning: '有警告', unusable: '不可消费' }[q.conclusion] ?? q.conclusion : '—', q?.conclusion === 'complete' ? 'good' : 'warn')}${badge('模型外发关闭')}${m.coverage?.actual?.cacheAgeHours ? badge(`缓存 ${m.coverage.actual.cacheAgeHours}h · 历史材料`, 'warn') : ''}</div>
      </div>
      <div class="actions">${b('查看来源', 'snapshot', `data-id="${id}"`, 'small')}${b('下载 JSON', 'download', `data-id="${id}" data-format="json"`, 'small')}${m.query?.capabilityId === 'wx.daily' ? b('CSV', 'download', `data-id="${id}" data-format="csv"`, 'small') : ''}</div>
      </article>`;
      })
      .join('')}</div>` : `<div class="empty">${icon('asset')}<h2>还没有保存的数据快照</h2><p>从查询工作台完成一次预览和质量检查，确认后把内容与来源一起保存。</p>${b('开始天气样板', 'detail', 'data-id="wx-synthetic"', 'primary')}</div>`}
    ${exports_.length ? `<div class="panel" style="margin-top:22px"><h2>导出台账</h2><div class="table-wrap"><table><thead><tr><th>导出 ID</th><th>快照</th><th>格式</th><th>时间</th></tr></thead><tbody>${exports_.map((x) => `<tr><td class="mono">${e(x.id)}</td><td class="mono">${e(x.snapshotId)}</td><td>${e(x.format)}</td><td>${e(formatDate(x.createdAtUtc))}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <p class="footnote">CSV 是带快照 ID 的简表，完整来源、质量与限制请配套下载 JSON。R1 不实施 JuanerAI 项目交付回执（后续按现行插件合同接入）。</p>`;
}

async function snapshotDialog(id) {
  let back;
  try {
    back = await get(`/snapshots/${id}`);
  } catch (err) {
    openDialog('快照读回失败', `<div class="notice bad"><strong>读回拒绝</strong><p>${e(err.message)}</p></div><p class="fine">损坏或缺失的快照不回退到伪成功。</p>`, b('关闭', 'close', '', 'primary'));
    return;
  }
  const m = back.manifest;
  openDialog(
    '快照来源与限制',
    `<h3 class="mono" style="font-size:15px">${e(id)}</h3>
     <dl class="detail-grid" style="margin-top:18px">
       <div><dt>来源与接法</dt><dd>${e(m.source.providerName)} · ${e(m.source.protocol)} · ${e(m.source.adapterVersion ?? '—')}</dd></div>
       <div><dt>覆盖</dt><dd>${m.quality.actualCount}/${m.quality.expectedCount ?? '—'} · ${e(m.quality.conclusion)}</dd></div>
       <div><dt>单位 / 时区</dt><dd>${e(Object.entries(m.coverage.units ?? {}).map(([k, v]) => `${k}:${v}`).join('、') || '—')} · ${e(m.coverage.timezone ?? '—')}</dd></div>
       <div><dt>源更新时间</dt><dd>${e(m.time.sourceUpdatedAt)}（不能用采集时间替代）</dd></div>
       <div><dt>采集时间</dt><dd>${e(formatDate(m.time.collectedAtUtc))}</dd></div>
       <div><dt>请求 / 页数</dt><dd>${m.query.requestCount} / ${m.query.pageCount}</dd></div>
       <div><dt>许可</dt><dd>导出 ${m.license.exportAllowed ? '允许' : '未允许'} · 模型外发 ${m.license.modelAllowed ? '允许' : '未允许'}</dd></div>
       <div><dt>原响应保留</dt><dd>${m.rawRetained ? `是（${e(m.rawRetainedReason)}）` : `否（${e(m.rawRetainedReason)}）`}</dd></div>
     </dl>
     ${m.quality.missingKeys.length ? `<div class="notice warn">缺失：${e(m.quality.missingKeys.join('、'))}</div>` : ''}
     <p class="fine">文件清单与 SHA-256（读回校验依据）</p>
     <p class="mono" style="font-size:11px">${m.files.map((f) => `${e(f.path)} ${e(f.sha256.slice(0, 16))}… ${f.size}B`).join('<br>')}</p>
     <details><summary>查看固定参数与元数据</summary><pre>${e(JSON.stringify({ params: m.query.params, paramsFingerprint: m.query.paramsFingerprint, templateRevision: m.query.templateRevision, connectionRevision: m.query.connectionRevision, quality: m.quality }, null, 2))}</pre></details>`,
    b('关闭', 'close') + b('下载 JSON', 'download', `data-id="${id}" data-format="json"`, 'primary'),
  );
}

// ---------- 运行记录 ----------
async function renderRuns() {
  const runs = await get(`/runs?projectId=${PROJECT}`);
  $('#main').innerHTML = `
    ${head('运行记录', '连接检查、业务结果、保存和导出分别看；失败不等于供应商没有计费。')}
    <div class="notice">合成情形真实请求为 0；费用“未知”用于保持真实系统应有的边界。</div>
    ${runs.length ? `<div class="table-wrap"><table><caption>查询历史 · 不含真实调用或凭据</caption><thead><tr><th>运行 / 来源</th><th>时间</th><th>状态</th><th>错误类别</th><th>请求 / 页</th><th>产物</th><th>操作</th></tr></thead><tbody>${runs
      .map(
        (r) => `<tr><td class="wrap"><strong class="mono">${e(r.id)}</strong><br><span class="fine">${e(r.sourceId)} · ${e(r.capabilityId)} · 模板 ${e(r.templateRevision)} · 连接修订 ${r.connectionRevision}</span></td>
      <td>${e(formatDate(r.createdAtUtc))}</td>
      <td>${badge(RUN_LABEL[r.status] ?? r.status, runColor(r.status))}${(r.cacheAgeHours ?? 0) > 0 ? `<br><span class="fine">缓存 ${r.cacheAgeHours}h</span>` : ''}</td>
      <td>${r.errorCategory ? e(CATEGORY_LABEL[r.errorCategory] ?? r.errorCategory) : '—'}</td>
      <td>${r.requestCount} / ${r.pageCount}</td>
      <td>${r.snapshotId ? `<span class="mono fine">${e(r.snapshotId)}</span>` : r.saveStatus === '保存失败' ? '保存失败' : '无已保存快照'}</td>
      <td>${b('查看', 'run-detail', `data-id="${e(r.id)}"`, 'small')}</td></tr>`,
      )
      .join('')}</tbody></table></div>` : `<div class="empty"><h2>暂无运行</h2><p>先建立连接，再从查询工作台开始。</p>${b('去数据集市', 'nav', 'data-path="catalog"')}</div>`}`;
}

async function runDialog(id) {
  const { run } = await get(`/runs/${id}`);
  openDialog(
    '运行状态与追溯',
    `<div class="tags" style="margin-bottom:16px">${badge(RUN_LABEL[run.status] ?? run.status, runColor(run.status))}${badge('SYNTHETIC')}</div>
     ${run.errorMessage ? `<p>${e(run.errorMessage)}</p>` : ''}
     <dl class="detail-grid">
       <div><dt>运行</dt><dd class="mono">${e(run.id)}</dd></div>
       <div><dt>参数指纹</dt><dd class="mono">${e(run.paramsFingerprint.slice(0, 16))}…</dd></div>
       <div><dt>请求 / 页数</dt><dd>${run.requestCount} / ${run.pageCount}</dd></div>
       <div><dt>费用已知性</dt><dd>${e(COST_LABEL[run.cost.knownness] ?? run.cost.knownness)} · ${e(run.cost.note)}</dd></div>
       <div><dt>授权快照</dt><dd>使用${run.grantSnapshot.use ? '✓' : '✗'} 提取${run.grantSnapshot.extract ? '✓' : '✗'} 导出${run.grantSnapshot.export ? '✓' : '✗'} 外发✗</dd></div>
       ${run.retryAfterSeconds !== null ? `<div><dt>Retry-After</dt><dd>${run.retryAfterSeconds}s（演示值）</dd></div>` : ''}
       ${run.quality ? `<div><dt>质量</dt><dd>${run.quality.actualCount}/${run.quality.expectedCount ?? '—'} · ${e(run.quality.conclusion)} · 规则 ${e(run.quality.ruleVersion)}</dd></div>` : ''}
     </dl>
     <pre>${e(JSON.stringify({ params: run.params, missingKeys: run.quality?.missingKeys ?? [], status: run.status, saveStatus: run.saveStatus }, null, 2))}</pre>`,
    b('关闭', 'close', '', 'primary'),
  );
}

// ---------- 商业画像阻断演示 ----------
async function blockedDemo(sourceId) {
  try {
    await post('/connections', {
      projectId: PROJECT,
      sourceId,
      accountAlias: '演示账户',
      credentialRef: 'none',
      capabilities: [],
      grant: { use: true, extract: true, export: true, modelEgress: false },
      confirmScope: true,
    });
  } catch (err) {
    openDialog(
      '授权不足 · 已在本地阻断',
      `<div class="notice bad"><strong>未发送任何请求（请求数 0）</strong><p>${e(err.message)}</p></div>
       <p>没有已验证商业许可、导出接口或范围。阻断在本地准入阶段发生，未向供应商发送；不读取其他项目凭据。</p>
       <p class="fine">可切换到独立的合成画像样板感知流程（不同来源身份，不能互相替代）。</p>`,
      b('保留需求草稿', 'keep-draft', `data-source="${sourceId}"`) + b('打开独立合成样板', 'detail', `data-id="persona-synthetic"`, 'primary'),
    );
  }
}

// ---------- 添加来源 ----------
function addSourceDialog() {
  openDialog(
    '添加来源 · 研究草稿',
    `<p>首期只接受精选来源。此入口收集适配线索形成本地研究草稿：不安装 MCP，不执行粘贴的命令，不保存密钥。</p>
     <div class="field"><label for="source-name">来源名称</label><input id="source-name" placeholder="填写供应商或数据服务名称"></div>
     <div class="field" style="margin-top:16px"><label for="source-note">说明 / 官方公开文档链接</label><input id="source-note" placeholder="https://…"></div>
     <p class="help">草稿只写入本地 catalog-drafts，不出现在精选目录，也不可连接。</p>
     <p id="source-error" class="form-error" role="alert"></p>`,
    b('取消', 'close') + b('保存研究草稿', 'commit-draft', '', 'primary'),
  );
}

// ---------- 动作分发 ----------
async function refreshQueryResult() {
  const area = $('#result-area');
  if (area) area.innerHTML = await renderResult();
  const runBtn = $('[data-act="run"]');
  const cancelBtn = $('[data-act="cancel-run"]');
  if (runBtn && qform.lastRun && !['查询中', '取消处理中'].includes(qform.lastRun.run.status)) {
    runBtn.disabled = false;
    runBtn.textContent = '执行查询';
    if (cancelBtn) cancelBtn.remove();
  }
}

async function pollRun(runId) {
  clearTimeout(pollTimer);
  const tick = async () => {
    try {
      const data = await get(`/runs/${runId}`);
      qform.lastRun = data;
      if (['查询中', '取消处理中'].includes(data.run.status)) {
        await refreshQueryResult();
        pollTimer = setTimeout(tick, 300);
      } else {
        await render();
        toast('运行已结束：' + (RUN_LABEL[data.run.status] ?? data.run.status));
      }
    } catch (err) {
      toast('轮询失败：' + err.message);
    }
  };
  await tick();
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const a = el.dataset.act;
  const id = el.dataset.id;
  try {
    if (a === 'nav') go(el.dataset.path);
    else if (a === 'detail') {
      if ($('#dialog').open) closeDialog();
      go('detail/' + id);
    }
    else if (a === 'close') closeDialog();
    else if (a === 'category') {
      filter.category = el.dataset.cat;
      renderCatalog();
      $(`[data-cat="${el.dataset.cat}"]`)?.focus();
    } else if (a === 'clear-filters') {
      filter = { search: '', category: '全部', protocol: '全部接法' };
      renderCatalog();
    } else if (a === 'add-source') addSourceDialog();
    else if (a === 'commit-draft') {
      const name = $('#source-name').value.trim();
      if (!name) {
        $('#source-error').textContent = '请填写来源名称。';
        return;
      }
      await post('/source-drafts', { name, note: $('#source-note').value.trim() });
      closeDialog();
      toast('研究草稿已保存到本地 catalog-drafts（不进精选目录、不可连接）。');
    } else if (a === 'blocked') blockedDemo(el.dataset.source);
    else if (a === 'keep-draft') {
      await post('/source-drafts', { name: '商业画像接入需求', note: `来源 ${el.dataset.source}：授权不足阻断演示后保留的需求草稿。` });
      closeDialog();
      toast('需求草稿已保留。');
    } else if (a === 'connect') connectDialog(el.dataset.source);
    else if (a === 'commit-connect') {
      const sourceId = el.dataset.source;
      if (!$('#connect-consent').checked) {
        $('#connect-error').textContent = '请先确认授权范围。';
        return;
      }
      const s = catalog.find((x) => x.id === sourceId);
      await post('/connections', {
        projectId: PROJECT,
        sourceId,
        accountAlias: $('#conn-alias').value,
        credentialRef: $('#credential-ref').value,
        capabilities: s.capabilities.map((c) => c.id),
        grant: { use: true, extract: true, export: true, modelEgress: false },
        confirmScope: true,
      });
      closeDialog();
      toast('连接已建立（待连接检查）。');
      go('connections');
    } else if (a === 'check-conn') {
      await post(`/connections/${id}/check`);
      toast('连接检查通过（仅协议/鉴权，不保证数据范围）。');
      render();
    } else if (a === 'validate-conn') {
      const c = await post(`/connections/${id}/validate`);
      toast('数据验证：' + c.dataValidation);
      render();
    } else if (a === 'toggle-export') {
      const conns = await get(`/connections?projectId=${PROJECT}`);
      const c = conns.find((x) => x.id === id);
      await put(`/connections/${id}/grant`, { export: !c.grant.export });
      toast(c.grant.export ? '导出权已撤销：文件交付将被拒绝。' : '导出权已恢复。');
      render();
    } else if (a === 'toggle-use') {
      const conns = await get(`/connections?projectId=${PROJECT}`);
      const c = conns.find((x) => x.id === id);
      await put(`/connections/${id}/grant`, { use: !c.grant.use });
      toast(c.grant.use ? '使用权已撤销：新调用被阻断，历史保留。' : '使用权已恢复。');
      render();
    } else if (a === 'use-conn') {
      const conns = await get(`/connections?projectId=${PROJECT}`);
      const c = conns.find((x) => x.id === id);
      qform.sourceId = c.sourceId;
      go('query');
    } else if (a === 'preview-tab') {
      previewTab = el.dataset.tab;
      $('#result-area').innerHTML = await renderResult();
    } else if (a === 'run') {
      if (!$('#query-grant').checked) {
        $('#query-error').textContent = '请先确认当前合成读取范围。';
        $('#query-grant').focus();
        return;
      }
      const conns = await connectionsOf(qform.sourceId);
      const conn = conns[0];
      const capabilityId = qform.sourceId === 'wx-synthetic' ? 'wx.daily' : 'persona.ageBands';
      const run = await post('/runs', { projectId: PROJECT, connectionId: conn.id, capabilityId, params: currentParams() });
      qform.lastRun = { run, preview: null };
      document.body.dataset.lastRunId = run.id;
      if (run.status === '未发送') {
        await render();
        toast('已在本地阻断：' + (run.errorMessage ?? ''));
        return;
      }
      await render();
      pollRun(run.id);
    } else if (a === 'cancel-run') {
      await post(`/runs/${id}/cancel`);
      toast('取消请求已发出：先停止新请求。');
    } else if (a === 'save') saveDialog();
    else if (a === 'commit-save') {
      const cur = qform.lastRun;
      const run = cur.run;
      const restricted = run.quality?.conclusion === 'partial' || (run.cacheAgeHours ?? 0) > 0;
      if (restricted && !$('#restricted-save').checked) {
        $('#save-error').textContent = '受限结果需要明确确认，缺口会随快照保留。';
        return;
      }
      el.disabled = true;
      try {
        const manifest = await post(`/runs/${run.id}/save`, { paramsFingerprint: run.paramsFingerprint, acknowledgePartial: restricted });
        closeDialog();
        toast('快照已保存：' + manifest.identity.snapshotId);
        qform.lastRun = { run: { ...run, saveStatus: '已保存', snapshotId: manifest.identity.snapshotId }, preview: cur.preview };
        go('assets');
      } catch (err2) {
        el.disabled = false;
        $('#save-error').textContent = `${err2.message}（可重试保存，无需再次查询）`;
      }
    } else if (a === 'snapshot') snapshotDialog(id);
    else if (a === 'download') {
      const format = el.dataset.format;
      const res = await fetch(`/api/v1/snapshots/${id}/export?format=${format}&projectId=${PROJECT}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast(`导出被拒绝：${body?.error?.message ?? res.status}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${id}.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('已导出（记入台账）；合成数据，非真实供应商数据。');
      render();
    } else if (a === 'run-detail') runDialog(id);
  } catch (err) {
    toast(`操作失败：${err.message}`);
  }
});

// 表单变化（stale 判定）
document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.id === 'query-source') {
    qform.sourceId = t.value;
    qform.lastRun = null;
    await render();
  } else if (t.id === 'query-cities') {
    qform.cities = t.value;
    await render();
  } else if (t.id === 'query-start') {
    qform.start = t.value;
    await render();
  } else if (t.id === 'query-end') {
    qform.end = t.value;
    await render();
  } else if (t.id === 'query-scenario') {
    qform.scenario = t.value;
    await render();
  } else if (t.id === 'query-grant') {
    qform.grant = t.checked;
  } else if (t.id === 'source-search') {
    filter.search = t.value;
    renderCards();
  } else if (t.id === 'protocol-filter') {
    filter.protocol = t.value;
    renderCatalog();
  } else if (t.id === 'status-filter') {
    filter.status = t.value;
    renderCatalog();
  }
});
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'source-search') {
    filter.search = ev.target.value;
    renderCards();
  }
});

// 主题 / 导航 / 键盘
$('#theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('data-mcps-theme', cur);
  document.documentElement.dataset.theme = cur;
});
$('#menu').addEventListener('click', () => {
  $('#sidebar').classList.add('open');
  $('#overlay').hidden = false;
  $('#menu').setAttribute('aria-expanded', 'true');
});
$('#overlay').addEventListener('click', closeMenu);
$('#dialog').addEventListener('cancel', (ev) => {
  ev.preventDefault();
  closeDialog();
});
window.addEventListener('hashchange', () => render(true));

render(true);
