/**
 * JSONLens Code & Format Generator View
 * Converts JSON to TypeScript, Go, Python (Pydantic), Java, Rust (Serde), JSON Schema, YAML, XML
 */

import { escapeHtml, highlightJson } from '../core/parser.js';
import {
  generateTypeScript,
  generateGo,
  generatePython,
  generateJava,
  generateRust,
  generateJsonSchema,
  jsonToYaml,
  jsonToXml,
} from '../core/codegen.js';

const TARGETS = [
  { id: 'ts', label: 'TypeScript', ext: 'ts' },
  { id: 'go', label: 'Go Struct', ext: 'go' },
  { id: 'python', label: 'Python Pydantic', ext: 'py' },
  { id: 'java', label: 'Java Lombok', ext: 'java' },
  { id: 'rust', label: 'Rust Serde', ext: 'rs' },
  { id: 'schema', label: 'JSON Schema', ext: 'schema.json' },
  { id: 'yaml', label: 'YAML', ext: 'yaml' },
  { id: 'xml', label: 'XML', ext: 'xml' },
];

export class JsonCodegenView {
  /**
   * @param {HTMLElement} container
   * @param {{ onCopy?: (text: string, label: string) => void, onNotify?: (msg: string) => void }} callbacks
   */
  constructor(container, callbacks = {}) {
    this.container = container;
    this.onCopy = callbacks.onCopy || (() => {});
    this.onNotify = callbacks.onNotify || (() => {});

    this.data = undefined;
    this.activeTarget = 'ts';
    this.rootTypeName = 'RootResponse';
    this.currentOutput = '';

    this._renderShell();
    this._bindEvents();
  }

  _renderShell() {
    const tabsHtml = TARGETS.map(
      (t) =>
        `<button type="button" class="lang-pill ${t.id === this.activeTarget ? 'is-active' : ''}" data-lang="${t.id}">${t.label}</button>`
    ).join('');

    this.container.innerHTML = `
      <div class="codegen-toolbar">
        <div class="lang-pills" data-role="lang-pills">${tabsHtml}</div>
        <div class="codegen-actions">
          <label class="toolbar-inline-label" title="根类型或根节点名称">根名称：</label>
          <input type="text" class="root-name-input" data-role="root-name" value="RootResponse" spellcheck="false" />
          <button type="button" class="btn-xs" data-role="download-code">下载文件</button>
          <button type="button" class="btn-xs btn-primary-xs" data-role="copy-code">复制代码</button>
        </div>
      </div>
      <div class="codegen-scroll">
        <pre class="codegen-pre"><code data-role="code-out"></code></pre>
      </div>
    `;

    this.rootNameInput = this.container.querySelector('[data-role="root-name"]');
    this.codeOut = this.container.querySelector('[data-role="code-out"]');
  }

  _bindEvents() {
    this.container.querySelector('[data-role="lang-pills"]').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-lang]');
      if (!btn) return;
      this.activeTarget = btn.getAttribute('data-lang');
      this.container.querySelectorAll('.lang-pill').forEach((b) => b.classList.toggle('is-active', b === btn));
      this.render();
    });

    this.rootNameInput.addEventListener('input', () => {
      this.rootTypeName = this.rootNameInput.value.trim() || 'RootObject';
      this.render();
    });

    this.container.querySelector('[data-role="copy-code"]').addEventListener('click', () => {
      if (!this.currentOutput) return;
      const meta = TARGETS.find((t) => t.id === this.activeTarget);
      this.onCopy(this.currentOutput, meta ? meta.label : '生成代码');
    });

    this.container.querySelector('[data-role="download-code"]').addEventListener('click', () => {
      if (!this.currentOutput) return;
      const meta = TARGETS.find((t) => t.id === this.activeTarget) || TARGETS[0];
      const blob = new Blob([this.currentOutput], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.rootTypeName || 'model'}.${meta.ext}`;
      a.click();
      URL.revokeObjectURL(url);
      this.onNotify(`已下载 ${meta.label} 文件`);
    });
  }

  setData(value) {
    this.data = value;
    this.render();
  }

  render() {
    if (this.data === undefined) {
      this.currentOutput = '';
      this.codeOut.innerHTML = `<span class="tok-comment">// 请在左侧输入有效 JSON 数据以自动推导类型定义与数据格式</span>`;
      return;
    }

    const name = this.rootTypeName || 'RootObject';
    switch (this.activeTarget) {
      case 'ts':
        this.currentOutput = generateTypeScript(this.data, name);
        break;
      case 'go':
        this.currentOutput = generateGo(this.data, name);
        break;
      case 'python':
        this.currentOutput = generatePython(this.data, name);
        break;
      case 'java':
        this.currentOutput = generateJava(this.data, name);
        break;
      case 'rust':
        this.currentOutput = generateRust(this.data, name);
        break;
      case 'schema':
        this.currentOutput = generateJsonSchema(this.data, name);
        break;
      case 'yaml':
        this.currentOutput = jsonToYaml(this.data);
        break;
      case 'xml':
        this.currentOutput = jsonToXml(this.data, name);
        break;
      default:
        this.currentOutput = '';
    }

    if (this.activeTarget === 'schema') {
      this.codeOut.innerHTML = highlightJson(this.currentOutput);
    } else {
      this.codeOut.innerHTML = this._highlightCode(this.currentOutput, this.activeTarget);
    }
  }

  _highlightCode(code, lang) {
    if (lang === 'yaml') {
      return code
        .split('\n')
        .map((line) => {
          const m = line.match(/^(\s*-?\s*)([^:#]+)(:)(.*)$/);
          if (m) {
            return `${escapeHtml(m[1])}<span class="tok-key">${escapeHtml(m[2])}</span><span class="tok-punct">:</span><span class="tok-str">${escapeHtml(m[4])}</span>`;
          }
          return escapeHtml(line);
        })
        .join('\n');
    }

    if (lang === 'xml') {
      return escapeHtml(code)
        .replace(/(&lt;\/?[A-Za-z0-9_.:-]+)/g, '<span class="tok-key">$1</span>')
        .replace(/(\/?&gt;)/g, '<span class="tok-key">$1</span>');
    }

    // Lightweight keyword highlighting for TS / Go / Python / Java / Rust
    const kwRegex =
      /\b(export|interface|type|package|struct|class|public|private|static|import|from|def|pass|use|pub|fn|let|boolean|string|number|int64|float64|bool|int|float|str|long|double|Long|Double|Boolean|String|List|Vec|Option|Any|None|null|unknown)\b/g;

    const tokenRe = /("(?:\\.|[^"\\])*"|`[^`]*`)|(#[a-zA-Z_\[].*|@[A-Za-z]+)|(\b(?:export|interface|type|package|struct|class|public|private|static|import|from|def|pass|use|pub|boolean|string|number|int64|float64|bool|int|float|str|long|double|Long|Double|Boolean|String|List|Vec|Option|Any|None|null|unknown)\b)/g;

    let res = '';
    let last = 0;
    let m;
    while ((m = tokenRe.exec(code)) !== null) {
      if (m.index > last) res += escapeHtml(code.slice(last, m.index));
      if (m[1]) res += `<span class="tok-str">${escapeHtml(m[1])}</span>`;
      else if (m[2]) res += `<span class="tok-bool">${escapeHtml(m[2])}</span>`;
      else if (m[3]) res += `<span class="tok-key">${escapeHtml(m[3])}</span>`;
      last = tokenRe.lastIndex;
    }
    if (last < code.length) res += escapeHtml(code.slice(last));
    return res;
  }
}
