import type { PkgConfig } from '../types.js'
import { ALL_CONFIGS, PKG_TYPE_OPTIONS } from '../types.js'

export const sopConfig: PkgConfig = {
  DataPointList: [
    { id: 'b_max', x: 43, y: -20, value: 0, type: 'input' },
    { id: 'b_min', x: -9, y: -20, value: 0, type: 'input' },
    { id: 'd_max', x: 147, y: 366, value: 0, type: 'input' },
    { id: 'd_min', x: 93, y: 366, value: 0, type: 'input' },
    { id: 'e_max', x: 306, y: 42, value: 0, type: 'input' },
    { id: 'e_min', x: 254, y: 42, value: 0, type: 'input' },
    { id: 'h_max', x: 144, y: 410, value: 0, type: 'input' },
    { id: 'h_min', x: 96, y: 410, value: 0, type: 'input' },
    { id: 'l_max', x: 300, y: 578, value: 0, type: 'input' },
    { id: 'l_min', x: 250, y: 578, value: 0, type: 'input' },
    { id: 'pitch', x: 186, y: -18, value: 0, type: 'input' },
    { id: 'a_max', x: 30, y: 578, value: 0, type: 'input' },
    { id: 'a_min', x: -6, y: 578, value: 0, type: 'input' },
  ],
  dividerList: [
    { x: 28, y: -12, direction: 'horizontal' },
    { x: 292, y: 50, direction: 'horizontal' },
    { x: 132, y: 374, direction: 'horizontal' },
    { x: 129, y: 418, direction: 'horizontal' },
    { x: 287, y: 586, direction: 'horizontal' },
    { x: 15, y: 586, direction: 'horizontal' },
  ],
  extraFieldsList: [
    { name: 'pin_count', label: '引脚数：', type: 'input', value: 0, required: true },
    { name: 'select_pkgType', label: '重新提取信息：', type: 'select', value: 'sop', options: PKG_TYPE_OPTIONS, required: true },
  ],
}
ALL_CONFIGS.sop = sopConfig
