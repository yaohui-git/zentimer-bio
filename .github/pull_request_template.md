## 改了什么

## 为什么

## 关联
- 关联 issue / ADR：
- 是否改动协议（gatt.md / ws.md / schema.json）：是 / 否
  - 若是，**UUID 与帧偏移是否保持不变**：是 / 否

## 自检
- [ ] 未改动 `yaohui-git/zentimer` 主仓库的任何内容
- [ ] 未复制主仓库的第三方音频 / 图片 / 图标素材
- [ ] 未出现疗效宣称或「压力分数」等禁止措辞（见 `docs/disclaimer.md`）
- [ ] `python3 -m py_compile tools/*.py` 通过
- [ ] `node --check web/zenbio.js` 通过
- [ ] `tools/synth_ppg.py` 三场景断言通过
- [ ] 新增代码带 SPDX 许可标识
