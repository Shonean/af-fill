# -*- coding: utf-8 -*-
"""AF-Fill 求职工作台 — 打包入口（windowed exe / pythonw 均可运行）。

启动序列：数据目录初始化 → 进程身份(AUMID) → 单例探测 → uvicorn 线程 → 托盘 → 应用主窗。
主窗（WinForms）：「工作台」页签 = WebView2 仪表盘；「浏览」页签 = 停靠进来的完整求职 Edge。
窗口关闭 = 收进托盘，托盘「退出」才真正退出。求职 Edge 懒启动：首次需要时才拉起。
宿主兜底链：WinForms 宿主 → pywebview 单窗 → 系统浏览器打开 dashboard。
"""
import ctypes
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import urllib.request

import af_core
import paths

# 窗口化模式下 stdout/stderr 可能为 None：先保证数据目录，再把输出重定向到日志（最早执行）
try:
    paths.ensure_data_dirs()
except Exception:
    pass
try:
    if sys.stdout is None:
        sys.stdout = open(paths.logs_dir() + r'\app.log', 'a', encoding='utf-8', buffering=1)
    if sys.stderr is None:
        sys.stderr = sys.stdout
except Exception:
    pass

# 崩溃留痕：段错误/未捕获异常（主线程+子线程）全部落 app.log，杜绝「静默死亡无日志」
try:
    import faulthandler
    faulthandler_log = open(paths.logs_dir() + r'\app.log', 'a', encoding='utf-8', buffering=1)
    faulthandler.enable(faulthandler_log)
except Exception:
    pass


def _hook_exit(t, v, tb):
    log('FATAL ' + ''.join(traceback.format_exception(t, v, tb)))


def _hook_thread(a):
    log('THREAD FATAL ' + ''.join(traceback.format_exception(a.exc_type, a.exc_value, a.exc_traceback)))


sys.excepthook = _hook_exit
threading.excepthook = _hook_thread

STORE = None
APP = None
DRIVER = None
SCAN = None
_HOST = None                              # 'winforms' | 'pywebview' | None
_UI = {'win': None, 'alive': False}       # pywebview 主窗口引用 / GUI 循环是否存活
_TRAY_ICON = None
_RUNNING = threading.Event()
_RUNNING.set()
_MUTEX = None                             # 命名互斥体句柄（进程退出自动释放）
_MUTEX_NAME = 'AF.Fill.Workbench.Singleton'
_SRV = {'alive': False, 'lastStart': 0.0} # 服务线程状态（看门狗判活）


def log(msg: str):
    try:
        with open(paths.logs_dir() + r'\app.log', 'a', encoding='utf-8') as f:
            f.write(time.strftime('[%Y-%m-%d %H:%M:%S] ') + msg + '\n')
    except Exception:
        pass


def _default_config() -> dict:
    return {
        'debugPort': 9222,
        'edgeProfileDir': os.path.expanduser('~\\edge-af-profile'),
        'workbenchPort': 8790,
        'llm': {'baseUrl': '', 'apiKey': '', 'model': ''},
        'watch': {
            'intervalHours': 0,
            'expireDays': 30,
            'filterPrompt': (
                '用户画像：<你的届别/专业/就业状态>；目标岗位：<岗位方向，如 软件/计算机/信息技术类>。\n'
                '逐条判断招聘公告：\n'
                '- 收：符合你的届别与择业期政策的公告；技术岗或专业不限的技术类公告。\n'
                '- 不收：仅招其他届别且排除你的届别；与目标方向无关；培训/辅导班广告；deadline 明显已过。\n'
                '只输出 JSON 数组：[{"i":行号,"relevant":布尔,"reason":"20字内理由","company":"公司/单位",'
                '"position":"岗位或公告主题","city":"城市","deadline":"截止日期或空","target":"届别/不限"}]，不要解释。'
            ),
        },
    }


def _port_alive(url: str, timeout: float = 1.5) -> bool:
    try:
        urllib.request.urlopen(url, timeout=timeout)
        return True
    except Exception:
        return False


def _acquire_singleton() -> bool:
    """命名互斥体单例（内核对象，进程退出/被杀自动释放）。False = 已有实例在运行。
    端口探测是 TOCTOU 竞态（旧实例服务未 bind 完就能溜进来），互斥体才是可靠闸门。"""
    global _MUTEX
    try:
        k32 = ctypes.windll.kernel32
        h = k32.CreateMutexW(None, False, _MUTEX_NAME)
        if not h:
            return True                         # 创建失败 → 退化为端口探测
        if k32.GetLastError() == 183:           # ERROR_ALREADY_EXISTS
            k32.CloseHandle(h)
            return False
        _MUTEX = h
        return True
    except Exception:
        return True


