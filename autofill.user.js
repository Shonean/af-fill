// ==UserScript==
// @name         网申快填 AF-Fill
// @namespace    af-fill.shonean
// @version      1.0.0
// @description  秋招网申表单识别与辅助填充：扫描 → 人工核对清单 → 仅填充勾选项。绝不自动提交、绝不自动上传文件、默认零网络请求（显式配置自己的 LLM 接口并启用后才联网，敏感值默认脱敏送审）。
// @author       Shonean
// @homepageURL  https://github.com/Shonean/af-fill
// @supportURL   https://github.com/Shonean/af-fill/issues
// @downloadURL  https://raw.githubusercontent.com/Shonean/af-fill/main/autofill.user.js
// @updateURL    https://raw.githubusercontent.com/Shonean/af-fill/main/autofill.user.js
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/* ================================================================
 * AF-Fill · v1.0.0（分区式表单全程扫描/逐区填充 + AI 扫描映射 + 中石油教育卡修复）
 * 分区：01 UTIL / 02 STORE / 03 SEED / 04 DICT / 04b ADAPTERS / 04c REGION / 04d VALIDATE
 *       05 SCANNER / 06 LABELER / 07 MATCHER / 08 ROWS / 09 FILLER / 09b LEARN / 10 BRIDGE
 *       10b DEEP（适配器驱动的分区遍历） / 11 UI / 11b LLM / 12 BOOT
 * 安全硬约束（代码层落实）：
 *   - 永不调用 form.submit()，永不点击任何 submit 控件；分区保存（保存教育背景等）除外，
 *     且由适配器白名单驱动、绝不含「提交/完整性校验」类按钮；最终投递提交始终由人工点击
 *   - 永不触碰 type=file（仅提示人工上传）
 *   - 单个独立 checkbox（协议/承诺类）永不自动勾选
 *   - 默认零网络请求（无 fetch/XHR/外链字体）；仅在设置里显式配置自己的 LLM API
 *     并启用后，才经 GM_xmlhttpRequest 向该 endpoint 批量送审（敏感值默认脱敏）。
 *     不加 @connect *：首次调用时篡改猴弹一次「允许该域名」确认，选「总是允许」即可。
 * ================================================================ */
