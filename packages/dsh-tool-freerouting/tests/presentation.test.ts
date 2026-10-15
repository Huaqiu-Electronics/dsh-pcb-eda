import { expect, it } from 'vitest';
import { routingErrorText, routingRunText } from '../src/presentation/routing-copy.js';
import { explainToolFailure, render } from '../src/tools/presentation.js';
import { UpstreamServiceError } from '../src/proxy/upstream-errors.js';

it('generates tool failure copy from error type without echoing raw diagnostics or guessing a rule', async () => {
  const cause = new UpstreamServiceError('KICAD_UNAVAILABLE', 409, 'IPC helper Python HTTP 409 DSN SES');
  try {
    await explainToolFailure(async () => {
      throw cause;
    });
    throw new Error('Expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBe(cause);
    expect((error as Error).message).toContain('暂时连不上当前 KiCad 板子');
    expect((error as Error).message).not.toContain('Python');
  }
  const diagnostic = { code: 'DESIGN_RULE_VIOLATION', message: 'clearance shorting_items' };
  const plain = routingErrorText(diagnostic);
  expect(plain).toBe(routingErrorText({ code: 'DESIGN_RULE_VIOLATION' }));
  expect(plain).not.toContain('布线结果存在短路');
  expect(plain).not.toContain('新走线与其他铜的间距不符合要求');
});

it('keeps uncertain and unknown outcomes cautious and preserves duplicate-task identity', async () => {
  for (const code of ['IMPORT_UNCERTAIN', 'future-error']) {
    const message = routingErrorText({ code });
    expect(message).not.toContain('板子未改变');
    expect(message).not.toContain('尚未添加到板子');
    expect(message).toContain('检查');
  }
  await expect(
    explainToolFailure(async () => {
      throw new UpstreamServiceError('BOARD_RUN_ACTIVE', 409, '已有任务 existing-run');
    }),
  ).rejects.toThrow('existing-run');
});

it('renders confirmed success with controls available but without tokens and transport metadata', () => {
  const message = routingRunText({
    state: 'partial',
    summary: { imported: true, tracks: 3, vias: 1, warning: '布线已添加，但仍有走线间距问题' },
  });
  const result = render(
    {},
    {
      user_message: message,
      run_id: 'continue-this-run',
      state: 'partial',
      capability_token: 'secret',
      status_endpoint: '/software/status',
      expires_at: 'expiry',
      schema_version: 1,
    },
  );
  const text = result[0]!.text;
  expect(text).toContain('continue-this-run');
  expect(text).toContain('新增走线 3 段、过孔 1 个');
  expect(text).toContain('文件未自动保存');
  expect(text).toContain('尚未确认是否所有网络都已接通');
  expect(text).not.toContain('secret');
  expect(text).not.toContain('status_endpoint');
});

it('explains enabled teardrops before routing without software diagnostics', () => {
  const message = routingErrorText({ code: 'AUTO_TEARDROPS_UNSUPPORTED' });
  expect(message).toContain('自动泪滴补铜');
  expect(message).toContain('本次没有把新走线添加到板子');
  expect(message).not.toContain('AUTO_TEARDROPS_UNSUPPORTED');
  expect(message).not.toContain('IPC');
});
