import { createHash, timingSafeEqual } from "node:crypto";

/** Storage roots are deliberately fixed so callers cannot manufacture arbitrary Blob prefixes. */
export const IMMUTABLE_ASSET_ROOTS = Object.freeze({
  model: "models",
  "gpu-interface": "gpu-interfaces",
  shader: "shaders",
  "shader-style-profile": "shader-style-profiles",
  "shader-validation-evidence": "shader-evidence",
} as const);

export const IMMUTABLE_VERSION_MANIFEST_PATH =
  "_plasius/version-manifest.json" as const;
export const IMMUTABLE_VERSION_MANIFEST_SCHEMA =
  "plasius.immutable-asset-version/1" as const;
/** The completion marker plus no more than 512 payload files. */
export const MAX_IMMUTABLE_VERSION_FILES = 513 as const;
export const MAX_IMMUTABLE_VERSION_PAYLOAD_FILES =
  MAX_IMMUTABLE_VERSION_FILES - 1;
export const MAX_IMMUTABLE_BLOB_NAME_LENGTH = 1024 as const;

export const SAFE_IMMUTABLE_ASSET_CONTENT_TYPES = Object.freeze([
  "application/json",
  "application/octet-stream",
  "application/wasm",
  "image/avif",
  "image/jpeg",
  "image/ktx2",
  "image/png",
  "image/webp",
  "model/gltf+json",
  "model/gltf-binary",
  "text/plain; charset=utf-8",
  "text/wgsl; charset=utf-8",
] as const);

export type ImmutableAssetKind = keyof typeof IMMUTABLE_ASSET_ROOTS;
export type ImmutableAssetStorageScope = "intake" | "runtime";
export type SafeImmutableAssetContentType =
  (typeof SAFE_IMMUTABLE_ASSET_CONTENT_TYPES)[number];

export interface ImmutableAssetIdentity {
  readonly kind: ImmutableAssetKind;
  readonly id: string;
  readonly version: string;
}

export interface ImmutableAssetFileInput {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly contentType?: string;
}

export interface CreateImmutableAssetVersionInput {
  readonly identity: ImmutableAssetIdentity;
  readonly files: readonly ImmutableAssetFileInput[];
}

export interface ImmutableAssetVersionFileManifest {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentType: SafeImmutableAssetContentType;
}

export interface ImmutableAssetVersionManifest {
  readonly schema: typeof IMMUTABLE_VERSION_MANIFEST_SCHEMA;
  readonly identity: ImmutableAssetIdentity;
  readonly root: (typeof IMMUTABLE_ASSET_ROOTS)[ImmutableAssetKind];
  readonly files: readonly ImmutableAssetVersionFileManifest[];
  readonly payloadFileCount: number;
  readonly payloadByteLength: number;
}

export interface ImmutableAssetVersionReceipt {
  readonly identity: ImmutableAssetIdentity;
  readonly prefix: string;
  readonly manifestPath: typeof IMMUTABLE_VERSION_MANIFEST_PATH;
  readonly manifestSha256: string;
  readonly fileCount: number;
  readonly payloadByteLength: number;
  readonly replayed: boolean;
  readonly files: readonly ImmutableAssetVersionFileManifest[];
}

export interface ImmutableAssetFileReadResult
  extends ImmutableAssetVersionFileManifest {
  readonly identity: ImmutableAssetIdentity;
  readonly bytes: Uint8Array;
}

export interface BlobUploadResponsePort {
  readonly etag?: string;
}

export interface BlobDownloadResponsePort {
  readonly readableStreamBody?: AsyncIterable<Uint8Array>;
  readonly contentLength?: number;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly etag?: string;
}

/** The subset of an Azure BlockBlobClient used by this package. */
export interface BlockBlobClientPort {
  uploadData(
    data: Uint8Array,
    options: {
      readonly abortSignal?: AbortSignal;
      readonly conditions: { readonly ifNoneMatch: "*" };
      readonly blobHTTPHeaders: { readonly blobContentType: string };
      readonly metadata: Readonly<Record<string, string>>;
    }
  ): Promise<BlobUploadResponsePort>;
  download(
    offset?: number,
    count?: number,
    options?: { readonly abortSignal?: AbortSignal }
  ): Promise<BlobDownloadResponsePort>;
}

/** The subset of an Azure ContainerClient used by this package. */
export interface BlobContainerPort {
  getBlockBlobClient(blobName: string): BlockBlobClientPort;
}

export type ImmutableAssetStorageErrorCode =
  | "ABORTED"
  | "BLOB_CORRUPT"
  | "BLOB_NOT_FOUND"
  | "DEADLINE_EXCEEDED"
  | "INVALID_ARGUMENT"
  | "INVALID_IDENTITY"
  | "INVALID_MANIFEST"
  | "INVALID_PATH"
  | "LIMIT_EXCEEDED"
  | "STORAGE_OPERATION_FAILED"
  | "UNDECLARED_FILE"
  | "VERSION_CONFLICT";

export type ImmutableAssetStorageOperation =
  | "create"
  | "download"
  | "publish"
  | "read"
  | "upload"
  | "verify";

export interface ImmutableAssetStorageDiagnostic {
  readonly code: ImmutableAssetStorageErrorCode;
  readonly message: string;
  readonly operation: ImmutableAssetStorageOperation;
  readonly retryable: boolean;
  readonly identity?: ImmutableAssetIdentity;
  readonly path?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export class ImmutableAssetStorageError extends Error {
  readonly code: ImmutableAssetStorageErrorCode;
  readonly diagnostic: ImmutableAssetStorageDiagnostic;
  readonly cause?: unknown;

  constructor(
    diagnostic: ImmutableAssetStorageDiagnostic,
    options: {
      readonly cause?: unknown;
    } = {}
  ) {
    super(diagnostic.message);
    this.name = "ImmutableAssetStorageError";
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: Object.freeze({ redacted: true }),
        configurable: true,
        enumerable: false,
        writable: false,
      });
    }
  }
}

export interface ImmutableAssetOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxConcurrency?: number;
  readonly maxFileBytes?: number;
  readonly maxVersionBytes?: number;
}

export interface CreateImmutableAssetStoreOptions
  extends Omit<ImmutableAssetOperationOptions, "signal"> {
  readonly intakeContainer: BlobContainerPort;
  readonly runtimeContainer: BlobContainerPort;
}

export interface ImmutableAssetStore {
  stageVersion(
    input: CreateImmutableAssetVersionInput,
    options?: Pick<ImmutableAssetOperationOptions, "signal">
  ): Promise<ImmutableAssetVersionReceipt>;
  publishVersion(
    identity: ImmutableAssetIdentity,
    options?: Pick<ImmutableAssetOperationOptions, "signal">
  ): Promise<ImmutableAssetVersionReceipt>;
  verifyVersion(
    scope: ImmutableAssetStorageScope,
    identity: ImmutableAssetIdentity,
    options?: Pick<ImmutableAssetOperationOptions, "signal">
  ): Promise<ImmutableAssetVersionReceipt>;
  readVersionFile(
    scope: ImmutableAssetStorageScope,
    identity: ImmutableAssetIdentity,
    relativePath: string,
    options?: Pick<ImmutableAssetOperationOptions, "signal">
  ): Promise<ImmutableAssetFileReadResult>;
}

