// Which tests a CI run needs, from the files the branch changes. A changed module picks the e2e specs of every route
// whose page imports it, directly or through other modules, as the map (MAP_FILE) lists them; a change that reaches
// the root layout, or a route every spec passes through, runs them all; a path no rule matches runs everything.
// Part of the playwright-tester CI template (CHECKLIST.md). `node scripts/ci-affected.mjs` is ci.yml's `changes` job
// (what to run, to $GITHUB_OUTPUT, and why, to the summary); `… verdict` is the `gate` job's commit status. Options
// arrive as CI_SCOPE, CI_BROWSERS, CI_LANGUAGES, CI_SPECS and E2E_SHARDS (runOptions). Node's built-ins only: the gate
// checks out scripts/ alone. The pure helpers take made-up input, so ci-affected.test.mjs can run them.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ═══════════════════════════════════ CONFIG: this repo's layout (CHECKLIST.md) ═══════════════════════════════════

/** The route → specs map. */
export const MAP_FILE = 'e2e/affected-map.json';
/** The e2e specs: `<SPEC_DIR>/<name><SPEC_SUFFIX>`, at the top of the folder (playwright.config's testDir). */
export const SPEC_DIR = 'e2e';
export const SPEC_SUFFIX = '.spec.ts';
/** The spec that runs with every list of picked specs, by name; '' for none. */
export const SMOKE_SPEC = 'smoke';
/** playwright.config's Chromium project: `browsers: chromium` runs it alone. */
export const CHROMIUM_PROJECT = 'desktop-chrome';
/** What a branch's changes are measured against: `git diff <BASE_REF>...HEAD`. */
export const BASE_REF = 'origin/main';
/** The app's source folders: a changed file there is followed through the imports to the pages it reaches. */
export const APP_DIRS = ['src/'];
/** The root layout: a change that reaches it runs every spec. */
export const ROOT_LAYOUT = 'src/app/layout.tsx';
/** Import aliases (tsconfig `paths`), prefix → folder. */
export const ALIASES = { '@/': 'src/' };
/** Notes only: nothing runs. Narrow it if the app renders Markdown. */
export const DOCS = [/^docs\//, /^\.claude\//, /\.md$/];
/** Paths with no e2e spec of their own: the checks still run. Unit tests by default. */
export const NO_E2E = [/^src\/.*\.(test|spec)\.[cm]?[jt]sx?$/];

/**
 * Each route → its page file, from every file in the checkout (`repo`'s keys). Built in: the Next.js App Router, one
 * route per folder under src/app with a page file, named by the folder as written (`/`, `/settings`, `/(shop)/cart`,
 * `/blog/[slug]`). Another router plugs in here with the same shape. The Pages Router, for example:
 *   const page = /^src\/pages\/(?!api\/|_)(.*?)(?:\/?index)?\.[jt]sx?$/.exec(file);
 *   if (page) pages.set(`/${page[1]}`, file);
 * A route table (React Router, Vue Router, Angular): read its file from `repo` (add it to APP_DIRS so its text is
 * read) and map each path to the module it loads.
 */
export function routePages(repo) {
  const pages = new Map();
  for (const file of Object.keys(repo)) {
    const page = /^src\/app\/(?:(.*)\/)?page\.[jt]sx?$/.exec(file);
    if (page) pages.set(`/${page[1] ?? ''}`, file);
  }
  return pages;
}

/**
 * Repo layers: jobs a repo adds from ci.yml's `# ── repo layer: … ──` stubs. `job` is its name in ci.yml (add it to the
 * gate's needs too: the unit tests hold JOBS and the gate's needs equal); `paths` turn it on. A layer is also on in a
 * full run and for a path no rule matches, unless `full: false`; with `allSpecs: true`, whenever every e2e spec runs;
 * and only with `quick: true` in a pull request's automatic run. A layer's own files that no e2e spec covers (a
 * migrations folder, the clicker's walk) belong in NO_E2E as well, or a change to them runs every spec. For example:
 *   { job: 'stack', paths: [/^db\//, /^src\/server\//], quick: true },
 *   { job: 'production', paths: [/^public\//, /^next\.config\./], allSpecs: true },
 *   { job: 'monkey', paths: [/^monkey\//], full: false },
 */
export const LAYERS = [];

// ═══════════════════════════════════════════════ end of the config ═══════════════════════════════════════════════

/** What ci.yml's Run workflow inputs offer (`quick` is a pull request's own run). */
const CHOICES = { scope: ['changed', 'full', 'quick'], browsers: ['auto', 'chromium', 'all'], languages: ['auto', 'default', 'all'] };
/** The jobs after `changes`, as ci.yml names them, in the gate's needs. The quarantine job never counts: it doesn't block. */
export const JOBS = ['checks', 'e2e', 'e2e-report', 'repeat', ...LAYERS.map((layer) => layer.job)];

const CODE = /\.[cm]?[jt]sx?$/;
const UNIT_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A spec file; its name, without the suffix, is the map's. */
export const SPEC = new RegExp(`^${escapeRegExp(SPEC_DIR)}/([^/]+)${escapeRegExp(SPEC_SUFFIX)}$`);
/** A spec file name the `specs` input takes: never a path, a pattern, a flag or a shell character. */
const SPEC_NAME = new RegExp(`^[A-Za-z0-9][\\w.-]*${escapeRegExp(SPEC_SUFFIX)}$`);
const SPECIFIER =
  /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;

const matches = (rules, file) => rules.some((rule) => rule.test(file));
const inApp = (file) => APP_DIRS.some((dir) => file.startsWith(dir));
/** The modules the walk follows: the app without its unit tests, and the spec folder. */
const inGraph = (file) => CODE.test(file) && ((inApp(file) && !UNIT_TEST.test(file)) || file.startsWith(`${SPEC_DIR}/`));

/** Every module specifier a source file imports, re-exports or requires, in order, packages included. */
export function importsOf(source) {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3] ?? match[4]);
}

