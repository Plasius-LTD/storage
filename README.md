# @plasius/storage

[![npm version](https://img.shields.io/npm/v/@plasius/storage.svg)](https://www.npmjs.com/package/@plasius/storage)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Plasius-LTD/storage/ci.yml?branch=main&label=build&style=flat)](https://github.com/Plasius-LTD/storage/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/codecov/c/github/Plasius-LTD/storage)](https://codecov.io/gh/Plasius-LTD/storage)
[![License](https://img.shields.io/github/license/Plasius-LTD/storage)](./LICENSE)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-yes-blue.svg)](./CODE_OF_CONDUCT.md)
[![Security Policy](https://img.shields.io/badge/security%20policy-yes-orange.svg)](./SECURITY.md)
[![Changelog](https://img.shields.io/badge/changelog-md-blue.svg)](./CHANGELOG.md)

Public package containing shared Azure storage helpers and server-side
immutable asset-version and schema-backed JSON packet primitives for Plasius
services.


## Install

```bash
npm install @plasius/storage
```

## Azure Files Usage

```ts
import { uploadUserImageShare } from "@plasius/storage";

await uploadUserImageShare("user-123", 1, Buffer.from("avatar"), "image/png");
```

`uploadUserImageShare()` supports `image/png`, `image/jpeg`, `image/jpg`, `image/webp`, `image/gif`, and `image/avif`, and it normalizes unsafe `userId` values before using them as Azure Files directory names.

## Immutable Asset Versions

The `@plasius/storage/immutable-assets` subpath is Node-only. It implements
conditional, digest-verified Azure Blob mechanics behind injected structural
ports; it is intentionally unavailable to browser bundles and does not create
credentials or Azure clients.

Its primary exports are:

- `createImmutableAssetStore(config)` for a service with distinct intake and
  runtime scopes;
- `createImmutableAssetVersion(container, input, options?)` for conditional,
  manifest-last creation followed by complete verification;
- `verifyImmutableAssetVersion(container, identity, options?)` for an explicit
  full-version re-read;
- `readImmutableAssetVersionFile(container, identity, relativePath, options?)`
  for marker-first exact file access;
- `BlobContainerPort` and `BlockBlobClientPort` structural adapter types;
- immutable identity, input, manifest, receipt, options, store, diagnostic, and
  error-code types; and
- `ImmutableAssetStorageError` for bounded, typed failures.

Import the API only from server-side Node code:

```ts
import {
  createImmutableAssetStore,
  createImmutableAssetVersion,
  verifyImmutableAssetVersion,
  readImmutableAssetVersionFile,
  ImmutableAssetStorageError,
  type BlobContainerPort,
} from "@plasius/storage/immutable-assets";
```

`IMMUTABLE_VERSION_MANIFEST_PATH` is the fixed marker path, and
`MAX_IMMUTABLE_VERSION_FILES` is the 513-file total ceiling.

Use a private intake container for unpromoted candidates and a private runtime
container for immutable versions that may be referenced by the promoted model
catalog. The host constructs the Azure adapters, supplies an abort
signal/deadline, and chooses the container for each operation.

The configured store exposes `stageVersion`, `publishVersion`, `verifyVersion`,
and `readVersionFile`. `stageVersion` targets the intake scope;
`publishVersion` targets the runtime scope. Verification and reads require an
explicit scope, so a caller cannot silently cross the intake/runtime boundary.

### Version roots

| Asset kind | Immutable root |
| --- | --- |
| Model | `models/{id}/versions/{version}` |
| GPU interface | `gpu-interfaces/{id}/versions/{version}` |
| WGSL shader | `shaders/{id}/versions/{version}` |
| Shader style profile | `shader-style-profiles/{id}/versions/{version}` |
| Qualification evidence | `shader-evidence/{id}/versions/{version}` |

Every complete version has the fixed marker
`_plasius/version-manifest.json`. A version may contain at most 513 files in
total: one marker and up to 512 manifest-declared payloads.

### Write contract

The immutable write operation:

1. validates the identity, paths, content types, package limits, and byte
   budgets before storage effects;
2. computes lowercase SHA-256, exact length, and protocol-owned metadata from
   the supplied bytes;
3. creates payloads with `If-None-Match: *`;
4. accepts an existing blob as an idempotent replay only after its complete
   bytes, length, content type, digest, and metadata match;
5. writes `_plasius/version-manifest.json` last; and
6. re-reads and verifies the marker and every declared payload before returning
   a verified receipt.

The receipt is evidence of immutable storage verification only. It contains no
Blob URL or SAS token and grants no catalog or runtime authority.

### Read contract

A read requires a supported kind, exact asset ID/version, and a normalized
relative path. It verifies the fixed marker first, requires that the marker
declares the path, then downloads and verifies the payload. Traversal,
undeclared paths, mutable aliases such as `latest`, raw blob names, and arbitrary
Blob/SAS URLs fail closed.

### Failure and lifecycle retention

Operations return typed storage diagnostics for invalid input, immutable
conflict, integrity mismatch, incomplete versions, timeout/abort, dependency
failure, and undeclared reads. Callers own bounded retry policy; the package
does not hide dependency failures behind internal retry loops.

Before the marker exists, a failed attempt is unreachable to marker-first
readers. This API intentionally has no delete authority: payloads from an
interrupted attempt are retained because a concurrent completion marker may
have adopted them. The host may apply a separately authorized lifecycle policy
only after proving an unreachable candidate is neither complete nor catalog
referenced. Product rollback changes a catalog pointer elsewhere; it never
overwrites or deletes these bytes.

### Ownership and rollout boundary

This package owns Blob paths, conditional creation, integrity metadata,
manifest-last completion, complete verification, and exact marker-first reads.
The model-storage/site layer continues to own:

- private-container configuration, credentials, authentication, authorization,
  tenant policy, and audit;
- catalog rows, channel compare-and-swap, promotion, discovery, and rollback;
- shader/model schemas, reflection, ABI and semantic compatibility, admission,
  and qualification-evidence policy;
- evaluation of feature flag `asset.pipeline.shader-store.enabled`; and
- evaluation of capability `gpu.shader.style.select` for user-visible style
  discovery and selection.

The feature flag is the runtime/public-submission rollout control. The
capability does not grant promotion or storage access and is not required for
default-profile rendering. Neither control is evaluated by this package.

For the complete protocol and security requirements, see
[ADR-0003](./docs/adrs/adr-0003-immutable-asset-version-storage.md),
[TDR-0001](./docs/tdrs/tdr-0001-immutable-asset-storage-protocol.md), and
[SECURITY.md](./SECURITY.md).

## Immutable Schema-Backed JSON Packets

The `@plasius/storage/immutable-json-packets` subpath is Node-only. It stores
privacy-safe, structured JSON packets behind injected Azure Blob-compatible
ports and provides coordination records for bounded processors.

```ts
import {
  createImmutableJsonPacketStore,
  type JsonPacketBlobContainerPort,
} from "@plasius/storage/immutable-json-packets";
import {
  FeedbackBugPacketSchema,
  FeedbackProcessorCheckpointSchema,
} from "@plasius/schema";

declare const privateFeedbackContainer: JsonPacketBlobContainerPort;
declare const structuredPacket: unknown;
declare const requestSignal: AbortSignal;

const feedbackPackets = createImmutableJsonPacketStore({
  container: privateFeedbackContainer,
  kinds: {
    bug: {
      prefix: "feedback/bugs",
      packetSchema: FeedbackBugPacketSchema,
      checkpointSchema: FeedbackProcessorCheckpointSchema,
      safeDeadLetterCodes: [
        "CLASSIFIER_UNAVAILABLE",
        "PACKET_SCHEMA_REJECTED",
      ],
    },
  },
  timeoutMs: 30_000,
  maxPacketBytes: 256 * 1024,
  maxListPageItems: 100,
  maxListPageBytes: 4 * 1024 * 1024,
});

const receipt = await feedbackPackets.writePacket(
  "bug",
  "bug_01j1te5t000000000000000001",
  structuredPacket,
  { signal: requestSignal }
);

const page = await feedbackPackets.listPacketPage("bug", {
  maxItems: 100,
  maxBytes: 4 * 1024 * 1024,
  signal: requestSignal,
});
const packets = await Promise.all(
  page.packets.map(({ packetId }) =>
    feedbackPackets.readPacket("bug", packetId, { signal: requestSignal })
  )
);
```

The example schema exports are supplied by the consuming application/package;
this package accepts their structural `validate()` and `getPiiAudit()` surface.
Schema registration fails closed unless its PII audit is empty.

### Storage contract

- Packet kinds select fixed, non-overlapping prefixes at store construction.
  Individual operations cannot provide Blob paths, prefixes, URLs, containers,
  or credentials.
- `writePacket()` accepts a structured value only. There is deliberately no raw
  JSON string, request body, `Buffer`, arbitrary metadata, or generic object
  upload API.
- Plain safe JSON is snapshotted before and after schema validation. Cycles,
  getters, symbols, custom prototypes, sparse arrays, non-finite numbers,
  excessive bounds, unsafe or content-shaped object keys,
  narrative/identity/browser fields, and deterministic sensitive-value
  patterns fail before Blob access. Array length/member bounds are checked
  before keys are enumerated or output storage is allocated.
- Canonical packet bytes and protocol metadata are created with
  `If-None-Match: *`. Only Blob's precise already-exists/precondition signals
  enter collision reconciliation; other 409 responses remain dependency
  failures. A collision is an idempotent replay only when the entire stored
  representation matches.
- Receipts contain safe IDs, schema identity, SHA-256, length, ETag, and replay
  status. They contain no packet value, Blob URL/path, credentials, or provider
  response. Provider ETags must be bounded printable values before they can
  enter a receipt or subsequent compare-and-swap.
- `readPacket()` requires an exact configured kind and safe packet ID, then
  verifies the canonical bytes, metadata, digest, ETag, envelope, and schema.
- `listPacketPage()` asks the injected Azure-compatible `ContainerClient` for
  exactly one bounded flat page under the kind's fixed
  `{prefix}/packets/` root. Callers cannot provide a prefix, path, container,
  or URL. The method validates every listed name, content type, ETag, complete
  protocol metadata record, schema identity, digest, item count, and aggregate
  declared-byte budget before returning sorted descriptors.
- List results contain only safe packet IDs, schema identity, SHA-256, and byte
  length. They never contain packet values, Blob names/URLs, provider tokens,
  account correlation, pseudonyms, narrative, or arbitrary metadata. Payloads
  still pass through `readPacket()` so full bytes, integrity, and the registered
  schema are checked at the consumer boundary.
- The optional cursor is a deterministic, bounded, opaque, kind-bound wrapper
  around Azure's continuation. It resumes only the same bounded traversal and
  is not a durable snapshot or an ingestion checkpoint. Processors must start a
  fresh traversal when reconciling new or late packets and use immutable output
  manifests/checkpoint CAS—not the list cursor—as their correctness boundary.

This is the final structured storage guard, not a free-text PII detector.
Narrative, screenshots, identity correlation, URLs, locale, and client
timestamps must never be passed to it. Upstream services must discard
transient narrative after deriving closed classifications.

### Processor coordination

- `compareAndSwapCheckpoint()` creates with `If-None-Match: *` or updates with
  the exact prior ETag. An uncertain retry succeeds only when the current
  canonical checkpoint is identical.
- `acquireLease()` uses a fixed sentinel and a 15–60 second Azure lease. Its
  returned handle can renew or release without exposing the lease token.
  Concurrent releases coalesce, an already-lost lease is an idempotent release,
  and renewal expiry is conservatively based on the request start. A release
  caller's cancellation or deadline stops only that caller's wait: the bounded
  provider release remains single-flight until it settles, so an immediate
  retry cannot launch a second release.
- `writeManifest()` stores only a bounded UTC window/revision and sorted packet
  ID/digest/length facts.
- `writeDeadLetter()` stores only a packet ID, startup-allowlisted error code,
  package-generated canonical server timestamp, bounded attempt, and
  retryability. The caller cannot supply the timestamp; retries with the same
  ID and logical facts replay the first server-timestamped record.

The host owns authentication, authorization, private-container and
managed-identity configuration, feature flag `feedback.reporting.enabled`,
processor traversal/reconciliation, retry policy, lifecycle/backup retention,
and all PII elimination before this API. The package has no logging, delete,
generic or caller-prefixed scan, public URL, SAS, credential-construction, or
lifecycle-policy surface. Existing write/read-only adapters remain compatible;
`listPacketPage()` fails closed until the injected container also supplies the
Azure-compatible flat-list structural method.

For the full decision and protocol, see
[ADR-0004](./docs/adrs/adr-0004-immutable-schema-backed-json-packet-storage.md),
[TDR-0002](./docs/tdrs/tdr-0002-immutable-json-packet-storage-protocol.md), and
[SECURITY.md](./SECURITY.md).

## Development

```bash
npm install
npm run privacy:check
npm run build
npm test
npm run test:privacy
npm run typecheck
npm run lint
npm run test:coverage
npm run audit:all
npm run pack:check
```

### Private-artifact and package policy

Signed contributor agreements and contributor acceptance records are retained
in an approved access-controlled system outside source control. A
zero-dependency policy gate inspects repository and Git-index path metadata
only; it never opens or hashes a suspected private artifact.

`privacy:check` rejects protected paths in the working tree and proposed Git
index. `pack:check` applies the same rules to the final npm path manifest,
requires the explicit `package.json.files` allowlist, and rejects any package
path not present in the exact public-package allowlist. Public CLA templates
remain distributable, but broad legal-directory entries are forbidden.

CI runs the path and package gates, and release preparation and publishing fail
closed when either policy fails. These targeted controls are defense in depth;
they do not replace organisation-wide secret scanning, access control, or
incident response.

## Governance

- Security policy: [SECURITY.md](./SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- ADRs: [docs/adrs](./docs/adrs)
- Immutable asset storage TDR: [docs/tdrs/tdr-0001-immutable-asset-storage-protocol.md](./docs/tdrs/tdr-0001-immutable-asset-storage-protocol.md)
- Immutable JSON packet storage TDR: [docs/tdrs/tdr-0002-immutable-json-packet-storage-protocol.md](./docs/tdrs/tdr-0002-immutable-json-packet-storage-protocol.md)
- Legal docs: [legal](./legal)
- Public CLA documents: [legal/CLA.md](./legal/CLA.md)

## License

MIT

<!-- BEGIN PLASIUS RELEASE INTEGRITY -->
## Release integrity

CI keeps the administrative contributor registry outside Git and npm package
artifacts using exact, case-normalised path checks. Pull requests run on
GitHub-hosted runners after same-repository admission; protected `main` CI uses
the workflow-restricted self-hosted group. Release preparation and npm
publication use GitHub-hosted runners with Node.js 24.18.0 LTS.

Dispatch `cd.yml` from protected `main` with `phase: prepare`. Release metadata
lands through a unique pull request. After successful push-triggered CI for the
exact merge SHA, the workflow dispatches a separate `publish` run from that
same SHA. Publication fails closed if `main`, CI evidence, the version, tag,
prerelease identity, artifact digests, or npm registry integrity differ.

The read-only validation job runs the repository privacy gate, installs
dependencies, validates the package, builds an SBOM, and seals an immutable
tarball. The `production` job runs no package lifecycle or dependency code; it
verifies the exact artifact hand-off and publishes that tarball through npm
OIDC with provenance. No npm write token or fallback is configured. The
trusted publisher must be bound to `Plasius-LTD/storage`, `cd.yml`,
`production`, and `npm publish`. Rollback is to disable `cd.yml`; never restore
token-based publication.
<!-- END PLASIUS RELEASE INTEGRITY -->