interface RequiredOperationLimits {
  readonly timeoutMs: number;
  readonly maxConcurrency: number;
  readonly maxFileBytes: number;
  readonly maxVersionBytes: number;
}

interface OperationContext {
  readonly signal: AbortSignal;
  readonly limits: RequiredOperationLimits;
  readonly race: <T>(promise: Promise<T>) => Promise<T>;
  readonly throwIfAborted: () => void;
  readonly abortCode: () => "ABORTED" | "DEADLINE_EXCEEDED";
}

interface PreparedFile extends ImmutableAssetVersionFileManifest {
  readonly bytes: Uint8Array;
  readonly blobPath: string;
  readonly metadata: Readonly<Record<string, string>>;
}

interface PreparedVersion {
  readonly identity: ImmutableAssetIdentity;
  readonly prefix: string;
  readonly files: readonly PreparedFile[];
  readonly manifest: ImmutableAssetVersionManifest;
  readonly manifestBytes: Uint8Array;
  readonly manifestDigest: string;
  readonly manifestBlobPath: string;
  readonly manifestMetadata: Readonly<Record<string, string>>;
}

interface DownloadedBlob {
  readonly bytes: Uint8Array;
  readonly contentLength: number;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly etag?: string;
}

interface PutResult {
  readonly created: boolean;
  readonly etag?: string;
}

const DEFAULT_LIMITS: RequiredOperationLimits = {
  timeoutMs: 30_000,
  maxConcurrency: 4,
  maxFileBytes: 256 * 1024 * 1024,
  maxVersionBytes: 2 * 1024 * 1024 * 1024,
};
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_DOWNLOAD_CHUNKS = 65_536;
const IDENTITY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MUTABLE_VERSION_NAMES = new Set([
  "canary",
  "current",
  "default",
  "head",
  "latest",
  "main",
  "next",
  "preview",
  "production",
  "stable",
]);
// Mirrors @plasius/asset-contracts assertImmutableAssetVersion without creating
// an upward dependency from the storage primitive into domain contracts.
const X_WILDCARD_SEGMENT_PATTERN =
  /^(?:[vV])?[xX](?:\.|-|$)|\.[xX](?:\.|-|$)/u;
const SAFE_CONTENT_TYPE_SET = new Set<string>(
  SAFE_IMMUTABLE_ASSET_CONTENT_TYPES
);
const UINT8_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength"
)?.get;

function fail(
  code: ImmutableAssetStorageErrorCode,
  message: string,
  operation: ImmutableAssetStorageOperation,
  options: {
    readonly identity?: ImmutableAssetIdentity;
    readonly path?: string;
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, string | number | boolean>>;
    readonly cause?: unknown;
  } = {}
): never {
  throw new ImmutableAssetStorageError(
    {
      code,
      message,
      operation,
      retryable: options.retryable ?? false,
      ...(options.identity === undefined ? {} : { identity: options.identity }),
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.details === undefined ? {} : { details: options.details }),
    },
    {
      cause: options.cause,
    }
  );
}

function asStorageError(
  error: unknown,
  operation: ImmutableAssetStorageOperation,
  identity?: ImmutableAssetIdentity,
  path?: string
): ImmutableAssetStorageError {
  if (error instanceof ImmutableAssetStorageError) {
    return error;
  }
  const { status } = storageErrorToken(error);
  const retryable = status === undefined || status === 408 || status === 425 || status === 429 || status >= 500;
  return new ImmutableAssetStorageError(
    {
      code: "STORAGE_OPERATION_FAILED",
      message: "The Blob storage operation failed.",
      operation,
      retryable,
      ...(identity === undefined ? {} : { identity }),
      ...(path === undefined ? {} : { path }),
    },
    { cause: error }
  );
}

function normalizeIdentity(
  identity: ImmutableAssetIdentity,
  operation: ImmutableAssetStorageOperation
): ImmutableAssetIdentity {
  if (
    !identity ||
    typeof identity !== "object" ||
    !hasExactKeys(identity as unknown as Record<string, unknown>, ["kind", "id", "version"])
  ) {
    fail("INVALID_IDENTITY", "An immutable asset identity is required.", operation);
  }
  const { kind, id, version } = identity;
  if (
    typeof kind !== "string" ||
    !Object.prototype.hasOwnProperty.call(IMMUTABLE_ASSET_ROOTS, kind)
  ) {
    fail("INVALID_IDENTITY", "The immutable asset kind is not supported.", operation);
  }
  if (typeof id !== "string" || !IDENTITY_SEGMENT_PATTERN.test(id)) {
    fail(
      "INVALID_IDENTITY",
      "Asset ids must be 1-128 ASCII letters, numbers, dots, underscores, or hyphens and start with a letter or number.",
      operation
    );
  }
  if (
    typeof version !== "string" ||
    !IDENTITY_SEGMENT_PATTERN.test(version) ||
    MUTABLE_VERSION_NAMES.has(version.toLowerCase()) ||
    X_WILDCARD_SEGMENT_PATTERN.test(version)
  ) {
    fail(
      "INVALID_IDENTITY",
      "Asset versions must be immutable identifiers, not mutable channel names.",
      operation
    );
  }
  return Object.freeze({ kind, id, version });
}

function immutableVersionPrefix(identity: ImmutableAssetIdentity): string {
  return `${IMMUTABLE_ASSET_ROOTS[identity.kind]}/${identity.id}/versions/${identity.version}`;
}

function hasNonPrintableAscii(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint < 0x20 || codePoint > 0x7e) return true;
  }
  return false;
}

function normalizeRelativePath(
  relativePath: string,
  operation: ImmutableAssetStorageOperation,
  identity?: ImmutableAssetIdentity
): string {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.length > 768 ||
    relativePath.startsWith("/") ||
    relativePath.endsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes(":") ||
    /[%?#]/u.test(relativePath) ||
    hasNonPrintableAscii(relativePath)
  ) {
    fail("INVALID_PATH", "The asset file path is not a safe relative Blob path.", operation, {
      identity,
    });
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > 255 ||
        segment === "." ||
        segment === ".."
    ) ||
    segments[0]?.toLowerCase() === "channels" ||
    segments[0]?.toLowerCase() === "_plasius"
  ) {
    fail(
      "INVALID_PATH",
      "Traversal, mutable channels, and reserved storage paths are not allowed.",
      operation,
      { identity, path: relativePath }
    );
  }
  if (
    identity !== undefined &&
    `${immutableVersionPrefix(identity)}/${relativePath}`.length >
      MAX_IMMUTABLE_BLOB_NAME_LENGTH
  ) {
    fail(
      "INVALID_PATH",
      "The complete immutable Blob name exceeds the storage path limit.",
      operation,
      { identity, path: relativePath }
    );
  }
  return relativePath;
}