/**
 * The file an import names: an alias's folder, or relative to the importer; tried as written, then with an extension
 * (`./x.js` in TypeScript also names x.ts), then as a folder. undefined for a package; null for an app path with no file.
 */
function resolveImport(specifier, from, repo) {
  const alias = Object.keys(ALIASES).find((prefix) => specifier.startsWith(prefix));
  let base;
  if (alias) base = ALIASES[alias] + specifier.slice(alias.length);
  else if (specifier.startsWith('./') || specifier.startsWith('../')) base = path.posix.join(path.posix.dirname(from), specifier);
  else return undefined;
  const stem = base.replace(/\.[cm]?js$/, '');
  const candidates = [base, ...EXTENSIONS.map((ext) => stem + ext), ...EXTENSIONS.map((ext) => `${base}/index${ext}`)];
  return candidates.find((file) => Object.hasOwn(repo, file)) ?? null;
}

/** Every import in the walk's modules: the importer, the specifier and the file it names (resolveImport). */
const allImports = (repo) =>
  Object.entries(repo)
    .filter(([file]) => inGraph(file))
    .flatMap(([file, source]) => importsOf(source).map((specifier) => [file, specifier, resolveImport(specifier, file, repo)]));

/** Each module → the modules that import it. */
function importersOf(repo) {
  const importers = new Map();
  for (const [file, , target] of allImports(repo)) {
    if (target) importers.set(target, (importers.get(target) ?? new Set()).add(file));
  }
  return importers;
}

/** The file and every module that imports it, directly or through others. */
function reachedFrom(file, importers) {
  const reached = new Set([file]);
  const queue = [file];
  while (queue.length > 0) {
    for (const importer of importers.get(queue.pop()) ?? []) {
      if (!reached.has(importer)) {
        reached.add(importer);
        queue.push(importer);
      }
    }
  }
  return reached;
}

/** Every aliased or relative import in the app and the specs that names no file, as `file: specifier`. */
export function unresolvedImports(repo) {
  return allImports(repo).filter(([, , target]) => target === null).map(([file, specifier]) => `${file}: ${specifier}`);
}

