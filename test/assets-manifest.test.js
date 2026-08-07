import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

// The Worker publishes the repository root as its asset directory, so anything
// `.assetsignore` fails to exclude is served publicly and forever. Pin the exact
// publishable set rather than the exclusions: a new operator artifact, editor
// directory, or credential cache is caught by the pin, not by remembering to
// deny it.
const PUBLIC_ASSETS = ['sensitive-data.js', 'who-is-hiring.css', 'who-is-hiring.html', 'who-is-hiring.js'];

test('publishes only the intended public assets', async () => {
  const patterns = await readIgnorePatterns();
  expect(patterns).not.toHaveLength(0);
  expect(await collectPublishable(REPO_ROOT, '', patterns)).toEqual(PUBLIC_ASSETS);
});

test('excludes local operator artifacts that never exist in a clean checkout', async () => {
  const patterns = await readIgnorePatterns();
  const artifacts = [
    '.wrangler/cache/wrangler-account.json',
    '.dev.vars',
    '.env',
    '.git/config',
    'node_modules/left-pad/index.js',
    'wrangler.production.toml',
    'wrangler.staging.toml'
  ];
  expect(artifacts.filter((path) => !isIgnored(path, patterns))).toEqual([]);
});

async function readIgnorePatterns() {
  const contents = await readFile(join(REPO_ROOT, '.assetsignore'), 'utf8');
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

async function collectPublishable(directory, prefix, patterns) {
  const entries = await readdir(directory, { withFileTypes: true });
  const published = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isIgnored(relativePath, patterns)) return [];
      if (!entry.isDirectory()) return [relativePath];
      return collectPublishable(join(directory, entry.name), relativePath, patterns);
    })
  );
  return published.flat().sort();
}

function isIgnored(relativePath, patterns) {
  return patterns.some((pattern) => matches(relativePath, pattern));
}

function matches(relativePath, pattern) {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
  }
  const expression = toRegExp(pattern);
  if (pattern.includes('/')) return expression.test(relativePath);
  return relativePath.split('/').some((segment) => expression.test(segment));
}

function toRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}
