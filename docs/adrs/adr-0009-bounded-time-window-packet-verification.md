# ADR-0009: Bounded Time-Window Packet Verification

- Date: 2026-10-24
- Status: Accepted
- Tracked work: [Storage Task #58](https://github.com/Plasius-LTD/storage/issues/58)
- Parent Feature: [Scheduled reporting #1661](https://github.com/Plasius-LTD/plasius-ltd-site/issues/1661)

## Context

The accepted-time index permits 10,000 entries. Serial verification at just
5 ms per Blob download consumes at least 50 seconds before other processing,
exceeding the default 30-second operation deadline. Each immutable packet can
be downloaded and verified independently after its bounded index is validated.

## Decision

After validating the full head and preflighting item and declared packet-byte
limits, use at most eight workers per `readPacketTimeWindow()` call. Each worker
claims the next canonical index position and stores its verified result at that
position. A fixed worker set is awaited; no promise is created per queued entry.
Schema, canonical encoding, digest, byte-length and accepted-time verification
remain mandatory. Snapshot, observation time and `(acceptedAt, packetId)` result
ordering remain those of the validated head. No listing, retries, new public
options, dependency changes or wire-format changes are introduced.

The first worker failure stops further scheduling. Failed operation contexts
abort their shared signal before removing deadline/external-abort listeners.
Active siblings receive cancellation; the existing context race also releases
package work when a provider ignores cancellation. Provider activity cannot be
forcibly terminated by the package if that provider ignores its signal. Such
activity remains capped at eight initiated downloads; callers must supply an
adapter that honours cancellation for prompt provider resource cleanup.
The original failure is returned without a partial snapshot. Caller abort and
deadline failures keep their existing fixed diagnostics.

## Alternatives

- Serial reads preserve order but violate the supported latency budget.
- One promise per packet creates unbounded concurrent provider demand.
- Fixed batches wait for the slowest read before starting an available slot.
- Public concurrency configuration expands the contract without a demonstrated
  need; a small fixed cap is easier to reason about and verify.

## Consequences and verification

The result array remains bounded by admitted index membership and packet bytes;
only eight packet downloads/verification operations are active at once. Distinct
calls each have their own pool; the host owns aggregate request admission.
Packet-size ceilings also bound each active download before digest comparison.
Tests measure peak concurrency, exercise tied timestamps and reordered finishes,
and read 10,000 packets at 5 ms/download within the 30-second default budget.
Failure tests cover corrupt/digest/time/schema/missing/provider responses,
caller cancellation, deadline expiry, queued-work suppression and adapters that
ignore cancellation. Existing index completeness and privacy gates still apply.

## Rollout and release

The host retains the remotely controllable `feedback.reporting.enabled` flag
and its reporting rollback path. The library does not evaluate product flags;
integrity/cancellation/limits cannot be bypassed by a rollout setting. Pause
reporting through that flag if needed. Package rollback uses reviewed consumer
dependency changes to a previously published version. No entitlement is added.

Release through reviewed source and pipeline-owned metadata PRs, exact-main CI,
and the existing `cd.yml` main/production trusted publication route. Verify the
public npm artifact and provenance before marking Task #58 complete. No backend
or site deployment is part of this library fix.
