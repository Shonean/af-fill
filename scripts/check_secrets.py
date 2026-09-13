# -*- coding: utf-8 -*-
"""公开仓库隐私/密钥扫描。

两层：
  1. 词表扫描：tools/sanitize.local.json 的 words（本地专用，已 gitignore；CI 上没有则跳过）
  2. 通用正则：手机号 / QQ 邮箱 / 本机用户目录绝对路径

用法：python scripts/check_secrets.py   （本地发布前 + CI 都跑）
命中即 exit 1。
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORDLIST = os.path.join(ROOT, 'tools', 'sanitize.local.json')
SKIP_DIRS = {'.git', 'dist', 'build_work', 'build_dist', 'build_artifacts',
             'webview2', 'logs', 'backup', 'watch', '__pycache__', 'node_modules'}
SKIP_FILES = {'sanitize.local.json', 'config.json', 'profile.json', '_tmp_upload.pdf'}
TEXT_EXT = {'.js', '.py', '.html', '.css', '.md', '.json', '.yml', '.yaml', '.txt',
            '.bat', '.ps1', '.vbs', '.toml', '.ini', '.cfg'}
ALLOW_PII = {'13800138000', '13900139000', 'lilei@example.com'}
GENERIC = [
    ('手机号', re.compile(r'(?<!\d)1[3-9]\d{9}(?!\d)')),
    ('QQ邮箱', re.compile(r'\d{5,12}@qq\.com')),
    ('本机用户目录', re.compile(r'[A-Za-z]:\\Users\\(?!<)[^\\\s"\']+')),
]


def iter_files():
    for dp, dns, fns in os.walk(ROOT):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in fns:
            if fn in SKIP_FILES:
                continue
            if os.path.splitext(fn)[1].lower() not in TEXT_EXT:
                continue
            yield os.path.join(dp, fn)


def main():
    words = []
    if os.path.exists(WORDLIST):
        with open(WORDLIST, encoding='utf-8') as f:
            words = [w for w in json.load(f).get('words', []) if w]
    hits = []
    for path in iter_files():
        rel = os.path.relpath(path, ROOT)
        try:
            with open(path, encoding='utf-8', errors='ignore') as f:
                for ln, line in enumerate(f, 1):
                    for w in words:
                        if w in line:
                            hits.append((rel, ln, '词表:' + w))
                    for label, rx in GENERIC:
                        for m in rx.finditer(line):
                            if m.group(0) in ALLOW_PII:
                                continue
                            hits.append((rel, ln, f'{label}:{m.group(0)}'))
        except Exception as e:
            print(f'  ! 读取失败 {rel}: {e}', file=sys.stderr)
    if hits:
        print(f'发现 {len(hits)} 处敏感内容：')
        for rel, ln, what in hits[:50]:
            print(f'  {rel}:{ln}  {what}')
        sys.exit(1)
    scope = '词表 %d 条 + 通用正则' % len(words) if words else '通用正则（无本地词表）'
    print(f'check_secrets: 0 命中（{scope}）· 通过')


if __name__ == '__main__':
    main()
