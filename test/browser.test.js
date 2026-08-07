import { expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const PUBLIC_CANDIDATES = [
  {
    id: 'ada-rivera',
    name: 'Ada Rivera',
    role: 'Distributed systems engineer',
    mode: 'Remote',
    availability: 'Immediate',
    location: 'Toronto, Canada',
    university: 'University of Waterloo',
    companies: ['Google'],
    skills: ['Rust', 'Kubernetes', 'Go'],
    summary: 'Builds reliable storage systems for high-throughput products.',
    source: 'HN · July 2026',
    sourceUrl: 'https://news.ycombinator.com/item?id=44601001',
    enriched: true,
    posted: 4,
    publishedAt: '2026-07-27T12:00:00.000Z'
  },
  {
    id: 'beatrice-okafor',
    name: 'Beatrice Okafor',
    role: 'Data and ML engineer',
    mode: 'Hybrid',
    availability: '1 month',
    location: 'New York, NY',
    university: 'Georgia Tech',
    companies: ['Microsoft'],
    skills: ['Python', 'PyTorch', 'Experimentation'],
    summary: 'Evaluates trustworthy climate models with product and research teams.',
    source: 'HN · July 2026',
    sourceUrl: 'http://news.ycombinator.com/item?id=44601002',
    enriched: true,
    posted: 1,
    publishedAt: '2026-07-30T12:00:00.000Z'
  },
  {
    id: 'chen-ito',
    name: 'Chen Ito',
    role: 'Staff frontend engineer',
    mode: 'On-site',
    availability: '3 months',
    location: 'New York, NY',
    university: 'Carnegie Mellon University',
    companies: ['Meta'],
    skills: ['React', 'Design systems', 'Accessibility'],
    summary: 'Leads accessible platform migrations and web performance programs.',
    source: 'HN · June 2026',
    enriched: false,
    posted: 9,
    publishedAt: '2026-07-20T12:00:00.000Z'
  },
  {
    id: 'diego-silva',
    name: 'Diego Silva',
    role: 'Backend engineer',
    mode: 'Remote',
    availability: '1 month',
    location: 'Remote · LATAM',
    university: 'University of Waterloo',
    companies: ['Stripe'],
    skills: ['Rust', 'PostgreSQL', 'SaaS'],
    summary: 'Scales payment systems for async software teams.',
    source: 'HN · July 2026',
    sourceUrl: 'https://news.ycombinator.com/item?id=44601004',
    enriched: true,
    posted: 2,
    publishedAt: '2026-07-29T12:00:00.000Z'
  },
  {
    id: 'evelyn-stone',
    name: 'Evelyn Stone',
    role: 'Security engineer',
    mode: 'Hybrid',
    availability: 'Immediate',
    location: 'new york,NY',
    university: 'TU Delft',
    companies: ['Basecamp'],
    skills: ['Go', 'Security', 'Cloud'],
    summary: 'Builds practical fintech security controls for early-stage teams.',
    source: 'HN · July 2026',
    sourceUrl: 'javascript:alert(document.domain)',
    enriched: true,
    posted: 7,
    publishedAt: '2026-07-24T12:00:00.000Z'
  },
  {
    id: 'fatima-noor',
    name: 'Fatima Noor',
    role: 'Product engineer',
    mode: 'Remote',
    availability: '3 months',
    location: 'London, UK',
    university: 'Carnegie Mellon University',
    companies: [],
    skills: ['TypeScript', 'Product', 'Node.js'],
    summary: 'Ships education products from customer discovery through launch.',
    source: 'HN · July 2026',
    sourceUrl: 'https://news.ycombinator.com/item?id=44601006&x="><script>alert(1)</script>',
    enriched: false,
    posted: 3,
    publishedAt: '2026-07-28T12:00:00.000Z'
  }
];

const EXPECTED_DEFAULT_NAMES = PUBLIC_CANDIDATES.map(({ name }) => name);
const RETIRED_HARDCODED_OPTIONS = ['University of Texas at Dallas', 'YC startup'];
const KEY_CODES = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, Home: 36, End: 35, Backspace: 8 };

