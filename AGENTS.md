# AGENTS

## Scope
- This directory contains a package/site in the Plasius workspace.

## Release and Quality Policy
- Update `README.md` whenever structural changes are made.
- Update `CHANGELOG.md` after every change.
- For fixes, add tests and run relevant tests before committing.
- Publish packages to npm only through GitHub CD workflows; do not publish directly from local machines.
- Maintain code coverage at 80% or higher where possible. Shader-related code is exempt.


## Plasius Package Creation Reference
- Use `/Users/philliphounslow/plasius/schema` (`@plasius/schema`) as the baseline template when creating new `@plasius/*` packages.
- Copy template runtime/tooling files at project creation: `.nvmrc` and `.npmrc`.
- Create and maintain required package docs from the start:
  - `README.md`: initialize for package purpose/API and update whenever structure or public behavior changes.
  - `CHANGELOG.md`: initialize at creation and update after every change.
  - `AGENTS.md`: include package-specific guidance and keep this policy section present.
- Include required legal/compliance files and folders used by the template/repo standards:
  - `LICENSE`
  - `SECURITY.md`
  - `CONTRIBUTING.md`
  - `legal/` documents (including CLA-related files where applicable)
- Include architecture/design documentation requirements:
  - ADRs in `docs/adrs/` for architectural decisions.
  - TDRs for technical decisions/direction.
  - Design documents for significant implementation plans and system behavior.
- Testing requirements for new packages and ongoing changes:
  - Define test scripts/strategy at creation time.
  - Create tests for all fixes and run relevant tests before committing.
  - Maintain code coverage at 80%+ where possible; shader-related code is the only coverage exception.
