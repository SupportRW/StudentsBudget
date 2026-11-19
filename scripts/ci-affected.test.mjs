// The tests of scripts/ci-affected.mjs and of the map: `node --test scripts/ci-affected.test.mjs`, Node's built-ins only.
// The pure tests run on a made-up Next.js app in a temp folder, with the template's default config: a repo that plugs
// in another router, spec folder or alias adapts APP and MAP below. "this repo" holds the real map, Playwright config
// and ci.yml to the script.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CHROMIUM_PROJECT, JOBS, MAP_FILE, NO_E2E, SMOKE_SPEC, SPEC, SPEC_DIR, SPEC_SUFFIX,
  e2eArgs, forScope, githubOutput, handPicked, importsOf, readRepo, requiredJobs, routePages, runOptions,
  selectAffected, statusContext, statusDescription, summary, unresolvedImports, verdict,
} from './ci-affected.mjs';

/** The CI workflow whose gate and concurrency the last tests check. */
const WORKFLOW = '.github/workflows/ci.yml';

/** A small made-up app: the root layout loads the shell, Home holds a card, Orders and Items share the item list. */
const APP = {
  'src/app/layout.tsx': "import { Shell } from '@/components/shell';\nimport './globals.css';\n",
  'src/app/globals.css': '', 'src/app/favicon.ico': '',
  'src/components/shell.tsx': "import { theme } from '@/lib/theme';\n",
  'src/lib/theme.ts': '', 'src/lib/money.ts': '', 'src/lib/orphan.ts': '',
  'src/lib/money.test.ts': "import { formatMoney } from './money';\n",
  'src/data/notes.json': '', 'src/data/topics.ts': '', 'src/server/db.ts': '', 'src/monkey/walk.ts': '',
  'src/app/page.tsx': "import { Home } from '@/features/home/home';\n",
  'src/features/home/home.tsx': "import {\n  Card,\n  type CardProps,\n} from '@/features/cards/card';\n",
  'src/features/cards/card.tsx': "import { formatMoney } from '@/lib/money';\n",
  'src/app/orders/page.tsx': "import { OrdersView } from '@/features/orders/orders-view';\n",
  'src/app/orders/layout.tsx': '', 'src/app/orders/[id]/page.tsx': '',
  'src/features/orders/orders-view.tsx': "import { rows } from './rows';\nexport { ItemList } from '@/features/items/item-list';\n",
  'src/features/orders/rows.ts': '',
  'src/features/items/item-list.tsx': "import { formatMoney } from '../../lib/money';\n",
  'src/app/items/page.tsx': "const list = await import('@/features/items/item-list');\n",
  'src/app/help/page.tsx': "import { HelpView } from '../../features/help/help-view';\n",
  'src/features/help/help-view.tsx': "import { TOPICS } from '@/data/topics';\n",
  'src/app/settings/page.tsx': "import { Panels } from '@/features/settings/panels';\n",
  'src/features/settings/panels.tsx': '', 'src/app/reports/page.tsx': '',
  'e2e/helpers/app.ts': '', 'e2e/smoke.spec.ts': '', 'e2e/order-detail.spec.ts': '', 'e2e/items.spec.ts': '', 'e2e/settings.spec.ts': '',
  'e2e/orders.spec.ts': "import { openApp } from './helpers/app';\n",
  'e2e/help.spec.ts': "import { TOPICS } from '../src/data/topics';\n",
  'e2e/topics.spec.ts': "import { TOPICS } from '../src/data/topics';\n",
  'docs/plan.md': '', 'README.md': '', 'next.config.ts': '', 'package.json': '',
};
/** Route → the specs that open it; /reports is left out on purpose. */
const MAP = {
  routes: { '/': 'all', '/orders': ['orders'], '/orders/[id]': ['order-detail'], '/items': ['items', 'orders'], '/help': ['help'], '/settings': 'all' },
  allOnly: ['settings'],
};
/** Three made-up repo layers, one of each kind. */
const LAYERS = [
  { job: 'stack', paths: [/^src\/server\//], quick: true },
  { job: 'production', paths: [/^next\.config\./], allSpecs: true },
  { job: 'monkey', paths: [/^src\/monkey\//], full: false },
];

let dir, repo;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ci-affected-'));
  const files = { ...APP, [MAP_FILE]: JSON.stringify(MAP) };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  mkdirSync(path.join(dir, 'scripts'));
  copyFileSync(fileURLToPath(new URL('./ci-affected.mjs', import.meta.url)), path.join(dir, 'scripts', 'ci-affected.mjs'));
  repo = readRepo(dir);
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** The selection on the made-up app, with no repo layer unless a test passes its own: the repo's LAYERS don't count here. */
const select = (changed, more = {}) => selectAffected({ changed, repo, map: MAP, layers: [], ...more });

describe('importsOf', () => {
  it('finds static, type-only, side-effect, re-exported, multi-line, dynamic and required imports', () => {
    const source = [
      "import { a } from '@/lib/a';", "import type { B } from './b';", "import './globals.css';", "export { c } from '../c';",
      "export * from '@/lib/d';", 'import {', '  e,', '  type E,', "} from '@/lib/e';", "const f = await import('@/lib/f');",
      "const g = require('./g');", "import { useState } from 'react';",
    ].join('\n');
    assert.deepEqual(importsOf(source), ['@/lib/a', './b', './globals.css', '../c', '@/lib/d', '@/lib/e', '@/lib/f', './g', 'react']);
  });
});

describe('selectAffected', () => {
  it('runs nothing for notes, and only the checks for a unit test or a module nothing imports', () => {
    assert.equal(select(['docs/plan.md', 'README.md']).run, false);
    for (const file of ['src/lib/money.test.ts', 'src/lib/orphan.ts']) assert.deepEqual([select([file]).run, select([file]).e2e], [true, 'none'], file);
  });

  it('picks the specs of every route a change reaches, plus smoke, and every spec that imports it', () => {
    const picks = (file, specs, why) => assert.deepEqual(select([file]).e2e, specs, why);
    picks('src/features/orders/rows.ts', ['orders.spec.ts', 'smoke.spec.ts'], 'a leaf module');
    picks('src/features/items/item-list.tsx', ['items.spec.ts', 'orders.spec.ts', 'smoke.spec.ts'], 'through a re-export and a dynamic import');
    picks('src/features/help/help-view.tsx', ['help.spec.ts', 'smoke.spec.ts'], 'through a relative import');
    picks('src/data/topics.ts', ['help.spec.ts', 'smoke.spec.ts', 'topics.spec.ts'], 'imported by a spec itself');
    picks('src/app/orders/layout.tsx', ['order-detail.spec.ts', 'orders.spec.ts', 'smoke.spec.ts'], 'a layout: its route and those below');
  });

  it('runs everything for the root layout, a route mapped to all, a route the map lacks, or a path no rule matches', () => {
    for (const file of [
      'src/app/layout.tsx', 'src/components/shell.tsx', 'src/lib/theme.ts', 'src/app/globals.css', 'src/features/cards/card.tsx',
      'src/lib/money.ts', 'src/features/settings/panels.tsx', 'src/app/reports/page.tsx', 'next.config.ts', 'package.json',
      'package-lock.json', '.github/workflows/ci.yml', 'src/app/favicon.ico', 'src/data/notes.json', 'e2e/helpers/app.ts', 'vitest.config.ts',
    ]) assert.equal(select([file]).e2e, 'all', file);
  });

  it('drops a deleted module or spec, and runs a changed spec, which the repeat check repeats', () => {
    assert.deepEqual(select(['src/features/old.tsx', 'e2e/gone.spec.ts']), { run: true, e2e: 'none', repeat: [], layers: [], why: {} });
    assert.deepEqual(select(['e2e/help.spec.ts', 'e2e/gone.spec.ts']).e2e, ['help.spec.ts', 'smoke.spec.ts']);
    assert.deepEqual(select(['e2e/help.spec.ts', 'e2e/gone.spec.ts', 'src/lib/money.ts']).repeat, ['help.spec.ts']);
  });

  it('runs everything in a full run, or when what changed is unknown, even with nothing changed', () => {
    assert.equal(select([], { full: true }).e2e, 'all');
    assert.deepEqual(select([], { diffError: 'no origin/main' }).why.all, ['what the branch changes is unknown: no origin/main']);
    assert.deepEqual(select([]).why.skip, ['nothing changed against origin/main']);
  });

  it('says why each spec was picked', () => {
    const { why } = select(['src/features/orders/rows.ts', 'src/data/topics.ts']);
    assert.deepEqual(why['orders.spec.ts'], ['`src/features/orders/rows.ts` → /orders']);
    assert.deepEqual(why['topics.spec.ts'], ['`src/data/topics.ts` is imported by the spec']);
    assert.deepEqual(why['smoke.spec.ts'], ['runs with every list']);
    assert.deepEqual(select(['src/lib/theme.ts']).why.all, ['`src/lib/theme.ts` reaches the root layout']);
    assert.deepEqual(select(['src/app/reports/page.tsx']).why.all, [`\`src/app/reports/page.tsx\` → /reports, which ${MAP_FILE} does not list`]);
    assert.deepEqual(select(['package.json']).why.all, ['`package.json`: no rule matches it']);
  });
});

describe('repo layers', () => {
  const layered = (changed, more = {}) => select(changed, { layers: LAYERS, ...more });

  it('turn on for their paths; in a full run or for an unknown path unless full: false; with every spec if allSpecs', () => {
    assert.deepEqual(layered(['src/server/db.ts']), { run: true, e2e: 'none', repeat: [], layers: ['stack'], why: { stack: ['`src/server/db.ts`'] } });
    assert.deepEqual(layered(['src/monkey/walk.ts']).layers, ['monkey']);
    assert.deepEqual(layered(['next.config.ts']).layers, ['stack', 'production']);
    assert.deepEqual(layered([], { full: true }).layers, ['stack', 'production']);
    assert.deepEqual(layered(['src/lib/theme.ts']).layers, ['production']);
    assert.deepEqual(layered(['src/features/orders/rows.ts']).layers, []);
  });

  it('stay in a quick run only when marked quick, and the gate needs them', () => {
    const picked = layered(['src/server/db.ts', 'next.config.ts', 'e2e/help.spec.ts']);
    assert.deepEqual(requiredJobs(picked), ['checks', 'e2e', 'e2e-report', 'repeat', 'stack', 'production']);
    const quick = forScope(picked, runOptions({ scope: 'quick' }), LAYERS);
    assert.deepEqual([quick.e2e, quick.repeat, quick.layers], ['none', [], ['stack']]);
    assert.deepEqual(requiredJobs(quick), ['checks', 'stack']);
    assert.match(summary(layered(['src/server/db.ts'])), /\| no e2e spec \| [^\n]*\n\| repo layer `stack` \| `src\/server\/db\.ts` \|/);
  });
});

describe('a pull request’s quick run', () => {
  it('keeps the checks, drops e2e and the repeat, and says why in the summary', () => {
    const options = runOptions({ scope: 'quick' });
    const quick = forScope(select(['src/features/orders/rows.ts', 'e2e/help.spec.ts']), options);
    assert.deepEqual(requiredJobs(quick), ['checks']);
    assert.match(summary(quick, options), /Scope \*\*quick\*\*/);
    assert.match(summary(quick, options), /\| no e2e spec \| a pull request’s automatic run has no e2e: start a changed or full run by hand \|/);
    const picked = select(['src/lib/money.ts']);
    assert.equal(forScope(picked, runOptions()), picked, 'a changed run stays as picked');
  });
});

describe('runOptions and the status', () => {
  it('runs a changed run on Chromium in the default language, and a full run on everything, by default', () => {
    assert.deepEqual(runOptions(), {
      scope: 'changed', full: false, e2e: true, browsers: 'chromium', languages: 'default',
      projectArgs: `--project=${CHROMIUM_PROJECT}`, specs: [], shards: 4, auto: ['browsers', 'languages'],
    });
    assert.deepEqual(runOptions({ scope: 'full' }), { ...runOptions(), scope: 'full', full: true, browsers: 'all', languages: 'all', projectArgs: '' });
    assert.equal(runOptions({ scope: 'quick' }).e2e, false);
    assert.equal(runOptions({ shards: '2' }).shards, 2);
  });

  it('refuses a value the inputs do not offer, and any spec but a plain file name', () => {
    for (const bad of [{ scope: 'everything' }, { browsers: 'webkit' }, { languages: 'de' }, { shards: '0' }, { shards: 'x' }]) {
      assert.throws(() => runOptions(bad), RangeError, JSON.stringify(bad));
    }
    for (const bad of ['../x.spec.ts', 'e2e/help.spec.ts', 'help', '--grep=x', 'help.spec.ts;rm', '*.spec.ts']) {
      assert.throws(() => runOptions({ specs: bad }), /specs/, bad);
    }
  });

  it('posts full-gate only for a full run on every browser and language', () => {
    assert.equal(statusContext({ scope: 'full' }), 'full-gate');
    assert.equal(statusContext({ scope: 'full', browsers: 'all', languages: 'all' }), 'full-gate');
    assert.equal(statusContext({ scope: 'full', browsers: 'chromium' }), 'partial-check');
    assert.equal(statusContext({ scope: 'full', languages: 'default' }), 'partial-check');
    assert.equal(statusContext({ scope: 'changed', browsers: 'all', languages: 'all' }), 'quick-check');
    assert.equal(statusContext({ scope: 'quick' }), 'quick-check');
    assert.equal(statusContext({ scope: 'full', specs: 'help.spec.ts' }), 'spec-check');
    assert.equal(statusDescription('0123456789abcdef', runOptions({ scope: 'full' })), '0123456 · full · browsers all · languages all');
  });
});

describe('hand-picked specs', () => {
  it('reads names split by spaces or commas, once each, and runs them alone', () => {
    const options = runOptions({ specs: ' help.spec.ts, items.spec.ts help.spec.ts ' });
    assert.deepEqual(options.specs, ['help.spec.ts', 'items.spec.ts']);
    const picked = handPicked(options.specs, repo);
    assert.deepEqual(requiredJobs(picked), ['e2e', 'e2e-report']);
    assert.match(githubOutput(picked, options), /^run=false\ne2e=e2e\/help\\\.spec\\\.ts\$ e2e\/items\\\.spec\\\.ts\$\n/);
    assert.match(summary(picked, options), /\| `help\.spec\.ts` \| picked by hand \(specs\) \|/);
    assert.equal(statusDescription('0123456789abcdef', options), '0123456 · changed · browsers chromium · languages default · specs help.spec.ts, items.spec.ts');
  });

  it('refuses a spec the branch does not have, so a typo never passes as a run of nothing', () => {
    assert.throws(() => handPicked(['nope.spec.ts'], repo), /nope\.spec\.ts/);
  });
});

describe('e2eArgs, githubOutput and summary', () => {
  it('anchors each file, so a name never matches a longer one', () => {
    const [order] = e2eArgs(['order.spec.ts']).split(' ').map((arg) => new RegExp(arg, 'i'));
    assert.ok(order.test('/work/app/e2e/order.spec.ts'));
    assert.ok(!order.test('/work/app/e2e/orders.spec.ts'));
  });

  it('writes the selection, the shards, the browsers and languages, the repeat, the layers and the jobs', () => {
    assert.equal(
      githubOutput(select(['src/features/orders/rows.ts']), runOptions()),
      'run=true\ne2e=e2e/orders\\.spec\\.ts$ e2e/smoke\\.spec\\.ts$\nshards=["1/1"]\n' +
        `projects=--project=${CHROMIUM_PROJECT}\nlanguages=default\nrepeat=\nlayers=[]\njobs=["checks","e2e","e2e-report"]\n`,
    );
    assert.equal(
      githubOutput(select(['e2e/help.spec.ts'], { full: true }), runOptions({ scope: 'full', shards: '3' })),
      'run=true\ne2e=all\nshards=["1/3","2/3","3/3"]\nprojects=\nlanguages=all\nrepeat=e2e/help\\.spec\\.ts$\nlayers=[]\n' +
        'jobs=["checks","e2e","e2e-report","repeat"]\n',
    );
  });

  it('has a row per spec with its reasons, shortens a long list, and says when nothing runs', () => {
    assert.match(summary(select(['src/features/orders/rows.ts', 'e2e/help.spec.ts'])), /\| `orders\.spec\.ts` \| `src\/features\/orders\/rows\.ts` → \/orders \|\n/);
    assert.match(summary(select(['e2e/help.spec.ts'])), /\| repeat ×10 at 2 workers \| `help\.spec\.ts` \|/);
    const why = { 'a.spec.ts': ['1', '2', '3', '4', '5'] };
    assert.match(summary({ run: true, e2e: ['a.spec.ts'], why }), /\| 1; 2; 3, and 2 more \|/);
    assert.match(summary(select(['docs/plan.md'])), /No checks run: notes only\./);
    assert.match(summary(select([]), runOptions({ scope: 'full', browsers: 'chromium' })), /Scope \*\*full\*\* · browsers \*\*chromium\*\* · languages \*\*all\*\* \(auto\)/);
  });
});

describe('verdict', () => {
  const EVERY = ['checks', 'e2e', 'e2e-report', 'repeat', 'stack'];
  const needs = (results, jobs = EVERY) => ({
    changes: { result: results.changes ?? 'success', outputs: results.changes ? {} : { jobs: JSON.stringify(jobs) } },
    ...Object.fromEntries(EVERY.filter((job) => results[job] !== undefined).map((job) => [job, { result: results[job] }])),
  });
  const passed = Object.fromEntries(EVERY.map((job) => [job, 'success']));

  it('passes only when every job the run needs passed: skipped, cancelled or no result fails it', () => {
    assert.equal(verdict('full', needs(passed), EVERY).state, 'success');
    for (const [job, result] of [['e2e', 'skipped'], ['stack', 'cancelled'], ['repeat', 'failure'], ['e2e-report', 'skipped'], ['checks', undefined]]) {
      assert.deepEqual(verdict('full', needs({ ...passed, [job]: result }), EVERY).problems, [`${job}: ${result ?? 'no result'}, but this run needs it`]);
    }
  });

  it('passes a job the run does not need when skipped, fails it when it failed, and ignores a changed run’s report merge', () => {
    const some = ['checks', 'e2e', 'e2e-report'];
    assert.equal(verdict('changed', needs({ ...passed, repeat: 'skipped', stack: 'skipped', 'e2e-report': 'failure' }, some), EVERY).state, 'success');
    assert.deepEqual(verdict('changed', needs({ ...passed, stack: 'failure' }, some), EVERY).problems, ['stack: failure']);
  });

  it('fails a run whose changes job failed or gave no list of jobs', () => {
    assert.deepEqual(verdict('full', needs({ changes: 'failure' })).problems, ['changes: failure']);
    assert.deepEqual(verdict('quick', { changes: { result: 'success', outputs: {} } }).problems, ['changes: it gave no list of the jobs this run needs']);
  });
});

describe('the command line', () => {
  const run = (args, env) => {
    const output = path.join(dir, 'output.txt');
    writeFileSync(output, '');
    execFileSync(process.execPath, [path.join(dir, 'scripts', 'ci-affected.mjs'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, CI_SCOPE: '', CI_BROWSERS: '', CI_LANGUAGES: '', CI_SPECS: '', E2E_SHARDS: '',
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'), GIT_CEILING_DIRECTORIES: path.dirname(dir), ...env,
      },
    });
    return readFileSync(output, 'utf8');
  };

  it('runs everything when git cannot tell what changed, which a quick run still runs without e2e', () => {
    assert.match(run([], { CI_SCOPE: 'changed' }), /^run=true\ne2e=all\nshards=\["1\/4","2\/4","3\/4","4\/4"\]\n/);
    assert.match(run([], { CI_SCOPE: 'quick' }), /^run=true\ne2e=none\n[^]*\njobs=\["checks"[",\w-]*\]\n$/);
  });

  it('runs hand-picked specs alone, and gives the gate the status to post', () => {
    assert.match(run([], { CI_SPECS: 'items.spec.ts' }), /^run=false\ne2e=e2e\/items\\\.spec\\\.ts\$\n/);
    const NEEDS = JSON.stringify({ changes: { result: 'success', outputs: { jobs: '["checks"]' } }, checks: { result: 'success' } });
    assert.equal(run(['verdict'], { CI_SCOPE: 'quick', NEEDS, SHA: '0123456789abcdef' }), 'context=quick-check\nstate=success\ndescription=0123456 · quick · browsers chromium · languages default\n');
  });
});

// The real repo: the map against the app, the Playwright config and ci.yml. These fail when a route or a spec is
// added without its map entry, or when the gate and JOBS drift apart.
describe('this repo', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  let real, map, specs, listed, workflow;
  before(() => {
    real = readRepo(root);
    map = JSON.parse(read(MAP_FILE));
    specs = Object.keys(real).filter((file) => SPEC.test(file) && !NO_E2E.some((rule) => rule.test(file))).map((file) => SPEC.exec(file)[1]);
    listed = Object.values(map.routes).filter(Array.isArray).flat();
    workflow = read(WORKFLOW).split(/\r?\n/);
  });

  it('maps every route, and only routes that exist', () => {
    assert.deepEqual(Object.keys(map.routes).sort(), [...routePages(real).keys()].sort());
  });

  it('names only specs that exist, and none both on a route and in allOnly', () => {
    assert.deepEqual([...listed, ...map.allOnly].filter((spec) => !specs.includes(spec)), []);
    assert.deepEqual(map.allOnly.filter((spec) => listed.includes(spec)), []);
  });

  it('reaches every spec through a route or allOnly (the smoke spec runs with every list)', () => {
    const mapped = new Set([...listed, ...map.allOnly, SMOKE_SPEC]);
    assert.deepEqual(specs.filter((spec) => !mapped.has(spec)), []);
  });

  it('has the smoke spec, and the Chromium project in playwright.config', () => {
    if (SMOKE_SPEC) assert.ok(specs.includes(SMOKE_SPEC), `no ${SPEC_DIR}/${SMOKE_SPEC}${SPEC_SUFFIX}`);
    const config = Object.keys(real).find((file) => /^playwright\.config\.[cm]?[jt]s$/.test(file));
    assert.ok(config, 'no playwright.config at the repo root');
    assert.match(read(config), new RegExp(`name:\\s*['"\`]${CHROMIUM_PROJECT}['"\`]`));
  });

  it('resolves every aliased and relative import in the app and the specs', () => {
    assert.deepEqual(unresolvedImports(real), []);
  });

  it("requires in ci.yml's gate exactly the jobs JOBS lists, never the quarantine job, and each is a job there", () => {
    const start = workflow.findIndex((line) => /^ {2}gate:\s*(#.*)?$/.test(line));
    assert.notEqual(start, -1, 'ci.yml has no gate job');
    const line = workflow.slice(start + 1).find((text) => /^ {4}needs:/.test(text));
    const needs = /^ {4}needs:\s*\[(.*)\]/.exec(line ?? '')?.[1].split(',').map((job) => job.trim());
    assert.ok(needs, "keep the gate's needs on one line: needs: [changes, …]");
    assert.deepEqual(needs.filter((job) => job !== 'changes').sort(), [...JOBS].sort());
    assert.ok(needs.includes('changes') && !needs.includes('quarantine'));
    for (const job of needs) assert.ok(workflow.some((text) => text === `  ${job}:`), `ci.yml has no ${job} job`);
  });

  it('keeps a draft’s run out of the ready run’s concurrency group, so it can never stop the quick check', () => {
    assert.ok(workflow.some((text) => /^ {2}group: .*\$\{\{ github\.event\.pull_request\.draft && '-draft' \|\| '' \}\}$/.test(text)));
    assert.ok(workflow.includes('  cancel-in-progress: true'));
  });
});
