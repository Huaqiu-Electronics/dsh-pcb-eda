// @huaqiu/dsh-tool-pcb-viewer — 独立整页入口（「浏览器打开」用）。
//
// 由 host 路由 /pcb-viewer/view 提供的极简页面加载：读 URL 上的 key/name，
// 向 /pcb-viewer/api/file 拉板文件文本，渲染「左 2D 走线 + 右 3D」整页视图。
// 布局与面板内一致（split），放大到满屏。
import { createViewer, type ViewMode } from '../viewer.js'

const app = document.getElementById('app') as HTMLElement
const q = new URLSearchParams(location.search)
const key = q.get('key') ?? ''
const name = q.get('name') ?? 'board.kicad_pcb'
const modeParam = q.get('mode')
const mode: ViewMode = modeParam === '2d' || modeParam === '3d' ? modeParam : 'split'

function fail(message: string): void {
  app.innerHTML = `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#9fb2c4;font:13px ui-monospace,Menlo,monospace;letter-spacing:.12em">${message}</div>`
}

if (!key) {
  fail('缺少 key 参数 —— 请从 DSH 会话里点「浏览器打开」进入')
} else {
  document.title = name + ' · PCB 3D'
  fetch(`/pcb-viewer/api/file?key=${encodeURIComponent(key)}`)
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
    .then((text) => {
      createViewer(app, {
        board: text,
        boardName: name,
        brand: 'PCB · 3D',
        brandSub: '2D LAYOUT + 3D RENDER',
        mode,
      })
    })
    .catch((e) => fail('加载失败：' + String(e instanceof Error ? e.message : e)))
}
