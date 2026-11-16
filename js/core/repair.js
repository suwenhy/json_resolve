/**
 * JSONLens Smart Repair, Escape/Unescape, Nested Unpack & Transform Engine
 * Token-aware state machine — never corrupts URLs ("https://...") or quoted symbols!
 */

/**
 * Repair common malformed JSON inputs:
 * - JSONP wrappers: callback({...});
 * - Escaped JSON pasted directly: {\"a\": 1}
 * - Single-line // and multi-line /* * / comments
 * - Single-quoted strings '...' and backtick template strings `...`
 * - Unquoted object keys { user_name: 123, $id: 1 }
 * - Python / JS literals: True, False, None, undefined, NaN, Infinity
 * - Leading '+' on numbers (+3.14 -> 3.14) and trailing decimal (3. -> 3.0)
 * - Trailing commas before } or ]
 * - Missing commas between adjacent values / lines
 * - Unclosed strings, brackets [, and braces {
 * - NDJSON / concatenated JSON objects -> array [...]
 *
 * @param {string} input
 * @returns {{ ok: boolean, output: string, changes: string[], error?: string }}
 */
export function repairJson(input) {
  if (!input || !input.trim()) {
    return { ok: false, output: input, changes: [], error: '输入内容为空' };
  }

  const changes = new Set();
  let src = input.trim();

  // 0. Check if already valid JSON (unless it's a double-escaped JSON string that user wants unpacked)
  try {
    const parsed = JSON.parse(src);
    if (typeof parsed === 'string') {
      const inner = parsed.trim();
      if ((inner.startsWith('{') && inner.endsWith('}')) || (inner.startsWith('[') && inner.endsWith(']'))) {
        try {
          const innerParsed = JSON.parse(inner);
          changes.add('自动解包转义的 JSON 字符串');
          return {
            ok: true,
            output: JSON.stringify(innerParsed, null, 2),
            changes: [...changes],
          };
        } catch {
          // continue
        }
      }
    } else {
      return {
        ok: true,
        output: JSON.stringify(parsed, null, 2),
        changes: [],
      };
    }
  } catch {
    // Proceed with repair pipeline
  }

  // 1. Strip BOM, leading/trailing comments, and trailing semicolons before JSONP check
  if (src.charCodeAt(0) === 0xfeff) {
    src = src.slice(1).trim();
    changes.add('移除 UTF-8 BOM 头');
  }

  // Strip leading comments (// or /* */) so JSONP wrappers after comments are cleanly recognized
  let strippedLeading = true;
  while (strippedLeading) {
    strippedLeading = false;
    if (src.startsWith('//')) {
      const nl = src.indexOf('\n');
      src = nl === -1 ? '' : src.slice(nl + 1).trim();
      changes.add('移除单行注释 //');
      strippedLeading = true;
    } else if (src.startsWith('/*')) {
      const end = src.indexOf('*/');
      src = end === -1 ? '' : src.slice(end + 2).trim();
      changes.add('移除多行注释 /* */');
      strippedLeading = true;
    }
  }

  while (src.endsWith(';')) {
    src = src.slice(0, -1).trim();
    changes.add('移除末尾分号');
  }

  // 2. Unwrap JSONP wrapper e.g. jsonpCallback({ ... })
  const jsonpMatch = src.match(/^[A-Za-z_$][A-Za-z0-9_$.]*\s*\(([\s\S]*)\)\s*;?$/);
  if (jsonpMatch) {
    src = jsonpMatch[1].trim();
    changes.add('剥离 JSONP 函数包裹');
  }

  // 3. Detect raw escaped JSON without outer quotes: {\"name\":\"test\"}
  if ((src.startsWith('{\\"') || src.startsWith('[\\"')) && src.includes('\\"')) {
    try {
      const unescaped = src.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const parsed = JSON.parse(unescaped);
      changes.add('还原反斜杠转义引号');
      return {
        ok: true,
        output: JSON.stringify(parsed, null, 2),
        changes: [...changes],
      };
    } catch {
      // Fall through to full lexer repair
    }
  }

  // 4. Token-aware lexical repair pass
  const tokens = tokenizeLooseJson(src, changes);
  const repairedText = assembleValidJson(tokens, changes);

  try {
    const parsed = JSON.parse(repairedText);
    return {
      ok: true,
      output: JSON.stringify(parsed, null, 2),
      changes: [...changes],
    };
  } catch (err) {
    return {
      ok: false,
      output: repairedText,
      changes: [...changes],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Tokenize loose/broken JSON-like text into structured tokens.
 * @param {string} src
 * @param {Set<string>} changes
 */
function tokenizeLooseJson(src, changes) {
  const tokens = [];
  const len = src.length;
  let i = 0;

  while (i < len) {
    const ch = src[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      let hasNewline = false;
      while (i < len && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r' || src[i] === '\n')) {
        if (src[i] === '\n') hasNewline = true;
        i++;
      }
      if (hasNewline) {
        tokens.push({ type: 'newline' });
      }
      continue;
    }

    // Single-line comment //
    if (ch === '/' && src[i + 1] === '/') {
      changes.add('移除单行注释 //');
      i += 2;
      while (i < len && src[i] !== '\n') i++;
      continue;
    }

    // Python/YAML hash comment # (outside strings)
    if (ch === '#') {
      changes.add('移除 # 注释');
      i++;
      while (i < len && src[i] !== '\n') i++;
      continue;
    }

    // Multi-line comment /* ... */
    if (ch === '/' && src[i + 1] === '*') {
      changes.add('移除多行注释 /* */');
      i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Structural characters
    if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ':' || ch === ',') {
      tokens.push({ type: 'punct', value: ch });
      i++;
      continue;
    }

    // Semicolon used instead of comma
    if (ch === ';') {
      changes.add('将分号 ";" 替换为逗号');
      tokens.push({ type: 'punct', value: ',' });
      i++;
      continue;
    }

    // Chinese full-width punctuation mistakes! Very common when editing in Chinese IME!
    if ('“”'.includes(ch) || ch === '‘' || ch === '’') {
      changes.add('修正中文全角引号');
      const closeQuotes = ch === '“' || ch === '”' ? ['”', '“', '"'] : ['’', '‘', "'"];
      i++;
      let content = '';
      while (i < len && !closeQuotes.includes(src[i]) && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < len) {
          content += src[i] + src[i + 1];
          i += 2;
        } else {
          content += src[i];
          i++;
        }
      }
      if (i < len && closeQuotes.includes(src[i])) i++;
      tokens.push({ type: 'string', value: JSON.stringify(unescapeLooseString(content)) });
      continue;
    }
    if (ch === '：') {
      changes.add('修正中文全角冒号');
      tokens.push({ type: 'punct', value: ':' });
      i++;
      continue;
    }
    if (ch === '，') {
      changes.add('修正中文全角逗号');
      tokens.push({ type: 'punct', value: ',' });
      i++;
      continue;
    }

    // Quoted strings: ", ', or `
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      if (quote !== '"') {
        changes.add(quote === "'" ? '将单引号字符串转换为双引号' : '将模板字符串转换为标准双引号');
      }
      i++;
      let rawChars = '';
      let closed = false;
      while (i < len) {
        const c = src[i];
        if (c === '\\') {
          if (i + 1 < len) {
            const next = src[i + 1];
            if (next === "'") {
              rawChars += "'";
            } else if (next === '`') {
              rawChars += '`';
            } else if ('"\\/bfnrt'.includes(next)) {
              rawChars += '\\' + next;
            } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
              rawChars += src.slice(i, i + 6);
              i += 6;
              continue;
            } else if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) {
              const code = parseInt(src.slice(i + 2, i + 4), 16);
              rawChars += `\\u${code.toString(16).padStart(4, '0')}`;
              changes.add('转换十六进制转义 \\x 为 \\u');
              i += 4;
              continue;
            } else {
              // Escape stray backslash
              rawChars += '\\\\' + next;
              changes.add('修复非法反斜杠转义');
            }
            i += 2;
            continue;
          } else {
            rawChars += '\\\\';
            i++;
            break;
          }
        }
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        if (c === '\n' || c === '\r') {
          if (quote === '`') {
            rawChars += c === '\n' ? '\\n' : '\\r';
            i++;
            continue;
          }
          // Unclosed single-line quote or raw newline in string
          rawChars += c === '\n' ? '\\n' : '\\r';
          changes.add('转义字符串内的原始换行符');
          i++;
          continue;
        }
        if (c === '"') {
          rawChars += '\\"';
        } else if (c.charCodeAt(0) < 0x20) {
          rawChars += `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
          changes.add('转义控制字符');
        } else {
          rawChars += c;
        }
        i++;
      }
      if (!closed) {
        changes.add('补全未闭合的字符串引号');
      }
      tokens.push({ type: 'string', value: `"${rawChars}"` });
      continue;
    }

    // Numbers (including +123, .5, 3., -Infinity, hex 0xFF)
    if (ch === '+' || ch === '-' || (ch >= '0' && ch <= '9') || (ch === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      // Check -Infinity
      if (src.startsWith('-Infinity', i) && !/[A-Za-z0-9_]/.test(src[i + 9] || '')) {
        changes.add('将 -Infinity 转换为 null');
        tokens.push({ type: 'literal', value: 'null' });
        i += 9;
        continue;
      }
      // Check hex 0x...
      const hexMatch = src.slice(i).match(/^[+-]?0[xX]([0-9a-fA-F]+)/);
      if (hexMatch) {
        const val = parseInt(hexMatch[0], 16);
        changes.add('将十六进制数字转换为十进制');
        tokens.push({ type: 'number', value: String(val) });
        i += hexMatch[0].length;
        continue;
      }

      const numMatch = src.slice(i).match(/^([+-]?)(\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/);
      if (numMatch) {
        let rawNum = numMatch[0];
        // Check if this numeric token is actually an unquoted key like 123: "abc"
        const afterIdx = i + rawNum.length;
        let lookahead = afterIdx;
        while (lookahead < len && (src[lookahead] === ' ' || src[lookahead] === '\t')) lookahead++;
        if (src[lookahead] === ':' || src[lookahead] === '：') {
          changes.add('为数字键名补全双引号');
          tokens.push({ type: 'string', value: JSON.stringify(rawNum) });
          i += rawNum.length;
          continue;
        }

        if (rawNum.startsWith('+')) {
          rawNum = rawNum.slice(1);
          changes.add('移除数字前的正号 "+"');
        }
        if (rawNum.startsWith('.')) {
          rawNum = '0' + rawNum;
          changes.add('补全小数前导 0');
        } else if (rawNum.startsWith('-.')) {
          rawNum = '-0.' + rawNum.slice(2);
          changes.add('补全小数前导 0');
        }
        if (rawNum.endsWith('.')) {
          rawNum = rawNum + '0';
          changes.add('补全小数末尾 0');
        }
        // Strip leading zeros like 007 -> 7
        if (/^-?0\d+/.test(rawNum)) {
          const neg = rawNum.startsWith('-');
          const stripped = rawNum.replace(/^-?0+/, '') || '0';
          rawNum = (neg && stripped !== '0' ? '-' : '') + stripped;
          changes.add('移除数字多余前导零');
        }
        tokens.push({ type: 'number', value: rawNum });
        i += numMatch[0].length;
        continue;
      }
    }

    // Identifiers / Unquoted keys / Python & JS literals
    const idMatch = src.slice(i).match(/^[^\s{}[\]:,"'`;/\\]+/);
    if (idMatch) {
      const word = idMatch[0];
      i += word.length;

      // Peek if followed by colon => it's an object key (even `true: 1`)
      let look = i;
      while (look < len && (src[look] === ' ' || src[look] === '\t')) look++;
      const followedByColon = src[look] === ':' || src[look] === '：';

      if (!followedByColon) {
        if (word === 'true' || word === 'false' || word === 'null') {
          tokens.push({ type: 'literal', value: word });
          continue;
        }
        if (word === 'True' || word === 'False') {
          changes.add(`将 Python "${word}" 转换为 ${word.toLowerCase()}`);
          tokens.push({ type: 'literal', value: word.toLowerCase() });
          continue;
        }
        if (word === 'None' || word === 'undefined' || word === 'NaN' || word === 'Infinity') {
          changes.add(`将 "${word}" 转换为 null`);
          tokens.push({ type: 'literal', value: 'null' });
          continue;
        }
      }

      // Unquoted key or unquoted string value
      changes.add(followedByColon ? '为未加引号的键名补全双引号' : '为未加引号的字符串补全双引号');
      tokens.push({ type: 'string', value: JSON.stringify(word) });
      continue;
    }

    // Fallback skip unknown char
    i++;
  }

  return tokens;
}

