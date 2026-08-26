# ADR-0006: Path-Only Private-Artifact Prevention Gates

- Date: 2026-07-15
- Status: Accepted

## Context

The public `@plasius/storage` source repository and npm package must not contain
signed contributor agreements, acceptance registries, tabular personal-data
exports, or similarly marked private registries. `.gitignore` cannot reject an
already tracked path, and broad npm `files` entries can expose new artifacts as
the repository evolves.

The prevention control must not increase exposure while checking a candidate.
It therefore cannot open, hash, copy, diff, or log a suspected artifact's
contents.

## Decision

Contributor agreements and acceptance records are stored only in an approved,
access-controlled system outside source control.

The repository provides a zero-dependency Node.js path policy with these
enforcement boundaries:

1. `privacy:check` inspects only working-tree and Git-index path metadata. The
   union is intentional: a tracked path deleted only from the working tree
   continues to fail until its deletion is staged in the proposed commit.
2. The policy rejects every `.csv` extension case-insensitively, CLA or
   contributor registries with any extension, signed-CLA storage paths,
   contributor acceptance/signature/submission record aliases, signed
   contributor agreement aliases, and paths that combine a privacy marker with
   a registry marker. The semantic matcher covers hierarchical and
   separator-free terms. Direct aliases are also classified through an ASCII
   case-folded representation independent of camel-case transitions, and both
   singular and plural CLA boundaries recognise every protected concatenated
   suffix family. A closed semantic vocabulary segments recognised archive,
   backup, record, storage, documentation, and version wrappers before direct
   aliases and around registry marker pairs; arbitrary substring prefixes do
   not qualify. Unicode NFKC normalization runs before structural path handling
   so compatibility separators, Windows and POSIX separators, and the optional
   npm `package/` prefix reduce to one representation. Explicit
   process, template, policy, schema, and validator files remain public, but a
   matching component used as a directory fails closed. A separate
   classification copy removes Windows-ignored trailing dots and spaces from
   every component and structurally normalizes the result; raw package-member
   identity remains unchanged for exact allowlist and collision enforcement.
3. `package.json.files` must be a non-empty explicit allowlist. Repository-root,
   wildcard, and complete `legal` directory entries are forbidden; only the
   exact public CLA Markdown documents are included.
4. `pack:check` first repeats the repository policy, then applies the same
   private-path rules and an exact public-path allowlist to the final manifest
   produced by `npm pack --json --ignore-scripts`. Raw package-member identities
   and cardinality remain alongside normalized forms so compatibility aliases
   and duplicates cannot collapse into the allowlist. The temporary tarball and
   npm cache are removed in a `finally` block.
5. Every package directory requested through the public-artifact verifier has
   its npm inventory classified by the shared rules even when its source root is
   below an excluded cache or tool directory. Policy tests export built-in Node
   coverage to LCOV and combine it with runtime-package coverage so all gate
   executables remain represented in the release evidence.

The policy and tests use Node.js built-ins only. CI executes the repository gate
before dependency installation, then runs the policy tests and final package
gate. Release preparation checks the source state before editing release
metadata, and CD checks the prepared commit before dependency installation and
again through `pack:check` before publication. `prepublishOnly` retains the same
final package gate for local defense in depth.

Ignore rules reduce accidental additions, but they are not an enforcement
boundary. Feature flags and capabilities do not apply because this mandatory
privacy control must not be remotely bypassable.

## Alternatives Considered

- **Rely on `.gitignore` only**: rejected because ignored paths can already be
  tracked and ignore rules do not inspect the proposed commit or npm manifest.
- **Scan file contents**: rejected because reading or reporting suspected
  records increases exposure and heuristic content matching is incomplete.
- **Rely on a broad npm `files` allowlist**: rejected because a newly added file
  beneath an allowed directory would become public without an explicit package
  policy decision.
- **Check only the working tree**: rejected because an unstaged deletion would
  hide a path that remains in the Git index and proposed commit.

## Consequences

- Repository and package validation fail closed on protected paths without
  reading candidate contents or logging suspected path values. Policy
  rejections expose only category counts, while exceptional traversal and
  verifier failures collapse to allowlisted codes without raw messages or
  stacks.
- Public package surface changes require an intentional exact-allowlist update.
- New protected path categories require a policy and regression-test update.
- The targeted path rules complement rather than replace secret scanning,
  access controls, retention policy, and incident response.

## Related Decisions

- [ADR-0002: Public Repository Governance Baseline](./adr-0002-public-repo-governance.md)
- [ADR-0003: Immutable Asset Version Storage](./adr-0003-immutable-asset-version-storage.md)
