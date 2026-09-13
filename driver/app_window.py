# -*- coding: utf-8 -*-
"""AF-Fill 应用宿主：WinForms 主窗（「工作台」WebView2 页签 + 「浏览」求职 Edge 停靠页签）。

- 「工作台」：WebView2 控件加载本机 dashboard（127.0.0.1:8790）
- 「浏览」  ：求职 Edge 保持独立顶层窗口（去标题栏、owner 归属主窗、位置贴合面板）——
  完整 Edge UI（标签栏/地址栏/收藏栏/密码填充）且键盘/激活走系统正常流程。
  注意：绝不能对 Edge 用 SetParent 跨进程收编为子窗口——Chromium 收不到
  WM_ACTIVATE，整窗键盘输入会全部失效（点击有效、打字无效）。
- 批量打开等操作首次拉起求职 Edge 时自动切到「浏览」页签
- 关闭窗口 = 隐藏到托盘；托盘「打开工作台」/ 二次启动 → show_and_focus()
- 求职 Edge 被用户关闭 → 页签显示占位与「重新打开」按钮（引擎随后自动重连）
- 任何初始化失败 → 抛异常，由 af_app 退回 pywebview 单窗兜底
"""
import ctypes
import os
import sys
import threading
import time
import traceback
from ctypes import wintypes

import af_core

# ── Win32 常量 ──
_GWL_STYLE = -16
_GWL_HWNDPARENT = -8                          # 实为 owner（历史命名）
_WS_CHILD = 0x40000000
_WS_POPUP = 0x80000000
_WS_CAPTION = 0x00C00000
_WS_THICKFRAME = 0x00040000
_WS_SYSMENU = 0x00080000
_WS_MINIMIZE = 0x20000000
_WS_MAXIMIZE = 0x01000000
_SWP_FRAMECHANGED = 0x0020
_SWP_NOZORDER = 0x0004
_SWP_NOMOVE = 0x0002
_SWP_NOSIZE = 0x0001
_SWP_NOACTIVATE = 0x0010
_GA_PARENT = 1


class _WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [('length', wintypes.UINT), ('flags', wintypes.UINT),
                ('showCmd', wintypes.UINT), ('ptMinPosition', wintypes.POINT),
                ('ptMaxPosition', wintypes.POINT), ('rcNormalPosition', wintypes.RECT)]

_S = {'form': None, 'panelDash': None, 'panelDock': None, 'panelEmpty': None,
      'lblEmpty': None, 'btnReopen': None, 'wv': None,
      'edgeHwnd': 0, 'edgeStyle': 0, 'browsing': False,
      'starting': False, 'startFailed': False, 'failCnt': 0, 'lastTry': 0.0,
      'everDocked': False, 'autoShown': False, 'get_cfg': None, 'log': None,
      'quitting': False, 'timer': None, 'wakedHwnd': 0,
      'wantShow': False, 'wantBrowse': False,
      'lastDockTry': 0.0, 'dockTries': 0, 'dockTriesHwnd': 0, 'ownerStuck': 0}


def _log(msg: str):
    try:
        _S['log'](msg)
    except Exception:
        pass


# ──────────────────── Win32：停靠/恢复 ────────────────────

def _get_style(hwnd: int) -> int:
    u32 = ctypes.windll.user32
    try:
        if hasattr(u32, 'GetWindowLongPtrW'):
            return int(u32.GetWindowLongPtrW(wintypes.HWND(hwnd), _GWL_STYLE)) & 0xFFFFFFFF
    except Exception:
        pass
    return int(u32.GetWindowLongW(wintypes.HWND(hwnd), _GWL_STYLE)) & 0xFFFFFFFF


def _set_style(hwnd: int, style: int):
    u32 = ctypes.windll.user32
    v = ctypes.c_ssize_t(style)
    try:
        if hasattr(u32, 'SetWindowLongPtrW'):
            u32.SetWindowLongPtrW(wintypes.HWND(hwnd), _GWL_STYLE, v)
            return
    except Exception:
        pass
    u32.SetWindowLongW(wintypes.HWND(hwnd), _GWL_STYLE, style)


