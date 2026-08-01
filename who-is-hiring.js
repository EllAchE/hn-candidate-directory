const seedCandidates = [
  { id: 'maya-chen', name: 'Maya Chen', role: 'Senior product engineer', mode: 'Remote', availability: 'Immediate', location: 'New York, NY', university: 'Carnegie Mellon University', companies: ['Stripe', 'YC startup'], skills: ['TypeScript', 'React', 'PostgreSQL', 'Product'], summary: 'Product-minded engineer who likes owning the thin slice from customer problem to shipped feature. Looking for a small team with high trust.', source: 'HN · June 2026', enriched: true, posted: 6 },
  { id: 'jordan-wright', name: 'Jordan Wright', role: 'Backend / infrastructure engineer', mode: 'Remote', availability: '1 month', location: 'Toronto, Canada', university: 'University of Waterloo', companies: ['Google', 'Microsoft'], skills: ['Go', 'Kubernetes', 'Rust', 'Distributed systems'], summary: 'Built storage and developer infrastructure at scale. Particularly interested in reliability, data-intensive systems, and tools that make engineers faster.', source: 'HN · July 2026', enriched: true, posted: 1 },
  { id: 'priya-narayanan', name: 'Priya Narayanan', role: 'Founding engineer / full-stack', mode: 'Hybrid', availability: 'Immediate', location: 'San Francisco, CA', university: 'Georgia Tech', companies: ['YC startup'], skills: ['Python', 'Next.js', 'AI products', 'GCP'], summary: 'Early-stage generalist with a bias toward talking to users and shipping. Open to founding or first engineering roles in climate, health, or education.', source: 'HN · July 2026', enriched: true, posted: 2 },
  { id: 'alex-kim', name: 'Alex Kim', role: 'Staff frontend engineer', mode: 'Remote', availability: '3 months', location: 'Austin, TX', university: 'University of Texas at Dallas', companies: ['Meta', 'Stripe'], skills: ['React', 'TypeScript', 'Design systems', 'Web performance'], summary: 'Frontend specialist with 10 years of experience building accessible, high-performance products and leading teams through platform migrations.', source: 'HN · May 2026', enriched: true, posted: 28 },
  { id: 'samira-okafor', name: 'Samira Okafor', role: 'Data / ML engineer', mode: 'On-site', availability: 'Immediate', location: 'Boston, MA', university: 'Carnegie Mellon University', companies: ['Microsoft'], skills: ['Python', 'PyTorch', 'Data pipelines', 'Experimentation'], summary: 'ML engineer focused on evaluation and trustworthy systems. Wants to work with researchers and product teams on real-world model behavior.', source: 'HN · July 2026', enriched: true, posted: 3 },
  { id: 'diego-ruiz', name: 'Diego Ruiz', role: 'Senior software engineer', mode: 'Remote', availability: '1 month', location: 'Remote · LATAM', university: 'University of Waterloo', companies: [], skills: ['Ruby', 'Rails', 'Postgres', 'SaaS'], summary: 'Pragmatic full-stack engineer who has helped small SaaS teams go from first customers to reliable recurring revenue. Open to async teams.', source: 'HN · July 2026', enriched: false, posted: 5 }
];

let candidates = seedCandidates;
let activeReview = null;
const el = (id) => document.getElementById(id);

function render() {
  const query = el('search').value.toLowerCase().trim();
  const mode = el('work-mode').value;
  const availability = el('availability').value;
  const university = el('university').value;
  const company = el('company').value;
  const skill = el('skill').value.toLowerCase().trim();
  let filtered = candidates.filter((candidate) => {
    const searchable = [candidate.name, candidate.role, candidate.location, candidate.university, ...candidate.companies, ...candidate.skills, candidate.summary].join(' ').toLowerCase();
    return (!query || searchable.includes(query)) && (!mode || candidate.mode === mode) && (!availability || candidate.availability === availability) && (!university || candidate.university === university) && (!company || candidate.companies.includes(company)) && (!skill || candidate.skills.join(' ').toLowerCase().includes(skill));
  });
  if (el('sort').value === 'recent') filtered.sort((a, b) => a.posted - b.posted);
  if (el('sort').value === 'enriched') filtered.sort((a, b) => Number(b.enriched) - Number(a.enriched));
  el('result-count').textContent = filtered.length;
  el('candidate-count').textContent = candidates.length.toLocaleString();
  el('candidate-list').innerHTML = filtered.map(card).join('');
  el('empty-state').hidden = filtered.length > 0;
}

