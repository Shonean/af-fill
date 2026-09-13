# -*- coding: utf-8 -*-
"""AF-Fill workbench: local dashboard (localhost) + page-event intake + LLM channel.

Run:  python workbench.py      (or double-click start_af.bat)
Requires Edge dedicated profile running with debug port (af_edge.ps1 / Job Edge shortcut);
the driver thread starts Edge automatically if needed.
"""
import json
import os
import re
import subprocess
import threading
import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional, List, Any

import af_core
import paths
import watcher
from af_core import Driver, Store, llm_chat, llm_forward, log_line
from watcher import CandidateStore

ROOT = os.path.dirname(os.path.abspath(__file__))

store = Store()
driver = Driver(store)
watch_store = CandidateStore()

app = FastAPI(title='AF-Fill Workbench', docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],          # page-side shim posts here from any https site
    allow_methods=['*'],
    allow_headers=['*'],
)


def _driver_watchdog():
    """Driver 线程心跳看门狗：beat 停滞 >45s（playwright 卡死/线程死亡）→ 整体重建 Driver。"""
    while True:
        time.sleep(10)
        try:
            beat = driver.status.get('beat') or 0
            if beat and time.time() - beat > 45:
                log_line('[watchdog] driver heartbeat stalled >45s → rebuilding driver')
                try:
                    driver.stop()                   # 先通知旧线程退出，再重建
                except Exception:
                    pass
                nd = Driver(store)
                nd.start()
                globals()['driver'] = nd
        except Exception as e:
            log_line('[watchdog] error: ' + str(e))


_booted = False


@app.on_event('startup')
def _boot():
    """服务线程（含看门狗重启）可能被多次启动：Driver/后台线程只允许起一次，防
    'threads can only be started once' 与看门狗/定时器线程叠罗汉。"""
    global _booted
    if not driver.is_alive():
        driver.start()
    if _booted:
        return
    _booted = True
    threading.Thread(target=_driver_watchdog, daemon=True, name='af-driver-watchdog').start()
    threading.Thread(target=_watch_interval_loop, daemon=True, name='af-watch-tick').start()


@app.on_event('shutdown')
def _down():
    driver.stop()


# ---------------- watch (盯梢源 + 候选审核区) ----------------

scan_state = {'running': False, 'phase': '', 'last': None, 'lastAt': '', 'log': []}


def _wlog(msg: str):
    scan_state['log'] = (scan_state['log'] + [time.strftime('%H:%M ') + msg])[-30:]
    log_line(f'[watch] {msg}')


def _watch_cfg(key, default):
    return (store.cfg.get('watch') or {}).get(key, default)


def _filter_pending():
    """LLM 画像式过滤：一次批量送审全部未过滤的待审候选。"""
    pend = watch_store.pending_unfiltered()
    if not pend or not llm_ready():
        return 0
    prompt = _watch_cfg('filterPrompt', '')
    done = 0
    CH = 40
    for start in range(0, len(pend), CH):
        chunk = pend[start:start + CH]
        payload = [{'i': i, 'title': c['title'], 'date': c.get('date', ''),
                    'source': ','.join(c.get('sources', []))} for i, c in enumerate(chunk)]
        out = llm_chat(store.cfg.get('llm'), [
            {'role': 'system', 'content': prompt},
            {'role': 'user', 'content': json.dumps(payload, ensure_ascii=False)},
        ], timeout=120)
        if out is None:
            _wlog(f'llm filter chunk fail @ {start}')
            continue
        try:
            m = re.search(r'\[[\s\S]*\]', out)
            arr = json.loads(m.group(0)) if m else []
        except Exception:
            _wlog('llm filter parse fail')
            continue
        for it in arr:
            try:
                c = chunk[int(it.get('i'))]
            except Exception:
                continue
            c['llm'] = {'relevant': bool(it.get('relevant')), 'reason': str(it.get('reason', ''))[:40],
                        'company': str(it.get('company', ''))[:40], 'position': str(it.get('position', ''))[:60],
                        'city': str(it.get('city', ''))[:20], 'deadline': str(it.get('deadline', ''))[:20],
                        'target': str(it.get('target', ''))[:12]}
            done += 1
        watch_store.save()
    return done


