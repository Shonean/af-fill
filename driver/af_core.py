# -*- coding: utf-8 -*-
"""AF-Fill driver core: state store, Edge launcher, CDP driver thread, LLM channel.

Threading model:
  - FastAPI threadpool: HTTP endpoints; owns Store mutations (lock-guarded file state).
  - Driver thread: the ONLY owner of the Playwright sync API; executes commands
    submitted via a queue (call() from other threads is safe).
Engine source is injected verbatim (injector.build_init_script); the engine's own
#af-host guard makes re-arming init scripts after data changes safe.
"""
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

import ctypes  # noqa: F401  Win32（窗口图标/AUMID/停靠）模块级助手依赖

import paths
from injector import build_init_script

ROOT = paths.RESOURCE_DIR
PROFILE_PATH = paths.profile_path()
CONFIG_PATH = paths.config_path()
STATE_PATH = paths.state_path()
LEDGER_PATH = paths.ledger_path()
LOGS_DIR = paths.logs_dir()

DEFAULT_CONFIG = {
    'debugPort': 9222,
    'edgeProfileDir': os.path.expanduser('~\\edge-af-profile'),
    'workbenchPort': 8790,
    'llm': {'baseUrl': '', 'apiKey': '', 'model': ''},
}

# 工作台在任务栏的身份标识（AppUserModelID）：工作台窗口与求职 Edge 窗口都归到它名下，
# 任务栏按钮/缩略图显示工作台自己的 AF 图标，而不是 Edge 图标。
APP_AUMID = 'AF.Fill.Workbench'

# af_app 注册的 UI 钩子（如 'show' → 聚焦应用窗口），供 workbench 的 /api/ui/show 调用
UI_HOOKS = {}

STATUSES = ['收录', '已打开', '已填', '已投', '面试', '挂']


def _is_internal_url(u: str) -> bool:
    """浏览器内部页（about:/edge:/chrome:/devtools:）—— 引擎不注入、收录不选中。"""
    return (u or '').lower().startswith(('about:', 'edge:', 'chrome:', 'devtools:', 'view-source:'))


def _load(path, default):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return json.loads(json.dumps(default))


