/**
 * JSONLens Core Parser, Cross-Browser Error Diagnostics & Stats Engine
 */

/**
 * Compute line and column (1-based) from character offset.
 * @param {string} text
 * @param {number} offset
 */
export function offsetToLineCol(text, offset) {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNewline = i;
    }
  }
  return {
    line,
    column: clamped - lastNewline,
    offset: clamped,
  };
}

/**
 * Deterministic RFC 8259 scanner used only when native JSON.parse fails,
 * ensuring consistent exact line/column & actionable Chinese hints across Chrome, Safari, and Firefox.
 * @param {string} text
 */
export function diagnoseJsonError(text) {
  const len = text.length;
  let i = 0;

  const fail = (offset, reason, repairable = false) => {
    const loc = offsetToLineCol(text, offset);
    const lines = text.split('\n');
    const errorLineText = lines[loc.line - 1] ?? '';
    return {
      ...loc,
      reason,
      repairable,
      lineText: errorLineText,
    };
  };

  const skipWhitespace = () => {
    while (i < len) {
      const ch = text.charCodeAt(i);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
        i++;
      } else if (ch === 47 && (text[i + 1] === '/' || text[i + 1] === '*')) {
        return fail(i, '标准 JSON 不支持注释（// 或 /* */），点击「智能修复」可自动移除注释', true);
      } else {
        break;
      }
    }
    return null;
  };

  const parseString = () => {
    const start = i;
    i++; // skip '"'
    while (i < len) {
      const code = text.charCodeAt(i);
      if (code === 34) {
        i++;
        return null;
      }
      if (code === 92) {
        i++;
        if (i >= len) return fail(i, '字符串末尾存在未完成的转义符 "\\"', false);
        const esc = text[i];
        if ('"\\/bfnrt'.includes(esc)) {
          i++;
        } else if (esc === 'u') {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            return fail(i - 1, `无效的 Unicode 转义序列 "\\u${hex}"`, false);
          }
          i += 5;
        } else {
          return fail(i - 1, `无效的转义字符 "\\${esc}"，可使用「智能修复」处理`, true);
        }
        continue;
      }
      if (code < 0x20) {
        if (code === 10 || code === 13) {
          return fail(i, '字符串未闭合或包含原始换行符（需转义为 \\n）', true);
        }
        return fail(i, `字符串中包含未转义的控制字符 (0x${code.toString(16)})`, true);
      }
      i++;
    }
    return fail(start, '字符串缺少闭合双引号 """', true);
  };

  const parseNumber = () => {
    if (text[i] === '-') i++;
    if (i >= len) return fail(i, '数字格式不完整', false);
    if (text[i] === '0') {
      i++;
      if (i < len && /[0-9]/.test(text[i])) {
        return fail(i, 'JSON 数字不允许前导零（如 01）', false);
      }
    } else if (/[1-9]/.test(text[i])) {
      while (i < len && /[0-9]/.test(text[i])) i++;
    } else {
      return fail(i, `无效的数字字符 "${text[i]}"`, false);
    }

    if (text[i] === '.') {
      i++;
      if (i >= len || !/[0-9]/.test(text[i])) {
        return fail(i, '小数点后必须紧跟数字', true);
      }
      while (i < len && /[0-9]/.test(text[i])) i++;
    }

    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (i >= len || !/[0-9]/.test(text[i])) {
        return fail(i, '科学计数法指数部分缺少数字', false);
      }
      while (i < len && /[0-9]/.test(text[i])) i++;
    }
    return null;
  };

  const parseValue = (depth) => {
    if (depth > 512) return fail(i, 'JSON 嵌套层级过深', false);
    const wsErr = skipWhitespace();
    if (wsErr) return wsErr;
    if (i >= len) return fail(i, 'JSON 内容意外结束，缺少对应的值', false);

    const ch = text[i];

    if (ch === '{') {
      const openPos = i;
      i++;
      let ws = skipWhitespace();
      if (ws) return ws;
      if (i >= len) return fail(openPos, '对象 "{" 未闭合，缺少 "}"', true);
      if (text[i] === '}') {
        i++;
        return null;
      }
      while (i < len) {
        ws = skipWhitespace();
        if (ws) return ws;
        if (i >= len) return fail(openPos, '对象 "{" 未闭合，缺少 "}"', true);

        if (text[i] === '}') {
          return fail(i, '对象末尾存在多余的尾随逗号 (Trailing comma)，可点击「智能修复」一键清除', true);
        }
        if (text[i] === "'") {
          return fail(i, '标准 JSON 键名必须使用双引号而非单引号，可点击「智能修复」自动转换', true);
        }
        if (text[i] !== '"') {
          if (/[a-zA-Z_$0-9]/.test(text[i])) {
            return fail(i, '对象键名缺少双引号包裹（疑似 JS 对象字面量），可点击「智能修复」自动补全', true);
          }
          return fail(i, `期望对象键名（双引号字符串），但遇到了 "${text[i]}"`, false);
        }

        const keyErr = parseString();
        if (keyErr) return keyErr;

        ws = skipWhitespace();
        if (ws) return ws;
        if (text[i] !== ':') {
          return fail(i, `对象键名后缺少冒号 ":"${text[i] ? `（遇到了 "${text[i]}"）` : ''}`, false);
        }
        i++; // skip ':'

        const valErr = parseValue(depth + 1);
        if (valErr) return valErr;

        ws = skipWhitespace();
        if (ws) return ws;
        if (text[i] === ',') {
          const commaPos = i;
          i++;
          ws = skipWhitespace();
          if (ws) return ws;
          if (text[i] === '}') {
            return fail(commaPos, '存在多余的尾随逗号 (Trailing comma)，可点击「智能修复」一键清除', true);
          }
          continue;
        }
        if (text[i] === '}') {
          i++;
          return null;
        }
        if (i >= len) {
          return fail(openPos, '对象 "{" 未闭合，缺少 "}"', true);
        }
        return fail(i, `对象属性之间缺少逗号 "," 或闭合花括号 "}"（遇到了 "${text[i]}"）`, true);
      }
      return fail(openPos, '对象 "{" 未闭合，缺少 "}"', true);
    }

    if (ch === '[') {
      const openPos = i;
      i++;
      let ws = skipWhitespace();
      if (ws) return ws;
      if (i >= len) return fail(openPos, '数组 "[" 未闭合，缺少 "]"', true);
      if (text[i] === ']') {
        i++;
        return null;
      }
      while (i < len) {
        ws = skipWhitespace();
        if (ws) return ws;
        if (text[i] === ']') {
          return fail(i, '数组末尾存在多余的尾随逗号 (Trailing comma)，可点击「智能修复」一键清除', true);
        }
        const elemErr = parseValue(depth + 1);
        if (elemErr) return elemErr;

        ws = skipWhitespace();
        if (ws) return ws;
        if (text[i] === ',') {
          const commaPos = i;
          i++;
          ws = skipWhitespace();
          if (ws) return ws;
          if (text[i] === ']') {
            return fail(commaPos, '数组末尾存在多余的尾随逗号 (Trailing comma)，可点击「智能修复」一键清除', true);
          }
          continue;
        }
        if (text[i] === ']') {
          i++;
          return null;
        }
        if (i >= len) {
          return fail(openPos, '数组 "[" 未闭合，缺少 "]"', true);
        }
        return fail(i, `数组元素之间缺少逗号 "," 或闭合方括号 "]"（遇到了 "${text[i]}"）`, true);
      }
      return fail(openPos, '数组 "[" 未闭合，缺少 "]"', true);
    }

    if (ch === '"') {
      return parseString();
    }

    if (ch === "'") {
      return fail(i, '标准 JSON 字符串必须使用双引号而非单引号，可点击「智能修复」自动转换', true);
    }

    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      return parseNumber();
    }

    if (ch === '+') {
      return fail(i, 'JSON 数字不支持正号 "+" 前缀，可点击「智能修复」处理', true);
    }

    if (text.startsWith('true', i) && !/[a-zA-Z0-9_]/.test(text[i + 4] || '')) {
      i += 4;
      return null;
    }
    if (text.startsWith('false', i) && !/[a-zA-Z0-9_]/.test(text[i + 5] || '')) {
      i += 5;
      return null;
    }
    if (text.startsWith('null', i) && !/[a-zA-Z0-9_]/.test(text[i + 4] || '')) {
      i += 4;
      return null;
    }

    // Common Python / JS literals
    const wordMatch = text.slice(i, i + 16).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (wordMatch) {
      const word = wordMatch[0];
      if (['True', 'False', 'None'].includes(word)) {
        return fail(i, `检测到 Python 字面量 "${word}"，标准 JSON 需使用 ${word === 'None' ? 'null' : word.toLowerCase()}，可点击「智能修复」转换`, true);
      }
      if (['undefined', 'NaN', 'Infinity'].includes(word)) {
        return fail(i, `检测到 JavaScript 字面量 "${word}"，标准 JSON 不支持，可点击「智能修复」转换为 null`, true);
      }
      if (text.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$.]*\s*\(/)) {
        return fail(i, `检测到 JSONP 函数包裹 "${word}(...)"，可点击「智能修复」提取核心 JSON`, true);
      }
      return fail(i, `未加双引号的标识符 "${word}"`, true);
    }

    return fail(i, `无法识别的字符 "${ch}"`, false);
  };

  const initWs = skipWhitespace();
  if (initWs) return initWs;
  if (i >= len) {
    return fail(0, '输入内容为空，请粘贴或输入 JSON 数据', false);
  }

  const rootErr = parseValue(0);
  if (rootErr) return rootErr;

  const trailWs = skipWhitespace();
  if (trailWs) return trailWs;

  if (i < len) {
    // Check if looks like NDJSON / multiple JSON lines
    if (text[i] === '{' || text[i] === '[') {
      return fail(i, '检测到多段连续 JSON（疑似 JSON Lines / 日志流），点击「智能修复」可自动合并为数组', true);
    }
    if (text[i] === ';') {
      return fail(i, 'JSON 末尾包含多余的分号 ";" ，点击「智能修复」可自动移除', true);
    }
    return fail(i, `根元素结束后存在多余内容 "${text.slice(i, i + 12)}"`, true);
  }

  return fail(0, 'JSON 语法解析失败', true);
}

