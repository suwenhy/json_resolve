/**
 * JSONLens Structural JSON Diff View
 * Compares Left Editor JSON against Right Target JSON (or another open tab) semantically by JSONPath.
 */

import { escapeHtml, parseJsonSafe } from '../core/parser.js';
import { repairJson } from '../core/repair.js';
import { diffJsonValues } from '../core/diff.js';
import { DIFF_DEMO_RIGHT } from '../samples.js';

export class JsonDiffView {
  /**
   * @param {HTMLElement} container
   * @param {{ onCopy?: (text: string, label: string) => void, onNotify?: (msg: string) => void, getOtherTabs?: () => Array<{id:string, title:string, content:string}> }} callbacks
   */
  constructor(container, callbacks = {}) {
    this.container = container;
    this.onCopy = callbacks.onCopy || (() => {});
    this.onNotify = callbacks.onNotify || (() => {});
    this.getOtherTabs = callbacks.getOtherTabs || (() => []);

    this.leftData = undefined;
    this.ignoreArrayOrder = false;
    this.kindFilter = 'all'; // 'all' | 'added' | 'removed' | 'modified'
    this.editorCollapsed = false;

    this._renderShell();
    this.rightTextarea.value = DIFF_DEMO_RIGHT;
    this._bindEvents();
  }

  _renderShell() {
    this.container.innerHTML = `
      <div class="diff-target-box" data-role="target-box">
        <div class="diff-target-head">
          <div class="diff-target-title">
            <span class="diff-badge-right">对比目标 (右侧 JSON)</span>
            <span class="diff-status" data-role="right-status"></span>
          </div>
          <div class="diff-target-actions">
            <select class="select-sm" data-role="tab-picker" title="从其他打开的标签页载入对比数据">
              <option value="">从标签页导入…</option>
            </select>
            <button type="button" class="btn-xs" data-role="load-demo">示例对比</button>
            <button type="button" class="btn-xs" data-role="repair-right">智能修复</button>
            <button type="button" class="btn-xs" data-role="format-right">格式化</button>
            <button type="button" class="btn-xs" data-role="toggle-editor">收起输入 ▴</button>
          </div>
        </div>
        <textarea
          class="diff-textarea"
          data-role="right-textarea"
          spellcheck="false"
          placeholder="在此粘贴用于对比的目标 JSON（忽略对象键名排版顺序，按语义路径精准对比）..."
        ></textarea>
      </div>

      <div class="diff-summary-bar">
        <div class="diff-filter-pills" data-role="filter-pills">
          <button type="button" class="diff-pill is-active" data-kind="all">全部 <span data-count="all">0</span></button>
          <button type="button" class="diff-pill pill-added" data-kind="added">+ 新增 <span data-count="added">0</span></button>
          <button type="button" class="diff-pill pill-removed" data-kind="removed">− 删除 <span data-count="removed">0</span></button>
          <button type="button" class="diff-pill pill-modified" data-kind="modified">~ 修改 <span data-count="modified">0</span></button>
        </div>
        <label class="tree-filter-toggle">
          <input type="checkbox" data-role="ignore-order" />
          <span>忽略数组顺序</span>
        </label>
      </div>

      <div class="diff-results-scroll" data-role="diff-results"></div>
    `;

    this.targetBox = this.container.querySelector('[data-role="target-box"]');
    this.rightStatus = this.container.querySelector('[data-role="right-status"]');
    this.tabPicker = this.container.querySelector('[data-role="tab-picker"]');
    this.toggleEditorBtn = this.container.querySelector('[data-role="toggle-editor"]');
    this.rightTextarea = this.container.querySelector('[data-role="right-textarea"]');
    this.ignoreOrderCheckbox = this.container.querySelector('[data-role="ignore-order"]');
    this.resultsScroll = this.container.querySelector('[data-role="diff-results"]');
  }

