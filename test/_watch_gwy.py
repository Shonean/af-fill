# -*- coding: utf-8 -*-
"""v0.5 单源验收：gwy.com 真实抓取（fetch 模式）→ 去重/合并 → 候选池语义 → LLM 过滤（有 key 才跑）。
Live network test. 需要 http.server 8080 不必；需要外网。"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'driver'))
import watcher  # noqa: E402
from watcher import CandidateStore, dedup_key, normalize_title, cluster_items  # noqa: E402

PASS, FAIL = [], []
def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(f'{name} {detail}')

SOURCE = {'id': 1, 'name': '高顿央国企', 'url': 'https://www.gwy.com/gqzp/', 'mode': 'fetch', 'pages': 3}

# 1. 抓取 + 通用提取
t0 = time.time()
items, fetched = watcher.crawl_source(SOURCE, log=print)
dt = round(time.time() - t0, 1)
print(f'crawled: fetched={fetched} pages, items={len(items)} in {dt}s')
check('抓取预算内完成', fetched <= 18 and fetched >= 3, f'fetched={fetched}')
check('条目 ≥50', len(items) >= 50, str(len(items)))
check('条目均有 title+url', all(i['title'] and i['url'].startswith('http') for i in items))
check('gwy 条目确有命中', any('gwy.com' in i['url'] for i in items))
dated = [i for i in items if i['date']]
check('带日期条目 ≥20', len(dated) >= 20, str(len(dated)))

# 2. 批内模糊聚类（构造同公告变体）
probe = [
    {'title': '中国邮政2027校园招聘公告发布，报名截止10月11日！', 'url': 'https://www.gwy.com/gqzp/1.html', 'date': '2026-09-08'},
    {'title': '中国邮政2027校园招聘公告发布报名截止10月11日', 'url': 'https://www.gwy.com/gqzp/2.html', 'date': '2026-09-07'},
    {'title': ' completely unrelated title about cooking noodles ', 'url': 'https://www.gwy.com/gqzp/3.html', 'date': '2026-09-07'},
]
cl = cluster_items(probe)
check('模糊聚类合并变体', len(cl) == 2, f'{len(cl)}')
check('聚类保留更长标题', any('！' in c['title'] for c in cl))

# 3. 候选池语义（用临时库，避免污染真库）
watcher.CAND_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'driver', 'watch', '_test_cand.json')
if os.path.exists(watcher.CAND_PATH):
    os.remove(watcher.CAND_PATH)
cs = CandidateStore()
batch = [{'title': i['title'], 'url': i['url'], 'date': i['date']} for i in items[:60]]
n1 = cs.add_batch(cluster_items(batch), '高顿央国企')
check('首批入库', n1 >= 40, str(n1))
n2 = cs.add_batch(cluster_items(batch), '高顿央国企')
check('幂等二扫零新增', n2 == 0, str(n2))
# 同公告换标题变体再来一条 → 合并（不新增）
v0 = items[0]
variant = [{'title': v0['title'].replace('！', '').replace('，', ''), 'url': 'https://www.gwy.com/gqzp/9999.html', 'date': v0['date']}]
before = cs.stats()['total']
cs.add_batch(cluster_items(variant), '高顿央国企')
after = cs.stats()['total']
check('变体标题合并不新增', after == before, f'{before}->{after}')
# 忽略语义
k0 = cs.list()[0]['key']
orig = cs.get(k0)
cs.set_status(k0, '忽略'); cs.save()
check('忽略后不在待审', all(c['key'] != k0 for c in cs.list()))
check('忽略集合生效', cs.is_ignored(k0))
n3 = cs.add_batch([{'title': orig['title'], 'url': orig['url'], 'date': orig['date']}], '高顿央国企')
check('被忽略的 key 不复活', n3 == 0 and all(c['key'] != k0 for c in cs.list()), str(n3))
# 过期
first_key = list(cs.data['items'])[0]
cs.data['items'][first_key]['lastSeen'] = '2020-01-01 00:00'
e = cs.expire(30)
check('30 天过期清理', e >= 1, str(e))
os.remove(watcher.CAND_PATH)

print(f'WATCH PASS {len(PASS)} / FAIL {len(FAIL)}')
for f in FAIL: print('  FAIL:', f)
sys.exit(1 if FAIL else 0)
