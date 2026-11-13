#!/usr/bin/env python3
"""zentimer-bio 合成生理数据生成器（阶段 0 用，无需任何硬件）。

生成符合 protocol/schema.json 的 zentimer.bio.v1 会话：
  · 逐拍 RR 间期（含呼吸性窦性心律不齐 RSA、随机 HRV、缓慢漂移）
  · 10 Hz 指标流：hr / rr_ms / br / eda / motion / quality / coherence
  · 可选 50 Hz 原始 PPG 波形（--raw，供固件算法联调）

只依赖 numpy。示例：

    python3 tools/synth_ppg.py --minutes 10 --br 6.0 --out data/sample_sessions/demo.json --csv demo.csv
    python3 tools/synth_ppg.py --minutes 2 --br 12 --scenario restless --out /tmp/restless.json
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze import summarize  # noqa: E402


def generate(
    minutes: float = 10.0,
    br: float = 6.0,
    hr: float = 62.0,
    rmssd: float = 55.0,
    scenario: str = "settled",
    seed: int = 42,
    rate_hz: float = 10.0,
    raw: bool = False,
) -> dict:
    rng = np.random.default_rng(seed)
    duration_s = minutes * 60.0
    n = int(duration_s * rate_hz)
    t = np.arange(n) / rate_hz  # 秒

    # ---- 呼吸相位：起始阶段略快且不稳，之后收敛到目标节律 ----
    settle = np.clip(t / 90.0, 0, 1)
    br_inst = br + (2.5 * (1 - settle)) + 0.18 * np.sin(2 * np.pi * t / 47.0)
    if scenario == "restless":
        br_inst += 1.4 * np.sin(2 * np.pi * t / 13.0)
    phase = 2 * np.pi * np.cumsum(br_inst) / (60.0 * rate_hz)

    # ---- 逐拍 RR 间期 ----
    base_rr = 60000.0 / hr
    rsa_amp = 90.0 if abs(br - 6.0) < 0.6 else 42.0  # 6 次/分时 RSA 最强
    noise_sd = max(rmssd / 1.414, 3.0)
    rr_list, beat_t = [], []
    cur_t = 0.0
    while cur_t < duration_s:
        rr = (
            base_rr
            + rsa_amp * np.sin(phase[min(int(cur_t * rate_hz), n - 1)] - 0.6)
            + rng.normal(0, noise_sd)
            + 12.0 * np.sin(2 * np.pi * cur_t / 180.0)
        )
        rr = float(np.clip(rr, 380, 1600))
        rr_list.append(rr)
        beat_t.append(cur_t * 1000.0)
        cur_t += rr / 1000.0
    rr_arr = np.array(rr_list)
    beat_ms = np.array(beat_t)

    # ---- 10 Hz 指标流 ----
    beat_idx = np.searchsorted(beat_ms, t * 1000.0, side="right") - 1
    beat_idx = np.clip(beat_idx, 0, len(rr_arr) - 1)
    rr_stream = rr_arr[beat_idx]
    hr_stream = 60000.0 / rr_stream

    eda = 1.1 + 0.45 * (1 - settle) + 0.12 * np.sin(2 * np.pi * t / 120.0) + rng.normal(0, 0.02, n)
    motion = np.clip(rng.normal(0.012, 0.008, n), 0, 1)
    if scenario == "restless":
        for center in (95.0, 210.0, 340.0):
            mask = np.abs(t - center) < 2.0
            motion[mask] += 0.35
            motion = np.clip(motion, 0, 1)
    quality = np.clip(0.985 - 0.35 * motion - 0.03 * np.abs(np.sin(2 * np.pi * t / 31.0)), 0.35, 1.0)
    if scenario == "poor_signal":
        quality = np.clip(quality - 0.45, 0.05, 1.0)

    # 滚动相干性：越接近 6 次/分、越安静越高
    target = np.exp(-((br_inst - 6.0) / 1.6) ** 2)
    coh = np.clip(0.35 + 0.55 * target * settle + rng.normal(0, 0.02, n), 0, 1)

    samples = []
    for i in range(n):
        s = {
            "t_ms": int(round(t[i] * 1000)),
            "hr": round(float(hr_stream[i]), 1),
            "rr_ms": round(float(rr_stream[i]), 1),
            "br": round(float(br_inst[i]), 2),
            "eda": round(float(eda[i]), 3),
            "motion": round(float(motion[i]), 3),
            "quality": round(float(quality[i]), 3),
            "coherence": round(float(coh[i]), 3),
        }
        samples.append(s)

    now = datetime.now(timezone(timedelta(hours=8)))
    session = {
        "schema": "zentimer.bio.v1",
        "session_id": now.strftime("%Y-%m-%d-%H%M%S") + "-sim",
        "started_at": now.isoformat(timespec="seconds"),
        "ended_at": (now + timedelta(seconds=duration_s)).isoformat(timespec="seconds"),
        "source": "sim",
        "device": {
            "fw": "synth-0.1",
            "sensor": "synthetic",
            "rate_hz": rate_hz,
            "calibration": {"br_target": br, "hr_base": hr, "rmssd_target": rmssd, "scenario": scenario},
        },
        "preset": {"duration_s": int(duration_s), "prep_s": 0, "label": "模拟会话"},
        "samples": samples,
        "subjective": {"depth": 7, "tags": ["模拟数据"], "note": "由 synth_ppg.py 生成，非真人数据"},
    }

    if raw:
        # 50 Hz PPG：脉搏波 + 呼吸基线调制 + 噪声
        fs = 50.0
        tr = np.arange(0, duration_s, 1.0 / fs)
        inst_hr = 60000.0 / np.interp(tr, beat_ms / 1000.0, rr_arr,
                                     left=rr_arr[0], right=rr_arr[-1])
        pulse_phase = 2 * np.pi * np.cumsum(inst_hr / 60.0) / fs
        breath_phase = 2 * np.pi * np.cumsum(np.interp(tr, t, br_inst) / 60.0) / fs
        ppg = (
            np.sin(pulse_phase) ** 2 * 0.8
            + 0.25 * np.sin(breath_phase)
            + rng.normal(0, 0.02, len(tr))
        )
        session["raw_ppg"] = [
            {"t_ms": int(round(x * 1000)), "ir": round(float(v), 4), "red": round(float(v * 0.72), 4)}
            for x, v in zip(tr[::5], ppg[::5])  # 每 100ms 一点，避免文件过大
        ]

    session["summary"] = summarize(session)
    return session


def main() -> int:
    ap = argparse.ArgumentParser(description="生成合成 zentimer.bio.v1 会话")
    ap.add_argument("--minutes", type=float, default=10.0)
    ap.add_argument("--br", type=float, default=6.0, help="目标呼吸率 次/分")
    ap.add_argument("--hr", type=float, default=62.0)
    ap.add_argument("--rmssd", type=float, default=55.0)
    ap.add_argument("--scenario", choices=["settled", "restless", "poor_signal"], default="settled")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--raw", action="store_true", help="附带原始 PPG 波形")
    ap.add_argument("--out", default="data/sample_sessions/demo.json")
    ap.add_argument("--csv", help="同时导出指标流 CSV")
    args = ap.parse_args()

    session = generate(
        minutes=args.minutes, br=args.br, hr=args.hr, rmssd=args.rmssd,
        scenario=args.scenario, seed=args.seed, raw=args.raw,
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"JSON -> {out}  ({len(session['samples'])} samples, {session['summary']['duration_s']} s)")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            keys = ["t_ms", "hr", "rr_ms", "br", "eda", "motion", "quality", "coherence"]
            w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
            w.writeheader()
            w.writerows(session["samples"])
        print(f"CSV  -> {args.csv}")

    s = session["summary"]
    print(f"  HR {s['mean_hr']} bpm | RMSSD {s['rmssd_ms']} ms | 呼吸 {s['mean_br']} 次/分 "
          f"| 谱峰 {s['coherence_peak_hz']} Hz | 有效率 {s['valid_ratio']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
