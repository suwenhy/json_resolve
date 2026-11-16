/**
 * JSONLens Structural JSON Diff Engine
 * Compares two JSON values semantically by path (independent of formatting or key order).
 */

import { formatPath } from './query.js';

function getKind(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val; // 'object' | 'string' | 'number' | 'boolean'
}

/**
 * Deep structural comparison of two parsed JSON values.
 * @param {any} left
 * @param {any} right
 * @param {{ ignoreArrayOrder?: boolean }} options
 */
export function diffJsonValues(left, right, options = {}) {
  const { ignoreArrayOrder = false } = options;
  const changes = [];
  const summary = {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 0,
  };

  const canonicalize = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      const items = v.map(canonicalize);
      if (ignoreArrayOrder) items.sort();
      return `[${items.join(',')}]`;
    }
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`;
  };

  const walk = (l, r, segments) => {
    const lKind = getKind(l);
    const rKind = getKind(r);
    const { jsonPath } = formatPath(segments);

    if (lKind !== rKind) {
      summary.modified++;
      changes.push({
        kind: 'type-changed',
        segments,
        jsonPath,
        leftType: lKind,
        rightType: rKind,
        leftValue: l,
        rightValue: r,
      });
      return;
    }

    if (lKind === 'object') {
      const allKeys = [...new Set([...Object.keys(l), ...Object.keys(r)])].sort();
      if (allKeys.length === 0) {
        summary.unchanged++;
        return;
      }
      for (const k of allKeys) {
        const hasL = Object.prototype.hasOwnProperty.call(l, k);
        const hasR = Object.prototype.hasOwnProperty.call(r, k);
        const childSegs = [...segments, k];
        const childPath = formatPath(childSegs).jsonPath;
        if (hasL && !hasR) {
          summary.removed++;
          changes.push({
            kind: 'removed',
            segments: childSegs,
            jsonPath: childPath,
            leftValue: l[k],
            rightValue: undefined,
          });
        } else if (!hasL && hasR) {
          summary.added++;
          changes.push({
            kind: 'added',
            segments: childSegs,
            jsonPath: childPath,
            leftValue: undefined,
            rightValue: r[k],
          });
        } else {
          walk(l[k], r[k], childSegs);
        }
      }
      return;
    }

    if (lKind === 'array') {
      if (l.length === 0 && r.length === 0) {
        summary.unchanged++;
        return;
      }
      if (ignoreArrayOrder) {
        const lMap = new Map();
        const rMap = new Map();
        l.forEach((item, idx) => {
          const sig = canonicalize(item);
          if (!lMap.has(sig)) lMap.set(sig, []);
          lMap.get(sig).push({ item, idx });
        });
        r.forEach((item, idx) => {
          const sig = canonicalize(item);
          if (!rMap.has(sig)) rMap.set(sig, []);
          rMap.get(sig).push({ item, idx });
        });

        for (const [sig, lItems] of lMap.entries()) {
          const rItems = rMap.get(sig) || [];
          const common = Math.min(lItems.length, rItems.length);
          summary.unchanged += common;
          for (let i = common; i < lItems.length; i++) {
            const segs = [...segments, lItems[i].idx];
            summary.removed++;
            changes.push({
              kind: 'removed',
              segments: segs,
              jsonPath: formatPath(segs).jsonPath,
              leftValue: lItems[i].item,
              rightValue: undefined,
            });
          }
        }
        for (const [sig, rItems] of rMap.entries()) {
          const lItems = lMap.get(sig) || [];
          const common = Math.min(lItems.length, rItems.length);
          for (let i = common; i < rItems.length; i++) {
            const segs = [...segments, rItems[i].idx];
            summary.added++;
            changes.push({
              kind: 'added',
              segments: segs,
              jsonPath: formatPath(segs).jsonPath,
              leftValue: undefined,
              rightValue: rItems[i].item,
            });
          }
        }
        return;
      }

      const maxLen = Math.max(l.length, r.length);
      for (let i = 0; i < maxLen; i++) {
        const childSegs = [...segments, i];
        const childPath = formatPath(childSegs).jsonPath;
        if (i >= r.length) {
          summary.removed++;
          changes.push({
            kind: 'removed',
            segments: childSegs,
            jsonPath: childPath,
            leftValue: l[i],
            rightValue: undefined,
          });
        } else if (i >= l.length) {
          summary.added++;
          changes.push({
            kind: 'added',
            segments: childSegs,
            jsonPath: childPath,
            leftValue: undefined,
            rightValue: r[i],
          });
        } else {
          walk(l[i], r[i], childSegs);
        }
      }
      return;
    }

    // Primitives & null
    if (Object.is(l, r)) {
      summary.unchanged++;
    } else {
      summary.modified++;
      changes.push({
        kind: 'modified',
        segments,
        jsonPath,
        leftValue: l,
        rightValue: r,
      });
    }
  };

  walk(left, right, []);

  return {
    identical: changes.length === 0,
    summary,
    changes,
  };
}