(function () {
'use strict';

/* 顶层 frame 渲染 UI；子 frame 走 iframe 桥接（12 BRIDGE：无面板，响应主框扫描/填充） */
const IS_TOP = window.top === window;
/* 双实例保护：本页已注入（如测试页 <script> 直载 + 油猴同时存在 + 驱动 init script）则不重复挂 UI。
   window flag 在求值期即置位——早于 DOMContentLoaded 的 boot，防止两份拷贝都通过 #af-host 检查后双重 boot */
if (document.getElementById('af-host') || window.__AF_LOADED) return;
window.__AF_LOADED = true;

const VER = '1.0.0';

/* ================= 01 UTIL ================= */
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TH_HIGH = 0.75, TH_MID = 0.45;
const CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const $ = (s, r) => (r || document).querySelector(s);
const normText = s => String(s || '').replace(/\s+/g, ' ').trim();

function cleanLabel(raw) {
  let s = normText(raw);
  /* 含 CJK 的文本：内部空白全删（"姓　名"(U+3000)→"姓名"、"南 京"→"南京"）；ASCII 标签（First Name）保留词间空格 */
  if (/[^\x00-\x7F]/.test(s)) s = s.replace(/\s+/g, '');
  s = s.replace(/[:：\s*＊✱]+$/g, '');          // 尾部冒号/星号
  s = s.replace(/^[\s*＊✱]+/g, '');             // 头部星号
  s = s.replace(/[（(][^（）()]{0,16}[）)]/g, ''); // 括注（必填）/（格式…）
  s = s.replace(/[①-⑳\d]+$/g, '');             // 尾部序号：项目经历1 → 项目经历
  return normText(s).slice(0, 16);
}
function hasReqMark(raw) { return /[*＊✱]|必填/.test(String(raw || '')); }
/** 字典侧标签归一化：与 cleanLabel 同规则（含 CJK 去内部空白），保证 "GitHub 主页"↔"GitHub主页" 相互命中 */
function normDictLabel(x) { const s = String(x || ''); return /[^\x00-\x7F]/.test(s) ? s.replace(/\s+/g, '') : s; }

/** label 容器自身的文字（剔除内部控件的自带文字） */
function ownText(container, exceptEl) {
  if (!container) return '';
  const clone = container.cloneNode(true);
  clone.querySelectorAll('input,select,textarea,button').forEach(n => n.remove());
  return normText(clone.textContent);
}
/** 容器内文字，但跳过 skipEls 里元素（含子树）的文本 —— 用于重复组题干提取 */
function textExcluding(root, skipEls) {
  const skip = new Set(skipEls);
  let t = '';
  const walk = n => {
    for (const ch of n.childNodes) {
      if (skip.has(ch)) continue;
      if (ch.nodeType === 3) t += ch.nodeValue;
      else walk(ch);
    }
  };
  walk(root);
  return normText(t);
}

function tokens(str) {
  return String(str || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2);
}
function lev1(a, b) {  // 编辑距离 ≤1 且均为 ≥4 字
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return true;
}
function isAscii(s) { return /^[\x00-\x7F]+$/.test(String(s || '')); }

function isVisible(el) {
  if (!el.getClientRects().length) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none';
}
function flashEl(el, cls) {           // 页面级闪烁：V=已填(黑) Y=需人工(琥珀)
  try {
    el.classList.remove('af-flashV', 'af-flashY');
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 2200);
  } catch (e) {}
}

/* ================= 02 STORE（GM 存储 · 跨站点；无 GM 时回退 localStorage） ================= */
const K_PROFILE = 'af.profile', K_SETTINGS = 'af.settings', K_BALL = 'af.ballPos', K_SITEQA = 'af.siteQA', K_AUDIT = 'af.audit';
/* 本站问答种子（岗位特有问题的答案只属于站点，永不进 Profile；设置页可清除） */
const SEED_SITEQA = {
  'job.chinatelecom.com.cn': {
    '是否有亲属在中国电信集团从业': '否',
    '是否有运营商实习经验': '否'
  }
};
const Store = {
  get(k, d) {
    try { if (typeof GM_getValue === 'function') { const v = GM_getValue(k); return v === undefined ? d : v; } } catch (e) {}
    try { const v = localStorage.getItem('af:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  },
  set(k, v) {
    try { if (typeof GM_setValue === 'function') { GM_setValue(k, v); return; } } catch (e) {}
    try { localStorage.setItem('af:' + k, JSON.stringify(v)); } catch (e) {}
  },
  settings() {
    const s = Store.get(K_SETTINGS, null);
    if (s && typeof s === 'object') { s.disabled = s.disabled || {}; return s; }
    return { disabled: {} };
  },
  saveSettings(s) { Store.set(K_SETTINGS, s); },
  getProfile() {
    let p = Store.get(K_PROFILE, null);
    if (!p || p.schemaVersion !== 1) { p = JSON.parse(JSON.stringify(SEED_PROFILE)); Store.set(K_PROFILE, p); }
    return p;
  },
  saveProfile(p) { Store.set(K_PROFILE, p); },
  siteQA() {
    const m = Store.get(K_SITEQA, null);
    const out = (m && typeof m === 'object') ? JSON.parse(JSON.stringify(m)) : {};
    const seed = SEED_SITEQA[location.host];
    if (seed && !out._noseed) out[location.host] = Object.assign({}, seed, out[location.host] || {});
    return out;
  },
  saveSiteQA(m) { Store.set(K_SITEQA, m); }
};
function deepMerge(t, s) {
  for (const k in s) {
    const sv = s[k], tv = t[k];
    const bothPlain = sv && tv && typeof sv === 'object' && typeof tv === 'object'
      && !Array.isArray(sv) && !Array.isArray(tv);
    if (bothPlain) deepMerge(tv, sv); else t[k] = sv;
  }
  return t;
}
/** base + 变体 overrides → 生效数据 */
function mergedProfile(profile, variantKey) {
  const m = JSON.parse(JSON.stringify(profile.base));
  const v = variantKey && profile.variants && profile.variants[variantKey];
  if (v && v.overrides) deepMerge(m, v.overrides);
  return m;
}
function pathGet(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/* ================= 03 SEED（首次运行的内置示例档案：虚构人物「李雷」，仅用于演示/开箱体验） =================
   真实档案不写在源码里：面板 Profile Tab 导入，或见 profile/profile.example.json 复制改填 */
const SEED_PROFILE = {
  schemaVersion: 1,
  updatedAt: '2026-01-01',
  base: {
    basic: {
      name: '李雷', phone: '13800138000', email: 'lilei@example.com', gender: '男',
      birthDate: '2002-03', idCard: '', politicalStatus: '群众', maritalStatus: '未婚', nation: '汉族',
      hometown: '江苏省南京市玄武区', gaokaoSource: '江苏省南京市玄武区', hukou: '江苏省南京市玄武区',
      cityNow: '江苏省南京市', address: '南京市玄武区示例路1号', cityExpected: '江苏省南京市', salaryExpected: '4500-5999', job: '',
      github: 'github.com/example-dev', qq: '', wechat: '', englishLevel: 'CET-4',
      emergencyContact: { name: '王秀英', phone: '13900139000' }
    },
    education: [{ school: '示例工业大学', major: '软件工程', degree: '本科', startDate: '2022-09', endDate: '2026-06', range: '2022.09-2026.06' }],
    projects: [
      { name: '校园二手交易平台（课程设计）', role: '独立开发', range: '2025.03-2025.06',
        description: '面向校园场景的二手交易平台：Spring Boot + Vue 实现商品发布、搜索、下单与站内消息；MySQL 存储业务数据，Redis 缓存热点商品；完成权限、订单状态机与基础风控（重复发布拦截）。', link: '' },
      { name: '分布式网盘系统（个人项目）', role: '独立开发', range: '2025.07-2025.09',
        description: '个人练手项目：基于 FastAPI 实现分片上传、秒传与断点续传，S3 兼容存储后端，PostgreSQL 记录文件元数据；实现失败重试与完整性校验，保证大文件上传的完整性。', link: 'github.com/example-dev/cloud-disk' },
      { name: '基于 WebGL 的数据可视化系统（毕业设计）', role: '独立开发', range: '2026.01-2026.05',
        description: '毕业设计：基于 WebGL 实现大规模数据点云渲染与交互分析，完成透视投影、光照模型与着色器编程；支持视角控制、区域选择与距离测量等交互操作。', link: '' }
    ],
    internships: [
      { company: '示例软件科技有限公司', position: '后端开发实习生', range: '2025.07-2025.09',
        description: '参与内部工单系统的后端开发：基于 Spring Boot 完成工单流转接口与权限校验，补充单元测试并修复并发问题；协助排查慢查询，优化索引后接口平均耗时下降约 40%。' },
      { company: '示例教育科技股份有限公司', position: '前端开发实习生', range: '2025.01-2025.02',
        description: '参与在线学习平台的前端开发：使用 Vue 完成课程列表、播放页与学习进度模块，抽离通用组件并统一交互规范；与后端联调接口，提升页面首屏体验。' }
    ],
    skills: ['Java', 'Python', 'JavaScript', 'Spring Boot', 'MyBatis', 'React', 'Vue', 'PostgreSQL', 'MySQL', 'Git', 'Linux', 'OpenGL'],
    skillSummary: '编程语言：熟悉 Java 与 Python，能完成常规后端开发与脚本编写。\n前端基础：掌握 HTML5、CSS3、JavaScript（ES6+）与 Vue/React，能独立完成页面布局与交互。\n后端框架：熟悉 Spring Boot、MyBatis 与 REST 接口设计，理解常用注解与配置原理。\n数据库：熟悉 PostgreSQL/MySQL，能使用 SQL 完成查询、分析与基础调优。\n工具与工程：熟悉 Linux 常用操作与 Git 版本管理，能独立排查常见环境与日志问题。\n图形与数学：了解 OpenGL 与基础图形学，完成过数据可视化方向的毕业设计。\n语言与协作：英语四级（456），能阅读英文技术文档；有校企合作项目经验，习惯与前后端、UI 协同推进。',
    selfIntro: '面试官您好，我是{{name}}，示例工业大学软件工程专业2026届本科生。在校期间我完成了校园二手交易平台、分布式网盘与数据可视化毕业设计三个项目，具备从需求拆解到落地的完整闭环能力；先后在示例软件科技与示例教育科技完成后端、前端方向实习。我学习能力强、执行力高，期待加入{{company}}，把技术做成实际价值。',
    openQuestions: [],
    customFields: [],
    fieldFlags: {}
  },
  variants: {
    backend: { label: '后端开发', overrides: { basic: { job: '后端开发工程师' }, selfIntro: '面试官您好，我是{{name}}，软件工程专业2026届本科生，求职方向为后端开发。我熟悉 Java 与 Spring Boot/MyBatis，理解 HTTP 协议与 REST 接口设计，熟悉 PostgreSQL/MySQL 并有调优实践；在示例软件科技实习期间参与工单系统后端开发与并发问题修复。希望能加入{{company}}，用扎实的后端能力支撑业务稳定增长。' } },
    frontend: { label: '前端开发', overrides: { basic: { job: '前端开发工程师' }, selfIntro: '面试官您好，我是{{name}}，软件工程专业2026届本科生，求职方向为前端开发。我掌握 HTML5/CSS3/JavaScript（ES6+）与 React，接触过 Vue 与工程化构建；在示例教育科技实习期间参与在线学习平台前端开发，完成核心页面与组件抽离。期待在{{company}}打磨高质量的前端产品。' } },
    management: { label: '管理/协调岗', overrides: { basic: { job: '项目管理/运营协调' }, selfIntro: '面试官您好，我是{{name}}，软件工程专业2026届本科生，求职方向为管理与协调类岗位。我先后参与两个校企合作项目，在跨职能团队中承担需求对接、进度协同与交付把关；在项目中负责拆解任务、跟进风险与验收，让交付节奏可控。我沟通顺畅、以结果为导向，期待在{{company}}把团队效能做成可度量的增长。' } }
  }
};

/* ================= 04 FIELD_DICT（字段语义字典；用户数据不在此） =================
   entry: key(点分 profile 路径) / label / aliases / pattern / en(name,id 英文)
          valueType: string|date|range|tags|longtext
          arrayKey+leaf: 重复组取 profile[arrayKey][k][leaf]
          sensitive: 默认不勾选 + 红色提醒                              */
function D(_key, _label, o) { return Object.assign({ key: _key, label: _label, aliases: [], en: [], pattern: null, valueType: 'string' }, o); }
const DICT = [
  /* —— 基本信息 —— */
  D('basic.name', '姓名', { aliases: ['名字', '考生姓名'], en: ['name', 'fullname', 'xingming'], pattern: '^姓名$', vtype: 'name' }),
  D('basic.phone', '手机号', { aliases: ['手机', '电话', '联系电话', '手机号码', '联系方式', '移动电话'], en: ['phone', 'mobile', 'tel', 'shouji'], pattern: '手机|电话', vtype: 'phone' }),
  D('basic.email', '电子邮箱', { aliases: ['邮箱', '电子邮件', 'E-mail', 'Email地址'], en: ['email', 'mail'], pattern: '邮箱|电子邮件|e-?mail', vtype: 'email' }),
  D('basic.gender', '性别', { aliases: ['男/女'], en: ['gender', 'sex'], valueType: 'option' }),
  D('basic.birthDate', '出生日期', { aliases: ['出生年月', '生日'], en: ['birth', 'birthday', 'born'], pattern: '出生|生日', valueType: 'date' }),
  D('basic.idCard', '身份证号', { aliases: ['身份证', '身份证号码', '证件号码'], en: ['idcard', 'idnumber'], pattern: '身份证|证件号', vtype: 'idcard', sensitive: true }),
  D('basic.politicalStatus', '政治面貌', { aliases: ['政治面目'], pattern: '政治面貌', valueType: 'option' }),
  D('basic.nation', '民族', { en: ['nation', 'ethnic'], valueType: 'option' }),
  D('basic.hometown', '籍贯', { aliases: ['家乡'], en: ['hometown', 'nativeplace'], pattern: '籍贯', region: true }),
  D('basic.hukou', '户口所在地', { aliases: ['户口', '户籍', '户口所在地'], en: ['hukou', 'huji'], pattern: '户口|户籍', region: true }),
  D('basic.address', '现居住地', { aliases: ['现居住地址', '居住地', '现住址', '通讯地址', '联系地址', '家庭住址', '家庭地址'], en: ['address'], pattern: '居住|住址|地址' }),
  D('basic.cityExpected', '期望工作城市', { aliases: ['期望城市', '意向城市', '工作城市', '期望工作地点', '意向工作地', '期望工作地点'], en: ['expectedcity', 'expectcity'], pattern: '期望.*城市|意向.*城市|工作城市|工作地点', region: true }),
  D('basic.salaryExpected', '期望月薪', { aliases: ['期望薪资', '期望待遇', '薪资期望', '期望薪酬', '期望年薪'], en: ['salary'], pattern: '期望.*薪|期望.*待遇|薪资期望', vtype: 'salary' }),
  D('basic.job', '期望岗位', { aliases: ['应聘岗位', '求职岗位', '应聘职位', '期望职位', '申请职位', '求职意向', '意向岗位'], en: ['applyposition', 'expectedposition', 'jobintension'], pattern: '期望.*(岗位|职位)|应聘(岗位|职位)|求职意向|意向(岗位|职位)' }),
  D('basic.github', 'GitHub 主页', { aliases: ['GitHub地址', 'GitHub链接', '个人主页'], en: ['github'] }),
  D('basic.qq', 'QQ号', { aliases: ['QQ号码', 'QQ'], en: ['qq'], pattern: '^qq' }),
  D('basic.wechat', '微信号', { aliases: ['微信', '微信号码'], en: ['wechat', 'weixin'], pattern: '微信' }),
  D('basic.englishLevel', '英语水平', { aliases: ['英语等级', '英语能力', '外语水平', '外语等级'], en: ['englishlevel'], pattern: '英语', vtype: 'level' }),
  D('basic.maritalStatus', '婚姻状况', { aliases: ['婚姻', '婚况', '婚姻情况', '婚姻状态'], pattern: '婚姻|婚况', valueType: 'option' }),
  D('basic.idType', '证件类型', { aliases: ['证件类别'], pattern: '^证件(类型|类别)$', valueType: 'option' }),
  D('basic.gaokaoSource', '生源所在地', { aliases: ['生源地', '生源地区', '高考生源地', '生源'], en: ['shengyuandi', 'originplace'], pattern: '生源', region: true }),
  D('basic.cityNow', '现居城市', { aliases: ['所在城市', '当前所在城市', '现所在城市', '目前所在城市', '居住城市'], en: ['currentcity', 'nowcity'], pattern: '现居|所在城市|居住城市', region: true }),
  D('basic.cityExpected2', '期望工作城市2', { aliases: ['第二期望城市', '期望城市2', '其他期望城市', '第二意向城市'], pattern: '期望.*城市|意向.*城市', region: true }),
  D('basic.graduationDate', '毕业日期', { aliases: ['预计毕业日期'], pattern: '^(预计)?毕业日期$', valueType: 'date' }),
  D('basic.availableFrom', '到岗时间', { aliases: ['可到岗时间', '到岗日期', '最早到岗时间', '可入职时间', '入职时间'], pattern: '到岗|入职时间', valueType: 'date' }),
  D('basic.jobNature', '工作性质', { aliases: ['就业类型', '用工性质', '工作类型', '就业性质', '用工类型'], pattern: '工作性质|工作类型|就业(类型|性质)|用工(性质|类型)', valueType: 'option' }),
  D('basic.isFreshGrad', '是否应届', { aliases: ['是否应届毕业生', '是否为应届毕业生', '应届毕业生'], pattern: '应届', valueType: 'option' }),
  D('basic.englishScore', '英语成绩', { aliases: ['英语分数', '四级成绩', '六级成绩', '英语四级成绩', '成绩分数', '外语成绩'], pattern: '英语(成绩|分数)|(四级|六级)成绩', vtype: 'number' }),
  D('basic.languageType', '外语语种', { aliases: ['语种'], en: ['language'], pattern: '语种', valueType: 'option', section: '外语' }),
  D('basic.isFirstLanguage', '是否第一外语', { aliases: ['第一外语'], pattern: '第一外语', valueType: 'option', section: '外语' }),
  D('basic.country', '国家/地区', { aliases: ['国家地区', '所在国家', '国籍'], en: ['country'], pattern: '国家', valueType: 'option' }),
  D('basic.hobby', '兴趣爱好', { aliases: ['爱好', '业余爱好'], pattern: '爱好' }),
  D('basic.speciality', '特长', { aliases: ['个人特长', '特长描述'], pattern: '特长' }),
  D('basic.stature', '身高', { en: ['stature', 'height'], pattern: '身高', vtype: 'number' }),
  D('basic.weight', '体重', { en: ['weight'], pattern: '体重', vtype: 'number' }),
  D('basic.hukouNature', '户口性质', { aliases: ['户籍性质', '户口类型', '户籍类型'], en: ['hukounature', 'hukoutype'], pattern: '户口(性质|类型)|户籍(性质|类型)', valueType: 'option' }),
  D('basic.homePlace', '家庭所在地', { aliases: ['家庭户籍地', '家庭所在地区'], en: ['homeplace', 'familyplace'], pattern: '家庭(所在|户籍)', region: true }),
  D('basic.regionNow', '现居地区', { aliases: ['省', '省份', '城市', '区县'], en: ['province', 'city', 'county'], path: 'basic.cityNow', region: true, section: '通讯', deepOnly: true }),
  D('basic.nameSpellAbb', '姓名拼音缩写', { aliases: ['拼音缩写', '姓名拼音'], en: ['namespell', 'pinyin', 'nameabbr'], pattern: '拼音', vtype: 'name' }),
  D('basic.isForeignStudent', '是否留学生', { aliases: ['留学生'], en: ['foreignstudent'], pattern: '留学生', valueType: 'option' }),
  D('basic.health', '健康状况', { aliases: ['身体状況', '身体状况', '健康情况'], pattern: '健康|身体状况', valueType: 'option' }),
  D('basic.emergencyContact.name', '紧急联系人', { aliases: ['紧急联系人姓名'], en: ['emergencycontact', 'emergencyname'], vtype: 'name', sensitive: true }),
  D('basic.emergencyContact.phone', '紧急联系电话', { aliases: ['紧急联系人电话', '紧急联系方式', '紧急联系人手机'], en: ['emergencyphone', 'emergencytel'], vtype: 'phone', sensitive: true }),
  /* —— 教育（重复组 education[]） —— */
  D('edu.school', '毕业院校', { aliases: ['学校', '院校', '毕业学校', '就读学校', '学校名称'], en: ['school', 'college', 'university'], pattern: '学校|院校', arrayKey: 'education', leaf: 'school' }),
  D('edu.schoolName', '院校中文名称', { aliases: ['中文院校名称', '学校中文名称', '毕业院校中文名称'], arrayKey: 'education', leaf: 'schoolName' }),
  D('edu.major', '专业', { aliases: ['专业名称', '所学专业'], en: ['major', 'speciality'], arrayKey: 'education', leaf: 'major' }),
  D('edu.degree', '学历', { aliases: ['最高学历', '学历层次'], en: ['degree', 'educationlevel'], pattern: '^学历$|最高学历', arrayKey: 'education', leaf: 'degree' }),
  D('edu.eduType', '学历形式', { aliases: ['学习形式', '培养方式', '就读形式', '就读方式', '录取形式'], arrayKey: 'education', leaf: 'eduType', valueType: 'option' }),
  D('edu.schoolProvince', '院校省份', { aliases: ['省份', '学校所在省份', '院校所在省份'], arrayKey: 'education', leaf: 'schoolProvince' }),
  D('edu.schoolType', '院校类型', { aliases: ['学校类型'], arrayKey: 'education', leaf: 'schoolType', valueType: 'option' }),
  D('edu.startDate', '入学时间', { aliases: ['入学年月', '入学日期', '入学年份'], en: ['startdate', 'enrolldate', 'entrancedate'], arrayKey: 'education', leaf: 'startDate', valueType: 'date' }),
  D('edu.degreeName', '学位', { aliases: ['学位名称', '授予学位', '所获学位'], arrayKey: 'education', leaf: 'degreeFull' }),
  D('edu.degreeNo', '学位证书编号', { aliases: ['学位证编号', '学位证书号'], arrayKey: 'education', leaf: 'degreeNo' }),
  D('edu.eduNo', '学历证书编号', { aliases: ['学历证编号', '学历证书号', '毕业证书编号'], arrayKey: 'education', leaf: 'diplomaNo' }),
  D('edu.endDate', '毕业时间', { aliases: ['毕业年月', '毕业日期', '毕业年份'], en: ['enddate', 'graduationdate', 'graduation'], arrayKey: 'education', leaf: 'endDate', valueType: 'date' }),
  D('edu.gradePointType', '绩点制', { aliases: ['绩点制度', '绩点类型'], arrayKey: 'education', leaf: 'gradePointType', valueType: 'option' }),
  D('edu.majorDirection', '专业方向', { aliases: ['专业方向名称'], arrayKey: 'education', leaf: 'majorDirection' }),
  D('edu.gpa', '学分绩点', { aliases: ['平均学分绩点', '绩点', 'GPA'], en: ['gpa'], arrayKey: 'education', leaf: 'gpa', vtype: 'number' }),
  D('edu.degreeType', '学位类型', { aliases: ['学位类别'], arrayKey: 'education', leaf: 'degreeType', valueType: 'option' }),
  D('edu.researchArea', '研究方向及课题', { aliases: ['研究方向', '研究课题'], arrayKey: 'education', leaf: 'researchArea' }),
  D('edu.range', '在校时间', { aliases: ['起止时间', '起止年月', '就读时间', '教育时间', '就读时间'], en: ['timerange', 'duration'], pattern: '在校时间|起止(时间|年月)|就读时间', arrayKey: 'education', leaf: 'range', valueType: 'range' }),
  /* —— 项目（重复组 projects[]） —— */
  D('proj.name', '项目名称', { aliases: ['项目名', '项目'], en: ['projectname', 'project'], arrayKey: 'projects', leaf: 'name' }),
  D('proj.role', '项目角色', { aliases: ['担任角色', '角色', '承担角色'], en: ['role'], arrayKey: 'projects', leaf: 'role' }),
  D('proj.range', '项目时间', { aliases: ['项目起止时间', '项目周期'], en: ['projecttime'], pattern: '项目.*(时间|周期)', arrayKey: 'projects', leaf: 'range', valueType: 'range' }),
  D('proj.description', '项目描述', { aliases: ['项目介绍', '项目简介', '项目内容'], en: ['projectdesc', 'description'], pattern: '项目(描述|介绍|简介|内容)', arrayKey: 'projects', leaf: 'description', valueType: 'longtext' }),
  D('proj.link', '项目链接', { aliases: ['项目地址', '代码地址', '仓库地址'], en: ['projecturl', 'repourl', 'projectlink'], arrayKey: 'projects', leaf: 'link' }),
  /* —— 实习（重复组 internships[]） —— */
  D('intern.company', '实习单位', { aliases: ['实习公司', '公司名称', '工作单位', '单位名称', '公司'], en: ['company', 'companyname'], arrayKey: 'internships', leaf: 'company', section: '实习' }),
  D('intern.position', '实习岗位', { aliases: ['实习职位', '担任职务', '实习岗位名称', '职位名称'], en: ['internposition', 'jobtitle'], pattern: '实习(岗位|职位)', arrayKey: 'internships', leaf: 'position', section: '实习' }),
  D('intern.startDate', '开始时间', { aliases: ['实习开始时间', '入职时间'], en: ['internstart', 'workstart'], arrayKey: 'internships', leaf: 'startDate', valueType: 'date', section: '实习', deepOnly: true }),
  D('intern.endDate', '结束时间', { aliases: ['实习结束时间', '离职时间'], en: ['internend', 'workend'], arrayKey: 'internships', leaf: 'endDate', valueType: 'date', section: '实习', deepOnly: true }),
  D('intern.range', '实习时间', { aliases: ['实习起止时间', '在职时间', '工作时间'], en: ['internshiptime'], pattern: '实习.*(时间|周期)|在职时间', arrayKey: 'internships', leaf: 'range', valueType: 'range' }),
  D('intern.description', '实习内容', { aliases: ['实习描述', '工作内容', '工作描述', '职责描述', '实习经历'], en: ['workdesc', 'internshipdesc'], pattern: '实习(内容|描述|经历)|工作(内容|描述)', arrayKey: 'internships', leaf: 'description', valueType: 'longtext' }),
  /* —— 家庭成员（重复组 family[]；section 限定：同名「姓名/工作单位/电话」优先家庭键） —— */
  D('family.relation', '与本人关系', { aliases: ['关系', '亲属关系', '与本人关系'], en: ['relation'], arrayKey: 'family', leaf: 'relation', valueType: 'option', section: '家庭' }),
  D('family.name', '家庭成员姓名', { aliases: ['姓名', '成员姓名'], en: ['membername'], arrayKey: 'family', leaf: 'name', vtype: 'name', section: '家庭' }),
  D('family.workplace', '家庭工作单位', { aliases: ['工作单位', '单位', '单位名称'], arrayKey: 'family', leaf: 'workplace', section: '家庭' }),
  D('family.duty', '家庭职位', { aliases: ['职位', '职务', '职位名称'], arrayKey: 'family', leaf: 'duty', section: '家庭' }),
  D('family.phone', '家庭电话', { aliases: ['电话', '联系电话', '手机号'], en: ['memberphone'], arrayKey: 'family', leaf: 'phone', vtype: 'phone', section: '家庭' }),
  /* —— 其他 —— */
  D('skills', '技能标签', { aliases: ['专业技能', '技能', '掌握技能', '技能特长', '技术栈'], en: ['skill', 'skills'], valueType: 'tags', arrayKey: 'skills' }),
  D('selfIntro', '自我介绍', { aliases: ['自我评价', '个人介绍', '个人评价', '个人简介'], en: ['selfintro', 'introduction', 'bio'], pattern: '自我(介绍|评价)|个人(简介|介绍|评价)', valueType: 'longtext' })
];
DICT.forEach(d => {
  if (d.pattern) d.pattern = new RegExp(d.pattern, 'i');
  d._norm = [d.label, ...d.aliases].filter(Boolean).map(normDictLabel);   // 匹配用归一化别名表（与 cleanLabel 同规则）
});
const ARRAY_LABEL = { education: '教育', projects: '项目', internships: '实习', skills: '技能' };

/* 用户自定义字段（profile.customFields: [{path,label,aliases?,sensitive?}]）→ 并入字典（幂等，导入后即时生效） */
function extendDict(profile) {
  for (let i = DICT.length - 1; i >= 0; i--) if (DICT[i]._custom) DICT.splice(i, 1);
  const extra = (profile.base && profile.base.customFields) || [];
  extra.forEach(cf => {
    if (!cf || !cf.path || !cf.label) return;
    const e = D(cf.path, cf.label, { aliases: cf.aliases || [], sensitive: !!cf.sensitive });
    e._custom = true;
    e._norm = [e.label, ...e.aliases].filter(Boolean).map(normDictLabel);
    DICT.push(e);
  });
}

/* ================= 04c REGION（省/市/区 拆分与级联：籍贯/户口/生源地/城市类字段） ================= */
const PROV_LIST = ['北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门'];
const PROV_RE = new RegExp('^(' + PROV_LIST.join('|') + ')(?:省|市|自治区|特别行政区|维吾尔自治区|壮族自治区|回族自治区)?');
const REGION_MAX_CLAIMS = 3;   // 同一区域字段最多被 省/市/区 三个控件认领
/** 剥行政区后缀用于选项匹配："江苏省"→"江苏" · "南京市"→"南京" · "玄武区"→"玄武" */
function stripRegionSuffix(s) {
  return String(s || '').replace(/\s+/g, '')
    .replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|省|市|盟|地区|县|旗|区)$/, '');
}
/** "江苏省南京市玄武区" → { p:'江苏省', c:'南京市', d:'玄武区' }；短写容错（"江苏南京"→ p+ d） */
function splitRegion(v) {
  const s = String(v || '').replace(/\s+/g, '');
  const out = { p: '', c: '', d: '' };
  if (!s) return out;
  let rest = s;
  const mp = rest.match(PROV_RE);
  if (mp) { out.p = mp[0]; rest = rest.slice(mp[0].length); }
  const mc = rest.match(/^[^省市区县旗]{0,8}?(?:市|自治州|盟|地区)/);
  if (mc) { out.c = mc[0]; rest = rest.slice(mc[0].length); }
  if (rest) out.d = rest;
  return out;
}
/** 按选项文本自检控件层级：多数命中省表→'p'；多数以 市/州 结尾→'c'；以 区/县/旗 结尾→'d'（样本 <3 不判） */
function detectLevel(opts) {
  const ts = (opts || []).map(o => {
    let t = ''; try { t = (o.textContent || o.value || '').trim(); } catch (e) {}
    return t.replace(/\s+/g, '');
  }).filter(t => t && !/^请(选择|选择省|选择市|选择区|选择县)/.test(t) && !/^[-—-]+$/.test(t));
  if (ts.length < 3) return null;
  const isP = t => { const m = t.match(PROV_RE); return !!(m && m[0] === t); };
  const np = ts.filter(isP).length;
  const nc = ts.filter(t => /(市|自治州|盟|地区)$/.test(t)).length;
  const nd = ts.filter(t => /(区|县|旗)$/.test(t)).length;
  if (np / ts.length >= 0.6) return 'p';
  if (nc / ts.length >= 0.6) return 'c';
  if (nd / ts.length >= 0.6) return 'd';
  return null;
}

/* ================= 04d VALIDATE（规则语义校验：第一道闸 · 离线瞬时零成本） =================
   拦「姓名←CET-4」式错配：值不符合字段类型 / 控件标签与字典强类型冲突 → semBad（默认不勾选，
   人工勾选 = 明确覆盖允许填充）。第二道（可选 LLM 复核）见 11b。 */
const VTYPES = {
  name:   v => /^[\u4e00-\u9fa5]{2,4}$/.test(v) || /^[A-Za-z][A-Za-z .'\-]{1,30}$/.test(v),
  phone:  v => /^1[3-9]\d{9}$/.test(v.replace(/[\s\-—]/g, '')),
  email:  v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  idcard: v => /^\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(v),
  level:  v => /CET|TOE|IELTS|TEM|雅思|托福|四级|六级|专[四八]级|普通话/i.test(v),
  number: v => /^\d{1,3}(\.\d{1,2})?$/.test(v),
  salary: v => /\d/.test(v)
};
const STRONG_VT = new Set(['name', 'phone', 'email', 'idcard', 'level', 'number']);
/** 从控件标签反推期望类型（先 分数/成绩 后 等级/水平，"英语成绩"→number 而非 level） */
const INFER_PAT = [
  [/姓名|名字/, 'name'],
  [/电话|手机|联系方式/, 'phone'],
  [/邮箱|电子邮件|e-?mail/i, 'email'],
  [/身份证|证件号码?/, 'idcard'],
  [/分数|成绩|得分|绩点(?!制)/, 'number'],
  [/英语|等级|水平|雅思|托福|普通话/, 'level']
];
function inferVtype(label) {
  const L = String(label || '');
  if (!L) return null;
  for (const [re, vt] of INFER_PAT) if (re.test(L)) return vt;
  return null;
}

/* ================= 04b PLATFORM ADAPTERS（平台适配层：通用引擎兜底，平台特征只做加减法） =================
   真实页面用「Debug 悬停模式」测绘后，把结论补进 docs/platforms.md，再在对应条目加 hooks。
   deep=true + sections()/want() 的分区式站点：扫描按钮走「全程扫描」，执行填充逐区补卡/填充/保存。 */
const ADAPTERS = [
  { id: 'beisen', match: /beisen\.com|ituiz\.com/i, note: '北森：表单常在客户官网 iframe 内（走桥接）· 表格布局标签 · 级联城市搜索式' },
  { id: 'moka', match: /mokahr\.com/i, note: 'Moka：React 全受控 + 自绘下拉 portal 浮层 · 分步表单' },
  { id: 'dayee', match: /dayee\.com/i, note: '大易：服务端渲染 + jQuery 传统控件 · 自我评价可能为 contenteditable' },
  {
    id: 'cnpc', match: /(^|\.)zhaopin\.cnpc\.com\.cn$/i, deep: true,
    note: '中石油：z1~z9 分区式简历（每区独立编辑/保存）· 教育卡专业 jQuery autocompleter · 按档案自动补卡',
    sections() {
      const out = [];
      document.querySelectorAll('div[id]').forEach(z => {
        if (!/^z\d+$/.test(z.id)) return;
        const root = z.nextElementSibling;
        if (!root || !root.querySelector) return;
        const name = cleanLabel((z.querySelector('span') || z).textContent);
        if (!name) return;
        out.push({ key: z.id, name, navEl: z, root });
      });
      return out;
    },
    want(name, P) {
      const b = P.basic || {};
      if (/^基本信息/.test(name)) return 0;                        // 常规为查看态，不自动改动
      if (/教育/.test(name)) return (P.education || []).length;
      if (/外语/.test(name)) return (b.englishLevel || b.englishScore) ? 1 : 0;
      if (/通讯/.test(name)) return 1;
      if (/实习|工作|入伍/.test(name)) return (P.internships || []).length;
      if (/获奖/.test(name)) return (P.awards || []).length;
      if (/家庭/.test(name)) return (P.family || []).length;
      return 0;                                                    // 其它资格 / 附件 / 未知：不自动
    }
  },
  { id: 'zhaopin', match: /(^|\.)zhaopin\.(com|cn)$/i, note: '智联校园：在线简历多 step，依赖 MutationObserver 复扫' },
  { id: '51job', match: /51job\.com/i, note: '前程无忧：table 布局 + 大 textarea 开放题' },
];
function activeAdapter() { return ADAPTERS.find(a => a.match.test(location.host)) || null; }

/* ================= 05 SCANNER（控件枚举） ================= */
/* 联想搜索输入（jQuery autocompleter 类）：keydown 初始化插件 · keyup 向后端查询 · 必须点选下拉项才写隐藏 id。
   仅作「候选标记」——真正的 autocomplete 路径只在命中字典（有值可填）时启用，站点通用搜索框不受影响（见 buildRows）。 */
function isAutoCompleteEl(el) {
  try {
    const hint = (el.getAttribute('onkeydown') || '') + ' ' + (el.getAttribute('onkeyup') || '') + ' ' + (el.getAttribute('oninput') || '');
    if (/search|suggest|autocomplete/i.test(hint)) return true;
    const cls = String(el.className || '');
    return /search/i.test(cls) && !!(el.closest && el.closest('[class*="autocomplet"],[class*="search"],[id*="search"],[id*="Search"]'));
  } catch (e) { return false; }
}
function scanControls(rootEl) {
  const scope = rootEl && rootEl.querySelectorAll ? rootEl : document;
  const els = [...scope.querySelectorAll('input,textarea,select')];
  const out = [];
  for (const el of els) {
    if (el.closest('#af-host')) continue;                    // 自家 UI（双保险）
    const t = (el.type || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(t)) continue;
    if (el.disabled) continue;
    if (!isVisible(el)) continue;

    let kind = 'text';
    if (el.tagName === 'SELECT') kind = 'select';
    else if (el.tagName === 'TEXTAREA') kind = 'textarea';
    else if (t === 'radio') kind = 'radio';
    else if (t === 'checkbox') kind = 'checkbox';
    else if (t === 'date' || t === 'month') kind = 'date';
    else if (t === 'file') kind = 'file';
    else if (el.isContentEditable) kind = 'ce';
    else if (isAutoCompleteEl(el)) kind = 'autocomplete';

    out.push({ el, kind, type: t, name: el.name || '', id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '', required: el.required || hasReqMark(''),
      domIdx: out.length });
  }
  /* 自绘下拉/级联（antd / element 等组件库）：样式壳 + portal 浮层，input 常为 readonly/隐藏
     ——升级为 kind='widget'：el 保留 input（标签引用它），host 记样式壳（点击/浮层都以 host 为准） */
  const WIDGET_SEL = '.ant-select,.el-select,.el-cascader,[role="combobox"],[class*="multiselect"]';
  const hosts = [...scope.querySelectorAll(WIDGET_SEL)].filter(h =>
    !h.closest('#af-host') && isVisible(h) && !(h.parentElement && h.parentElement.closest(WIDGET_SEL)));
  for (const h of hosts) {
    if (h.querySelector('select')) continue;                 // 内嵌原生 select → 走原生填充路径
    const inp = h.querySelector('input');
    const existing = inp ? out.find(c => c.el === inp) : null;
    if (existing) { existing.kind = 'widget'; existing.host = h; }
    else out.push({ el: h, kind: 'widget', host: h, type: 'widget', name: h.getAttribute('name') || '', id: h.id || '',
      placeholder: cleanLabel(h.textContent).slice(0, 12) || '', required: hasReqMark(h.textContent),
      domIdx: out.length });
  }
  return out;
}

/* ================= 06 LABELER（标签提取：来源加权，取最高权重首个命中） ================= */
function labelFor(c) {
  const el = c.el;
  /* 1.0 label[for] / 包裹式 label */
  if (c.id) {
    try {
      const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(c.id) : c.id) + '"]');
      if (l) return { t: cleanLabel(l.textContent), w: 1.0, s: 'label[for]' };
    } catch (e) {}
  }
  const wrap = el.closest('label');
  if (wrap) { const t = cleanLabel(ownText(wrap, el)); if (t) return { t, w: 1.0, s: 'label>' }; }
  /* 0.95 aria-label / title */
  const aria = el.getAttribute('aria-label') || el.title;
  if (aria) return { t: cleanLabel(aria), w: 0.95, s: 'aria' };
  /* 0.9 fieldset legend（radio/checkbox 组） */
  const fs = el.closest('fieldset');
  if (fs) { const lg = fs.querySelector('legend'); if (lg) { const t = cleanLabel(lg.textContent); if (t) return { t, w: 0.9, s: 'legend' }; } }
  /* 0.8 表格：优先列头（避免相邻单元格填值后污染标签），无表头再取同行前 td 文本 */
  const cell = el.closest('td,th');
  if (cell) {
    const table = cell.closest('table');
    if (table && cell.cellIndex > -1 && table.rows.length) {
      const th = table.rows[0].cells[cell.cellIndex];
      if (th && th !== cell && !th.querySelector('input,select,textarea')) {
        const t2 = cleanLabel(th.textContent);
        if (t2) return { t: t2, w: 0.8, s: 'colhead' };
      }
    }
    const parts = [];
    let sib = cell.previousElementSibling;
    while (sib) {
      if (!sib.querySelector('input,select,textarea')) parts.unshift(sib.textContent);
      sib = sib.previousElementSibling;
    }
    const t = cleanLabel(parts.join(' '));
    if (t) return { t, w: 0.8, s: 'tr' };
  }
  /* 0.8 前置兄弟 */
  let ps = el.previousElementSibling, hops = 0;
  while (ps && hops < 2) {
    const t = cleanLabel(ps.textContent);
    if (t && t.length <= 12) return { t, w: 0.8, s: 'prev' };
    ps = ps.previousElementSibling; hops++;
  }
  /* 0.78 祖先兄弟：控件被包在 <div>（select/input 外再包一层）里时，标签 span 常挂在包裹层左侧。
     只认以冒号结尾的短文本，且容器内出现第二个控件即停止爬升 —— 防串到相邻字段的标签。
     若最近标签是「省份/城市/区县」等级词，再往左拼父级字段名（户口所在地：省份：→户口所在地省份） */
  {
    const LVL = /^(省份|省|城市|市|区县|区|县|地区|盟|州|街道)$/;
    let anc = el.parentElement, depth = 0;
    while (anc && depth < 3) {
      if (anc.id === 'af-host') break;
      const sib = anc.previousElementSibling;
      if (sib && !sib.querySelector('input,select,textarea')) {
        const raw = String(sib.textContent || '');
        if (/[：:]$/.test(raw.replace(/[\s\u3000]+/g, ''))) {
          const t = cleanLabel(raw);
          if (t && t.length <= 12) {
            if (LVL.test(t)) {
              let p2 = sib.previousElementSibling, hop2 = 0;
              while (p2 && hop2 < 3) {
                if (!p2.querySelector('input,select,textarea')) {
                  const raw2 = String(p2.textContent || '');
                  if (/[：:]$/.test(raw2.replace(/[\s\u3000]+/g, ''))) {
                    const t2 = cleanLabel(raw2);
                    if (t2 && t2.length <= 12 && !LVL.test(t2)) return { t: t2 + t, w: 0.78, s: 'prev-anc-lvl' };
                  }
                }
                p2 = p2.previousElementSibling; hop2++;
              }
            }
            return { t, w: 0.78, s: 'prev-anc' };
          }
        }
      }
      if (anc.querySelectorAll('input:not([type="hidden"]),select,textarea').length > 1) break;
      anc = anc.parentElement; depth++;
    }
  }
  /* 0.75 表单项容器内标签（长度上限 20：容器整段文本不是字段名） */
  const box = el.closest('.ant-form-item,.el-form-item,.form-item,.form-group,.form-field,.field,[class*="form-item"],[class*="form-group"],[class*="field-item"]');
  if (box) {
    const lbl = box.querySelector('label,[class*="label"],[class*="title"]');
    if (lbl && !lbl.contains(el)) { const t = cleanLabel(ownText(lbl, el)); if (t && t.length <= 20) return { t, w: 0.75, s: 'container' }; }
  }
  /* 0.5 placeholder */
  if (c.placeholder) return { t: cleanLabel(c.placeholder), w: 0.5, s: 'placeholder' };
  /* 0.6 纯英文属性（无中文文本时交给 Matcher 用 name/id 词） */
  return { t: '', w: 0.6, s: 'name/id' };
}

/** radio/checkbox 组标签：列头 > 图例 > 表单容器 > 前置兄弟（跳过选项自身的包裹 label，避免拿到"是/否"当组名） */
function groupLabelOf(el) {
  const cell = el.closest('td,th');
  if (cell) {
    const table = cell.closest('table');
    if (table && cell.cellIndex > -1 && table.rows.length) {
      const th = table.rows[0].cells[cell.cellIndex];
      if (th && th !== cell && !th.querySelector('input,select,textarea')) {
        const t = cleanLabel(th.textContent); if (t) return t;
      }
    }
  }
  const fs = el.closest('fieldset');
  if (fs) { const lg = fs.querySelector('legend'); if (lg) { const t = cleanLabel(lg.textContent); if (t) return t; } }
  const box = el.closest('.ant-form-item,.el-form-item,.form-item,.form-group,.form-field,.field,[class*="form-item"],[class*="form-group"],[class*="field-item"]');
  if (box) {
    const lbl = box.querySelector('label,[class*="label"],[class*="title"]');
    if (lbl && !lbl.contains(el)) { const t = cleanLabel(ownText(lbl, el)); if (t && t.length <= 20) return t; }
  }
  const anchor = el.closest('label') || el;
  let ps = anchor.previousElementSibling, hops = 0;
  while (ps && hops < 3) {
    if (!(ps.querySelector && ps.querySelector('input'))) {
      const t = cleanLabel(ps.textContent);
      if (t && t.length <= 16) return t;
    }
    ps = ps.previousElementSibling; hops++;
  }
  return '';
}

/* ================= 07 MATCHER（字典匹配 + 置信度） ================= */
function candidatesFor(c, secName) {
  const out = [];
  const L = c.labelText;
  const tk = tokens(c.name + ' ' + c.id + ' ' + (isAscii(L) ? L : '') + ' ' + (isAscii(c.placeholder) ? c.placeholder : ''));
  for (const d of DICT) {
    /* 分区限定（深扫）：带 section 的词典项只在对应分区竞争；命中分区的项加权，避免「姓名/电话/工作单位」跨分区串键。
       deepOnly 的项只在分区扫描里启用（如 CNPC 通讯信息的 省/城市/区县标签过泛，不进通用扫描） */
    if (d.deepOnly && !secName) continue;
    const secHit = !!(d.section && secName && String(secName).indexOf(d.section) >= 0);
    if (d.section && secName && !secHit) continue;
    let level = 0;
    if (L) {
      const norm = d._norm || [d.label, ...d.aliases].filter(Boolean).map(normDictLabel);
      if (norm.some(a => L === a)) level = 1.0;
      else if (d.pattern && d.pattern.test(L)) level = 0.9;
      else {
        for (const a of norm) {
          if (a.length >= 2 && (L.includes(a) || a.includes(L) && L.length >= 2)) { level = 0.7; break; }
        }
      }
      if (!level && isAscii(L) && d.en.some(w => tk.includes(w))) level = 0.6;
    }
    if (!level && d.en.length && d.en.some(w => tk.includes(w))) level = 0.6;
    if (!level && L && [...L].length >= 4) {
      for (const a of [d.label, ...d.aliases]) if (lev1(L, a)) { level = 0.4; break; }
    }
    if (level) out.push({ d, level, score: level * c.labelWeight * (secHit ? 1.15 : 1) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 4);
}

/* ================= 08 ROWS（扫描 → 匹配 → 仲裁 → 重复组编号 → 行数据） ================= */
let ROWS = [];
let scannedOnce = false;
let LAST_ASSIGN = new Map();   // el → {d, k, score}：扫描时的字典占用（自动学习用它定位数组第 k 段）

function buildRows(variantKey, rootEl, arrOffset, secName) {
  const profile = Store.getProfile();
  extendDict(profile);
  const P = mergedProfile(profile, variantKey);
  arrOffset = arrOffset || 0;

  const controls = scanControls(rootEl);
  controls.forEach(c => { const lb = labelFor(c); c.labelText = lb.t; c.labelWeight = lb.w; c.labelSource = lb.s; });
  /* radio/checkbox 同名组只让首个成员参与字典占用；单独勾选框（协议/承诺类，永远人工）不占字典、不消耗数组段 */
  const seenGroupKeys = new Set(), cbNameCount = {};
  for (const c of controls) {
    if (c.kind === 'radio' || c.kind === 'checkbox') {
      const k = c.kind + '|' + (c.name || '#' + c.domIdx);
      if (seenGroupKeys.has(k)) c.groupMemberOnly = true;
      else seenGroupKeys.add(k);
      if (c.kind === 'checkbox') cbNameCount[k] = (cbNameCount[k] || 0) + 1;
    }
  }
  for (const c of controls) {
    if (c.kind === 'checkbox' && (cbNameCount['checkbox|' + (c.name || '#' + c.domIdx)] || 0) < 2) c.singleCheckbox = true;
  }
  controls.forEach(c => { c.cands = candidatesFor(c, secName); });

  /* 贪心仲裁：按最高分降序占用字典项；数组键按 DOM 顺序取第 k 项（绝不复用第 0 项）。
     区域键（region）允许最多 3 个控件认领（省/市/区各一），但先让位给其他未占用字典项 */
  const usedScalar = new Set();
  const usedArr = {};
  const usedRegion = {};
  const sorted = [...controls].sort((a, b) => (b.cands[0] ? b.cands[0].score : 0) - (a.cands[0] ? a.cands[0].score : 0));
  const assign = new Map();          // control → {d, k, score}
  for (const c of sorted) {
    if (c.groupMemberOnly || c.singleCheckbox) continue;
    let fb = null;                                   // 同 key 区域已被认领 → 兜底认领下一级
    for (const cand of c.cands) {
      const d = cand.d;
      if (d.region) {
        const n = usedRegion[d.key] || 0;
        if (n === 0) { usedRegion[d.key] = 1; assign.set(c, { d, k: 0, score: cand.score }); break; }
        if (n < REGION_MAX_CLAIMS && !fb) fb = cand;
        continue;
      }
      if (d.arrayKey) {
        if (d.valueType !== 'tags') {                 // 普通重复组：逐个占第 k 项
          const k = usedArr[d.arrayKey + '.' + d.leaf] || 0;
          usedArr[d.arrayKey + '.' + d.leaf] = k + 1;
          assign.set(c, { d, k, score: cand.score });
          break;
        } else {                                      // tags 组（checkbox 多选）：唯一
          if (usedArr[d.arrayKey]) continue;
          usedArr[d.arrayKey] = 1;
          assign.set(c, { d, k: 0, score: cand.score });
          break;
        }
      } else {
        if (usedScalar.has(d.key)) continue;
        usedScalar.add(d.key);
        assign.set(c, { d, k: 0, score: cand.score });
        break;
      }
    }
    if (!assign.has(c) && fb) {                       // 没有更合适的字典项 → 认领同 key 区域的第 k 级
      const n = usedRegion[fb.d.key] || 0;
      if (n < REGION_MAX_CLAIMS) { usedRegion[fb.d.key] = n + 1; assign.set(c, { d: fb.d, k: n, score: fb.score }); }
    }
  }
  /* 命中字典的联想搜索输入 → autocomplete 路径（keyup 出候选 → 点选 → 站点插件写隐藏 id）。
     未命中字典的搜索框保持 text/manual，站点通用搜索不会被误升级 */
  for (const [c] of assign) {
    if (c.kind === 'text' && isAutoCompleteEl(c.el)) c.kind = 'autocomplete';
  }

  /* 重复组/区域多认领按 DOM 顺序重排（块状卡片也正确）：贪心按分数处理可能乱序，这里以 DOM 次序为准 */
  const byEntry = new Map();
  for (const [c, a] of assign) {
    if (!a.d) continue;
    let key = null;
    if (a.d.arrayKey && a.d.valueType !== 'tags') key = a.d.arrayKey + '.' + a.d.leaf;
    else if (a.d.region) key = 'region:' + a.d.key;
    if (!key) continue;
    if (!byEntry.has(key)) byEntry.set(key, []);
    byEntry.get(key).push(c);
  }
  for (const list of byEntry.values()) {
    list.sort((x, y) => x.domIdx - y.domIdx).forEach((c, i) => { assign.get(c).k = i; });
  }
  /* 区域字段认领数：>1 时文本框按 k 级拆分填省/市/区 */
  const regionCount = {};
  for (const [c, a] of assign) if (a.d && a.d.region) regionCount[a.d.key] = (regionCount[a.d.key] || 0) + 1;

  /* 单 radio/checkbox 归组 */
  const groups = groupRadiosChecks(controls, assign);

  const rows = [];
  const prevChecked = new Map();
  if (!arrOffset) ROWS.forEach(r => { if (r.el) prevChecked.set(r.el, r.checked); });   // 深扫逐卡：同一控件跨段复用，勾选态不跨段继承

  /* 已匹配控件 → 行 */
  const takenEls = new Set();
  for (const [c, a] of assign) {
    if (c.kind === 'radio' || c.kind === 'checkbox') continue;   // 组行单独生成
    if (groups.has(c.el)) continue;
    takenEls.add(c.el);
    rows.push(makeRow(c, a, P, prevChecked.get(c.el), regionCount, arrOffset));
  }
  /* radio / checkbox 组行 */
  for (const g of groups.values()) {
    if (g.kind === 'manual') {
      rows.push({ el: g.el, kind: g.kind, label: g.label, conf: 'low', value: g.value,
        note: g.note, checked: false, manual: true, group: g.items, domIdx: g.items[0].domIdx });
      continue;
    }
    if (!g.a) {                                   // 未命中字典的组 → 先查本站问答记忆
      const qa = qaLookup(g.label);
      if (qa != null) {
        rows.push({ el: g.el, kind: g.kind, label: g.label, conf: 'mid', value: qa,
          note: '本站记忆 · 岗位特有 · 不写入 Profile', checked: true, group: g.items, _qa: true,
          domIdx: g.domIdx });
        continue;
      }
    }
    rows.push(makeGroupRow(g, P, prevChecked.get(g.el), arrOffset));
  }
  /* file → 人工上传 */
  for (const c of controls) {
    if (c.kind !== 'file') continue;
    rows.push({ el: c.el, kind: 'file', label: c.labelText || '附件上传', conf: 'low',
      value: '需人工上传', note: '脚本永不自动上传文件', checked: false, manual: true, domIdx: c.domIdx });
  }
  /* 未匹配 → 先查本站问答记忆，再落低置信行（定位交人工） */
  for (const c of controls) {
    if (c.kind === 'file' || assign.has(c) || groups.has(c.el) || groupMember(c, groups)) continue;
    const qa = (c.kind !== 'checkbox' && c.labelText) ? qaLookup(c.labelText) : null;
    if (qa != null) {
      rows.push({ el: c.el, kind: c.kind, label: c.labelText, conf: 'mid', value: qa,
        note: '本站记忆 · 岗位特有 · 不写入 Profile', checked: true, _qa: true, domIdx: c.domIdx });
      continue;
    }
    rows.push({ el: c.el, kind: c.kind,
      label: (c.labelText ? (c.labelText.length <= 20 ? c.labelText : c.labelText.slice(0, 20) + '…') : '未识别控件'),
      conf: 'low', value: '—', note: c.labelSource === 'none' ? '未找到标签' : '未命中字典 · 需人工', checked: false, manual: true, domIdx: c.domIdx });
  }

  rows.forEach((r, i) => { r.id = i; });
  rows.sort((x, y) => ({ high: 0, mid: 1, sen: 2, low: 3 }[x.conf] - ({ high: 0, mid: 1, sen: 2, low: 3 }[y.conf])) || (x.domIdx - y.domIdx));
  LAST_ASSIGN = assign;
  return rows;
}

function groupMember(c, groups) {
  for (const g of groups.values()) if (g.items.includes(c)) return true;
  return false;
}

/** radio 按 name 分组 → 一行；checkbox：同名≥2 → tags 组行，单个 → 永不自动（manual） */
function groupRadiosChecks(controls, assign) {
  const groups = new Map();   // el(first) → group
  const byName = {};
  for (const c of controls) {
    if (c.kind !== 'radio' && c.kind !== 'checkbox') continue;
    const k = c.kind + '|' + (c.name || '‹anon' + controls.indexOf(c) + '›');
    (byName[k] = byName[k] || []).push(c);
  }
  for (const k in byName) {
    const items = byName[k];
    const kind = items[0].kind;
    if (kind === 'radio') {
      const a = assign.get(items[0]);
      groups.set(items[0].el, { kind: 'radio', el: items[0].el, items,
        label: a ? a.d.label : (groupLabelOf(items[0].el) || groupLabelViaLca(items) || items[0].labelText || '单选组'), a,
        domIdx: items[0].domIdx });
    } else if (items.length >= 2) {
      const a = assign.get(items[0]);
      groups.set(items[0].el, { kind: 'tags', el: items[0].el, items,
        label: a ? a.d.label : (groupLabelOf(items[0].el) || groupLabelViaLca(items) || items[0].labelText || '多选组'), a,
        domIdx: items[0].domIdx });
    } else {
      const c = items[0];
      groups.set(c.el, { kind: 'manual', items: [c], el: c.el,
        label: groupLabelOf(c.el) || c.labelText || '勾选项',
        value: '人工勾选', note: '协议/承诺类单独勾选框 · 永不自动勾选', domIdx: c.domIdx });
    }
  }
  return groups;
}

function optionLabel(el) {     // radio/checkbox 的选项文字
  const wrap = el.closest('label');
  if (wrap) { const t = cleanLabel(ownText(wrap, el)); if (t) return t; }
  let n = el.nextElementSibling;
  for (let i = 0; n && i < 2; i++) {
    const t = cleanLabel(n.textContent);
    if (t && t.length <= 12) return t;
    n = n.nextElementSibling;
  }
  return cleanLabel(el.value) || el.value;
}
/** 组标签兜底：取所有成员的最近公共祖先 → 跳过选项承载元素后的剩余文字就是题干
    （「是/否 是否愿意服从岗位调剂」→「是否愿意服从岗位调剂」；技能网格则落在前置兄弟 label） */
function groupLabelViaLca(items) {
  if (!items || !items.length) return '';
  let anc = items[0].el.parentElement;
  const rest = items.slice(1);
  while (anc && !rest.every(c => anc.contains(c.el))) anc = anc.parentElement;
  if (!anc || anc === document.body) return '';
  const optEls = items.map(c => c.el.closest('label') || c.el).filter(Boolean);
  const t = cleanLabel(textExcluding(anc, optEls));
  if (t.length >= 2) return t;
  let ps = anc.previousElementSibling;
  while (ps) {
    const t2 = cleanLabel(ps.textContent);
    if (t2 && t2.length >= 2 && t2.length <= 16 && !(ps.querySelector && ps.querySelector('input'))) return t2;
    ps = ps.previousElementSibling;
  }
  return '';
}

function makeRow(c, a, P, prevChecked, regionCount, arrOffset) {
  const d = a.d;
  const k = (a.k || 0) + (arrOffset || 0);   // 深扫逐卡：整卡扫描后把段号平移
  const conf = d.sensitive ? 'sen' : (a.score >= TH_HIGH ? 'high' : a.score >= TH_MID ? 'mid' : 'low');
  let value = '', note = '', missing = false;

  if (d.arrayKey) {
    const arr = P[d.arrayKey] || [];
    const item = arr[k];
    if (item == null) {
      missing = true;
      note = 'Profile ' + (ARRAY_LABEL[d.arrayKey] || '') + '仅 ' + arr.length + ' 段 · 第' + (CIRC[k] || k + 1) + '段缺失 · 不复用前段';
      value = '';
    } else {
      value = item[d.leaf];
    }
  } else {
    value = pathGet(P, d.path || d.key);
  }
  if (value == null) value = '';
  if (!missing && value === '') note = 'Profile 未填写';
  const _tpl = typeof value === 'string' && value.indexOf('{{') >= 0;
  if (_tpl) value = fillTpl(value, P);

  /* 区域字段：省/市/区拆分。select 填充时按实际选项定级；文本框多认领按 DOM 序发第 k 级；单认领文本框填全文 */
  let regionParts = null;
  if (d.region && !missing && value && !_tpl) {
    regionParts = splitRegion(value);
    if (c.kind === 'select' || c.kind === 'widget') {
      const lv = c.kind === 'select' ? detectLevel([...c.el.options]) : null;
      if (lv) {
        if (regionParts[lv]) value = regionParts[lv];
        else { missing = true; note = 'Profile 无' + ({ p: '省级', c: '市级', d: '区县级' }[lv]) + ' · 需人工补'; value = ''; }
      }
    } else if ((regionCount && regionCount[d.key] || 1) > 1) {
      const part = regionParts[['p', 'c', 'd'][k] || 'p'];
      if (part) value = part;
      else { missing = true; note = 'Profile 无该级行政区 · 需人工补'; value = ''; }
    }
  }

  /* 日期 / 起止时间格式适配 */
  if (!missing && value && d.valueType === 'date') { const r = fmtDate(value, c); value = r.v; if (r.warn) note = note ? note + ' · ' + r.warn : r.warn; }
  if (!missing && value && d.valueType === 'range') value = fmtRange(value, c);

  const label = d.arrayKey ? (ARRAY_LABEL[d.arrayKey] || '') + (CIRC[k] || k + 1) + '·' + d.label : d.label;
  const checked = !missing && value !== '' && conf !== 'sen' && conf !== 'low' && (prevChecked !== undefined ? !!prevChecked : (conf === 'high' || conf === 'mid'));
  const row = { el: c.el, host: c.host || null, kind: c.kind, dictKey: d.key, arrayKey: d.arrayKey || null, arrIdx: k, _d: d, _tpl,
    ctlLabel: c.labelText || '', regionParts,
    label, conf, value: value == null ? '' : String(value), note, checked, sensitive: !!d.sensitive,
    domIdx: c.domIdx };

  /* 规则语义闸（第一道）：值不符字段类型 / 控件标签与字典强类型冲突 → semBad 拦下 */
  if (!missing && !_tpl && row.value) {
    const vt = d.vtype, iv = inferVtype(row.ctlLabel);
    let bad = '';
    if (/配偶|父亲|母亲|监护人|紧急联系|家庭成员|亲属|子女/.test(String(row.ctlLabel || '')) && /^(basic\.name|basic\.phone|basic\.email|basic\.idCard)$/.test(d.key)) bad = '关系人字段勿填本人信息';
    else if (vt && VTYPES[vt] && !VTYPES[vt](row.value)) bad = '值不符「' + d.label + '」的格式';
    else if (vt && iv && STRONG_VT.has(vt) && STRONG_VT.has(iv) && vt !== iv) bad = '标签"' + row.ctlLabel + '"与「' + d.label + '」不符';
    else if (!vt && iv && STRONG_VT.has(iv) && !VTYPES[iv](row.value)) bad = '标签"' + row.ctlLabel + '"要求' + ({ name: '人名', phone: '手机号', email: '邮箱', idcard: '证件号', level: '语言等级', number: '分数' }[iv]) + '，值不符';
    if (bad) { row.semBad = true; row.checked = false; row.note = (row.note ? row.note + ' · ' : '') + bad; }
  }
  return row;
}

function makeGroupRow(g, P, prevChecked, arrOffset) {
  const a = g.a;
  if (!a) {
    return { el: g.el, kind: g.kind, label: g.label, conf: 'low', value: '—', note: '未命中字典 · 需人工', checked: false, manual: true, group: g.items, domIdx: g.domIdx };
  }
  const d = a.d;
  const k = (a.k || 0) + (arrOffset || 0);
  const conf = a.score >= TH_HIGH ? 'high' : a.score >= TH_MID ? 'mid' : 'low';
  let values = [];
  if (d.valueType === 'tags' && d.arrayKey) values = P[d.arrayKey] || [];
  else if (d.arrayKey) {                                   // 数组键的单选组（如 院校类型/学位类型 每卡一段）
    const arr = P[d.arrayKey] || [];
    const it = arr[k];
    if (it && it[d.leaf] != null) values = [it[d.leaf]];
  } else if (d.key) { const v = pathGet(P, d.path || d.key); if (v != null) values = [v]; }
  values = values.filter(v => v != null && String(v).trim() !== '').map(String);
  const _tpl = values.some(v => v.indexOf('{{') >= 0);
  if (_tpl) values = values.map(v => fillTpl(v, P));
  const checked = values.length > 0 && conf !== 'low' && (prevChecked !== undefined ? !!prevChecked : conf === 'high');
  return { el: g.el, kind: g.kind, dictKey: d.key, arrayKey: d.arrayKey || null, arrIdx: 0, _d: d, _tpl,
    label: d.label, conf, values, value: values.join(' / '), checked, group: g.items, domIdx: g.domIdx };
}

/* ---- 模板占位符：{{name}}/{{company}}/{{position}}（上下文在开放题 Tab 顶部输入，存 settings.ctx） ---- */
function fillTpl(v, P, ctxOver) {
  if (!v || String(v).indexOf('{{') < 0) return v;
  const s = Store.settings();
  const ctx = s.ctx = s.ctx || {};
  return String(v)
    .replace(/\{\{\s*name\s*\}\}/g, (P.basic && P.basic.name) || '')
    .replace(/\{\{\s*company\s*\}\}/g, (ctxOver && ctxOver.company) || ctx.company || '贵公司')
    .replace(/\{\{\s*position\s*\}\}/g, (ctxOver && ctxOver.position) || ctx.position || (P.basic && P.basic.job) || '该岗位');
}

/* ---- 日期 / 起止时间格式 ---- */
function dateHint(c) {
  const ph = c.placeholder || '';
  const m = ph.match(/\d{4}\s*([./\-年])\s*\d{1,2}/);
  if (m) { if (m[1] === '/') return 'slash'; if (m[1] === '.') return 'dot'; if (m[1] === '年') return 'cn'; return 'dash'; }
  if (/年/.test(ph)) return 'cn';
  const ml = parseInt(c.el.getAttribute('maxlength') || '', 10);
  if (ml === 8) return 'plain';
  if (ml === 7) return 'dash';
  return 'dash';
}
function fmtDate(v, c) {   // 'YYYY-MM' → 控件要的格式
  const m = String(v).match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return { v: String(v) };
  const [, y, mo] = m;
  if (c.kind === 'date') {
    if (c.type === 'month') return { v: y + '-' + mo };
    return { v: y + '-' + mo + '-01', warn: 'date 型按 1 号补全 · 请核对' };
  }
  switch (dateHint(c)) {
    case 'slash': return { v: y + '/' + mo };
    case 'dot': return { v: y + '.' + mo };
    case 'cn': return { v: y + '年' + mo + '月' };
    case 'plain': return { v: y + (mo.length === 1 ? '0' + mo : mo) };
    default: return { v: y + '-' + mo };
  }
}
function fmtRange(v, c) {  // 'YYYY.MM-YYYY.MM' → 控件要的分隔符
  const m = String(v).match(/^(\d{4})[.\-/](\d{1,2})\s*[~—\-–]+\s*(\d{4})[.\-/](\d{1,2})$/);
  if (!m) return String(v);
  const [, y1, m1, y2, m2] = m;
  const h = dateHint(c);
  const j = x => h === 'slash' ? x[0] + '/' + x[1] : h === 'dot' ? x[0] + '.' + x[1] : h === 'cn' ? x[0] + '年' + x[1] + '月' : x[0] + '-' + x[1];
  return j([y1, m1]) + (h === 'cn' ? '至' : '-') + j([y2, m2]);
}

/* ================= 09 FILLER（native 填充；永不提交/上传） ================= */
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) { desc.set.call(el, ''); desc.set.call(el, value); }   // 先清后赋：受控组件同值短路
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function fillText(el, value) {
  const v = String(value);
  const ro = el.readOnly;
  if (ro) el.readOnly = false;                 // 自绘日期/下拉的 readonly input：临时放开再恢复
  setNativeValue(el, v);
  if (ro) el.readOnly = true;
  if (el.value !== v) {                        // 受控组件拒绝（React 同值短路/自定义拦截）→ 降级 execCommand
    try {
      el.focus();
      if (el.select) el.select();
      else if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
      document.execCommand('insertText', false, v);
    } catch (e) {}
    if (el.value !== v) return { ok: false, why: '受控组件未接受赋值 · 请手填' };
  }
  return { ok: true };
}
function fillCE(el, value) {                   // contenteditable（大易等平台的自我评价）
  el.focus();
  const sel = getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.addRange(range);
  document.execCommand('insertText', false, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}
/** 选项匹配（含消歧）：精确文本/值 > 后缀剥离 > 唯一包含 > 「以目标值结尾」的唯一候选；
    多个候选（同义/近义选项）返回 null —— 交 LLM 扫描映射或人工，绝不盲选第一个 */
function matchSelectOption(opts, text) {
  const t = String(text).trim();
  if (!t) return null;
  const txt = x => (x.text || '').trim();
  const st = stripRegionSuffix(t);
  const o = opts.find(x => txt(x) === t) || opts.find(x => x.value === t)
    || (st ? opts.find(x => txt(x) && stripRegionSuffix(txt(x)) === st) : null)   // "山东省"↔"山东" 后缀剥离
    ;
  if (o) return o;
  const cand = opts.filter(x => { const L = txt(x); return L.length >= 2 && L !== t && (L.includes(t) || t.includes(L)); });
  if (cand.length === 1) return cand[0];
  if (cand.length > 1) {
    const ends = cand.filter(x => txt(x).endsWith(t));
    if (ends.length === 1) return ends[0];
  }
  return null;
}
function fillSelect(sel, text) {
  const t = String(text).trim();
  if (!t) return { ok: false, why: '空值' };
  const o = matchSelectOption([...sel.options], t);
  if (!o) return { ok: false, why: '未匹配到选项「' + t + '」（同义选项可启用 AI 扫描映射）' };
  if (sel.value !== o.value) {
    sel.value = o.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return { ok: true };
}
/** 占位选项（不可作为映射目标）：请选择/—/无 等 */
function isPlaceholderOpt(t) {
  const s = String(t || '').trim();
  return !s || /^请选择|^请选|^选择$/.test(s) || /^[-—–/]+$/.test(s) || s === '无' || s === '暂无';
}
/** 联想搜索输入（jQuery autocompleter）：keydown 初始化 → 写值 → keyup 查询 → 等候选浮层 → 点选。
    点选让站点插件自行写隐藏 id（如 majorUnionId）；无候选时降级纯文本（部分站点接受自由文本）。 */
async function fillAutocomplete(el, value) {
  const t = String(value).trim();
  if (!t) return { ok: false, why: '空值' };
  const key = { bubbles: true, cancelable: true, view: window, key: 'a', code: 'KeyA' };
  try { el.focus(); } catch (e) {}
  el.dispatchEvent(new KeyboardEvent('keydown', key));    // 触发站点 onkeydown 初始化（destroy + autocompleter()）
  setNativeValue(el, t);
  el.dispatchEvent(new KeyboardEvent('keyup', key));      // 触发插件向后端查询
  let items = [];
  for (let i = 0; i < 20; i++) {
    await sleep(120);
    items = [...document.querySelectorAll('.autocompleter-item,[class*="autocompleter-item"]')].filter(o => isVisible(o) && cleanLabel(o.textContent));
    if (!items.length) items = [...document.querySelectorAll('[role="option"],[class*="option-item"],[class*="suggest-item"]')].filter(o => isVisible(o) && cleanLabel(o.textContent));
    if (items.length) break;
  }
  if (!items.length) return fillText(el, t);              // 无候选：降级纯文本
  const labelOf = o => cleanLabel(o.getAttribute('data-label') || o.textContent);
  const T = cleanLabel(t);
  const chosen = items.find(o => labelOf(o) === T)
    || items.find(o => { const L = labelOf(o); return L.length >= 2 && (L.includes(T) || T.includes(L)); });
  if (!chosen) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return { ok: false, why: '下拉中未匹配到「' + t + '」· 请手选' };
  }
  clickEl(chosen);
  await sleep(150);
  if (String(el.value || '').trim() !== '') return { ok: true };
  return { ok: false, why: '点选后控件仍为空 · 请手选' };
}
function fillRadioGroup(items, value, fieldLabel) {
  const v = String(value).trim();
  const neg = /^(否|不是|无|非|no|n|0)$/i.test(v);
  const pos = /^(是|有|yes|y|1)$/i.test(v);
  let fallback = null;
  for (const c of items) {
    const lbl = optionLabel(c.el);
    if (lbl === v || c.el.value === v || (lbl && lbl.includes(v)) || (v.length >= 2 && v.includes(lbl))) {
      if (!c.el.checked) c.el.click();
      return { ok: true };
    }
    /* 「是否X」类：选项写成肯定式短语（如「我是留学生」/「我是全日制…毕业生」）时按字段关键词判正反 */
    if ((neg || pos) && fieldLabel && items.length === 2 && lbl) {
      const kw = String(fieldLabel).replace(/^是否|^有无/, '').replace(/[?？:：]/g, '');
      const affirm = kw.length >= 2 && lbl.includes(kw);
      if ((neg && !affirm) || (pos && affirm)) fallback = c;
    }
  }
  if (fallback) { if (!fallback.el.checked) fallback.el.click(); return { ok: true }; }
  return { ok: false, why: '未匹配到选项「' + v + '」' };
}
function fillTagsGroup(items, values) {
  let hit = 0;
  for (const c of items) {
    const lbl = optionLabel(c.el);
    if (!lbl) continue;
    const L = lbl.toLowerCase();
    const want = values.some(t => {
      const T = String(t).toLowerCase();
      return L === T || (T.length >= 2 && (L.includes(T) || T.includes(L)));
    });
    if (want && !c.el.checked) { c.el.click(); hit++; }
  }
  return hit > 0 ? { ok: true } : { ok: false, why: '未匹配到任何选项' };
}
/* ---- 自绘下拉点击填充：点击打开 → 等 portal 浮层 → 按文本点选；可搜索下拉先输入再点首条 ----
   失败绝不盲点：关闭浮层（Escape）→ 交人工。 */
const AF_OVERLAY_SEL = '.ant-select-dropdown,.el-select-dropdown,.el-cascader__dropdown,.el-picker-panel,.el-picker__popper,' +
  '[role="listbox"],[role="listbox-popup"],[class*="select-dropdown"],[class*="dropdown-menu"],[class*="dropdown-panel"],' +
  '[class*="option-list"],[class*="options-container"],[class*="picker-panel"],[class*="popover"],[class*="menu-list"]';
const AF_OPTION_SEL = '[role="option"],.ant-select-item,.ant-select-item-option,.el-select-dropdown__item,.el-cascader-node,[class*="option"],[class*="item"]';

function overlaySnapshot() {
  return [...document.querySelectorAll(AF_OVERLAY_SEL)].filter(x => isVisible(x));
}
function clickEl(el) {
  const r = el.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    let ev; try { ev = new PointerEvent(type, base); } catch (e) { ev = new MouseEvent(type, base); }
    el.dispatchEvent(ev);
  }
  try { el.click(); } catch (e) {}
}
/** 单击版（分区导航/添加/保存）：pointer+mouse 序列 + 仅一次 click —— 避免「添加/保存」被触发两次 */
function clickOnce(el) {
  const r = el.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    let ev; try { ev = new PointerEvent(type, base); } catch (e) { ev = new MouseEvent(type, base); }
    el.dispatchEvent(ev);
  }
  try { el.click(); } catch (e) {}
}
function optionsIn(overlay) {
  return [...overlay.querySelectorAll(AF_OPTION_SEL)]
    .filter(o => isVisible(o) && o.offsetHeight > 4 && cleanLabel(o.textContent));
}
function matchOption(opts, t) {
  const T = cleanLabel(t);
  if (!T) return null;
  const Ts = stripRegionSuffix(T);
  return opts.find(o => cleanLabel(o.textContent) === T)
    || (Ts ? opts.find(o => { const L = stripRegionSuffix(cleanLabel(o.textContent)); return L && L === Ts; }) : null)
    || opts.find(o => { const L = cleanLabel(o.textContent); return L.length >= 2 && T.length >= 2 && (L.includes(T) || T.includes(L)); });
}
async function fillWidget(c, text, regionParts) {
  const host = c.host || c.el;
  const t0 = String(text).trim();
  if (!t0) return { ok: false, why: '空值' };
  const before = overlaySnapshot();
  clickEl(host);
  let overlay = null, opts = [];
  for (let i = 0; i < 12; i++) {                       // 最多等 1.2s：级联/远程加载的浮层
    await sleep(100);
    const fresh = overlaySnapshot().filter(x => !before.includes(x));
    if (fresh.length) {
      overlay = fresh[0];
      opts = optionsIn(overlay);
      if (opts.length) break;
    }
  }
  /* 区域字段：浮层选项自检层级 → 取对应级（短形），Profile 缺级则交人工 */
  let t = t0;
  if (regionParts) {
    const lv = detectLevel(opts);
    if (lv) {
      const part = regionParts[lv];
      if (!part) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return { ok: false, why: 'Profile 无' + ({ p: '省级', c: '市级', d: '区县级' }[lv]) + ' · 请手选' };
      }
      t = part;
      c.value = t;   // 审计留痕用实际填入的级值
    }
  }
  let chosen = opts.length ? matchOption(opts, t) : null;
  if (!chosen && overlay) {                            // 可搜索下拉：往浮层/壳内搜索框输入再选
    const search = [...overlay.querySelectorAll('input')].find(x => isVisible(x))
      || [...host.querySelectorAll('input')].find(x => isVisible(x) && !x.readOnly);
    if (search) {
      setNativeValue(search, t);
      await sleep(400);
      opts = optionsIn(overlay);
      chosen = matchOption(opts, t);
    }
  }
  if (!chosen) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return { ok: false, why: '下拉中未匹配到「' + t + '」· 请手选' };
  }
  clickEl(chosen);
  await sleep(120);
  return { ok: true };
}
async function fillRow(row) {
  const el = row.el;
  try {
    if (row.kind === 'widget') return await fillWidget(row, row.value, row.regionParts);
    if (row.kind === 'autocomplete') return await fillAutocomplete(el, row.value);
    if (row.kind === 'textarea' || row.kind === 'text' || row.kind === 'date') return fillText(el, row.value);
    if (row.kind === 'ce') return fillCE(el, row.value);
    if (row.kind === 'select') {
      for (let i = 0; i < 12 && el.options.length <= 1; i++) await sleep(100);   // 级联：等上级 change 加载下级选项
      if (row.regionParts) {
        const lv = detectLevel([...el.options]);
        if (lv) {
          const part = row.regionParts[lv];
          if (!part) return { ok: false, why: 'Profile 无' + ({ p: '省级', c: '市级', d: '区县级' }[lv]) + ' · 请手选' };
          row.value = part;   // 审计留痕用实际填入的级值
          return fillSelect(el, part);
        }
      }
      return fillSelect(el, row.value);
    }
    if (row.kind === 'radio') return fillRadioGroup(row.group, row.value, row.label);
    if (row.kind === 'tags') return fillTagsGroup(row.group, row.values);
    return { ok: false, why: '该控件类型暂不支持自动填充' };
  } catch (e) { return { ok: false, why: '填充异常：' + e.message }; }
}