test(
  'public browse, global search, sorting, and multi-select filters work in a real browser',
  async () => {
    await withPage(async (cdp) => {
      expect(await candidateNames(cdp)).toEqual(EXPECTED_DEFAULT_NAMES);
      expect(await textContent(cdp, '#candidate-count')).toBe('6');
      expect(await textContent(cdp, '#result-count')).toBe('6');

      expect(await textContent(cdp, 'label[for="search"]')).toBe('Search everything');
      expect(await attribute(cdp, '#search', 'placeholder')).toBe('Search all fields — name, role, location, school, company, skill…');
      expect(await attribute(cdp, '#search', 'aria-describedby')).toBe('search-hint');
      expect(await textContent(cdp, '#search-hint')).toBe('One box, every field: name, role, location, university, companies, skills, and summary.');

      const searchCases = [
        ['aDa rIVERA', ['Ada Rivera']],
        ['SECURITY ENGINEER', ['Evelyn Stone']],
        ['toronto', ['Ada Rivera']],
        ['Georgia Tech', ['Beatrice Okafor']],
        ['stRIPE', ['Diego Silva']],
        ['kUbErNeTeS', ['Ada Rivera']],
        ['CLIMATE', ['Beatrice Okafor']]
      ];
      for (const [query, names] of searchCases) {
        await clearFilters(cdp);
        await setControl(cdp, 'search', query);
        expect(await candidateNames(cdp)).toEqual(names);
      }

      await clearFilters(cdp);
      await selectFacetOption(cdp, 'availability', 'Immediate');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Evelyn Stone']);
      await selectFacetOption(cdp, 'availability', '3 months');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Chen Ito', 'Evelyn Stone', 'Fatima Noor']);
      await selectFacetOption(cdp, 'mode', 'Remote');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Fatima Noor']);
      expect(await activeFilterChips(cdp)).toEqual([
        'Remove Availability filter Immediate',
        'Remove Availability filter 3 months',
        'Remove Work mode filter Remote'
      ]);
      expect(await textContent(cdp, '#filters-badge')).toBe('3 selected');

      await removeActiveFilterChip(cdp, 'Remove Availability filter 3 months');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera']);
      await removeActiveFilterChip(cdp, 'Remove Work mode filter Remote');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Evelyn Stone']);

      await clearFilters(cdp);
      expect(await activeFilterChips(cdp)).toEqual([]);
      expect(await visible(cdp, '#active-filters')).toBe(false);
      expect(await textContent(cdp, '#filters-badge')).toBe('none selected');
      expect(await candidateNames(cdp)).toEqual(EXPECTED_DEFAULT_NAMES);

      await selectFacetOption(cdp, 'skill', 'Rust');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Diego Silva']);
      await selectFacetOption(cdp, 'skill', 'Python');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Beatrice Okafor', 'Diego Silva']);
      await selectFacetOption(cdp, 'mode', 'Remote');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Diego Silva']);
      await selectFacetOption(cdp, 'skill', 'Rust');
      expect(await candidateNames(cdp)).toEqual([]);
      expect(await visible(cdp, '#empty-state')).toBe(true);

      await clearFilters(cdp);
      await selectFacetOption(cdp, 'location', 'Remote · LATAM');
      expect(await candidateNames(cdp)).toEqual(['Diego Silva']);
      await clearFilters(cdp);
      await selectFacetOption(cdp, 'location', 'New York, NY');
      expect(await candidateNames(cdp)).toEqual(['Beatrice Okafor', 'Chen Ito', 'Evelyn Stone']);
      await selectFacetOption(cdp, 'university', 'Carnegie Mellon University');
      expect(await candidateNames(cdp)).toEqual(['Chen Ito']);
      await clearFilters(cdp);
      await selectFacetOption(cdp, 'company', 'Basecamp');
      expect(await candidateNames(cdp)).toEqual(['Evelyn Stone']);

      await clearFilters(cdp);
      await setControl(cdp, 'sort', 'recent', 'change');
      expect(await candidateNames(cdp)).toEqual(['Beatrice Okafor', 'Diego Silva', 'Fatima Noor', 'Ada Rivera', 'Evelyn Stone', 'Chen Ito']);
      await setControl(cdp, 'sort', 'enriched', 'change');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Beatrice Okafor', 'Diego Silva', 'Evelyn Stone', 'Chen Ito', 'Fatima Noor']);
      await setControl(cdp, 'sort', 'relevant', 'change');
      expect(await candidateNames(cdp)).toEqual(EXPECTED_DEFAULT_NAMES);

      await setControl(cdp, 'search', 'no candidate has this phrase');
      expect(await candidateNames(cdp)).toEqual([]);
      expect(await visible(cdp, '#empty-state')).toBe(true);
      expect(await activeFilterChips(cdp, '[data-clear-search]')).toEqual(['Clear the search box']);
      await clearFilters(cdp);
      expect(await candidateNames(cdp)).toEqual(EXPECTED_DEFAULT_NAMES);
      expect(await visible(cdp, '#empty-state')).toBe(false);
      expect(await filterState(cdp)).toEqual({ search: '', availability: [], mode: [], location: [], university: [], company: [], skill: [] });
    });
  },
  30_000
);

