# 信号标签按侧对齐

视觉目标沿用用户提供的 [左右参考](../../assets/drawing-patterns/reference-label-sides.png) 和 [上下参考](../../assets/drawing-patterns/reference-label-vertical.png)。它们只说明排版，不提供可照抄的芯片接法。

| 引脚侧 | 引线 | 标签方向 | 生成效果 |
| --- | --- | --- | --- |
| 左/右 | 水平短直线，导线外端同列 | 水平，名称位于引线上方 | [左右](../../assets/drawing-patterns/label-sides.png) |
| 上/下 | 竖直短直线，导线外端同行 | 竖排，名称沿引线排列 | [上下](../../assets/drawing-patterns/label-vertical.png) |

先按实际符号引脚位置分组，分别调用 `attachPinLabels`；不按编号奇偶推断实际芯片的侧边。默认 textPosition="overWire"：名称放在线上，标签锚点位于导线上并从外端向符号方向展开；左右文字在水平线上方，上下文字沿竖线排列。length 默认 5.08 mm，作为最短长度；程序根据本组最长名称保守估计统一线长，不按每个名称分别拉长。导线外端同列/同行。需要原来的线外文字时显式传 textPosition:"outside"。必要时 alignAt 显式指定该列 x 或该行 y，使用与 target 一致的局部/全局坐标。

```js
import { attachPinLabels } from '<实际安装路径>/skills/kicad-schematic-design/assets/runtime.mjs';
const result = attachPinLabels(region, {
  reference: 'U1', direction: 'left',
  pins: [{ pin: '1', net: 'EN' }, { pin: '2', net: 'GPIO0' }],
});
```

代码中的路径与引脚由实际项目替换。[简短封装](../../assets/drawing-patterns/label-alignment.mjs) 可选；接口已由 runtime 与 builder 导出，不必复制封装才能使用。保留引脚所在的纵向/横向坐标，不排序重连、不改网络名。每组一次添加，仅包括确实需要标签、尚未接线的信号引脚；电源、地、NC 和已有外围连接单独处理。

返回 `{items,warnings}`。默认 minPitch 为 1.8 mm，是保守的文字行/列间距提示，不是完整避障器。显式 alignAt 使线长不足时返回 LABEL_LEAD_SHORT，增加整组空间或调整基线。出现 LABEL_PITCH_TIGHT 时只看相关区域，必要时拆组或局部定制引线，不把整侧都变成阶梯折线。相同引线轨道的引脚、重复引脚、向内的 alignAt 会在写入前拒绝。文字仍可能碰到其他对象，应预留外侧空间并按真实预览处理。单个复杂引脚可继续用 attachPinLabel 的显式折点通道，不要逐引脚随机设 length/lane。
