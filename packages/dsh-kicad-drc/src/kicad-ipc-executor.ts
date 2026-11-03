/**
 * KiCad IPC 后端：让正在运行的 KiCad 执行 DRC，并把结构化结果取回来。
 *
 * 为什么用 IPC 而不是再起一个 kicad-cli：
 *   - 板子已经在 KiCad 进程里加载好了，不用重新解析文件；
 *   - 直接作用于**内存中的板**（含未保存修改），不需要先存盘；
 *   - 复用当前工程的设计规则，不会出现"命令行读到的是旧规则"；
 *   - 不产生 marker、不写盘、不进撤销栈，调用无副作用。
 *
 * 结果怎么取回来：
 *   命令 `kiapi.board.commands.RunDrc` → `RunDrcResponse`（华秋定制版 KiCad 提供，
 *   官方 10.0.6 没有）。kipy 不认这条命令，所以脚本在**运行时**把从本仓库
 *   `api/proto/board/drc_commands.proto` 导出的 FileDescriptorProto 注册进默认
 *   descriptor pool，再用 message_factory 取出消息类，直接走 KiCadClient.send()。
 *   这样做的好处是：不用预生成 .py、不用改 kipy、proto 改了只需重跑一次导出，
 *   也不会因为 kipy 版本不同而失配。
 *
 * 脚本以 `-c` 内联传给 Python，避免打包后 .py 文件路径丢失。
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import {
  DrcAbortedError,
  ExecutorError,
  type BackendHealth,
  type DrcExecutor,
  type DrcRunOptions,
  type DrcRunResult,
} from './executor.ts'

/** 探测脚本的默认超时（连接 + 版本 + 板查询，通常 < 1s）。 */
const PROBE_TIMEOUT_MS = 15_000

/** `RunDrc` 请求/响应消息类在 descriptor pool 里的名字。 */
const RUN_DRC_TYPE = 'kiapi.board.commands.RunDrc'
const RUN_DRC_RESPONSE_TYPE = 'kiapi.board.commands.RunDrcResponse'

/**
 * board/drc_commands.proto 的 FileDescriptorProto（序列化后 base64）。
 *
 * 只含这一个文件，不含依赖：`common/types/base_types.proto`、`board/board_types.proto`
 * 在导入 kipy 时已经进了默认 pool。重新导出方式见 README「更新 IPC 协议」。
 */