function inferContentType(path: string): SafeImmutableAssetContentType {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".wgsl")) return "text/wgsl; charset=utf-8";
  if (lower.endsWith(".gltf")) return "model/gltf+json";
  if (lower.endsWith(".glb")) return "model/gltf-binary";
  if (lower.endsWith(".wasm")) return "application/wasm";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".ktx2")) return "image/ktx2";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function normalizeContentType(
  contentType: string | undefined,
  path: string,
  operation: ImmutableAssetStorageOperation,
  identity: ImmutableAssetIdentity
): SafeImmutableAssetContentType {
  if (contentType !== undefined && typeof contentType !== "string") {
    fail(
      "INVALID_ARGUMENT",
      "The asset content type must be a string when supplied.",
      operation,
      { identity, path }
    );
  }
  const normalized = contentType === undefined
    ? inferContentType(path)
    : contentType.trim().toLowerCase();
  if (!SAFE_CONTENT_TYPE_SET.has(normalized)) {
    fail(
      "INVALID_ARGUMENT",
      "The asset content type is not in the server-safe allowlist.",
      operation,
      { identity, path }
    );
  }
  const inferred = inferContentType(path);
  if (inferred !== "application/octet-stream" && normalized !== inferred) {
    fail(
      "INVALID_ARGUMENT",
      "Known asset file extensions require their canonical safe content type.",
      operation,
      { identity, path }
    );
  }
  return normalized as SafeImmutableAssetContentType;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function metadataFor(
  identity: ImmutableAssetIdentity,
  relativePath: string,
  digest: string,
  byteLength: number,
  contentType: string,
  role: "manifest" | "payload"
): Readonly<Record<string, string>> {
  return Object.freeze({
    plasiusassetid: identity.id,
    plasiusassetkind: identity.kind,
    plasiusassetversion: identity.version,
    plasiusbytelength: String(byteLength),
    plasiuscontenttype: contentType,
    plasiusrelativepath: relativePath,
    plasiusrole: role,
    plasiusschema: IMMUTABLE_VERSION_MANIFEST_SCHEMA,
    plasiussha256: digest,
  });
}

function encodeManifest(manifest: ImmutableAssetVersionManifest): Uint8Array {
  return Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
}

function resolveLimits(
  options: ImmutableAssetOperationOptions = {}
): RequiredOperationLimits {
  const limits = {
    timeoutMs: options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    maxConcurrency: options.maxConcurrency ?? DEFAULT_LIMITS.maxConcurrency,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
    maxVersionBytes: options.maxVersionBytes ?? DEFAULT_LIMITS.maxVersionBytes,
  };
  if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > 300_000) {
    fail("INVALID_ARGUMENT", "timeoutMs must be an integer from 1 to 300000.", "create");
  }
  if (!Number.isInteger(limits.maxConcurrency) || limits.maxConcurrency < 1 || limits.maxConcurrency > 32) {
    fail("INVALID_ARGUMENT", "maxConcurrency must be an integer from 1 to 32.", "create");
  }
  if (!Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes < 1) {
    fail("INVALID_ARGUMENT", "maxFileBytes must be a positive safe integer.", "create");
  }
  if (
    !Number.isSafeInteger(limits.maxVersionBytes) ||
    limits.maxVersionBytes < limits.maxFileBytes
  ) {
    fail(
      "INVALID_ARGUMENT",
      "maxVersionBytes must be a safe integer no smaller than maxFileBytes.",
      "create"
    );
  }
  return Object.freeze(limits);
}

function assertContainer(container: BlobContainerPort, operation: ImmutableAssetStorageOperation): void {
  if (!container || typeof container.getBlockBlobClient !== "function") {
    fail("INVALID_ARGUMENT", "A structural Blob container port is required.", operation);
  }
}

