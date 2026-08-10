
let candidates = [];
let activeReview = null;
const el = (id) => document.getElementById(id);

const FACETS = [
  { key: 'availability', label: 'Availability', kind: 'toggle', values: (candidate) => [candidate.availability] },
  { key: 'mode', label: 'Work mode', kind: 'toggle', values: (candidate) => [candidate.mode] },
  { key: 'location', label: 'Location', kind: 'combobox', placeholder: 'Type a city, region, or “remote”', values: (candidate) => [candidate.location] },
  { key: 'university', label: 'University', kind: 'combobox', placeholder: 'Type a university', values: (candidate) => [candidate.university] },
  { key: 'company', label: 'Previously at', kind: 'combobox', placeholder: 'Type a company', values: (candidate) => candidate.companies },
  { key: 'skill', label: 'Skill or stack', kind: 'combobox', placeholder: 'Type a skill or stack', values: (candidate) => candidate.skills }
];
const selections = new Map(FACETS.map((facet) => [facet.key, new Set()]));
const selectionLabels = new Map();
const comboState = new Map(FACETS.filter((facet) => facet.kind === 'combobox').map((facet) => [facet.key, { query: '', open: false, active: '' }]));
let filtersOpen = false;

function render() {
  const query = el('search').value.toLowerCase().trim();
  const filtered = candidates.filter((candidate) => matchesQuery(candidate, query) && matchesFacets(candidate, null));
  if (el('sort').value === 'recent') filtered.sort((a, b) => a.posted - b.posted);
  if (el('sort').value === 'enriched') filtered.sort((a, b) => Number(b.enriched) - Number(a.enriched));
  el('result-count').textContent = filtered.length;
  renderStats();
  el('candidate-list').innerHTML = filtered.map(card).join('');
  el('empty-state').hidden = filtered.length > 0;
  FACETS.forEach((facet) => renderFacet(facet, query));
  renderActiveFilters(query);
  syncFilterDrawer();
}

function renderStats() {
  const universityFacet = FACETS.find((facet) => facet.key === 'university');
  const universities = new Set(candidates.flatMap((candidate) => facetValues(universityFacet, candidate).map((value) => facetKeyFor(universityFacet, value))).filter((key) => key !== 'not specified'));
  el('candidate-count').textContent = candidates.length.toLocaleString();
  el('university-count').textContent = universities.size.toLocaleString();
  el('enriched-count').textContent = candidates.filter((candidate) => candidate.enriched).length.toLocaleString();
}

function searchableText(candidate) {
  return [candidate.name, candidate.role, candidate.location, candidate.university, ...(candidate.companies || []), ...(candidate.skills || []), candidate.summary].filter(Boolean).join(' ').toLowerCase();
}

function matchesQuery(candidate, query) {
  return !query || searchableText(candidate).includes(query);
}

function matchesFacets(candidate, exceptKey) {
  return FACETS.every((facet) => {
    const selected = selections.get(facet.key);
    if (facet.key === exceptKey || !selected.size) return true;
    return facetValues(facet, candidate).some((value) => selected.has(facetKeyFor(facet, value)));
  });
}

function facetValues(facet, candidate) {
  const raw = facet.values(candidate);
  return (Array.isArray(raw) ? raw : [raw]).map((value) => String(value ?? '').trim()).filter(Boolean);
}

function facetKeyFor(facet, value) {
  const grouped = facet.key === 'location' ? value.replace(/[·|/–—]+/g, ',') : value;
  return grouped.toLowerCase().replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').replace(/[.,]+$/, '').trim();
}

function facetOptions(facet, pool) {
  const groups = new Map();
  pool.forEach((candidate) => {
    const perCandidate = new Map(facetValues(facet, candidate).map((value) => [facetKeyFor(facet, value), value]));
    perCandidate.forEach((value, key) => {
      const group = groups.get(key) || { key, count: 0, labels: new Map() };
      group.count += 1;
      group.labels.set(value, (group.labels.get(value) || 0) + 1);
      groups.set(key, group);
    });
  });
  const options = [...groups.values()].map((group) => ({
    key: group.key,
    count: group.count,
    label: [...group.labels].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
  }));
  const selected = selections.get(facet.key);
  const missing = [...selected].filter((key) => !groups.has(key)).map((key) => ({ key, count: 0, label: labelFor(facet.key, key) }));
  return [...options.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)), ...missing];
}

function labelFor(facetKey, value) {
  return selectionLabels.get(`${facetKey}:${value}`) || value;
}

