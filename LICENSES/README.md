# 许可证矩阵

开源硬件最容易踩的坑：**硬件设计和软件代码要分开授权**。软件许可（MIT/GPL/Apache）对「原理图、PCB、结构图」并不适用，CERN-OHL 是专为硬件写的、经 OSI 认可的协议。

| 资产 | 协议 | 覆盖文件 | 说明 |
|---|---|---|---|
| 代码 | **Apache-2.0** | `firmware/`、`web/`、`tools/`、CI 脚本 | 与 [`yaohui-git/zentimer`](https://github.com/yaohui-git/zentimer) 主仓库一致，便于未来代码复用或合并，无 GPL 兼容问题 |
| 硬件设计 | **CERN-OHL-S-2.0** | `hardware/kicad/`、`hardware/enclosure/`、`hardware/bom.csv`、`hardware/wiring.md` 中的设计性内容 | 强互惠：衍生硬件必须回开源完整可制造的设计源文件。若希望被商业产品集成，改用 `-W-2.0`（弱互惠）；只求最大传播用 `-P-2.0`（宽松） |
| 文档 | **CC-BY-4.0** | `docs/`、`README.md`、`ROADMAP.md`、本文件 | CERN OSPO 对文档的推荐协议 |
| 示例数据 | **CC0-1.0** | `data/sample_sessions/`、`data/annotation_template.csv` | 方便他人无顾虑地用于研究 |
| 商标 / 项目名 | 保留 | 「静息」「zentimer」「zentimer-bio」 | 不随开源许可授予，需在 README 写明 |

## 落地动作（发布前）

- [ ] 仓库根放 `LICENSE`（Apache-2.0 全文）
- [ ] `hardware/LICENSE`（CERN-OHL-S-2.0 全文）
- [ ] 每个源文件头加 SPDX 标识，例如 `// SPDX-License-Identifier: Apache-2.0`
- [ ] KiCad 工程与 STL 文件所在目录放一份 CERN-OHL-S-2.0
- [ ] README 写明四层协议，避免贡献者误以为「整个项目都是 Apache-2.0」

## 严禁事项

**不得**把主仓库 `zentimer` 的以下素材复制进本仓库：

- `res/raw/` 的 23 段颂钵/环境音录音
- `res/drawable-nodpi/` 的 36 张界面图
- 启动图标中的打坐人形剪影

主仓库 `NOTICE.md` / `ASSETS-NOTICE.md` 明确这些是**第三方资产，不在 Apache-2.0 范围内**。本仓库所有视觉一律 CSS/SVG 自绘，所有音效若需要则另行生成或采用明确 CC0/自录素材。

## 参考

- CERN OHL v2 三变体与官方许可建议：https://ospo.docs.cern.ch/recommendations/licensing/
- 中文解读（嘉立创）：https://m.jlc.com/pages-bbs/detail-page?feedShowId=1090212