function prepareVersion(
  input: CreateImmutableAssetVersionInput,
  limits: RequiredOperationLimits
): PreparedVersion {
  if (
    !input ||
    typeof input !== "object" ||
    !hasExactKeys(input as unknown as Record<string, unknown>, ["identity", "files"])
  ) {
    fail("INVALID_ARGUMENT", "An immutable asset version input is required.", "create");
  }
  const identityInput = input.identity;
  const sourceFiles = input.files;
  const identity = normalizeIdentity(identityInput, "create");
  if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) {
    fail("INVALID_ARGUMENT", "An immutable version requires at least one payload file.", "create", {
      identity,
    });
  }
  if (sourceFiles.length > MAX_IMMUTABLE_VERSION_PAYLOAD_FILES) {
    fail(
      "LIMIT_EXCEEDED",
      `An immutable version may contain no more than ${MAX_IMMUTABLE_VERSION_PAYLOAD_FILES} payload files.`,
      "create",
      { identity, details: { fileCount: sourceFiles.length } }
    );
  }
  for (let index = 0; index < sourceFiles.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(sourceFiles, index)) {
      fail("INVALID_ARGUMENT", "Asset file arrays must not contain sparse entries.", "create", {
        identity,
      });
    }
  }

  const prefix = immutableVersionPrefix(identity);
  const seenPaths = new Set<string>();
  let payloadByteLength = 0;
  const files = sourceFiles.map((file): PreparedFile => {
    if (!file || typeof file !== "object") {
      fail("INVALID_ARGUMENT", "Every asset file must be an object.", "create", {
        identity,
      });
    }
    const fileKeys = Object.keys(file);
    if (
      !hasExactKeys(file as unknown as Record<string, unknown>, ["path", "bytes"]) &&
      !hasExactKeys(file as unknown as Record<string, unknown>, [
        "path",
        "bytes",
        "contentType",
      ])
    ) {
      fail(
        "INVALID_ARGUMENT",
        "Asset file inputs may contain only path, bytes, and contentType.",
        "create",
        { identity, details: { fieldCount: fileKeys.length } }
      );
    }
    const filePath = file.path;
    const fileBytes = file.bytes;
    const fileContentType = file.contentType;
    const path = normalizeRelativePath(filePath, "create", identity);
    if (seenPaths.has(path)) {
      fail("INVALID_PATH", "Asset file paths must be unique.", "create", {
        identity,
        path,
      });
    }
    seenPaths.add(path);
    if (!(fileBytes instanceof Uint8Array) || !ArrayBuffer.isView(fileBytes)) {
      fail("INVALID_ARGUMENT", "Asset file bytes must be a Uint8Array.", "create", {
        identity,
        path,
      });
    }
    let byteLength: number;
    try {
      byteLength = UINT8_ARRAY_BYTE_LENGTH_GETTER?.call(fileBytes) as number;
    } catch {
      fail("INVALID_ARGUMENT", "Asset file bytes must be an ordinary Uint8Array view.", "create", {
        identity,
        path,
      });
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      fail("INVALID_ARGUMENT", "Asset file bytes have an invalid intrinsic byte length.", "create", {
        identity,
        path,
      });
    }
    if (byteLength > limits.maxFileBytes) {
      fail("LIMIT_EXCEEDED", "The asset file exceeds maxFileBytes.", "create", {
        identity,
        path,
        details: { byteLength, maxFileBytes: limits.maxFileBytes },
      });
    }
    payloadByteLength += byteLength;
    if (!Number.isSafeInteger(payloadByteLength) || payloadByteLength > limits.maxVersionBytes) {
      fail("LIMIT_EXCEEDED", "The immutable version exceeds maxVersionBytes.", "create", {
        identity,
        details: {
          payloadByteLength,
          maxVersionBytes: limits.maxVersionBytes,
        },
      });
    }
    const bytes = new Uint8Array(byteLength);
    try {
      Uint8Array.prototype.set.call(bytes, fileBytes);
      if (UINT8_ARRAY_BYTE_LENGTH_GETTER?.call(fileBytes) !== byteLength) {
        throw new TypeError("Uint8Array length changed during snapshot.");
      }
    } catch (cause) {
      fail("INVALID_ARGUMENT", "Asset file bytes could not be snapshotted consistently.", "create", {
        identity,
        path,
        cause,
      });
    }
    const contentType = normalizeContentType(fileContentType, path, "create", identity);
    const digest = sha256(bytes);
    return Object.freeze({
      path,
      bytes,
      contentType,
      sha256: digest,
      byteLength: bytes.byteLength,
      blobPath: `${prefix}/${path}`,
      metadata: metadataFor(
        identity,
        path,
        digest,
        bytes.byteLength,
        contentType,
        "payload"
      ),
    });
  });
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const manifestFiles = files.map(
    ({ path, sha256: digest, byteLength, contentType }) =>
      Object.freeze({ path, sha256: digest, byteLength, contentType })
  );
  const manifest: ImmutableAssetVersionManifest = Object.freeze({
    schema: IMMUTABLE_VERSION_MANIFEST_SCHEMA,
    identity,
    root: IMMUTABLE_ASSET_ROOTS[identity.kind],
    files: Object.freeze(manifestFiles),
    payloadFileCount: manifestFiles.length,
    payloadByteLength,
  });
  const manifestBytes = encodeManifest(manifest);
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    fail("LIMIT_EXCEEDED", "The generated immutable version manifest is too large.", "create", {
      identity,
    });
  }
  const manifestDigest = sha256(manifestBytes);
  return Object.freeze({
    identity,
    prefix,
    files: Object.freeze(files),
    manifest,
    manifestBytes,
    manifestDigest,
    manifestBlobPath: `${prefix}/${IMMUTABLE_VERSION_MANIFEST_PATH}`,
    manifestMetadata: metadataFor(
      identity,
      IMMUTABLE_VERSION_MANIFEST_PATH,
      manifestDigest,
      manifestBytes.byteLength,
      "application/json",
      "manifest"
    ),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function snapshotCreateInput(
  input: CreateImmutableAssetVersionInput
): CreateImmutableAssetVersionInput {
  if (
    !input ||
    typeof input !== "object" ||
    !hasExactKeys(input as unknown as Record<string, unknown>, ["identity", "files"])
  ) {
    fail("INVALID_ARGUMENT", "An immutable asset version input is required.", "create");
  }
  const inputRecord = input as unknown as Record<string, unknown>;
  const identityValue = ownDataProperty(inputRecord, "identity", "Asset version input");
  const filesValue = ownDataProperty(inputRecord, "files", "Asset version input");
  if (!isRecord(identityValue) || !hasExactKeys(identityValue, ["kind", "id", "version"])) {
    fail("INVALID_IDENTITY", "An immutable asset identity is required.", "create");
  }
  const identity = Object.freeze({
    kind: ownDataProperty(identityValue, "kind", "Asset identity"),
    id: ownDataProperty(identityValue, "id", "Asset identity"),
    version: ownDataProperty(identityValue, "version", "Asset identity"),
  }) as unknown as ImmutableAssetIdentity;
  if (!Array.isArray(filesValue)) {
    fail("INVALID_ARGUMENT", "Asset files must be a dense array.", "create");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(filesValue, "length");
  const fileCount = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (!Number.isSafeInteger(fileCount) || (fileCount as number) < 0) {
    fail("INVALID_ARGUMENT", "Asset files must be a dense array.", "create");
  }
  if ((fileCount as number) > MAX_IMMUTABLE_VERSION_PAYLOAD_FILES) {
    fail(
      "LIMIT_EXCEEDED",
      `An immutable version may contain no more than ${MAX_IMMUTABLE_VERSION_PAYLOAD_FILES} payload files.`,
      "create",
      { details: { fileCount: fileCount as number } }
    );
  }
  const files: ImmutableAssetFileInput[] = [];
  for (let index = 0; index < (fileCount as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(filesValue, String(index));
    if (!descriptor || !("value" in descriptor)) {
      fail("INVALID_ARGUMENT", "Asset file arrays must contain own data entries.", "create");
    }
    const file = descriptor.value;
    if (!isRecord(file)) {
      fail("INVALID_ARGUMENT", "Every asset file must be a data object.", "create");
    }
    const keys = Object.keys(file);
    const hasContentType = hasExactKeys(file, ["path", "bytes", "contentType"]);
    if (!hasContentType && !hasExactKeys(file, ["path", "bytes"])) {
      fail("INVALID_ARGUMENT", "Asset file inputs may contain only path, bytes, and contentType.", "create", {
        details: { fieldCount: keys.length },
      });
    }
    const path = ownDataProperty(file, "path", `Asset file ${index}`);
    const bytes = ownDataProperty(file, "bytes", `Asset file ${index}`);
    const contentType = hasContentType
      ? ownDataProperty(file, "contentType", `Asset file ${index}`)
      : undefined;
    files.push(Object.freeze({
      path,
      bytes,
      ...(hasContentType ? { contentType } : {}),
    }) as unknown as ImmutableAssetFileInput);
  }
  return Object.freeze({ identity, files: Object.freeze(files) });
}

function ownDataProperty(
  value: Record<string, unknown>,
  key: string,
  label: string
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    fail("INVALID_ARGUMENT", `${label} must use own data properties.`, "create");
  }
  return descriptor.value;
}

function parseManifest(
  bytes: Uint8Array,
  expectedIdentity: ImmutableAssetIdentity,
  limits: RequiredOperationLimits
): ImmutableAssetVersionManifest {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, [
        "schema",
        "identity",
        "root",
        "files",
        "payloadFileCount",
        "payloadByteLength",
      ]) ||
      parsed.schema !== IMMUTABLE_VERSION_MANIFEST_SCHEMA ||
      !isRecord(parsed.identity) ||
      !hasExactKeys(parsed.identity, ["kind", "id", "version"])
    ) {
      throw new Error("Manifest envelope is invalid.");
    }
    const identity = normalizeIdentity(
      parsed.identity as unknown as ImmutableAssetIdentity,
      "verify"
    );
    if (
      identity.kind !== expectedIdentity.kind ||
      identity.id !== expectedIdentity.id ||
      identity.version !== expectedIdentity.version ||
      parsed.root !== IMMUTABLE_ASSET_ROOTS[expectedIdentity.kind] ||
      !Array.isArray(parsed.files) ||
      parsed.files.length === 0 ||
      parsed.files.length > MAX_IMMUTABLE_VERSION_PAYLOAD_FILES ||
      parsed.payloadFileCount !== parsed.files.length ||
      !Number.isSafeInteger(parsed.payloadByteLength) ||
      (parsed.payloadByteLength as number) < 0 ||
      (parsed.payloadByteLength as number) > limits.maxVersionBytes
    ) {
      throw new Error("Manifest identity or bounds are invalid.");
    }

    const seen = new Set<string>();
    let total = 0;
    const files = parsed.files.map((candidate): ImmutableAssetVersionFileManifest => {
      if (
        !isRecord(candidate) ||
        !hasExactKeys(candidate, ["path", "sha256", "byteLength", "contentType"])
      ) {
        throw new Error("Manifest file record is invalid.");
      }
      const path = normalizeRelativePath(candidate.path as string, "verify", identity);
      if (seen.has(path)) throw new Error("Manifest file paths are not unique.");
      seen.add(path);
      if (
        typeof candidate.sha256 !== "string" ||
        !SHA256_PATTERN.test(candidate.sha256) ||
        !Number.isSafeInteger(candidate.byteLength) ||
        (candidate.byteLength as number) < 0 ||
        (candidate.byteLength as number) > limits.maxFileBytes ||
        typeof candidate.contentType !== "string" ||
        !SAFE_CONTENT_TYPE_SET.has(candidate.contentType) ||
        (inferContentType(path) !== "application/octet-stream" &&
          candidate.contentType !== inferContentType(path))
      ) {
        throw new Error("Manifest file metadata is invalid.");
      }
      total += candidate.byteLength as number;
      if (!Number.isSafeInteger(total) || total > limits.maxVersionBytes) {
        throw new Error("Manifest total size is invalid.");
      }
      return Object.freeze({
        path,
        sha256: candidate.sha256,
        byteLength: candidate.byteLength as number,
        contentType: candidate.contentType as SafeImmutableAssetContentType,
      });
    });
    if (total !== parsed.payloadByteLength) {
      throw new Error("Manifest total byte length does not match its files.");
    }
    const sortedPaths = files
      .map((file) => file.path)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (files.some((file, index) => file.path !== sortedPaths[index])) {
      throw new Error("Manifest file records are not canonically ordered.");
    }
    const manifest: ImmutableAssetVersionManifest = Object.freeze({
      schema: IMMUTABLE_VERSION_MANIFEST_SCHEMA,
      identity,
      root: IMMUTABLE_ASSET_ROOTS[identity.kind],
      files: Object.freeze(files),
      payloadFileCount: files.length,
      payloadByteLength: total,
    });
    if (!exactBytesEqual(bytes, encodeManifest(manifest))) {
      throw new Error("Manifest bytes are not canonical.");
    }
    return manifest;
  } catch (error) {
    if (error instanceof ImmutableAssetStorageError && error.code === "INVALID_MANIFEST") {
      throw error;
    }
    fail(
      "INVALID_MANIFEST",
      "The immutable version completion manifest is invalid.",
      "verify",
      { identity: expectedIdentity, path: IMMUTABLE_VERSION_MANIFEST_PATH, cause: error }
    );
  }
}