function renderFacet(facet, query) {
  const pool = candidates.filter((candidate) => matchesQuery(candidate, query) && matchesFacets(candidate, facet.key));
  const options = facetOptions(facet, pool);
  const selected = selections.get(facet.key);
  if (facet.kind === 'toggle') {
    el(`facet-${facet.key}-options`).innerHTML = options.map((option) => togglePill(facet, option, selected.has(option.key))).join('');
    return;
  }

  const state = comboState.get(facet.key);
  const needle = state.query.toLowerCase().trim();
  const shown = options.filter((option) => !needle || option.label.toLowerCase().includes(needle) || option.key.includes(needle));
  if (!shown.some((option) => option.key === state.active)) state.active = shown[0]?.key || '';
  const list = el(`facet-${facet.key}-listbox`);
  list.innerHTML = shown.length
    ? shown.map((option, index) => optionRow(facet, option, index, selected.has(option.key), option.key === state.active)).join('')
    : '<li class="combo-empty" role="presentation">No matching options</li>';
  list.hidden = !state.open;
  const input = el(`facet-${facet.key}-input`);
  input.setAttribute('aria-expanded', String(state.open));
  const activeIndex = shown.findIndex((option) => option.key === state.active);
  if (state.open && activeIndex >= 0) input.setAttribute('aria-activedescendant', `facet-${facet.key}-option-${activeIndex}`);
  else input.removeAttribute('aria-activedescendant');
  el(`facet-${facet.key}-selected`).innerHTML = [...selected].map((key) => selectedPill(facet, key)).join('');
  if (state.open) list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
}

function togglePill(facet, option, isSelected) {
  return `<button class="pill${isSelected ? ' is-selected' : ''}" type="button" aria-pressed="${isSelected}" data-facet-toggle="${facet.key}" data-value="${escapeHtml(option.key)}" data-label="${escapeHtml(option.label)}">${escapeHtml(option.label)}<span class="pill-count">${option.count}</span></button>`;
}

function optionRow(facet, option, index, isSelected, isActive) {
  return `<li class="combo-option${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}" id="facet-${facet.key}-option-${index}" role="option" aria-selected="${isSelected}" data-facet-option="${facet.key}" data-value="${escapeHtml(option.key)}" data-label="${escapeHtml(option.label)}"><span>${escapeHtml(option.label)}</span><span class="option-count">${option.count}</span></li>`;
}

function selectedPill(facet, key) {
  const label = labelFor(facet.key, key);
  return `<button class="pill is-selected" type="button" data-facet-remove="${facet.key}" data-value="${escapeHtml(key)}" aria-label="Remove ${escapeHtml(facet.label)} filter ${escapeHtml(label)}">${escapeHtml(label)}<span class="pill-remove" aria-hidden="true">×</span></button>`;
}

function renderActiveFilters(query) {
  const chips = FACETS.flatMap((facet) => [...selections.get(facet.key)].map((key) => activeChip(facet, key)));
  const count = chips.length;
  if (query) chips.unshift(`<button class="pill is-selected" type="button" data-clear-search aria-label="Clear the search box">Search: ${escapeHtml(query)}<span class="pill-remove" aria-hidden="true">×</span></button>`);
  const bar = el('active-filters');
  bar.hidden = chips.length === 0;
  bar.innerHTML = chips.length ? `<span class="active-filters-label">Active</span>${chips.join('')}<button class="clear-button" type="button" data-clear-filters>Clear all</button>` : '';
  el('filters-badge').textContent = count ? `${count} selected` : 'none selected';
}

function activeChip(facet, key) {
  const label = labelFor(facet.key, key);
  return `<button class="pill is-selected" type="button" data-facet-remove="${facet.key}" data-value="${escapeHtml(key)}" aria-label="Remove ${escapeHtml(facet.label)} filter ${escapeHtml(label)}"><span class="pill-facet">${escapeHtml(facet.label)}</span>${escapeHtml(label)}<span class="pill-remove" aria-hidden="true">×</span></button>`;
}

function buildFacets() {
  el('filters-body').innerHTML = FACETS.map((facet) => {
    const labelId = `facet-${facet.key}-label`;
    if (facet.kind === 'toggle') {
      return `<div class="facet"><div class="field-label" id="${labelId}">${escapeHtml(facet.label)}</div><div class="pill-row" role="group" aria-labelledby="${labelId}" id="facet-${facet.key}-options"></div></div>`;
    }
    return `<div class="facet"><label class="field-label" id="${labelId}" for="facet-${facet.key}-input">${escapeHtml(facet.label)}</label><div class="combobox"><input class="combo-input" id="facet-${facet.key}-input" data-combo="${facet.key}" type="text" role="combobox" aria-expanded="false" aria-controls="facet-${facet.key}-listbox" aria-haspopup="listbox" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(facet.placeholder)}" /><button class="combo-toggle" type="button" tabindex="-1" data-combo-toggle="${facet.key}" aria-label="Show all ${escapeHtml(facet.label.toLowerCase())} options">▾</button><ul class="combo-list" id="facet-${facet.key}-listbox" role="listbox" aria-multiselectable="true" aria-labelledby="${labelId}" hidden></ul></div><div class="pill-row" id="facet-${facet.key}-selected"></div></div>`;
  }).join('');
}

