// ==UserScript==
// @name         Manga Tag Lens · 漫画标签透镜
// @name:en      Manga Tag Lens
// @namespace    https://github.com/toocutetop/manga-tag-lens
// @version      0.2.1
// @updateURL    https://raw.githubusercontent.com/toocutetop/manga-tag-lens/main/src/manga-tag-lens.user.js
// @downloadURL  https://raw.githubusercontent.com/toocutetop/manga-tag-lens/main/src/manga-tag-lens.user.js
// @description  手动输入多个标签，在当前页把对上的漫画和标签亮出来。不分大小写，简体繁体视为同一个，可选「同时要」或「有一个就行」。
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

  const VERSION = '0.2.1';
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

  /** 卡片外面那一格（整列里能挪动的那块）。轮播不挪，避免把站点的滑动轨道拆开。 */
  function gridCell(el) {
    if (el.closest && el.closest('.owl-carousel, .owl-stage')) return null;
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

  /** 输入框对得上的标签排到前面；没在打字时，已选的排前面 */
  function orderedTags() {
    const q = norm(state.keyword);
    const list = Array.from(state.tagIndex.values());
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

  function addPick(key) {
    if (!picks.includes(key)) picks.push(key);
    const rec = state.tagIndex.get(key);
    if (rec) pickLabels.set(key, rec.label);
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

  function restoreOrder() {
    layoutSnap.forEach((children, parent) => {
      if (!parent || !parent.isConnected) return;
      children.forEach((node) => {
        if (node) parent.appendChild(node);
      });
    });
    layoutSnap.clear();
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
      const base = layoutSnap.get(parent);
      const hitCells = new Set(list.filter((it) => it.hit).map((it) => it.cell));
      const hits = [];
      const rest = [];
      base.forEach((node) => {
        if (hitCells.has(node)) hits.push(node);
        else rest.push(node);
      });
      hits.concat(rest).forEach((node) => parent.appendChild(node));
    });
  }

  function clearMarks() {
    qsa(document, '[data-mtl]').forEach((el) => el.removeAttribute('data-mtl'));
    qsa(document, '[data-mtl-tag]').forEach((el) => el.removeAttribute('data-mtl-tag'));
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
    hits
      .filter((n) => !hits.some((o) => o !== n && n.contains(o)))
      .forEach((n) => n.setAttribute('data-mtl-tag', '1'));
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
    renderStatus();
  }

  function clearAll() {
    picks = [];
    state.keyword = '';
    state.hint = '';
    state.cursor = -1;
    if (ui.kwInput) ui.kwInput.value = '';
    persistPicks();
    renderPanel();
    applyHighlight();
  }

  function jumpNext() {
    const hits = state.items.filter((it) => it.hit);
    if (!hits.length) return;
    state.cursor = (state.cursor + 1) % hits.length;
    const el = hits[state.cursor].el;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function commitToken(token) {
    const found = resolveToken(token);
    if (found.type === 'one') {
      addPick(found.key);
      return 'added';
    }
    return found.type;
  }

  function commitQuery() {
    const token = cleanLabel(state.keyword);
    if (!token) return;
    const result = commitToken(token);
    if (result === 'added') {
      state.keyword = '';
      state.hint = '';
      if (ui.kwInput) ui.kwInput.value = '';
    } else if (result === 'many') {
      state.hint = '有多个相近的，点一个，或继续打完';
    } else if (result === 'none') {
      state.hint = '本页没有这个标签';
    }
    renderPanel({ keepScroll: result !== 'added' });
    if (result === 'added') applyHighlight();
  }

  function addFromText(text) {
    const parts = String(text).split(/[\s,，;；、\n]+/).map(cleanLabel).filter(Boolean);
    const left = [];
    let added = 0;
    parts.forEach((part) => {
      if (commitToken(part) === 'added') added++;
      else left.push(part);
    });
    state.keyword = left.join(' ');
    if (ui.kwInput) ui.kwInput.value = state.keyword;
    if (!left.length) state.hint = '';
    else if (!added) state.hint = '这些词本页没有';
    else state.hint = '没对上的还留在输入框里';
    renderPanel();
    if (added) applyHighlight();
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

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  button, input { font: inherit; color: inherit; }
  .wrap {
    position: fixed; top: 16px; right: 16px; z-index: 2147483647;
    width: min(336px, calc(100vw - 24px));
    max-height: calc(100vh - 32px);
    display: flex; flex-direction: column;
    background: #12141a; color: #f6f3ec;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 18px;
    box-shadow: 0 18px 50px rgba(0,0,0,.38);
    font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    font-size: 13px; line-height: 1.45;
    overflow: hidden;
  }
  .hd {
    display: flex; align-items: center; gap: 8px;
    padding: 14px 12px 6px 16px;
    cursor: grab; user-select: none;
  }
  .hd:active { cursor: grabbing; }
  .name { font-weight: 600; }
  .ver { color: #9c968b; font-size: 11px; }
  .icon-btn {
    margin-left: auto; width: 28px; height: 28px;
    border: 0; border-radius: 8px; background: transparent;
    color: #c9c3b8; cursor: pointer;
  }
  .icon-btn:hover { background: rgba(255,255,255,.06); }
  .icon-btn:active { transform: scale(0.96); }
  .body {
    padding: 6px 12px 14px;
    display: flex; flex-direction: column; gap: 10px;
    overflow: auto;
  }
  .wrap.collapsed .body { display: none; }
  .seg {
    display: grid; grid-template-columns: 1fr 1fr; gap: 4px;
    padding: 4px; background: #0c0e13; border-radius: 12px;
  }
  .seg button {
    border: 0; background: transparent; color: #b7b1a6;
    border-radius: 9px; padding: 8px 8px 7px; cursor: pointer; line-height: 1.2;
  }
  .seg button small { display: block; font-size: 10px; letter-spacing: .04em; opacity: .72; }
  .seg button.on { background: #ffb020; color: #1c1404; font-weight: 600; }
  .seg button:active { transform: scale(0.98); }
  .field {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    min-height: 46px; padding: 8px;
    background: #0c0e13; border: 1px solid rgba(255,255,255,.08); border-radius: 12px;
    cursor: text;
  }
  .field:focus-within { border-color: rgba(255,176,32,.9); }
  .chip {
    display: inline-flex; align-items: center; gap: 2px; max-width: 100%;
    padding: 3px 4px 3px 9px; background: #ffb020; color: #1c1404;
    border-radius: 999px; font-size: 12px; font-weight: 600;
  }
  .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
  .chip button {
    width: 18px; height: 18px; border: 0; border-radius: 50%;
    background: transparent; cursor: pointer; line-height: 1; padding: 0;
  }
  .chip button:hover { background: rgba(0,0,0,.12); }
  .field input {
    flex: 1; min-width: 120px; border: 0; outline: none;
    background: transparent; padding: 4px 2px; font-size: 13px;
  }
  .field input::placeholder { color: #8d877c; }
  .hint { min-height: 16px; font-size: 11px; color: #a39c90; }
  .hint.warn { color: #ffb020; }
  .row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .count { color: #b7b1a6; font-size: 12px; }
  .count b { color: #ffb020; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .jump {
    border: 0; background: transparent; color: #ffb020;
    cursor: pointer; font-size: 12px; padding: 0;
  }
  .jump:disabled { color: #6d675e; cursor: default; }
  .jump:active:not(:disabled) { transform: scale(0.98); }
  .ghost {
    border: 1px solid rgba(255,255,255,.1); background: transparent; color: #d9d3c8;
    border-radius: 8px; padding: 4px 8px; cursor: pointer; font-size: 12px;
  }
  .ghost:hover { background: rgba(255,255,255,.05); }
  .ghost:active { transform: scale(0.98); }
  .list {
    display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start;
    max-height: 42vh; overflow: auto;
  }
  .tag {
    display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
    border: 1px solid rgba(255,255,255,.08); background: #1b1e27; color: #f3efe7;
    border-radius: 999px; padding: 5px 9px; cursor: pointer; font-size: 12px;
  }
  .tag .n { color: #9c968b; font-size: 10px; font-variant-numeric: tabular-nums; }
  .tag.on { background: #ffb020; border-color: #ffb020; color: #1c1404; font-weight: 600; }
  .tag.on .n { color: rgba(28,20,4,.62); }
  .tag.hot { border-color: rgba(255,176,32,.8); }
  .tag.dim { opacity: .4; }
  .tag kbd {
    font-family: inherit; font-size: 10px; padding: 0 4px; border-radius: 4px;
    background: rgba(255,176,32,.16); color: #ffb020;
  }
  .tag.on kbd { background: rgba(0,0,0,.12); color: #1c1404; }
  .tag:active { transform: scale(0.98); }
  .empty { color: #9c968b; font-size: 12px; padding: 8px 2px; }
  .foot { font-size: 11px; color: #8a847a; }
  `;

  const PAGE_CSS = `
  [data-mtl="hit"] {
    outline: 3px solid #ffb020 !important;
    outline-offset: 3px !important;
    box-shadow: 0 0 0 6px rgba(255, 176, 32, .35) !important;
    border-radius: 10px;
  }
  [data-mtl="miss"] { opacity: 0.34 !important; }
  [data-mtl-tag="1"] {
    background: #ffb020 !important;
    color: #1a1203 !important;
    border-radius: 4px !important;
    box-shadow: 0 0 0 2px #ffb020, 0 0 14px rgba(255, 176, 32, .9) !important;
    font-weight: 700 !important;
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
      <div class="hd">
        <span class="name">标签透镜</span>
        <span class="ver">v${VERSION}</span>
        <button class="icon-btn" type="button" data-act="collapse" title="折叠">–</button>
      </div>
      <div class="body">
        <div class="seg">
          <button type="button" data-act="logic" data-v="and">同时要<small>AND</small></button>
          <button type="button" data-act="logic" data-v="or">有一个就行<small>OR</small></button>
        </div>
        <div class="field">
          <span class="chips"></span>
          <input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入标签，回车添加" />
        </div>
        <div class="hint"></div>
        <div class="row">
          <div class="count"></div>
          <button class="jump" type="button" data-act="jump">跳到下一本</button>
        </div>
        <div class="list"></div>
        <div class="row">
          <span class="foot">不分大小写。简体和繁体算同一个。</span>
          <button class="ghost" type="button" data-act="reset">清空</button>
        </div>
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
      collapseBtn: wrap.querySelector('[data-act="collapse"]'),
      jumpBtn: wrap.querySelector('[data-act="jump"]'),
    };

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
      if (act === 'collapse') {
        settings.collapsePanel = !settings.collapsePanel;
        saveSettings(settings);
        ui.panel.classList.toggle('collapsed', settings.collapsePanel);
        ui.collapseBtn.textContent = settings.collapsePanel ? '+' : '–';
        return;
      }
      if (act === 'logic') {
        settings.logic = btn.dataset.v === 'or' ? 'or' : 'and';
        saveSettings(settings);
        renderLogic();
        applyHighlight();
        return;
      }
      if (act === 'reset') { clearAll(); return; }
      if (act === 'jump') { jumpNext(); return; }
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
        ui.kwInput.value = '';
        renderPanel();
        applyHighlight();
      }
    });

    ui.panel.classList.toggle('collapsed', !!settings.collapsePanel);
    ui.collapseBtn.textContent = settings.collapsePanel ? '+' : '–';
    makeDraggable(ui.panel, wrap.querySelector('.hd'));
  }

  function makeDraggable(panel, handle) {
    let dragging = false;
    let sx = 0; let sy = 0; let ox = 0; let oy = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      panel.style.left = ox + 'px';
      panel.style.top = oy + 'px';
      panel.style.right = 'auto';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
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
      chip.className = 'chip';
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
    ui.hintBox.classList.toggle('warn', !!state.hint);
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
      empty.textContent = '本页没有读到标签';
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
      if (hot) btn.classList.add('hot');
      if (q && !hot) btn.classList.add('dim');

      const name = document.createElement('span');
      name.textContent = t.label;
      btn.appendChild(name);

      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(t.count);
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
    } else {
      ui.statusBox.innerHTML = '亮了 <b>' + state.matched + '</b> / ' + state.total;
    }
    if (ui.jumpBtn) ui.jumpBtn.disabled = state.matched <= 0 || !picks.length;
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

  function boot() {
    state.adapter = pickAdapter();
    if (!collect()) {
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
    if (boot()) return;
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