async function withOperationContext<T>(
  operation: ImmutableAssetStorageOperation,
  identity: ImmutableAssetIdentity | undefined,
  externalSignal: AbortSignal | undefined,
  limits: RequiredOperationLimits,
  work: (context: OperationContext) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let abortCode: "ABORTED" | "DEADLINE_EXCEEDED" = "ABORTED";
  const abort = (code: "ABORTED" | "DEADLINE_EXCEEDED") => {
    if (!controller.signal.aborted) {
      abortCode = code;
      controller.abort();
    }
  };
  const onExternalAbort = () => abort("ABORTED");
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => abort("DEADLINE_EXCEEDED"), limits.timeoutMs);

  const interruption = () =>
    new ImmutableAssetStorageError({
      code: abortCode,
      message:
        abortCode === "DEADLINE_EXCEEDED"
          ? "The immutable asset storage operation exceeded its deadline."
          : "The immutable asset storage operation was aborted.",
      operation,
      retryable: true,
      ...(identity === undefined ? {} : { identity }),
    });
  const context: OperationContext = {
    signal: controller.signal,
    limits,
    abortCode: () => abortCode,
    throwIfAborted: () => {
      if (controller.signal.aborted) throw interruption();
    },
    race: async <R>(promise: Promise<R>): Promise<R> => {
      if (controller.signal.aborted) throw interruption();
      let listener: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        listener = () => reject(interruption());
        controller.signal.addEventListener("abort", listener, { once: true });
      });
      void promise.catch(() => undefined);
      try {
        return await Promise.race([promise, aborted]);
      } finally {
        if (listener) controller.signal.removeEventListener("abort", listener);
      }
    },
  };

  try {
    context.throwIfAborted();
    return await work(context);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (!failed) {
        const index = nextIndex++;
        if (index >= values.length) return;
        try {
          results[index] = await mapper(values[index] as T, index);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
    }
  );
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}

function storageErrorToken(error: unknown): { readonly status?: number; readonly code?: string } {
  if (!isRecord(error)) return {};
  const details = isRecord(error.details) ? error.details : undefined;
  const status =
    typeof error.statusCode === "number"
      ? error.statusCode
      : typeof error.status === "number"
        ? error.status
        : undefined;
  const code =
    typeof error.code === "string"
      ? error.code
      : typeof details?.errorCode === "string"
        ? details.errorCode
        : undefined;
  return { ...(status === undefined ? {} : { status }), ...(code === undefined ? {} : { code }) };
}

function isAlreadyExists(error: unknown): boolean {
  const { status, code } = storageErrorToken(error);
  return status === 409 || code === "BlobAlreadyExists" || code === "ConditionNotMet";
}

function isNotFound(error: unknown): boolean {
  const { status, code } = storageErrorToken(error);
  return code === "BlobNotFound" || (status === 404 && code !== "ContainerNotFound");
}

function normalizedMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
  identity: ImmutableAssetIdentity,
  path: string
): Readonly<Record<string, string>> {
  if (!metadata || !isRecord(metadata)) {
    fail("BLOB_CORRUPT", "The Blob is missing its immutable metadata.", "download", {
      identity,
      path,
    });
  }
  const normalized = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase();
    if (
      typeof value !== "string" ||
      Object.prototype.hasOwnProperty.call(normalized, lower)
    ) {
      fail("BLOB_CORRUPT", "The Blob has invalid immutable metadata.", "download", {
        identity,
        path,
      });
    }
    normalized[lower] = value;
  }
  return Object.freeze(normalized);
}

