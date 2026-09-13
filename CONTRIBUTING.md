# 贡献指南

感谢参与。先读 [安全硬约束](../docs/architecture.md#安全硬约束代码落实)——违反它们的 PR 不会被合并：
**不自动提交、不上传文件、不自动勾选协议类单选框、默认零网络请求。**

## 开发环境

```bash
# 引擎：零依赖，Node 只用来自查语法
node --check autofill.user.js

# 测试
pip install playwright
python -m playwright install chromium
python test/run_all.py          # 起 8080 静态服务器 + 全部离线回归

# 工作台
pip install -r driver/requirements.txt
python driver/workbench.py
```

## 仓库约定

- **单文件引擎**：`autofill.user.js` 是唯一真源，不拆模块、不加第三方运行时依赖；注释用中文，与现有 12 段结构对齐。
- **不要改生成物**：`driver/build_artifacts/`、`dist/`、`build_*` 均为构建产物（已 gitignore）。
- **不要提交个人数据**：档案、API Key、本机路径。提交前跑 `python scripts/check_secrets.py`；本地词表放 `tools/sanitize.local.json`（已 gitignore）。
- 测试数据统一用虚构角色（`test/fixture/profile.fixture.json`，李雷），不要在测试/mock 里写真实信息。

## 新增平台适配

1. **测绘**：真实页面 → 面板「设置 → Debug 悬停模式」记录控件结构（KIND/标签来源/命中）；必要时「诊断报告」导出结构。结论写进 `docs/platforms.md`。
2. **适配**：`autofill.user.js` 的 `ADAPTERS` 加条目（`match` + 可选 hooks）。优先用通用引擎兜底，平台只做加减法；分区式站点实现 `deep: true` + `sections()/want()`（参考 `cnpc`）。
3. **回归**：在 `test/` 新增/扩展 `mock-*.html` 复刻关键结构（**用虚构数据**），加 smoke 断言：
   - 通用页 → `_smoke.py`
   - 分区页 → 参考 `_smoke_cnpc_deep.py`（把本地 mock 路由成目标域名以命中适配器）
4. **文档**：更新 `docs/platforms.md` 状态、`CHANGELOG.md` Unreleased。

## PR 要求

- `python test/run_all.py` 全绿（新增断言算数）
- `python scripts/check_secrets.py` 0 命中
- 说明改动动机与验证方式；一个 PR 只做一件事

## 提交信息

简短祈使句 + 可选 scope，例：
`fix(cnpc): openCard 走「修改」路径不重复补卡`
`feat(dict): 教育卡新增绩点制/学分绩点`

## 行为准则

参与即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
