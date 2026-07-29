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
   request.
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
7. Only the verified tarball is published through npm OIDC with provenance.
   The privileged job installs no dependencies, runs no project scripts, and
   receives no npm write token.

Preparation runs are serialized. Publication concurrency includes the prepared
SHA so the self-dispatched run is not blocked by its own preparation while
duplicate publication attempts for the same SHA remain non-cancelling.
Conflicting release tags are never rewritten.

The npm trusted publisher is externally bound to organization `Plasius-LTD`,
repository `storage`, workflow `cd.yml`, environment `production`, and action
`npm publish`. GitHub `main` and `production` policies are independent
admission controls. The inherited rollout flag is
`platform.public-artifact-integrity.enabled`; rollback disables `cd.yml` and
never restores token publication.

## Consequences

- npm provenance, package bytes, successful CI, tag, and GitHub release bind to
  one immutable `main` commit.
- The restored `privacy:check` package script is a release admission gate.
- Dependency and third-party code cannot use production OIDC or mutation
  permissions.
- A moved `main`, mismatched existing package, or stale dispatch fails closed.

## Alternatives considered

- Publishing after checking out a child commit in the original run was
  rejected because provenance remains bound to the dispatch commit.
- A token fallback was rejected because it weakens the trusted-publisher
  boundary and makes successful authentication ambiguous.
- One shared concurrency group was rejected because the self-dispatched
  publish run would wait behind the prepare run; unsupported queue extensions
  are not part of the GitHub Actions workflow schema.