async function downloadBlob(
  container: BlobContainerPort,
  blobPath: string,
  relativePath: string,
  identity: ImmutableAssetIdentity,
  maxBytes: number,
  context: OperationContext
): Promise<DownloadedBlob> {
  context.throwIfAborted();
  let response: BlobDownloadResponsePort;
  try {
    const client = container.getBlockBlobClient(blobPath);
    response = await context.race(
      client.download(0, undefined, { abortSignal: context.signal })
    );
  } catch (error) {
    if (error instanceof ImmutableAssetStorageError) throw error;
    if (isNotFound(error)) {
      fail("BLOB_NOT_FOUND", "The immutable asset Blob was not found.", "download", {
        identity,
        path: relativePath,
      });
    }
    throw asStorageError(error, "download", identity, relativePath);
  }
  const responseContentLength = response.contentLength;
  const responseContentType = response.contentType;
  const responseBody = response.readableStreamBody;
  const responseMetadata = response.metadata;
  const responseEtag = response.etag;
  if (
    !Number.isSafeInteger(responseContentLength) ||
    (responseContentLength as number) < 0
  ) {
    fail("BLOB_CORRUPT", "The Blob response has no trustworthy byte length.", "download", {
      identity,
      path: relativePath,
    });
  }
  if ((responseContentLength as number) > maxBytes) {
    fail("LIMIT_EXCEEDED", "The Blob exceeds the configured read limit.", "download", {
      identity,
      path: relativePath,
      details: { contentLength: responseContentLength as number, maxBytes },
    });
  }
  if (typeof responseContentType !== "string") {
    fail("BLOB_CORRUPT", "The Blob response is missing its content type.", "download", {
      identity,
      path: relativePath,
    });
  }
  const declaredLength = responseContentLength as number;
  if (!responseBody && declaredLength !== 0) {
    fail("BLOB_CORRUPT", "The Blob response is missing its byte stream.", "download", {
      identity,
      path: relativePath,
    });
  }
  const bytes = new Uint8Array(declaredLength);
  let received = 0;
  let chunkCount = 0;
  if (responseBody) {
    await context.race(
      (async () => {
        for await (const chunk of responseBody as AsyncIterable<Uint8Array>) {
          context.throwIfAborted();
          if (!(chunk instanceof Uint8Array) || !ArrayBuffer.isView(chunk)) {
            fail("BLOB_CORRUPT", "The Blob response emitted a non-binary chunk.", "download", {
              identity,
              path: relativePath,
            });
          }
          chunkCount += 1;
          if (chunkCount > MAX_DOWNLOAD_CHUNKS) {
            fail("BLOB_CORRUPT", "The Blob response exceeded the bounded stream chunk count.", "download", {
              identity,
              path: relativePath,
            });
          }
          let chunkLength: number;
          try {
            chunkLength = UINT8_ARRAY_BYTE_LENGTH_GETTER?.call(chunk) as number;
          } catch {
            fail("BLOB_CORRUPT", "The Blob response emitted an invalid binary view.", "download", {
              identity,
              path: relativePath,
            });
          }
          if (!Number.isSafeInteger(chunkLength) || chunkLength <= 0) {
            fail("BLOB_CORRUPT", "The Blob response emitted an empty or invalid binary chunk.", "download", {
              identity,
              path: relativePath,
            });
          }
          if (received + chunkLength > maxBytes || received + chunkLength > declaredLength) {
            fail("BLOB_CORRUPT", "The Blob stream exceeded its declared or configured length.", "download", {
              identity,
              path: relativePath,
            });
          }
          try {
            Uint8Array.prototype.set.call(bytes, chunk, received);
            if (UINT8_ARRAY_BYTE_LENGTH_GETTER?.call(chunk) !== chunkLength) {
              throw new TypeError("Uint8Array length changed during download.");
            }
          } catch (cause) {
            fail("BLOB_CORRUPT", "The Blob response chunk could not be copied consistently.", "download", {
              identity,
              path: relativePath,
              cause,
            });
          }
          received += chunkLength;
        }
      })()
    );
  }
  if (received !== declaredLength) {
    fail("BLOB_CORRUPT", "The Blob stream length differs from its response length.", "download", {
      identity,
      path: relativePath,
    });
  }
  return {
    bytes,
    contentLength: declaredLength,
    contentType: responseContentType,
    metadata: normalizedMetadata(responseMetadata, identity, relativePath),
    ...(responseEtag === undefined ? {} : { etag: responseEtag }),
  };
}

function metadataEqual(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) => key === expectedKeys[index] && actual[key] === expected[key]
    )
  );
}

function assertBlobMatches(
  downloaded: DownloadedBlob,
  expected: {
    readonly bytes?: Uint8Array;
    readonly byteLength: number;
    readonly contentType: string;
    readonly sha256: string;
    readonly metadata: Readonly<Record<string, string>>;
  },
  identity: ImmutableAssetIdentity,
  path: string,
  mismatchCode: "BLOB_CORRUPT" | "VERSION_CONFLICT"
): void {
  const digest = sha256(downloaded.bytes);
  if (
    downloaded.contentLength !== expected.byteLength ||
    downloaded.bytes.byteLength !== expected.byteLength ||
    downloaded.contentType !== expected.contentType ||
    digest !== expected.sha256 ||
    !metadataEqual(downloaded.metadata, expected.metadata) ||
    (expected.bytes !== undefined && !exactBytesEqual(downloaded.bytes, expected.bytes))
  ) {
    fail(
      mismatchCode,
      mismatchCode === "VERSION_CONFLICT"
        ? "A different immutable Blob already occupies this version path."
        : "An immutable Blob differs from its manifest or storage metadata.",
      mismatchCode === "VERSION_CONFLICT" ? "create" : "verify",
      { identity, path }
    );
  }
}

async function putBlobImmutable(
  container: BlobContainerPort,
  blobPath: string,
  relativePath: string,
  bytes: Uint8Array,
  contentType: string,
  digest: string,
  metadata: Readonly<Record<string, string>>,
  identity: ImmutableAssetIdentity,
  context: OperationContext,
  maxReadBytes: number
): Promise<PutResult> {
  context.throwIfAborted();
  try {
    const client = container.getBlockBlobClient(blobPath);
    const response = await context.race(
      client.uploadData(bytes, {
        abortSignal: context.signal,
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: contentType },
        metadata,
      })
    );
    if (typeof response.etag !== "string" || response.etag.length === 0) {
      fail(
        "STORAGE_OPERATION_FAILED",
        "Blob creation succeeded without the ETag required for immutable write confirmation.",
        "upload",
        { identity, path: relativePath, retryable: true }
      );
    }
    return { created: true, etag: response.etag };
  } catch (error) {
    if (error instanceof ImmutableAssetStorageError) throw error;
    if (!isAlreadyExists(error)) {
      throw asStorageError(error, "upload", identity, relativePath);
    }
    const downloaded = await downloadBlob(
      container,
      blobPath,
      relativePath,
      identity,
      maxReadBytes,
      context
    );
    assertBlobMatches(
      downloaded,
      {
        bytes,
        byteLength: bytes.byteLength,
        contentType,
        sha256: digest,
        metadata,
      },
      identity,
      relativePath,
      "VERSION_CONFLICT"
    );
    return { created: false, ...(downloaded.etag === undefined ? {} : { etag: downloaded.etag }) };
  }
}

function expectedPayloadMetadata(
  identity: ImmutableAssetIdentity,
  file: ImmutableAssetVersionFileManifest
): Readonly<Record<string, string>> {
  return metadataFor(
    identity,
    file.path,
    file.sha256,
    file.byteLength,
    file.contentType,
    "payload"
  );
}

