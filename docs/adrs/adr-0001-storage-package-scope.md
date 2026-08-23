# ADR-0001: Standalone @plasius/storage Package Scope

- Date: 2026-02-11
- Status: Accepted

## Context

This package was previously maintained as a workspace-only module inside
`plasius-ltd-site`. External consumers and remote builds require it to be
installable from npm without monorepo-local links.

## Decision

Move `@plasius/storage` to a standalone root package with independent build,
test, governance, CI, and publish workflows.

## Consequences

- The package can be versioned and released independently.
- `plasius-ltd-site` and other repositories can depend on npm-published versions.
- Build and lint rules must no longer rely on monorepo-relative tsconfig paths.
