/* 产品浏览器验收：驱动真实本地服务（无 mock、无 localStorage 业务状态）。
 * 证据：evidence/browser-checks.json + evidence/screenshots/*.png
 * __BASE_URL__ / __SHOT_DIR__ 由 run_browser_check.py 注入。
 */
async (page) => {
  const base = '__BASE_URL__';
  const out = '__SHOT_DIR__';
  const checks = [], errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const act = (a) => page.locator(`[data-act="${a}"]`);
  const check = (ok, name) => { if (!ok) throw Error(name); checks.push(name); console.log('PASS ' + name); };
  const shot = (n) => page.screenshot({ path: `${out}/${n}.png`, fullPage: true });
  const apiGet = (p) => page.evaluate(async (p) => (await fetch('/api/v1' + p)).json(), p);
  const settle = async (prevRunId) => {
    await page.waitForFunction((prev) => (document.body.dataset.lastRunId ?? '') !== prev, prevRunId);
    const runId = await page.evaluate(() => document.body.dataset.lastRunId);
    await page.waitForFunction(async (rid) => {
      const data = await (await fetch('/api/v1/runs/' + rid)).json();
      return data?.run && !['查询中', '取消处理中'].includes(data.run.status);
    }, runId, { timeout: 30000, polling: 200 });
    await page.waitForFunction((rid) => {
      const el = document.querySelector(`[data-run-id="${rid}"]`);
      return el && /完整返回|部分返回|失败|结果未知|已取消|阻断/.test(el.textContent ?? '');
    }, runId, { timeout: 30000, polling: 200 });
  };
  const runQuery = async (scenario) => {
    await page.locator('#query-scenario').selectOption(scenario);
    const grant = page.locator('#query-grant');
    if (!(await grant.isChecked())) await grant.check();
    const prev = await page.evaluate(() => document.body.dataset.lastRunId ?? '');
    await act('run').click();
    await settle(prev);
  };
  try {
    await page.goto(base);
    await page.setViewportSize({ width: 1440, height: 1050 });

    // 1 集市
    check((await page.locator('.source-card').count()) === 8, 'catalog lists 8 curated entries');
    await page.locator('#source-search').fill('天气');
    await page.waitForFunction(() => document.querySelectorAll('.source-card').length === 4);
    check((await page.locator('.source-card').count()) === 4, 'search narrows to 4 weather entries');
    await page.locator('#source-search').fill('');
    await page.waitForFunction(() => document.querySelectorAll('.source-card').length === 8);
    await page.locator('[data-cat="金融商业"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.source-card').length === 2);
    check((await page.locator('.source-card').count()) === 2, 'category filter to finance');
    await page.locator('[data-cat="全部"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.source-card').length === 8);
    await page.locator('#status-filter').selectOption('适配待验证');
    await page.waitForFunction(() => document.querySelectorAll('.source-card').length === 6);
    check((await page.locator('.source-card').count()) === 6, 'access-status filter shows 6 pending entries');
    await page.locator('#status-filter').selectOption('全部状态');
    await page.waitForFunction(() => document.querySelectorAll('.source-card').length === 8);
    await shot('01-marketplace');

    // 2 天气连接（检查与验证分开）
    await page.locator('[data-act="detail"][data-id="wx-synthetic"]').first().click();
    await page.waitForFunction(() => document.querySelector('main')?.textContent.includes('示例结构'));
    check((await page.locator('main').textContent()).includes('daily.time'), 'detail page shows example structure');
    await act('connect').click();
    check(await page.evaluate(() => document.querySelector('dialog').contains(document.activeElement)), 'dialog focus management');
    await act('commit-connect').click();
    check((await page.locator('#connect-error').textContent()).includes('请先确认'), 'connection requires explicit scope confirmation');
    await page.locator('#connect-consent').check();
    await act('commit-connect').click();
    await page.waitForURL('**#connections');
    await act('check-conn').first().click();
    await page.waitForFunction(() => document.querySelector('main').textContent.includes('连接检查通过'));
    check((await page.locator('main').textContent()).includes('数据验证：未验证'), 'connection check does not claim data validation');
    await act('validate-conn').first().click();
    await page.waitForFunction(() => document.querySelector('main').textContent.includes('数据验证：通过'));

    // 3 查询 → 14/14 → 保存
    await act('use-conn').first().click();
    await page.waitForURL('**#query');
    await act('run').click();
    check((await page.locator('#query-error').textContent()).includes('请先确认'), 'query requires scope confirmation');
    await runQuery('success');
    let text = await page.locator('#result-area').textContent();
    globalThis.__lastText = text;
    check(text.includes('14 / 14'), 'complete weather 14/14');
    check(text.includes('演示无真实调用'), 'cost knownness shown as demo-no-call');
    await shot('02-weather-complete');
    await page.locator('[data-tab="json"]').click();
    check((await page.locator('#result-area pre').textContent()).includes('tempMeanC'), 'JSON preview shows normalized fields');
    await page.locator('[data-tab="table"]').click();
    await act('save').click();
    await act('commit-save').click();
    await page.waitForURL('**#assets');
    const snaps = await apiGet('/snapshots?projectId=default');
    check(snaps.length === 1 && /^snap_[0-9a-f]{16}$/.test(snaps[0].identity.snapshotId), 'snapshot saved with content-addressed id');
    const snapId = snaps[0].identity.snapshotId;

    // 4 资产：读回 + 导出
    await act('snapshot').first().click();
    await page.waitForFunction(() => document.querySelector('dialog')?.textContent.includes('快照来源与限制'));
    check((await page.locator('dialog').textContent()).includes('SHA-256'), 'manifest dialog shows file hashes');
    await act('close').first().click();
    const dl = page.waitForEvent('download');
    await page.locator(`[data-act="download"][data-format="json"]`).first().click();
    const download = await dl;
    check(download.suggestedFilename().endsWith('.json'), 'JSON export downloads');
    await shot('03-assets');

    // 5 改参 stale
    await page.locator('.nav-link[data-path="query"]').click();
    await page.locator('#query-cities').selectOption('shanghai');
    await page.waitForFunction(() => document.querySelector('#result-area')?.textContent.includes('参数已变化'));
    check(await act('save').isDisabled(), 'stale params disable saving old result');
    await page.locator('#query-cities').selectOption('both');

    // 6 部分结果
    await runQuery('partial');
    text = await page.locator('#result-area').textContent();
    check(text.includes('13/14') || text.includes('13 / 14'), 'partial 13/14 visible');
    check(text.includes('杭州|2026-09-03'), 'missing key listed, no zero-filling');
    await shot('04-partial');
    await act('save').click();
    await act('commit-save').click();
    check((await page.locator('#save-error').textContent()).includes('明确确认'), 'partial save requires acknowledgement');
    await page.locator('#restricted-save').check();
    await act('commit-save').click();
    await page.waitForURL('**#assets');
    check((await apiGet('/snapshots?projectId=default')).length === 2, 'restricted snapshot saved with gap');

    // 7 限流
    await page.locator('.nav-link[data-path="query"]').click();
    await runQuery('rate');
    text = await page.locator('#result-area').textContent();
    check(text.includes('频率限流'), 'rate limit classified');
    check(text.includes('60'), 'Retry-After evidence shown');
    check(text.includes('未知'), 'cost stays unknown after failure');
    await shot('05-rate-limit');

    // 8 取消与迟到
    await runQuery('late');
    await page.locator('#query-scenario').selectOption('late');
    if (!(await page.locator('#query-grant').isChecked())) await page.locator('#query-grant').check();
    const prevL = await page.evaluate(() => document.body.dataset.lastRunId ?? '');
    await act('run').click();
    await page.waitForFunction((prev) => (document.body.dataset.lastRunId ?? '') !== prev, prevL);
    await page.waitForFunction(() => document.querySelector('#result-area')?.textContent.includes('查询中'));
    await act('cancel-run').click();
    await settle(prevL);
    text = await page.locator('#result-area').textContent();
    check(text.includes('结果未知') || text.includes('已取消'), 'cancel path yields cancelled or unknown');
    await shot('06-cancel');

    // 9 商业画像阻断
    await page.locator('.nav-link[data-path="catalog"]').click();
    await page.locator('[data-act="detail"][data-id="questmobile-truth"]').first().click();
    await act('blocked').click();
    await page.waitForFunction(() => document.querySelector('dialog')?.textContent.includes('授权不足'));
    check((await page.locator('dialog').textContent()).includes('未发送任何请求'), 'commercial portrait blocked pre-send');
    await shot('07-portrait-blocked');
    await act('detail').click(); // 打开独立合成样板
    await page.waitForURL('**#detail/persona-synthetic');

    // 10 画像管道
    await act('connect').click();
    await page.locator('#connect-consent').check();
    await act('commit-connect').click();
    await page.waitForURL('**#connections');
    await act('check-conn').last().click();
    await page.waitForFunction(() => document.querySelectorAll('main tbody tr').length === 2 && document.querySelector('main').textContent.includes('合成画像'));
    await page.waitForFunction(() => document.querySelectorAll('main tbody tr')[1].textContent.includes('连接检查通过'));
    await act('use-conn').last().click();
    await page.waitForURL('**#query');
    if (!(await page.locator('#query-grant').isChecked())) await page.locator('#query-grant').check();
    const prevP = await page.evaluate(() => document.body.dataset.lastRunId ?? '');
    await act('run').click();
    await settle(prevP);
    text = await page.locator('#result-area').textContent();
    check(text.includes('1,200'), 'persona denominator visible');
    check(text.includes('已抑制'), 'suppression shown');
    await shot('08-persona');
    await act('save').click();
    await act('commit-save').click();
    await page.waitForURL('**#assets');

    // 11 运行记录 + 暗色 + 移动
    await page.locator('.nav-link[data-path="runs"]').click();
    await page.waitForFunction(() => document.querySelector('main')?.textContent.includes('运行记录') && document.querySelector('main')?.querySelector('table'));
    text = await page.locator('main').textContent();
    check(text.includes('rate_limited') || text.includes('频率限流'), 'runs page shows error categories');
    await shot('09-runs');
    await page.locator('#theme').click();
    await shot('10-runs-dark');
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ['catalog', 'connections', 'query', 'assets', 'runs']) {
      await page.goto(base + '#' + path);
      await page.waitForTimeout(300);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '390px ' + path + ' no page-level overflow');
    }
    await shot('11-mobile-dark');

    check(errors.length === 0, 'no uncaught page errors: ' + errors.join(';'));
    const result = { passed: checks.length, failed: 0, checks, errors, finishedAt: new Date().toISOString() };
    console.log('DATA_MCPS_CHECKS=' + JSON.stringify(result));
    return result;
  } catch (err) {
    await page.screenshot({ path: `${out}/failure.png`, fullPage: true });
    const areaText = await page.locator('#result-area').textContent().catch(() => '(no result-area)');
    const result = { passed: checks.length, failed: 1, checks, errors, error: err.message, lastText: (globalThis.__lastText ?? '').slice(0, 300), resultArea: (areaText ?? '').slice(0, 500) };
    console.log('DATA_MCPS_CHECKS=' + JSON.stringify(result));
    return result;
  }
}
