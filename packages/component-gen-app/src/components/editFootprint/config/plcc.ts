import type { PkgConfig } from '../types.js'
import { ALL_CONFIGS, PKG_TYPE_OPTIONS } from '../types.js'

export const plccConfig: PkgConfig = {
  DataPointList: [
    { id: 'b_max', x: 22, y: 617, value: 0, type: 'input' },
    { id: 'b_min', x: -19, y: 617, value: 0, type: 'input' },
    { id: 'd1_max', x: 180, y: -19, value: 0, type: 'input' },
    { id: 'd1_min', x: 136, y: -19, value: 0, type: 'input' },
    { id: 'd_max', x: 184, y: 300, value: 0, type: 'input' },
    { id: 'd_min', x: 144, y: 300, value: 0, type: 'input' },
    { id: 'e1_max', x: 319, y: 300, value: 0, type: 'input' },
    { id: 'e1_min', x: 276, y: 300, value: 0, type: 'input' },
    { id: 'e_max', x: 30, y: 270, value: 0, type: 'input' },
    { id: 'e_min', x: -15, y: 270, value: 0, type: 'input' },
    { id: 'pitch', x: -8, y: 400, value: 0, type: 'input' },
    { id: 'd2_max', x: 182, y: 344, value: 0, type: 'input' },
    { id: 'd2_min', x: 140, y: 344, value: 0, type: 'input' },
    { id: 'e2_max', x: 321, y: 644, value: 0, type: 'input' },
    { id: 'e2_min', x: 278, y: 644, value: 0, type: 'input' },
  ],
  dividerList: [
    { x: 12, y: 625, direction: 'horizontal' },
    { x: 168, y: -11, direction: 'horizontal' },
    { x: 172, y: 307, direction: 'horizontal' },
    { x: 308, y: 307, direction: 'horizontal' },
    { x: 18, y: 278, direction: 'horizontal' },
    { x: 172, y: 351, direction: 'horizontal' },
    { x: 310, y: 651, direction: 'horizontal' },
  ],
  extraFieldsList: [
    { name: 'pin_count_d', label: '水平引脚数：', type: 'input', value: 0, required: true },
    { name: 'pin_count_e', label: '垂直引脚数：', type: 'input', value: 0, required: true },
    { name: 'select_pkgType', label: '重新提取信息：', type: 'select', value: 'plcc', options: PKG_TYPE_OPTIONS, required: true },
  ],
}
ALL_CONFIGS.plcc = plccConfig