test(
  'facet options are derived from the loaded candidates and drive an accessible combobox',
  async () => {
    await withPage(async (cdp) => {
      expect(await facetOptions(cdp, 'availability')).toEqual([
        { label: '1 month', count: 2, selected: false },
        { label: '3 months', count: 2, selected: false },
        { label: 'Immediate', count: 2, selected: false }
      ]);
      expect(await facetOptions(cdp, 'mode')).toEqual([
        { label: 'Remote', count: 3, selected: false },
        { label: 'Hybrid', count: 2, selected: false },
        { label: 'On-site', count: 1, selected: false }
      ]);
      expect(await facetOptions(cdp, 'university')).toEqual([
        { label: 'Carnegie Mellon University', count: 2, selected: false },
        { label: 'University of Waterloo', count: 2, selected: false },
        { label: 'Georgia Tech', count: 1, selected: false },
        { label: 'TU Delft', count: 1, selected: false }
      ]);
      expect(await facetOptions(cdp, 'company')).toEqual([
        { label: 'Basecamp', count: 1, selected: false },
        { label: 'Google', count: 1, selected: false },
        { label: 'Meta', count: 1, selected: false },
        { label: 'Microsoft', count: 1, selected: false },
        { label: 'Stripe', count: 1, selected: false }
      ]);
      expect(await facetOptions(cdp, 'location')).toEqual([
        { label: 'New York, NY', count: 3, selected: false },
        { label: 'London, UK', count: 1, selected: false },
        { label: 'Remote · LATAM', count: 1, selected: false },
        { label: 'Toronto, Canada', count: 1, selected: false }
      ]);

      const everyLabel = (await Promise.all(['availability', 'mode', 'location', 'university', 'company', 'skill'].map((facet) => facetOptions(cdp, facet)))).flat().map(({ label }) => label);
      for (const retired of RETIRED_HARDCODED_OPTIONS) expect(everyLabel).not.toContain(retired);

      await selectFacetOption(cdp, 'mode', 'Remote');
      expect(await facetOptions(cdp, 'university')).toEqual([
        { label: 'University of Waterloo', count: 2, selected: false },
        { label: 'Carnegie Mellon University', count: 1, selected: false }
      ]);
      expect(await facetOptions(cdp, 'mode')).toEqual([
        { label: 'Remote', count: 3, selected: true },
        { label: 'Hybrid', count: 2, selected: false },
        { label: 'On-site', count: 1, selected: false }
      ]);
      await clearFilters(cdp);

      expect(await comboWiring(cdp, 'university')).toEqual({
        inputRole: 'combobox',
        listRole: 'listbox',
        optionRole: 'option',
        multiselectable: 'true',
        autocomplete: 'list',
        controls: 'facet-university-listbox',
        labelledBy: 'facet-university-label',
        labelFor: 'facet-university-input'
      });

      await focus(cdp, 'facet-university-input');
      expect((await comboSnapshot(cdp, 'university')).expanded).toBe('false');
      await pressKey(cdp, 'ArrowDown');
      expect(await comboSnapshot(cdp, 'university')).toMatchObject({
        expanded: 'true',
        listVisible: true,
        optionCount: 4,
        activeLabel: 'Carnegie Mellon University',
        activeDescendantMatches: true
      });
      await pressKey(cdp, 'ArrowDown');
      expect((await comboSnapshot(cdp, 'university')).activeLabel).toBe('University of Waterloo');
      await pressKey(cdp, 'ArrowUp');
      expect((await comboSnapshot(cdp, 'university')).activeLabel).toBe('Carnegie Mellon University');
      await pressKey(cdp, 'ArrowUp');
      expect((await comboSnapshot(cdp, 'university')).activeLabel).toBe('TU Delft');
      await pressKey(cdp, 'Home');
      expect((await comboSnapshot(cdp, 'university')).activeLabel).toBe('Carnegie Mellon University');
      await pressKey(cdp, 'End');
      expect((await comboSnapshot(cdp, 'university')).activeLabel).toBe('TU Delft');
      await pressKey(cdp, 'Home');
      await pressKey(cdp, 'ArrowDown');
      await pressKey(cdp, 'Enter');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Diego Silva']);
      expect(await selectedPills(cdp, 'university')).toEqual(['University of Waterloo']);
      expect((await facetOptions(cdp, 'university')).find(({ label }) => label === 'University of Waterloo')?.selected).toBe(true);
      expect((await comboSnapshot(cdp, 'university')).expanded).toBe('true');
      await pressKey(cdp, 'Enter');
      expect(await candidateNames(cdp)).toEqual(EXPECTED_DEFAULT_NAMES);
      expect(await selectedPills(cdp, 'university')).toEqual([]);
      await pressKey(cdp, 'Escape');
      expect(await comboSnapshot(cdp, 'university')).toMatchObject({ expanded: 'false', listVisible: false, activeDescendant: null });

      await typeCombo(cdp, 'university', 'geor');
      expect((await facetOptions(cdp, 'university')).map(({ label }) => label)).toEqual(['Georgia Tech']);
      expect((await comboSnapshot(cdp, 'university')).expanded).toBe('true');
      await typeCombo(cdp, 'university', 'zzz');
      expect(await facetOptions(cdp, 'university')).toEqual([]);
      expect(await textContent(cdp, '#facet-university-listbox .combo-empty')).toBe('No matching options');
      await typeCombo(cdp, 'university', 'geor');
      await pressKey(cdp, 'Enter');
      expect(await candidateNames(cdp)).toEqual(['Beatrice Okafor']);
      expect(await selectedPills(cdp, 'university')).toEqual(['Georgia Tech']);
      await pressKey(cdp, 'Escape');
      await pressKey(cdp, 'Escape');
      expect(await evaluate(cdp, `document.getElementById('facet-university-input').value`)).toBe('');
      expect((await facetOptions(cdp, 'university')).map(({ label }) => label)).toEqual([
        'Carnegie Mellon University',
        'University of Waterloo',
        'Georgia Tech',
        'TU Delft'
      ]);
      await pressKey(cdp, 'Backspace');
      expect(await selectedPills(cdp, 'university')).toEqual([]);
      expect(await candidateNames(cdp)).toEqual(EXPECTED_DEFAULT_NAMES);

      await click(cdp, '[data-combo-toggle="company"]');
      expect(await comboSnapshot(cdp, 'company')).toMatchObject({ expanded: 'true', listVisible: true, optionCount: 5 });
      await click(cdp, '.results-toolbar');
      expect(await comboSnapshot(cdp, 'company')).toMatchObject({ expanded: 'false', listVisible: false });
    });
  },
  30_000
);

