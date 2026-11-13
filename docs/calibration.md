# 校准与实验方案

## 1. 传感器校准（S1）

| 项 | 做法 | 合格线 |
|---|---|---|
| 心率对照 | 同场同时佩戴指夹与参考心率带（Polar H9 / CooSpo），静止 10 分钟，比对平均 HR | 误差 ≤ 3 bpm |
| RR 间期对照 | 导出两者 RR 序列，比对 RMSSD 与逐拍差值 | RMSSD 相对误差 ≤ 15%（PPG 比 ECG 略差属正常） |
| 呼吸率对照 | 用节拍器按 4.5 / 5 / 5.5 / 6 / 6.5 次/分各引导 2 分钟，看 PPG 派生呼吸率 | 误差 ≤ 1 次/分 |
| 信号质量 | 手指压力过松/过紧/低温/涂指甲油各测 2 分钟，记录 `quality` | 报告里给出佩戴建议 |
| 伪迹 | 故意轻微动手 3 次，看 `motion` 与 `quality` 是否同步下降 | 低质量段不进入指标计算 |

> 小米手环 3/4 只作瞬时心率的粗略对照，**不参与 RR / HRV 校准**（不提供标准 RR 间期流）。

## 2. 个人共振频率标定协议（S2）

约 6 次/分是群体平均值，个体差异存在（约 4.5–6.5 次/分）。协议：

1. 每场静坐前静息 2 分钟作基线；
2. 依次按 **4.5 / 5.0 / 5.5 / 6.0 / 6.5 次/分** 各引导 2 分钟（伴侣页的「目标呼吸」下拉框已备好）；
3. 每段记录 RMSSD、0.1 Hz 谱峰锐度、HR–呼吸相位一致性；
4. 取 HRV 响应最大的频率作为个人共振频率，写入伴侣页设置；
5. 后续以此频率生成呼吸引导节律。

注意：此协议是**自我观察实验**，不是临床评估；结果只用于调整引导节律，不作任何健康判断。

## 3. 真人数据积累协议（最稀缺的资源）

每场记录：

- 日期时间、时长、是否用引导、引导频率；
- 客观指标流（伴侣页自动导出 JSON）；
- **主观自评（必填）**：深度 1–10、标签、备注；
- 干扰因素：咖啡因、睡眠、当天压力、环境噪声、是否感冒。

建议节奏：连续 4 周、每周 ≥ 4 场、每场 ≥ 10 分钟。积累到约 20 场后再看「主观深度 ↔ RMSSD / 相干性」的相关性，不要拿 3 场就下结论。

标注模板见 `data/annotation_template.csv`。

## 4. 算法验收数据集

`tools/synth_ppg.py` 提供三种可复现场景，用于 CI 与回归测试：

```bash
python3 tools/synth_ppg.py --minutes 10 --br 6   --scenario settled     --out /tmp/settled.json
python3 tools/synth_ppg.py --minutes 10 --br 12  --scenario restless    --out /tmp/restless.json
python3 tools/synth_ppg.py --minutes 10 --br 6   --scenario poor_signal --out /tmp/poor.json
python3 tools/analyze.py /tmp/settled.json
```

期望：`settled` 的谱峰落在 0.09–0.11 Hz、`valid_ratio` > 0.9；`poor_signal` 的 `valid_ratio` 显著下降；`restless` 的 `stillness` 下降。任何算法改动都应保持这三条断言。