def _save(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def deep_merge(base: dict, override: dict) -> dict:
    """override wins on scalars; dicts recurse; arrays/scalars replaced wholesale."""
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def log_line(msg: str):
    try:
        os.makedirs(LOGS_DIR, exist_ok=True)
        stamp = time.strftime('%Y-%m-%d %H:%M:%S')
        with open(os.path.join(LOGS_DIR, 'driver.log'), 'a', encoding='utf-8') as f:
            f.write(f'[{stamp}] {msg}\n')
    except Exception:
        pass


class Store:
    """File-backed state shared by FastAPI endpoints and the driver thread."""

    def __init__(self):
        self.lock = threading.RLock()
        self.cfg = _load(CONFIG_PATH, DEFAULT_CONFIG)
        if not self.cfg.get('llm'):
            self.cfg['llm'] = dict(DEFAULT_CONFIG['llm'])
        self.profile = _load(PROFILE_PATH, {'schemaVersion': 1, 'base': {'basic': {'name': ''}}})
        self.state = _load(STATE_PATH, {'settings': {'disabled': {}}, 'siteQA': {}, 'audit': [], 'ballPos': None})
        self.ledger = _load(LEDGER_PATH, {'seq': 1, 'entries': []})

    # ---- config ----
    def save_config(self):
        with self.lock:
            _save(CONFIG_PATH, self.cfg)

    # ---- profile / engine state ----
    def init_data(self):
        with self.lock:
            return {
                'profile': self.profile,
                'settings': self.state.get('settings') or {'disabled': {}},
                'siteQA': self.state.get('siteQA') or {},
                'audit': (self.state.get('audit') or [])[-200:],
                'ballPos': self.state.get('ballPos'),
                'endpoint': 'http://127.0.0.1:' + str(self.cfg.get('workbenchPort', 8790)),
            }

    def save_profile(self, profile: dict):
        with self.lock:
            self.profile = profile
            _save(PROFILE_PATH, profile)

    def merge_profile(self, page_profile: dict):
        with self.lock:
            deep_merge(self.profile, page_profile)
            _save(PROFILE_PATH, self.profile)

    def merge_state_key(self, key: str, value):
        with self.lock:
            if key == 'af.settings':
                deep_merge(self.state.setdefault('settings', {'disabled': {}}), value)
            elif key == 'af.siteQA':
                deep_merge(self.state.setdefault('siteQA', {}), value)
            else:
                self.state[key.replace('af.', '')] = value
            _save(STATE_PATH, self.state)

    def append_audit(self, entry: dict):
        with self.lock:
            audit = self.state.setdefault('audit', [])
            audit.append(entry)
            if len(audit) > 500:
                del audit[:len(audit) - 500]
            _save(STATE_PATH, self.state)

    def set_ballpos(self, pos):
        with self.lock:
            self.state['ballPos'] = pos
            _save(STATE_PATH, self.state)

    # ---- ledger ----
    def add_entry(self, url: str, title: str = '', jd: str = '', host: str = '') -> dict:
        with self.lock:
            for e in self.ledger['entries']:
                if e.get('url') == url:
                    changed = []
                    if jd and jd != e.get('jd'):
                        e['jd'] = jd; changed.append('jd')
                    if title and title != e.get('title'):
                        e['title'] = title; changed.append('title')
                    if changed:
                        e['updatedAt'] = time.strftime('%Y-%m-%d %H:%M')
                        _save(LEDGER_PATH, self.ledger)
                    return {'ok': True, 'status': 'updated', 'id': e['id'], 'changed': changed}
            eid = self.ledger['seq']
            self.ledger['seq'] = eid + 1
            entry = {'id': eid, 'company': '', 'position': '', 'url': url, 'title': title or '',
                     'jd': jd or '', 'city': '', 'salary': '', 'stack': [], 'match': '',
                     'summary': '', 'note': '', 'status': '收录', 'llmTagged': False,
                     'createdAt': time.strftime('%Y-%m-%d %H:%M'), 'updatedAt': time.strftime('%Y-%m-%d %H:%M'),
                     'events': [{'t': time.strftime('%Y-%m-%d %H:%M'), 'what': '收录'}]}
            self.ledger['entries'].insert(0, entry)
            _save(LEDGER_PATH, self.ledger)
            log_line(f'ledger +{eid} {url[:80]}')
            return {'ok': True, 'status': 'created', 'id': eid}

    def update_entry(self, eid: int, patch: dict) -> dict:
        with self.lock:
            for e in self.ledger['entries']:
                if e['id'] == eid:
                    allowed = ('company', 'position', 'url', 'title', 'jd', 'city', 'salary',
                               'stack', 'match', 'summary', 'note', 'status')
                    old_status = e.get('status')
                    for k in allowed:
                        if k in patch:
                            e[k] = patch[k]
                    if patch.get('status') and patch['status'] != old_status:
                        e.setdefault('events', []).append({'t': time.strftime('%Y-%m-%d %H:%M'), 'what': patch['status']})
                    e['updatedAt'] = time.strftime('%Y-%m-%d %H:%M')
                    _save(LEDGER_PATH, self.ledger)
                    return {'ok': True}
            return {'ok': False, 'error': 'no such entry'}

    def delete_entry(self, eid: int) -> dict:
        with self.lock:
            before = len(self.ledger['entries'])
            self.ledger['entries'] = [e for e in self.ledger['entries'] if e['id'] != eid]
            _save(LEDGER_PATH, self.ledger)
            return {'ok': len(self.ledger['entries']) < before}

    def mark_filled_by_host(self, host: str, label: str, ok: bool):
        with self.lock:
            for e in self.ledger['entries']:
                try:
                    same = host and host in (e.get('url') or '')
                except Exception:
                    same = False
                if same and e.get('status') in ('收录', '已打开', '已填'):
                    if ok and e['status'] != '已填':
                        e['status'] = '已填'
                        e.setdefault('events', []).append({'t': time.strftime('%Y-%m-%d %H:%M'), 'what': '已填（首次填充事件）'})
                        e['updatedAt'] = time.strftime('%Y-%m-%d %H:%M')
                        _save(LEDGER_PATH, self.ledger)
                    return


# ---------------- Edge launcher ----------------

def _http_ok(url: str, timeout: float = 2.0) -> bool:
    try:
        urllib.request.urlopen(url, timeout=timeout)
        return True
    except Exception:
        return False


def find_edge() -> str:
    cands = [
        os.path.expandvars(r'%ProgramFiles%\Microsoft\Edge\Application\msedge.exe'),
        os.path.expandvars(r'%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe'),
    ]
    for c in cands:
        if os.path.isfile(c):
            return c
    return ''


# ---------------- 窗口身份：图标 + AppUserModelID（任务栏显示工作台图标而非 Edge） ----------------

_ICONS: dict = {}


def workbench_icons():
    """工作台图标 HICON (big, small)：打包模式从 exe 提取；dev 从 build_artifacts/app.ico 加载。进程内缓存。"""
    if _ICONS.get('ok'):
        return _ICONS.get('big', 0), _ICONS.get('small', 0)
    big = small = 0
    try:
        import ctypes
        if paths.is_frozen():
            arr_big = (ctypes.c_void_p * 1)()
            arr_small = (ctypes.c_void_p * 1)()
            n = ctypes.windll.shell32.ExtractIconExW(ctypes.c_wchar_p(sys.executable), 0, arr_big, arr_small, 1)
            if n and n > 0:
                big = arr_big[0] or 0
                small = arr_small[0] or 0
        else:
            ico = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build_artifacts', 'app.ico')
            if os.path.isfile(ico):
                IMAGE_ICON, LR_LOADFROMFILE = 1, 0x10
                big = ctypes.windll.user32.LoadImageW(None, ctypes.c_wchar_p(ico), IMAGE_ICON, 64, 64,
                                                      LR_LOADFROMFILE) or 0
                small = ctypes.windll.user32.LoadImageW(None, ctypes.c_wchar_p(ico), IMAGE_ICON, 16, 16,
                                                        LR_LOADFROMFILE) or 0
    except Exception:
        big = small = 0
    _ICONS['ok'] = True
    _ICONS['big'] = big
    _ICONS['small'] = small
    return big, small


def _send_seticon(hwnd: int, icon_type: int, hicon: int):
    """跨进程替换窗口图标（任务栏/Alt+Tab 生效）。SendMessageTimeout 防目标卡死拖住本进程。"""
    try:
        from ctypes import wintypes
        res = wintypes.DWORD()
        ctypes.windll.user32.SendMessageTimeoutW(
            ctypes.c_void_p(hwnd), 0x0080, wintypes.WPARAM(icon_type), wintypes.LPARAM(hicon),
            0x0002, 300, ctypes.byref(res))            # WM_SETICON, SMTO_ABORTIFHUNG
    except Exception:
        pass


def _job_edge_pids(cfg: dict) -> set:
    """求职 Edge 的 msedge 进程集合（按命令行含专用剖面目录识别）。"""
    try:
        import psutil
    except Exception:
        return set()
    udd = (cfg.get('edgeProfileDir') or '').lower()
    if not udd:
        return set()
    pids = set()
    for p in psutil.process_iter(['name', 'cmdline']):
        try:
            if (p.info['name'] or '').lower() == 'msedge.exe' and any(
                    udd in (c or '').lower() for c in (p.info['cmdline'] or [])):
                pids.add(p.pid)
        except Exception:
            pass
    return pids


def find_job_edge_hwnd(cfg: dict) -> int:
    """求职 Edge 的可见主窗口句柄（应用内停靠用）；无则 0。
    多个候选时取面积最大者（排除 Chromium 小弹窗/气泡）。
    找不到可见窗口时兜底：把隐藏的主窗口显示出来再返回（上一次退出前被藏住的情形）。"""
    pids = _job_edge_pids(cfg)
    if not pids:
        return 0
    try:
        from ctypes import wintypes
    except Exception:
        return 0
    user32 = ctypes.windll.user32
    best = [0, 0]                                # [area, hwnd]
    best_hidden = [0, 0]
    Proc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def _cb(hwnd, _lp):
        try:
            buf = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, buf, 64)
            if not buf.value.startswith(('Chrome_WidgetWin', 'msedge')):
                return True
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value not in pids:
                return True
            r = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            w, h = r.right - r.left, r.bottom - r.top
            if w > 500 and h > 400 and w * h > best[0]:
                best[0], best[1] = w * h, int(hwnd)
            if not user32.IsWindowVisible(hwnd) and w * h > best_hidden[0]:
                best_hidden[0], best_hidden[1] = w * h, int(hwnd)
        except Exception:
            pass
        return True

    try:
        user32.EnumWindows(Proc(_cb), 0)
    except Exception:
        pass
    if not best[1] and best_hidden[1]:
        user32.ShowWindow(wintypes.HWND(best_hidden[1]), 8)   # SW_SHOWNA
        return best_hidden[1]
    return best[1]