test(
  'filter controls become more compact as the viewport narrows',
  async () => {
    await withPage(async (cdp) => {
      const widths = [1280, 1024, 900, 860, 820, 760, 700, 560, 390];
      const measurements = [];
      for (const width of widths) {
        await setViewport(cdp, width, width < 500 ? 844 : 900, width < 500);
        await waitFor(cdp, `window.innerWidth === ${width}`);
        await waitFor(cdp, `document.getElementById('filters-toggle').getAttribute('aria-expanded') === '${width > 860}'`);
        measurements.push({ width, ...(await measureFilters(cdp)) });
      }

      const [desktop] = measurements;
      expect(desktop.width).toBe(1280);
      expect(desktop.columns).toBe(2);
      expect(desktop.toggleVisible).toBe(false);
      expect(desktop.collapsedBodyVisible).toBe(true);
      expect(desktop.panelWidth).toBeGreaterThanOrEqual(250);

      for (const measurement of measurements.slice(1)) {
        expect({ width: measurement.width, control: measurement.controlWidth <= desktop.controlWidth + 0.5 }).toEqual({ width: measurement.width, control: true });
        expect({ width: measurement.width, height: measurement.controlHeight <= desktop.controlHeight + 0.5 }).toEqual({ width: measurement.width, height: true });
        expect({ width: measurement.width, share: measurement.panelWidth / measurement.width <= 1 }).toEqual({ width: measurement.width, share: true });
      }

      for (const measurement of measurements) {
        expect({ width: measurement.width, overflow: measurement.horizontalOverflow }).toEqual({ width: measurement.width, overflow: false });
        expect({ width: measurement.width, contained: measurement.controlsWithinViewport }).toEqual({ width: measurement.width, contained: true });
        expect({ width: measurement.width, usable: measurement.controlWidth > 100 }).toEqual({ width: measurement.width, usable: true });
        const narrow = measurement.width <= 860;
        expect({ width: measurement.width, columns: measurement.columns }).toEqual({ width: measurement.width, columns: narrow ? 1 : 2 });
        expect({ width: measurement.width, toggle: measurement.toggleVisible }).toEqual({ width: measurement.width, toggle: narrow });
        expect({ width: measurement.width, collapsed: measurement.collapsedBodyVisible }).toEqual({ width: measurement.width, collapsed: !narrow });
        expect({ width: measurement.width, expanded: measurement.collapsedExpandedAttribute }).toEqual({ width: measurement.width, expanded: narrow ? 'false' : 'true' });
        if (!narrow) continue;
        expect({ width: measurement.width, footprint: measurement.collapsedPanelHeight < desktop.collapsedPanelHeight / 2 }).toEqual({ width: measurement.width, footprint: true });
        expect({ width: measurement.width, page: measurement.collapsedPanelHeight < measurement.viewportHeight * 0.4 }).toEqual({ width: measurement.width, page: true });
      }

      await setViewport(cdp, 390, 844, true);
      await waitFor(cdp, 'window.innerWidth === 390');
      await setControl(cdp, 'search', 'KUBERNETES');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera']);
      await clearFilters(cdp);
      await expandFilters(cdp);
      await selectFacetOption(cdp, 'mode', 'Remote');
      await selectFacetOption(cdp, 'location', 'Remote · LATAM');
      expect(await candidateNames(cdp)).toEqual(['Diego Silva']);
      await clearFilters(cdp);
      expect(await candidateNames(cdp)).toEqual(EXPECTED_DEFAULT_NAMES);
    });
  },
  30_000
);