/**
 * Parse JSON string and return either parsed value or detailed cross-browser error.
 * Also detects if the valid result is a stringified JSON (e.g. "{\"a\":1}") so UI can offer 1-click unescape!
 * @param {string} raw
 */
export function parseJsonSafe(raw) {
  if (!raw || !raw.trim()) {
    return {
      ok: true,
      empty: true,
      value: undefined,
      error: null,
      isEscapedJsonString: false,
    };
  }

  try {
    const value = JSON.parse(raw);
    let isEscapedJsonString = false;
    if (typeof value === 'string') {
      const trimmedInner = value.trim();
      if (
        (trimmedInner.startsWith('{') && trimmedInner.endsWith('}')) ||
        (trimmedInner.startsWith('[') && trimmedInner.endsWith(']'))
      ) {
        try {
          JSON.parse(trimmedInner);
          isEscapedJsonString = true;
        } catch {
          isEscapedJsonString = false;
        }
      }
    }
    return {
      ok: true,
      empty: false,
      value,
      error: null,
      isEscapedJsonString,
    };
  } catch (nativeErr) {
    const diag = diagnoseJsonError(raw);
    return {
      ok: false,
      empty: false,
      value: undefined,
      error: {
        ...diag,
        nativeMessage: nativeErr instanceof Error ? nativeErr.message : String(nativeErr),
      },
      isEscapedJsonString: false,
    };
  }
}