/* ================= 09b LEARN（自动学习：用户手填的值 → 写回本地 Profile） =================
   只学习「用户真实键入」的值（isTrusted）——脚本/网站写入的合成事件一律忽略；
   匹配到字典 → 写回对应字段（数组按扫描时第 k 段）；未匹配 → customFields + custom 值；
   验证码/搜索框/密码框/勾选框永不学习。设置里可一键关闭。                        */
const LEARN_Q = new Map();
let learnTimer = null;
const LEARN_DENY = /验证码|搜索|关键字|关键词|search|keyword|captcha/i;
/* 岗位/公司特有问答（亲属从业、运营商经验、是否愿意服从调剂…）→ 只记本站，不进 Profile */
const SITEQA_PAT = /是否|亲属|回避|从业|违法|犯罪|失信|竞业|背景调查|政审|违约|忠诚/;

function qaLookup(label) {
  if (!label) return null;
  const host = Store.siteQA()[location.host];
  if (!host) return null;
  const k = String(label).toLowerCase();
  if (host[k] != null) return host[k];
  if (k.length >= 6) {
    for (const key in host) {
      if (key.length >= 6 && (key.includes(k) || k.includes(key))) return host[key];
    }
  }
  return null;
}

function learnEnabled() { return Store.settings().learn !== false; }
function toCanonDate(v) {
  const m = String(v).trim().match(/^(\d{4})\s*[.\-/年]\s*(\d{1,2})(?:\s*[.\-/]\s*(\d{1,2}))?\s*月?日?$/);
  if (m) return m[1] + '-' + String(+m[2]).padStart(2, '0');
  return String(v).trim();
}
function toCanonRange(v) {
  const m = String(v).trim().match(/^(\d{4})\s*[.\-/年]?\s*(\d{1,2})?\s*月?\s*[~—\-–至到]+\s*(\d{4})\s*[.\-/年]?\s*(\d{1,2})?\s*月?$/);
  if (!m) return String(v).trim();
  const f = (y, mo) => mo ? y + '.' + String(+mo).padStart(2, '0') : y;
  return f(m[1], m[2]) + '-' + f(m[3], m[4]);
}
function canonLearnValue(d, v) {
  if (d.valueType === 'date') return toCanonDate(v);
  if (d.valueType === 'range') return toCanonRange(v);
  return String(v).trim();
}
function controlValueForLearn(c) {
  if (c.kind === 'select') { const o = c.el.selectedOptions && c.el.selectedOptions[0]; return o ? o.text.trim() : ''; }
  return String(c.el.value || '').trim();
}
function queueLearn(item) {
  const sig = item.type + '|' + (item.path || (item.arrayKey + '.' + item.k + '.' + item.leaf));
  LEARN_Q.set(sig, item);
  clearTimeout(learnTimer);
  learnTimer = setTimeout(commitLearn, 3500);
}
function stageDictKey(key, label, v) {
  v = String(v || '').trim();
  if (!v || v.length > 60 || /[\r\n]/.test(v)) return;              // 防页面文本块被误学进标量
  if (key === 'basic.name' && !VTYPES.name(v)) return;
  if (key === 'basic.phone' && !VTYPES.phone(v)) return;
  const cur = pathGet(Store.getProfile().base, key);
  if (cur === v) return;
  queueLearn({ type: 'dict', path: key, label, value: v });
}
function stageDict(d, k, v) {
  if (d.valueType === 'tags') return;
  v = String(v || '').trim();
  if (!v) return;
  if (d.valueType !== 'longtext' && (v.length > 100 || /[\r\n]/.test(v))) return;
  const arr = Store.getProfile().base[d.arrayKey] || [];
  if (!arr[k]) return;
  if (arr[k][d.leaf] === v) return;
  queueLearn({ type: 'array', arrayKey: d.arrayKey, k, leaf: d.leaf,
    label: (ARRAY_LABEL[d.arrayKey] || '') + (CIRC[k] || k + 1) + '·' + d.label, value: v });
}
function stageCustom(label, v) {
  label = String(label || '').trim();
  v = String(v || '').trim();
  if (label.length < 2 || label.length > 20 || /\s{2,}/.test(label)) return;   // 容器长文本不是字段名
  if (!v || v.length > 300) return;
  const profile = Store.getProfile();
  const path = 'custom.' + label.replace(/\./g, '_');
  if (pathGet(profile.base, path) === v) return;
  const known = (profile.base.customFields || []).some(cf => cf.path === path);
  queueLearn({ type: 'custom', path, label, value: v, known });
}
function stageSiteQA(label, v) {
  const host = Store.siteQA()[location.host] || {};
  if (host[String(label).toLowerCase()] === v) return;
  queueLearn({ type: 'siteqa', label, value: v });
}
function commitLearn() {
  if (!LEARN_Q.size) return;
  const profile = Store.getProfile();
  let n = 0;
  LEARN_Q.forEach(it => {
    if (it.type === 'dict') {
      const keys = it.path.split('.');
      let o = profile.base;
      for (let i = 0; i < keys.length - 1; i++) { o[keys[i]] = o[keys[i]] || {}; o = o[keys[i]]; }
      o[keys[keys.length - 1]] = it.value; n++;
    } else if (it.type === 'array') {
      const arr = profile.base[it.arrayKey] = profile.base[it.arrayKey] || [];
      if (arr[it.k]) { arr[it.k][it.leaf] = it.value; n++; }
    } else if (it.type === 'custom') {
      profile.base.custom = profile.base.custom || {};
      profile.base.custom[it.path.slice(7)] = it.value;
      if (!it.known) {
        profile.base.customFields = profile.base.customFields || [];
        profile.base.customFields.push({ path: it.path, label: it.label, aliases: [it.label] });
      }
      n++;
    } else if (it.type === 'siteqa') {
      const m = Store.siteQA();
      const host = m[location.host] = m[location.host] || {};
      host[String(it.label).toLowerCase()] = it.value;
      Store.saveSiteQA(m); n++;
    }
  });
  LEARN_Q.clear();
  Store.saveProfile(profile);
  renderProfileView(); renderSiteQa();
  toast('已自动学习 ' + n + ' 个字段（岗位特有问答只记本站）→ Profile 页可复制导出回 json');
}