def _scan_worker(source_ids=None):
    scan_state['running'] = True
    summary = {'sources': 0, 'fetched': 0, 'items': 0, 'new': 0, 'filtered': 0, 'error': None}
    try:
        targets = [s for s in watcher.load_sources()
                   if s.get('enabled') and (not source_ids or s.get('id') in source_ids)]
        for s in targets:
            scan_state['phase'] = f"抓取 {s.get('name')}"
            items, fetched = watcher.crawl_source(s, log=_wlog)
            merged = watcher.cluster_items(items)
            new = watch_store.add_batch(merged, s.get('name') or s.get('url', '')[:20])
            s['lastScan'] = watcher.now_str()
            s['lastNew'] = new
            s['lastFetched'] = fetched
            _rewrite_source(s)
            summary['sources'] += 1
            summary['fetched'] += fetched
            summary['items'] += len(merged)
            summary['new'] += new
            _wlog(f"{s.get('name')}: 抓取 {fetched} 页 · 条目 {len(merged)} · 新候选 {new}")
        expired = watch_store.expire(int(_watch_cfg('expireDays', 30)))
        watch_store.save()
        if expired:
            _wlog(f'过期清理 {expired} 条')
        if llm_ready():
            scan_state['phase'] = 'LLM 过滤'
            summary['filtered'] = _filter_pending()
        scan_state['last'] = summary
        scan_state['lastAt'] = watcher.now_str()
        _wlog(f"扫描完成：{json.dumps(summary, ensure_ascii=False)}")
    except Exception as e:
        summary['error'] = f'{type(e).__name__}: {e}'
        scan_state['last'] = summary
        _wlog('扫描失败: ' + str(e))
    finally:
        scan_state['running'] = False
        scan_state['phase'] = ''


def _rewrite_source(updated: dict):
    sources = watcher.load_sources()
    for i, s in enumerate(sources):
        if s.get('id') == updated.get('id'):
            sources[i] = updated
    watcher.save_sources(sources)
    return sources


def _watch_interval_loop():
    while True:
        time.sleep(600)
        try:
            hours = float(_watch_cfg('intervalHours', 0) or 0)
            if hours <= 0 or scan_state['running']:
                continue
            last = scan_state.get('lastAt') or ''
            due = True
            if last:
                t = time.mktime(time.strptime(last, '%Y-%m-%d %H:%M'))
                due = (time.time() - t) >= hours * 3600
            if due:
                threading.Thread(target=_scan_worker, daemon=True).start()
        except Exception:
            pass


@app.get('/api/watch/state')
def watch_state():
    return {
        'scan': {k: scan_state[k] for k in ('running', 'phase', 'last', 'lastAt')},
        'log': scan_state['log'][-12:],
        'sources': watcher.load_sources(),
        'candidates': watch_store.list(),
        'stats': watch_store.stats(),
        'llmReady': llm_ready(),
        'prompt': _watch_cfg('filterPrompt', ''),
        'intervalHours': _watch_cfg('intervalHours', 0),
    }


class SourceBody(BaseModel):
    name: str
    url: str
    pages: Optional[int] = 3


@app.post('/api/watch/sources/add')
def watch_source_add(body: SourceBody):
    if not body.url.startswith('http'):
        return JSONResponse({'ok': False, 'error': 'URL 必须以 http 开头'}, status_code=400)
    sources = watcher.load_sources()
    for s in sources:
        if s.get('url') == body.url:
            return JSONResponse({'ok': False, 'error': '该源已存在'}, status_code=400)
    sources.append({'id': max([s.get('id', 0) for s in sources] or [0]) + 1,
                    'name': body.name or body.url[:24], 'url': body.url, 'mode': 'fetch',
                    'pages': body.pages or 3, 'enabled': True, 'lastScan': '', 'lastNew': 0, 'lastFetched': 0})
    watcher.save_sources(sources)
    return {'ok': True}


class SourcePatchBody(BaseModel):
    id: int
    patch: dict


@app.post('/api/watch/sources/update')
def watch_source_update(body: SourcePatchBody):
    sources = watcher.load_sources()
    for i, s in enumerate(sources):
        if s.get('id') == body.id:
            for k in ('name', 'url', 'pages', 'enabled'):
                if k in body.patch:
                    s[k] = body.patch[k]
            watcher.save_sources(sources)
            return {'ok': True}
    return JSONResponse({'ok': False, 'error': 'no source'}, status_code=404)