test(
  'candidate cards link a source only when its URL is https, and never render a hostile scheme',
  async () => {
    await withPage(async (cdp) => {
      expect(await sourceCells(cdp)).toEqual([
        { name: 'Ada Rivera', text: 'from HN · July 2026', href: 'https://news.ycombinator.com/item?id=44601001', target: '_blank', rel: 'noopener noreferrer' },
        { name: 'Beatrice Okafor', text: 'from HN · July 2026', href: null, target: null, rel: null },
        { name: 'Chen Ito', text: 'from HN · June 2026', href: null, target: null, rel: null },
        { name: 'Diego Silva', text: 'from HN · July 2026', href: 'https://news.ycombinator.com/item?id=44601004', target: '_blank', rel: 'noopener noreferrer' },
        { name: 'Evelyn Stone', text: 'from HN · July 2026', href: null, target: null, rel: null },
        {
          name: 'Fatima Noor',
          text: 'from HN · July 2026',
          href: 'https://news.ycombinator.com/item?id=44601006&x=%22%3E%3Cscript%3Ealert(1)%3C/script%3E',
          target: '_blank',
          rel: 'noopener noreferrer'
        }
      ]);
      expect(await evaluate(cdp, `[...document.querySelectorAll('a')].some((link) => link.protocol === 'javascript:')`)).toBe(false);
      expect(await evaluate(cdp, `document.querySelectorAll('script').length`)).toBe(1);

      await selectFacetOption(cdp, 'mode', 'Hybrid');
      expect(await sourceCells(cdp)).toEqual([
        { name: 'Beatrice Okafor', text: 'from HN · July 2026', href: null, target: null, rel: null },
        { name: 'Evelyn Stone', text: 'from HN · July 2026', href: null, target: null, rel: null }
      ]);
      await clearFilters(cdp);
    });
  },
  30_000
);

test(
  'the page carries an unbranded identity, no submission-first framing, and only derived statistics',
  async () => {
    await withPage(async (cdp) => {
      expect(await evaluate(cdp, 'document.title')).toBe('Who wants to be hired · Candidate directory');
      expect(await textContent(cdp, '.brand')).toBe('Who wants to be hired');
      expect(await evaluate(cdp, `/ellache|built in public/i.test(document.documentElement.innerHTML)`)).toBe(false);
      expect(await evaluate(cdp, `document.querySelector('.pipeline-card')`)).toBe(null);

      expect(await evaluate(cdp, `[...document.querySelectorAll('.stats div')].map((stat) => [stat.querySelector('strong').textContent, stat.querySelector('span').textContent])`)).toEqual([
        ['6', 'candidate profiles'],
        ['4', 'universities represented'],
        ['4', 'profiles enriched']
      ]);

      const markup = await evaluate(cdp, `fetch('/who-is-hiring.html').then((response) => response.text())`);
      for (const fabricated of ['1,284', '>38<', '>612<', '100%', 'source-linked']) expect(markup).not.toContain(fabricated);

      expect(await evaluate(cdp, `[...document.querySelectorAll('.hero-actions > *')].map((action) => [action.tagName, action.className])`)).toEqual([
        ['A', 'button button-primary'],
        ['BUTTON', 'text-link']
      ]);
      expect(await evaluate(cdp, `[...document.querySelectorAll('[data-open-import]')].map((button) => button.className)`)).toEqual(['text-link', 'text-link']);

      await click(cdp, '.hero-actions [data-open-import]');
      expect(await evaluate(cdp, `document.getElementById('import-dialog').open`)).toBe(true);
      await click(cdp, '#import-dialog [data-close-dialog]');
      expect(await evaluate(cdp, `document.getElementById('import-dialog').open`)).toBe(false);
    });
  },
  30_000
);

