import { expect, test } from 'bun:test';
import worker, { extractProfile, ingestHnComment } from '../worker.js';
import { createEnvironment, deliverQueuedMessages } from './memory-d1.js';
import { parseExperience, extractExperience, experienceBands } from '../sensitive-data.js';

test('experience totals retain uncertainty and do not count education or individual skills', () => {
  expect(parseExperience('5+ years')).toEqual({ minYears: 5, maxYears: null });
  expect(parseExperience('3–5 years')).toEqual({ minYears: 3, maxYears: 5 });
  expect(parseExperience('0')).toEqual({ minYears: 0, maxYears: 0 });
  expect(extractExperience('Education: 2010–2014\nPython: 5 years')).toBeNull();
  expect(extractExperience('Experience: 5 years\nProfessional experience: 10 years')).toBeNull();
  expect(extractProfile('Role: Engineer\nExperience: 4+ years').companies).toEqual([]);
  expect(experienceBands(parseExperience('3–7'))).not.toContain('5+ years');
  expect(experienceBands(parseExperience('5+'))).toContain('5+ years');
  expect(experienceBands(null)).toEqual(['Unknown']);
  for (const value of ['-1', '81', '5–3', 'NaN', 'five', '<script>']) expect(parseExperience(value)).toBeNull();
});

const request = (path, method = 'GET', body, token) => new Request(`https://directory.example${path}`, {
  method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {})
});

test('experience survives private extraction, edits, publication and review retrieval', async () => {
  const env = createEnvironment();
  const submitted = await (await worker.fetch(request('/api/submissions/text', 'POST', {
    sourceText: 'Name: Sample Candidate\nRole: Engineer\nExperience: 5+ years\nSummary: Builds reliable systems.'
  }), env)).json();
  await deliverQueuedMessages(env, worker);
  const endpoint = `/api/reviews/${submitted.submissionId}`;
  const review = await (await worker.fetch(request(endpoint, 'GET', undefined, submitted.reviewToken), env)).json();
  expect(review.draft.experience).toEqual({ minYears: 5, maxYears: null });
  const draft = { ...review.draft, experience: { minYears: 3, maxYears: 5 } };
  expect((await worker.fetch(request(endpoint, 'PATCH', draft, submitted.reviewToken), env)).status).toBe(200);
  const bad = { ...draft, experience: { minYears: -1, maxYears: 5 } };
  expect((await worker.fetch(request(endpoint, 'PATCH', bad, submitted.reviewToken), env)).status).toBe(400);
  const published = await (await worker.fetch(request(`${endpoint}/decision`, 'POST', { decision: 'publish', draft }, submitted.reviewToken), env)).json();
  expect(published.candidate.experience).toEqual({ minYears: 3, maxYears: 5 });
  const listing = await (await worker.fetch(request('/api/candidates'), env)).json();
  expect(listing.candidates[0].experience).toEqual({ minYears: 3, maxYears: 5 });
});

test('HN ingestion stores experience; newest account source keeps its current total', async () => {
  const env = createEnvironment();
  const first = { objectID: '12345001', author: 'sample-handle', story_id: '12345000', created_at: '2026-07-01T12:00:00Z',
    comment_text: 'Location: Remote<p>Role: Engineer<p>Experience: 5+ years<p>Technologies: Go' };
  await ingestHnComment(env, { itemId: first.objectID, author: first.author, threadId: first.story_id, threadMonth: '2026-07', commentText: first.comment_text, createdAt: first.created_at });
  const response = await (await worker.fetch(request('/api/candidates'), env)).json();
  expect(response.candidates[0].experience).toEqual({ minYears: 5, maxYears: null });
});
