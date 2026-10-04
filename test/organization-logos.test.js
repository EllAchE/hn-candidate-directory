import { expect, test } from 'bun:test';
import { organizationLogoUrl } from '../organization-logos.js';
import worker from '../worker.js';

test('logos resolve curated organization aliases without guessing from arbitrary names', () => {
  expect(organizationLogoUrl('company', '  GOOGLE   LLC ')).toBe('https://www.google.com/s2/favicons?domain=google.com&sz=64');
  expect(organizationLogoUrl('university', 'Massachusetts Institute of Technology')).toContain('domain=mit.edu');
  expect(organizationLogoUrl('university', 'Georgia Tech')).toContain('domain=gatech.edu');
  for (const name of ['CMU', 'UW', 'Stanford alumni club', 'https://attacker.test', '<img src=x>', 'MIT student club']) {
    expect(organizationLogoUrl('university', name)).toBe('');
  }
  expect(organizationLogoUrl('company', 'MIT')).toBe('');
  expect(organizationLogoUrl('university', 'Google')).toBe('');
});

test('public assets permit the logo provider without permitting arbitrary image or script hosts', async () => {
  const response = await worker.fetch(new Request('https://directory.example/organization-logos.js'), {
    ASSETS: { fetch: async () => new Response('asset') }
  });
  expect(response.status).toBe(200);
  const policy = response.headers.get('Content-Security-Policy');
  expect(policy).toContain("img-src 'self' data: https://www.google.com https://*.gstatic.com");
  expect(policy).toContain("script-src 'self'");
});
