# ESP32 AP 热点 + WebSocket 规范 · zentimer-bio v1

## 为什么需要这条通道

`zentimer` 主 App 是**完全离线、无 INTERNET 权限**的 Android 应用。最贴合这一气质的做法是：ESP32 自己开一个 Wi-Fi 热点，并**自己托管伴侣页**，手机连上热点后打开 `http://192.168.4.1` 即可。

普通 HTTP + WebSocket 不需要 Web Bluetooth、不需要 HTTPS、不需要外网、不需要任何 App，因此：

| 平台 | Web Bluetooth 通道 | AP + WebSocket 通道 |
|---|---|---|
| Chrome / Edge（桌面、安卓） | ✅ | ✅ |
| Firefox | ❌ | ✅ |
| Safari macOS / iOS / iPadOS | ❌ | ✅ |
| 需要 HTTPS | 是 | 否 |
| 需要外网 | 是（GitHub Pages） | **否，完全离线** |

> 本项目 v1 的**主通道是 AP + WebSocket**，Web Bluetooth 是桌面调试与接第三方心率带的辅助通道。用户已明确「先不管 iOS」，但这条通道顺带把 iOS 覆盖问题一起解决了，成本为零。

## 连接流程

1. 固件启动后进入 AP 模式：`SSID = zentimer-bio-XXXX`（XXXX 取芯片 ID 后 4 位），无密码或默认密码（写在机身标签与 README）。
2. 手机/电脑连接该热点，浏览器访问 `http://192.168.4.1`。
3. ESP32 返回 `web/index.html`（固件内嵌，gzip 后存放于 SPIFFS/LittleFS）。
4. 页面用 `new WebSocket('ws://192.168.4.1/ws')`（同源时 `ws://' + location.host + '/ws'`）建立长连接。
5. 页面点「开始记录」→ 发送 `{"cmd":"start","rate_hz":10}`；设备以 10 Hz 推送指标帧。
6. 页面点「结束」→ 发送 `{"cmd":"stop"}`，设备停止推送并记录会话结束。

## 消息格式（设备 → 浏览器，每 100 ms 一条 JSON）

```json
{"t_ms":12340,"hr":61.2,"rr_ms":982.4,"br":5.98,
 "eda":1.21,"motion":0.012,"quality":0.97,"coherence":0.82}
```

字段与 `protocol/schema.json` 的 `samples` 项完全一致。`t_ms` 为会话内相对毫秒。浏览器侧 `WsAdapter` 收到后直接 `emit('sample', s)`，与 BLE 通道共用同一套指标计算与会话存储。

## 设备 → 浏览器的其他消息

```json
{"type":"status","fw":"0.1.0","sensor":"MAX30102","rate_hz":10,"battery":87}
{"type":"error","code":"SENSOR_LOST","message":"MAX30102 未响应"}
```

## 浏览器 → 设备

```json
{"cmd":"start","rate_hz":10}
{"cmd":"stop"}
{"cmd":"config","guide":0,"raw_ppg":false}
{"cmd":"calibrate","br_target":6.0}
```

## 功耗与取舍

| 模式 | 典型电流 | 500 mAh 续航 | 适用 |
|---|---|---|---|
| 仅 BLE | ~30–60 mA | 8 h+ | 阶段 2 电池供电默认 |
| WiFi AP + WebSocket | ~120–200 mA | 2.5–4 h | 阶段 1 USB 供电 / 长时间桌面使用 |

**阶段 1 一律 USB 供电，不装电池**，因此不存在这个取舍。阶段 2 固件提供模式切换（长按按钮 3 秒 或 控制帧 `{"cmd":"config","radio":"ble"}`），默认 BLE；需要全平台/离线自持时切到 AP。

## 待办（阶段 2 固件）

- [ ] AP 模式与 STA 模式（连家里 Wi-Fi）二选一，通过配网页切换
- [ ] 内嵌网页的 gzip 压缩与 OTA 更新
- [ ] 断连后本地缓存到 Flash，会话结束导出 CSV
- [ ] mDNS：`http://zentimer-bio.local`（可选）