  _bindEvents() {
    let timer = null;
    this.rightTextarea.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.render(), 100);
    });

    this.ignoreOrderCheckbox.addEventListener('change', () => {
      this.ignoreArrayOrder = this.ignoreOrderCheckbox.checked;
      this.render();
    });

    this.container.querySelector('[data-role="filter-pills"]').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-kind]');
      if (!btn) return;
      this.kindFilter = btn.getAttribute('data-kind');
      this.container.querySelectorAll('.diff-pill').forEach((b) => b.classList.toggle('is-active', b === btn));
      this.render();
    });

    this.container.querySelector('[data-role="format-right"]').addEventListener('click', () => {
      const p = parseJsonSafe(this.rightTextarea.value);
      if (p.ok && !p.empty) {
        this.rightTextarea.value = JSON.stringify(p.value, null, 2);
        this.render();
      } else {
        this.onNotify('右侧 JSON 存在语法错误，可先点击「智能修复」');
      }
    });

    this.container.querySelector('[data-role="repair-right"]').addEventListener('click', () => {
      const r = repairJson(this.rightTextarea.value);
      if (r.ok) {
        this.rightTextarea.value = r.output;
        this.render();
        this.onNotify('右侧目标 JSON 已修复并格式化');
      } else {
        this.onNotify('右侧 JSON 无法自动修复：' + (r.error || '语法错误'));
      }
    });

    this.container.querySelector('[data-role="load-demo"]').addEventListener('click', () => {
      this.rightTextarea.value = DIFF_DEMO_RIGHT;
      this.render();
      this.onNotify('已载入示例对比 JSON');
    });

    this.toggleEditorBtn.addEventListener('click', () => {
      this.editorCollapsed = !this.editorCollapsed;
      this.targetBox.classList.toggle('is-collapsed', this.editorCollapsed);
      this.toggleEditorBtn.textContent = this.editorCollapsed ? '展开输入 ▾' : '收起输入 ▴';
    });

    this.tabPicker.addEventListener('focus', () => this._refreshTabPicker());
    this.tabPicker.addEventListener('change', () => {
      const id = this.tabPicker.value;
      if (!id) return;
      const tabs = this.getOtherTabs();
      const hit = tabs.find((t) => t.id === id);
      if (hit) {
        this.rightTextarea.value = hit.content;
        this.render();
        this.onNotify(`已从标签页「${hit.title}」导入对比内容`);
      }
      this.tabPicker.value = '';
    });

    this.resultsScroll.addEventListener('click', (e) => {
      const pathEl = e.target.closest('[data-copy-path]');
      if (pathEl) {
        this.onCopy(pathEl.getAttribute('data-copy-path'), '变更路径');
      }
    });
  }

  _refreshTabPicker() {
    const tabs = this.getOtherTabs();
    this.tabPicker.innerHTML =
      `<option value="">从标签页导入…</option>` +
      tabs.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.title)}</option>`).join('');
  }

  setLeftData(value) {
    this.leftData = value;
    this._refreshTabPicker();
    this.render();
  }

  render() {
    if (this.leftData === undefined) {
      this.resultsScroll.innerHTML = `<div class="empty-view">左侧编辑器暂无有效 JSON 数据</div>`;
      return;
    }

    const rightParsed = parseJsonSafe(this.rightTextarea.value);
    if (rightParsed.empty) {
      this.rightStatus.textContent = '等待输入';
      this.rightStatus.className = 'diff-status';
      this.resultsScroll.innerHTML = `<div class="empty-view">请在上方输入框粘贴要对比的目标 JSON</div>`;
      return;
    }

    if (!rightParsed.ok) {
      this.rightStatus.textContent = `语法错误 (第 ${rightParsed.error.line} 行)`;
      this.rightStatus.className = 'diff-status is-err';
      this.resultsScroll.innerHTML = `
        <div class="jsonpath-banner is-error">
          <strong>右侧对比 JSON 解析失败：</strong> 第 ${rightParsed.error.line} 行，第 ${rightParsed.error.column} 列 — ${escapeHtml(rightParsed.error.reason)}
        </div>
      `;
      return;
    }

    this.rightStatus.textContent = '● 语法有效';
    this.rightStatus.className = 'diff-status is-ok';

    const diff = diffJsonValues(this.leftData, rightParsed.value, {
      ignoreArrayOrder: this.ignoreArrayOrder,
    });

    this.container.querySelector('[data-count="all"]').textContent = String(diff.changes.length);
    this.container.querySelector('[data-count="added"]').textContent = String(diff.summary.added);
    this.container.querySelector('[data-count="removed"]').textContent = String(diff.summary.removed);
    this.container.querySelector('[data-count="modified"]').textContent = String(diff.summary.modified);

    if (diff.identical) {
      this.resultsScroll.innerHTML = `
        <div class="diff-identical-card">
          <div class="diff-identical-icon">✓</div>
          <div>
            <strong>两份 JSON 在语义结构上完全一致</strong>
            <p>共核验 ${diff.summary.unchanged} 个节点路径，未发现任何键值差异（已自动忽略键排版顺序与缩进空白）。</p>
          </div>
        </div>
      `;
      return;
    }

    const filtered = diff.changes.filter((c) => {
      if (this.kindFilter === 'all') return true;
      if (this.kindFilter === 'modified') return c.kind === 'modified' || c.kind === 'type-changed';
      return c.kind === this.kindFilter;
    });

    const cardsHtml = filtered
      .slice(0, 400)
      .map((c) => {
        const kindLabel =
          c.kind === 'added'
            ? '+ 新增字段'
            : c.kind === 'removed'
            ? '− 删除字段'
            : c.kind === 'type-changed'
            ? `! 类型变更 (${c.leftType} → ${c.rightType})`
            : '~ 值已修改';
        const cls = c.kind === 'type-changed' ? 'modified' : c.kind;

        return `
          <div class="diff-card is-${cls}">
            <div class="diff-card-head">
              <span class="diff-kind-tag is-${cls}">${escapeHtml(kindLabel)}</span>
              <code class="diff-path" data-copy-path="${escapeHtml(c.jsonPath)}" title="点击复制 JSONPath">${escapeHtml(c.jsonPath)}</code>
            </div>
            <div class="diff-card-body">
              ${
                c.kind !== 'added'
                  ? `<div class="diff-line is-old"><span class="diff-sign">−</span><code>${escapeHtml(this._fmtVal(c.leftValue))}</code></div>`
                  : ''
              }
              ${
                c.kind !== 'removed'
                  ? `<div class="diff-line is-new"><span class="diff-sign">+</span><code>${escapeHtml(this._fmtVal(c.rightValue))}</code></div>`
                  : ''
              }
            </div>
          </div>
        `;
      })
      .join('');

    this.resultsScroll.innerHTML = `<div class="diff-list">${cardsHtml || '<div class="empty-view">当前筛选条件下无变更项</div>'}</div>`;
  }

  _fmtVal(v) {
    const str = JSON.stringify(v);
    return str && str.length > 260 ? str.slice(0, 260) + '…' : String(str);
  }
}
