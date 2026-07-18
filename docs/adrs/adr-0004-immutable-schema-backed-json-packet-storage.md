# ADR-0004: Immutable Schema-Backed JSON Packet Storage

- Date: 2026-07-18
- Status: Accepted
- Tracked work: [Storage Task #34](https://github.com/Plasius-LTD/storage/issues/34)
- Parent story: [Feedback Reporting Story #1667](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1667)
- Rollout flag context: `feedback.reporting.enabled`

## Context

Feedback intake and scheduled intelligence need to persist identifier-free,
structured JSON packets in private Blob Storage. The storage boundary must not
become a generic Blob proxy or accept request bodies, narrative, screenshots,
account subjects, pseudonyms, network identifiers, or provider error text.

The processors also need safe coordination primitives. Immutable packets must
survive idempotent retries, checkpoints must use compare-and-swap, concurrent
processors need bounded leases, and replay manifests and dead-letter records
must contain only safe, fixed metadata.

Azure Blob Storage provides conditional writes, ETags, and leases, but those
primitives do not provide schema admission, canonical JSON, privacy-aware
diagnostics, or fixed path ownership by themselves.

## Decision

Add the explicitly Node-only
`@plasius/storage/immutable-json-packets` entry point.

The host constructs one store with:

- a structural private Blob container port;
- a fixed, non-overlapping prefix for every registered packet kind;
- an `@plasius/schema`-compatible packet schema and optional checkpoint schema;
- a closed allowlist of dead-letter reason codes; and
- byte, read, manifest-entry, and operation-deadline bounds.

The entry point accepts structured values only. It exposes no method that
accepts a raw body, JSON string, byte buffer, Blob name, URL, connection string,
credential, or log callback.

Before a packet or checkpoint reaches Blob Storage, the implementation:

1. snapshots plain JSON without invoking getters, `toJSON`, or custom
   prototypes;
2. rejects cycles, sparse/extended arrays, symbols, non-finite numbers,
   excessive depth/member/string bounds, prototype-control keys, and unsafe
   content-shaped object keys, checking array budgets before enumeration or
   allocation;
3. rejects schemas whose PII audit is non-empty;
4. rejects narrative, identity, network, browser, attachment, URL, and other
   prohibited field names, plus high-confidence email and URL string patterns;
5. validates the snapshot with the registered schema and repeats the safe JSON
   snapshot over the schema output; and
6. canonically encodes and hashes a protocol-owned envelope.

The privacy checks are a final defence, not a substitute for the upstream
transient PII-elimination pipeline. Packet schemas must use closed enums,
bounded identifiers, numbers, booleans, and other structured facts. Automatic
pattern checks cannot prove that arbitrary free text contains no personal
data, so unbounded user text is outside this API contract.

Packet, manifest, dead-letter, and lease-sentinel records use
`If-None-Match: *`. A collision is an idempotent replay only when the complete
canonical bytes and all protocol metadata match. Otherwise it is a typed
immutable conflict. Receipts contain kind, safe record ID, schema identity,
SHA-256, byte length, ETag, and replay status; they contain no Blob path, URL,
credential, packet value, or storage-provider detail. Only precise Blob
already-exists/precondition responses are collision signals, and every
provider-returned ETag is bounded before use.

Checkpoint writes use either `If-None-Match: *` or the caller's exact expected
ETag. An uncertain retry is accepted only if the current canonical bytes and
metadata exactly match. A different winner produces a typed checkpoint
conflict. Processor leases use a fixed sentinel path, Azure's lease port, a
15–60 second duration, and an opaque handle that never exposes the lease token.
Lease errors have a separate exact classifier; release coalesces concurrent
calls and converges after uncertain acknowledgements. Caller timeouts bound
only their observation of the shared, separately bounded provider release, so
an immediate retry cannot overlap it. Renewal expiry is measured
conservatively from request start.

Replay manifests contain only a UTC window, revision, and bounded packet
ID/digest/length records. Dead letters contain only a packet ID, allowlisted
safe error code, package-generated canonical server timestamp, bounded attempt
count, and retryability. They cannot contain caller-authored timestamps,
messages, stack traces, provider responses, or arbitrary metadata. Retries of
the same dead-letter ID and logical facts replay the first timestamped record.

All errors expose fixed diagnostics. Underlying causes are replaced with
`{ redacted: true }`; packet values, record IDs, Blob names, and provider
messages are not copied into diagnostics.

## Ownership Boundary

This package owns conditional Blob mechanics, canonical representation,
integrity metadata, exact replay, checkpoint CAS, bounded lease handling, and
safe storage diagnostics.

The host continues to own:

- authentication, authorization, capability and feature-flag evaluation;
- creation of server-owned packet IDs, packet timestamps, and processor
  windows; dead-letter timestamps are owned by this package;
- narrative decryption, PII elimination, classification, and immediate
  disposal before calling this package;
- private endpoints, managed identity, CMKs, RBAC, WAF, and telemetry policy;
- container selection and UK-region deployment;
- lifecycle, soft-delete, versioning, and backup retention configuration;
- processor discovery, bounded retry, alerting, and release correlation; and
- proving that registered schemas contain only closed, identifier-free facts.

`feedback.reporting.enabled` is evaluated by the host. The storage package does
not evaluate or override rollout controls.

## Alternatives Considered

### Accept arbitrary JSON strings or bytes

Rejected. It would allow callers to bypass schema validation, safe snapshotting,
privacy field guards, canonical encoding, and byte accounting.

### Accept a Blob prefix or path on every call

Rejected. It would turn the entry point into a generic storage proxy and permit
cross-boundary reads or writes. Prefixes are fixed once at store construction.

### Put account correlation in packet metadata

Rejected. Abuse and eligibility correlation belongs in a separately
authorised, short-lived control plane. Blob packets and receipts remain
identifier-free.

### Overwrite checkpoints without ETags

Rejected. Last-writer-wins updates can silently skip or regress processor
windows. Exact ETag compare-and-swap makes races visible and replay-safe.

### Return lease IDs or Blob URLs

Rejected. Both are capability-bearing values that callers might log, expose,
or pass outside the authorised service boundary.

## Consequences

- Immutable packet creation is retry-safe and detects conflicting reuse of a
  packet ID.
- Processors can coordinate with bounded leases and ETag checkpoints without
  unbounded lock ownership.
- Canonical re-reads and integrity metadata add Blob I/O but detect corruption
  and ambiguous acknowledgements.
- Schema registration fails closed when PII annotations are present.
- Strict privacy guards may reject a structured value that resembles sensitive
  data; schema authors should use closed identifiers and operators should treat
  rejection as a structured-only fallback, never as permission to bypass the
  boundary.
- Lifecycle deletion and backup erasure remain deployment responsibilities;
  the write API intentionally has no delete or public-access authority.

## References

- [TDR-0002: Immutable JSON Packet Storage Protocol](../tdrs/tdr-0002-immutable-json-packet-storage-protocol.md)
- [ADR-0003: Immutable Asset Version Storage](./adr-0003-immutable-asset-version-storage.md)
