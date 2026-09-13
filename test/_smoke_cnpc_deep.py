"""中石油分区式简历 mock · 全程扫描 + 逐区填充回归（Alt+Shift+F 扫描 / Alt+Shift+D 填充）"""
import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _util import load_fixture  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILE = load_fixture()

PASS, FAIL = [], []


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(f'{name} {detail}')


with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    # 用路由把本地 mock 伪装成中石油域名，命中 ADAPTERS.cnpc（分区导航 hooks）
    mock_body = open(os.path.join(ROOT, 'test', 'mock-cnpc.html'), encoding='utf-8').read()
    engine_body = open(os.path.join(ROOT, 'autofill.user.js'), encoding='utf-8').read()
    pg.route('https://zhaopin.cnpc.com.cn/web/createResume.html',
             lambda r: r.fulfill(status=200, content_type='text/html; charset=utf-8', body=mock_body))
    pg.route('https://zhaopin.cnpc.com.cn/autofill.user.js',
             lambda r: r.fulfill(status=200, content_type='application/javascript; charset=utf-8', body=engine_body))
    pg.goto('https://zhaopin.cnpc.com.cn/web/createResume.html')
    pg.evaluate("prof => localStorage.setItem('af:af.profile', JSON.stringify(prof))", PROFILE)
    pg.reload()
    pg.wait_for_timeout(1200)

    pg.keyboard.press('Alt+Shift+F')            # 全程扫描
    pg.wait_for_timeout(8000)
    pg.keyboard.press('Alt+Shift+D')            # 逐区填充 + 分区保存
    pg.wait_for_timeout(25000)

    v = pg.evaluate("""() => {
      const g = id => { const e = document.getElementById(id); return e ? e.value : null; };
      const radio = n => { const r = document.querySelector('input[name="' + n + '"]:checked'); return r ? r.value : null; };
      return {
        edu: { province: g('province'), educationType: g('educationType'), school: g('schoolCode'),
               schoolChina: g('schoolChinaName'), start: g('educationStartDate'), xw: g('xw'), xl: g('xl'),
               end: g('educationEndDate'), major: g('major'), union: g('majorUnionId'), gpt: g('gradePointType'),
               gpa: g('gradePoint'), dir: g('majorDirection'), dtype: radio('degreeType'), rtype: radio('type') },
        lang: { type: g('languageType'), level: g('languageLevel'), first: radio('firstLanguage'), score: g('languageScore') },
        contact: { country: g('contactCountry'), prov: g('contactProvince'), city: g('contactCity'),
                   dist: g('contactDistrict'), addr: g('contactAddress'), phone: g('contactPhone'), mail: g('contactEmail') },
        fam: { name: g('familyName'), rel: g('familyRelation'), wp: g('familyWorkplace'), duty: g('familyDuty'), phone: g('familyPhone') },
        intern: { co: g('internCompany'), pos: g('internPosition'), start: g('internStart'), end: g('internEnd') },
        saves: window.__saves, dialogs: window.__dialogs
      };
    }""")
    audit = pg.evaluate("() => { try { return JSON.parse(localStorage.getItem('af:af.audit') || '[]'); } catch (e) { return []; } }")
    print('AUDIT (%d):' % len(audit))
    for a in audit:
        print('  ', a.get('ok'), '|', a.get('conf'), '|', a.get('label'), '|', repr(a.get('value'))[:44])
    print('VALUES:', json.dumps(v, ensure_ascii=True)[:1500])

    e = v['edu']
    edu = PROFILE['base']['education'][0]
    check('教育省份=江苏省(320)', e['province'] == '320', repr(e['province']))
    check('学历形式=普通全日制(1)', e['educationType'] == '1', repr(e['educationType']))
    check(f'毕业院校={edu["school"]}(320100001)', e['school'] == '320100001', repr(e['school']))
    check('入学时间=2022-09', e['start'] == edu['startDate'], repr(e['start']))
    check('学位=工学学士(408)', e['xw'] == '408', repr(e['xw']))
    check('学历=大学本科(31)', e['xl'] == '31', repr(e['xl']))
    check('毕业时间=2026-06', e['end'] == edu['endDate'], repr(e['end']))
    check('专业=软件工程', e['major'] == edu['major'], repr(e['major']))
    check('专业下拉已点选(unionId≠空)', bool(e['union']), repr(e['union']))
    check('绩点制=五分制(2)', e['gpt'] == '2', repr(e['gpt']))
    check('学分绩点=档案值', e['gpa'] == edu['gpa'], repr(e['gpa']))
    check('专业方向=档案值', e['dir'] == edu['majorDirection'], repr(e['dir']))
    check('学位类型=学术型(1)', e['dtype'] == '1', repr(e['dtype']))
    check('院校类型=境内(1)', e['rtype'] == '1', repr(e['rtype']))

    check('外语语种=英语(1)', v['lang']['type'] == '1', repr(v['lang']['type']))
    check('外语水平=CET-4(1)', v['lang']['level'] == '1', repr(v['lang']['level']))
    check('是否第一外语=是(1)', v['lang']['first'] == '1', repr(v['lang']['first']))
    check('成绩分数=档案值', v['lang']['score'] == PROFILE['base']['basic']['englishScore'], repr(v['lang']['score']))

    b0 = PROFILE['base']['basic']
    check('通讯国家=中国(1)', v['contact']['country'] == '1', repr(v['contact']['country']))
    check('通讯省=江苏省(320)', v['contact']['prov'] == '320', repr(v['contact']['prov']))
    check('通讯市=南京市(3201)', v['contact']['city'] == '3201', repr(v['contact']['city']))
    check('通讯区县=玄武区(320102)', v['contact']['dist'] == '320102', repr(v['contact']['dist']))
    check('通讯地址=档案', v['contact']['addr'] == b0['address'], repr(v['contact']['addr']))
    check('手机号=档案', v['contact']['phone'] == b0['phone'], repr(v['contact']['phone']))
    check('邮箱=档案', v['contact']['mail'] == b0['email'], repr(v['contact']['mail']))

    fam = PROFILE['base']['family'][1]
    rel_val = {'父亲': '1', '母亲': '2', '配偶': '3', '子女': '4'}.get(fam['relation'], '')
    check('家庭第2段=档案第2位(姓名/关系/单位/职位/电话)',
          v['fam']['name'] == fam['name'] and v['fam']['rel'] == rel_val and v['fam']['wp'] == fam['workplace']
          and v['fam']['duty'] == fam['duty'] and v['fam']['phone'] == fam.get('phone', ''),
          json.dumps(v['fam'], ensure_ascii=False))
    it = PROFILE['base']['internships'][1]
    check('实习第2段=档案第2段(单位/职位)', v['intern']['co'] == it['company'] and v['intern']['pos'] == it['position'],
          json.dumps(v['intern'], ensure_ascii=False))

    expect_saves = {'教育背景': 1, '外语水平': 1, '通讯信息': 1, '实习/工作/入伍经历': 2, '家庭成员': 2}
    check('分区保存次数(教育1/外语1/通讯1/实习2/家庭2)', v['saves'] == expect_saves, json.dumps(v['saves'], ensure_ascii=False))
    check('无页面弹窗(校验全过)', len(v['dialogs']) == 0, repr(v['dialogs'][:3]))

    # 第二轮：分区已有保存记录 → 必须走「修改」编辑路径，不得重复添加卡片
    adds1 = pg.evaluate("() => JSON.parse(JSON.stringify(window.__adds || {}))")
    pg.keyboard.press('Alt+Shift+F')
    pg.wait_for_timeout(8000)
    pg.keyboard.press('Alt+Shift+D')
    pg.wait_for_timeout(25000)
    rep = pg.evaluate("() => ({ saves: window.__saves, adds: window.__adds })")
    expect_saves2 = {k: x * 2 for k, x in expect_saves.items()}
    check('二轮：已有记录走「修改」编辑（保存×2）', rep['saves'] == expect_saves2, json.dumps(rep['saves'], ensure_ascii=False))
    check('二轮：未新增卡片（添加次数不变）', rep['adds'] == adds1, json.dumps(rep['adds'], ensure_ascii=False))

    ok_labels = {a.get('label') for a in audit if a.get('ok')}
    need = {'学位', '学历', '专业', '学分绩点', '绩点制', '专业方向', '学历形式', '院校类型', '与本人关系', '家庭成员姓名'}
    miss = {x for x in need if not any(x in (l or '') for l in ok_labels)}
    check('审计覆盖 学位/学历/专业/绩点/方向/学历形式/院校类型/家庭', not miss, str(sorted(miss)))
    check('零console错误', len(errs) == 0, repr(errs[:3]))
    b.close()

print(f'PASS {len(PASS)} / FAIL {len(FAIL)}')
for f in FAIL:
    print('  FAIL:', f)
sys.exit(1 if FAIL else 0)