/**
 * Compute comprehensive statistics for parsed JSON value & raw string.
 * Caps traversal at 100,000 nodes to keep UI instant on multi-MB payloads.
 * @param {any} value
 * @param {string} rawText
 */
export function analyzeJsonStats(value, rawText = '') {
  const bytes = new TextEncoder().encode(rawText).length;
  const lines = rawText ? rawText.split('\n').length : 0;

  const stats = {
    bytes,
    formattedBytes: formatBytes(bytes),
    lines,
    maxDepth: 0,
    keys: 0,
    objects: 0,
    arrays: 0,
    strings: 0,
    numbers: 0,
    booleans: 0,
    nulls: 0,
    truncated: false,
  };

  if (value === undefined) return stats;

  let visited = 0;
  const MAX_VISIT = 100000;
  const stack = [{ val: value, depth: 1 }];

  while (stack.length > 0) {
    const { val, depth } = stack.pop();
    visited++;
    if (visited > MAX_VISIT) {
      stats.truncated = true;
      break;
    }

    if (val === null) {
      stats.nulls++;
    } else if (Array.isArray(val)) {
      stats.arrays++;
      if (depth > stats.maxDepth) stats.maxDepth = depth;
      for (let i = val.length - 1; i >= 0; i--) {
        stack.push({ val: val[i], depth: depth + 1 });
      }
    } else if (typeof val === 'object') {
      stats.objects++;
      if (depth > stats.maxDepth) stats.maxDepth = depth;
      const entries = Object.keys(val);
      stats.keys += entries.length;
      for (let i = entries.length - 1; i >= 0; i--) {
        stack.push({ val: val[entries[i]], depth: depth + 1 });
      }
    } else if (typeof val === 'string') {
      stats.strings++;
    } else if (typeof val === 'number') {
      stats.numbers++;
    } else if (typeof val === 'boolean') {
      stats.booleans++;
    }
  }

  return stats;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Escape HTML entities safely.
 * @param {string} str
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Fast, XSS-safe JSON syntax highlighter for code overlays & previews.
 * Distinguishes object keys from string values cleanly!
 * @param {string} code
 */
export function highlightJson(code) {
  if (!code) return '';
  // Regex matches JSON strings (with optional trailing colon for keys), booleans/null, numbers, comments, or punctuation
  const tokenRegex =
    /("(?:\\.|[^"\\])*")(\s*:)?|(\b(?:true|false|null|True|False|None|undefined|NaN|Infinity)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|([{}\[\],:])/g;

  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(code)) !== null) {
    if (match.index > lastIndex) {
      result += escapeHtml(code.slice(lastIndex, match.index));
    }
    const [, strLit, colonPart, kwLit, numLit, commentLit, punctLit] = match;
    if (strLit !== undefined) {
      if (colonPart !== undefined) {
        result += `<span class="tok-key">${escapeHtml(strLit)}</span><span class="tok-punct">${escapeHtml(colonPart)}</span>`;
      } else {
        result += `<span class="tok-str">${escapeHtml(strLit)}</span>`;
      }
    } else if (kwLit !== undefined) {
      const cls = kwLit === 'null' || kwLit === 'None' || kwLit === 'undefined' ? 'tok-null' : 'tok-bool';
      result += `<span class="${cls}">${escapeHtml(kwLit)}</span>`;
    } else if (numLit !== undefined) {
      result += `<span class="tok-num">${escapeHtml(numLit)}</span>`;
    } else if (commentLit !== undefined) {
      result += `<span class="tok-comment">${escapeHtml(commentLit)}</span>`;
    } else if (punctLit !== undefined) {
      result += `<span class="tok-punct">${escapeHtml(punctLit)}</span>`;
    }
    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < code.length) {
    result += escapeHtml(code.slice(lastIndex));
  }
  return result;
}