@app.post('/api/watch/sources/delete/{sid}')
def watch_source_delete(sid: int):
    sources = [s for s in watcher.load_sources() if s.get('id') != sid]
    watcher.save_sources(sources)
    return {'ok': True}


@app.post('/api/watch/scan')
def watch_scan(body: dict = None):
    if scan_state['running']:
        return JSONResponse({'ok': False, 'error': '扫描进行中'}, status_code=409)
    ids = (body or {}).get('ids')
    threading.Thread(target=_scan_worker, args=(ids,), daemon=True).start()
    return {'ok': True}


class CandBody(BaseModel):
    key: str
    action: str   # accept | ignore | delete


@app.post('/api/watch/candidate')
def watch_candidate(body: CandBody):
    c = watch_store.get(body.key)
    if not c:
        return JSONResponse({'ok': False, 'error': '候选不存在或已忽略'}, status_code=404)
    if body.action == 'accept':
        r = store.add_entry(url=c['url'], title=c['title'], jd='', host=c['url'])
        llm = c.get('llm') or {}
        patch = {}
        for k in ('company', 'position', 'city'):
            if llm.get(k):
                patch[k] = llm[k]
        if llm.get('deadline'):
            patch['note'] = f"截止 {llm['deadline']} · {llm.get('target', '')}"
        store.update_entry(r['id'], patch)
        watch_store.set_status(body.key, '已收')
        watch_store.save()
        return {'ok': True, 'ledgerId': r['id']}
    watch_store.set_status(body.key, '忽略' if body.action == 'ignore' else '删除')
    watch_store.save()
    return {'ok': True}


class PromptBody(BaseModel):
    prompt: str
    intervalHours: Optional[float] = None


@app.post('/api/watch/config')
def watch_config(body: PromptBody):
    store.cfg['watch'] = store.cfg.get('watch') or {}
    store.cfg['watch']['filterPrompt'] = body.prompt
    if body.intervalHours is not None:
        store.cfg['watch']['intervalHours'] = max(0, float(body.intervalHours))
    store.save_config()
    return {'ok': True}


# ---------------- page events (from GM shim / chip) ----------------

_rearm_state = {'busy': False}


def _rearm_soon(delay: float = 0.8):
    """合并短时间内的连续数据变更，后台重建注入脚本。此前在页面请求线程里同步
    driver.call('rearm')，一次 /event 要等驱动 3s+，引擎学习时页面请求被拖住。"""
    if _rearm_state['busy']:
        return
    _rearm_state['busy'] = True

    def work():
        try:
            time.sleep(delay)
            driver.call('rearm', timeout=30)
        except Exception as e:
            log_line(f'rearm deferred failed: {e}')
        finally:
            _rearm_state['busy'] = False

    threading.Thread(target=work, daemon=True, name='af-rearm').start()


class EventBody(BaseModel):
    type: str
    url: Optional[str] = None
    title: Optional[str] = None
    host: Optional[str] = None
    jd: Optional[str] = None
    key: Optional[str] = None
    value: Optional[Any] = None
    entry: Optional[dict] = None


@app.post('/event')
def event(body: EventBody):
    t = body.type
    if t == 'collect':
        r = store.add_entry(url=body.url or '', title=body.title or '', jd=body.jd or '',
                            host=body.host or '')
        e = llm_tag_entry(r.get('id')) if r.get('status') == 'created' and llm_ready() else None
        return {'ok': True, 'id': r.get('id'), 'status': r.get('status'), 'tagged': bool(e)}
    if t == 'sync':
        if body.key == 'af.profile' and isinstance(body.value, dict):
            try:
                store.merge_profile(body.value)
                _rearm_soon()
            except Exception as e:
                log_line(f'profile merge failed: {e}')
        elif body.key in ('af.settings', 'af.siteQA', 'af.ballPos') and body.value is not None:
            store.merge_state_key(body.key, body.value)
        return {'ok': True}
    if t == 'audit':
        e = body.entry or {}
        host = e.get('host') or ''
        ok = bool(e.get('ok'))
        label = e.get('label') or ''
        if e.get('frame') == 'llm' or e.get('conf') == 'llm':
            log_line(f"[llm-audit] {host} {label}")
        else:
            store.mark_filled_by_host(host, label, ok)
        log_line(f"[audit] {'OK ' if ok else 'FAIL'} {host} {label}")
        return {'ok': True}
    return {'ok': True, 'ignored': t}