/** The spec files the branch changes, for the repeat check: not a deleted one, nor one NO_E2E keeps out. */
export function changedSpecs(changed, repo) {
  const live = changed.filter((file) => SPEC.test(file) && Object.hasOwn(repo, file) && !matches(NO_E2E, file));
  return live.map((file) => path.posix.basename(file)).sort();
}

/**
 * What to run for the changed files. `repo` maps every file in the checkout to its text (only the walk's modules need
 * it); a changed file not in it was deleted. `full`, or `diffError` (why the changed files are unknown), runs
 * everything. Returns `run`, `e2e` ('none', 'all' or the spec files), `repeat`, `layers` and `why`, the reasons.
 */
export function selectAffected({ changed, repo, map, full = false, diffError = '', layers = LAYERS }) {
  const why = {};
  const pick = (target, reason) => {
    why[target] ??= [];
    if (!why[target].includes(reason)) why[target].push(reason);
  };
  const pickSpec = (name, reason) => pick(`${name}${SPEC_SUFFIX}`, reason);
  const everything = (reason) => {
    pick('all', reason);
    for (const layer of layers) if (layer.full !== false) pick(layer.job, reason);
  };

  if (full) everything('a full run was asked for');
  if (diffError) everything(`what the branch changes is unknown: ${diffError}`);
  let run = full || Boolean(diffError);

  const importers = importersOf(repo);
  const pages = routePages(repo);
  const routeOfPage = new Map([...pages].map(([route, page]) => [page, route]));
  /** The routes whose pages sit in a file's folder or below it: a layout, loading or error file there applies to all. */
  const routesBelow = (file) => {
    const dir = `${path.posix.dirname(file)}/`;
    return [...pages].filter(([, page]) => page.startsWith(dir)).map(([route]) => route);
  };

  for (const file of changed) {
    if (matches(DOCS, file)) continue;
    run = true;
    const name = `\`${file}\``;
    for (const layer of layers) if (matches(layer.paths, file)) pick(layer.job, name);
    if (matches(NO_E2E, file)) continue;
    const spec = SPEC.exec(file);
    if (!inApp(file) && !spec) {
      everything(`${name}: no rule matches it`);
      continue;
    }
    // A deleted module picks nothing itself: the files that imported it changed too, or the build fails.
    if (!Object.hasOwn(repo, file)) continue;
    if (spec) {
      pickSpec(spec[1], `${name} changed`);
      continue;
    }

    const reached = reachedFrom(file, importers);
    if (reached.has(ROOT_LAYOUT)) {
      pick('all', `${name} reaches the root layout`);
      continue;
    }
    const routes = new Set([...reached].map((module) => routeOfPage.get(module)).filter(Boolean));
    // Code that nothing imports (a layout, a loading or error file, middleware) is loaded by the framework.
    if (routes.size === 0 && !importers.has(file) && CODE.test(file)) for (const route of routesBelow(file)) routes.add(route);
    const specs = [...reached].map((module) => SPEC.exec(module)?.[1]).filter(Boolean);

    for (const route of routes) {
      const mapped = map.routes[route];
      if (mapped === undefined) pick('all', `${name} → ${route}, which ${MAP_FILE} does not list`);
      else if (mapped === 'all') pick('all', `${name} → ${route}`);
      else for (const mappedSpec of mapped) pickSpec(mappedSpec, `${name} → ${route}`);
    }
    for (const importer of specs) pickSpec(importer, `${name} is imported by the spec`);
    // A module no page or spec imports needs no e2e spec; any other file there could be loaded some other way.
    if (routes.size === 0 && specs.length === 0 && !CODE.test(file)) everything(`${name}: no rule matches it`);
  }

  let e2e = 'none';
  const isSpec = (target) => target.endsWith(SPEC_SUFFIX);
  if (why.all) {
    e2e = 'all';
    for (const layer of layers) if (layer.allSpecs) pick(layer.job, 'every e2e spec runs');
  } else if (Object.keys(why).some(isSpec)) {
    const smoke = `${SMOKE_SPEC}${SPEC_SUFFIX}`;
    if (SMOKE_SPEC && !why[smoke]) pick(smoke, 'runs with every list');
    e2e = Object.keys(why).filter(isSpec).sort();
  }
  if (!run) pick('skip', changed.length === 0 ? `nothing changed against ${BASE_REF}` : 'notes only');
  const on = layers.filter((layer) => why[layer.job]).map((layer) => layer.job);
  return { run, e2e, repeat: changedSpecs(changed, repo), layers: on, why };
}