async function loadManifestInternal(
  container: BlobContainerPort,
  identity: ImmutableAssetIdentity,
  context: OperationContext
): Promise<{
  readonly manifest: ImmutableAssetVersionManifest;
  readonly manifestBytes: Uint8Array;
  readonly manifestDigest: string;
  readonly markerEtag: string;
}> {
  const prefix = immutableVersionPrefix(identity);
  const downloaded = await downloadBlob(
    container,
    `${prefix}/${IMMUTABLE_VERSION_MANIFEST_PATH}`,
    IMMUTABLE_VERSION_MANIFEST_PATH,
    identity,
    MAX_MANIFEST_BYTES,
    context
  );
  const manifest = parseManifest(downloaded.bytes, identity, context.limits);
  const manifestBytes = encodeManifest(manifest);
  const manifestDigest = sha256(manifestBytes);
  assertBlobMatches(
    downloaded,
    {
      bytes: manifestBytes,
      byteLength: manifestBytes.byteLength,
      contentType: "application/json",
      sha256: manifestDigest,
      metadata: metadataFor(
        identity,
        IMMUTABLE_VERSION_MANIFEST_PATH,
        manifestDigest,
        manifestBytes.byteLength,
        "application/json",
        "manifest"
      ),
    },
    identity,
    IMMUTABLE_VERSION_MANIFEST_PATH,
    "BLOB_CORRUPT"
  );
  if (typeof downloaded.etag !== "string" || downloaded.etag.length === 0) {
    fail(
      "BLOB_CORRUPT",
      "The immutable completion marker is missing its ETag.",
      "verify",
      { identity, path: IMMUTABLE_VERSION_MANIFEST_PATH }
    );
  }
  return { manifest, manifestBytes, manifestDigest, markerEtag: downloaded.etag };
}

interface MarkerBinding {
  readonly manifestBytes: Uint8Array;
  readonly manifestDigest: string;
  readonly markerEtag: string;
}

function assertMarkerBinding(
  actual: MarkerBinding,
  expected: MarkerBinding,
  identity: ImmutableAssetIdentity,
  mismatchCode: "BLOB_CORRUPT" | "VERSION_CONFLICT"
): void {
  if (
    actual.markerEtag !== expected.markerEtag ||
    actual.manifestDigest !== expected.manifestDigest ||
    !exactBytesEqual(actual.manifestBytes, expected.manifestBytes)
  ) {
    fail(
      mismatchCode,
      mismatchCode === "VERSION_CONFLICT"
        ? "The immutable completion marker changed during exact replay."
        : "The immutable completion marker changed during verification.",
      mismatchCode === "VERSION_CONFLICT" ? "create" : "verify",
      { identity, path: IMMUTABLE_VERSION_MANIFEST_PATH }
    );
  }
}

async function readPayloadInternal(
  container: BlobContainerPort,
  identity: ImmutableAssetIdentity,
  file: ImmutableAssetVersionFileManifest,
  context: OperationContext
): Promise<ImmutableAssetFileReadResult> {
  const downloaded = await downloadBlob(
    container,
    `${immutableVersionPrefix(identity)}/${file.path}`,
    file.path,
    identity,
    context.limits.maxFileBytes,
    context
  );
  assertBlobMatches(
    downloaded,
    {
      byteLength: file.byteLength,
      contentType: file.contentType,
      sha256: file.sha256,
      metadata: expectedPayloadMetadata(identity, file),
    },
    identity,
    file.path,
    "BLOB_CORRUPT"
  );
  return Object.freeze({ ...file, identity, bytes: downloaded.bytes });
}

function receiptFor(
  identity: ImmutableAssetIdentity,
  manifest: ImmutableAssetVersionManifest,
  manifestDigest: string,
  replayed: boolean
): ImmutableAssetVersionReceipt {
  return Object.freeze({
    identity,
    prefix: immutableVersionPrefix(identity),
    manifestPath: IMMUTABLE_VERSION_MANIFEST_PATH,
    manifestSha256: manifestDigest,
    fileCount: manifest.files.length + 1,
    payloadByteLength: manifest.payloadByteLength,
    replayed,
    files: manifest.files,
  });
}

async function verifyInternal(
  container: BlobContainerPort,
  identity: ImmutableAssetIdentity,
  context: OperationContext,
  replayed = false,
  expectedMarker?: MarkerBinding
): Promise<ImmutableAssetVersionReceipt> {
  const initial = await loadManifestInternal(container, identity, context);
  if (expectedMarker) {
    assertMarkerBinding(initial, expectedMarker, identity, "VERSION_CONFLICT");
  }
  const { manifest, manifestDigest } = initial;
  await mapWithConcurrency(manifest.files, context.limits.maxConcurrency, async (file) => {
    await readPayloadInternal(container, identity, file, context);
  });
  const final = await loadManifestInternal(container, identity, context);
  assertMarkerBinding(final, initial, identity, "BLOB_CORRUPT");
  return receiptFor(identity, manifest, manifestDigest, replayed);
}

async function completionMarkerPrecheck(
  container: BlobContainerPort,
  prepared: PreparedVersion,
  context: OperationContext
): Promise<ImmutableAssetVersionReceipt | undefined> {
  let downloaded: DownloadedBlob;
  try {
    downloaded = await downloadBlob(
      container,
      prepared.manifestBlobPath,
      IMMUTABLE_VERSION_MANIFEST_PATH,
      prepared.identity,
      MAX_MANIFEST_BYTES,
      context
    );
  } catch (error) {
    if (error instanceof ImmutableAssetStorageError && error.code === "BLOB_NOT_FOUND") {
      return undefined;
    }
    if (
      error instanceof ImmutableAssetStorageError &&
      (error.code === "ABORTED" ||
        error.code === "DEADLINE_EXCEEDED" ||
        error.code === "STORAGE_OPERATION_FAILED")
    ) {
      throw error;
    }
    fail(
      "VERSION_CONFLICT",
      "A non-matching completion marker already occupies this immutable version.",
      "create",
      {
        identity: prepared.identity,
        path: IMMUTABLE_VERSION_MANIFEST_PATH,
        cause: error,
      }
    );
  }
  assertBlobMatches(
    downloaded,
    {
      bytes: prepared.manifestBytes,
      byteLength: prepared.manifestBytes.byteLength,
      contentType: "application/json",
      sha256: prepared.manifestDigest,
      metadata: prepared.manifestMetadata,
    },
    prepared.identity,
    IMMUTABLE_VERSION_MANIFEST_PATH,
    "VERSION_CONFLICT"
  );
  if (typeof downloaded.etag !== "string" || downloaded.etag.length === 0) {
    fail(
      "VERSION_CONFLICT",
      "The existing immutable completion marker is missing its ETag.",
      "create",
      { identity: prepared.identity, path: IMMUTABLE_VERSION_MANIFEST_PATH }
    );
  }
  return verifyInternal(container, prepared.identity, context, true, {
    manifestBytes: prepared.manifestBytes,
    manifestDigest: prepared.manifestDigest,
    markerEtag: downloaded.etag,
  });
}

