const seedCandidates = [
  { id: 'maya-chen', name: 'Maya Chen', role: 'Senior product engineer', mode: 'Remote', availability: 'Immediate', location: 'New York, NY', university: 'Carnegie Mellon University', companies: ['Stripe', 'YC startup'], skills: ['TypeScript', 'React', 'PostgreSQL', 'Product'], summary: 'Product-minded engineer who likes owning the thin slice from customer problem to shipped feature. Looking for a small team with high trust.', source: 'HN · June 2026', enriched: true, posted: 6 },
  { id: 'jordan-wright', name: 'Jordan Wright', role: 'Backend / infrastructure engineer', mode: 'Remote', availability: '1 month', location: 'Toronto, Canada', university: 'University of Waterloo', companies: ['Google', 'Microsoft'], skills: ['Go', 'Kubernetes', 'Rust', 'Distributed systems'], summary: 'Built storage and developer infrastructure at scale. Particularly interested in reliability, data-intensive systems, and tools that make engineers faster.', source: 'HN · July 2026', enriched: true, posted: 1 },
  { id: 'priya-narayanan', name: 'Priya Narayanan', role: 'Founding engineer / full-stack', mode: 'Hybrid', availability: 'Immediate', location: 'San Francisco, CA', university: 'Georgia Tech', companies: ['YC startup'], skills: ['Python', 'Next.js', 'AI products', 'GCP'], summary: 'Early-stage generalist with a bias toward talking to users and shipping. Open to founding or first engineering roles in climate, health, or education.', source: 'HN · July 2026', enriched: true, posted: 2 },
  { id: 'alex-kim', name: 'Alex Kim', role: 'Staff frontend engineer', mode: 'Remote', availability: '3 months', location: 'Austin, TX', university: 'University of Texas at Dallas', companies: ['Meta', 'Stripe'], skills: ['React', 'TypeScript', 'Design systems', 'Web performance'], summary: 'Frontend specialist with 10 years of experience building accessible, high-performance products and leading teams through platform migrations.', source: 'HN · May 2026', enriched: true, posted: 28 },
  { id: 'samira-okafor', name: 'Samira Okafor', role: 'Data / ML engineer', mode: 'On-site', availability: 'Immediate', location: 'Boston, MA', university: 'Carnegie Mellon University', companies: ['Microsoft'], skills: ['Python', 'PyTorch', 'Data pipelines', 'Experimentation'], summary: 'ML engineer focused on evaluation and trustworthy systems. Wants to work with researchers and product teams on real-world model behavior.', source: 'HN · July 2026', enriched: true, posted: 3 },
  { id: 'diego-ruiz', name: 'Diego Ruiz', role: 'Senior software engineer', mode: 'Remote', availability: '1 month', location: 'Remote · LATAM', university: 'University of Waterloo', companies: [], skills: ['Ruby', 'Rails', 'Postgres', 'SaaS'], summary: 'Pragmatic full-stack engineer who has helped small SaaS teams go from first customers to reliable recurring revenue. Open to async teams.', source: 'HN · July 2026', enriched: false, posted: 5 }
];

const storedCandidates = JSON.parse(localStorage.getItem('hn-candidates') || 'null');
let candidates = storedCandidates || seedCandidates;
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
  return `<article class="candidate-card"><div class="card-top"><div><div class="candidate-name">${escapeHtml(candidate.name)}</div><div class="candidate-role">${escapeHtml(candidate.role)}</div></div><span class="availability">${escapeHtml(candidate.availability)}</span></div><p class="candidate-summary">${escapeHtml(candidate.summary)}</p><div class="chips">${chips}${enrichment}</div><div class="card-bottom"><div class="metadata"><span>${escapeHtml(candidate.location)}</span><span>${escapeHtml(candidate.mode)}</span><span>${escapeHtml(candidate.university)}</span><span>from <b>${escapeHtml(candidate.source)}</b></span></div><div class="card-actions"><button data-view="${candidate.id}">View profile</button><a href="#" data-request-for="${candidate.id}">Request update</a></div></div></article>`;
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }
function openDialog(dialog) { dialog.showModal(); }
function closeDialogs() { document.querySelectorAll('dialog').forEach((dialog) => dialog.close()); }