const DRC_DESCRIPTOR_B64 =
  'Chhib2FyZC9kcmNfY29tbWFuZHMucHJvdG8SFGtpYXBpLmJvYXJkLmNvbW1hbmRzGh1jb21tb24vdHlwZXMvYmFzZV90eXBlcy5wcm90bxoXYm9hcmQvYm9hcmRfdHlwZXMucHJvdG8iswMKDERyY1Zpb2xhdGlvbhISCgR0eXBlGAEgASgJUgR0eXBlEh0KCmVycm9yX2NvZGUYAiABKAVSCWVycm9yQ29kZRIUCgV0aXRsZRgDIAEoCVIFdGl0bGUSIAoLZGVzY3JpcHRpb24YBCABKAlSC2Rlc2NyaXB0aW9uEkYKCHNldmVyaXR5GAUgASgOMioua2lhcGkuYm9hcmQuY29tbWFuZHMuRHJjVmlvbGF0aW9uU2V2ZXJpdHlSCHNldmVyaXR5EjcKCHBvc2l0aW9uGAYgASgLMhsua2lhcGkuY29tbW9uLnR5cGVzLlZlY3RvcjJSCHBvc2l0aW9uEjMKBWxheWVyGAcgASgOMh0ua2lhcGkuYm9hcmQudHlwZXMuQm9hcmRMYXllclIFbGF5ZXISLgoFaXRlbXMYCCADKAsyGC5raWFwaS5jb21tb24udHlwZXMuS0lJRFIFaXRlbXMSKwoRaXRlbV9kZXNjcmlwdGlvbnMYCSADKAlSEGl0ZW1EZXNjcmlwdGlvbnMSJQoOdmlvbGF0aW5nX3J1bGUYCiABKAlSDXZpb2xhdGluZ1J1bGUinwIKCkRyY1N1bW1hcnkSHwoLZXJyb3JfY291bnQYASABKAVSCmVycm9yQ291bnQSIwoNd2FybmluZ19jb3VudBgCIAEoBVIMd2FybmluZ0NvdW50EicKD2V4Y2x1c2lvbl9jb3VudBgDIAEoBVIOZXhjbHVzaW9uQ291bnQSIwoNaWdub3JlZF9jb3VudBgEIAEoBVIMaWdub3JlZENvdW50EicKD3Zpb2xhdGlvbl9jb3VudBgFIAEoBVIOdmlvbGF0aW9uQ291bnQSKwoRdW5jb25uZWN0ZWRfY291bnQYBiABKAVSEHVuY29ubmVjdGVkQ291bnQSJwoPZm9vdHByaW50X2NvdW50GAcgASgFUg5mb290cHJpbnRDb3VudCLIAQoGUnVuRHJjEjsKBWJvYXJkGAEgASgLMiUua2lhcGkuY29tbW9uLnR5cGVzLkRvY3VtZW50U3BlY2lmaWVyUgVib2FyZBIhCgxyZWZpbGxfem9uZXMYAiABKAhSC3JlZmlsbFpvbmVzEjUKF3JlcG9ydF9hbGxfdHJhY2tfZXJyb3JzGAMgASgIUhRyZXBvcnRBbGxUcmFja0Vycm9ycxInCg90ZXN0X2Zvb3RwcmludHMYBCABKAhSDnRlc3RGb290cHJpbnRzIrEBCg5SdW5EcmNSZXNwb25zZRI6CgdzdW1tYXJ5GAEgASgLMiAua2lhcGkuYm9hcmQuY29tbWFuZHMuRHJjU3VtbWFyeVIHc3VtbWFyeRJCCgp2aW9sYXRpb25zGAIgAygLMiIua2lhcGkuYm9hcmQuY29tbWFuZHMuRHJjVmlvbGF0aW9uUgp2aW9sYXRpb25zEh8KC2R1cmF0aW9uX21zGAMgASgDUgpkdXJhdGlvbk1zKqEBChREcmNWaW9sYXRpb25TZXZlcml0eRIaChZEUkNWU19TRVZFUklUWV9VTktOT1dOEAASGAoURFJDVlNfU0VWRVJJVFlfRVJST1IQARIaChZEUkNWU19TRVZFUklUWV9XQVJOSU5HEAISHAoYRFJDVlNfU0VWRVJJVFlfRVhDTFVTSU9OEAMSGQoVRFJDVlNfU0VWRVJJVFlfSUdOT1JFEARiBnByb3RvMw=='

/**
 * 内联 Python 脚本。
 *
 * 约定：始终向 stdout 输出**一行 JSON**，退出码只用于粗分类
 * （0 成功 / 2 环境缺失 / 3 没有打开 PCB / 4 触发失败）。
 * 这样 Node 侧不需要解析任何人类可读文本。
 */
