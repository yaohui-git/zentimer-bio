# BLE GATT 规范 · zentimer-bio v1

固件与 `web/zenbio.js` 必须严格遵守本文件。UUID 一经发布不得变更，新增字段走新版本号。

## 1. 服务清单

| 服务 | UUID | 用途 | 是否必需 |
|---|---|---|---|
| Zen Biofeedback（自定义） | `c8f3e000-1a2b-4c3d-8e4f-5a6b7c8d9e0f` | 自研指夹完整指标 | 自研设备必需 |
| Heart Rate（标准） | `0x180D` | 兼容第三方心率带 / 生态 | 可选，建议实现 |
| Battery（标准） | `0x180F` | 电量 0x2A19 | 阶段 2 |
| Device Information（标准） | `0x180A` | 固件版本、型号 | 可选 |

> 自研设备**同时**广播 `0x180D` 与自定义服务，浏览器 `requestDevice` 的 `filters` 才能匹配到；伴侣页优先绑定自定义服务，取不到再退回标准心率服务。

## 2. Zen Biofeedback Service 特征

| 特征 | UUID 后缀 | 属性 | 方向 | 内容 |
|---|---|---|---|---|
| 实时指标 | `c8f3e001-...` | Notify | 设备 → 浏览器 | 20 字节二进制帧，10 Hz |
| 原始 PPG | `c8f3e002-...` | Notify | 设备 → 浏览器 | 50 Hz，默认关闭，调试用 |
| 设备控制 | `c8f3e003-...` | Write | 浏览器 → 设备 | 开始/结束会话、采样率、引导强度 |
| 设备信息 | `c8f3e004-...` | Read | 设备 → 浏览器 | UTF-8 JSON：fw / sensor / rate_hz / 校准值 |

自定义基础 UUID：`c8f3e000-1a2b-4c3d-8e4f-5a6b7c8d9e0f`（各特征依次 `e001`…`e004`）。

## 3. 实时指标帧（小端，固定 20 字节）

正好一个默认 BLE 包，无需 MTU 协商。

| 偏移 | 类型 | 字段 | 换算 | 说明 |
|---|---|---|---|---|
| 0 | uint8 | version | `=1` | 帧版本 |
| 1–2 | uint16 | t_ms | 原始值，回绕 | 会话内相对时间低 16 位 |
| 3–4 | uint16 | rr_ms | 原始值 ms | 最近一拍 RR 间期，**HRV 的唯一依据** |
| 5–6 | uint16 | hr_x10 | ÷10 | 瞬时心率 bpm |
| 7–8 | uint16 | br_x100 | ÷100 | 呼吸率 次/分（PPG 基线调制派生） |
| 9–10 | uint16 | eda_x100 | ÷100 | 皮肤电 μS；阶段 1 填 0 |
| 11 | uint8 | motion_x100 | ÷100 | 体动强度 0–1 |
| 12 | uint8 | quality_x100 | ÷100 | 信号质量 0–1；<0.5 的样本不参与指标 |
| 13 | uint8 | coherence_x100 | ÷100 | 0.1 Hz 相干性滚动分数 |
| 14–19 | — | reserved | 填 0 | 预留扩展 |

参考实现：`web/zenbio.js` 的 `parseZenFrame()`。

## 4. 标准 Heart Rate Measurement（0x2A37）

用于兼容第三方心率带（阶段 0 的真实 HRV 来源）。解析规则：

- `flags` bit0 = 1 → 心率为 uint16（否则 uint8），数据从偏移 1 开始；
- `flags` bit4 = 1 → 后续含 RR 间期，每 2 字节一个 uint16（小端），单位 **1/1024 秒**，乘 `1000/1024` 得 ms；
- 一帧可能含多个 RR 间期，需全部入队。

> **关键**：普通心率带只提供瞬时心率，HRV 必须依赖 RR 间期。选购参考心率带时务必确认「支持 RR interval / HRV」。小米手环 3/4 不提供标准 RR 间期流，因此**不能**作为 HRV 数据源（见 `docs/adr-001-architecture.md`）。

## 5. 设备控制帧（Write，JSON 文本）

```json
{"cmd":"start","rate_hz":10}
{"cmd":"stop"}
{"cmd":"config","guide":0,"led":0,"raw_ppg":false}
```

## 6. 版本兼容

- 帧 `version` 字段变化时，`parseZenFrame()` 应拒绝并返回 null，伴侣页提示升级固件；
- 会话文件格式版本独立管理，见 `protocol/schema.json` 的 `zentimer.bio.v1`；
- 新增指标优先使用保留字节，不改已有偏移。
