// Records the real `gh` CLI's output for every read-only call shape Factory
// Factory makes (./gh-policies.mjs), against public objects of this
// repository, and writes scrubbed fixtures to
// src/backend/testing/fixtures/upstream/gh/<gh version>/.
//
//   node scripts/record-upstream.mjs gh [--keep-raw <dir> | --rescrub <dir>]
//
// It runs only the reads listed in GH_SHAPES, with your own `gh` sign-in, from
// an empty temp directory (so `gh` infers no repository), with prompts, colour,
// the pager and update notices off. Nothing writes to GitHub. About twenty
// API requests; `gh` is not pinned, and the directory is named after the
// version that answered.
//
// `--keep-raw <dir>` keeps the unscrubbed outputs (they name real accounts) as
// 0600 files in a private directory outside this repository; `--rescrub <dir>`
// rewrites the fixtures from them without calling `gh`. Read every fixture
// before you push: pushing publishes it.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installAbortCleanup, prepareRawDirectory, removeOnAbort } from './environment.mjs';
import { FAKE_REPOSITORY, GH_OBJECTS, GH_SHAPES } from './gh-policies.mjs';
import {
  collectScrubFacts,
  createGhScrubContext,
  loginsInText,
  PLACEHOLDER,
  scrubHttpHead,
  scrubJson,
  scrubText,
  splitHttp,
  treatValue,
  trimOutput,
} from './gh-scrub.mjs';

