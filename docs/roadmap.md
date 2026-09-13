# Roadmap

## 开源上线计划（2026-09）

- [x] **M0 脱敏净化**：`.gitignore`（档案/密钥/运行数据/构建产物）· `build.py` 敏感词表外置 `tools/sanitize.local.json` · 测试全部切换到虚构 fixture（李雷）· `scripts/check_secrets.py` 双扫
- [x] **M1 仓库结构**：`docs/`（guide/platforms/architecture/privacy/faq/roadmap）· README 重构 · LICENSE/CHANGELOG/CONTRIBUTING/SECURITY/CoC · `docs/demo/`（GitHub Pages 在线演示）· `test/run_all.py`
- [x] **M2 CI**：`ci.yml`（引擎语法 + VT + 全量离线回归 + 密钥扫描 + gitleaks）· `release.yml`（tag → Windows 打包 exe → zip + SHA256SUMS + 引擎单文件）
- [x] **M3 发布**：建库推送（[Shonean/af-fill](https://github.com/Shonean/af-fill)）→ [v1.0.0 Release](https://github.com/Shonean/af-fill/releases/tag/v1.0.0)（CI 自动打包 exe + SHA256SUMS + 引擎单文件）→ Pages 演示站 + Discussions
- [ ] **M3.1 社区发布**：Greasy Fork / V2EX / 掘金等
- [ ] **M4 真实页面验收清单**：中石油真机全流程（教育卡全绿 → 逐区保存 → 人工补附件/父母出生日期/证书编号）· 国家能源重扫 · 中国电信可编辑路由定位

## 引擎能力

- [ ] 更多平台适配（欢迎 PR）：北森 / Moka / 大易 / 智联 / 前程无忧 的真实页面测绘见 [platforms.md](platforms.md)
- [ ] 日期控件的更多形态（select 三连 / 自绘 / 时区）
- [ ] 富文本（contenteditable iframe 型）覆盖
- [ ] 字典扩展：获奖/证书/论文/党员材料等
- [ ] 英文 README 与界面 i18n（先英文 README）

## 工作台

- [ ] macOS / Linux 支持调研（当前宿主链依赖 Windows WinForms/WebView2）
- [ ] Release 自动签名（降低 SmartScreen 摩擦，可选）
- [ ] 盯梢源「加载更多」型站点的 render 模式继续实弹

## 质量

- [ ] smoke 覆盖 adapter registry（每个平台一个 mock）
- [ ] 引擎纯函数测试继续外扩（REGION/VALIDATE 边界）
- [ ] 可访问性（键盘操作面板全流程）

> 有想法欢迎开 [Feature Request](https://github.com/Shonean/af-fill/issues/new?template=feature_request.yml)。
> 安全硬约束不在此列（不自动提交/不上传/不勾协议框），相关功能请求会被拒绝。
