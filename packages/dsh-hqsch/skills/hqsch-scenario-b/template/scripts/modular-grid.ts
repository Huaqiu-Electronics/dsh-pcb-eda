/**
 * 槽位网格 —— P1 器件坐标与 P4a 模块框共用同一套矩形（ext，Y 向下）
 *
 * 页面 1800×1400；3×3 格，每格 500×400；整体水平居中，上边距 100 ext。
 * 器件坐标 = 槽内 origin + 20 ext 倍数偏移；框 = 槽位 ± FRAME_PAD（40）。
 */

export const PAGE_W = 1800;
export const PAGE_H = 1400;
export const COL_W = 500;
export const ROW_H = 400;
export const COLS = 3;
export const ROWS = 3;
export const FRAME_PAD = 40;
export const TITLE_DY = 24;
export const SNAP = 20;

export const GRID_OX = Math.round((PAGE_W - COLS * COL_W) / 2 / SNAP) * SNAP; // 150
export const GRID_OY = 100;

export interface Box { x1: number; y1: number; x2: number; y2: number }

export const snap = (v: number) => Math.round(v / SNAP) * SNAP;

/** 槽位 [col,row]，可选跨列/跨行 */
export function slot(col: number, row: number, colSpan = 1, rowSpan = 1): Box {
  return {
    x1: GRID_OX + col * COL_W,
    y1: GRID_OY + row * ROW_H,
    x2: GRID_OX + (col + colSpan) * COL_W,
    y2: GRID_OY + (row + rowSpan) * ROW_H,
  };
}

export function frameOf(s: Box): Box {
  return {
    x1: s.x1 - FRAME_PAD,
    y1: s.y1 - FRAME_PAD,
    x2: s.x2 + FRAME_PAD,
    y2: s.y2 + FRAME_PAD,
  };
}

/** 槽内锚点：距槽左上角的偏移（已 snap） */
export function at(s: Box, dx: number, dy: number) {
  return { x: snap(s.x1 + dx), y: snap(s.y1 + dy) };
}

/** STM32 最小系统 · 模块槽位（P1 / P4a 一致） */
export const STM32_SLOTS = {
  power: slot(0, 0),
  temp: slot(1, 0),
  boot: slot(2, 0),
  crystal: slot(0, 1),
  decouple: slot(1, 1),
  mcu: slot(2, 1, 1, 2),
  reset: slot(0, 2),
} as const;

export const STM32_MODULES: Array<{ key: keyof typeof STM32_SLOTS; title: string; box: Box }> = [
  { key: "power", title: "电源模块 5V→3.3V", box: STM32_SLOTS.power },
  { key: "temp", title: "温度传感模块 DS18B20", box: STM32_SLOTS.temp },
  { key: "boot", title: "BOOT 配置模块", box: STM32_SLOTS.boot },
  { key: "crystal", title: "晶振模块 8MHz HSE", box: STM32_SLOTS.crystal },
  { key: "decouple", title: "去耦电容模块", box: STM32_SLOTS.decouple },
  { key: "mcu", title: "主控模块 STM32F103C8T6", box: STM32_SLOTS.mcu },
  { key: "reset", title: "复位模块 NRST", box: STM32_SLOTS.reset },
];