/** 文档级入口：可信 input/change → 学习该控件的值 */
function learnControl(el) {
  if (!learnEnabled() || !el || !el.tagName) return;
  if (el.closest && el.closest('#af-host')) return;
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
  const t = (el.type || '').toLowerCase();
  if (t === 'checkbox' || t === 'file' || t === 'password') return;
  if (LEARN_DENY.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('placeholder') || ''))) return;
  if (!isVisible(el)) return;

  /* 单选组：组内任一成员持有扫描时的占用信息 */
  if (t === 'radio') {
    if (!el.checked) return;
    let hit = LAST_ASSIGN.get(el);
    if (!hit) for (const r2 of document.querySelectorAll('input[type=radio]')) {
      if (r2.name === el.name && LAST_ASSIGN.get(r2)) { hit = LAST_ASSIGN.get(r2); break; }
    }
    if (!hit) {                                   // 未知单选组：组标签 → 字典兜底，否则记为本站问答
      const gl = groupLabelOf(el);
      const v = optionLabel(el);
      if (!gl || !v) return;
      const cand = candidatesFor({ labelText: gl, labelWeight: 1, name: '', id: '', placeholder: '' })[0];
      if (cand && cand.score >= TH_MID && !cand.d.arrayKey) stageDictKey(cand.d.key, cand.d.label, v);
      else stageSiteQA(gl, v);
      return;
    }
    if (hit.score < TH_MID) return;
    const v = optionLabel(el);
    if (v) { if (hit.d.arrayKey) stageDict(hit.d, hit.k, v); else stageDictKey(hit.d.key, hit.d.label, v); }
    return;
  }

  const c = { el, kind: tag === 'SELECT' ? 'select' : tag === 'TEXTAREA' ? 'textarea' : 'text',
    type: t, name: el.name || '', id: el.id || '', placeholder: el.getAttribute('placeholder') || '' };
  const v = controlValueForLearn(c);
  if (!v) return;

  /* 优先用扫描时的占用（可定位数组第 k 段）；没扫过则现算（仅标量） */
  const hit = LAST_ASSIGN.get(el);
  if (hit && hit.score >= TH_MID && hit.d) {
    const cv = canonLearnValue(hit.d, v);
    if (hit.d.arrayKey) stageDict(hit.d, hit.k, cv);
    else stageDictKey(hit.d.key, hit.d.label, cv);
    return;
  }
  const lb = labelFor(c); c.labelText = lb.t; c.labelWeight = lb.w; c.labelSource = lb.s;
  const cand = candidatesFor(c)[0];
  if (cand && cand.score >= TH_MID && !cand.d.arrayKey) {
    stageDictKey(cand.d.key, cand.d.label, canonLearnValue(cand.d, v));
  } else if (c.labelText && c.labelText.length >= 2) {
    if (SITEQA_PAT.test(c.labelText)) stageSiteQA(c.labelText, v);
    else stageCustom(c.labelText, v);
  }
}
/** 面板行内改值 → 学习（模板行跳过：不让学生把模板真身覆盖成单页文本） */
function learnRowEdit(r, v) {
  if (!learnEnabled() || !v) return;
  if (r._qa) { if (v !== '—') stageSiteQA(r.label, v); return; }
  if (!r._d || r._tpl) return;
  const d = r._d;
  const cv = canonLearnValue(d, v);
  if (!cv) return;
  if (d.arrayKey && d.valueType !== 'tags') stageDict(d, r.arrIdx || 0, cv);
  else if (!d.arrayKey) stageDictKey(d.key, d.label, cv);
}
function wireLearn() {
  ['input', 'change'].forEach(ev => document.addEventListener(ev, e => {
    if (!e.isTrusted || e.target === host) return;
    try { learnControl(e.target); } catch (err) {}
  }, true));
}

/* ================= 11 BRIDGE（iframe 桥接：postMessage 协议，src/token 双校验） =================
   北森等平台的表单常嵌在客户官网的 iframe 里。子 frame 同样运行本脚本：
   - 子 frame：无面板；响应主框 SCAN / FILL_ONE；另有迷你兜底按钮（两击：先扫描后填充勾选项）
   - 主 frame：广播扫描 → 合并子 frame 行（标「子框架」）→ 填充时逐行转发
   协议：{src:'AF_FILL', token, type, ...}；token 每页随机，防其他脚本伪造消息。 */
const AF_TOKEN = Math.random().toString(36).slice(2);
const FRAME_WINS = new Map();   // url → window（子 frame HELLO 时记录，主框用）