def _request_show(port: int, tries: int = 8):
    """请已有实例把工作台窗口带到前台（它可能还在启动，重试几轮）。"""
    for _ in range(tries):
        try:
            req = urllib.request.Request(f'http://127.0.0.1:{port}/api/ui/show', data=b'{}',
                                         headers={'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(req, timeout=2) as r:
                body = json.loads(r.read().decode('utf-8', 'ignore'))
            if body.get('ok'):
                return
        except Exception:
            pass
        time.sleep(0.5)


def _bind_socket(port: int):
    """抢占 127.0.0.1:port。成功返回 listening socket；被占用返回 None。"""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(('127.0.0.1', port))
        s.listen(128)
        return s
    except OSError:
        try:
            s.close()
        except Exception:
            pass
        return None


def first_run_init():
    """数据目录种子：config / profile / watch。全部缺省时才写，不覆盖用户数据。"""
    cfg_p = paths.config_path()
    if not os.path.exists(cfg_p):
        with open(cfg_p, 'w', encoding='utf-8') as f:
            json.dump(_default_config(), f, ensure_ascii=False, indent=2)
        log('first run: config.json written')
    prof_p = paths.profile_path()
    if not os.path.exists(prof_p):
        seed = paths.seed_profile_path()
        if os.path.exists(seed):
            import shutil
            shutil.copyfile(seed, prof_p)
            log('first run: profile seeded from template')
    src_p = paths.data('watch', 'sources.json')
    if not os.path.exists(src_p):
        seed = paths.seed_sources_path()
        if os.path.exists(seed):
            import shutil
            shutil.copyfile(seed, src_p)
            log('first run: watch sources seeded from template')
    create_desktop_shortcut()


def create_desktop_shortcut():
    """桌面快捷方式「求职工作台」→ 本 exe（仅打包模式）。已存在但指向漂移（如目录搬迁）时自动修复。"""
    if not paths.is_frozen():
        return
    lnk = os.path.join(os.path.expanduser('~'), 'Desktop', '求职工作台.lnk')
    exe = sys.executable
    try:
        if os.path.exists(lnk):
            import pythoncom  # noqa: F401  确保 COM 可用
        ps_check = (
            "$sh=New-Object -ComObject WScript.Shell;"
            f"$l=$sh.CreateShortcut('{lnk}');"
            f"Write-Output $l.TargetPath"
        )
        r = subprocess.run(['powershell', '-NoProfile', '-Command', ps_check],
                           capture_output=True, text=True, timeout=20,
                           creationflags=0x08000000)
        if r.returncode == 0 and r.stdout.strip().lower() == exe.lower():
            return                                    # 已指向本 exe → 不动
    except Exception:
        pass
    ps = (
        "$ws=New-Object -ComObject WScript.Shell;"
        f"$s=$ws.CreateShortcut('{lnk}');"
        f"$s.TargetPath='{exe}';"
        f"$s.WorkingDirectory='{os.path.dirname(exe)}';"
        "$s.IconLocation='" + exe + ",0';"
        "$s.Description='AF-Fill 求职工作台';"
        "$s.Save()"
    )
    try:
        subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
                       capture_output=True, timeout=20,
                       creationflags=0x08000000)  # CREATE_NO_WINDOW
        log('desktop shortcut created/repaired')
    except Exception as e:
        log('shortcut create failed: ' + str(e))


def start_server(sock=None):
    """运行 uvicorn（sock 非空时用已抢占的 listening socket，端口归属无歧义）。"""
    global STORE, APP, DRIVER
    import uvicorn
    import workbench as wb
    STORE, APP, DRIVER = wb.store, wb.app, wb.driver
    port = STORE.cfg.get('workbenchPort', 8790)
    log('workbench server starting')
    try:
        cfg = uvicorn.Config(wb.app, host='127.0.0.1', port=port, log_level='warning')
        uvicorn.Server(cfg).run(sockets=[sock] if sock is not None else None)
        log('workbench server stopped')
    except Exception as e:
        log('workbench server DIED: ' + str(e))
    finally:
        _SRV['alive'] = False


def watchdog():
    """每 10s 探测 8790：自己的服务线程真死 → 自绑确认端口空闲后重启；
    端口被别的进程占着（老版本实例/僵尸）→ 本进程直接退出，绝不做硬跑的僵尸。"""
    while _RUNNING.is_set():
        time.sleep(10)
        try:
            port = (STORE.cfg.get('workbenchPort', 8790) if STORE else 8790)
            if _port_alive(f'http://127.0.0.1:{port}/api/state', 2):
                continue
            if _SRV.get('alive'):
                continue                        # 自己的服务还活着，探活超时 ≠ 服务死
            if time.time() - _SRV.get('lastStart', 0) < 20:
                continue                        # 刚起服，给足启动时间
            s = _bind_socket(port)
            if s is None:
                log('watchdog: port held by another process → quit this zombie instance')
                os._exit(0)
            s.close()
            log('watchdog: workbench down → restarting server thread')
            _SRV['alive'] = True
            _SRV['lastStart'] = time.time()
            threading.Thread(target=start_server, daemon=True, name='af-server-r').start()
            time.sleep(15)                      # 给新线程起服时间，避免连发
        except Exception:
            pass


# ---------------- 应用窗口（pywebview / WebView2，即「Edge 封装成 app 的前端界面」） ----------------

def _bind_window(w):
    try:
        w.events.closed += _on_main_closed
    except Exception:
        pass


def _on_main_closed(*_a):
    _UI['win'] = None


def _open_main_window(url: str):
    import webview
    w = webview.create_window('求职工作台', url, width=1420, height=920,
                              min_size=(1100, 700), background_color='#101014',
                              maximized=True)
    _bind_window(w)
    _UI['win'] = w
    return w


def tray_open(icon=None, item=None):
    """托盘「打开工作台」/ 二次启动请求：聚焦应用主窗，绝不弹浏览器。"""
    cfg = (STORE.cfg if STORE else _default_config())
    url = f"http://127.0.0.1:{cfg.get('workbenchPort', 8790)}/"
    if _HOST == 'winforms':
        try:
            import app_window
            app_window.show_and_focus()
            return
        except Exception as e:
            log('focus winforms window failed: ' + str(e))
    if _HOST == 'pywebview':
        import webview
        w = _UI.get('win')
        if w is not None and w in getattr(webview, 'windows', []):
            for fn in ('restore', 'show'):
                try:
                    getattr(w, fn)()
                except Exception:
                    pass
            return
        if not _UI.get('alive'):
            af_core.open_in_job_edge(cfg, url)   # GUI 循环不可用时的兜底
            return
        try:
            _open_main_window(url)
            log('workbench window reopened from tray')
            return
        except Exception as e:
            log('reopen window failed: ' + str(e))
    af_core.open_in_job_edge(cfg, url)


def tray_scan(icon=None, item=None):
    if SCAN is not None:
        try:
            SCAN.watch_scan({})
        except Exception as e:
            log('tray scan failed: ' + str(e))


def tray_edge(icon=None, item=None):
    try:
        af_core.ensure_edge(STORE.cfg)      # 内部含最大化 + AF 图标 + AUMID
        af_core.open_in_job_edge(STORE.cfg, 'about:blank')
        log('job edge restarted via tray')
    except Exception as e:
        log('tray edge failed: ' + str(e))


def tray_quit(icon=None, item=None):
    log('quit via tray')
    _RUNNING.clear()
    try:
        if DRIVER is not None:
            DRIVER.stop()
    except Exception:
        pass
    if _HOST == 'winforms':
        try:
            import app_window
            app_window.pre_exit()                  # 解除停靠，还原 Edge 窗口
        except Exception:
            pass
    try:
        import webview
        for w in list(getattr(webview, 'windows', [])):
            try:
                w.destroy()
            except Exception:
                pass
    except Exception:
        pass
    try:
        if _TRAY_ICON is not None:
            _TRAY_ICON.stop()
    except Exception:
        pass
    os._exit(0)


def make_tray():
    import pystray
    from PIL import Image, ImageDraw

    def _img():
        img = Image.new('RGBA', (64, 64), (255, 255, 255, 0))
        d = ImageDraw.Draw(img)
        d.ellipse([3, 3, 61, 61], fill=(255, 255, 255), outline=(20, 20, 22), width=3)
        d.text((16, 18), 'AF', fill=(20, 20, 22))
        return img

    menu = pystray.Menu(
        pystray.MenuItem('打开工作台', tray_open, default=True),
        pystray.MenuItem('立即扫描', tray_scan),
        pystray.MenuItem('重启求职 Edge', tray_edge),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('退出', tray_quit),
    )
    return pystray.Icon('af_fill', _img(), 'AF-Fill 求职工作台', menu)


def _set_process_aumid():
    """进程级 AppUserModelID：应用窗口在任务栏以工作台身份显示/分组。必须在任何窗口创建前调用。"""
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(af_core.APP_AUMID)
    except Exception:
        pass


def _ui_loop():
    """阻塞：应用主窗循环。首选 WinForms 宿主（工作台+停靠浏览），失败退回 pywebview 单窗。"""
    global _HOST
    cfg = (STORE.cfg if STORE else _default_config())
    url = f"http://127.0.0.1:{cfg.get('workbenchPort', 8790)}/"
    try:
        import app_window
        _HOST = 'winforms'
        af_core.UI_HOOKS['browse'] = app_window.request_browse   # 队列打开→切浏览页签
        log('winforms host starting')
        app_window.run(url, get_cfg=lambda: (STORE.cfg if STORE else _default_config()), log_fn=log)
        _HOST = None
        return
    except SystemExit:
        raise
    except Exception:
        _HOST = 'pywebview'
        log('winforms host unavailable → pywebview fallback:\n' + traceback.format_exc()[-700:])

    try:
        webview_create(url)
    except Exception as e:
        log('webview unavailable → fallback browser: ' + str(e))
        try:
            af_core.open_in_job_edge(cfg, url)
        except Exception:
            pass
    _UI['alive'] = False
    _UI['win'] = None
    # GUI 循环结束（窗口全部关闭/异常）后保持进程存活，等托盘「退出」
    while _RUNNING.is_set():
        time.sleep(0.5)
    log('ui loop exit')


def webview_create(url: str):
    """pywebview 兜底宿主：隐藏锚窗口保证主窗关闭后 GUI 循环仍存活。"""
    import webview
    try:
        webview.create_window('af-anchor', html='<html></html>', width=1, height=1, hidden=True)
    except Exception as e:
        log('anchor window unavailable: ' + str(e))
    try:
        try:
            os.makedirs(paths.data('webview2'), exist_ok=True)
        except Exception:
            pass
        _open_main_window(url)
        _UI['alive'] = True
        try:
            webview.start(gui='edgechromium', private_mode=False,
                          storage_path=paths.data('webview2'))
        except TypeError:
            webview.start(gui='edgechromium')     # 老版本 pywebview 无 storage_path/private_mode
    except Exception:
        _UI['alive'] = False
        _UI['win'] = None
        raise


def main():
    # 单例第一道闸：命名互斥体（可靠，无 TOCTOU）。已在跑 → 聚焦它的窗口，本进程干净退出。
    if not _acquire_singleton():
        port0 = 8790
        try:
            with open(paths.config_path(), encoding='utf-8') as f:
                port0 = json.load(f).get('workbenchPort', 8790)
        except Exception:
            pass
        _request_show(port0)
        log('already running (mutex): ui-show requested, exit')
        sys.exit(0)

    first_run_init()
    _set_process_aumid()

    port = 8790
    cfg = _default_config()
    try:
        with open(paths.config_path(), encoding='utf-8') as f:
            cfg = json.load(f)
        port = cfg.get('workbenchPort', 8790)
    except Exception:
        pass
    # 单例第二道闸：老版本实例（无互斥体）占着端口 → 聚焦后退出
    if _port_alive(f'http://127.0.0.1:{port}/api/state'):
        _request_show(port)
        log('already running (port): ui-show requested, exit')
        sys.exit(0)

    # 单例第三道闸：自绑端口。抢不到 = 端口被占 → 退出，绝不带着失败的服务硬跑 UI/看门狗
    sock = _bind_socket(port)
    if sock is None:
        _request_show(port)
        log('port %s busy → ui-show requested, exit' % port)
        sys.exit(0)

    af_core.UI_HOOKS['show'] = tray_open
    _SRV['alive'] = True
    _SRV['lastStart'] = time.time()
    threading.Thread(target=start_server, args=(sock,), daemon=True, name='af-server').start()
    threading.Thread(target=watchdog, daemon=True, name='af-watchdog').start()
    # 等服务就绪再开窗（页面自身每 2.5s 轮询自愈，等不到最多 20s 也照开）
    for _ in range(40):
        if _port_alive(f'http://127.0.0.1:{port}/api/state', 1):
            break
        time.sleep(0.5)
    log('tray starting')
    global _TRAY_ICON
    try:
        _TRAY_ICON = make_tray()
        _TRAY_ICON.run_detached()
    except Exception as e:
        log('tray detached failed: ' + str(e))
        try:
            _TRAY_ICON = make_tray()
            threading.Thread(target=_TRAY_ICON.run, daemon=True, name='af-tray').start()
        except Exception as e2:
            log('tray thread failed: ' + str(e2))
    _ui_loop()


if __name__ == '__main__':
    main()
