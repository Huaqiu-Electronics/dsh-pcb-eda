/** Browser-safe presentation of domain facts. Never infer outcomes from diagnostic prose. */
export interface RoutingExplanation {
  problem: string;
  boardEffect: string;
  nextAction: string;
}

const notAdded = '本次没有把新走线添加到板子。';
const inspect = '请在 KiCad 中检查板子，再决定是否重新布线。';
const explanations: Record<string, RoutingExplanation> = {};

function register(codes: string[], problem: string, boardEffect: string, nextAction: string) {
  for (const code of codes) {
    explanations[code] = { problem, boardEffect, nextAction };
  }
}

register(
  ['FREEROUTING_TIMEOUT'],
  '自动布线在允许的时间内没有完成。',
  notAdded,
  '请保留诊断详情，检查未连接位置后再决定是否重新布线。',
);
register(
  ['KICAD_UNAVAILABLE'],
  '暂时连不上当前 KiCad 板子。',
  notAdded,
  '请确认 PCB 编辑器已打开，并在“设置 → 偏好设置 → 插件”中启用 KiCad API。已经启用时，请重新打开 PCB 编辑器再试。',
);
register(
  ['INSTANCE_SELECTION_REQUIRED', 'KICAD_PYTHON_SELECTION_REQUIRED'],
  '发现多个 KiCad，暂时无法确定要操作哪一块板子。',
  notAdded,
  '请只保留一个用于本次布线的 KiCad PCB 编辑器，或请维护人员指定目标。',
);
register(
  ['NET_FILTER_UNSUPPORTED'],
  '当前布线引擎暂不支持只布指定网络或跳过部分网络。',
  notAdded,
  '请使用不跳过网络的整板自动布线。',
);
register(['BOARD_NOT_SAVED'], '这块板子还没有保存过。', notAdded, '请先在 KiCad 中保存一次板子，再开始布线。');
register(
  ['BOARD_CHANGED', 'PLACEMENT_CHANGED'],
  '布线期间板子或布线规则发生了变化。',
  notAdded,
  '请按当前板子重新布线，运行期间不要编辑板子。',
);
register(
  ['EDITOR_CLOSED'],
  '目标 PCB 编辑器已关闭，布线已停止。',
  '请重新打开板子检查原有内容和过程走线的实际状态。',
  '状态待确认时，先检查板子再解除暂停。',
);
register(['INSTANCE_CHANGED'], '目标 KiCad 已关闭或重新打开。', notAdded, '请确认当前板子后重新布线。');
register(
  ['IMPORT_UNCERTAIN', 'BOARD_IMPORT_UNCERTAIN'],
  '暂时无法确认新走线是否已添加到板子。',
  '这块板子的后续自动布线已暂停，不能确认板子是否保持原样。',
  '请先检查目标板子，再明确告诉助手“我已检查这块板子”，解除暂停。',
);
register(['CREATE_FAILED'], '新走线添加失败。', '本轮新增内容已撤回，原有内容保留。', inspect);
register(
  ['BOARD_RUN_ACTIVE'],
  '当前已有布线或板子处理正在运行。',
  '没有启动第二个任务，已有任务继续运行。',
  '请等待已有任务结束，或先取消它。',
);
register(
  ['RESOURCE_LIMIT', 'RESOURCE_CHECK_FAILED'],
  '本次布线因内存或结果容量保护而停止。',
  '已有可用结果仍保留；请核对过程走线是否已清理。最终结果未添加时，不代表布线完成。',
  '请释放电脑内存，或等待旧结果过期后再试；状态待确认时先检查板子。',
);
register(
  ['ENGINE_TASK_UNCONFIRMED'],
  '无法确认上一轮布线计算已停止。',
  '没有开始新的计算，也没有启动第二个引擎。',
  '请等待原任务停止后再试；引擎已保留供确认空闲后复用。',
);
register(['RUN_CAPACITY_EXCEEDED'], '正在处理的布线任务太多。', '本次请求没有启动布线。', '请等待已有任务结束后再试。');
register(
  ['RUN_NOT_FOUND', 'REPAIR_UNAVAILABLE', 'REPAIR_ALREADY_ATTEMPTED'],
  '这次任务已无法继续处理。',
  '没有再次添加布线结果。',
  '请查看原任务的最终结果，确认板子状态后再决定下一步。',
);
register(
  ['DESIGN_RULE_VIOLATION'],
  '新走线没有通过布线规则检查。',
  notAdded,
  '请查看具体问题，检查线距、线宽和是否存在短路；未提供具体报告时，不能确定是哪一项问题。',
);
register(
  ['DESIGN_CHECK_MISSING', 'DESIGN_CHECK_FAILED', 'DESIGN_CHECK_PROTOCOL', 'DESIGN_CHECK_TIMEOUT'],
  '未能完成新走线的布线规则检查。',
  notAdded,
  '这不代表板子一定有规则问题。请保留检查报告或诊断详情，交给维护人员排查后再试。',
);
register(
  ['ORIGINAL_COPPER_AMBIGUOUS', 'ORIGINAL_COPPER_OVERLAP', 'ORIGINAL_COPPER_UNPROTECTED', 'DUPLICATE_COPPER'],
  '无法确认新走线与原有走线、过孔能正确合并。',
  notAdded,
  '为保留原有内容，本次已停止。请保留布线结果和诊断详情，交给维护人员检查。',
);
register(
  ['NET_MAPPING', 'NET_SCOPE', 'LAYER_MAPPING', 'SES_MAPPING', 'INVALID_COORDINATE', 'CREATE_VERIFICATION'],
  '布线结果中的网络、铜层或位置未能正确核对。',
  '请检查板子，确认本轮是否新增了走线；不要直接保存。',
  '请保留布线结果和诊断详情，交给维护人员检查。',
);
register(
  [
    'CUSTOM_RULES_UNSUPPORTED',
    'DIFF_PAIR_UNSUPPORTED',
    'ARC_UNSUPPORTED',
    'TRACK_UNSUPPORTED',
    'VIA_UNSUPPORTED',
    'UNSUPPORTED_VIA',
  ],
  '板子包含当前自动布线暂不支持的规则、走线或过孔类型。',
  notAdded,
  '请查看诊断详情确认具体限制；不要为继续布线而删除原有内容或放宽规则。',
);
register(
  ['AUTO_TEARDROPS_UNSUPPORTED'],
  '板子开启了自动泪滴补铜，当前自动布线暂不支持。',
  notAdded,
  '请在 KiCad 中检查并关闭自动泪滴补铜后再试，或保留设置等待插件支持。',
);
register(
  ['RULE_FIDELITY', 'PROJECT_RULES_MISSING', 'PROJECT_RULES_UNVERIFIABLE'],
  '无法完整读取或保留这块板子的布线规则。',
  notAdded,
  '请确认板子与工程文件放在一起，并保留诊断详情供维护人员排查。',
);
register(
  ['KICAD_VERSION_UNSUPPORTED', 'PLATFORM_UNSUPPORTED'],
  '当前 KiCad 版本或操作系统不受支持。',
  notAdded,
  '请使用 Windows 和 KiCad 10.0.6 或更新的 10.0 版本。',
);
register(
  ['KICAD_PYTHON_MISSING', 'KICAD_PYTHON_MISMATCH', 'HELPER_MISSING', 'HELPER_PREFLIGHT_FAILED'],
  'KiCad 或布线插件的配套组件未准备好。',
  '请检查板子，确认本轮是否新增了走线。',
  '请把诊断详情交给维护人员，检查安装是否完整、所选 KiCad 是否匹配。',
);
register(
  ['UNKNOWN_NET', 'NO_TARGET_NETS'],
  '没有找到本次需要布线的网络。',
  notAdded,
  '请核对网络名称和跳过的网络，再决定是否重新布线。',
);
register(
  ['UNSTABLE_SNAPSHOT', 'INSTANCE_IDENTITY_FAILED'],
  '无法可靠确认当前板子和目标编辑器。',
  notAdded,
  '请停止编辑板子并重新打开 PCB 编辑器，再试一次。',
);
register(
  ['RUN_CANCELLED'],
  '已收到取消请求。',
  '请以任务的最终结果确认是否已添加走线。',
  '如果正在添加走线，请等待完成，不要强行关闭 KiCad。',
);