function scanFrames(variantKey) {
  return new Promise(resolve => {
    const wins = [];
    document.querySelectorAll('iframe,frame').forEach(f => {
      try {
        if (!f.contentWindow || f.contentWindow === window) return;
        if (!isVisible(f)) return;                                  // 隐藏/装饰 iframe 不扫
        const rc = f.getBoundingClientRect();
        if (rc.width < 120 || rc.height < 60) return;               // 广告位/像素级挂件不扫
        wins.push(f.contentWindow);
      } catch (e) {}
    });
    if (!wins.length) return resolve([]);
    const found = [];
    const onMsg = ev => {
      const d = ev.data;
      if (!d || d.src !== 'AF_FILL' || d.token !== AF_TOKEN) return;
      if (d.type === 'SCAN_RES') {
        if (!found.some(x => x.url === d.url)) found.push(d);
        if (ev.source) FRAME_WINS.set(d.url, ev.source);
      }
    };
    window.addEventListener('message', onMsg);
    wins.forEach(w => { try { w.postMessage({ src: 'AF_FILL', token: AF_TOKEN, type: 'SCAN', variant: variantKey || '' }, '*'); } catch (e) {} });
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(found); }, 900);
  });
}
function fillFrameRow(r) {
  return new Promise(resolve => {
    const onMsg = ev => {
      const d = ev.data;
      if (!d || d.src !== 'AF_FILL' || d.type !== 'FILL_RES' || d.token !== AF_TOKEN || d.rowId !== r.childId) return;
      cleanup(); resolve(d.result || { ok: false, why: '子框架返回异常' });
    };
    const cleanup = () => window.removeEventListener('message', onMsg);
    window.addEventListener('message', onMsg);
    try {
      r.frameWin.postMessage({ src: 'AF_FILL', token: AF_TOKEN, type: 'FILL_ONE',
        rowId: r.childId, value: r.value, values: r.values }, '*');
    } catch (e) { cleanup(); return resolve({ ok: false, why: '无法访问子框架' }); }
    setTimeout(() => { cleanup(); resolve({ ok: false, why: '子框架填充超时' }); }, 3500);
  });
}
function bootChildFrame() {
  /* 子 frame 不进 UI 区（CSS 常量未初始化），这里内联一份填充闪烁样式 */
  try {
    if (!document.getElementById('af-pagecss')) {
      const st = document.createElement('style');
      st.id = 'af-pagecss';
      st.textContent = '@keyframes afRing{0%{box-shadow:0 0 0 0 rgba(20,20,22,.4)}100%{box-shadow:0 0 0 9px rgba(20,20,22,0)}}' +
        '@keyframes afRingY{0%{box-shadow:0 0 0 0 rgba(210,166,60,.55)}100%{box-shadow:0 0 0 9px rgba(210,166,60,0)}}' +
        '.af-flashV{animation:afRing .8s ease-out 2}.af-flashY{animation:afRingY .8s ease-out 2}';
      document.head.appendChild(st);
    }
  } catch (e) {}
  let childRows = [];
  window.addEventListener('message', ev => {
    const d = ev.data;
    if (!d || d.src !== 'AF_FILL') return;
    if (d.type === 'SCAN') {
      try {
        childRows = buildRows(d.variant || '');
        ev.source.postMessage({ src: 'AF_FILL', token: d.token, type: 'SCAN_RES', url: location.href,
          rows: childRows.filter(r => r.kind !== 'file').map(r => ({ id: r.id, kind: r.kind, label: r.label,
            conf: r.conf, value: r.value, note: r.note, checked: r.checked, sensitive: !!r.sensitive, manual: !!r.manual })) }, '*');
      } catch (e) {}
    }
    if (d.type === 'FILL_ONE') {
      const r = childRows.find(x => x.id === d.rowId);
      if (!r) {
        ev.source.postMessage({ src: 'AF_FILL', token: d.token, type: 'FILL_RES', rowId: d.rowId,
          result: { ok: false, why: '行已失效 · 请重新扫描' } }, '*');
        return;
      }
      if (d.value != null) r.value = d.value;      // 面板内联编辑过的值
      if (d.values) r.values = d.values;
      fillRow(r).then(res => ev.source.postMessage({ src: 'AF_FILL', token: d.token, type: 'FILL_RES', rowId: d.rowId, result: res }, '*'));
    }
  });
  /* 迷你兜底按钮：主框桥不可用（如直接打开子页面）时，两击完成「扫描 → 填充勾选项」。
     同样：不碰提交、不碰文件、敏感字段默认不勾。可填项 <3 个不出现，避免广告 iframe 里到处是小球。 */
  const mini = document.createElement('div');
  mini.textContent = 'AF';
  mini.setAttribute('title', '网申快填 · 子框架模式：第 1 击扫描，第 2 击填充勾选项');
  mini.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:2147483646;width:26px;height:26px;' +
    'border-radius:50%;background:#fff;color:#141416;border:1px solid rgba(20,20,22,.35);' +
    'font:600 10px/24px ui-monospace,Consolas,monospace;text-align:center;cursor:pointer;opacity:.6;user-select:none';
  mini.addEventListener('mouseenter', () => mini.style.opacity = '1');
  mini.addEventListener('mouseleave', () => mini.style.opacity = '.6');
  let scanned = false;
  mini.addEventListener('click', () => {
    try {
      if (!scanned) {
        childRows = buildRows('');
        scanned = true;
        const n = childRows.filter(r => r.checked).length;
        mini.textContent = String(n);
        return;
      }
      const targets = childRows.filter(r => r.checked && !r.manual && r.conf !== 'low' && r.value !== '');
      let done = 0;
      targets.reduce((p, r) => p.then(() => fillRow(r).then(res => {
        if (res.ok) done++;
        auditPush({ t: new Date().toISOString(), host: location.host, frame: 'child',
          conf: r.conf, ok: !!res.ok, label: r.label, value: auditMask(res.ok ? r.value : '', r.sensitive) });
      })), Promise.resolve())
        .then(() => { mini.textContent = '✓' + done; setTimeout(() => { mini.textContent = 'AF'; }, 2500); });
    } catch (e) {}
  });
  if (!Store.settings().disabled[location.host]) {
    try { childRows = buildRows(''); } catch (e) {}   // 预判一次：可填项够多才亮按钮（广告 iframe 不出现）
    setTimeout(() => {
      if (childRows.filter(r => r.checked && !r.manual && r.conf !== 'low' && r.value !== '').length >= 3) {
        document.documentElement.appendChild(mini);
      }
    }, 800);
  }
}

if (!IS_TOP) { bootChildFrame(); return; }            // 子 frame：到此为止，不进 UI

/* ================= 12 UI（Shadow DOM · 白纸黑字设计语言） ================= */
const CSS = `
:host{all:initial}
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif}
button{cursor:pointer}
.ball{position:fixed;right:26px;bottom:26px;width:46px;height:46px;border-radius:50%;background:#fff;
  border:1px solid rgba(20,20,22,.32);display:grid;place-items:center;color:#141416;cursor:grab;
  font:500 11.5px/1 ui-monospace,'Cascadia Mono',Consolas,monospace;letter-spacing:.08em;user-select:none;touch-action:none;
  box-shadow:0 12px 30px rgba(12,12,16,.18);z-index:2147483646}
.ball:active{cursor:grabbing}
.ball i{position:absolute;top:-1px;left:50%;width:14px;height:1px;background:#141416;transform:translateX(-50%);font-style:normal}
.panel{position:fixed;right:26px;bottom:84px;width:398px;max-width:calc(100vw - 24px);max-height:min(660px,calc(100vh - 120px));
  display:flex;flex-direction:column;background:#fff;border:1px solid rgba(20,20,22,.09);border-radius:16px;color:#141416;
  box-shadow:0 32px 90px rgba(10,10,14,.16),0 2px 6px rgba(10,10,14,.06);z-index:2147483647;
  transform-origin:bottom right;transition:transform .2s ease,opacity .2s ease}
.panel.hidden{transform:scale(.97) translateY(8px);opacity:0;pointer-events:none}
.ph{display:flex;align-items:baseline;gap:10px;padding:17px 20px 13px}
.wm{font:500 11.5px/1 ui-monospace,Consolas,monospace;letter-spacing:.2em}
.v{font:400 9px/1 ui-monospace,Consolas,monospace;letter-spacing:.12em;color:#A6A7AE}
.x{margin-left:auto;background:none;border:none;color:#A6A7AE;font-size:13px;width:22px;height:22px;border-radius:6px;line-height:1}
.x:hover{color:#141416}
.tabs{display:flex;gap:24px;padding:0 20px;border-bottom:1px solid rgba(20,20,22,.10)}
.tab{background:none;border:none;font-size:12px;color:#74757C;padding:7px 1px 9px;position:relative}
.tab.on{color:#141416;font-weight:500}
.tab.on::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1.5px;background:#141416}
.body{overflow-y:auto;padding:13px 20px 16px;flex:1;min-height:200px}
.pane{display:none}.pane.on{display:block}
.bar{display:flex;gap:8px;margin-bottom:11px}
.bar select{flex:1;font-size:12px;background:#F7F7F8;border:1px solid rgba(20,20,22,.14);border-radius:8px;padding:7px 9px;color:#141416}
.btn{border:none;border-radius:9px;font-size:12px;font-weight:500;padding:8px 15px;letter-spacing:.04em}
.btn.pri{background:#141416;color:#fff}.btn.pri:hover{background:#2A2A2E}
.btn.ghost{background:#fff;border:1px solid rgba(20,20,22,.2);color:#74757C}.btn.ghost:hover{border-color:#141416;color:#141416}
.legend{display:flex;gap:12px;flex-wrap:wrap;font:400 9px/1 ui-monospace,Consolas,monospace;letter-spacing:.1em;color:#A6A7AE;margin-bottom:9px}
.legend span{display:flex;align-items:center;gap:5px}
.legend i{width:5px;height:5px;border-radius:50%;font-style:normal}
.stats{display:flex;gap:14px;flex-wrap:wrap;font:400 9.5px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;color:#A6A7AE;margin-bottom:8px}
.stats b{font-weight:500;color:#74757C}
.dirty{display:none;font:400 9.5px/1.6 ui-monospace,Consolas,monospace;letter-spacing:.08em;color:#B98F35;margin-bottom:8px}
.dirty.on{display:block}
.rows{display:flex;flex-direction:column}
.row{display:flex;align-items:center;gap:11px;padding:9.5px 0;border-bottom:1px solid rgba(20,20,22,.06)}
.dot{width:5px;height:5px;border-radius:50%;flex:none}
.row.c-high .dot{background:#4C9E7E}.row.c-mid .dot{background:#D2A63C}.row.c-low .dot{background:#B4B5BB}
.row.c-sen{box-shadow:inset 2px 0 0 #C6484E;padding-left:10px}.row.c-sen .dot{background:#C6484E}
.lb{font-size:12px;color:#74757C;width:96px;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row.c-sen .lb{color:#C6484E}
.val{flex:1;min-width:0;font:400 11px/1.4 ui-monospace,Consolas,monospace;background:transparent;border:1px solid transparent;border-radius:5px;
  padding:3px 6px;color:#141416;text-align:right;white-space:pre;text-overflow:ellipsis;overflow:hidden}
.val:hover,.val:focus{border-color:rgba(20,20,22,.2);background:#fff}
.val:disabled{color:#A6A7AE}
.row.c-low .val{border-style:dashed;border-color:rgba(20,20,22,.14)}
.row.done .val{color:#141416}
.row.warnfill .val{color:#B98F35}
.row.badfill .val{color:#C6484E}
.row.semBad{box-shadow:inset 2px 0 0 #D2A63C;padding-left:10px}
.row.semBad .val{color:#B98F35}
.row.semBad + .rownote{color:#B98F35}
.row.llmBad{box-shadow:inset 2px 0 0 #B98F35;padding-left:10px}
.row.llmBad .val{color:#B98F35}
.ck{width:14px;height:14px;border-radius:4px;flex:none;appearance:none;-webkit-appearance:none;border:1px solid rgba(20,20,22,.28);
  background:#fff;position:relative;margin:0}
.ck:checked{background:#141416;border-color:#141416}
.ck:checked::after{content:"";position:absolute;left:4px;top:1.4px;width:4px;height:7.5px;border:solid #fff;border-width:0 1.4px 1.4px 0;transform:rotate(42deg)}
.ck:disabled{opacity:.35;cursor:not-allowed}
.loc{flex:none;background:none;border:none;font:400 9.5px/1 ui-monospace,Consolas,monospace;letter-spacing:.1em;color:#74757C;
  text-decoration:underline;text-underline-offset:3px;padding:2px 0}
.loc:hover{color:#141416}
.rownote{font-size:10.5px;color:#A6A7AE;padding:0 0 7px 16px;margin-top:-5px;border-bottom:1px solid rgba(20,20,22,.06)}
.row.c-sen + .rownote{color:#C6484E}
.row.warnfill + .rownote{color:#B98F35}
.hint{font-size:11px;color:#A6A7AE;line-height:1.7;margin-top:10px}
.foot{border-top:1px solid rgba(20,20,22,.10);padding:13px 20px 15px}
.doneBanner{display:none;background:#F7F7F8;border:1px solid rgba(20,20,22,.08);border-radius:9px;padding:9px 12px;
  font-size:11.5px;color:#141416;line-height:1.65;margin-bottom:10px}
.doneBanner.on{display:block}
.doneBanner b{font:500 11px/1 ui-monospace,Consolas,monospace}
.fillbtn{width:100%;padding:11px;font-size:12.5px;letter-spacing:.08em;border-radius:10px;background:#141416;color:#fff;
  border:none;font-weight:500}
.fillbtn:hover{background:#2A2A2E}
.fillbtn:disabled{opacity:.4;cursor:not-allowed}
.fillbtn .fine{display:block;font:400 9px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;color:rgba(255,255,255,.55);margin-top:4px}
.pview{font:400 10px/1.7 ui-monospace,Consolas,monospace;color:#74757C;background:#F7F7F8;border:1px solid rgba(20,20,22,.08);
  border-radius:9px;padding:11px 13px;max-height:170px;overflow:auto;white-space:pre;margin-bottom:10px}
.impArea{width:100%;font:400 10.5px/1.6 ui-monospace,Consolas,monospace;border:1px dashed rgba(20,20,22,.22);border-radius:9px;
  padding:9px 11px;min-height:72px;resize:vertical;background:#fff;color:#141416;margin-bottom:8px}
.impMsg{font-size:11px;border-radius:7px;padding:6px 10px;margin-bottom:8px;display:none;line-height:1.6}
.impMsg.ok{display:block;background:#F7F7F8;color:#141416;border:1px solid rgba(20,20,22,.08)}
.impMsg.err{display:block;color:#C6484E;border:1px solid rgba(198,72,78,.3)}
.inp{width:100%;font:400 10.5px/1.4 ui-monospace,Consolas,monospace;background:#F7F7F8;border:1px solid rgba(20,20,22,.14);border-radius:7px;padding:6px 9px;color:#141416}
.inp:focus{outline:none;border-color:#141416}
.oprow{display:flex;gap:8px;align-items:center}
.fileLbl{font-size:11px;color:#A6A7AE}
.ctxrow{display:flex;gap:8px;margin-bottom:11px}
.ctxrow input{flex:1;min-width:0;font-size:12px;background:#F7F7F8;border:1px solid rgba(20,20,22,.14);border-radius:8px;padding:7px 9px;color:#141416}
.oqrow{padding:11px 0;border-bottom:1px solid rgba(20,20,22,.06)}
.oqrow:last-of-type{border-bottom:none}
.oqttl{font-size:12.5px;color:#141416;font-weight:500}
.oqmeta{font:400 9px/1 ui-monospace,Consolas,monospace;letter-spacing:.1em;color:#A6A7AE;margin:4px 0 8px}
.oqprev{font-size:11px;color:#74757C;line-height:1.6;max-height:52px;overflow:hidden;margin-bottom:8px}
.oqbtns{display:flex;gap:8px}
.setRow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;border-bottom:1px solid rgba(20,20,22,.06)}
.setRow:last-of-type{border-bottom:none}
.setRow .sl{font-size:12px}
.setRow .sl small{display:block;font-size:10px;color:#A6A7AE;line-height:1.5;margin-top:1px}
.sw{width:32px;height:18px;border-radius:99px;background:rgba(20,20,22,.14);border:none;position:relative;flex:none}
.sw::after{content:"";position:absolute;top:2.5px;left:3px;width:13px;height:13px;border-radius:50%;background:#fff;box-shadow:0 1px 2.5px rgba(10,10,14,.25)}
.sw.on{background:#141416}.sw.on::after{left:16px}
.toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%) translateY(14px);background:#fff;border:1px solid rgba(20,20,22,.18);
  color:#74757C;font-size:11.5px;border-radius:10px;padding:10px 19px;opacity:0;pointer-events:none;transition:.25s;z-index:2147483647;
  max-width:86vw;text-align:center;box-shadow:0 16px 44px rgba(10,10,14,.16)}
.toast.on{opacity:1;transform:translateX(-50%)}
.toast.warn{border-color:rgba(210,166,60,.55);color:#141416}
.toast.bad{border-color:rgba(198,72,78,.55);color:#C6484E}
@media (max-width:560px){ .panel{right:12px;bottom:80px} .ball{right:16px;bottom:16px} }
@media (prefers-reduced-motion:reduce){ *{transition:none!important} }
`;
/* 页面级：填充闪烁（工具身份色=黑）+ 需人工(琥珀) */
function injectPageCss() {
  if ($('#af-pagecss')) return;
  const st = document.createElement('style');
  st.id = 'af-pagecss';
  st.textContent =
    '@keyframes afRing{0%{box-shadow:0 0 0 0 rgba(20,20,22,.4)}100%{box-shadow:0 0 0 9px rgba(20,20,22,0)}}' +
    '@keyframes afRingY{0%{box-shadow:0 0 0 0 rgba(210,166,60,.55)}100%{box-shadow:0 0 0 9px rgba(210,166,60,0)}}' +
    '.af-flashV{animation:afRing .8s ease-out 2}' +
    '.af-flashY{animation:afRingY .8s ease-out 2}';
  document.documentElement.appendChild(st);
}

const host = document.createElement('div');
host.id = 'af-host';
const root = host.attachShadow({ mode: 'closed' });
/* UI 挂载：优先 innerHTML；站点开启 Trusted Types（如电信/北森等企业站）时该写入点会抛错，
 * 此时降级为 DOMParser（惰性文档，不受 TT 管控）解析后移入 shadow root —— 字符串仍是脚本内置静态 UI，零网络、零 eval */
const SHADOW_HTML = '<style>' + CSS + '</style>' +
  '<div class="ball" part="ball" title="网申快填">AF<i></i></div>' +
  '<div class="panel hidden" role="dialog" aria-label="网申快填面板">' +
    '<div class="ph"><span class="wm">AF-FILL</span><span class="v">V' + VER + '</span><button class="x" data-close aria-label="收起">✕</button></div>' +
    '<div class="tabs">' +
      '<button class="tab on" data-tab="fill" type="button">填充</button>' +
      '<button class="tab" data-tab="oq" type="button">开放题</button>' +
      '<button class="tab" data-tab="profile" type="button">Profile</button>' +
      '<button class="tab" data-tab="set" type="button">设置</button>' +
    '</div>' +
    '<div class="body">' +
      '<section class="pane on" data-pane="fill">' +
        '<div class="bar"><select class="varSel" aria-label="岗位变体"></select><button class="btn pri scanBtn" type="button">扫描表单</button></div>' +
        '<div class="legend">' +
          '<span><i style="background:#4C9E7E"></i>高置信</span>' +
          '<span><i style="background:#D2A63C"></i>待确认</span>' +
          '<span><i style="background:#B4B5BB"></i>需人工</span>' +
          '<span><i style="background:#C6484E"></i>敏感默认跳过</span>' +
        '</div>' +
        '<div class="stats" hidden></div>' +
        '<div class="dirty">PAGE CHANGED · 建议重新扫描</div>' +
        '<div class="rows"></div>' +
        '<p class="hint scanHint">尚未扫描。点「扫描表单」识别当前页面可填字段（只读操作，不会写入）。</p>' +
      '</section>' +
      '<section class="pane" data-pane="oq">' +
        '<div class="ctxrow">' +
          '<input class="ctxCo" placeholder="公司名 {{company}}">' +
          '<input class="ctxPo" placeholder="岗位名 {{position}}">' +
        '</div>' +
        '<div class="setRow" style="display:block;padding:10px 0 11px"><div class="sl">AI 代笔<small>粘贴 JD → 生成按这家公司定制的初稿（需在设置里配好接口并开启「开放题代笔」）。草稿只存本机，满意后自行存回 profile.json。</small></div>' +
          '<div style="display:flex;gap:6px;margin:8px 0 6px"><select class="draftType" style="flex:0 0 112px;font-size:12px;background:#F7F7F8;border:1px solid rgba(20,20,22,.14);border-radius:8px;padding:7px 9px;color:#141416">' +
            '<option>自我介绍</option><option>为什么选我们</option><option>职业规划</option><option>自定义</option></select>' +
            '<button class="btn ghost draftGrab" type="button">抓取本页 JD</button>' +
            '<button class="btn pri draftBtn" type="button">AI 生成初稿</button></div>' +
          '<textarea class="impArea draftJd" style="min-height:54px;max-height:120px" placeholder="粘贴职位描述 JD（从职位页复制），或点「抓取本页 JD」自动取页面正文前 3000 字"></textarea>' +
        '</div>' +
        '<div class="oqlist"></div>' +
        '<p class="hint">「插入」写入页面正在编辑的文本域（没在编辑就找最长的空文本域）；「复制」进剪贴板手动粘贴。先点一下页面里的输入框再回来点插入，最准。</p>' +
      '</section>' +
      '<section class="pane" data-pane="profile">' +
        '<div class="oprow" style="margin:0 0 9px"><button class="btn pri harvBtn" type="button">采集本页已填 → Profile</button></div>' +
        '<p class="hint" style="margin:0 0 9px">反向采集：把当前页面里<b>已手工填好的内容</b>读回 Profile——同名标量以页面为准覆盖，经历数组按段对位、缺的段自动补建，岗位特有问答只记本站。完成后下方文本框即最新 Profile 全文，请复制存回 profile.json。敏感值（身份证等）同样一并采集，仅存本机。</p>' +
        '<p class="hint" style="margin:0 0 9px">数据只存在你本机（Tampermonkey 存储，跨网站共享）。源文件 profile.json 由你自行维护，改完在此导入。</p>' +
        '<div class="pview"></div>' +
        '<textarea class="impArea" placeholder=\'粘贴 profile.json 全文，或选择文件\'></textarea>' +
        '<div class="oprow"><button class="btn ghost fileBtn" type="button">选择文件…</button><input type="file" accept=".json,application/json" style="display:none">' +
        '<button class="btn pri impBtn" type="button">校验并导入</button><button class="btn ghost expBtn" type="button">复制导出</button></div>' +
        '<div class="impMsg"></div>' +
      '</section>' +
      '<section class="pane" data-pane="set">' +
        '<div class="setRow"><div class="sl">本站启用<small>关闭后此域名不显示悬浮球（可用油猴菜单恢复）</small></div><button class="sw siteSw" role="switch" type="button"></button></div>' +
        '<div class="setRow"><div class="sl">自动学习<small>你手动键入的新内容自动存回 Profile（身份证等敏感值同样只存本机）</small></div><button class="sw learnSw" role="switch" type="button"></button></div>' +
        '<div class="setRow" style="display:block"><div class="sl">AI 校验（可选 · 默认关闭）<small>填你自己的 OpenAI 兼容接口（DeepSeek / Kimi / 通义 / 本地 Ollama 均可）。启用后每次扫描把待填行打包批量送审一次做语义复核，敏感值默认脱敏后才发出；首次调用时篡改猴会弹一次「允许该域名」，选「总是允许」即可。</small></div>' +
          '<div style="display:flex;gap:6px;margin:9px 0 6px"><input class="inp llmBase" style="flex:1" placeholder="Base URL（如 https://api.deepseek.com）">' +
          '<input class="inp llmModel" style="flex:0 0 110px" placeholder="模型名"></div>' +
          '<input class="inp llmKey" type="password" placeholder="API Key（留空 = 完全不联网）" style="margin-bottom:9px">' +
          '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;font-size:10.5px;color:#74757C">' +
            '<span style="display:flex;align-items:center;gap:6px"><button class="sw llmSw" role="switch" type="button"></button>AI 复核</span>' +
            '<span style="display:flex;align-items:center;gap:6px"><button class="sw llmMapSw" role="switch" type="button"></button>AI 扫描映射</span>' +
            '<span style="display:flex;align-items:center;gap:6px"><button class="sw llmPlainSw" role="switch" type="button"></button>明文送审</span>' +
            '<span style="display:flex;align-items:center;gap:6px"><button class="sw llmDraftSw" role="switch" type="button"></button>开放题代笔</span>' +
          '</div>' +
        '</div>' +
        '<div class="setRow"><div class="sl">上传附件后自动填充<small>检测到你选了简历附件 → 自动按默认勾选清单填充（敏感/低置信仍需手动确认）</small></div><button class="sw upSw" role="switch" type="button"></button></div>' +
        '<div class="setRow"><div class="sl">本站问答记忆<small>岗位特有问题（亲属从业、运营商经验…）的答案只记在本站，不进 Profile。<span class="qaCnt"></span></small></div><button class="btn ghost qaClr" type="button">清除本站</button></div>' +
        '<div class="setRow"><div class="sl">诊断报告<small>扫描本页全部控件生成结构化文本（只读、零网络），显示在 Profile 页文本框，请手动全选复制。</small></div><button class="btn ghost diagBtn" type="button">生成报告</button></div>' +
        '<div class="setRow"><div class="sl">Debug 悬停模式<small>悬停页面任意控件显示识别详情（标签来源·命中字典·置信度）· 只读，用于平台适配测绘</small></div><button class="sw dbgSw" role="switch" type="button"></button></div>' +
        '<div class="setRow"><div class="sl">填充审计<small>每次填充记一笔：时间·站点·字段·置信度（敏感值打码），仅存本机、上限 200 条。<span class="auCnt"></span></small></div><div style="display:flex;gap:6px"><button class="btn ghost auExp" type="button">导出</button><button class="btn ghost auClr" type="button">清空</button></div></div>' +
        '<div class="setRow" style="display:block;border-bottom:none"><div class="sl">安全说明<small>脚本只填充勾选项，绝不点击提交、绝不上传文件；默认零网络，配置 LLM 后仅向你指定的接口发送送审内容（默认脱敏）。填充完成后请逐项核对，自行提交。</small></div></div>' +
      '</section>' +
    '</div>' +
    '<div class="foot">' +
      '<div class="doneBanner">✓ 已填充 <b class="dc">0</b> 项，跳过 <b class="sc">0</b> 项。请逐项核对后再自行提交——脚本不会替你提交。</div>' +
      '<button class="fillbtn" type="button" disabled>执行填充 · 仅勾选项<span class="fine">FILL CHECKED ONLY — REVIEW BEFORE SUBMIT</span></button>' +
    '</div>' +
  '</div>' +
  '<div class="toast" role="status"></div>';
