// ==UserScript==
// @name         Manga Tag Lens · 漫画标签透镜
// @name:en      Manga Tag Lens
// @namespace    https://github.com/toocutetop/manga-tag-lens
// @version      0.2.27
// @updateURL    https://cdn.jsdelivr.net/gh/toocutetop/manga-tag-lens@main/src/manga-tag-lens.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/toocutetop/manga-tag-lens@main/src/manga-tag-lens.user.js
// @description  禁漫天堂（jmcomic）油猴脚本：在列表页记下标签，对上的漫画当场亮出来。当前只适配禁漫。不分大小写，简繁算同一个。
// @description:en  Tampermonkey script for jmcomic / 禁漫天堂. Type tags to highlight matching comics. Currently jmcomic only.
// @author       you
// @icon         https://cdn.jsdelivr.net/gh/toocutetop/manga-tag-lens@main/src/icon.png
// @match        *://*.jmcomic.me/*
// @match        *://jmcomic.me/*
// @include      /^https?:\/\/([^\/]+\.)?(jmcomic\d*|18comic)\.[a-z0-9-]+/i
// @require      https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/t2cn.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 设计说明（先读这段，3 行看懂）
 * 1) 所有站点差异都被收进 ADAPTERS（适配器）。引擎只认「标签」和「条目」两个概念。
 * 2) 页面加载后采集标签。用户输入标签，对上的整块漫画和其中的标签高亮，方便查找。
 * 3) 加新站点 = 往 ADAPTERS 里加一个对象，不用改引擎。见 docs/adapter-guide.md。
 */

