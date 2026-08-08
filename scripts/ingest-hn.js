import { pathToFileURL } from 'node:url';
import { previewHackerNewsIngest } from '../worker.js';

const COVERAGE_FIELDS = ['location', 'workMode', 'availability', 'skills', 'companies', 'universities'];

export function summarizePreview(threads) {
  return threads.map((thread) => {
    const covered = Object.fromEntries(
      COVERAGE_FIELDS.map((field) => [field, thread.drafts.filter((draft) => isKnown(draft[field])).length])
    );
    return { ...thread, drafts: undefined, covered };
  });
}

function isKnown(value) {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' && value.trim() !== '' && value !== 'Not specified';
}

function report(threads) {
  summarizePreview(threads).forEach((thread) => {
    console.log(
      `thread ${thread.threadId} (${thread.threadMonth}): ${thread.comments} comments, ${thread.extracted} extractable`
    );
    COVERAGE_FIELDS.forEach((field) => console.log(`  ${field}: ${thread.covered[field]}/${thread.extracted}`));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const threads = Number(process.argv[2] || 1);
  if (!Number.isInteger(threads) || threads < 1 || threads > 6) {
    console.error('Usage: bun run preview:hn -- [threadCount 1-6]');
    process.exitCode = 2;
  } else {
    previewHackerNewsIngest({ threads })
      .then(report)
      .catch((error) => {
        console.error(error instanceof Error ? error.message : 'Hacker News preview failed');
        process.exitCode = 1;
      });
  }
}
