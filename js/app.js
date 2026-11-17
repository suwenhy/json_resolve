/**
 * JSONLens Application Controller
 * Coordinates Multi-Tab Workspace, Split Resizer, Editor, Tree/Graph/Table/Codegen/Diff Views,
 * Command Palette (Cmd/Ctrl+K), Drag & Drop File Import, Theme, and Local Persistence.
 */

import { parseJsonSafe, analyzeJsonStats, escapeHtml } from './core/parser.js?v=20261117-3';
import {
  repairJson,
  formatJsonText,
  minifyJsonText,
  escapeJsonText,
  unescapeJsonText,
  unpackNestedJson,
  sortJsonKeys,
} from './core/repair.js';
import { setValueAtPath } from './core/query.js';
import { SAMPLES } from './samples.js';
import { JsonCodeEditor } from './ui/editor.js?v=20261117-3';
import { JsonTreeView } from './ui/treeView.js?v=20261117-3';
import { JsonGraphView } from './ui/graphView.js?v=20261117-3';
import { JsonTableView } from './ui/tableView.js';
import { JsonCodegenView } from './ui/codegenView.js';
import { JsonDiffView } from './ui/diffView.js';

const STORAGE_TABS_KEY = 'jsonlens_workspace_v1';
const STORAGE_THEME_KEY = 'jsonlens_theme_v1';
const STORAGE_FONTSIZE_KEY = 'jsonlens_fontsize_v1';

class JsonLensApp {
  constructor() {
    this.tabs = [];
    this.activeTabId = '';
    this.activeView = 'tree'; // 'tree' | 'graph' | 'table' | 'codegen' | 'diff'
    this.indentSetting = 2; // 2 | 4 | '\t'
    this.fontSize = 13;
    this.leftCollapsed = false;
    this.parseResult = { ok: true, empty: true, value: undefined, error: null };
    this.cmdPaletteIdx = 0;
    this.filteredCommands = [];

    this._initTheme();
    this._loadWorkspace();
    this._initComponents();
    this._initFontSize();
    this._bindGlobalEvents();
    this._renderTabs();
    this._activateCurrentTab();
  }

  _initTheme() {
    const saved = localStorage.getItem(STORAGE_THEME_KEY);
    const theme = saved === 'light' || saved === 'dark' ? saved : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  }

  toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(STORAGE_THEME_KEY, next);
    if (this.activeView === 'graph') {
      this.graphView.renderGraph(false);
    }
    this.toast(next === 'dark' ? '已切换至深色主题' : '已切换至浅色主题');
  }

  _initFontSize() {
    const saved = parseInt(localStorage.getItem(STORAGE_FONTSIZE_KEY) || '13', 10);
    const initial = Number.isFinite(saved) ? Math.min(22, Math.max(11, saved)) : 13;
    this.setFontSize(initial, false);
  }

  setFontSize(size, notify = true) {
    const clamped = Math.min(22, Math.max(11, size));
    this.fontSize = clamped;
    const lineHeight = Math.round(clamped * 1.68);
    const root = document.documentElement;
    root.style.setProperty('--editor-font-size', `${clamped}px`);
    root.style.setProperty('--editor-line-height', `${lineHeight}px`);
    root.style.setProperty('--tree-font-size', `${Math.max(11, clamped - 0.5)}px`);
    root.style.setProperty('--code-font-size', `${Math.max(11, clamped - 0.5)}px`);

    const label = document.getElementById('font-size-label');
    if (label) label.textContent = `${clamped}px`;
    if (this.editor) this.editor.setFontSize(clamped, lineHeight);
    localStorage.setItem(STORAGE_FONTSIZE_KEY, String(clamped));
    if (notify) this.toast(`字体大小已调整为 ${clamped}px`);
  }

  _loadWorkspace() {
    try {
      const raw = localStorage.getItem(STORAGE_TABS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
          this.tabs = parsed.tabs;
          this.activeTabId = parsed.activeTabId || this.tabs[0].id;
          return;
        }
      }
    } catch {
      // ignore corrupted storage
    }

    this.tabs = [
      {
        id: 'tab_' + Date.now(),
        title: '订单网关响应.json',
        content: SAMPLES[0].content,
      },
    ];
    this.activeTabId = this.tabs[0].id;
  }

  _saveWorkspace() {
    try {
      // Avoid exceeding localStorage quota when user pastes multi-MB files
      const safeTabs = this.tabs.map((t) => ({
        id: t.id,
        title: t.title,
        content: t.content.length <= 450000 ? t.content : t.content.slice(0, 450000),
      }));
      localStorage.setItem(
        STORAGE_TABS_KEY,
        JSON.stringify({ tabs: safeTabs, activeTabId: this.activeTabId })
      );
    } catch {
      // ignore storage quota errors
    }
  }

  _initComponents() {
    // 1. Code Editor
    this.editor = new JsonCodeEditor(document.getElementById('editor-mount'), {
      onChange: (val) => this._handleEditorChange(val),
      onCursorChange: (pos) => {
        document.getElementById('status-cursor').textContent = `行 ${pos.line}, 列 ${pos.column}`;
      },
      onFormatShortcut: () => this.formatCurrent(),
    });

    // 2. Tree View + Smart Inspector
    this.treeView = new JsonTreeView(document.getElementById('view-tree'), {
      onSelectPath: (info) => this._updateBreadcrumb(info.jsonPath),
      onCopy: (txt, label) => this.copyToClipboard(txt, label),
      onUnpackAtPath: (segments, parsedVal) => {
        if (!this.parseResult.ok) return;
        const updated = setValueAtPath(this.parseResult.value, segments, parsedVal);
        this.editor.setValue(JSON.stringify(updated, null, this.indentSetting));
        this.toast('已将该字段的内嵌 JSON 字符串原地展开');
      },
    });

    // 3. Graph View
    this.graphView = new JsonGraphView(document.getElementById('view-graph'), {
      onSelectNode: (info) => {
        this._updateBreadcrumb(info.jsonPath);
        this.toast(`选中节点：${info.jsonPath}`);
      },
      onNotify: (msg) => this.toast(msg),
    });

    // 4. Table View
    this.tableView = new JsonTableView(document.getElementById('view-table'), {
      onCopy: (txt, label) => this.copyToClipboard(txt, label),
      onNotify: (msg) => this.toast(msg),
    });

    // 5. Codegen View
    this.codegenView = new JsonCodegenView(document.getElementById('view-codegen'), {
      onCopy: (txt, label) => this.copyToClipboard(txt, label),
      onNotify: (msg) => this.toast(msg),
    });

    // 6. Diff View
    this.diffView = new JsonDiffView(document.getElementById('view-diff'), {
      onCopy: (txt, label) => this.copyToClipboard(txt, label),
      onNotify: (msg) => this.toast(msg),
      getOtherTabs: () => this.tabs.filter((t) => t.id !== this.activeTabId),
    });

    // Populate Sample Menu
    const sampleMenu = document.getElementById('samples-menu');
    sampleMenu.innerHTML = SAMPLES.map(
      (s) => `
        <button type="button" class="dropdown-item" data-sample-id="${escapeHtml(s.id)}">
          <div class="dd-item-title">${escapeHtml(s.title)}</div>
          <div class="dd-item-sub">${escapeHtml(s.subtitle)}</div>
        </button>
      `
    ).join('');
  }

  _bindGlobalEvents() {
    // Tabs bar delegation
    const tabsList = document.getElementById('tabs-list');
    tabsList.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-close-tab]');
      if (closeBtn) {
        e.stopPropagation();
        this.closeTab(closeBtn.getAttribute('data-close-tab'));
        return;
      }
      const tabEl = e.target.closest('[data-tab-id]');
      if (tabEl) {
        this.switchTab(tabEl.getAttribute('data-tab-id'));
      }
    });

    tabsList.addEventListener('dblclick', (e) => {
      const tabEl = e.target.closest('[data-tab-id]');
      if (!tabEl) return;
      const id = tabEl.getAttribute('data-tab-id');
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab) return;
      const nextName = window.prompt('重命名当前标签页：', tab.title);
      if (nextName && nextName.trim()) {
        tab.title = nextName.trim();
        this._saveWorkspace();
        this._renderTabs();
      }
    });

    document.getElementById('btn-new-tab').addEventListener('click', () => this.createNewTab());

    // Dropdown menus toggle & outside click close
    document.querySelectorAll('[data-dropdown-trigger]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menuId = btn.getAttribute('data-dropdown-trigger');
        const menu = document.getElementById(menuId);
        const wasOpen = menu.classList.contains('is-open');
        this._closeAllDropdowns();
        if (!wasOpen) menu.classList.add('is-open');
      });
    });

    window.addEventListener('click', () => this._closeAllDropdowns());

    // Sample selection
    document.getElementById('samples-menu').addEventListener('click', (e) => {
      const item = e.target.closest('[data-sample-id]');
      if (!item) return;
      const sample = SAMPLES.find((s) => s.id === item.getAttribute('data-sample-id'));
      if (sample) {
        this.createNewTab(sample.title, sample.content);
        this.toast(`已加载示例：${sample.title}`);
      }
    });

    // Indent selector
    document.getElementById('indent-select').addEventListener('change', (e) => {
      const v = e.target.value;
      this.indentSetting = v === 'tab' ? '\t' : parseInt(v, 10) || 2;
      if (this.parseResult.ok && !this.parseResult.empty) {
        this.formatCurrent();
      }
    });

    // Toolbar actions
    document.getElementById('btn-format').addEventListener('click', () => this.formatCurrent());
    document.getElementById('btn-minify').addEventListener('click', () => this.minifyCurrent());
    document.getElementById('btn-repair').addEventListener('click', () => this.repairCurrent());
    document.getElementById('btn-copy-editor').addEventListener('click', () => {
      this.copyToClipboard(this.editor.getValue(), 'JSON 内容');
    });
    document.getElementById('btn-clear-editor').addEventListener('click', () => {
      if (!this.editor.getValue()) return;
      this.editor.setValue('');
      this.toast('已清空当前编辑器');
    });
    document.getElementById('btn-search-editor').addEventListener('click', () => this.editor.openFind());

    // Transform dropdown items
    document.getElementById('transform-menu').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-transform]');
      if (!btn) return;
      this._runTransform(btn.getAttribute('data-transform'));
    });

    // File import & export
    const fileInput = document.getElementById('file-input');
    document.getElementById('btn-import-file').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) this._importFile(file);
      fileInput.value = '';
    });

    document.getElementById('btn-download-json').addEventListener('click', () => this.downloadJsonFile());
    document.getElementById('btn-font-dec').addEventListener('click', () => this.setFontSize(this.fontSize - 1));
    document.getElementById('btn-font-inc').addEventListener('click', () => this.setFontSize(this.fontSize + 1));
    document.getElementById('font-size-label').addEventListener('click', () => this.setFontSize(13));
    document.getElementById('btn-theme-toggle').addEventListener('click', () => this.toggleTheme());
    document.getElementById('btn-cmd-palette').addEventListener('click', () => this.openCommandPalette());
    document.getElementById('btn-help-modal').addEventListener('click', () => this.toggleShortcutsModal(true));
    document.getElementById('btn-close-help').addEventListener('click', () => this.toggleShortcutsModal(false));

    // Error banner buttons
    document.getElementById('btn-err-locate').addEventListener('click', () => {
      if (this.parseResult.error?.line) {
        this.editor.scrollToLine(this.parseResult.error.line, true);
      }
    });
    document.getElementById('btn-err-repair').addEventListener('click', () => this.repairCurrent());
    document.getElementById('btn-unescape-banner').addEventListener('click', () => this._runTransform('unescape'));

    // Status bar error / path click
    document.getElementById('status-valid').addEventListener('click', () => {
      if (!this.parseResult.ok && this.parseResult.error?.line) {
        this.editor.scrollToLine(this.parseResult.error.line, true);
      }
    });
    document.getElementById('status-path').addEventListener('click', (e) => {
      const txt = e.currentTarget.textContent.trim();
      if (txt) this.copyToClipboard(txt, 'JSONPath');
    });

    // View mode segmented control
    document.getElementById('view-switcher').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (!btn) return;
      this.switchView(btn.getAttribute('data-view'));
    });

    // Left pane collapse / maximize right view
    document.getElementById('btn-toggle-left').addEventListener('click', () => this.toggleLeftPane());

    // Split pane resizer drag
    this._setupSplitResizer();

    // Full-window drag & drop .json file
    this._setupDragAndDrop();

    // Command palette keyboard & click
    this._setupCommandPalette();

    // Global shortcuts
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.openCommandPalette();
        return;
      }
      if (e.key === 'Escape') {
        this.closeCommandPalette();
        this.toggleShortcutsModal(false);
      }
    });
  }

  _closeAllDropdowns() {
    document.querySelectorAll('.dropdown-menu.is-open').forEach((m) => m.classList.remove('is-open'));
  }

  _renderTabs() {
    const container = document.getElementById('tabs-list');
    container.innerHTML = this.tabs
      .map(
        (t) => `
          <div class="ws-tab ${t.id === this.activeTabId ? 'is-active' : ''}" data-tab-id="${escapeHtml(t.id)}" title="双击可重命名标签页">
            <span class="ws-tab-dot"></span>
            <span class="ws-tab-title">${escapeHtml(t.title)}</span>
            ${
              this.tabs.length > 1
                ? `<button type="button" class="ws-tab-close" data-close-tab="${escapeHtml(t.id)}" title="关闭标签页">×</button>`
                : ''
            }
          </div>
        `
      )
      .join('');
  }

  createNewTab(title = null, content = '{\n  \n}') {
    const idx = this.tabs.length + 1;
    const newTab = {
      id: 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      title: title || `未命名-${idx}.json`,
      content,
    };
    this.tabs.push(newTab);
    this.activeTabId = newTab.id;
    this._saveWorkspace();
    this._renderTabs();
    this._activateCurrentTab();
  }

  switchTab(id) {
    if (id === this.activeTabId) return;
    this.activeTabId = id;
    this._saveWorkspace();
    this._renderTabs();
    this._activateCurrentTab();
  }

  closeTab(id) {
    if (this.tabs.length <= 1) return;
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    this.tabs.splice(idx, 1);
    if (this.activeTabId === id) {
      const nextTab = this.tabs[Math.max(0, idx - 1)];
      this.activeTabId = nextTab.id;
    }
    this._saveWorkspace();
    this._renderTabs();
    this._activateCurrentTab();
  }

  _activateCurrentTab() {
    const tab = this.tabs.find((t) => t.id === this.activeTabId) || this.tabs[0];
    if (!tab) return;
    this.editor.setValue(tab.content, true);
    this._processJson(tab.content);
  }

  _handleEditorChange(val) {
    const tab = this.tabs.find((t) => t.id === this.activeTabId);
    if (tab) {
      tab.content = val;
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this._saveWorkspace(), 300);
    }

    clearTimeout(this._parseTimer);
    const delay = val.length > 100000 ? 180 : 35;
    this._parseTimer = setTimeout(() => this._processJson(val), delay);
  }

  _processJson(raw) {
    const res = parseJsonSafe(raw);
    this.parseResult = res;

    const errBanner = document.getElementById('error-banner');
    const escapedBanner = document.getElementById('escaped-banner');
    const repairBtn = document.getElementById('btn-repair');
    const statusValid = document.getElementById('status-valid');
    const statusMetrics = document.getElementById('status-metrics');

    if (res.empty) {
      this.editor.setErrorLine(null);
      errBanner.classList.add('hidden');
      escapedBanner.classList.add('hidden');
      repairBtn.classList.remove('has-pulse');
      statusValid.className = 'status-pill is-idle';
      statusValid.textContent = '○ 等待输入';
      statusMetrics.textContent = '0 B · 0 行';
      this._syncActiveViewData(undefined);
      return;
    }

    if (!res.ok) {
      const err = res.error;
      this.editor.setErrorLine(err.line);
      errBanner.classList.remove('hidden');
      escapedBanner.classList.add('hidden');
      document.getElementById('err-loc-text').textContent = `第 ${err.line} 行，第 ${err.column} 列`;
      document.getElementById('err-reason-text').textContent = err.reason;
      repairBtn.classList.toggle('has-pulse', Boolean(err.repairable));

      statusValid.className = 'status-pill is-err clickable';
      statusValid.textContent = `✕ 语法错误：第 ${err.line} 行, 第 ${err.column} 列`;
      statusMetrics.textContent = `${(new TextEncoder().encode(raw).length / 1024).toFixed(2)} KB`;
      return;
    }

    // Valid JSON!
    this.editor.setErrorLine(null);
    errBanner.classList.add('hidden');
    escapedBanner.classList.toggle('hidden', !res.isEscapedJsonString);
    repairBtn.classList.remove('has-pulse');

    const stats = analyzeJsonStats(res.value, raw);
    statusValid.className = 'status-pill is-ok';
    statusValid.textContent = '● JSON 语法有效';
    statusMetrics.textContent = `${stats.formattedBytes} · ${stats.lines} 行 · 深度 ${stats.maxDepth} · ${stats.keys} 键`;

    this._syncActiveViewData(res.value);
  }

  _syncActiveViewData(value) {
    if (this.activeView === 'tree') this.treeView.setData(value);
    else if (this.activeView === 'graph') this.graphView.setData(value);
    else if (this.activeView === 'table') this.tableView.setData(value);
    else if (this.activeView === 'codegen') this.codegenView.setData(value);
    else if (this.activeView === 'diff') this.diffView.setLeftData(value);
  }

  switchView(viewName) {
    this.activeView = viewName;
    document.querySelectorAll('#view-switcher [data-view]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-view') === viewName);
    });
    document.querySelectorAll('.right-view-pane').forEach((pane) => {
      pane.classList.toggle('is-active', pane.id === `view-${viewName}`);
    });
    const val = this.parseResult.ok && !this.parseResult.empty ? this.parseResult.value : undefined;
    this._syncActiveViewData(val);
    if (viewName === 'graph' && val !== undefined) {
      requestAnimationFrame(() => this.graphView.fitToView());
    }
  }

  toggleLeftPane() {
    this.leftCollapsed = !this.leftCollapsed;
    const workbench = document.getElementById('workbench');
    const btn = document.getElementById('btn-toggle-left');
    workbench.classList.toggle('left-collapsed', this.leftCollapsed);
    btn.textContent = this.leftCollapsed ? '显示编辑器' : '专注视图';
    if (this.activeView === 'graph') {
      setTimeout(() => this.graphView.fitToView(), 60);
    }
  }

  formatCurrent() {
    const raw = this.editor.getValue();
    if (!raw.trim()) return;
    try {
      const formatted = formatJsonText(raw, this.indentSetting);
      this.editor.setValue(formatted);
      this.toast('JSON 已格式化');
    } catch {
      this.toast('当前存在语法错误，可点击「智能修复」自动修正并格式化');
    }
  }

  minifyCurrent() {
    const raw = this.editor.getValue();
    if (!raw.trim()) return;
    try {
      const minified = minifyJsonText(raw);
      this.editor.setValue(minified);
      this.toast('JSON 已压缩为单行');
    } catch {
      this.toast('语法错误无法压缩，请先点击「智能修复」');
    }
  }

  repairCurrent() {
    const raw = this.editor.getValue();
    if (!raw.trim()) return;
    const res = repairJson(raw);
    if (res.ok) {
      this.editor.setValue(res.output);
      const summary = res.changes.length > 0 ? `智能修复完成：${res.changes.join('、')}` : 'JSON 语法有效，已完成格式化';
      this.toast(summary);
    } else {
      this.toast('自动修复未能完全解决语法冲突：' + (res.error || '请检查结构'));
    }
  }

  _runTransform(kind) {
    const raw = this.editor.getValue();
    if (!raw.trim()) return;

    if (kind === 'unescape') {
      const out = unescapeJsonText(raw);
      this.editor.setValue(out);
      this.toast('已执行去转义处理');
      return;
    }

    if (kind === 'escape') {
      const out = escapeJsonText(raw);
      this.editor.setValue(out);
      this.toast('已转义为 JSON 字符串字面量');
      return;
    }

    if (!this.parseResult.ok || this.parseResult.empty) {
      this.toast('请先确保 JSON 语法有效（可使用「智能修复」）');
      return;
    }

    if (kind === 'unpack-nested') {
      const { value, unpackedCount } = unpackNestedJson(this.parseResult.value);
      if (unpackedCount === 0) {
        this.toast('未检测到可解包的内嵌 JSON 字符串字段');
      } else {
        this.editor.setValue(JSON.stringify(value, null, this.indentSetting));
        this.toast(`成功递归解包 ${unpackedCount} 处内嵌 JSON 字段`);
      }
    } else if (kind === 'sort-asc') {
      const sorted = sortJsonKeys(this.parseResult.value, 'asc', true);
      this.editor.setValue(JSON.stringify(sorted, null, this.indentSetting));
      this.toast('已按属性键名升序排列 (A → Z)');
    } else if (kind === 'sort-desc') {
      const sorted = sortJsonKeys(this.parseResult.value, 'desc', true);
      this.editor.setValue(JSON.stringify(sorted, null, this.indentSetting));
      this.toast('已按属性键名降序排列 (Z → A)');
    }
  }

  _importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      this.createNewTab(file.name, content);
      this.toast(`已导入文件：${file.name}`);
    };
    reader.readAsText(file, 'utf-8');
  }

  downloadJsonFile() {
    const content = this.editor.getValue();
    if (!content.trim()) return;
    const tab = this.tabs.find((t) => t.id === this.activeTabId);
    let filename = tab ? tab.title : 'data.json';
    if (!filename.endsWith('.json')) filename += '.json';

    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    this.toast(`已下载 ${filename}`);
  }

  _updateBreadcrumb(jsonPath) {
    document.getElementById('status-path').textContent = jsonPath || '$';
  }

  async copyToClipboard(text, label = '内容') {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(`已复制${label}到剪贴板`);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      this.toast(`已复制${label}到剪贴板`);
    }
  }

  toast(message) {
    const host = document.getElementById('toast-host');
    const el = document.createElement('div');
    el.className = 'toast-item';
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }

  _setupSplitResizer() {
    const resizer = document.getElementById('split-resizer');
    const leftPane = document.getElementById('left-pane');
    const workbench = document.getElementById('workbench');
    let dragging = false;

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      resizer.classList.add('is-dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = workbench.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(76, Math.max(24, pct));
      leftPane.style.width = `${clamped}%`;
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('is-dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  _setupDragAndDrop() {
    const dropOverlay = document.getElementById('drop-overlay');
    let dragDepth = 0;

    window.addEventListener('dragenter', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        dragDepth++;
        dropOverlay.classList.remove('hidden');
      }
    });

    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
      }
    });

    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropOverlay.classList.add('hidden');
    });

    window.addEventListener('drop', (e) => {
      dragDepth = 0;
      dropOverlay.classList.add('hidden');
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        e.preventDefault();
        this._importFile(file);
      }
    });
  }

  _getCommands() {
    return [
      { title: '格式化 JSON (Prettify)', hint: '⌘/Ctrl + Enter', run: () => this.formatCurrent() },
      { title: '压缩 JSON 为单行 (Minify)', hint: '紧凑输出', run: () => this.minifyCurrent() },
      { title: '智能修复非标准 JSON (Auto Repair)', hint: '去注释/单引号/尾随逗号/Python', run: () => this.repairCurrent() },
      { title: '递归解包所有内嵌 JSON 字符串', hint: 'Unpack Nested JSON', run: () => this._runTransform('unpack-nested') },
      { title: '字符串去转义 (Unescape)', hint: '\\" → "', run: () => this._runTransform('unescape') },
      { title: '字符串转义 (Escape)', hint: '" → \\"', run: () => this._runTransform('escape') },
      { title: '按属性键名升序排序 (A → Z)', hint: '递归排序', run: () => this._runTransform('sort-asc') },
      { title: '按属性键名降序排序 (Z → A)', hint: '递归排序', run: () => this._runTransform('sort-desc') },
      { title: '切换至：树形透视视图 (Tree & Inspector)', hint: '视图', run: () => this.switchView('tree') },
      { title: '切换至：可视化图谱视图 (Graph View)', hint: 'JSON Crack 风格', run: () => this.switchView('graph') },
      { title: '切换至：智能数据表格视图 (Table & CSV)', hint: '支持导出 Excel CSV', run: () => this.switchView('table') },
      { title: '切换至：类型与格式生成 (TS / Go / Python / Java / Rust / YAML)', hint: '代码生成', run: () => this.switchView('codegen') },
      { title: '切换至：语义级 JSON 差异对比 (Structural Diff)', hint: '忽略键名顺序', run: () => this.switchView('diff') },
      { title: '切换深色 / 浅色主题', hint: 'Dark / Light', run: () => this.toggleTheme() },
      { title: '增大编辑器字体 (A+)', hint: 'Font Size +', run: () => this.setFontSize(this.fontSize + 1) },
      { title: '减小编辑器字体 (A−)', hint: 'Font Size -', run: () => this.setFontSize(this.fontSize - 1) },
      { title: '重置编辑器字体为默认 13px', hint: 'Reset Font', run: () => this.setFontSize(13) },
      { title: '在编辑器中查找并定位 (Find)', hint: '⌘/Ctrl + F', run: () => this.editor.openFind() },
      { title: '新建空白标签页', hint: '多文档工作区', run: () => this.createNewTab() },
      { title: '载入示例：非标准/损坏的日志 JSON', hint: '演示一键修复', run: () => this.createNewTab(SAMPLES[1].title, SAMPLES[1].content) },
      { title: '下载当前 JSON 文件', hint: '.json', run: () => this.downloadJsonFile() },
    ];
  }

  _setupCommandPalette() {
    this.cmdModal = document.getElementById('cmd-modal');
    this.cmdInput = document.getElementById('cmd-input');
    this.cmdList = document.getElementById('cmd-list');

    this.cmdModal.addEventListener('click', (e) => {
      if (e.target === this.cmdModal) this.closeCommandPalette();
    });

    this.cmdInput.addEventListener('input', () => {
      this.cmdPaletteIdx = 0;
      this._renderCommandList();
    });

    this.cmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.filteredCommands.length > 0) {
          this.cmdPaletteIdx = (this.cmdPaletteIdx + 1) % this.filteredCommands.length;
          this._renderCommandList();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.filteredCommands.length > 0) {
          this.cmdPaletteIdx = (this.cmdPaletteIdx - 1 + this.filteredCommands.length) % this.filteredCommands.length;
          this._renderCommandList();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = this.filteredCommands[this.cmdPaletteIdx];
        if (item) {
          this.closeCommandPalette();
          item.run();
        }
      }
    });

    this.cmdList.addEventListener('click', (e) => {
      const row = e.target.closest('[data-cmd-idx]');
      if (!row) return;
      const idx = parseInt(row.getAttribute('data-cmd-idx'), 10);
      const item = this.filteredCommands[idx];
      if (item) {
        this.closeCommandPalette();
        item.run();
      }
    });
  }

  openCommandPalette() {
    this.cmdModal.classList.remove('hidden');
    this.cmdInput.value = '';
    this.cmdPaletteIdx = 0;
    this._renderCommandList();
    this.cmdInput.focus();
  }

  closeCommandPalette() {
    this.cmdModal.classList.add('hidden');
  }

  _renderCommandList() {
    const q = this.cmdInput.value.trim().toLowerCase();
    const all = this._getCommands();
    this.filteredCommands = q
      ? all.filter((c) => c.title.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q))
      : all;

    if (this.filteredCommands.length === 0) {
      this.cmdList.innerHTML = `<div class="cmd-empty">未找到匹配的命令</div>`;
      return;
    }

    this.cmdList.innerHTML = this.filteredCommands
      .map(
        (c, i) => `
          <div class="cmd-item ${i === this.cmdPaletteIdx ? 'is-active' : ''}" data-cmd-idx="${i}">
            <span class="cmd-title">${escapeHtml(c.title)}</span>
            <kbd class="cmd-hint">${escapeHtml(c.hint)}</kbd>
          </div>
        `
      )
      .join('');
  }

  toggleShortcutsModal(open) {
    const modal = document.getElementById('help-modal');
    modal.classList.toggle('hidden', !open);
    if (open) {
      modal.onclick = (e) => {
        if (e.target === modal) this.toggleShortcutsModal(false);
      };
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.jsonLensApp = new JsonLensApp();
});
