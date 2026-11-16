/**
 * JSONLens JSONPath Query Engine (CSP-safe, zero eval) & Smart Value Inspector
 */

/**
 * Format path segments into JSONPath (`$.a.b[0]['c.d']`) and JSON Pointer (`/a/b/0/c.d`).
 * @param {Array<string|number>} segments
 */
export function formatPath(segments) {
  let jsonPath = '$';
  for (const seg of segments) {
    if (typeof seg === 'number') {
      jsonPath += `[${seg}]`;
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) {
      jsonPath += `.${seg}`;
    } else {
      jsonPath += `[${JSON.stringify(seg)}]`;
    }
  }
  const jsonPointer =
    segments.length === 0
      ? '/'
      : '/' +
        segments
          .map((s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1'))
          .join('/');

  return { jsonPath, jsonPointer };
}

/**
 * Retrieve value at exact segments array.
 * @param {any} root
 * @param {Array<string|number>} segments
 */
export function getValueAtPath(root, segments) {
  let cur = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = cur[seg];
  }
  return cur;
}

/**
 * Replace value at exact segments array immutably.
 * @param {any} root
 * @param {Array<string|number>} segments
 * @param {any} newValue
 */
export function setValueAtPath(root, segments, newValue) {
  if (segments.length === 0) return newValue;
  const [head, ...rest] = segments;
  if (Array.isArray(root)) {
    const copy = root.slice();
    copy[head] = setValueAtPath(copy[head], rest, newValue);
    return copy;
  }
  if (root !== null && typeof root === 'object') {
    return {
      ...root,
      [head]: setValueAtPath(root[head], rest, newValue),
    };
  }
  return root;
}

/**
 * Tokenize a JSONPath expression into steps.
 * Supports: $, .key, ..key, ..*, [*], [0], [-1], [0:5], [0,2], ['a','b'], [?(@.price < 20)]
 * @param {string} expr
 */
function parseJsonPathSteps(expr) {
  let s = expr.trim();
  if (!s || s === '$') return [];
  if (s.startsWith('$')) {
    s = s.slice(1);
  } else if (!s.startsWith('.') && !s.startsWith('[')) {
    s = '.' + s;
  }

  const steps = [];
  let i = 0;
  const len = s.length;

  while (i < len) {
    if (s[i] === '.' && s[i + 1] === '.') {
      i += 2;
      if (s[i] === '*') {
        steps.push({ op: 'recursiveWildcard' });
        i++;
      } else if (s[i] === '[') {
        // Recursive bracket e.g. $..['id']
        const bracketStep = readBracket(s, i);
        i = bracketStep.nextIndex;
        steps.push({ ...bracketStep.step, recursive: true });
      } else {
        const m = s.slice(i).match(/^[^.[\s]+/);
        if (!m) throw new Error(`JSONPath 语法错误，位置 ${i}：".."` );
        steps.push({ op: 'recursiveKey', key: m[0] });
        i += m[0].length;
      }
      continue;
    }

    if (s[i] === '.') {
      i++;
      if (s[i] === '*') {
        steps.push({ op: 'wildcard' });
        i++;
      } else {
        const m = s.slice(i).match(/^[^.[\s]+/);
        if (!m) throw new Error(`JSONPath 点号后缺少属性名`);
        steps.push({ op: 'key', key: m[0] });
        i += m[0].length;
      }
      continue;
    }

    if (s[i] === '[') {
      const bracketStep = readBracket(s, i);
      i = bracketStep.nextIndex;
      steps.push(bracketStep.step);
      continue;
    }

    if (/\s/.test(s[i])) {
      i++;
      continue;
    }

    throw new Error(`无法识别的 JSONPath 语法片段："${s.slice(i, i + 15)}"`);
  }

  return steps;
}

function readBracket(s, startIdx) {
  let i = startIdx + 1;
  let depth = 1;
  let inQuote = null;
  let content = '';

  while (i < s.length && depth > 0) {
    const c = s[i];
    if (inQuote) {
      content += c;
      if (c === '\\' && i + 1 < s.length) {
        content += s[i + 1];
        i += 2;
        continue;
      }
      if (c === inQuote) inQuote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      content += c;
      i++;
      continue;
    }
    if (c === '[') depth++;
    if (c === ']') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
    content += c;
    i++;
  }

  if (depth !== 0) {
    throw new Error('JSONPath 方括号 "[" 未闭合');
  }

  const inner = content.trim();
  if (inner === '*') {
    return { step: { op: 'wildcard' }, nextIndex: i };
  }

  // Filter expression: ?(@.price < 20) or ?@.active
  if (inner.startsWith('?')) {
    let f = inner.slice(1).trim();
    if (f.startsWith('(') && f.endsWith(')')) {
      f = f.slice(1, -1).trim();
    }
    return { step: { op: 'filter', expr: f }, nextIndex: i };
  }

  // Slice expression: start:end[:step]
  if (/^-?\d*\s*:\s*-?\d*(\s*:\s*-?\d*)?$/.test(inner)) {
    const parts = inner.split(':').map((p) => p.trim());
    return {
      step: {
        op: 'slice',
        start: parts[0] === '' ? null : parseInt(parts[0], 10),
        end: parts[1] === '' ? null : parseInt(parts[1], 10),
        step: parts[2] ? parseInt(parts[2], 10) : 1,
      },
      nextIndex: i,
    };
  }

  // Comma-separated union of quoted keys or integer indices
  const items = splitTopLevelComma(inner);
  const parsedItems = items.map((item) => {
    const t = item.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      return { kind: 'key', value: t.slice(1, -1).replace(/\\(['"\\])/g, '$1') };
    }
    if (/^-?\d+$/.test(t)) {
      return { kind: 'index', value: parseInt(t, 10) };
    }
    return { kind: 'key', value: t };
  });

  if (parsedItems.length === 1) {
    const single = parsedItems[0];
    if (single.kind === 'index') {
      return { step: { op: 'index', index: single.value }, nextIndex: i };
    }
    return { step: { op: 'key', key: single.value }, nextIndex: i };
  }

  return { step: { op: 'union', items: parsedItems }, nextIndex: i };
}

function splitTopLevelComma(str) {
  const res = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < str.length) {
        cur += str[++i];
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      res.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) res.push(cur);
  return res;
}

/**
 * Safe filter predicate evaluator without `eval`.
 * Supports `&&`, `||`, `@.a.b`, comparisons (`==`, `!=`, `<`, `<=`, `>`, `>=`, `=~` regex/contains), and truthy checks `@.active`.
 */
function evalFilterExpr(item, expr) {
  if (expr.includes('||')) {
    return expr.split('||').some((part) => evalFilterExpr(item, part.trim()));
  }
  if (expr.includes('&&')) {
    return expr.split('&&').every((part) => evalFilterExpr(item, part.trim()));
  }

  const cmpMatch = expr.match(/^(@(?:[.[][^\s=!<>~]+)*)\s*(===|!==|==|!=|<=|>=|<|>|=~)\s*(.+)$/);
  if (!cmpMatch) {
    // Truthy check e.g. @.active or !@.deleted
    const neg = expr.startsWith('!');
    const clean = neg ? expr.slice(1).trim() : expr.trim();
    const val = resolveAtPath(item, clean);
    return neg ? !Boolean(val) : Boolean(val);
  }

  const [, leftExpr, op, rightRaw] = cmpMatch;
  const leftVal = resolveAtPath(item, leftExpr.trim());
  const rightVal = parseFilterLiteral(rightRaw.trim(), item);

  switch (op) {
    case '==':
    case '===':
      return leftVal === rightVal;
    case '!=':
    case '!==':
      return leftVal !== rightVal;
    case '<':
      return typeof leftVal === 'number' && typeof rightVal === 'number' && leftVal < rightVal;
    case '<=':
      return typeof leftVal === 'number' && typeof rightVal === 'number' && leftVal <= rightVal;
    case '>':
      return typeof leftVal === 'number' && typeof rightVal === 'number' && leftVal > rightVal;
    case '>=':
      return typeof leftVal === 'number' && typeof rightVal === 'number' && leftVal >= rightVal;
    case '=~': {
      if (leftVal === undefined || leftVal === null) return false;
      const pattern = String(rightVal).replace(/^\/|\/[gimsuy]*$/g, '');
      try {
        return new RegExp(pattern, 'i').test(String(leftVal));
      } catch {
        return String(leftVal).toLowerCase().includes(pattern.toLowerCase());
      }
    }
    default:
      return false;
  }
}

function resolveAtPath(item, atExpr) {
  if (atExpr === '@') return item;
  if (!atExpr.startsWith('@')) return undefined;
  const subExpr = '$' + atExpr.slice(1);
  const res = evaluateJsonPath(item, subExpr);
  return res.ok && res.matches.length > 0 ? res.matches[0].value : undefined;
}

function parseFilterLiteral(raw, item) {
  if (raw.startsWith('@')) return resolveAtPath(item, raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

/**
 * Evaluate a JSONPath expression against `rootData`.
 * Returns matched `{ path, segments, value }` nodes!
 * @param {any} rootData
 * @param {string} expr
 */
export function evaluateJsonPath(rootData, expr) {
  try {
    const steps = parseJsonPathSteps(expr);
    let current = [{ value: rootData, segments: [] }];

    const collectDescendants = (node, list) => {
      list.push(node);
      if (Array.isArray(node.value)) {
        node.value.forEach((v, idx) => {
          collectDescendants({ value: v, segments: [...node.segments, idx] }, list);
        });
      } else if (node.value !== null && typeof node.value === 'object') {
        for (const [k, v] of Object.entries(node.value)) {
          collectDescendants({ value: v, segments: [...node.segments, k] }, list);
        }
      }
    };

    for (const step of steps) {
      let candidates = current;
      if (step.recursive || step.op === 'recursiveKey' || step.op === 'recursiveWildcard') {
        candidates = [];
        for (const c of current) collectDescendants(c, candidates);
      }

      const next = [];
      for (const node of candidates) {
        const val = node.value;
        if (val === null || val === undefined || typeof val !== 'object') continue;

        if (step.op === 'key' || step.op === 'recursiveKey') {
          if (!Array.isArray(val) && Object.prototype.hasOwnProperty.call(val, step.key)) {
            next.push({ value: val[step.key], segments: [...node.segments, step.key] });
          }
        } else if (step.op === 'index') {
          if (Array.isArray(val)) {
            const idx = step.index < 0 ? val.length + step.index : step.index;
            if (idx >= 0 && idx < val.length) {
              next.push({ value: val[idx], segments: [...node.segments, idx] });
            }
          }
        } else if (step.op === 'wildcard' || step.op === 'recursiveWildcard') {
          if (Array.isArray(val)) {
            val.forEach((item, idx) => next.push({ value: item, segments: [...node.segments, idx] }));
          } else {
            for (const [k, v] of Object.entries(val)) {
              next.push({ value: v, segments: [...node.segments, k] });
            }
          }
        } else if (step.op === 'slice') {
          if (Array.isArray(val) && step.step > 0) {
            const len = val.length;
            const start =
              step.start === null ? 0 : step.start < 0 ? Math.max(0, len + step.start) : Math.min(len, step.start);
            const end =
              step.end === null ? len : step.end < 0 ? Math.max(0, len + step.end) : Math.min(len, step.end);
            for (let idx = start; idx < end; idx += step.step) {
              next.push({ value: val[idx], segments: [...node.segments, idx] });
            }
          }
        } else if (step.op === 'union') {
          for (const u of step.items) {
            if (u.kind === 'index' && Array.isArray(val)) {
              const idx = u.value < 0 ? val.length + u.value : u.value;
              if (idx >= 0 && idx < val.length) {
                next.push({ value: val[idx], segments: [...node.segments, idx] });
              }
            } else if (u.kind === 'key' && !Array.isArray(val) && Object.prototype.hasOwnProperty.call(val, u.value)) {
              next.push({ value: val[u.value], segments: [...node.segments, u.value] });
            }
          }
        } else if (step.op === 'filter') {
          const entries = Array.isArray(val)
            ? val.map((item, idx) => [idx, item])
            : Object.entries(val);
          for (const [k, item] of entries) {
            if (evalFilterExpr(item, step.expr)) {
              next.push({ value: item, segments: [...node.segments, k] });
            }
          }
        }
      }
      current = next;
    }

    return {
      ok: true,
      matches: current.map((m) => ({
        ...formatPath(m.segments),
        segments: m.segments,
        value: m.value,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      matches: [],
    };
  }
}

/**
 * Smart Value Inspector (inspired by JSON Hero):
 * Detects semantic data types inside raw JSON values (Unix Timestamp, ISO Date, JWT, URL, Color, Base64, Nested JSON).
 * @param {any} value
 * @param {string|number|null} key
 * @param {Array<string|number>} segments
 */
export function inspectValue(value, key = null, segments = []) {
  const { jsonPath, jsonPointer } = formatPath(segments);
  const serialized = value === undefined ? '' : JSON.stringify(value);
  const byteSize = new TextEncoder().encode(serialized).length;

  let baseType = typeof value;
  if (value === null) baseType = 'null';
  else if (Array.isArray(value)) baseType = 'array';

  const insights = [];

  // 1. Numeric insights: Unix Timestamp detection
  if (typeof value === 'number' && Number.isFinite(value)) {
    const keyHint = String(key || '').toLowerCase();
    const looksLikeTimeKey = /(time|date|at|ts|timestamp|exp|iat|nbf|created|updated|expired)/.test(keyHint);

    // Seconds epoch: 2000-01-01 (946684800) to 2100-01-01 (4102444800)
    if (Number.isInteger(value) && value >= 946684800 && value <= 4102444800) {
      const d = new Date(value * 1000);
      insights.push({
        kind: 'timestamp',
        badge: 'Unix 时间戳 (秒)',
        local: formatLocalDateTime(d),
        iso: d.toISOString(),
        relative: formatRelativeTime(d),
        confidence: looksLikeTimeKey ? 'high' : 'medium',
      });
    } else if (Number.isInteger(value) && value >= 946684800000 && value <= 4102444800000) {
      const d = new Date(value);
      insights.push({
        kind: 'timestamp',
        badge: 'Unix 时间戳 (毫秒)',
        local: formatLocalDateTime(d),
        iso: d.toISOString(),
        relative: formatRelativeTime(d),
        confidence: looksLikeTimeKey ? 'high' : 'medium',
      });
    }
  }

  // 2. String semantic detections
  if (typeof value === 'string') {
    const trimmed = value.trim();

    // 2a. Numeric string timestamp
    if (/^\d{10}$/.test(trimmed) || /^\d{13}$/.test(trimmed)) {
      const num = Number(trimmed);
      const ms = trimmed.length === 10 ? num * 1000 : num;
      if (ms >= 946684800000 && ms <= 4102444800000) {
        const d = new Date(ms);
        insights.push({
          kind: 'timestamp',
          badge: `时间戳字符串 (${trimmed.length === 10 ? '秒' : '毫秒'})`,
          local: formatLocalDateTime(d),
          iso: d.toISOString(),
          relative: formatRelativeTime(d),
        });
      }
    }

    // 2b. ISO-8601 / RFC Date string
    if (
      /^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)
    ) {
      const parsedMs = Date.parse(trimmed);
      if (!Number.isNaN(parsedMs)) {
        const d = new Date(parsedMs);
        insights.push({
          kind: 'date-string',
          badge: '日期时间 (ISO 8601)',
          local: formatLocalDateTime(d),
          unixSec: Math.floor(parsedMs / 1000),
          unixMs: parsedMs,
          relative: formatRelativeTime(d),
        });
      }
    }

    // 2c. JWT Token (Header.Payload.Signature)
    if (/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(trimmed)) {
      const parts = trimmed.split('.');
      const header = safeDecodeBase64UrlJson(parts[0]);
      const payload = safeDecodeBase64UrlJson(parts[1]);
      if (header && payload) {
        let expInfo = null;
        if (typeof payload.exp === 'number') {
          const expDate = new Date(payload.exp * 1000);
          expInfo = {
            expired: expDate.getTime() < Date.now(),
            formatted: formatLocalDateTime(expDate),
          };
        }
        insights.push({
          kind: 'jwt',
          badge: 'JWT 令牌 (JSON Web Token)',
          header,
          payload,
          expInfo,
        });
      }
    }

    // 2d. Color Hex / RGB / HSL
    if (
      /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed) ||
      /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/.test(trimmed) ||
      /^hsla?\(\s*\d+/.test(trimmed)
    ) {
      insights.push({
        kind: 'color',
        badge: '颜色值 (Color)',
        color: trimmed,
      });
    }

    // 2e. URL & Image URL
    if (/^https?:\/\/[^\s]+$/i.test(trimmed)) {
      try {
        const u = new URL(trimmed);
        const queryParams = [...u.searchParams.entries()];
        const isImage = /\.(png|jpe?g|gif|webp|svg|avif|ico)(\?.*)?$/i.test(u.pathname);
        insights.push({
          kind: 'url',
          badge: isImage ? '图片链接 (URL)' : '网页/接口链接 (URL)',
          href: u.href,
          host: u.host,
          pathname: u.pathname,
          queryParams,
          isImage,
        });
      } catch {
        // ignore invalid URL
      }
    }

    // 2f. Embedded / Stringified JSON
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const nested = JSON.parse(trimmed);
        if (nested !== null && typeof nested === 'object') {
          insights.push({
            kind: 'nested-json',
            badge: '内嵌 JSON 字符串',
            parsed: nested,
            pretty: JSON.stringify(nested, null, 2),
          });
        }
      } catch {
        // not valid nested json
      }
    }

    // 2g. Base64 string (only when >= 12 chars, multiple of 4, and decodes to clean UTF-8 text)
    if (
      trimmed.length >= 12 &&
      trimmed.length <= 4096 &&
      trimmed.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) &&
      !/^[A-Za-z0-9]+$/.test(trimmed) // require at least +, /, or =, OR check key hint so normal words aren't misflagged
    ) {
      const decoded = safeDecodeBase64Utf8(trimmed);
      if (decoded) {
        insights.push({
          kind: 'base64',
          badge: 'Base64 编码文本',
          decoded,
        });
      }
    }
  }

  return {
    key,
    segments,
    jsonPath,
    jsonPointer,
    baseType,
    byteSize,
    summary: getValueSummary(value, baseType),
    value,
    insights,
  };
}

function getValueSummary(value, baseType) {
  if (baseType === 'object') return `Object · ${Object.keys(value).length} 个属性`;
  if (baseType === 'array') return `Array · ${value.length} 个元素`;
  if (baseType === 'string') return `String · ${value.length} 字符`;
  if (baseType === 'number') return Number.isInteger(value) ? 'Number (Integer)' : 'Number (Float)';
  if (baseType === 'boolean') return `Boolean (${value})`;
  return 'null';
}

function formatLocalDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatRelativeTime(date) {
  const diffSec = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const suffix = diffSec < 0 ? '前' : '后';
  if (abs < 60) return `${abs} 秒${suffix}`;
  if (abs < 3600) return `${Math.round(abs / 60)} 分钟${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)} 小时${suffix}`;
  if (abs < 86400 * 365) return `${Math.round(abs / 86400)} 天${suffix}`;
  return `${(abs / (86400 * 365)).toFixed(1)} 年${suffix}`;
}

function safeDecodeBase64UrlJson(b64url) {
  try {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const text = safeDecodeBase64Utf8(padded);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function safeDecodeBase64Utf8(b64) {
  try {
    let bytes;
    if (typeof atob === 'function') {
      const bin = atob(b64);
      bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } else if (typeof Buffer !== 'undefined') {
      bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    } else {
      return null;
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Verify printable text (no weird binary control chars except \n, \r, \t)
    for (let i = 0; i < decoded.length; i++) {
      const c = decoded.charCodeAt(i);
      if (c < 32 && c !== 9 && c !== 10 && c !== 13) return null;
    }
    return decoded;
  } catch {
    return null;
  }
}
