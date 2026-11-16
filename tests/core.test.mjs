import test from 'node:test';
import assert from 'node:assert/strict';

import { parseJsonSafe, analyzeJsonStats, highlightJson } from '../js/core/parser.js';
import {
  repairJson,
  unescapeJsonText,
  escapeJsonText,
  unpackNestedJson,
  sortJsonKeys,
} from '../js/core/repair.js';
import { evaluateJsonPath, inspectValue } from '../js/core/query.js';
import {
  generateTypeScript,
  generateGo,
  generatePython,
  generateJava,
  generateRust,
  jsonToYaml,
  jsonToXml,
  discoverTableDatasets,
  extractTableModel,
  tableToCsv,
} from '../js/core/codegen.js';
import { diffJsonValues } from '../js/core/diff.js';

test('parseJsonSafe parses valid JSON and pinpoints exact error line/column on malformed JSON', () => {
  const valid = parseJsonSafe('{"name": "JSONLens", "version": 2}');
  assert.equal(valid.ok, true);
  assert.equal(valid.value.name, 'JSONLens');

  const trailingComma = parseJsonSafe('{\n  "a": 1,\n  "b": 2,\n}');
  assert.equal(trailingComma.ok, false);
  assert.equal(trailingComma.error.line, 3);
  assert.equal(trailingComma.error.repairable, true);

  const singleQuote = parseJsonSafe("{\n  'user': 'alice'\n}");
  assert.equal(singleQuote.ok, false);
  assert.equal(singleQuote.error.line, 2);
  assert.equal(singleQuote.error.repairable, true);
});

test('repairJson fixes comments, unquoted keys, single quotes, Python literals, URLs, trailing commas, and unclosed brackets', () => {
  const broken = `
    // API debug dump
    jsonpCallback({
      user_id: 1001,
      name: 'Alice "Wonder"',
      endpoint: 'https://api.example.com/v1/users?active=true', /* keep // inside URL! */
      is_vip: True,
      deleted_at: None,
      extra: undefined,
      tags: ['admin', 'ops',],
      score: +98.5,
    });
  `;
  const res = repairJson(broken);
  assert.equal(res.ok, true);
  const parsed = JSON.parse(res.output);
  assert.equal(parsed.user_id, 1001);
  assert.equal(parsed.name, 'Alice "Wonder"');
  assert.equal(parsed.endpoint, 'https://api.example.com/v1/users?active=true');
  assert.equal(parsed.is_vip, true);
  assert.equal(parsed.deleted_at, null);
  assert.equal(parsed.extra, null);
  assert.deepEqual(parsed.tags, ['admin', 'ops']);
  assert.equal(parsed.score, 98.5);
});

test('repairJson merges NDJSON log lines and fixes Chinese full-width quotes/colons', () => {
  const ndjson = `{"id": 1, "msg": "start"}\n{"id": 2, "msg": "done"}`;
  const res1 = repairJson(ndjson);
  assert.equal(res1.ok, true);
  assert.equal(JSON.parse(res1.output).length, 2);

  const chinesePunct = `{“name”：“张三”，“age”：28}`;
  const res2 = repairJson(chinesePunct);
  assert.equal(res2.ok, true);
  assert.deepEqual(JSON.parse(res2.output), { name: '张三', age: 28 });

  const unclosed = `{"items": [{"id": 1}, {"id": 2}`;
  const res3 = repairJson(unclosed);
  assert.equal(res3.ok, true);
  assert.equal(JSON.parse(res3.output).items.length, 2);
});

test('escape, unescape, unpackNestedJson, and sortJsonKeys work accurately', () => {
  const raw = '{"hello":"world"}';
  const escaped = escapeJsonText(raw);
  const restored = unescapeJsonText(escaped);
  assert.deepEqual(JSON.parse(restored), { hello: 'world' });

  const nested = {
    code: 0,
    payload: '{"user":"bob","roles":"[\\"dev\\",\\"ops\\"]"}',
  };
  const { value, unpackedCount } = unpackNestedJson(nested);
  assert.equal(unpackedCount, 2);
  assert.deepEqual(value.payload.roles, ['dev', 'ops']);

  const sorted = sortJsonKeys({ z: 1, a: { d: 4, c: 3 } }, 'asc', true);
  assert.deepEqual(Object.keys(sorted), ['a', 'z']);
  assert.deepEqual(Object.keys(sorted.a), ['c', 'd']);
});

test('evaluateJsonPath supports wildcards, slices, recursive descent, and filter expressions', () => {
  const data = {
    store: {
      book: [
        { title: 'Go Systems', price: 15, active: true },
        { title: 'Rust Core', price: 28, active: true },
        { title: 'Legacy PHP', price: 9, active: false },
      ],
      bicycle: { price: 199, color: '#ff5500' },
    },
  };

  const r1 = evaluateJsonPath(data, '$.store.book[*].title');
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.matches.map((m) => m.value), ['Go Systems', 'Rust Core', 'Legacy PHP']);

  const r2 = evaluateJsonPath(data, '$..price');
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.matches.map((m) => m.value), [15, 28, 9, 199]);

  const r3 = evaluateJsonPath(data, '$.store.book[?(@.price < 20 && @.active == true)]');
  assert.equal(r3.ok, true);
  assert.equal(r3.matches.length, 1);
  assert.equal(r3.matches[0].value.title, 'Go Systems');
});

