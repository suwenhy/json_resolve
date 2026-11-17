/**
 * JSONLens High-Precision Code Editor Component
 * Pixel-locked textarea + syntax highlight layer + line gutter + error indicator + search jump
 */

import { highlightJson, escapeHtml, offsetToLineCol } from '../core/parser.js';

const MAX_HIGHLIGHT_CHARS = 260000;

export class JsonCodeEditor {
  /**
   * @param {HTMLElement} container
   * @param {{ onChange?: (val: string) => void, onCursorChange?: (pos: {line:number,column:number}) => void, onFormatShortcut?: () => void }} callbacks
   */
  constructor(container, callbacks = {}) {
    this.container = container;
    this.onChange = callbacks.onChange || (() => {});
    this.onCursorChange = callbacks.onCursorChange || (() => {});
    this.onFormatShortcut = callbacks.onFormatShortcut || (() => {});

    this.errorLine = null;
    this.activeLine = 1;
    this.lastLineCount = 0;
    this.fontSize = 13;
    this.lineHeight = 22;
    this.searchMatches = [];
    this.searchIdx = -1;
    this.caseSensitive = false;

    this._renderShell();
    this._bindEvents();
  }

  _renderShell() {
    this.container.innerHTML = `
      <div class="editor-find-bar hidden" data-role="find-bar">
        <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input type="text" class="editor-find-input" data-role="find-input" placeholder="查找内容 (Enter 下一个 / Shift+Enter 上一个)..." autocomplete="off" spellcheck="false" />
        <button type="button" class="icon-btn-xs find-opt-btn" data-role="find-case" title="区分大小写">Aa</button>
        <span class="editor-find-count" data-role="find-count">0 / 0</span>
        <button type="button" class="icon-btn-xs" data-role="find-prev" title="上一个匹配项 (Shift+Enter)">↑</button>
        <button type="button" class="icon-btn-xs" data-role="find-next" title="下一个匹配项 (Enter)">↓</button>
        <button type="button" class="icon-btn-xs" data-role="find-close" title="关闭 (Esc)">✕</button>
      </div>
      <div class="editor-body">
        <div class="editor-gutter" data-role="gutter" aria-hidden="true">
          <div class="editor-gutter-inner" data-role="gutter-inner"></div>
        </div>
        <div class="editor-stage" data-role="stage">
          <div class="editor-line-highlight" data-role="active-line"></div>
          <div class="editor-error-line" data-role="error-line"></div>
          <pre class="editor-backdrop" data-role="backdrop" aria-hidden="true"><code data-role="highlight-code"></code></pre>
          <textarea
            class="editor-textarea"
            data-role="textarea"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            autocorrect="off"
            wrap="off"
            aria-label="JSON 代码编辑器"
            placeholder="在此粘贴或输入 JSON / JS 对象 / 日志内容，或直接拖入 .json 文件..."
          ></textarea>
        </div>
      </div>
    `;

    this.findBar = this.container.querySelector('[data-role="find-bar"]');
    this.findInput = this.container.querySelector('[data-role="find-input"]');
    this.findCaseBtn = this.container.querySelector('[data-role="find-case"]');
    this.findCountEl = this.container.querySelector('[data-role="find-count"]');
    this.gutterInner = this.container.querySelector('[data-role="gutter-inner"]');
    this.activeLineEl = this.container.querySelector('[data-role="active-line"]');
    this.errorLineEl = this.container.querySelector('[data-role="error-line"]');
    this.backdrop = this.container.querySelector('[data-role="backdrop"]');
    this.highlightCode = this.container.querySelector('[data-role="highlight-code"]');
    this.textarea = this.container.querySelector('[data-role="textarea"]');
  }