const DRC_IPC_SCRIPT = String.raw`
import argparse, base64, datetime, json, os, sys

def emit(obj, code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(code)

DESC_B64 = '__DESC_B64__'

# proto 里的 enum 数值 → kicad-cli JSON 报告用的字符串
SEVERITY_NAMES = {1: 'error', 2: 'warning', 3: 'exclusion', 4: 'ignore', 0: 'unknown'}

# kicad-cli 把这三类问题分到不同的顶层数组里，报告消费方（drc-summary）按数组+severity 统计
UNCONNECTED_TYPES = {'unconnected_items'}
PARITY_TYPES = {'missing_footprint', 'extra_footprint', 'duplicate_footprints',
                'footprint_symbol_mismatch', 'footprint_filters_mismatch'}

def nm_to_mm(nm):
    return round(nm / 1000000.0, 4)

def load_run_drc():
    """把 drc_commands.proto 注册进默认 descriptor pool，返回 (RunDrc, RunDrcResponse)。

    返回 None 表示当前 protobuf 版本取不到消息类；这属于客户端环境问题，
    与"服务端有没有这条命令"是两件事，调用方要分开报告。
    """
    try:
        import kipy.proto.common.types.base_types_pb2  # noqa: F401
        import kipy.proto.board.board_types_pb2  # noqa: F401
        from google.protobuf import descriptor_pool

        pool = descriptor_pool.Default()

        try:
            pool.AddSerializedFile(base64.b64decode(DESC_B64))
        except Exception:
            # 已注册（例如以后的 kipy 自带这个文件）时直接复用
            pass

        run_desc = pool.FindMessageTypeByName('__RUN_DRC_TYPE__')
        resp_desc = pool.FindMessageTypeByName('__RUN_DRC_RESPONSE_TYPE__')

        try:
            from google.protobuf.message_factory import GetMessageClass
        except Exception:
            from google.protobuf import message_factory
            GetMessageClass = message_factory.MessageFactory(pool).GetPrototype

        return GetMessageClass(run_desc), GetMessageClass(resp_desc)
    except Exception as e:
        sys.stderr.write('注册 RunDrc 描述符失败: %s\n' % e)
        return None

def probe_capability(k, RunDrc, RunDrcResponse):
    """判断服务端是否注册了 RunDrc，不跑 DRC。

    用一个空的 DocumentSpecifier 发请求：定制版会先校验文档、回 "is not open"，
    官方版则根本没有 handler、回 "no handler available"。两种情况都很快返回，
    区别只在那句话里。返回 True / False / None(未知)。
    """
    try:
        k._client.send(RunDrc(), RunDrcResponse)
        return True
    except Exception as e:
        msg = str(e).lower()
        if 'no handler available' in msg:
            return False
        if 'is not open' in msg:
            return True
        # busy / 超时 / 其它：无法判断，交给真正的调用去确认
        return None

def extend_timeout(k, rpc_ms):
    """发 DRC 之前把 RPC 超时调大：大板上引擎可能跑几十秒，
    但连接/ping 阶段必须保持短超时，否则 KiCad 卡住时会白等。"""
    conn = getattr(k._client, '_conn', None)

    if conn is not None:
        try:
            conn.recv_timeout = rpc_ms
            conn.send_timeout = rpc_ms
            return k
        except Exception:
            pass

    # 拿不到底层连接时退化成新开一个客户端（令牌复用，避免重新握手鉴权）
    try:
        import kipy
        return kipy.KiCad(timeout_ms=rpc_ms, kicad_token=k._client._kicad_token)
    except Exception:
        return k

def violation_entry(v, keep_ignored):
    """把一条 DrcViolation 转成 kicad-cli drc.json 里 VIOLATION 的形状。"""
    sev = SEVERITY_NAMES.get(v.severity, 'error')

    if sev == 'ignore' and not keep_ignored:
        return None, None

    pos = None

    if v.HasField('position'):
        pos = {'x': nm_to_mm(v.position.x_nm), 'y': nm_to_mm(v.position.y_nm)}

    descriptions = list(v.item_descriptions)
    items = []

    for i, kiid in enumerate(v.items):
        item = {'uuid': kiid.value,
                'description': descriptions[i] if i < len(descriptions) else ''}
        if pos is not None:
            item['pos'] = pos
        items.append(item)

    entry = {'type': v.type or 'unknown',
             'description': v.description or v.title,
             'severity': sev,
             'items': items}

    if v.violating_rule:
        entry['violating_rule'] = v.violating_rule

    if v.type in UNCONNECTED_TYPES:
        return entry, 'unconnected_items'
    if v.type in PARITY_TYPES:
        return entry, 'schematic_parity'
    return entry, 'violations'

def build_report(response, meta, keep_ignored):
    report = {'$schema': 'https://schemas.kicad.org/drc.v1.json',
              'coordinate_units': 'mm',
              'kicad_version': meta['kicad_version'],
              'source': meta['source'],
              'date': meta['date'],
              'violations': [],
              'unconnected_items': [],
              'schematic_parity': [],
              'ignored_checks': []}

    for v in response.violations:
        entry, section = violation_entry(v, keep_ignored)
        if entry is not None:
            report[section].append(entry)

    return report

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', choices=['probe', 'run'], default='probe')
    ap.add_argument('--pcb', default='')
    ap.add_argument('--timeout-ms', type=int, default=2500)
    ap.add_argument('--rpc-timeout-ms', type=int, default=120000)
    ap.add_argument('--refill-zones', action='store_true')
    ap.add_argument('--all-track-errors', action='store_true')
    ap.add_argument('--test-footprints', action='store_true')
    ap.add_argument('--severity-all', action='store_true')
    a = ap.parse_args()

    out = {'ok': False, 'mode': a.mode, 'connected': False, 'runDrc': None,
           'warnings': [], 'errors': []}

    try:
        import kipy
    except Exception as e:
        out['errors'].append('kipy 未安装: %s' % e)
        emit(out, 2)

    classes = load_run_drc()
    out['clientProtocol'] = classes is not None

    # 连接和 ping 必须快速失败（KiCad 没开就立刻报错），只有真正跑 DRC 时才把超时调大
    try:
        k = kipy.KiCad(timeout_ms=a.timeout_ms)
        k.ping()
        out['connected'] = True
        out['kicadVersion'] = str(k.get_version()).split(' ')[0]
        out['apiVersion'] = str(k.get_api_version())
    except Exception as e:
        out['errors'].append('连接 KiCad IPC 失败: %s' % e)
        emit(out, 2)

    board = None
    doc = None
    try:
        board = k.get_board()
        doc = board._doc
        out['boardFile'] = doc.board_filename
        proj = doc.project
        out['project'] = proj.name if proj else ''
        # kipy 只给文件名，工程目录在 doc.project.path；拼成绝对路径才能和目标板比对
        proj_path = getattr(proj, 'path', '') if proj else ''
        bp = doc.board_filename or ''
        if bp and proj_path and not os.path.isabs(bp):
            bp = os.path.join(proj_path, bp)
        out['boardPath'] = bp
    except Exception as e:
        out['errors'].append('KiCad 中没有打开的 PCB 编辑器: %s' % e)
        emit(out, 3)

    if a.pcb:
        try:
            want = os.path.normcase(os.path.abspath(a.pcb))
            have = os.path.normcase(os.path.abspath(out.get('boardPath') or ''))
            out['boardMatched'] = (want == have)
            if not out['boardMatched']:
                out['warnings'].append(
                    'KiCad 当前打开的板与目标不一致: %s' % (out.get('boardPath') or ''))
        except Exception:
            pass

    if classes is None:
        out['errors'].append('无法加载 RunDrc 协议描述符（protobuf 版本过旧？）')
        out['ok'] = a.mode == 'probe'
        emit(out, 0 if a.mode == 'probe' else 4)

    RunDrc, RunDrcResponse = classes
    out['runDrc'] = probe_capability(k, RunDrc, RunDrcResponse)

    if a.mode == 'probe' or out['runDrc'] is False:
        # probe 只要能判断可用性；服务端不支持时也在这里收尾，run 模式由 Node 侧报错
        out['ok'] = a.mode == 'probe' and out['runDrc'] is not False
        emit(out, 0 if a.mode == 'probe' else 4)

    req = RunDrc()
    req.board.ParseFromString(doc.SerializeToString())
    req.refill_zones = bool(a.refill_zones)
    req.report_all_track_errors = bool(a.all_track_errors)
    req.test_footprints = bool(a.test_footprints)

    started = datetime.datetime.now()

    k = extend_timeout(k, a.rpc_timeout_ms)

    try:
        response = k._client.send(req, RunDrcResponse)
    except Exception as e:
        out['errors'].append('KiCad 执行 RunDrc 失败: %s' % e)
        emit(out, 4)

    elapsed_ms = int((datetime.datetime.now() - started).total_seconds() * 1000)

    meta = {'kicad_version': out.get('kicadVersion') or 'unknown',
            'source': out.get('boardFile') or a.pcb,
            'date': datetime.datetime.now().astimezone().isoformat(timespec='seconds')}

    out['report'] = build_report(response, meta, bool(a.severity_all))
    out['durationMs'] = int(response.duration_ms or elapsed_ms)
    out['ok'] = True
    emit(out)

main()
`
  .replace('__DESC_B64__', DRC_DESCRIPTOR_B64)
  .replace('__RUN_DRC_TYPE__', RUN_DRC_TYPE)
  .replace('__RUN_DRC_RESPONSE_TYPE__', RUN_DRC_RESPONSE_TYPE)

