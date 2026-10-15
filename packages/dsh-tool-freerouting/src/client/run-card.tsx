import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import { active, capabilitySchema, stateLabels, type Capability } from './model.js';
import { useRunStatus } from './use-run-status.js';
import { useRunDownload } from './use-run-download.js';
import cardStyles from './routing-card.css?inline';
import { routingRunText, ruleProblemText } from '../presentation/routing-copy.js';
import { ProcessPanel } from './process-panel.js';

function RunCard({ capability }: { capability: Capability }) {
  const { status, error, retryStatus } = useRunStatus(capability);
  const { downloading, downloadError, save } = useRunDownload(capability);
  const running = status === undefined || active(status);
  const uncertain = status?.error?.code === 'IMPORT_UNCERTAIN';
  const label = uncertain
    ? '请检查板子状态'
    : status
      ? stateLabels[status.state]
      : error
        ? '暂时无法查看进度'
        : '正在读取任务';
  const percentage = status?.progress?.percentage;
  const progress = percentage === undefined ? undefined : Math.max(0, Math.min(100, percentage));
  return (
    <section data-freerouting-card="true" aria-label="PCB 自动布线任务" aria-busy={running && !error}>
      <header>
        <strong>PCB 自动布线</strong>
        <span role="status" aria-atomic="true">
          {label}
        </span>
      </header>
      {running && (
        <p className="fr-stage">
          {status?.progress?.state ?? '等待任务状态'}
          {progress !== undefined ? ` · ${Math.round(progress)}%` : ''}
        </p>
      )}
      {running && !error && <progress aria-label="布线进度" max={100} value={progress} />}
      {status && <ProcessPanel status={status} readError={!!error} />}
      {status?.state === 'repair_pending' && <p>{status.user_message ?? routingRunText(status)}</p>}
      {status?.summary?.imported && <p>{status.user_message ?? routingRunText(status)}</p>}
      {!!status?.design_report?.count && (
        <details open>
          <summary>具体冲突（{status.design_report.count} 项）</summary>
          <ol>
            {status.design_report.violations.map((issue, index) => (
              <li key={index}>
                <p>{ruleProblemText(issue.type)}</p>
                {issue.items.map((item, itemIndex) => (
                  <p key={itemIndex}>
                    {item.label ?? '冲突对象'} · 位置 X {item.x.toFixed(3)} mm，Y {item.y.toFixed(3)} mm
                  </p>
                ))}
                <details>
                  <summary>查看 KiCad 原始检查说明</summary>
                  <p>{issue.description}</p>
                  {issue.items.map((item, itemIndex) => (
                    <p key={itemIndex}>{item.description}</p>
                  ))}
                </details>
              </li>
            ))}
          </ol>
          {status.design_report.truncated && <p>这里只显示前 100 项，其余问题请下载完整检查报告查看。</p>}
        </details>
      )}
      {status?.state === 'running' && status.preview?.imported && (
        <p>布线已添加到板子，正在完成后续处理。文件未自动保存。</p>
      )}
      {status?.error && <p className="fr-warning">{status.user_message ?? routingRunText(status)}</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={retryStatus}>
            重新读取状态
          </button>
        </div>
      )}
      {downloadError && <p role="alert">{downloadError}</p>}
      <details>
        <summary>诊断详情</summary>
        <p>任务编号：{capability.runId}</p>
        {status?.error && (
          <p>
            错误代码：{status.error.code}
            <br />
            {status.error.message}
          </p>
        )}
        {status?.log?.length ? (
          <ol>
            {status.log.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ol>
        ) : null}
      </details>
      <footer>
        {status?.report_name && (
          <button
            type="button"
            disabled={downloading}
            onClick={() => {
              void save('report');
            }}
          >
            下载检查报告
          </button>
        )}
        {status?.output_name && (
          <button
            type="button"
            disabled={downloading}
            onClick={() => {
              void save();
            }}
          >
            {downloading ? '正在下载…' : '下载布线结果'}
          </button>
        )}
      </footer>
    </section>
  );
}

/** Own the two routing tool rows through DSH's existing keyed tool-view slot. */
export function RoutingToolView({ block, toolName }: ToolCallViewProps) {
  const settled = 'kind' in block;
  const parsed = capabilitySchema.safeParse(settled ? block.meta : undefined);
  if (!parsed.success) {
    const text = settled
      ? block.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n')
      : '正在连接目标 KiCad 板子…';
    return (
      <div data-freerouting-card="true">
        <style>{cardStyles}</style>
        <strong>{toolName === 'pcb_route_nets' ? '指定网络自动布线' : 'PCB 自动布线'}</strong>
        <p role={settled && block.isError ? 'alert' : 'status'}>{text}</p>
      </div>
    );
  }
  return (
    <>
      <style>{cardStyles}</style>
      <RunCard key={parsed.data.runId} capability={parsed.data} />
    </>
  );
}
