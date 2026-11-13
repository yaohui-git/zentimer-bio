#!/usr/bin/env python3
"""zentimer-bio 离线分析：从会话 JSON 计算 HRV / 呼吸 / 0.1 Hz 相干性。

只依赖 numpy。可独立运行，也被 synth_ppg.py 复用。

    python3 tools/analyze.py data/sample_sessions/demo.json
    python3 tools/analyze.py demo.json --csv summary.csv
    python3 tools/analyze.py demo.json --json
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path

import numpy as np


def _clean_rr(rr: np.ndarray, quality: np.ndarray | None) -> tuple[np.ndarray, float, np.ndarray]:
    """剔除伪迹：生理限幅、相邻差分阈值、低质量段。

    返回 (有效 RR, 有效率, 布尔掩码)。
    """
    rr = np.asarray(rr, dtype=float)
    n = len(rr)
    if n == 0:
        return rr, 0.0, np.zeros(0, dtype=bool)
    ok = (rr >= 300) & (rr <= 2000)
    if quality is not None and len(quality) == n:
        ok &= np.asarray(quality, dtype=float) >= 0.5
    diff = np.abs(np.diff(rr, prepend=rr[0]))
    ok &= diff < 0.2 * rr  # 相邻变化 >20% 视为伪迹
    return rr[ok], (ok.sum() / n if n else 0.0), ok


def hrv_time_domain(rr: np.ndarray) -> dict:
    if len(rr) < 2:
        return {"rmssd_ms": 0.0, "sdnn_ms": 0.0, "pnn50": 0.0, "mean_hr": 0.0}
    d = np.diff(rr)
    return {
        "rmssd_ms": round(float(np.sqrt(np.mean(d ** 2))), 1),
        "sdnn_ms": round(float(np.std(rr, ddof=1)), 1),
        "pnn50": round(float(np.mean(np.abs(d) > 50)), 3),
        "mean_hr": round(float(60000.0 / np.mean(rr)), 1),
    }


def coherence(rr: np.ndarray, beat_times_ms: np.ndarray, fs: float = 4.0) -> dict:
    """把不规则 RR 序列重采样到 fs，做周期图，看 0.1 Hz 附近谱峰有多突出。

    注意：慢呼吸（~6 次/分）会让 LF(0.04–0.15 Hz) 功率刻意升高，
    这是共振呼吸的训练目标，不是「压力大」。因此这里输出的是
    0.09–0.11 Hz 峰在 LF 频段内的占比，而不是传统 LF/HF 比值。
    """
    if len(rr) < 30 or beat_times_ms[-1] <= beat_times_ms[0]:
        return {"coherence_peak_hz": 0.0, "coherence_score": 0.0}
    t = beat_times_ms / 1000.0
    grid = np.arange(t[0], t[-1], 1.0 / fs)
    y = np.interp(grid, t, rr)
    y = y - np.mean(y)
    y = y * np.hanning(len(y))
    n = 1 << int(math.ceil(math.log2(max(len(y), 32))))
    spec = np.abs(np.fft.rfft(y, n=n)) ** 2
    freqs = np.fft.rfftfreq(n, d=1.0 / fs)
    lf = (freqs >= 0.04) & (freqs <= 0.15)
    band = (freqs >= 0.09) & (freqs <= 0.11)
    if not lf.any() or spec[lf].sum() <= 0:
        return {"coherence_peak_hz": 0.0, "coherence_score": 0.0}
    peak = float(freqs[lf][np.argmax(spec[lf])])
    score = float(spec[band].sum() / spec[lf].sum())
    return {"coherence_peak_hz": round(peak, 4), "coherence_score": round(score, 3)}


def summarize(session: dict) -> dict:
    samples = session.get("samples", [])
    if not samples:
        return {}
    with_rr = [s for s in samples if s.get("rr_ms") is not None]
    if not with_rr:
        return {}
    rr_stream = np.array([s["rr_ms"] for s in with_rr], dtype=float)
    quality = np.array([s.get("quality", 1.0) for s in with_rr], dtype=float)
    t_ms = np.array([s.get("t_ms", 0) for s in with_rr], dtype=float)

    # 关键：10 Hz 指标流里「最近一拍 RR」会连续重复多个采样点，
    # 必须先还原成逐拍序列，否则 RMSSD 被低估、HRV 谱峰会偏移到 0.01 Hz 量级。
    # 判定新的一拍：RR 值相对上一采样点发生显著变化（或首样本）。
    is_beat = np.r_[True, np.abs(np.diff(rr_stream)) > 0.5]
    rr_beats = rr_stream[is_beat]
    q_beats = quality[is_beat]
    t_beats = t_ms[is_beat]

    rr, valid_ratio, ok = _clean_rr(rr_beats, q_beats)
    beat_times = t_beats[ok]  # 用真实会话时间做频谱重采样，而非 RR 累加

    br = np.array([s["br"] for s in samples if s.get("br") is not None], dtype=float)
    motion = np.array([s.get("motion", 0.0) for s in samples], dtype=float)
    t0 = samples[0].get("t_ms", 0)
    t1 = samples[-1].get("t_ms", 0)

    out = {
        "duration_s": round((t1 - t0) / 1000.0, 1),
        "valid_ratio": round(valid_ratio, 3),
        "stillness": round(float(1.0 - np.clip(np.mean(motion), 0, 1)), 3),
    }
    out.update(hrv_time_domain(rr))
    out.update(coherence(rr, beat_times))
    if len(br):
        out["mean_br"] = round(float(np.mean(br)), 2)
        out["br_cv"] = round(float(np.std(br) / max(np.mean(br), 1e-6)), 3)
    else:
        out["mean_br"] = 0.0
        out["br_cv"] = 0.0
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="分析一场 zentimer.bio.v1 会话")
    ap.add_argument("input", help="会话 JSON 路径")
    ap.add_argument("--json", action="store_true", help="只输出 summary JSON")
    ap.add_argument("--csv", help="把指标流导出为 CSV")
    ap.add_argument("--write", action="store_true", help="把 summary 写回原 JSON 文件")
    args = ap.parse_args()

    path = Path(args.input)
    session = json.loads(path.read_text(encoding="utf-8"))
    summary = summarize(session)
    if not summary:
        print("错误：会话中没有 samples", file=sys.stderr)
        return 1

    if args.write:
        session["summary"] = summary
        path.write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            keys = ["t_ms", "hr", "rr_ms", "br", "eda", "motion", "quality", "coherence"]
            w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
            w.writeheader()
            for s in session["samples"]:
                w.writerow(s)
        print(f"CSV -> {args.csv}")

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(f"会话 {session.get('session_id', path.stem)}  ({summary['duration_s']} s)")
        print("-" * 46)
        labels = {
            "mean_hr": "平均心率 (bpm)", "rmssd_ms": "RMSSD (ms)",
            "sdnn_ms": "SDNN (ms)", "pnn50": "pNN50",
            "mean_br": "平均呼吸 (次/分)", "br_cv": "呼吸节律变异系数",
            "coherence_peak_hz": "HRV 谱峰 (Hz)", "coherence_score": "0.1Hz 相干性占比",
            "stillness": "静稳度", "valid_ratio": "有效数据占比",
        }
        for k, label in labels.items():
            print(f"  {label:<24} {summary.get(k, '-')}")
        print("-" * 46)
        note = "共振呼吸时 LF 升高属正常，本项目不使用 LF/HF 作为压力指标。"
        print("  注：" + note)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