function unescapeLooseString(str) {
  return str.replace(/\\(.)/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === 't') return '\t';
    return c;
  });
}

/**
 * Reassemble token stream into valid RFC 8259 JSON:
 * - Removes trailing commas & duplicate commas
 * - Inserts missing commas between consecutive values / key-value pairs
 * - Wraps multiple top-level values (NDJSON / log lines) into a JSON array [...]
 * - Auto-closes any unclosed { or [
 */
function assembleValidJson(tokens, changes) {
  // Strip newline markers after using them only if needed; structural analysis handles missing commas cleanly!
  const clean = tokens.filter((t) => t.type !== 'newline');
  if (clean.length === 0) return '';

  const isValueStart = (tok) =>
    tok &&
    (tok.type === 'string' ||
      tok.type === 'number' ||
      tok.type === 'literal' ||
      (tok.type === 'punct' && (tok.value === '{' || tok.value === '[')));

  const isValueEnd = (tok) =>
    tok &&
    (tok.type === 'string' ||
      tok.type === 'number' ||
      tok.type === 'literal' ||
      (tok.type === 'punct' && (tok.value === '}' || tok.value === ']')));

  const out = [];
  const stack = []; // '{' | '['
  let topLevelValues = 0;

  for (let idx = 0; idx < clean.length; idx++) {
    const tok = clean[idx];
    const prev = out[out.length - 1];

    // Skip leading or duplicate commas
    if (tok.type === 'punct' && tok.value === ',') {
      if (!prev || (prev.type === 'punct' && (prev.value === '{' || prev.value === '[' || prev.value === ',' || prev.value === ':'))) {
        changes.add('移除多余逗号');
        continue;
      }
      // Look ahead: if next token is } or ] or end-of-input, skip trailing comma!
      const next = clean[idx + 1];
      if (!next || (next.type === 'punct' && (next.value === '}' || next.value === ']'))) {
        changes.add('移除尾随逗号 (Trailing comma)');
        continue;
      }
      out.push(tok);
      continue;
    }

    // Handle closing brackets
    if (tok.type === 'punct' && (tok.value === '}' || tok.value === ']')) {
      const expected = tok.value === '}' ? '{' : '[';
      if (stack.length > 0 && stack[stack.length - 1] === expected) {
        stack.pop();
        out.push(tok);
        if (stack.length === 0) topLevelValues++;
      } else if (stack.length > 0) {
        // Mismatched closer: close current container properly
        const actualOpen = stack.pop();
        const properClose = actualOpen === '{' ? '}' : ']';
        changes.add(`修正不匹配的括号 "${tok.value}" 为 "${properClose}"`);
        out.push({ type: 'punct', value: properClose });
        if (stack.length === 0) topLevelValues++;
      } else {
        changes.add(`忽略多余的闭合括号 "${tok.value}"`);
      }
      continue;
    }

    // Insert missing comma between two adjacent values (either inside {}/[] or at top-level NDJSON!)
    if (isValueEnd(prev) && isValueStart(tok)) {
      out.push({ type: 'punct', value: ',' });
      if (stack.length > 0) {
        changes.add('自动补全缺失的逗号');
      }
    }

    if (tok.type === 'punct' && (tok.value === '{' || tok.value === '[')) {
      stack.push(tok.value);
      out.push(tok);
      continue;
    }

    out.push(tok);
    if (stack.length === 0 && (tok.type === 'string' || tok.type === 'number' || tok.type === 'literal')) {
      topLevelValues++;
    }
  }

  // Remove trailing dangling colon or comma before auto-closing
  while (out.length > 0 && out[out.length - 1].type === 'punct' && (out[out.length - 1].value === ',' || out[out.length - 1].value === ':')) {
    const dangling = out.pop();
    if (dangling.value === ':') {
      out.push({ type: 'literal', value: 'null' });
      changes.add('为末尾缺失值的键补全 null');
      break;
    }
  }

  // Auto-close unclosed containers
  if (stack.length > 0) {
    changes.add('自动补全末尾缺失的闭合括号');
    while (stack.length > 0) {
      const open = stack.pop();
      out.push({ type: 'punct', value: open === '{' ? '}' : ']' });
    }
    topLevelValues = Math.max(1, topLevelValues);
  }

  const serialized = out.map((t) => t.value).join('');

  if (topLevelValues > 1) {
    changes.add('将多段 JSON / NDJSON 合并为数组');
    return `[${serialized}]`;
  }

  return serialized;
}