function toggleSelection(facetKey, value, label) {
  const selected = selections.get(facetKey);
  if (!selected) return;
  if (selected.has(value)) selected.delete(value);
  else {
    selected.add(value);
    if (label) selectionLabels.set(`${facetKey}:${value}`, label);
  }
  render();
}

function comboOptionElements(facetKey) {
  return [...el(`facet-${facetKey}-listbox`).querySelectorAll('[data-facet-option]')];
}

function moveCombo(facetKey, delta) {
  const state = comboState.get(facetKey);
  const values = comboOptionElements(facetKey).map((option) => option.dataset.value);
  if (!values.length) return;
  const index = values.indexOf(state.active);
  state.active = values[(index + delta + values.length) % values.length];
  render();
}

function setComboOpen(facetKey, open) {
  const state = comboState.get(facetKey);
  if (state.open === open) return;
  state.open = open;
  render();
}

function closeCombos() {
  if (![...comboState.values()].some((state) => state.open)) return;
  comboState.forEach((state) => { state.open = false; });
  render();
}

function clearFilters() {
  el('search').value = '';
  selections.forEach((selected) => selected.clear());
  comboState.forEach((state, facetKey) => {
    state.query = '';
    state.open = false;
    state.active = '';
    el(`facet-${facetKey}-input`).value = '';
  });
  render();
}

function syncFilterDrawer() {
  const toggle = el('filters-toggle');
  const collapsible = getComputedStyle(toggle).display !== 'none';
  el('filters-panel').classList.toggle('is-open', filtersOpen);
  toggle.setAttribute('aria-expanded', String(!collapsible || filtersOpen));
}

function card(candidate) {
  const chips = candidate.skills.map((skill) => `<span class="chip">${escapeHtml(skill)}</span>`).join('');
  const enrichment = candidate.enriched ? `<span class="chip enriched">✦ enriched</span>` : '';
  const companies = candidate.companies.length ? `<span>Previously at <b>${escapeHtml(candidate.companies.join(', '))}</b></span>` : '<span>Employment history <b>not enriched</b></span>';
  return `<article class="candidate-card"><div class="card-top"><div><div class="candidate-name">${escapeHtml(candidate.name)}</div><div class="candidate-role">${escapeHtml(candidate.role)}</div></div><span class="availability">${escapeHtml(candidate.availability)}</span></div><p class="candidate-summary">${escapeHtml(candidate.summary)}</p><div class="chips">${chips}${enrichment}</div><div class="card-bottom"><div class="metadata"><span>${escapeHtml(candidate.location)}</span><span>${escapeHtml(candidate.mode)}</span><span>${escapeHtml(candidate.university)}</span><span class="source-cell">from ${sourceLink(candidate)}</span></div><div class="card-actions"><button data-view="${escapeHtml(candidate.id)}">View profile</button><a href="#" data-request-for="${escapeHtml(candidate.id)}">Manage profile</a></div></div></article>`;
}

function sourceLink(candidate) {
  const label = escapeHtml(candidate.source);
  const href = httpsUrl(candidate.sourceUrl);
  return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : `<b>${label}</b>`;
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }
function openDialog(dialog) { dialog.showModal(); }
function closeDialogs() { document.querySelectorAll('dialog').forEach((dialog) => dialog.close()); }

