/**
 * zh_CN copy for the document-rendering surfaces.
 *
 * Same rationale as `../copy.ts`: one dictionary, so a string rendered from two
 * seats cannot drift, and "is this translated?" stays a grep for a Chinese
 * character outside these two files. The document seats take no `locale`
 * namespace, for the reason spelled out there — DSH's typed `locale` overload
 * requires both baseline locales and this product ships zh-CN only — so these
 * strings are read directly rather than through a slot's `t`.
 *
 * Extension names, viewer verbs and unit symbols are not translated.
 *
 * @module @huaqiu/dsh-hardware-ui/client/document/copy
 */

export const DOCUMENT_COPY = {
  /** Toolbar labels for the document viewer menu. */
  viewer: {
    schematic: '原理图',
    pcb: 'PCB',
    model: '3D 模型',
  },
  /** Progress and state lines. */
  state: {
    loading: '正在解析并渲染…',
    stepLoading: '正在解析 STEP 几何…',
    empty: '文件为空，没有可渲染的内容。',
    tooLarge: (limit: string) => `文件超过 ${limit} 上限，文档预览不渲染该文件。`,
    parseFailed: (message: string) => `解析失败：${message}`,
    renderFailed: (message: string) => `渲染失败：${message}`,
    timeout: (seconds: number) => `渲染超过 ${seconds} 秒未完成，已取消。`,
    aborted: '渲染已取消。',
    /** Shown when the WebGL canvas cannot be created (no GPU, blocklisted driver). */
    noWebgl: '当前环境无法创建 WebGL 上下文，无法渲染该文档。',
    stepUnavailable: '3D 解析组件不可用，无法预览 STEP/STP 文件。',
    stepInvalid: '该 STEP/STP 文件不含可用实体几何，无法预览。',
    wasmFailed: '3D 解析组件加载失败。',
  },
  /** Interaction hints overlaid on a rendered document. */
  hint: {
    schematic: '拖动平移 · 滚轮缩放',
    model: '左键旋转 · 右键平移 · 滚轮缩放',
  },
  /** Child-sheet disclosure under a schematic. */
  sheets: {
    title: (count: number) => `本图引用 ${count} 个子图（未合并显示）`,
    missing: (label: string) => `${label}：无法读取`,
    found: (label: string) => label,
    hint: '子图在各自的文件中单独打开预览；本预览只渲染当前文档。',
  },
} as const
