# -*- coding: utf-8 -*-
"""AF-Fill 打包脚本：一键产出 dist\\AF工作台\\（onedir，windowed，托盘）。

流程：
  1. 生成脱敏引擎变体（SEED_PROFILE 置空）—— TM 版原件不动
  2. 生成托盘图标 (Pillow)
  3. PyInstaller onedir（--collect-all playwright/pystray/uvicorn 隐藏子模块）
  4. 组装 AF工作台/：exe + _internal + 使用说明.txt
  5. 敏感串断言扫描：产物目录逐文件字节搜索「你的敏感词表」命中即 FAIL（exit 1）

敏感词表（可选但强烈建议）：tools/sanitize.local.json（已 gitignore，不会公开），
格式 {"words": ["你的真名", "手机号", "邮箱", "学校", "公司", ...]}。
未提供词表时跳过第 5 步（公开仓库/CI 只构建不含个人数据的默认产物）。

用法：python driver\\build.py
"""
import json
import os
import re
import shutil
import subprocess
import sys

DRIVER = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(DRIVER)
ART = os.path.join(DRIVER, 'build_artifacts')
DIST_OUT = os.path.join(ROOT, 'dist', 'AF工作台')
EXE_NAME = '求职工作台'
LOCAL_WORDS = os.path.join(ROOT, 'tools', 'sanitize.local.json')


def load_sensitive():
    if os.path.exists(LOCAL_WORDS):
        with open(LOCAL_WORDS, encoding='utf-8') as f:
            words = [w for w in json.load(f).get('words', []) if w]
        if words:
            print(f'[0/5] 敏感词表 {len(words)} 条 ← tools/sanitize.local.json')
            return words
    print('[0/5] 未提供 tools/sanitize.local.json —— 跳过敏感串扫描')
    return []


SENSITIVE = load_sensitive()

BLANK_SEED = '''const SEED_PROFILE = {
  schemaVersion: 1,
  updatedAt: '',
  base: {
    basic: {
      name: '', phone: '', email: '', gender: '', birthDate: '', idCard: '', politicalStatus: '',
      maritalStatus: '', nation: '', hometown: '', gaokaoSource: '', hukou: '', cityNow: '',
      address: '', cityExpected: '', cityExpected2: '', salaryExpected: '', availableFrom: '',
      jobNature: '', job: '', github: '', qq: '', wechat: '', englishLevel: '', englishScore: '',
      hobby: '', health: '', emergencyContact: { name: '', phone: '' }
    },
    education: [], projects: [], internships: [], skills: [], skillSummary: '', selfIntro: '',
    openQuestions: [], customFields: [], fieldFlags: {}
  },
  variants: {}
};'''