el('search').addEventListener('input', render);
el('sort').addEventListener('change', render);
el('filters-toggle').addEventListener('click', () => { filtersOpen = !filtersOpen; syncFilterDrawer(); });
window.addEventListener('resize', syncFilterDrawer);
document.addEventListener('input', (event) => {
  const input = event.target.closest('.combo-input');
  if (!input) return;
  const state = comboState.get(input.dataset.combo);
  state.query = input.value;
  state.open = true;
  state.active = '';
  render();
});
document.addEventListener('mousedown', (event) => { if (event.target.closest('.combo-list')) event.preventDefault(); });
document.addEventListener('focusout', (event) => {
  const combobox = event.target.closest('.combobox');
  if (combobox && !combobox.contains(event.relatedTarget)) setComboOpen(combobox.querySelector('.combo-input').dataset.combo, false);
});
document.addEventListener('keydown', (event) => {
  const input = event.target.closest('.combo-input');
  if (!input) return;
  const facetKey = input.dataset.combo;
  const state = comboState.get(facetKey);
  const optionValues = () => comboOptionElements(facetKey).map((option) => option.dataset.value);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (state.open) moveCombo(facetKey, event.key === 'ArrowDown' ? 1 : -1);
    else setComboOpen(facetKey, true);
  } else if (event.key === 'Home' || event.key === 'End') {
    const values = state.open ? optionValues() : [];
    if (!values.length) return;
    event.preventDefault();
    state.active = event.key === 'Home' ? values[0] : values[values.length - 1];
    render();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (!state.open) return setComboOpen(facetKey, true);
    const active = comboOptionElements(facetKey).find((option) => option.dataset.value === state.active);
    if (active) toggleSelection(facetKey, active.dataset.value, active.dataset.label);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (state.open) return setComboOpen(facetKey, false);
    if (!state.query) return;
    state.query = '';
    input.value = '';
    render();
  } else if (event.key === 'Backspace' && !input.value) {
    const selected = [...selections.get(facetKey)];
    if (selected.length) toggleSelection(facetKey, selected[selected.length - 1]);
  }
});
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-clear-filters]')) return clearFilters();
  if (event.target.closest('[data-clear-search]')) {
    el('search').value = '';
    return render();
  }
  const pill = event.target.closest('[data-facet-toggle],[data-facet-remove],[data-facet-option]');
  if (pill) return toggleSelection(pill.dataset.facetToggle || pill.dataset.facetRemove || pill.dataset.facetOption, pill.dataset.value, pill.dataset.label);
  const comboToggle = event.target.closest('[data-combo-toggle]');
  if (comboToggle) {
    const facetKey = comboToggle.dataset.comboToggle;
    setComboOpen(facetKey, !comboState.get(facetKey).open);
    el(`facet-${facetKey}-input`).focus();
    return;
  }
  if (!event.target.closest('.combobox')) closeCombos();
});
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
    el('dialog-content').innerHTML = `<div class="section-kicker">Candidate profile</div><h2>${escapeHtml(candidate.name)}</h2><p class="dialog-copy">${escapeHtml(candidate.summary)}</p><div class="chips">${candidate.skills.map((skill) => `<span class="chip">${escapeHtml(skill)}</span>`).join('')}</div><p class="dialog-copy" style="margin-top:20px">Enriched fields: <strong>${escapeHtml(candidate.university)}</strong> · ${escapeHtml(candidate.companies.join(', ') || 'pending document processing')}</p><div class="dialog-actions">${candidate.sourceUrl ? `<button class="button button-danger" type="button" data-remove-for="${escapeHtml(candidate.id)}">This is me — remove my listing</button>` : `<button class="button button-ghost" type="button" data-request-for="${escapeHtml(candidate.id)}">Manage this profile</button>`}</div>${candidate.sourceUrl ? `<p class="privacy-note">This profile was compiled from a public ${sourceLink(candidate)}. Removal takes effect immediately and the comment will not be collected again.</p>` : ''}`;
    openDialog(el('candidate-dialog'));
  }
  const request = event.target.closest('[data-request-for]');
  if (request) { event.preventDefault(); openManagementDialog(request.dataset.requestFor); }
  const remove = event.target.closest('[data-remove-for]');
  if (remove) { event.preventDefault(); handleRemovalClick(remove); }
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
buildFacets();
render();
loadPublishedCandidates();

// Two-step rather than window.confirm so the confirmation renders inside the open dialog.
async function handleRemovalClick(button) {
  const candidateId = button.dataset.removeFor;
  if (button.dataset.confirming !== 'true') {
    button.dataset.confirming = 'true';
    button.textContent = 'Confirm removal';
    return;
  }

  button.disabled = true;
  button.textContent = 'Removing…';
  try {
    const response = await fetch(apiPath(`/api/candidates/${encodeURIComponent(candidateId)}/removal`), { method: 'POST' });
    if (!response.ok) throw new Error('removal_failed');
    candidates = candidates.filter((candidate) => candidate.id !== candidateId);
    buildFacets();
    render();
    closeDialogs();
  } catch {
    button.disabled = false;
    button.textContent = 'Removal failed — try again';
  }
}

async function loadPublishedCandidates() {
  try {
    const response = await fetch(apiPath('/api/candidates'));
    if (!response.ok) return;
    const payload = await response.json();
    if (!Array.isArray(payload.candidates)) return;
    candidates = payload.candidates;
    render();
  } catch {
    // Leave the directory empty rather than inventing rows; the empty state is honest
    // about a failed load, and every profile shown must be one a real person consented to.
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
