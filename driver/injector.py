# -*- coding: utf-8 -*-
"""AF-Fill injector: build the init-script that runs the verbatim engine in driver mode.

Segments stitched together (order matters):
  1. window.__AF_DATA  - profile/settings/siteQA/audit baked in (sync reads by construction)
  2. GM shim + chip    - GM_* globals the engine expects; transport to local workbench
  3. engine source     - autofill.user.js VERBATIM (single source of truth)

The engine double-instance guard (#af-host) makes this safe even on mock pages that
also load the userscript via <script> tag: init script runs first, page copy skips.
"""
import json
import os

import paths

_SHIM_TMPL = """
/* ==== AF-FILL GM SHIM (driver mode) ==== */
(function () {
'use strict';
var D = window.__AF_DATA = window.__AF_DATA || {};
var EP = D.endpoint || 'http://127.0.0.1:8790';
var mem = {};
mem['af.profile'] = D.profile || null;
mem['af.settings'] = D.settings || { disabled: {} };
mem['af.siteQA'] = D.siteQA || {};
mem['af.audit'] = D.audit || [];
if (D.ballPos) mem['af.ballPos'] = D.ballPos;

function report(type, payload) {
  try {
    fetch(EP + '/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ type: type, host: location.host, url: location.href, ts: Date.now() }, payload))
    }).catch(function () {});
  } catch (e) {}
}

window.GM_getValue = function (k) { return (k in mem) ? mem[k] : undefined; };
window.GM_setValue = function (k, v) {
  mem[k] = v;
  try { localStorage.setItem('af:' + k, JSON.stringify(v)); } catch (e) {}
  if (k === 'af.profile' || k === 'af.settings' || k === 'af.siteQA' || k === 'af.ballPos') {
    report('sync', { key: k, value: v });
  }
  if (k === 'af.audit' && Array.isArray(v) && v.length) {
    report('audit', { entry: v[v.length - 1] });   // 最新一笔填充 → 工作台推进台账状态
  }
};
window.GM_deleteValue = function (k) { delete mem[k]; try { localStorage.removeItem('af:' + k); } catch (e) {} };
window.GM_registerMenuCommand = function () {};

/* LLM / cross-origin transport: page -> local workbench /proxy (localhost is
   treated as potentially-trustworthy, so https pages may POST it). */
window.GM_xmlhttpRequest = function (opt) {
  opt = opt || {};
  try {
    fetch(EP + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: opt.url, method: opt.method || 'GET',
        headers: opt.headers || {}, body: opt.data == null ? null : String(opt.data),
        timeout: opt.timeout || 15000 })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.error) { opt.onerror && opt.onerror(j); }
      else { opt.onload && opt.onload({ status: (j && j.status) || 0, responseText: (j && j.text) || '' }); }
    }).catch(function () { opt.onerror && opt.onerror({}); });
  } catch (e) { opt.onerror && opt.onerror(e); }
};
window.__AF_SHIM_READY = true;
})();
"""

_CHIP_JS = """
/* ==== AF-FILL COLLECT CHIP (main frame only) ==== */
(function () {
'use strict';
if (window.top !== window) return;
if (/^(about|chrome|edge):/.test(location.protocol)) return;
if (/^(127\\.0\\.0\\.1|localhost)$/.test(location.hostname)) return;   // 工作台自身页面不挂 chip
if (window.__AF_CHIP) return; window.__AF_CHIP = 1;
var EP = (window.__AF_DATA && window.__AF_DATA.endpoint) || 'http://127.0.0.1:8790';

function post(payload) {
  return fetch(EP + '/event', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ type: 'collect', url: location.href, title: document.title,
      host: location.host, jd: (document.body && document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 3000),
      ts: Date.now() }, payload))
  });
}

var chip = document.createElement('div');
chip.textContent = '+ 台账';
chip.setAttribute('title', 'AF-Fill collect: add this job page to the ledger (Alt+Shift+C)');
chip.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483645;background:#fff;color:#141416;' +
  'border:1px solid rgba(20,20,22,.32);border-radius:99px;padding:5px 12px;font:500 11px/1.4 system-ui,' +
  "'PingFang SC','Microsoft YaHei',sans-serif;cursor:pointer;opacity:.55;box-shadow:0 6px 18px rgba(12,12,16,.14);" +
  'user-select:none';
chip.addEventListener('mouseenter', function () { chip.style.opacity = '1'; });
chip.addEventListener('mouseleave', function () { chip.style.opacity = '.55'; });
chip.addEventListener('click', function () { collect(); });
function collect() {
  chip.textContent = '收录中…';
  post({}).then(function (r) { return r.json(); }).then(function (j) {
    chip.textContent = j && j.ok ? (j.status === 'updated' ? '已在台账' : '已收录 #' + j.id) : 'Failed';
  }).catch(function () { chip.textContent = '驱动未启动'; });
  setTimeout(function () { chip.textContent = '+ 台账'; }, 2600);
}
document.addEventListener('keydown', function (e) {
  if (e.altKey && e.shiftKey && !e.ctrlKey && (e.key === 'C' || e.key === 'c')) { e.preventDefault(); collect(); }
});
function mount() { (document.body || document.documentElement).appendChild(chip); }
if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
"""


def load_engine_source() -> str:
    with open(paths.engine_path(), 'r', encoding='utf-8') as f:
        return f.read()


def build_init_script(profile: dict, settings: dict, siteqa: dict, audit: list,
                      ballpos=None, endpoint: str = 'http://127.0.0.1:8790',
                      engine_src: str = None, with_chip: bool = True) -> str:
    data = {
        'profile': profile,
        'settings': settings or {'disabled': {}},
        'siteQA': siteqa or {},
        'audit': audit or [],
        'ballPos': ballpos,
        'endpoint': endpoint,
    }
    parts = [
        '/* ==== AF-FILL DATA ==== */',
        'window.__AF_DATA = ' + json.dumps(data, ensure_ascii=False) + ';',
        _SHIM_TMPL,
    ]
    if with_chip:
        parts.append(_CHIP_JS)
    parts.append('/* ==== AF-FILL ENGINE (verbatim) ==== */')
    parts.append(engine_src if engine_src is not None else load_engine_source())
    return '\n'.join(parts)
