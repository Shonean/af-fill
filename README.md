# AF-Fill · 网申快填

[![CI](https://github.com/Shonean/af-fill/actions/workflows/ci.yml/badge.svg)](https://github.com/Shonean/af-fill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-informational)](CHANGELOG.md)

秋招网申填表太累了。**档案只填一次，之后每个网站：扫描 → 核对 → 一键填充**。
只填你勾选的，提交永远由你自己点。

> 在线演示（纯前端模拟，无真实数据）：https://shonean.github.io/af-fill/demo/

## 30 秒上手

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/)
2. [点这里安装脚本](autofill.user.js)（或新建脚本粘贴全文）
3. 打开网申页 → 点右下角「AF」→ 核对清单 → **执行填充 · 仅勾选项** → 自己提交

想批量投递（台账 / 盯梢公告 / AI 代笔）？下载 [Release](https://github.com/Shonean/af-fill/releases) 里的「求职工作台」解压双击，或源码 `python driver/workbench.py`。

## 它能帮你干什么

- **一句话填完整张表**：姓名 / 姓　名 / First Name 各种写法都认得；下拉、单选、多选、日期、文本框一次填齐
- **重复经历不乱套**：教育①②、实习①②按档案第 k 段对应，永远不复制前一段
- **难缠控件也能填**：React/Vue 受控组件、自绘下拉、省市区三级级联、联想搜索框（专业/院校）、iframe 嵌套表单（北森模式）
- **分区式简历全程处理**（中石油实测）：自动翻遍 9 个分区、缺的卡片按档案自动补建、逐区填完并保存；再跑一遍走「修改」路径，不会重复添加
- **AI 帮你消歧**（可选 · 默认脱敏）：同一个意思的不同选项（「全日制统招」↔「普通全日制」）自动对上；没认出的字段 AI 建议对应档案项，带 🤖 标等你确认——**防幻觉，AI 说的不算数，页面/档案里没有的不会硬填**
- **越用越省事**：你手工填过一次的内容自动记住（可关）；「是否有亲属在本公司」这类问题按网站记忆，不进你的档案
- **填了什么有据可查**：每次填充记录字段与结果，敏感值打码，只存本机

## 安全边界（写死在代码里，不是口号）

- 永不自动提交、永不点完整性校验；分区站点只允许点「保存教育背景」这类分区保存
- 永不上传文件（只提示你人工传）
- 协议/承诺类勾选框**永不自动勾选**
- 默认零网络请求；AI 是可选功能，必须你自己配接口，且默认脱敏送审
- 你的档案只存本机，随时可导出带走

## 支持平台

| 平台 | 状态 |
|---|---|
| 中石油校招（zhaopin.cnpc.com.cn） | ✅ 分区简历全程扫描 / 逐区保存（实测） |
| 通用网申（React/Vue/自绘组件/平铺重复组） | ✅ 引擎全量覆盖 |
| 北森系 iframe 表单 | ✅ 桥接填充 |
| Moka / 大易 / 智联 / 前程无忧 / 国家能源 / 中国电信 | 🔶 已建适配，欢迎实弹反馈 |
| 其他网站没适配过？ | 通用引擎先兜底，遇到问题提 Issue |

## 使用文档

- [使用指南](docs/guide.md)：安装、Profile 档案怎么写、快捷键、工作台、LLM 配置
- [常见问题](docs/faq.md)：装不上 / 没填对 / 杀软误报 / LLM 报错
- [隐私说明](docs/privacy.md)：数据流向与脱敏细节
- 开发者：[CONTRIBUTING.md](CONTRIBUTING.md) · [架构](docs/architecture.md) · [平台测绘](docs/platforms.md)

## 隐私与免责

- 档案只存本机；唯一联网路径是你自己配置的 AI 接口，默认打码后才发出（[隐私说明](docs/privacy.md)）
- 本工具只帮你填自己在浏览器里打开的表单，等价于手工填写；不绕过验证码/登录风控；使用请遵守目标网站条款，风险自负
- 漏洞请走私密通道（[SECURITY.md](SECURITY.md)），不要开公开 Issue

## License

[MIT](LICENSE) © 2026 Shonean