def _has_visible_job_edge_window(cfg: dict) -> bool:
    """是否存在可见的求职 Edge 主窗口（只看可见，绝不触发显示隐藏窗口的兜底）。"""
    pids = _job_edge_pids(cfg)
    if not pids:
        return False
    try:
        from ctypes import wintypes
    except Exception:
        return False
    user32 = ctypes.windll.user32
    found = [False]
    Proc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def _cb(hwnd, _lp):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            buf = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, buf, 64)
            if not buf.value.startswith(('Chrome_WidgetWin', 'msedge')):
                return True
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value not in pids:
                return True
            r = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            if (r.right - r.left) > 500 and (r.bottom - r.top) > 400:
                found[0] = True
        except Exception:
            pass
        return True

    try:
        user32.EnumWindows(Proc(_cb), 0)
    except Exception:
        pass
    return found[0]


def _daily_edge_running(cfg: dict) -> bool:
    """日常 Edge（默认档案、无 --type= 子进程标志）是否正在运行。"""
    try:
        import psutil
    except Exception:
        return False
    udd = (cfg.get('edgeProfileDir') or '').lower()
    for p in psutil.process_iter(['name', 'cmdline']):
        try:
            if (p.info['name'] or '').lower() != 'msedge.exe':
                continue
            cl = ' '.join(c or '' for c in (p.info['cmdline'] or []))
            if '--type=' in cl:                        # 渲染/工具子进程
                continue
            if udd and udd in cl.lower():              # 求职 Edge 主进程
                continue
            return True
        except Exception:
            continue
    return False


