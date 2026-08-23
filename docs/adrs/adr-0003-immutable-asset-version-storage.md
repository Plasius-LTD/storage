# ADR-0003: Immutable Asset Version Storage

- Date: 2026-07-13
- Status: Accepted

## Context

The unified model and WGSL shader lifecycle publishes models, reflected GPU
interfaces, shader modules, rendering-style profiles, and qualification
evidence as independently versioned assets. A catalog entry must never expose
an incomplete upload, a mutable replacement at an existing version identity,
or bytes that differ from the manifest used during admission.

Azure Blob Storage supplies conditional object creation and object metadata,
but those primitives do not by themselves define when an asset version is
complete. The storage package also cannot become an authority for catalog
promotion, authorization, shader compatibility, or feature rollout. Those
decisions require domain context owned by the asset and site services.

## Decision

Add a server-only `@plasius/storage/immutable-assets` entry point. It accepts
injected structural Blob container ports and implements one narrow protocol:

1. Validate a kind, immutable identity, payload paths, byte lengths, content
   types, and package limits before writing.
2. Create every payload with `If-None-Match: *` semantics.
3. Compute lowercase SHA-256 digests, exact byte lengths, and safe content-type
   metadata inside the trusted service boundary.
4. Treat a conditional-create collision as idempotent only after downloading
   the existing blob and confirming its bytes, length, digest, content type,
   and integrity metadata are identical.
5. Create `_plasius/version-manifest.json` last, using the same conditional and
   exact-replay rules.
6. Re-read and digest-verify the marker and every manifest-declared payload
   before returning a verified result suitable for a separate catalog update.

The low-level operations are `createImmutableAssetVersion`,
`verifyImmutableAssetVersion`, and `readImmutableAssetVersionFile`.
`createImmutableAssetStore` binds distinct intake/runtime ports and exposes
scope-safe `stageVersion`, `publishVersion`, `verifyVersion`, and
`readVersionFile` methods without taking ownership of the clients.

The immutable roots are fixed by asset kind:

| Asset kind | Version root |
| --- | --- |
| Model | `models/{id}/versions/{version}` |
| GPU interface | `gpu-interfaces/{id}/versions/{version}` |
| WGSL shader | `shaders/{id}/versions/{version}` |
| Shader style profile | `shader-style-profiles/{id}/versions/{version}` |
| Qualification evidence | `shader-evidence/{id}/versions/{version}` |

A version contains at most 513 files in total: one version manifest and up to
512 manifest-declared payloads. The limit aligns storage admission with the
shader lifecycle package boundary.

Read operations start from a validated immutable identity, fetch and verify the
version marker first, and then allow only an exact relative path declared by
that marker. The API does not accept Blob URLs, SAS URLs, channel names,
`latest` aliases, or raw blob names.

Private intake and runtime containers are supplied by the host. The package
does not discover accounts, construct credentials, evaluate access policy, or
create public URLs. Callers own bounded deadlines and cancellation; the
implementation bounds concurrency and does not hide failures behind
unbounded/internal retry loops.

The following responsibilities deliberately remain outside this package:

- catalog rows, mutable channel pointers, and compare-and-swap promotion or
  rollback;
- request authentication, tenant authorization, and audit policy;
- feature-flag evaluation, including
  `asset.pipeline.shader-store.enabled`;
- capability evaluation, including `gpu.shader.style.select`;
- WGSL parsing/reflection, schema generation, ABI compatibility, model
  semantics, qualification-matrix validation, and admission policy.

## Alternatives Considered

### Overwrite a known version path

Rejected. An overwrite permits readers and evidence to observe different bytes
for the same identity and makes exact rollback non-reproducible.

### Publish the manifest first

Rejected. Marker-first readers could observe a declared file set while one or
more payloads were missing or corrupt.

### Accept caller digests and metadata as authoritative

Rejected. A caller-controlled integrity record can agree with itself while
describing different uploaded bytes. The service recomputes integrity values
and verifies stored bytes.

### Put catalog and shader policy in the storage package

Rejected. It would couple generic Blob mechanics to Cosmos state, site
authorization, WebGPU contracts, and rollout policy. The storage result is an
input to promotion; it is never proof that promotion occurred.

### Return direct or signed Blob URLs

Rejected. URL-based access bypasses marker-declared paths, makes credential
redaction harder, and expands the API into distribution and authorization.

## Consequences

- A marker-first reader cannot discover a partially uploaded version through
  this API.
- Concurrent writers converge only when the complete stored representation is
  identical; otherwise they receive a typed immutable-version conflict.
- Publication performs a complete final read, which adds I/O but closes the
  gap between upload acknowledgement and durable, digest-verified bytes.
- Failed attempts may leave unreachable payload blobs. The write API performs
  no deletion because a concurrent completion marker may already have adopted
  those payloads. Separately authorized host lifecycle retention may collect
  only candidates proven incomplete and unreferenced.
- Catalog rollback changes a pointer elsewhere. It never edits or deletes an
  immutable version.
- Hosts remain responsible for private containers, least-privilege managed
  identities, deadlines, retry policy, catalog authorization, and lifecycle
  retention of unreachable candidates.

## References

- [TDR-0001: Immutable Asset Storage Protocol](../tdrs/tdr-0001-immutable-asset-storage-protocol.md)
- [Storage Task #27](https://github.com/Plasius-LTD/storage/issues/27)
- [WGSL Shader Compatibility Feature #1026](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1026)
- [Unified Asset Lifecycle Epic #902](https://github.com/Plasius-LTD/plasius-ltd-site/issues/902)