function card(candidate) {
  const chips = candidate.skills.map((skill) => `<span class="chip">${escapeHtml(skill)}</span>`).join('');
  const enrichment = candidate.enriched ? `<span class="chip enriched">✦ enriched</span>` : '';
  const companies = candidate.companies.length ? `<span>Previously at <b>${escapeHtml(candidate.companies.join(', '))}</b></span>` : '<span>Employment history <b>not enriched</b></span>';
  return `<article class="candidate-card"><div class="card-top"><div><div class="candidate-name">${escapeHtml(candidate.name)}</div><div class="candidate-role">${escapeHtml(candidate.role)}</div></div><span class="availability">${escapeHtml(candidate.availability)}</span></div><p class="candidate-summary">${escapeHtml(candidate.summary)}</p><div class="chips">${chips}${enrichment}</div><div class="card-bottom"><div class="metadata"><span>${escapeHtml(candidate.location)}</span><span>${escapeHtml(candidate.mode)}</span><span>${escapeHtml(candidate.university)}</span><span>from <b>${escapeHtml(candidate.source)}</b></span></div><div class="card-actions"><button data-view="${escapeHtml(candidate.id)}">View profile</button><a href="#" data-request-for="${escapeHtml(candidate.id)}">Manage profile</a></div></div></article>`;
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }
function openDialog(dialog) { dialog.showModal(); }
function closeDialogs() { document.querySelectorAll('dialog').forEach((dialog) => dialog.close()); }

