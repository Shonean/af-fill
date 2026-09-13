# -*- coding: utf-8 -*-
"""Live queue check: workbench API -> open entry URL in dedicated Edge -> status transitions."""
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'driver'))
from af_core import ensure_edge, PROFILE_PATH  # noqa: E402
from injector import build_init_script  # noqa: E402

PASS, FAIL = [], []
def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(f'{name} {detail}')

def api(path, body=None):
    req = urllib.request.Request('http://127.0.0.1:8790' + path,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'},
                                 method='POST' if body is not None else 'GET')
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode('utf-8'))

cfg = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'driver', 'config.json'), encoding='utf-8'))
ensure_edge(cfg)

wb = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'driver', 'workbench.py')],
                      creationflags=subprocess.CREATE_NO_WINDOW)
up = False
for _ in range(40):
    time.sleep(0.5)
    try:
        api('/api/state'); up = True; break
    except Exception:
        pass
check('workbench 起服', up)

if up:
    # 造一条台账（mock 页）→ 队列打开 → 状态推进
    r = api('/event', {'type': 'collect', 'url': 'http://127.0.0.1:8080/test/mock-generic.html',
                           'title': '队列测试 · 启航人才网', 'host': '127.0.0.1:8080', 'jd': 'x' * 120})
    eid = r['id']
    check('台账落库', r['ok'] is True, json.dumps(r))
    before = len(api('/api/state')['pages'])
    r2 = api('/api/open/' + str(eid), {})
    check('单条打开成功', r2.get('ok') is True, json.dumps(r2)[:80])
    time.sleep(2.5)
    st = api('/api/state')
    after = len(st['pages'])
    check('新标签页出现在 Edge', after > before, f'{before}->{after}')
    e = next(x for x in st['ledger']['entries'] if x['id'] == eid)
    check('状态推进为已打开', e['status'] == '已打开', e['status'])
    # 模拟该页的填充事件 → 已填
    api('/event', {'type': 'audit', 'entry': {'t': 'now', 'host': '127.0.0.1:8080', 'frame': 'top',
                                                  'conf': 'high', 'ok': True, 'label': '姓名', 'value': '***'}})
    time.sleep(0.5)
    st = api('/api/state')
    e = next(x for x in st['ledger']['entries'] if x['id'] == eid)
    check('填充事件→已填', e['status'] == '已填', e['status'])
    api('/api/ledger/update', {'id': eid, 'patch': {'status': '已投'}})
    st = api('/api/state')
    e = next(x for x in st['ledger']['entries'] if x['id'] == eid)
    check('手动标已投', e['status'] == '已投', e['status'])
    check('轨迹记录', '已投' in ' '.join(x['what'] for x in e.get('events', [])))
    # 清理测试条目 + 关闭测试标签
    api('/api/ledger/delete/' + str(eid), {})
    for p in api('/api/state')['pages']:
        pass

try:
    wb.terminate()
except Exception:
    pass
print(f'QUEUE PASS {len(PASS)} / FAIL {len(FAIL)}')
for f in FAIL: print('  FAIL:', f)
sys.exit(1 if FAIL else 0)
