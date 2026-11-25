import type { PkgConfig } from '../types.js'
import { ALL_CONFIGS, PKG_TYPE_OPTIONS } from '../types.js'

export const qfnConfig: PkgConfig = {
  DataPointList: [
    { id: 'a1_max', x: 306, y: 450, value: 0, type: 'input' },
    { id: 'a1_min', x: 270, y: 450, value: 0, type: 'input' },
    { id: 'a_max', x: 46, y: 450, value: 0, type: 'input' },
    { id: 'a_min', x: 10, y: 450, value: 0, type: 'input' },
    { id: 'd2_max', x: 156, y: 18, value: 0, type: 'input' },
    { id: 'd2_min', x: 120, y: 18, value: 0, type: 'input' },
    { id: 'd_max', x: 166, y: 306, value: 0, type: 'input' },
    { id: 'd_min', x: 130, y: 306, value: 0, type: 'input' },
    { id: 'e2_max', x: 28, y: 80, value: 0, type: 'input' },
    { id: 'e2_min', x: -8, y: 80, value: 0, type: 'input' },
    { id: 'e_max', x: 316, y: 280, value: 0, type: 'input' },
    { id: 'e_min', x: 280, y: 280, value: 0, type: 'input' },
    { id: 'l_max', x: 68, y: 10, value: 0, type: 'input' },
    { id: 'l_min', x: 32, y: 10, value: 0, type: 'input' },
    { id: 'pitch_d', x: 156, y: 262, value: 0, type: 'input' },
    { id: 'b_min', x: 260, y: 125, value: 0, type: 'input' },
    { id: 'b_max', x: 300, y: 125, value: 0, type: 'input' },
  ],
  dividerList: [
    { x: 298, y: 458, direction: 'horizontal' },
    { x: 38, y: 458, direction: 'horizontal' },
    { x: 148, y: 26, direction: 'horizontal' },
    { x: 158, y: 314, direction: 'horizontal' },
    { x: 20, y: 88, direction: 'horizontal' },
    { x: 308, y: 288, direction: 'horizontal' },
    { x: 60, y: 18, direction: 'horizontal' },
    { x: 291, y: 132, direction: 'horizontal' },
  ],
  extraFieldsList: [
    { name: 'pin_count_d', label: '水平引脚数：', type: 'input', value: 0, required: true },
    { name: 'pin_count_e', label: '垂直引脚数：', type: 'input', value: 0, required: true },
    { name: 'select_pkgType', label: '重新提取信息：', type: 'select', value: 'qfn', options: PKG_TYPE_OPTIONS, required: true },
  ],
}
ALL_CONFIGS.qfn = qfnConfig
