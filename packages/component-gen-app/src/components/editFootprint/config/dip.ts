import type { PkgConfig } from '../types.js'
import { ALL_CONFIGS, PKG_TYPE_OPTIONS } from '../types.js'

export const dipConfig: PkgConfig = {
  DataPointList: [
    { id: 'b_max', x: 190, y: -19, value: '', type: 'input' },
    { id: 'b_min', x: 145, y: -19, value: '', type: 'input' },
    { id: 'd_max', x: 152, y: 196, value: '', type: 'input' },
    { id: 'd_min', x: 112, y: 196, value: '', type: 'input' },
    { id: 'e_max', x: 324, y: 164, value: '', type: 'input' },
    { id: 'e_min', x: 286, y: 164, value: '', type: 'input' },
    { id: 'pitch', x: 140, y: 156, value: '', type: 'input' },
    { id: 'row_spacing', x: 150, y: 250, value: '', type: 'input' },
  ],
  dividerList: [
    { x: 177, y: -13, direction: 'horizontal' },
    { x: 141, y: 203, direction: 'horizontal' },
    { x: 316, y: 171, direction: 'horizontal' },
  ],
  extraFieldsList: [
    { name: 'pin_count', label: '引脚数：', type: 'input', value: '', required: true },
    { name: 'select_pkgType', label: '重新提取信息：', type: 'select', value: 'dip', options: PKG_TYPE_OPTIONS, required: true },
  ],
}
ALL_CONFIGS.dip = dipConfig