/**
 * Format JSON text with configurable indentation (2, 4, or '\t').
 * @param {string} text
 * @param {number|string} indent
 */
export function formatJsonText(text, indent = 2) {
  const parsed = JSON.parse(text);
  return JSON.stringify(parsed, null, indent);
}

/**
 * Minify JSON text to single compact line.
 * @param {string} text
 */
export function minifyJsonText(text) {
  const parsed = JSON.parse(text);
  return JSON.stringify(parsed);
}

/**
 * Escape text into a JSON string literal (wraps in quotes and escapes quotes/newlines).
 * @param {string} text
 */
export function escapeJsonText(text) {
  return JSON.stringify(text);
}

/**
 * Unescape stringified JSON text (supports both `"{\"a\":1}"` and `{\"a\":1}`).
 * @param {string} text
 */
export function unescapeJsonText(text) {
  const trimmed = text.trim();
  if (!trimmed) return text;

  // Case 1: Wrapped as a valid JSON string literal e.g. "{\"a\": 1}"
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const inner = JSON.parse(trimmed);
      if (typeof inner === 'string') {
        // Pretty format if inner is valid JSON!
        try {
          return JSON.stringify(JSON.parse(inner), null, 2);
        } catch {
          return inner;
        }
      }
    } catch {
      // Fall through
    }
  }

  // Case 2: Raw backslash-escaped text without outer quotes e.g. {\"a\":1,\"b\":\"hello\\nworld\"}
  const unescaped = trimmed
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');

  try {
    return JSON.stringify(JSON.parse(unescaped), null, 2);
  } catch {
    return unescaped;
  }
}