  _bindEvents() {
    this.textarea.addEventListener('input', () => {
      this._syncHighlight();
      this._updateCursor();
      this.onChange(this.textarea.value);
      if (!this.findBar.classList.contains('hidden') && this.findInput.value) {
        this._computeSearch(false);
      }
    });

    this.textarea.addEventListener('scroll', () => {
      this._syncScroll();
    });

    const cursorEvents = ['keyup', 'click', 'mouseup', 'select'];
    for (const evt of cursorEvents) {
      this.textarea.addEventListener(evt, () => this._updateCursor());
    }

    this.textarea.addEventListener('keydown', (e) => this._handleKeyDown(e));

    // Find bar controls
    this.findInput.addEventListener('input', () => this._computeSearch(true));
    this.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'F3') {
        e.preventDefault();
        this.stepSearch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeFind();
      }
    });

    this.findCaseBtn.addEventListener('click', () => {
      this.caseSensitive = !this.caseSensitive;
      this.findCaseBtn.classList.toggle('is-active', this.caseSensitive);
      this._computeSearch(true);
    });

    this.container.querySelector('[data-role="find-prev"]').addEventListener('click', () => this.stepSearch(-1));
    this.container.querySelector('[data-role="find-next"]').addEventListener('click', () => this.stepSearch(1));
    this.container.querySelector('[data-role="find-close"]').addEventListener('click', () => this.closeFind());
  }

  _handleKeyDown(e) {
    // Cmd/Ctrl + F => open in-editor search
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      this.openFind();
      return;
    }

    // F3 / Shift+F3 => step search
    if (e.key === 'F3' && !this.findBar.classList.contains('hidden')) {
      e.preventDefault();
      this.stepSearch(e.shiftKey ? -1 : 1);
      return;
    }

    // Cmd/Ctrl + Enter or Shift+Alt+F => format shortcut
    if (((e.metaKey || e.ctrlKey) && e.key === 'Enter') || (e.shiftKey && e.altKey && e.key.toLowerCase() === 'f')) {
      e.preventDefault();
      this.onFormatShortcut();
      return;
    }

    const ta = this.textarea;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value;

    // Tab / Shift+Tab indentation
    if (e.key === 'Tab') {
      e.preventDefault();
      if (start === end && !e.shiftKey) {
        this._replaceRange(start, end, '  ', start + 2);
      } else {
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        const block = val.slice(lineStart, end);
        const lines = block.split('\n');
        const transformed = e.shiftKey
          ? lines.map((l) => l.replace(/^ {1,2}|\t/, ''))
          : lines.map((l) => '  ' + l);
        const joined = transformed.join('\n');
        this._replaceRange(lineStart, end, joined, lineStart, lineStart + joined.length);
      }
      return;
    }

    // Smart Enter indentation
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      const currentLine = val.slice(lineStart, start);
      const indentMatch = currentLine.match(/^[ \t]*/);
      const indent = indentMatch ? indentMatch[0] : '';
      const prevChar = val[start - 1];
      const nextChar = val[end];

      if ((prevChar === '{' && nextChar === '}') || (prevChar === '[' && nextChar === ']')) {
        e.preventDefault();
        const ins = `\n${indent}  \n${indent}`;
        const cursor = start + 1 + indent.length + 2;
        this._replaceRange(start, end, ins, cursor);
        return;
      }
      if (prevChar === '{' || prevChar === '[') {
        e.preventDefault();
        const ins = `\n${indent}  `;
        this._replaceRange(start, end, ins, start + ins.length);
        return;
      }
      if (indent.length > 0) {
        e.preventDefault();
        const ins = `\n${indent}`;
        this._replaceRange(start, end, ins, start + ins.length);
      }
    }
  }

  _replaceRange(start, end, text, selStart, selEnd = selStart) {
    const val = this.textarea.value;
    this.textarea.value = val.slice(0, start) + text + val.slice(end);
    this.textarea.setSelectionRange(selStart, selEnd);
    this._syncHighlight();
    this._updateCursor();
    this.onChange(this.textarea.value);
  }

  openFind() {
    this.findBar.classList.remove('hidden');
    const selected = this.textarea.value.slice(this.textarea.selectionStart, this.textarea.selectionEnd);
    if (selected && !selected.includes('\n')) {
      this.findInput.value = selected;
    }
    this.findInput.focus();
    this.findInput.select();
    this._computeSearch(true);
  }

  closeFind() {
    this.findBar.classList.add('hidden');
    this.searchMatches = [];
    this.searchIdx = -1;
    this._syncHighlight();
    this.textarea.focus();
  }

  _computeSearch(jumpFirst = false) {
    const q = this.findInput.value;
    this.searchMatches = [];
    this.searchIdx = -1;
    if (!q) {
      this.findCountEl.textContent = '0 / 0';
      this._syncHighlight();
      return;
    }
    const raw = this.textarea.value;
    const hay = this.caseSensitive ? raw : raw.toLowerCase();
    const needle = this.caseSensitive ? q : q.toLowerCase();
    let idx = 0;
    while (idx <= hay.length - needle.length) {
      const found = hay.indexOf(needle, idx);
      if (found === -1) break;
      this.searchMatches.push({ start: found, end: found + needle.length });
      idx = found + Math.max(1, needle.length);
      if (this.searchMatches.length >= 2000) break;
    }

    if (this.searchMatches.length === 0) {
      this.findCountEl.textContent = '无匹配';
      this._syncHighlight();
      return;
    }
    this.searchIdx = 0;
    this.findCountEl.textContent = `1 / ${this.searchMatches.length}`;
    this._syncHighlight();
    if (jumpFirst) this._revealMatch(this.searchMatches[0], false);
  }

  stepSearch(delta) {
    if (this.searchMatches.length === 0) return;
    this.searchIdx = (this.searchIdx + delta + this.searchMatches.length) % this.searchMatches.length;
    this.findCountEl.textContent = `${this.searchIdx + 1} / ${this.searchMatches.length}`;
    this._syncHighlight();
    this._revealMatch(this.searchMatches[this.searchIdx], false);
  }

  _revealMatch(match, focusTextarea = true) {
    if (focusTextarea) this.textarea.focus();
    this.textarea.setSelectionRange(match.start, match.end);
    const loc = offsetToLineCol(this.textarea.value, match.start);

    // Center matched line vertically in viewport
    const ta = this.textarea;
    const padTop = 12;
    const lineTop = padTop + (loc.line - 1) * this.lineHeight;
    const targetTop = Math.max(0, lineTop - Math.max(0, ta.clientHeight / 2 - this.lineHeight / 2));
    ta.scrollTop = targetTop;

    // Ensure matched column is visible horizontally (important for minified / long lines)
    const charW = this.fontSize * 0.602;
    const targetX = Math.max(0, (loc.column - 1) * charW);
    const viewW = ta.clientWidth - 48;
    if (targetX < ta.scrollLeft + 24 || targetX > ta.scrollLeft + viewW) {
      ta.scrollLeft = Math.max(0, targetX - viewW / 2);
    }

    this._syncScroll();
    this._updateCursor();
  }

  setFontSize(fontSize, lineHeight) {
    this.fontSize = fontSize;
    this.lineHeight = lineHeight;
    this._renderLineBars();
  }

  getValue() {
    return this.textarea.value;
  }

  setValue(text, silent = false) {
    this.textarea.value = text ?? '';
    this._syncHighlight();
    this._updateCursor();
    this._syncScroll();
    if (!silent) {
      this.onChange(this.textarea.value);
    }
  }

  setErrorLine(lineNumber) {
    this.errorLine = lineNumber;
    this._renderLineBars();
    this._updateGutterMarkers();
  }

  scrollToLine(lineNumber, focus = true) {
    const lineHeight = this.lineHeight;
    const targetTop = Math.max(0, (lineNumber - 4) * lineHeight);
    this.textarea.scrollTop = targetTop;
    this._syncScroll();
    if (focus) {
      const lines = this.textarea.value.split('\n');
      let offset = 0;
      for (let i = 0; i < Math.min(lineNumber - 1, lines.length); i++) {
        offset += lines[i].length + 1;
      }
      this.textarea.focus();
      this.textarea.setSelectionRange(offset, offset);
      this._updateCursor();
    }
  }

  _syncScroll() {
    const top = this.textarea.scrollTop;
    const left = this.textarea.scrollLeft;
    this.backdrop.style.transform = `translate(${-left}px, ${-top}px)`;
    this.gutterInner.style.transform = `translateY(${-top}px)`;
    this._renderLineBars();
  }

  _updateCursor() {
    const pos = offsetToLineCol(this.textarea.value, this.textarea.selectionStart || 0);
    if (this.activeLine !== pos.line) {
      this.activeLine = pos.line;
      this._renderLineBars();
      this._updateGutterMarkers();
    }
    this.onCursorChange(pos);
  }

  _renderLineBars() {
    const lineHeight = this.lineHeight;
    const padTop = 12;
    const scrollTop = this.textarea.scrollTop;

    const activeTop = padTop + (this.activeLine - 1) * lineHeight - scrollTop;
    this.activeLineEl.style.transform = `translateY(${activeTop}px)`;

    if (this.errorLine && this.errorLine >= 1) {
      const errTop = padTop + (this.errorLine - 1) * lineHeight - scrollTop;
      this.errorLineEl.style.display = 'block';
      this.errorLineEl.style.transform = `translateY(${errTop}px)`;
    } else {
      this.errorLineEl.style.display = 'none';
    }
  }

  _syncHighlight() {
    const val = this.textarea.value;
    // Trailing newline space guarantees last empty line scrolls identically to textarea
    const displayVal = val.endsWith('\n') ? val + ' ' : val;

    let html = val.length > MAX_HIGHLIGHT_CHARS ? escapeHtml(displayVal) : highlightJson(displayVal);
    if (this.searchMatches.length > 0 && !this.findBar.classList.contains('hidden')) {
      html = this._injectSearchMarks(html, this.searchMatches, this.searchIdx);
    }
    this.highlightCode.innerHTML = html;

    const lineCount = val ? val.split('\n').length : 1;
    if (lineCount !== this.lastLineCount) {
      this.lastLineCount = lineCount;
      // Cap rendered line numbers at 15,000 for huge multi-MB files
      const maxGutter = Math.min(lineCount, 15000);
      const nums = new Array(maxGutter);
      for (let i = 1; i <= maxGutter; i++) {
        nums[i - 1] = `<div class="gutter-ln" data-ln="${i}">${i}</div>`;
      }
      this.gutterInner.innerHTML = nums.join('');
      this._updateGutterMarkers();
    }
    this._renderLineBars();
  }

  _injectSearchMarks(html, matches, activeIdx) {
    let out = '';
    let mIdx = 0;
    let curMatch = matches[0];
    let inMark = false;
    let plainPos = 0;
    let i = 0;
    const len = html.length;

    const openTag = (idx) => `<mark class="editor-find-hit${idx === activeIdx ? ' is-current' : ''}">`;

    while (i < len) {
      if (html[i] === '<') {
        const closeBracket = html.indexOf('>', i);
        if (closeBracket !== -1) {
          if (inMark) out += '</mark>';
          out += html.slice(i, closeBracket + 1);
          if (inMark) out += openTag(mIdx);
          i = closeBracket + 1;
          continue;
        }
      }

      if (curMatch && plainPos === curMatch.start && !inMark) {
        out += openTag(mIdx);
        inMark = true;
      }

      let tokenStr;
      if (html[i] === '&') {
        const semi = html.indexOf(';', i);
        if (semi !== -1 && semi - i <= 6) {
          tokenStr = html.slice(i, semi + 1);
          i = semi + 1;
        } else {
          tokenStr = html[i++];
        }
      } else {
        tokenStr = html[i++];
      }

      out += tokenStr;
      plainPos++;

      if (inMark && curMatch && plainPos >= curMatch.end) {
        out += '</mark>';
        inMark = false;
        mIdx++;
        curMatch = mIdx < matches.length ? matches[mIdx] : null;
      }
    }

    if (inMark) out += '</mark>';
    return out;
  }

  _updateGutterMarkers() {
    const prevActive = this.gutterInner.querySelector('.gutter-ln.is-active');
    if (prevActive) prevActive.classList.remove('is-active');
    const prevErr = this.gutterInner.querySelector('.gutter-ln.is-error');
    if (prevErr) prevErr.classList.remove('is-error');

    const curEl = this.gutterInner.querySelector(`.gutter-ln[data-ln="${this.activeLine}"]`);
    if (curEl) curEl.classList.add('is-active');

    if (this.errorLine) {
      const errEl = this.gutterInner.querySelector(`.gutter-ln[data-ln="${this.errorLine}"]`);
      if (errEl) errEl.classList.add('is-error');
    }
  }
}