/**
 * What a run's inputs mean. `scope`: `changed`, `full`, or `quick` (a pull request's own run: changed without e2e).
 * `browsers` and `languages`: `auto` is Chromium and the default language for a changed run, everything for a full one.
 * `specs`: spec file names, spaces or commas between, run alone (handPicked). `shards`: E2E_SHARDS. Throws on a value
 * the inputs don't offer.
 */
export function runOptions({ scope = 'changed', browsers = 'auto', languages = 'auto', specs = '', shards = '4' } = {}) {
  for (const [name, value] of Object.entries({ scope, browsers, languages })) {
    if (!CHOICES[name].includes(value)) throw new RangeError(`${name} must be one of ${CHOICES[name].join(', ')}, not "${value}".`);
  }
  const picked = specs.split(/[\s,]+/).filter(Boolean);
  // Each name goes into the e2e job's command line: only a plain spec file name.
  for (const spec of picked) {
    if (!SPEC_NAME.test(spec)) throw new RangeError(`specs takes spec file names like smoke${SPEC_SUFFIX}, not "${spec}".`);
  }
  const count = Number(shards);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new RangeError(`E2E_SHARDS must be from 1 to 50, not "${shards}".`);
  const full = scope === 'full';
  const chosen = browsers === 'auto' ? (full ? 'all' : 'chromium') : browsers;
  const auto = Object.entries({ browsers, languages }).filter(([, value]) => value === 'auto').map(([name]) => name);
  const projectArgs = chosen === 'chromium' ? `--project=${CHROMIUM_PROJECT}` : '';
  const language = languages === 'auto' ? (full ? 'all' : 'default') : languages;
  return { scope, full, e2e: scope !== 'quick', browsers: chosen, languages: language, projectArgs, specs: [...new Set(picked)], shards: count, auto };
}

/**
 * The commit status a run posts: `full-gate` only for a full run on every browser and language; `partial-check` for a
 * full run narrowed by an option; `quick-check` for a changed or quick run; `spec-check` for hand-picked specs.
 */
export function statusContext(inputs) {
  const options = runOptions(inputs);
  if (options.specs.length) return 'spec-check';
  if (!options.full) return 'quick-check';
  return options.browsers === 'all' && options.languages === 'all' ? 'full-gate' : 'partial-check';
}

/** The status's description: the tested commit, short, and the options the run used. */
export function statusDescription(sha, options) {
  const head = `${sha.slice(0, 7)} · ${options.scope} · browsers ${options.browsers} · languages ${options.languages}`;
  return options.specs.length ? `${head} · specs ${options.specs.join(', ')}` : head;
}

/** The jobs a selection needs, which `changes` hands the gate (`jobs`). */
export function requiredJobs({ run, e2e, repeat = [], layers = [] }) {
  return [...(run ? ['checks'] : []), ...(e2e !== 'none' ? ['e2e', 'e2e-report'] : []), ...(repeat.length ? ['repeat'] : []), ...layers];
}

/**
 * The run's verdict, from `toJSON(needs)`. `changes` must pass, and its `jobs` output names the jobs this run needs:
 * each must pass, since skipped, cancelled or no result is coverage the run doesn't have. A job the run doesn't need
 * passes when skipped. A changed or quick run's report merge doesn't count. Returns `state` and the `problems`.
 */