async function withPage(run) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'hn-candidate-browser-'));
  let server;
  let browser;

  try {
    server = createFixtureServer();
    browser = await launchBrowser(temporaryRoot);
    const cdp = await connectToPage(browser.devToolsUrl);
    const runtimeExceptions = [];
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => runtimeExceptions.push(exceptionDetails.text));

    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Network.enable')]);
    await cdp.send('Network.setBlockedURLs', { urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'] });
    await setViewport(cdp, 1280, 900, false);
    await navigate(cdp, `http://127.0.0.1:${server.port}/`);
    await waitFor(cdp, `document.querySelector('.candidate-name')?.textContent === 'Ada Rivera'`);

    await run(cdp);
    expect(runtimeExceptions).toEqual([]);
    cdp.close();
  } finally {
    server?.stop(true);
    if (browser) {
      browser.process.kill();
      await browser.process.exited;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function createFixtureServer() {
  const assets = new Map([
    ['/', ['who-is-hiring.html', 'text/html; charset=utf-8']],
    ['/who-is-hiring.html', ['who-is-hiring.html', 'text/html; charset=utf-8']],
    ['/who-is-hiring.css', ['who-is-hiring.css', 'text/css; charset=utf-8']],
    ['/who-is-hiring.js', ['who-is-hiring.js', 'text/javascript; charset=utf-8']],
    ['/sensitive-data.js', ['sensitive-data.js', 'text/javascript; charset=utf-8']]
  ]);

  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/api/candidates') {
        return Response.json({ candidates: PUBLIC_CANDIDATES }, { headers: { 'cache-control': 'no-store' } });
      }
      const asset = assets.get(pathname);
      if (!asset) return new Response('Not found', { status: 404 });
      return new Response(Bun.file(join(REPO_ROOT, asset[0])), {
        headers: { 'cache-control': 'no-store', 'content-type': asset[1] }
      });
    }
  });
}

async function launchBrowser(temporaryRoot) {
  const configuredBrowser = process.env.BROWSER_BIN;
  const candidates = configuredBrowser
    ? [configuredBrowser]
    : [
        '/opt/homebrew/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable'
      ];
  const launchErrors = [];

  for (const [index, executable] of candidates.entries()) {
    try {
      await access(executable, constants.X_OK);
    } catch {
      launchErrors.push(`${executable}: not executable`);
      continue;
    }

    const profilePath = join(temporaryRoot, `profile-${index}`);
    await mkdir(profilePath);
    const browserProcess = Bun.spawn(
      [
        executable,
        '--headless=new',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-gpu',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--no-first-run',
        '--no-sandbox',
        '--password-store=basic',
        '--remote-debugging-port=0',
        `--user-data-dir=${profilePath}`,
        '--use-mock-keychain',
        'about:blank'
      ],
      { stdout: 'ignore', stderr: 'pipe' }
    );

    try {
      const devToolsUrl = await readDevToolsUrl(browserProcess, executable);
      return { process: browserProcess, devToolsUrl, executable };
    } catch (error) {
      browserProcess.kill();
      await browserProcess.exited;
      launchErrors.push(error.message);
      if (configuredBrowser) break;
    }
  }

  const prefix = configuredBrowser ? `BROWSER_BIN could not launch (${configuredBrowser})` : 'No supported Chromium browser could launch';
  throw new Error(`${prefix}: ${launchErrors.join('; ')}`);
}

async function readDevToolsUrl(browserProcess, executable) {
  const reader = browserProcess.stderr.getReader();
  const readUrl = async () => {
    const decoder = new TextDecoder();
    let output = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`${executable}: exited before opening DevTools${output.trim() ? ` (${output.trim()})` : ''}`);
      output += decoder.decode(value, { stream: true });
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        void drain(reader);
        return match[1];
      }
      if (output.length > 4_000) output = output.slice(-4_000);
    }
  };
  return Promise.race([
    readUrl(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${executable}: timed out opening DevTools`)), 8_000))
  ]);
}

async function drain(reader) {
  while (!(await reader.read()).done) {}
}

async function connectToPage(devToolsUrl) {
  const browserEndpoint = new URL(devToolsUrl);
  const listEndpoint = `http://${browserEndpoint.host}/json/list`;
  let page;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const targets = await fetch(listEndpoint).then((response) => response.json());
    if (!Array.isArray(targets)) throw new Error(`Chromium returned an invalid target list: ${JSON.stringify(targets)}`);
    page = targets.find((target) => target.type === 'page');
    if (page) break;
    await Bun.sleep(50);
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('Chromium opened DevTools without a page target');
  return CdpConnection.open(page.webSocketDebuggerUrl);
}

class CdpConnection {
  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to the Chromium page target')), 5_000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Could not connect to the Chromium page target'));
      });
    });
    return new CdpConnection(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.receive(JSON.parse(String(event.data))));
  }

  receive(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 5_000);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  once(method) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${method} event timed out`)), 5_000);
      const listener = (params) => {
        clearTimeout(timeout);
        const listeners = this.listeners.get(method) || [];
        this.listeners.set(method, listeners.filter((candidate) => candidate !== listener));
        resolve(params);
      };
      this.on(method, listener);
    });
  }

  close() {
    this.socket.close();
  }
}

async function setViewport(cdp, width, height, mobile) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    screenWidth: width,
    screenHeight: height,
    deviceScaleFactor: 1,
    mobile
  });
}

async function navigate(cdp, url) {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

async function waitFor(cdp, expression) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Browser condition did not become true: ${expression}`);
}

