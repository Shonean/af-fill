# -*- coding: utf-8 -*-
"""AF-Fill watcher: generic extraction + dedup + candidate pool for job-info aggregator sites.

Design (v0.5, single-source acceptance on gwy.com):
  - fetch mode: get source page -> generic <a>+nearby-date extraction -> BFS follow
    "查看更多/更多/下一页" & pagination-pattern links (depth 2, fetch budget) -> collect
  - dedup (3 layers): exact URL -> normalized-title exact -> fuzzy cluster (difflib >= 0.85)
  - candidate pool: watch/candidates.json {items by dedupKey, ignored keys}; 30-day expiry;
    ignored keys never resurrect (any source)
LLM filtering happens in workbench (batch call), not here.
"""
import difflib
import hashlib
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request

import paths

SOURCES_PATH = paths.data('watch', 'sources.json')
CAND_PATH = paths.data('watch', 'candidates.json')

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

ANCHOR_RE = re.compile(r'<a\b[^>]*?href="([^"]+)"[^>]*>(.*?)</a>', re.I | re.S)
TAG_RE = re.compile(r'<[^>]+>')
DATE_RE = re.compile(r'20\d{2}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?')
MORE_TEXT_RE = re.compile(r'查看更多|更多&gt;|更多>|^更多$|下一页|加载更多')
MORE_HREF_RE = re.compile(r'(list|page|index)_?\d+|/(?:zpxx|bmrk|xxhz)/?$')
JUNK_TITLE_RE = re.compile(r'^(首页|登录|注册|返回|客服|APP|小程序|搜索|导航|咨询|电话|关于我们|联系|帮助|收藏|顶部)')
ASSET_RE = re.compile(r'\.(css|js|png|jpe?g|gif|svg|ico|woff2?|pdf|docx?|xlsx?|zip|mp4)([?#]|$)', re.I)
PUNCT_RE = re.compile(r'[\s，。、：；！？“”‘’（）《》〈〉【】\[\]〔〕·…\-—_~～|/\\+\'"*.#：:！!？？,()（）]+')
YEAR_WORD_RE = re.compile(r'20(2[5-9])(\s*届|\s*年(?!度))|(26|27|28)(?=届)')


def _load(path, default):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return json.loads(json.dumps(default))


