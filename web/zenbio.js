/* zentimer-bio 伴侣页核心库（无构建、无依赖、file:// 直接可用）
 *
 * 设计前提（见 docs/adr-001-architecture.md）：
 *   zentimer 主 App 是离线 Kotlin/Compose 应用，无 INTERNET 权限、不申请蓝牙权限。
 *   因此本项目不改动主 App，独立提供「伴侣页」，通过数据源适配器接硬件。
 *
 * 数据源适配器：
 *   SimAdapter   合成数据，零硬件即可跑通全流程（阶段 0）
 *   BleAdapter   ① 标准 BLE 心率服务 0x180D（心率带，读 RR 间期算 HRV）
 *                ② 自定义 Zen Biofeedback Service（自研指夹，20 字节二进制帧）
 *   WsAdapter    ESP32 开 AP 热点，页面由设备自托管，WebSocket 推流（全平台通用）
 *   FileAdapter  导入 .json / .csv 回放
 */
(function (global) {
  'use strict';

  // ---- 自定义 GATT UUID（与 protocol/gatt.md 一致）----
  var UUID = {
    ZEN_SERVICE: 'c8f3e000-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
    ZEN_METRICS: 'c8f3e001-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
    ZEN_RAW:     'c8f3e002-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
    ZEN_CONTROL: 'c8f3e003-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
    ZEN_INFO:    'c8f3e004-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
    HEART_RATE_SERVICE: 'heart_rate',
    HEART_RATE_MEASUREMENT: 'heart_rate_measurement',
    BATTERY_SERVICE: 'battery_service'
  };

  // ---- 极简事件总线 ----
  function Emitter() { this._h = {}; }
  Emitter.prototype.on = function (e, fn) {
    (this._h[e] || (this._h[e] = [])).push(fn); return this;
  };
  Emitter.prototype.off = function (e, fn) {
    if (!this._h[e]) return this;
    this._h[e] = this._h[e].filter(function (f) { return f !== fn; }); return this;
  };
  Emitter.prototype.emit = function (e, data) {
    (this._h[e] || []).forEach(function (fn) { fn(data); });
    (this._h['*'] || []).forEach(function (fn) { fn({ type: e, data: data }); });
  };

  // ---- 滚动指标窗口 ----
  // 注意：不使用 LF/HF 作为压力指标。约 6 次/分共振呼吸时 LF 功率刻意升高，
  // 那是训练目标而非压力。主指标为 RMSSD / 0.1Hz 相干性 / 静稳度。
  function Metrics(windowSize) {
    this.size = windowSize || 120;   // 12 秒 @10Hz
    this.buf = [];
    this.rr = [];
    this.br = [];
  }
  Metrics.prototype.push = function (s) {
    this.buf.push(s);
    if (this.buf.length > this.size) this.buf.shift();
    if (s.rr_ms != null) {
      this.rr.push(s.rr_ms);
      if (this.rr.length > this.size) this.rr.shift();
    }
    if (s.br != null) {
      this.br.push(s.br);
      if (this.br.length > this.size) this.br.shift();
    }
    return this.snapshot();
  };
  Metrics.prototype.snapshot = function () {
    var rr = this.rr.filter(function (v, i, a) {
      if (v < 300 || v > 2000) return false;
      return i === 0 || Math.abs(v - a[i - 1]) < 0.2 * v;
    });
    var rmssd = null, sdnn = null;
    if (rr.length > 2) {
      var sum = 0;
      for (var i = 1; i < rr.length; i++) { var d = rr[i] - rr[i - 1]; sum += d * d; }
      rmssd = Math.sqrt(sum / (rr.length - 1));
      var mean = rr.reduce(function (a, b) { return a + b; }, 0) / rr.length;
      sdnn = Math.sqrt(rr.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / rr.length);
    }
    var last = this.buf[this.buf.length - 1] || {};
    var qs = this.buf.map(function (x) { return x.quality == null ? 1 : x.quality; });
    var ms = this.buf.map(function (x) { return x.motion == null ? 0 : x.motion; });
    var avg = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; };
    return {
      hr: last.hr != null ? last.hr : null,
      rmssd: rmssd,
      sdnn: sdnn,
      br: avg(this.br) || null,
      coherence: last.coherence != null ? last.coherence : null,
      quality: avg(qs),
      stillness: 1 - Math.min(avg(ms), 1),
      beatCount: rr.length
    };
  };

  // ---- 标准 Heart Rate Measurement (0x2A37) 解析 ----
  // flags bit0: HR 是 16 位；bit4: 含 RR 间期（单位 1/1024 秒）
  function parseHeartRate(view) {
    var flags = view.getUint8(0);
    var hr16 = (flags & 0x01) !== 0;
    var hasRR = (flags & 0x10) !== 0;
    var hr = hr16 ? view.getUint16(1, true) : view.getUint8(1);
    var offset = hr16 ? 3 : 2;
    var rr = [];
    if (hasRR) {
      while (offset + 1 < view.byteLength) {
        rr.push(view.getUint16(offset, true) / 1024 * 1000); // -> ms
        offset += 2;
      }
    }
    return { hr: hr, rr: rr };
  }

  // ---- 自定义 20 字节指标帧解析 ----
  function parseZenFrame(view) {
    if (view.byteLength < 14 || view.getUint8(0) !== 1) return null;
    return {
      t_ms: view.getUint16(1, true),
      rr_ms: view.getUint16(3, true),
      hr: view.getUint16(5, true) / 10,
      br: view.getUint16(7, true) / 100,
      eda: view.getUint16(9, true) / 100,
      motion: view.getUint8(11) / 100,
      quality: view.getUint8(12) / 100,
      coherence: view.getUint8(13) / 100
    };
  }

  // ===================== 适配器 =====================

  /** 合成数据源：零硬件跑通全流程。与 tools/synth_ppg.py 同思路的简化版。 */
  function SimAdapter(opts) {
    Emitter.call(this);
    opts = opts || {};
    this.brTarget = opts.br || 6.0;
    this.hrBase = opts.hr || 62;
    this.scenario = opts.scenario || 'settled';
    this._timer = null;
    this._t = 0;
    this._phase = 0;
    this._seed = opts.seed || 42;
    this._rnd = this._mulberry(this._seed);
  }
  SimAdapter.prototype = Object.create(Emitter.prototype);
  SimAdapter.prototype.constructor = SimAdapter;
  SimAdapter.prototype._mulberry = function (a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  };
  SimAdapter.prototype.start = function () {
    var self = this;
    this._t = 0; this._phase = 0;
    this.emit('status', { state: 'connected', label: '模拟设备' });
    this._timer = setInterval(function () { self._tick(); }, 100);
  };
  SimAdapter.prototype._tick = function () {
    var settle = Math.min(this._t / 90, 1);
    var br = this.brTarget + 2.5 * (1 - settle) + 0.18 * Math.sin(2 * Math.PI * this._t / 47);
    if (this.scenario === 'restless') br += 1.4 * Math.sin(2 * Math.PI * this._t / 13);
    this._phase += 2 * Math.PI * br / 60 * 0.1;
    var rsaAmp = Math.abs(this.brTarget - 6) < 0.6 ? 90 : 42;
    var rr = 60000 / this.hrBase
      + rsaAmp * Math.sin(this._phase - 0.6)
      + (this._rnd() - 0.5) * 2 * 38
      + 12 * Math.sin(2 * Math.PI * this._t / 180);
    rr = Math.max(380, Math.min(1600, rr));
    var motion = Math.max(0, Math.min(1, (this._rnd() - 0.5) * 0.02 + 0.012));
    if (this.scenario === 'restless' && Math.abs(this._t % 115 - 95) < 2) motion += 0.35;
    var quality = Math.max(this.scenario === 'poor_signal' ? 0.1 : 0.35,
      Math.min(1, 0.985 - 0.35 * motion - 0.03 * Math.abs(Math.sin(2 * Math.PI * this._t / 31))));
    var target = Math.exp(-Math.pow((br - 6) / 1.6, 2));
    var s = {
      t_ms: Math.round(this._t * 1000),
      hr: Math.round(60000 / rr * 10) / 10,
      rr_ms: Math.round(rr * 10) / 10,
      br: Math.round(br * 100) / 100,
      eda: Math.round((1.1 + 0.45 * (1 - settle) + this._rnd() * 0.05) * 1000) / 1000,
      motion: Math.round(Math.min(1, motion) * 1000) / 1000,
      quality: Math.round(quality * 1000) / 1000,
      coherence: Math.round(Math.max(0, Math.min(1, 0.35 + 0.55 * target * settle)) * 1000) / 1000
    };
    this.emit('sample', s);
    this._t += 0.1;
  };
  SimAdapter.prototype.stop = function () {
    clearInterval(this._timer); this._timer = null;
    this.emit('status', { state: 'idle', label: '已停止' });
  };

  /** Web Bluetooth 适配器（Chrome / Edge / Android Chrome）。
   *  支持两类设备：标准心率带（0x180D，带 RR 间期）、自研指夹（自定义服务）。 */
  function BleAdapter() {
    Emitter.call(this);
    this.device = null; this.server = null;
    this._t0 = Date.now();
    this._custom = false;
  }
  BleAdapter.prototype = Object.create(Emitter.prototype);
  BleAdapter.prototype.constructor = BleAdapter;
  BleAdapter.isSupported = function () {
    return !!(global.navigator && navigator.bluetooth);
  };
  BleAdapter.prototype.connect = function () {
    var self = this;
    if (!BleAdapter.isSupported()) {
      return Promise.reject(new Error('当前浏览器不支持 Web Bluetooth。请用桌面或安卓的 Chrome / Edge；Safari、Firefox 与 iOS 不支持。'));
    }
    this.emit('status', { state: 'connecting', label: '正在选择设备…' });
    return navigator.bluetooth.requestDevice({
      filters: [{ services: [UUID.HEART_RATE_SERVICE] }, { services: [UUID.ZEN_SERVICE] }],
      optionalServices: [UUID.HEART_RATE_SERVICE, UUID.ZEN_SERVICE, UUID.BATTERY_SERVICE]
    }).then(function (device) {
      self.device = device;
      device.addEventListener('gattserverdisconnected', function () {
        self.emit('status', { state: 'idle', label: '设备已断开' });
      });
      return device.gatt.connect();
    }).then(function (server) {
      self.server = server; self._t0 = Date.now();
      // 优先自研设备（有完整指标）；否则退回标准心率带
      return server.getPrimaryService(UUID.ZEN_SERVICE)
        .then(function (svc) { self._custom = true; return self._bindCustom(svc); })
        .catch(function () { self._custom = false; return self._bindStandard(server); });
    }).then(function () {
      self.emit('status', {
        state: 'connected',
        label: (self._custom ? 'zentimer-bio 指夹' : '标准 BLE 心率带') + ' · ' + (self.device.name || 'BLE')
      });
    });
  };
  BleAdapter.prototype._bindCustom = function (svc) {
    var self = this;
    return svc.getCharacteristic(UUID.ZEN_METRICS).then(function (ch) {
      ch.addEventListener('characteristicvaluechanged', function (e) {
        var s = parseZenFrame(e.target.value);
        if (s) { s.t_ms = Date.now() - self._t0; self.emit('sample', s); }
      });
      return ch.startNotifications();
    });
  };
  BleAdapter.prototype._bindStandard = function (server) {
    var self = this;
    return server.getPrimaryService(UUID.HEART_RATE_SERVICE)
      .then(function (svc) { return svc.getCharacteristic(UUID.HEART_RATE_MEASUREMENT); })
      .then(function (ch) {
        ch.addEventListener('characteristicvaluechanged', function (e) {
          var r = parseHeartRate(e.target.value);
          // 标准心率带只给 HR + RR；呼吸/相干性由浏览器侧从 RR 派生
          var s = {
            t_ms: Date.now() - self._t0,
            hr: r.hr,
            rr_ms: r.rr.length ? r.rr[r.rr.length - 1] : null,
            br: null, eda: null, motion: 0, quality: 1, coherence: null
          };
          self.emit('sample', s);
        });
        return ch.startNotifications();
      });
  };
  BleAdapter.prototype.stop = function () {
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    this.emit('status', { state: 'idle', label: '已断开' });
  };

  /** ESP32 AP 热点模式：页面由设备自托管，WebSocket 同源推流。
   *  普通 HTTP/WebSocket，不需要 Web Bluetooth、不需要 HTTPS、不需要外网，
   *  因此 iPhone Safari / Firefox 也能用（顺带解决了桌面方案的兼容缺口）。 */
  function WsAdapter(url) {
    Emitter.call(this);
    this.url = url || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    this.ws = null; this._t0 = Date.now();
  }
  WsAdapter.prototype = Object.create(Emitter.prototype);
  WsAdapter.prototype.constructor = WsAdapter;
  WsAdapter.prototype.start = function () {
    var self = this;
    this.emit('status', { state: 'connecting', label: '连接设备热点…' });
    try { this.ws = new WebSocket(this.url); }
    catch (e) { this.emit('error', e); return; }
    this.ws.onopen = function () {
      self._t0 = Date.now();
      self.emit('status', { state: 'connected', label: 'ESP32 AP 热点 · WebSocket' });
    };
    this.ws.onmessage = function (ev) {
      try {
        var s = JSON.parse(ev.data);
        if (s && s.t_ms != null) self.emit('sample', s);
      } catch (e) { /* 忽略坏帧 */ }
    };
    this.ws.onerror = function () { self.emit('error', new Error('WebSocket 连接失败，请确认已连上设备热点并打开 http://192.168.4.1')); };
    this.ws.onclose = function () { self.emit('status', { state: 'idle', label: '热点已断开' }); };
  };
  WsAdapter.prototype.stop = function () {
    if (this.ws) this.ws.close();
    this.emit('status', { state: 'idle', label: '已停止' });
  };

  /** 文件回放：导入 zentimer.bio.v1 JSON 或 CSV。 */
  function FileAdapter(speed) {
    Emitter.call(this);
    this.speed = speed || 1;
    this._timer = null;
  }
  FileAdapter.prototype = Object.create(Emitter.prototype);
  FileAdapter.prototype.constructor = FileAdapter;
  FileAdapter.prototype.loadFile = function (file) {
    var self = this;
    return file.text().then(function (txt) {
      var samples;
      if (file.name.toLowerCase().endsWith('.csv')) {
        var lines = txt.trim().split(/\r?\n/);
        var head = lines[0].split(',');
        samples = lines.slice(1).map(function (l) {
          var c = l.split(','); var o = {};
          head.forEach(function (k, i) { var v = parseFloat(c[i]); o[k.trim()] = isNaN(v) ? null : v; });
          return o;
        });
      } else {
        var d = JSON.parse(txt);
        samples = d.samples || [];
      }
      self.emit('status', { state: 'connected', label: '回放 ' + file.name + '（' + samples.length + ' 点）' });
      return samples;
    });
  };
  FileAdapter.prototype.replay = function (samples) {
    var self = this, i = 0;
    this.stop();
    this._timer = setInterval(function () {
      if (i >= samples.length) { self.stop(); return; }
      var s = Object.assign({}, samples[i]);
      s.t_ms = Date.now() - self._t0;
      self.emit('sample', s);
      i++;
    }, 100 / this.speed);
  };
  FileAdapter.prototype.stop = function () {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.emit('status', { state: 'idle', label: '回放结束' });
  };

  // ===================== 会话与本地存储 =====================

  var STORE_KEY = 'zentimer.bio.sessions.v1';
  var MAX_SESSIONS = 8; // localStorage 容量有限，建议及时导出归档

  var storage = {
    list: function () {
      try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); }
      catch (e) { return []; }
    },
    save: function (session) {
      var all = storage.list();
      all.unshift(session);
      while (all.length > MAX_SESSIONS) all.pop();
      try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); return true; }
      catch (e) { return false; } // 配额满：提示用户导出
    },
    clear: function () { localStorage.removeItem(STORE_KEY); }
  };

  function Session(adapter, meta) {
    Emitter.call(this);
    this.adapter = adapter;
    this.meta = meta || {};
    this.metrics = new Metrics(120);
    this.samples = [];
    this.running = false;
    this.startedAt = null;
    this._onSample = this._handle.bind(this);
    this._onStatus = function (s) { this.emit('status', s); }.bind(this);
    this._onError = function (e) { this.emit('error', e); }.bind(this);
  }
  Session.prototype = Object.create(Emitter.prototype);
  Session.prototype.constructor = Session;
  Session.prototype.start = function () {
    if (this.running) return;
    this.samples = []; this.metrics = new Metrics(120);
    this.startedAt = new Date(); this.running = true;
    this.adapter.on('sample', this._onSample);
    this.adapter.on('status', this._onStatus);
    this.adapter.on('error', this._onError);
    if (this.adapter.start) this.adapter.start();
    this.emit('started', this.startedAt);
  };
  Session.prototype._handle = function (s) {
    if (!this.running) return;
    this.samples.push(s);
    var snap = this.metrics.push(s);
    this.emit('sample', s);
    this.emit('metrics', snap);
  };
  Session.prototype.stop = function (subjective) {
    if (!this.running) return null;
    this.running = false;
    if (this.adapter.stop) this.adapter.stop();
    this.adapter.off('sample', this._onSample);
    this.adapter.off('status', this._onStatus);
    this.adapter.off('error', this._onError);
    var now = new Date();
    var session = {
      schema: 'zentimer.bio.v1',
      session_id: this.startedAt.toISOString().slice(0, 10) + '-' +
        String(this.startedAt.getTime()).slice(-6),
      started_at: this.startedAt.toISOString(),
      ended_at: now.toISOString(),
      source: this.meta.source || 'sim',
      device: this.meta.device || { fw: 'web-0.1', sensor: 'unknown', rate_hz: 10 },
      preset: this.meta.preset || {},
      samples: this.samples,
      subjective: subjective || { depth: null, tags: [], note: '未填写' },
      summary: this._summary()
    };
    this.emit('ended', session);
    return session;
  };
  Session.prototype._summary = function () {
    var snap = this.metrics.snapshot();
    var brs = this.samples.map(function (s) { return s.br; }).filter(function (v) { return v != null; });
    var qs = this.samples.map(function (s) { return s.quality == null ? 1 : s.quality; });
    var ms = this.samples.map(function (s) { return s.motion == null ? 0 : s.motion; });
    var avg = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; };
    return {
      duration_s: this.samples.length ? (this.samples[this.samples.length - 1].t_ms - this.samples[0].t_ms) / 1000 : 0,
      mean_hr: snap.hr, rmssd_ms: snap.rmssd == null ? null : Math.round(snap.rmssd * 10) / 10,
      sdnn_ms: snap.sdnn == null ? null : Math.round(snap.sdnn * 10) / 10,
      mean_br: brs.length ? Math.round(avg(brs) * 100) / 100 : null,
      coherence_score: snap.coherence,
      stillness: Math.round(snap.stillness * 1000) / 1000,
      valid_ratio: Math.round((qs.filter(function (v) { return v >= 0.5; }).length / Math.max(qs.length, 1)) * 1000) / 1000,
      mean_motion: Math.round(avg(ms) * 1000) / 1000
    };
  };

  function download(session, asCsv) {
    var name = 'zentimer-' + session.session_id + (asCsv ? '.csv' : '.json');
    var text, mime;
    if (asCsv) {
      var keys = ['t_ms', 'hr', 'rr_ms', 'br', 'eda', 'motion', 'quality', 'coherence'];
      text = keys.join(',') + '\n' + session.samples.map(function (s) {
        return keys.map(function (k) { return s[k] == null ? '' : s[k]; }).join(',');
      }).join('\n');
      mime = 'text/csv;charset=utf-8';
    } else {
      text = JSON.stringify(session, null, 2);
      mime = 'application/json;charset=utf-8';
    }
    var blob = new Blob([text], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  global.ZenBio = {
    UUID: UUID, Emitter: Emitter, Metrics: Metrics,
    parseHeartRate: parseHeartRate, parseZenFrame: parseZenFrame,
    SimAdapter: SimAdapter, BleAdapter: BleAdapter,
    WsAdapter: WsAdapter, FileAdapter: FileAdapter,
    Session: Session, storage: storage, download: download
  };
})(window);