async function candidateNames(cdp) {
  return evaluate(cdp, `[...document.querySelectorAll('.candidate-name')].map((element) => element.textContent)`);
}

async function sourceCells(cdp) {
  return evaluate(
    cdp,
    `[...document.querySelectorAll('.candidate-card')].map((card) => {
      const cell = card.querySelector('.source-cell');
      const link = cell.querySelector('a');
      return {
        name: card.querySelector('.candidate-name').textContent,
        text: cell.textContent,
        href: link ? link.getAttribute('href') : null,
        target: link ? link.getAttribute('target') : null,
        rel: link ? link.getAttribute('rel') : null
      };
    })`
  );
}

async function textContent(cdp, selector) {
  return evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).textContent`);
}

async function attribute(cdp, selector, name) {
  return evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).getAttribute(${JSON.stringify(name)})`);
}

async function visible(cdp, selector) {
  return evaluate(cdp, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); const box = element.getBoundingClientRect(); return !element.hidden && box.width > 0 && box.height > 0; })()`);
}

async function setControl(cdp, id, value, eventName = 'input') {
  await evaluate(
    cdp,
    `(() => { const control = document.getElementById(${JSON.stringify(id)}); control.value = ${JSON.stringify(value)}; control.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true })); })()`
  );
}

async function click(cdp, selector) {
  await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function focus(cdp, id) {
  await evaluate(cdp, `document.getElementById(${JSON.stringify(id)}).focus()`);
}

async function pressKey(cdp, key) {
  const virtualKeyCode = KEY_CODES[key];
  const payload = { key, code: key, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...payload });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...payload });
}

async function clearFilters(cdp) {
  await click(cdp, '#clear-filters');
}

async function expandFilters(cdp) {
  await evaluate(cdp, `(() => { const toggle = document.getElementById('filters-toggle'); if (toggle.getAttribute('aria-expanded') === 'false') toggle.click(); })()`);
}

async function selectFacetOption(cdp, facetKey, label) {
  const selector = `[data-facet-option="${facetKey}"],[data-facet-toggle="${facetKey}"]`;
  await evaluate(
    cdp,
    `(() => {
      const option = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.dataset.label === ${JSON.stringify(label)});
      if (!option) throw new Error('No ' + ${JSON.stringify(facetKey)} + ' option labelled ' + ${JSON.stringify(label)});
      option.click();
    })()`
  );
}

async function facetOptions(cdp, facetKey) {
  return evaluate(
    cdp,
    `(() => {
      const container = document.getElementById('facet-' + ${JSON.stringify(facetKey)} + '-listbox') || document.getElementById('facet-' + ${JSON.stringify(facetKey)} + '-options');
      return [...container.querySelectorAll('[data-facet-option],[data-facet-toggle]')].map((option) => ({
        label: option.dataset.label,
        count: Number(option.querySelector('.option-count,.pill-count').textContent),
        selected: option.getAttribute('aria-selected') === 'true' || option.getAttribute('aria-pressed') === 'true'
      }));
    })()`
  );
}

async function selectedPills(cdp, facetKey) {
  return evaluate(cdp, `[...document.getElementById('facet-' + ${JSON.stringify(facetKey)} + '-selected').querySelectorAll('[data-facet-remove]')].map((pill) => pill.textContent.replace('×', ''))`);
}

async function activeFilterChips(cdp, selector = '[data-facet-remove]') {
  return evaluate(cdp, `[...document.querySelectorAll('#active-filters ' + ${JSON.stringify(selector)})].map((chip) => chip.getAttribute('aria-label'))`);
}

async function removeActiveFilterChip(cdp, ariaLabel) {
  await evaluate(
    cdp,
    `(() => {
      const chip = [...document.querySelectorAll('#active-filters [data-facet-remove]')].find((item) => item.getAttribute('aria-label') === ${JSON.stringify(ariaLabel)});
      if (!chip) throw new Error('No active filter chip labelled ' + ${JSON.stringify(ariaLabel)});
      chip.click();
    })()`
  );
}

async function typeCombo(cdp, facetKey, value) {
  await focus(cdp, `facet-${facetKey}-input`);
  await setControl(cdp, `facet-${facetKey}-input`, value);
}

async function comboWiring(cdp, facetKey) {
  return evaluate(
    cdp,
    `(() => {
      const facet = ${JSON.stringify(facetKey)};
      const input = document.getElementById('facet-' + facet + '-input');
      const list = document.getElementById('facet-' + facet + '-listbox');
      const label = document.getElementById('facet-' + facet + '-label');
      return {
        inputRole: input.getAttribute('role'),
        listRole: list.getAttribute('role'),
        optionRole: list.querySelector('[data-facet-option]').getAttribute('role'),
        multiselectable: list.getAttribute('aria-multiselectable'),
        autocomplete: input.getAttribute('aria-autocomplete'),
        controls: input.getAttribute('aria-controls'),
        labelledBy: list.getAttribute('aria-labelledby'),
        labelFor: label.getAttribute('for')
      };
    })()`
  );
}

async function comboSnapshot(cdp, facetKey) {
  return evaluate(
    cdp,
    `(() => {
      const facet = ${JSON.stringify(facetKey)};
      const input = document.getElementById('facet-' + facet + '-input');
      const list = document.getElementById('facet-' + facet + '-listbox');
      const active = list.querySelector('.combo-option.is-active');
      const activeDescendant = input.getAttribute('aria-activedescendant');
      return {
        expanded: input.getAttribute('aria-expanded'),
        listVisible: !list.hidden && list.getBoundingClientRect().height > 0,
        optionCount: list.querySelectorAll('[role="option"]').length,
        activeLabel: active ? active.dataset.label : null,
        activeDescendant,
        activeDescendantMatches: activeDescendant === (active ? active.id : null)
      };
    })()`
  );
}

async function filterState(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const selected = (facet) => [...document.querySelectorAll('#facet-' + facet + '-selected [data-facet-remove], #facet-' + facet + '-options [aria-pressed="true"]')].map((pill) => pill.dataset.value);
      return {
        search: document.getElementById('search').value,
        availability: selected('availability'),
        mode: selected('mode'),
        location: selected('location'),
        university: selected('university'),
        company: selected('company'),
        skill: selected('skill')
      };
    })()`
  );
}

