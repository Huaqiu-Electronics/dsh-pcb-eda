import type { PkgConfig } from '../types.js'
import { ALL_CONFIGS, PKG_TYPE_OPTIONS } from '../types.js'

export const sonConfig: PkgConfig = {
  DataPointList: [
    { id: 'a1_min', x: -12, y: 440, value: 0, type: 'input' },
    { id: 'a1_max', x: 38, y: 440, value: 0, type: 'input' },
    { id: 'a_min', x: 275, y: 440, value: 0, type: 'input' },
    { id: 'a_max', x: 319, y: 440, value: 0, type: 'input' },
    { id: 'b_max', x: 196, y: 236, value: 0, type: 'input' },
    { id: 'b_min', x: 146, y: 236, value: 0, type: 'input' },
    { id: 'd2_max', x: 178, y: -18, value: 0, type: 'input' },
    { id: 'd2_min', x: 130, y: -18, value: 0, type: 'input' },
    { id: 'd_max', x: 178, y: 276, value: 0, type: 'input' },
    { id: 'd_min', x: 137, y: 276, value: 0, type: 'input' },
    { id: 'e2_max', x: 320, y: 216, value: 0, type: 'input' },
    { id: 'e2_min', x: 281, y: 216, value: 0, type: 'input' },
    { id: 'e_max', x: 36, y: 260, value: 0, type: 'input' },
    { id: 'e_min', x: -13, y: 260, value: 0, type: 'input' },
    { id: 'l_max', x: 318, y: 32, value: 0, type: 'input' },
    { id: 'l_min', x: 270, y: 32, value: 0, type: 'input' },
    { id: 'pitch', x: 148, y: 34, value: 0, type: 'input' },
  ],
  dividerList: [
    { x: 22, y: 448, direction: 'horizontal' },
    { x: 300, y: 448, direction: 'horizontal' },
    { x: 182, y: 242, direction: 'horizontal' },
    { x: 158, y: -10, direction: 'horizontal' },
    { x: 166, y: 283, direction: 'horizontal' },
    { x: 304, y: 223, direction: 'horizontal' },
    { x: 22, y: 266, direction: 'horizontal' },
    { x: 305, y: 39, direction: 'horizontal' },
  ],
  extraFieldsList: [
    { name: 'pin_count', label: '引脚数：', type: 'input', value: 0, required: true },
    { name: 'select_pkgType', label: '重新提取信息：', type: 'select', value: 'son', options: PKG_TYPE_OPTIONS, required: true },
  ],
}
ALL_CONFIGS.son = sonConfig
