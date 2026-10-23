# ADR-0008: Reserve Index Capacity Before Packets

- Date: 2026-10-23
- Status: Accepted
- Task: [storage #55](https://github.com/Plasius-LTD/storage/issues/55)
- Parent Feature: [site #1661](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1661)
- Inherited host flag: `feedback.reporting.enabled`; capabilities: none.
- Supersedes ADR-0007's packet-first write order.

## Problem

Writing the packet before checking head capacity can create a durable packet
that a full accepted-time window can never publish. Read-only preflight is
insufficient: concurrent writers can both observe the final available slot.
Blob cannot transactionally create both packet and index head.

## Decision

1. Check an existing packet for exact byte/metadata equality before reserving.
   Only an explicit HTTP 404/`BlobNotFound` permits a new identity claim; an
   ambiguous legacy-packet lookup fails closed. Other window lookup behavior
   remains separately tracked by storage #56.
2. Create an immutable identity reservation at the configured index prefix's
   `reservations/<packetId>.json` path. Its existing index envelope holds one
   safe entry (ID, accepted time, schema, digest, byte length), with accepted
   time as deterministic observation time. No payload is copied. Create-only
   upload plus exact replay binds the ID across windows and competing payloads.
3. Append the same entry to the bounded window head using the existing CAS
   retry/deadline/cancellation protocol. Canonical encoded bytes and entry
   count must fit configured limits before CAS. Losing writers reread;
   exhausted capacity creates no packet. Existing exact entries retain their
   reservation even when the window is otherwise full.
   Identity and head uploads may commit before their response fails. All such
   provider ambiguities are retryable, including permanent-looking statuses;
   deterministic capacity or immutable-identity rejection remains terminal.
4. Upload the immutable packet only after its head entry is reserved. Return
   a receipt only after successful creation or verified exact replay. Ambiguous
   post-upload failures retain retryability, including permanent-looking
   provider responses. Immutable conflicts remain terminal.

An interrupted write leaves at most a safe identity claim and head reservation,
not a capacity-stranded packet. The host's durable outbox replays the identical
write until successful. Reading a reserved head with a missing packet fails
with fixed retryable `STORAGE_OPERATION_FAILED`; no partial result is returned.
Head snapshots remain stable on repair: no successful complete read was possible
before the missing packet became visible. Head discovery alone is never a
materialisation checkpoint. No scan, global lock or unbounded retry is added.

## Pending-index reconciliation (storage #57)

[Task #57](https://github.com/Plasius-LTD/storage/issues/57) extends the phase
classification across identity preparation, upload/replay and every head CAS
read/write. A permanent-looking provider response during this phase cannot
release the caller's outbox obligation: a reservation or packet may already
exist. Provider errors use fixed redacted retryable `STORAGE_OPERATION_FAILED`
diagnostics with `time-window-index` record type; general HTTP retry rules still
apply outside indexed writes.

When the initial exact-byte/metadata lookup confirms an existing durable packet,
every later index failure except `IMMUTABLE_CONFLICT` remains retryable. Preserve
capacity, corruption, abort and deadline codes so callers can distinguish the
required remediation. A fixed pending-reconciliation message replaces dependency
text. A missing packet still allows terminal deterministic capacity/corruption
rejection before packet upload. Actual identity collisions remain terminal in
both phases; no record is overwritten and no partial receipt is returned.

Here retryability means retain and reconcile the exact outbox item. Configuration,
capacity and corruption faults require remediation/operator escalation before a
bounded caller retry; they do not justify rapid retries, index deletion, payload
changes or an internal retry loop. This avoids a new queue or public error code,
keeps the existing eight-attempt CAS/deadline/cancellation bounds, and adds no
Blob calls. Abandoning confirmed durable packets on a terminal index diagnostic
or treating every pre-packet validation failure as transient was rejected.

Regression coverage includes legacy packet/head separation, 403/404/409/5xx
head reads/uploads, CAS reread failure, exact replay repair, capacity/corruption
remediation, cancellation/deadline, redaction and terminal identity conflicts.
The Task uses the same host flag, rollout/rollback, NFR and approved patch-release
qualification path below; it does not deploy or migrate site consumers.

## Alternatives

- Packet-first preflight without reservation loses races and is rejected.
- A lease alone can expire after packet creation and loses capacity protection.
- A separate overflow/reconciliation queue introduces a second discovery and
  retention protocol; the existing durable outbox already owns replay.
- A window reservation without an identity claim can poison a second window
  when concurrent writers reuse the same packet ID with different timestamps.
- Dropping missing entries would falsely report a complete window.

## Compatibility, rollout and recovery

Public types, immutable packet bytes, index schema, existing non-indexed kinds,
schema validation, managed-identity ports, leases and retention ownership stay
compatible. Old heads and packets remain readable; exact legacy replay rebuilds
a missing head. The new internal reservation path adds a storage operation and
an additional lookup, and must fall under host index-prefix permissions.
Failed writes can permanently bind an ID even before packet creation; callers
must never reinterpret an accepted packet's identity, payload or accepted time.

Pause indexed ingestion and disable reporting with the existing remotely
controlled host flag before draining old writers and deploying this protocol.
Do not mix packet-first and reservation-first writers. Restart retained outboxes
with the new version; enable reporting after full-window reads converge. Rollback
pauses indexed ingestion/materialisation and preserves reservations/outboxes;
it must not redeploy packet-first writers into active reserved windows.

Keep reservations until packet/window retention and outstanding replay
obligations expire together. Abandoned reservations require outbox/operator
reconciliation, never blind deletion or TTL while a delayed write may complete.
Previously stranded legacy packets are not automatically reconciled. Other
accepted-time completeness follow-ups remain separately tracked. Task #55
alone did not close storage #56 or #57 or the reporting Feature; Task #57's
phase classification is documented above and requires its own release evidence.

## Validation and release

Tests prove item and byte exhaustion creates no packet; concurrent final-slot
writers preserve capacity; cross-window identity races have one winner;
interruption, cancellation and response-after-commit ambiguity repair by replay;
legacy conflict does not publish a false reservation; full-capacity exact replay
does not duplicate entries; index records contain no payload and never scan.
Use total and changed-source LCOV gates, strict types, lint/build, audit,
privacy/package/export checks, installed ESM/CJS/declaration consumers, PR CI,
genuine exact-main CI, then existing `cd.yml`/`production` hosted OIDC and
registry integrity/provenance verification. No dependency or site rollout is
part of this package fix. Accessibility, SEO and browser UI checks are N/A for
the Node-only storage protocol. Existing fixed diagnostics expose pending-window
failures without provider text or packet material; operators monitor outbox age.