export function verdict(scope, needs, jobs = JOBS) {
  const changes = needs.changes?.result ?? 'no result';
  if (changes !== 'success') return { state: 'failure', problems: [`changes: ${changes}`] };
  let required;
  try {
    required = JSON.parse(needs.changes?.outputs?.jobs ?? '');
  } catch {}
  if (!Array.isArray(required)) return { state: 'failure', problems: ['changes: it gave no list of the jobs this run needs'] };
  const problems = [];
  for (const job of jobs) {
    const result = needs[job]?.result;
    if (required.includes(job)) {
      if ((scope === 'full' || job !== 'e2e-report') && result !== 'success') problems.push(`${job}: ${result ?? 'no result'}, but this run needs it`);
    } else if (result !== undefined && result !== 'skipped' && result !== 'success') {
      problems.push(`${job}: ${result}`);
    }
  }
  return { state: problems.length === 0 ? 'success' : 'failure', problems };
}

const QUICK_REASON = 'a pull request’s automatic run has no e2e: start a changed or full run by hand';

/** The selection a run's scope allows: a quick run keeps the checks and the quick layers, and drops e2e and the repeat. */
export function forScope(selection, options, layers = LAYERS) {
  if (options.e2e) return selection;
  const quick = new Set(layers.filter((layer) => layer.quick).map((layer) => layer.job));
  const kept = selection.layers.filter((job) => quick.has(job));
  return { ...selection, e2e: 'none', repeat: [], layers: kept, why: { ...selection.why, quick: [QUICK_REASON] } };
}

const HAND_PICKED = 'picked by hand (specs)';

/** A run of hand-picked specs: those alone, with no checks, repeat or layer. Throws on a spec the branch doesn't have. */
export function handPicked(specs, repo) {
  const missing = specs.filter((spec) => !Object.hasOwn(repo, `${SPEC_DIR}/${spec}`));
  if (missing.length) throw new RangeError(`No such spec on this branch: ${missing.join(', ')}.`);
  return { run: false, e2e: [...specs], repeat: [], layers: [], why: Object.fromEntries(specs.map((spec) => [spec, [HAND_PICKED]])) };
}

/** Spec files as Playwright file arguments: each a regex over the path, anchored so `order` never runs `orders`. */
export function e2eArgs(specs) {
  return specs.map((spec) => `${escapeRegExp(SPEC_DIR)}/${escapeRegExp(spec)}$`).join(' ');
}

/**
 * The lines for $GITHUB_OUTPUT. `shards` is the e2e job's matrix (E2E_SHARDS machines for every spec, one for a list),
 * `projects` Playwright's project argument (empty for every project), `jobs` what the gate requires.
 */
export function githubOutput(selection, options = runOptions()) {
  const { run, e2e, repeat = [], layers = [] } = selection;
  const shards = e2e === 'all' ? Array.from({ length: options.shards }, (_, k) => `${k + 1}/${options.shards}`) : ['1/1'];
  const list = Array.isArray(e2e) ? e2eArgs(e2e) : e2e;
  return (
    `run=${run}\ne2e=${list}\nshards=${JSON.stringify(shards)}\nprojects=${options.projectArgs}\nlanguages=${options.languages}\n` +
    `repeat=${e2eArgs(repeat)}\nlayers=${JSON.stringify(layers)}\njobs=${JSON.stringify(requiredJobs(selection))}\n`
  );
}

/** Up to three reasons, then how many more. */
const reasonsText = (reasons) => (reasons.length <= 3 ? reasons.join('; ') : `${reasons.slice(0, 3).join('; ')}, and ${reasons.length - 3} more`);

/** The job summary: the options the run used, then a row for the e2e run (or each picked spec), the repeat and each layer. */
export function summary({ run, e2e, repeat = [], layers = [], why }, options = runOptions()) {
  const chosen = (name) => `${name} **${options[name]}**${options.auto.includes(name) ? ' (auto)' : ''}`;
  const head = `### Affected tests\n\nScope **${options.scope}** · ${chosen('browsers')} · ${chosen('languages')}\n\n`;
  if (!run && !Array.isArray(e2e)) return `${head}No checks run: ${why.skip[0]}.\n`;
  const rows = [];
  if (e2e === 'all') rows.push(['every e2e spec', why.all]);
  else if (e2e === 'none') rows.push(['no e2e spec', why.quick ?? ['no changed file reaches a page or a spec']]);
  else for (const spec of e2e) rows.push([`\`${spec}\``, why[spec]]);
  if (repeat.length > 0) rows.push(['repeat ×10 at 2 workers', repeat.map((spec) => `\`${spec}\``)]);
  for (const job of layers) rows.push([`repo layer \`${job}\``, why[job]]);
  const table = rows.map(([what, reasons]) => `| ${what} | ${reasonsText(reasons)} |`);
  return [`${head}| Runs | Why |`, '|---|---|', ...table, ''].join('\n');
}

