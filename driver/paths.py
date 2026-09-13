# -*- coding: utf-8 -*-
"""AF-Fill unified path resolution: works identically in dev mode and PyInstaller mode.

- Resources (read-only, bundled): engine source, dashboard.html, seed_profile.json
- Data (writable, per-installation): config/ledger/state/profile/watch/logs

Dev  : RESOURCE_DIR = driver/          DATA_DIR = driver/
       engine at ../autofill.user.js (repo single source)
Frozen: RESOURCE_DIR = sys._MEIPASS    DATA_DIR = <exe dir>\\data
       engine at _MEIPASS/engine.user.js (seed-blanked dist variant)
"""
import os
import sys


def is_frozen() -> bool:
    return bool(getattr(sys, 'frozen', False))


if is_frozen():
    RESOURCE_DIR = getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
    APP_DIR = os.path.dirname(sys.executable)
    DATA_DIR = os.path.join(APP_DIR, 'data')
else:
    RESOURCE_DIR = os.path.dirname(os.path.abspath(__file__))
    APP_DIR = os.path.dirname(RESOURCE_DIR)
    DATA_DIR = RESOURCE_DIR


def ensure_data_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(data('watch'), exist_ok=True)
    os.makedirs(logs_dir(), exist_ok=True)


def resource(*parts) -> str:
    return os.path.join(RESOURCE_DIR, *parts)


def data(*parts) -> str:
    return os.path.join(DATA_DIR, *parts)


def logs_dir() -> str:
    return data('logs')


def engine_path() -> str:
    p = resource('engine.user.js')
    if os.path.isfile(p):
        return p
    return os.path.normpath(os.path.join(RESOURCE_DIR, '..', 'autofill.user.js'))


def dashboard_path() -> str:
    return resource('dashboard.html')


def seed_profile_path() -> str:
    return resource('seed_profile.json')


def seed_sources_path() -> str:
    """分发用默认盯梢源模板（首次运行种进 data/watch/sources.json）。"""
    return resource('seed_sources.json')


def config_path() -> str:
    return data('config.json')


def state_path() -> str:
    return data('state.json')


def ledger_path() -> str:
    return data('ledger.json')


def profile_path() -> str:
    r"""Dev: repo profile\profile.json (user's real file). Frozen: data\profile.json (seeded)."""
    if is_frozen():
        return data('profile.json')
    return os.path.normpath(os.path.join(RESOURCE_DIR, '..', 'profile', 'profile.json'))
