// 语义闸/区域拆分纯函数静态断言：从 autofill.user.js 抽取源码片段在 Node 中直接执行
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../autofill.user.js', 'utf8');

function slice(startMark, endMark) {
  const a = src.indexOf(startMark);
  const z = src.indexOf(endMark, a);
  if (a < 0 || z < 0) throw new Error('marker not found: ' + startMark + ' / ' + endMark);
  return src.slice(a, z);
}
const code = [
  'const RM = false;',
  slice('const normText =', 'function hasReqMark'),          // normText + cleanLabel
  slice('function normDictLabel', 'function ownText'),        // normDictLabel
  slice('/* ================= 04c REGION', '/* ================= 05 SCANNER')  // REGION + VALIDATE
].join('\n');
const ctx = {};
new Function('exports', code + '\nObject.assign(exports, { cleanLabel, normDictLabel, stripRegionSuffix, splitRegion, detectLevel, VTYPES, STRONG_VT, inferVtype, PROV_RE });')(ctx);
const { cleanLabel, stripRegionSuffix, splitRegion, detectLevel, VTYPES, inferVtype } = ctx;

let n = 0, bad = 0;
const T = (name, cond) => { n++; if (!cond) { bad++; console.log('FAIL:', name); } };

// cleanLabel：U+3000 / 混排 / ASCII
T('cleanLabel U+3000', cleanLabel('姓　名') === '姓名');
T('cleanLabel 混排去空格', cleanLabel('GitHub 主页') === 'GitHub主页');
T('cleanLabel ASCII保留', cleanLabel('First Name') === 'First Name');
T('cleanLabel 括注+星号', cleanLabel('＊籍贯（省）') === '籍贯');
// stripRegionSuffix / splitRegion
T('strip 玄武区', stripRegionSuffix('玄武区') === '玄武');
T('strip 内蒙古自治区', stripRegionSuffix('内蒙古自治区') === '内蒙古');
T('split 全三级', JSON.stringify(splitRegion('江苏省南京市玄武区')) === JSON.stringify({ p: '江苏省', c: '南京市', d: '玄武区' }));
T('split 直辖市区', splitRegion('北京市海淀区').d === '海淀区' && splitRegion('北京市海淀区').c === '');
T('split 两级', splitRegion('江苏省南京市').d === '');
T('split 自治区', splitRegion('新疆维吾尔自治区乌鲁木齐市天山区').p === '新疆维吾尔自治区');
// VTYPES
T('name 中文', VTYPES.name('李雷') && VTYPES.name('欧阳娜娜'));
T('name 拦CET-4', !VTYPES.name('CET-4'));
T('name 英文', VTYPES.name('Chen Yuanpeng'));
T('phone 剥分隔符', VTYPES.phone('138-0013-8000') && VTYPES.phone('13800138000'));
T('phone 拦邮箱', !VTYPES.phone('lilei@example.com'));
T('email', VTYPES.email('lilei@example.com') && !VTYPES.email('13800138000'));
T('idcard', VTYPES.idcard('110101200203150011') && !VTYPES.idcard('110101200213150011') && !VTYPES.idcard('1101012002031500'));
T('level', VTYPES.level('CET-4') && VTYPES.level('英语四级') && VTYPES.level('雅思') && !VTYPES.level('李雷'));
T('number', VTYPES.number('456') && !VTYPES.number('CET-4'));
// inferVtype：标签侧推断（分数优先于等级）
T('infer 姓名', inferVtype('姓名') === 'name' && inferVtype('考生姓名') === 'name');
T('infer 英语成绩→number', inferVtype('英语成绩') === 'number');
T('infer 英语水平→level', inferVtype('英语水平') === 'level');
T('infer 紧急联系电话→phone', inferVtype('紧急联系电话') === 'phone');
T('infer 政治面貌→null', inferVtype('政治面貌') === null);
T('infer 身份证号→idcard', inferVtype('证件号码') === 'idcard');
// detectLevel（伪 options 对象）
const opt = a => a.map(t => ({ textContent: t }));
T('detect 省', detectLevel(opt(['请选择省', '江苏省', '北京市', '山东省', '广东省'])) === 'p');
T('detect 市', detectLevel(opt(['请选择市', '南京市', '苏州市', '无锡市'])) === 'c');
T('detect 区', detectLevel(opt(['请选择区', '玄武区', '秦淮区', '鼓楼区'])) === 'd');
T('detect 样本不足', detectLevel(opt(['请选择市'])) === null);
T('detect 混杂不判', detectLevel(opt([' Flat 3', 'Unit 5', 'Block B'])) === null);

console.log(`VT-TESTS ${n - bad}/${n} PASS`);
process.exit(bad ? 1 : 0);
