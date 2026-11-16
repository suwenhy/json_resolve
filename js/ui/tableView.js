/**
 * JSONLens Smart Data Table View
 * Auto-discovers nested arrays inside API responses, supports sorting, filtering, Excel-friendly CSV & Markdown export.
 */

import { escapeHtml } from '../core/parser.js';
import {
  discoverTableDatasets,
  extractTableModel,
  tableToCsv,
  tableToMarkdown,
} from '../core/codegen.js';

export class JsonTableView {
  /**
   * @param {HTMLElement} container
   * @param {{ onCopy?: (text: string, label: string) => void, onNotify?: (msg: string) => void }} callbacks
   */
  constructor(container, callbacks = {}) {
    this.container = container;
    this.onCopy = callbacks.onCopy || (() => {});
    this.onNotify = callbacks.onNotify || (() => {});

    this.datasets = [];
    this.activeDatasetIdx = 0;
    this.sortCol = null;
    this.sortDir = 'asc';
    this.filterText = '';

    this._renderShell();
    this._bindEvents();
  }

  _renderShell() {
    this.container.innerHTML = `
      <div class="table-toolbar">
        <div class="table-left-controls">
          <label class="toolbar-inline-label">数据源：</label>
          <select class="select-sm" data-role="dataset-select" aria-label="选择数组路径"></select>
          <input
            type="text"
            class="table-filter-input"
            data-role="table-filter"
            placeholder="过滤表格行..."
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="btn-group-xs">
          <button type="button" class="btn-xs" data-role="copy-md" title="复制为 GitHub Markdown 表格">复制 Markdown</button>
          <button type="button" class="btn-xs btn-primary-xs" data-role="export-csv" title="下载兼容 Excel 的 UTF-8 CSV">导出 CSV</button>
        </div>
      </div>
      <div class="table-scroll" data-role="table-scroll"></div>
    `;

    this.datasetSelect = this.container.querySelector('[data-role="dataset-select"]');
    this.filterInput = this.container.querySelector('[data-role="table-filter"]');
    this.tableScroll = this.container.querySelector('[data-role="table-scroll"]');
  }

