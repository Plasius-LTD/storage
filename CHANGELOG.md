# Changelog

All notable changes to this project will be documented in this file.

The format is based on **[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)**, and this project adheres to **[Semantic Versioning](https://semver.org/spec/v2.0.0.html)**.

---

## [Unreleased]

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.2.1] - 2026-08-27

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - Consume the complete package tar listing when checking for built output so
    `pipefail` cannot mistake a successful early match for a failed archive.
  - Pass the verified publication tarball to npm as an explicit local path so
    npm cannot interpret the artifact directory as a hosted Git repository.

- **Security**
  - Added zero-dependency, path-only repository and npm-package gates that
    prevent tabular exports, contributor registries, signed CLA artifacts, and
    privacy-marked registries from entering source control or release artifacts
    without inspecting candidate file contents.
  - Reject contributor acceptance, signature, submission, and signed-agreement
    record aliases, plus signed-CLA storage aliases, across hierarchical,
    case-insensitive separator-free, Windows, and Unicode compatibility path
    forms while retaining explicit public contributor documentation files.
    Classify one closed vocabulary of protected markers, record categories,
    wrappers, and decimal terms optionally prefixed by `v`, `version`,
    `revision`, or `generation` independently of order so reversed terms,
    intervening wrappers, mixed token boundaries, or a third protected marker
    cannot bypass contributor, CLA, or registry policy families. Compact and
    separated numeric wrappers such as `V2` and `version2` remain valid on
    terminal public process, template, policy, schema, and validator documents.
  - Keep raw package-member identity and cardinality alongside normalized paths,
    report rejected private-path categories by count, and collapse exceptional
    traversal or verifier failures to allowlisted codes without logging path
    values, raw exception messages, or stacks.
  - Canonicalize Windows-ignored trailing dots and spaces only in the policy
    classification copy so disguised CSV paths fail every gate without merging
    distinct raw npm package-member identities.
  - Apply the shared contributor-record classifier to every requested npm
    inventory, including package roots beneath excluded tool/cache directories,
    and include every changed gate executable in combined LCOV.
  - Restricted the npm package manifest to an explicit allowlist and exact
    public CLA documents, with the final packed path manifest checked in CI and
    CD before publication.

## [1.2.0] - 2026-08-13

- **Added**
  - Add the Node-only `@plasius/storage/immutable-json-packets` entry point for schema-validated, conditionally created JSON packets, safe replay manifests and dead letters, ETag checkpoint compare-and-swap, and bounded processor leases (task #34).
  - Add one-page, fixed-prefix packet descriptor enumeration with opaque
    kind-bound cursors, strict item/declared-byte/deadline limits, Azure
    `ContainerClient` structural compatibility, and exact metadata admission so
    scheduled materializers can discover packets without a generic Blob scan.

- **Changed**
  - Split release preparation from SHA-bound publication so npm provenance,
    the release tag, package bytes, and successful `main` CI all identify the
    same immutable commit.
  - Extend installed-package validation to require ESM, CommonJS, and type artifacts for immutable JSON packets while denying browser resolution.
  - Pin the build graph to the audited esbuild `0.28.1` line so tsup cannot resolve the vulnerable development-only range identified during the Epic dependency audit.
  - Consume the published compatible `@plasius/schema` 1.4.x and
    `@plasius/entity-manager` 1.1.x lines without source pins, and add an
    Azure-Blob type-only compatibility gate for the injected list driver.

- **Fixed**
  - Prevent the read-only checkout credential from shadowing the scoped
    release-preparation GitHub App token when the protected CD workflow pushes
    its version and changelog branch.
  - Correct the embedded pre-release identity JavaScript terminator and verify
    every embedded release-preparation script parses before publication.

- **Security**
  - Updated the development-tool dependency graph to patched
    `brace-expansion`, `fast-uri`, and `nanoid` releases after the feedback
    release audit.
  - Added fail-closed source and npm-package admission for the administrative contributor registry and pinned the CI/CD runtime to Node.js 24.18.0 LTS.
  - Moved pull-request validation to GitHub-hosted runners while retaining
    fail-closed same-repository admission and workflow-restricted self-hosted
    execution for protected `main`.
  - Replaced long-lived npm write-token configuration with workflow-bound OIDC
    trusted publishing, isolated dependency execution from the privileged
    production publication job, and restored the package privacy gate used by
    CD.
  - Require fixed non-overlapping prefixes, empty schema PII audits, privacy-safe structured JSON snapshots, bounded machine-field keys, pre-enumeration sparse-array limits, deterministic sensitive-field rejection, bounded provider ETags, exact Blob/lease conflict classification, canonical SHA-256 integrity metadata, server-owned dead-letter timestamps, deadline-independent single-flight lease release, redacted dependency errors, opaque lease tokens, and URL/value-free receipts.
  - Ensure packet listing cannot accept a dynamic prefix or expose Blob names,
    values, provider continuations, identity/correlation fields, or arbitrary
    metadata; malformed, oversized, duplicate, cross-kind, and non-progressing
    pages fail closed with value-free diagnostics.

## [1.1.0] - 2026-07-15

- **Added**
  - Add the server-only `@plasius/storage/immutable-assets` API for conditionally writing, fully verifying, and marker-first reading immutable model, GPU-interface, WGSL-shader, style-profile, and qualification-evidence Blob versions (task #27).
  - Document the immutable version protocol, injected Blob-port boundary, threat model, and package ownership decisions in ADR-0003 and TDR-0001.

- **Changed**
  - Align immutable package admission with the shader lifecycle ceiling of one manifest plus at most 512 payloads and keep catalog, authorization, feature-flag, capability, and shader-domain decisions outside the storage package.

- **Fixed**
  - Pin releases to the workflow-dispatch commit and require a fresh dispatch after metadata lands, preventing protected-branch drift from diverging version scope, tags, package bytes, and npm provenance.

- **Security**
  - Require create-if-absent writes, service-computed SHA-256 metadata, manifest-last completion, marker-bound stored-byte re-verification, no write-path delete authority, path allowlisting, and URL/SAS-free receipts and diagnostics for immutable asset versions.

## [1.0.19] - 2026-07-13

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)
  - Consume the propagated entity-manager and RFC-remediated schema releases (task #26).

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.18] - 2026-06-28

- **Added**
  - (placeholder)

- **Changed**
  - Refreshed `@azure/storage-file-share` to `12.32.0` and aligned the published `@plasius/entity-manager` and `@plasius/schema` dependencies with their latest released versions.
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.17] - 2026-06-22

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.16] - 2026-06-22

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.14] - 2026-05-21

