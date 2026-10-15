import { existsSync } from 'node:fs';

import { chromium } from 'playwright';

const baseUrl = new URL(process.argv[2] ?? process.env.DSH_FREEROUTING_HOST_URL ?? 'http://127.0.0.1:3180');
const sessionTitle = process.argv[3] ?? process.env.DSH_FREEROUTING_SESSION_TITLE;
const expectedCard = process.argv[4] ?? process.env.DSH_FREEROUTING_EXPECTED_CARD;
const expectedCallId = process.argv[5] ?? process.env.DSH_FREEROUTING_EXPECTED_CALL_ID;
const expectedState = process.argv[6] ?? process.env.DSH_FREEROUTING_EXPECTED_STATE;
const edgeCandidates =
  process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : [];
const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? edgeCandidates.find((candidate) => existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  ...(executablePath === undefined ? {} : { executablePath }),
});
const errors = [];

try {
  const context = await browser.newContext({ viewport: { height: 800, width: 1280 } });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    errors.push(`page: ${error.message}`);
  });

  const response = await page.goto(baseUrl.toString(), {
    timeout: 30_000,
    waitUntil: 'domcontentloaded',
  });
  if (response === null || !response.ok()) {
    throw new Error(`Web root returned ${response?.status() ?? 'no response'}`);
  }
  await page.locator('body').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(1_500);

  const boot = await page.evaluate(() => window.__DSH_BOOT__);
  if (typeof boot !== 'object' || boot === null || !Array.isArray(boot.entries)) {
    throw new Error('window.__DSH_BOOT__ is missing or malformed');
  }
  const plugin = boot.entries.find((entry) =>
    ['@huaqiu/dsh-tool-freerouting', 'huaqiu-dsh-tool-freerouting'].includes(entry?.id),
  );
  if (plugin === undefined || typeof plugin.url !== 'string') {
    const ids = boot.entries.map((entry) => entry?.id).filter(Boolean);
    throw new Error(`@huaqiu/dsh-tool-freerouting is absent from the Web boot graph; entries: ${ids.join(', ')}`);
  }

  const bundleResponse = await context.request.get(new URL(plugin.url, baseUrl).toString());
  if (!bundleResponse.ok()) {
    throw new Error(`Plugin client bundle returned ${bundleResponse.status()}`);
  }
  const bundle = await bundleResponse.text();
  for (const marker of ['pcb_route', 'pcb_route_nets']) {
    if (!bundle.includes(marker)) {
      throw new Error(`Plugin client bundle is missing ${marker}`);
    }
  }

  if (sessionTitle !== undefined) {
    const welcome = page.getByRole('dialog', { name: '内测声明' });
    if ((await welcome.count()) > 0) {
      await welcome.getByRole('button', { name: '继续' }).click();
    }
    const credentialStep = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' });
    if ((await credentialStep.count()) > 0) {
      await credentialStep.getByLabel('API 密钥', { exact: true }).fill('dsh-host-smoke-key');
      await credentialStep.getByRole('button', { name: '保存并继续' }).click();
      await credentialStep.waitFor({ state: 'detached', timeout: 15_000 });
    }
    const blockingDialogs = await page.locator('[role="dialog"]').allTextContents();
    if (blockingDialogs.length > 0) {
      throw new Error(`DSH startup is blocked by a dialog: ${blockingDialogs.join(' | ')}`);
    }
    const firstTreeRow = page.locator('[role="treeitem"]').first();
    await firstTreeRow.waitFor({ state: 'visible', timeout: 15_000 });
    for (let remaining = 20; remaining > 0; remaining -= 1) {
      const collapsedGroup = page.locator('[role="treeitem"][aria-expanded="false"]').first();
      if ((await collapsedGroup.count()) === 0) {
        break;
      }
      await collapsedGroup.click();
    }
    const sessionRow = page.getByRole('treeitem').filter({ hasText: sessionTitle }).first();
    await sessionRow.waitFor({ state: 'visible', timeout: 15_000 });
    await sessionRow.click();
    if (expectedCard !== undefined) {
      try {
        const card = page.locator('[data-pcb-freerouting-dock] section[aria-label]').filter({ hasText: expectedCard });
        await card.waitFor({ state: 'visible', timeout: 20_000 });
        if (expectedState === 'expired') {
          await card
            .getByRole('alert')
            .filter({ hasText: '该任务已失效，请重新发起布线任务' })
            .waitFor({ state: 'visible', timeout: 20_000 });
          const display = await card.evaluate((element) => getComputedStyle(element).display);
          if (display !== 'grid') {
            throw new Error(`Expected attached card layout, received display: ${display}`);
          }
        }
      } catch (cause) {
        const callRows = await page.locator('[data-chat-call-id]').evaluateAll((rows) =>
          rows.slice(-8).map((row) => ({
            callId: row.getAttribute('data-chat-call-id'),
            text: row.textContent?.trim().slice(0, 300),
          })),
        );
        const matchingCall =
          expectedCallId === undefined ? undefined : callRows.find((row) => row.callId === expectedCallId);
        throw new Error(
          `Expected card ${expectedCard} did not render; matching call: ${JSON.stringify(matchingCall)}; recent calls: ${JSON.stringify(callRows)}; browser errors: ${errors.join(' | ')}`,
          { cause },
        );
      }
    }
  }
  const unexpectedErrors =
    expectedCallId === undefined && expectedState !== 'expired'
      ? errors
      : errors.filter((message) => !message.includes('401 (Unauthorized)'));
  if (unexpectedErrors.length > 0) {
    throw new Error(`Browser startup errors:\n${unexpectedErrors.join('\n')}`);
  }

  console.log(
    JSON.stringify(
      {
        baseUrl: baseUrl.origin,
        browser: executablePath ?? 'playwright-managed chromium',
        expectedReplayAuthorizationErrors: errors.length - unexpectedErrors.length,
        expectedState,
        ok: true,
        pluginClientUrl: plugin.url,
        sessionCard: expectedCard,
        title: await page.title(),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
