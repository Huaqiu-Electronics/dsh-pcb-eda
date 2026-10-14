import { useEffect, useState, useRef } from 'react';
import { active, type RunStatus } from './model.js';

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** Local clock and plugin observations only; this view never asks the agent to poll. */
export function ProcessPanel({ status, readError }: { status: RunStatus; readError: boolean }) {
  const [now, setNow] = useState(Date.now);
  const running = active(status);
  const process = status.process;
  const list = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  useEffect(() => {
    if (!running || !process) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, !!process]);
  const lastEvent = process?.events.at(-1);
  useEffect(() => {
    if (following.current && list.current) {
      list.current.scrollTop = list.current.scrollHeight;
    }
  }, [lastEvent?.at, lastEvent?.text]);
  if (!process) {
    return null;
  }
  const clock = running ? now : Date.parse(process.updated_at);
  const stale = running && clock - Date.parse(process.updated_at) >= 60_000;
  return (
    <section className="fr-process" aria-label="布线过程记录">
      <strong>布线过程</strong>
      <p>
        第 {process.round} 轮{status.created_at ? ` · 已用时 ${duration(clock - Date.parse(status.created_at))}` : ''}
        {running ? ` · 当前阶段已用时 ${duration(clock - Date.parse(process.stage_started_at))}` : ''}
      </p>
      {process.preview && (
        <p>
          KiCad 当前显示过程走线 {process.preview.tracks} 段、过孔 {process.preview.vias}{' '}
          个；仍会调整，尚未完成最终检查。
        </p>
      )}
      {running && process.remaining_connections !== undefined && (
        <p>引擎报告剩余 {process.remaining_connections} 个连接待处理；最终接通情况仍需检查。</p>
      )}
      {stale && !readError && (
        <p className="fr-wait">
          最近 {duration(clock - Date.parse(process.updated_at))} 没有新的阶段或数量变化；当前仍在“
          {status.progress?.state ?? '等待任务状态'}”。
          {process.engine_updated_at &&
            `最后收到引擎状态：${new Date(process.engine_updated_at).toLocaleTimeString('zh-CN', { hour12: false })}。`}
          这不代表布线已完成，也不能据此确认任务卡住。
        </p>
      )}
      <ol
        ref={list}
        tabIndex={0}
        aria-label="布线步骤"
        onScroll={() => {
          const element = list.current;
          if (element) {
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          }
        }}
      >
        {process.events.map((event, index) => (
          <li key={`${event.at}-${index}`}>
            <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
            {' · '}
            {event.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