def _get_owner(hwnd: int) -> int:
    u32 = ctypes.windll.user32
    try:
        if hasattr(u32, 'GetWindowLongPtrW'):
            return int(u32.GetWindowLongPtrW(wintypes.HWND(hwnd), _GWL_HWNDPARENT))
    except Exception:
        pass
    return int(u32.GetWindowLongW(wintypes.HWND(hwnd), _GWL_HWNDPARENT))


def _set_owner(hwnd: int, owner: int):
    u32 = ctypes.windll.user32
    v = ctypes.c_ssize_t(owner)
    try:
        if hasattr(u32, 'SetWindowLongPtrW'):
            u32.SetWindowLongPtrW(wintypes.HWND(hwnd), _GWL_HWNDPARENT, v)
            return
    except Exception:
        pass
    u32.SetWindowLongW(wintypes.HWND(hwnd), _GWL_HWNDPARENT, owner)


def _fit_edge(panel):
    """把求职 Edge（顶层无边框窗）对齐到 panel 的屏幕矩形；无位移则不动。"""
    hwnd = _S.get('edgeHwnd')
    if not hwnd or not _S.get('docked'):
        return
    try:
        from System.Drawing import Point
        u32 = ctypes.windll.user32
        org = panel.PointToScreen(Point(0, 0))
        w, h = panel.ClientSize.Width, panel.ClientSize.Height
        if w <= 50 or h <= 50:
            return
        # Chromium 会反复恢复「最大化」摆放盖住整个主窗（含页签条），
        # 先退掉最大化状态再对位
        wp = _WINDOWPLACEMENT()
        wp.length = ctypes.sizeof(_WINDOWPLACEMENT)
        if u32.GetWindowPlacement(wintypes.HWND(hwnd), ctypes.byref(wp)) and wp.showCmd == 3:
            u32.ShowWindow(wintypes.HWND(hwnd), 9)         # SW_RESTORE
        r = wintypes.RECT()
        if u32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(r)):
            if (r.left != int(org.X) or r.top != int(org.Y) or
                    r.right - r.left != int(w) or r.bottom - r.top != int(h)):
                u32.MoveWindow(wintypes.HWND(hwnd), int(org.X), int(org.Y), int(w), int(h), True)
        else:
            _log('fit: GetWindowRect failed')
    except Exception:
        _log('fit error: ' + traceback.format_exc()[-200:])


def _show_edge():
    hwnd = _S.get('edgeHwnd')
    if hwnd and _S.get('docked'):
        try:
            if not ctypes.windll.user32.IsWindowVisible(wintypes.HWND(hwnd)):
                ctypes.windll.user32.ShowWindow(wintypes.HWND(hwnd), 8)   # SW_SHOWNA
        except Exception:
            pass


def _hide_edge():
    hwnd = _S.get('edgeHwnd')
    if hwnd:
        try:
            if ctypes.windll.user32.IsWindowVisible(wintypes.HWND(hwnd)):
                ctypes.windll.user32.ShowWindow(wintypes.HWND(hwnd), 0)   # SW_HIDE
        except Exception:
            pass


def _activate_edge():
    """切到浏览页签后把前台交给 Edge（此刻前台归工作台进程，系统允许移交）。"""
    hwnd = _S.get('edgeHwnd')
    if hwnd:
        try:
            ctypes.windll.user32.SetForegroundWindow(wintypes.HWND(hwnd))
        except Exception:
            pass


def _dock_edge(hwnd: int, panel):
    """求职 Edge 保持顶层窗口（键盘/激活走正常流程），仅去标题栏、设主窗为 owner、
    位置贴合 panel。绝不可 SetParent：跨进程子窗口收不到 WM_ACTIVATE，键盘全废。"""
    u32 = ctypes.windll.user32
    _S['edgeStyle'] = _get_style(hwnd)
    style = _S['edgeStyle']
    new_style = (style & ~(_WS_CAPTION | _WS_THICKFRAME | _WS_SYSMENU |
                           _WS_MINIMIZE | _WS_MAXIMIZE | _WS_CHILD)) | _WS_POPUP
    _set_style(hwnd, new_style)
    try:
        _set_owner(hwnd, _S['form'].Handle.ToInt64())
    except Exception:
        pass
    _S['edgeHwnd'] = hwnd
    _S['docked'] = True
    _S['everDocked'] = True
    _S['failCnt'] = 0
    _S['lastDockTry'] = time.time()
    u32.SetWindowPos(wintypes.HWND(hwnd), 0, 0, 0, 0, 0,
                     _SWP_FRAMECHANGED | _SWP_NOZORDER | _SWP_NOMOVE | _SWP_NOSIZE |
                     _SWP_NOACTIVATE)
    _fit_edge(panel)
    u32.ShowWindow(wintypes.HWND(hwnd), 8)             # SW_SHOWNA


