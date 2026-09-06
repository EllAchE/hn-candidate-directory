import assert from 'node:assert/strict';
import { test } from 'node:test';

import { needsOcr, renderStructured } from '../scripts/extract-hn-profiles/hn-pdf-text.mjs';

function inspector({ pdfType = 'TextBased', pages = [] } = {}) {
  return async () => ({
    classifyPdfAsync: async () => ({ pdfType, pageCount: pages.length }),
    extractPagesMarkdownAsync: async () => ({ pages })
  });
}

test('joins page markdown in order', async () => {
  const result = await renderStructured(Buffer.from('%PDF-'), {
    importInspector: inspector({
      pages: [
        { page: 0, markdown: '# Experience', needsOcr: false },
        { page: 1, markdown: '# Education', needsOcr: false }
      ]
    })
  });

  assert.equal(result.text, '# Experience\n\n# Education');
  assert.equal(result.documentType, 'TextBased');
  assert.equal(result.pageCount, 2);
  assert.equal(result.reason, null);
});

test('reports pages needing OCR one-indexed, as a viewer counts them', async () => {
  const result = await renderStructured(Buffer.from('%PDF-'), {
    importInspector: inspector({
      pdfType: 'Mixed',
      pages: [
        { page: 0, markdown: '# Experience', needsOcr: false },
        { page: 1, markdown: '', needsOcr: true }
      ]
    })
  });

  assert.deepEqual(result.pagesNeedingOcr, [2]);
});

// The binding is native and per-platform. A checkout that never installed it must degrade to
// pdftotext, not fail the run.
test('a missing binding is a reason, not a throw', async () => {
  const result = await renderStructured(Buffer.from('%PDF-'), { importInspector: async () => null });

  assert.equal(result.text, null);
  assert.equal(result.reason, 'inspector_unavailable');
  assert.deepEqual(result.pagesNeedingOcr, []);
});

test('a throwing inspector is a reason, not a throw', async () => {
  const result = await renderStructured(Buffer.from('%PDF-'), {
    importInspector: async () => ({
      classifyPdfAsync: async () => {
        throw new Error('corrupt xref');
      },
      extractPagesMarkdownAsync: async () => ({ pages: [] })
    })
  });

  assert.equal(result.text, null);
  assert.equal(result.reason, 'inspector_failed');
});

test('whitespace-only markdown reads as no text', async () => {
  const result = await renderStructured(Buffer.from('%PDF-'), {
    importInspector: inspector({ pages: [{ page: 0, markdown: '   \n  ', needsOcr: false }] })
  });

  assert.equal(result.text, null);
});

test('a scanned or image document needs OCR whatever its pages report', () => {
  assert.equal(needsOcr('Scanned', [], 3), true);
  assert.equal(needsOcr('ImageBased', [], 1), true);
});

// A resume whose every page lacks a text layer will not read on a retry; one bad page among
// several still leaves enough to extract from.
test('every page needing OCR is a miss, but one page is not', () => {
  assert.equal(needsOcr('Mixed', [1, 2], 2), true);
  assert.equal(needsOcr('Mixed', [2], 2), false);
  assert.equal(needsOcr('TextBased', [], 2), false);
});
