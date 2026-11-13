# 参与贡献

## 先读三份文件

1. [`docs/adr-001-architecture.md`](docs/adr-001-architecture.md) —— 为什么不改 `zentimer` 主 App
2. [`docs/disclaimer.md`](docs/disclaimer.md) —— 非医疗器械定位与禁止措辞
3. [`LICENSES/README.md`](LICENSES/README.md) —— 四层许可证矩阵

## 三条底线

- **不改主仓库**：`yaohui-git/zentimer` 的源码、权限清单、素材一律不动。集成提案另开 ADR 讨论。
- **不碰第三方素材**：主仓库的 `res/raw` 音频、`res/drawable-nodpi` 图片、启动图标人形剪影不在 Apache-2.0 内，禁止复制进本仓库。视觉一律 CSS/SVG 自绘。
- **不做疗效宣称**：PR、issue、文档、界面文案里不得出现改善焦虑/抑郁/失眠、降血压、压力分数等表述。

## 好的第一个 PR

- [ ] 给 `web/zenbio.js` 增加一个新数据源适配器（保持 `on('sample')` 接口一致）
- [ ] 给 `tools/analyze.py` 增加一个指标，并补一条 `synth_ppg.py` 场景断言
- [ ] 改进 `hardware/bom.csv` 的替代料与实测价格
- [ ] 修正文档错别字、补充组装照片位说明
- [ ] 在另一种开发板（XIAO ESP32-C3 / ESP32-S3）上复现 S1 并回传接线差异

## 代码约定

- 网页：**无构建、无依赖、无外部 CDN**（`web/flash.html` 烧录器除外），`file://` 直接打开可用
- JS：ES5 兼容写法，避免 ES module（避免 `file://` 下的 CORS 问题），中文注释
- Python：只依赖 numpy，`python3 -m py_compile` 必须通过
- 提交前跑：`bash tools/check.sh`（若存在）或 CI 中等价命令
- 协议变更必须先改 `protocol/*.md` 与 `protocol/schema.json`，再改代码；UUID 与帧偏移一经发布不得变动

## 报告问题

请附：浏览器/系统版本、开发板型号、固件版本、串口日志、`quality` 曲线截图、复现步骤。生理数据请先匿名化（去掉 session_id 时间戳、设备 ID、主观备注）。

## 行为准则

这是安静的项目。讨论就事论事，不催促维护者，不做人身评价，不在 issue 里争辩冥想方法优劣。
