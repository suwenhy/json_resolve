/**
 * JSONLens Interactive Tree Explorer + JSONPath Query Bar + Smart Value Inspector
 */

import { escapeHtml, highlightJson, formatBytes } from '../core/parser.js';
import { formatPath, evaluateJsonPath, inspectValue, getValueAtPath } from '../core/query.js';

const PAGE_LIMIT = 150;

export class JsonTreeView {
  /**
   * @param {HTMLElement} container
   * @param {{ onSelectPath?: (info: any) => void, onCopy?: (text: string, label: string) => void, onUnpackAtPath?: (segments: Array<string|number>, parsedVal: any) => void }} callbacks
   */
  constructor(container, callbacks = {}) {
    this.container = container;
    this.onSelectPath = callbacks.onSelectPath || (() => {});
    this.onCopy = callbacks.onCopy || (() => {});
    this.onUnpackAtPath = callbacks.onUnpackAtPath || (() => {});

    this.data = undefined;
    this.collapsedPaths = new Set();
    this.expandedPages = new Map(); // pathKey -> max count
    this.selectedPathKey = '$';
    this.selectedSegments = [];
    this.queryText = '';
    this.filterOnlyMatches = false;
    this.inspectorOpen = true;

    this._renderShell();
    this._bindEvents();
  }

  _renderShell() {
    this.container.innerHTML = `
      <div class="tree-toolbar">
        <div class="tree-search-wrap">
          <svg class="icon-sm tree-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
          </svg>
          <input
            type="text"
            class="tree-search-input"
            data-role="query-input"
            placeholder="搜索键/值，或输入 JSONPath 如 $.orders[?(@.paid==true)] 、$..amount"
            autocomplete="off"
            spellcheck="false"
          />
          <button type="button" class="icon-btn-xs hidden" data-role="query-clear" title="清除查询">✕</button>
        </div>
        <div class="tree-actions">
          <label class="tree-filter-toggle" title="搜索时仅保留匹配的节点分支">
            <input type="checkbox" data-role="filter-only" />
            <span>仅匹配项</span>
          </label>
          <div class="btn-group-xs">
            <button type="button" class="btn-xs" data-depth="1" title="展开至第 1 层">1层</button>
            <button type="button" class="btn-xs" data-depth="2" title="展开至第 2 层">2层</button>
            <button type="button" class="btn-xs" data-depth="99" title="全部展开">全展</button>
            <button type="button" class="btn-xs" data-depth="0" title="全部折叠">全折</button>
          </div>
        </div>
      </div>

      <div class="tree-scroll" data-role="tree-scroll"></div>

      <div class="inspector-panel" data-role="inspector">
        <div class="inspector-header" data-role="inspector-toggle">
          <div class="inspector-title">
            <span class="inspector-dot"></span>
            <span>智能属性透视器 (Value Inspector)</span>
            <code class="inspector-path-pill" data-role="insp-path">$</code>
          </div>
          <div class="inspector-header-actions">
            <button type="button" class="btn-xs" data-role="insp-copy-path" title="复制 JSONPath">复制路径</button>
            <button type="button" class="btn-xs" data-role="insp-copy-val" title="复制节点 JSON 值">复制值</button>
            <button type="button" class="icon-btn-xs" data-role="insp-collapse-btn" title="折叠/展开透视面板">▾</button>
          </div>
        </div>
        <div class="inspector-body" data-role="insp-body"></div>
      </div>
    `;

    this.queryInput = this.container.querySelector('[data-role="query-input"]');
    this.queryClearBtn = this.container.querySelector('[data-role="query-clear"]');
    this.filterOnlyCheckbox = this.container.querySelector('[data-role="filter-only"]');
    this.treeScroll = this.container.querySelector('[data-role="tree-scroll"]');
    this.inspectorEl = this.container.querySelector('[data-role="inspector"]');
    this.inspPathEl = this.container.querySelector('[data-role="insp-path"]');
    this.inspBodyEl = this.container.querySelector('[data-role="insp-body"]');
    this.inspCollapseBtn = this.container.querySelector('[data-role="insp-collapse-btn"]');
  }