def _kill_job_edge(cfg: dict) -> int:
    """停掉全部求职 Edge 进程（导入身份前必须：文件锁）。返回杀掉的数量。"""
    try:
        import psutil
    except Exception:
        return 0
    udd = (cfg.get('edgeProfileDir') or '').lower()
    n = 0
    for p in psutil.process_iter(['name', 'cmdline']):
        try:
            if (p.info['name'] or '').lower() == 'msedge.exe' and any(
                    udd in (c or '').lower() for c in (p.info['cmdline'] or [])):
                p.kill()
                n += 1
        except Exception:
            pass
    if n:
        time.sleep(1.5)
    return n


def restart_job_edge(cfg: dict) -> str:
    """停掉求职 Edge 并重新拉起（身份导入后刷新登录态/收藏）。返回版本串。"""
    _kill_job_edge(cfg)
    return ensure_edge(cfg)


IMPORT_FILES = ['Bookmarks', 'Bookmarks.bak', 'Favicons', 'Favicons-journal',
                'Login Data', 'Login Data-journal', 'Login Data-wal',
                'Cookies', 'Cookies-journal', 'Cookies-wal',
                'Web Data', 'Web Data-journal', 'Web Data-wal',
                'History', 'History-journal', 'Preferences']


def import_daily_edge_identity(cfg: dict, src_root: str = '') -> dict:
    """把日常 Edge（默认档案）的收藏/密码/Cookie/自动填充复制到求职 Edge。

    返回 {'ok': True, 'copied': [...], 'backup': path} 或 {'ok': False, 'needClose': True/..., 'message': ...}
    src_root 仅供测试注入临时档案目录；正式路径 = %LOCALAPPDATA%\\Microsoft\\Edge\\User Data。
    """
    src_root = src_root or os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\Edge\User Data')
    src_default = os.path.join(src_root, 'Default')
    dst_root = cfg.get('edgeProfileDir') or ''
    if not dst_root:
        return {'ok': False, 'message': '求职 Edge 剖面目录未配置'}
    dst_default = os.path.join(dst_root, 'Default')
    if not os.path.isdir(src_default):
        return {'ok': False, 'message': '未找到日常 Edge 档案（User Data\\Default）'}
    if _daily_edge_running(cfg):
        return {'ok': False, 'needClose': True,
                'message': '检测到日常 Edge 正在运行 —— 请先完全退出日常 Edge（含后台），再点导入'}
    _kill_job_edge(cfg)                                # 求职 Edge 也持有文件锁
    os.makedirs(dst_default, exist_ok=True)
    bak = paths.data('backup', 'edge-import-' + time.strftime('%Y%m%d-%H%M%S'))
    os.makedirs(bak, exist_ok=True)
    for fn in IMPORT_FILES + ['Local State']:
        src = os.path.join(src_root if fn == 'Local State' else dst_default, fn)
        if os.path.isfile(src):
            try:
                shutil.copy2(src, os.path.join(bak, fn))
            except Exception:
                pass
    copied = []
    for fn in IMPORT_FILES:
        src = os.path.join(src_default, fn)
        if os.path.isfile(src):
            try:
                shutil.copy2(src, os.path.join(dst_default, fn))
                copied.append(fn)
            except Exception:
                pass
    if os.path.isfile(os.path.join(src_root, 'Local State')):   # os_crypt 密钥（密码/Cookie 解密）
        try:
            shutil.copy2(os.path.join(src_root, 'Local State'), os.path.join(dst_root, 'Local State'))
            copied.append('Local State')
        except Exception:
            pass
    log_line(f'[import] daily edge identity → job profile: {len(copied)} files, backup={bak}')
    return {'ok': True, 'copied': copied, 'backup': bak,
            'message': f'导入完成（{len(copied)} 个文件）· 收藏/密码/登录态已进入求职 Edge'}


def _polish_job_edge_windows(cfg: dict):
    """求职 Edge（按命令行里含专用剖面目录识别的 msedge 进程）可见主窗口：
    最大化 + 图标换成工作台 AF 图标 + 设置工作台 AppUserModelID（任务栏不再显示 Edge 图标）。"""
    try:
        from ctypes import wintypes
    except Exception:
        return
    pids = _job_edge_pids(cfg)
    if not pids:
        return
    user32 = ctypes.windll.user32
    big, small = workbench_icons()
    Proc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def _cb(hwnd, _lparam):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            buf = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, buf, 64)
            if not buf.value.startswith(('Chrome_WidgetWin', 'msedge')):
                return True
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value in pids:
                if not user32.GetParent(hwnd):      # 已停靠（有父窗口）时不最大化，交给应用布局
                    user32.ShowWindow(hwnd, 3)      # SW_MAXIMIZE
                if big:
                    _send_seticon(int(hwnd), 1, int(big))     # ICON_BIG
                if small:
                    _send_seticon(int(hwnd), 0, int(small))   # ICON_SMALL
        except Exception:
            pass
        return True

    try:
        user32.EnumWindows(Proc(_cb), 0)
    except Exception:
        pass


