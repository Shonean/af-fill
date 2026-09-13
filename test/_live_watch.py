# -*- coding: utf-8 -*-
"""v0.5 live 全栈：workbench 起服 → 触发扫描 → 候选出现 → accept → 台账 → 忽略语义。"""
import json
import os
import subprocess
import sys
import time
import urllib.request

def api(path, body=None, timeout=30):
    req = urllib.request.Request('http://127.0.0.1:8790' + path,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'},
                                 method='POST' if body is not None else 'GET')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))

PASS, FAIL = [], []
def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(f'{name} {detail}')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
wb = subprocess.Popen([sys.executable, os.path.join(ROOT, 'driver', 'workbench.py')],
                      cwd=ROOT + os.sep + 'driver', creationflags=subprocess.CREATE_NO_WINDOW)
up = False
for _ in range(60):
    time.sleep(0.5)
    try:
        api('/api/state'); up = True; break
    except Exception:
        pass
check('workbench 起服', up)

if up:
    st = api('/api/watch/state')
    check('watch state 可用', 'sources' in st and 'candidates' in st)
    check('gwy 源已注册', any('gwy.com' in s['url'] for s in st['sources']))
    # 触发扫描（后台线程）
    api('/api/watch/scan', {})
    time.sleep(2)
    st = api('/api/watch/state')
    check('扫描已启动', st['scan']['running'] is True, json.dumps(st['scan'])[:80])
    # 轮询等待完成（最长 300s）
    deadline = time.time() + 300
    while time.time() < deadline:
        st = api('/api/watch/state')
        if not st['scan']['running']:
            break
        time.sleep(5)
    check('扫描完成', st['scan']['running'] is False)
    check('扫描无错误', not (st['scan']['last'] or {}).get('error'), json.dumps(st['scan'].get('last'))[:100])
    check('候选产出 ≥50', len(st['candidates']) >= 50, str(len(st['candidates'])))
    n_ignored_before = st['stats']['ignored']
    # accept 第一条 → 台账
    c0 = st['candidates'][0]
    r = api('/api/watch/candidate', {'key': c0['key'], 'action': 'accept'})
    check('候选收进台账', r.get('ok') is True, json.dumps(r)[:60])
    led = api('/api/state')
    e = next((x for x in led['ledger']['entries'] if x['url'] == c0['url']), None)
    check('台账条目存在', e is not None)
    if e and c0.get('llm'):
        check('LLM 字段随收入台账', (e.get('company') or e.get('position') or '') != '', json.dumps({k: e.get(k) for k in ('company','position')}, ensure_ascii=False)[:80])
    # ignore 第二条 → 下轮不复活（用 stats.ignored 计数验证）
    c1 = st['candidates'][1]
    api('/api/watch/candidate', {'key': c1['key'], 'action': 'ignore'})
    st2 = api('/api/watch/state')
    check('忽略计数 +1', st2['stats']['ignored'] == n_ignored_before + 1, f"{n_ignored_before}->{st2['stats']['ignored']}")
    check('已忽略不在待审', all(x['key'] != c1['key'] for x in st2['candidates']))
    # 清理测试产生的台账条目与候选（被忽略的候选已弹出 → delete 会 404，属预期）
    if e:
        api('/api/ledger/delete/' + str(e['id']), {})
    for c in (c0, c1):
        try:
            api('/api/watch/candidate', {'key': c['key'], 'action': 'delete'})
        except Exception:
            pass

try:
    wb.terminate()
except Exception:
    pass
print(f'LIVE-WATCH PASS {len(PASS)} / FAIL {len(FAIL)}')
for f in FAIL: print('  FAIL:', f)
sys.exit(1 if FAIL else 0)
