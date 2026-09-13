# -*- coding: utf-8 -*-
"""render 模式冒烟：gwy 经 CDP 后台标签滚动抓取（对静态站同样有效，验证通用路径）。"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'driver'))
import watcher  # noqa: E402

PASS, FAIL = [], []
def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(f'{name} {detail}')

SOURCE = {'id': 9, 'name': 'gwy-render', 'url': 'https://www.gwy.com/gqzp/', 'mode': 'render', 'pages': 3}
items, rounds = watcher.crawl_source(SOURCE, log=print)
print(f'render: rounds={rounds} items={len(items)} dated={len([i for i in items if i["date"]])}')
check('render 产出 ≥50', len(items) >= 50, str(len(items)))
check('标题干净', all(8 <= len(i['title']) <= 80 for i in items))
check('同站条目', all('gwy.com' in i['url'] for i in items))
print(f'RENDER PASS {len(PASS)} / FAIL {len(FAIL)}')
for f in FAIL: print('  FAIL:', f)
sys.exit(1 if FAIL else 0)
