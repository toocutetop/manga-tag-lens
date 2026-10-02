// ==UserScript==
// @name         Manga Tag Lens · 漫画标签透镜
// @name:en      Manga Tag Lens
// @namespace    https://github.com/toocutetop/manga-tag-lens
// @version      0.2.15
// @updateURL    https://cdn.jsdelivr.net/gh/toocutetop/manga-tag-lens@main/src/manga-tag-lens.user.js
// @downloadURL  https://cdn.jsdelivr.net/gh/toocutetop/manga-tag-lens@main/src/manga-tag-lens.user.js
// @description  记下要找的标签，在当前页把对上的漫画亮出来。本页没有的标签也会保存，换页后继续对。不分大小写，简体繁体视为同一个。
// @description:en  Type tags to highlight matching comics on the current page. Case-insensitive, simplified and traditional Chinese match, with AND / OR.
// @author       you
// @match        *://*/*
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

  const VERSION = '0.2.15';
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
    for (let i = 0; i < ADAPTERS.length - 1; i++) {
      try {
        if (ADAPTERS[i].test()) return ADAPTERS[i];
      } catch (e) { /* 单个适配器出错就跳过 */ }
    }
    return ADAPTERS[ADAPTERS.length - 1];
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

  function medianCellWidth(parent) {
    const base = layoutSnap.get(parent) || [];
    const widths = base
      .map((node) => (node.getBoundingClientRect ? node.getBoundingClientRect().width : 0))
      .filter((w) => w > 40)
      .sort((a, b) => a - b);
    if (!widths.length) return 0;
    return widths[Math.floor(widths.length / 2)];
  }

  function docBefore(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

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
    });

    const tracks = [];
    const grids = [];
    groups.forEach((list, parent) => {
      (isTrack(parent) ? tracks : grids).push(parent);
    });
    const sized = grids.map((parent) => ({ parent, w: medianCellWidth(parent) })).filter((item) => item.w > 0);
    const buckets = [];
    sized.forEach((item) => {
      const bucket = buckets.find((b) => Math.abs(b.w - item.w) / b.w < 0.12);
      if (bucket) bucket.items.push(item.parent);
      else buckets.push({ w: item.w, items: [item.parent] });
    });
    buckets.forEach((bucket) => {
      const list = bucket.items.sort(docBefore);
      if (list.length < 2) {
        reorderWithin(list[0]);
        return;
      }
      const dest = list[0];
      const hits = [];
      const seen = new Set();
      list.forEach((parent) => {
        layoutSnap.get(parent).forEach((node) => {
          if (seen.has(node)) return;
          if (state.items.some((it) => it.hit && it.cell === node)) {
            seen.add(node);
            hits.push(node);
          }
        });
      });
      const destRest = layoutSnap.get(dest).filter((node) => !seen.has(node));
      placeNodes(dest, hits.concat(destRest));
      list.slice(1).forEach((parent) => {
        placeNodes(parent, layoutSnap.get(parent).filter((node) => !seen.has(node)));
      });
    });

    tracks.forEach((parent) => {
      reorderWithin(parent);
      settleTrack(parent);
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
    qsa(document, '[data-mtl]').forEach((el) => el.removeAttribute('data-mtl'));
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
        markTagNodes(it.el, it.keys.filter((k) => picks.includes(k)));
      } else {
        it.el.setAttribute('data-mtl', 'miss');
      }
    });
    reorderHits();
    state.matched = active ? matched : state.total;
    markFocus();
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
    const badge = document.createElement('div');
    badge.className = 'mtl-focus-badge';
    badge.textContent = '当前 ' + (state.cursor + 1) + '/' + list.length;
    el.appendChild(badge);
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
   * 6. 面板
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
    return c.toDataURL();
  }

  function buildGlassFilter(w, h) {
    let mapW = w;
    let mapH = h;
    const maxPixels = 280 * 360;
    if (mapW * mapH > maxPixels) {
      const k = Math.sqrt(maxPixels / (mapW * mapH));
      mapW = Math.max(8, Math.round(mapW * k));
      mapH = Math.max(8, Math.round(mapH * k));
    }
    const radius = Math.min(Math.max(16, Math.round(40 * mapW / w)), Math.floor(Math.min(mapW, mapH) / 2) - 1);
    const bezel = Math.max(12, Math.min(Math.round(34 * mapW / w), radius - 1));
    const profile = glassProfile(78, bezel, 2.6);
    let maxDisp = 1;
    for (let i = 0; i < profile.length; i++) maxDisp = Math.max(maxDisp, Math.abs(profile[i]));
    const dispUrl = glassMap(mapW, mapH, radius, bezel, (d, W, H, r, bz) => {
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
    const specUrl = glassMap(mapW, mapH, radius, Math.min(bezel * 2.5, radius), (d, W, H, r, bz) => {
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
    const scale = maxDisp * 1.55;
    return `<filter id="mtl-lg" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="blurred_source"/>
      <feImage href="${dispUrl}" x="0" y="0" width="${w}" height="${h}" result="disp_map"/>
      <feDisplacementMap in="blurred_source" in2="disp_map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="displaced"/>
      <feColorMatrix in="displaced" type="saturate" values="4" result="displaced_sat"/>
      <feImage href="${specUrl}" x="0" y="0" width="${w}" height="${h}" result="spec_layer"/>
      <feComposite in="displaced_sat" in2="spec_layer" operator="in" result="spec_masked"/>
      <feComponentTransfer in="spec_layer" result="spec_faded">
        <feFuncA type="linear" slope="0.85"/>
      </feComponentTransfer>
      <feBlend in="spec_masked" in2="displaced" mode="normal" result="with_sat"/>
      <feBlend in="spec_faded" in2="with_sat" mode="normal"/>
    </filter>`;
  }

  function mountGlass(root, plate) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('color-interpolation-filters', 'sRGB');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.appendChild(defs);
    root.appendChild(svg);
    let timer = 0;
    let last = '';
    const rebuild = () => {
      const w = Math.round(plate.offsetWidth);
      const h = Math.round(plate.offsetHeight);
      if (w < 8 || h < 8) return;
      const key = w + 'x' + h;
      if (key === last) return;
      last = key;
      try {
        defs.innerHTML = buildGlassFilter(w, h);
        plate.classList.add('refract');
      } catch (e) {
        plate.classList.remove('refract');
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(rebuild, 80);
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(plate);
    requestAnimationFrame(rebuild);
  }

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  button, input { font: inherit; color: inherit; }
  .wrap {
    position: fixed; top: 16px; right: 16px; z-index: 2147483647;
    width: min(336px, calc(100vw - 24px));
    max-height: calc(100vh - 32px);
    display: flex; flex-direction: column;
    color: #16130f;
    border-radius: 40px;
    box-shadow: 0 10px 30px rgba(0,0,0,.16), 0 1px 0 rgba(255,255,255,.35);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 13px; line-height: 1.45;
    overflow: hidden;
    isolation: isolate;
  }
  .plate {
    position: absolute; inset: 0; z-index: 0; border-radius: inherit; pointer-events: none;
    background: rgba(255,255,255,.16);
    box-shadow: inset 0 0 24px -8px rgba(255,255,255,.65);
    backdrop-filter: blur(22px) saturate(1.8);
    -webkit-backdrop-filter: blur(22px) saturate(1.8);
  }
  .plate.refract {
    background: rgba(255,255,255,.06);
    backdrop-filter: url(#mtl-lg);
    -webkit-backdrop-filter: url(#mtl-lg);
  }
  .lip {
    position: absolute; inset: 0; z-index: 2; pointer-events: none; border-radius: inherit;
    box-shadow:
      inset 0 1.5px 0 rgba(255,255,255,.92),
      inset 0 0 0 1px rgba(255,255,255,.38),
      inset 0 -18px 24px rgba(255,255,255,.06);
    background: linear-gradient(180deg, rgba(255,255,255,.34), rgba(255,255,255,0) 26%);
  }
  .hd, .body { position: relative; z-index: 3; }
  .hd {
    display: flex; align-items: center; gap: 8px;
    min-height: 56px; padding: 12px 18px;
    cursor: pointer; user-select: none;
  }
  .hd:active { cursor: grabbing; }
  .name { font-weight: 650; letter-spacing: -0.01em; }
  .ver, .sum { color: rgba(28,25,21,.55); font-size: 11px; }
  .sum { display: none; }
  .chev {
    margin-left: auto;
    padding: 4px 10px; border-radius: 999px;
    background: linear-gradient(180deg, rgba(255,255,255,.62), rgba(255,255,255,.16));
    box-shadow: inset 0 1px 0 #fff, inset 0 -8px 10px rgba(255,255,255,.12);
    font-size: 12px; font-weight: 650;
  }
  .wrap.collapsed .body { display: none; }
  .wrap.collapsed .ver { display: none; }
  .wrap.collapsed .sum { display: inline; }
  .body {
    padding: 0 16px 16px;
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
    padding: 4px; border-radius: 18px;
    background: rgba(255,255,255,.1);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.55), inset 0 0 0 1px rgba(255,255,255,.28);
  }
  .seg button {
    border: 0; color: rgba(22,19,15,.72);
    border-radius: 14px; padding: 8px 8px 7px; cursor: pointer; line-height: 1.2;
  }
  .seg button small { display: block; font-size: 10px; letter-spacing: .04em; opacity: .72; }
  .seg button.on {
    color: #16130f; font-weight: 650;
    background: linear-gradient(180deg, rgba(255,255,255,.82), rgba(255,255,255,.34));
    box-shadow:
      inset 0 1px 0 #fff,
      inset 0 0 0 1px rgba(255,255,255,.8),
      inset 0 -12px 16px rgba(255,255,255,.35),
      0 8px 16px rgba(0,0,0,.08);
  }
  .seg button:active { transform: scale(0.98); }
  .field {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    min-height: 46px; padding: 8px;
    background: linear-gradient(180deg, rgba(255,255,255,.28), rgba(255,255,255,.08));
    border-radius: 18px; cursor: text;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.85), inset 0 0 0 1px rgba(255,255,255,.32);
  }
  .field:focus-within { box-shadow: inset 0 1px 0 #fff, inset 0 0 0 1px rgba(255,255,255,.7); }
  .chip, .tag {
    background: linear-gradient(180deg, rgba(255,255,255,.5), rgba(255,255,255,.12));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.95), inset 0 -8px 12px rgba(255,255,255,.1), 0 1px 1px rgba(0,0,0,.04);
  }
  .jump, .clear, .pager button, .seg button {
    position: relative;
    overflow: hidden;
    background: linear-gradient(180deg, rgba(255,255,255,.28), rgba(255,255,255,.06) 46%, rgba(255,255,255,.2));
    backdrop-filter: blur(22px) saturate(1.9);
    -webkit-backdrop-filter: blur(22px) saturate(1.9);
    box-shadow:
      inset 0 1px 0 #fff,
      inset 0 0 0 1px rgba(255,255,255,.72),
      inset 0 -18px 20px rgba(255,255,255,.22),
      0 10px 18px rgba(20,16,12,.1);
  }
  .jump::before, .clear::before, .pager button::before, .seg button::before {
    content: "";
    position: absolute;
    left: 1px;
    right: 1px;
    top: 0;
    height: 52%;
    border-radius: inherit;
    background: linear-gradient(180deg, rgba(255,255,255,.78), rgba(255,255,255,0));
    pointer-events: none;
    z-index: -1;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 2px; max-width: 100%;
    padding: 3px 4px 3px 9px; color: #1c1915;
    border-radius: 999px; font-size: 12px; font-weight: 650;
  }
  .chip.away, .tag.away {
    background: rgba(255,255,255,.14);
    box-shadow: inset 0 0 0 1px rgba(28,25,21,.28), inset 0 1px 0 rgba(255,255,255,.5);
  }
  .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
  .chip button {
    width: 18px; height: 18px; border: 0; border-radius: 50%;
    background: transparent; cursor: pointer; line-height: 1; padding: 0;
  }
  .chip button:hover { background: rgba(255,255,255,.45); }
  .field input {
    flex: 1; min-width: 120px; border: 0; outline: none;
    background: transparent; padding: 4px 2px; font-size: 13px; color: #1c1915;
  }
  .field input::placeholder { color: rgba(28,25,21,.45); }
  .hint { min-height: 16px; font-size: 11px; color: rgba(28,25,21,.55); }
  .hint.note { color: #1c1915; }
  .hint.warn { color: #7a4b12; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .count { color: rgba(28,25,21,.62); font-size: 12px; }
  .count b { color: #1c1915; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .jump {
    border: 0; color: #1c1915;
    cursor: pointer; font-size: 12px; font-weight: 650;
    border-radius: 999px; padding: 6px 10px;
  }
  .jump:disabled { opacity: .4; cursor: default; }
  .jump:active:not(:disabled), .clear:active:not(:disabled), .tag:active, .pager button:active:not(:disabled) { transform: scale(0.98); }
  .pager { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .pager button {
    border: 0; min-height: 44px; border-radius: 16px; cursor: pointer;
    color: #16130f; font-size: 14px; font-weight: 650;
  }
  .pager button:disabled { opacity: .38; cursor: default; }
  .clear {
    width: 100%; border: 0; color: #16130f;
    border-radius: 16px; min-height: 40px; padding: 8px 12px;
    cursor: pointer; font-size: 13px; font-weight: 650;
  }
  .clear:disabled { opacity: .38; cursor: default; }
  .list {
    display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start;
    max-height: 42vh; overflow: auto;
    padding-right: 2px;
    scrollbar-width: thin;
    scrollbar-color: rgba(22,19,15,.35) transparent;
  }
  .tag {
    display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
    border: 0; color: #1c1915;
    border-radius: 999px; padding: 5px 9px; cursor: pointer; font-size: 12px;
  }
  .tag .n { color: rgba(28,25,21,.5); font-size: 10px; font-variant-numeric: tabular-nums; }
  .tag.on {
    font-weight: 650;
    background: linear-gradient(180deg, rgba(255,255,255,.82), rgba(255,255,255,.34));
    box-shadow: inset 0 1px 0 #fff, inset 0 -8px 14px rgba(255,255,255,.25), 0 6px 14px rgba(0,0,0,.08);
  }
  .tag.on .n { color: rgba(28,25,21,.55); }
  .tag.hot { box-shadow: inset 0 1px 0 #fff, inset 0 0 0 1px rgba(255,255,255,.9); }
  .tag.dim { opacity: .45; }
  .tag kbd {
    font-family: inherit; font-size: 10px; padding: 0 4px; border-radius: 4px;
    background: rgba(255,255,255,.45); color: #1c1915;
  }
  .empty { color: rgba(28,25,21,.62); font-size: 12px; padding: 8px 2px; }
  .foot { font-size: 11px; color: rgba(22,19,15,.58); line-height: 1.4; }
  `;

  const PAGE_CSS = `
  [data-mtl="hit"] {
    border-radius: 18px !important;
    outline: 1px solid rgba(255,255,255,.95) !important;
    outline-offset: 3px !important;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.7),
      inset 0 0 22px rgba(255, 176, 64, .22),
      0 0 0 1px rgba(255, 196, 110, .9),
      0 0 0 4px rgba(255, 160, 48, .22) !important;
  }
  [data-mtl-focus="1"] {
    outline: 1.5px solid #fff !important;
    outline-offset: 3px !important;
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.85),
      inset 0 0 26px rgba(120, 210, 255, .38),
      0 0 0 1px rgba(170, 230, 255, .95),
      0 0 0 4px rgba(90, 190, 255, .34) !important;
    position: relative !important;
    z-index: 4 !important;
  }
  .mtl-focus-badge {
    position: absolute !important;
    top: 10px !important;
    left: 10px !important;
    z-index: 6 !important;
    background: linear-gradient(180deg, rgba(255,255,255,.82), rgba(150, 220, 255, .48)) !important;
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
  [data-mtl="miss"] {
    opacity: 0.4 !important;
    filter: saturate(.72) !important;
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
      <div class="lip"></div>
      <div class="hd" title="点击展开或收起，按住拖动">
        <span class="name">标签透镜</span>
        <span class="ver">v${VERSION}</span>
        <span class="sum"></span>
        <span class="chev">收起</span>
      </div>
      <div class="body">
        <div class="seg">
          <button type="button" data-act="logic" data-v="and">同时要<small>AND</small></button>
          <button type="button" data-act="logic" data-v="or">有一个就行<small>OR</small></button>
        </div>
        <div class="field">
          <span class="chips"></span>
          <input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入标签，回车记下。本页没有也能加" />
        </div>
        <div class="hint"></div>
        <div class="row">
          <div class="count"></div>
          <button class="jump" type="button" data-act="jump">跳到下一本</button>
        </div>
        <div class="pager">
          <button type="button" data-act="page" data-dir="prev">上一页</button>
          <button type="button" data-act="page" data-dir="next">下一页</button>
        </div>
        <div class="list"></div>
        <p class="foot">不分大小写，简繁算同一个。这一页没有的词也会记下。</p>
        <button class="clear" type="button" data-act="reset">清空已选</button>
      </div>
    `;
    root.appendChild(wrap);
    document.documentElement.appendChild(host);

    ui = {
      host,
      root,
      panel: wrap,
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
    mountGlass(root, wrap.querySelector('.plate'));

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
    makeDraggable(ui.panel, wrap.querySelector('.hd'));
  }

  function applyCollapsed() {
    if (!ui.panel) return;
    ui.panel.classList.toggle('collapsed', !!settings.collapsePanel);
    if (ui.chev) ui.chev.textContent = settings.collapsePanel ? '展开' : '收起';
  }

  function toggleCollapse() {
    settings.collapsePanel = !settings.collapsePanel;
    saveSettings(settings);
    applyCollapsed();
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
    window.addEventListener('mouseup', () => { dragging = false; });
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
      chip.className = 'chip' + (state.tagIndex.has(key) ? '' : ' away');
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
      btn.className = 'tag';
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
    if (ui.host) {
      ui.host.remove();
      ui.host = null;
    }
  }

  function boot(allowEmpty) {
    state.adapter = pickAdapter();
    const found = collect();
    if (!found && !(allowEmpty && state.adapter && state.adapter.id !== 'generic')) {
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