export function routingExplanation(code: string): RoutingExplanation {
  return (
    explanations[code] ?? {
      problem: '自动布线未能完成。',
      boardEffect: '请检查当前板子，确认本轮是否新增了走线；暂时不要保存。',
      nextAction: '请保留布线结果或诊断详情，交给维护人员排查。',
    }
  );
}

export function explanationText(explanation: RoutingExplanation): string {
  return [explanation.problem, explanation.boardEffect, explanation.nextAction].join('');
}

export function routingErrorText(error: { code: string }): string {
  return explanationText(routingExplanation(error.code));
}

const ruleLabels: Record<string, string> = {
  clearance: '走线或过孔与其他铜的距离不够',
  shorting_items: '铜之间发生相碰，可能造成短路',
  track_width: '走线宽度不符合板子的要求',
  via_diameter: '过孔直径不符合板子的要求',
  via_hole: '过孔钻孔尺寸不符合板子的要求',
  hole_size: '钻孔尺寸不符合板子的要求',
  holes_co_located: '多个钻孔重叠在同一位置',
  hole_to_hole: '钻孔之间的距离不够',
  copper_edge_clearance: '走线或过孔离板边太近',
  annular_width: '焊盘或过孔的铜环太窄',
  disallowed_items: '走线或过孔放在了规则不允许的位置',
};

