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
    pg.goto('http://127.0.0.1:8080/test/mock-iframe-guard.html')
    pg.wait_for_timeout(1200)
    pg.evaluate("prof => localStorage.setItem('af:af.profile', JSON.stringify(prof))", PROFILE)
    pg.reload()
    pg.wait_for_timeout(1200)
    pg.set_input_files('#f-cv', PDF)
    pg.wait_for_timeout(8000)

    real_name = pg.frame_locator('#real').locator('input[name="cand_name"]').input_value()
    real_mobile = pg.frame_locator('#real').locator('input[name="mobile"]').input_value()
    garbage_name = pg.frame_locator('#garbage').locator('input[name="g_name"]').input_value()
    garbage_mail = pg.frame_locator('#garbage').locator('input[name="g_mail"]').input_value()

    print('real frame  cand_name=%r mobile=%r' % (real_name, real_mobile))
    print('garbage     g_name=%r g_mail=%r' % (garbage_name, garbage_mail))

    check('真表单 iframe 正常并入并填充(姓名)', real_name == B['name'], repr(real_name))
    check('真表单 iframe 正常并入并填充(手机)', real_mobile == B['phone'], repr(real_mobile))
    check('无关 iframe 未并入(姓名未被填)', garbage_name == '', repr(garbage_name))
    check('无关 iframe 未并入(邮箱未被填)', garbage_mail == '', repr(garbage_mail))
    check('零console错误', len(errs) == 0, repr(errs[:3]))
    b.close()

print(f'PASS {len(PASS)} / FAIL {len(FAIL)}')
for f in FAIL:
    print('  FAIL:', f)
sys.exit(1 if FAIL else 0)
