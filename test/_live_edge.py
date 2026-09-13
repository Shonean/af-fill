# -*- coding: utf-8 -*-
"""Live check: dedicated Edge profile + CDP connect + init-script injection + workbench API.
Leaves the dedicated Edge running (it's the user's daily driver from now on)."""
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'driver'))
from injector import build_init_script  # noqa: E402
from af_core import ensure_edge, PROFILE_PATH  # noqa: E402

PASS, FAIL = [], []
def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(f'{name} {detail}')

cfg = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'driver', 'config.json'), encoding='utf-8'))

# 1. Edge dedicated profile
ver = ensure_edge(cfg)
check('Edge 专用剖面拉起', 'Edg' in ver or 'Chrome' in ver, ver)
print('EDGE:', ver)

profile = json.load(open(PROFILE_PATH, encoding='utf-8'))
init = build_init_script(profile, {'disabled': {}}, {}, [], endpoint='http://127.0.0.1:8790')

from playwright.sync_api import sync_playwright
pw = sync_playwright().start()
b = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{cfg['debugPort']}")
ctx = b.contexts[0]
ctx.add_init_script(init)
check('CDP 连接 + init script 注册', True)

pg = ctx.new_page()
# 清理上次运行残留的 mock 标签
for p in list(ctx.pages):
    if 'mock-generic' in (p.url or ''):
        try:
            p.close()
        except Exception:
            pass
pg.goto('http://127.0.0.1:8080/test/mock-generic.html', wait_until='domcontentloaded')
pg.wait_for_timeout(2500)
v = pg.evaluate("""(() => ({
  data: !!(window.__AF_DATA && window.__AF_DATA.profile && window.__AF_DATA.profile.base),
  shim: typeof window.GM_getValue === 'function' && typeof window.GM_xmlhttpRequest === 'function',
  host: !!document.getElementById('af-host'),
  chip: [...document.body.children].some(d => d.textContent === '+ 台账'),
  loaded: window.__AF_LOADED === true
}))()""")
check('__AF_DATA 烤入', v['data'])
check('GM shim 就位', v['shim'])
check('引擎挂载(#af-host)', v['host'])
check('收录 chip 挂载', v['chip'])
check('双实例 flag', v['loaded'])

# chip 收录 → workbench (start workbench as subprocess first)
wb = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'driver', 'workbench.py')],
                      creationflags=subprocess.CREATE_NO_WINDOW)
up = False
for _ in range(40):
    time.sleep(0.5)
    try:
        urllib.request.urlopen('http://127.0.0.1:8790/api/state', timeout=2)
        up = True
        break
    except Exception:
        pass
check('workbench 起服', up)
if up:
    st = json.loads(urllib.request.urlopen('http://127.0.0.1:8790/api/state', timeout=5).read())
    check('driver 线程 CDP 就绪', st['driver'].get('cdp') is True, json.dumps(st['driver'].get('error')))
    # 触发 chip 收录（页面侧 POST /event）
    pg.evaluate("""(() => {
      const chip = [...document.body.children].find(d => d.textContent === '+ 台账');
      if (chip) chip.click();
      return !!chip;
    })()""")
    time.sleep(2)
    st2 = json.loads(urllib.request.urlopen('http://127.0.0.1:8790/api/state', timeout=5).read())
    n = len(st2['ledger']['entries'])
    check('chip 收录 → 台账落库', n >= 1, f'entries={n}')
    if n:
        e0 = st2['ledger']['entries'][0]
        check('收录含 JD 文本', len(e0.get('jd') or '') > 100, f"jd={len(e0.get('jd') or '')}字")
        check('收录 URL 正确', 'mock-generic' in e0.get('url', ''), e0.get('url', '')[:60])

# cleanup: close test tab; keep Edge + workbench running for the user? stop workbench (user starts via bat)
try:
    pg.close()
except Exception:
    pass
pw.stop()
if up:
    wb.terminate()
    time.sleep(1)
print(f'LIVE PASS {len(PASS)} / FAIL {len(FAIL)}')
for f in FAIL: print('  FAIL:', f)
sys.exit(1 if FAIL else 0)
