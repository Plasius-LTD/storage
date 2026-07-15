# TDR-0001: Immutable Asset Storage Protocol

- Date: 2026-07-13
- Status: Accepted
- Package entry point: `@plasius/storage/immutable-assets`
- Tracked work: [Storage Task #27](https://github.com/Plasius-LTD/storage/issues/27)
- Feature flag context: `asset.pipeline.shader-store.enabled`
- Style-selection capability context: `gpu.shader.style.select`

## Purpose

This record defines the server-side storage protocol used by model storage to
write, verify, and read exact immutable asset versions. It covers Blob
mechanics only. A successful operation means that a complete set of declared
bytes exists under an immutable root and has been verified; it does not mean
the version is admitted, promoted, authorized, or visible in a catalog.

## Ownership Boundary

| Component | Owns | Does not own |
| --- | --- | --- |
| `@plasius/storage/immutable-assets` | Path construction, structural Blob ports, conditional creation, service-computed integrity metadata, manifest-last completion, full stored-byte verification, marker-first exact reads, typed storage diagnostics | Credentials, authentication, authorization, catalog rows, channel CAS, shader/model validation, feature flags, capabilities, public URL generation |
| Model-storage host | Private intake/runtime container selection, credentials or managed identity, request deadlines, retry orchestration, admission-to-storage coordination | Replacing exact immutable bytes in place |
| `@plasius/asset-processing` | Shader and model admission, generated-contract verification, evidence validation | Blob implementation and catalog mutation |
| `@plasius/asset-pipeline` | Deterministic promotion, requalification, and rollback preconditions | Blob writes, catalog effects, auth |
| Site catalog service | Auth, feature/capability evaluation, catalog/channel compare-and-swap, discovery, runtime delivery, audit, retention policy | WGSL reflection and low-level Blob protocol |

`asset.pipeline.shader-store.enabled` gates site-owned public candidate
submission and runtime discovery/loading/activation. Separately authorized
private intake and rollback preparation may operate while that flag is off,
but this package never evaluates or overrides the flag. Likewise,
`gpu.shader.style.select` governs user-visible style discovery and selection;
it grants no Blob, promotion, or rollback authority and is not required for
default-profile rendering.

## Structural Blob Ports

The subpath is Node-only and accepts injected, minimal container/blob
interfaces rather than constructing an Azure SDK client. Production adapters
may wrap Azure Blob clients; deterministic tests may supply in-memory ports.
The port surface must retain the storage invariants needed by the protocol:

- create a block blob with `If-None-Match: *`, HTTP headers, metadata, and an
  abort signal;
- download exact bytes together with length, content type, metadata, ETag, and
  other properties required for verification.

The API does not accept connection strings, account keys, credential-bearing
URLs, SAS tokens, or an unconstrained callback that can reinterpret paths.

The public operations are:

- `createImmutableAssetVersion(container, input, options?)`;
- `verifyImmutableAssetVersion(container, identity, options?)`;
- `readImmutableAssetVersionFile(container, identity, relativePath, options?)`;
  and
- `createImmutableAssetStore(config)`.

The configured store binds private intake and runtime ports. Its
`stageVersion` method writes to intake and its `publishVersion` method writes to
runtime. `verifyVersion` and `readVersionFile` require the caller to select a
scope explicitly. The structural `BlobContainerPort` and
`BlockBlobClientPort` contracts preserve dependency injection without adding a
runtime Azure Blob SDK dependency to this package.

## Identity and Layout

An immutable identity consists of a supported asset kind, an asset ID, and an
exact version. IDs and versions are validated as individual path segments;
relative payload paths are validated separately. Separators, dot segments,
empty segments, control characters, backslashes, encoded traversal, query or
fragment syntax, absolute paths, and reserved marker paths fail closed.

| Kind | Root |
| --- | --- |
| `model` | `models/{id}/versions/{version}` |
| `gpu-interface` | `gpu-interfaces/{id}/versions/{version}` |
| `shader` | `shaders/{id}/versions/{version}` |
| `shader-style-profile` | `shader-style-profiles/{id}/versions/{version}` |
| `shader-validation-evidence` | `shader-evidence/{id}/versions/{version}` |

The completion marker is always
`{root}/_plasius/version-manifest.json`. No caller-supplied file may use that
relative path. Paths are case-sensitive printable-ASCII POSIX relative paths
and must be unique. The complete Blob name is capped at Azure's 1024-character
limit.

One version is limited to 513 files total: exactly one marker plus at most 512
payload files. Sparse file collections, duplicate paths, and larger packages
are rejected before hashing or storage I/O.

## Integrity Representation

For each payload and the marker, the service computes:

- lowercase hexadecimal SHA-256 over the exact stored bytes;
- exact byte length;
- an allowlisted, normalized content type;
- immutable identity and relative-path metadata sufficient to detect replay at
  a different logical location.

JSON uses a safe JSON media type, WGSL uses its allowlisted text media type,
and opaque fixture data uses a bounded safe binary type. Content type is
metadata, not a substitute for admission or parsing. Caller-supplied digests,
lengths, or integrity metadata may be checked as expectations, but they cannot
override regenerated values.

Digest equality alone is insufficient for idempotency. Exact stored bytes,
length, content type, and all protocol-owned metadata must agree.

## Write and Verification Protocol

### Preflight

Before the first effect:

1. validate the supported kind, ID, and exact version;
2. validate and normalize every relative path;
3. reject the reserved marker path, duplicates, sparse input, and more than 512
   payloads;
4. enforce configured byte, path-length, and metadata budgets;
5. normalize an allowlisted content type for every file;
6. compute payload bytes, lengths, and lowercase SHA-256 values;
7. deterministically construct the service-owned version manifest bytes.

### Conditional payload creation

Each payload is created with `If-None-Match: *`. A successful create requires a
returned ETag as write confirmation. If the condition fails because a
blob exists, the implementation downloads that exact blob and compares the
whole representation. An exact match is an idempotent replay. Any different
byte, length, digest, content type, identity metadata, or missing property is a
typed immutable-version conflict.

Create work runs with bounded concurrency and respects a caller-provided
abort/deadline. The package does not start unbounded work and does not perform
hidden retry loops. The host may retry a typed transient result under its own
deadline; exact replay remains safe.

### Manifest-last completion

Only after every payload has been created or proven as an exact replay does the
implementation conditionally create `_plasius/version-manifest.json`. An
existing marker is accepted only when its downloaded bytes and complete
metadata exactly match the generated marker.

The marker is a discoverability boundary, not sufficient evidence by itself.
After marker creation/replay, the implementation performs a bounded final read
of the marker and every declared payload from storage. It verifies path
membership, bytes, byte length, SHA-256, content type, identity metadata, and
the marker's complete declaration. Only then may it return a verified receipt.

The receipt contains immutable identities, digests, counts, and bounded
diagnostic/correlation data. It contains no Blob URL, SAS token, credential,
or authority to update the catalog. The coordinator revalidates it as required
before a separate compare-and-swap pointer operation.

## Marker-First Read Protocol

A read accepts only:

- a supported immutable kind, ID, and exact version; and
- one normalized relative path expected to be declared by that version.

The implementation first downloads and verifies the fixed version marker. A
missing, malformed, oversized, or integrity-invalid marker means the version is
not readable. It then verifies that the requested path appears exactly once in
the marker, downloads that payload, and verifies its bytes, length, digest,
content type, and protocol-owned metadata before returning bytes.

Mutable channel names, aliases such as `latest`, undeclared relative paths,
absolute blob names, and arbitrary Blob/SAS URLs are rejected. A caller cannot
use this API as a generic object-store proxy.

## Failure, Retention, and Rollback

Failures are typed and distinguish at least invalid input/path, package limit,
conditional conflict, integrity mismatch, incomplete version, timeout/abort,
storage unavailable, and undeclared reads. Public details use bounded reason
codes and safe identifiers, never payload contents, credentials, SAS query
strings, or full provider error bodies.

Before the marker exists, an aborted write is unreachable through marker-first
reads and cannot be catalog-promoted by a conforming coordinator. The write API
never deletes payloads or markers: once a conditional payload create is
acknowledged, another writer may adopt it before this attempt can safely prove
otherwise. Unreachable partial data remains invisible and is a candidate for a
separately authorized host lifecycle process only after that process proves the
version incomplete and unreferenced. Storage does not roll back a catalog.
Product rollback is a site-owned compare-and-swap from one promoted pointer to
a previously verified immutable version. No rollback path mutates immutable
bytes.

## Security Controls

- Use private containers and least-privilege managed identities; separate
  intake writers from runtime readers where deployment boundaries permit.
- Treat manifest and payload bytes as untrusted data until upstream admission
  and domain validation are complete.
- Reject traversal, reserved names, and arbitrary URLs before Blob access.
- Use conditional writes and marker-bound verification to close overwrite and
  replacement races; keep delete authority out of this API.
- Enforce the 513-file ceiling and bounded byte/path/metadata budgets before
  allocation, hashing, or fan-out.
- Bound concurrency, response sizes, provider error translation, deadlines,
  and cancellation.
- Never log bytes, credentials, connection strings, SAS tokens, signed URLs,
  private model metadata, or WGSL source.

SHA-256 provides integrity identity; it does not authenticate a caller or prove
shader compatibility. Those controls remain mandatory in the host.

## Observability

The host should attach a non-secret correlation ID and record structured
events for preflight rejection, create, exact replay, conflict, marker commit,
final verification, read verification, abort, and retained partial candidates.
Recommended fields are operation, asset kind, bounded asset/version hashes,
file count, aggregate byte count, result code, elapsed time, retry classification,
and container role (`intake` or `runtime`).

Do not record payload names when they contain private domain data. Never record
payload bytes, manifest contents, Blob URLs, authorization headers, SAS query
parameters, account names, connection strings, or raw provider responses.

Metrics should distinguish attempted, verified, conflicted, aborted, and
retention-pending partial versions. A successful payload upload count must never be
reported as a successful publication; only complete final verification earns
that result.

## Test Obligations

Tests cover:

- every kind-to-root mapping and marker path;
- conditional creation and manifest-last ordering;
- exact idempotent replay and conflicts for bytes, lengths, content types, and
  metadata;
- full post-write re-read and corruption detection;
- marker-first reads, traversal, reserved marker, undeclared file, URL, and
  mutable-alias rejection;
- JSON, WGSL, and opaque binary media types;
- the 512-payload/513-total boundary, sparse inputs, and oversized input;
- bounded concurrency, deadlines, cancellation, and provider failures;
- adopted-payload races, ambiguous marker completion, retained partials, and
  preservation of complete or pre-existing versions;
- receipts and diagnostics containing neither URLs nor secrets.

Package typecheck, tests, coverage, lint, build, dependency audit, and installed
tarball/export checks remain release gates. Passing these tests does not claim
shader admission, catalog promotion, runtime authorization, feature rollout,
or physical WebGPU qualification.

## Related Documents

- [ADR-0003: Immutable Asset Version Storage](../adrs/adr-0003-immutable-asset-version-storage.md)
- [WGSL Shader Compatibility Design](https://github.com/Plasius-LTD/plasius-ltd-site/blob/main/docs/Design/wgsl-shader-compatibility-and-style-framework.md)
- [WGSL Shader Compatibility Feature #1026](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1026)
- [Physical WebGPU Fleet Task #1513](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1513)