  _bindEvents() {
    this.datasetSelect.addEventListener('change', () => {
      this.activeDatasetIdx = parseInt(this.datasetSelect.value, 10) || 0;
      this.sortCol = null;
      this.renderTable();
    });

    this.filterInput.addEventListener('input', () => {
      this.filterText = this.filterInput.value.trim().toLowerCase();
      this.renderTable();
    });

    this.tableScroll.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-col]');
      if (th) {
        const col = th.getAttribute('data-col');
        if (this.sortCol === col) {
          if (this.sortDir === 'asc') this.sortDir = 'desc';
          else {
            this.sortCol = null;
            this.sortDir = 'asc';
          }
        } else {
          this.sortCol = col;
          this.sortDir = 'asc';
        }
        this.renderTable();
      }
    });

    this.container.querySelector('[data-role="copy-md"]').addEventListener('click', () => {
      const { columns, records } = this._getProcessedModel();
      if (columns.length === 0) return;
      this.onCopy(tableToMarkdown(columns, records), 'Markdown 表格');
    });

    this.container.querySelector('[data-role="export-csv"]').addEventListener('click', () => {
      const { columns, records } = this._getProcessedModel();
      if (columns.length === 0) return;
      // Prepend UTF-8 BOM (\uFEFF) so Microsoft Excel opens Chinese characters cleanly!
      const csv = '\uFEFF' + tableToCsv(columns, records);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `jsonlens-table-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      this.onNotify('已导出 CSV 表格文件');
    });
  }

  setData(value) {
    if (value === undefined) {
      this.datasets = [];
      this.datasetSelect.innerHTML = '';
      this.tableScroll.innerHTML = `<div class="empty-view">暂无有效 JSON 数据</div>`;
      return;
    }

    this.datasets = discoverTableDatasets(value);
    if (this.activeDatasetIdx >= this.datasets.length) {
      this.activeDatasetIdx = 0;
    }

    this.datasetSelect.innerHTML = this.datasets
      .map(
        (ds, i) =>
          `<option value="${i}" ${i === this.activeDatasetIdx ? 'selected' : ''}>${escapeHtml(ds.path)} (${ds.rowCount} 行)</option>`
      )
      .join('');

    this.renderTable();
  }

  _getProcessedModel() {
    const ds = this.datasets[this.activeDatasetIdx];
    if (!ds) return { columns: [], records: [] };

    let { columns, records } = extractTableModel(ds.rows);

    if (this.filterText) {
      records = records.filter((row) =>
        columns.some((col) => {
          const v = row[col];
          if (v === undefined) return false;
          const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
          return str.toLowerCase().includes(this.filterText);
        })
      );
    }

    if (this.sortCol && columns.includes(this.sortCol)) {
      const col = this.sortCol;
      const mul = this.sortDir === 'asc' ? 1 : -1;
      records = records.slice().sort((a, b) => {
        const va = a[col];
        const vb = b[col];
        if (va === vb) return 0;
        if (va === undefined || va === null) return 1;
        if (vb === undefined || vb === null) return -1;
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
        return String(va).localeCompare(String(vb)) * mul;
      });
    }

    return { columns, records };
  }

  renderTable() {
    if (this.datasets.length === 0) {
      this.tableScroll.innerHTML = `<div class="empty-view">当前 JSON 不包含可表格化的数组或对象属性</div>`;
      return;
    }

    const { columns, records } = this._getProcessedModel();
    if (columns.length === 0) {
      this.tableScroll.innerHTML = `<div class="empty-view">所选数组为空</div>`;
      return;
    }

    const ths = columns
      .map((c) => {
        const arrow = this.sortCol === c ? (this.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
        return `<th data-col="${escapeHtml(c)}"><span>${escapeHtml(c)}</span><em class="sort-ind">${arrow}</em></th>`;
      })
      .join('');

    const displayRecords = records.slice(0, 500);
    const trs = displayRecords
      .map((row, idx) => {
        const tds = columns.map((col) => `<td>${this._formatCell(row[col])}</td>`).join('');
        return `<tr><td class="td-rownum">${idx + 1}</td>${tds}</tr>`;
      })
      .join('');

    const capNote =
      records.length > 500
        ? `<div class="table-foot-note">仅渲染前 500 行（共 ${records.length} 行），点击「导出 CSV」可导出全部数据</div>`
        : '';

    this.tableScroll.innerHTML = `
      <table class="data-table">
        <thead>
          <tr><th class="th-rownum">#</th>${ths}</tr>
        </thead>
        <tbody>${trs || `<tr><td colspan="${columns.length + 1}" class="td-empty">无匹配记录</td></tr>`}</tbody>
      </table>
      ${capNote}
    `;
  }

  _formatCell(val) {
    if (val === undefined) return `<span class="cell-undef">—</span>`;
    if (val === null) return `<span class="tok-null">null</span>`;
    if (typeof val === 'boolean') {
      return `<span class="cell-bool ${val ? 'is-true' : 'is-false'}">${val}</span>`;
    }
    if (typeof val === 'number') {
      return `<span class="tok-num">${val}</span>`;
    }
    if (typeof val === 'object') {
      const compact = JSON.stringify(val);
      const short = compact.length > 72 ? compact.slice(0, 72) + '…' : compact;
      return `<code class="cell-json" title="${escapeHtml(compact)}">${escapeHtml(short)}</code>`;
    }
    const str = String(val);
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(str.trim())) {
      return `<span class="color-swatch-inline" style="background:${escapeHtml(str.trim())}"></span> <code>${escapeHtml(str)}</code>`;
    }
    return escapeHtml(str);
  }
}