  _bindEvents() {
    let debounceTimer = null;
    this.queryInput.addEventListener('input', () => {
      this.queryText = this.queryInput.value.trim();
      this.queryClearBtn.classList.toggle('hidden', !this.queryText);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => this.renderTree(), 90);
    });

    this.queryClearBtn.addEventListener('click', () => {
      this.queryInput.value = '';
      this.queryText = '';
      this.queryClearBtn.classList.add('hidden');
      this.renderTree();
    });

    this.filterOnlyCheckbox.addEventListener('change', () => {
      this.filterOnlyMatches = this.filterOnlyCheckbox.checked;
      this.renderTree();
    });

    this.container.querySelectorAll('[data-depth]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const depth = parseInt(btn.getAttribute('data-depth'), 10);
        this.expandToDepth(depth);
      });
    });

    // Event delegation on tree scroll container for ultra-fast DOM performance
    this.treeScroll.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-tree-action]');
      if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.getAttribute('data-tree-action');
        const segJson = actionBtn.closest('[data-segments]')?.getAttribute('data-segments');
        const segments = segJson ? JSON.parse(segJson) : [];
        this._handleNodeAction(action, segments);
        return;
      }

      const moreBtn = e.target.closest('[data-load-more]');
      if (moreBtn) {
        e.stopPropagation();
        const pathKey = moreBtn.getAttribute('data-load-more');
        const curLimit = this.expandedPages.get(pathKey) || PAGE_LIMIT;
        this.expandedPages.set(pathKey, curLimit + PAGE_LIMIT * 2);
        this.renderTree();
        return;
      }

      const toggleEl = e.target.closest('[data-toggle-key]');
      if (toggleEl) {
        e.stopPropagation();
        const key = toggleEl.getAttribute('data-toggle-key');
        if (this.collapsedPaths.has(key)) this.collapsedPaths.delete(key);
        else this.collapsedPaths.add(key);
        this.renderTree();
        return;
      }

      const rowEl = e.target.closest('.tree-row');
      if (rowEl) {
        const segJson = rowEl.getAttribute('data-segments');
        const segments = segJson ? JSON.parse(segJson) : [];
        this.selectSegments(segments);
      }
    });

    // Double click container row to toggle expand/collapse
    this.treeScroll.addEventListener('dblclick', (e) => {
      const rowEl = e.target.closest('.tree-row.is-branch');
      if (!rowEl) return;
      const pathKey = rowEl.getAttribute('data-path-key');
      if (this.collapsedPaths.has(pathKey)) this.collapsedPaths.delete(pathKey);
      else this.collapsedPaths.add(pathKey);
      this.renderTree();
    });

    // Inspector controls
    this.container.querySelector('[data-role="insp-copy-path"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const { jsonPath } = formatPath(this.selectedSegments);
      this.onCopy(jsonPath, 'JSONPath 路径');
    });

    this.container.querySelector('[data-role="insp-copy-val"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const val = getValueAtPath(this.data, this.selectedSegments);
      const str = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
      this.onCopy(str, '节点值');
    });

    this.container.querySelector('[data-role="inspector-toggle"]').addEventListener('click', (e) => {
      if (e.target.closest('button') && !e.target.closest('[data-role="insp-collapse-btn"]')) return;
      this.inspectorOpen = !this.inspectorOpen;
      this.inspectorEl.classList.toggle('is-collapsed', !this.inspectorOpen);
      this.inspCollapseBtn.textContent = this.inspectorOpen ? '▾' : '▴';
    });

    this.inspBodyEl.addEventListener('click', (e) => {
      const unpackBtn = e.target.closest('[data-role="insp-unpack-nested"]');
      if (unpackBtn) {
        const val = getValueAtPath(this.data, this.selectedSegments);
        if (typeof val === 'string') {
          try {
            const parsed = JSON.parse(val.trim());
            this.onUnpackAtPath(this.selectedSegments, parsed);
          } catch {
            // ignore
          }
        }
      }
    });
  }

  _handleNodeAction(action, segments) {
    const val = getValueAtPath(this.data, segments);
    const { jsonPath } = formatPath(segments);
    if (action === 'copy-path') {
      this.onCopy(jsonPath, 'JSONPath');
    } else if (action === 'copy-val') {
      const text = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
      this.onCopy(text, '节点值');
    } else if (action === 'unpack') {
      if (typeof val === 'string') {
        try {
          const parsed = JSON.parse(val.trim());
          this.onUnpackAtPath(segments, parsed);
        } catch {
          // ignore
        }
      }
    }
  }

  setData(value) {
    this.data = value;
    // Validate selectedSegments still exists; otherwise reset to root
    const curVal = getValueAtPath(value, this.selectedSegments);
    if (curVal === undefined) {
      this.selectedSegments = [];
      this.selectedPathKey = '$';
    }
    this.renderTree();
    this._renderInspector();
  }

  expandToDepth(maxDepth) {
    this.collapsedPaths.clear();
    if (this.data === undefined || maxDepth >= 99) {
      this.renderTree();
      return;
    }

    const walk = (val, segments, depth) => {
      if (val === null || typeof val !== 'object') return;
      const { jsonPath } = formatPath(segments);
      if (depth >= maxDepth) {
        this.collapsedPaths.add(jsonPath);
      }
      if (Array.isArray(val)) {
        val.slice(0, PAGE_LIMIT).forEach((item, idx) => walk(item, [...segments, idx], depth + 1));
      } else {
        for (const [k, v] of Object.entries(val)) {
          walk(v, [...segments, k], depth + 1);
        }
      }
    };

    walk(this.data, [], 0);
    this.renderTree();
  }

  selectSegments(segments) {
    this.selectedSegments = segments;
    const { jsonPath } = formatPath(segments);
    this.selectedPathKey = jsonPath;

    const prev = this.treeScroll.querySelector('.tree-row.is-selected');
    if (prev) prev.classList.remove('is-selected');
    const next = this.treeScroll.querySelector(`.tree-row[data-path-key="${CSS.escape(jsonPath)}"]`);
    if (next) next.classList.add('is-selected');

    const val = getValueAtPath(this.data, segments);
    const key = segments.length > 0 ? segments[segments.length - 1] : null;
    const info = inspectValue(val, key, segments);
    this._renderInspector(info);
    this.onSelectPath(info);
  }

  renderTree() {
    if (this.data === undefined) {
      this.treeScroll.innerHTML = `<div class="empty-view">暂无可渲染的 JSON 数据</div>`;
      return;
    }

    // Check if queryText is a JSONPath expression
    const isJsonPathMode =
      this.queryText.startsWith('$') ||
      (this.queryText.startsWith('.') && this.queryText.length > 1);

    if (isJsonPathMode) {
      this._renderJsonPathResults(this.queryText);
      return;
    }

    const needle = this.queryText.toLowerCase();
    const matchAllowed = needle ? this._computeMatchingPaths(this.data, needle) : null;

    const htmlChunks = [];
    this._buildNodeHtml(this.data, null, [], 0, true, needle, matchAllowed, htmlChunks);

    if (htmlChunks.length === 0) {
      this.treeScroll.innerHTML = `<div class="empty-view">没有找到与 <code>${escapeHtml(this.queryText)}</code> 匹配的节点</div>`;
    } else {
      this.treeScroll.innerHTML = `<div class="tree-root">${htmlChunks.join('')}</div>`;
    }
  }

  _renderJsonPathResults(expr) {
    const res = evaluateJsonPath(this.data, expr);
    if (!res.ok) {
      this.treeScroll.innerHTML = `
        <div class="jsonpath-banner is-error">
          <strong>JSONPath 语法提示：</strong> ${escapeHtml(res.error)}
        </div>
      `;
      return;
    }

    if (res.matches.length === 0) {
      this.treeScroll.innerHTML = `
        <div class="jsonpath-banner">
          JSONPath <code>${escapeHtml(expr)}</code> 查询成功，共匹配 <strong>0</strong> 条结果
        </div>
      `;
      return;
    }

    const itemsHtml = res.matches
      .slice(0, 200)
      .map((m, i) => {
        const segAttr = escapeHtml(JSON.stringify(m.segments));
        const preview = JSON.stringify(m.value, null, 2);
        return `
          <div class="jp-result-card" data-segments="${segAttr}">
            <div class="jp-result-head">
              <span class="jp-idx">#${i + 1}</span>
              <code class="jp-path">${escapeHtml(m.jsonPath)}</code>
              <div class="jp-actions">
                <button type="button" class="btn-xs" data-tree-action="copy-path">复制路径</button>
                <button type="button" class="btn-xs" data-tree-action="copy-val">复制值</button>
              </div>
            </div>
            <pre class="jp-code"><code>${highlightJson(preview)}</code></pre>
          </div>
        `;
      })
      .join('');

    this.treeScroll.innerHTML = `
      <div class="jsonpath-banner is-ok">
        <span>JSONPath 匹配到 <strong>${res.matches.length}</strong> 个节点</span>
      </div>
      <div class="jp-results-list">${itemsHtml}</div>
    `;
  }

  _computeMatchingPaths(root, needle) {
    const keep = new Set();
    const walk = (val, segments) => {
      const { jsonPath } = formatPath(segments);
      const keyStr = segments.length > 0 ? String(segments[segments.length - 1]).toLowerCase() : '';
      let selfMatches = keyStr.includes(needle);

      if (val === null || typeof val !== 'object') {
        if (String(val).toLowerCase().includes(needle)) selfMatches = true;
      } else if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          if (walk(val[i], [...segments, i])) selfMatches = true;
        }
      } else {
        for (const [k, v] of Object.entries(val)) {
          if (walk(v, [...segments, k])) selfMatches = true;
        }
      }

      if (selfMatches) keep.add(jsonPath);
      return selfMatches;
    };
    walk(root, []);
    return keep;
  }

  _highlightTextMatch(str, needle) {
    const escaped = escapeHtml(str);
    if (!needle) return escaped;
    const safeNeedle = escapeHtml(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!safeNeedle) return escaped;
    return escaped.replace(new RegExp(`(${safeNeedle})`, 'gi'), '<mark class="search-mark">$1</mark>');
  }

  _buildNodeHtml(val, key, segments, depth, isLast, needle, matchAllowed, out) {
    const { jsonPath } = formatPath(segments);
    if (needle && this.filterOnlyMatches && matchAllowed && !matchAllowed.has(jsonPath)) {
      return;
    }

    const segAttr = escapeHtml(JSON.stringify(segments));
    const isSelected = jsonPath === this.selectedPathKey;
    const indentPx = depth * 18;

    const keyHtml =
      key === null
        ? `<span class="tree-root-tag">root</span>`
        : typeof key === 'number'
        ? `<span class="tree-idx">[${key}]</span>`
        : `<span class="tree-key">"${this._highlightTextMatch(String(key), needle)}"</span><span class="tok-punct">: </span>`;

    // Branch node: Object or Array
    if (val !== null && typeof val === 'object') {
      const isArr = Array.isArray(val);
      const count = isArr ? val.length : Object.keys(val).length;
      const openSym = isArr ? '[' : '{';
      const closeSym = isArr ? ']' : '}';
      // Auto-expand when actively searching!
      const isCollapsed = !needle && this.collapsedPaths.has(jsonPath);

      if (count === 0) {
        out.push(`
          <div class="tree-row ${isSelected ? 'is-selected' : ''}" data-path-key="${escapeHtml(jsonPath)}" data-segments="${segAttr}" style="padding-left:${indentPx + 20}px">
            ${keyHtml}<span class="tok-punct">${openSym}${closeSym}</span>
            <span class="tree-meta">空${isArr ? '数组' : '对象'}</span>
            ${this._renderHoverActions(false)}
          </div>
        `);
        return;
      }

      out.push(`
        <div class="tree-row is-branch ${isSelected ? 'is-selected' : ''}" data-path-key="${escapeHtml(jsonPath)}" data-segments="${segAttr}" style="padding-left:${indentPx}px">
          <button type="button" class="tree-caret ${isCollapsed ? 'is-collapsed' : ''}" data-toggle-key="${escapeHtml(jsonPath)}" aria-label="展开或折叠">▾</button>
          ${keyHtml}<span class="tok-punct">${openSym}</span>
          <span class="tree-badge">${isArr ? `${count} items` : `${count} keys`}</span>
          ${isCollapsed ? `<span class="tok-punct">… ${closeSym}${isLast ? '' : ','}</span>` : ''}
          ${this._renderHoverActions(false)}
        </div>
      `);

      if (!isCollapsed) {
        const limit = this.expandedPages.get(jsonPath) || PAGE_LIMIT;
        if (isArr) {
          const shown = Math.min(val.length, limit);
          for (let i = 0; i < shown; i++) {
            this._buildNodeHtml(val[i], i, [...segments, i], depth + 1, i === val.length - 1, needle, matchAllowed, out);
          }
          if (val.length > shown) {
            out.push(`
              <div class="tree-more-row" style="padding-left:${(depth + 1) * 18 + 20}px">
                <button type="button" class="btn-xs btn-accent-soft" data-load-more="${escapeHtml(jsonPath)}">
                  加载更多元素（剩余 ${val.length - shown} 项）…
                </button>
              </div>
            `);
          }
        } else {
          const entries = Object.entries(val);
          const shown = Math.min(entries.length, limit);
          for (let i = 0; i < shown; i++) {
            const [k, v] = entries[i];
            this._buildNodeHtml(v, k, [...segments, k], depth + 1, i === entries.length - 1, needle, matchAllowed, out);
          }
          if (entries.length > shown) {
            out.push(`
              <div class="tree-more-row" style="padding-left:${(depth + 1) * 18 + 20}px">
                <button type="button" class="btn-xs btn-accent-soft" data-load-more="${escapeHtml(jsonPath)}">
                  加载更多属性（剩余 ${entries.length - shown} 个）…
                </button>
              </div>
            `);
          }
        }

        out.push(`
          <div class="tree-close-row" style="padding-left:${indentPx + 20}px">
            <span class="tok-punct">${closeSym}${isLast ? '' : ','}</span>
          </div>
        `);
      }
      return;
    }

    // Primitive leaf node
    const { valueHtml, inlineTag, canUnpack } = this._formatLeafValue(val, needle);
    out.push(`
      <div class="tree-row ${isSelected ? 'is-selected' : ''}" data-path-key="${escapeHtml(jsonPath)}" data-segments="${segAttr}" style="padding-left:${indentPx + 20}px">
        ${keyHtml}${valueHtml}<span class="tok-punct">${isLast ? '' : ','}</span>
        ${inlineTag}
        ${this._renderHoverActions(canUnpack)}
      </div>
    `);
  }

  _formatLeafValue(val, needle) {
    if (val === null) {
      return { valueHtml: `<span class="tok-null">null</span>`, inlineTag: '', canUnpack: false };
    }
    if (typeof val === 'boolean') {
      return { valueHtml: `<span class="tok-bool">${val}</span>`, inlineTag: '', canUnpack: false };
    }
    if (typeof val === 'number') {
      let tag = '';
      if (Number.isInteger(val) && val >= 946684800 && val <= 4102444800) {
        const d = new Date(val * 1000);
        tag = `<span class="leaf-pill" title="Unix 时间戳">🕒 ${d.toISOString().slice(0, 10)}</span>`;
      } else if (Number.isInteger(val) && val >= 946684800000 && val <= 4102444800000) {
        const d = new Date(val);
        tag = `<span class="leaf-pill" title="毫秒时间戳">🕒 ${d.toISOString().slice(0, 10)}</span>`;
      }
      return {
        valueHtml: `<span class="tok-num">${this._highlightTextMatch(String(val), needle)}</span>`,
        inlineTag: tag,
        canUnpack: false,
      };
    }

    // String
    const rawStr = String(val);
    const displayStr = rawStr.length > 180 ? rawStr.slice(0, 180) + '…' : rawStr;
    let inlineTag = '';
    let canUnpack = false;

    const trimmed = rawStr.trim();
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
      inlineTag = `<span class="color-swatch-inline" style="background:${escapeHtml(trimmed)}" title="${escapeHtml(trimmed)}"></span>`;
    } else if (/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./.test(trimmed)) {
      inlineTag = `<span class="leaf-pill is-jwt">🔑 JWT</span>`;
    } else if (/^https?:\/\//i.test(trimmed)) {
      inlineTag = `<a class="leaf-pill is-link" href="${escapeHtml(trimmed)}" target="_blank" rel="noopener noreferrer" title="新标签打开链接">↗ 链接</a>`;
    } else if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const p = JSON.parse(trimmed);
        if (p && typeof p === 'object') {
          canUnpack = true;
          inlineTag = `<button type="button" class="leaf-pill is-unpack" data-tree-action="unpack" title="将此字符串原地解包为嵌套 JSON 对象">⚡ 展开内嵌 JSON</button>`;
        }
      } catch {
        // ignore
      }
    }

    return {
      valueHtml: `<span class="tok-str">"${this._highlightTextMatch(displayStr, needle)}"</span>`,
      inlineTag,
      canUnpack,
    };
  }

  _renderHoverActions(canUnpack) {
    return `
      <span class="tree-hover-actions">
        ${canUnpack ? `<button type="button" class="hover-pill" data-tree-action="unpack">解包</button>` : ''}
        <button type="button" class="hover-pill" data-tree-action="copy-val">复制值</button>
        <button type="button" class="hover-pill" data-tree-action="copy-path">路径</button>
      </span>
    `;
  }

  _renderInspector(precomputed = null) {
    if (this.data === undefined) {
      this.inspPathEl.textContent = '$';
      this.inspBodyEl.innerHTML = `<div class="insp-empty">点击树中任意属性即可智能识别时间戳、JWT 载荷、URL 参数、颜色或内嵌 JSON</div>`;
      return;
    }

    const val = getValueAtPath(this.data, this.selectedSegments);
    const key = this.selectedSegments.length > 0 ? this.selectedSegments[this.selectedSegments.length - 1] : null;
    const info = precomputed || inspectValue(val, key, this.selectedSegments);

    this.inspPathEl.textContent = info.jsonPath;

    const metaHtml = `
      <div class="insp-meta-grid">
        <div class="insp-meta-item">
          <span class="insp-label">数据类型</span>
          <span class="insp-val-badge type-${info.baseType}">${escapeHtml(info.summary)}</span>
        </div>
        <div class="insp-meta-item">
          <span class="insp-label">节点体积</span>
          <span class="insp-val-mono">${formatBytes(info.byteSize)}</span>
        </div>
        <div class="insp-meta-item">
          <span class="insp-label">JSON Pointer</span>
          <code class="insp-val-mono">${escapeHtml(info.jsonPointer)}</code>
        </div>
      </div>
    `;

    let insightsHtml = '';
    for (const ins of info.insights) {
      if (ins.kind === 'timestamp' || ins.kind === 'date-string') {
        insightsHtml += `
          <div class="insp-card">
            <div class="insp-card-badge">🕒 ${escapeHtml(ins.badge)}</div>
            <div class="insp-kv-list">
              <div><span>本地时间：</span><strong>${escapeHtml(ins.local)}</strong> <em class="insp-muted">(${escapeHtml(ins.relative)})</em></div>
              ${ins.iso ? `<div><span>ISO 8601：</span><code>${escapeHtml(ins.iso)}</code></div>` : ''}
              ${ins.unixSec !== undefined ? `<div><span>Unix 秒 / 毫秒：</span><code>${ins.unixSec}</code> / <code>${ins.unixMs}</code></div>` : ''}
            </div>
          </div>
        `;
      } else if (ins.kind === 'jwt') {
        const expTag = ins.expInfo
          ? `<span class="jwt-status ${ins.expInfo.expired ? 'is-expired' : 'is-valid'}">${ins.expInfo.expired ? '已过期' : '有效期内'} · exp ${escapeHtml(ins.expInfo.formatted)}</span>`
          : '';
        insightsHtml += `
          <div class="insp-card">
            <div class="insp-card-badge">🔑 ${escapeHtml(ins.badge)} ${expTag}</div>
            <div class="jwt-grid">
              <div>
                <div class="jwt-sub">Header</div>
                <pre class="insp-pre"><code>${highlightJson(JSON.stringify(ins.header, null, 2))}</code></pre>
              </div>
              <div>
                <div class="jwt-sub">Payload</div>
                <pre class="insp-pre"><code>${highlightJson(JSON.stringify(ins.payload, null, 2))}</code></pre>
              </div>
            </div>
          </div>
        `;
      } else if (ins.kind === 'color') {
        insightsHtml += `
          <div class="insp-card insp-color-card">
            <span class="insp-color-box" style="background:${escapeHtml(ins.color)}"></span>
            <div>
              <div class="insp-card-badge">🎨 ${escapeHtml(ins.badge)}</div>
              <code>${escapeHtml(ins.color)}</code>
            </div>
          </div>
        `;
      } else if (ins.kind === 'url') {
        const qpHtml =
          ins.queryParams.length > 0
            ? `<div class="url-params">${ins.queryParams.map(([k, v]) => `<span class="url-param-chip"><b>${escapeHtml(k)}</b>=${escapeHtml(v)}</span>`).join('')}</div>`
            : '';
        insightsHtml += `
          <div class="insp-card">
            <div class="insp-card-badge">🔗 ${escapeHtml(ins.badge)} · <a href="${escapeHtml(ins.href)}" target="_blank" rel="noopener noreferrer">新窗口打开 ↗</a></div>
            <div class="insp-kv-list">
              <div><span>域名 (Host)：</span><code>${escapeHtml(ins.host)}</code></div>
              <div><span>路径 (Path)：</span><code>${escapeHtml(ins.pathname)}</code></div>
            </div>
            ${qpHtml}
          </div>
        `;
      } else if (ins.kind === 'nested-json') {
        insightsHtml += `
          <div class="insp-card">
            <div class="insp-card-head-row">
              <span class="insp-card-badge">📦 ${escapeHtml(ins.badge)}</span>
              <button type="button" class="btn-xs btn-primary-xs" data-role="insp-unpack-nested">⚡ 原地解包为 JSON 对象</button>
            </div>
            <pre class="insp-pre"><code>${highlightJson(ins.pretty)}</code></pre>
          </div>
        `;
      } else if (ins.kind === 'base64') {
        insightsHtml += `
          <div class="insp-card">
            <div class="insp-card-badge">🔓 ${escapeHtml(ins.badge)}</div>
            <pre class="insp-pre"><code>${escapeHtml(ins.decoded)}</code></pre>
          </div>
        `;
      }
    }

    if (!insightsHtml) {
      const rawPreview =
        typeof info.value === 'object' && info.value !== null
          ? `<div class="insp-muted">提示：点击包含时间戳、JWT、URL、颜色值或内嵌 JSON 字符串的字段可触发智能解码预览。</div>`
          : `<div class="insp-raw-val"><code>${escapeHtml(JSON.stringify(info.value))}</code></div>`;
      insightsHtml = rawPreview;
    }

    this.inspBodyEl.innerHTML = metaHtml + insightsHtml;
  }
}