- **Added**
  - (placeholder)

- **Changed**
  - Removed the unused `react` and `@azure/cosmos` peer dependencies so the published package contract matches the runtime Azure Files helper surface.

- **Fixed**
  - `uploadUserImageShare()` now derives file extensions from supported image MIME types and normalizes unsafe `userId` values into Azure Files-safe directory names.

- **Security**
  - (placeholder)

## [1.0.13] - 2026-05-13

- **Added**
  - (placeholder)

- **Changed**
  - Refreshed dependencies to the latest stable published versions.
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.12] - 2026-05-13

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.11] - 2026-04-02

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.10] - 2026-03-09

- **Added**
  - (placeholder)

- **Changed**
  - Raised the minimum `@plasius/schema` dependency to `^1.2.6` to align with field exposure and safe serialization support across shared packages.

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.9] - 2026-03-04

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.5] - 2026-03-01

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.4] - 2026-02-28

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.3] - 2026-02-22

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.2] - 2026-02-22

- **Added**
  - (placeholder)

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.1] - 2026-02-13

- **Added**
  - (placeholder)

- **Changed**
  - Replace dual-`tsc` build steps with `tsup` to emit ESM + CJS + types side-by-side in `dist/` (`index.js`, `index.cjs`, `index.d.ts`).

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)

## [1.0.0] - 2026-02-12

- **Added**
  - Standalone public package scaffold at repository root with independent CI/CD, ADRs, and legal governance assets.

- **Changed**
  - Add dual ESM + CJS build outputs with `exports` entries and CJS artifacts in `dist-cjs/`.

- **Fixed**
  - Removed monorepo-relative TypeScript configuration coupling for standalone builds.

- **Security**
  - Added baseline public package governance and CLA documentation.

---

## Release process (maintainers)

1. Update `CHANGELOG.md` under **Unreleased** with user-visible changes.
2. Bump version in `package.json` following SemVer (major/minor/patch).
3. Move entries from **Unreleased** to a new version section with the current date.
4. Tag the release in Git (`vX.Y.Z`) and push tags.
5. Publish to npm (via CI/CD or `npm publish`).

> Tip: Use Conventional Commits in PR titles/bodies to make changelog updates easier.

---

[Unreleased]: https://github.com/Plasius-LTD/storage/compare/v1.2.1...HEAD

## [1.0.0] - 2026-02-11

- **Added**
  - Initial release.

- **Changed**
  - (placeholder)

- **Fixed**
  - (placeholder)

- **Security**
  - (placeholder)
[1.0.0]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.0
[1.0.1]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.1
[1.0.2]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.2
[1.0.3]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.3
[1.0.4]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.4
[1.0.5]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.5
[1.0.9]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.9
[1.0.10]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.10
[1.0.11]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.11
[1.0.12]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.12
[1.0.13]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.13
[1.0.14]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.14
[1.0.16]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.16
[1.0.17]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.17
[1.0.18]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.18
[1.0.19]: https://github.com/Plasius-LTD/storage/releases/tag/v1.0.19
[1.1.0]: https://github.com/Plasius-LTD/storage/releases/tag/v1.1.0
[1.2.0]: https://github.com/Plasius-LTD/storage/releases/tag/v1.2.0
[1.2.1]: https://github.com/Plasius-LTD/storage/releases/tag/v1.2.1
