/**
 * Tags and releases npm versions of factory-factory.
 *
 * Publishing is `npm stage publish` followed by a maintainer's approval on npm, outside
 * GitHub, so the publish workflow cannot tag. This runs on a schedule instead: every
 * version newer than BACKLOG_CUTOFF without a `v<version>` tag gets the tag and a GitHub
 * Release. Older versions are the backlog, handled only when a maintainer asks with
 * `--backlog tags` (tags alone, which notify nobody) or `--backlog releases`.
 *
 * Versions from 0.4.7 on carry no `gitHead`, so the commit each was built from is read
 * from its npm provenance attestation, which must name this repository's publish workflow
 * on `main`. Before anything is created, the commit must exist here, be reachable from
 * `main` and declare that version; GitHub must confirm the staging run the provenance
 * names (the publish workflow, dispatched on `main`, successful, at that commit); and
 * `scripts/verify-npm-release.sh` must accept the published tarball. Anything else is
 * reported and skipped, never guessed.
 *
 * Usage: tsx scripts/tag-npm-releases.ts --repository <owner/name>
 *          [--backlog none|tags|releases] [--dry-run]
 *
 * Without --dry-run it refuses to run outside GitHub Actions: only the workflow token
 * creates Releases that start no other workflow, and a personal `gh` login would start
 * `npm-publish.yml` for each Release. --outside-actions-starts-release-workflows
 * overrides that, for someone who means it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const PACKAGE = 'factory-factory';
const REGISTRY = 'https://registry.npmjs.org';
const PUBLISH_WORKFLOW = '.github/workflows/npm-publish.yml';
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;
// GitHub's secondary rate limit allows 80 content-creating requests a minute.
const PAUSE_BETWEEN_RELEASES_MS = 2000;

/**
 * The npm `latest` version when this workflow was added. It and every older version are
 * the backlog: published before tags were automatic, and tagged or released only when a
 * maintainer runs the workflow with `backlog` set, because each Release notifies everyone
 * watching the repository. Every newer version is released automatically. This never
 * needs to move.
 */
export const BACKLOG_CUTOFF = '0.5.14';

export const BACKLOG_MODES = ['none', 'tags', 'releases'] as const;
export type Backlog = (typeof BACKLOG_MODES)[number];

export type Outcome = { ok: true } | { ok: false; reason: string };
export type Source = { ok: true; commit: string; runId: string } | { ok: false; reason: string };

export interface ReleaseRequest {
  tag: string;
  commit: string;
  name: string;
  body: string;
  latest: boolean;
}

/** Everything the run reads or writes. The CLI wires the real registry, git and `gh`. */
export interface ReleaseEnvironment {
  packument(): Promise<unknown>;
  /** The attestations document for a version, or null when npm has none. */
  attestations(version: string): Promise<unknown>;
  /** Each tag on `origin` and the commit it points at. */
  remoteTags(): Map<string, string>;
  /** The tags that have a GitHub Release. */
  releasedTags(): Set<string>;
  mainHead(): string;
  commitExists(commit: string): boolean;
  isAncestor(commit: string, head: string): boolean;
  /** `package.json` at a commit, or null when it has none. */
  packageJsonAt(commit: string): string | null;
  /** The GitHub Actions run as GitHub reports it, or null when GitHub has no such run. */
  stagingRun(runId: string): Promise<unknown>;
  verifyPublished(version: string, commit: string, runId: string): Promise<Outcome>;
  /** Creates a tag alone; a tag notifies nobody. */
  createTag(tag: string, commit: string): void;
  /** Creates a Release, and its tag at the commit when the tag does not exist. */
  createRelease(release: ReleaseRequest): void;
  pause(milliseconds: number): Promise<void>;
  changelog: string;
}

const packumentSchema = z.object({
  'dist-tags': z.record(z.string(), z.string()),
  versions: z.record(z.string(), z.unknown()),
});

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** Stable published versions, oldest first, and the version npm installs by default. */
export function publishedVersions(packument: unknown): {
  versions: string[];
  latest: string | undefined;
} {
  const parsed = packumentSchema.parse(packument);
  return {
    versions: Object.keys(parsed.versions)
      .filter((version) => STABLE_VERSION.test(version))
      .toSorted(compareVersions),
    latest: parsed['dist-tags'].latest,
  };
}