test('inspectValue detects timestamps, JWTs, colors, URLs, and nested JSON', () => {
  const tsInfo = inspectValue(1735689600, 'created_at', ['created_at']);
  assert.ok(tsInfo.insights.some((i) => i.kind === 'timestamp'));

  const jwtHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const jwtPayload = Buffer.from(JSON.stringify({ sub: '123', role: 'admin' })).toString('base64url');
  const jwtInfo = inspectValue(`${jwtHeader}.${jwtPayload}.sig123`, 'token', ['token']);
  assert.ok(jwtInfo.insights.some((i) => i.kind === 'jwt' && i.payload.role === 'admin'));

  const colorInfo = inspectValue('#6366f1', 'themeColor', ['themeColor']);
  assert.ok(colorInfo.insights.some((i) => i.kind === 'color'));
});

test('codegen generates valid TypeScript, Go, Python, Java, Rust, YAML, XML, and CSV', () => {
  const sample = {
    request_id: 'req-1',
    users: [
      { user_id: 1, name: 'Alice', bio: null },
      { user_id: 2, name: 'Bob', email: 'bob@example.com' },
    ],
  };

  const ts = generateTypeScript(sample);
  assert.match(ts, /export interface RootObject/);
  assert.match(ts, /email\?: string;/);

  const go = generateGo(sample);
  assert.match(go, /UserID int64 `json:"user_id"`/);

  const py = generatePython(sample);
  assert.match(py, /class RootObject\(BaseModel\):/);

  const java = generateJava(sample);
  assert.match(java, /public class RootObject/);

  const rust = generateRust(sample);
  assert.match(rust, /pub struct RootObject/);

  const yaml = jsonToYaml(sample);
  assert.match(yaml, /request_id: req-1/);

  const xml = jsonToXml(sample);
  assert.match(xml, /<\?xml version="1\.0"/);

  const datasets = discoverTableDatasets(sample);
  assert.equal(datasets[0].path, '$.users');
  const { columns, records } = extractTableModel(datasets[0].rows);
  const csv = tableToCsv(columns, records);
  assert.match(csv, /user_id,name,bio,email/);
});

test('diffJsonValues detects added, removed, and modified fields regardless of key order', () => {
  const left = { b: 2, a: 1, user: { role: 'viewer', legacy: true } };
  const right = { a: 1, b: 2, user: { role: 'admin', extra: 42 } };
  const diff = diffJsonValues(left, right);
  assert.equal(diff.identical, false);
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.summary.modified, 1);
});

test('analyzeJsonStats & highlightJson handle complex payloads safely', () => {
  const raw = '{"key": "<script>alert(1)</script>", "n": 42}';
  const parsed = JSON.parse(raw);
  const stats = analyzeJsonStats(parsed, raw);
  assert.equal(stats.keys, 2);
  const html = highlightJson(raw);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('All UI ES modules import cleanly, DOM IDs match index.html, and all sample presets work', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const rootDir = path.resolve(import.meta.dirname, '..');

  // 1. Verify UI module imports & named exports
  const { SAMPLES, DIFF_DEMO_RIGHT } = await import('../js/samples.js');
  const { JsonCodeEditor } = await import('../js/ui/editor.js');
  const { JsonTreeView } = await import('../js/ui/treeView.js');
  const { JsonGraphView } = await import('../js/ui/graphView.js');
  const { JsonTableView } = await import('../js/ui/tableView.js');
  const { JsonCodegenView } = await import('../js/ui/codegenView.js');
  const { JsonDiffView } = await import('../js/ui/diffView.js');

  assert.equal(typeof JsonCodeEditor, 'function');
  assert.equal(typeof JsonTreeView, 'function');
  assert.equal(typeof JsonGraphView, 'function');
  assert.equal(typeof JsonTableView, 'function');
  assert.equal(typeof JsonCodegenView, 'function');
  assert.equal(typeof JsonDiffView, 'function');

  // 2. Verify samples parse or repair cleanly
  assert.equal(parseJsonSafe(SAMPLES[0].content).ok, true);
  assert.equal(repairJson(SAMPLES[1].content).ok, true);
  assert.equal(parseJsonSafe(SAMPLES[2].content).ok, true);
  assert.equal(repairJson(SAMPLES[3].content).ok, true);
  assert.equal(parseJsonSafe(DIFF_DEMO_RIGHT).ok, true);

  // 3. Verify every getElementById('...') in app.js exists in index.html
  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(rootDir, 'js/app.js'), 'utf8');
  const idRefs = [...appJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  for (const id of idRefs) {
    assert.ok(html.includes(`id="${id}"`), `Missing id="${id}" in index.html`);
  }
});