# ---------------- LLM proxy for page-side GM_xmlhttpRequest ----------------

class ProxyBody(BaseModel):
    url: str
    method: Optional[str] = 'GET'
    headers: Optional[dict] = {}
    body: Optional[str] = None
    timeout: Optional[float] = 15.0


@app.post('/proxy')
def proxy(body: ProxyBody):
    return llm_forward({'url': body.url, 'method': body.method, 'headers': body.headers,
                        'body': body.body}, timeout=min(body.timeout or 15, 60) + 2)


# ---------------- ledger ----------------

class EntryPatch(BaseModel):
    id: int
    patch: dict


@app.post('/api/ledger/update')
def ledger_update(body: EntryPatch):
    return store.update_entry(body.id, body.patch)


@app.post('/api/ledger/delete/{eid}')
def ledger_delete(eid: int):
    return store.delete_entry(eid)


class QueueBody(BaseModel):
    ids: List[int]


@app.post('/api/queue/start')
def queue_start(body: QueueBody):
    entries = {e['id']: e for e in store.ledger['entries']}
    opened = []
    _ui_browse()          # 先切「浏览」页签：开页过程实时可见，不再等整批开完
    for eid in body.ids:
        e = entries.get(eid)
        if not e or not (e.get('url') or '').startswith('http'):
            continue
        store.update_entry(eid, {'status': '已打开'})
        try:
            r = driver.call('open', {'url': e['url']}, timeout=90)
            opened.append({'id': eid, 'ok': True, 'title': r.get('title', '')})
        except Exception as ex:
            opened.append({'id': eid, 'ok': False, 'error': str(ex)[:120]})
            store.update_entry(eid, {'note': ((e.get('note') or '') + ' | 打开失败:' + str(ex)[:60]).strip(' |')})
        time.sleep(2.5)   # 逐个错峰开页，避免同时加载触发风控
    if opened:
        _ui_browse()      # 批量打开 → 自动切到「浏览」页签实时显示
    return {'ok': True, 'opened': opened}


@app.post('/api/open/{eid}')
def open_one(eid: int):
    for e in store.ledger['entries']:
        if e['id'] == eid:
            _ui_browse()
            r = driver.call('open', {'url': e['url']}, timeout=90)
            store.update_entry(eid, {'status': '已打开'})
            return {'ok': True, **r}
    return JSONResponse({'ok': False, 'error': 'no entry'}, status_code=404)


# ---------------- collect ----------------

class CollectBody(BaseModel):
    index: Optional[int] = None   # open-tab index; None = visible tab


@app.post('/api/collect')
def collect(body: CollectBody):
    info = driver.call('page_jd', {'index': body.index}, timeout=90)
    r = store.add_entry(url=info.get('url', ''), title=info.get('title', ''),
                        jd=info.get('jd', ''), host=info.get('host', ''))
    tagged = False
    if r.get('status') == 'created' and llm_ready():
        tagged = bool(llm_tag_entry(r['id']))
    return {'ok': True, **r, 'tagged': tagged}


# ---------------- LLM ----------------

def llm_ready() -> bool:
    c = store.cfg.get('llm') or {}
    return bool(c.get('baseUrl') and c.get('apiKey'))


TAG_PROMPT = (
    '你是招聘信息解析器。输入是一段职位页文本（可能含导航噪音）。'
    '提取并输出 JSON（只输出 JSON，不要解释）：{"company":"公司名","position":"岗位名",'
    '"city":"工作城市","salary":"薪资或范围（没有则空串）","stack":["关键技术栈，最多8个"],'
    '"match":"与该求职者目标的匹配度：高/中/低","summary":"一句话摘要（60字内）"}。'
    '解析不出的字段用空串/空数组。'
)


def llm_tag_entry(eid: int):
    for e in store.ledger['entries']:
        if e['id'] == eid:
            break
    else:
        return None
    text = (e.get('jd') or e.get('title') or '')[:2500]
    if len(text.strip()) < 20:
        return None
    out = llm_chat(store.cfg.get('llm'), [
        {'role': 'system', 'content': TAG_PROMPT},
        {'role': 'user', 'content': text},
    ], timeout=45)
    if not out:
        return None
    try:
        m = re.search(r'\{[\s\S]*\}', out)
        tag = json.loads(m.group(0)) if m else {}
    except Exception:
        return None
    patch = {k: tag.get(k, '') for k in ('company', 'position', 'city', 'salary', 'match', 'summary')}
    patch['stack'] = tag.get('stack') or []
    patch['llmTagged'] = True
    store.update_entry(eid, patch)
    return patch


