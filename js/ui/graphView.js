/**
 * JSONLens Interactive Graph Visualizer (Inspired by JSON Crack)
 * Pure SVG + Pan/Zoom + LR/TB Hierarchical Tree Layout + Branch Collapse + SVG/PNG Export
 */

import { escapeHtml } from '../core/parser.js';
import { formatPath, inspectValue, getValueAtPath } from '../core/query.js';

const NODE_W = 264;
const HEADER_H = 30;
const ROW_H = 23;
const BODY_PAD = 10;
const H_GAP = 86;
const V_GAP = 20;
const MAX_GRAPH_NODES = 220;

export class JsonGraphView {
  /**
   * @param {HTMLElement} container
   * @param {{ onSelectNode?: (info: any) => void, onNotify?: (msg: string) => void }} callbacks
   */
  constructor(container, callbacks = {}) {
    this.container = container;
    this.onSelectNode = callbacks.onSelectNode || (() => {});
    this.onNotify = callbacks.onNotify || (() => {});

    this.data = undefined;
    this.direction = 'LR'; // 'LR' | 'TB'
    this.collapsedIds = new Set();
    this.selectedId = '$';
    this.searchTerm = '';

    // Viewport transform
    this.panX = 36;
    this.panY = 36;
    this.scale = 1;
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0, panX: 0, panY: 0 };

    this.nodes = [];
    this.edges = [];
    this.bounds = { width: 800, height: 600 };