def open_in_job_edge(cfg: dict, url: str) -> bool:
    """把 URL 开进求职 Edge（专用剖面）；同 URL 已有 tab → 激活并最大化，否则新窗口+最大化；找不到 Edge 回退系统浏览器。"""
    edge = find_edge()
    udd = cfg.get('edgeProfileDir')
    port = cfg.get('debugPort', 9222)
    if edge and udd and os.path.isdir(udd):
        try:
            # 已开着同 URL 的 tab → 激活即可（防重复弹窗）
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/json', timeout=1.5) as r:
                    tabs = json.loads(r.read().decode('utf-8', 'ignore'))
                hit = next((t for t in tabs if str(t.get('url') or '').split('#')[0] == url), None)
                if hit:
                    urllib.request.urlopen(f'http://127.0.0.1:{port}/json/activate/{hit["id"]}', timeout=2)
                    _polish_job_edge_windows(cfg)
                    return True
            except Exception:
                pass
            subprocess.Popen([edge, f'--user-data-dir={udd}', '--new-window', url],
                             creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            time.sleep(1.2)                          # 等窗口建立
            _polish_job_edge_windows(cfg)
            return True
        except Exception:
            pass
    try:
        import webbrowser
        return bool(webbrowser.open(url))
    except Exception:
        return False


def _kill_stale_profile_edges(udd: str):
    """杀掉占用专用剖面但没有监听 debug 端口的 Edge 残留实例。

    场景：Edge 崩溃恢复/兼容层重启后，剖面被一个没有 --remote-debugging-port 的
    实例占用，新起的命令行全被路由进去，debug 端口永远起不来。
    仅在 ensure_edge 里、且「端口持续 ≥30s 不通 + 无任何可见求职 Edge 窗口」时才调用，
    避免把用户正在使用的窗口整批杀没。"""
    try:
        import psutil
    except Exception:
        return
    udd_l = (udd or '').lower()
    killed = 0
    for p in psutil.process_iter(['name', 'cmdline']):
        try:
            if (p.info['name'] or '').lower() == 'msedge.exe' and any(
                    udd_l in (c or '').lower() for c in (p.info['cmdline'] or [])):
                p.kill()
                killed += 1
        except Exception:
            pass
    if killed:
        log_line(f'[edge] killed {killed} stale profile edge processes (no debug port)')
        time.sleep(1.5)


_EDGE_DOWN = {'since': 0.0, 'noKillLogged': False}   # 调试端口持续不通的起点


def ensure_edge(cfg: dict) -> str:
    port = cfg.get('debugPort', 9222)
    ver_url = f'http://127.0.0.1:{port}/json/version'
    if _http_ok(ver_url):
        _EDGE_DOWN['since'] = 0.0
        _EDGE_DOWN['noKillLogged'] = False
        with urllib.request.urlopen(ver_url, timeout=2) as r:
            ver = json.loads(r.read().decode('utf-8', 'ignore')).get('Browser', 'edge')
        _polish_job_edge_windows(cfg)
        return ver
    edge = find_edge()
    if not edge:
        raise RuntimeError('msedge.exe not found')
    udd = cfg.get('edgeProfileDir')
    # 清残留实例是最后手段：端口不通可能只是 Edge 繁忙/探活超时，若用户窗口还在，
    # 绝不清场（此前无条件 kill 会把整批窗口秒关——「秒退弹窗」的元凶）。
    if not _EDGE_DOWN['since']:
        _EDGE_DOWN['since'] = time.time()
    waited = time.time() - _EDGE_DOWN['since']
    if waited >= 30 and not _has_visible_job_edge_window(cfg):
        _kill_stale_profile_edges(udd)
    elif waited >= 30 and not _EDGE_DOWN['noKillLogged']:
        _EDGE_DOWN['noKillLogged'] = True
        log_line('[edge] debug port down ≥30s but job Edge window visible → keep it (no kill)')
    os.makedirs(udd, exist_ok=True)
    subprocess.Popen([edge, f'--remote-debugging-port={port}', f'--user-data-dir={udd}',
                      '--no-first-run', '--no-default-browser-check', '--start-maximized',
                      '--proxy-bypass-list=<local>;127.0.0.1;localhost',
                      'edge://newtab'],
                     creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    for _ in range(60):
        time.sleep(0.5)
        if _http_ok(ver_url):
            with urllib.request.urlopen(ver_url, timeout=2) as r:
                ver = json.loads(r.read().decode('utf-8', 'ignore')).get('Browser', 'edge')
            time.sleep(0.5)                      # 等首窗建立
            _polish_job_edge_windows(cfg)
            return ver
    raise RuntimeError('edge debug port did not come up in 30s')


# ---------------- LLM (OpenAI-compatible, stdlib only) ----------------

def llm_chat(cfg: dict, messages: list, timeout: float = 60.0):
    """Returns message content str, or None on any failure (mirrors userscript behaviour)."""
    base = str((cfg or {}).get('baseUrl') or '').rstrip('/')
    key = (cfg or {}).get('apiKey') or ''
    if not base or not key:
        return None
    url = base if base.endswith('/chat/completions') else base + '/chat/completions'
    body = json.dumps({'model': (cfg or {}).get('model') or 'deepseek-chat',
                       'messages': messages, 'temperature': 0, 'stream': False}).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read().decode('utf-8', 'ignore'))
            return ((j.get('choices') or [{}])[0].get('message') or {}).get('content')
    except Exception as e:
        log_line(f'llm_chat error: {e}')
        return None


def llm_forward(payload: dict, timeout: float = 20.0):
    """Generic proxy used by the page-side GM_xmlhttpRequest shim."""
    url = payload.get('url') or ''
    if not url.startswith(('http://', 'https://')):
        return {'error': 'bad url'}
    method = (payload.get('method') or 'GET').upper()
    headers = {k: v for k, v in (payload.get('headers') or {}).items()
               if k.lower() not in ('host', 'content-length', 'connection')}
    data = payload.get('body')
    if data is not None and isinstance(data, str):
        data = data.encode('utf-8')
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return {'status': r.status, 'text': r.read().decode('utf-8', 'ignore')}
    except urllib.error.HTTPError as e:
        try:
            return {'status': e.code, 'text': e.read().decode('utf-8', 'ignore')}
        except Exception:
            return {'error': str(e)}
    except Exception as e:
        return {'error': str(e)}


# ---------------- Driver thread (sole Playwright owner) ----------------

class _AttachDrift(Exception):
    """playwright 视野与 Edge 实际 tab 不一致（auto-attach 事件丢失）。"""


class Driver(threading.Thread):
    def __init__(self, store: Store):
        super().__init__(daemon=True, name='af-driver')
        self.store = store
        self.cmds: queue.Queue = queue.Queue()
        self.stop_flag = False
        self.status = {'edge': False, 'cdp': False, 'error': None, 'edgeVer': '', 'pages': [], 'lazy': True}
        self._script = ''
        self._connected = False               # 懒启动：False 时不拉 Edge、不连 CDP
        self.pw = None
        self.browser = None
        self.ctx = None
        self._probe_fails = 0                 # 连续探活失败次数（防繁忙误判 Edge 死亡）
        self._drift_set = []                  # 上一轮缺失的 tab 集合（需持续 ≥3s 才判 drift）
        self._drift_since = 0.0
        self._last_reattach = 0.0             # 重连限频

    # ---- public (any thread) ----
    def call(self, name: str, arg=None, timeout: float = 60.0):
        box = {'ev': threading.Event(), 'res': None, 'err': None}
        self.cmds.put((name, arg, box))
        if not box['ev'].wait(timeout):
            raise TimeoutError(f'driver cmd timeout: {name}')
        if box['err']:
            raise box['err']
        return box['res']

    def stop(self):
        self.stop_flag = True

    # ---- internals ----
    def log(self, msg: str):
        log_line(f'[driver] {msg}')

    def run(self):
        try:
            self._run()
        except Exception as e:
            self.status['error'] = f'{type(e).__name__}: {e}'
            self.log('fatal: ' + self.status['error'])
        finally:
            self.status['beat'] = 0               # 线程已退出/卡死后不再有心跳

    def _ensure_connected(self):
        """懒启动：首次需要 Edge 的命令（打开职位/采集本页/重新注入）才拉起浏览器并连 CDP。
        双击 exe → 只见工作台应用窗口，绝不弹浏览器；浏览器窗口在真正要用时才出现。"""
        if self._connected:
            return
        cfg = self.store.cfg
        self.status['edgeVer'] = ensure_edge(cfg)      # ensure_edge 内部已做最大化+图标+AUMID
        self.status['edge'] = True
        self.log(f"edge ready: {self.status['edgeVer']} on :{cfg.get('debugPort')}")
        from playwright.sync_api import sync_playwright
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.connect_over_cdp(f"http://127.0.0.1:{cfg.get('debugPort')}")
        self.ctx = self.browser.contexts[0] if self.browser.contexts else self.browser.new_context()
        self.status['cdp'] = True
        self.status['lazy'] = False
        self._connected = True
        self.log('cdp connected, contexts=%d pages=%d' % (len(self.browser.contexts), len(self.ctx.pages)))
        self.cmd_rearm(None)                           # 此刻已连接 → 会 add_init_script
        self._inject_existing()
        try:
            self.ctx.on('page', lambda p: self.log('page opened: ' + (p.url or '')[:90]))
        except Exception:
            pass

    def _run(self):
        # 懒启动主循环：未连接时只处理队列 + 心跳；连接后保持原有监控/重连逻辑
        while not self.stop_flag:
            self.status['beat'] = time.time()
            try:
                while True:
                    name, arg, box = self.cmds.get_nowait()
                    try:
                        box['res'] = getattr(self, 'cmd_' + name)(arg)
                    except Exception as e:
                        box['err'] = e
                        self.log(f'cmd {name} error: {e}')
                    finally:
                        box['ev'].set()
            except queue.Empty:
                pass
            if not self._connected:
                time.sleep(0.5)
                continue
            # HTTP 预检：Edge 死亡时 playwright sync 调用可能永久挂起（不抛异常），
            # 先用纯 HTTP 探测 9222，死了绝不碰 playwright，直接走重连。
            # 繁忙时探活可能瞬时超时：单次失败只跳过本轮（不碰 playwright 也就不怕挂起），
            # 连续 2 次失败才判死重连，避免「误判死亡 → kill 用户窗口」。
            cfg = self.store.cfg
            if not _http_ok(f"http://127.0.0.1:{cfg.get('debugPort', 9222)}/json/version", 5):
                self._probe_fails += 1
                if self._probe_fails >= 2:
                    self._probe_fails = 0
                    self.status['cdp'] = False
                    self.status['error'] = 'edge gone (http probe x2) → reconnecting'
                    self.log('edge gone → reconnecting')
                    try:
                        self._reconnect()
                    except Exception as e2:
                        self.status['error'] = f'reconnect failed: {e2}'
                        self.log('reconnect failed: ' + str(e2))
                        time.sleep(3)
                continue
            self._probe_fails = 0
            try:
                self._refresh_pages()
            except _AttachDrift as e:
                self.status['error'] = f'attach drift: {e} → re-attaching'
                self.log('attach drift → full re-attach')
                self._last_reattach = time.time()
                try:
                    if self.browser:
                        self.browser.close()
                except Exception:
                    pass
                try:
                    self.browser = self.pw.chromium.connect_over_cdp(
                        f"http://127.0.0.1:{cfg.get('debugPort', 9222)}")
                    self.ctx = self.browser.contexts[0] if self.browser.contexts else self.browser.new_context()
                    self.status['cdp'] = True
                    self.status['error'] = None
                    self.log('re-attached: pages=%d' % len(self.ctx.pages))
                    self.cmd_rearm(None)
                    self._inject_existing()
                except Exception as e2:
                    self.status['error'] = f're-attach failed: {e2}'
                    self.log('re-attach failed: ' + str(e2))
                    time.sleep(3)
                continue
            except Exception as e:
                self.status['cdp'] = False
                self.status['error'] = f'cdp lost: {e} → reconnecting'
                self.log('refresh failed: ' + str(e))
                try:
                    self._reconnect()
                except Exception as e2:
                    self.status['error'] = f'reconnect failed: {e2}'
                    self.log('reconnect failed: ' + str(e2))
                    time.sleep(3)
                continue
            self.status['cdp'] = True
            self.status['error'] = None
            time.sleep(1.5)

    def _reconnect(self):
        """Edge 被关/崩溃/被杀后自动重连。关键：整个 playwright 实例一起重建——
        Edge 死亡后旧 pw 实例的事件分发已坏，复用它 connect 的话 auto-attach 失效
        （新开标签页永远进不了 ctx.pages）。"""
        cfg = self.store.cfg
        try:
            if self.browser:
                self.browser.close()
        except Exception:
            pass
        self.browser = None
        self.ctx = None
        try:
            if self.pw:
                self.pw.stop()
        except Exception:
            pass
        self.pw = None
        self.status['edgeVer'] = ensure_edge(cfg)
        self.status['edge'] = True
        from playwright.sync_api import sync_playwright
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.connect_over_cdp(f"http://127.0.0.1:{cfg.get('debugPort')}")
        self.ctx = self.browser.contexts[0] if self.browser.contexts else self.browser.new_context()
        self.status['cdp'] = True
        self.status['error'] = None
        self.log('reconnected: contexts=%d pages=%d' % (len(self.browser.contexts), len(self.ctx.pages)))
        self.cmd_rearm(None)
        self._inject_existing()

    def _build_script(self) -> str:
        d = self.store.init_data()
        return build_init_script(d['profile'], d['settings'], d['siteQA'], d['audit'],
                                 d['ballPos'], d['endpoint'])

    def cmd_rearm(self, arg):
        """重建注入脚本。内容没变则不再 add_init_script —— Playwright 不去重，
        每次 rearm 都会给上下文叠一份 119KB 脚本、新页面挨个执行。"""
        new = self._build_script()
        changed = (new != self._script)
        self._script = new
        self.init_version = getattr(self, 'init_version', 0) + 1
        if self._connected and changed:
            self.ctx.add_init_script(self._script)   # later scripts override __AF_DATA; #af-host guard dedupes engine
        return self.init_version

    def _inject_existing(self, only_missing: bool = False):
        """only_missing=True 时跳过已注入帧（查 window.__AF_LOADED 标记）——
        重复 reinject（窗口重停靠等）不再把 119KB 引擎反复 evaluate 进所有页面。"""
        n = 0
        for page in self.ctx.pages:
            if _is_internal_url(page.url):
                continue
            for frame in page.frames:
                if _is_internal_url(frame.url):
                    continue
                if only_missing:
                    try:
                        if frame.evaluate('!!(window.__AF_LOADED || window.__AF_SHIM_READY)'):
                            continue
                    except Exception:
                        continue
                try:
                    frame.evaluate(self._script)
                    n += 1
                except Exception as e:
                    self.log(f'inject skip {frame.url[:60]}: {type(e).__name__} {e}')
        self.log(f'injected into {n} frames of {len(self.ctx.pages)} existing pages')

    def cmd_inject_existing(self, arg):
        self._ensure_connected()
        self._inject_existing(only_missing=True)
        return True

    def _usable_pages(self):
        """可操作的标签页：排除 about:/edge:/chrome:// 等内部页（悬浮球/收录都不针对它们）。"""
        return [p for p in self.ctx.pages if not _is_internal_url(p.url)]

    def _refresh_pages(self):
        pages = []
        for i, p in enumerate(self._usable_pages()):
            try:
                info = p.evaluate("(() => ({ u: location.href, t: (document.title || '').slice(0, 70), v: document.visibilityState }))()")
                pages.append({'i': i, 'url': info.get('u', ''), 'title': info.get('t', ''), 'visible': info.get('v') == 'visible'})
            except Exception:
                pages.append({'i': i, 'url': p.url, 'title': '', 'visible': False})
        # 对账：Edge 的真实 tab（CDP HTTP /json）必须都在 playwright 视野里。
        # Edge 在崩溃恢复等状态下 auto-attach 事件会静默失效，新开的 tab 永远
        # 不进 ctx.pages——只能靠对账发现，然后整体重连（connect 会全量枚举）。
        # 跳转中的 tab（/json 已报新 URL、playwright 还停在旧文档）会瞬时缺失：
        # 同一批缺失持续 ≥3s 且距上次重连 ≥8s 才判 drift，避免误判风暴。
        try:
            port = self.store.cfg.get('debugPort', 9222)
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/json', timeout=2) as r:
                real = json.loads(r.read().decode('utf-8', 'ignore'))
            norm = lambda u: (u or '').split('#')[0]
            real_urls = sorted({norm(t.get('url', '')) for t in real
                                if t.get('type') == 'page' and not _is_internal_url(t.get('url', ''))
                                and norm(t.get('url', ''))})
            seen = {norm(p.url) for p in self.ctx.pages}
            missing = [u for u in real_urls if u and u not in seen]
            now = time.time()
            if missing:
                if self._drift_set != missing:
                    self._drift_set = missing
                    self._drift_since = now
                if (now - self._drift_since) >= 3 and (now - self._last_reattach) >= 8:
                    raise _AttachDrift(f'{len(missing)} tab(s) outside playwright: ' + missing[0][:60])
            else:
                self._drift_set = []
                self._drift_since = 0.0
        except _AttachDrift:
            raise
        except Exception:
            pass                      # 对账失败不阻塞正常 refresh
        self.status['pages'] = pages

    def _pick_page(self, index=None):
        pages = self._usable_pages()
        if not pages:
            raise RuntimeError('no usable tabs')
        if index is not None and 0 <= index < len(pages):
            return pages[index]
        for p in pages:
            try:
                if p.evaluate('document.visibilityState') == 'visible':
                    return p
            except Exception:
                continue
        return pages[-1]

    def cmd_page_jd(self, arg):
        self._ensure_connected()
        page = self._pick_page((arg or {}).get('index'))
        return page.evaluate(
            "(() => ({ url: location.href, title: document.title, host: location.host,"
            " jd: (document.body && document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 3000) }))()")

    def cmd_open(self, arg):
        self._ensure_connected()
        url = (arg or {}).get('url')
        if not url or not url.startswith(('http://', 'https://')):
            raise ValueError('bad url')
        page = self.ctx.new_page()
        # commit 即返回：不等 DOMContentLoaded（招聘站 DCL 常 3~5s）。页面在「浏览」
        # 页签里渐进加载，观感与正常浏览器一致；队列错峰 2.5s 仍由调用方控制。
        page.goto(url, wait_until='commit', timeout=45000)
        try:
            title = page.title()
        except Exception:
            title = ''
        return {'finalUrl': page.url, 'title': title}
