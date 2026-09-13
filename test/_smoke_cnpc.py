import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _util import ensure_pdf, load_fixture  # noqa: E402

PDF = ensure_pdf()
PROFILE = load_fixture()
B = PROFILE['base']['basic']

PASS, FAIL = [], []


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(f'{name} {detail}')


with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8080/test/mock-cnpc.html')
    pg.evaluate("prof => localStorage.setItem('af:af.profile', JSON.stringify(prof))", PROFILE)
    pg.reload()
    pg.wait_for_timeout(1200)
    pg.set_input_files('#f-cv', PDF)
    pg.wait_for_timeout(9000)

    v = pg.evaluate("""() => {
      const g = id => { const el = document.getElementById(id); return el ? el.value : null; };
      const radio = n => { const r = document.querySelector('input[name="' + n + '"]:checked'); return r ? r.value : null; };
      return {
        name: g('basicName'), spell: g('nameSpellAbb'), birth: g('basicBirthday'),
        gender: radio('gender'), foreign: radio('foreignStudent'),
        prov: g('domicilePlace'), city: g('domicilePlaceC'),
        mz: g('mz'), hy: g('hy'), hk: g('hk'), sy: g('sy'),
        health: g('healthCondition'), zzmm: g('zzmm'), home: g('homePlace'),
        native: g('nativePlaceName'), stature: g('stature'), weight: g('weight'),
        spec: g('speciality'), hobby: g('hobby')
      };
    }""")
    audit = pg.evaluate("() => { try { return JSON.parse(localStorage.getItem('af:af.audit') || '[]'); } catch (e) { return []; } }")
    print('AUDIT (%d):' % len(audit))
    for a in audit:
        print('  ', a.get('ok'), '|', a.get('conf'), '|', a.get('label'), '|', repr(a.get('value'))[:50])
    print('VALUES:', json.dumps(v, ensure_ascii=True))

    check(f'姓名={B["name"]}', v['name'] == B['name'], repr(v['name']))
    check(f'拼音缩写={B["nameSpellAbb"]}', v['spell'] == B['nameSpellAbb'], repr(v['spell']))
    check(f'出生日期={B["birthDate"]}', v['birth'] == B['birthDate'], repr(v['birth']))
    check('性别=男(value 1)', v['gender'] == '1', repr(v['gender']))
    check('是否留学生=否(value 0)', v['foreign'] == '0', repr(v['foreign']))
    check('户口省=江苏省(320)', v['prov'] == '320', repr(v['prov']))
    check('户口市=南京市(3201)', v['city'] == '3201', repr(v['city']))
    check('民族=汉族(01)', v['mz'] == '01', repr(v['mz']))
    check('婚姻=未婚(1)', v['hy'] == '1', repr(v['hy']))
    check('户口性质=非农业(2)', v['hk'] == '2', repr(v['hk']))
    check('生源地=江苏省(320)', v['sy'] == '320', repr(v['sy']))
    check('健康=健康(1)', v['health'] == '1', repr(v['health']))
    check('政治面貌=群众(4)', v['zzmm'] == '4', repr(v['zzmm']))
    check('家庭所在地=江苏省(320)', v['home'] == '320', repr(v['home']))
    check('籍贯框已填(含玄武)', '玄武' in (v['native'] or ''), repr(v['native']))
    check(f'身高={B["stature"]}', v['stature'] == B['stature'], repr(v['stature']))
    check(f'体重={B["weight"]}', v['weight'] == B['weight'], repr(v['weight']))
    check(f'特长={B["speciality"]}', v['spec'] == B['speciality'], repr(v['spec']))
    check(f'爱好={B["hobby"]}', v['hobby'] == B['hobby'], repr(v['hobby']))
    ok_labels = {a.get('label') for a in audit if a.get('ok')}
    check('审计覆盖 ≥14 项', len(ok_labels) >= 14, str(sorted(ok_labels)))
    check('零console错误', len(errs) == 0, repr(errs[:3]))
    b.close()

print(f'PASS {len(PASS)} / FAIL {len(FAIL)}')
for f in FAIL:
    print('  FAIL:', f)
sys.exit(1 if FAIL else 0)