/** 脚本输出的结构化结果。 */
interface IpcScriptOutput {
  ok: boolean
  mode: 'probe' | 'run'
  connected: boolean
  kicadVersion?: string
  apiVersion?: string
  boardFile?: string
  boardPath?: string
  project?: string
  boardMatched?: boolean
  /** 客户端能否加载 RunDrc 协议（protobuf 版本问题）。 */
  clientProtocol?: boolean
  /** 服务端是否提供 RunDrc：true / false / null（无法判断）。 */
  runDrc?: boolean | null
  /** 已转换成 kicad-cli drc.json 形状的报告。 */
  report?: Record<string, unknown>
  durationMs?: number
  warnings?: string[]
  errors?: string[]
}

/** `RunDrc` 不可用时的固定提示：这是最常遇到的一种失败，值得一句能照做的话。 */
const NO_RUN_DRC_HINT =
  '当前 KiCad 没有提供 RunDrc 接口（官方版没有这条 IPC 命令，需要华秋定制版 KiCad）。'
  + '可改用 local / remote 后端。'

/** 运行一次脚本，返回解析后的 JSON 与耗时。 */
function runScript(
  pythonPath: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ out: IpcScriptOutput, exitCode: number, stderr: string, elapsedMs: number }> {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now()
    const child = spawn(pythonPath, ['-c', DRC_IPC_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | undefined

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8') })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8') })

    timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)

    // 取消时杀掉脚本进程：它阻塞在 RPC 上，等它自己退出可能是一分钟
    const onAbort = (): void => {
      if (timer) clearTimeout(timer)
      child.kill('SIGKILL')
      reject(new DrcAbortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new ExecutorError(`无法启动 Python（${pythonPath}）: ${err.message}`))
    })

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const elapsedMs = Math.round(performance.now() - started)
      const text = stdout.trim()
      if (!text) {
        reject(new ExecutorError(
          `KiCad IPC 脚本没有输出（exit ${code}）。stderr: ${stderr.trim().slice(0, 400) || '(空)'}`,
        ))
        return
      }
      // 只取最后一行：脚本约定输出单行 JSON，前面可能有 KiCad 的杂项打印
      const line = text.split(/\r?\n/).pop() ?? text
      try {
        const out = JSON.parse(line) as IpcScriptOutput
        resolvePromise({ out, exitCode: code ?? -1, stderr, elapsedMs })
      } catch {
        reject(new ExecutorError(`KiCad IPC 脚本输出不是 JSON: ${line.slice(0, 400)}`))
      }
    })
  })
}

