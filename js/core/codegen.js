/**
 * JSONLens Multi-Language Type Generator & Data Format Converter
 * Supports: TypeScript, Go, Python (Pydantic), Java, Rust (Serde), JSON Schema, YAML, XML
 */

const GO_INITIALISMS = new Set([
  'id', 'url', 'uri', 'api', 'http', 'https', 'ip', 'json', 'xml', 'html', 'css', 'sql', 'jwt', 'uuid', 'uid', 'cpu', 'gpu', 'os', 'io', 'ui', 'ux', 'ttl', 'qps', 'rpc', 'tcp', 'udp', 'dns', 'tls', 'ssl',
]);

export function toPascalCase(str, goStyle = false) {
  const words = String(str)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return 'Field';
  let res = words
    .map((w) => {
      const lower = w.toLowerCase();
      if (goStyle && GO_INITIALISMS.has(lower)) return lower.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
  if (/^\d/.test(res)) res = 'N' + res;
  return res;
}

export function toCamelCase(str) {
  const pascal = toPascalCase(str, false);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function toSnakeCase(str) {
  const s = String(str)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!s) return 'field_val';
  return /^\d/.test(s) ? `f_${s}` : s;
}

/**
 * Infer a unified schema AST from any JSON value, merging object shapes across array items.
 * Node shapes:
 * - { kind: 'any' }
 * - { kind: 'null' }
 * - { kind: 'primitive', type: 'string' | 'int' | 'float' | 'boolean' }
 * - { kind: 'array', elem: SchemaNode }
 * - { kind: 'object', name: string, fields: Array<{ key: string, optional: boolean, schema: SchemaNode }> }
 * - { kind: 'union', variants: SchemaNode[] }
 */
function inferSchema(rootValue, rootName = 'RootObject') {
  const structs = [];
  const usedNames = new Map();

  const uniqueStructName = (hint) => {
    const base = toPascalCase(hint || 'Item');
    const count = usedNames.get(base) || 0;
    usedNames.set(base, count + 1);
    return count === 0 ? base : `${base}${count + 1}`;
  };

  const mergeSchemas = (list, nameHint) => {
    const flat = [];
    for (const item of list) {
      if (!item || item.kind === 'any') continue;
      if (item.kind === 'union') flat.push(...item.variants);
      else flat.push(item);
    }
    if (flat.length === 0) return { kind: 'any' };

    const hasNull = flat.some((s) => s.kind === 'null');
    const nonNull = flat.filter((s) => s.kind !== 'null');
    if (nonNull.length === 0) return { kind: 'null' };

    // Merge numeric int + float => float
    const hasInt = nonNull.some((s) => s.kind === 'primitive' && s.type === 'int');
    const hasFloat = nonNull.some((s) => s.kind === 'primitive' && s.type === 'float');

    const objectNodes = nonNull.filter((s) => s.kind === 'object');
    const arrayNodes = nonNull.filter((s) => s.kind === 'array');
    const primTypes = new Set(
      nonNull
        .filter((s) => s.kind === 'primitive')
        .map((s) => (hasInt && hasFloat && s.type === 'int' ? 'float' : s.type))
    );

    const mergedVariants = [];
    for (const pt of primTypes) {
      mergedVariants.push({ kind: 'primitive', type: pt });
    }

    if (arrayNodes.length > 0) {
      const mergedElem = mergeSchemas(
        arrayNodes.map((a) => a.elem),
        nameHint
      );
      mergedVariants.push({ kind: 'array', elem: mergedElem });
    }

    if (objectNodes.length > 0) {
      if (objectNodes.length === 1) {
        mergedVariants.push(objectNodes[0]);
      } else {
        // Merge multiple object instances (e.g. from array items) into one consolidated struct!
        const allKeys = new Map(); // key -> { count, schemas[] }
        for (const obj of objectNodes) {
          // Remove intermediate structs that we are consolidating
          const idx = structs.indexOf(obj);
          if (idx !== -1) structs.splice(idx, 1);
          for (const f of obj.fields) {
            if (!allKeys.has(f.key)) allKeys.set(f.key, { count: 0, schemas: [] });
            const entry = allKeys.get(f.key);
            if (!f.optional) entry.count++;
            entry.schemas.push(f.schema);
          }
        }
        const structName = uniqueStructName(nameHint);
        const fields = [];
        for (const [k, info] of allKeys.entries()) {
          fields.push({
            key: k,
            optional: info.count < objectNodes.length,
            schema: mergeSchemas(info.schemas, k),
          });
        }
        const mergedObj = { kind: 'object', name: structName, fields };
        structs.push(mergedObj);
        mergedVariants.push(mergedObj);
      }
    }

    if (hasNull) mergedVariants.push({ kind: 'null' });
    return mergedVariants.length === 1 ? mergedVariants[0] : { kind: 'union', variants: mergedVariants };
  };

  const infer = (val, nameHint) => {
    if (val === null || val === undefined) return { kind: 'null' };
    if (typeof val === 'boolean') return { kind: 'primitive', type: 'boolean' };
    if (typeof val === 'number') {
      return { kind: 'primitive', type: Number.isInteger(val) ? 'int' : 'float' };
    }
    if (typeof val === 'string') return { kind: 'primitive', type: 'string' };

    if (Array.isArray(val)) {
      const singularHint = String(nameHint || 'Item').replace(/ies$/i, 'y').replace(/s$/i, '') || 'Item';
      // Sample up to 100 elements for fast inference on huge arrays
      const sample = val.slice(0, 100);
      const itemSchemas = sample.map((item) => infer(item, singularHint));
      return {
        kind: 'array',
        elem: mergeSchemas(itemSchemas, singularHint),
      };
    }

    if (typeof val === 'object') {
      const structName = uniqueStructName(nameHint);
      const fields = Object.entries(val).map(([k, v]) => ({
        key: k,
        optional: false,
        schema: infer(v, k),
      }));
      const node = { kind: 'object', name: structName, fields };
      structs.push(node);
      return node;
    }

    return { kind: 'any' };
  };

  const root = infer(rootValue, rootName);
  return { root, structs };
}

function splitNullable(schema) {
  if (schema.kind === 'union') {
    const nullable = schema.variants.some((v) => v.kind === 'null');
    const rest = schema.variants.filter((v) => v.kind !== 'null');
    if (rest.length === 0) return { nullable: true, core: { kind: 'any' } };
    if (rest.length === 1) return { nullable, core: rest[0] };
    return { nullable, core: { kind: 'union', variants: rest } };
  }
  if (schema.kind === 'null') return { nullable: true, core: { kind: 'any' } };
  return { nullable: false, core: schema };
}

/**
 * 1. TypeScript Interfaces Generator
 */
export function generateTypeScript(value, rootName = 'RootObject') {
  const { root, structs } = inferSchema(value, rootName);

  const renderType = (node) => {
    if (node.kind === 'any') return 'unknown';
    if (node.kind === 'null') return 'null';
    if (node.kind === 'primitive') {
      if (node.type === 'int' || node.type === 'float') return 'number';
      return node.type;
    }
    if (node.kind === 'array') {
      const inner = renderType(node.elem);
      return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
    }
    if (node.kind === 'object') return node.name;
    if (node.kind === 'union') {
      return node.variants.map(renderType).join(' | ');
    }
    return 'unknown';
  };

  const blocks = [];
  // Emit root first (reverse post-order)
  const ordered = [...structs].reverse();
  for (const st of ordered) {
    const lines = [`export interface ${st.name} {`];
    for (const f of st.fields) {
      const propKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(f.key) ? f.key : JSON.stringify(f.key);
      const opt = f.optional ? '?' : '';
      lines.push(`  ${propKey}${opt}: ${renderType(f.schema)};`);
    }
    lines.push('}');
    blocks.push(lines.join('\n'));
  }

  if (root.kind !== 'object') {
    blocks.unshift(`export type ${toPascalCase(rootName)} = ${renderType(root)};`);
  }

  return blocks.join('\n\n');
}

/**
 * 2. Go Structs Generator
 */
export function generateGo(value, rootName = 'RootObject') {
  const { root, structs } = inferSchema(value, rootName);

  const renderGoType = (node, optional = false) => {
    const { nullable, core } = splitNullable(node);
    const ptr = (optional || nullable) && core.kind !== 'array' && core.kind !== 'any' ? '*' : '';
    if (core.kind === 'any') return 'any';
    if (core.kind === 'primitive') {
      if (core.type === 'string') return `${ptr}string`;
      if (core.type === 'int') return `${ptr}int64`;
      if (core.type === 'float') return `${ptr}float64`;
      if (core.type === 'boolean') return `${ptr}bool`;
    }
    if (core.kind === 'array') return `[]${renderGoType(core.elem, false)}`;
    if (core.kind === 'object') return `${ptr}${toPascalCase(core.name, true)}`;
    return 'any';
  };

  const blocks = ['package model'];
  const ordered = [...structs].reverse();
  for (const st of ordered) {
    const structName = toPascalCase(st.name, true);
    const lines = [`type ${structName} struct {`];
    const seenFields = new Set();
    for (const f of st.fields) {
      let fieldName = toPascalCase(f.key, true);
      if (seenFields.has(fieldName)) fieldName += '_';
      seenFields.add(fieldName);
      const omit = f.optional ? ',omitempty' : '';
      lines.push(`\t${fieldName} ${renderGoType(f.schema, f.optional)} \`json:"${f.key}${omit}"\``);
    }
    lines.push('}');
    blocks.push(lines.join('\n'));
  }

  if (root.kind !== 'object') {
    blocks.push(`type ${toPascalCase(rootName, true)} = ${renderGoType(root, false)}`);
  }

  return blocks.join('\n\n');
}

/**
 * 3. Python Pydantic v2 Models Generator
 */
export function generatePython(value, rootName = 'RootObject') {
  const { root, structs } = inferSchema(value, rootName);
  const PY_KEYWORDS = new Set([
    'from', 'import', 'class', 'def', 'return', 'pass', 'None', 'True', 'False', 'and', 'or', 'not', 'in', 'is', 'if', 'else', 'elif', 'for', 'while', 'try', 'except', 'finally', 'with', 'as', 'lambda', 'yield', 'global', 'nonlocal', 'assert', 'del', 'raise', 'break', 'continue',
  ]);

  const renderPyType = (node, optional = false) => {
    const { nullable, core } = splitNullable(node);
    let base = 'Any';
    if (core.kind === 'primitive') {
      if (core.type === 'string') base = 'str';
      else if (core.type === 'int') base = 'int';
      else if (core.type === 'float') base = 'float';
      else if (core.type === 'boolean') base = 'bool';
    } else if (core.kind === 'array') {
      base = ` list[${renderPyType(core.elem, false)}]`.trim();
    } else if (core.kind === 'object') {
      base = core.name;
    } else if (core.kind === 'union') {
      base = core.variants.map((v) => renderPyType(v, false)).join(' | ');
    }
    return optional || nullable ? `${base} | None` : base;
  };

  const blocks = ['from typing import Any\nfrom pydantic import BaseModel, Field'];
  // Dependencies must come BEFORE parent class in Python! `structs` is already post-order (children first)!
  for (const st of structs) {
    const lines = [`class ${st.name}(BaseModel):`];
    if (st.fields.length === 0) {
      lines.push('    pass');
    } else {
      for (const f of st.fields) {
        let pyField = toSnakeCase(f.key);
        const needsAlias = pyField !== f.key || PY_KEYWORDS.has(pyField);
        if (PY_KEYWORDS.has(pyField)) pyField += '_';
        const { nullable } = splitNullable(f.schema);
        const isOpt = f.optional || nullable;
        const typeStr = renderPyType(f.schema, f.optional);
        if (needsAlias) {
          const def = isOpt ? `Field(default=None, alias=${JSON.stringify(f.key)})` : `Field(alias=${JSON.stringify(f.key)})`;
          lines.push(`    ${pyField}: ${typeStr} = ${def}`);
        } else if (isOpt) {
          lines.push(`    ${pyField}: ${typeStr} = None`);
        } else {
          lines.push(`    ${pyField}: ${typeStr}`);
        }
      }
    }
    blocks.push(lines.join('\n'));
  }

  if (root.kind !== 'object') {
    blocks.push(`${toPascalCase(rootName)} = ${renderPyType(root, false)}`);
  }

  return blocks.join('\n\n\n');
}

/**
 * 4. Java (Lombok + Jackson) Classes Generator
 */
export function generateJava(value, rootName = 'RootObject') {
  const { structs } = inferSchema(value, rootName);

  const renderJavaType = (node, boxed = false) => {
    const { nullable, core } = splitNullable(node);
    const useBox = boxed || nullable;
    if (core.kind === 'primitive') {
      if (core.type === 'string') return 'String';
      if (core.type === 'int') return useBox ? 'Long' : 'long';
      if (core.type === 'float') return useBox ? 'Double' : 'double';
      if (core.type === 'boolean') return useBox ? 'Boolean' : 'boolean';
    }
    if (core.kind === 'array') return `List<${renderJavaType(core.elem, true)}>`;
    if (core.kind === 'object') return core.name;
    return 'Object';
  };

  if (structs.length === 0) {
    return '// 顶层需为 JSON 对象或包含对象的数组以生成 Java 类\npublic class RootObject {}';
  }

  const ordered = [...structs].reverse();
  const rootStruct = ordered[0];
  const innerStructs = ordered.slice(1);

  const lines = [
    'import com.fasterxml.jackson.annotation.JsonProperty;',
    'import lombok.Data;',
    'import java.util.List;',
    '',
    '@Data',
    `public class ${rootStruct.name} {`,
  ];

  for (const f of rootStruct.fields) {
    const camel = toCamelCase(f.key);
    if (camel !== f.key) {
      lines.push(`    @JsonProperty(${JSON.stringify(f.key)})`);
    }
    lines.push(`    private ${renderJavaType(f.schema, f.optional)} ${camel};`);
  }

  for (const st of innerStructs) {
    lines.push('');
    lines.push('    @Data');
    lines.push(`    public static class ${st.name} {`);
    for (const f of st.fields) {
      const camel = toCamelCase(f.key);
      if (camel !== f.key) {
        lines.push(`        @JsonProperty(${JSON.stringify(f.key)})`);
      }
      lines.push(`        private ${renderJavaType(f.schema, f.optional)} ${camel};`);
    }
    lines.push('    }');
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * 5. Rust (Serde) Structs Generator
 */
export function generateRust(value, rootName = 'RootObject') {
  const { root, structs } = inferSchema(value, rootName);
  const RUST_KW = new Set(['type', 'match', 'fn', 'let', 'mut', 'pub', 'mod', 'use', 'struct', 'enum', 'impl', 'trait', 'where', 'async', 'await', 'move', 'ref', 'self', 'Self', 'super', 'crate', 'in', 'for', 'loop', 'while', 'if', 'else', 'return']);

  const renderRustType = (node, optional = false) => {
    const { nullable, core } = splitNullable(node);
    let base = 'serde_json::Value';
    if (core.kind === 'primitive') {
      if (core.type === 'string') base = 'String';
      else if (core.type === 'int') base = 'i64';
      else if (core.type === 'float') base = 'f64';
      else if (core.type === 'boolean') base = 'bool';
    } else if (core.kind === 'array') {
      base = `Vec<${renderRustType(core.elem, false)}>`;
    } else if (core.kind === 'object') {
      base = core.name;
    }
    return optional || nullable ? `Option<${base}>` : base;
  };

  const blocks = ['use serde::{Deserialize, Serialize};'];
  const ordered = [...structs].reverse();
  for (const st of ordered) {
    const lines = [
      '#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]',
      `pub struct ${st.name} {`,
    ];
    for (const f of st.fields) {
      let snake = toSnakeCase(f.key);
      if (snake !== f.key) {
        lines.push(`    #[serde(rename = ${JSON.stringify(f.key)})]`);
      }
      if (RUST_KW.has(snake)) {
        snake = `r#${snake}`;
      }
      lines.push(`    pub ${snake}: ${renderRustType(f.schema, f.optional)},`);
    }
    lines.push('}');
    blocks.push(lines.join('\n'));
  }

  if (root.kind !== 'object') {
    blocks.push(`pub type ${toPascalCase(rootName)} = ${renderRustType(root, false)};`);
  }

  return blocks.join('\n\n');
}

/**
 * 6. JSON Schema (Draft 2020-12) Generator
 */
export function generateJsonSchema(value, title = 'RootSchema') {
  const build = (val) => {
    if (val === null) return { type: 'null' };
    if (typeof val === 'boolean') return { type: 'boolean' };
    if (typeof val === 'number') return { type: Number.isInteger(val) ? 'integer' : 'number' };
    if (typeof val === 'string') return { type: 'string' };
    if (Array.isArray(val)) {
      if (val.length === 0) return { type: 'array', items: {} };
      return { type: 'array', items: build(val[0]) };
    }
    if (typeof val === 'object') {
      const properties = {};
      const required = [];
      for (const [k, v] of Object.entries(val)) {
        properties[k] = build(v);
        if (v !== null && v !== undefined) required.push(k);
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }
    return {};
  };

  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title,
    ...build(value),
  };
  return JSON.stringify(schema, null, 2);
}

/**
 * 7. Clean YAML Serializer (zero external dependency)
 */
export function jsonToYaml(value) {
  const needsQuotes = (str) => {
    if (str === '') return true;
    if (/^\s|\s$/.test(str)) return true;
    if (/^(true|false|null|yes|no|on|off|~|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/i.test(str)) return true;
    if (/[:#{}[\],&*!|>'"%@`\n\r\t]/.test(str) || str.startsWith('-')) return true;
    return false;
  };

  const formatScalar = (val) => {
    if (val === null || val === undefined) return 'null';
    if (typeof val === 'boolean' || typeof val === 'number') return String(val);
    if (typeof val === 'string') {
      return needsQuotes(val) ? JSON.stringify(val) : val;
    }
    return JSON.stringify(val);
  };

  const serialize = (val, indent) => {
    const pad = '  '.repeat(indent);
    if (val === null || typeof val !== 'object') {
      return formatScalar(val);
    }

    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      return val
        .map((item) => {
          if (item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length > 0) {
            const entries = Object.entries(item);
            const [firstKey, firstVal] = entries[0];
            const firstKeyStr = needsQuotes(firstKey) ? JSON.stringify(firstKey) : firstKey;
            let head;
            if (firstVal !== null && typeof firstVal === 'object' && Object.keys(firstVal).length > 0) {
              head = `${pad}- ${firstKeyStr}:\n${serialize(firstVal, indent + 2)}`;
            } else {
              head = `${pad}- ${firstKeyStr}: ${serialize(firstVal, 0)}`;
            }
            const rest = entries.slice(1).map(([k, v]) => {
              const kStr = needsQuotes(k) ? JSON.stringify(k) : k;
              if (v !== null && typeof v === 'object' && Object.keys(v).length > 0) {
                return `${pad}  ${kStr}:\n${serialize(v, indent + 2)}`;
              }
              return `${pad}  ${kStr}: ${serialize(v, 0)}`;
            });
            return [head, ...rest].join('\n');
          }
          if (Array.isArray(item) && item.length > 0) {
            return `${pad}-\n${serialize(item, indent + 1)}`;
          }
          return `${pad}- ${serialize(item, 0)}`;
        })
        .join('\n');
    }

    const keys = Object.keys(val);
    if (keys.length === 0) return '{}';
    return keys
      .map((k) => {
        const v = val[k];
        const kStr = needsQuotes(k) ? JSON.stringify(k) : k;
        if (v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
          return `${pad}${kStr}:\n${serialize(v, indent + 1)}`;
        }
        return `${pad}${kStr}: ${serialize(v, 0)}`;
      })
      .join('\n');
  };

  return serialize(value, 0);
}

/**
 * 8. XML Converter
 */
export function jsonToXml(value, rootTag = 'root') {
  const escXml = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const safeTag = (name) => {
    const cleaned = String(name).replace(/[^A-Za-z0-9_.-]/g, '_');
    return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned || 'item'}`;
  };

  const toNode = (val, tag, indent) => {
    const pad = '  '.repeat(indent);
    const t = safeTag(tag);
    if (val === null || val === undefined) {
      return `${pad}<${t} xsi:nil="true"/>`;
    }
    if (typeof val !== 'object') {
      return `${pad}<${t}>${escXml(val)}</${t}>`;
    }
    if (Array.isArray(val)) {
      if (val.length === 0) return `${pad}<${t}/>`;
      return val.map((item) => toNode(item, tag === rootTag ? 'item' : tag, indent)).join('\n');
    }
    const entries = Object.entries(val);
    if (entries.length === 0) return `${pad}<${t}/>`;
    const children = entries
      .map(([k, v]) => {
        if (Array.isArray(v)) {
          return `${pad}  <${safeTag(k)}>\n${v.map((item) => toNode(item, 'item', indent + 2)).join('\n')}\n${pad}  </${safeTag(k)}>`;
        }
        return toNode(v, k, indent + 1);
      })
      .join('\n');
    return `${pad}<${t}>\n${children}\n${pad}</${t}>`;
  };

  const body = Array.isArray(value)
    ? `<${rootTag}>\n${value.map((item) => toNode(item, 'item', 1)).join('\n')}\n</${rootTag}>`
    : toNode(value, rootTag, 0);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

/**
 * 9. Discover tabular datasets (arrays of objects/primitives) anywhere inside JSON,
 * and export to CSV or Markdown Table!
 */
export function discoverTableDatasets(rootValue) {
  const datasets = [];

  const walk = (val, segments) => {
    if (Array.isArray(val) && val.length > 0) {
      const objCount = val.filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x)).length;
      const primCount = val.filter((x) => x === null || typeof x !== 'object').length;
      if (objCount > 0 || primCount > 0) {
        const path =
          segments.length === 0
            ? '$ (根数组)'
            : '$' +
              segments
                .map((s) => (typeof s === 'number' ? `[${s}]` : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`))
                .join('');
        datasets.push({
          path,
          segments,
          rows: val,
          rowCount: val.length,
          isObjectRows: objCount >= primCount,
        });
      }
      // Only recurse into first few elements if needed, up to depth 5
      if (segments.length < 4) {
        val.slice(0, 5).forEach((item, idx) => {
          if (item && typeof item === 'object') walk(item, [...segments, idx]);
        });
      }
    } else if (val !== null && typeof val === 'object') {
      // Also allow viewing a single root/nested object as a Key-Value table if no arrays exist!
      for (const [k, v] of Object.entries(val)) {
        if (segments.length < 6 && v !== null && typeof v === 'object') {
          walk(v, [...segments, k]);
        }
      }
    }
  };

  walk(rootValue, []);

  // Sort: prefer object-row arrays with more rows first
  datasets.sort((a, b) => {
    if (a.isObjectRows !== b.isObjectRows) return a.isObjectRows ? -1 : 1;
    return b.rowCount - a.rowCount;
  });

  // Fallback: if no arrays exist at all and root is an object, convert root key-values into rows!
  if (datasets.length === 0 && rootValue !== null && typeof rootValue === 'object' && !Array.isArray(rootValue)) {
    const kvRows = Object.entries(rootValue).map(([k, v]) => ({
      key: k,
      type: v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v,
      value: v,
    }));
    datasets.push({
      path: '$ (根对象属性表)',
      segments: [],
      rows: kvRows,
      rowCount: kvRows.length,
      isObjectRows: true,
      isKeyValueFallback: true,
    });
  }

  return datasets;
}

export function extractTableModel(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { columns: [], records: [] };
  }
  const hasObjects = rows.some((r) => r !== null && typeof r === 'object' && !Array.isArray(r));
  if (!hasObjects) {
    return {
      columns: ['index', 'value'],
      records: rows.map((v, i) => ({ index: i, value: v })),
    };
  }

  const colSet = new Set();
  for (const r of rows) {
    if (r !== null && typeof r === 'object' && !Array.isArray(r)) {
      for (const k of Object.keys(r)) colSet.add(k);
    } else {
      colSet.add('_value');
    }
  }
  const columns = [...colSet];
  const records = rows.map((r) => {
    if (r !== null && typeof r === 'object' && !Array.isArray(r)) return r;
    return { _value: r };
  });
  return { columns, records };
}

export function tableToCsv(columns, records) {
  const escCsv = (val) => {
    if (val === undefined || val === null) return '';
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = columns.map(escCsv).join(',');
  const body = records.map((row) => columns.map((col) => escCsv(row[col])).join(','));
  return [header, ...body].join('\n');
}

export function tableToMarkdown(columns, records) {
  const escMd = (val) => {
    if (val === undefined || val === null) return '';
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return str.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  };
  const header = `| ${columns.map(escMd).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = records.map((row) => `| ${columns.map((col) => escMd(row[col])).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}
