# ADR-0002: Public Repository Governance Baseline

- Date: 2026-02-11
- Status: Accepted

## Context

Public npm distribution requires transparent contributor and security policy
artifacts and consistent release automation.

## Decision

Include these baseline governance assets:

- `CODE_OF_CONDUCT.md`
- `CONTRIBUTORS.md`
- `SECURITY.md`
- `legal/` CLA documents
- CI/CD GitHub Actions workflows

## Consequences

- Public contributors and consumers can follow a predictable governance process.
- Release quality gates (build, test, coverage, publish) are standardized.
