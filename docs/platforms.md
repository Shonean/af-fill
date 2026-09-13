# 平台测绘与适配笔记

> 用法：打开目标平台的网申页 → 面板「设置」→ 开启 **Debug 悬停模式** → 悬停每个控件记下
> `KIND / LABEL 来源 / HIT 字典项`；必要时「设置 → 诊断报告 → 生成报告」把全页结构拷到这里。
> 测绘结论落在 `autofill.user.js` 的 `ADAPTERS` 里（通用引擎兜底，平台只做加减法）。
> 新增适配请同时补 `test/mock-*.html` + smoke 断言，见 CONTRIBUTING.md。

## 通用引擎已覆盖（无需平台适配）

| 特征 | 引擎路径 |
|---|---|
| label[for] / 包裹 label / aria-label / 表格列头 / 前置兄弟 / placeholder / 英文 name | LABELER 7 来源加权 |
| React/Vue 受控 input·textarea | setNativeValue（原型 setter 先清后赋 + input/change 冒泡）→ execCommand 降级 |
| 自绘下拉（.ant-select / .el-select / [role=combobox]） | kind=widget：点击壳 → 等 portal 浮层 → 文本点选；可搜索下拉自动输入过滤 |
| 级联（省→市，异步加载） | fillWidget 轮询浮层 1.2s，二级选项出现后再匹配 |
| readonly 日期 input（.ant-picker 等） | 临时移除 readonly → setNativeValue → 恢复 |
| 表单在 iframe 内 | BRIDGE：子 frame 响应 SCAN/FILL_ONE，行并入主清单（[子框架·host] 前缀） |

## 北森（*.beisen.com / *.ituiz.com）

- 状态：**stub 已建**（ADAPTERS[0]），待真实页面测绘。
- 已知模式（待验证）：表单常嵌在客户官网 iframe 里 → 桥接是主路径；表格布局标签（colhead 权重 0.8 已覆盖）；
  级联城市为搜索式下拉（fillWidget 的搜索路径应命中）。
- 测绘待办：
  - [ ] 城市/省份下拉的真实类名（是否 .ant-select 系 or 自研）→ 决定 WIDGET_SEL 是否要加选择器
  - [ ] 上传控件是否分包（脚本只提示人工上传，无需处理）
  - [ ] 分步表单翻页后 MutationObserver 是否触发自动重扫提示

## Moka（saasjob / hire.mokahr.com）

- 状态：**stub 已建**，待真实页面测绘。
- 已知模式（待验证）：React 全受控（setNativeValue 主链）、自绘下拉 portal（.ant-select 系组件库），
  分步表单 → 依赖 observer 重扫。
- 测绘待办：
  - [ ] 受控赋值是否被组件拦截（若 fillText 返回「未接受赋值」，补 KeyboardEvent 逐字符降级）
  - [ ] 下拉浮层类名与 option 元素结构

## 大易（*.dayee.com）

- 状态：**stub 已建**，待真实页面测绘。
- 已知模式（待验证）：服务端渲染 + jQuery 传统控件多 → 原生 select/radio 命中率高；
  自我评价可能为 contenteditable（fillCE 已备）。
- 测绘待办：
  - [ ] 富文本编辑器实际 DOM（iframe 型富文本需要额外桥接）

## 智联校园（xiaoyuan.zhaopin.com）

- 状态：stub 已建。在线简历多 step → observer 复扫已覆盖，待验证 option 格式（日期拆分控件多）。

## 前程无忧（campus.51job.com）

- 状态：stub 已建。table 布局 + 大 textarea → colhead / 开放题 Tab 已覆盖，待验证。

## 中国电信（job.chinatelecom.com.cn）

- 状态：自研 ATS。**v0.2.1 已在真实站点注入成功（Edge + 篡改猴，2026-09-08）**。
- 实测记录：
  - `#/resumepreview?data=<base64>` 是**只读预览页**——整页无 input 控件，扫描 0 项属正常（内容渲染自 URL 参数）。可编辑表单在别的路由，待定位（站内「简历管理 / 编辑简历」入口或投递时的填写页）。
  - 页面内嵌第三方 SDK（aa.shopshop123.cn，已死）+ 站点自身压缩 JS 有报错——均与本脚本无关。
  - **踩坑 1（已修，v0.2.1）**：本站疑似启用 Trusted Types，v0.2.0 的 shadow UI 挂载（innerHTML）在注入后静默崩溃 → 已改为 DOMParser 降级挂载。
  - **踩坑 2（运维）**：Edge 下改完脚本/扩展后篡改猴后台可能 stale（控制台 `content.js: injected: env: missing script <uuid>`，徽标无数字、脚本不注入）→ 完全重启 Edge，或在 edge://extensions 把篡改猴开关关/开一次即恢复。
- 已确认：岗位特有问句（亲属从业 / 运营商经验）已由 siteQA 记忆（本站），不进 Profile。
- 页面已手工填全并回写 Profile（2026-09-08）：通用亲属信息存 `base.family`（父母各一段，均不在电信从业）；`base.basic` 补齐身份证/政治面貌/籍贯/户口/地址/期望城市×2/薪资/到岗/英语分数等；projects 与 internships 按该站 DOM 顺序重排更稳。
- 已知本站问答答案（待采集按钮入 siteQA）：是否接受岗位调剂=是。
- 测绘待办：
  - [ ] 定位可编辑表单路由，生成诊断报告贴回本文件
  - [ ] 日期控件形态（select 三连 / 自绘 / 原生 date）

