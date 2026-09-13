# AF-Fill · 网申快填

[![CI](https://github.com/Shonean/af-fill/actions/workflows/ci.yml/badge.svg)](https://github.com/Shonean/af-fill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-informational)](CHANGELOG.md)

秋招网申表单识别与辅助填充。**扫描 → 人工核对清单 → 仅填充勾选项**，最终提交永远由你自己点。

- **Tampermonkey 用户脚本**：[`autofill.user.js`](autofill.user.js) 单文件零依赖，装完即用
- **求职工作台**：本地驱动（专用 Edge 剖面）+ 仪表盘（台账/批量队列/盯梢/AI 代笔），下载 Release 双击即用

> 在线演示（静态模拟，无真实数据）：https://shonean.github.io/af-fill/demo/

## 安全硬约束（代码层落实，非口号）

- 永不调用 `form.submit()`、永不点击最终提交 / 完整性校验按钮
- 永不触碰 `type=file`（只提示人工上传）
- 协议 / 承诺类**单个独立勾选框永不自动勾选**
- 默认零网络请求；不内置任何统计遥测。LLM 必须由你显式配置，且**默认脱敏**送审
- 分区式网站只点适配器白名单内的「保存教育背景」这类分区保存

## 特性

- **扫描只读、填充可控**：每次扫描生成清单（绿=高置信 / 琥珀=待确认 / 红=敏感默认跳过 / 灰=需人工可定位），你勾哪些填哪些
- **分区式简历全程扫描**（v1.0.0，中石油实测）：z1~z9 逐区打开、按档案自动补卡、逐区填充并保存；第二轮走「修改」路径不重复添加
- **AI 扫描映射**（可关）：歧义下拉同义消歧（「全日制统招」↔「普通全日制」）+ 未命中字段映射档案键（「技术博客」→ `basic.github`），`pick/key` 均做防幻觉校验
- **抗造控件链**：React/Vue 受控组件（原型 setter）、自绘下拉/级联（绝不盲点）、jQuery autocompleter（专业/院校点选写隐藏 id）、readonly 日期、contenteditable、iframe 桥接（北森模式）
- **规则语义闸**：值↔标签双向校验，拦截「姓名框填出 CET-4」类错配
- **档案即数据**：Profile JSON 定义一次，全站复用；支持岗位变体、自定义字段、开放题模板与占位符；「采集本页已填」一键回读
- **自动学习 / 本站问答记忆**：手工填过的不再问第二遍；声明类问题按站点记忆，不进档案
- **填充审计**：时间/站点/字段/置信度（敏感值打码），仅存本机，可导出
- **工作台**：台账状态机（收录→已打开→已填→已投→面试/挂）、批量打开、盯梢源公告雷达、LLM 打标签/开放题代笔

## 快速开始

### A. 用户脚本（推荐先试）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本 → 粘贴 [`autofill.user.js`](autofill.user.js) 全文 → 保存
3. 打开网申页 → 点右下角「AF」→ 核对清单 → 执行填充 → **自己提交**

详见 [docs/guide.md](docs/guide.md)。

### B. 求职工作台

- Release 下载 `AF-Fill-Workbench-*.zip` 解压双击「求职工作台.exe」（未签名，SmartScreen 选「仍要运行」；校验和见 Release 附件）
- 或源码运行：

```bash
pip install -r driver/requirements.txt
python -m playwright install chromium
python driver/workbench.py
```

### C. 本地跑测试 / 演示页

```bash
python test/run_all.py                 # 全部离线回归（需要 node + playwright）
python -m http.server 8080             # 浏览器打开 http://localhost:8080/docs/demo/
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/guide.md](docs/guide.md) | 安装、使用流程、Profile 格式、工作台、LLM 配置 |
| [docs/platforms.md](docs/platforms.md) | 平台测绘与适配状态（中石油已深适配） |
| [docs/architecture.md](docs/architecture.md) | 引擎 12 段流水线、DEEP 分区、LLM 通道、驱动架构 |
| [docs/privacy.md](docs/privacy.md) | 数据流向与 LLM 脱敏细节 |
| [docs/faq.md](docs/faq.md) | 常见问题 |
| [docs/roadmap.md](docs/roadmap.md) | 开源计划与后续路线 |
| [CHANGELOG.md](CHANGELOG.md) | 版本记录 |

## 平台支持

| 平台 | 状态 |
|---|---|
| 中石油校招（zhaopin.cnpc.com.cn） | ✅ 分区全程扫描/逐区保存（v1.0.0 实测） |
| 通用 ATS（原生控件 + React/Vue + 自绘组件） | ✅ 引擎全量覆盖 |
| 北森系（*beisen.com / *ituiz.com，iframe 表单） | ✅ 桥接路径；具体站点欢迎补测绘 |
| Moka / 大易 / 智联 / 前程无忧 | 🔶 适配条目已建，待真实页面测绘（见 platforms.md） |
| 中国电信（自研 ATS） | 🔶 注入成功，可编辑路由待定位 |
| 国家能源 | 🔶 早期实测站点，级联已修 |

## 开发与测试

```bash
node --check autofill.user.js          # 引擎语法
node test/_vt_tests.js                 # 纯函数 30 断言
python test/run_all.py                 # 全量离线回归（mock 页 + Playwright）
python scripts/check_secrets.py        # 隐私/密钥扫描（提 PR 前必跑）
python driver/build.py                 # 打包 exe（需 pyinstaller）
```

新增平台适配请看 [CONTRIBUTING.md](CONTRIBUTING.md)（`ADAPTERS` + mock 页 + smoke 断言是硬性要求）。

## 仓库结构

```
autofill.user.js        # 引擎（唯一真源，单文件）
profile/                # profile.example.json 示例档案（你的真实档案 profile.json 已 gitignore）
driver/                 # 工作台：FastAPI + Playwright + PyInstaller 打包
test/                   # mock 页 + 离线回归 + 虚构 fixture
docs/                   # 文档 + 静态演示（GitHub Pages）
scripts/check_secrets.py# 隐私扫描
tools/                  # 快捷方式脚本；sanitize.local.json（本地词表，已 gitignore）
```

## 隐私与免责

- 你的档案只存本机；唯一联网路径是你自己配置的 LLM，且默认脱敏（见 [docs/privacy.md](docs/privacy.md)）
- 本工具仅辅助填写你本人在浏览器中打开的表单，与手工填写等价；不绕过验证码/登录风控，不自动提交
- 使用即表示遵守目标网站条款，风险自负；请勿用于批量滥用
- 漏洞请走私密通道：[SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE) © 2026 Shonean