def _undock():
    hwnd = _S.get('edgeHwnd')
    if not hwnd:
        return
    u32 = ctypes.windll.user32
    try:
        if _S.get('docked') and u32.IsWindow(wintypes.HWND(hwnd)):
            st = _S.get('edgeStyle')
            if st:
                _set_style(hwnd, st)
                u32.SetWindowPos(wintypes.HWND(hwnd), 0, 0, 0, 0, 0,
                                 _SWP_FRAMECHANGED | _SWP_NOZORDER | _SWP_NOMOVE |
                                 _SWP_NOSIZE | _SWP_NOACTIVATE)
            _set_owner(hwnd, 0)
            u32.ShowWindow(wintypes.HWND(hwnd), 3)     # SW_MAXIMIZE
    except Exception:
        pass
    finally:
        _S['edgeHwnd'] = 0
        _S['docked'] = False


# ──────────────────── 求职 Edge 生命周期 ────────────────────

def _show_empty(text: str, with_btn: bool = False):
    try:
        _S['lblEmpty'].Text = text
        _S['btnReopen'].Visible = with_btn
        _S['panelEmpty'].Visible = True
    except Exception:
        pass


def _hide_empty():
    try:
        _S['panelEmpty'].Visible = False
    except Exception:
        pass


def _ensure_edge_async(manual: bool = False):
    """后台拉起求职 Edge（ensure_edge 最长阻塞 30s，绝不能卡 UI 线程）。"""
    if _S.get('starting') or _S.get('edgeHwnd'):
        return
    if _S.get('startFailed') and not manual:
        return
    if not manual and time.time() - _S.get('lastTry', 0) < 8:
        return
    _S['starting'] = True
    _S['lastTry'] = time.time()
    _show_empty('正在启动求职 Edge …（首次 3~10 秒）')

    def work():
        try:
            af_core.ensure_edge(_S['get_cfg']())
            _S['failCnt'] = 0
            hwnd = af_core.find_job_edge_hwnd(_S['get_cfg']())
            if hwnd:
                _wake_once(hwnd)                    # 连接 Driver + 注入引擎（悬浮球）
        except Exception as e:
            _S['failCnt'] = _S.get('failCnt', 0) + 1
            _log('ensure_edge failed: ' + str(e))
            if _S['failCnt'] >= 2:
                _S['startFailed'] = True
        finally:
            _S['starting'] = False                  # 失败占位由 UI 线程的 _watch_dock 处理
    threading.Thread(target=work, daemon=True, name='af-edge-start').start()


def _wake_driver():
    """请 Driver 连接并注入引擎（悬浮球 / 收录 chip）。后台线程执行，不阻塞 UI。"""
    def work():
        try:
            import urllib.request
            port = (_S['get_cfg']() or {}).get('workbenchPort', 8790)
            req = urllib.request.Request(f'http://127.0.0.1:{port}/api/reinject', data=b'{}',
                                         headers={'Content-Type': 'application/json'}, method='POST')
            urllib.request.urlopen(req, timeout=300)
            _log('driver wake: engine injected')
        except Exception as e:
            _log('driver wake failed: ' + str(e))
    threading.Thread(target=work, daemon=True, name='af-driver-wake').start()


def _wake_once(hwnd):
    """每个 Edge 窗口只唤醒注入一次（窗口重开后再注入）。"""
    if not hwnd or hwnd == _S.get('wakedHwnd'):
        return
    _S['wakedHwnd'] = hwnd
    _wake_driver()