async function createInternal(
  container: BlobContainerPort,
  input: CreateImmutableAssetVersionInput,
  context: OperationContext
): Promise<ImmutableAssetVersionReceipt> {
  const prepared = prepareVersion(input, context.limits);
  const existing = await completionMarkerPrecheck(container, prepared, context);
  if (existing) return existing;

  let compatibleExternalMarkerObserved = false;
  try {
    await mapWithConcurrency(prepared.files, context.limits.maxConcurrency, async (file) => {
      await putBlobImmutable(
        container,
        file.blobPath,
        file.path,
        file.bytes,
        file.contentType,
        file.sha256,
        file.metadata,
        prepared.identity,
        context,
        context.limits.maxFileBytes
      );
    });

    const markerResult = await putBlobImmutable(
      container,
      prepared.manifestBlobPath,
      IMMUTABLE_VERSION_MANIFEST_PATH,
      prepared.manifestBytes,
      "application/json",
      prepared.manifestDigest,
      prepared.manifestMetadata,
      prepared.identity,
      context,
      MAX_MANIFEST_BYTES
    );
    if (!markerResult.created) {
      compatibleExternalMarkerObserved = true;
    }
    if (typeof markerResult.etag !== "string" || markerResult.etag.length === 0) {
      fail(
        "BLOB_CORRUPT",
        "The immutable completion marker has no ETag for verification binding.",
        "verify",
        { identity: prepared.identity, path: IMMUTABLE_VERSION_MANIFEST_PATH }
      );
    }
    return await verifyInternal(
      container,
      prepared.identity,
      context,
      compatibleExternalMarkerObserved,
      {
        manifestBytes: prepared.manifestBytes,
        manifestDigest: prepared.manifestDigest,
        markerEtag: markerResult.etag,
      }
    );
  } catch (error) {
    // Payload blobs are intentionally retained. A concurrent writer may have
    // adopted them before this attempt can prove cleanup is safe. The absence
    // of a valid completion marker keeps partial data unreachable to readers.
    throw asStorageError(error, "create", prepared.identity);
  }
}

async function readInternal(
  container: BlobContainerPort,
  identity: ImmutableAssetIdentity,
  relativePath: string,
  context: OperationContext
): Promise<ImmutableAssetFileReadResult> {
  const path = normalizeRelativePath(relativePath, "read", identity);
  const initial = await loadManifestInternal(container, identity, context);
  const { manifest } = initial;
  const file = manifest.files.find((candidate) => candidate.path === path);
  if (!file) {
    fail(
      "UNDECLARED_FILE",
      "The requested file is not declared by the immutable version manifest.",
      "read",
      { identity, path }
    );
  }
  const result = await readPayloadInternal(container, identity, file, context);
  const final = await loadManifestInternal(container, identity, context);
  assertMarkerBinding(final, initial, identity, "BLOB_CORRUPT");
  return result;
}

async function publishInternal(
  intakeContainer: BlobContainerPort,
  runtimeContainer: BlobContainerPort,
  identity: ImmutableAssetIdentity,
  context: OperationContext
): Promise<ImmutableAssetVersionReceipt> {
  const initial = await loadManifestInternal(intakeContainer, identity, context);
  const { manifest } = initial;
  const files = await mapWithConcurrency(
    manifest.files,
    context.limits.maxConcurrency,
    async (file): Promise<ImmutableAssetFileInput> => {
      const read = await readPayloadInternal(intakeContainer, identity, file, context);
      return {
        path: file.path,
        bytes: read.bytes,
        contentType: file.contentType,
      };
    }
  );
  const final = await loadManifestInternal(intakeContainer, identity, context);
  assertMarkerBinding(final, initial, identity, "BLOB_CORRUPT");
  return createInternal(runtimeContainer, { identity, files }, context);
}

/** Creates or exactly replays an immutable version in one injected Blob container. */
export async function createImmutableAssetVersion(
  container: BlobContainerPort,
  input: CreateImmutableAssetVersionInput,
  options: ImmutableAssetOperationOptions = {}
): Promise<ImmutableAssetVersionReceipt> {
  assertContainer(container, "create");
  const limits = resolveLimits(options);
  const snapshot = snapshotCreateInput(input);
  const identity = normalizeIdentity(snapshot.identity, "create");
  return withOperationContext("create", identity, options.signal, limits, (context) =>
    createInternal(container, snapshot, context)
  );
}

/** Re-reads the completion marker and every declared file, validating bytes and metadata. */
export async function verifyImmutableAssetVersion(
  container: BlobContainerPort,
  identityInput: ImmutableAssetIdentity,
  options: ImmutableAssetOperationOptions = {}
): Promise<ImmutableAssetVersionReceipt> {
  assertContainer(container, "verify");
  const limits = resolveLimits(options);
  const identity = normalizeIdentity(identityInput, "verify");
  return withOperationContext("verify", identity, options.signal, limits, (context) =>
    verifyInternal(container, identity, context)
  );
}

/** Reads only a manifest-declared file and verifies its immutable bytes before returning it. */
export async function readImmutableAssetVersionFile(
  container: BlobContainerPort,
  identityInput: ImmutableAssetIdentity,
  relativePath: string,
  options: ImmutableAssetOperationOptions = {}
): Promise<ImmutableAssetFileReadResult> {
  assertContainer(container, "read");
  const limits = resolveLimits(options);
  const identity = normalizeIdentity(identityInput, "read");
  return withOperationContext("read", identity, options.signal, limits, (context) =>
    readInternal(container, identity, relativePath, context)
  );
}

/**
 * Creates the intake/runtime façade used by model storage. It intentionally owns
 * neither authorization nor catalog/channel mutation.
 */
export function createImmutableAssetStore(
  options: CreateImmutableAssetStoreOptions
): ImmutableAssetStore {
  if (!options || typeof options !== "object") {
    fail("INVALID_ARGUMENT", "Immutable asset store options are required.", "create");
  }
  const intakeContainer = options.intakeContainer;
  const runtimeContainer = options.runtimeContainer;
  assertContainer(intakeContainer, "create");
  assertContainer(runtimeContainer, "create");
  if (intakeContainer === runtimeContainer) {
    fail(
      "INVALID_ARGUMENT",
      "Intake and runtime storage containers must be distinct ports.",
      "create"
    );
  }
  const limits = resolveLimits(options);
  const operationOptions = (signal?: AbortSignal): ImmutableAssetOperationOptions => ({
    ...limits,
    ...(signal === undefined ? {} : { signal }),
  });
  const containerFor = (scope: ImmutableAssetStorageScope): BlobContainerPort => {
    if (scope === "intake") return intakeContainer;
    if (scope === "runtime") return runtimeContainer;
    fail("INVALID_ARGUMENT", "Storage scope must be intake or runtime.", "read");
  };

  const store: ImmutableAssetStore = {
    stageVersion: (input, callOptions = {}) =>
      createImmutableAssetVersion(
        intakeContainer,
        input,
        operationOptions(callOptions.signal)
      ),
    publishVersion: async (identityInput, callOptions = {}) => {
      const identity = normalizeIdentity(identityInput, "publish");
      return await withOperationContext(
        "publish",
        identity,
        callOptions.signal,
        limits,
        (context) =>
          publishInternal(
            intakeContainer,
            runtimeContainer,
            identity,
            context
          )
      );
    },
    verifyVersion: async (scope, identity, callOptions = {}) =>
      await verifyImmutableAssetVersion(
        containerFor(scope),
        identity,
        operationOptions(callOptions.signal)
      ),
    readVersionFile: async (scope, identity, relativePath, callOptions = {}) =>
      await readImmutableAssetVersionFile(
        containerFor(scope),
        identity,
        relativePath,
        operationOptions(callOptions.signal)
      ),
  };
  return Object.freeze(store);
}
