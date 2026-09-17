// Resume PDFs are read for structure, not for character count. `pdftotext` returns an
// undifferentiated wall of text; the inspector returns markdown with headings and bullets.
// Measured on two corpus resumes: the two agree on text volume within 4%, and the markdown
// carries 8 and 9 headings where pdftotext carries none.
//
// What that structure buys is narrower than it looks. An A/B on those same two resumes had the
// extractor score identically on employers under both renderings (3/3 and 1/1), and pdftotext
// won on dates and on picking the resume link. Headings are worth having, but do not claim they
// are what attaches a date range to the right employer — that was measured and it is not true.
//
// The reason that does hold up is diagnosis. A scanned resume yields almost no text either way
// and used to arrive as `too_thin` — the same reason a permission wall produces — so the one
// document type that genuinely needs a different tool was indistinguishable from a blocked
// fetch. `classifyPdfAsync` separates them.

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

const RUN = /\*{1,3}/g;
// Punctuation that legitimately hugs an opening run, so no space is inserted after it.
const HUGS_OPENER = new RegExp('[\\s([{"\'`*_/-]');

// The inspector emits an emphasis run with no surrounding space wherever the PDF's own text runs
// abut, and a resume's bold is exactly on the words that matter:
// `**College of Engineering**Tumkur, India` welds the school to the city, and
// `**Software Engineer III***July 2024` welds a title to its date range. Measured on the corpus,
// one of the two resumes carried 49 such welds and the other none. The markers themselves are
// noise to the extractor; the word boundary they swallow is not, so put the boundary back
// without adding or removing a single character of content.
function respaceLine(line) {
  // A leading `*` is a list marker, not emphasis. Step over it before tracking spans.
  const bullet = line.match(/^(\s*[*+-]\s+)/);
  const head = bullet ? bullet[1] : '';
  const body = line.slice(head.length);

  let out = '';
  let last = 0;
  let openRun = 0;
  let match;
  RUN.lastIndex = 0;
  while ((match = RUN.exec(body)) !== null) {
    const run = match[0];
    const before = body.slice(last, match.index);
    const prev = (before || out).slice(-1);
    const next = body.slice(match.index + run.length, match.index + run.length + 1);
    out += before;

    if (openRun === 0) {
      if (prev && !HUGS_OPENER.test(prev)) out += ' ';
      out += run;
      openRun = run.length;
    } else if (!prev || HUGS_OPENER.test(prev)) {
      out += run;
      openRun += run.length;
    } else {
      const closingLength = Math.min(openRun, run.length);
      out += '*'.repeat(closingLength);
      openRun -= closingLength;

      const reopeningLength = run.length - closingLength;
      if (reopeningLength > 0) {
        if (next && !/\s/.test(next)) out += ' ';
        out += '*'.repeat(reopeningLength);
        openRun += reopeningLength;
      }
      // A closing run may legitimately hug a comma or period; only a word re-opening behind it
      // is a weld.
      if (reopeningLength === 0 && next && /[\w([]/.test(next)) out += ' ';
    }
    last = match.index + run.length;
  }
  return head + out + body.slice(last);
}

export function respaceEmphasis(markdown) {
  return String(markdown || '')
    .split('\n')
    .map(respaceLine)
    .join('\n');
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
    .map((page) => respaceEmphasis(page.markdown || ''))
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