export function ruleProblemText(type: string): string {
  return ruleLabels[type] ?? '走线或过孔不符合板子的布线规则，请查看原始检查说明';
}

export function routingStageText(state: string): string {
  return (
    (
      {
        INVALID: '布线引擎未能开始处理',
        QUEUED: '等待布线引擎开始处理',
        RUNNING: '布线中',
        COMPLETED: '布线计算完成，正在检查结果',
        CANCELLED: '正在取消布线',
        FAILED: '布线引擎未能完成计算',
        TIMED_OUT: '布线计算等待超时',
      } as Record<string, string>
    )[state] ?? '布线引擎正在处理'
  );
}

interface RunFacts {
  state: string;
  error?: { code: string };
  summary?: { imported: boolean; tracks: number; vias: number; warning?: string };
}

/** Same confirmed result for the card, tool response and background notification. */
export function routingRunText(run: RunFacts): string {
  if (run.error) {
    return routingErrorText(run.error);
  }
  if (run.summary?.imported) {
    const { tracks, vias, warning } = run.summary;
    const result =
      tracks || vias
        ? `布线结果已添加到板子，新增走线 ${tracks} 段、过孔 ${vias} 个。`
        : '本次没有新增走线或过孔，原有内容保留。';
    return `${result}${warning ? `${warning}。` : ''}文件未自动保存。尚未确认是否所有网络都已接通，请在 KiCad 中检查后再手动保存。`;
  }
  if (run.state === 'repair_pending') {
    return '发现新走线的布线规则问题，正在等待自动处理；本轮过程走线已清理，最终结果尚未添加。实际处理和重新布线动作会显示在过程记录中。';
  }
  if (run.state === 'cancelled') {
    return '任务已取消，本次布线结果未添加到板子。';
  }
  if (run.state === 'expired') {
    return '这次布线结果已过期，请检查当前板子后再决定是否重新布线。';
  }
  return '自动布线任务已启动，卡片会显示进度。请等待最终结果，期间不要编辑板子。文件不会自动保存。';
}