USAGE = '''AF-Fill 求职工作台 · 使用说明
================================

【首次使用】
1. 双击「求职工作台.exe」→ 应用主窗最大化打开（任务栏为 AF 图标，不是浏览器）
2. 主窗有两个页签：
   - 「工作台」：仪表盘（概览/网申队列/盯梢/AI 代笔/档案/设置）
   - 「浏览」  ：完整求职 Edge 嵌在应用里（标签栏/地址栏/收藏栏/密码填充都可用）
3. 窗口关闭 = 收进右下角托盘；托盘 AF 图标 →「打开工作台」恢复；彻底退出用托盘 →「退出」
4. 「浏览」页签首次进入会自动拉起求职 Edge（专用剖面，与日常浏览隔离）；
   批量打开的投递页也会直接显示在这个页签里，引擎填充实时可见
5. 想在里面用你自己的收藏/密码/已登录账号：设置页 →「从我的 Edge 导入收藏 / 密码 / 登录态」
   （需先完全退出日常 Edge；数据会先自动备份到 data\\backup\\）
6. 工作台 → Profile 卡 → 粘贴/编辑你的档案 JSON（至少填姓名、手机、邮箱）→ 保存
   或者：到任意网申页把表单手工填一遍 → 工作台「采集本页已填 → Profile」一键回读

【日常投递】
- 工作台「概览」页有「打开网页」：输入网址或点「QQ 邮箱」，会在内置 Edge 新标签打开并自动切到浏览页签
- 页面右下角有 AF 悬浮球（引擎已注入）：点它填表；左下角「+ 台账」收录当前职位页（Alt+Shift+C）
- 台账勾选 → 批量打开 → 自动切到「浏览」页签逐页核对填充（脚本只填勾选项）→ 提交永远自己点
- 盯梢源：添加招聘汇总站，自动抓新公告去重后进候选审核区

【LLM（可选）】
工作台右侧填 Base URL / API Key / 模型名（DeepSeek/Kimi/通义/本地 Ollama 均可）→ 测试连通。
启用后获得：扫描语义复核、职位自动打标签、开放题 AI 代笔。不配置也完全可用（零联网）。

【常见问题】
- 首次运行 Windows SmartScreen 提示：点「更多信息」→「仍要运行」
- 杀软报毒：PyInstaller 打包常见误报，将本文件夹加入白名单
- 界面报「服务未响应」或按钮全部失效：托盘退出 → 重新双击 exe；
  若反复发生 = 杀毒软件已隔离本程序。处理：Windows 安全中心 → 病毒和威胁防护 →
  保护历史记录 → 找到「求职工作台」→ 还原并允许；再在「病毒和威胁防护设置 → 排除项」
  添加本文件夹。日志：程序目录 data\\logs\\app.log
- 找不到工作台窗口：右下角托盘 AF 图标 → 打开工作台
- 「浏览」页签显示"求职 Edge 已关闭"：点页签里的「重新打开求职 Edge」即可
- 导入身份后个别受保护设置（默认搜索引擎等）可能重置，扩展需在求职 Edge 里重装
- 关闭：窗口 ×（收进托盘）；彻底退出：托盘 → 退出
- 数据都在本文件夹 data\\ 内，备份整个文件夹即可迁移

安全边界：绝不自动提交表单、绝不上传文件、默认零联网（配置 LLM 后仅向你自己填写的接口发送脱敏内容）。
'''


