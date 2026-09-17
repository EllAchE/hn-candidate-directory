import assert from 'node:assert/strict';
import { test } from 'node:test';

import { needsOcr, renderStructured, respaceEmphasis } from '../scripts/extract-hn-profiles/hn-pdf-text.mjs';

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

// The inspector drops the space around an emphasis run wherever the PDF's own text runs abut,
// and a resume bolds exactly the words that must not merge: the school welds to the city, the
// title welds to its date range.
test('a bold span welded to the next word gets its boundary back', () => {
  assert.equal(
    respaceEmphasis('**College of Engineering**Tumkur, India'),
    '**College of Engineering** Tumkur, India'
  );
  assert.equal(
    respaceEmphasis('Engineer with**4+ years**building things'),
    'Engineer with **4+ years** building things'
  );
});

// `**Software Engineer III***July 2024 - Present*` is one run of three asterisks doing two jobs.
test('a three-asterisk run closes the bold and opens the italic', () => {
  assert.equal(
    respaceEmphasis('**Software Engineer III***July 2024 - Present*'),
    '**Software Engineer III** *July 2024 - Present*'
  );
});

test('a matched three-asterisk span stays intact', () => {
  assert.equal(respaceEmphasis('***Engineering lead***Tumkur'), '***Engineering lead*** Tumkur');
});

test('nested emphasis keeps its delimiter depth', () => {
  assert.equal(
    respaceEmphasis('**Engineering *and research* lead**Tumkur'),
    '**Engineering *and research* lead** Tumkur'
  );
});

// A closing run may legitimately hug a comma; only a word re-opening behind it is a weld.
test('punctuation hugging a run is left alone', () => {
  assert.equal(respaceEmphasis('**Google ADK**, and Gemini'), '**Google ADK**, and Gemini');
  assert.equal(respaceEmphasis('**ADK**,**vector search**'), '**ADK**, **vector search**');
});

test('a leading list marker is not emphasis', () => {
  assert.equal(respaceEmphasis('* Built a **thing**quickly'), '* Built a **thing** quickly');
});

// The transform inserts spaces and does nothing else: no character of content is added, dropped,
// or reordered, and no emphasis marker changes count.
test('re-spacing preserves every character of content and every marker', () => {
  const source = '**Sabre Corporation** Bengaluru, India **Software Engineer III***July 2024*\n'
    + '- Built a**production RAG backend**using**Python**, achieving**90% Precision@k**.';
  const out = respaceEmphasis(source);
  const strip = (value) => value.replace(/[*\s]+/g, '');
  assert.equal(strip(out), strip(source));
  assert.equal((out.match(/\*/g) || []).length, (source.match(/\*/g) || []).length);
});

test('page markdown arrives re-spaced', async () => {
  const result = await renderStructured(Buffer.from('%PDF-'), {
    importInspector: inspector({
      pages: [{ page: 0, markdown: '**Ain Shams University**Cairo, Egypt', needsOcr: false }]
    })
  });

  assert.equal(result.text, '**Ain Shams University** Cairo, Egypt');
});