def _save(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def now_str():
    return time.strftime('%Y-%m-%d %H:%M')


# ---------------- http ----------------

def fetch(url: str, timeout: float = 20.0) -> str:
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    for enc in ('utf-8', 'gb18030'):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode('utf-8', 'ignore')


# ---------------- normalization / dedup keys ----------------

def normalize_title(title: str) -> str:
    s = str(title or '')
    s = re.sub(r'【[^】]{0,20}】|\[[^\]]{0,20}\]', '', s)      # 【急聘】等前缀块
    s = PUNCT_RE.sub('', s)
    s = YEAR_WORD_RE.sub('', s)
    return s.lower()[:64]


def dedup_key(title: str, url: str = '') -> str:
    return hashlib.sha1((normalize_title(title) or url).encode('utf-8')).hexdigest()[:16]


def canonical_url(url: str) -> str:
    try:
        p = urllib.parse.urlsplit(url)
        return urllib.parse.urlunsplit((p.scheme, p.netloc, p.path, '', ''))
    except Exception:
        return url


def same_site(url: str, base_netloc: str) -> bool:
    try:
        n = urllib.parse.urlsplit(url).netloc.lower()
        return n == base_netloc or n.endswith('.' + base_netloc)
    except Exception:
        return False


# ---------------- extraction ----------------

def _clean_title(s: str) -> str:
    return re.sub(r'\s+', ' ', TAG_RE.sub('', s)).strip()


def _anchor_title(inner_html: str) -> str:
    """锚点内嵌卡片（title/desc/date 多层嵌套）时取第一个合理文本段为标题。"""
    first = _clean_title(inner_html)
    if 6 <= len(first) <= 80:
        return first
    runs = [t.strip() for t in re.findall(r'>([^<>]+)<', inner_html) if t.strip()]
    for r in runs:
        t = re.sub(r'\s+', ' ', r)
        if 8 <= len(t) <= 80 and re.search(r'[\u4e00-\u9fa5]', t) and not JUNK_TITLE_RE.match(t):
            return t
    m = re.search(r'class="[^"]*title[^"]*"[^>]*>([^<]{6,80})<', inner_html)
    return re.sub(r'\s+', ' ', m.group(1)).strip() if m else ''


def extract_items(html: str, base_url: str, require_date: bool = True) -> list:
    """Generic <a>+date extraction. Date 先搜锚点内部（卡片式列表）再搜锚点后缀。
    require_date: 页面若一个带日期的条目都没有 → 回退接受无日期条目（cap 20，兼容无日期站点）。"""
    base_netloc = urllib.parse.urlsplit(base_url).netloc.lower()
    dated, undated = {}, {}
    for m in ANCHOR_RE.finditer(html):
        href = (m.group(1) or '').strip()
        inner = m.group(2)
        if not href or href.startswith(('#', 'javascript:')):
            continue
        title = _anchor_title(inner)
        if not title or len(title) < 8 or len(title) > 80:
            continue
        if JUNK_TITLE_RE.match(title) or not re.search(r'[\u4e00-\u9fa5]', title):
            continue
        try:
            url = urllib.parse.urljoin(base_url, href)
        except Exception:
            continue
        if not same_site(url, base_netloc) or not looks_like_article(url):
            continue
        dm = DATE_RE.search(inner) or DATE_RE.search(html[m.end():m.end() + 400])
        date = normalize_date(dm.group(0)) if dm else ''
        cu = canonical_url(url)
        bucket = dated if date else undated
        if cu in bucket:
            continue
        bucket[cu] = {'title': title, 'url': cu, 'date': date}
    if dated:
        return list(dated.values())
    if require_date:
        return list(undated.values())[:20]
    return list(undated.values())


def looks_like_article(url: str) -> bool:
    if ASSET_RE.search(url):
        return False
    path = urllib.parse.urlsplit(url).path
    if re.search(r'\.(html?|shtml)$', path, re.I):
        return True
    if re.search(r'/\d{3,}(?:[/._]|$)', path):
        return True
    return False


def normalize_date(m: str) -> str:
    digits = re.findall(r'\d{1,4}', m)
    if len(digits) >= 3:
        y, mo, d = digits[0], int(digits[1]), int(digits[2])
        return f'{y}-{mo:02d}-{d:02d}'
    return ''


def discover_more(html: str, base_url: str, visited: set) -> list:
    """Anchors whose text is 查看更多/更多/下一页 or href matches pagination/channel patterns."""
    base_netloc = urllib.parse.urlsplit(base_url).netloc.lower()
    out = []
    for m in ANCHOR_RE.finditer(html):
        href = (m.group(1) or '').strip()
        text = _clean_title(m.group(2))
        if not href or href.startswith(('#', 'javascript:')):
            continue
        hit = bool(MORE_TEXT_RE.search(text)) or bool(MORE_HREF_RE.search(href))
        if not hit:
            continue
        if len(text) > 12:      # 长文本不是导航
            continue
        try:
            url = urllib.parse.urljoin(base_url, href)
        except Exception:
            continue
        if not same_site(url, base_netloc):
            continue
        cu = canonical_url(url)
        if cu in visited or not cu.startswith('http'):
            continue
        if ASSET_RE.search(cu):
            continue
        out.append(cu)
    return out


def crawl_source(source: dict, log=None) -> tuple:
    """按 mode 分派：fetch（默认，纯 HTTP）| render（CDP 后台标签滚动加载）。"""
    if source.get('mode') == 'render':
        return render_crawl_source(source, log=log)
    return fetch_crawl_source(source, log=log)


def fetch_crawl_source(source: dict, log=None) -> tuple:
    """BFS: source page + more-links (depth 2) within fetch budget. Returns (items, fetched)."""
    url = source['url']
    pages_budget = max(1, int(source.get('pages', 3))) * 6
    delay = float(source.get('delay', 1.2))
    visited = set()
    items_by_url = {}
    fetched = 0
    queue = [(canonical_url(url), 0)]
    visited.add(canonical_url(url))
    while queue and fetched < pages_budget:
        cu, depth = queue.pop(0)
        try:
            html = fetch(cu)
        except Exception as e:
            if log:
                log(f'fetch fail {cu[:70]}: {e}')
            continue
        fetched += 1
        for it in extract_items(html, cu):
            if it['url'] not in items_by_url:
                items_by_url[it['url']] = it
        if depth < 2:
            for more in discover_more(html, cu, visited):
                visited.add(more)
                queue.append((more, depth + 1))
        time.sleep(delay)
    return list(items_by_url.values()), fetched


_COLLECT_JS = """
(() => {
  const DATE = /20\\d{2}\\s*[-\\/年.]\\s*\\d{1,2}\\s*[-\\/月.]\\s*\\d{1,2}/;
  const out = {};
  document.querySelectorAll('a[href]').forEach(a => {
    const href = a.href || '';
    const lines = (a.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const title = lines[0] || '';
    if (title.length < 8 || title.length > 80) return;
    const scope = a.closest('li,article,div[class*="item"],div[class*="list"]') || a;
    const dm = (scope.innerText || a.innerText || '').match(DATE);
    if (out[href]) { if (dm && !out[href].date) out[href].date = dm[0]; return; }
    out[href] = { title: title.replace(/\\s+/g, ' '), url: href, date: dm ? dm[0] : '' };
  });
  return Object.values(out);
})()
"""


def render_crawl_source(source: dict, log=None) -> tuple:
    """CDP 后台标签：打开源页 → 循环滚动+点「查看更多/加载更多」 → DOM 收集 anchors → 关标签。
    通用兜底：不逆向各站 AJAX 端点。复用求职 Edge 专用剖面。"""
    from af_core import ensure_edge   # 延迟导入避免循环依赖
    cfg = _load(paths.config_path(), {})
    ensure_edge(cfg)
    from playwright.sync_api import sync_playwright
    pw = sync_playwright().start()
    rounds = max(1, int(source.get('pages', 3))) * 3
    items_by_url = {}
    try:
        b = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{cfg.get('debugPort', 9222)}")
        ctx = b.contexts[0] if b.contexts else b.new_context()
        page = ctx.new_page()
        try:
            page.goto(source['url'], wait_until='domcontentloaded', timeout=45000)
            page.bring_to_front()
            for i in range(rounds):
                page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
                time.sleep(1.5)
                try:   # 点开「查看更多/加载更多」（若有）
                    page.evaluate("""(() => {
                      const btn = [...document.querySelectorAll('a,button,div,span')].find(e =>
                        /查看更多|加载更多|更多>>|点击查看/.test((e.innerText || '').trim()) &&
                        (e.innerText || '').trim().length <= 12);
                      if (btn) btn.click();
                      return !!btn;
                    })()""")
                except Exception:
                    pass
            raw = page.evaluate(_COLLECT_JS)
            base_netloc = urllib.parse.urlsplit(source['url']).netloc.lower()
            for it in raw:
                try:
                    cu = canonical_url(urllib.parse.urljoin(source['url'], it['url']))
                except Exception:
                    continue
                if not same_site(cu, base_netloc) or not looks_like_article(cu):
                    continue
                title = (it.get('title') or '').strip()
                if len(title) < 8 or JUNK_TITLE_RE.match(title) or not re.search(r'[\u4e00-\u9fa5]', title):
                    continue
                if cu in items_by_url:
                    continue
                items_by_url[cu] = {'title': title, 'url': cu, 'date': normalize_date(it.get('date') or '') if it.get('date') else ''}
            if log:
                log(f"render 抓取完成：{len(items_by_url)} 条（滚动 {rounds} 轮）")
        finally:
            try:
                page.close()
            except Exception:
                pass
    finally:
        try:
            pw.stop()
        except Exception:
            pass
    # 质量闸：带日期的条目优先；带日期不足 10 条时补无日期（上限 80，防 SEO 链接农场灌池）
    values = list(items_by_url.values())
    dated = [i for i in values if i['date']]
    if len(dated) >= 10:
        return dated, rounds
    undated = [i for i in values if not i['date']][:80]
    return dated + undated, rounds


# ---------------- fuzzy cluster within a batch ----------------

def cluster_items(items: list, ratio: float = 0.85) -> list:
    """Merge near-duplicate titles within one scan batch. items mutated: merged keep
    longest title, latest date, others dropped."""
    clusters = []   # [ {norm, rep_item, members:[norm_titles]} ]
    for it in sorted(items, key=lambda x: -len(x.get('title', ''))):
        norm = normalize_title(it['title'])
        if not norm:
            continue
        hit = None
        for c in clusters:
            if difflib.SequenceMatcher(None, norm, c['norm']).ratio() >= ratio:
                hit = c
                break
        if hit is None:
            clusters.append({'norm': norm, 'rep': it})
        else:
            if it.get('date') and it['date'] > (hit['rep'].get('date') or ''):
                hit['rep']['date'] = it['date']
    return [c['rep'] for c in clusters]


# ---------------- candidate store ----------------

DEFAULT_CAND = {'ignored': [], 'items': {}, 'updated': ''}


class CandidateStore:
    def __init__(self):
        self.lock = threading.RLock()
        self.data = _load(CAND_PATH, DEFAULT_CAND)
        if not isinstance(self.data.get('items'), dict):
            self.data['items'] = {}
        if not isinstance(self.data.get('ignored'), list):
            self.data['ignored'] = []

    def save(self):
        with self.lock:
            self.data['updated'] = now_str()
            _save(CAND_PATH, self.data)

    def is_ignored(self, key: str) -> bool:
        return key in self.data['ignored']

    def expire(self, days: int = 30):
        cutoff = time.strftime('%Y-%m-%d %H:%M', time.localtime(time.time() - days * 86400))
        drop = [k for k, v in self.data['items'].items()
                if v.get('status') == '待审' and (v.get('lastSeen') or '') < cutoff]
        for k in drop:
            del self.data['items'][k]
        return len(drop)

    def add_batch(self, items: list, source_name: str) -> int:
        """items already URL-deduped & clustered. Returns count of NEW candidates."""
        with self.lock:
            new = 0
            for it in items:
                key = dedup_key(it['title'], it['url'])
                if key in self.data['ignored']:
                    continue
                cur = self.data['items'].get(key)
                if cur is None:
                    self.data['items'][key] = {
                        'key': key, 'title': it['title'], 'url': it['url'], 'date': it.get('date', ''),
                        'sources': [source_name], 'llm': None, 'status': '待审',
                        'firstSeen': now_str(), 'lastSeen': now_str(),
                    }
                    new += 1
                else:
                    if source_name not in cur['sources']:
                        cur['sources'].append(source_name)
                    if it.get('date') and it['date'] > (cur.get('date') or ''):
                        cur['date'] = it['date']
                    cur['lastSeen'] = now_str()
                    if cur.get('status') == '忽略':
                        cur['status'] = '待审'   # 用户删过（非忽略）→ 再现重置为待审
            return new

    def list(self, include_accepted: bool = False, cap: int = 300) -> list:
        with self.lock:
            rows = [json.loads(json.dumps(v)) for v in self.data['items'].values()
                    if include_accepted or v.get('status') == '待审']
        rows.sort(key=lambda x: (x.get('date') or '0', x.get('firstSeen') or ''), reverse=True)
        return rows[:cap]

    def get(self, key: str):
        with self.lock:
            v = self.data['items'].get(key)
            return json.loads(json.dumps(v)) if v else None

    def set_status(self, key: str, status: str):
        with self.lock:
            if status == '忽略':
                if key not in self.data['ignored']:
                    self.data['ignored'].append(key)
                self.data['items'].pop(key, None)
            elif status == '删除':
                self.data['items'].pop(key, None)
            else:
                if key in self.data['items']:
                    self.data['items'][key]['status'] = status

    def pending_unfiltered(self) -> list:
        with self.lock:
            return [json.loads(json.dumps(v)) for v in self.data['items'].values()
                    if v.get('status') == '待审' and not v.get('llm')]

    def stats(self) -> dict:
        with self.lock:
            n = len(self.data['items'])
            by = {}
            for v in self.data['items'].values():
                by[v.get('status', '待审')] = by.get(v.get('status', '待审'), 0) + 1
            return {'total': n, 'ignored': len(self.data['ignored']), 'byStatus': by}


# ---------------- sources ----------------

def load_sources() -> list:
    return _load(SOURCES_PATH, {'seq': 1, 'sources': []}).get('sources', [])


def save_sources(sources: list):
    _save(SOURCES_PATH, {'seq': max([s.get('id', 0) for s in sources] or [0]) + 1, 'sources': sources})
