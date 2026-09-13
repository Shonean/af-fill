# -*- coding: utf-8 -*-
"""测试公共工具：虚构档案 fixture + 临时上传文件。

公开仓库不含真实档案（profile/profile.json 已 gitignore）；
所有 smoke/驱动等价测试统一使用 test/fixture/profile.fixture.json（虚构人物「李雷」）。
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURE = os.path.join(HERE, 'fixture', 'profile.fixture.json')


def load_fixture():
    with open(FIXTURE, encoding='utf-8') as f:
        return json.load(f)


def ensure_pdf():
    p = os.path.join(HERE, '_tmp_upload.pdf')
    if not os.path.exists(p):
        with open(p, 'wb') as f:
            f.write(b'%PDF-1.4\n')
    return p
