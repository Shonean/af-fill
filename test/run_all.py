# -*- coding: utf-8 -*-
"""一键跑全部离线回归（CI 与本地同款）。

前置：
    pip install playwright
    python -m playwright install chromium
    node --version   # 有 node 即可（VT 纯函数测试用）

用法：
    python test/run_all.py
脚本会在 8080 端口起一个临时 http.server（仓库根为静态目录），结束后自动关闭。
"""
import os
import subprocess
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PORT = 8080

sys.path.insert(0, HERE)
from _util import ensure_pdf  # noqa: E402

STEPS = [
    ('node --check autofill.user.js', ['node', '--check', 'autofill.user.js']),
    ('VT 纯函数 30 项', ['node', os.path.join('test', '_vt_tests.js')]),
    ('通用引擎 _smoke', [sys.executable, os.path.join('test', '_smoke.py')]),
    ('CNPC 基础 _smoke_cnpc', [sys.executable, os.path.join('test', '_smoke_cnpc.py')]),
    ('CNPC 全程深扫 _smoke_cnpc_deep', [sys.executable, os.path.join('test', '_smoke_cnpc_deep.py')]),
    ('LLM 映射 _smoke_llm_map', [sys.executable, os.path.join('test', '_smoke_llm_map.py')]),
    ('iframe 桥接 _smoke_iframe', [sys.executable, os.path.join('test', '_smoke_iframe.py')]),
    ('驱动等价 _smoke_driver', [sys.executable, os.path.join('test', '_smoke_driver.py')]),
]


def _server():
    import http.server
    import functools
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
    httpd.serve_forever()


def wait_port(timeout=10):
    for _ in range(timeout * 10):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{PORT}/test/mock-generic.html', timeout=1)
            return True
        except Exception:
            time.sleep(0.1)
    return False


def main():
    ensure_pdf()
    if not wait_port(timeout=1):
        t = threading.Thread(target=_server, daemon=True)
        t.start()
        if not wait_port():
            print('无法在 8080 启动本地测试服务器')
            sys.exit(1)
    print(f'本地测试服务器 http://127.0.0.1:{PORT} (root={ROOT})')

    bad = []
    for name, cmd in STEPS:
        print(f'\n===== {name} =====', flush=True)
        r = subprocess.run(cmd, cwd=ROOT)
        if r.returncode != 0:
            bad.append(name)
    print('\n================ 汇总 ================')
    print(f'{len(STEPS) - len(bad)}/{len(STEPS)} 通过' + (f' · 失败: {bad}' if bad else ' · 全绿'))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
