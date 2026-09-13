"""LLM 扫描映射回归：同义选项消歧（pick）+ 档案键映射（key）+ 防幻觉（不存在的 key 必须拦下）"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _util import load_fixture  # noqa: E402

PROFILE = load_fixture()
SETTINGS = {"disabled": {}, "llm": {"enabled": True, "baseUrl": "http://fake.local/v1", "apiKey": "test-key", "model": "stub", "scanMap": True}}

PASS, FAIL = [], []


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(f'{name} {detail}')


with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8080/test/mock-llm-map.html')
    pg.evaluate("""d => {
      localStorage.setItem('af:af.profile', JSON.stringify(d.prof));
      localStorage.setItem('af:af.settings', JSON.stringify(d.set));
    }""", {"prof": PROFILE, "set": SETTINGS})
    pg.reload()
    pg.wait_for_timeout(1200)
    pg.keyboard.press('Alt+Shift+F')       # 扫描 → maybeLlmMap（桩）
    pg.wait_for_timeout(2500)
    pg.keyboard.press('Alt+Shift+D')       # 填充
    pg.wait_for_timeout(6000)

    v = pg.evaluate("""() => ({
      gpt: document.getElementById('gpt').value,
      xw: document.getElementById('xw').value,
      blog: document.getElementById('blog').value,
      spouse: document.getElementById('spouse').value,
      calls: window.__llmCalls
    })""")
    audit = pg.evaluate("() => { try { return JSON.parse(localStorage.getItem('af:af.audit') || '[]'); } catch (e) { return []; } }")
    print('VALUES:', json.dumps(v, ensure_ascii=True))
    for a in audit:
        print('  ', a.get('ok'), '|', a.get('conf'), '|', a.get('label'), '|', repr(a.get('value'))[:50])

    check('LLM 接口被调用', v['calls'] >= 1, str(v['calls']))
    check('绩点制：同义选项消歧 → 五分制绩点', v['gpt'] == 'a', repr(v['gpt']))
    check('学位：歧义选项按学术型选中', v['xw'] == '408a', repr(v['xw']))
    check('技术博客：key 映射 basic.github', v['blog'] == PROFILE['base']['basic']['github'], repr(v['blog']))
    check('防幻觉：不存在的 key 不落值', v['spouse'] == '', repr(v['spouse']))
    check('零console错误', len(errs) == 0, repr(errs[:3]))
    b.close()

print(f'PASS {len(PASS)} / FAIL {len(FAIL)}')
for f in FAIL:
    print('  FAIL:', f)
sys.exit(1 if FAIL else 0)
