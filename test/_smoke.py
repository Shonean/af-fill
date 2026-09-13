import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _util import ensure_pdf, load_fixture  # noqa: E402

PDF = ensure_pdf()
PROFILE = load_fixture()
B = PROFILE['base']['basic']
EDU = PROFILE['base']['education'][0]
INTERNS = PROFILE['base']['internships']
PROJECTS = PROFILE['base']['projects']

PASS, FAIL = [], []


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(f'{name} {detail}')


with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8080/test/mock-generic.html')
    pg.wait_for_timeout(1200)
    pg.evaluate("prof => localStorage.setItem('af:af.profile', JSON.stringify(prof))", PROFILE)
    pg.reload()
    pg.wait_for_timeout(1200)
    pg.set_input_files('#f-cv', PDF)
    pg.wait_for_timeout(12000)
    v = pg.evaluate("""() => {
      const g = id => { const el = document.getElementById(id); return el ? (el.type==='checkbox'||el.type==='radio' ? String(el.checked) : el.value) : null; };
      const gn = n => { const el = document.querySelector('input[name="'+n+'"]'); return el ? el.value : null; };
      return {
        name: g('f-name'), phone: g('f-phone'),
        mail: document.querySelector('input[name=mail_addr]').value,
        genderM: String(document.querySelector('input[name=gender][value=男]').checked),
        pol: g('f-pol'), nation: g('f-nation'),
        hp: g('f-hp'), hc: g('f-hc'), hd: g('f-hd'), mar: g('f-mar'),
        hukou: document.querySelector('input[name=hukou_addr]').value,
        city: g('f-city'), eng: g('f-eng'), idc: g('f-idc'), addr: g('f-addr'), gh: g('f-gh'),
        edu1: gn('edu1_school'), edu1r: gn('edu1_range'), edu2: gn('edu2_school'),
        i1co: g('i1-co'), i2co: g('i2-co'),
        p1na: g('p1-na'), p2na: g('p2-na'), p3na: g('p3-na'),
        skillJava: String(document.querySelector('input[name=skills][value=Java]').checked),
        agree: String(document.querySelector('input[name=agree]').checked),
        intro: g('f-intro').slice(0, 16)
      };
    }""")
    audit = pg.evaluate("() => { try { return JSON.parse(localStorage.getItem('af:af.audit') || '[]'); } catch(e) { return []; } }")
    print('AUDIT:')
    for a in audit:
        print('  ', a.get('ok'), '|', a.get('conf'), '|', a.get('label'), '|', repr(a.get('value'))[:60])
    print('VALUES:', json.dumps(v, ensure_ascii=True))
    check(f'U+3000姓名→{B["name"]}', v['name'] == B['name'], repr(v['name']))
    check('手机号', v['phone'] == B['phone'], repr(v['phone']))
    check('邮箱', v['mail'] == B['email'], repr(v['mail']))
    check('政治面貌=档案值', v['pol'] == B['politicalStatus'], repr(v['pol']))
    check('民族=汉族', v['nation'] == B['nation'], repr(v['nation']))
    check('级联省=江苏省', v['hp'] == '江苏省', repr(v['hp']))
    check('级联市=南京市', v['hc'] == '南京市', repr(v['hc']))
    check('级联区=玄武区', v['hd'] == '玄武区', repr(v['hd']))
    check('婚姻状况=未婚', v['mar'] == '未婚', repr(v['mar']))
    check('户口文本=全文', v['hukou'] == B['hukou'], repr(v['hukou']))
    check('期望城市=南京', v['city'] == '南京', repr(v['city']))
    check('GitHub主页混合标签命中', v['gh'] == B['github'], repr(v['gh']))
    check('英语水平=CET-4', v['eng'] == B['englishLevel'], repr(v['eng']))
    check('敏感身份证未自动填', v['idc'] == '', repr(v['idc']))
    check(f'教育①={EDU["school"]}', v['edu1'] == EDU['school'], repr(v['edu1']))
    check('教育①时间=档案 range', v['edu1r'] == EDU['range'], repr(v['edu1r']))
    check('教育②不复用前段', v['edu2'] == '', repr(v['edu2']))
    check('实习①=档案第1段', v['i1co'] == INTERNS[0]['company'], repr(v['i1co']))
    check('实习②=档案第2段', v['i2co'] == INTERNS[1]['company'], repr(v['i2co']))
    check('项目①=档案第1段', PROJECTS[0]['name'][:4] in v['p1na'], repr(v['p1na']))
    check('项目②=档案第2段', PROJECTS[1]['name'][:4] in v['p2na'], repr(v['p2na']))
    check('项目③=档案第3段', 'WebGL' in v['p3na'], repr(v['p3na']))
    check('协议框未自动勾', v['agree'] == 'false', repr(v['agree']))
    check(f'自我介绍模板占位符展开', v['intro'].startswith('面试官您好，我是' + B['name']), repr(v['intro']))
    check('零console错误', len(errs) == 0, repr(errs[:3]))
    b.close()

print(f'PASS {len(PASS)} / FAIL {len(FAIL)}')
for f in FAIL:
    print('  FAIL:', f)
sys.exit(1 if FAIL else 0)