/**
 * KiCad IPC 执行器。
 *
 * `probe()` 会真的连接一次 KiCad（约几十毫秒）并确认服务端有没有 RunDrc：
 * 这是唯一可靠的判断方式——配置文件里 `enable_server` 为 true 也不代表当前进程在服务，
 * 而"连得上"也不代表这是定制版。
 */
export class KicadIpcExecutor implements DrcExecutor {
  readonly name = 'ipc' as const
  private readonly pythonPath: string
  /** 上次探测的失败原因（60s 内复用，避免每次工具调用都连一次）。 */
  private lastFailure: { message: string, at: number } | null = null

  constructor(pythonPath: string) {
    this.pythonPath = pythonPath
  }

  async probe(): Promise<BackendHealth> {
    if (this.lastFailure && Date.now() - this.lastFailure.at < 60_000) {
      return { backend: 'ipc', available: false, endpoint: this.pythonPath, reason: this.lastFailure.message }
    }
    try {
      const { out } = await runScript(this.pythonPath, ['--mode', 'probe'], PROBE_TIMEOUT_MS)
      if (!out.connected) {
        return this.failed(out.errors?.join('；') ?? '无法连接 KiCad IPC')
      }
      if (out.clientProtocol === false) {
        return this.failed(out.errors?.join('；') ?? '无法加载 RunDrc 协议描述符')
      }
      // 连上但没打开板，IPC 也无从下手：DRC 只能作用于编辑器里已加载的板
      if (!out.boardFile) {
        return this.failed(
          'KiCad 已连上，但没有打开的 PCB 编辑器；请先在 KiCad 里打开目标 .kicad_pcb',
        )
      }
      if (out.runDrc === false) {
        return this.failed(NO_RUN_DRC_HINT)
      }
      const proto = out.runDrc === true ? 'RunDrc 可用' : 'RunDrc 未确认'
      return {
        backend: 'ipc',
        available: true,
        endpoint: `${this.pythonPath} → ${out.boardPath ?? out.boardFile}，${proto}`,
      }
    } catch (e) {
      return this.failed(e instanceof Error ? e.message : String(e))
    }
  }

