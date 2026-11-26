import type { PkgConfig } from '../types.js'
import { ALL_CONFIGS, PKG_TYPE_OPTIONS } from '../types.js'

export const sot23Config: PkgConfig = {
  DataPointList: [
    { id: 'b_min', x: -26, y: 44, value: 0, type: 'input' },
    { id: 'b_max', x: 16, y: 44, value: 0, type: 'input' },
    { id: 'h_min', x: 122, y: 10, value: 0, type: 'input' },
    { id: 'h_max', x: 166, y: 10, value: 0, type: 'input' },
    { id: 'd_min', x: 280, y: 336, value: 0, type: 'input' },
    { id: 'd_max', x: 326, y: 336, value: 0, type: 'input' },
    { id: 'e_min', x: 88, y: 340, value: 0, type: 'input' },
    { id: 'e_max', x: 140, y: 340, value: 0, type: 'input' },
    { id: 'l_min', x: 246, y: 590, value: 0, type: 'input' },
    { id: 'l_max', x: 286, y: 590, value: 0, type: 'input' },
    { id: 'pitch', x: -10, y: 298, value: 0, type: 'input' },
    { id: 'a_max', x: 326, y: 470, value: 0, type: 'input' },
  ],
  dividerList: [
    { x: 6, y: 52, direction: 'horizontal' },
    { x: 157, y: 18, direction: 'horizontal' },
    { x: 314, y: 344, direction: 'horizontal' },
    { x: 129, y: 348, direction: 'horizontal' },
    { x: 275, y: 597, direction: 'horizontal' },
  ],
  extraFieldsList: [
    { name: 'pin_count', label: '引脚数：', type: 'input', value: 0, required: true },
    { name: 'select_pkgType', label: '重新提取信息：', type: 'select', value: 'son', options: PKG_TYPE_OPTIONS, required: true },
  ],
}
ALL_CONFIGS.sot23 = sot23Config