def step1_dist_engine():
    src = open(os.path.join(ROOT, 'autofill.user.js'), encoding='utf-8').read()
    m = re.search(r'const SEED_PROFILE = \{.*?\n\};', src, re.S)
    if not m:
        raise RuntimeError('SEED_PROFILE block not found')
    dist = src[:m.start()] + BLANK_SEED + src[m.end():]
    os.makedirs(ART, exist_ok=True)
    out = os.path.join(ART, 'engine.user.js')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(dist)
    for s in SENSITIVE:
        if s in dist:
            raise RuntimeError(f'敏感串仍在脱敏引擎中: {s}')
    r = subprocess.run(['node', '--check', out], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError('脱敏引擎语法错误:\n' + r.stderr[:800])
    print(f'[1/5] 脱敏引擎变体（SEED 置空）→ {out} ({len(dist)} chars)')
    return out


def step2_icon():
    from PIL import Image, ImageDraw
    img = Image.new('RGBA', (256, 256), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([10, 10, 246, 246], fill=(255, 255, 255), outline=(20, 20, 22), width=10)
    try:
        from PIL import ImageFont
        font = ImageFont.truetype('arialbd.ttf', 120)
        d.text((128, 128), 'AF', font=font, fill=(20, 20, 22), anchor='mm')
    except Exception:
        d.text((90, 100), 'AF', fill=(20, 20, 22))
    out = os.path.join(ART, 'app.ico')
    img.save(out, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f'[2/5] 图标 → {out}')
    return out


def step3_pyinstaller(icon):
    exe_dir = os.path.join(ROOT, 'build_dist')
    if os.path.exists(exe_dir):
        shutil.rmtree(exe_dir)
    cmd = [
        sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean',
        '--windowed', '--name', EXE_NAME, '--icon', icon,
        '--paths', DRIVER,
        '--add-data', os.path.join(ART, 'engine.user.js') + ';.',
        '--add-data', os.path.join(DRIVER, 'dashboard.html') + ';.',
        '--add-data', os.path.join(DRIVER, 'resources', 'seed_profile.json') + ';.',
        '--add-data', os.path.join(DRIVER, 'resources', 'seed_sources.json') + ';.',
        '--collect-all', 'playwright',
        '--collect-all', 'pystray',
        '--collect-all', 'webview',
        '--collect-all', 'pythonnet',
        '--collect-all', 'clr_loader',
        '--collect-submodules', 'uvicorn',
        '--distpath', exe_dir,
        '--workpath', os.path.join(ROOT, 'build_work'),
        '--specpath', os.path.join(ROOT, 'build_work'),
        os.path.join(DRIVER, 'af_app.py'),
    ]
    print('[3/5] PyInstaller ...（2-5 分钟）')
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                       encoding='utf-8', errors='ignore')
    if r.returncode != 0:
        print(r.stdout[-3000:])
        print(r.stderr[-3000:])
        raise RuntimeError('PyInstaller failed')
    print(f'[3/5] 构建完成 → {exe_dir}\\{EXE_NAME}\\')


def step4_assemble():
    src = os.path.join(ROOT, 'build_dist', EXE_NAME)
    data_bak = None
    if os.path.exists(DIST_OUT):
        # data\ 是用户运行数据（台账/盯梢候选/配置），重新打包必须保留回填
        data_dir = os.path.join(DIST_OUT, 'data')
        if os.path.isdir(data_dir):
            data_bak = os.path.join(ROOT, 'build_work', '_data_backup')
            if os.path.exists(data_bak):
                shutil.rmtree(data_bak)
            try:
                shutil.move(data_dir, data_bak)
            except (shutil.Error, OSError) as e:
                raise RuntimeError(
                    'data\\ 目录被占用，无法搬迁（WebView2/Cookies 被锁）。\n'
                    '请先完全退出「求职工作台」（托盘 → 退出）与外部启动的实例，再重新打包。\n'
                    f'原始错误：{e}')
        shutil.rmtree(DIST_OUT)
    os.makedirs(os.path.dirname(DIST_OUT), exist_ok=True)
    shutil.move(src, DIST_OUT)
    if data_bak and os.path.isdir(data_bak):
        shutil.copytree(data_bak, os.path.join(DIST_OUT, 'data'), dirs_exist_ok=True)
        shutil.rmtree(data_bak)
        print('    data\\ 用户数据已保留回填')
    with open(os.path.join(DIST_OUT, '使用说明.txt'), 'w', encoding='utf-8') as f:
        f.write(USAGE)
    total = sum(os.path.getsize(os.path.join(dp, f))
                for dp, _, fs in os.walk(DIST_OUT) for f in fs)
    print(f'[4/5] 组装 → {DIST_OUT}  ({total / 1048576:.0f} MB)')


def step5_sensitive_scan():
    if not SENSITIVE:
        print('[5/5] 敏感串扫描：跳过（无 tools/sanitize.local.json）')
        return
    bad = []
    pats = [s.encode('utf-8') for s in SENSITIVE]
    data_dir = os.path.join(DIST_OUT, 'data')   # 用户本机运行数据（真实档案/缓存）不属于分发内容，不参与扫描
    for dp, _, fs in os.walk(DIST_OUT):
        if dp == data_dir or dp.startswith(data_dir + os.sep):
            continue
        for f in fs:
            p = os.path.join(dp, f)
            try:
                blob = open(p, 'rb').read()
            except Exception:
                continue
            for s, b in zip(SENSITIVE, pats):
                if b in blob:
                    bad.append((p, s))
    if bad:
        for p, s in bad[:20]:
            print('  SENSITIVE HIT: %s @ %s' % (s, p))
        raise RuntimeError(f'敏感串扫描命中 {len(bad)} 处 — 构建失败')
    print('[5/5] 敏感串扫描：0 命中 · 通过')


if __name__ == '__main__':
    step1_dist_engine()
    icon = step2_icon()
    step3_pyinstaller(icon)
    step4_assemble()
    step5_sensitive_scan()
    print('\n打包完成 →', DIST_OUT)