try {
  root.innerHTML = SHADOW_HTML;
} catch (ttErr) {
  try {
    const ttDoc = new DOMParser().parseFromString('<body>' + SHADOW_HTML + '</body>', 'text/html');
    while (ttDoc.body.firstChild) root.appendChild(ttDoc.body.firstChild);
  } catch (e2) { console.warn('[AF-Fill] UI 挂载失败', e2); }
}

const ui = {
  ball: $('.ball', root), panel: $('.panel', root),
  varSel: $('.varSel', root), scanBtn: $('.scanBtn', root),
  stats: $('.stats', root), dirty: $('.dirty', root), rowsEl: $('.rows', root),
  scanHint: $('.scanHint', root), fillBtn: $('.fillbtn', root),
  doneBanner: $('.doneBanner', root), dc: $('.dc', root), sc: $('.sc', root),
  pview: $('.pview', root), impArea: $('.impArea', root), impMsg: $('.impMsg', root), harvBtn: $('.harvBtn', root),
  fileInput: $('input[type=file]', root), siteSw: $('.siteSw', root), learnSw: $('.learnSw', root), upSw: $('.upSw', root),
  qaCnt: $('.qaCnt', root), qaClr: $('.qaClr', root),
  oqList: $('.oqlist', root), ctxCo: $('.ctxCo', root), ctxPo: $('.ctxPo', root),
  llmBase: $('.llmBase', root), llmKey: $('.llmKey', root), llmModel: $('.llmModel', root),
  llmSw: $('.llmSw', root), llmMapSw: $('.llmMapSw', root), llmPlainSw: $('.llmPlainSw', root), llmDraftSw: $('.llmDraftSw', root),
  draftType: $('.draftType', root), draftGrab: $('.draftGrab', root), draftBtn: $('.draftBtn', root), draftJd: $('.draftJd', root),
  dbgSw: $('.dbgSw', root), auCnt: $('.auCnt', root), auExp: $('.auExp', root), auClr: $('.auClr', root),
  toastEl: $('.toast', root)
};

let toastTimer;
function toast(msg, kind) {
  ui.toastEl.textContent = msg;
  ui.toastEl.className = 'toast on' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toastEl.classList.remove('on'), 2800);
}
function togglePanel(force) {
  const open = force !== undefined ? !!force : ui.panel.classList.contains('hidden');
  ui.panel.classList.toggle('hidden', !open);
  if (open && !scannedOnce) rescan(false);   // 首次打开面板自动扫描（只读），免一次点击
}
root.addEventListener('click', e => {
  const t = e.target;
  if (t.closest('[data-close]')) togglePanel(false);
  if (t.closest('.tab')) {
    const name = t.closest('.tab').dataset.tab;
    root.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
    root.querySelectorAll('.pane').forEach(x => x.classList.toggle('on', x.dataset.pane === name));
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') togglePanel(false); });
document.addEventListener('keydown', e => {   // Alt+Shift+A 唤起/收起面板
  if (e.altKey && e.shiftKey && !e.ctrlKey && (e.key === 'A' || e.key === 'a')) { e.preventDefault(); togglePanel(); }
});
document.addEventListener('keydown', e => {   // Alt+Shift+F 扫描（分区站点 = 全程扫描；只读/只开分区，不提交）
  if (e.altKey && e.shiftKey && !e.ctrlKey && (e.key === 'F' || e.key === 'f')) {
    e.preventDefault();
    if (host.style.display !== 'none') ui.scanBtn.click();
  }
});
document.addEventListener('keydown', e => {   // Alt+Shift+D 执行填充（仅勾选项；分区站点逐区填充+分区保存，绝不点最终提交）
  if (e.altKey && e.shiftKey && !e.ctrlKey && (e.key === 'D' || e.key === 'd')) {
    e.preventDefault();
    if (host.style.display !== 'none') ui.fillBtn.click();
  }
});

/* —— 悬浮球拖拽（≤6px 视为点击） —— */
(function drag() {
  const b = ui.ball;
  let sx, sy, ox, oy, drag = false, wasDrag = false;
  try {
    const p = Store.get(K_BALL, null);
    if (p) { b.style.right = 'auto'; b.style.bottom = 'auto'; b.style.left = p.x + 'px'; b.style.top = p.y + 'px'; }
  } catch (e) {}
  b.addEventListener('pointerdown', e => {
    drag = false; sx = e.clientX; sy = e.clientY;
    const r = b.getBoundingClientRect(); ox = r.left; oy = r.top;
    try { b.setPointerCapture(e.pointerId); } catch (err) {}
  });
  b.addEventListener('pointermove', e => {
    if (e.buttons !== 1) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 6) drag = true;
    if (!drag) return;
    b.style.right = 'auto'; b.style.bottom = 'auto';
    b.style.left = Math.min(Math.max(0, ox + dx), innerWidth - 54) + 'px';
    b.style.top = Math.min(Math.max(0, oy + dy), innerHeight - 54) + 'px';
  });
  b.addEventListener('pointerup', () => {
    if (drag) {
      wasDrag = true;
      try { const r = b.getBoundingClientRect(); Store.set(K_BALL, { x: r.left, y: r.top }); } catch (e) {}
    }
  });
  b.addEventListener('click', () => {
    if (wasDrag) { wasDrag = false; return; }
    togglePanel();
  });
})();

/* —— 行渲染（page 内容一律 textContent，防注入） —— */
function renderRows() {
  ui.rowsEl.textContent = '';
  ui.scanHint.style.display = 'none';
  const cnt = { high: 0, mid: 0, sen: 0, low: 0 };
  ROWS.forEach(r => cnt[r.conf] = (cnt[r.conf] || 0) + 1);
  ui.stats.hidden = false;
  ui.stats.textContent = '';
  const statLine = document.createDocumentFragment();
  const mkStat = (color, name, n) => {
    const s = document.createElement('span');
    s.style.display = 'flex'; s.style.alignItems = 'center'; s.style.gap = '5px';
    const i = document.createElement('i'); i.style.cssText = 'width:5px;height:5px;border-radius:50%;font-style:normal;background:' + color;
    s.appendChild(i);
    const b = document.createElement('b'); b.textContent = name + ' ' + n;
    s.appendChild(b);
    return s;
  };
  statLine.appendChild(document.createTextNode('SCAN ' + ROWS.length + ' · '));
  statLine.appendChild(mkStat('#4C9E7E', 'HIGH', cnt.high));
  statLine.appendChild(document.createTextNode(' · '));
  statLine.appendChild(mkStat('#D2A63C', 'MID', cnt.mid));
  statLine.appendChild(document.createTextNode(' · '));
  statLine.appendChild(mkStat('#C6484E', 'SENS', cnt.sen));
  statLine.appendChild(document.createTextNode(' · '));
  statLine.appendChild(mkStat('#B4B5BB', 'LOW', cnt.low));
  ui.stats.appendChild(statLine);
  ui.dirty.classList.remove('on');
  ui.fillBtn.disabled = !ROWS.some(r => r.checked);

  ROWS.forEach(r => {
    const row = document.createElement('div');
    row.className = 'row c-' + r.conf + (r.semBad ? ' semBad' : '') + (r.llmBad ? ' llmBad' : '');

    const dot = document.createElement('span'); dot.className = 'dot';
    const lb = document.createElement('span'); lb.className = 'lb'; lb.textContent = r.label; lb.title = r.label;
    const val = document.createElement('input'); val.className = 'val'; val.type = 'text';
    const editable = !r.manual && r.conf !== 'low';
    val.value = r.value ? (r.value.length > 40 && r.kind !== 'textarea' ? r.value.slice(0, 40) + '…' : r.value) : (r.manual ? r.value : '—');
    if (r.value.length > 40) val.title = r.value;
    val.disabled = !editable;
    if (editable) {
      val.addEventListener('input', () => { r.value = val.value; });
      val.addEventListener('change', () => { learnRowEdit(r, val.value); });
    }
    row.appendChild(dot); row.appendChild(lb); row.appendChild(val);

    if (r.el && (r.conf === 'low' || r.manual)) {
      const loc = document.createElement('button'); loc.className = 'loc'; loc.type = 'button'; loc.textContent = '定位';
      loc.addEventListener('click', () => {
        const t = r.el;
        if (t && t.scrollIntoView) t.scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'center' });
        flashEl(t, 'af-flashY');
      });
      row.appendChild(loc);
    }
    const ck = document.createElement('input'); ck.className = 'ck'; ck.type = 'checkbox';
    ck.setAttribute('aria-label', '填充 ' + r.label);
    if (r.checked) ck.checked = true;
    /* 敏感行默认不勾但可手动勾选（有值时）；其余按人工/低置信/空值禁用 */
    if (r.manual || r.conf === 'low' || r.value === '') ck.disabled = true;
    if (!r.manual && r.conf !== 'low' && r.value !== '') {
      ck.addEventListener('change', () => { r.checked = ck.checked; ui.fillBtn.disabled = !ROWS.some(x => x.checked); });
    }
    row.appendChild(ck);
    ui.rowsEl.appendChild(row);
    r.elRow = row;

    if (r.note) {
      const n = document.createElement('div');
      n.className = 'rownote';
      n.textContent = (r.conf === 'sen' || r.semBad || r.llmBad ? '⚠ ' : '· ') + r.note;
      ui.rowsEl.appendChild(n);
    }
  });
}

/* —— 填充审计（仅存本机 GM/localStorage；敏感值打码；上限 200 条；导出靠手动复制） —— */
function auditPush(entry) {
  try {
    const list = Store.get(K_AUDIT, []) || [];
    list.push(entry);
    if (list.length > 200) list.splice(0, list.length - 200);
    Store.set(K_AUDIT, list);
  } catch (e) {}
}
function auditMask(v, sensitive) {
  const s = String(v || '');
  if (!s) return '';
  if (sensitive) return s.slice(0, 2) + '****' + (s.length > 6 ? s.slice(-2) : '');
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
}
function renderAudit() {
  const list = Store.get(K_AUDIT, []) || [];
  if (ui.auCnt) ui.auCnt.textContent = list.length ? '共 ' + list.length + ' 条。' : '暂无。';
}
function switchPane(name) {
  root.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x.dataset.tab === name));
  root.querySelectorAll('.pane').forEach(x => x.classList.toggle('on', x.dataset.pane === name));
}
ui.auExp.addEventListener('click', () => {
  const list = Store.get(K_AUDIT, []) || [];
  ui.impArea.value = list.length
    ? list.map(e => [e.t, e.host, e.frame, e.conf, e.ok ? 'OK' : 'FAIL', e.label, e.value].join(' | ')).join('\n')
    : '（审计日志为空）';
  switchPane('profile');
  toast('审计日志已放到 Profile 页文本框 · 请手动全选复制');
});
ui.auClr.addEventListener('click', () => { Store.set(K_AUDIT, []); renderAudit(); toast('审计日志已清空'); });

/* —— 扫描 / 填充 —— */
async function rescan(keepChecked) {
  scannedOnce = true;
  const variantKey = ui.varSel.value || '';
  const prev = keepChecked ? new Map(ROWS.filter(r => r.el).map(r => [r.el, r])) : null;
  ROWS = buildRows(variantKey);
  if (prev) ROWS.forEach(r => { const o = prev.get(r.el); if (o) r.checked = o.checked; });
  renderRows();
  /* iframe 桥：子 frame 行并入清单（标「子框架」），填充时逐行转发。
     防「乱读取」：只并入真有可填项的框架 —— 命中字典（高/中置信）≥3 行才算表单，
     否则视为广告位/侧边嵌入的无关页面（如左边那页简历），整帧忽略。 */
  const frameRes = await scanFrames(variantKey);
  if (frameRes.length) {
    let merged = 0, skipped = 0;
    frameRes.forEach(fr => {
      let fh = 'frame';
      try { fh = new URL(fr.url).host || fh; } catch (e) {}
      const usable = (fr.rows || []).filter(cr =>
        !cr.manual && cr.kind !== 'file' && cr.value !== '' && (cr.conf === 'high' || cr.conf === 'mid'));
      if (usable.length < 3) { skipped++; return; }
      usable.slice(0, 60).forEach(cr => {
        ROWS.push({ id: 0, childId: cr.id, kind: cr.kind, label: '[子框架·' + fh + '] ' + cr.label,
          conf: cr.conf, value: cr.value, note: cr.note, checked: !!cr.checked, sensitive: cr.sensitive,
          manual: cr.manual, frameWin: FRAME_WINS.get(fr.url) || null, frameUrl: fr.url, el: null,
          domIdx: 10000 + ROWS.length });
      });
      merged += Math.min(usable.length, 60);
    });
    if (merged || skipped) {
      renderRows();
      toast(merged ? ('已并入 ' + merged + ' 项子框架字段' + (skipped ? ' · 忽略 ' + skipped + ' 个无表格子框架' : ''))
                   : ('已忽略 ' + skipped + ' 个无表格子框架'), skipped ? 'warn' : '');
    }
  }
  lastCount = -1;   // 让 observer 下一跳重新对齐基线
  maybeLlmMap(() => maybeLlmReview());   // AI 扫描映射（消歧/补全）→ 第二道复核；未配置/未启用直接跑复核
}
ui.scanBtn.addEventListener('click', async () => {
  const dd = deepSecs();
  if (dd) {
    ui.scanBtn.disabled = true; ui.scanBtn.textContent = '全程扫描中…';
    try { await deepScan(false); }
    finally { ui.scanBtn.disabled = false; ui.scanBtn.textContent = '扫描表单'; }
    return;
  }
  await rescan(false);
  const n = ROWS.length, ns = ROWS.filter(r => r.semBad).length;
  toast('扫描完成：识别 ' + n + ' 项 · 无写入操作' + (ns ? ' · ' + ns + ' 行语义不符已拦下' : ''), ns ? 'warn' : '');
});
function doFill() {
  if (DEEP && DEEP.adapter && activeAdapter() === DEEP.adapter) return doFillDeep();
  const targets = ROWS.filter(r => r.checked && !r.manual && r.conf !== 'low' && r.value !== '');
  if (!targets.length) { toast('没有已勾选的可填项', 'warn'); return; }
  ui.fillBtn.disabled = true;
  const domOrder = [...targets].sort((a, b) => a.domIdx - b.domIdx);
  let done = 0, warn = 0, fail = 0;
  const run = async i => {
    if (i >= domOrder.length) {
      ui.dc.textContent = done; ui.sc.textContent = ROWS.length - done;
      ui.doneBanner.classList.add('on');
      ui.fillBtn.disabled = !ROWS.some(x => x.checked);
      toast(warn || fail ? '填充完成，有 ' + (warn + fail) + ' 项需要人工处理' : '填充完成 · 请逐项核对后自行提交');
      return;
    }
    const r = domOrder[i];
    const res = r.frameWin ? await fillFrameRow(r) : await fillRow(r);
    auditPush({ t: new Date().toISOString(), host: location.host, frame: r.frameUrl ? 'iframe' : 'top',
      conf: r.conf, ok: !!res.ok, label: r.label, value: auditMask(res.ok ? r.value : '', r.sensitive) });
    if (res.ok) {
      done++;
      /* 敏感字段填后红框强制核对 */
      r.elRow && r.elRow.classList.add(r.sensitive ? 'badfill' : 'done');
      if (r.host || r.el) flashEl(r.host || r.el, 'af-flashV');
    } else {
      fail++; r.elRow && r.elRow.classList.add('badfill');
      if (r.host || r.el) flashEl(r.host || r.el, 'af-flashY');
      toast(r.label + '：' + (res.why || '填充失败'), 'warn');
    }
    setTimeout(() => run(i + 1), RM ? 0 : 90 + Math.floor(Math.random() * 70));
  };
  run(0);
}
ui.fillBtn.addEventListener('click', doFill);

/* —— 变体 —— */
function renderVariants() {
  const profile = Store.getProfile();
  const cur = ui.varSel.value;
  ui.varSel.textContent = '';
  const opt0 = document.createElement('option');
  opt0.value = ''; opt0.textContent = '变体 · 默认';
  ui.varSel.appendChild(opt0);
  (Object.keys(profile.variants || {})).forEach(k => {
    const o = document.createElement('option');
    o.value = k; o.textContent = '变体 · ' + ((profile.variants[k] && profile.variants[k].label) || k);
    ui.varSel.appendChild(o);
  });
  if (cur && [...ui.varSel.options].some(o => o.value === cur)) ui.varSel.value = cur;
}
ui.varSel.addEventListener('change', () => {
  if (scannedOnce) { rescan(true); toast('已按变体刷新将填值'); }
});

/* —— 开放题 Tab（模板库 + 占位符 + 插入/复制） —— */
let lastFocusEl = null;
document.addEventListener('focusin', e => {
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable) && !(t.closest && t.closest('#af-host'))) lastFocusEl = t;
}, true);
function targetForInsert() {
  if (lastFocusEl && document.contains(lastFocusEl) && (lastFocusEl.tagName === 'TEXTAREA' || lastFocusEl.isContentEditable)) return lastFocusEl;
  const tas = [...document.querySelectorAll('textarea')].filter(t => !(t.closest && t.closest('#af-host')) && isVisible(t));
  tas.sort((a, b) => (((b.value || '').trim() ? 0 : 1) - ((a.value || '').trim() ? 0 : 1)) || (b.offsetHeight - a.offsetHeight));
  return tas[0] || null;
}
function insertOQ(content) {
  const t = targetForInsert();
  if (!t) { toast('页面上没有可插入的文本域 · 请用「复制」手动粘贴'); return; }
  const cur = t.tagName === 'TEXTAREA' ? String(t.value || '') : t.textContent || '';
  const next = cur.trim() ? cur.trimEnd() + '\n\n' + content : content;
  if (t.isContentEditable) fillCE(t, next); else { t.focus(); setNativeValue(t, next); }
  flashEl(t, 'af-flashV');
  toast('已插入开放题内容 · 请核对');
}
function renderOQ() {
  const P = mergedProfile(Store.getProfile(), ui.varSel.value || '');
  const s = Store.settings(); const ctx = s.ctx = s.ctx || {};
  ui.oqList.textContent = '';
  const mkBtns = (content, withClear) => {
    const btns = document.createElement('div'); btns.className = 'oqbtns';
    const ins = document.createElement('button'); ins.type = 'button'; ins.className = 'btn pri'; ins.textContent = '插入';
    ins.addEventListener('click', () => insertOQ(content));
    const cp = document.createElement('button'); cp.type = 'button'; cp.className = 'btn ghost'; cp.textContent = '复制';
    cp.addEventListener('click', () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(content).then(() => toast('已复制 · 可粘贴到任意输入框'))
          .catch(() => { ui.impArea.value = content; toast('剪贴板不可用 · 已放到 Profile 页文本框'); });
      } else { ui.impArea.value = content; toast('已放到 Profile 页文本框'); }
    });
    btns.appendChild(ins); btns.appendChild(cp);
    if (withClear) {
      const dl = document.createElement('button'); dl.type = 'button'; dl.className = 'btn ghost'; dl.textContent = '清除';
      dl.addEventListener('click', () => { AI_DRAFT = null; renderOQ(); });
      btns.appendChild(dl);
    }
    return btns;
  };
  if (AI_DRAFT) {
    const row = document.createElement('div'); row.className = 'oqrow';
    const ttl = document.createElement('div'); ttl.className = 'oqttl'; ttl.textContent = AI_DRAFT.title;
    const meta = document.createElement('div'); meta.className = 'oqmeta'; meta.textContent = 'AI 草稿 · 未写入 PROFILE.JSON · 请修改后自行保存';
    const prev = document.createElement('div'); prev.className = 'oqprev';
    prev.textContent = AI_DRAFT.content.slice(0, 120) + (AI_DRAFT.content.length > 120 ? '…' : ''); prev.title = AI_DRAFT.content;
    row.appendChild(ttl); row.appendChild(meta); row.appendChild(prev); row.appendChild(mkBtns(AI_DRAFT.content, true));
    ui.oqList.appendChild(row);
  }
  const q = P.openQuestions || [];
  if (!q.length) {
    if (AI_DRAFT) return;
    const p = document.createElement('p'); p.className = 'hint';
    p.textContent = 'Profile.openQuestions 为空 · 在 profile.json 里维护开放题模板';
    ui.oqList.appendChild(p); return;
  }
  q.forEach((item, i) => {
    const row = document.createElement('div'); row.className = 'oqrow';
    const filled = fillTpl(item.content || '', P, ctx);
    const ttl = document.createElement('div'); ttl.className = 'oqttl';
    ttl.textContent = fillTpl(item.title || ('模板 ' + (i + 1)), P, ctx);
    const meta = document.createElement('div'); meta.className = 'oqmeta';
    meta.textContent = ((item.type || '其他') + (item.tags && item.tags.length ? ' · ' + item.tags.join('/') : '')).toUpperCase();
    const prev = document.createElement('div'); prev.className = 'oqprev';
    prev.textContent = filled.slice(0, 120) + (filled.length > 120 ? '…' : ''); prev.title = filled;
    row.appendChild(ttl); row.appendChild(meta); row.appendChild(prev); row.appendChild(mkBtns(filled, false));
    ui.oqList.appendChild(row);
  });
}
function renderCtx() {
  const ctx = (Store.settings().ctx = Store.settings().ctx || {});
  ui.ctxCo.value = ctx.company || '';
  ui.ctxPo.value = ctx.position || '';
}
ui.ctxCo.addEventListener('input', () => { const s = Store.settings(); s.ctx = s.ctx || {}; s.ctx.company = ui.ctxCo.value.trim(); Store.saveSettings(s); renderOQ(); });
ui.ctxPo.addEventListener('input', () => { const s = Store.settings(); s.ctx = s.ctx || {}; s.ctx.position = ui.ctxPo.value.trim(); Store.saveSettings(s); renderOQ(); });

