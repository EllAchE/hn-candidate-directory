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
    location: 'Atlanta, GA',
    university: 'Georgia Tech',
    companies: ['Microsoft'],
    skills: ['Python', 'PyTorch', 'Experimentation'],
    summary: 'Evaluates trustworthy climate models with product and research teams.',
    source: 'HN · July 2026',
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
    location: 'Boston, MA',
    university: 'University of Texas at Dallas',
    companies: ['YC startup'],
    skills: ['Go', 'Security', 'Cloud'],
    summary: 'Builds practical fintech security controls for early-stage teams.',
    source: 'HN · July 2026',
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
    enriched: false,
    posted: 3,
    publishedAt: '2026-07-28T12:00:00.000Z'
  }
];

const EXPECTED_DEFAULT_NAMES = PUBLIC_CANDIDATES.map(({ name }) => name);

test(
  'public browse, search, sorting, and filters work in a real browser at desktop and mobile viewports',
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'hn-candidate-browser-'));
    const server = createFixtureServer();
    let browser;

    try {
      browser = await launchBrowser(temporaryRoot);
      const cdp = await connectToPage(browser.devToolsUrl);
      const runtimeExceptions = [];
      cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => runtimeExceptions.push(exceptionDetails.text));

      await Promise.all([
        cdp.send('Page.enable'),
        cdp.send('Runtime.enable'),
        cdp.send('Network.enable')
      ]);
      await cdp.send('Network.setBlockedURLs', {
        urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*']
      });

      await setViewport(cdp, 1280, 900, false);
      await navigate(cdp, `http://127.0.0.1:${server.port}/`);
      await waitFor(cdp, `document.querySelector('.candidate-name')?.textContent === 'Ada Rivera'`);

      expect(await candidateNames(cdp)).toEqual(EXPECTED_DEFAULT_NAMES);
      expect(await textContent(cdp, '#candidate-count')).toBe('6');
      expect(await textContent(cdp, '#result-count')).toBe('6');

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
      await setControl(cdp, 'availability', 'Immediate');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Evelyn Stone']);

      await clearFilters(cdp);
      await setControl(cdp, 'work-mode', 'Hybrid');
      expect(await candidateNames(cdp)).toEqual(['Beatrice Okafor', 'Evelyn Stone']);

      await clearFilters(cdp);
      await setControl(cdp, 'university', 'University of Waterloo');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Diego Silva']);

      await clearFilters(cdp);
      await setControl(cdp, 'company', 'Meta');
      expect(await candidateNames(cdp)).toEqual(['Chen Ito']);

      await clearFilters(cdp);
      await setControl(cdp, 'skill', 'rUsT');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Diego Silva']);

      await clearFilters(cdp);
      await setControl(cdp, 'work-mode', 'Remote');
      await setControl(cdp, 'availability', '1 month');
      await setControl(cdp, 'university', 'University of Waterloo');
      await setControl(cdp, 'skill', 'rust');
      expect(await candidateNames(cdp)).toEqual(['Diego Silva']);

      await setControl(cdp, 'search', 'no candidate has this phrase');
      expect(await candidateNames(cdp)).toEqual([]);
      expect(await visible(cdp, '#empty-state')).toBe(true);
      await click(cdp, '#clear-filters');
      expect(await candidateNames(cdp)).toEqual(EXPECTED_DEFAULT_NAMES);
      expect(await visible(cdp, '#empty-state')).toBe(false);
      expect(await controlValues(cdp)).toEqual({ search: '', availability: '', mode: '', university: '', company: '', skill: '' });

      await setControl(cdp, 'sort', 'recent', 'change');
      expect(await candidateNames(cdp)).toEqual(['Beatrice Okafor', 'Diego Silva', 'Fatima Noor', 'Ada Rivera', 'Evelyn Stone', 'Chen Ito']);
      await setControl(cdp, 'sort', 'enriched', 'change');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera', 'Beatrice Okafor', 'Diego Silva', 'Evelyn Stone', 'Chen Ito', 'Fatima Noor']);
      await setControl(cdp, 'sort', 'relevant', 'change');
      expect(await candidateNames(cdp)).toEqual(EXPECTED_DEFAULT_NAMES);

      const desktopLayout = await layoutSnapshot(cdp);
      expect(desktopLayout.viewportWidth).toBe(1280);
      expect(desktopLayout.workspaceColumns).toHaveLength(2);
      expect(desktopLayout.filterWidth).toBeGreaterThanOrEqual(250);
      expect(desktopLayout.resultsLeft).toBeGreaterThan(desktopLayout.filterRight);
      expect(desktopLayout.navLinksVisible).toBe(true);
      expect(desktopLayout.controlsVisible).toBe(true);
      expect(desktopLayout.cardsContained).toBe(true);
      expect(desktopLayout.hasHorizontalOverflow).toBe(false);

      await setViewport(cdp, 390, 844, true);
      await waitFor(cdp, 'window.innerWidth === 390');
      await clearFilters(cdp);
      await setControl(cdp, 'search', 'KUBERNETES');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera']);
      await setControl(cdp, 'work-mode', 'Remote');
      await setControl(cdp, 'availability', 'Immediate');
      expect(await candidateNames(cdp)).toEqual(['Ada Rivera']);
      await clearFilters(cdp);
      await setControl(cdp, 'skill', 'python');
      expect(await candidateNames(cdp)).toEqual(['Beatrice Okafor']);
      await clearFilters(cdp);

      const mobileLayout = await layoutSnapshot(cdp);
      expect(mobileLayout.viewportWidth).toBe(390);
      expect(mobileLayout.workspaceColumns).toHaveLength(1);
      expect(mobileLayout.resultsTop).toBeGreaterThanOrEqual(mobileLayout.filterBottom);
      expect(mobileLayout.navLinksVisible).toBe(false);
      expect(mobileLayout.controlsVisible).toBe(true);
      expect(mobileLayout.cardsContained).toBe(true);
      expect(mobileLayout.hasHorizontalOverflow).toBe(false);
      expect(await candidateNames(cdp)).toEqual(EXPECTED_DEFAULT_NAMES);
      expect(runtimeExceptions).toEqual([]);

      cdp.close();
    } finally {
      server.stop(true);
      if (browser) {
        browser.process.kill();
        await browser.process.exited;
      }
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
  30_000
);

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
    const process = Bun.spawn(
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
      const devToolsUrl = await readDevToolsUrl(process, executable);
      return { process, devToolsUrl, executable };
    } catch (error) {
      process.kill();
      await process.exited;
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

async function textContent(cdp, selector) {
  return evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).textContent`);
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

async function clearFilters(cdp) {
  await click(cdp, '#clear-filters');
}

async function controlValues(cdp) {
  return evaluate(
    cdp,
    `({ search: search.value, availability: availability.value, mode: document.getElementById('work-mode').value, university: university.value, company: company.value, skill: skill.value })`
  );
}

async function layoutSnapshot(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const workspace = document.querySelector('.workspace');
      const filters = document.querySelector('.filters-panel').getBoundingClientRect();
      const results = document.querySelector('.results-panel').getBoundingClientRect();
      const cards = [...document.querySelectorAll('.candidate-card')];
      const controls = [...document.querySelectorAll('.filters-panel input, .filters-panel select, .results-toolbar select')];
      const withinViewport = (element) => {
        const box = element.getBoundingClientRect();
        return box.left >= -1 && box.right <= window.innerWidth + 1;
      };
      return {
        viewportWidth: window.innerWidth,
        workspaceColumns: getComputedStyle(workspace).gridTemplateColumns.split(' ').filter(Boolean),
        filterWidth: filters.width,
        filterRight: filters.right,
        filterBottom: filters.bottom,
        resultsLeft: results.left,
        resultsTop: results.top,
        navLinksVisible: [...document.querySelectorAll('nav a')].every((link) => getComputedStyle(link).display !== 'none'),
        controlsVisible: controls.every((control) => {
          const box = control.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && withinViewport(control);
        }),
        cardsContained: cards.length === ${PUBLIC_CANDIDATES.length} && cards.every(withinViewport),
        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
      };
    })()`
  );
}
