# ADR-0005: Exact-main OIDC package publishing

- Status: Accepted
- Date: 2026-07-29

## Context

The former package workflow prepared a release commit and published it from the
workflow run dispatched at the preceding commit. Checking out a newer commit
does not change a GitHub Actions run's source identity, so npm provenance could
identify a different commit from the package and tag. The workflow also
configured a reusable long-lived npm write token, and CD referenced a missing
package privacy script.

## Decision

Use a two-run release protocol:

1. An operator dispatches `cd.yml` from protected `main` with `phase: prepare`.
2. The reusable preparation workflow versions the package with lifecycle
   scripts disabled and lands metadata through a unique, non-force-pushed pull
   request. The preparation command requires real notes in populated
   changelog categories, promotes them to the requested version, and leaves a
   blank Unreleased section. A rerun verifies the existing version's notes
   without changing them. Historical headings, links and real notes are
   retained. Package validation rejects placeholder text anywhere in the
   changelog, including historical sections.
3. The prepare run waits for successful push-triggered `ci.yml` evidence whose
   branch, event, head SHA, status, and conclusion match the resulting `main`
   commit.
4. If remote `main` still equals that commit, it dispatches `phase: publish`
   from `main`, carrying the exact expected SHA, release tag, and version-derived
   prerelease identity.
5. A read-only hosted job repeats exact-main and exact-CI checks, runs the
   repository privacy gate, validates and packs with lifecycle scripts
   disabled, creates the SBOM, and uploads both as digest-bound direct
   artifacts.
6. The hosted `production` job verifies the exact artifact IDs, digests,
   package identity, safe members, npm distribution tag, and SHA-512 registry
   integrity, then repeats the exact-main check before mutation.
7. Immediately before publishing to npm, the production job checks its
   checkout and fetches remote `main` again. A failed fetch or a mismatch with
   the admitted SHA stops publication, even if the earlier check passed.
8. Only the verified tarball is published through npm OIDC with provenance.
   Both release jobs install the approved npm 11.6.2 client with lifecycle
   scripts disabled and verify Node.js 24.18.0. The production job installs no
   project dependencies, runs no project scripts, and receives no npm write
   token.

Preparation runs are serialized. Publication concurrency includes the prepared
SHA so the self-dispatched run is not blocked by its own preparation while
duplicate publication attempts for the same SHA remain non-cancelling.
Conflicting release tags are never rewritten.

The npm trusted publisher is externally bound to organization `Plasius-LTD`,
repository `storage`, workflow `cd.yml`, environment `production`, and action
`npm publish`. GitHub `main` and `production` policies are independent
admission controls. The inherited rollout flag is
`platform.public-artifact-integrity.enabled`; rollback disables `cd.yml` and
never restores token publication. Its backend evaluator controls rollout admission (Feature #1022):
disable it to suspend admission and re-enable after verifying the release
source, CI and public artifact. Changelog validation remains mandatory in both
states; no environment override or user entitlement applies.

## Consequences

- npm provenance, package bytes, successful CI, tag, and GitHub release bind to
  one immutable `main` commit.
- The restored `privacy:check` package script is a release admission gate.
- Dependency and third-party code cannot use production OIDC or mutation
  permissions.
- A moved `main`, failed main fetch, mismatched existing package, or stale dispatch fails closed.

## Alternatives considered

- Seeding placeholder categories or a generic entry for a new version was
  rejected because it can publish false release history. An empty Unreleased
  section is safe; creating a new version requires actual notes.

- Publishing after checking out a child commit in the original run was
  rejected because provenance remains bound to the dispatch commit.
- A token fallback was rejected because it weakens the trusted-publisher
  boundary and makes successful authentication ambiguous.
- One shared concurrency group was rejected because the self-dispatched
  publish run would wait behind the prepare run; unsupported queue extensions
  are not part of the GitHub Actions workflow schema.