/** Every file under `dir`, without node_modules and dot-folders: the checkout when git can't list it. */
function walk(root, dir = '') {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : walk(root, rel);
    return entry.isFile() ? [rel] : [];
  });
}

/** git's output, split on NUL; throws when git fails. */
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean);

/** Every file in the checkout (tracked, or new and not ignored), with the text of the modules the walk follows. */
export function readRepo(root) {
  let files = [];
  try {
    files = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  } catch {} // Not a git checkout: the walk.
  const repo = {};
  for (const file of files.length ? files : walk(root)) {
    const full = path.join(root, file);
    if (existsSync(full)) repo[file] = inGraph(file) ? readFileSync(full, 'utf8') : '';
  }
  return repo;
}

/** The files the checked-out branch changes since it left BASE_REF (three dots: newer commits there don't count). */
export function changedFiles(root, base = BASE_REF) {
  try {
    return { changed: git(root, ['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`]), error: '' };
  } catch (error) {
    const reason = String(error.stderr || error.message).trim().split('\n')[0];
    return { changed: [], error: `git diff ${base}...HEAD failed (${reason})` };
  }
}

/** The run's inputs, as ci.yml passes them on. */
function inputsFromEnv() {
  const env = (name) => process.env[name] || undefined;
  return { scope: env('CI_SCOPE'), browsers: env('CI_BROWSERS'), languages: env('CI_LANGUAGES'), specs: env('CI_SPECS'), shards: env('E2E_SHARDS') };
}

/** Writes the lines and the table to stdout, and to $GITHUB_OUTPUT and the job summary when the run has them. */
function emit(output, table, head = '') {
  process.stdout.write(`${head}${output}\n${table}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const options = runOptions(inputsFromEnv());
  const repo = readRepo(root);
  let selection;
  let head = '';
  // Hand-picked specs run alone: what the branch changes doesn't matter.
  if (options.specs.length) selection = handPicked(options.specs, repo);
  else {
    // CI checks out the whole history (fetch-depth: 0), so BASE_REF is there. If git still can't say, everything runs.
    const { changed, error } = changedFiles(root);
    if (error) process.stdout.write(`::warning title=ci-affected::${error}: everything runs.\n`);
    const map = JSON.parse(readFileSync(path.join(root, MAP_FILE), 'utf8'));
    selection = forScope(selectAffected({ changed, repo, map, full: options.full, diffError: error }), options);
    head = `${changed.length} changed files\n`;
  }
  emit(githubOutput(selection, options), summary(selection, options), head);
}

/** `… verdict`, the gate job: from every job's result (NEEDS), the inputs and the tested commit (SHA), the status to post. */
function gate() {
  const inputs = inputsFromEnv();
  const options = runOptions(inputs);
  const context = statusContext(inputs);
  const { state, problems } = verdict(options.scope, JSON.parse(process.env.NEEDS ?? '{}'));
  const description = statusDescription(process.env.SHA ?? '', options);
  const table = [`### ${context}: ${state}`, '', description, '', ...problems.map((problem) => `- ${problem}`), ''].join('\n');
  emit(`context=${context}\nstate=${state}\ndescription=${description}\n`, table);
}

// Run as a command, not imported (import.meta.main needs Node 22.18 or 24.2).
const self = (file) => {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
};
if (self(process.argv[1]) === self(fileURLToPath(import.meta.url))) (process.argv[2] === 'verdict' ? gate : main)();
