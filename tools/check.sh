#!/usr/bin/env bash
# 本地自检：等价于 .github/workflows/ci.yml
set -euo pipefail
cd "$(dirname "$0")/.."
echo "[1/5] Python 语法"
python3 -m py_compile tools/synth_ppg.py tools/analyze.py
echo "[2/5] JavaScript 语法"
node --check web/zenbio.js
echo "[3/5] JSON 合法性"
python3 -c "import json,glob; [json.load(open(f,encoding='utf-8')) for f in glob.glob('protocol/*.json')+glob.glob('data/sample_sessions/*.json')]"
echo "[4/5] 生成三场景"
tmp=$(mktemp -d)
python3 tools/synth_ppg.py --minutes 10 --br 6  --scenario settled     --seed 42 --out "$tmp/settled.json"  >/dev/null
python3 tools/synth_ppg.py --minutes 10 --br 12 --scenario restless    --seed 42 --out "$tmp/restless.json" >/dev/null
python3 tools/synth_ppg.py --minutes 10 --br 6  --scenario poor_signal --seed 42 --out "$tmp/poor.json"     >/dev/null
echo "[5/5] 断言"
python3 - "$tmp" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1])
s,r,q=[json.load(open(p/f))['summary'] for f in ('settled.json','restless.json','poor.json')]
assert s['valid_ratio']>0.90
assert q['valid_ratio']<s['valid_ratio']
assert r['stillness']<=s['stillness']
assert 0.08<=s['coherence_peak_hz']<=0.12
assert s['coherence_score']>r['coherence_score']
assert s['rmssd_ms']>40
print('  settled: 谱峰 %.4f Hz, 相干性 %.3f, RMSSD %.1f ms' % (s['coherence_peak_hz'],s['coherence_score'],s['rmssd_ms']))
print('  restless: 相干性 %.3f（应显著更低）' % r['coherence_score'])
print('  poor_signal: 有效率 %.3f（应更低）' % q['valid_ratio'])
PY
rm -rf "$tmp"
echo "全部通过 ✓"