## 中石油（zhaopin.cnpc.com.cn · createResume.html）

- 状态：**v1.0.0 已测绘并接入 ADAPTERS.cnpc（deep）**（2026-09-13，虚构档案 mock 复刻回归 33/33）。
- 页面结构（实测）：
  - 左侧 `div[id^=z][1-9]` 导航，`nextElementSibling` 即分区容器（每区独立显示/隐藏）：
    基本信息 / 教育背景 / 外语水平 / 通讯信息 / 实习·工作·入伍经历 / 获奖信息 / 家庭成员 / 其它资格 / 附件
  - 每区「查看态 ↔ 编辑态」分离：`修改` / `添加X` 进入编辑，`保存X` 提交该区（**分区级保存**，非最终提交）
  - 控件标签均为 `li.zzza > span.zz` 前置（v0.7 祖先兄弟规则已覆盖）
- 教育卡（问题最集中）：
  - `#educationType`（学历形式）标签含"学历"曾抢占 `edu.degree` → 已加 `edu.eduType` 正名 + `edu.degree` pattern 收紧 `^学历$|最高学历`
  - 缺失字段全部补了字典：院校类型/学位/绩点制/学分绩点/专业方向/学位类型/院校中文名称/省份/证书编号
  - `#major` 是 jQuery autocompleter（`onkeydown=doSearchMajor()` → keyup 查询 `/web/resume/selectMajorAllByInput` → 点选写 `#majorUnionId`）→ 新增 `kind='autocomplete'` 填充路径（keydown 初始化 → 写值 → keyup → 点头部候选）
  - `#xw`（学位）onchange 会自动联动 `#xl`（学士→大学本科），引擎填 xw 后 xl 自动就位
  - 学历介绍（最高学历/第一学历）为单独勾选框 → 引擎永不自动勾（会影响附件必传文案，人工勾选）
- 分区适配结论（ADAPTERS.cnpc）：
  - `sections()`：扫描 z1~z9 + nextElementSibling；`want()` 按档案段数：教育 1 / 外语 1 / 通讯 1 / 实习 2 / 家庭 2（获奖/项目/其它/附件不自动）
  - 深扫逐卡带 `arrOffset`（同一表单控件复用给每段经历，段号平移绑定 profile[k]）；分区保存用单击版 `clickOnce`（防添加/保存被双击）
  - 通讯信息 省/市/区：`deepOnly` 字典项 `basic.regionNow`（path=basic.cityNow，region）按选项层级填充
  - `section` 词典项（family.*/intern 起止/lang.*）只在对应分区竞争：避免「姓名/电话/工作单位」跨区串键
- 待办：真机全流程验收（教育卡全绿 → 逐区保存 → 人工补附件/父母出生日期/证书编号）；通讯信息「城市」下拉在真机的层级（省市混排）待 Debug 悬停确认
## 国家能源（集团校园招聘网申站）

- 状态：**v0.2.2 首轮真实投递实测**（2026-09-08）——暴露的两个缺陷即 v0.2.3 的修复靶，均已修：
  - **标签含全角空格（U+3000）**：`姓　名` 被 cleanLabel 折叠成 `姓 名`，与字典 alias `姓名` 永不相等、互不包含、编辑距离分支又要求 ≥4 字 → basic.name 零候选，姓名 input 被贪心仲裁错配到 basic.englishLevel，填出 "CET-4"。→ v0.2.3 起含 CJK 的标签内部空白全删（`姓　名`→`姓名` 精确命中）；另加**规则语义校验层**（值↔标签双向闸，此类错配直接 semBad 拦下，默认不勾选）。
  - **省/市/区原生 select 级联**：旧 fillSelect 第三级匹配双向包含——`"江苏省南京市".includes("江苏")` 点完省级即报成功返回，市/区级联无人跟进。→ v0.2.3 REGION 分区：按选项自检层级（detectLevel）逐级拆分填充 + 双方剥后缀匹配（江苏省↔江苏）+ 级联未加载自动等待（12×100ms）。
- 本站问答（是否亲属从业=否 等）已由自动学习记入 siteQA（仅本机浏览器存储，不进 Profile）。
- 测绘待办：
  - [ ] v0.2.3 重扫验证：姓名行（绿）、籍贯/户口/生源地三级全满、语义不符行标红待人工
  - [ ] Debug 悬停确认市/区级是否原生 select（若为自绘 widget，验证 fillWidget 的 detectLevel 分支）
  - [ ] 问卷/开放题形态与字数限制

## 附：桥接协议速查

```
主框 → 子frame: {src:'AF_FILL', token, type:'SCAN',     variant}
子frame → 主框: {src:'AF_FILL', token, type:'SCAN_RES', url, rows:[{id,kind,label,conf,value,checked,...}]}
主框 → 子frame: {src:'AF_FILL', token, type:'FILL_ONE', rowId, value, values}
子frame → 主框: {src:'AF_FILL', token, type:'FILL_RES', rowId, result:{ok,why}}
```
token 每页随机（Math.random），消息双校验 src+token；跨域 iframe 天然可运行（*://*/* 注入）。
