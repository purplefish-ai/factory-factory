/**
 * Tags and releases every npm version of factory-factory that has no `v<version>` tag.
 *
 * Publishing is `npm stage publish` followed by a maintainer's approval on npm, outside
 * GitHub, so the publish workflow cannot tag. This runs on a schedule instead. Published
 * versions carry no `gitHead`; the commit each was built from is read from its npm
 * provenance attestation, which must name this repository's publish workflow on `main`.
 * The commit must exist here, be reachable from `main` and declare that version, and
 * `scripts/verify-npm-release.sh` must accept the published tarball, before a tag and a
 * release are created. Anything else is reported and skipped, never guessed.
 *
 * Usage: tsx scripts/tag-npm-releases.ts --repository <owner/name> [--dry-run]
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
  remoteTags(): Set<string>;
  mainHead(): string;
  commitExists(commit: string): boolean;
  isAncestor(commit: string, head: string): boolean;
  /** `package.json` at a commit, or null when it has none. */
  packageJsonAt(commit: string): string | null;
  verifyPublished(version: string, commit: string, runId: string): Promise<Outcome>;
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

export async function tagPublishedVersions(
  environment: ReleaseEnvironment,
  options: { repository: string; dryRun: boolean }
): Promise<{ exitCode: number; lines: string[] }> {
  const { versions, latest } = publishedVersions(await environment.packument());
  const tags = environment.remoteTags();
  const untagged = versions.filter((version) => !tags.has(`v${version}`));
  if (untagged.length === 0) {
    return { exitCode: 0, lines: ['every published version is tagged'] };
  }
  const head = environment.mainHead();
  const lines: string[] = [];
  const releases: ReleaseRequest[] = [];
  // One version at a time keeps registry requests sequential.
  for (const version of untagged) {
    const source = await verifiedSource(environment, version, head, options.repository);
    if (!source.ok) {
      lines.push(`skipped v${version}: ${source.reason}`);
      continue;
    }
    releases.push({
      tag: `v${version}`,
      commit: source.commit,
      name: `v${version}`,
      body: releaseBody(environment.changelog, version, source.commit),
      latest: version === latest,
    });
  }
  const skipped = lines.length;
  const created = await createReleases(environment, releases, options.dryRun, lines);
  return { exitCode: skipped === 0 && created ? 0 : 1, lines };
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
  const verified = checked.ok
    ? await environment.verifyPublished(version, source.commit, source.runId)
    : checked;
  return verified.ok ? source : verified;
}

/** Creates the releases in order, pausing between them; false after the first failure. */
async function createReleases(
  environment: ReleaseEnvironment,
  releases: ReleaseRequest[],
  dryRun: boolean,
  lines: string[]
): Promise<boolean> {
  for (const [index, release] of releases.entries()) {
    const described = `${release.tag} at ${release.commit}${release.latest ? ' (latest)' : ''}`;
    if (dryRun) {
      lines.push(`would release ${described}`);
      continue;
    }
    if (index > 0) {
      await environment.pause(PAUSE_BETWEEN_RELEASES_MS);
    }
    try {
      environment.createRelease(release);
    } catch (error) {
      // Stop rather than release later versions ahead of this one.
      lines.push(
        `failed to release ${release.tag}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
    lines.push(`released ${described}`);
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
    remoteTags: () =>
      new Set(
        git(root, ['ls-remote', '--tags', 'origin'])
          .split('\n')
          .map((line) =>
            line
              .split('\t')[1]
              ?.replace(/^refs\/tags\//, '')
              .replace(/\^\{\}$/, '')
          )
          .filter((tag): tag is string => tag !== undefined && tag !== '')
      ),
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

function liveEnvironment(root: string, repository: string): ReleaseEnvironment {
  return {
    ...gitEnvironment(root),
    packument: () => registryJson(`${REGISTRY}/${PACKAGE}`),
    attestations: (version) =>
      registryJson(`${REGISTRY}/-/npm/v1/attestations/${PACKAGE}@${version}`),
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
    // A release created with the workflow token triggers no other workflow, so neither
    // npm publishing nor any `release` listener runs for these.
    createRelease: (release) => {
      execFileSync(
        'gh',
        ['api', '--method', 'POST', `repos/${repository}/releases`, '--input', '-'],
        {
          cwd: root,
          input: JSON.stringify({
            tag_name: release.tag,
            // GitHub creates the missing tag at this commit.
            target_commitish: release.commit,
            name: release.name,
            body: release.body,
            draft: false,
            prerelease: false,
            make_latest: release.latest ? 'true' : 'false',
          }),
          stdio: ['pipe', 'ignore', 'pipe'],
        }
      );
    },
    pause: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    changelog: readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { repository: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
  });
  const repository = z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .parse(values.repository);
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const report = await tagPublishedVersions(liveEnvironment(root, repository), {
    repository,
    dryRun: values['dry-run'],
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