/* —— Profile 视图 / 导入导出 —— */
function renderProfileView() {
  const p = Store.getProfile();
  const s = JSON.stringify(p, null, 2);
  ui.pview.textContent = s.length > 3600 ? s.slice(0, 3600) + '\n…（完整内容请复制导出）' : s;
}
function validateProfile(j) {
  if (!j || typeof j !== 'object') return '不是合法的 JSON 对象';
  if (j.schemaVersion !== 1) return 'schemaVersion 必须为 1';
  if (!j.base || !j.base.basic || !j.base.basic.name) return '缺少 base.basic.name';
  return null;
}
$('.impBtn', root).addEventListener('click', () => {
  const raw = ui.impArea.value.trim();
  ui.impMsg.className = 'impMsg';
  if (!raw) { ui.impMsg.classList.add('err'); ui.impMsg.textContent = '请先粘贴 JSON 内容'; return; }
  let j;
  try { j = JSON.parse(raw); } catch (e) { ui.impMsg.classList.add('err'); ui.impMsg.textContent = '解析失败：' + e.message; return; }
  const err = validateProfile(j);
  if (err) { ui.impMsg.classList.add('err'); ui.impMsg.textContent = err; return; }
  Store.saveProfile(j);
  ui.impMsg.classList.add('ok');
  ui.impMsg.textContent = '✓ 校验通过，已存入 Tampermonkey 存储（跨网站共享）';
  toast('Profile 导入成功');
  renderProfileView(); renderVariants();
  if (scannedOnce) rescan(true);
});
function copyText(s) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(s).then(() => true).catch(() => fallbackCopy(s));
  }
  return Promise.resolve(fallbackCopy(s));
}
function fallbackCopy(s) {
  const ta = document.createElement('textarea');
  ta.value = s; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) {}
  ta.remove();
  return ok;
}
$('.expBtn', root).addEventListener('click', () => {
  copyText(JSON.stringify(Store.getProfile(), null, 2)).then(ok => toast(ok ? '已复制当前 Profile' : '复制失败', ok ? '' : 'bad'));
});
$('.fileBtn', root).addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', () => {
  const f = ui.fileInput.files && ui.fileInput.files[0];
  if (!f) return;
  const fr = new FileReader();
  fr.onload = () => { ui.impArea.value = String(fr.result || ''); $('.impBtn', root).click(); };
  fr.readAsText(f);
  ui.fileInput.value = '';
});

/* —— 设置 —— */
function renderSiteSw() {
  const s = Store.settings();
  const on = !s.disabled[location.host];
  ui.siteSw.classList.toggle('on', on);
  ui.siteSw.setAttribute('aria-checked', on);
}
ui.siteSw.addEventListener('click', () => {
  const s = Store.settings();
  const on = !s.disabled[location.host];
  if (on) { s.disabled[location.host] = 1; toast('已在本站停用（油猴菜单可恢复）'); }
  else { delete s.disabled[location.host]; toast('已在本站启用'); }
  Store.saveSettings(s);
  renderSiteSw();
  host.style.display = on ? 'none' : '';
});
function renderLearnSw() {
  const on = Store.settings().learn !== false;
  ui.learnSw.classList.toggle('on', on);
  ui.learnSw.setAttribute('aria-checked', on);
}
ui.learnSw.addEventListener('click', () => {
  const s = Store.settings();
  s.learn = s.learn === false;
  Store.saveSettings(s);
  renderLearnSw();
  toast(s.learn ? '自动学习已开启：手填的新内容会存回 Profile' : '自动学习已关闭');
});
function renderUpSw() {
  const on = Store.settings().autoFillUpload !== false;
  ui.upSw.classList.toggle('on', on);
  ui.upSw.setAttribute('aria-checked', on);
}
ui.upSw.addEventListener('click', () => {
  const s = Store.settings();
  s.autoFillUpload = s.autoFillUpload === false;
  Store.saveSettings(s);
  renderUpSw();
  toast(s.autoFillUpload === false ? '上传附件后自动填充已关闭：仅扫描并弹出面板' : '上传附件后自动填充已开启');
});
function renderDbgSw() {
  const on = Store.settings().debug === true;
  dbgOn = on;
  ui.dbgSw.classList.toggle('on', on);
  ui.dbgSw.setAttribute('aria-checked', on);
}
ui.dbgSw.addEventListener('click', () => {
  const s = Store.settings();
  s.debug = !(s.debug === true);
  Store.saveSettings(s);
  renderDbgSw();
  if (!s.debug) hideDbgTip();
  toast(s.debug ? 'Debug 悬停模式已开启 · 悬停控件查看识别详情（只读）' : 'Debug 悬停模式已关闭');
});
/* —— Debug 悬停：页面级小浮签（只读，textContent，零网络） —— */
let dbgTip = null, dbgHover = null, dbgOn = false;
function hideDbgTip() {
  if (dbgTip) { dbgTip.remove(); dbgTip = null; }
  dbgHover = null;
}
function showDbgTip(el, x, y) {
  if (!dbgTip) {
    dbgTip = document.createElement('div');
    dbgTip.style.cssText = 'position:fixed;z-index:2147483645;max-width:340px;padding:7px 10px;background:#fff;' +
      'color:#141416;border:1px solid rgba(20,20,22,.3);border-radius:8px;box-shadow:0 4px 16px rgba(20,20,22,.14);' +
      'font:10.5px/1.7 ui-monospace,Consolas,monospace;pointer-events:none;white-space:pre-wrap';
    document.documentElement.appendChild(dbgTip);
  }
  const c = { el, kind: (el.tagName || '').toLowerCase(), type: (el.type || '').toLowerCase(), name: el.name || '',
    id: el.id || '', placeholder: el.getAttribute('placeholder') || '' };
  if (el.isContentEditable) c.kind = 'ce';
  if (el.closest && el.closest('.ant-select,.el-select,.el-cascader,[role="combobox"]')) c.kind = 'widget';
  const lb = labelFor(c);
  const cands = c.kind === 'radio' || c.kind === 'checkbox'
    ? [] : candidatesFor(Object.assign(c, { labelText: lb.t, labelWeight: lb.w })).slice(0, 3);
  const lines = [];
  lines.push('KIND  ' + c.kind + (c.type ? ' / ' + c.type : ''));
  lines.push('DOM   ' + (el.tagName || '') + (c.id ? '#' + c.id : '') + (c.name ? '[name=' + c.name + ']' : ''));
  lines.push('LABEL "' + (lb.t || '—') + '"  来源=' + lb.s + '  权重=' + lb.w);
  lines.push(cands.length
    ? cands.map(x => 'HIT   ' + x.d.key + '  ' + x.d.label + '  @' + x.score.toFixed(2)).join('\n')
    : 'HIT   （未命中字典）');
  const row = ROWS.find(r => r.el === el);
  if (row) lines.push('ROW   conf=' + row.conf + '  将填="' + String(row.value).slice(0, 20) + '"');
  dbgTip.textContent = lines.join('\n');
  const rect = dbgTip.getBoundingClientRect();
  dbgTip.style.left = Math.min(x + 14, innerWidth - rect.width - 10) + 'px';
  dbgTip.style.top = Math.min(y + 16, innerHeight - rect.height - 10) + 'px';
}
document.addEventListener('mouseover', e => {
  if (!dbgOn) return;
  const el = e.target;
  if (!el || el.closest && (el.closest('#af-host') || el === dbgTip)) return;
  if (!el.matches || !el.matches('input,textarea,select,[contenteditable],[role="combobox"]')) return;
  if (el === dbgHover) return;
  dbgHover = el;
  showDbgTip(el, e.clientX, e.clientY);
}, true);
document.addEventListener('mousemove', e => {
  if (dbgTip && dbgHover && e.clientX != null) showDbgTip(dbgHover, e.clientX, e.clientY);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideDbgTip(); });
window.addEventListener('scroll', hideDbgTip, true);

/* ================= 11b LLM（可选 AI 层：默认全关 · 显式配置你自己的 OpenAI 兼容接口后才联网） =================
   - 复核：扫描完成后把待填行打包一次批量送审（不是逐字段调用），拦截语义不符行
   - 脱敏：身份证/电话发出前打码；设置里「明文送审」开启才发真值（默认坚持脱敏）
   - 代笔：JD + 本机档案 → 开放题定制初稿；只输出到本机列表，绝不编造档案外事实
   - 失败一律静默降级（toast 提示，规则层结果生效），绝不阻塞主流程 */
let llmBusy = false, AI_DRAFT = null;

function llmCfg() { const s = Store.settings(); s.llm = s.llm || {}; return s.llm; }
function saveLlm(patch) { const s = Store.settings(); s.llm = Object.assign(s.llm || {}, patch); Store.saveSettings(s); return s.llm; }
function llmReady() { const c = llmCfg(); return !!(c.enabled && c.baseUrl && c.apiKey && typeof GM_xmlhttpRequest === 'function'); }

function renderLlm() {
  const c = llmCfg();
  ui.llmBase.value = c.baseUrl || '';
  ui.llmKey.value = c.apiKey || '';
  ui.llmModel.value = c.model || '';
  const on = c.enabled === true && !!(c.baseUrl && c.apiKey);
  ui.llmSw.classList.toggle('on', on); ui.llmSw.setAttribute('aria-checked', on);
  const mOn = c.scanMap !== false;
  ui.llmMapSw.classList.toggle('on', mOn); ui.llmMapSw.setAttribute('aria-checked', mOn);
  ui.llmPlainSw.classList.toggle('on', c.plain === true); ui.llmPlainSw.setAttribute('aria-checked', c.plain === true);
  const dOn = c.draft !== false;
  ui.llmDraftSw.classList.toggle('on', dOn); ui.llmDraftSw.setAttribute('aria-checked', dOn);
}
ui.llmBase.addEventListener('input', () => { saveLlm({ baseUrl: ui.llmBase.value.trim() }); renderLlm(); });
ui.llmKey.addEventListener('input', () => { saveLlm({ apiKey: ui.llmKey.value.trim() }); renderLlm(); });
ui.llmModel.addEventListener('input', () => { saveLlm({ model: ui.llmModel.value.trim() }); });
ui.llmSw.addEventListener('click', () => {
  const c = llmCfg();
  if (c.enabled === true && c.baseUrl && c.apiKey) { saveLlm({ enabled: false }); renderLlm(); toast('AI 复核已关闭 · 恢复零网络'); return; }
  if (!c.baseUrl || !c.apiKey) { toast('先填 Base URL 和 API Key（留空 = 完全不联网）', 'warn'); return; }
  saveLlm({ enabled: true }); renderLlm();
  toast('AI 复核已启用 · 每次扫描批量送审一次（默认脱敏）');
});
ui.llmPlainSw.addEventListener('click', () => {
  const c = saveLlm({ plain: !(llmCfg().plain === true) });
  renderLlm();
  toast(c.plain ? '明文送审已开启：身份证/电话原样发给 API' : '明文送审已关闭：敏感值脱敏后才发出');
});
ui.llmDraftSw.addEventListener('click', () => {
  const c = saveLlm({ draft: !(llmCfg().draft !== false) });
  renderLlm();
  toast(c.draft !== false ? '开放题 AI 代笔已启用' : '开放题 AI 代笔已关闭');
});
ui.llmMapSw.addEventListener('click', () => {
  const next = !(llmCfg().scanMap !== false);
  saveLlm({ scanMap: next });
  renderLlm();
  toast(next ? 'AI 扫描映射已开启：同义选项消歧 + 未命中字段补映射（默认脱敏）' : 'AI 扫描映射已关闭 · 仅规则层');
});

/** OpenAI 兼容 chat 调用（GM_xmlhttpRequest 跨域；任何失败 cb(null)，绝不抛错） */
function llmChat(messages, cb, timeoutMs) {
  const c = llmCfg();
  let url = String(c.baseUrl || '').replace(/\/+$/, '');
  if (!url) return cb(null);
  if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
  try {
    GM_xmlhttpRequest({
      method: 'POST', url, timeout: timeoutMs || 15000,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (c.apiKey || '') },
      data: JSON.stringify({ model: c.model || 'deepseek-chat', messages, temperature: 0, stream: false }),
      onload: r => {
        try { const j = JSON.parse(r.responseText); cb((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || null); }
        catch (e) { cb(null); }
      },
      onerror: () => cb(null), ontimeout: () => cb(null)
    });
  } catch (e) { cb(null); }
}

/* —— AI 扫描映射（同义选项消歧 + 未命中字段补映射）：
   输入：待定 select/单选/多选行 + 未命中字典的可填控件 + 脱敏档案键值表（mapDigest）
   输出：{i, action:'key'|'pick'|'skip', key?, value?, why?}；一次批量调用，默认脱敏
   落地校验（防幻觉）：pick 必须命中控件现有选项；key 必须能在本机档案解析出非空值；
   MAP_CACHE 按字段签名缓存，深扫逐卡时不重复送审 */
const MAP_CACHE = new Map();
function llmMapReady() { return llmReady() && llmCfg().scanMap !== false; }
function mapDigest(plain) {
  const P = Store.getProfile().base || {};
  const flat = {};
  const put = (k, v) => { if (v != null && String(v).trim() !== '') flat[k] = String(v).slice(0, 100); };
  const pb = P.basic || {};
  for (const k of ['name', 'email', 'gender', 'politicalStatus', 'nation', 'maritalStatus', 'health', 'hometown', 'hukou', 'address', 'cityNow', 'cityExpected', 'cityExpected2', 'salaryExpected', 'job', 'qq', 'wechat', 'englishLevel', 'englishScore', 'graduationDate', 'availableFrom', 'jobNature', 'hobby', 'speciality', 'stature', 'weight', 'hukouNature', 'homePlace', 'isForeignStudent', 'gaokaoSource', 'nameSpellAbb', 'github']) put('basic.' + k, pb[k]);
  put('basic.phone', plain ? pb.phone : (pb.phone ? String(pb.phone).slice(0, 2) + '****' : ''));
  (P.education || []).forEach((e, i) => { for (const k of ['school', 'schoolName', 'schoolProvince', 'schoolType', 'major', 'majorDirection', 'degree', 'degreeFull', 'degreeType', 'eduType', 'eduLength', 'gradePointType', 'gpa', 'avgScore', 'rank', 'startDate', 'endDate', 'isHighest', 'researchArea']) put('education.' + i + '.' + k, e[k]); });
  (P.internships || []).forEach((it, i) => { for (const k of ['company', 'position', 'range', 'startDate', 'endDate']) put('internships.' + i + '.' + k, it[k]); put('internships.' + i + '.description', String(it.description || '').slice(0, 60)); });
  (P.family || []).forEach((f, i) => { for (const k of ['name', 'relation', 'workplace', 'duty']) put('family.' + i + '.' + k, f[k]); });
  if (P.skills && P.skills.length) put('skills', P.skills.join('、'));
  put('skillSummary', String(P.skillSummary || '').slice(0, 120));
  return flat;
}
/** 落地 LLM 映射结果；成功返回 true */
function applyMapResult(r, ret, P) {
  if (!r || !ret || ret.action === 'skip') return false;
  if (ret.action === 'pick') {
    const v = String(ret.value || '').trim();
    if (!v || isPlaceholderOpt(v)) return false;
    if (r.kind === 'select') {
      const o = matchSelectOption([...r.el.options], v);
      if (!o || isPlaceholderOpt(o.text)) return false;
      r.value = (o.text || '').trim();
    } else if (r.kind === 'radio') {
      const hit = (r.group || []).some(g => { const L = optionLabel(g.el || g); return L && (L === v || L.includes(v) || v.includes(L)); });
      if (!hit) return false;
      r.value = v;
    } else if (r.kind === 'checkbox' || r.kind === 'tags') {
      const v2 = String(ret.value || '').trim();
      const hit = (r.group || []).some(g => { const L = optionLabel(g.el || g); return L && (L === v2 || L.includes(v2) || v2.includes(L)); });
      if (!hit) return false;
      r.kind = 'tags'; r.values = [v2]; r.value = v2;
    } else if (r.kind === 'autocomplete' || r.kind === 'widget') {
      r.value = v;
    } else return false;
  } else if (ret.action === 'key') {
    const key = String(ret.key || '').trim();
    if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/i.test(key)) return false;
    const val = pathGet(P, key);
    if (val == null || String(val).trim() === '') return false;
    const v = Array.isArray(val) ? val.join('、') : String(val);
    if (r.kind === 'select') {
      const o = matchSelectOption([...r.el.options], v);
      if (!o || isPlaceholderOpt(o.text)) return false;
      r.value = (o.text || '').trim();
    } else if (r.kind === 'radio') { r.value = v; }
    else if (r.kind === 'checkbox' || r.kind === 'tags') { r.kind = 'tags'; r.values = [v]; r.value = v; }
    else { r.value = v; }
    ret.value = v;
  } else return false;
  if (r.manual) { r.manual = false; if (r.conf === 'low') r.conf = 'mid'; }
  else if (r.conf === 'low') r.conf = 'mid';
  r.checked = true; r._llmMap = true;
  r.note = '🤖 AI 映射 · 请核对' + (ret.why ? ' · ' + String(ret.why).slice(0, 40) : '');
  return true;
}
/** 收集待映射字段 + 一次批量送审（cb(应用行数)）；无内容/未启用立即回调 */
function runLlmMap(rows, P, cb) {
  if (!llmMapReady()) return cb(0);
  const items = [], refs = [];
  let applied = 0;
  for (const r of rows) {
    if (items.length >= 40) break;
    if (r.kind === 'file' || r.frameWin || r._llmMap || r._qa) continue;
    if (r._d && !['select', 'widget', 'radio', 'checkbox', 'tags'].includes(r.kind)) continue;
    if (!r._d && !r.manual) continue;
    const isTextual = r.kind === 'text' || r.kind === 'textarea' || r.kind === 'autocomplete' || r.kind === 'ce';
    if (isTextual && !r.manual && r.value) continue;
    let options = null;
    try {
      if (r.kind === 'select') options = [...r.el.options].map(o => (o.text || '').trim()).filter(o => o && !isPlaceholderOpt(o)).slice(0, 80);
      else if (r.kind === 'radio' || r.kind === 'checkbox' || r.kind === 'tags') options = (r.group || []).map(g => optionLabel(g.el || g)).filter(o => o && !isPlaceholderOpt(o)).slice(0, 30);
    } catch (e) {}
    if ((!options || !options.length) && !(isTextual && r.manual)) continue;
    const sig = [r.ctlLabel || r.label, r.kind, (options || []).join('|').slice(0, 200), r.arrIdx || 0].join('||');
    const cache = MAP_CACHE.get(sig);
    if (cache) { if (applyMapResult(r, cache, P)) applied++; continue; }
    items.push({ i: items.length, label: r.ctlLabel || r.label, kind: r.kind, current: String(r.value || '').slice(0, 30),
      options: options || undefined, placeholder: (r.el && r.el.getAttribute) ? (r.el.getAttribute('placeholder') || '') : undefined, _sig: sig });
    refs.push(r);
  }
  if (!items.length) return cb(applied);
  const plain = llmCfg().plain === true;
  const req = { profile: mapDigest(plain), fields: items.map(x => { const y = Object.assign({}, x); delete y._sig; return y; }) };
  llmBusy = true;
  toast('AI 扫描映射中 · ' + items.length + ' 个字段一次送审' + (plain ? '（明文）' : '（已脱敏）') + '…');
  llmChat([
    { role: 'system', content: '你是网申表单字段映射器。profile=求职者档案（键→值，可能脱敏）；fields=页面控件（label=控件标签，kind=控件类型，current=规则层现值，options=候选选项，placeholder=占位提示）。为每个字段输出：action="key" 从 profile 精确选一个键（文本类控件只能用这个）；action="pick" 从该控件 options 里原样复制一个选项（select/radio/checkbox）；action="skip" 判断不出。只输出 JSON 数组 [{"i":序号,"action":"key|pick|skip","key":"...","value":"...","why":"简短原因"}]，不要解释、不要代码块围栏。绝不编造 profile 里不存在的键或值；options 里没有的绝不 pick。' },
    { role: 'user', content: JSON.stringify(req) }
  ], out => {
    llmBusy = false;
    let arr = null;
    try { const m = String(out || '').match(/\[[\s\S]*\]/); if (m) arr = JSON.parse(m[0]); } catch (e) {}
    if (!Array.isArray(arr)) { toast('AI 扫描映射不可用 · 规则层结果生效', 'warn'); return cb(applied); }
    let n = applied;
    for (const ret of arr) {
      const r = refs[ret && ret.i];
      if (!r) continue;
      if (items[ret.i] && items[ret.i]._sig) { try { MAP_CACHE.set(items[ret.i]._sig, { action: ret.action, key: ret.key, value: ret.value, why: ret.why }); } catch (e) {} }
      if (applyMapResult(r, ret, P)) n++;
    }
    if (n) { renderRows(); toast('AI 映射：' + n + ' 项（🤖 标注 · 请核对）'); }
    else toast('AI 映射：无需补充');
    cb(n);
  }, 30000);
}
/** 深扫逐卡：给定行集合跑一次映射（Promise 版） */
function llmMapRows(rows, P) {
  return new Promise(resolve => { try { runLlmMap(rows, P, n => resolve(n || 0)); } catch (e) { resolve(0); } });
}
/** 扫描后入口：映射完成再跑语义复核（串行，复用 llmBusy 互斥） */
function maybeLlmMap(cb) {
  if (!llmMapReady()) return cb && cb();
  const P = mergedProfile(Store.getProfile(), ui.varSel.value || '');
  runLlmMap(ROWS, P, () => { cb && cb(); });
}

/** 第二道复核：全部待填行打包成一次请求；返回 [{i,ok,why,suggest}]，!ok 行取消勾选并加 AI note */
function maybeLlmReview() {
  if (llmBusy || !llmReady()) return;
  const rows = ROWS.filter(r => !r.manual && !r.frameWin && r.el && r._d && !r._tpl && !r.semBad && String(r.value || '').trim()
    && !['date', 'range', 'longtext', 'tags'].includes(r._d.valueType));
  if (rows.length < 2) return;
  const plain = llmCfg().plain === true;
  const items = rows.map((r, i) => {
    const vt = r._d.vtype || '';
    let val = String(r.value);
    if (!plain && (r.sensitive || vt === 'idcard' || vt === 'phone')) val = '（已脱敏·' + (vt === 'idcard' ? '身份证号' : '电话号码') + '）';
    return { i, label: r.label, ctlLabel: r.ctlLabel || r.label, kind: r.kind, type: vt || r._d.valueType, value: val.slice(0, 80) };
  });
  llmBusy = true;
  toast('AI 复核中 · ' + items.length + ' 行一次批量送审' + (plain ? '（明文）' : '（已脱敏）') + '…');
  llmChat([
    { role: 'system', content: '你是网申表单填充校验器。输入是即将填入网申表单的字段清单：label=字段含义，ctlLabel=页面控件标签原文，kind=控件类型，type=值类型，value=拟填值。逐项判断：①标签与值语义是否相符（如姓名栏填了考试成绩、手机号栏填了邮箱、籍贯只填了省没填市）；②值本身是否合理（手机号 11 位、身份证 18 位、日期格式、占位文本）；③语义相符但表述不同的同义项（如「全日制统招」↔页面选项「普通全日制」、「学士」↔「工学学士」）也判 ok=false，并在 suggest 里给出页面应选的准确表述（若是有选项列表的下拉，必须是选项原文之一）。只输出 JSON 数组：[{"i":行号,"ok":布尔,"why":"原因","suggest":"建议值"}]，不要解释、不要代码块围栏；全部相符输出 []。' },
    { role: 'user', content: JSON.stringify(items) }
  ], out => {
    llmBusy = false;
    if (out == null) { toast('AI 复核不可用 · 规则校验层结果生效', 'warn'); return; }
    let arr = null;
    try { const m = String(out).match(/\[[\s\S]*\]/); if (m) arr = JSON.parse(m[0]); } catch (e) {}
    if (!Array.isArray(arr)) { toast('AI 复核返回无法解析 · 规则校验层结果生效', 'warn'); return; }
    let bad = 0, fixed = 0;
    for (const it of arr) {
      const r = rows[it && it.i];
      if (!r || !it || it.ok !== false) continue;
      const sg = String(it.suggest || '').trim();
      if (sg && r.kind === 'select' && r.el && r.el.options) {          // 同义选项：建议能命中现有选项 → 直接修正落地
        const o = matchSelectOption([...r.el.options], sg);
        if (o) {
          r.value = (o.text || '').trim();
          r._llmMap = true; r.checked = true;
          r.note = '🤖 AI 修正为「' + r.value + '」 · 请核对';
          auditPush({ t: new Date().toISOString(), host: location.host, frame: 'llm', conf: 'llm', ok: true, label: r.label, value: auditMask(r.value, r.sensitive) });
          fixed++;
          continue;
        }
      }
      bad++;
      r.llmBad = true; r.checked = false;
      r.note = 'AI: ' + String(it.why || '语义存疑').slice(0, 60) + (it.suggest ? ' · 建议: ' + String(it.suggest).slice(0, 40) : '');
      auditPush({ t: new Date().toISOString(), host: location.host, frame: 'llm', conf: 'llm', ok: false, label: r.label, value: auditMask(String(it.why || ''), false) });
    }
    renderRows();
    toast(fixed || bad ? ('AI 复核：' + (fixed ? '修正 ' + fixed + ' 行' : '') + (bad ? (fixed ? ' · ' : '') + '拦下 ' + bad + ' 行（请人工确认）' : '')) : 'AI 复核：全部相符');
  });
}