const attestationsSchema = z.object({
  attestations: z.array(
    z.object({
      predicateType: z.string(),
      bundle: z.object({ dsseEnvelope: z.object({ payload: z.string() }) }),
    })
  ),
});

const statementSchema = z.object({
  _type: z.literal('https://in-toto.io/Statement/v1'),
  predicateType: z.literal(SLSA_PROVENANCE),
  subject: z.array(z.object({ name: z.string() })),
  predicate: z.object({
    buildDefinition: z.object({
      externalParameters: z.object({
        workflow: z.object({ repository: z.string(), path: z.string(), ref: z.string() }),
      }),
      resolvedDependencies: z.array(
        z.object({ uri: z.string(), digest: z.object({ gitCommit: z.string().optional() }) })
      ),
    }),
    runDetails: z.object({ metadata: z.object({ invocationId: z.string() }) }),
  }),
});
type Statement = z.infer<typeof statementSchema>;

function decodeStatement(payload: string): Statement | null {
  try {
    const parsed = statementSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The commit and staging run recorded in a version's SLSA provenance, accepted only when
 * the statement was produced by this repository's publish workflow on `main`.
 */
export function provenanceSource(document: unknown, version: string, repository: string): Source {
  if (document === null) {
    return { ok: false, reason: 'no provenance attestation on npm' };
  }
  const parsed = attestationsSchema.safeParse(document);
  if (!parsed.success) {
    return { ok: false, reason: 'unreadable attestations document' };
  }
  const statements = parsed.data.attestations
    .filter((attestation) => attestation.predicateType === SLSA_PROVENANCE)
    .map((attestation) => decodeStatement(attestation.bundle.dsseEnvelope.payload));
  if (statements.includes(null)) {
    return { ok: false, reason: 'unreadable provenance statement' };
  }
  const subject = `pkg:npm/${PACKAGE}@${version}`;
  const matching = statements.filter(
    (statement): statement is Statement =>
      statement?.subject.some((item) => item.name === subject) === true
  );
  const [statement] = matching;
  if (matching.length !== 1 || statement === undefined) {
    return { ok: false, reason: `expected one provenance statement, found ${matching.length}` };
  }
  const { workflow } = statement.predicate.buildDefinition.externalParameters;
  const repositoryUrl = `https://github.com/${repository}`;
  if (workflow.repository !== repositoryUrl) {
    return { ok: false, reason: `built by ${workflow.repository}, not ${repositoryUrl}` };
  }
  if (workflow.path !== PUBLISH_WORKFLOW || workflow.ref !== 'refs/heads/main') {
    return { ok: false, reason: `built by ${workflow.path} at ${workflow.ref}` };
  }
  const sourceUri = `git+${repositoryUrl}@refs/heads/main`;
  const commits = new Set(
    statement.predicate.buildDefinition.resolvedDependencies
      .filter((dependency) => dependency.uri === sourceUri)
      .map((dependency) => dependency.digest.gitCommit)
  );
  const [commit] = commits;
  if (commits.size !== 1 || commit === undefined || !COMMIT.test(commit)) {
    return { ok: false, reason: `no single source commit for ${sourceUri}` };
  }
  const run = new RegExp(`^${escapeRegExp(repositoryUrl)}/actions/runs/(\\d+)/attempts/\\d+$`).exec(
    statement.predicate.runDetails.metadata.invocationId
  );
  if (run?.[1] === undefined) {
    return { ok: false, reason: 'staging run is not in this repository' };
  }
  return { ok: true, commit, runId: run[1] };
}

/** The version's CHANGELOG section when there is one, then the npm version and commit. */
export function releaseBody(changelog: string, version: string, commit: string): string {
  const footer = `Published to npm as ${PACKAGE}@${version}, built from ${commit}.`;
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) {
    return footer;
  }
  const length = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const section = lines
    .slice(start + 1, length === -1 ? undefined : start + 1 + length)
    .join('\n')
    .trim();
  return section === '' ? footer : `${section}\n\n${footer}`;
}

const manifestSchema = z.object({ version: z.string() });

function checkCommit(
  environment: ReleaseEnvironment,
  version: string,
  commit: string,
  head: string,
  repository: string
): Outcome {
  if (!environment.commitExists(commit)) {
    return { ok: false, reason: `commit ${commit} is not in ${repository}` };
  }
  if (!environment.isAncestor(commit, head)) {
    return { ok: false, reason: `commit ${commit} is not reachable from main` };
  }
  const manifest = environment.packageJsonAt(commit);
  let declared: string | undefined;
  try {
    declared = manifest === null ? undefined : manifestSchema.parse(JSON.parse(manifest)).version;
  } catch {
    declared = undefined;
  }
  if (declared !== version) {
    return {
      ok: false,
      reason: `package.json at ${commit} is version ${declared ?? '(unreadable)'}`,
    };
  }
  return { ok: true };
}

/** A verified version and what to create for it: its tag alone, or a Release. */
interface Creation {
  kind: 'tag' | 'release';
  release: ReleaseRequest;
  /** The tag already exists at the verified commit; only the Release is missing. */
  existingTag: boolean;
}

interface Options {
  repository: string;
  dryRun: boolean;
  backlog: Backlog;
}

/**
 * What each version needs. A version newer than the cutoff without a tag gets its tag and
 * Release together. A backlog version is only listed, unless the run asks to tag it or to
 * release it.
 */
function wanted(
  environment: ReleaseEnvironment,
  tags: Map<string, string>,
  versions: string[],
  backlog: Backlog,
  lines: string[]
): { version: string; kind: Creation['kind'] }[] {
  const released = backlog === 'releases' ? environment.releasedTags() : new Set<string>();
  return versions.flatMap((version) => {
    const kind = wantedKind(version, backlog, tags, released);
    if (kind === 'listed') {
      lines.push(`backlog v${version}: not released automatically`);
    }
    return kind === 'listed' || kind === null ? [] : [{ version, kind }];
  });
}

function wantedKind(
  version: string,
  backlog: Backlog,
  tags: Map<string, string>,
  released: Set<string>
): Creation['kind'] | 'listed' | null {
  const tag = `v${version}`;
  if (compareVersions(version, BACKLOG_CUTOFF) > 0) {
    return tags.has(tag) ? null : 'release';
  }
  if (backlog === 'releases' && released.has(tag)) {
    // A Release whose tag was deleted gets its tag back.
    return tags.has(tag) ? null : 'tag';
  }
  if (backlog === 'releases') {
    return 'release';
  }
  if (tags.has(tag)) {
    return null;
  }
  return backlog === 'tags' ? 'tag' : 'listed';
}

export async function tagPublishedVersions(
  environment: ReleaseEnvironment,
  options: Options
): Promise<{ exitCode: number; lines: string[] }> {
  const { versions, latest } = publishedVersions(await environment.packument());
  const lines = [`mode: backlog ${options.backlog}${options.dryRun ? ', dry run' : ''}`];
  const tags = environment.remoteTags();
  const candidates = wanted(environment, tags, versions, options.backlog, lines);
  if (candidates.length === 0) {
    lines.push('nothing to create');
    if (options.dryRun) {
      lines.push(countLine([]));
    }
    return { exitCode: 0, lines };
  }
  const head = environment.mainHead();
  const creations: Creation[] = [];
  let skipped = 0;
  // One version at a time keeps registry requests sequential.
  for (const { version, kind } of candidates) {
    const tag = `v${version}`;
    const existing = tags.get(tag);
    const verified = await verifiedSource(environment, version, head, options.repository);
    // A Release is added to an existing tag only when the tag is at the verified commit.
    const source: Source =
      verified.ok && existing !== undefined && existing !== verified.commit
        ? { ok: false, reason: `tag ${tag} points at ${existing}, not ${verified.commit}` }
        : verified;
    if (!source.ok) {
      lines.push(`skipped ${tag}: ${source.reason}`);
      skipped += 1;
      continue;
    }
    creations.push({
      kind,
      existingTag: existing !== undefined,
      release: {
        tag,
        commit: source.commit,
        name: tag,
        body: releaseBody(environment.changelog, version, source.commit),
        latest: version === latest,
      },
    });
  }
  const created = await createAll(environment, creations, options.dryRun, lines);
  if (options.dryRun) {
    lines.push(countLine(creations));
  }
  return { exitCode: skipped === 0 && created ? 0 : 1, lines };
}

/** How many Releases and new tags a run would create; a Release creates its missing tag. */
function countLine(creations: Creation[]): string {
  const releases = creations.filter((creation) => creation.kind === 'release').length;
  const tags = creations.filter((creation) => !creation.existingTag).length;
  return `would create ${releases} Releases and ${tags} tags`;
}

/**
 * The version's provenance source, once its commit and published bytes check out. A
 * failed request skips this version only, so the others are still released this run.
 */
async function verifiedSource(
  environment: ReleaseEnvironment,
  version: string,
  head: string,
  repository: string
): Promise<Source> {
  try {
    return await checkVersion(environment, version, head, repository);
  } catch (error) {
    return {
      ok: false,
      reason: `could not check: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkVersion(
  environment: ReleaseEnvironment,
  version: string,
  head: string,
  repository: string
): Promise<Source> {
  const source = provenanceSource(await environment.attestations(version), version, repository);
  if (!source.ok) {
    return source;
  }
  const checked = checkCommit(environment, version, source.commit, head, repository);
  const confirmed = checked.ok
    ? checkStagingRun(await environment.stagingRun(source.runId), source.runId, source.commit)
    : checked;
  const verified = confirmed.ok
    ? await environment.verifyPublished(version, source.commit, source.runId)
    : confirmed;
  return verified.ok ? source : verified;
}

const runSchema = z.object({
  path: z.string(),
  event: z.string(),
  head_branch: z.string().nullable(),
  conclusion: z.string().nullable(),
  head_sha: z.string(),
});

/**
 * GitHub's own record of the staging run named by the provenance: the publish workflow,
 * dispatched on `main`, successful, at the provenance commit. This is the one check that
 * does not rest on what the npm registry returns.
 */
export function checkStagingRun(document: unknown, runId: string, commit: string): Outcome {
  const prefix = `staging run ${runId}`;
  if (document === null) {
    return { ok: false, reason: `${prefix} is not on GitHub` };
  }
  const parsed = runSchema.safeParse(document);
  if (!parsed.success) {
    return { ok: false, reason: `${prefix} is unreadable` };
  }
  const run = parsed.data;
  if (run.path !== PUBLISH_WORKFLOW) {
    return { ok: false, reason: `${prefix} ran ${run.path}` };
  }
  if (run.event !== 'workflow_dispatch') {
    return { ok: false, reason: `${prefix} was started by ${run.event}, not workflow_dispatch` };
  }
  if (run.head_branch !== 'main') {
    return { ok: false, reason: `${prefix} ran on ${run.head_branch ?? 'no branch'}, not main` };
  }
  if (run.conclusion !== 'success') {
    return { ok: false, reason: `${prefix} concluded ${run.conclusion ?? 'nothing'}, not success` };
  }
  if (run.head_sha !== commit) {
    return { ok: false, reason: `${prefix} built ${run.head_sha}, not ${commit}` };
  }
  return { ok: true };
}

function summarize({ kind, release, existingTag }: Creation): string {
  const suffix =
    kind === 'tag'
      ? ''
      : `${existingTag ? ' (existing tag)' : ''}${release.latest ? ' (latest)' : ''}`;
  return `${release.tag} at ${release.commit}${suffix}`;
}

/** Creates everything oldest first, pausing between; false after the first failure. */
async function createAll(
  environment: ReleaseEnvironment,
  creations: Creation[],
  dryRun: boolean,
  lines: string[]
): Promise<boolean> {
  for (const [index, creation] of creations.entries()) {
    const verb = creation.kind === 'tag' ? 'tag' : 'release';
    if (dryRun) {
      lines.push(`would ${verb} ${summarize(creation)}`);
      continue;
    }
    if (index > 0) {
      await environment.pause(PAUSE_BETWEEN_RELEASES_MS);
    }
    try {
      if (creation.kind === 'tag') {
        environment.createTag(creation.release.tag, creation.release.commit);
      } else {
        environment.createRelease(creation.release);
      }
    } catch (error) {
      // Stop rather than create later versions ahead of this one.
      lines.push(
        `failed to ${verb} ${creation.release.tag}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
    lines.push(`${verb === 'tag' ? 'tagged' : 'released'} ${summarize(creation)}`);
  }
  return true;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function succeeds(root: string, args: readonly string[]): boolean {
  return spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status === 0;
}

/** The git half of the environment, against `origin` of the checkout at `root`. */
export function gitEnvironment(
  root: string
): Pick<
  ReleaseEnvironment,
  'remoteTags' | 'mainHead' | 'commitExists' | 'isAncestor' | 'packageJsonAt'
> {
  return {
    remoteTags: () => {
      // An annotated tag is listed twice; its peeled `^{}` line names the commit.
      const tags = new Map<string, string>();
      const peeled = new Map<string, string>();
      for (const line of git(root, ['ls-remote', '--tags', 'origin']).split('\n')) {
        const [object, ref] = line.split('\t');
        const name = ref?.replace(/^refs\/tags\//, '');
        if (object === undefined || name === undefined || name === '') {
          continue;
        }
        if (name.endsWith('^{}')) {
          peeled.set(name.slice(0, -3), object);
        } else {
          tags.set(name, object);
        }
      }
      return new Map([...tags].map(([name, object]) => [name, peeled.get(name) ?? object]));
    },
    mainHead: () => {
      git(root, ['fetch', '--quiet', '--no-tags', 'origin', 'main']);
      return git(root, ['rev-parse', 'FETCH_HEAD']).trim();
    },
    commitExists: (commit) => succeeds(root, ['cat-file', '-e', `${commit}^{commit}`]),
    isAncestor: (commit, head) => succeeds(root, ['merge-base', '--is-ancestor', commit, head]),
    packageJsonAt: (commit) => {
      const result = spawnSync('git', ['show', `${commit}:package.json`], {
        cwd: root,
        encoding: 'utf8',
      });
      return result.status === 0 ? result.stdout : null;
    },
  };
}

/**
 * Runs `scripts/verify-npm-release.sh` on a directory holding the published tarball: the
 * registry's integrity and the provenance subject must match those bytes, and the
 * provenance must name this repository's publish workflow, the commit and the run.
 */
export function verifyDownloadedPackage(
  root: string,
  directory: string,
  version: string,
  commit: string,
  runId: string,
  repository: string
): Outcome {
  const result = spawnSync(
    'bash',
    [join(root, 'scripts/verify-npm-release.sh'), directory, commit, runId, repository],
    { cwd: root, encoding: 'utf8' }
  );
  if (result.status === 0 && result.stdout.trim() === version) {
    return { ok: true };
  }
  return { ok: false, reason: result.stderr.trim() || 'release verification failed' };
}

async function registryJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

/** The body of `POST /repos/{repository}/releases`. */
export function releaseRequestBody(release: ReleaseRequest) {
  return {
    tag_name: release.tag,
    // GitHub creates a missing tag at this commit; an existing tag is used as is, and
    // was checked to point at this commit.
    target_commitish: release.commit,
    name: release.name,
    body: release.body,
    draft: false,
    prerelease: false,
    // GitHub marks a new release latest unless told otherwise, as the string 'false'.
    make_latest: release.latest ? 'true' : 'false',
  };
}

/**
 * GitHub's record of a run. It tries the workflow token, then the public API, because
 * run records of a public repository are public and the job does not ask for
 * `actions: read`.
 */
async function readStagingRun(root: string, repository: string, runId: string): Promise<unknown> {
  const path = `repos/${repository}/actions/runs/${runId}`;
  const viaToken = spawnSync('gh', ['api', path], { cwd: root, encoding: 'utf8' });
  if (viaToken.status === 0) {
    const parsed: unknown = JSON.parse(viaToken.stdout);
    return parsed;
  }
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'factory-factory-release-tags',
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

function liveEnvironment(root: string, repository: string): ReleaseEnvironment {
  return {
    ...gitEnvironment(root),
    packument: () => registryJson(`${REGISTRY}/${PACKAGE}`),
    attestations: (version) =>
      registryJson(`${REGISTRY}/-/npm/v1/attestations/${PACKAGE}@${version}`),
    stagingRun: (runId) => readStagingRun(root, repository, runId),
    verifyPublished: async (version, commit, runId) => {
      const directory = mkdtempSync(join(tmpdir(), 'ff-release-'));
      try {
        const url = `${REGISTRY}/${PACKAGE}/-/${PACKAGE}-${version}.tgz`;
        const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) {
          return { ok: false, reason: `${url} returned HTTP ${response.status}` };
        }
        writeFileSync(
          join(directory, `${PACKAGE}-${version}.tgz`),
          Buffer.from(await response.arrayBuffer())
        );
        return verifyDownloadedPackage(root, directory, version, commit, runId, repository);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    releasedTags: () =>
      new Set(
        execFileSync(
          'gh',
          [
            'api',
            '--paginate',
            `repos/${repository}/releases?per_page=100`,
            '--jq',
            '.[].tag_name',
          ],
          { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        )
          .split('\n')
          .filter(Boolean)
      ),
    createTag: (tag, commit) => {
      execFileSync(
        'gh',
        [
          'api',
          '--method',
          'POST',
          `repos/${repository}/git/refs`,
          '-f',
          `ref=refs/tags/${tag}`,
          '-f',
          `sha=${commit}`,
        ],
        { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] }
      );
    },
    // A release or tag created with the workflow token triggers no other workflow, so
    // neither npm publishing nor any `release` listener runs for these.
    createRelease: (release) => {
      execFileSync(
        'gh',
        ['api', '--method', 'POST', `repos/${repository}/releases`, '--input', '-'],
        {
          cwd: root,
          input: JSON.stringify(releaseRequestBody(release)),
          stdio: ['pipe', 'ignore', 'pipe'],
        }
      );
    },
    pause: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    changelog: readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
  };
}

const OUTSIDE_ACTIONS_OVERRIDE = 'outside-actions-starts-release-workflows';

/**
 * Only the workflow token creates Releases that start no other workflow. Anywhere else, a
 * personal `gh` login would start `npm-publish.yml` for every Release created.
 */
export function mayCreate(run: { dryRun: boolean; inActions: boolean; override: boolean }) {
  return run.dryRun || run.inActions || run.override;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      backlog: { type: 'string', default: 'none' },
      'dry-run': { type: 'boolean', default: false },
      [OUTSIDE_ACTIONS_OVERRIDE]: { type: 'boolean', default: false },
    },
  });
  const repository = z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .parse(values.repository);
  const backlog = z.enum(BACKLOG_MODES).parse(values.backlog);
  if (
    !mayCreate({
      dryRun: values['dry-run'],
      inActions: process.env.GITHUB_ACTIONS === 'true',
      override: values[OUTSIDE_ACTIONS_OVERRIDE],
    })
  ) {
    throw new Error(
      `refusing to create tags or Releases outside GitHub Actions: with a personal gh login each Release starts npm-publish.yml. Use --dry-run, or --${OUTSIDE_ACTIONS_OVERRIDE} if that is intended.`
    );
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const report = await tagPublishedVersions(liveEnvironment(root, repository), {
    repository,
    dryRun: values['dry-run'],
    backlog,
  });
  // A Markdown list, so the job summary keeps one line per version.
  process.stdout.write(report.lines.map((line) => `- ${line}\n`).join(''));
  return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `Tagging npm releases failed: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    }
  );
}