def _switch(to_browse: bool):
    from System.Windows.Forms import FormWindowState
    _log('switch browse=%s' % to_browse)
    _S['browsing'] = to_browse
    _S['panelDock'].Visible = to_browse
    _S['panelDash'].Visible = not to_browse
    try:
        if to_browse:
            _S['form'].WindowState = FormWindowState.Maximized
    except Exception:
        pass
    paint = _S.get('_paint_tabs')
    if paint:
        try:
            paint(not to_browse)
        except Exception:
            pass
    if to_browse:
        if _S.get('edgeHwnd') and _S.get('docked'):
            _fit_edge(_S['panelDock'])
            _show_edge()
            _hide_empty()
            _activate_edge()
        else:
            _ensure_edge_async()
    else:
        _hide_edge()


def _do_show_focus():
    """UI 线程执行：显示并聚焦主窗。"""
    form = _S.get('form')
    if form is None:
        return
    from System.Windows.Forms import FormWindowState
    try:
        form.WindowState = FormWindowState.Maximized
    except Exception:
        pass
    try:
        form.Show()
    except Exception:
        pass
    try:
        form.Activate()
    except Exception:
        pass


def _watch_dock():
    """定时对账（UI 线程，所有页签下都跑）：消费跨线程请求；Edge 出现 → 停靠+注入；
    被关 → 占位；漂移 → 重停靠。"""
    if _S.get('quitting'):
        return
    panel = _S.get('panelDock')
    if panel is None:
        return
    # ── 跨线程请求（托盘显示 / 队列打开切浏览）在 UI 线程消费 ──
    try:
        if _S.get('wantShow'):
            _S['wantShow'] = False
            _log('ui req: show')
            _do_show_focus()
        if _S.get('wantBrowse'):
            _S['wantBrowse'] = False
            _log('ui req: browse')
            _switch(True)
    except Exception:
        _log(traceback.format_exc()[-300:])
    browsing = _S.get('browsing')
    try:
        u32 = ctypes.windll.user32
        hwnd = _S.get('edgeHwnd')
        owner = 0
        try:
            owner = int(_S['form'].Handle.ToInt64())
        except Exception:
            pass

        def _keep_visible():
            """只维持可见性/贴合，不重复改样式（限频冷却期与熔断后使用）。"""
            if browsing:
                _hide_empty()
                _fit_edge(panel)
                _show_edge()
            else:
                _hide_edge()

        if hwnd:
            if _S.get('ownerStuck') == hwnd:
                _keep_visible()                        # owner 收编失败 → 永不反复折腾
                return
            if u32.IsWindow(wintypes.HWND(hwnd)) and _get_owner(hwnd) == owner:
                _keep_visible()
                return
            if time.time() - _S.get('lastDockTry', 0.0) < 3:
                _keep_visible()                        # 冷却中：不重复整套改样式（防闪屏/刷屏）
                return
            if _S.get('dockTriesHwnd') != hwnd:        # 换窗口 → 重新计数
                _S['dockTriesHwnd'] = hwnd
                _S['dockTries'] = 0
            _S['dockTries'] = _S.get('dockTries', 0) + 1
            if _S['dockTries'] > 5:
                _S['ownerStuck'] = hwnd
                _log('owner never sticks (hwnd=%s) → keep window as-is, stop re-docking' % hwnd)
                _keep_visible()
                return
            _log('redock: hwnd=%s got_owner=%s expect=%s (try %d)'
                 % (hwnd, _get_owner(hwnd), owner, _S['dockTries']))
            _S['edgeHwnd'] = 0                         # 窗口没了/漂出 → 重新找
            _S['docked'] = False
        fresh = af_core.find_job_edge_hwnd(_S['get_cfg']())
        if fresh:
            _dock_edge(fresh, panel)
            _log('docked hwnd=%s' % fresh)
            _wake_once(fresh)                          # 新窗口 → 注入引擎
            if browsing:
                _hide_empty()
                _fit_edge(panel)
                _show_edge()
                _activate_edge()
            else:
                _hide_edge()
            return
        _S['wakedHwnd'] = 0                            # Edge 已不在 → 下次重开再注入
        if browsing:
            if _S.get('starting'):
                return
            if _S.get('startFailed'):
                _show_empty('求职 Edge 启动失败（未安装 / 被安全软件拦截）', with_btn=True)
            elif _S.get('everDocked'):
                _show_empty('求职 Edge 已关闭', with_btn=True)
            else:
                _ensure_edge_async()
    except Exception:
        pass


