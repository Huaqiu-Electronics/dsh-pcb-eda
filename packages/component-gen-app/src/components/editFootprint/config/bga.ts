import type { PkgConfig, ExtraField } from '../types.js'
import { ALL_CONFIGS, PKG_TYPE_OPTIONS } from '../types.js'

const _extra = (value: string): ExtraField[] => [
  { name: 'select_pkgType', label: '重新提取信息：', type: 'select', value, options: PKG_TYPE_OPTIONS, required: true },
]

export const bgaConfig: PkgConfig = {
  DataPointList: [
    { id: 'b_nom', x: -8, y: 0, value: 0, type: 'input' },
    { id: 'd_max', x: 148, y: 296, value: 0, type: 'input' },
    { id: 'd_min', x: 106, y: 296, value: 0, type: 'input' },
    { id: 'e_max', x: 319, y: 266, value: 0, type: 'input' },
    { id: 'e_min', x: 276, y: 266, value: 0, type: 'input' },
    { id: 'pitch_d', x: 110, y: 256, value: 0, type: 'input' },
    { id: 'pitch_e', x: 294, y: 97, value: 0, type: 'input' },
  ],
  dividerList: [
    { x: 134, y: 303, direction: 'horizontal' },
    { x: 308, y: 273, direction: 'horizontal' },
  ],
  extraFieldsList: [
    { name: 'rows', label: '行数：', type: 'input', value: 0, required: true },
    { name: 'columns', label: '列数：', type: 'input', value: 0, required: true },
    { name: 'pin_count', label: '引脚数：', type: 'input', value: 0, required: true },
    ..._extra('bga'),
  ],
}
ALL_CONFIGS.bga = bgaConfig