/**
 * Recursively unpack string values that themselves contain valid JSON objects or arrays!
 * Extremely useful for API gateway logs where `payload`, `body`, or `ext_info` is stringified JSON.
 * @param {any} value
 * @param {number} maxDepth
 * @returns {{ value: any, unpackedCount: number }}
 */
export function unpackNestedJson(value, maxDepth = 5) {
  let unpackedCount = 0;

  const walk = (val, depth) => {
    if (depth > maxDepth) return val;

    if (typeof val === 'string') {
      const s = val.trim();
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try {
          const parsed = JSON.parse(s);
          if (parsed !== null && typeof parsed === 'object') {
            unpackedCount++;
            return walk(parsed, depth + 1);
          }
        } catch {
          return val;
        }
      }
      return val;
    }

    if (Array.isArray(val)) {
      return val.map((item) => walk(item, depth));
    }

    if (val !== null && typeof val === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        out[k] = walk(v, depth);
      }
      return out;
    }

    return val;
  };

  return {
    value: walk(value, 0),
    unpackedCount,
  };
}

/**
 * Sort object keys alphabetically (asc / desc), optionally recursive.
 * @param {any} value
 * @param {'asc'|'desc'} direction
 * @param {boolean} recursive
 */
export function sortJsonKeys(value, direction = 'asc', recursive = true) {
  if (Array.isArray(value)) {
    return recursive ? value.map((item) => sortJsonKeys(item, direction, true)) : value.slice();
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) =>
      direction === 'asc' ? a.localeCompare(b) : b.localeCompare(a)
    );
    const sorted = {};
    for (const k of keys) {
      sorted[k] = recursive ? sortJsonKeys(value[k], direction, true) : value[k];
    }
    return sorted;
  }
  return value;
}