# ──────────────────── WinForms 宿主 ────────────────────

def _load_dotnet():
    import clr
    clr.AddReference('System.Windows.Forms')
    clr.AddReference('System.Drawing')
    import webview as _wv_pkg
    lib = os.path.join(os.path.dirname(_wv_pkg.__file__), 'lib')
    clr.AddReference(os.path.join(lib, 'Microsoft.Web.WebView2.Core.dll'))
    clr.AddReference(os.path.join(lib, 'Microsoft.Web.WebView2.WinForms.dll'))


def _make_icon():
    from System.Drawing import Icon
    try:
        if getattr(sys, 'frozen', False):
            return Icon.ExtractAssociatedIcon(sys.executable)
        ico = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build_artifacts', 'app.ico')
        if os.path.isfile(ico):
            return Icon(ico)
    except Exception:
        pass
    return None


def _wv_ready(sender, args):
    try:
        sender.CoreWebView2.NewWindowRequested += _on_newwindow
    except Exception:
        pass


def _on_newwindow(sender, e):
    """dashboard 里 target=_blank 的链接 → 交给系统默认浏览器（日常 Edge）。"""
    try:
        e.Handled = True
        uri = str(e.Uri)
        if uri.startswith(('http://', 'https://')):
            os.startfile(uri)
    except Exception:
        pass