const VERSION = /^gh version (\d+\.\d+\.\d+)\b/;
const USAGE = 'Usage: node scripts/record-upstream.mjs gh [--keep-raw <dir> | --rescrub <dir>]';

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!(flag === '--keep-raw' || flag === '--rescrub')) {
      throw new Error(`Unknown option ${flag}. ${USAGE}`);
    }
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} needs a directory. ${USAGE}`);
    }
    options[flag === '--keep-raw' ? 'keepRaw' : 'rescrub'] = value;
  }
  if (options.keepRaw && options.rescrub) {
    throw new Error(`--keep-raw and --rescrub cannot be combined. ${USAGE}`);
  }
  return options;
}

function ghEnvironment() {
  const env = { ...process.env };
  for (const name of [
    'CLICOLOR_FORCE',
    'GH_FORCE_TTY',
    'GH_DEBUG',
    'DEBUG',
    'GH_REPO',
    'GH_HOST',
  ]) {
    delete env[name];
  }
  return {
    ...env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PAGER: 'cat',
    NO_COLOR: '1',
    CLICOLOR: '0',
  };
}

/** The real values a shape's arguments are built from. */
function realValues() {
  const [owner, name] = GH_OBJECTS.repository.split('/');
  return { ...GH_OBJECTS, repo: GH_OBJECTS.repository, owner, name };
}

/** The first recorded review thread with a comment end cursor, for the thread-comments page. */
function threadFromRecording(raw) {
  const shape = GH_SHAPES.find((candidate) => candidate.file === 'graphql-review-threads.json');
  const { json } = trimOutput(JSON.parse(raw.stdout), shape.trim);
  const threads = json.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const thread = threads.find((node) => node.comments?.pageInfo?.endCursor);
  return thread ? { threadId: thread.id, threadCursor: thread.comments.pageInfo.endCursor } : {};
}

/**
 * Throws unless `gh api repos/<repo> --jq .private` answered `false`: a
 * recording keeps check, label and workflow names, which are free text, and
 * that is only acceptable for a repository anyone can read.
 */
export function assertPublicRepository(result) {
  if (result.error || result.status !== 0 || result.stdout?.trim() !== 'false') {
    throw new Error(
      'The repository to record is not public, or its visibility could not be read; nothing was recorded.'
    );
  }
}

function oneLine(args) {
  return args.map((arg) => arg.replace(/\s+/g, ' ').trim()).join(' ');
}

function runShapes(rawDir) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ff-gh-cwd-')));
  removeOnAbort.add(cwd);
  const env = ghEnvironment();
  const values = realValues();
  try {
    const version = spawnSync('gh', ['--version'], { cwd, env, encoding: 'utf8' });
    const ghVersion = VERSION.exec(version.stdout ?? '')?.[1];
    if (version.status !== 0 || !ghVersion) {
      throw new Error('gh --version did not report a version; is gh installed?');
    }
    // Kept strings may be free text, which is only acceptable from a public repository.
    const visibility = ['api', `repos/${values.repo}`, '--jq', '.private'];
    console.log(`gh ${oneLine(visibility)}`);
    assertPublicRepository(spawnSync('gh', visibility, { cwd, env, encoding: 'utf8' }));
    for (const shape of GH_SHAPES) {
      if (shape.needs?.some((name) => values[name] === undefined)) {
        console.log(`gh: skipped ${shape.file}: no ${shape.needs.join(' or ')} to read`);
        continue;
      }
      const args = shape.args(values);
      console.log(`gh ${oneLine(args)}`);
      const result = spawnSync('gh', args, {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
      });
      if (result.error || (result.status !== 0 && !shape.allowFailure)) {
        throw new Error(`gh failed for ${shape.file} (exit ${result.status ?? 'none'})`);
      }
      const raw = { args, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
      writeFileSync(join(rawDir, shape.file), JSON.stringify(raw), { mode: 0o600 });
      if (shape.file === 'graphql-review-threads.json') {
        Object.assign(values, threadFromRecording(raw));
      }
    }
    const run = {
      ghVersion,
      recordedOn: new Date().toISOString().slice(0, 10),
      platform: `${process.platform}-${process.arch}`,
      // What the arguments were built from, so a rescrub rebuilds the same ones.
      values,
    };
    writeFileSync(join(rawDir, 'run.json'), JSON.stringify(run), { mode: 0o600 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    removeOnAbort.delete(cwd);
  }
}

function readRaw(rawDir, shape) {
  const path = join(rawDir, shape.file);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** The parsed (and trimmed) JSON body of a raw output, or null for text output. */
function jsonBody(shape, raw) {
  if (shape.output === 'json') {
    return trimOutput(JSON.parse(raw.stdout), shape.trim);
  }
  if (shape.output === 'http-json') {
    return trimOutput(JSON.parse(splitHttp(raw.stdout).body), shape.trim);
  }
  return null;
}

function fixtureFor(shape, raw, body, context, fakeValues) {
  const fixture = {
    description: shape.description,
    ...(shape.deviation ? { deviation: shape.deviation } : {}),
    args: shape.args(fakeValues),
    exitCode: raw.exitCode,
    stdoutFormat: shape.output,
  };
  if (shape.output === 'text') {
    fixture.stdout = scrubText(shape.text, raw.stdout, context);
    fixture.stderr = shape.text === 'authStatus' ? scrubText(shape.text, raw.stderr, context) : '';
  } else if (shape.output === 'json') {
    fixture.stdout = scrubJson(body.json, shape.fields, context);
    fixture.stderr = raw.stderr === '' ? '' : PLACEHOLDER;
  } else {
    fixture.stdout = {
      head: scrubHttpHead(splitHttp(raw.stdout), shape.headers, context),
      body: scrubJson(body.json, shape.fields, context),
    };
    fixture.stderr = raw.stderr === '' ? '' : PLACEHOLDER;
  }
  return fixture;
}

function writeVersionDirectory(rawDir, run, target) {
  const recorded = GH_SHAPES.map((shape) => ({ shape, raw: readRaw(rawDir, shape) })).filter(
    ({ raw }) => raw
  );
  const bodies = new Map(recorded.map(({ shape, raw }) => [shape, jsonBody(shape, raw)]));
  // First pass: every login (to keep none by accident) and timestamp (to keep their order).
  const facts = { logins: [], times: [] };
  for (const { shape, raw } of recorded) {
    if (bodies.get(shape)) {
      collectScrubFacts(bodies.get(shape).json, shape.fields, facts);
    } else {
      facts.logins.push(...loginsInText(shape.text, `${raw.stdout}\n${raw.stderr}`));
    }
  }
  const real = run.values;
  const context = createGhScrubContext({
    repository: real.repo,
    fake: FAKE_REPOSITORY,
    ...facts,
  });
  const fakeRepo = `${FAKE_REPOSITORY.owner}/${FAKE_REPOSITORY.name}`;
  const files = {};
  for (const { shape, raw } of recorded) {
    const fakeValues = {
      ...real,
      repo: fakeRepo,
      ...FAKE_REPOSITORY,
      threadId: real.threadId && treatValue('id', real.threadId, context),
      threadCursor: real.threadCursor && treatValue('cursor', real.threadCursor, context),
    };
    const before = context.droppedKeys;
    const body = bodies.get(shape);
    const fixture = fixtureFor(shape, raw, body, context, fakeValues);
    writeFileSync(join(target, shape.file), `${JSON.stringify(fixture, null, 2)}\n`);
    files[shape.file] = {
      description: shape.description,
      ...(body?.kept ? { trimmed: `kept ${body.kept.kept} of ${body.kept.of} items` } : {}),
      droppedKeys: context.droppedKeys - before,
    };
  }
  const meta = {
    tool: 'gh',
    version: run.ghVersion,
    recordedOn: run.recordedOn,
    platform: run.platform,
    repository:
      'This repository, named example-owner/example-repo in every fixture; only public objects were read.',
    objects: {
      mergedPullRequest: real.mergedPullRequest,
      openPullRequest: real.openPullRequest,
      issue: real.issue,
      issueSearch: real.issueSearch,
      issueEventsPage: real.issueEventsPage,
    },
    notRecorded: GH_SHAPES.filter((shape) => !readRaw(rawDir, shape)).map((shape) => shape.file),
    files,
    scrubbing:
      'Allowlist by call shape and key path (scripts/record-upstream/gh-policies.mjs, treatments in gh-scrub.mjs): unlisted keys and headers are dropped (counted in droppedKeys); free text is "<text>"; logins are user-N, bot-N[bot] or app/bot-N; ids, commits, branches and cursors are fixed fakes; timestamps are fakes from 2026-01-01 in their real order; URLs keep github.com path words and pull request and issue numbers, every other number is a fake id and other hosts are example.invalid; auth status keeps only the active account, with a fake login, token and scopes.',
  };
  writeFileSync(join(target, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  const format = spawnSync(
    join(import.meta.dirname, '..', '..', 'node_modules', '.bin', 'oxfmt'),
    ['--write', target],
    {
      stdio: 'ignore',
    }
  );
  if (format.error || format.status !== 0) {
    throw new Error('oxfmt could not format the new recordings');
  }
}

function writeFixtures(rawDir, fixturesRoot) {
  const run = JSON.parse(readFileSync(join(rawDir, 'run.json'), 'utf8'));
  if (typeof run.ghVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(run.ghVersion)) {
    throw new Error('run.json does not name a gh version');
  }
  if (typeof run.values?.repo !== 'string') {
    throw new Error('run.json does not hold the values the arguments were built from');
  }
  const toolDirectory = join(fixturesRoot, 'gh');
  const target = join(toolDirectory, run.ghVersion);
  if (dirname(target) !== toolDirectory) {
    throw new Error('The gh version resolves outside the fixtures directory');
  }
  mkdirSync(toolDirectory, { recursive: true });
  const staging = mkdtempSync(join(toolDirectory, `.${run.ghVersion}-`));
  removeOnAbort.add(staging);
  try {
    writeVersionDirectory(rawDir, run, staging);
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    console.log(`gh: wrote ${target}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    removeOnAbort.delete(staging);
  }
}

/** Entry point for `node scripts/record-upstream.mjs gh ...`. */
export function recordGitHubCli(argv, { fixturesRoot, checkout }) {
  const options = parseOptions(argv);
  const uninstallAbortCleanup = installAbortCleanup();
  try {
    if (options.rescrub) {
      if (!existsSync(join(options.rescrub, 'run.json'))) {
        throw new Error('--rescrub needs a directory written with --keep-raw');
      }
      writeFixtures(options.rescrub, fixturesRoot);
      return;
    }
    const kept = options.keepRaw ? prepareRawDirectory(options.keepRaw, checkout) : undefined;
    const rawDir = kept ?? realpathSync(mkdtempSync(join(tmpdir(), 'ff-gh-raw-')));
    if (!kept) {
      removeOnAbort.add(rawDir);
    }
    try {
      runShapes(rawDir);
      writeFixtures(rawDir, fixturesRoot);
    } finally {
      if (!kept) {
        rmSync(rawDir, { recursive: true, force: true });
        removeOnAbort.delete(rawDir);
      }
    }
  } finally {
    uninstallAbortCleanup();
  }
}