document.querySelectorAll('input,select').forEach((input) => input.addEventListener('input', render));
el('sort').addEventListener('change', render);
el('clear-filters').addEventListener('click', () => { ['search', 'skill'].forEach((id) => { el(id).value = ''; }); ['availability', 'work-mode', 'university', 'company'].forEach((id) => { el(id).value = ''; }); render(); });
document.querySelectorAll('[data-open-import]').forEach((button) => button.addEventListener('click', () => {
  activeReview = null;
  el('run-import').closest('.dialog-actions').hidden = false;
  el('import-result').hidden = true;
  el('import-result').classList.remove('review-ready');
  openDialog(el('import-dialog'));
}));
document.querySelectorAll('[name="import-source"]').forEach((input) => input.addEventListener('change', syncImportSource));
document.querySelectorAll('[data-open-request]').forEach((button) => button.addEventListener('click', () => openManagementDialog()));
document.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-dialog]')) closeDialogs();
  const view = event.target.closest('[data-view]');
  if (view) {
    const candidate = candidates.find((item) => item.id === view.dataset.view);
    el('dialog-content').innerHTML = `<div class="section-kicker">Candidate profile</div><h2>${escapeHtml(candidate.name)}</h2><p class="dialog-copy">${escapeHtml(candidate.summary)}</p><div class="chips">${candidate.skills.map((skill) => `<span class="chip">${escapeHtml(skill)}</span>`).join('')}</div><p class="dialog-copy" style="margin-top:20px">Enriched fields: <strong>${escapeHtml(candidate.university)}</strong> · ${escapeHtml(candidate.companies.join(', ') || 'pending document processing')}</p><div class="dialog-actions"><button class="button button-ghost" type="button" data-request-for="${escapeHtml(candidate.id)}">Manage this profile</button></div>`;
    openDialog(el('candidate-dialog'));
  }
  const request = event.target.closest('[data-request-for]');
  if (request) { event.preventDefault(); openManagementDialog(request.dataset.requestFor); }
  const copyToken = event.target.closest('[data-copy-management-token]');
  if (copyToken && activeReview?.token && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(activeReview.token).then(() => { copyToken.textContent = 'Copied'; });
  }
});
el('run-import').addEventListener('click', async () => {
  const sourceKind = document.querySelector('[name="import-source"]:checked')?.value || 'text';
  const sourceUrl = el('import-url').value.trim();
  const sourceText = el('import-text').value.trim();
  const resumeFile = el('import-resume').files[0];
  if (sourceKind === 'url' && !sourceUrl) {
    showImportMessage('Enter a public LinkedIn profile URL before creating a draft.', true);
    return;
  }
  if (sourceKind === 'text' && !sourceText) {
    showImportMessage('Paste source text before creating a draft.', true);
    return;
  }
  if (sourceKind === 'resume' && !resumeFile) {
    showImportMessage('Choose a UTF-8 plain-text resume before creating a draft.', true);
    return;
  }

  setImportBusy(true, 'Submitting privately…');
  try {
    const submission =
      sourceKind === 'url'
        ? await submitSourceUrl(sourceUrl)
        : sourceKind === 'resume'
          ? await submitResume(resumeFile)
          : await submitSourceText(sourceText);
    if (!submission) {
      activeReview = { local: true };
      renderReviewDraft(await extractLocalDraft(sourceText));
      return;
    }

    const reviewAccess = { submissionId: submission.submissionId, token: submission.reviewToken, local: false };
    activeReview = reviewAccess;
    showImportMessage('Submission stored privately. Waiting for the extraction queue…');
    const review = await waitForReview(reviewAccess);
    if (activeReview !== reviewAccess) return;
    renderReviewDraft(review.draft);
  } catch (error) {
    showImportMessage(error.message || 'The private submission could not be created.', true);
  } finally {
    setImportBusy(false, 'Create private draft');
  }
});
el('import-result').addEventListener('submit', async (event) => {
  if (!event.target.matches('#review-form')) return;
  event.preventDefault();
  const draft = draftFromForm(event.target);
  const saveState = el('review-save-state');

  if (activeReview?.local) {
    saveState.textContent = 'Kept in this tab only · still private';
    return;
  }

  const saveButton = event.target.querySelector('button[type="submit"]');
  saveButton.disabled = true;
  saveState.textContent = 'Saving…';
  try {
    const response = await fetch(apiPath(`/api/reviews/${activeReview.submissionId}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${activeReview.token}` },
      body: JSON.stringify(draft)
    });
    if (!response.ok) throw new Error(await apiError(response, 'Draft could not be saved'));
    saveState.textContent = 'Saved privately · not searchable';
  } catch (error) {
    saveState.textContent = error.message;
  } finally {
    saveButton.disabled = false;
  }
});
el('import-result').addEventListener('change', (event) => {
  if (!event.target.matches('#publish-consent')) return;
  const publishButton = el('import-result').querySelector('[data-review-decision="publish"]');
  if (publishButton) publishButton.disabled = !event.target.checked;
});
el('import-result').addEventListener('click', async (event) => {
  const decisionButton = event.target.closest('[data-review-decision]');
  if (!decisionButton || !activeReview || activeReview.local) return;

  const decision = decisionButton.dataset.reviewDecision;
  const form = el('review-form');
  if (decision === 'publish' && !el('publish-consent')?.checked) {
    el('review-save-state').textContent = 'Confirm consent before publishing';
    return;
  }

  const wasPublished = !form;
  setDecisionBusy(true, decision === 'publish' ? 'Publishing approved revision…' : 'Recording your decision…');
  try {
    const response = await fetch(apiPath(`/api/reviews/${activeReview.submissionId}/decision`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${activeReview.token}` },
      body: JSON.stringify({ decision, ...(decision === 'publish' ? { draft: draftFromForm(form) } : {}) })
    });
    if (!response.ok) throw new Error(await apiError(response, 'Decision could not be saved'));
    const result = await response.json();
    if (result.status === 'published') renderPublicationResult(result);
    else renderRefusalResult(wasPublished);
    await loadPublishedCandidates();
  } catch (error) {
    const state = el('review-save-state');
    if (state) state.textContent = error.message;
  } finally {
    setDecisionBusy(false);
  }
});
el('request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const action = event.submitter?.dataset.managementAction;
  const candidateId = el('request-candidate').value;
  const token = el('request-token').value.trim();
  if (!action || !candidateId || !token) return;

  setManagementBusy(true, action === 'update' ? 'Opening private review…' : 'Removing profile…');
  try {
    const response = await fetch(apiPath(`/api/candidates/${encodeURIComponent(candidateId)}/manage`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action })
    });
    if (!response.ok) throw new Error(await apiError(response, 'Profile could not be managed'));
    const result = await response.json();
    el('request-token').value = '';
    await loadPublishedCandidates();

    if (result.status === 'review_ready') {
      activeReview = { submissionId: result.submissionId, token, local: false };
      const reviewResponse = await fetch(apiPath(result.reviewEndpoint), { headers: { authorization: `Bearer ${token}` } });
      if (!reviewResponse.ok) throw new Error(await apiError(reviewResponse, 'Private review could not be loaded'));
      const review = await reviewResponse.json();
      closeDialogs();
      el('run-import').closest('.dialog-actions').hidden = true;
      openDialog(el('import-dialog'));
      renderReviewDraft(review.draft);
      el('review-save-state').textContent = 'Hidden from search while you review changes';
      return;
    }

    event.target.hidden = true;
    el('request-success').hidden = false;
    el('request-success').innerHTML = '<span>✓</span><div><strong>Profile removed</strong><p>The verified profile is archived and no longer appears in public search. Repeating this removal is safe.</p></div>';
  } catch (error) {
    el('request-state').textContent = error.message;
  } finally {
    setManagementBusy(false);
  }
});
render();
loadPublishedCandidates();

async function loadPublishedCandidates() {
  try {
    const response = await fetch(apiPath('/api/candidates'));
    if (!response.ok) return;
    const payload = await response.json();
    if (!Array.isArray(payload.candidates)) return;
    candidates = payload.candidates;
    render();
  } catch {
    candidates = seedCandidates;
  }
}

async function submitSourceText(sourceText) {
  let response;
  try {
    response = await fetch(apiPath('/api/submissions/text'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceText })
    });
  } catch {
    return null;
  }
  if ([404, 405, 501].includes(response.status)) return null;
  if (!response.ok) throw new Error(await apiError(response, 'Submission failed'));
  return response.json();
}

async function submitSourceUrl(url) {
  let response;
  try {
    response = await fetch(apiPath('/api/submissions/url'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url })
    });
  } catch {
    throw new Error('LinkedIn URL submission requires the connected private Worker service.');
  }
  if ([404, 405, 501].includes(response.status)) {
    throw new Error('LinkedIn URL submission requires the connected private Worker service.');
  }
  if (!response.ok) throw new Error(await apiError(response, 'URL submission failed'));
  return response.json();
}

async function submitResume(file) {
  if (file.type !== 'text/plain' || !/^[A-Za-z0-9][A-Za-z0-9 _()-]*\.txt$/i.test(file.name)) {
    throw new Error('Resume upload supports UTF-8 plain-text .txt files with a simple ASCII filename only.');
  }
  if (file.size > 100_000) throw new Error('Resume upload is limited to 100,000 bytes.');

  let response;
  try {
    response = await fetch(apiPath('/api/submissions/resume'), {
      method: 'POST',
      headers: { 'content-type': file.type, 'x-resume-filename': file.name },
      body: file
    });
  } catch {
    throw new Error('Resume upload requires the connected private Worker service.');
  }
  if ([404, 405, 501].includes(response.status)) {
    throw new Error('Resume upload requires the connected private Worker service.');
  }
  if (!response.ok) throw new Error(await apiError(response, 'Resume upload failed'));
  return response.json();
}

function syncImportSource() {
  const sourceKind = document.querySelector('[name="import-source"]:checked')?.value || 'text';
  el('import-url-panel').hidden = sourceKind !== 'url';
  el('import-resume-panel').hidden = sourceKind !== 'resume';
  el('import-text-panel').hidden = sourceKind !== 'text';
}

async function waitForReview(reviewAccess) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(apiPath(`/api/reviews/${reviewAccess.submissionId}`), {
      headers: { authorization: `Bearer ${reviewAccess.token}` }
    });
    if (!response.ok) throw new Error(await apiError(response, 'Review could not be loaded'));
    const review = await response.json();
    if (review.status === 'review_ready' && review.draft) return review;
    if (review.status === 'failed') throw new Error('Extraction failed. Your submission remains private.');
    showImportMessage(review.status === 'processing' ? 'Extracting structured fields…' : 'Submission queued privately…');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Extraction is still queued. Keep this tab open and try again shortly.');
}

function renderReviewDraft(draft) {
  const result = el('import-result');
  const decisionControls = activeReview?.local
    ? '<div class="decision-panel"><strong>Preview only</strong><p>Connect the Worker API to approve or decline this listing. This in-tab preview cannot publish.</p></div>'
    : '<div class="decision-panel"><strong>Choose whether this exact revision enters the directory</strong><p>Saving above remains private. Publishing is a separate action and makes only the fields currently shown searchable. You can also decline the listing.</p><label class="consent-confirm"><input id="publish-consent" type="checkbox" /> <span>I approve this exact profile and consent to its publication in the public candidate directory.</span></label><div class="decision-actions"><button class="button button-danger" type="button" data-review-decision="refuse">Decline listing</button><button class="button button-primary" type="button" data-review-decision="publish" disabled>Approve exact draft & publish</button></div></div>';
  el('run-import').closest('.dialog-actions').hidden = true;
  result.hidden = false;
  result.classList.add('review-ready');
  result.innerHTML = `${managementTokenPanel()}<form id="review-form"><div class="review-heading"><strong>Review your extracted profile</strong><span class="private-badge">Private draft</span></div><p class="privacy-note">Edit any field below. Saving this draft does not publish it or add it to directory search.</p><div class="review-grid">${reviewInput('Name', 'name', draft.name)}${reviewInput('Role', 'role', draft.role)}${reviewInput('Location', 'location', draft.location)}${reviewInput('Work mode', 'workMode', draft.workMode)}${reviewInput('Availability', 'availability', draft.availability)}${reviewInput('Date ranges', 'dateRanges', draft.dateRanges.join(', '))}${reviewTextarea('Summary', 'summary', draft.summary, true)}${reviewTextarea('Universities', 'universities', draft.universities.join(', '))}${reviewTextarea('Companies', 'companies', draft.companies.join(', '))}${reviewTextarea('Skills', 'skills', draft.skills.join(', '))}</div><div class="dialog-actions"><span class="review-save-state" id="review-save-state">Not searchable</span><button class="button button-ghost" type="submit">Save private draft</button></div>${decisionControls}</form>`;
}

function renderPublicationResult(result) {
  const candidate = result.candidate;
  const publishedAt = new Date(result.publishedAt).toLocaleString();
  el('import-result').innerHTML = `${managementTokenPanel()}<div class="decision-result published"><span class="decision-icon">✓</span><div><div class="review-heading"><strong>Profile published</strong><span class="published-badge">Searchable</span></div><p><strong>${escapeHtml(candidate.name)}</strong> · ${escapeHtml(candidate.role)}</p><p>The exact revision you approved is now in public search. Published ${escapeHtml(publishedAt)}.</p><div class="decision-actions"><span class="review-save-state" id="review-save-state">You remain in control</span><button class="button button-danger" type="button" data-review-decision="refuse">Withdraw from directory</button></div></div></div>`;
}

function renderRefusalResult(wasPublished) {
  el('import-result').innerHTML = `<div class="decision-result refused"><span class="decision-icon">×</span><div><div class="review-heading"><strong>${wasPublished ? 'Profile withdrawn' : 'Listing declined'}</strong><span class="private-badge">Not searchable</span></div><p>${wasPublished ? 'The profile has been removed from public search.' : 'This draft will not enter the public directory.'} This review token cannot publish the archived revision later.</p></div></div>`;
}

function managementTokenPanel() {
  if (!activeReview?.token || activeReview.local) return '';
  return `<div class="management-token"><strong>Save your private management token</strong><p>This token is shown only in this tab. Use it later to update or remove this exact profile; the directory stores only its hash.</p><div class="token-row"><input type="text" readonly autocomplete="off" spellcheck="false" value="${escapeHtml(activeReview.token)}" /><button class="button button-ghost" type="button" data-copy-management-token>Copy</button></div></div>`;
}

function openManagementDialog(candidateId = '') {
  closeDialogs();
  refreshManagementCandidates(candidateId);
  el('request-form').hidden = false;
  el('request-success').hidden = true;
  el('request-token').value = '';
  el('request-state').textContent = 'The token is checked against the selected profile before anything changes.';
  openDialog(el('request-dialog'));
}

function refreshManagementCandidates(preferredCandidateId = '') {
  const select = el('request-candidate');
  if (!select) return;
  const selected = preferredCandidateId || select.value;
  select.innerHTML = `<option value="">Choose your published profile</option>${candidates.map((candidate) => `<option value="${escapeHtml(candidate.id)}">${escapeHtml(candidate.name)} · ${escapeHtml(candidate.role)}</option>`).join('')}`;
  if (candidates.some((candidate) => candidate.id === selected)) select.value = selected;
}

function setManagementBusy(busy, label = '') {
  el('request-form').querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  if (busy) el('request-state').textContent = label;
}

function reviewInput(label, name, value) {
  return `<label><span class="field-label">${escapeHtml(label)}</span><input name="${name}" value="${escapeHtml(value)}" /></label>`;
}

function reviewTextarea(label, name, value, full = false) {
  return `<label class="${full ? 'review-full' : ''}"><span class="field-label">${escapeHtml(label)}</span><textarea name="${name}">${escapeHtml(value)}</textarea></label>`;
}

function draftFromForm(form) {
  const data = new FormData(form);
  const list = (name) => String(data.get(name) || '').split(/[,;|\n]/).map((item) => item.trim()).filter(Boolean);
  return {
    name: String(data.get('name') || '').trim(),
    role: String(data.get('role') || '').trim(),
    summary: String(data.get('summary') || '').trim(),
    location: String(data.get('location') || '').trim(),
    workMode: String(data.get('workMode') || '').trim(),
    availability: String(data.get('availability') || '').trim(),
    universities: list('universities'),
    companies: list('companies'),
    skills: list('skills'),
    dateRanges: list('dateRanges')
  };
}

async function extractLocalDraft(sourceText) {
  const lines = sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const labeled = Object.fromEntries(lines.map((line) => line.match(/^([^:]{2,30}):\s*(.+)$/)).filter(Boolean).map((match) => [match[1].toLowerCase(), match[2].trim()]));
  const valueFor = (...labels) => labels.map((label) => labeled[label]).find(Boolean) || '';
  const listFor = (...labels) => valueFor(...labels).split(/[,;|]/).map((item) => item.trim()).filter(Boolean);
  const { sanitizeCandidateDraft } = await import('./sensitive-data.js');
  return sanitizeCandidateDraft({
    name: valueFor('name') || 'Name needs review',
    role: valueFor('role', 'title') || lines[0] || 'Role needs review',
    summary: valueFor('summary', 'about') || lines.slice(0, 3).join(' '),
    location: valueFor('location') || 'Location needs review',
    workMode: valueFor('work mode', 'mode') || (/\bremote\b/i.test(sourceText) ? 'Remote' : 'Needs review'),
    availability: valueFor('availability') || 'Needs review',
    universities: listFor('universities', 'university', 'education', 'school'),
    companies: listFor('companies', 'company', 'previously', 'experience'),
    skills: listFor('skills', 'technologies', 'technology', 'stack'),
    dateRanges: [...sourceText.matchAll(/\b(?:19|20)\d{2}\s*(?:-|–|—|to)\s*(?:(?:19|20)\d{2}|present|current)\b/gi)].map((match) => match[0])
  }).draft;
}

function showImportMessage(message, error = false) {
  const result = el('import-result');
  result.hidden = false;
  result.classList.remove('review-ready');
  result.innerHTML = `<strong>${error ? 'Private draft not created' : 'Processing privately'}</strong><br><span>${escapeHtml(message)}</span>`;
}

function setImportBusy(busy, label) {
  el('run-import').disabled = busy;
  el('run-import').textContent = label;
}

function setDecisionBusy(busy, label = '') {
  el('import-result').querySelectorAll('button').forEach((button) => {
    button.disabled = busy || (button.dataset.reviewDecision === 'publish' && !el('publish-consent')?.checked);
  });
  const state = el('review-save-state');
  if (busy && state) state.textContent = label;
}

async function apiError(response, fallback) {
  const body = await response.json().catch(() => ({}));
  return body.error ? `${fallback}: ${body.error}` : `${fallback} (${response.status})`;
}

function apiPath(path) {
  return `${window.HN_API_BASE || ''}${path}`;
}
