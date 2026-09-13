# FAQ

## 安装与运行

**Q：双击 exe 被 SmartScreen / 杀软拦了？**
A：exe 未做代码签名，且 PyInstaller 产物常被启发式误报（如 `Trojan:Win32/Bearfoos.B!ml`）。
- SmartScreen：点「更多信息」→「仍要运行」
- 杀软：把程序文件夹加入白名单/排除项；若已被隔离，在「保护历史记录」里还原
- 不放心就**源码运行**：`pip install -r driver/requirements.txt && python driver/workbench.py`，或只用 Tampermonkey 用户脚本

**Q：脚本装上没反应/悬浮球不出现？**
A：依次检查：① Tampermonkey 里脚本是否启用（图标徽标有数字）② 页面是否在 `@match *://*/*` 范围内（所有网页）③ 页面 CSP 很严的企业站会自动降级挂载，仍不出现请开 F12 看报错并提 Issue ④ 改过脚本后篡改猴可能 stale，重启浏览器或把扩展开关关/开一次。

**Q：页面里同时有 Tampermonkey 和工作台驱动，会打架吗？**
A：不会。脚本有双实例保护（`#af-host` + `window.__AF_LOADED`）。但专用 Edge 剖面里建议禁用 Tampermonkey，避免重复注入浪费性能。

## 填充行为

**Q：为什么有的字段没填？**
A：可能原因：① 该行是灰色「需人工」（脚本不敢猜）② 字段是协议/承诺类单个勾选框（**设计上永不自动勾**）③ 控件是自绘下拉且匹配不到选项（绝不盲点，面板会提示手选）④ 档案里没有对应值。用「Debug 悬停模式」定位。

**Q：会不会替我提交？**
A：不会。最终提交、完整性校验按钮在代码层被排除；分区式站点只会点适配器白名单里的「保存教育背景」这类**分区保存**。

**Q：身份证/电话会被自动填吗？**
A：身份证等敏感字段默认**跳过**（红色行，需手动勾选）；LLM 送审时默认脱敏。

**Q：重复经历（教育②/实习②）怎么对应档案？**
A：按 DOM 顺序取档案第 k 段，绝不复制前一段；分区式站点（中石油）会按档案段数自动补卡。

## Profile / 数据

**Q：Profile 怎么写？**
A：复制 `profile/profile.example.json` → 改名为 `profile/profile.json` 编辑，或直接面板 Profile Tab 粘贴导入。字段含义见 [guide.md](guide.md#profile档案)。

**Q：换电脑怎么迁移？**
A：迁移整个 `data/` 文件夹（工作台）；Tampermonkey 用户用 Profile Tab「复制导出」带走 JSON。

**Q：我的数据会被上传吗？**
A：不会，除非你显式配置 LLM。见 [privacy.md](privacy.md)。

## LLM

**Q：不配 LLM 能用吗？**
A：能，全部离线可用；LLM 只是提高歧义场景的命中率。

**Q：调用报 403/跨域失败？**
A：Tampermonkey 下首次需要点篡改猴弹窗「总是允许」该 API 域名；工作台模式下由本机 `127.0.0.1:8790/proxy` 转发，无跨域问题。检查 Base URL 是否 OpenAI 兼容（`/v1/chat/completions`）。

**Q：LLM 会瞎填吗？**
A：不会：`pick` 必须命中页面现有选项才落地，`key` 必须能在本机档案里解析出值（防幻觉），AI 行都带 `🤖` 标且默认勾选待你核对。

## 开发 / 贡献

**Q：怎么加一个新平台适配？**
A：见 [CONTRIBUTING.md](../CONTRIBUTING.md)：`ADAPTERS` 加条目 + 写 `test/mock-*.html` + smoke 断言 + 更新 [platforms.md](platforms.md)。

**Q：测试怎么跑？**
A：`python test/run_all.py`（需要 node + playwright + chromium）。

**Q：为什么引擎是单文件不拆模块？**
A：为了方便 Tampermonkey 粘贴/自动更新与零依赖注入；拆分会引入构建步骤。纯函数逻辑用 `test/_vt_tests.js` 从源码切片直测。
