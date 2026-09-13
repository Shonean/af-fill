# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号对应 `autofill.user.js` 头部 `@version`。

## [1.0.0] - 2026-09-13

首个开源发布版。引擎能力 = 下述 0.8.0 全部内容；另含开源工程化：
CI（引擎语法 / 纯函数 / 全量 mock 回归 / 密钥扫描 / gitleaks）、Release 自动打包工作台 exe + SHA256SUMS、
全部文档与隐私说明、测试数据全部虚构化（fixture「李雷」）。

## [0.8.0] - 2026-09-13

### Added
- **分区式表单全程扫描 / 逐区填充**（`ADAPTERS.cnpc`，deep）：中石油 z1~z9「每区独立编辑/保存」简历——扫描即全程：逐区打开、按档案段数自动补卡（教育1·外语1·通讯1·实习2·家庭2）、执行填充后点该区「保存X」。绝不点最终提交/完整性校验；附件仍人工上传。
- **AI 扫描映射**（LLM 介入扫描环节，设置开关、默认随 LLM 启用）：歧义下拉消歧 `pick`（必须命中现有选项）+ 未命中字段映射档案键 `key`（本机解析、防幻觉）+ `skip`；`🤖` 标注、默认勾选待核对；跨卡片 `MAP_CACHE` 复用。
- 教育卡字典九键：院校中文名称 / 学历形式 / 学位 / 院校类型 / 省份 / 绩点制 / 学分绩点 / 专业方向 / 学位类型 / 证书编号；`#major` jQuery autocompleter 走 `kind='autocomplete'`（keydown 初始化 → keyup 查询 → 点选写 `majorUnionId`）。
- 测试：`mock-cnpc.html` 九分区复刻、`mock-llm-map.html` LLM 桩、`test/run_all.py` 一键回归。

### Fixed
- 「学历形式」标签抢占 `edu.degree`；`edu.degree` pattern 收紧为 `^学历$|最高学历`。
- `fillSelect` 不再盲选第一个包含项（多候选时仅唯一/后缀唯一才选，歧义交 LLM/人工）。
- 单个独立勾选框（学历介绍/协议类）不再偷占数组段位（曾把学位挤到第②段）。
- 分区保存单击防重（`clickOnce`）；`secClickables` 改用「最深文字载体」规则，修复「包着 span 的容器 div 吞掉保存/修改点击」。
- 关系人字段（配偶/父母姓名）不再误填本人信息；占位选项（请选择）永不作为 AI 映射目标。
- 深扫逐卡 `arrOffset` 段号平移：同一控件复用不串段、勾选态不跨段继承。

## [0.6.2] - 2026-09-10

### Fixed
- Defender 误杀（`Trojan:Win32/Bearfoos.B!ml`，PyInstaller 误报）处置与文档指引。
- 4 处 `evaluate(..., timeout=)` 错误调用——曾导致手动新开页面 100% 静默注入失败。
- 崩溃留痕（faulthandler + excepthook 落 `data/logs/app.log`）；双层看门狗；Driver 自愈重连 + CDP `/json` 对账。

## [0.6.1] - 2026-09-10

### Added
- 工作台顶部标签页六模块（概览/网申队列/盯梢/AI 代笔/档案/设置）+ hash 路由。
- 打开即最大化；盯梢源种子随包。

## [0.6.0] - 2026-09-10

### Added
- **打包分发**：`python driver/build.py` → `dist/AF工作台/`（onedir，托盘，单例，首次运行初始化）。
- 分发脱敏：内嵌引擎 SEED 置空、空壳档案模板、构建时敏感串断言扫描。
- `paths.py` dev/frozen 双模式统一路径解析。

## [0.5.0] - 2026-09-09

### Added
- **盯梢源**：fetch/render 双模式提取、三层去重（URL/标题规范化/模糊聚类）、候选审核区、LLM 画像过滤（含择业期判断）、间隔扫描。

## [0.4.0] - 2026-09-09

### Added
- **本地驱动 + 工作台**：专用 Edge 剖面（CDP 9222）、`injector.py` init script 注入（档案 + GM shim + 引擎原样）、FastAPI 仪表盘、台账状态机、批量打开、收录 chip、LLM 打标签 / 开放题代笔 / Profile 热更新。

## [0.2.3] 及更早

- 标签清洗（U+3000 全角空格）、值↔标签双向语义闸、省市区级联拆分填充、DICT 补全、LLM 复核与开放题代笔、受控组件（React/Vue）赋值链、自绘下拉/级联、iframe 桥接与迷你兜底、填充审计、Trusted Types 降级、Debug 悬停测绘模式。
