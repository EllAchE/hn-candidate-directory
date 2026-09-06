// Resume PDFs are read for structure, not for character count. `pdftotext` returns an
// undifferentiated wall of text; the inspector returns markdown, and its headings and bullets are
// what let the extractor attach a date range to the right employer. Measured on two corpus
// resumes: the two agree on text volume within 4%, and the markdown carries 8 and 9 headings
// where pdftotext carries none.
//
// The second reason is diagnosis. A scanned resume yields almost no text either way and used to
// arrive as `too_thin` — the same reason a permission wall produces — so the one document type
// that genuinely needs a different tool was indistinguishable from a blocked fetch.

const INSPECTOR = '@firecrawl/pdf-inspector';

// The inspector ships a native binding per platform. A checkout that has not installed it, or a
// platform it has no prebuild for, degrades to `pdftotext` rather than failing the run.
async function importInspector() {
  try {
    return await import(INSPECTOR);
  } catch {
    return null;
  }
}

export async function renderStructured(bytes, deps = {}) {
  const load = deps.importInspector || importInspector;
  const inspector = await load();
  if (!inspector) return { text: null, documentType: null, pagesNeedingOcr: [], pageCount: 0, reason: 'inspector_unavailable' };

  let classification;
  let extraction;
  try {
    [classification, extraction] = await Promise.all([
      inspector.classifyPdfAsync(bytes),
      inspector.extractPagesMarkdownAsync(bytes)
    ]);
  } catch {
    return { text: null, documentType: null, pagesNeedingOcr: [], pageCount: 0, reason: 'inspector_failed' };
  }

  const pages = extraction?.pages || [];
  // The library reports pages 0-indexed; everything downstream of here, including the miss
  // reasons an operator reads, counts from 1 the way a viewer does.
  const pagesNeedingOcr = pages.filter((page) => page.needsOcr).map((page) => page.page + 1);
  const text = pages
    .map((page) => page.markdown || '')
    .join('\n\n')
    .trim();

  return {
    text: text || null,
    documentType: classification?.pdfType || null,
    pagesNeedingOcr,
    pageCount: pages.length,
    reason: null
  };
}

// A document the inspector classified as having no usable text layer. Worth its own miss reason:
// re-fetching will never fix it, and it is the case a future OCR pass would pick up.
export function needsOcr(documentType, pagesNeedingOcr, pageCount) {
  if (documentType === 'Scanned' || documentType === 'ImageBased') return true;
  return pagesNeedingOcr.length > 0 && pagesNeedingOcr.length === pageCount;
}
