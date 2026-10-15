import type { IpcRun } from '../ipc/session.js';
import type { FreeroutingClient } from '../proxy/freerouting-client.js';
import { UpstreamServiceError } from '../proxy/upstream-errors.js';
import type { RunRecord, RunOutput, RoutingResult } from './contracts.js';
import type { RunStore } from './run-store.js';
import type { FreeroutingLauncher } from './launcher.js';
import { parseDsnNetNames, parseDsnNetPinCounts } from './statistics.js';
import { designWarning, type DesignReport } from './design-report.js';
import { createPreviewReader } from './preview.js';
import { routeWithEditorPreview } from './editor-preview.js';
import { type ProcessRecorder, checkResultText } from './process-recorder.js';
import { RepairNeeded, type RepairPlan } from './repair-plan.js';

/** One routing attempt. The task owner retains cancellation and repair scheduling. */
export class RoutingRound {
  constructor(
    private readonly runs: RunStore,
    private readonly freerouting: FreeroutingClient,
    private readonly launcher?: FreeroutingLauncher,
  ) {}
  async execute(
    run: RunRecord,
    session: IpcRun,
    signal: AbortSignal,
    process: ProcessRecorder,
    repair?: RepairPlan,
  ): Promise<RunOutput> {
    const started = Date.now();
    const requested = run.parameters;
    const record = (message: string) => process.note(message);
    const round = repair ? 2 : 1;
    process.round(round);
    this.runs.setPreview(run.id, round, 'waiting');
    process.diagnose(`已固定目标板子：${session.target.boardPath}`);
    process.stage(
      repair
        ? '正在尝试补充铜文字避让范围；只重新布线一次，不修改原板文字或元件'
        : '正在读取当前板子，准备布线要求和原有铜的保留约束',
    );
    const dsn = repair
      ? await session.repairDsn(repair.avoidObjectIds, signal, record)
      : await session.exportDsn(signal, record);
    let readPreview: ReturnType<typeof createPreviewReader> | undefined;
    try {
      readPreview = createPreviewReader(dsn.toString('utf8'));
    } catch {
      this.runs.setPreview(run.id, round, 'unavailable');
    }
    let lastPreview = '';
    const publishPreview = (sesBase64: string, final = false) => {
      if (!readPreview || signal.aborted || (!final && sesBase64 === lastPreview)) {
        return;
      }
      lastPreview = sesBase64;
      try {
        if (sesBase64.length > 2_800_000) {
          throw new Error('Preview too large');
        }
        const scene = readPreview(Buffer.from(sesBase64, 'base64').toString('utf8'));
        this.runs.setPreview(run.id, round, 'ready', scene, final);
      } catch {
        this.runs.setPreview(run.id, round, 'unavailable', undefined, final);
      }
    };
    const names = parseDsnNetNames(dsn.toString('utf8'));
    const pins = parseDsnNetPinCounts(dsn.toString('utf8'));
    const scope = requested.routeOnlyNets.length ? requested.routeOnlyNets : names;
    for (const name of [...scope, ...requested.skipNets]) {
      if (!names.includes(name)) {
        throw new UpstreamServiceError('UNKNOWN_NET', 400, `未知网络：${name}`);
      }
    }
    const targetNets = scope.filter((name) => !requested.skipNets.includes(name) && (pins.get(name) ?? 2) > 1);
    if (!targetNets.length) {
      throw new UpstreamServiceError('NO_TARGET_NETS', 400, '没有需要布线的目标网络');
    }
    record(
      `本次处理 ${targetNets.length} 个需要连接的网络；${requested.skipNets.length ? `按要求跳过 ${requested.skipNets.length} 个网络` : '没有指定跳过网络'}；原有走线和过孔保留`,
    );
    record(
      requested.fast ? '使用快速模式，优先尽快获得布线结果' : '使用质量模式，布线引擎会花更多时间寻找和优化连接路径',
    );
    process.stage('正在准备布线引擎');
    await this.launcher?.ensureUp((message) => process.diagnose(message), signal);
    process.stage(`第 ${round} 轮：正在开始布线计算`);
    if (requested.realtime) {
      record('布线过程会显示在 KiCad 中；请先不要编辑或保存板子，结果仍会变化');
    }
    const outcome = await routeWithEditorPreview(
      this.freerouting,
      dsn,
      {
        ...requested,
        routeOnlyNets: targetNets,
        requireNetFilter: requested.routeOnlyNets.length > 0 || requested.skipNets.length > 0,
      },
      {
        ...(readPreview ? { onIntermediate: (sesBase64: string) => publishPreview(sesBase64) } : {}),
        onProgress: (progress) => process.progress(progress),
      },
      session,
      signal,
      (message) => process.diagnose(message),
      (ses) =>
        this.runs.retain(run.id, {
          content: new Uint8Array(ses),
          filename: 'board.ses',
          contentType: 'text/plain; charset=utf-8',
        }),
      (counts) => process.preview(counts),
    );
    publishPreview(outcome.sesBase64, true);
    const ses = Buffer.from(outcome.sesBase64, 'base64');
    this.runs.retain(run.id, {
      content: new Uint8Array(ses),
      filename: 'board.ses',
      contentType: 'text/plain; charset=utf-8',
    });
    signal.throwIfAborted();
    process.stage('正在检查新增走线：短路、铜间距、线宽、过孔尺寸和板边距离等规则；尚未添加最终结果');
    const report = await session.reviewSession(ses, targetNets, signal);
    await this.retainReport(run, session, report);
    record(checkResultText(report));
    signal.throwIfAborted();
    if (report.count && !repair) {
      throw new RepairNeeded(report);
    }
    if (report.count) {
      record('重新布线后仍有上述规则问题，按已授权的约定保留结果并列出冲突；检查未全部通过，不再自动重布');
    }
    process.stage('正在核对板子是否发生变化，并添加最终走线和过孔；请等待添加完成');
    const imported = await session.importSession(ses, targetNets, signal, !!repair);
    this.runs.previewImported(run.id);
    run.designReport = imported.designReport;
    try {
      await this.retainReport(run, session, imported.designReport);
    } catch {
      record('布线已添加，但最新检查报告未能保留；请在 KiCad 中重新检查，之前的报告仍可查看');
    }
    record(
      imported.outcome === 'unchanged'
        ? '本次没有新增走线或过孔，原有走线和过孔保留'
        : `已添加到板子：新增走线 ${imported.tracks} 段，过孔 ${imported.vias} 个；请手动保存板子`,
    );
    const warnings: string[] = [];
    if (imported.displayWarning) {
      warnings.push(imported.displayWarning);
    }
    const ruleWarning = designWarning(imported.designReport);
    if (ruleWarning) {
      warnings.unshift(ruleWarning);
    }
    if (requested.skipNets.length) {
      warnings.push(`本次按要求跳过的网络仍需处理：${requested.skipNets.join(', ')}`);
    }
    let zonesFilled: number | undefined;
    let zoneFill: RoutingResult['zoneFill'] = 'not_requested';
    if (signal.aborted) {
      zoneFill = 'cancelled';
      warnings.push('取消时新走线已添加到板子，已保留；后续铺铜已取消');
    } else if (requested.fillZonesAfterRoute) {
      process.stage('最终走线已添加，正在填充已有铺铜区域');
      try {
        const filled = await session.fillZones();
        zonesFilled = filled.zonesFilled;
        zoneFill = filled.skipped ? 'skipped' : 'completed';
        if (filled.skipped) {
          warnings.push('板子上没有已设置的铺铜区域，本次已跳过铺铜');
        } else {
          record(`已填充已有铺铜区域 ${filled.zonesFilled} 个；铺铜是独立步骤`);
        }
      } catch {
        zoneFill = 'failed';
        warnings.push('新走线已添加到板子，但铺铜未完成；请在 KiCad 中手动填充铺铜区域');
      }
      if (signal.aborted) {
        warnings.push('已收到取消请求，新增走线已保留；请检查铺铜是否完成');
      }
    }
    if (zoneFill === 'not_requested') {
      record('本次未要求填充铺铜区域，已跳过铺铜步骤');
    }
    for (const warning of warnings) {
      record(warning);
    }
    return {
      content: run.artifact?.content ?? new Uint8Array(ses),
      filename: 'board.ses',
      contentType: 'text/plain; charset=utf-8',
      routing: {
        designReport: imported.designReport,
        repairAttempts: repair ? 1 : 0,
        imported: true,
        zoneFill,
        tracks: imported.tracks,
        vias: imported.vias,
        netCount: targetNets.length,
        durationMs: Date.now() - started,
        warning: warnings.join('；'),
        ...(zonesFilled === undefined ? {} : { zonesFilled }),
        ...(outcome.statistics === undefined ? {} : { statistics: outcome.statistics }),
      },
    };
  }
  private async retainReport(run: RunRecord, session: IpcRun, report: DesignReport): Promise<void> {
    run.designReport = report;
    const content = await session.designReportArtifact();
    this.runs.retainReport(
      run.id,
      content ? { content, contentType: 'application/json', filename: 'board-rule-report.json' } : undefined,
    );
  }
}
