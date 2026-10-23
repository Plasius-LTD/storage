# ADR-0007: CAS Time-Window Packet Indexes

- Date: 2026-08-27
- Status: Accepted
- Tracked work: [Storage Task #51](https://github.com/Plasius-LTD/storage/issues/51)
- Error-contract clarification: [Storage Task #56](https://github.com/Plasius-LTD/storage/issues/56), 2026-10-23.
- The packet-first write order and its rejected index-first alternative are
  superseded by [ADR-0008](./adr-0008-reserve-index-capacity-before-packets.md).
  The remaining index schema, bounds, integrity and ownership decisions remain.

## Context

Hourly and daily processors need a complete, bounded view of packets accepted
inside an event-time window. `listPacketPage()` deliberately provides only an
opaque, packet-ID-ordered traversal. It is not a durable snapshot, cannot prove
event-time completeness, and can miss a late packet inserted behind a saved
cursor. Reading every retained packet would be unbounded and would turn Blob
layout into an accidental query API.

A packet write and its index update are separate Blob operations. Azure Blob
Storage cannot atomically commit both records, so the protocol must make
partial progress recoverable without publishing a false-success receipt.

## Decision

A kind may opt into one fixed time index:

```ts
timeIndex: {
  prefix: "feedback-index/bugs",
  timestampField: "acceptedAt",
  partition: "hour"
}
```

The index prefix is validated at startup, cannot overlap any packet or index
prefix, and is never accepted per request. The timestamp field is a fixed safe
schema field name. Its value must be a canonical UTC timestamp, and the
configured partition is `hour` or `day`.

Each aligned partition owns one canonical index head under the fixed index
prefix. The head contains only accepted time, packet ID, packet schema
identity, packet digest, and byte length. Entries are append-only and sorted by
`(acceptedAt, packetId)`. Updates use `If-None-Match` for creation and exact
`If-Match` compare-and-swap thereafter. A conflicting writer rereads and
retries within a fixed attempt, byte, item, cancellation, and deadline bound.
Existing entries may never be removed or changed.

The package writes the immutable packet first and then makes its index entry
visible. `writePacket()` succeeds only after both are visible. An exact replay
repairs a missing index entry. A different timestamp or packet digest is an
immutable conflict. A failure after the packet write is a fixed, redacted,
retryable storage failure; the host retains its outbox reservation and retries
the same operation until the index converges.

Every head has a deterministic opaque `snapshot` digest of its kind, window,
and entries. `observedAt` is package-owned, stable while membership is stable,
and advances monotonically when membership changes, even if the injected clock
stalls or moves backwards. Neither value is a credential or a public/admin
identifier.

`readPacketTimeWindow()` accepts exactly one aligned configured partition. It
reads the single fixed head, verifies canonical bytes and complete integrity
metadata, then reads and validates every referenced packet. It returns the
complete set exactly once in canonical order or fails without partial output.
Caller item/byte limits may only reduce configured ceilings. A missing head is
a complete empty window with a deterministic empty snapshot only when that
exact head request supplies a plain-data provider `code: "BlobNotFound"`, with
HTTP 404 or no status. A status-only 404, container/route/authorization error,
contradictory non-404 status, or adapter-domain `NOT_FOUND` cannot prove absence.
Both head downloads and discovery properties reject these failures with fixed
redacted storage diagnostics; no partial complete result can escape. Generic
record downloads use the same explicit provider-code classifier. This preserves
Azure SDK errors (`statusCode`) and equivalent adapters (`status` or code-only)
without reading provider URLs, messages, headers, or accessor properties.
Error descriptor-inspection exceptions and revoked proxies are ambiguous
failures; safe reflection and error classification must never release their
raw exception text. This applies to both head APIs and shared record reads.

`listPacketTimeWindows()` derives the finite set of aligned head paths for a
bounded caller range and reads properties for only those paths. It never calls
flat Blob listing. Complete closed metadata supplies window, observation, and
snapshot facts. The response and metadata cross the provider boundary through
bounded plain-data descriptor snapshots, so nulls, accessors, and throwing
dependency traps fail with fixed redacted corruption errors without invoking
provider-controlled getters. Malformed or ambiguous properties fail closed.
Results are ascending, unique, and include only windows with a head.

## Ownership Boundary

The package owns path derivation, canonical index records, conditional writes,
integrity checks, bounds, deadlines, and redacted failures. The host owns
authentication, authorization, managed identity, private networking,
retention, leases around materialisation, outbox persistence, and deciding
which windows require reprocessing when their snapshot changes.

## Alternatives Rejected

- Flat-listing all packets: unbounded and not an event-time snapshot.
- Trusting packet Blob timestamps or metadata: server receipt time is not the
  registered packet field and list traversal still lacks snapshot semantics.
- One immutable index Blob per packet without a bounded head: discovery still
  requires a potentially unbounded prefix scan.
- Writing the index before the packet: readers could observe a dangling entry.
- Returning partial pages or resumable tokens: a processor could persist an
  incomplete window as complete.
- Treating any HTTP 404 or domain `NOT_FOUND` as an absent head: missing
  infrastructure or concealed authorization would become a false snapshot.
- Inspecting provider error text/URLs: those are sensitive and cannot establish
  absence more reliably than the exact operation's structured provider code.

## Consequences

Indexed writes require at least one additional conditional Blob operation and
may return a retryable failure after the packet is already durable. Hosts must
therefore keep an outbox until the combined receipt succeeds. In exchange,
processors obtain a bounded, revision-detectable, late-arrival-safe input
contract without scans or retained reporter data.
