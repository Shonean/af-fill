# 架构

## 总览

```
                         ┌──────────────────────────── 浏览器页面 ────────────────────────────┐
   Tampermonkey 直装 ──▶ │  autofill.user.js（单文件引擎，零依赖）                              │
                         │  扫描 → 清单(UI) → 执行填充(仅勾选项)                               │
                         └──────────────────────────────────────────────────────────────────────┘
                                             ▲ 同一份引擎，原样注入
   driver/injector.py ── init script = window.__AF_DATA(档案) + GM shim + 引擎全文
                                             │
   求职工作台.exe / workbench.py：FastAPI(8790) 仪表盘/台账/LLM 代理/盯梢  ──▶ 专用 Edge(9222 CDP)
```

- **引擎单文件**：`autofill.user.js` 是唯一真源；工作台不 fork 引擎，用 `driver/injector.py` 原样注入（等价性由 `test/_smoke_driver.py` 回归保证）。
- **工作台只是壳与通道**：开页、台账、LLM 转发、盯梢；填充仍由同一引擎执行。

## 引擎（autofill.user.js，12 段）

| 段 | 职责 |
|---|---|
| 01 UTIL | 文本清洗（含 U+3000 全角空格折叠）、可见性、原生 setter 赋值 |
| 02 STORE | GM shim：`GM_setValue/GetValue` → localStorage 镜像；档案/设置/审计/站点问答 |
| 03 SEED | 内置**虚构示例档案**（李雷）——真实档案不写进源码 |
| 04 DICT | 字段语义字典：key(档案路径)/label/aliases/pattern/en/vtype/sensitive/section/deepOnly |
| 04b ADAPTERS | 平台适配：match + hooks（`sections()/want()` 等） |
| 04c REGION | 省/市/区拆分、选项层级自检、后缀剥离匹配 |
| 04d VALIDATE | 值↔标签双向语义闸（semBad）、类型推断（inferVtype） |
| 05 SCANNER | 控件枚举；识别 autocomplete 类输入（`kind='autocomplete'`） |
| 06 LABELER | 7 种标签来源加权：label[for] / 包裹 label / aria-label / 表格列头 / 前置兄弟 / placeholder / 英文 name·id |
| 07 MATCHER | 字典匹配（精确/别名/包含/编辑距离）+ 消歧 |
| 08 ROWS | 生成核对清单行；重复组按 `arrOffset` 取档案第 k 段 |
| 09 FILLER | 各控件填充：text/setNativeValue、select 消歧、widget、autocomplete、region、contenteditable |
| 09b LEARN | 自动学习（你键入的未知标签→本机档案/自定义字段；验证码/密码/搜索永不学） |
| 10 BRIDGE | iframe 子框架协议（SCAN / FILL_ONE），token 双校验 |
| 10b DEEP | 分区式站点遍历：`activateSection/openCard/saveSection` |
| 11 UI | 悬浮球 + 面板（Shadow DOM，Trusted Types 降级）；Debug 悬停；审计 |
| 11b LLM | 扫描映射 / 复核 / 开放题代笔（均走用户自己的 OpenAI 兼容接口） |
| 12 BOOT | 启动、双实例保护、observer 复扫 |

### 扫描 → 填充流水线

1. **SCANNER** 枚举可见控件（含子 frame 请求）
2. **LABELER** 多来源定标签 → **MATCHER** 匹配 DICT → 置信度分档（high/mid/low/sensitive）
3. **VALIDATE** 值↔标签双向闸拦「姓名框填出 CET-4」类错配（默认不勾选）
4. **ROWS** 生成清单；同标签竞争仲裁；重复组按序号平移
5. （可选）**LLM 扫描映射**：把「歧义选项 + 未命中控件 + 脱敏档案键值表」一次送审 → `pick/key/skip`
6. **FILLER** 仅填勾选行：受控组件走原型 setter（先清后赋 + 冒泡），失败降级 `execCommand`；自绘下拉"点击壳→等浮层→文本点选"，匹配不到**绝不盲点**

### 安全硬约束（代码落实）

