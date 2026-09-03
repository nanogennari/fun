/**
 * Wiring tests -- the checks that catch "the page loads but nothing works".
 *
 * These exist because a refactor once deleted two functions that app.js
 * imported. A missing named export does not fail loudly: the whole ES module
 * graph silently refuses to link, so *no* JavaScript runs, every value on
 * screen stays at its static HTML default and every button is dead. Nothing in
 * the unit tests noticed, because they only ever imported protocol.js and
 * store.js directly.
 *
 * So: verify that every import actually resolves, and that every DOM handle the
 * controller reaches for actually exists.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const JS_DIR = resolve(here, '../public/js');
const HTML = readFileSync(resolve(here, '../public/index.html'), 'utf8');

const jsFiles = readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));

/** Extract `import { a, b as c } from './x.js'` plus default/namespace forms. */
function parseImports(src) {
  const out = [];
  const re = /import\s+([\s\S]*?)\s+from\s+'([^']+)'/g;
  for (const [, clause, spec] of src.matchAll(re)) {
    if (!spec.startsWith('.')) continue; // bare specifiers are not ours to check
    const named = [];
    const braced = clause.match(/\{([\s\S]*?)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const nameRaw = part.trim();
        if (!nameRaw) continue;
        named.push(nameRaw.split(/\s+as\s+/)[0].trim());
      }
    }
    const hasDefault = /^\s*[A-Za-z_$][\w$]*\s*(,|$)/.test(clause.replace(/\{[\s\S]*?\}/, ''));
    out.push({ spec, named, hasDefault });
  }
  return out;
}

test('every named import resolves to a real export', async () => {
  let checked = 0;
  for (const file of jsFiles) {
    const src = readFileSync(join(JS_DIR, file), 'utf8');
    for (const imp of parseImports(src)) {
      const target = resolve(JS_DIR, imp.spec);
      const ns = await import(pathToFileURL(target).href);
      for (const name of imp.named) {
        assert.ok(
          name in ns,
          `${file} imports { ${name} } from '${imp.spec}', but that module does not export it. ` +
          `Available: ${Object.keys(ns).sort().join(', ')}`,
        );
        checked++;
      }
      if (imp.hasDefault) {
        assert.ok('default' in ns, `${file} imports a default from '${imp.spec}', which has none`);
      }
    }
  }
  assert.ok(checked > 0, 'parsed no imports at all -- the parser is broken');
});

test('every getElementById in app.js exists in index.html', () => {
  const src = readFileSync(join(JS_DIR, 'app.js'), 'utf8');
  const ids = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...src.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, 'found no getElementById calls -- the parser is broken');
  const missing = refs.filter((r) => !ids.has(r));
  assert.deepEqual(missing, [], `app.js reaches for ids absent from index.html: ${missing.join(', ')}`);
});

test('every data-role queried by app.js exists in the probe template', () => {
  const src = readFileSync(join(JS_DIR, 'app.js'), 'utf8');
  const tpl = HTML.slice(HTML.indexOf('<template id="probe-card-template">'));
  const present = new Set([...tpl.matchAll(/data-role="([^"]+)"/g)].map((m) => m[1]));
  // Two ways app.js reaches a role: the q('x') helper, and a literal selector.
  // Selectors built from a template placeholder -- [data-role="${role}"] -- are
  // the helper's own definition and carry no role name to check, so drop them.
  const used = new Set([
    ...[...src.matchAll(/\bq\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...src.matchAll(/\[data-role="([a-z][a-z-]*)"\]/g)].map((m) => m[1]),
  ]);
  const missing = [...used].filter((u) => !present.has(u));
  assert.deepEqual(missing, [], `app.js queries data-roles absent from the template: ${missing.join(', ')}`);
});

test('no module reaches for the DOM at import time', async () => {
  // app.js legitimately does (it is the entry point and is never imported by
  // anything). Every other module must stay importable in a plain JS runtime,
  // which is what lets the tests above link them at all.
  for (const file of jsFiles.filter((f) => f !== 'app.js')) {
    const src = readFileSync(join(JS_DIR, file), 'utf8');
    // crude but effective: top-level (column-0) statements touching document/window
    const bad = src
      .split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /^(const|let|var|document\.|window\.)/.test(l) && /\b(document|window)\./.test(l));
    assert.deepEqual(
      bad.map(([n]) => n), [],
      `${file} touches the DOM at module scope (line ${bad.map(([n]) => n).join(', ')}), which breaks importability`,
    );
  }
});

test('flex pills that are wider than their content must centre it', () => {
  // Reported from a real phone: the "?" and "°C" chips had their glyphs shoved
  // left. .chip is inline-flex with a min-width, so for short labels the pill
  // is wider than its content and all the slack lands on one side. A button's
  // default text-align: center does not help, because flex layout ignores it.
  const css = readFileSync(resolve(here, '../public/styles.css'), 'utf8');
  const block = css.slice(css.indexOf('.chip {'));
  const rule = block.slice(0, block.indexOf('}'));
  assert.match(
    rule, /justify-content:\s*center/,
    '.chip sets min-width and inline-flex, so it must also set justify-content: center',
  );
});
