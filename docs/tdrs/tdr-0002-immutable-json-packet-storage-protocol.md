# TDR-0002: Immutable JSON Packet Storage Protocol

- Date: 2026-07-18
- Status: Accepted
- Package entry point: `@plasius/storage/immutable-json-packets`
- Tracked work: [Storage Task #34](https://github.com/Plasius-LTD/storage/issues/34)
- Rollout flag context: `feedback.reporting.enabled`

## Purpose

This record defines the server-side protocol for storing privacy-safe,
schema-validated JSON packets and coordinating bounded materialisation jobs. A
successful write proves that exact canonical bytes exist at the fixed packet
identity. It does not prove that upstream PII elimination was perfect, grant
report access, or make the Blob public.

## Fixed Layout

For a configured packet kind with prefix `{prefix}`, the package owns:

| Record | Fixed path |
| --- | --- |
| Packet | `{prefix}/packets/{packetId}.json` |
| Replay manifest | `{prefix}/manifests/{manifestId}.json` |
| Dead letter | `{prefix}/dead-letters/{deadLetterId}.json` |
| Checkpoint | `{prefix}/control/checkpoints/{name}.json` |
| Lease sentinel | `{prefix}/control/leases/{name}.json` |

Prefixes contain two to six lowercase allowlisted path segments, are
non-overlapping, and are fixed when the store is created. Record IDs are
bounded safe segments. Callers cannot supply a Blob path, URL, query, container
name, or arbitrary prefix.

## Schema and Privacy Admission

Packet and checkpoint schemas implement the structural `@plasius/schema`
validation and PII-audit surface. Registration requires an immutable schema
identity and an empty PII audit.

Values are copied into plain canonical JSON before and after schema validation.
The copy accepts only null, booleans, finite numbers, bounded strings, dense
arrays, and plain objects with enumerable data properties. It rejects
accessors, symbols, custom prototypes, cycles, prototype-control keys, and
excessive nesting or member counts. Object keys must be bounded machine-field
identifiers; control-bearing, email-like, URL-like, sensitive, and arbitrary
content-shaped dynamic keys are rejected. Array length and the remaining
member budget are checked before key enumeration, density validation, or
output allocation.

The final storage guard denies fields associated with narrative, identity,
account correlation, network/browser data, attachments, screenshots, raw
content, URLs, locale, or client timestamps. It also denies high-confidence
email and URL string patterns. These checks are defence in depth.
Context-sensitive phone, address, credential, government-ID, and similar
recognition belongs in the upstream transient scanner, where machine IDs and
canonical UTC timestamps can be distinguished safely. Registered packet
schemas must still restrict strings to closed, bounded machine identifiers;
this API does not claim automatic free-text PII detection.

## Canonical Record and Integrity

Every stored object is a canonical JSON envelope terminated by one newline. It
contains the protocol schema, record type, packet kind, safe record ID, schema
identity, and the schema-validated payload or fixed coordination metadata.
Object keys are sorted recursively by the safe snapshot.

The service computes lowercase SHA-256 and exact UTF-8 byte length. Blob
metadata binds:

- protocol schema;
- record type;
- packet kind;
- record ID;
- registered schema ID and version;
- byte length; and
- SHA-256.

Reads require exact kind and ID, download no more than the configured bound,
verify content type, ETag, canonical bytes, digest, and complete protocol
metadata, then revalidate the payload schema. Receipts omit paths, URLs, values,
and provider diagnostics. ETags obtained from the provider must be bounded
printable values and cannot be wildcard conditions.

## Immutable Write Protocol

Packets, manifests, dead letters, and lease sentinels use
`If-None-Match: *`. A successful response must include an ETag. On a
conditional collision, the package performs one bounded exact read. Identical
bytes and metadata are an idempotent replay; any difference is an immutable
conflict. Collision reconciliation is entered only for `BlobAlreadyExists`,
`ConditionNotMet`, or HTTP 412. An unrelated HTTP 409 is a storage dependency
failure. The package performs no hidden retries.

## Checkpoint Protocol

Checkpoint creation uses `If-None-Match: *`. Subsequent updates require the
exact previously read ETag via `If-Match`. A failed condition triggers one
bounded read:

- exact canonical equality is an idempotent uncertain-acknowledgement replay;
- different bytes are a checkpoint conflict.

Processors must not advance an output checkpoint until immutable output
packets or reports exist. Revision/window rules remain in the processor's
registered checkpoint schema.

## Lease Protocol

The package creates or exactly replays a fixed lease-sentinel object, then
acquires an Azure Blob lease for 15–60 seconds. The returned handle captures
the lease client and exposes only `renew()` and `release()`. It never exposes
the lease token. Each operation has its own abort signal and deadline.
Lease conflicts are classified only from the provider's specific lease error
codes, separately from Blob conditional-write conflicts. Concurrent release
calls share one release operation; a missing/lost prior lease makes release
idempotently complete, including after an uncertain acknowledgement. Renewal
reports a conservative expiry calculated from the renewal request start, not
from the later response time.

Each release caller retains its own abort signal and deadline while observing
the shared provider operation. A caller timeout does not cancel or clear that
provider single-flight. Immediate retries observe the same in-flight result
under their own deadline and cannot launch an overlapping release. The
provider call has a separate bounded abort budget derived from the configured
default and initiating caller timeout.

Leases are advisory coordination; checkpoint CAS and immutable output IDs
remain the correctness boundary if a worker pauses or loses its lease.

## Manifest and Dead-Letter Protocol

Replay manifests contain:

- canonical UTC start/end timestamps;
- a non-negative revision; and
- a bounded, sorted, duplicate-free list of packet ID, SHA-256, and byte
  length.

Dead letters contain only:

- packet ID;
- an error code from the kind's startup allowlist;
- canonical timestamp generated by this package's server clock;
- attempt number from 1 to 100; and
- retryability.

There is no message, exception, stack, raw provider code, packet payload,
account correlation, URL, or extensible metadata field.
Callers cannot author the timestamp. A retry of the same dead-letter ID and
logical facts reuses the first immutable timestamp even when the clock has
advanced.

## Failure and Observability Contract

Errors use fixed codes for invalid configuration/input, schema rejection,
privacy rejection, limits, immutable/checkpoint/lease conflicts, not found,
corruption, abort/deadline, and dependency failure. Underlying causes are
replaced by a redacted marker.

The package intentionally accepts no logger. Hosts may count safe error codes,
operation names, packet kinds, elapsed-time bands, and retry classifications.
They must not log inputs, Blob paths, IDs, ETags, lease tokens, response bodies,
provider messages, or receipt contents.

## Deployment and Retention

Hosts must use private containers, managed identity, least-privilege custom
roles, private endpoints, and approved CMK configuration. Public and anonymous
Blob access must remain disabled.

Lifecycle rules, versioning, soft delete, and backups must be configured so
the total retained lifetime meets the owning product policy. This package has
no delete, list, credential-construction, public URL, or lifecycle-policy API.

## Validation Obligations

Release validation covers:

- schema rejection and PII-audit failure;
- malformed, cyclic, accessor-backed, sensitive, and oversized values;
- hostile object keys and pre-enumeration sparse-array length bounds;
- conditional create replay and immutable conflicts;
- corrupt bytes and metadata;
- bounded ETag create/update/replay/conflict races and unrelated 409 failures;
- bounded manifest and dead-letter inputs;
- lease duration, contention, conservative renewal, concurrent/uncertain
  release, and token encapsulation;
- abort, deadline, missing ETag, not-found, and dependency failures;
- error and receipt redaction;
- Node-only ESM/CJS/type exports and browser-resolution denial; and
- changed-source LCOV presence with at least 80% coverage.

## Related Documents

- [ADR-0004: Immutable Schema-Backed JSON Packet Storage](../adrs/adr-0004-immutable-schema-backed-json-packet-storage.md)
- [Security Policy](../../SECURITY.md)