document.querySelectorAll('input,select').forEach((input) => input.addEventListener('input', render));
el('sort').addEventListener('change', render);
el('clear-filters').addEventListener('click', () => { ['search', 'skill'].forEach((id) => { el(id).value = ''; }); ['availability', 'work-mode', 'university', 'company'].forEach((id) => { el(id).value = ''; }); render(); });
document.querySelectorAll('[data-open-import]').forEach((button) => button.addEventListener('click', () => openDialog(el('import-dialog'))));
document.querySelectorAll('[data-open-request]').forEach((button) => button.addEventListener('click', () => openDialog(el('request-dialog'))));
document.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-dialog]')) closeDialogs();
  const view = event.target.closest('[data-view]');
  if (view) {
    const candidate = candidates.find((item) => item.id === view.dataset.view);
    el('dialog-content').innerHTML = `<div class="section-kicker">Candidate profile</div><h2>${escapeHtml(candidate.name)}</h2><p class="dialog-copy">${escapeHtml(candidate.summary)}</p><div class="chips">${candidate.skills.map((skill) => `<span class="chip">${escapeHtml(skill)}</span>`).join('')}</div><p class="dialog-copy" style="margin-top:20px">Enriched fields: <strong>${escapeHtml(candidate.university)}</strong> · ${escapeHtml(candidate.companies.join(', ') || 'pending document processing')}</p>`;
    openDialog(el('candidate-dialog'));
  }
  const request = event.target.closest('[data-request-for]');
  if (request) { event.preventDefault(); openDialog(el('request-dialog')); }
});
el('run-import').addEventListener('click', async () => {
  const sourceUrl = el('source-url').value.trim();
  const text = el('import-text').value.trim();
  let sourceText = text;
  const configuredEndpoint = window.HN_ENRICH_ENDPOINT;
  if (sourceUrl && configuredEndpoint) {
    el('run-import').disabled = true;
    el('run-import').textContent = 'Fetching via String…';
    try {
      const response = await fetch(configuredEndpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: sourceUrl }) });
      if (!response.ok) throw new Error(`enrichment proxy returned ${response.status}`);
      const payload = await response.json();
      sourceText = payload.text || payload.data || text;
    } catch (error) {
      el('import-result').hidden = false;
      el('import-result').innerHTML = `<strong>Document fetch failed.</strong><br><span style="font-size:12px">${escapeHtml(error.message)}. Paste the text manually or retry when the server-side String adapter is configured.</span>`;
      el('run-import').disabled = false; el('run-import').textContent = 'Extract profile'; return;
    }
    el('run-import').disabled = false; el('run-import').textContent = 'Extract profile';
  }
  if (!sourceText) return;
  const lines = sourceText.split('\n').map((line) => line.trim()).filter(Boolean);
  const extracted = { id: `import-${Date.now()}`, name: 'Imported candidate', role: lines[0] || 'Candidate', mode: /remote/i.test(sourceText) ? 'Remote' : 'Unspecified', availability: 'Immediate', location: lines.find((line) => /location:/i.test(line))?.split(':').slice(1).join(':').trim() || 'Not specified', university: /university|college/i.test(sourceText) ? (lines.find((line) => /university|college/i.test(line))?.split(':').slice(1).join(':').trim() || 'Needs review') : 'Needs enrichment', companies: ['Pending extraction'], skills: (lines.find((line) => /technolog|skills|stack/i.test(line))?.split(':').slice(1).join(':').split(',').map((item) => item.trim()).filter(Boolean) || ['Needs extraction']).slice(0, 5), summary: lines.slice(0, 3).join(' '), source: sourceUrl ? 'String import' : 'Local import', enriched: false, posted: 0 };
  candidates = [extracted, ...candidates]; localStorage.setItem('hn-candidates', JSON.stringify(candidates)); render();
  el('import-result').hidden = false; el('import-result').innerHTML = `<strong>Profile extracted locally.</strong><br><span style="font-size:12px">The production queue would now process the source document, ask for candidate consent, and add normalized education and employment fields.</span>`;
});
el('request-form').addEventListener('submit', (event) => { event.preventDefault(); localStorage.setItem('hn-update-request', JSON.stringify({ email: el('request-email').value, message: el('request-message').value, createdAt: new Date().toISOString() })); event.target.hidden = true; el('request-success').hidden = false; });
render();
