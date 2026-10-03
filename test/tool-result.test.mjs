import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeAdjacentTextContent } from '../build/tool-result.js';

test('joins a metadata block and a body block into one text block', () => {
  const result = {
    content: [
      { type: 'text', text: '{"document":{"title":"Styleguide"}}' },
      { type: 'text', text: '# Styleguide\n\nBody.' },
    ],
  };

  assert.deepEqual(mergeAdjacentTextContent(result), {
    content: [{ type: 'text', text: '{"document":{"title":"Styleguide"}}\n\n# Styleguide\n\nBody.' }],
  });
});

test('joins one block per row from list tools', () => {
  const result = { content: ['{"id":1}', '{"id":2}', '{"id":3}'].map((text) => ({ type: 'text', text })) };

  assert.deepEqual(mergeAdjacentTextContent(result).content, [{ type: 'text', text: '{"id":1}\n\n{"id":2}\n\n{"id":3}' }]);
});

test('keeps non-text blocks in place and only joins adjacent text', () => {
  const image = { type: 'image', data: 'abc', mimeType: 'image/png' };
  const result = {
    content: [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      image,
      { type: 'text', text: 'c' },
    ],
  };

  assert.deepEqual(mergeAdjacentTextContent(result).content, [{ type: 'text', text: 'a\n\nb' }, image, { type: 'text', text: 'c' }]);
});

test('preserves the other result fields', () => {
  const result = {
    content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    structuredContent: { ok: true },
    isError: false,
  };

  const merged = mergeAdjacentTextContent(result);

  assert.deepEqual(merged.structuredContent, { ok: true });
  assert.equal(merged.isError, false);
});

test('does not join text blocks that carry annotations or metadata', () => {
  const result = {
    content: [
      { type: 'text', text: 'a', annotations: { audience: ['user'] } },
      { type: 'text', text: 'b' },
    ],
  };

  assert.equal(mergeAdjacentTextContent(result), result);
});

test('returns results with nothing to join unchanged', () => {
  const single = { content: [{ type: 'text', text: 'only' }] };
  const noContent = { toolResult: 'legacy' };

  assert.equal(mergeAdjacentTextContent(single), single);
  assert.equal(mergeAdjacentTextContent(noContent), noContent);
  assert.equal(mergeAdjacentTextContent(undefined), undefined);
});