async function measureFilters(cdp) {
  const collapsed = await filterMetrics(cdp);
  if (collapsed.bodyVisible) {
    return {
      ...collapsed,
      collapsedBodyVisible: collapsed.bodyVisible,
      collapsedPanelHeight: collapsed.panelHeight,
      collapsedExpandedAttribute: collapsed.toggleExpanded
    };
  }
  await click(cdp, '#filters-toggle');
  const expanded = await filterMetrics(cdp);
  await click(cdp, '#filters-toggle');
  return {
    ...expanded,
    collapsedBodyVisible: collapsed.bodyVisible,
    collapsedPanelHeight: collapsed.panelHeight,
    collapsedExpandedAttribute: collapsed.toggleExpanded
  };
}

async function filterMetrics(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const panel = document.getElementById('filters-panel');
      const body = document.getElementById('filters-body');
      const toggle = document.getElementById('filters-toggle');
      const control = document.getElementById('facet-university-input');
      const controls = [...document.querySelectorAll('.filters-panel input, .filters-panel .pill, .results-toolbar select')];
      const withinViewport = (element) => {
        const box = element.getBoundingClientRect();
        return box.left >= -1 && box.right <= window.innerWidth + 1;
      };
      return {
        viewportHeight: window.innerHeight,
        columns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(' ').filter(Boolean).length,
        panelWidth: panel.getBoundingClientRect().width,
        panelHeight: panel.getBoundingClientRect().height,
        bodyVisible: body.getBoundingClientRect().height > 0,
        toggleVisible: getComputedStyle(toggle).display !== 'none',
        toggleExpanded: toggle.getAttribute('aria-expanded'),
        controlWidth: control.getBoundingClientRect().width,
        controlHeight: control.getBoundingClientRect().height,
        controlsWithinViewport: controls.every(withinViewport),
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
      };
    })()`
  );
}
