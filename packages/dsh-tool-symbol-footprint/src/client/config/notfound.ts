import type { PkgConfig } from '../types.js'
import { ALL_CONFIGS, PKG_TYPE_OPTIONS } from '../types.js'

export const pkgTypeNotFoundConfig: PkgConfig = {
  DataPointList: [],
  dividerList: [],
  extraFieldsList: [
    { name: 'select_pkgType', label: '重新提取信息：', type: 'select', value: 'sop', options: PKG_TYPE_OPTIONS, required: true },
  ],
}
ALL_CONFIGS.pkgTypeNotFound = pkgTypeNotFoundConfig