(function () {
  'use strict';

  if (!/(^|\.)(jmcomic\d*|18comic)\.[a-z0-9-]+$/i.test(location.hostname)
      && !((location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        && /标签透镜/.test(document.title || ''))) return;

  const VERSION = '0.2.27';
  const STORE_KEY = 'mtl:settings:v2';

  /* ============================================================
   * 0. 小工具
   * ============================================================
   * 简繁用 OpenCC（@require，安装时下载一次）。比较前先折成简体再小写。
   * ============================================================ */

  const uniq = (arr) => Array.from(new Set(arr));
  const txt = (el) => (el && el.textContent ? el.textContent : '').trim();
  const cleanLabel = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  const OpenCCLib = (typeof OpenCC !== 'undefined' && OpenCC && OpenCC.Converter)
    ? OpenCC
    : (typeof globalThis !== 'undefined' && globalThis.OpenCC && globalThis.OpenCC.Converter ? globalThis.OpenCC : null);

  let toCN = null;
  if (OpenCCLib) {
    try {
      toCN = OpenCCLib.Converter({ from: 'twp', to: 'cn' });
    } catch (e) {
      console.warn('[MTL] OpenCC 初始化失败，简繁暂时不折叠', e);
    }
  }

  /** 折叠空白、简繁、英文大小写。同一标签的各种写法得到同一个 key。 */
  function norm(s) {
    let t = cleanLabel(s).normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (toCN) {
      try { t = toCN(t); } catch (e) { /* 保持原文，至少还能比大小写 */ }
    }
    return t.toLowerCase();
  }

  /** 只在 DOM 里做一次去重查询 */
  function qsa(root, selector) {
    if (!root || !selector) return [];
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (e) {
      console.warn('[MTL] 选择器非法:', selector, e);
      return [];
    }
  }

  function isJmcomicHost(host) {
    return /(^|\.)(jmcomic\d*|18comic)\.[a-z0-9-]+$/i.test(host || location.hostname);
  }

  function isLocalPreview() {
    const h = location.hostname;
    if (!(location.protocol === 'file:' || h === 'localhost' || h === '127.0.0.1')) return false;
    return /标签透镜/.test(document.title || '');
  }

  function parseRgb(raw) {
    if (!raw || raw === 'transparent') return null;
    const s = String(raw).trim();
    let m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([.\d]+))?\s*\)$/i);
    if (!m) m = s.match(/^rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([.\d]+%?))?\s*\)$/i);
    if (!m) return null;
    let a = m[4] == null ? 1 : parseFloat(m[4]);
    if (m[4] && String(m[4]).includes('%')) a /= 100;
    if (!(a > 0.08)) return null;
    return { r: +m[1], g: +m[2], b: +m[3] };
  }

  function luminance(c) {
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  }

  function bgOf(el) {
    return el ? parseRgb(getComputedStyle(el).backgroundColor) : null;
  }

  /** 看页面底色，黑底就把面板换成浅字。先看 body / 主容器，html 常常是默认白，不能先信。 */
  function pageIsDark() {
    const body = document.body;
    const main = document.querySelector('#wrapper, .wrapper, main, .container-fluid');
    const html = document.documentElement;
    const primary = bgOf(body) || bgOf(main);
    if (primary) return luminance(primary) < 0.38;
    const htmlBg = bgOf(html);
    if (htmlBg) return luminance(htmlBg) < 0.38;
    const text = body && parseRgb(getComputedStyle(body).color);
    if (text && luminance(text) > 0.72) return true;
    const cls = ((html.className || '') + ' ' + ((body && body.className) || '')).toLowerCase();
    if (/\b(dark|night|black|theme-dark)\b/.test(cls)) return true;
    const scheme = getComputedStyle(html).colorScheme || '';
    return /\bdark\b/.test(scheme) && !/\blight\b/.test(scheme);
  }

  /* ============================================================
   * 1. 适配器（站点适配层）—— 想支持新网站，只改这里
   * ============================================================
   * 每个适配器字段：
   *   id           唯一标识
   *   name         显示名
   *   test()       是否命中当前页面（返回 boolean）
   *   tagSelector  页面上「全部标签」区域的标签元素选择器（可选，用于自动补全标签词典）
   *   itemSelector 每一部漫画（卡片/行）的选择器
   *   getItemTags(el) 从单个条目元素里取出标签数组
   *   getItemTitle(el) 可选，取标题（用于搜索结果里显示）
   * ============================================================ */
  const ADAPTERS = [];

  /** 示例：MangaDex 列表页（tag 在卡片内的 a[href*="/titles?"] 或 data 属性里） */
  ADAPTERS.push({
    id: 'mangadex',
    name: 'MangaDex',
    test: () => /(^|\.)mangadex\.org$/.test(location.hostname),
    itemSelector: '[data-manga-id], .manga-card, li[class*="manga"]',
    getItemTags(el) {
      const out = [];
      qsa(el, 'a[href*="/titles?"], a[href*="includedTags"]').forEach((a) => out.push(txt(a)));
      const raw = el.getAttribute('data-tags');
      if (raw) raw.split(/[,|]/).forEach((s) => out.push(s.trim()));
      return uniq(out.map(cleanLabel).filter(Boolean));
    },
    getItemTitle: (el) => txt(el.querySelector('a[href*="/title/"]')) || txt(el).slice(0, 40),
  });

  /**
   * 禁漫天堂（jmcomic.me，以及同模板的 jmcomic* / 18comic 镜像）。
   * 分类、搜索、首页底部「最新漫画」：标签是卡片里的 a.tag。
   * 首页顶部轮播（周五连载、禁漫汉化组等）的 HTML 里没有标签，只有分类角标和作者。
   */
  ADAPTERS.push({
    id: 'jmcomic',
    name: '禁漫天堂',
    test: () => /(^|\.)(jmcomic\d*|18comic)\.[a-z0-9-]+$/i.test(location.hostname),
    itemSelector: '.p-b-15',
    getItemTags(el) {
      const out = [];
      qsa(el, 'a.tag').forEach((a) => out.push(txt(a)));
      return uniq(out.map(cleanLabel).filter(Boolean));
    },
    getItemTitle(el) {
      const title = el.querySelector('.video-title');
      if (title) return txt(title);
      const a = el.querySelector('a[href*="/album/"]');
      return (a && (a.getAttribute('title') || txt(a))) || txt(el).slice(0, 40);
    },
  });

  /** 通用兜底：必须放在数组最后。前面的专用适配器都没命中时才用它。 */
  ADAPTERS.push({
    id: 'generic',
    name: '通用模式',
    test: () => true,
    tagSelector: 'a[href*="tag"], a[href*="Tag"], [class*="tag" i] a, .tags a, .tag a',
    itemSelector: [
      'article',
      'li[class*="card" i]',
      'div[class*="card" i]',
      '.manga-item',
      '.comic-item',
      '.book-item',
    ].join(','),
    getItemTags(el) {
      const set = [];
      const push = (s) => {
        const v = String(s || '').trim();
        if (v && [...v].length <= 32) set.push(v);
      };
      // 线索 1：条目内所有指向 tag 页面的链接
      qsa(el, 'a[href*="tag"], a[href*="Tag"]').forEach((a) => push(txt(a)));
      // 线索 2：带 tag 类名的元素
      qsa(el, '[class*="tag" i]').forEach((n) => {
        if (n.children.length === 0 || n.tagName === 'A' || n.tagName === 'SPAN') push(txt(n));
      });
      // 线索 3：站点常见的 data-* 属性
      ['data-tags', 'data-tag', 'data-genres', 'data-genre'].forEach((attr) => {
        const raw = el.getAttribute && el.getAttribute(attr);
        if (raw) raw.split(/[,|;、]/).forEach((s) => push(s));
      });
      return uniq(set);
    },
    getItemTitle(el) {
      const a = el.querySelector('a[href]');
      return (txt(a).split('\n')[0] || txt(el).slice(0, 40)).trim();
    },
  });

  /* ============================================================
   * 2. 设置
   * ============================================================ */
  const DEFAULT_SETTINGS = {
    logic: 'and',
    collapsePanel: false,
    picks: [],
    pickLabels: {},
    panelPos: null,
  };

  function loadSettings() {
    try {
      const raw = typeof GM_getValue === 'function' ? GM_getValue(STORE_KEY, null) : null;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Object.assign({}, DEFAULT_SETTINGS, parsed || {});
    } catch (e) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings(s) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(STORE_KEY, JSON.stringify(s));
    } catch (e) { /* 存储失败就只在这一页生效 */ }
  }

  const settings = loadSettings();

  /* ============================================================
   * 3. 运行时
   * ============================================================ */
  const state = {
    adapter: null,
    items: [],
    tagIndex: new Map(),
    keyword: '',
    total: 0,
    matched: 0,
    hint: '',
    hintKind: '',
    cursor: -1,
  };

  /** 已选标签的 key，按加入顺序 */
  let picks = [];
  const pickLabels = new Map();

  function labelOf(key) {
    const rec = state.tagIndex.get(key);
    if (rec) return rec.label;
    return pickLabels.get(key) || key;
  }

  function remember(label, key) {
    let rec = state.tagIndex.get(key);
    if (!rec) {
      rec = { key, label, count: 0, best: 0 };
      state.tagIndex.set(key, rec);
    }
    rec.count++;
    const votes = rec.votes || (rec.votes = new Map());
    const n = (votes.get(label) || 0) + 1;
    votes.set(label, n);
    if (n > rec.best) {
      rec.best = n;
      rec.label = label;
    }
  }

  function parseTag(raw) {
    const label = cleanLabel(raw);
    if (!label || [...label].length > 32) return null;
    const key = norm(label);
    if (!key) return null;
    return { label, key };
  }

  /* ============================================================
   * 4. 采集
   * ============================================================ */

  function pickAdapter() {
    if (isJmcomicHost()) {
      for (let i = 0; i < ADAPTERS.length; i++) {
        const ad = ADAPTERS[i];
        if (!ad || ad.id !== 'jmcomic') continue;
        try {
          if (ad.test()) return ad;
        } catch (e) { /* 单个适配器出错就跳过 */ }
      }
      return null;
    }
    if (isLocalPreview()) {
      return ADAPTERS.find((ad) => ad && ad.id === 'generic') || null;
    }
    return null;
  }

  function collect() {
    restoreOrder();
    const ad = state.adapter;
    const els = qsa(document, ad.itemSelector).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 80 && r.height > 40;
    });

    state.items = [];
    state.tagIndex = new Map();

    els.forEach((el) => {
      const raws = uniq((ad.getItemTags(el) || []).map(cleanLabel).filter(Boolean));
      const keys = [];
      const seen = new Set();
      raws.forEach((raw) => {
        const tag = parseTag(raw);
        if (!tag || seen.has(tag.key)) return;
        seen.add(tag.key);
        keys.push(tag.key);
        remember(tag.label, tag.key);
      });
      if (!keys.length) return;
      state.items.push({ el, keys, hit: false, cell: null });
    });

    state.items.forEach((it) => { it.cell = gridCell(it.el); });
    state.total = state.items.length;
    return state.items.length > 0;
  }

  /** 卡片外面那一格。轮播里挪的是整张幻灯片，不拆轨道里的内容。 */
  function gridCell(el) {
    const slide = el.closest && el.closest('.owl-item, .slick-slide, .swiper-slide');
    if (slide) {
      if (slide.classList.contains('cloned') || slide.classList.contains('slick-cloned')) return null;
      return slide;
    }
    let node = el;
    while (node.parentElement && node.parentElement !== document.body) {
      const parent = node.parentElement;
      let holders = 0;
      for (const child of parent.children) {
        if (state.items.some((it) => child === it.el || child.contains(it.el))) holders++;
      }
      if (holders >= 2) return node;
      node = parent;
    }
    return el;
  }

  function rank(key, q) {
    if (!q) return 1;
    if (key === q) return 0;
    if (key.startsWith(q)) return 1;
    if (key.includes(q)) return 2;
    return 3;
  }

  /** 本页标签，加上已经记下、但这页还没出现的词 */
  function orderedTags() {
    const q = norm(state.keyword);
    const list = Array.from(state.tagIndex.values());
    const seen = new Set(list.map((t) => t.key));
    picks.forEach((key) => {
      if (seen.has(key)) return;
      list.push({ key, label: labelOf(key), count: 0, away: true });
    });
    list.sort((a, b) => {
      const ra = rank(a.key, q);
      const rb = rank(b.key, q);
      if (ra !== rb) return ra - rb;
      if (!q) {
        const sa = picks.includes(a.key) ? 0 : 1;
        const sb = picks.includes(b.key) ? 0 : 1;
        if (sa !== sb) return sa - sb;
      }
      if (a.count !== b.count) return b.count - a.count;
      return a.label.localeCompare(b.label, 'zh');
    });
    return list;
  }

  function enterTarget(list) {
    const q = norm(state.keyword);
    if (!q) return null;
    const exact = list.find((t) => t.key === q);
    if (exact) return exact.key;
    const starts = list.filter((t) => t.key.startsWith(q));
    if (starts.length === 1) return starts[0].key;
    return null;
  }

  function resolveToken(token) {
    const q = norm(token);
    if (!q) return { type: 'empty' };
    const all = Array.from(state.tagIndex.values());
    const exact = all.find((t) => t.key === q);
    if (exact) return { type: 'one', key: exact.key };
    const starts = all.filter((t) => t.key.startsWith(q));
    if (starts.length === 1) return { type: 'one', key: starts[0].key };
    if (starts.length > 1 || all.some((t) => t.key.includes(q))) return { type: 'many' };
    return { type: 'none' };
  }

  /* ============================================================
   * 5. 选择与高亮
   * ============================================================ */

  function persistPicks() {
    settings.picks = picks.slice();
    settings.pickLabels = {};
    picks.forEach((key) => { settings.pickLabels[key] = labelOf(key); });
    saveSettings(settings);
  }

  function addPick(key, label) {
    if (!picks.includes(key)) picks.push(key);
    const rec = state.tagIndex.get(key);
    if (rec) pickLabels.set(key, rec.label);
    else if (label) pickLabels.set(key, label);
    else if (!pickLabels.has(key)) pickLabels.set(key, key);
    state.cursor = -1;
    persistPicks();
  }

  function removePick(key) {
    const i = picks.indexOf(key);
    if (i >= 0) picks.splice(i, 1);
    state.cursor = -1;
    persistPicks();
  }

  function matches(keys) {
    if (!picks.length) return true;
    if (settings.logic === 'or') return picks.some((k) => keys.includes(k));
    return picks.every((k) => keys.includes(k));
  }

  /** parent -> 排位前的子节点顺序，清空时按这个放回去 */
  const layoutSnap = new Map();
  /** 轮播轨道原来的位移，清空时放回去 */
  const trackSnap = new Map();

  function restoreOrder() {
    layoutSnap.forEach((children, parent) => {
      if (!parent || !parent.isConnected) return;
      children.forEach((node) => {
        if (node) parent.appendChild(node);
      });
    });
    trackSnap.forEach((prev, parent) => {
      if (!parent || !parent.isConnected) return;
      parent.style.transform = prev.transform;
      parent.style.transition = prev.transition;
    });
    layoutSnap.clear();
    trackSnap.clear();
  }

  function isTrack(parent) {
    return !!(parent && parent.classList && (
      parent.classList.contains('owl-stage')
      || parent.classList.contains('swiper-wrapper')
      || parent.classList.contains('slick-track')
    ));
  }

  function settleTrack(parent) {
    if (!isTrack(parent)) return;
    if (!trackSnap.has(parent)) {
      trackSnap.set(parent, {
        transform: parent.style.transform || '',
        transition: parent.style.transition || '',
      });
    }
    parent.style.transition = 'none';
    parent.style.transform = 'none';
    Array.from(parent.children).forEach((node) => {
      if (node.classList && (node.classList.contains('cloned') || node.classList.contains('slick-cloned'))) {
        parent.appendChild(node);
      }
    });
  }

  function placeNodes(parent, nodes) {
    nodes.forEach((node) => {
      if (node) parent.appendChild(node);
    });
  }

  /** 同一父节点里，对上的格子排到最前，其余保持原来的相对顺序。 */
  function reorderWithin(parent) {
    const base = layoutSnap.get(parent);
    if (!base) return;
    const hitCells = new Set(state.items.filter((it) => it.hit && it.cell && it.cell.parentElement).map((it) => it.cell));
    const hits = [];
    const rest = [];
    base.forEach((node) => {
      if (hitCells.has(node)) hits.push(node);
      else rest.push(node);
    });
    placeNodes(parent, hits.concat(rest));
  }

  /** 只在同一排里把对上的提前。不同排的格子栏数不一样，挪过去封面会被挤小。 */
  function reorderHits() {
    if (!picks.length) {
      restoreOrder();
      return;
    }
    const groups = new Map();
    state.items.forEach((it) => {
      if (!it.cell || !it.cell.parentElement) return;
      const parent = it.cell.parentElement;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(it);
    });
    groups.forEach((list, parent) => {
      if (!layoutSnap.has(parent)) layoutSnap.set(parent, Array.from(parent.children));
      reorderWithin(parent);
      if (isTrack(parent)) settleTrack(parent);
    });
  }

  function usableHref(a) {
    if (!a || !a.getAttribute) return '';
    const raw = a.getAttribute('href') || '';
    if (!raw || raw === '#' || /^javascript:/i.test(raw)) return '';
    if (a.classList.contains('disabled') || a.getAttribute('aria-disabled') === 'true') return '';
    const li = a.closest && a.closest('li, button');
    if (li && (li.classList.contains('disabled') || li.getAttribute('aria-disabled') === 'true')) return '';
    let href = '';
    try { href = new URL(raw, location.href).href; } catch (e) { return ''; }
    if (!href || href === location.href) return '';
    return href;
  }

  function pagerText(el) {
    return (el.textContent || '').replace(/\s+/g, '');
  }

  /** 列表页的上一页 / 下一页。轮播和正文里的链接不算。 */
  function findPageHref(dir) {
    const rel = dir === 'prev' ? 'prev' : 'next';
    const relNode = document.querySelector('a[rel="' + rel + '"], link[rel="' + rel + '"]');
    const relHref = usableHref(relNode);
    if (relHref) return relHref;

    const scopes = qsa(document, '.pagination, .pager, .page-nav, .bot-page');
    if (!scopes.length) return '';
    const word = dir === 'prev' ? /^(上一页|上一頁|prev|previous)$/i : /^(下一页|下一頁|next)$/i;
    const near = dir === 'prev' ? /^[‹<〈]$/ : /^[›>〉]$/;
    const far = dir === 'prev' ? /^[«〈]{1,2}$/ : /^[»〉]{1,2}$/;
    let nearHref = '';
    let farHref = '';
    scopes.forEach((scope) => {
      qsa(scope, 'a[href]').forEach((a) => {
        const href = usableHref(a);
        if (!href) return;
        const text = pagerText(a);
        const li = a.parentElement;
        const liCls = (li && li.className) || '';
        const marked = dir === 'prev'
          ? /prev|previous/i.test(a.className + ' ' + liCls)
          : /(^|[^a-z])next([^a-z]|$)/i.test(a.className + ' ' + liCls);
        if (marked || word.test(text)) {
          if (!nearHref) nearHref = href;
          return;
        }
        if (!nearHref && near.test(text)) nearHref = href;
        else if (!farHref && far.test(text)) farHref = href;
      });
    });
    return nearHref || farHref;
  }

  /** 标签原来的顺序，清空时放回去 */
  const tagSnap = new Map();

  function restoreTagOrder() {
    tagSnap.forEach((children, parent) => {
      if (!parent || !parent.isConnected) return;
      children.forEach((node) => {
        if (node) parent.appendChild(node);
      });
    });
    tagSnap.clear();
  }

  function clearMarks() {
    restoreTagOrder();
    clearHaloFit();
    qsa(document, '[data-mtl]').forEach((el) => {
      el.removeAttribute('data-mtl');
      el.style.removeProperty('--mtl-r');
    });
    qsa(document, '[data-mtl-cover]').forEach((el) => el.removeAttribute('data-mtl-cover'));
    qsa(document, '[data-mtl-tag]').forEach((el) => el.removeAttribute('data-mtl-tag'));
    qsa(document, '[data-mtl-focus]').forEach((el) => {
      el.removeAttribute('data-mtl-focus');
    });
    qsa(document, '.mtl-focus-badge').forEach((el) => el.remove());
  }

  function tagChip(node) {
    const link = node.closest && node.closest('a');
    if (!link || !node.parentElement || !link.contains(node)) return node;
    const label = cleanLabel(link.textContent || '');
    if (!label || [...label].length > 24) return node;
    return link;
  }

  function markTagNodes(el, keys) {
    const want = new Set(keys);
    const nodes = qsa(el, 'a, span');
    const hits = [];
    nodes.forEach((n) => {
      const label = cleanLabel(n.textContent || '');
      if (!label || [...label].length > 24) return;
      if (want.has(norm(label))) hits.push(n);
    });
    const chips = [];
    hits
      .filter((n) => !hits.some((o) => o !== n && n.contains(o)))
      .forEach((n) => {
        const chip = tagChip(n);
        if (!el.contains(chip) || chips.includes(chip)) return;
        chips.push(chip);
        chip.setAttribute('data-mtl-tag', '1');
      });
    const byParent = new Map();
    chips.forEach((chip) => {
      const parent = chip.parentElement;
      if (!parent) return;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(chip);
    });
    byParent.forEach((list, parent) => {
      if (!tagSnap.has(parent)) tagSnap.set(parent, Array.from(parent.children));
      const sorted = list.slice().sort((a, b) => {
        const ia = picks.indexOf(norm(a.textContent || ''));
        const ib = picks.indexOf(norm(b.textContent || ''));
        return (ia < 0 ? picks.length : ia) - (ib < 0 ? picks.length : ib);
      });
      for (let i = sorted.length - 1; i >= 0; i--) parent.insertBefore(sorted[i], parent.firstChild);
    });
  }

  /** 封面那一层。禁漫是 .thumb-overlay / .thumb-overlay-albums，高亮只画在这层，
   *  不要去改它的宽高：它是 100% 宽 + 官方 3/4，父级一加内边距就会被挤小。 */
  function coverEl(el) {
    if (!el || !el.querySelector) return el;
    return el.querySelector('.thumb-overlay-albums')
      || el.querySelector('.thumb-overlay')
      || el;
  }

  const RING_OFF = 2;
  const RING_LINE = 2.5;
  const RING_LINE_FOCUS = 2.5;
  const RING_GLOW = 8;
  const RING_SLACK = 1;

  function clearHaloFit() {
    qsa(document, '[data-mtl-cover]').forEach((el) => {
      el.style.removeProperty('--mtl-off');
      el.style.removeProperty('--mtl-line');
      el.style.removeProperty('--mtl-glow');
    });
  }

  function ringLine(it) {
    return it.el && it.el.getAttribute('data-mtl-focus') === '1' ? RING_LINE_FOCUS : RING_LINE;
  }

  function haloNeed(cover, off, line, glow) {
    const g = (glow.get(cover) || 0) + 1;
    return Math.max((off.get(cover) || 0) + (line.get(cover) || 0), g);
  }

  /** 圈画在封面外面，带一圈暖色发光。两本都亮时，两边的圈都要吃进官方空隙；
   *  空隙不够先收发光再收外扩，绝不给封面加 padding。 */
  function applyHaloFit() {
    clearHaloFit();
    if (!picks.length) return;

    const recs = [];
    state.items.forEach((it) => {
      const cover = coverEl(it.el);
      if (!cover || !cover.getBoundingClientRect) return;
      const r = cover.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      recs.push({ it: it, cover: cover, r: r, hit: !!it.hit });
    });
    if (!recs.length) return;

    const off = new Map();
    const line = new Map();
    const glow = new Map();
    recs.forEach((x) => {
      if (!x.hit) return;
      off.set(x.cover, RING_OFF);
      line.set(x.cover, ringLine(x.it));
      glow.set(x.cover, RING_GLOW);
    });

    function cap(cover, budget) {
      if (!off.has(cover)) return;
      if ((glow.get(cover) || 0) + 1 > budget) {
        glow.set(cover, Math.max(0, budget - 1));
      }
      if (haloNeed(cover, off, line, glow) <= budget) return;
      const maxOff = Math.max(0, budget - line.get(cover));
      if (maxOff < off.get(cover)) off.set(cover, maxOff);
    }

    function meet(a, b, gap) {
      if (!(a.hit || b.hit)) return;
      if (!(gap >= 0) || gap > 120) return;
      const aNeed = a.hit ? haloNeed(a.cover, off, line, glow) : 0;
      const bNeed = b.hit ? haloNeed(b.cover, off, line, glow) : 0;
      if (aNeed + bNeed + RING_SLACK <= gap) return;
      const n = (a.hit ? 1 : 0) + (b.hit ? 1 : 0);
      const budget = (gap - RING_SLACK) / n;
      if (a.hit) cap(a.cover, budget);
      if (b.hit) cap(b.cover, budget);
    }

    function pairAxis(bucket, along, gapOf) {
      const groups = new Map();
      recs.forEach((x) => {
        const k = bucket(x.r);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(x);
      });
      groups.forEach((list) => {
        list.sort((a, b) => along(a.r) - along(b.r));
        for (let i = 0; i < list.length - 1; i++) {
          meet(list[i], list[i + 1], gapOf(list[i].r, list[i + 1].r));
        }
      });
    }

    for (let pass = 0; pass < 2; pass++) {
      pairAxis(
        (r) => Math.round(r.top / 6),
        (r) => r.left,
        (a, b) => b.left - a.right
      );
      pairAxis(
        (r) => Math.round(r.left / 6),
        (r) => r.top,
        (a, b) => b.top - a.bottom
      );
    }

    recs.forEach((x) => {
      if (!x.hit) return;
      x.cover.style.setProperty('--mtl-off', off.get(x.cover).toFixed(2) + 'px');
      x.cover.style.setProperty('--mtl-line', line.get(x.cover) + 'px');
      x.cover.style.setProperty('--mtl-glow', glow.get(x.cover).toFixed(2) + 'px');
    });
  }

  function applyHighlight() {
    clearMarks();
    const active = picks.length > 0;
    let matched = 0;
    state.items.forEach((it) => {
      const hit = active && matches(it.keys);
      it.hit = hit;
      if (!active) return;
      if (hit) {
        matched++;
        it.el.setAttribute('data-mtl', 'hit');
        coverEl(it.el).setAttribute('data-mtl-cover', '1');
        markTagNodes(it.el, it.keys.filter((k) => picks.includes(k)));
      } else {
        it.el.setAttribute('data-mtl', 'miss');
      }
    });
    reorderHits();
    state.matched = active ? matched : state.total;
    markFocus();
    applyHaloFit();
    renderStatus();
  }

  function hitItems() {
    return state.items.filter((it) => it.hit);
  }

  function markFocus() {
    qsa(document, '[data-mtl-focus]').forEach((el) => el.removeAttribute('data-mtl-focus'));
    qsa(document, '.mtl-focus-badge').forEach((el) => el.remove());
    const list = hitItems();
    if (state.cursor < 0 || state.cursor >= list.length) return null;
    const el = list[state.cursor].el;
    el.setAttribute('data-mtl-focus', '1');
    const cover = coverEl(el);
    const badge = document.createElement('div');
    badge.className = 'mtl-focus-badge';
    badge.textContent = '当前 ' + (state.cursor + 1) + '/' + list.length;
    cover.appendChild(badge);
    return el;
  }

  function clearAll() {
    picks = [];
    state.keyword = '';
    state.hint = '';
    state.hintKind = '';
    state.cursor = -1;
    if (ui.kwInput) ui.kwInput.value = '';
    persistPicks();
    renderPanel();
    applyHighlight();
  }

  function jumpNext() {
    const list = hitItems();
    if (!list.length) return;
    state.cursor = (state.cursor + 1) % list.length;
    const el = markFocus();
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    renderStatus();
  }

  function commitToken(token) {
    const found = resolveToken(token);
    if (found.type === 'one') {
      addPick(found.key);
      return 'added';
    }
    if (found.type === 'many') return 'many';
    if (found.type === 'empty') return 'empty';
    const tag = parseTag(token);
    if (!tag) return 'none';
    addPick(tag.key, tag.label);
    return 'saved';
  }

  function commitQuery() {
    const token = cleanLabel(state.keyword);
    if (!token) return;
    const result = commitToken(token);
    const kept = result === 'added' || result === 'saved';
    if (kept) {
      state.keyword = '';
      if (ui.kwInput) ui.kwInput.value = '';
      if (result === 'saved') {
        state.hint = '已记下。这一页还没有，之后遇到会对上';
        state.hintKind = 'note';
      } else {
        state.hint = '';
        state.hintKind = '';
      }
    } else if (result === 'many') {
      state.hint = '有多个相近的，点一个，或把词打完整。本页没有的词回车也会记下';
      state.hintKind = 'warn';
    } else if (result === 'none') {
      state.hint = '这个词太长了';
      state.hintKind = 'warn';
    }
    renderPanel({ keepScroll: !kept });
    if (kept) applyHighlight();
  }

  function addFromText(text) {
    const parts = String(text).split(/[\s,，;；、\n]+/).map(cleanLabel).filter(Boolean);
    const left = [];
    let added = 0;
    let saved = 0;
    parts.forEach((part) => {
      const result = commitToken(part);
      if (result === 'added') added++;
      else if (result === 'saved') saved++;
      else left.push(part);
    });
    state.keyword = left.join(' ');
    if (ui.kwInput) ui.kwInput.value = state.keyword;
    if (!left.length && saved) {
      state.hint = '已记下。这一页没有的，换页后会对上';
      state.hintKind = 'note';
    } else if (!left.length) {
      state.hint = '';
      state.hintKind = '';
    } else if (!added && !saved) {
      state.hint = '这些词还没写完整，或太长';
      state.hintKind = 'warn';
    } else {
      state.hint = '没对上的还留在输入框里';
      state.hintKind = 'warn';
    }
    renderPanel();
    if (added || saved) applyHighlight();
  }

  function restorePicks() {
    const saved = Array.isArray(settings.picks) ? settings.picks : [];
    const labels = settings.pickLabels || {};
    picks = [];
    saved.forEach((key) => {
      if (!key || picks.includes(key)) return;
      picks.push(key);
      if (labels[key]) pickLabels.set(key, labels[key]);
    });
  }

  /* ============================================================
   * 6. 液态玻璃
   * ============================================================
   * 面板本体和面板里的每一颗按钮共用同一套折射：给元素贴一张「圆角边缘的
   * 位移贴图」，backdrop-filter 照着它把后面的画面折一下，边缘就有了厚度。
   * 同一尺寸只算一次并缓存，尺寸按桶取整，几十颗按钮也只生成十几张图。
   * ============================================================ */

  let ui = {};

  const GLASS_SURFACE = (x) => Math.pow(1 - Math.pow(1 - x, 4), 0.25);

  function glassProfile(thickness, bezel, ior) {
    const samples = 128;
    const eta = 1 / ior;
    const profile = new Float64Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = i / samples;
      const y = GLASS_SURFACE(x);
      const dx = x < 1 ? 0.0001 : -0.0001;
      const deriv = (GLASS_SURFACE(x + dx) - y) / dx;
      const mag = Math.sqrt(deriv * deriv + 1);
      const nx = -deriv / mag;
      const ny = -1 / mag;
      const dot = ny;
      const k = 1 - eta * eta * (1 - dot * dot);
      if (k < 0) continue;
      const sq = Math.sqrt(k);
      const ry = eta - (eta * dot + sq) * ny;
      if (!ry) continue;
      profile[i] = (-(eta * dot + sq) * nx) * ((y * bezel + thickness) / ry);
    }
    return profile;
  }

  function glassMap(w, h, radius, bezel, paint) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    paint(img.data, w, h, radius, bezel);
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** 给位移贴图四周留取样边。Chromium 的 backdrop-filter 只给元素自己那块背景，
   *  feDisplacementMap 取样超出 scale/2 就会在右侧画出一条竖线。
   *  面板比可见区域大一圈，折光就能拉到面板外面的画面；竖线落在 overflow 裁掉的地方。 */
  function padMap(src, pad, fill) {
    if (!pad) return src.toDataURL();
    const c = document.createElement('canvas');
    c.width = src.width + pad * 2;
    c.height = src.height + pad * 2;
    const ctx = c.getContext('2d');
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(src, pad, pad);
    return c.toDataURL();
  }

  const GLASS_DEFAULTS = {
    radiusCss: 44,      // 圆角，元素像素。要跟 .wrap 的 border-radius 对上，折光才贴边
    radiusMin: 16,
    bezelCss: 52,       // 折光带宽度。那个液态玻璃页默认 60，太窄就只剩一圈雾
    bezelMin: 12,
    depth: 80,          // 玻璃厚度，只影响折光的分布。液态玻璃页默认 80
    ior: 3.0,           // 折射率。液态玻璃页 / 苹果这档都是 3，不能再往下砍
    strength: 1.55,     // 最大位移 = 剖线峰值 × strength
    dispPx: 0,          // 大于 0 时直接指定最大位移（元素像素）
    expandSample: false,// 面板打开：四周留 scale/2，折光按折射率走，竖线藏在裁切外
    // 按钮不扩取样时仍要封顶，否则小胶囊右侧会裂开。
    capBezel: 1.1,
    saturate: 4,        // 折光带里的色散。苹果边缘那圈绿/彩边就是它，不要降到 1.5
    specFade: 0.5,      // 高光强度，液态玻璃页默认 0.50
    specGain: 2.5,      // 高光带宽度 = bezel × specGain
    blur: 0.35,         // 液态玻璃页 0.3。糊大了折光就被磨砂盖掉
    maxPixels: 280 * 360,
  };

  /** 一张玻璃 = 一个 SVG filter。w / h / radius 都用元素像素。 */
  function buildGlassFilter(id, w, h, options) {
    const o = Object.assign({}, GLASS_DEFAULTS, options || {});
    let mapW = Math.max(8, Math.round(w));
    let mapH = Math.max(8, Math.round(h));
    if (mapW * mapH > o.maxPixels) {
      const s = Math.sqrt(o.maxPixels / (mapW * mapH));
      mapW = Math.max(8, Math.round(mapW * s));
      mapH = Math.max(8, Math.round(mapH * s));
    }
    const k = mapW / w;
    const ceiling = Math.floor(Math.min(mapW, mapH) / 2);
    const radius = Math.max(1, Math.min(Math.max(o.radiusMin, Math.round(o.radiusCss * k)), ceiling - 1));
    const bezel = Math.max(1, Math.min(Math.max(o.bezelMin, Math.round(o.bezelCss * k)), radius - 1));
    const profile = glassProfile(Math.max(4, o.depth), bezel, o.ior);
    let maxDisp = 1;
    for (let i = 0; i < profile.length; i++) maxDisp = Math.max(maxDisp, Math.abs(profile[i]));
    const dispCanvas = glassMap(mapW, mapH, radius, bezel, (d, W, H, r, bz) => {
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 128; d[i + 1] = 128; d[i + 2] = 0; d[i + 3] = 255;
      }
      const rSq = r * r;
      const r1Sq = (r + 1) * (r + 1);
      const rBSq = Math.max(r - bz, 0) ** 2;
      const wB = W - r * 2;
      const hB = H - r * 2;
      const S = profile.length;
      for (let y1 = 0; y1 < H; y1++) {
        for (let x1 = 0; x1 < W; x1++) {
          const x = x1 < r ? x1 - r : x1 >= W - r ? x1 - r - wB : 0;
          const y = y1 < r ? y1 - r : y1 >= H - r ? y1 - r - hB : 0;
          const dSq = x * x + y * y;
          if (dSq > r1Sq || dSq < rBSq || dSq === 0) continue;
          const dist = Math.sqrt(dSq);
          const fromSide = r - dist;
          const op = dSq < rSq ? 1 : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
          if (op <= 0) continue;
          const bi = Math.min(((fromSide / bz) * S) | 0, S - 1);
          const disp = profile[bi] || 0;
          const idx = (y1 * W + x1) * 4;
          d[idx] = Math.max(0, Math.min(255, (128 + ((-x / dist) * disp) / maxDisp * 127 * op + 0.5) | 0));
          d[idx + 1] = Math.max(0, Math.min(255, (128 + ((-y / dist) * disp) / maxDisp * 127 * op + 0.5) | 0));
        }
      }
    });
    const specCanvas = glassMap(mapW, mapH, radius, Math.max(1, Math.min(bezel * o.specGain, radius)), (d, W, H, r, bz) => {
      d.fill(0);
      const rSq = r * r;
      const r1Sq = (r + 1) * (r + 1);
      const rBSq = Math.max(r - bz, 0) ** 2;
      const wB = W - r * 2;
      const hB = H - r * 2;
      const svx = Math.cos(Math.PI / 3);
      const svy = Math.sin(Math.PI / 3);
      for (let y1 = 0; y1 < H; y1++) {
        for (let x1 = 0; x1 < W; x1++) {
          const x = x1 < r ? x1 - r : x1 >= W - r ? x1 - r - wB : 0;
          const y = y1 < r ? y1 - r : y1 >= H - r ? y1 - r - hB : 0;
          const dSq = x * x + y * y;
          if (dSq > r1Sq || dSq < rBSq || dSq === 0) continue;
          const dist = Math.sqrt(dSq);
          const fromSide = r - dist;
          const op = dSq < rSq ? 1 : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
          if (op <= 0) continue;
          const dot = Math.abs((x / dist) * svx + (-y / dist) * svy);
          const edge = Math.sqrt(Math.max(0, 1 - (1 - fromSide) ** 2));
          const coeff = dot * edge;
          const col = (255 * coeff) | 0;
          const idx = (y1 * W + x1) * 4;
          d[idx] = col;
          d[idx + 1] = col;
          d[idx + 2] = col;
          d[idx + 3] = (col * coeff * op) | 0;
        }
      }
    });
    // scale 是「峰值偏移 × 2」。剖线峰值会随玻璃厚度放大，不加约束能到 290px：
    // 折光带去拉元素外面一百多像素，玻璃糊成一片，右侧 scale/2 处还会裂一条竖线。
    // 面板打开 expandSample：四周留出取样边，位移按折射率走，竖线裁在可见区域外。
    const rawScale = o.dispPx > 0 ? o.dispPx : maxDisp * o.strength;
    const capScale = o.expandSample
      ? Math.max(24, Math.min(w, h) * 0.7)
      : Math.max(6, o.bezelCss * (o.capBezel == null ? 0.85 : o.capBezel));
    const scale = Math.min(rawScale, capScale);
    const padCss = o.expandSample ? Math.ceil(scale / 2) + 8 : 0;
    const padPx = padCss ? Math.max(1, Math.round(padCss * k)) : 0;
    const dispUrl = padMap(dispCanvas, padPx, '#808000');
    const specUrl = padMap(specCanvas, padPx, '');
    let maskUrl = '';
    if (padPx) {
      const mask = document.createElement('canvas');
      mask.width = dispCanvas.width + padPx * 2;
      mask.height = dispCanvas.height + padPx * 2;
      const mctx = mask.getContext('2d');
      mctx.fillStyle = '#fff';
      const rr = typeof mctx.roundRect === 'function';
      mctx.beginPath();
      if (rr) mctx.roundRect(padPx, padPx, dispCanvas.width, dispCanvas.height, radius);
      else {
        const x = padPx; const y = padPx; const mw = dispCanvas.width; const mh = dispCanvas.height;
        mctx.moveTo(x + radius, y);
        mctx.arcTo(x + mw, y, x + mw, y + mh, radius);
        mctx.arcTo(x + mw, y + mh, x, y + mh, radius);
        mctx.arcTo(x, y + mh, x, y, radius);
        mctx.arcTo(x, y, x + mw, y, radius);
        mctx.closePath();
      }
      mctx.fill();
      maskUrl = mask.toDataURL();
    }
    const stretch = 'x="0" y="0" width="100%" height="100%" preserveAspectRatio="none"';
    const crop = maskUrl
      ? `<feImage href="${maskUrl}" ${stretch} result="inner_mask"/>
      <feComposite in="glass_out" in2="inner_mask" operator="in"/>`
      : '';
    const html = `<filter id="${id}" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="${o.blur}" result="blurred_source"/>
      <feImage href="${dispUrl}" ${stretch} result="disp_map"/>
      <feDisplacementMap in="blurred_source" in2="disp_map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="displaced"/>
      <feColorMatrix in="displaced" type="saturate" values="${o.saturate}" result="displaced_sat"/>
      <feImage href="${specUrl}" ${stretch} result="spec_layer"/>
      <feComposite in="displaced_sat" in2="spec_layer" operator="in" result="spec_masked"/>
      <feComponentTransfer in="spec_layer" result="spec_faded">
        <feFuncA type="linear" slope="${o.specFade}"/>
      </feComponentTransfer>
      <feBlend in="spec_masked" in2="displaced" mode="normal" result="with_sat"/>
      <feBlend in="spec_faded" in2="with_sat" mode="normal" result="glass_out"/>
      ${crop}
    </filter>`;
    return { html, pad: padCss, scale };
  }

  /* 玻璃工厂：一块 <defs> 装下所有滤镜，按尺寸缓存复用。
   * 只有「正在屏幕上」的按钮才挂 backdrop-filter；滚出视口的退回普通磨砂，
   * 免得一屏几十上百颗按钮各占一层合成。 */
  function createGlassLab(root) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.appendChild(defs);
    root.appendChild(svg);

    const built = new Map();   // 尺寸键 -> { id, w, h, r }
    const MAX_FILTERS = 200;
    let seq = 0;
    let panelSeq = 0;
    let panelNode = null;

    /** 按钮这一档的参数：比面板薄，折光带吃短边约三成，位移随短边缩放。 */
    function buttonOptions(w, h, r) {
      const s = Math.min(w, h);
      return {
        radiusCss: r,
        radiusMin: 2,
        bezelCss: Math.max(3, s * 0.34),
        bezelMin: 2,
        depth: Math.max(8, s * 0.85),
        ior: 3.0,
        dispPx: Math.max(2, Math.min(16, s * 0.26)),
        saturate: 4,
        specFade: 0.5,
        specGain: 2.5,
        blur: 0.4,
        expandSample: false,
        maxPixels: 160 * 160,
      };
    }

    /** 滤镜额度用完时，退而求其次复用一个尺寸最接近的。 */
    function nearestBox(box) {
      let pick = null;
      built.forEach((rec) => {
        const d = Math.abs(rec.w - box.w) + Math.abs(rec.h - box.h) * 2 + Math.abs(rec.r - box.r) * 4;
        if (!pick || d < pick.d) pick = { d, rec };
      });
      return pick ? pick.rec.id : null;
    }

    function ensure(box) {
      const key = box.w + 'x' + box.h + 'r' + box.r;
      const hit = built.get(key);
      if (hit) return hit.id;
      if (built.size >= MAX_FILTERS) return nearestBox(box);
      const id = 'mtl-g' + (++seq);
      try {
        const rec = buildGlassFilter(id, box.w, box.h, buttonOptions(box.w, box.h, box.r));
        defs.insertAdjacentHTML('beforeend', rec.html);
      } catch (e) {
        console.warn('[MTL] 玻璃滤镜生成失败', e);
        return null;
      }
      built.set(key, { id, w: box.w, h: box.h, r: box.r });
      return id;
    }

    /** 量一个元素；尺寸按桶取整，同尺寸的按钮才能共用同一张图。 */
    function boxOf(el) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w < 10 || h < 10) return null;
      let r = 0;
      try { r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0; } catch (e) { r = 0; }
      r = Math.min(r, Math.min(w, h) / 2);
      return {
        w: Math.max(8, Math.round(w / 8) * 8),
        h: Math.max(8, Math.round(h / 4) * 4),
        r: Math.max(2, Math.round(r / 2) * 2),
      };
    }

    /** 已经量好尺寸的元素直接上玻璃。写样式不影响布局，不会打断这一帧。 */
    function applyBox(el, box) {
      if (el.__mtlGlass || !box) return;
      const id = ensure(box);
      if (!id) return;
      el.__mtlGlass = id;
      el.style.backdropFilter = 'url(#' + id + ')';
      el.style.webkitBackdropFilter = 'url(#' + id + ')';
      el.classList.add('refract');
    }

    function upgrade(el) {
      if (el.__mtlGlass) return;
      applyBox(el, boxOf(el));
    }

    function downgrade(el) {
      if (!el.__mtlGlass) return;
      el.__mtlGlass = '';
      el.style.backdropFilter = '';
      el.style.webkitBackdropFilter = '';
      el.classList.remove('refract');
    }

    let io = null;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.target.isConnected) return;
          if (entry.isIntersecting) upgrade(entry.target);
          else downgrade(entry.target);
        });
      }, { rootMargin: '120px' });
    }

    const groups = new Map();
    const pending = new Set();
    let rafId = 0;

    /** 量尺寸会强制一次布局。攒到动画帧里一次做完：输入处理立刻返回，
     *  连打几个字也只会合并成一次布局，不会一个字卡一下。 */
    function flushEager() {
      rafId = 0;
      const list = [];
      pending.forEach((el) => {
        pending.delete(el);
        if (el.isConnected && !el.__mtlGlass) list.push(el);
      });
      if (!list.length) return;
      const boxes = new Array(list.length);
      for (let i = 0; i < list.length; i++) boxes[i] = boxOf(list[i]);
      for (let i = 0; i < list.length; i++) applyBox(list[i], boxes[i]);
    }

    function scheduleEager(els) {
      if (!els.length) return;
      els.forEach((el) => pending.add(el));
      if (!rafId) rafId = requestAnimationFrame(flushEager);
    }

    function release(group) {
      const set = groups.get(group || 'main');
      if (!set) return;
      set.forEach((el) => { if (io) io.unobserve(el); });
      set.clear();
    }

    /** 挂上一批元素：进观察队列，同时预热前 sync 个（通常就是当前看得见的那几排），
     *  这样第一帧就有折光、不会闪一下。剩下的等滚进视口时由观察器补上。 */
    function watch(list, opts) {
      const o = opts || {};
      const group = o.group || 'main';
      const sync = o.sync == null ? 0 : o.sync;
      if (o.replace) release(group);
      if (!groups.has(group)) groups.set(group, new Set());
      const set = groups.get(group);
      const els = Array.from(list || []).filter(Boolean);
      if (!els.length) return;

      els.forEach((el) => {
        // 建元素时就已经带上了这个类，这里通常什么都不做；
        // 补加会让整批元素的样式再来一遍，别小看这一次重排。
        if (!el.classList.contains('glassable')) el.classList.add('glassable');
        set.add(el);
      });

      if (io) els.forEach((el) => io.observe(el));
      scheduleEager(io ? els.slice(0, sync) : els);
    }

    /** 面板本体：尺寸随窗口变，重建时换个新 id，再把旧的删掉。 */
    function mountPanel(plate) {
      let last = '';
      let timer = 0;
      const rebuild = () => {
        const host = plate.parentElement;
        const w = Math.round((host || plate).offsetWidth);
        const h = Math.round((host || plate).offsetHeight);
        if (w < 8 || h < 8) return;
        const key = w + 'x' + h;
        if (key === last) return;
        last = key;
        try {
          const id = 'mtl-panel-' + (++panelSeq);
          let radiusCss = GLASS_DEFAULTS.radiusCss;
          try {
            const raw = getComputedStyle(host || plate).borderTopLeftRadius;
            const parsed = parseFloat(raw);
            if (parsed > 0) radiusCss = parsed;
          } catch (e) { /* 用默认圆角 */ }
          const rec = buildGlassFilter(id, w, h, {
            radiusCss,
            radiusMin: Math.min(16, Math.max(8, Math.round(radiusCss / 2))),
            expandSample: true,
          });
          defs.insertAdjacentHTML('beforeend', rec.html);
          plate.style.inset = rec.pad ? (-rec.pad + 'px') : '0px';
          plate.style.clipPath = 'none';
          plate.style.backdropFilter = 'url(#' + id + ')';
          plate.style.webkitBackdropFilter = 'url(#' + id + ')';
          plate.classList.add('refract');
          const fresh = defs.lastElementChild;
          if (panelNode && panelNode !== fresh) panelNode.remove();
          panelNode = fresh;
        } catch (e) {
          plate.classList.remove('refract');
        }
      };
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(rebuild, 80);
      };
      if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(plate.parentElement || plate);
      requestAnimationFrame(rebuild);
    }

    /** 面板整个拆掉时调用，别让观察器攥着一堆已经不在页面上的元素。 */
    function destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      pending.clear();
      groups.forEach((set) => set.clear());
      groups.clear();
      built.clear();
      if (io) io.disconnect();
      io = null;
    }

    return { watch, release, mountPanel, upgrade, downgrade, destroy };
  }

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  button, input { font: inherit; color: inherit; }
  .wrap {
    position: fixed; top: 16px; right: 16px; z-index: 2147483647;
    width: min(340px, calc(100vw - 24px));
    max-height: calc(100vh - 32px);
    display: flex; flex-direction: column;
    color: #16130f;
    background: transparent;
    border-radius: 44px;
    box-shadow:
      0 22px 50px -16px rgba(22,19,15,.48),
      0 4px 14px -6px rgba(22,19,15,.22),
      0 0 0 0.5px rgba(255,255,255,.38);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 13px; line-height: 1.45;
    overflow: visible;
    isolation: isolate;
  }
  .shell {
    position: relative; z-index: 1;
    display: flex; flex-direction: column;
    max-height: inherit; min-height: 0; flex: 1;
    overflow: hidden;
    border-radius: inherit;
  }
  .plate {
    position: absolute; inset: 0; z-index: 0; border-radius: inherit; pointer-events: none;
    /* 玻璃本身没有颜色。折光在滤镜里；这里只留很淡的底，免得又变成白膜。 */
    background: rgba(255,255,255,.06);
    box-shadow: inset 0 0 18px -10px rgba(255,255,255,.42);
    backdrop-filter: blur(8px) saturate(1.6);
    -webkit-backdrop-filter: blur(8px) saturate(1.6);
  }
  .plate.refract {
    background: transparent;
    box-shadow: none;
  }
  .lip {
    position: absolute; inset: 0; z-index: 2; pointer-events: none; border-radius: inherit;
    /* 高光只贴边：顶边最亮，左边次之，右下几乎不亮。
       大面积白渐变会把磨砂盖掉，玻璃就没了。 */
    box-shadow:
      inset 0 1.2px 0 rgba(255,255,255,.88),
      inset 1px 0 0 rgba(255,255,255,.32),
      inset -0.8px 0 0 rgba(255,255,255,.1),
      inset 0 -0.8px 0 rgba(255,255,255,.08),
      inset 0 -20px 26px -20px rgba(38,50,70,.2);
    background:
      linear-gradient(155deg, rgba(255,255,255,.22), rgba(255,255,255,0) 18%),
      linear-gradient(180deg, rgba(255,255,255,.12), rgba(255,255,255,0) 12%),
      /* 底下加薄薄一层，字和按钮才看得清；别铺满，否则又变成白膜。 */
      linear-gradient(180deg, rgba(255,255,255,0) 50%, rgba(255,250,244,.2) 82%, rgba(255,248,240,.3));
  }
  .hd, .body {
    position: relative; z-index: 3;
    /* 面板压在漫画封面上，底下是什么颜色说不准。
       给深色字垫一层很淡的白晕：浅底上看不出来，深底上正好把字托住。 */
    text-shadow: 0 1px 0 rgba(255,255,255,.5);
  }
  .hd {
    display: flex; align-items: center; gap: 8px;
    min-height: 58px; padding: 13px 15px 11px 20px;
    cursor: pointer; user-select: none;
  }
  .hd:active { cursor: grabbing; }
  .name { font-weight: 660; font-size: 14px; letter-spacing: -0.01em; }
  .ver, .sum { color: rgba(28,25,21,.52); font-size: 11px; }
  .sum { display: none; }
  .chev {
    margin-left: auto;
    padding: 5px 11px 4px; border-radius: 999px;
    font-size: 12px; font-weight: 660;
  }
  .wrap.collapsed .body { display: none; }
  .wrap.collapsed .ver { display: none; }
  .wrap.collapsed .sum { display: inline; }
  .body {
    padding: 0 16px 18px;
    display: flex; flex-direction: column; gap: 10px;
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(22,19,15,.35) transparent;
  }
  .body::-webkit-scrollbar,
  .list::-webkit-scrollbar { width: 8px; height: 8px; }
  .body::-webkit-scrollbar-track,
  .list::-webkit-scrollbar-track { background: transparent; }
  .body::-webkit-scrollbar-thumb,
  .list::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,.7);
    border: 2px solid transparent;
    background-clip: padding-box;
    border-radius: 999px;
    box-shadow: inset 0 0 0 1px rgba(22,19,15,.2);
  }
  .body::-webkit-scrollbar-button,
  .list::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
  .body::-webkit-scrollbar-corner,
  .list::-webkit-scrollbar-corner { background: transparent; }
  .seg {
    display: grid; grid-template-columns: 1fr 1fr; gap: 4px;
    padding: 4px; border-radius: 999px;
    background: rgba(255,255,255,.06);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.42),
      inset 1px 0 0 rgba(255,255,255,.18),
      inset -0.8px 0 0 rgba(255,255,255,.08),
      inset 0 -0.8px 0 rgba(255,255,255,.08);
  }
  .seg button {
    border: 0; color: rgba(22,19,15,.7);
    border-radius: 999px; min-height: 44px; padding: 8px 10px 7px; cursor: pointer; line-height: 1.2;
  }
  .seg button small { display: block; font-size: 10px; letter-spacing: .05em; opacity: .68; }
  .field {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    min-height: 48px; padding: 8px 12px;
    background: rgba(255,255,255,.06);
    border-radius: 999px; cursor: text;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.55),
      inset 1px 0 0 rgba(255,255,255,.2),
      inset -0.8px 0 0 rgba(255,255,255,.08),
      inset 0 -0.8px 0 rgba(255,255,255,.08),
      inset 0 8px 14px -10px rgba(38,50,70,.28);
    transition: box-shadow .18s ease;
  }
  .field:focus-within {
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.85),
      inset 0 0 0 1px rgba(255,255,255,.42),
      inset 0 8px 16px -10px rgba(38,50,70,.32);
  }

  /* 玻璃基本面：没挂上折射时是磨砂，挂上之后由 backdrop-filter 折背景。
     不要 overflow:hidden —— 会把外圈投影裁掉，按钮就贴死在面板上。 */
  .glassable {
    position: relative;
    background-color: rgba(255,255,255,.1);
    background-image: linear-gradient(180deg, rgba(255,255,255,.32), rgba(255,255,255,.05) 42%, rgba(255,255,255,0) 100%);
    background-repeat: no-repeat;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.82),
      inset 1px 0 0 rgba(255,255,255,.28),
      inset -0.8px 0 0 rgba(255,255,255,.1),
      inset 0 -0.8px 0 rgba(255,255,255,.08),
      inset 0 -8px 12px -8px rgba(38,50,70,.16),
      0 6px 14px -8px rgba(22,19,15,.22);
    transition: transform .16s cubic-bezier(.23,1,.32,1), box-shadow .18s ease, background-color .18s ease;
  }
  .glassable.refract {
    background-color: rgba(255,255,255,.03);
    background-image: linear-gradient(180deg, rgba(255,255,255,.2), rgba(255,255,255,.03) 40%, rgba(255,255,255,0) 100%);
  }
  @media (hover: hover) and (pointer: fine) {
    .glassable:hover {
      background-color: rgba(255,255,255,.14);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,.95),
        inset 1px 0 0 rgba(255,255,255,.4),
        inset -0.8px 0 0 rgba(255,255,255,.12),
        inset 0 -0.8px 0 rgba(255,255,255,.1),
        inset 0 -8px 12px -8px rgba(38,50,70,.18),
        0 8px 16px -8px rgba(22,19,15,.26);
    }
  }
  .glassable:active:not(:disabled) { transform: scale(.972); }
  .glassable:focus-visible { outline: 2px solid rgba(96,162,255,.9); outline-offset: 2px; }
  .glassable:disabled { opacity: .4; cursor: default; }

  .seg button.on,
  .tag.on {
    color: #16130f; font-weight: 660;
    background-color: rgba(255,255,255,.28);
    background-image: linear-gradient(180deg, rgba(255,255,255,.36), rgba(255,255,255,.05) 50%, rgba(255,255,255,0) 100%);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.95),
      inset 1px 0 0 rgba(255,255,255,.42),
      inset -0.8px 0 0 rgba(255,255,255,.14),
      inset 0 -0.8px 0 rgba(255,255,255,.1),
      inset 0 -12px 16px -8px rgba(64,120,180,.16),
      0 6px 14px -8px rgba(22,19,15,.22);
  }
  .chip {
    display: inline-flex; align-items: center; gap: 3px; max-width: 100%;
    padding: 3px 4px 3px 10px; color: #1c1915;
    border-radius: 999px; font-size: 12px; font-weight: 660;
    border: 0; overflow: hidden;
  }
  .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 176px; }
  .chip button {
    width: 19px; height: 19px; border: 0; border-radius: 50%;
    display: grid; place-items: center; padding: 0;
    color: #1c1915; background: rgba(255,255,255,.34);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.75);
    cursor: pointer; line-height: 1; font-size: 12px;
    transition: background-color .15s ease;
  }
  .chip button:hover { background: rgba(255,255,255,.68); }
  .chip.away, .tag.away { opacity: .7; }
  .field input {
    flex: 1; min-width: 118px; border: 0; outline: none;
    appearance: none; border-radius: 999px;
    background: transparent; padding: 4px 2px; font-size: 13px; color: #1c1915;
  }
  .field input::placeholder { color: rgba(28,25,21,.42); }
  .hint { min-height: 16px; font-size: 11px; line-height: 1.5; color: rgba(28,25,21,.55); }
  .hint.note { color: #1c1915; }
  .hint.warn { color: #8a4a06; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .count { color: rgba(28,25,21,.6); font-size: 12px; }
  .count b { color: #1c1915; font-size: 18px; font-weight: 720; font-variant-numeric: tabular-nums; }
  .jump {
    border: 0; color: #1c1915;
    cursor: pointer; font-size: 12px; font-weight: 660;
    border-radius: 999px; padding: 7px 12px 6px;
  }
  .pager { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .pager button {
    border: 0; min-height: 44px; border-radius: 999px; cursor: pointer;
    color: #16130f; font-size: 14px; font-weight: 660;
  }
  .clear {
    width: 100%; border: 0; color: #16130f;
    border-radius: 999px; min-height: 44px; padding: 10px 14px;
    cursor: pointer; font-size: 13px; font-weight: 660;
  }
  .list {
    display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start;
    max-height: 40vh; overflow: auto;
    padding: 3px;
    scrollbar-width: thin;
    scrollbar-color: rgba(22,19,15,.32) transparent;
  }
  .tag {
    display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
    border: 0; color: #1c1915;
    border-radius: 999px; padding: 6px 12px 6px 13px; cursor: pointer; font-size: 12px;
    overflow: hidden;
  }
  .tag > span:first-child {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 148px;
  }
  .tag .n { color: rgba(28,25,21,.48); font-size: 10px; font-variant-numeric: tabular-nums; }
  .tag.on .n { color: rgba(28,25,21,.55); }
  .tag.hot {
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.95),
      inset 1px 0 0 rgba(255,255,255,.4),
      inset -0.8px 0 0 rgba(255,255,255,.12),
      inset 0 -0.8px 0 rgba(255,255,255,.1),
      inset 0 -10px 14px -8px rgba(38,50,70,.16),
      0 0 0 2px rgba(96,162,255,.22),
      0 6px 14px -8px rgba(22,19,15,.22);
  }
  .tag.dim { opacity: .42; }
  .tag kbd {
    font-family: inherit; font-size: 10px; padding: 2px 7px; border-radius: 999px;
    background: rgba(255,255,255,.4); color: #1c1915;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.85);
  }
  .empty { color: rgba(28,25,21,.6); font-size: 12px; padding: 8px 2px; }
  .foot { margin: 0; font-size: 11px; color: rgba(22,19,15,.56); line-height: 1.45; }

  /* 页面是黑底时：浅字、深玻璃，白晕改成黑晕。 */
  .wrap.night { color: #f3efe6; }
  .wrap.night .plate,
  .wrap.night .plate.refract { background: rgba(10,12,16,.62); }
  .wrap.night .lip {
    background:
      linear-gradient(155deg, rgba(255,255,255,.14), rgba(255,255,255,0) 18%),
      linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,0) 12%),
      linear-gradient(180deg, rgba(255,255,255,0) 52%, rgba(6,8,12,.42) 84%, rgba(6,8,12,.58));
  }
  .wrap.night .hd, .wrap.night .body { text-shadow: 0 1px 2px rgba(0,0,0,.72); }
  .wrap.night .glassable {
    background-color: rgba(255,255,255,.08);
    background-image: linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,.03) 42%, rgba(255,255,255,0) 100%);
  }
  .wrap.night .glassable.refract {
    background-color: rgba(255,255,255,.05);
  }
  .wrap.night .seg button.on,
  .wrap.night .tag.on {
    background-color: rgba(255,255,255,.16);
  }
  .wrap.night .ver, .wrap.night .sum, .wrap.night .hint, .wrap.night .count,
  .wrap.night .foot, .wrap.night .empty, .wrap.night .tag .n, .wrap.night .tag.on .n {
    color: rgba(243,239,230,.62);
  }
  .wrap.night .name, .wrap.night .hint.note, .wrap.night .count b,
  .wrap.night .chip, .wrap.night .tag, .wrap.night .jump,
  .wrap.night .pager button, .wrap.night .clear, .wrap.night .field input,
  .wrap.night .seg button.on, .wrap.night .tag.on, .wrap.night .tag kbd, .wrap.night .chev {
    color: #f6f1e8;
  }
  .wrap.night .seg button { color: rgba(243,239,230,.78); }
  .wrap.night .hint.warn { color: #ffc56a; }
  .wrap.night .field input::placeholder { color: rgba(243,239,230,.4); }
  .wrap.night .chip button {
    color: #f6f1e8; background: rgba(255,255,255,.12);
  }
  .wrap.night .body { scrollbar-color: rgba(255,255,255,.35) transparent; }

  @media (prefers-reduced-transparency: reduce) {
    .plate, .plate.refract {
      background: rgba(250,246,240,.94);
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      box-shadow: none;
    }
    .glassable, .glassable.refract {
      background-color: rgba(255,255,255,.78);
      background-image: none;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    .lip { background: none; }
    .wrap.night .plate, .wrap.night .plate.refract {
      background: rgba(22, 24, 28, .94);
    }
  }
  @media (prefers-contrast: more) {
    .wrap { box-shadow: 0 0 0 2px #16130f, 0 22px 50px -16px rgba(22,19,15,.48); }
    .glassable { box-shadow: inset 0 0 0 1.5px rgba(22,19,15,.55); }
  }
  `;

  const PAGE_CSS = `
  /* 高亮只画在封面内侧：整圈实边 + Magic UI 那种沿边走的光点。
   * 不要给整格或封面写 padding / margin / width / height / border-radius：
   * 封面是 100% 宽 + 官方 3/4，父级一加内边距就会比旁边没高亮的小一圈。 */
  @property --mtl-beam {
    syntax: '<angle>';
    inherits: false;
    initial-value: 0deg;
  }
  [data-mtl-cover] {
    position: relative !important;
    outline: none !important;
    box-shadow:
      inset 0 0 0 2px rgba(255, 184, 40, .92),
      inset 0 0 14px rgba(255, 150, 20, .22) !important;
  }
  [data-mtl-cover]::after {
    content: '' !important;
    position: absolute !important;
    inset: 0 !important;
    z-index: 5 !important;
    pointer-events: none !important;
    border-radius: 4px !important;
    padding: var(--mtl-line, 2.5px) !important;
    background: conic-gradient(
      from var(--mtl-beam),
      #ffb420 0 78%,
      #ffe08a 86%,
      #fff 90%,
      #ffcf55 95%,
      #ffb420 100%
    ) !important;
    -webkit-mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0) !important;
    -webkit-mask-composite: xor !important;
    mask-composite: exclude !important;
    animation: mtl-beam 2.6s linear infinite !important;
  }
  @keyframes mtl-beam {
    to { --mtl-beam: 360deg; }
  }
  /* 当前看的那一本换成冷色。角标挂在封面上，封面自己是 relative。 */
  [data-mtl-focus="1"] [data-mtl-cover],
  [data-mtl-focus="1"][data-mtl-cover] {
    box-shadow:
      inset 0 0 0 2px rgba(120, 210, 255, .95),
      inset 0 0 14px rgba(60, 170, 240, .28) !important;
    z-index: 4;
  }
  [data-mtl-focus="1"] [data-mtl-cover]::after,
  [data-mtl-focus="1"][data-mtl-cover]::after {
    background: conic-gradient(
      from var(--mtl-beam),
      #5ec8ff 0 78%,
      #d8f3ff 86%,
      #fff 90%,
      #7ed4ff 95%,
      #5ec8ff 100%
    ) !important;
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mtl-cover]::after { animation: none !important; --mtl-beam: 210deg; }
  }
  .mtl-focus-badge {
    position: absolute !important;
    top: 10px !important;
    left: 10px !important;
    z-index: 6 !important;
    background: linear-gradient(180deg, rgba(255,255,255,.86), rgba(150, 220, 255, .55)) !important;
    color: #0c2433 !important;
    font: 650 12px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important;
    letter-spacing: .02em !important;
    padding: 5px 10px !important;
    border-radius: 999px !important;
    pointer-events: none !important;
    backdrop-filter: blur(16px) saturate(1.8) !important;
    -webkit-backdrop-filter: blur(16px) saturate(1.8) !important;
    box-shadow: inset 0 1px 0 #fff, 0 0 0 1px rgba(170, 225, 255, .75), 0 8px 18px rgba(40, 130, 190, .28) !important;
  }
  /* 没对上的压暗，但不靠「变透明」——那样连字一起淡掉。
     改成降饱和 + 稍微压一点亮度，弱化的同时反而把浅色字衬得更清楚。 */
  [data-mtl="miss"] {
    opacity: .8 !important;
    filter: saturate(.55) brightness(.96) !important;
  }
  [data-mtl-tag="1"] {
    background: linear-gradient(180deg, rgba(255,255,255,.88), rgba(255, 196, 110, .62)) !important;
    color: #3a2408 !important;
    border-radius: 999px !important;
    box-shadow: inset 0 1px 0 #fff, 0 0 0 1px rgba(255, 190, 90, .7) !important;
    font-weight: 650 !important;
    text-decoration: none !important;
  }
  `;

  function ensurePageStyle() {
    if (document.getElementById('mtl-page-style')) return;
    const style = document.createElement('style');
    style.id = 'mtl-page-style';
    style.textContent = PAGE_CSS;
    document.documentElement.appendChild(style);
  }

  function buildUI() {
    ensurePageStyle();
    const host = document.createElement('div');
    host.id = 'mtl-host';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <div class="plate"></div>
      <div class="shell">
      <div class="lip"></div>
      <div class="hd" title="点击展开或收起，按住拖动">
        <span class="name">标签透镜</span>
        <span class="ver">v${VERSION}</span>
        <span class="sum"></span>
        <span class="chev glassable">收起</span>
      </div>
      <div class="body">
        <div class="seg">
          <button type="button" class="glassable" data-act="logic" data-v="and">同时要<small>AND</small></button>
          <button type="button" class="glassable" data-act="logic" data-v="or">有一个就行<small>OR</small></button>
        </div>
        <div class="field">
          <span class="chips"></span>
          <input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入标签，回车记下。本页没有也能加" />
        </div>
        <div class="hint"></div>
        <div class="row">
          <div class="count"></div>
          <button class="jump glassable" type="button" data-act="jump">跳到下一本</button>
        </div>
        <div class="pager">
          <button type="button" class="glassable" data-act="page" data-dir="prev">上一页</button>
          <button type="button" class="glassable" data-act="page" data-dir="next">下一页</button>
        </div>
        <div class="list"></div>
        <p class="foot">不分大小写，简繁算同一个。这一页没有的词也会记下。</p>
        <button class="clear glassable" type="button" data-act="reset">清空已选</button>
      </div>
      </div>
    `;
    root.appendChild(wrap);
    document.documentElement.appendChild(host);

    ui = {
      host,
      root,
      panel: wrap,
      lab: createGlassLab(root),
      chips: wrap.querySelector('.chips'),
      listBox: wrap.querySelector('.list'),
      statusBox: wrap.querySelector('.count'),
      hintBox: wrap.querySelector('.hint'),
      kwInput: wrap.querySelector('input'),
      chev: wrap.querySelector('.chev'),
      sum: wrap.querySelector('.sum'),
      jumpBtn: wrap.querySelector('[data-act="jump"]'),
      clearBtn: wrap.querySelector('[data-act="reset"]'),
      pagerPrev: wrap.querySelector('[data-dir="prev"]'),
      pagerNext: wrap.querySelector('[data-dir="next"]'),
    };
    ui.lab.mountPanel(wrap.querySelector('.plate'));
    ui.lab.watch(wrap.querySelectorAll('.glassable'), { group: 'chrome', sync: 99 });

    let composing = false;
    ui.kwInput.addEventListener('compositionstart', () => { composing = true; });
    ui.kwInput.addEventListener('compositionend', () => {
      composing = false;
      state.keyword = ui.kwInput.value;
      renderList();
    });
    ui.kwInput.addEventListener('input', () => {
      if (composing) return;
      state.keyword = ui.kwInput.value;
      state.hint = '';
      state.hintKind = '';
      renderList();
      renderHint();
    });
    ui.kwInput.addEventListener('keydown', (e) => {
      if (composing || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        e.preventDefault();
        commitQuery();
        return;
      }
      if (e.key === ' ' && resolveToken(state.keyword).type === 'one') {
        e.preventDefault();
        commitQuery();
        return;
      }
      if (e.key === 'Backspace' && !ui.kwInput.value && picks.length) {
        removePick(picks[picks.length - 1]);
        renderPanel({ keepScroll: true });
        applyHighlight();
      }
    });
    ui.kwInput.addEventListener('paste', (e) => {
      const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
      if (!/[\s,，;；、\n]/.test(text)) return;
      e.preventDefault();
      addFromText(text);
    });

    wrap.querySelector('.field').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      ui.kwInput.focus();
    });

    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'logic') {
        settings.logic = btn.dataset.v === 'or' ? 'or' : 'and';
        saveSettings(settings);
        renderLogic();
        applyHighlight();
        return;
      }
      if (act === 'reset') { clearAll(); return; }
      if (act === 'jump') { jumpNext(); return; }
      if (act === 'page') {
        const href = btn.dataset.href;
        if (!href || btn.disabled) return;
        location.assign(href);
        return;
      }
      if (act === 'del') {
        removePick(btn.dataset.key);
        renderPanel({ keepScroll: true });
        applyHighlight();
        ui.kwInput.focus();
        return;
      }
      if (act === 'pick') {
        const key = btn.dataset.key;
        if (picks.includes(key)) removePick(key);
        else addPick(key);
        state.keyword = '';
        state.hint = '';
        state.hintKind = '';
        ui.kwInput.value = '';
        renderPanel();
        applyHighlight();
      }
    });

    applyCollapsed();
    applyPanelPos();
    applyPageTheme();
    watchPageTheme();
    makeDraggable(ui.panel, wrap.querySelector('.hd'));
    window.addEventListener('resize', applyPanelPos);
  }

  function applyCollapsed() {
    if (!ui.panel) return;
    ui.panel.classList.toggle('collapsed', !!settings.collapsePanel);
    if (ui.chev) ui.chev.textContent = settings.collapsePanel ? '展开' : '收起';
  }

  function applyPageTheme() {
    if (!ui.panel) return;
    ui.panel.classList.toggle('night', pageIsDark());
  }

  let themeWatch = null;
  function watchPageTheme() {
    applyPageTheme();
    if (themeWatch) return;
    themeWatch = new MutationObserver(() => applyPageTheme());
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-bs-theme'] });
    if (document.body) {
      themeWatch.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-bs-theme'] });
    }
    window.addEventListener('load', applyPageTheme);
    setTimeout(applyPageTheme, 400);
  }

  function toggleCollapse() {
    settings.collapsePanel = !settings.collapsePanel;
    saveSettings(settings);
    applyCollapsed();
  }

  function readPanelPos(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const left = Number(raw.left);
    const top = Number(raw.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  }

  function applyPanelPos() {
    if (!ui.panel) return;
    const pos = readPanelPos(settings.panelPos);
    if (!pos) return;
    const r = ui.panel.getBoundingClientRect();
    const w = r.width || 340;
    const left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - w));
    const top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - 48));
    ui.panel.style.left = left + 'px';
    ui.panel.style.top = top + 'px';
    ui.panel.style.right = 'auto';
  }

  function persistPanelPos(panel) {
    const r = panel.getBoundingClientRect();
    settings.panelPos = { left: Math.round(r.left), top: Math.round(r.top) };
    saveSettings(settings);
  }

  function makeDraggable(panel, handle) {
    let dragging = false;
    let moved = false;
    let sx = 0; let sy = 0; let ox = 0; let oy = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        moved = true;
        panel.style.left = Math.max(0, ox + dx) + 'px';
        panel.style.top = Math.max(0, oy + dy) + 'px';
        panel.style.right = 'auto';
      }
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (moved) persistPanelPos(panel);
    });
    handle.addEventListener('click', () => {
      if (moved) { moved = false; return; }
      toggleCollapse();
    });
  }

  function renderLogic() {
    if (!ui.root) return;
    ui.root.querySelectorAll('[data-act="logic"]').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === settings.logic);
    });
  }

  function renderChips() {
    if (!ui.chips) return;
    ui.chips.replaceChildren();
    picks.forEach((key) => {
      const chip = document.createElement('span');
      chip.className = 'chip glassable' + (state.tagIndex.has(key) ? '' : ' away');
      if (!state.tagIndex.has(key)) chip.title = '本页还没有，已记下';
      const name = document.createElement('span');
      name.textContent = labelOf(key);
      const x = document.createElement('button');
      x.type = 'button';
      x.dataset.act = 'del';
      x.dataset.key = key;
      x.textContent = '×';
      x.title = '去掉';
      chip.appendChild(name);
      chip.appendChild(x);
      ui.chips.appendChild(chip);
    });
    if (ui.lab) ui.lab.watch(ui.chips.children, { group: 'chips', replace: true, sync: 24 });
  }

  function renderHint() {
    if (!ui.hintBox) return;
    ui.hintBox.textContent = state.hint || '';
    ui.hintBox.classList.toggle('warn', state.hintKind === 'warn');
    ui.hintBox.classList.toggle('note', state.hintKind === 'note');
  }

  function renderList(opts) {
    if (!ui.listBox) return;
    const keep = opts && opts.keepScroll;
    const top = ui.listBox.scrollTop;
    const q = norm(state.keyword);
    const tags = orderedTags();
    const target = enterTarget(tags);
    ui.listBox.replaceChildren();
    if (ui.lab) ui.lab.release('tags');

    if (!tags.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '本页没有读到标签。直接输入也能记下，换页后会对上';
      ui.listBox.appendChild(empty);
      return;
    }

    tags.slice(0, 400).forEach((t) => {
      const hot = q && rank(t.key, q) < 3;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag glassable';
      btn.dataset.act = 'pick';
      btn.dataset.key = t.key;
      if (picks.includes(t.key)) btn.classList.add('on');
      if (t.away || !state.tagIndex.has(t.key)) btn.classList.add('away');
      if (hot) btn.classList.add('hot');
      if (q && !hot) btn.classList.add('dim');

      const name = document.createElement('span');
      name.textContent = t.label;
      btn.appendChild(name);

      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = (t.away || !state.tagIndex.has(t.key)) ? '未出现' : String(t.count);
      btn.appendChild(n);

      if (t.key === target) {
        const kbd = document.createElement('kbd');
        kbd.textContent = '回车';
        btn.appendChild(kbd);
      }
      ui.listBox.appendChild(btn);
    });
    ui.listBox.scrollTop = keep ? top : 0;
    if (ui.lab) ui.lab.watch(ui.listBox.children, { group: 'tags', sync: 48 });
  }

  function renderStatus() {
    if (!ui.statusBox) return;
    if (!picks.length) {
      ui.statusBox.textContent = '本页 ' + state.total + ' 部有标签';
    } else if (state.cursor >= 0 && state.matched > 0) {
      ui.statusBox.innerHTML = '亮了 <b>' + state.matched + '</b> / ' + state.total
        + ' · 当前第 ' + (state.cursor + 1) + ' 本';
    } else if (state.matched === 0) {
      ui.statusBox.innerHTML = '亮了 <b>0</b> / ' + state.total + ' · 本页还没对上';
    } else {
      ui.statusBox.innerHTML = '亮了 <b>' + state.matched + '</b> / ' + state.total;
    }
    if (ui.sum) ui.sum.textContent = picks.length ? (picks.length + ' 个标签') : '未选标签';
    if (ui.jumpBtn) ui.jumpBtn.disabled = state.matched <= 0 || !picks.length;
    if (ui.clearBtn) ui.clearBtn.disabled = !picks.length;
    renderPager();
  }

  function renderPager() {
    if (!ui.pagerPrev || !ui.pagerNext) return;
    const prev = findPageHref('prev');
    const next = findPageHref('next');
    ui.pagerPrev.disabled = !prev;
    ui.pagerNext.disabled = !next;
    if (prev) ui.pagerPrev.dataset.href = prev;
    else delete ui.pagerPrev.dataset.href;
    if (next) ui.pagerNext.dataset.href = next;
    else delete ui.pagerNext.dataset.href;
  }

  function renderPanel(opts) {
    renderLogic();
    renderChips();
    renderHint();
    renderList(opts);
    renderStatus();
  }

  /* ============================================================
   * 7. 启动
   * ============================================================ */

  function destroyUI() {
    restoreOrder();
    clearMarks();
    if (ui.lab) ui.lab.destroy();
    if (ui.host) {
      ui.host.remove();
      ui.host = null;
    }
    ui = {};
  }

  function boot(allowEmpty) {
    if (!isJmcomicHost() && !isLocalPreview()) return true;
    state.adapter = pickAdapter();
    if (!state.adapter) return true;
    const found = collect();
    if (!found && !allowEmpty) {
      console.log('[MTL] 当前页面未识别到带标签的漫画条目。适配器：' + state.adapter.name);
      return false;
    }
    if (!document.getElementById('mtl-host')) buildUI();
    restorePicks();
    renderPanel();
    applyHighlight();
    const lib = toCN ? 'OpenCC' : '仅大小写';
    console.log('[MTL] 已启动 ' + VERSION + '，适配器：' + state.adapter.name + '，条目 ' + state.total + '，标签 ' + state.tagIndex.size + '，简繁 ' + lib);
    return true;
  }

  function bootOrWait(tries) {
    if (boot(tries <= 0)) return;
    if (tries <= 0) return;
    setTimeout(() => bootOrWait(tries - 1), 800);
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('重新扫描本页', () => {
      destroyUI();
      bootOrWait(3);
    });
    GM_registerMenuCommand('清除高亮', () => clearAll());
  }

  bootOrWait(8);
})();