@app.post('/api/llm/selftest')
def llm_selftest():
    if not llm_ready():
        return JSONResponse({'ok': False, 'error': 'LLM 未配置'}, status_code=400)
    t0 = time.time()
    out = llm_chat(store.cfg.get('llm'), [
        {'role': 'system', 'content': 'Connectivity test. Reply with exactly: OK'},
        {'role': 'user', 'content': 'ping'},
    ], timeout=25)
    dt = round(time.time() - t0, 1)
    if out is None:
        return JSONResponse({'ok': False, 'error': f'调用失败（{dt}s）· 检查 baseUrl/key/model 或网络'}, status_code=502)
    return {'ok': True, 'reply': str(out)[:60], 'seconds': dt}


class DraftBody(BaseModel):
    jd: str
    type: str = '自我介绍'


@app.post('/api/llm/draft')
def llm_draft(body: DraftBody):
    if not llm_ready():
        return JSONResponse({'ok': False, 'error': 'LLM 未配置（config.json 或设置卡）'}, status_code=400)
    P = store.profile
    base = P.get('base') or {}
    basic = base.get('basic') or {}
    edu = (base.get('education') or [{}])[0]
    brief = {
        '姓名': basic.get('name', ''), '学校': edu.get('school', ''), '专业': edu.get('major', ''),
        '毕业时间': edu.get('endDate', ''), '求职方向': basic.get('job', ''), '技能': base.get('skills', []),
        '项目': [f"{p.get('name')}（{p.get('role')}，{p.get('range')}）" for p in (base.get('projects') or [])],
        '实习': [f"{i.get('company')}·{i.get('position')}（{i.get('range')}）" for i in (base.get('internships') or [])],
        '技能自述': str(base.get('skillSummary') or '')[:500],
    }
    content = llm_chat(store.cfg.get('llm'), [
        {'role': 'system', 'content': '你是求职文书代笔。根据 JD 与求职者档案写一段可直接粘贴使用的中文'
         + body.type + '，300-600 字，第一人称。要求：紧扣 JD 的岗位要求与公司业务；只使用档案里存在的事实，'
         '绝不编造经历、技能或数字；语气专业自然，不堆砌形容词。只输出正文本身，不要标题、引号或任何解释。'},
        {'role': 'user', 'content': '【JD】\n' + body.jd[:2500] + '\n\n【求职者档案要点】\n'
         + json.dumps(brief, ensure_ascii=False, indent=1) + '\n\n【文风参考（该求职者的自我介绍）】\n'
         + str(base.get('selfIntro') or '')[:300]},
    ], timeout=90)
    if not content:
        return JSONResponse({'ok': False, 'error': 'LLM 调用失败，检查配置或网络'}, status_code=502)
    content = re.sub(r'^```[a-z]*\s*', '', content.strip(), flags=re.I)
    content = re.sub(r'```\s*$', '', content).strip()
    return {'ok': True, 'content': content}


# ---------------- config / profile ----------------

class ConfigBody(BaseModel):
    llm: dict


@app.post('/api/config')
def save_config(body: ConfigBody):
    store.cfg['llm'] = {k: str(body.llm.get(k, '') or '').strip() for k in ('baseUrl', 'apiKey', 'model')}
    store.save_config()
    return {'ok': True}


class ProfileBody(BaseModel):
    profile: dict


@app.post('/api/profile')
def save_profile(body: ProfileBody):
    p = body.profile
    if not (isinstance(p, dict) and p.get('schemaVersion') == 1 and (p.get('base') or {}).get('basic', {}).get('name')):
        return JSONResponse({'ok': False, 'error': 'schemaVersion 必须=1 且 base.basic.name 非空'}, status_code=400)
    store.save_profile(p)
    _rearm_soon(0.2)
    return {'ok': True}


@app.post('/api/reinject')
def reinject():
    return {'ok': True, 'version': driver.call('inject_existing', timeout=300)}


