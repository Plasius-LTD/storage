# Security Policy

## Supported Versions

We currently support the latest major version of this project. Older versions may not receive security updates.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately by emailing us at [security@plasius.co.uk](mailto:security@plasius.co.uk). Please do not create a public issue for security-related matters.

## Response Timeline

We aim to acknowledge your report within 2 business days and to provide a more detailed response (including next steps and, if applicable, a timeline for a fix) within 7 business days.

## Disclosure Policy

We request that you give us the opportunity to address the vulnerability before publicly disclosing it. We will coordinate with you on public disclosure once a fix is available and deployed.

## Immutable Asset Storage Security Boundary

`@plasius/storage/immutable-assets` is a server-only Blob protocol. It is not a
browser API, generic Blob proxy, catalog authority, shader validator, or
authentication layer. Hosts must inject private intake/runtime container ports
backed by least-privilege credentials or managed identities. Do not put account
keys, connection strings, SAS tokens, signed URLs, or credentials into asset
manifests, receipts, diagnostics, logs, or client bundles.

The package accepts only a supported immutable asset identity and validated
manifest-declared relative paths. It rejects absolute paths, traversal,
reserved marker paths, mutable channel aliases, undeclared files, and arbitrary
Blob or SAS URLs. Runtime delivery must resolve a promoted catalog reference
through the authorized model-storage service; it must not expose a storage URL
as a bypass.

Integrity controls are fail-closed:

- payloads and `_plasius/version-manifest.json` use `If-None-Match: *`;
- lowercase SHA-256, exact byte length, and safe content type are computed by
  the service rather than trusted from callers;
- an existing object is an idempotent replay only when its complete bytes and
  protocol-owned metadata match;
- the manifest is written last, then the manifest and every declared payload
  are re-read and verified;
- reads verify the marker before resolving and verifying a declared payload;
- the write API has no delete authority, so it cannot remove payloads already
  adopted by a concurrent completion marker.

These integrity checks do not authenticate a caller, validate WGSL, prove ABI
compatibility, establish qualification evidence, or promote a version. The
calling service must still enforce authentication, authorization, tenant
isolation, domain schemas, shader/model compatibility, catalog compare-and-swap,
and audit policy. The site-owned feature flag
`asset.pipeline.shader-store.enabled` and capability
`gpu.shader.style.select` remain separate controls and confer no direct Blob
authority.

## Immutable JSON Packet Security Boundary

`@plasius/storage/immutable-json-packets` is a Node-only, schema-backed
structured storage protocol. It is not an HTTP body parser, free-text PII
detector, generic Blob proxy, abuse-correlation store, analytics identity
store, or browser API.

Hosts register fixed, non-overlapping packet-kind prefixes and
`@plasius/schema`-compatible schemas. Registration fails when a schema reports
PII fields. Writes accept structured values only and apply safe plain-JSON
snapshotting, privacy field/value guards, schema validation, canonical
encoding, byte limits, conditional creation, and SHA-256 metadata. Do not add a
raw JSON/body/byte upload escape hatch.

Object keys are restricted to bounded machine-field identifiers and receive
control, email/URL, and sensitive-name screening. Array member limits are
enforced before key enumeration or proportional allocation. Only exact Blob
precondition/already-exists signals enter immutable or checkpoint
reconciliation; lease conflicts use their own exact provider-code classifier.
Provider-returned ETags are bounded before receipts, reads, or
compare-and-swap.

The following content is outside this API contract and must be discarded or
kept in its separately authorised control plane before storage:

- narrative, rich-text ASTs, summaries, quotes, embeddings, and model traces;
- account IDs, authentication subjects, pseudonyms, cookies, sessions, IP
  addresses, user agents, URLs/referrers, locale, and client timestamps;
- screenshots, pixels, attachments, filenames, DOM data, and exact device
  fingerprints; and
- credentials, tokens, connection strings, SAS URLs, provider errors, or raw
  request metadata.

Checkpoint values use their own PII-free schema and exact ETag
compare-and-swap. Processor leases are limited to 15–60 seconds and keep their
lease token inside an opaque handle. Concurrent lease releases coalesce,
already-lost leases complete idempotently, and renewal expiry is conservative.
Caller cancellation only bounds that caller's observation of a release; the
separately bounded provider call stays single-flight until settlement so a
deadline retry cannot overlap it. Replay manifests and dead letters have fixed
metadata shapes; they cannot carry arbitrary messages or exception details.
Dead-letter timestamps come only from the injected server clock, never the
caller.

Storage errors contain fixed reason codes and replace every dependency cause
with a redacted marker. The package accepts no logger and does not put packet
values, Blob names, record IDs, ETags, lease tokens, provider messages, URLs, or
credentials into diagnostics.

These controls are defence in depth. Empty PII annotations and deterministic
patterns cannot prove arbitrary prose safe. Packet schemas must use closed
enums and bounded machine identifiers, while the upstream privacy scanner must
eliminate and discard narrative before calling this package.

## Operational Hardening

- Keep intake and runtime containers private. Prefer separate managed
  identities so intake can create candidates while runtime can only read
  promoted exact versions through the model-storage service.
- Deny public container access and account-key authentication where the Azure
  deployment supports managed identities and role assignments.
- Enforce the package ceiling of 513 files total (one marker plus at most 512
  payloads), along with configured byte, path, metadata, response, and duration
  budgets.
- Bound Blob concurrency and supply an abort signal/deadline for every
  operation. Keep retry policy bounded and outside the package so the host can
  honor request and incident budgets.
- Treat all manifest, JSON, WGSL, and opaque fixture bytes as untrusted until
  their owning admission and domain validators accept them. Content type is not
  validation.
- Record bounded structured reason codes and correlation IDs. Do not record
  payload bytes, manifest bodies, WGSL source, private model metadata, raw Azure
  responses, account names, authorization headers, URLs, or query strings.
- Alert on integrity mismatch, immutable conflict, repeated abort/timeout,
  incomplete-marker reads, retained-partial growth, and attempts to use
  undeclared paths or URLs.
- Keep JSON packet content, processor reports, and abuse/eligibility controls
  in their documented separate private boundaries. Never join control-plane
  pseudonyms into packets, manifests, checkpoints, Admin output, or MCP output.
- Configure Blob lifecycle, versioning, soft-delete, and backup windows so
  total retained lifetime satisfies the owning product policy. This package
  deliberately has no delete or lifecycle-policy authority.
- Use retention/lifecycle rules for unreachable partial candidates only after
  confirming they are not complete or catalog-referenced. Never implement
  product rollback by overwriting or deleting a published immutable version.

If credentials or a signed URL are exposed, treat the event as a blocking
incident: revoke/rotate the credential, inspect Blob and catalog audit history,
invalidate affected access paths, and verify every referenced immutable version
before restoring service.
