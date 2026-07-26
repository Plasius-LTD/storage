# @plasius/storage

[![npm version](https://img.shields.io/npm/v/@plasius/storage.svg)](https://www.npmjs.com/package/@plasius/storage)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Plasius-LTD/storage/ci.yml?branch=main&label=build&style=flat)](https://github.com/Plasius-LTD/storage/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/codecov/c/github/Plasius-LTD/storage)](https://codecov.io/gh/Plasius-LTD/storage)
[![License](https://img.shields.io/github/license/Plasius-LTD/storage)](./LICENSE)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-yes-blue.svg)](./CODE_OF_CONDUCT.md)
[![Security Policy](https://img.shields.io/badge/security%20policy-yes-orange.svg)](./SECURITY.md)
[![Changelog](https://img.shields.io/badge/changelog-md-blue.svg)](./CHANGELOG.md)

Public package containing shared Azure storage helpers and server-side,
immutable asset-version primitives for Plasius services.


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

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint
npm run test:coverage
npm run audit:all
npm run pack:check
```

## Governance

- Security policy: [SECURITY.md](./SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- ADRs: [docs/adrs](./docs/adrs)
- Immutable asset storage TDR: [docs/tdrs/tdr-0001-immutable-asset-storage-protocol.md](./docs/tdrs/tdr-0001-immutable-asset-storage-protocol.md)
- Legal docs: [legal](./legal)

## License

MIT

<!-- BEGIN PLASIUS RELEASE INTEGRITY -->
## Release integrity

CI keeps the administrative contributor registry outside Git and npm package
artifacts using exact, case-normalised path checks. CI runs on approved
self-hosted runners. Release preparation and npm publication use GitHub-hosted
runners with Node.js 24.18.0 LTS. CD remains disabled until the npm trusted
publisher binding is verified and the legacy token fallback is removed.
<!-- END PLASIUS RELEASE INTEGRITY -->
