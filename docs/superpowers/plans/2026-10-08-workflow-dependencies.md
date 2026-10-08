# GitHub Actions dependency audit

Audited October 8, 2026. Upgrade workflow actions to their latest stable
releases and pin every action to its verified release commit. The five workflows
keep their existing triggers, permissions, inputs, environment and release
behavior.

| Action                                     | Release                                                                                     | Compatibility                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions/checkout`                         | [v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)                           | Node24, runner >=2.327.1. v6 credentials stored under RUNNER_TEMP; normal git push remains automatic. Authenticated git from Docker actions requires runner >=2.329.0. v7 refuses unsafe fork checkout for pull_request_target/workflow_run; neither exists in current workflows. Preserve default safe behavior.            |
| `actions/setup-node`                       | [v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)                         | Node24, runner >=2.327.1. v6 automatic cache only npm; pnpm cache stays explicitly enabled in CI. Removed always-auth (unused). v7 no dummy NODE_AUTH_TOKEN; registry-url not used anywhere. npm publish workflow uses OIDC id-token:write and npm stage publish, automatic cache disabled, so auth unaffected.              |
| `actions/upload-artifact`                  | [v7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2)                    | Node24, runner >=2.327.1. v7 direct unzipped uploads are opt-in via archive:false. Leave archive default true: names/file paths and existing downloads preserved. v4+ artifact format already used; hidden files default excluded already.                                                                                   |
| `actions/download-artifact`                | [v8.0.2](https://github.com/actions/download-artifact/releases/tag/v8.0.2)                  | Node24, runner >=2.327.1. v8 digest mismatch now errors; retain secure default. Existing name-based downloads keep path behavior. Existing download-all remains per-artifact directories. v5 artifact-id single extraction change irrelevant (no artifact-ids input). v4 uploaded zip artifacts compatible; no v3 producers. |
| `github/codeql-action`                     | [v4.38.3](https://github.com/github/codeql-action/releases/tag/v4.38.3)                     | v4 Node24; hosted ubuntu-latest supports it. languages javascript-typescript/actions and build-mode:none retained. No pinned ancient CodeQL bundle, GHES or self-hosted constraints.                                                                                                                                         |
| `docker/setup-buildx-action`               | [v4.4.1](https://github.com/docker/setup-buildx-action/releases/tag/v4.4.1)                 | Node24 ESM. Removed config/config-inline/install inputs, none used (setup step has no with). Deprecated outputs should not matter: setup step has no id/output consumers.                                                                                                                                                    |
| `docker/login-action`                      | [v4.6.0](https://github.com/docker/login-action/releases/tag/v4.6.0)                        | Node24 ESM. Existing registry/username/password GHCR login inputs retained; no ECR/AWS or special buildx-scoped auth setup.                                                                                                                                                                                                  |
| `docker/metadata-action`                   | [v6.2.0](https://github.com/docker/metadata-action/releases/tag/v6.2.0)                     | Node24 ESM. v6 list parser preserves inline #; current images and type=ref/type=sha have no #. Existing tags/labels outputs retained.                                                                                                                                                                                        |
| `docker/build-push-action`                 | [v7.4.0](https://github.com/docker/build-push-action/releases/tag/v7.4.0)                   | Node24 ESM. Removed DOCKER_BUILD_NO_SUMMARY, DOCKER_BUILD_EXPORT_RETENTION_DAYS; neither is used. Current context, push, tags, labels, cache-from/cache-to retained. Buildx installed by current setup action; Docker ghcr token unchanged.                                                                                  |
| `softprops/action-gh-release`              | [v3.0.3](https://github.com/softprops/action-gh-release/releases/tag/v3.0.3)                | Node24 runtime change. files/tag_name/name/draft/generate_release_notes inputs retained. Existing contents:write permissions unchanged.                                                                                                                                                                                      |
| `davelosert/vitest-coverage-report-action` | [v2.13.0](https://github.com/davelosert/vitest-coverage-report-action/releases/tag/v2.13.0) | Current stable v2.13.0 is same major as installed pinned v2.7.0-ish; optional refresh only. New comment markers optional; existing inputs retained.                                                                                                                                                                          |

The existing `pnpm/action-setup` pin already uses the latest stable v6.1.0 and
is retained.

## Verification

- Parse all five YAML workflows and compare their structure with the base: only
  action references change; all 46 uses have exact 40-character commit pins.
- Validate the workflows using the official actionlint 1.7.12 release binary,
  verified against its published SHA-256 checksum. ShellCheck is unavailable
  locally, so this run validates YAML, actions and expressions only.
- Retrieve all 13 official action manifests at the pinned commits and validate
  every supplied input against those manifests.
- Run the required repository checks and tests. CI executes the updated core
  actions and CodeQL; Docker, npm and Electron publication await their existing
  push, tag or manual triggers. No release is published by this audit.