def run(url: str, get_cfg, log_fn):
    """构建并运行主窗（阻塞）。初始化失败抛异常 → af_app 退回 pywebview 兜底。"""
    _S['get_cfg'] = get_cfg
    _S['log'] = log_fn or (lambda m: None)
    _load_dotnet()
    try:
        ctypes.windll.ole32.CoInitializeEx(None, 2)    # STA（WinForms 必须）
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

    from System import Uri
    from System.Drawing import Color, ContentAlignment, Font, Point, Size
    from System.Windows.Forms import (Application, Button, Cursors, DockStyle, FlatStyle,
                                      Form, FormWindowState, Label, Panel, Timer)
    from Microsoft.Web.WebView2.WinForms import WebView2
    from Microsoft.Web.WebView2.Core import CoreWebView2Environment

    Application.EnableVisualStyles()
    form = Form()
    form.Text = '求职工作台'
    icon = _make_icon()
    if icon is not None:
        form.Icon = icon
    form.Font = Font('Microsoft YaHei UI', 9)
    form.WindowState = FormWindowState.Maximized
    form.BackColor = Color.FromArgb(0xED, 0xEE, 0xF1)
    _S['form'] = form

    # ── 顶部页签条 ──
    strip = Panel()
    strip.Dock = DockStyle.Top
    strip.Height = 42
    strip.BackColor = Color.White

    def tab_btn(text, w):
        b = Button()
        b.Text = text
        b.FlatStyle = FlatStyle.Flat
        b.FlatAppearance.BorderSize = 0
        b.Size = Size(w, 30)
        b.Location = Point(0, 0)
        b.Cursor = Cursors.Hand
        return b

    btn_work = tab_btn('工作台', 120)
    btn_browse = tab_btn('浏览 · 求职Edge', 150)
    btn_work.Location = Point(14, 6)
    btn_browse.Location = Point(140, 6)
    strip.Controls.Add(btn_work)
    strip.Controls.Add(btn_browse)

    def _paint_tabs(work_on):
        for b, on in ((btn_work, work_on), (btn_browse, not work_on)):
            b.BackColor = Color.FromArgb(0x14, 0x14, 0x16) if on else Color.FromArgb(0xE2, 0xE3, 0xE8)
            b.ForeColor = Color.White if on else Color.FromArgb(0x74, 0x75, 0x7C)
    _S['_paint_tabs'] = _paint_tabs

    # ── 内容区：填充面板先加，页签条最后加（WinForms 停靠按加入逆序布局） ──
    panelDash = Panel()
    panelDash.Dock = DockStyle.Fill
    panelDock = Panel()                                # Edge 停靠容器
    panelDock.Dock = DockStyle.Fill
    panelDock.BackColor = Color.FromArgb(0xF3, 0xF3, 0xF3)
    panelEmpty = Panel()                               # 占位（启动中/已关闭/失败）
    panelEmpty.Dock = DockStyle.Fill
    lblEmpty = Label()
    lblEmpty.Dock = DockStyle.Fill
    lblEmpty.TextAlign = ContentAlignment.MiddleCenter
    lblEmpty.ForeColor = Color.FromArgb(0x74, 0x75, 0x7C)
    lblEmpty.Text = '正在启动求职 Edge …'
    btnReopen = Button()
    btnReopen.Text = '重新打开求职 Edge'
    btnReopen.FlatStyle = FlatStyle.Flat
    btnReopen.FlatAppearance.BorderSize = 1
    btnReopen.Dock = DockStyle.Bottom
    btnReopen.Height = 36
    btnReopen.Visible = False
    panelEmpty.Controls.Add(lblEmpty)
    panelEmpty.Controls.Add(btnReopen)
    panelDock.Controls.Add(panelEmpty)

    form.Controls.Add(panelDash)
    form.Controls.Add(panelDock)
    form.Controls.Add(strip)
    panelDock.Visible = False
    _S.update(panelDash=panelDash, panelDock=panelDock, panelEmpty=panelEmpty,
              lblEmpty=lblEmpty, btnReopen=btnReopen)

    # ── 工作台 WebView2 ──
    try:
        wv = WebView2()
        wv.Dock = DockStyle.Fill
        panelDash.Controls.Add(wv)
        udf = None
        try:
            import paths
            udf = paths.data('webview2')
            os.makedirs(udf, exist_ok=True)
        except Exception:
            pass
        if udf:
            env_task = CoreWebView2Environment.CreateAsync(None, udf, None)
            try:
                wv.EnsureCoreWebView2Async(env_task)
            except Exception:
                wv.EnsureCoreWebView2Async(env_task.Result)
        else:
            wv.EnsureCoreWebView2Async()
        wv.Source = Uri(url)
        wv.CoreWebView2InitializationCompleted += _wv_ready
        _S['wv'] = wv
    except Exception:
        _log('webview init failed（工作台页签不可用，浏览页签仍可用）:\n' +
             traceback.format_exc()[-400:])

    # ── 行为 ──
    def on_work_click(sender, args):
        _safe(lambda: _switch(False))

    def on_browse_click(sender, args):
        _safe(lambda: _switch(True))

    def on_reopen_click(sender, args):
        def go():
            _S['startFailed'] = False
            _S['everDocked'] = False
            btnReopen.Visible = False
            _ensure_edge_async(manual=True)
        _safe(go)

    def on_resize(sender, args):
        _fit_edge(panelDock)

    def on_form_closing(sender, args):
        if _S.get('quitting'):
            return
        args.Cancel = True                             # 关闭 = 收进托盘
        _hide_edge()
        form.Hide()

    btn_work.Click += on_work_click
    btn_browse.Click += on_browse_click
    btnReopen.Click += on_reopen_click
    panelDock.Resize += on_resize
    form.FormClosing += on_form_closing
    _paint_tabs(True)

    timer = Timer()
    timer.Interval = 1200
    timer.Tick += lambda s, a: _safe(_watch_dock)
    timer.Start()
    _S['timer'] = timer

    Application.Run(form)


def _safe(fn):
    try:
        fn()
    except Exception:
        _log(traceback.format_exc()[-300:])


def show_and_focus():
    """托盘「打开工作台」/ 二次启动：置标志，由 UI 线程定时器执行（线程安全）。"""
    if _S.get('form') is None:
        raise RuntimeError('winforms host not running')
    _S['wantShow'] = True


def request_browse():
    """队列打开等：请求切到「浏览」页签（线程安全，UI 线程消费）。"""
    _S['wantBrowse'] = True


def pre_exit():
    """托盘「退出」前调用：解除停靠并还原 Edge 窗口。"""
    _S['quitting'] = True
    try:
        if _S.get('timer') is not None:
            _S['timer'].Stop()
    except Exception:
        pass
    _undock()