/** 开放题 AI 代笔：JD + 档案要点 → 定制初稿（写入列表顶部 🤖 草稿，走插入/复制通道，不写 profile.json） */
async function genDraft() {
  const c = llmCfg();
  if (!c.baseUrl || !c.apiKey) { toast('先在设置里填好 Base URL 和 API Key', 'warn'); return; }
  if (typeof GM_xmlhttpRequest !== 'function') { toast('需要 Tampermonkey 环境才能联网调用（测试直载模式不可用）', 'warn'); return; }
  if (c.draft === false) { toast('已在设置里关闭「开放题代笔」', 'warn'); return; }
  const jd = ui.draftJd.value.trim();
  if (jd.length < 30) { toast('JD 太短：先粘贴职位描述，或点「抓取本页 JD」', 'warn'); return; }
  const P = mergedProfile(Store.getProfile(), ui.varSel.value || '');
  const e1 = (P.education && P.education[0]) || {};
  const brief = {
    姓名: P.basic.name, 学校: e1.school || '', 专业: e1.major || '', 毕业时间: e1.endDate || '',
    求职方向: P.basic.job || '', 技能: P.skills,
    项目: (P.projects || []).map(p => p.name + '（' + p.role + '，' + p.range + '）'),
    实习: (P.internships || []).map(it => it.company + '·' + it.position + '（' + it.range + '）'),
    技能自述: String(P.skillSummary || '').slice(0, 500)
  };
  const typeName = ui.draftType.value;
  ui.draftBtn.disabled = true; ui.draftBtn.textContent = '生成中…';
  llmChat([
    { role: 'system', content: '你是求职文书代笔。根据 JD 与求职者档案写一段可直接粘贴使用的中文' + typeName + '，300-600 字，第一人称。要求：紧扣 JD 的岗位要求与公司业务；只使用档案里存在的事实，绝不编造经历、技能或数字；语气专业自然，不堆砌形容词。只输出正文本身，不要标题、引号或任何解释。' },
    { role: 'user', content: '【JD】\n' + jd.slice(0, 2500) + '\n\n【求职者档案要点】\n' + JSON.stringify(brief, null, 1) + '\n\n【文风参考（该求职者的自我介绍）】\n' + String(P.selfIntro || '').slice(0, 300) }
  ], out => {
    ui.draftBtn.disabled = false; ui.draftBtn.textContent = 'AI 生成初稿';
    if (out == null) { toast('AI 生成失败 · 检查接口配置或稍后再试', 'bad'); return; }
    const content = String(out).replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    if (!content) { toast('AI 返回为空', 'bad'); return; }
    AI_DRAFT = { title: '🤖 ' + typeName + ' · AI 初稿（本机草稿）', content, type: 'aiDraft', tags: ['AI 草稿'] };
    renderOQ();
    toast('AI 初稿已生成 · 在开放题列表顶部，改两句就能用');
  }, 60000);
}
ui.draftBtn.addEventListener('click', () => { genDraft(); });
ui.draftGrab.addEventListener('click', () => {
  const t = ((document.body && document.body.innerText) || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000);
  if (!t) { toast('页面没有可抓取的正文', 'warn'); return; }
  ui.draftJd.value = t;
  toast('已抓取页面正文前 3000 字 · 请确认是职位描述');
});

function renderSiteQa() {
  const n = Object.keys(Store.siteQA()[location.host] || {}).length;
  if (ui.qaCnt) ui.qaCnt.textContent = n ? '已记 ' + n + ' 条。' : '暂无。';
}
ui.qaClr.addEventListener('click', () => {
  const m = Store.get(K_SITEQA, {}) || {};
  m[location.host] = {}; m._noseed = 1;
  Store.saveSiteQA(m);
  renderSiteQa();
  toast('已清除本站问答记忆（不影响 Profile）');
});

/* —— 页面向 Profile 采集：把页面上已手工填好的内容反向读回本地档案（只读页面、零网络、绝不触碰提交/文件） —— */
function readControlValue(r) {
  if (r.kind === 'widget') {
    const inp = r.host && r.host.querySelector('input');
    return { v: inp ? String(inp.value || '').trim() : '' };
  }
  if (r.kind === 'radio' || r.kind === 'checkbox') {
    const items = (r.group && r.group.length ? r.group : [r]).map(g => g.el || g).filter(Boolean);
    const on = items.filter(el => { try { return !!el.checked; } catch (e) { return false; } });
    return { v: on.map(optionLabel).filter(Boolean).join(' / ') };
  }
  if (r.kind === 'select') {
    const o = r.el.selectedOptions && r.el.selectedOptions[0];
    return { v: o ? o.text.trim() : '' };
  }
  const el = r.el;
  const raw = el && el.value !== undefined && el.value !== null ? String(el.value) : (el && el.textContent || '');
  return { v: String(raw || '').trim() };
}
ui.harvBtn.addEventListener('click', async () => {
  toast('正在采集本页已填内容（只读操作，不写入页面）…');
  await rescan(false);
  const profile = Store.getProfile();
  let ok = 0, qa = 0, skipNo = 0, skipTpl = 0, skipFrame = 0;
  for (const r of ROWS) {
    try {
      if (r.frameWin) { skipFrame++; continue; }                       // 子框架行：值为计划值非页面现值，跳过
      if (r.kind === 'file') continue;                                 // 永不触碰文件控件
      if (r._qa) {                                                     // 问答行 → 只记本站
        const g = readControlValue(r);
        if (g.v && g.v !== '—') { stageSiteQA(r.label, g.v); qa++; }
        continue;
      }
      if (r.manual) {                                                  // 未命中字典的组：协议类单选框跳过，其余按问答/自定义分流
        const g = readControlValue(r);
        if (!g.v || (r.kind === 'checkbox' && (!r.group || r.group.length <= 1))) continue;
        if (LEARN_DENY.test(r.label)) continue;
        if (SITEQA_PAT.test(r.label)) { stageSiteQA(r.label, g.v); qa++; }
        else { stageCustom(r.label, g.v); skipNo++; }
        continue;
      }
      if (!r._d || r.conf === 'low') { skipNo++; continue; }           // 低置信不回写，防脏数据
      if (r._tpl) { skipTpl++; continue; }                             // 模板行跳过：不让学生用单页文本覆盖模板真身
      const d = r._d;
      const g = readControlValue(r);
      const v = canonLearnValue(d, g.v);
      if (!v) continue;
      if (d.arrayKey && d.valueType === 'tags') {                      // 技能等多选：整组替换
        const vals = g.v.split(' / ').map(s => s.trim()).filter(Boolean);
        if (JSON.stringify(profile.base[d.arrayKey] || []) !== JSON.stringify(vals)) { profile.base[d.arrayKey] = vals; ok++; }
      } else if (d.arrayKey) {                                         // 经历数组：按段对位，缺的段自动补建（页面比 Profile 全时扩容）
        const arr = profile.base[d.arrayKey] = profile.base[d.arrayKey] || [];
        while (arr.length <= (r.arrIdx || 0)) arr.push({});
        const it = arr[r.arrIdx || 0];
        if (it[d.leaf] !== v) { it[d.leaf] = v; ok++; }
      } else {                                                         // 标量：同名覆盖
        const keys = d.key.split('.');
        let o = profile.base;
        for (let i = 0; i < keys.length - 1; i++) { o[keys[i]] = o[keys[i]] || {}; o = o[keys[i]]; }
        const lk = keys[keys.length - 1];
        if (o[lk] !== v) { o[lk] = v; ok++; }
      }
    } catch (e) { skipNo++; }
  }
  Store.saveProfile(profile);
  commitLearn();                                                       // 分流出去的问答/自定义队列落库（其提示会被下方覆盖）
  renderProfileView();
  ui.impArea.value = JSON.stringify(profile, null, 2);                 // 最新全文放到文本框，手动复制（不自动进剪贴板）
  toast('采集完成：回写 ' + ok + ' 项 · 本站问答 ' + qa + ' 项 · 跳过（未匹配 ' + skipNo + ' · 模板 ' + skipTpl + ' · 子框架 ' + skipFrame + '）· 文本框为最新 Profile 全文，请复制存回 profile.json');
});

/* —— 诊断报告：本页全部控件 → 结构化文本（只读、零网络；平台适配开发的测绘工具） —— */
function buildDiagReport() {
  const L = [];
  const ad = activeAdapter();
  L.push('AF-FILL DIAG v' + VER);
  L.push('URL: ' + location.href);
  L.push('TITLE: ' + document.title);
  L.push('PLATFORM: ' + (ad ? ad.id + ' — ' + ad.note : '通用（未命中已知平台）'));
  const controls = scanControls();
  L.push('CONTROLS: ' + controls.length + ' · FRAMES: ' + window.frames.length);
  const qaHost = Store.siteQA()[location.host] || {};
  controls.forEach(c => {
    const lb = labelFor(c);
    c.labelText = lb.t; c.labelWeight = lb.w; c.labelSource = lb.s;
    const cand = candidatesFor(c)[0];
    let v = '';
    try {
      v = c.kind === 'select' ? (c.el.selectedOptions && c.el.selectedOptions[0] ? c.el.selectedOptions[0].text : '')
        : c.kind === 'radio' || c.kind === 'checkbox' ? (c.el.checked ? '✓' : '○') + optionLabel(c.el)
        : String(c.el.value || '');
    } catch (e) {}
    const bits = [
      '#' + (c.domIdx + 1), c.kind,
      c.name ? 'name=' + c.name : '', c.id ? 'id=' + c.id : '',
      c.placeholder ? 'ph=' + c.placeholder : '',
      'label[' + lb.s + '×' + lb.w + ']=' + (lb.t || '∅'),
      cand ? '→ ' + cand.d.key + ' @' + cand.score.toFixed(2) : '→ 未命中字典',
      lb.t && qaHost[String(lb.t).toLowerCase()] != null ? '[本站问答]' : '',
      'val=' + (v.length > 24 ? v.slice(0, 24) + '…' : v || '空')
    ];
    L.push(bits.filter(Boolean).join(' | '));
  });
  return L.join('\n');
}
$('.diagBtn', root).addEventListener('click', () => {
  ui.impArea.value = buildDiagReport();
  root.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x.dataset.tab === 'profile'));
  root.querySelectorAll('.pane').forEach(x => x.classList.toggle('on', x.dataset.pane === 'profile'));
  toast('诊断报告已生成在 Profile 页文本框 · 请手动全选复制');
});

/* —— 检测附件上传 → 自动扫描 + 自动填充（脚本不读取文件内容，数据来自本地 Profile） —— */
document.addEventListener('change', e => {
  if (!e.isTrusted) return;
  const el = e.target;
  if (el && el.type === 'file' && el.files && el.files.length && !(el.closest && el.closest('#af-host'))) {
    togglePanel(true);
    /* rescan 是异步的（含 iframe 合并，最长 ~1s）：必须 await 完再取 targets，
       否则子框架字段还没并进来就开填（漏填 iframe 表单） */
    (async () => {
      await rescan(false);
      if (Store.settings().autoFillUpload === false) {
        toast('检测到附件上传 · 已扫描本页（不读取文件内容，数据来自本地 Profile）');
        return;
      }
      const targets = ROWS.filter(r => r.checked && !r.manual && r.conf !== 'low' && r.value !== '');
      if (!targets.length) { toast('检测到附件上传 · 本页没有可自动填充的项，请在清单中核对'); return; }
      toast('检测到附件上传 · 正在按本地 Profile 自动填充（不读取文件内容）…');
      doFill();
    })();
  }
}, true);

/* ================= 10b DEEP（分区式表单全程扫描 / 逐区填充 · 适配器驱动） =================
   适用于 z1~z9 分区式简历（中石油）：每个分区独立编辑/保存，未保存编辑切区可能丢弃。
   扫描按钮 → 全程扫描（逐区打开/补卡取证）；执行填充 → 逐区填充并点「保存X」（绝不碰最终提交/完整性校验/附件上传）。 */
let DEEP = null;   // { adapter, secs, busy }
function deepSecs() {
  const ad = activeAdapter();
  if (!ad || !ad.deep || typeof ad.sections !== 'function') return null;
  try { const s = ad.sections(); return (s && s.length) ? { ad, secs: s } : null; } catch (e) { return null; }
}
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  for (;;) {
    let ok = false; try { ok = !!fn(); } catch (e) {}
    if (ok) return true;
    if (Date.now() - t0 > (ms || 2000)) return false;
    await sleep(step || 120);
  }
}
function secEditable(sec) {
  try {
    return [...sec.root.querySelectorAll('input,textarea,select')].some(el =>
      isVisible(el) && !['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes((el.type || '').toLowerCase()));
  } catch (e) { return false; }
}
function secClickables(sec) {
  try {
    const leaf = [...sec.root.querySelectorAll('a,button,span,div')].filter(e => {
      if (!isVisible(e) || e.children.length > 1) return false;
      const own = cleanLabel(ownText(e, null));
      return own.length >= 2 && own.length <= 18;      // 自身直接文字（排除包着按钮的容器 div）
    });
    /* 最深文字载体：丢弃「文字其实挂在其子元素上」的外层容器（如 <div><span>修改</span></div> 只留 span） */
    return leaf.filter(e => {
      const own = cleanLabel(ownText(e, null));
      return ![...e.children].some(ch => cleanLabel(ownText(ch, null)) === own);
    });
  } catch (e) { return []; }
}
async function activateSection(sec) {
  if (isVisible(sec.root)) return true;
  const nav = sec.navEl.querySelector ? (sec.navEl.querySelector('a,span') || sec.navEl) : sec.navEl;
  clickOnce(nav);
  return await waitFor(() => isVisible(sec.root), 2600, 120);
}
/** 打开第 k 段卡片：已有保存记录 → 点第 k 条「修改」；否则点「添加X」（防止把已存经历重复添加） */
async function openCard(sec, k) {
  if (!(await activateSection(sec))) return false;
  if (k === 0 && secEditable(sec)) return true;                   // 正在编辑（未保存态）直接复用
  const mods = secClickables(sec).filter(el => cleanLabel(ownText(el, null)) === '修改');
  if (k < mods.length) {
    clickOnce(mods[k]);
    if (await waitFor(() => secEditable(sec), 2600, 120)) return true;
    return false;
  }
  const core = sec.name.replace(/[／/].*$/, '').slice(0, 4);
  let addBtn = null;
  for (const el of secClickables(sec)) {
    const t = cleanLabel(ownText(el, null));
    if (/^添加/.test(t) && (t.includes(core) || t.includes(sec.name.slice(0, 2)))) { addBtn = el; break; }
  }
  if (!addBtn) return false;
  clickOnce(addBtn);
  return await waitFor(() => secEditable(sec), 2800, 120);
}
/** 点该分区的保存按钮（排除 提交/完整性校验；返回是否已离开编辑态） */
async function saveSection(sec) {
  const core = sec.name.replace(/[／/].*$/, '').slice(0, 4);
  let btn = null;
  for (const el of secClickables(sec)) {
    const t = cleanLabel(ownText(el, null));
    if (!/^保存/.test(t) || /提交|完整性|校验/.test(t)) continue;
    if (t.includes(core) || t.length <= 8) { btn = el; break; }
  }
  if (!btn) return { ok: false, why: '未找到分区保存按钮' };
  clickOnce(btn);
  const gone = await waitFor(() => !btn.isConnected || !isVisible(btn), 3600, 150);
  return gone ? { ok: true } : { ok: false, why: '保存后未离开编辑态（可能校验未过）' };
}
/** 全程扫描：逐区激活/补首卡 → 收集控件（标 [分区] 前缀）；最后回原分区 */
async function deepScan(keepChecked) {
  const d = deepSecs();
  if (!d) return rescan(keepChecked);
  const variantKey = ui.varSel.value || '';
  const P = mergedProfile(Store.getProfile(), variantKey);
  const activeSec = d.secs.find(s => isVisible(s.root)) || null;
  DEEP = { adapter: d.ad, secs: d.secs, busy: true };
  const acc = [];
  let opened = 0, skipped = 0;
  try {
    for (const sec of d.secs) {
      let want = -1;
      try { want = d.ad.want ? d.ad.want(sec.name, P) : -1; } catch (e) {}
      if (want === 0) continue;                                   // 档案无数据：整区不碰
      if (!(await openCard(sec, 0))) { skipped++; continue; }
      opened++;
      const rows = buildRows(variantKey, sec.root, 0, sec.name);
      rows.forEach(r => { r.step = sec.name; r.label = '[' + sec.name + '] ' + r.label; });
      acc.push(...rows);
    }
  } finally {
    if (activeSec) { try { await activateSection(activeSec); } catch (e) {} }
    if (DEEP) DEEP.busy = false;
  }
  scannedOnce = true;
  lastCount = -1;
  ROWS = acc;
  renderRows();
  const nCk = acc.filter(r => r.checked).length;
  toast('全程扫描：' + opened + ' 个分区 · ' + acc.length + ' 项（默认勾选 ' + nCk + ' 项）' + (skipped ? ' · ' + skipped + ' 个分区未打开' : ''), skipped ? 'warn' : '');
  maybeLlmMap(() => maybeLlmReview());
}
function rowSig(r) { return [r.step || '', r.dictKey || ('L:' + (r.ctlLabel || r.label)), r.arrIdx || 0, r.ctlLabel || ''].join('|'); }
/** 临时接管 alert/confirm/prompt：自动保存不被原生弹窗卡死；消息记录进返回值 */
function patchDialogs() {
  const orig = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
  const msgs = [];
  try { window.alert = m => { msgs.push('alert: ' + m); }; } catch (e) {}
  try { window.confirm = m => { msgs.push('confirm: ' + m); return true; }; } catch (e) {}
  try { window.prompt = m => { msgs.push('prompt: ' + m); return ''; }; } catch (e) {}
  return { orig, msgs };
}
function restoreDialogs(p) { try { window.alert = p.orig.alert; window.confirm = p.orig.confirm; window.prompt = p.orig.prompt; } catch (e) {} }
/** 逐区填充：每段卡片 重新扫描(带段偏移) → 采纳面板勾选 → AI 映射 → 填充 → 保存该区 */
async function doFillDeep() {
  const d = DEEP;
  if (!d || !d.adapter || activeAdapter() !== d.adapter) return;
  const variantKey = ui.varSel.value || '';
  const P = mergedProfile(Store.getProfile(), variantKey);
  const prev = new Map(ROWS.map(r => [rowSig(r), r]));
  const patch = patchDialogs();
  let done = 0, fail = 0, llmN = 0;
  const warns = [];
  ui.fillBtn.disabled = true;
  try {
    for (const sec of d.secs) {
      let want = -1;
      try { want = d.adapter.want ? d.adapter.want(sec.name, P) : -1; } catch (e) {}
      if (want < 1) continue;
      for (let k = 0; k < want; k++) {
        if (!(await openCard(sec, k))) { warns.push(sec.name + ' 第' + (k + 1) + '段：未找到入口'); break; }
        const rows = buildRows(variantKey, sec.root, k, sec.name);
        rows.forEach(r => { r.step = sec.name; });
        rows.forEach(r => {                                        // 采纳面板上的人工勾选/AI 映射值
          const p = prev.get(rowSig(r));
          if (p) { r.checked = p.checked; if (p._llmMap && String(p.value || '').trim()) r.value = p.value; }
        });
        if (llmMapReady() && llmCfg().scanMap !== false) { try { llmN += await llmMapRows(rows, P); } catch (e) {} }
        const targets = rows.filter(r => r.checked && !r.manual && r.conf !== 'low' && r.value !== '' && r.kind !== 'file');
        for (const r of targets.sort((a, b) => a.domIdx - b.domIdx)) {
          const res = await fillRow(r);
          auditPush({ t: new Date().toISOString(), host: location.host, frame: 'top', conf: r.conf, ok: !!res.ok,
            label: r.label, value: auditMask(res.ok ? r.value : '', r.sensitive) });
          if (res.ok) { done++; if (r.el) flashEl(r.el, 'af-flashV'); }
          else { fail++; warns.push(r.label + '：' + (res.why || '填充失败')); if (r.el) flashEl(r.el, 'af-flashY'); }
        }
        if (targets.length) {
          const sv = await saveSection(sec);
          if (!sv.ok) warns.push(sec.name + ' 第' + (k + 1) + '段：' + sv.why);
        }
      }
    }
  } finally {
    restoreDialogs(patch);
    ui.fillBtn.disabled = !ROWS.some(x => x.checked);
  }
  if (patch.msgs.length) warns.push('页面弹窗：' + patch.msgs.slice(0, 3).join(' / ').slice(0, 140));
  ui.dc.textContent = done; ui.sc.textContent = fail + warns.length;
  ui.doneBanner.classList.add('on');
  toast(warns.length ? ('全程填充：已填 ' + done + ' 项 · ' + warns.length + ' 项需人工核对（逐区保存）') : ('全程填充：' + done + ' 项已填并逐区保存 · 请逐项核对'), warns.length ? 'warn' : '');
}

/* ================= 11 OBSERVER（SPA 分步表单 → 提示重扫） ================= */
let lastCount = -1, obsTimer;
function watchDom() {
  if (!document.body || !window.MutationObserver) return;
  new MutationObserver(() => {
    clearTimeout(obsTimer);
    obsTimer = setTimeout(() => {
      if (!scannedOnce) return;
      if (DEEP && DEEP.busy) return;                 // 全程扫描/逐区填充中：DOM 变化属预期，不提示
      const n = scanControls().length;
      if (lastCount === -1) lastCount = n;
      else if (n !== lastCount) { ui.dirty.classList.add('on'); lastCount = n; }
    }, 700);
  }).observe(document.body, { childList: true, subtree: true });
}

/* ================= 12 BOOT ================= */
function boot() {
  injectPageCss();
  document.documentElement.appendChild(host);
  const s = Store.settings();
  if (s.disabled[location.host]) host.style.display = 'none';
  try {
    renderSiteSw(); renderLearnSw(); renderUpSw(); renderDbgSw(); renderLlm(); renderSiteQa(); renderAudit(); renderVariants(); renderProfileView(); renderOQ(); renderCtx();
  } catch (e) { console.warn('[AF-Fill] 面板初始化部分失败（球与扫描仍可用）', e); }
  extendDict(Store.getProfile());
  wireLearn();
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('网申快填 · 打开/收起面板', () => togglePanel());
      GM_registerMenuCommand('网申快填 · 本站停用/启用', () => ui.siteSw.click());
    }
  } catch (e) {}
  watchDom();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

})();
