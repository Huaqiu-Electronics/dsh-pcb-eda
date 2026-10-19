# 层次工程生成

每个子页可使用下载原图、修改后的副本或模型脚本生成的单页。脚本生成的子页先保存，再在明确的实际网络接点添加层次标签并读取端口；仅有普通标签或连接器不能直接作为层次端口。来源保持不变，新增/修改发生在 work/ 或候选目录。

每个子页写明确连接表：源端口、根图网络、用途、供电电压/信号电平与实际接点。检查共地、极性、使能、必要上拉、负载条件与外部接口。以端口名称规划 connections，不以标签电气方向阻断。暂不连接的端口放入 unconnectedPorts，不用编造网络代替。

```js
create_kicad_hierarchy({
  projectName: 'example', title: '设计标题', targetDir: '<design>/.candidate/<run-id>',
  sheets: [{ name: 'power', sourcePath: '<design>/work/power.kicad_sch',
    connections: { VOUT: 'VCC_3V3', GND: 'GND' }, unconnectedPorts: ['STATUS'] }],
});
```

targetDir 是已创建的候选根目录，工具输出到其 schematic/，不能把 targetDir 设为这个输出子目录。每个已声明端口必须恰好映射或明确未连接。只有带明确层次标签的单页图可作 sourcePath。同一来源使用多次时各实例由工具复制处理。

工具统一 UUID、引用编号、根图页引脚与可唯一匹配的符号缓存，工程副本中将方向统一 passive，源方向冲突由 directionConflicts 提示。预检一次列出端口及缓存差异，按具体诊断修正，不写临时 PowerShell 或 XML 网表修复脚本。

候选通过后，将生成的 schematic/ 内容连同其相对子页结构发布到固定 project/。替换文件依据本设计输出清单，不删除其他文件或旧文件中用户的未保存改动。保留根图、全部子页、所需符号库和配置；不只复制根图。预览根图及发生变化的子页，未完成页面在交付说明中标明。