- 无 `form.submit()`、无 submit 按钮点击；分区保存由适配器白名单驱动（`clickOnce` 防双击）
- 不触碰 `type=file`；单个独立 checkbox（协议类）永不自动勾选
- 敏感字段（身份证等）默认不勾选；LLM 送审默认打码
- 默认零网络请求；`GM_xmlhttpRequest` 仅用于用户显式配置的 LLM endpoint

## DEEP 模块（分区式站点）

站点形态：每分区「查看态 ↔ 编辑态」分离，同一张表单控件复用于第 k 条记录。

- `deepSecs()`：适配器 `sections()` 返回 `{key,name,navEl,root}` 列表
- `deepScan()`：逐区 `activateSection` → 需要时 `openCard(k)` 补卡/进编辑态 → 收集行（`buildRows(..., arrOffset=k)`）→ 回到查看态
- `doFillDeep()`：逐区逐段填充 → `saveSection()` 点该区保存按钮（排除 提交/完整性校验）
- `openCard`：已有记录走第 k 条「修改」；不足时按 `want()` 自动补卡
- `patchDialogs()`：接管 alert/confirm（防原生弹窗卡死脚本）

## LLM 通道

页面（脚本）→ `GM_xmlhttpRequest` → 工作台 `POST /proxy` → 用户配置的 OpenAI 兼容接口。
Tampermonkey 直装时走原生 `GM_xmlhttpRequest`（首次需在篡改猴点「总是允许」该域名）。

- `mapDigest()`：档案 → 脱敏键值表（身份证/电话打码；「明文送审」开关可关脱敏）
- `applyMapResult()`：`pick` 必须命中页面现有选项、`key` 必须本机可解析——**防幻觉**，不存在的 key 直接丢弃
- `MAP_CACHE`：跨卡片/跨次扫描复用映射结果

## 驱动与工作台（driver/）

| 模块 | 职责 |
|---|---|
| `injector.py` | 三段拼接 init script：`__AF_DATA` + GM shim + 引擎；变更检测去重注入 |
| `af_core.py` | Driver 线程（Playwright 唯一属主）：CDP 连接 9222、tab 对账、自愈重连、HTTP 预检防挂死；Store：config/ledger/profile 持久化 |
| `workbench.py` | FastAPI：仪表盘、台账状态机、`/proxy` LLM 转发、盯梢 API、事件流（填充→已填） |
| `watcher.py` | 盯梢：fetch/render 双模式提取 + 三层去重 + LLM 过滤 |
| `af_app.py` | 入口：单例互斥体、托盘、宿主兜底链（WinForms → pywebview → 系统浏览器）、看门狗、路径解析（dev/frozen 一致） |
| `af_edge.ps1` / `start_af.bat` / `make-shortcut.vbs` | 专用 Edge 剖面（CDP 9222）启动器与快捷方式 |
| `build.py` | PyInstaller onedir 打包 + SEED 置空 + 敏感词断言扫描 |

数据目录（运行时生成，已 gitignore）：`data/{config,ledger,state,profile}.json`、`data/watch/`、`data/logs/`。

## 测试金字塔

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯函数 | `test/_vt_tests.js`（Node 直跑） | 清洗/区域拆分/类型闸 30 断言 |
| 引擎·通用 | `test/mock-generic.html` + `_smoke.py` | 7 种标签来源、平铺重复组、级联、安全项 |
| 引擎·受控/自绘 | `mock-react.html` · `mock-custom-widget.html` | setNativeValue、下拉/级联异步 |
| 引擎·iframe | `mock-iframe-guard.html` + `_smoke_iframe.py` | 桥接与无关 iframe 护栏 |
| 引擎·分区 | `mock-cnpc.html` + `_smoke_cnpc.py` / `_smoke_cnpc_deep.py` | z1~z9 全程扫描/补卡/分区保存/二轮修改路径 |
| LLM 桩 | `mock-llm-map.html` + `_smoke_llm_map.py` | pick 消歧 / key 映射 / 防幻觉 |
| 驱动等价 | `_smoke_driver.py` | init script 注入与直载行为一致 |
| 真机 | `_live_*.py`（手动，需本机 Edge/工作台） | 端到端冒烟 |

统一入口：`python test/run_all.py`（自动起 8080 静态服务器）。