  private failed(message: string): BackendHealth {
    this.lastFailure = { message, at: Date.now() }
    return { backend: 'ipc', available: false, endpoint: this.pythonPath, reason: message }
  }

  async run(options: DrcRunOptions): Promise<DrcRunResult> {
    if (options.signal?.aborted) throw new DrcAbortedError()
    const pcbPath = resolve(options.pcbPath)
    const timeoutMs = Math.min((options.timeoutSeconds ?? 600) * 1000, 120_000)
    // RPC 超时要略小于脚本超时：让 KiCad 侧的等待先结束，好拿到它自己的错误信息
    const rpcTimeoutMs = Math.max(timeoutMs - 5_000, 10_000)

    const args = ['--mode', 'run', '--pcb', pcbPath, '--rpc-timeout-ms', String(rpcTimeoutMs)]
    if (options.refillZones) args.push('--refill-zones')
    if (options.allTrackErrors) args.push('--all-track-errors')
    if (options.severityAll) args.push('--severity-all')

    const { out, elapsedMs } = await runScript(this.pythonPath, args, timeoutMs, options.signal)

    // 服务端没有 RunDrc：这不是"这次运气不好"，而是能力缺失，标记冷却让 auto 别再选它
    if (out.runDrc === false) {
      this.lastFailure = { message: NO_RUN_DRC_HINT, at: Date.now() }
      throw new ExecutorError(NO_RUN_DRC_HINT)
    }

    if (!out.ok) {
      throw new ExecutorError(
        `KiCad IPC 执行 DRC 失败: ${out.errors?.join('；') || '未知原因'}`,
      )
    }

    // 目标板与 KiCad 当前打开的板不一致时，宁可报错也不能把别的板的结果当答案
    if (out.boardMatched === false) {
      throw new ExecutorError(
        `KiCad 当前打开的是 ${out.boardPath ?? out.boardFile ?? '未知板'}，与目标 ${pcbPath} 不是同一块板。`
        + '请先在 KiCad 中打开目标 PCB 再使用 ipc 模式。',
      )
    }

    if (!out.report) {
      throw new ExecutorError('KiCad 执行完毕但没有返回 DRC 结果（RunDrcResponse 为空）')
    }

    return {
      exitCode: 0,
      stdout: `DRC 已在 KiCad 中执行（${out.boardFile ?? pcbPath}，${out.durationMs ?? '?'}ms）`,
      stderr: (out.warnings ?? []).join('\n'),
      drcJson: JSON.stringify(out.report),
      elapsedMs,
      timedOut: false,
      kicadCliPath: `ipc:${out.kicadVersion ?? 'kicad'}`,
      command: `python -c <drc_ipc.py> --mode run --pcb ${pcbPath}`,
      drcJsonPath: null,
    }
  }
}