    this._renderShell();
    this._bindEvents();
  }

  _renderShell() {
    this.container.innerHTML = `
      <div class="graph-toolbar">
        <div class="graph-search-box">
          <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="text" class="graph-search-input" data-role="graph-search" placeholder="定位图谱节点..." autocomplete="off" spellcheck="false" />
        </div>
        <div class="graph-controls">
          <div class="btn-group-xs">
            <button type="button" class="btn-xs is-active" data-dir="LR" title="从左到右布局">水平 LR</button>
            <button type="button" class="btn-xs" data-dir="TB" title="从上到下布局">垂直 TB</button>
          </div>
          <div class="btn-group-xs">
            <button type="button" class="btn-xs" data-role="zoom-out" title="缩小">−</button>
            <span class="zoom-readout" data-role="zoom-label">100%</span>
            <button type="button" class="btn-xs" data-role="zoom-in" title="放大">+</button>
            <button type="button" class="btn-xs" data-role="zoom-fit" title="居中适配画布">适配</button>
          </div>
          <div class="btn-group-xs">
            <button type="button" class="btn-xs" data-role="export-svg" title="导出矢量 SVG 图片">导出 SVG</button>
            <button type="button" class="btn-xs" data-role="export-png" title="导出高清 PNG 图片">导出 PNG</button>
          </div>
        </div>
      </div>
      <div class="graph-canvas-wrap" data-role="canvas-wrap">
        <div class="graph-grid-bg"></div>
        <svg class="graph-svg" data-role="svg" xmlns="http://www.w3.org/2000/svg">
          <g data-role="viewport"></g>
        </svg>
        <div class="graph-hud" data-role="hud"></div>
      </div>
    `;

    this.searchInput = this.container.querySelector('[data-role="graph-search"]');
    this.zoomLabel = this.container.querySelector('[data-role="zoom-label"]');
    this.canvasWrap = this.container.querySelector('[data-role="canvas-wrap"]');
    this.svgEl = this.container.querySelector('[data-role="svg"]');
    this.viewportG = this.container.querySelector('[data-role="viewport"]');
    this.hudEl = this.container.querySelector('[data-role="hud"]');
  }

  _bindEvents() {
    // Direction switch
    this.container.querySelectorAll('[data-dir]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.direction = btn.getAttribute('data-dir');
        this.container.querySelectorAll('[data-dir]').forEach((b) => b.classList.toggle('is-active', b === btn));
        this.renderGraph(true);
      });
    });

    this.container.querySelector('[data-role="zoom-in"]').addEventListener('click', () => this._zoomBy(1.22));
    this.container.querySelector('[data-role="zoom-out"]').addEventListener('click', () => this._zoomBy(1 / 1.22));
    this.container.querySelector('[data-role="zoom-fit"]').addEventListener('click', () => this.fitToView());
    this.container.querySelector('[data-role="export-svg"]').addEventListener('click', () => this.exportSvg());
    this.container.querySelector('[data-role="export-png"]').addEventListener('click', () => this.exportPng());

    this.searchInput.addEventListener('input', () => {
      this.searchTerm = this.searchInput.value.trim().toLowerCase();
      this._applySearchHighlight(true);
    });

    // Mouse pan on canvas
    this.canvasWrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('[data-collapse-id]')) return;
      this.isDragging = true;
      this.movedDuringDrag = false;
      this.dragStart = { x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY };
      this.canvasWrap.classList.add('is-grabbing');
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.movedDuringDrag = true;
      this.panX = this.dragStart.panX + dx;
      this.panY = this.dragStart.panY + dy;
      this._applyTransform();
    });

    window.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.canvasWrap.classList.remove('is-grabbing');
      }
    });

    // Wheel zoom centered at pointer
    this.canvasWrap.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = this.canvasWrap.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 0.91;
        const nextScale = Math.min(2.6, Math.max(0.18, this.scale * factor));
        const ratio = nextScale / this.scale;
        this.panX = cursorX - (cursorX - this.panX) * ratio;
        this.panY = cursorY - (cursorY - this.panY) * ratio;
        this.scale = nextScale;
        this._applyTransform();
      },
      { passive: false }
    );

    // Node click & collapse button delegation
    this.svgEl.addEventListener('click', (e) => {
      if (this.movedDuringDrag) return;
      const collapseBtn = e.target.closest('[data-collapse-id]');
      if (collapseBtn) {
        e.stopPropagation();
        const id = collapseBtn.getAttribute('data-collapse-id');
        if (this.collapsedIds.has(id)) this.collapsedIds.delete(id);
        else this.collapsedIds.add(id);
        this.renderGraph(false);
        return;
      }

      const nodeGroup = e.target.closest('[data-node-id]');
      if (nodeGroup) {
        const id = nodeGroup.getAttribute('data-node-id');
        const found = this.nodes.find((n) => n.id === id);
        if (found) {
          this.selectedId = id;
          this.svgEl.querySelectorAll('.g-node.is-selected').forEach((el) => el.classList.remove('is-selected'));
          nodeGroup.classList.add('is-selected');
          const val = getValueAtPath(this.data, found.segments);
          const key = found.segments.length > 0 ? found.segments[found.segments.length - 1] : null;
          this.onSelectNode(inspectValue(val, key, found.segments));
        }
      }
    });
  }

  setData(value) {
    const isFirstLoad = this.data === undefined && value !== undefined;
    this.data = value;
    this.renderGraph(isFirstLoad);
  }

  _buildGraphModel(rootVal) {
    const nodes = [];
    const edges = [];
    let truncatedCount = 0;

    const createNode = (val, label, segments, depth) => {
      if (nodes.length >= MAX_GRAPH_NODES) {
        truncatedCount++;
        return null;
      }

      const { jsonPath } = formatPath(segments);
      const isArr = Array.isArray(val);
      const isObj = val !== null && typeof val === 'object' && !isArr;
      const rows = [];
      const childSpecs = [];

      if (isObj) {
        for (const [k, v] of Object.entries(val)) {
          if (v !== null && typeof v === 'object') {
            const badge = Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`;
            childSpecs.push({ key: k, edgeLabel: `${k} ${badge}`, val: v, segs: [...segments, k] });
          } else {
            rows.push({ key: k, val: v, type: v === null ? 'null' : typeof v });
          }
        }
        if (rows.length === 0 && childSpecs.length === 0) {
          rows.push({ key: '(empty)', val: '{}', type: 'empty' });
        }
      } else if (isArr) {
        const allPrimitives = val.every((item) => item === null || typeof item !== 'object');
        if (allPrimitives) {
          if (val.length === 0) {
            rows.push({ key: '(empty)', val: '[]', type: 'empty' });
          } else {
            val.slice(0, 12).forEach((item, idx) => {
              rows.push({ key: `[${idx}]`, val: item, type: item === null ? 'null' : typeof item });
            });
            if (val.length > 12) {
              rows.push({ key: '…', val: `还有 ${val.length - 12} 项`, type: 'empty' });
            }
          }
        } else {
          rows.push({ key: 'length', val: `${val.length} items`, type: 'meta' });
          val.forEach((item, idx) => {
            if (item !== null && typeof item === 'object') {
              childSpecs.push({ key: `[${idx}]`, edgeLabel: `[${idx}]`, val: item, segs: [...segments, idx] });
            } else {
              rows.push({ key: `[${idx}]`, val: item, type: item === null ? 'null' : typeof item });
            }
          });
        }
      } else {
        rows.push({ key: 'value', val, type: val === null ? 'null' : typeof val });
      }

      const displayRows = rows.slice(0, 14);
      if (rows.length > 14) {
        displayRows.push({ key: '…', val: `+${rows.length - 14} 个属性`, type: 'empty' });
      }

      const height = HEADER_H + Math.max(1, displayRows.length) * ROW_H + BODY_PAD;
      const collapsed = this.collapsedIds.has(jsonPath);

      const node = {
        id: jsonPath,
        title: label,
        kind: isArr ? 'array' : isObj ? 'object' : 'primitive',
        segments,
        depth,
        rows: displayRows,
        hasChildren: childSpecs.length > 0,
        childCount: childSpecs.length,
        collapsed,
        width: NODE_W,
        height,
        x: 0,
        y: 0,
        children: [],
        span: 0,
      };
      nodes.push(node);

      if (!collapsed) {
        for (const ch of childSpecs) {
          const childNode = createNode(ch.val, ch.key, ch.segs, depth + 1);
          if (childNode) {
            node.children.push(childNode);
            edges.push({
              from: node,
              to: childNode,
              label: ch.edgeLabel,
            });
          }
        }
      }

      return node;
    };

    const rootNode = createNode(rootVal, 'root', [], 0);
    return { rootNode, nodes, edges, truncatedCount };
  }

  _layoutTree(rootNode) {
    if (!rootNode) return { width: 400, height: 300 };

    if (this.direction === 'LR') {
      const measure = (n) => {
        if (n.children.length === 0) {
          n.span = n.height;
          return n.span;
        }
        let sum = 0;
        n.children.forEach((c, i) => {
          if (i > 0) sum += V_GAP;
          sum += measure(c);
        });
        n.span = Math.max(n.height, sum);
        return n.span;
      };

      const place = (n, x, topY) => {
        n.x = x;
        n.y = topY + (n.span - n.height) / 2;
        let childSum = 0;
        n.children.forEach((c, i) => {
          if (i > 0) childSum += V_GAP;
          childSum += c.span;
        });
        let curY = topY + (n.span - childSum) / 2;
        for (const c of n.children) {
          place(c, x + NODE_W + H_GAP, curY);
          curY += c.span + V_GAP;
        }
      };

      measure(rootNode);
      place(rootNode, 0, 0);
    } else {
      // Top-to-Bottom (TB)
      const levelMaxH = new Map();
      const collectDepthH = (n) => {
        levelMaxH.set(n.depth, Math.max(levelMaxH.get(n.depth) || 0, n.height));
        n.children.forEach(collectDepthH);
      };
      collectDepthH(rootNode);

      const levelY = new Map();
      let accY = 0;
      const maxD = Math.max(...levelMaxH.keys(), 0);
      for (let d = 0; d <= maxD; d++) {
        levelY.set(d, accY);
        accY += (levelMaxH.get(d) || 80) + 74;
      }

      const measureW = (n) => {
        if (n.children.length === 0) {
          n.span = n.width;
          return n.span;
        }
        let sum = 0;
        n.children.forEach((c, i) => {
          if (i > 0) sum += 28;
          sum += measureW(c);
        });
        n.span = Math.max(n.width, sum);
        return n.span;
      };

      const placeTB = (n, leftX) => {
        n.x = leftX + (n.span - n.width) / 2;
        n.y = levelY.get(n.depth) || 0;
        let childSum = 0;
        n.children.forEach((c, i) => {
          if (i > 0) childSum += 28;
          childSum += c.span;
        });
        let curX = leftX + (n.span - childSum) / 2;
        for (const c of n.children) {
          placeTB(c, curX);
          curX += c.span + 28;
        }
      };

      measureW(rootNode);
      placeTB(rootNode, 0);
    }

    let maxX = 0;
    let maxY = 0;
    this.nodes.forEach((n) => {
      if (n.x + n.width > maxX) maxX = n.x + n.width;
      if (n.y + n.height > maxY) maxY = n.y + n.height;
    });
    return { width: maxX, height: maxY };
  }

  renderGraph(autoFit = false) {
    if (this.data === undefined) {
      this.viewportG.innerHTML = '';
      this.hudEl.textContent = '等待有效的 JSON 数据';
      return;
    }

    const { rootNode, nodes, edges, truncatedCount } = this._buildGraphModel(this.data);
    this.nodes = nodes;
    this.edges = edges;
    this.bounds = this._layoutTree(rootNode);

    const edgesSvg = edges
      .map((e) => {
        let d;
        if (this.direction === 'LR') {
          const x1 = e.from.x + e.from.width;
          const y1 = e.from.y + e.from.height / 2;
          const x2 = e.to.x;
          const y2 = e.to.y + e.to.height / 2;
          const cx = (x1 + x2) / 2;
          d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
        } else {
          const x1 = e.from.x + e.from.width / 2;
          const y1 = e.from.y + e.from.height;
          const x2 = e.to.x + e.to.width / 2;
          const y2 = e.to.y;
          const cy = (y1 + y2) / 2;
          d = `M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`;
        }
        return `<path class="g-edge" d="${d}" fill="none" />`;
      })
      .join('');

    const nodesSvg = nodes.map((n) => this._renderNodeSvg(n)).join('');

    this.viewportG.innerHTML = `<g class="g-edges">${edgesSvg}</g><g class="g-nodes">${nodesSvg}</g>`;

    const truncNote = truncatedCount > 0 ? ` · 已智能省略 ${truncatedCount} 个深层节点以保障流畅度` : '';
    this.hudEl.textContent = `${nodes.length} 个节点 · ${edges.length} 条连线${truncNote}`;

    if (autoFit) {
      requestAnimationFrame(() => this.fitToView());
    } else {
      this._applyTransform();
    }

    if (this.searchTerm) {
      this._applySearchHighlight(false);
    }
  }

  _renderNodeSvg(n) {
    const isSelected = n.id === this.selectedId;
    const badgeText = n.kind === 'array' ? '[ ]' : n.kind === 'object' ? '{ }' : 'val';
    const truncStr = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

    const rowsSvg = n.rows
      .map((r, idx) => {
        const ry = HEADER_H + 5 + idx * ROW_H;
        const keyStr = truncStr(String(r.key), 15);
        let valStr = r.type === 'string' ? `"${r.val}"` : String(r.val);
        valStr = truncStr(valStr, 20);
        const colorSwatch =
          r.type === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(r.val).trim())
            ? `<rect x="${n.width - 22}" y="${ry + 4}" width="10" height="10" rx="2" fill="${escapeHtml(String(r.val).trim())}" stroke="rgba(255,255,255,0.3)" />`
            : '';
        return `
          <g class="g-row">
            <text x="12" y="${ry + 13}" class="g-key">${escapeHtml(keyStr)}</text>
            <text x="${n.width - (colorSwatch ? 28 : 12)}" y="${ry + 13}" text-anchor="end" class="g-val g-type-${r.type}">${escapeHtml(valStr)}</text>
            ${colorSwatch}
          </g>
        `;
      })
      .join('');

    const collapseControl = n.hasChildren
      ? `
        <g class="g-collapse-btn" data-collapse-id="${escapeHtml(n.id)}" transform="translate(${n.width - 28}, 6)">
          <rect width="20" height="18" rx="4" class="g-collapse-bg" />
          <text x="10" y="13" text-anchor="middle" class="g-collapse-txt">${n.collapsed ? `+${n.childCount}` : '−'}</text>
        </g>
      `
      : '';

    return `
      <g class="g-node g-kind-${n.kind} ${isSelected ? 'is-selected' : ''}" data-node-id="${escapeHtml(n.id)}" transform="translate(${n.x}, ${n.y})">
        <rect class="g-card-bg" width="${n.width}" height="${n.height}" rx="8" />
        <path class="g-card-head" d="M 0 8 A 8 8 0 0 1 8 0 L ${n.width - 8} 0 A 8 8 0 0 1 ${n.width} 8 L ${n.width} ${HEADER_H} L 0 ${HEADER_H} Z" />
        <text x="12" y="19" class="g-title">${escapeHtml(truncStr(n.title, 22))}</text>
        <text x="${n.hasChildren ? n.width - 36 : n.width - 12}" y="19" text-anchor="end" class="g-kind-tag">${badgeText}</text>
        ${collapseControl}
        ${rowsSvg}
      </g>
    `;
  }

  _applyTransform() {
    this.viewportG.setAttribute('transform', `translate(${this.panX}, ${this.panY}) scale(${this.scale})`);
    this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
  }

  _zoomBy(factor) {
    const rect = this.canvasWrap.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const next = Math.min(2.6, Math.max(0.18, this.scale * factor));
    const ratio = next / this.scale;
    this.panX = cx - (cx - this.panX) * ratio;
    this.panY = cy - (cy - this.panY) * ratio;
    this.scale = next;
    this._applyTransform();
  }

  fitToView() {
    const rect = this.canvasWrap.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || this.nodes.length === 0) {
      this.panX = 36;
      this.panY = 36;
      this.scale = 1;
      this._applyTransform();
      return;
    }
    const pad = 64;
    const scaleX = (rect.width - pad) / Math.max(1, this.bounds.width);
    const scaleY = (rect.height - pad) / Math.max(1, this.bounds.height);
    this.scale = Math.min(1.15, Math.max(0.22, Math.min(scaleX, scaleY)));
    this.panX = Math.max(24, (rect.width - this.bounds.width * this.scale) / 2);
    this.panY = Math.max(24, (rect.height - this.bounds.height * this.scale) / 2);
    this._applyTransform();
  }

  _applySearchHighlight(panToFirst = false) {
    let firstMatch = null;
    this.svgEl.querySelectorAll('.g-node').forEach((el) => {
      const id = el.getAttribute('data-node-id');
      const n = this.nodes.find((x) => x.id === id);
      if (!this.searchTerm || !n) {
        el.classList.remove('is-match');
        return;
      }
      const hit =
        n.title.toLowerCase().includes(this.searchTerm) ||
        n.rows.some(
          (r) =>
            String(r.key).toLowerCase().includes(this.searchTerm) ||
            String(r.val).toLowerCase().includes(this.searchTerm)
        );
      el.classList.toggle('is-match', hit);
      if (hit && !firstMatch) firstMatch = n;
    });

    if (panToFirst && firstMatch) {
      const rect = this.canvasWrap.getBoundingClientRect();
      this.panX = rect.width / 2 - (firstMatch.x + firstMatch.width / 2) * this.scale;
      this.panY = rect.height / 2 - (firstMatch.y + firstMatch.height / 2) * this.scale;
      this._applyTransform();
    }
  }

  _buildStandaloneSvgString() {
    const pad = 40;
    const w = Math.ceil(this.bounds.width + pad * 2);
    const h = Math.ceil(this.bounds.height + pad * 2);
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const bg = isLight ? '#f8fafc' : '#0b0d12';
    const cardBg = isLight ? '#ffffff' : '#151924';
    const headBg = isLight ? '#eef2ff' : '#1e2436';
    const border = isLight ? '#cbd5e1' : '#2d364f';
    const textMain = isLight ? '#0f172a' : '#e2e8f0';
    const textKey = isLight ? '#0369a1' : '#7dcfff';
    const edgeColor = isLight ? '#94a3b8' : '#4b5563';

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <style>
    text { font-family: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace; font-size: 12px; }
    .g-edge { stroke: ${edgeColor}; stroke-width: 1.6; }
    .g-card-bg { fill: ${cardBg}; stroke: ${border}; stroke-width: 1.2; }
    .g-card-head { fill: ${headBg}; }
    .g-title { fill: ${textMain}; font-weight: 600; font-size: 12.5px; }
    .g-kind-tag { fill: #6366f1; font-size: 11px; }
    .g-key { fill: ${textKey}; }
    .g-val { fill: ${textMain}; }
    .g-type-string { fill: ${isLight ? '#15803d' : '#9ece6a'}; }
    .g-type-number { fill: ${isLight ? '#c2410c' : '#ff9e64'}; }
    .g-type-boolean { fill: ${isLight ? '#7e22ce' : '#bb9af7'}; }
    .g-type-null { fill: #f43f5e; font-style: italic; }
    .g-collapse-bg { fill: rgba(99,102,241,0.18); }
    .g-collapse-txt { fill: ${textMain}; font-size: 11px; }
  </style>
  <rect width="100%" height="100%" fill="${bg}" />
  <g transform="translate(${pad}, ${pad})">${this.viewportG.innerHTML}</g>
</svg>`;
  }

  exportSvg() {
    if (this.nodes.length === 0) return;
    const svgStr = this._buildStandaloneSvgString();
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jsonlens-graph-${Date.now()}.svg`;
    a.click();
    URL.revokeObjectURL(url);
    this.onNotify('已导出矢量图谱 SVG');
  }

  exportPng() {
    if (this.nodes.length === 0) return;
    const svgStr = this._buildStandaloneSvgString();
    const img = new Image();
    const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((pngBlob) => {
        if (!pngBlob) return;
        const pngUrl = URL.createObjectURL(pngBlob);
        const a = document.createElement('a');
        a.href = pngUrl;
        a.download = `jsonlens-graph-${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(pngUrl);
        this.onNotify('已导出高清 2x PNG 图谱');
      }, 'image/png');
    };
    img.src = url;
  }
}
