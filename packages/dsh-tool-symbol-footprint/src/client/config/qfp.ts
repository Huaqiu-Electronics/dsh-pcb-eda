import type { PkgConfig } from '../types.js'
import { ALL_CONFIGS, PKG_TYPE_OPTIONS } from '../types.js'

export const qfpConfig: PkgConfig = {
  DataPointList: [
    { id: 'a_max', x: 28, y: 426, value: 0, type: 'input' },
    { id: 'a_min', x: -8, y: 426, value: 0, type: 'input' },
    { id: 'b_max', x: 311, y: 270, value: 0, type: 'input' },
    { id: 'b_min', x: 270, y: 270, value: 0, type: 'input' },
    { id: 'd1_max', x: 180, y: 312, value: 0, type: 'input' },
    { id: 'd1_min', x: 138, y: 312, value: 0, type: 'input' },
    { id: 'd_max', x: 188, y: 338, value: 0, type: 'input' },
    { id: 'd_min', x: 146, y: 338, value: 0, type: 'input' },
    { id: 'e1_max', x: 62, y: 13, value: 0, type: 'input' },
    { id: 'e1_min', x: 22, y: 13, value: 0, type: 'input' },
    { id: 'e_max', x: 40, y: -19, value: 0, type: 'input' },
    { id: 'e_min', x: -6, y: -19, value: 0, type: 'input' },
    { id: 'l_max', x: 311, y: 446, value: 0, type: 'input' },
    { id: 'l_min', x: 268, y: 446, value: 0, type: 'input' },
    { id: 'pitch', x: 230, y: 4, value: 0, type: 'input' },
  ],
  dividerList: [
    { x: 13, y: 434, direction: 'horizontal' },
    { x: 300, y: 278, direction: 'horizontal' },
    { x: 169, y: 319, direction: 'horizontal' },
    { x: 174, y: 346, direction: 'horizontal' },
    { x: 53, y: 21, direction: 'horizontal' },
    { x: 27, y: -12, direction: 'horizontal' },
    { x: 300, y: 453, direction: 'horizontal' },
  ],
  extraFieldsList: [
    { name: 'pin_count_d', label: '水平引脚数：', type: 'input', value: 0, required: true },
    { name: 'pin_count_e', label: '垂直引脚数：', type: 'input', value: 0, required: true },
    { name: 'select_pkgType', label: '重新提取信息：', type: 'select', value: 'qfp', options: PKG_TYPE_OPTIONS, required: true },
  ],
}
ALL_CONFIGS.qfp = qfpConfig
