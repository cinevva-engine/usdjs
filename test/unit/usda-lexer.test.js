import test from 'node:test';
import assert from 'node:assert/strict';

import { UsdaLexer } from '../../dist/index.js';

function lexAll(src, opts) {
  const lex = new UsdaLexer(src, opts);
  const out = [];
  while (true) {
    const t = lex.next();
    out.push(t);
    if (t.kind === 'eof') break;
  }
  return out;
}

test('USDA lexer: skips whitespace and comments', () => {
  const toks = lexAll(`# comment
def Xform "World" {
  token purpose = "proxy" # trailing
}
`);
  const ids = toks.filter(t => t.kind === 'identifier').map(t => t.value);
  assert.deepEqual(ids.slice(0, 4), ['def', 'Xform', 'token', 'purpose']);
});

test('USDA lexer: strings and @paths@', () => {
  const toks = lexAll(`string name = "hello"
asset tex = @textures/albedo.png@
`);
  const strings = toks.filter(t => t.kind === 'string').map(t => t.value);
  assert.ok(strings.includes('hello'));
  const paths = toks.filter(t => t.kind === 'path').map(t => t.value);
  assert.deepEqual(paths, ['textures/albedo.png']);
});

test('USDA lexer: <SdfPath> literals', () => {
  const toks = lexAll(`rel material:binding = </World/Looks/Mat>
`);
  const sdfpaths = toks.filter(t => t.kind === 'sdfpath').map(t => t.value);
  assert.deepEqual(sdfpaths, ['/World/Looks/Mat']);
});

test('USDA lexer: numbers', () => {
  const toks = lexAll(`float a = 1
float b = -2.5
float c = 3.0e-2
`);
  const nums = toks.filter(t => t.kind === 'number').map(t => t.value);
  assert.deepEqual(nums, ['1', '-2.5', '3.0e-2']);
});


