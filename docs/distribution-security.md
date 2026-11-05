# Distribution security

## Container images

The Dockerfile pins the Node/Alpine multi-platform image by its OCI index
digest. The index selects the correct Linux amd64 or arm64 image. Update the
Node tag, index digest, `.node-version`, and package engine requirement
together.

Cloudflared and uv use versioned release assets with committed SHA-256 hashes
for both supported architectures. Hashes are verified before either executable
is installed or an archive is extracted. uv is extracted directly; its remote
installer is not executed. Download the replacement assets and compare them
against the official GitHub release API's `digest` fields before changing a
version or hash:

```sh
gh api repos/cloudflare/cloudflared/releases/tags/2026.10.7
gh api repos/astral-sh/uv/releases/tags/0.13.6
docker buildx imagetools inspect node:26.12.1-alpine
```

Standalone Codex for workspace shell use has an exact version in the Dockerfile.
The application's ACP runtime versions remain controlled by its lockfile.

The dependency stage installs the frozen pnpm graph and applies the repository's
patches. A separate stage prunes development-only dependencies without running
lifecycle scripts again; the application builder retains its full toolchain. The
runner copies the pruned graph, retaining required native modules and their
installed binaries. Build tools intentionally remain in the operating system so
agents can compile native dependencies in user workspaces.

Docker publishing emits BuildKit provenance and an SPDX SBOM alongside the image
manifest. Inspect them using the published image digest rather than a mutable
tag. These describe build inputs and installed software; they do not establish
that the software is free of vulnerabilities.

Validate changes with a real image build and runtime smoke checks:

```sh
docker build -t factory-factory:security-check .
docker run --rm --entrypoint ff factory-factory:security-check serve --help
docker run --rm --entrypoint codex factory-factory:security-check --version
docker run --rm --entrypoint uv factory-factory:security-check --version
docker run --rm --entrypoint cloudflared factory-factory:security-check --version
```

Run the Docker Build workflow for CI validation without publishing. Docker Build
& Push publishes only from main; no package or image publishing is needed to
validate a pull request.

Alpine packages and transitive Python tooling dependencies still resolve from
upstream repositories at build time. The pinned base image and executable
checksums do not make the entire image build reproducible. Review SBOM changes
and rebuild regularly for operating-system security updates.