# ---------------- state ----------------

@app.get('/api/state')
def state():
    d = dict(driver.status)
    d.pop('pages', None)
    return {
        'driver': d,
        'pages': driver.status.get('pages', []),
        'ledger': store.ledger,
        'llmReady': llm_ready(),
        'llm': {'baseUrl': store.cfg['llm'].get('baseUrl', ''), 'model': store.cfg['llm'].get('model', '')},
        'profileEmpty': not (((store.profile.get('base') or {}).get('basic') or {}).get('name') or '').strip(),
    }


@app.post('/api/ui/show')
def ui_show():
    """单例二次启动：请 GUI（af_app 注册的钩子）把工作台窗口带到前台。dev 直跑无钩子 → ok:false。"""
    fn = af_core.UI_HOOKS.get('show')
    if not fn:
        return {'ok': False, 'error': 'no ui'}
    try:
        fn()
        return {'ok': True}
    except Exception as e:
        return {'ok': False, 'error': str(e)[:120]}


@app.post('/api/edge/import-identity')
def edge_import_identity():
    """把日常 Edge 的收藏/密码/Cookie/自动填充复制到求职 Edge（需先完全退出日常 Edge）。"""
    try:
        r = af_core.import_daily_edge_identity(store.cfg)
        if r.get('ok'):
            try:
                af_core.restart_job_edge(store.cfg)     # 重启求职 Edge 生效；引擎自动重连
                r['restarted'] = True
            except Exception as e:
                r['restartError'] = str(e)[:100]
        return r
    except Exception as e:
        return JSONResponse({'ok': False, 'message': str(e)[:160]}, status_code=500)


def _ui_browse():
    """请求 GUI 切到「浏览」页签（打开投递页后实时可见）。"""
    fn = af_core.UI_HOOKS.get('browse')
    if fn:
        try:
            fn()
        except Exception:
            pass


class OpenUrlBody(BaseModel):
    url: str


@app.post('/api/open-url')
def open_url(body: OpenUrlBody):
    """在内置求职 Edge 新标签打开任意网址（引擎自动注入 → 悬浮球可用）。"""
    url = (body.url or '').strip()
    if not url.startswith('http'):
        return JSONResponse({'ok': False, 'error': 'URL 必须以 http 开头'}, status_code=400)
    _ui_browse()
    r = driver.call('open', {'url': url}, timeout=120)
    return {'ok': True, **r}


@app.get('/api/profile')
def get_profile():
    return store.profile


@app.get('/')
def index():
    return FileResponse(paths.dashboard_path())


@app.get('/api/profile/full')
def get_profile_full():
    return JSONResponse(store.profile)


@app.get('/api/logs')
def logs():
    try:
        with open(os.path.join(af_core.LOGS_DIR, 'driver.log'), encoding='utf-8') as f:
            return {'lines': f.read().splitlines()[-40:]}
    except Exception:
        return {'lines': []}


def _open_in_job_edge(url: str) -> bool:
    return af_core.open_in_job_edge(store.cfg, url)


if __name__ == '__main__':
    import sys
    import threading
    import urllib.request
    import webbrowser

    import uvicorn

    port = store.cfg.get('workbenchPort', 8790)
    url = f'http://127.0.0.1:{port}/'

    def _probe():
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/api/state', timeout=1.5)
            return True
        except Exception:
            return False

    # 单例：已有 AF 工作台在跑 → 直接打开页面、干净退出（不报错、不闪 traceback）
    if _probe():
        print('[AF-Fill] 工作台已在运行 · 已为你打开页面')
        try:
            _open_in_job_edge(url)
        except Exception:
            pass
        sys.exit(0)

    def _auto_open():
        # dev 模式：Driver 已懒启动化 → 这里显式拉起求职 Edge 再打开页面
        for _ in range(60):
            time.sleep(0.5)
            if _probe():
                break
        try:
            af_core.ensure_edge(store.cfg)
        except Exception:
            pass
        try:
            ok = _open_in_job_edge(url)
            log_line(('dashboard auto-opened in job edge: ' if ok else 'dashboard auto-open fallback: ') + url)
        except Exception:
            pass

    threading.Thread(target=_auto_open, daemon=True, name='af-autoopen').start()
    log_line('workbench starting')
    uvicorn.run(app, host='127.0.0.1', port=port, log_level='warning')
