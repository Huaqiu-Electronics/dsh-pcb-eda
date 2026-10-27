# 平铺模块外框与说明

为已有单页副本或新图组织功能分区时读取。布局验收和迭代停止统一按 [布局交付](layout-delivery.md)，本页只规定分区表达。

## 分区与文字

- 按完整功能分区，单一功能电路一个框；不为每个 LED、按键或去耦支路单独建框。外围靠近所属芯片，输入→处理→输出组织，主控与支持电路成组。
- 使用无填充、统一线宽外框，顶部短标题、底部默认一行说明；必要接法、额定限制和警告可补短注释。标题必须写入实际图纸，聊天说明不能替代。
- 说明依据真实电路，不复写来源长介绍；例如“3.3 V 稳压；输入 5 V，负载条件待确认”只表达已知及未决内容，不暗示额定性能已验证。
- 同页文字风格、边缘对齐和模块间距一致，不强求不同电路等高；给属性、长型号、接口和标题栏留空间。框线不穿器件、文字或接点，相邻框不嵌套或侵入。

## 选择生成方式

| 场景 | 使用方式 |
| --- | --- |
| 脚本新绘电路 | 用 sch.region 预先规划 origin/size；坐标与 API 见 [编程接口](programming.md#坐标与区域)。不再为 region 添加第二个 frame。 |
| 复用已有内容 | 用 frames/autoBounds 或 sch.frame；参数及对象选择见 [编辑参考](editing.md#create一次生成副本)。已有清楚布局保留。 |

先安排电路及文字，再按内容确定外框。自动框只计算范围，不移动、缩放电路或避免内容重叠。空间不足扩大区域；必要位移应同步整组连接，不为加框改变网络和参数。

清理来源时在副本中先 list 普通文字，再用 removeTextUuids 精确删除冗余介绍；更换旧框按 UUID 删除。保留器件属性、数值、引脚、电气标签及必要图片/限制，原始来源完整保存。

模板参数由 [frame-style.json](../templates/frame-style.json) 统一控制，不在脚本重复抄写。旧 rectangle 不计入自动内容范围，图片和文字采用保守边界；boundsError 时用手动框并预览，不扫描像素或自写测量器。仅研究格式实现时查 [KiCad 图片解析](https://github.com/KiCad/kicad/blob/10.0.0/eeschema/sch_io/kicad_sexpr/sch_io_kicad_sexpr_parser.cpp#L3340) 与 [PNG 分辨率规则](https://github.com/wxWidgets/wxWidgets/blob/v3.2.9/src/common/imagpng.cpp#L340)。
