import { createHash, timingSafeEqual } from "node:crypto";

export const IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA =
  "plasius.immutable-json-packet-storage/1" as const;
export const IMMUTABLE_JSON_PACKET_CONTENT_TYPE =
  "application/json" as const;

const MAX_OPERATION_TIMEOUT_MS = 300_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PACKET_BYTES = 256 * 1024;
const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LIST_PAGE_ITEMS = 100;
const DEFAULT_MAX_LIST_PAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_MANIFEST_ENTRIES = 10_000;
const MAX_LIST_PAGE_ITEMS = 1_000;
const MAX_PROVIDER_CONTINUATION_BYTES = 4 * 1024;
const MAX_ENCODED_CURSOR_BYTES = 8 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_MEMBERS = 10_000;
const MAX_JSON_STRING_BYTES = 1_024;
const MAX_STREAM_CHUNKS = 65_536;
const MAX_TIME_INDEX_CAS_ATTEMPTS = 8;
const MAX_TIME_WINDOW_INDEX_ENTRIES = 10_000;

type JsonPrimitive = string | number | boolean | null;
export type SafeJsonValue =
  | JsonPrimitive
  | readonly SafeJsonValue[]
  | { readonly [key: string]: SafeJsonValue };

export interface PersistableJsonValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface PersistableJsonValidationResult<T> {
  readonly valid: boolean;
  readonly value?: T;
  readonly errors?: readonly string[];
  readonly issues?: readonly PersistableJsonValidationIssue[];
}

/**
 * Structural subset implemented by `@plasius/schema` schemas. Only schemas
 * whose PII audit is empty are accepted by this storage boundary.
 */
export interface PersistableJsonSchemaPort<T = unknown> {
  readonly meta: {
    readonly entityType: string;
    readonly version: string;
  };
  validate(input: unknown): PersistableJsonValidationResult<T>;
  getPiiAudit():
    | readonly {
        readonly field: string;
        readonly classification: string;
      }[]
    | null;
}

export interface JsonPacketBlobUploadResponsePort {
  readonly etag?: string;
}

export interface JsonPacketBlobDownloadResponsePort {
  readonly readableStreamBody?: AsyncIterable<Uint8Array>;
  readonly contentLength?: number;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly etag?: string;
}

export interface JsonPacketBlobPropertiesResponsePort {
  readonly contentLength?: number;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly etag?: string;
}

/** Structural subset of Azure Blob list options used by the packet store. */
export interface JsonPacketBlobListOptions {
  readonly abortSignal?: AbortSignal;
  readonly includeMetadata: true;
  readonly prefix: string;
}

/** Structural subset of Azure page settings used by the packet store. */
export interface JsonPacketBlobPageSettings {
  readonly continuationToken?: string;
  readonly maxPageSize?: number;
}

/** Structural subset of an Azure Blob item returned by flat listing. */
export interface JsonPacketBlobListItemPort {
  readonly name: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly properties: {
    readonly contentLength?: number;
    readonly contentType?: string;
    readonly etag?: string;
  };
}

/** Structural subset of one Azure flat-list page. */
export interface JsonPacketBlobListPagePort {
  readonly continuationToken?: string;
  readonly segment: {
    readonly blobItems: readonly JsonPacketBlobListItemPort[];
  };
}

/** Structural subset of Azure's paged flat-list iterator. */
export interface JsonPacketBlobListIteratorPort {
  byPage(
    settings?: JsonPacketBlobPageSettings
  ): AsyncIterable<JsonPacketBlobListPagePort>;
}

export type JsonPacketBlobConditions =
  | {
      readonly ifNoneMatch: "*";
      readonly ifMatch?: never;
    }
  | {
      readonly ifMatch: string;
      readonly ifNoneMatch?: never;
    };

export interface JsonPacketBlobUploadOptions {
  readonly abortSignal?: AbortSignal;
  readonly conditions: JsonPacketBlobConditions;
  readonly blobHTTPHeaders: {
    readonly blobContentType: typeof IMMUTABLE_JSON_PACKET_CONTENT_TYPE;
  };
  readonly metadata: Readonly<Record<string, string>>;
}

export interface JsonPacketBlobLeaseClientPort {
  acquireLease(
    durationSeconds: number,
    options?: { readonly abortSignal?: AbortSignal }
  ): Promise<{ readonly leaseId?: string }>;
  renewLease(
    options?: { readonly abortSignal?: AbortSignal }
  ): Promise<{ readonly leaseId?: string }>;
  releaseLease(options?: {
    readonly abortSignal?: AbortSignal;
  }): Promise<unknown>;
}

/** Structural subset of an Azure BlockBlobClient used by this entry point. */
export interface JsonPacketBlobClientPort {
  uploadData(
    data: Uint8Array,
    options: JsonPacketBlobUploadOptions
  ): Promise<JsonPacketBlobUploadResponsePort>;
  download(
    offset?: number,
    count?: number,
    options?: { readonly abortSignal?: AbortSignal }
  ): Promise<JsonPacketBlobDownloadResponsePort>;
  getProperties?(options?: {
    readonly abortSignal?: AbortSignal;
  }): Promise<JsonPacketBlobPropertiesResponsePort>;
  getBlobLeaseClient(proposedLeaseId?: string): JsonPacketBlobLeaseClientPort;
}

/** Structural subset of an Azure ContainerClient used by this entry point. */
export interface JsonPacketBlobContainerPort {
  getBlockBlobClient(blobName: string): JsonPacketBlobClientPort;
  /**
   * Optional to preserve write/read compatibility for existing hosts. Listing
   * fails closed unless the injected private, managed-identity-capable
   * ContainerClient exposes this Azure-compatible structural method.
   */
  listBlobsFlat?(
    options: JsonPacketBlobListOptions
  ): JsonPacketBlobListIteratorPort;
}

export interface ImmutableJsonPacketKindConfig<T = unknown> {
  /** Fixed root selected once when the store is created; never accepted per operation. */
  readonly prefix: string;
  readonly packetSchema: PersistableJsonSchemaPort<T>;
  readonly checkpointSchema?: PersistableJsonSchemaPort<unknown>;
  readonly safeDeadLetterCodes?: readonly string[];
  readonly maxPacketBytes?: number;
  readonly timeIndex?: {
    /** Fixed index root selected at store creation; never accepted per operation. */
    readonly prefix: string;
    /** Closed field in the validated packet containing its server acceptance time. */
    readonly timestampField: string;
    readonly partition: "hour" | "day";
  };
}

export interface CreateImmutableJsonPacketStoreOptions<
  Kinds extends Readonly<Record<string, ImmutableJsonPacketKindConfig>> =
    Readonly<Record<string, ImmutableJsonPacketKindConfig>>,
> {
  readonly container: JsonPacketBlobContainerPort;
  readonly kinds: Kinds;
  readonly timeoutMs?: number;
  readonly maxPacketBytes?: number;
  readonly maxReadBytes?: number;
  readonly maxListPageItems?: number;
  readonly maxListPageBytes?: number;
  readonly maxManifestEntries?: number;
  /** Server clock injection for deterministic tests; packet payloads never supply it. */
  readonly clock?: () => Date;
}

export interface ImmutableJsonPacketOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ImmutableJsonPacketListOptions
  extends ImmutableJsonPacketOperationOptions {
  /** Opaque, kind-bound cursor returned by the preceding page. */
  readonly cursor?: string;
  /** Per-call item ceiling; it may only reduce the configured ceiling. */
  readonly maxItems?: number;
  /** Per-call declared-byte ceiling; it may only reduce the configured ceiling. */
  readonly maxBytes?: number;
}

export interface ImmutableJsonPacketTimeWindowOptions
  extends ImmutableJsonPacketOperationOptions {
  readonly windowStart: string;
  readonly windowEnd: string;
  /** Per-call item ceiling; it may only reduce the configured ceiling. */
  readonly maxItems: number;
  /** Per-call packet-byte ceiling; it may only reduce the configured ceiling. */
  readonly maxBytes: number;
}

export interface ImmutableJsonPacketTimeWindowListOptions
  extends ImmutableJsonPacketOperationOptions {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly partition: "hour" | "day";
  /** Bounds both exact property reads and returned windows. */
  readonly maxItems: number;
  /** Bounds aggregate declared index-head bytes. */
  readonly maxBytes: number;
}

export type ImmutableJsonPacketStorageErrorCode =
  | "ABORTED"
  | "CHECKPOINT_CONFLICT"
  | "CORRUPT_RECORD"
  | "DEADLINE_EXCEEDED"
  | "IMMUTABLE_CONFLICT"
  | "INVALID_ARGUMENT"
  | "INVALID_CONFIG"
  | "LEASE_CONFLICT"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "SCHEMA_PII_NOT_ALLOWED"
  | "SCHEMA_REJECTED"
  | "SENSITIVE_FIELD_REJECTED"
  | "STORAGE_OPERATION_FAILED";

export type ImmutableJsonPacketStorageOperation =
  | "acquire-lease"
  | "list-packets"
  | "list-time-windows"
  | "read-checkpoint"
  | "read-packet"
  | "read-time-window"
  | "release-lease"
  | "renew-lease"
  | "write-checkpoint"
  | "write-dead-letter"
  | "write-manifest"
  | "write-packet";

export interface ImmutableJsonPacketStorageDiagnostic {
  readonly code: ImmutableJsonPacketStorageErrorCode;
  readonly message: string;
  readonly operation: ImmutableJsonPacketStorageOperation;
  readonly retryable: boolean;
  readonly kind?: string;
  readonly recordType?:
    | "checkpoint"
    | "dead-letter"
    | "lease"
    | "manifest"
    | "packet"
    | "time-window-index";
}

export class ImmutableJsonPacketStorageError extends Error {
  readonly code: ImmutableJsonPacketStorageErrorCode;
  readonly diagnostic: ImmutableJsonPacketStorageDiagnostic;
  readonly cause?: { readonly redacted: true };

  constructor(
    diagnostic: ImmutableJsonPacketStorageDiagnostic,
    options: { readonly cause?: unknown } = {}
  ) {
    super(diagnostic.message);
    this.name = "ImmutableJsonPacketStorageError";
    this.code = diagnostic.code;
    this.diagnostic = Object.freeze({ ...diagnostic });
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: Object.freeze({ redacted: true }),
        configurable: true,
        enumerable: true,
        writable: false,
      });
    }
  }
}

export interface ImmutableJsonRecordReceipt {
  readonly recordType: "dead-letter" | "manifest" | "packet";
  readonly kind: string;
  readonly recordId: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly etag: string;
  readonly replayed: boolean;
}

export interface ImmutableJsonPacketReceipt
  extends ImmutableJsonRecordReceipt {
  readonly recordType: "packet";
  readonly packetId: string;
}

export interface ImmutableJsonPacketListEntry {
  readonly packetId: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ImmutableJsonPacketPage {
  readonly kind: string;
  readonly packets: readonly ImmutableJsonPacketListEntry[];
  readonly byteLength: number;
  readonly complete: boolean;
  readonly nextCursor?: string;
}

export interface ImmutableJsonPacketTimeWindowEntry
  extends ImmutableJsonPacketListEntry {
  readonly acceptedAt: string;
  readonly packet: SafeJsonValue;
}

export interface ImmutableJsonPacketTimeWindow {
  readonly kind: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly observedAt: string;
  readonly snapshot: string;
  readonly byteLength: number;
  readonly complete: true;
  readonly packets: readonly ImmutableJsonPacketTimeWindowEntry[];
}

export interface ImmutableJsonPacketTimeWindowDescriptor {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly observedAt: string;
  readonly snapshot: string;
}

export interface ImmutableJsonPacketTimeWindowList {
  readonly kind: string;
  readonly complete: true;
  readonly windows: readonly ImmutableJsonPacketTimeWindowDescriptor[];
}

export interface ImmutableJsonManifestPacket {
  readonly packetId: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ImmutableJsonManifestInput {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly revision: number;
  readonly packets: readonly ImmutableJsonManifestPacket[];
}

export interface ImmutableJsonManifestReceipt
  extends ImmutableJsonRecordReceipt {
  readonly recordType: "manifest";
  readonly entryCount: number;
}

export interface ImmutableJsonDeadLetterInput {
  readonly packetId: string;
  readonly errorCode: string;
  readonly attempt: number;
  readonly retryable: boolean;
}

export interface ImmutableJsonDeadLetterReceipt
  extends ImmutableJsonRecordReceipt {
  readonly recordType: "dead-letter";
}

export interface JsonCheckpointResult<T = unknown> {
  readonly kind: string;
  readonly name: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly value: T;
  readonly sha256: string;
  readonly byteLength: number;
  readonly etag: string;
  readonly replayed: boolean;
}

export interface JsonPacketLease {
  readonly kind: string;
  readonly name: string;
  readonly durationSeconds: number;
  readonly expiresAt: string;
  renew(options?: ImmutableJsonPacketOperationOptions): Promise<string>;
  release(options?: ImmutableJsonPacketOperationOptions): Promise<void>;
}

export interface ImmutableJsonPacketStore<K extends string = string> {
  writePacket(
    kind: K,
    packetId: string,
    packet: unknown,
    options?: ImmutableJsonPacketOperationOptions
  ): Promise<ImmutableJsonPacketReceipt>;
  readPacket(
    kind: K,
    packetId: string,
    options?: ImmutableJsonPacketOperationOptions
  ): Promise<SafeJsonValue>;
  listPacketPage(
    kind: K,
    options?: ImmutableJsonPacketListOptions
  ): Promise<ImmutableJsonPacketPage>;
  readPacketTimeWindow(
    kind: K,
    options: ImmutableJsonPacketTimeWindowOptions
  ): Promise<ImmutableJsonPacketTimeWindow>;
  listPacketTimeWindows(
    kind: K,
    options: ImmutableJsonPacketTimeWindowListOptions
  ): Promise<ImmutableJsonPacketTimeWindowList>;
  writeManifest(
    kind: K,
    manifestId: string,
    input: ImmutableJsonManifestInput,
    options?: ImmutableJsonPacketOperationOptions
  ): Promise<ImmutableJsonManifestReceipt>;
  writeDeadLetter(
    kind: K,
    deadLetterId: string,
    input: ImmutableJsonDeadLetterInput,
    options?: ImmutableJsonPacketOperationOptions
  ): Promise<ImmutableJsonDeadLetterReceipt>;
  readCheckpoint(
    kind: K,
    name: string,
    options?: ImmutableJsonPacketOperationOptions
  ): Promise<JsonCheckpointResult | undefined>;
  compareAndSwapCheckpoint(
    kind: K,
    name: string,
    expectedEtag: string | null,
    value: unknown,
    options?: ImmutableJsonPacketOperationOptions
  ): Promise<JsonCheckpointResult>;
  acquireLease(
    kind: K,
    name: string,
    options?: ImmutableJsonPacketOperationOptions & {
      readonly durationSeconds?: number;
    }
  ): Promise<JsonPacketLease>;
}

interface ResolvedKind {
  readonly kind: string;
  readonly prefix: string;
  readonly packetSchema: ResolvedSchema;
  readonly checkpointSchema?: ResolvedSchema;
  readonly safeDeadLetterCodes: ReadonlySet<string>;
  readonly maxPacketBytes: number;
  readonly timeIndex?: ResolvedTimeIndex;
}

interface ResolvedTimeIndex {
  readonly prefix: string;
  readonly timestampField: string;
  readonly partition: "hour" | "day";
}

interface ResolvedSchema {
  readonly schema: PersistableJsonSchemaPort;
  readonly id: string;
  readonly version: string;
}

interface ResolvedStoreConfig {
  readonly container: JsonPacketBlobContainerPort;
  readonly kinds: ReadonlyMap<string, ResolvedKind>;
  readonly timeoutMs: number;
  readonly maxReadBytes: number;
  readonly maxListPageItems: number;
  readonly maxListPageBytes: number;
  readonly maxManifestEntries: number;
  readonly clock: () => Date;
}

interface OperationContext {
  readonly signal: AbortSignal;
  readonly race: <T>(promise: Promise<T>) => Promise<T>;
  readonly throwIfAborted: () => void;
}

interface EncodedRecord {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly schemaId: string;
  readonly schemaVersion: string;
}

interface DownloadedRecord {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly etag: string;
}

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{2,127}$/u;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const PREFIX_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SCHEMA_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const VERSION_PATTERN = /^(?!.*(?:latest|current|next))[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;
const ETAG_PATTERN = /^[\x20-\x7e]{1,256}$/u;
const SAFE_JSON_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const LEASE_TOKEN_PATTERN = /^[\x20-\x7e]{1,256}$/u;
const BASE64URL_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DECIMAL_BYTE_LENGTH_PATTERN = /^(?:0|[1-9][0-9]{0,8})$/u;
const TIME_INDEX_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const PACKET_LIST_METADATA_KEYS = [
  "plasiusbytelength",
  "plasiuskind",
  "plasiusrecordid",
  "plasiusrecordschema",
  "plasiusrecordtype",
  "plasiusschemaid",
  "plasiusschemaversion",
  "plasiussha256",
] as const;
const TIME_WINDOW_INDEX_SCHEMA_ID = "plasiusPacketTimeWindowIndex";
const TIME_WINDOW_INDEX_SCHEMA_VERSION = "1.0.0";
const TIME_WINDOW_INDEX_METADATA_KEYS = [
  ...PACKET_LIST_METADATA_KEYS,
  "plasiusentrycount",
  "plasiusobservedat",
  "plasiussnapshot",
  "plasiuswindowend",
  "plasiuswindowstart",
] as const;
const FORBIDDEN_PREFIX_SEGMENTS = new Set([
  ".",
  "..",
  "_control",
  "_dead-letters",
  "_manifests",
  "http",
  "https",
]);
const FORBIDDEN_PACKET_KEYS = new Set([
  "account",
  "accountid",
  "address",
  "attachment",
  "auth",
  "authorization",
  "body",
  "clienttimestamp",
  "ciphertext",
  "comment",
  "content",
  "cookie",
  "coordinates",
  "description",
  "email",
  "embedding",
  "filename",
  "hash",
  "headers",
  "html",
  "identity",
  "ip",
  "ipaddress",
  "locale",
  "message",
  "name",
  "narrative",
  "network",
  "phone",
  "pixel",
  "postcode",
  "prompt",
  "pseudonym",
  "quote",
  "raw",
  "referrer",
  "reporter",
  "request",
  "response",
  "screenshot",
  "session",
  "sessionid",
  "subject",
  "summary",
  "text",
  "token",
  "trace",
  "url",
  "userid",
  "useragent",
  "username",
]);
const EMAIL_PATTERN = /(^|[^\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}($|[^\p{L}\p{N}])/iu;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)/iu;
const LEASE_CONFLICT_CODES = new Set([
  "LeaseAlreadyAcquired",
  "LeaseAlreadyPresent",
  "LeaseIdMismatchWithBlobOperation",
  "LeaseIdMismatchWithLeaseOperation",
  "LeaseIdMissing",
  "LeaseIsBreakingAndCannotBeAcquired",
  "LeaseIsBrokenAndCannotBeRenewed",
  "LeaseLost",
  "LeaseNotPresentWithBlobOperation",
  "LeaseNotPresentWithLeaseOperation",
]);
const RELEASE_ALREADY_COMPLETE_CODES = new Set([
  "LeaseIdMismatchWithBlobOperation",
  "LeaseIdMismatchWithLeaseOperation",
  "LeaseIdMissing",
  "LeaseLost",
  "LeaseNotPresentWithBlobOperation",
  "LeaseNotPresentWithLeaseOperation",
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(
  code: ImmutableJsonPacketStorageErrorCode,
  message: string,
  operation: ImmutableJsonPacketStorageOperation,
  options: {
    readonly retryable?: boolean;
    readonly kind?: string;
    readonly recordType?: ImmutableJsonPacketStorageDiagnostic["recordType"];
    readonly cause?: unknown;
  } = {}
): never {
  throw new ImmutableJsonPacketStorageError(
    {
      code,
      message,
      operation,
      retryable: options.retryable ?? false,
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      ...(options.recordType === undefined
        ? {}
        : { recordType: options.recordType }),
    },
    { cause: options.cause }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function normalizeKind(
  kind: unknown,
  operation: ImmutableJsonPacketStorageOperation
): string {
  if (typeof kind !== "string" || !KIND_PATTERN.test(kind)) {
    fail("INVALID_ARGUMENT", "The packet kind is invalid.", operation);
  }
  return kind;
}

function normalizeIdentifier(
  value: unknown,
  operation: ImmutableJsonPacketStorageOperation
): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    fail("INVALID_ARGUMENT", "The record identifier is invalid.", operation);
  }
  return value;
}

function normalizeTimestamp(
  value: unknown,
  operation: ImmutableJsonPacketStorageOperation
): string {
  if (!isCanonicalTimestamp(value)) {
    fail("INVALID_ARGUMENT", "A canonical UTC timestamp is required.", operation);
  }
  return value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return (
    Number.isFinite(timestamp.getTime()) &&
    timestamp.toISOString() === value
  );
}

function isTimeIndexTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIME_INDEX_TIMESTAMP_PATTERN.test(value) &&
    isCanonicalTimestamp(value)
  );
}

interface TimeWindowBounds {
  readonly windowStart: string;
  readonly windowEnd: string;
}

interface TimeWindowIndexEntry {
  readonly acceptedAt: string;
  readonly packetId: string;
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly sha256: string;
  readonly byteLength: number;
}

interface StoredTimeWindowIndex extends TimeWindowBounds {
  readonly recordId: string;
  readonly observedAt: string;
  readonly snapshot: string;
  readonly entries: readonly TimeWindowIndexEntry[];
}

function partitionMilliseconds(partition: "hour" | "day"): number {
  return partition === "hour" ? 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000;
}

function alignedPartitionBounds(
  timestamp: string,
  partition: "hour" | "day"
): TimeWindowBounds {
  const instant = new Date(timestamp);
  if (partition === "hour") {
    instant.setUTCMinutes(0, 0, 0);
  } else {
    instant.setUTCHours(0, 0, 0, 0);
  }
  const windowStart = instant.toISOString();
  const windowEnd = new Date(
    instant.getTime() + partitionMilliseconds(partition)
  ).toISOString();
  return Object.freeze({ windowStart, windowEnd });
}

function timeWindowRecordId(
  windowStart: string,
  partition: "hour" | "day"
): string {
  const compact = windowStart
    .slice(0, partition === "hour" ? 13 : 10)
    .replace(/[-:]/gu, "")
    .replace("T", "t");
  return `window_${compact}`;
}

function timeWindowPath(
  timeIndex: ResolvedTimeIndex,
  windowStart: string
): string {
  const date = new Date(windowStart);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  return timeIndex.partition === "hour"
    ? `${timeIndex.prefix}/windows/${year}/${month}/${day}/${hour}.json`
    : `${timeIndex.prefix}/windows/${year}/${month}/${day}.json`;
}

function assertExactTimeWindow(
  windowStartInput: unknown,
  windowEndInput: unknown,
  partition: "hour" | "day",
  operation: "read-time-window" | "list-time-windows",
  kind: string,
  requireSinglePartition: boolean
): TimeWindowBounds {
  const windowStart = normalizeTimestamp(windowStartInput, operation);
  const windowEnd = normalizeTimestamp(windowEndInput, operation);
  const alignedStart = alignedPartitionBounds(windowStart, partition);
  if (
    !isTimeIndexTimestamp(windowStart) ||
    !isTimeIndexTimestamp(windowEnd) ||
    !isTimeIndexTimestamp(alignedStart.windowEnd) ||
    alignedStart.windowStart !== windowStart ||
    windowEnd <= windowStart
  ) {
    fail("INVALID_ARGUMENT", "The accepted-time window is not aligned.", operation, {
      kind,
      recordType: "time-window-index",
    });
  }
  if (requireSinglePartition) {
    if (alignedStart.windowEnd !== windowEnd) {
      fail("INVALID_ARGUMENT", "Exactly one aligned partition is required.", operation, {
        kind,
        recordType: "time-window-index",
      });
    }
  } else {
    const alignedEnd = alignedPartitionBounds(windowEnd, partition);
    if (alignedEnd.windowStart !== windowEnd) {
      fail("INVALID_ARGUMENT", "The accepted-time window is not aligned.", operation, {
        kind,
        recordType: "time-window-index",
      });
    }
  }
  return Object.freeze({ windowStart, windowEnd });
}

function compareTimeWindowEntries(
  left: TimeWindowIndexEntry,
  right: TimeWindowIndexEntry
): number {
  if (left.acceptedAt !== right.acceptedAt) {
    return left.acceptedAt < right.acceptedAt ? -1 : 1;
  }
  return left.packetId < right.packetId
    ? -1
    : left.packetId > right.packetId
      ? 1
      : 0;
}

function timeWindowIndexEntryLimit(configured: number): number {
  return Math.min(configured, MAX_TIME_WINDOW_INDEX_ENTRIES);
}

function timeWindowIndexMemberLimit(entryLimit: number): number {
  return Math.max(MAX_JSON_MEMBERS, 32 + entryLimit * 7);
}

function timeWindowSnapshot(
  kind: string,
  bounds: TimeWindowBounds,
  entries: readonly TimeWindowIndexEntry[],
  operation: ImmutableJsonPacketStorageOperation
): string {
  const membership = snapshotJson(
    {
      kind,
      windowStart: bounds.windowStart,
      windowEnd: bounds.windowEnd,
      entries: entries.map((entry) => ({
        acceptedAt: entry.acceptedAt,
        packetId: entry.packetId,
        schemaId: entry.schemaId,
        schemaVersion: entry.schemaVersion,
        sha256: entry.sha256,
        byteLength: entry.byteLength,
      })),
    },
    operation,
    false,
    timeWindowIndexMemberLimit(entries.length)
  );
  return sha256(encodeCanonical(membership));
}

function nextObservedAt(candidate: Date, previous?: string): string {
  const candidateMs = candidate.getTime();
  const previousMs = previous === undefined ? -1 : new Date(previous).getTime();
  return new Date(Math.max(candidateMs, previousMs + 1)).toISOString();
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function hasUnsupportedControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (
      (codePoint >= 0 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    ) {
      return true;
    }
  }
  return false;
}

function assertSafeString(
  value: string,
  operation: ImmutableJsonPacketStorageOperation
): void {
  if (
    Buffer.byteLength(value, "utf8") > MAX_JSON_STRING_BYTES ||
    hasUnsupportedControlCharacter(value) ||
    EMAIL_PATTERN.test(value) ||
    URL_PATTERN.test(value)
  ) {
    fail(
      "SENSITIVE_FIELD_REJECTED",
      "The record contains content outside the structured storage allowlist.",
      operation
    );
  }
}

function assertSafeObjectKey(
  key: string,
  operation: ImmutableJsonPacketStorageOperation,
  enforcePrivacy: boolean
): void {
  if (
    Buffer.byteLength(key, "utf8") > 128 ||
    !SAFE_JSON_KEY_PATTERN.test(key) ||
    hasUnsupportedControlCharacter(key) ||
    EMAIL_PATTERN.test(key) ||
    URL_PATTERN.test(key) ||
    (enforcePrivacy && FORBIDDEN_PACKET_KEYS.has(normalizedKey(key)))
  ) {
    fail(
      enforcePrivacy ? "SENSITIVE_FIELD_REJECTED" : "INVALID_ARGUMENT",
      enforcePrivacy
        ? "The record contains a field outside the structured storage allowlist."
        : "The JSON object contains an unsafe key.",
      operation
    );
  }
}

function snapshotJson(
  input: unknown,
  operation: ImmutableJsonPacketStorageOperation,
  enforcePrivacy: boolean,
  maxMembers = MAX_JSON_MEMBERS
): SafeJsonValue {
  const seen = new Set<object>();
  let memberCount = 0;

  const visit = (value: unknown, depth: number): SafeJsonValue => {
    if (depth > MAX_JSON_DEPTH) {
      fail("LIMIT_EXCEEDED", "The JSON record exceeds the nesting limit.", operation);
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (enforcePrivacy) assertSafeString(value, operation);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        fail("INVALID_ARGUMENT", "JSON numbers must be finite.", operation);
      }
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== "object") {
      fail("INVALID_ARGUMENT", "The value is not safe structured JSON.", operation);
    }
    if (seen.has(value)) {
      fail("INVALID_ARGUMENT", "Cyclic JSON records are not supported.", operation);
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
          fail("INVALID_ARGUMENT", "Only plain JSON arrays are supported.", operation);
        }
        if (
          !Number.isSafeInteger(value.length) ||
          value.length > maxMembers - memberCount
        ) {
          fail("LIMIT_EXCEEDED", "The JSON record has too many members.", operation);
        }
        memberCount += value.length;
        const ownKeys = Reflect.ownKeys(value);
        if (
          ownKeys.some((key) => typeof key === "symbol") ||
          ownKeys.length !== value.length + 1 ||
          !Object.prototype.hasOwnProperty.call(value, "length")
        ) {
          fail("INVALID_ARGUMENT", "JSON arrays must be dense data arrays.", operation);
        }
        const output: SafeJsonValue[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (
            !descriptor ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            fail("INVALID_ARGUMENT", "JSON arrays must contain data entries.", operation);
          }
          output.push(visit(descriptor.value, depth + 1));
        }
        return Object.freeze(output);
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        fail("INVALID_ARGUMENT", "Only plain JSON objects are supported.", operation);
      }
      const source = value as Record<string, unknown>;
      const keys = Reflect.ownKeys(source);
      if (keys.some((key) => typeof key === "symbol")) {
        fail("INVALID_ARGUMENT", "JSON objects may not contain symbol keys.", operation);
      }
      memberCount += keys.length;
      if (memberCount > maxMembers) {
        fail("LIMIT_EXCEEDED", "The JSON record has too many members.", operation);
      }
      const output = Object.create(null) as Record<string, SafeJsonValue>;
      for (const key of (keys as string[]).sort()) {
        if (
          key === "__proto__" ||
          key === "constructor" ||
          key === "prototype"
        ) {
          fail(
            enforcePrivacy ? "SENSITIVE_FIELD_REJECTED" : "INVALID_ARGUMENT",
            enforcePrivacy
              ? "The record contains a field outside the structured storage allowlist."
              : "The JSON object contains a forbidden key.",
            operation
          );
        }
        assertSafeObjectKey(key, operation, enforcePrivacy);
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          fail("INVALID_ARGUMENT", "JSON objects must use enumerable data properties.", operation);
        }
        output[key] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(output);
    } finally {
      seen.delete(value);
    }
  };

  return visit(input, 0);
}

function encodeCanonical(value: SafeJsonValue): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function packetListCursorScope(kind: string, prefix: string): string {
  return sha256(encoder.encode(`packet-list\u0000${kind}\u0000${prefix}`));
}

function hasCursorControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function validProviderContinuation(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROVIDER_CONTINUATION_BYTES &&
    Buffer.byteLength(value, "utf8") <= MAX_PROVIDER_CONTINUATION_BYTES &&
    !hasCursorControlCharacter(value)
  );
}

function encodePacketListCursor(
  kind: string,
  prefix: string,
  continuationToken: unknown
): string {
  if (!validProviderContinuation(continuationToken)) {
    fail(
      "CORRUPT_RECORD",
      "Blob storage returned an invalid packet-list continuation.",
      "list-packets",
      { kind, recordType: "packet" }
    );
  }
  const encoded = Buffer.from(
    JSON.stringify({
      continuation: continuationToken,
      scope: packetListCursorScope(kind, prefix),
      version: 1,
    }),
    "utf8"
  ).toString("base64url");
  if (Buffer.byteLength(encoded, "ascii") > MAX_ENCODED_CURSOR_BYTES) {
    fail(
      "CORRUPT_RECORD",
      "Blob storage returned an invalid packet-list continuation.",
      "list-packets",
      { kind, recordType: "packet" }
    );
  }
  return encoded;
}

function decodePacketListCursor(
  kind: string,
  prefix: string,
  cursor: unknown
): string | undefined {
  if (cursor === undefined) return undefined;
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > MAX_ENCODED_CURSOR_BYTES ||
    Buffer.byteLength(cursor, "ascii") > MAX_ENCODED_CURSOR_BYTES ||
    !BASE64URL_CURSOR_PATTERN.test(cursor)
  ) {
    fail("INVALID_ARGUMENT", "The packet-list cursor is invalid.", "list-packets", {
      kind,
      recordType: "packet",
    });
  }

  let decoded: unknown;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("non-canonical");
    decoded = JSON.parse(decoder.decode(bytes));
  } catch {
    fail("INVALID_ARGUMENT", "The packet-list cursor is invalid.", "list-packets", {
      kind,
      recordType: "packet",
    });
  }
  if (
    !isRecord(decoded) ||
    !hasExactKeys(decoded, ["continuation", "scope", "version"]) ||
    decoded.version !== 1 ||
    decoded.scope !== packetListCursorScope(kind, prefix) ||
    !validProviderContinuation(decoded.continuation)
  ) {
    fail("INVALID_ARGUMENT", "The packet-list cursor is invalid.", "list-packets", {
      kind,
      recordType: "packet",
    });
  }
  return decoded.continuation;
}

function exactBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function resolvePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > maximum
  ) {
    fail("INVALID_CONFIG", `${label} is outside its supported bounds.`, "write-packet");
  }
  return resolved;
}

function resolveTimeout(
  value: number | undefined,
  fallback: number,
  operation: ImmutableJsonPacketStorageOperation
): number {
  const timeout = value ?? fallback;
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_OPERATION_TIMEOUT_MS
  ) {
    fail("INVALID_ARGUMENT", "timeoutMs is outside its supported bounds.", operation);
  }
  return timeout;
}

function resolvePacketListLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: "maxBytes" | "maxItems",
  kind: string
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > maximum
  ) {
    fail(
      "INVALID_ARGUMENT",
      `${label} is outside the configured packet-list bounds.`,
      "list-packets",
      { kind, recordType: "packet" }
    );
  }
  return resolved;
}

function resolveTimeWindowLimit(
  value: number,
  maximum: number,
  label: "maxBytes" | "maxItems",
  operation: "list-time-windows" | "read-time-window",
  kind: string
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(
      "INVALID_ARGUMENT",
      `${label} is outside the configured accepted-time window bounds.`,
      operation,
      { kind, recordType: "time-window-index" }
    );
  }
  return value;
}

function resolveSchema(
  candidate: unknown,
  operation: ImmutableJsonPacketStorageOperation
): ResolvedSchema {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof (candidate as PersistableJsonSchemaPort).validate !== "function" ||
    typeof (candidate as PersistableJsonSchemaPort).getPiiAudit !== "function"
  ) {
    fail("INVALID_CONFIG", "A schema validation port is required.", operation);
  }
  const schema = candidate as PersistableJsonSchemaPort;
  const id = schema.meta?.entityType;
  const version = schema.meta?.version;
  if (
    typeof id !== "string" ||
    !SCHEMA_ID_PATTERN.test(id) ||
    typeof version !== "string" ||
    !VERSION_PATTERN.test(version)
  ) {
    fail("INVALID_CONFIG", "The schema identity is invalid.", operation);
  }
  let audit: ReturnType<PersistableJsonSchemaPort["getPiiAudit"]>;
  try {
    audit = schema.getPiiAudit();
  } catch (cause) {
    fail("INVALID_CONFIG", "The schema PII audit could not be evaluated.", operation, {
      cause,
    });
  }
  if (!Array.isArray(audit)) {
    fail("INVALID_CONFIG", "The schema must expose a complete PII audit.", operation);
  }
  if (audit.length > 0) {
    fail(
      "SCHEMA_PII_NOT_ALLOWED",
      "Schemas containing PII fields cannot be registered for packet storage.",
      operation
    );
  }
  return Object.freeze({ schema, id, version });
}

function normalizePrefix(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) {
    fail("INVALID_CONFIG", "The fixed packet prefix is invalid.", "write-packet");
  }
  const segments = value.split("/");
  if (
    segments.length < 2 ||
    segments.length > 6 ||
    segments.some(
      (segment) =>
        !PREFIX_SEGMENT_PATTERN.test(segment) ||
        FORBIDDEN_PREFIX_SEGMENTS.has(segment)
    )
  ) {
    fail("INVALID_CONFIG", "The fixed packet prefix is invalid.", "write-packet");
  }
  return segments.join("/");
}

function resolveTimeIndex(candidate: unknown): ResolvedTimeIndex | undefined {
  if (candidate === undefined) return undefined;
  if (
    !isRecord(candidate) ||
    !hasExactKeys(candidate, ["partition", "prefix", "timestampField"])
  ) {
    fail("INVALID_CONFIG", "The accepted-time index configuration is invalid.", "write-packet");
  }
  const prefix = normalizePrefix(candidate.prefix);
  const timestampField = candidate.timestampField;
  if (
    typeof timestampField !== "string" ||
    !SAFE_JSON_KEY_PATTERN.test(timestampField) ||
    timestampField === "constructor" ||
    timestampField === "prototype" ||
    FORBIDDEN_PACKET_KEYS.has(normalizedKey(timestampField)) ||
    (candidate.partition !== "hour" && candidate.partition !== "day")
  ) {
    fail("INVALID_CONFIG", "The accepted-time index configuration is invalid.", "write-packet");
  }
  return Object.freeze({
    prefix,
    timestampField,
    partition: candidate.partition,
  });
}

function validateSchemaValue(
  schema: ResolvedSchema,
  input: unknown,
  operation: ImmutableJsonPacketStorageOperation
): SafeJsonValue {
  const safeInput = snapshotJson(input, operation, true);
  let result: PersistableJsonValidationResult<unknown>;
  try {
    result = schema.schema.validate(safeInput);
  } catch (cause) {
    fail(
      "SCHEMA_REJECTED",
      "The structured record did not pass its registered schema.",
      operation,
      { cause }
    );
  }
  if (!result || result.valid !== true || result.value === undefined) {
    fail(
      "SCHEMA_REJECTED",
      "The structured record did not pass its registered schema.",
      operation
    );
  }
  return snapshotJson(result.value, operation, true);
}

function prepareRecord(
  envelope: SafeJsonValue,
  recordType: string,
  kind: string,
  recordId: string,
  schemaId: string,
  schemaVersion: string,
  maxBytes: number,
  operation: ImmutableJsonPacketStorageOperation,
  extraMetadata: Readonly<Record<string, string>> = {}
): EncodedRecord {
  const bytes = encodeCanonical(envelope);
  if (bytes.byteLength > maxBytes) {
    fail("LIMIT_EXCEEDED", "The encoded JSON record exceeds its byte limit.", operation, {
      kind,
    });
  }
  const digest = sha256(bytes);
  return Object.freeze({
    bytes,
    digest,
    schemaId,
    schemaVersion,
    metadata: Object.freeze({
      plasiusbytelength: String(bytes.byteLength),
      plasiuskind: kind,
      plasiusrecordid: recordId,
      plasiusrecordschema: IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA,
      plasiusrecordtype: recordType,
      plasiusschemaid: schemaId,
      plasiusschemaversion: schemaVersion,
      plasiussha256: digest,
      ...extraMetadata,
    }),
  });
}

function prepareTimeWindowIndex(
  kind: ResolvedKind,
  bounds: TimeWindowBounds,
  observedAt: string,
  entries: readonly TimeWindowIndexEntry[],
  operation: ImmutableJsonPacketStorageOperation,
  maxBytes: number
): { readonly prepared: EncodedRecord; readonly index: StoredTimeWindowIndex } {
  const recordId = timeWindowRecordId(
    bounds.windowStart,
    kind.timeIndex?.partition ?? "hour"
  );
  const snapshot = timeWindowSnapshot(kind.kind, bounds, entries, operation);
  const envelope = snapshotJson(
    {
      storageSchema: IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA,
      recordType: "time-window-index",
      kind: kind.kind,
      recordId,
      schema: {
        id: TIME_WINDOW_INDEX_SCHEMA_ID,
        version: TIME_WINDOW_INDEX_SCHEMA_VERSION,
      },
      windowStart: bounds.windowStart,
      windowEnd: bounds.windowEnd,
      observedAt,
      snapshot,
      entryCount: entries.length,
      entries,
    },
    operation,
    false,
    timeWindowIndexMemberLimit(entries.length)
  );
  const prepared = prepareRecord(
    envelope,
    "time-window-index",
    kind.kind,
    recordId,
    TIME_WINDOW_INDEX_SCHEMA_ID,
    TIME_WINDOW_INDEX_SCHEMA_VERSION,
    maxBytes,
    operation,
    {
      plasiusentrycount: String(entries.length),
      plasiusobservedat: observedAt,
      plasiussnapshot: snapshot,
      plasiuswindowend: bounds.windowEnd,
      plasiuswindowstart: bounds.windowStart,
    }
  );
  return Object.freeze({
    prepared,
    index: Object.freeze({
      recordId,
      windowStart: bounds.windowStart,
      windowEnd: bounds.windowEnd,
      observedAt,
      snapshot,
      entries: Object.freeze([...entries]),
    }),
  });
}

function parseTimeWindowIndex(
  downloaded: DownloadedRecord,
  kind: ResolvedKind,
  bounds: TimeWindowBounds,
  operation: "read-time-window" | "list-time-windows" | "write-packet",
  maxBytes: number,
  maxEntries: number
): StoredTimeWindowIndex {
  const parsed = parseStoredJson(
    downloaded,
    operation,
    kind.kind,
    timeWindowIndexMemberLimit(maxEntries)
  );
  const partition = kind.timeIndex?.partition;
  const expectedRecordId =
    partition === undefined
      ? ""
      : timeWindowRecordId(bounds.windowStart, partition);
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "entries",
      "entryCount",
      "kind",
      "observedAt",
      "recordId",
      "recordType",
      "schema",
      "snapshot",
      "storageSchema",
      "windowEnd",
      "windowStart",
    ]) ||
    parsed.storageSchema !== IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA ||
    parsed.recordType !== "time-window-index" ||
    parsed.kind !== kind.kind ||
    parsed.recordId !== expectedRecordId ||
    parsed.windowStart !== bounds.windowStart ||
    parsed.windowEnd !== bounds.windowEnd ||
    !isTimeIndexTimestamp(parsed.observedAt) ||
    typeof parsed.snapshot !== "string" ||
    !SHA256_PATTERN.test(parsed.snapshot) ||
    !Number.isSafeInteger(parsed.entryCount) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length !== parsed.entryCount ||
    parsed.entries.length > maxEntries ||
    !isRecord(parsed.schema) ||
    !hasExactKeys(parsed.schema, ["id", "version"]) ||
    parsed.schema.id !== TIME_WINDOW_INDEX_SCHEMA_ID ||
    parsed.schema.version !== TIME_WINDOW_INDEX_SCHEMA_VERSION
  ) {
    fail("CORRUPT_RECORD", "The accepted-time index is invalid.", operation, {
      kind: kind.kind,
      recordType: "time-window-index",
    });
  }

  const seen = new Set<string>();
  const entries = (parsed.entries as readonly unknown[]).map((value) => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "acceptedAt",
        "byteLength",
        "packetId",
        "schemaId",
        "schemaVersion",
        "sha256",
      ]) ||
      !isTimeIndexTimestamp(value.acceptedAt) ||
      value.acceptedAt < bounds.windowStart ||
      value.acceptedAt >= bounds.windowEnd ||
      typeof value.packetId !== "string" ||
      !IDENTIFIER_PATTERN.test(value.packetId) ||
      seen.has(value.packetId) ||
      value.schemaId !== kind.packetSchema.id ||
      value.schemaVersion !== kind.packetSchema.version ||
      typeof value.sha256 !== "string" ||
      !SHA256_PATTERN.test(value.sha256) ||
      !Number.isSafeInteger(value.byteLength) ||
      (value.byteLength as number) < 1 ||
      (value.byteLength as number) > kind.maxPacketBytes
    ) {
      fail("CORRUPT_RECORD", "The accepted-time index is invalid.", operation, {
        kind: kind.kind,
        recordType: "time-window-index",
      });
    }
    seen.add(value.packetId);
    return Object.freeze({
      acceptedAt: value.acceptedAt,
      packetId: value.packetId,
      schemaId: value.schemaId,
      schemaVersion: value.schemaVersion,
      sha256: value.sha256,
      byteLength: value.byteLength as number,
    });
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (compareTimeWindowEntries(entries[index - 1] as TimeWindowIndexEntry, entries[index] as TimeWindowIndexEntry) >= 0) {
      fail("CORRUPT_RECORD", "The accepted-time index is not canonically ordered.", operation, {
        kind: kind.kind,
        recordType: "time-window-index",
      });
    }
  }
  const expectedSnapshot = timeWindowSnapshot(kind.kind, bounds, entries, operation);
  if (parsed.snapshot !== expectedSnapshot) {
    fail("CORRUPT_RECORD", "The accepted-time index snapshot is invalid.", operation, {
      kind: kind.kind,
      recordType: "time-window-index",
    });
  }
  const expected = prepareTimeWindowIndex(
    kind,
    bounds,
    parsed.observedAt,
    entries,
    operation,
    maxBytes
  );
  assertDownloadedRecord(
    downloaded,
    expected.prepared,
    operation,
    kind.kind,
    "CORRUPT_RECORD"
  );
  return expected.index;
}

function storageToken(error: unknown): {
  readonly status?: number;
  readonly code?: string;
} {
  if (!isRecord(error)) return {};
  const statusDescriptor =
    Object.getOwnPropertyDescriptor(error, "statusCode") ??
    Object.getOwnPropertyDescriptor(error, "status");
  const codeDescriptor = Object.getOwnPropertyDescriptor(error, "code");
  const status =
    statusDescriptor && "value" in statusDescriptor &&
    typeof statusDescriptor.value === "number"
      ? statusDescriptor.value
      : undefined;
  const code =
    codeDescriptor && "value" in codeDescriptor &&
    typeof codeDescriptor.value === "string"
      ? codeDescriptor.value
      : undefined;
  return {
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
  };
}

function isNotFound(error: unknown): boolean {
  const { status, code } = storageToken(error);
  return code === "BlobNotFound" || (status === 404 && code !== "ContainerNotFound");
}

function isBlobConditionalConflict(error: unknown): boolean {
  const { status, code } = storageToken(error);
  return (
    status === 412 ||
    code === "BlobAlreadyExists" ||
    code === "ConditionNotMet"
  );
}

function isLeaseConflict(error: unknown): boolean {
  const { code } = storageToken(error);
  return code !== undefined && LEASE_CONFLICT_CODES.has(code);
}

function isReleaseAlreadyComplete(error: unknown): boolean {
  const { code } = storageToken(error);
  return code !== undefined && RELEASE_ALREADY_COMPLETE_CODES.has(code);
}

function providerEtag(
  value: unknown,
  operation: ImmutableJsonPacketStorageOperation,
  kind: string,
  source: "download" | "write",
  recordType?: ImmutableJsonPacketStorageDiagnostic["recordType"]
): string {
  if (
    typeof value !== "string" ||
    !ETAG_PATTERN.test(value) ||
    value === "*"
  ) {
    fail(
      source === "download" ? "CORRUPT_RECORD" : "STORAGE_OPERATION_FAILED",
      source === "download"
        ? "The JSON record response has an invalid ETag."
        : "Blob storage did not return a valid ETag.",
      operation,
      {
        kind,
        ...(recordType === undefined ? {} : { recordType }),
        retryable: source === "write",
      }
    );
  }
  return value;
}

function assertProviderLeaseToken(
  value: unknown,
  operation: "acquire-lease" | "renew-lease",
  kind: string
): void {
  if (
    typeof value !== "string" ||
    !LEASE_TOKEN_PATTERN.test(value) ||
    value === "*"
  ) {
    fail(
      "STORAGE_OPERATION_FAILED",
      operation === "acquire-lease"
        ? "Lease acquisition did not return a valid lease token."
        : "Lease renewal did not return a valid lease token.",
      operation,
      { kind, recordType: "lease", retryable: true }
    );
  }
}

function asStorageFailure(
  error: unknown,
  operation: ImmutableJsonPacketStorageOperation,
  kind: string,
  recordType?: ImmutableJsonPacketStorageDiagnostic["recordType"]
): ImmutableJsonPacketStorageError {
  if (error instanceof ImmutableJsonPacketStorageError) return error;
  const { status } = storageToken(error);
  return new ImmutableJsonPacketStorageError(
    {
      code: "STORAGE_OPERATION_FAILED",
      message: "The Blob storage operation failed.",
      operation,
      retryable:
        status === undefined ||
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status >= 500,
      kind,
      ...(recordType === undefined ? {} : { recordType }),
    },
    { cause: error }
  );
}

async function withContext<T>(
  operation: ImmutableJsonPacketStorageOperation,
  kind: string,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
  work: (context: OperationContext) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let code: "ABORTED" | "DEADLINE_EXCEEDED" = "ABORTED";
  const abort = (nextCode: "ABORTED" | "DEADLINE_EXCEEDED") => {
    if (!controller.signal.aborted) {
      code = nextCode;
      controller.abort();
    }
  };
  const onExternalAbort = () => abort("ABORTED");
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => abort("DEADLINE_EXCEEDED"), timeoutMs);
  const interruption = () =>
    new ImmutableJsonPacketStorageError({
      code,
      message:
        code === "DEADLINE_EXCEEDED"
          ? "The storage operation exceeded its deadline."
          : "The storage operation was aborted.",
      operation,
      retryable: true,
      kind,
    });
  const context: OperationContext = {
    signal: controller.signal,
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

function snapshotProviderDataRecord(
  value: unknown,
  selectedKeys: readonly string[] | undefined,
  maxProperties: number,
  operation: ImmutableJsonPacketStorageOperation,
  kind: string,
  recordType: ImmutableJsonPacketStorageDiagnostic["recordType"]
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) {
    fail("CORRUPT_RECORD", "Blob storage returned invalid response data.", operation, {
      kind,
      recordType,
    });
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    if (
      Array.isArray(value) ||
      (prototype !== Object.prototype && prototype !== null)
    ) {
      fail("CORRUPT_RECORD", "Blob storage returned invalid response data.", operation, {
        kind,
        recordType,
      });
    }

    const keys: readonly (string | symbol)[] =
      selectedKeys ?? Reflect.ownKeys(value);
    if (keys.length > maxProperties) {
      fail("CORRUPT_RECORD", "Blob storage returned invalid response data.", operation, {
        kind,
        recordType,
      });
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") {
        fail("CORRUPT_RECORD", "Blob storage returned invalid response data.", operation, {
          kind,
          recordType,
        });
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!("value" in descriptor)) {
        fail("CORRUPT_RECORD", "Blob storage returned invalid response data.", operation, {
          kind,
          recordType,
        });
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof ImmutableJsonPacketStorageError) throw error;
    fail("CORRUPT_RECORD", "Blob storage returned invalid response data.", operation, {
      kind,
      recordType,
      cause: error,
    });
  }
}

function normalizeMetadata(
  metadata: unknown,
  operation: ImmutableJsonPacketStorageOperation,
  kind: string
): Readonly<Record<string, string>> {
  if (!metadata || !isRecord(metadata)) {
    fail("CORRUPT_RECORD", "The JSON record is missing integrity metadata.", operation, {
      kind,
    });
  }
  const output = Object.create(null) as Record<string, string>;
  const entries = Object.entries(metadata);
  if (entries.length > 32) {
    fail("CORRUPT_RECORD", "The JSON record has invalid integrity metadata.", operation, {
      kind,
    });
  }
  for (const [key, value] of entries) {
    if (key.length > 128) {
      fail("CORRUPT_RECORD", "The JSON record has invalid integrity metadata.", operation, {
        kind,
      });
    }
    const normalized = key.toLowerCase();
    if (
      typeof value !== "string" ||
      !/^[a-z0-9]{1,128}$/u.test(normalized) ||
      Buffer.byteLength(value, "utf8") > 1_024 ||
      hasCursorControlCharacter(value) ||
      Object.prototype.hasOwnProperty.call(output, normalized)
    ) {
      fail("CORRUPT_RECORD", "The JSON record has invalid integrity metadata.", operation, {
        kind,
      });
    }
    output[normalized] = value;
  }
  return Object.freeze(output);
}

function packetListEntry(
  kind: ResolvedKind,
  item: unknown
): ImmutableJsonPacketListEntry {
  const packetPrefix = `${kind.prefix}/packets/`;
  if (!isRecord(item) || typeof item.name !== "string") {
    fail(
      "CORRUPT_RECORD",
      "Blob storage returned an invalid packet-list item.",
      "list-packets",
      { kind: kind.kind, recordType: "packet" }
    );
  }
  if (
    item.name.length > packetPrefix.length + 133 ||
    Buffer.byteLength(item.name, "utf8") > packetPrefix.length + 133
  ) {
    fail(
      "CORRUPT_RECORD",
      "Blob storage returned an invalid packet-list item.",
      "list-packets",
      { kind: kind.kind, recordType: "packet" }
    );
  }
  const suffix = item.name.startsWith(packetPrefix)
    ? item.name.slice(packetPrefix.length)
    : "";
  const packetId = suffix.endsWith(".json")
    ? suffix.slice(0, -".json".length)
    : "";
  if (
    !IDENTIFIER_PATTERN.test(packetId) ||
    suffix !== `${packetId}.json`
  ) {
    fail(
      "CORRUPT_RECORD",
      "Blob storage returned an invalid packet-list item.",
      "list-packets",
      { kind: kind.kind, recordType: "packet" }
    );
  }
  if (!isRecord(item.properties)) {
    fail(
      "CORRUPT_RECORD",
      "Blob storage returned invalid packet-list properties.",
      "list-packets",
      { kind: kind.kind, recordType: "packet" }
    );
  }
  const contentLength = item.properties.contentLength;
  if (
    !Number.isSafeInteger(contentLength) ||
    (contentLength as number) < 1 ||
    (contentLength as number) > kind.maxPacketBytes ||
    item.properties.contentType !== IMMUTABLE_JSON_PACKET_CONTENT_TYPE
  ) {
    fail(
      "CORRUPT_RECORD",
      "Blob storage returned invalid packet-list properties.",
      "list-packets",
      { kind: kind.kind, recordType: "packet" }
    );
  }
  providerEtag(
    item.properties.etag,
    "list-packets",
    kind.kind,
    "download",
    "packet"
  );
  const metadata = normalizeMetadata(
    isRecord(item.metadata)
      ? (item.metadata as Readonly<Record<string, string>>)
      : undefined,
    "list-packets",
    kind.kind
  );
  if (!hasExactKeys(metadata, PACKET_LIST_METADATA_KEYS)) {
    fail(
      "CORRUPT_RECORD",
      "Blob storage returned invalid packet-list metadata.",
      "list-packets",
      { kind: kind.kind, recordType: "packet" }
    );
  }
  const declaredLength = metadata.plasiusbytelength;
  if (
    !DECIMAL_BYTE_LENGTH_PATTERN.test(declaredLength) ||
    Number(declaredLength) !== contentLength ||
    metadata.plasiuskind !== kind.kind ||
    metadata.plasiusrecordid !== packetId ||
    metadata.plasiusrecordschema !== IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA ||
    metadata.plasiusrecordtype !== "packet" ||
    metadata.plasiusschemaid !== kind.packetSchema.id ||
    metadata.plasiusschemaversion !== kind.packetSchema.version ||
    !SHA256_PATTERN.test(metadata.plasiussha256)
  ) {
    fail(
      "CORRUPT_RECORD",
      "Blob storage returned invalid packet-list metadata.",
      "list-packets",
      { kind: kind.kind, recordType: "packet" }
    );
  }
  return Object.freeze({
    packetId,
    schemaId: kind.packetSchema.id,
    schemaVersion: kind.packetSchema.version,
    sha256: metadata.plasiussha256,
    byteLength: contentLength as number,
  });
}

async function downloadRecord(
  config: ResolvedStoreConfig,
  kind: string,
  path: string,
  maxBytes: number,
  operation: ImmutableJsonPacketStorageOperation,
  context: OperationContext
): Promise<DownloadedRecord> {
  let response: JsonPacketBlobDownloadResponsePort;
  try {
    response = await context.race(
      config.container
        .getBlockBlobClient(path)
        .download(0, undefined, { abortSignal: context.signal })
    );
  } catch (error) {
    if (error instanceof ImmutableJsonPacketStorageError) throw error;
    if (isNotFound(error)) {
      fail("NOT_FOUND", "The requested JSON record was not found.", operation, {
        kind,
      });
    }
    throw asStorageFailure(error, operation, kind);
  }
  if (
    !Number.isSafeInteger(response.contentLength) ||
    (response.contentLength as number) < 0
  ) {
    fail("CORRUPT_RECORD", "The JSON record has no trustworthy byte length.", operation, {
      kind,
    });
  }
  const contentLength = response.contentLength as number;
  if (contentLength > maxBytes) {
    fail("LIMIT_EXCEEDED", "The JSON record exceeds the configured read limit.", operation, {
      kind,
    });
  }
  if (
    response.contentType !== IMMUTABLE_JSON_PACKET_CONTENT_TYPE ||
    (!response.readableStreamBody && contentLength !== 0)
  ) {
    fail("CORRUPT_RECORD", "The JSON record response is incomplete.", operation, {
      kind,
    });
  }
  const etag = providerEtag(response.etag, operation, kind, "download");
  const bytes = new Uint8Array(contentLength);
  let received = 0;
  let chunks = 0;
  if (response.readableStreamBody) {
    try {
      await context.race(
        (async () => {
          for await (const chunk of response.readableStreamBody as AsyncIterable<Uint8Array>) {
            context.throwIfAborted();
            if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1) {
              fail("CORRUPT_RECORD", "The JSON record emitted invalid bytes.", operation, {
                kind,
              });
            }
            chunks += 1;
            if (
              chunks > MAX_STREAM_CHUNKS ||
              received + chunk.byteLength > contentLength ||
              received + chunk.byteLength > maxBytes
            ) {
              fail("CORRUPT_RECORD", "The JSON record stream exceeded its bounds.", operation, {
                kind,
              });
            }
            try {
              bytes.set(chunk, received);
            } catch (cause) {
              fail("CORRUPT_RECORD", "The JSON record bytes could not be copied.", operation, {
                kind,
                cause,
              });
            }
            received += chunk.byteLength;
          }
        })()
      );
    } catch (error) {
      if (error instanceof ImmutableJsonPacketStorageError) throw error;
      throw asStorageFailure(error, operation, kind);
    }
  }
  if (received !== contentLength) {
    fail("CORRUPT_RECORD", "The JSON record stream length is inconsistent.", operation, {
      kind,
    });
  }
  return Object.freeze({
    bytes,
    contentType: response.contentType,
    metadata: normalizeMetadata(response.metadata, operation, kind),
    etag,
  });
}

function metadataEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key]
    )
  );
}

function assertDownloadedRecord(
  downloaded: DownloadedRecord,
  expected: EncodedRecord,
  operation: ImmutableJsonPacketStorageOperation,
  kind: string,
  conflictCode: "CHECKPOINT_CONFLICT" | "IMMUTABLE_CONFLICT" | "CORRUPT_RECORD"
): void {
  if (
    !exactBytesEqual(downloaded.bytes, expected.bytes) ||
    sha256(downloaded.bytes) !== expected.digest ||
    !metadataEqual(downloaded.metadata, expected.metadata)
  ) {
    fail(
      conflictCode,
      conflictCode === "CHECKPOINT_CONFLICT"
        ? "The checkpoint changed concurrently."
        : conflictCode === "IMMUTABLE_CONFLICT"
          ? "A different immutable record already uses this identifier."
          : "The JSON record failed integrity verification.",
      operation,
      {
        kind,
        retryable: conflictCode === "CHECKPOINT_CONFLICT",
      }
    );
  }
}

async function putImmutable(
  config: ResolvedStoreConfig,
  kind: string,
  path: string,
  prepared: EncodedRecord,
  maxReadBytes: number,
  operation: ImmutableJsonPacketStorageOperation,
  recordType: ImmutableJsonPacketStorageDiagnostic["recordType"],
  context: OperationContext
): Promise<{ readonly etag: string; readonly replayed: boolean }> {
  try {
    const response = await context.race(
      config.container.getBlockBlobClient(path).uploadData(prepared.bytes, {
        abortSignal: context.signal,
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: {
          blobContentType: IMMUTABLE_JSON_PACKET_CONTENT_TYPE,
        },
        metadata: prepared.metadata,
      })
    );
    const etag = providerEtag(
      response.etag,
      operation,
      kind,
      "write",
      recordType
    );
    return Object.freeze({ etag, replayed: false });
  } catch (error) {
    if (error instanceof ImmutableJsonPacketStorageError) throw error;
    if (!isBlobConditionalConflict(error)) {
      throw asStorageFailure(error, operation, kind, recordType);
    }
    const downloaded = await downloadRecord(
      config,
      kind,
      path,
      maxReadBytes,
      operation,
      context
    );
    assertDownloadedRecord(downloaded, prepared, operation, kind, "IMMUTABLE_CONFLICT");
    return Object.freeze({ etag: downloaded.etag, replayed: true });
  }
}

async function readTimeWindowIndexIfPresent(
  config: ResolvedStoreConfig,
  kind: ResolvedKind,
  bounds: TimeWindowBounds,
  operation: "read-time-window" | "write-packet",
  context: OperationContext
): Promise<
  | {
      readonly downloaded: DownloadedRecord;
      readonly index: StoredTimeWindowIndex;
    }
  | undefined
> {
  if (!kind.timeIndex) {
    fail("INVALID_CONFIG", "No accepted-time index is registered for this kind.", operation, {
      kind: kind.kind,
      recordType: "time-window-index",
    });
  }
  let downloaded: DownloadedRecord;
  try {
    downloaded = await downloadRecord(
      config,
      kind.kind,
      timeWindowPath(kind.timeIndex, bounds.windowStart),
      config.maxReadBytes,
      operation,
      context
    );
  } catch (error) {
    if (
      error instanceof ImmutableJsonPacketStorageError &&
      error.code === "NOT_FOUND"
    ) {
      return undefined;
    }
    throw error;
  }
  return Object.freeze({
    downloaded,
    index: parseTimeWindowIndex(
      downloaded,
      kind,
      bounds,
      operation,
      config.maxReadBytes,
      timeWindowIndexEntryLimit(config.maxManifestEntries)
    ),
  });
}

async function putTimeWindowIndexConditionally(
  config: ResolvedStoreConfig,
  kind: ResolvedKind,
  bounds: TimeWindowBounds,
  prepared: EncodedRecord,
  expectedEtag: string | null,
  context: OperationContext
): Promise<boolean> {
  if (!kind.timeIndex) {
    fail("INVALID_CONFIG", "No accepted-time index is registered for this kind.", "write-packet", {
      kind: kind.kind,
      recordType: "time-window-index",
    });
  }
  try {
    const response = await context.race(
      config.container
        .getBlockBlobClient(timeWindowPath(kind.timeIndex, bounds.windowStart))
        .uploadData(prepared.bytes, {
          abortSignal: context.signal,
          conditions:
            expectedEtag === null
              ? { ifNoneMatch: "*" }
              : { ifMatch: expectedEtag },
          blobHTTPHeaders: {
            blobContentType: IMMUTABLE_JSON_PACKET_CONTENT_TYPE,
          },
          metadata: prepared.metadata,
        })
    );
    providerEtag(
      response.etag,
      "write-packet",
      kind.kind,
      "write",
      "time-window-index"
    );
    return true;
  } catch (error) {
    if (error instanceof ImmutableJsonPacketStorageError) throw error;
    if (isBlobConditionalConflict(error)) return false;
    throw asStorageFailure(
      error,
      "write-packet",
      kind.kind,
      "time-window-index"
    );
  }
}

async function ensurePacketTimeIndexEntry(
  config: ResolvedStoreConfig,
  kind: ResolvedKind,
  bounds: TimeWindowBounds,
  acceptedAt: string,
  packetId: string,
  packet: EncodedRecord,
  observationCandidate: Date,
  context: OperationContext
): Promise<void> {
  const desiredEntry = Object.freeze({
    acceptedAt,
    packetId,
    schemaId: packet.schemaId,
    schemaVersion: packet.schemaVersion,
    sha256: packet.digest,
    byteLength: packet.bytes.byteLength,
  });

  for (let attempt = 0; attempt < MAX_TIME_INDEX_CAS_ATTEMPTS; attempt += 1) {
    context.throwIfAborted();
    const existing = await readTimeWindowIndexIfPresent(
      config,
      kind,
      bounds,
      "write-packet",
      context
    );
    const prior = existing?.index.entries.find(
      (entry) => entry.packetId === packetId
    );
    if (prior) {
      if (
        prior.acceptedAt !== desiredEntry.acceptedAt ||
        prior.schemaId !== desiredEntry.schemaId ||
        prior.schemaVersion !== desiredEntry.schemaVersion ||
        prior.sha256 !== desiredEntry.sha256 ||
        prior.byteLength !== desiredEntry.byteLength
      ) {
        fail(
          "IMMUTABLE_CONFLICT",
          "A different accepted-time entry already uses this packet identifier.",
          "write-packet",
          { kind: kind.kind, recordType: "time-window-index" }
        );
      }
      return;
    }
    const entries = [...(existing?.index.entries ?? []), desiredEntry];
    if (
      entries.length > timeWindowIndexEntryLimit(config.maxManifestEntries)
    ) {
      fail(
        "LIMIT_EXCEEDED",
        "The accepted-time window exceeds its configured item limit.",
        "write-packet",
        { kind: kind.kind, recordType: "time-window-index" }
      );
    }
    entries.sort(compareTimeWindowEntries);
    const observedAt = nextObservedAt(
      observationCandidate,
      existing?.index.observedAt
    );
    if (!isTimeIndexTimestamp(observedAt)) {
      fail(
        "STORAGE_OPERATION_FAILED",
        "The accepted-time index observation range is exhausted.",
        "write-packet",
        { kind: kind.kind, recordType: "time-window-index" }
      );
    }
    const { prepared } = prepareTimeWindowIndex(
      kind,
      bounds,
      observedAt,
      entries,
      "write-packet",
      config.maxReadBytes
    );
    const stored = await putTimeWindowIndexConditionally(
      config,
      kind,
      bounds,
      prepared,
      existing?.downloaded.etag ?? null,
      context
    );
    if (stored) return;
  }

  fail(
    "STORAGE_OPERATION_FAILED",
    "The accepted-time index could not converge within its retry bound.",
    "write-packet",
    {
      kind: kind.kind,
      recordType: "time-window-index",
      retryable: true,
    }
  );
}

function parseStoredJson(
  downloaded: DownloadedRecord,
  operation: ImmutableJsonPacketStorageOperation,
  kind: string,
  maxMembers = MAX_JSON_MEMBERS
): SafeJsonValue {
  try {
    const text = decoder.decode(downloaded.bytes);
    const parsed: unknown = JSON.parse(text);
    const snapshot = snapshotJson(parsed, operation, false, maxMembers);
    if (!exactBytesEqual(downloaded.bytes, encodeCanonical(snapshot))) {
      throw new Error("non-canonical");
    }
    return snapshot;
  } catch (error) {
    if (error instanceof ImmutableJsonPacketStorageError) throw error;
    fail("CORRUPT_RECORD", "The stored JSON record is not canonical.", operation, {
      kind,
      cause: error,
    });
  }
}

function assertStoredMetadata(
  downloaded: DownloadedRecord,
  expected: {
    readonly kind: string;
    readonly recordId: string;
    readonly recordType: string;
    readonly schemaId: string;
    readonly schemaVersion: string;
  },
  operation: ImmutableJsonPacketStorageOperation
): void {
  const prepared = prepareRecord(
    parseStoredJson(downloaded, operation, expected.kind),
    expected.recordType,
    expected.kind,
    expected.recordId,
    expected.schemaId,
    expected.schemaVersion,
    downloaded.bytes.byteLength,
    operation
  );
  assertDownloadedRecord(
    downloaded,
    prepared,
    operation,
    expected.kind,
    "CORRUPT_RECORD"
  );
}

async function putServerTimestampedDeadLetter(
  config: ResolvedStoreConfig,
  kind: ResolvedKind,
  path: string,
  recordId: string,
  prepared: EncodedRecord,
  logicalInput: {
    readonly packetId: string;
    readonly errorCode: string;
    readonly attempt: number;
    readonly retryable: boolean;
  },
  context: OperationContext
): Promise<{
  readonly prepared: EncodedRecord;
  readonly etag: string;
  readonly replayed: boolean;
}> {
  try {
    const response = await context.race(
      config.container.getBlockBlobClient(path).uploadData(prepared.bytes, {
        abortSignal: context.signal,
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: {
          blobContentType: IMMUTABLE_JSON_PACKET_CONTENT_TYPE,
        },
        metadata: prepared.metadata,
      })
    );
    return Object.freeze({
      prepared,
      etag: providerEtag(
        response.etag,
        "write-dead-letter",
        kind.kind,
        "write",
        "dead-letter"
      ),
      replayed: false,
    });
  } catch (error) {
    if (error instanceof ImmutableJsonPacketStorageError) throw error;
    if (!isBlobConditionalConflict(error)) {
      throw asStorageFailure(
        error,
        "write-dead-letter",
        kind.kind,
        "dead-letter"
      );
    }
  }

  const downloaded = await downloadRecord(
    config,
    kind.kind,
    path,
    16 * 1024,
    "write-dead-letter",
    context
  );
  assertStoredMetadata(
    downloaded,
    {
      kind: kind.kind,
      recordId,
      recordType: "dead-letter",
      schemaId: prepared.schemaId,
      schemaVersion: prepared.schemaVersion,
    },
    "write-dead-letter"
  );
  const parsed = parseStoredJson(
    downloaded,
    "write-dead-letter",
    kind.kind
  );
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "attempt",
      "errorCode",
      "kind",
      "packetId",
      "recordId",
      "recordType",
      "recordedAt",
      "retryable",
      "schema",
      "storageSchema",
    ]) ||
    parsed.storageSchema !== IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA ||
    parsed.recordType !== "dead-letter" ||
    parsed.kind !== kind.kind ||
    parsed.recordId !== recordId ||
    parsed.packetId !== logicalInput.packetId ||
    parsed.errorCode !== logicalInput.errorCode ||
    parsed.attempt !== logicalInput.attempt ||
    parsed.retryable !== logicalInput.retryable ||
    !isCanonicalTimestamp(parsed.recordedAt) ||
    !isRecord(parsed.schema) ||
    !hasExactKeys(parsed.schema, ["id", "version"]) ||
    parsed.schema.id !== prepared.schemaId ||
    parsed.schema.version !== prepared.schemaVersion
  ) {
    fail(
      "IMMUTABLE_CONFLICT",
      "A different immutable record already uses this identifier.",
      "write-dead-letter",
      { kind: kind.kind, recordType: "dead-letter" }
    );
  }
  const existingPrepared = prepareRecord(
    parsed,
    "dead-letter",
    kind.kind,
    recordId,
    prepared.schemaId,
    prepared.schemaVersion,
    16 * 1024,
    "write-dead-letter"
  );
  return Object.freeze({
    prepared: existingPrepared,
    etag: downloaded.etag,
    replayed: true,
  });
}

function resolveStoreConfig(
  options: CreateImmutableJsonPacketStoreOptions
): ResolvedStoreConfig {
  if (
    !options ||
    typeof options !== "object" ||
    !options.container ||
    typeof options.container.getBlockBlobClient !== "function" ||
    !isRecord(options.kinds)
  ) {
    fail("INVALID_CONFIG", "Packet store configuration is invalid.", "write-packet");
  }
  const timeoutMs = resolvePositiveInteger(
    options.timeoutMs,
    DEFAULT_OPERATION_TIMEOUT_MS,
    "timeoutMs",
    MAX_OPERATION_TIMEOUT_MS
  );
  const defaultMaxPacketBytes = resolvePositiveInteger(
    options.maxPacketBytes,
    DEFAULT_MAX_PACKET_BYTES,
    "maxPacketBytes",
    DEFAULT_MAX_READ_BYTES
  );
  const maxReadBytes = resolvePositiveInteger(
    options.maxReadBytes,
    DEFAULT_MAX_READ_BYTES,
    "maxReadBytes",
    64 * 1024 * 1024
  );
  if (maxReadBytes < defaultMaxPacketBytes) {
    fail("INVALID_CONFIG", "maxReadBytes must cover maxPacketBytes.", "write-packet");
  }
  const maxListPageItems = resolvePositiveInteger(
    options.maxListPageItems,
    DEFAULT_MAX_LIST_PAGE_ITEMS,
    "maxListPageItems",
    MAX_LIST_PAGE_ITEMS
  );
  const maxListPageBytes = resolvePositiveInteger(
    options.maxListPageBytes,
    Math.min(DEFAULT_MAX_LIST_PAGE_BYTES, maxReadBytes),
    "maxListPageBytes",
    maxReadBytes
  );
  const maxManifestEntries = resolvePositiveInteger(
    options.maxManifestEntries,
    DEFAULT_MAX_MANIFEST_ENTRIES,
    "maxManifestEntries",
    100_000
  );
  const clock = options.clock ?? (() => new Date());
  if (typeof clock !== "function") {
    fail("INVALID_CONFIG", "A valid server clock is required.", "write-packet");
  }
  const kinds = new Map<string, ResolvedKind>();
  const prefixes: string[] = [];
  const kindEntries = Object.entries(options.kinds);
  if (kindEntries.length === 0 || kindEntries.length > 32) {
    fail("INVALID_CONFIG", "One to 32 packet kinds must be configured.", "write-packet");
  }
  for (const [rawKind, candidate] of kindEntries) {
    if (!KIND_PATTERN.test(rawKind) || !isRecord(candidate)) {
      fail("INVALID_CONFIG", "A configured packet kind is invalid.", "write-packet");
    }
    const prefix = normalizePrefix(candidate.prefix);
    const timeIndex = resolveTimeIndex(candidate.timeIndex);
    const candidatePrefixes = [
      prefix,
      ...(timeIndex === undefined ? [] : [timeIndex.prefix]),
    ];
    for (const candidatePrefix of candidatePrefixes) {
      if (
        prefixes.some(
          (existing) =>
            candidatePrefix === existing ||
            candidatePrefix.startsWith(`${existing}/`) ||
            existing.startsWith(`${candidatePrefix}/`)
        ) ||
        candidatePrefixes.some(
          (other) =>
            other !== candidatePrefix &&
            (candidatePrefix.startsWith(`${other}/`) ||
              other.startsWith(`${candidatePrefix}/`))
        )
      ) {
        fail("INVALID_CONFIG", "Packet prefixes must be unique and non-overlapping.", "write-packet");
      }
      prefixes.push(candidatePrefix);
    }
    const packetSchema = resolveSchema(candidate.packetSchema, "write-packet");
    const checkpointSchema =
      candidate.checkpointSchema === undefined
        ? undefined
        : resolveSchema(candidate.checkpointSchema, "write-checkpoint");
    const maxPacketBytes = resolvePositiveInteger(
      candidate.maxPacketBytes,
      defaultMaxPacketBytes,
      "kind.maxPacketBytes",
      maxReadBytes
    );
    const safeCodes = candidate.safeDeadLetterCodes ?? [];
    if (
      !Array.isArray(safeCodes) ||
      safeCodes.length > 64 ||
      safeCodes.some(
        (code) => typeof code !== "string" || !SAFE_ERROR_CODE_PATTERN.test(code)
      ) ||
      new Set(safeCodes).size !== safeCodes.length
    ) {
      fail("INVALID_CONFIG", "Dead-letter codes must be a bounded allowlist.", "write-packet");
    }
    kinds.set(
      rawKind,
      Object.freeze({
        kind: rawKind,
        prefix,
        packetSchema,
        ...(checkpointSchema === undefined ? {} : { checkpointSchema }),
        safeDeadLetterCodes: new Set(safeCodes),
        maxPacketBytes,
        ...(timeIndex === undefined ? {} : { timeIndex }),
      })
    );
  }
  return Object.freeze({
    container: options.container,
    kinds,
    timeoutMs,
    maxReadBytes,
    maxListPageItems,
    maxListPageBytes,
    maxManifestEntries,
    clock,
  });
}

function kindFor(
  config: ResolvedStoreConfig,
  input: unknown,
  operation: ImmutableJsonPacketStorageOperation
): ResolvedKind {
  const kind = normalizeKind(input, operation);
  const resolved = config.kinds.get(kind);
  if (!resolved) {
    fail("INVALID_ARGUMENT", "The packet kind is not registered.", operation);
  }
  return resolved;
}

async function readVerifiedPacket(
  config: ResolvedStoreConfig,
  kind: ResolvedKind,
  packetId: string,
  operation: "read-packet" | "read-time-window",
  context: OperationContext
): Promise<{
  readonly packet: SafeJsonValue;
  readonly sha256: string;
  readonly byteLength: number;
}> {
  const downloaded = await downloadRecord(
    config,
    kind.kind,
    `${kind.prefix}/packets/${packetId}.json`,
    kind.maxPacketBytes,
    operation,
    context
  );
  assertStoredMetadata(
    downloaded,
    {
      kind: kind.kind,
      recordId: packetId,
      recordType: "packet",
      schemaId: kind.packetSchema.id,
      schemaVersion: kind.packetSchema.version,
    },
    operation
  );
  const parsed = parseStoredJson(downloaded, operation, kind.kind);
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "kind",
      "payload",
      "recordId",
      "recordType",
      "schema",
      "storageSchema",
    ]) ||
    parsed.storageSchema !== IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA ||
    parsed.recordType !== "packet" ||
    parsed.kind !== kind.kind ||
    parsed.recordId !== packetId ||
    !isRecord(parsed.schema) ||
    !hasExactKeys(parsed.schema, ["id", "version"]) ||
    parsed.schema.id !== kind.packetSchema.id ||
    parsed.schema.version !== kind.packetSchema.version
  ) {
    fail("CORRUPT_RECORD", "The packet envelope is invalid.", operation, {
      kind: kind.kind,
      recordType: "packet",
    });
  }
  return Object.freeze({
    packet: validateSchemaValue(kind.packetSchema, parsed.payload, operation),
    sha256: sha256(downloaded.bytes),
    byteLength: downloaded.bytes.byteLength,
  });
}

async function readTimeWindowPropertiesIfPresent(
  config: ResolvedStoreConfig,
  kind: ResolvedKind,
  bounds: TimeWindowBounds,
  context: OperationContext
): Promise<
  | {
      readonly descriptor: ImmutableJsonPacketTimeWindowDescriptor;
      readonly byteLength: number;
    }
  | undefined
> {
  if (!kind.timeIndex) {
    fail(
      "INVALID_CONFIG",
      "No accepted-time index is registered for this kind.",
      "list-time-windows",
      { kind: kind.kind, recordType: "time-window-index" }
    );
  }
  const client = config.container.getBlockBlobClient(
    timeWindowPath(kind.timeIndex, bounds.windowStart)
  );
  const getProperties = client.getProperties?.bind(client);
  if (!getProperties) {
    fail(
      "INVALID_CONFIG",
      "The accepted-time index properties driver is not configured.",
      "list-time-windows",
      { kind: kind.kind, recordType: "time-window-index" }
    );
  }
  let properties: unknown;
  try {
    properties = await context.race(
      getProperties({ abortSignal: context.signal })
    );
  } catch (error) {
    if (error instanceof ImmutableJsonPacketStorageError) throw error;
    if (isNotFound(error)) return undefined;
    throw asStorageFailure(
      error,
      "list-time-windows",
      kind.kind,
      "time-window-index"
    );
  }
  const safeProperties = snapshotProviderDataRecord(
    properties,
    ["contentLength", "contentType", "etag", "metadata"],
    4,
    "list-time-windows",
    kind.kind,
    "time-window-index"
  );
  const contentLength = safeProperties.contentLength;
  if (
    !Number.isSafeInteger(contentLength) ||
    (contentLength as number) < 1 ||
    (contentLength as number) > config.maxReadBytes ||
    safeProperties.contentType !== IMMUTABLE_JSON_PACKET_CONTENT_TYPE
  ) {
    fail(
      "CORRUPT_RECORD",
      "The accepted-time index properties are incomplete.",
      "list-time-windows",
      { kind: kind.kind, recordType: "time-window-index" }
    );
  }
  providerEtag(
    safeProperties.etag,
    "list-time-windows",
    kind.kind,
    "download",
    "time-window-index"
  );
  const metadata = normalizeMetadata(
    snapshotProviderDataRecord(
      safeProperties.metadata,
      undefined,
      32,
      "list-time-windows",
      kind.kind,
      "time-window-index"
    ),
    "list-time-windows",
    kind.kind
  );
  const byteLength = contentLength as number;
  const recordId = timeWindowRecordId(
    bounds.windowStart,
    kind.timeIndex.partition
  );
  if (
    !hasExactKeys(metadata, TIME_WINDOW_INDEX_METADATA_KEYS) ||
    metadata.plasiusrecordschema !== IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA ||
    metadata.plasiusrecordtype !== "time-window-index" ||
    metadata.plasiuskind !== kind.kind ||
    metadata.plasiusrecordid !== recordId ||
    metadata.plasiusschemaid !== TIME_WINDOW_INDEX_SCHEMA_ID ||
    metadata.plasiusschemaversion !== TIME_WINDOW_INDEX_SCHEMA_VERSION ||
    metadata.plasiusbytelength !== String(byteLength) ||
    !SHA256_PATTERN.test(metadata.plasiussha256 ?? "") ||
    metadata.plasiuswindowstart !== bounds.windowStart ||
    metadata.plasiuswindowend !== bounds.windowEnd ||
    !isTimeIndexTimestamp(metadata.plasiusobservedat) ||
    !SHA256_PATTERN.test(metadata.plasiussnapshot ?? "") ||
    !DECIMAL_BYTE_LENGTH_PATTERN.test(metadata.plasiusentrycount ?? "") ||
    Number(metadata.plasiusentrycount) < 1 ||
    Number(metadata.plasiusentrycount) >
      timeWindowIndexEntryLimit(config.maxManifestEntries)
  ) {
    fail(
      "CORRUPT_RECORD",
      "The accepted-time index properties are invalid.",
      "list-time-windows",
      { kind: kind.kind, recordType: "time-window-index" }
    );
  }
  return Object.freeze({
    byteLength,
    descriptor: Object.freeze({
      windowStart: bounds.windowStart,
      windowEnd: bounds.windowEnd,
      observedAt: metadata.plasiusobservedat,
      snapshot: metadata.plasiussnapshot,
    }),
  });
}

function receiptFor(
  kind: ResolvedKind,
  recordType: "dead-letter" | "manifest" | "packet",
  recordId: string,
  prepared: EncodedRecord,
  write: { readonly etag: string; readonly replayed: boolean }
): ImmutableJsonRecordReceipt {
  return Object.freeze({
    recordType,
    kind: kind.kind,
    recordId,
    schemaId: prepared.schemaId,
    schemaVersion: prepared.schemaVersion,
    sha256: prepared.digest,
    byteLength: prepared.bytes.byteLength,
    etag: write.etag,
    replayed: write.replayed,
  });
}

function now(
  config: ResolvedStoreConfig,
  operation: ImmutableJsonPacketStorageOperation
): Date {
  let value: Date;
  try {
    value = config.clock();
  } catch (cause) {
    fail("INVALID_CONFIG", "The server clock failed.", operation, { cause });
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("INVALID_CONFIG", "The server clock returned an invalid date.", operation);
  }
  return new Date(value.getTime());
}

/**
 * Creates a Node-only, prefix-bound packet store. The host still owns
 * authorization, lifecycle policy, managed identity, and feature-flag checks.
 */
export function createImmutableJsonPacketStore<
  const Kinds extends Readonly<
    Record<string, ImmutableJsonPacketKindConfig>
  >,
>(
  options: CreateImmutableJsonPacketStoreOptions<Kinds>
): ImmutableJsonPacketStore<Extract<keyof Kinds, string>> {
  const config = resolveStoreConfig(options);
  type Kind = Extract<keyof Kinds, string>;

  const store: ImmutableJsonPacketStore<Kind> = {
    writePacket: async (kindInput, packetIdInput, packet, operationOptions = {}) => {
      const kind = kindFor(config, kindInput, "write-packet");
      const packetId = normalizeIdentifier(packetIdInput, "write-packet");
      const payload = validateSchemaValue(kind.packetSchema, packet, "write-packet");
      let acceptedAt: string | undefined;
      let acceptedWindow: TimeWindowBounds | undefined;
      if (kind.timeIndex) {
        const timestamp = isRecord(payload)
          ? payload[kind.timeIndex.timestampField]
          : undefined;
        if (!isTimeIndexTimestamp(timestamp)) {
          fail(
            "SCHEMA_REJECTED",
            "The structured packet has no canonical registered acceptance time.",
            "write-packet",
            { kind: kind.kind, recordType: "packet" }
          );
        }
        acceptedAt = timestamp;
        acceptedWindow = alignedPartitionBounds(
          acceptedAt,
          kind.timeIndex.partition
        );
        if (!isTimeIndexTimestamp(acceptedWindow.windowEnd)) {
          fail(
            "SCHEMA_REJECTED",
            "The structured packet acceptance time is outside the supported range.",
            "write-packet",
            { kind: kind.kind, recordType: "packet" }
          );
        }
      }
      const envelope = snapshotJson(
        {
          storageSchema: IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA,
          recordType: "packet",
          kind: kind.kind,
          recordId: packetId,
          schema: {
            id: kind.packetSchema.id,
            version: kind.packetSchema.version,
          },
          payload,
        },
        "write-packet",
        false
      );
      const prepared = prepareRecord(
        envelope,
        "packet",
        kind.kind,
        packetId,
        kind.packetSchema.id,
        kind.packetSchema.version,
        kind.maxPacketBytes,
        "write-packet"
      );
      return withContext(
        "write-packet",
        kind.kind,
        resolveTimeout(operationOptions.timeoutMs, config.timeoutMs, "write-packet"),
        operationOptions.signal,
        async (context) => {
          const observationCandidate =
            kind.timeIndex === undefined
              ? undefined
              : now(config, "write-packet");
          if (
            observationCandidate !== undefined &&
            !isTimeIndexTimestamp(observationCandidate.toISOString())
          ) {
            fail(
              "INVALID_CONFIG",
              "The server clock is outside the accepted-time index range.",
              "write-packet",
              { kind: kind.kind, recordType: "time-window-index" }
            );
          }
          const write = await putImmutable(
            config,
            kind.kind,
            `${kind.prefix}/packets/${packetId}.json`,
            prepared,
            kind.maxPacketBytes,
            "write-packet",
            "packet",
            context
          );
          if (
            kind.timeIndex !== undefined &&
            acceptedAt !== undefined &&
            acceptedWindow !== undefined &&
            observationCandidate !== undefined
          ) {
            await ensurePacketTimeIndexEntry(
              config,
              kind,
              acceptedWindow,
              acceptedAt,
              packetId,
              prepared,
              observationCandidate,
              context
            );
          }
          return Object.freeze({
            ...receiptFor(kind, "packet", packetId, prepared, write),
            recordType: "packet" as const,
            packetId,
          });
        }
      );
    },

    readPacket: async (kindInput, packetIdInput, operationOptions = {}) => {
      const kind = kindFor(config, kindInput, "read-packet");
      const packetId = normalizeIdentifier(packetIdInput, "read-packet");
      return withContext(
        "read-packet",
        kind.kind,
        resolveTimeout(operationOptions.timeoutMs, config.timeoutMs, "read-packet"),
        operationOptions.signal,
        async (context) => {
          const verified = await readVerifiedPacket(
            config,
            kind,
            packetId,
            "read-packet",
            context
          );
          return verified.packet;
        }
      );
    },

    listPacketPage: async (kindInput, operationOptions = {}) => {
      const kind = kindFor(config, kindInput, "list-packets");
      const maxItems = resolvePacketListLimit(
        operationOptions.maxItems,
        config.maxListPageItems,
        config.maxListPageItems,
        "maxItems",
        kind.kind
      );
      const maxBytes = resolvePacketListLimit(
        operationOptions.maxBytes,
        config.maxListPageBytes,
        config.maxListPageBytes,
        "maxBytes",
        kind.kind
      );
      const continuationToken = decodePacketListCursor(
        kind.kind,
        kind.prefix,
        operationOptions.cursor
      );
      const listBlobsFlat = config.container.listBlobsFlat?.bind(
        config.container
      );
      if (!listBlobsFlat) {
        fail(
          "INVALID_CONFIG",
          "The packet-list Blob driver is not configured.",
          "list-packets",
          { kind: kind.kind, recordType: "packet" }
        );
      }

      return withContext(
        "list-packets",
        kind.kind,
        resolveTimeout(
          operationOptions.timeoutMs,
          config.timeoutMs,
          "list-packets"
        ),
        operationOptions.signal,
        async (context) => {
          let iteration: IteratorResult<JsonPacketBlobListPagePort>;
          try {
            const listing = listBlobsFlat({
              abortSignal: context.signal,
              includeMetadata: true,
              prefix: `${kind.prefix}/packets/`,
            });
            if (!listing || typeof listing.byPage !== "function") {
              throw new Error("invalid-list-driver");
            }
            const pages = listing.byPage({
              ...(continuationToken === undefined
                ? {}
                : { continuationToken }),
              maxPageSize: maxItems,
            });
            if (
              !pages ||
              typeof pages[Symbol.asyncIterator] !== "function"
            ) {
              throw new Error("invalid-list-driver");
            }
            const iterator = pages[Symbol.asyncIterator]();
            iteration = await context.race(Promise.resolve(iterator.next()));
          } catch (error) {
            if (error instanceof ImmutableJsonPacketStorageError) throw error;
            throw asStorageFailure(
              error,
              "list-packets",
              kind.kind,
              "packet"
            );
          }

          if (iteration.done === true) {
            return Object.freeze({
              kind: kind.kind,
              packets: Object.freeze([]) as readonly ImmutableJsonPacketListEntry[],
              byteLength: 0,
              complete: true,
            });
          }
          context.throwIfAborted();
          const page = iteration.value;
          if (
            !isRecord(page) ||
            !isRecord(page.segment) ||
            !Array.isArray(page.segment.blobItems)
          ) {
            fail(
              "CORRUPT_RECORD",
              "Blob storage returned an invalid packet-list page.",
              "list-packets",
              { kind: kind.kind, recordType: "packet" }
            );
          }
          const blobItems = page.segment.blobItems as readonly unknown[];
          if (blobItems.length > maxItems) {
            fail(
              "LIMIT_EXCEEDED",
              "The packet-list page exceeds its item limit.",
              "list-packets",
              { kind: kind.kind, recordType: "packet" }
            );
          }

          const nextProviderToken = page.continuationToken;
          if (
            nextProviderToken !== undefined &&
            (!validProviderContinuation(nextProviderToken) ||
              nextProviderToken === continuationToken ||
              blobItems.length === 0)
          ) {
            fail(
              "CORRUPT_RECORD",
              "Blob storage returned an invalid packet-list continuation.",
              "list-packets",
              { kind: kind.kind, recordType: "packet" }
            );
          }

          const packetIds = new Set<string>();
          let byteLength = 0;
          const packets = blobItems.map((item) => {
            context.throwIfAborted();
            const entry = packetListEntry(kind, item);
            if (packetIds.has(entry.packetId)) {
              fail(
                "CORRUPT_RECORD",
                "Blob storage returned a duplicate packet-list item.",
                "list-packets",
                { kind: kind.kind, recordType: "packet" }
              );
            }
            packetIds.add(entry.packetId);
            if (
              entry.byteLength > maxBytes - byteLength ||
              !Number.isSafeInteger(byteLength + entry.byteLength)
            ) {
              fail(
                "LIMIT_EXCEEDED",
                "The packet-list page exceeds its declared-byte limit.",
                "list-packets",
                { kind: kind.kind, recordType: "packet" }
              );
            }
            byteLength += entry.byteLength;
            return entry;
          });
          packets.sort((left, right) =>
            left.packetId < right.packetId
              ? -1
              : left.packetId > right.packetId
                ? 1
                : 0
          );
          const nextCursor =
            nextProviderToken === undefined
              ? undefined
              : encodePacketListCursor(
                  kind.kind,
                  kind.prefix,
                  nextProviderToken
                );
          return Object.freeze({
            kind: kind.kind,
            packets: Object.freeze(packets),
            byteLength,
            complete: nextCursor === undefined,
            ...(nextCursor === undefined ? {} : { nextCursor }),
          });
        }
      );
    },

    readPacketTimeWindow: async (kindInput, operationOptions) => {
      const kind = kindFor(config, kindInput, "read-time-window");
      if (!kind.timeIndex) {
        fail(
          "INVALID_CONFIG",
          "No accepted-time index is registered for this kind.",
          "read-time-window",
          { kind: kind.kind, recordType: "time-window-index" }
        );
      }
      const timeIndex = kind.timeIndex;
      if (!isRecord(operationOptions)) {
        fail(
          "INVALID_ARGUMENT",
          "Accepted-time window options are required.",
          "read-time-window",
          { kind: kind.kind, recordType: "time-window-index" }
        );
      }
      const bounds = assertExactTimeWindow(
        operationOptions.windowStart,
        operationOptions.windowEnd,
        timeIndex.partition,
        "read-time-window",
        kind.kind,
        true
      );
      const maxItems = resolveTimeWindowLimit(
        operationOptions.maxItems,
        timeWindowIndexEntryLimit(config.maxManifestEntries),
        "maxItems",
        "read-time-window",
        kind.kind
      );
      const maxBytes = resolveTimeWindowLimit(
        operationOptions.maxBytes,
        config.maxReadBytes,
        "maxBytes",
        "read-time-window",
        kind.kind
      );
      return withContext(
        "read-time-window",
        kind.kind,
        resolveTimeout(
          operationOptions.timeoutMs,
          config.timeoutMs,
          "read-time-window"
        ),
        operationOptions.signal,
        async (context) => {
          const stored = await readTimeWindowIndexIfPresent(
            config,
            kind,
            bounds,
            "read-time-window",
            context
          );
          if (!stored) {
            return Object.freeze({
              kind: kind.kind,
              windowStart: bounds.windowStart,
              windowEnd: bounds.windowEnd,
              observedAt: bounds.windowStart,
              snapshot: timeWindowSnapshot(
                kind.kind,
                bounds,
                [],
                "read-time-window"
              ),
              byteLength: 0,
              complete: true as const,
              packets: Object.freeze([]) as readonly ImmutableJsonPacketTimeWindowEntry[],
            });
          }
          if (stored.index.entries.length > maxItems) {
            fail(
              "LIMIT_EXCEEDED",
              "The accepted-time window exceeds its item limit.",
              "read-time-window",
              { kind: kind.kind, recordType: "time-window-index" }
            );
          }
          let byteLength = 0;
          for (const entry of stored.index.entries) {
            if (
              entry.byteLength > maxBytes - byteLength ||
              !Number.isSafeInteger(byteLength + entry.byteLength)
            ) {
              fail(
                "LIMIT_EXCEEDED",
                "The accepted-time window exceeds its packet-byte limit.",
                "read-time-window",
                { kind: kind.kind, recordType: "time-window-index" }
              );
            }
            byteLength += entry.byteLength;
          }
          const packets: ImmutableJsonPacketTimeWindowEntry[] = [];
          for (const entry of stored.index.entries) {
            context.throwIfAborted();
            const verified = await readVerifiedPacket(
              config,
              kind,
              entry.packetId,
              "read-time-window",
              context
            );
            const packetAcceptedAt = isRecord(verified.packet)
              ? verified.packet[timeIndex.timestampField]
              : undefined;
            if (
              verified.sha256 !== entry.sha256 ||
              verified.byteLength !== entry.byteLength ||
              packetAcceptedAt !== entry.acceptedAt
            ) {
              fail(
                "CORRUPT_RECORD",
                "An accepted-time entry does not match its immutable packet.",
                "read-time-window",
                { kind: kind.kind, recordType: "time-window-index" }
              );
            }
            packets.push(
              Object.freeze({
                ...entry,
                packet: verified.packet,
              })
            );
          }
          return Object.freeze({
            kind: kind.kind,
            windowStart: bounds.windowStart,
            windowEnd: bounds.windowEnd,
            observedAt: stored.index.observedAt,
            snapshot: stored.index.snapshot,
            byteLength,
            complete: true as const,
            packets: Object.freeze(packets),
          });
        }
      );
    },

    listPacketTimeWindows: async (kindInput, operationOptions) => {
      const kind = kindFor(config, kindInput, "list-time-windows");
      if (!kind.timeIndex) {
        fail(
          "INVALID_CONFIG",
          "No accepted-time index is registered for this kind.",
          "list-time-windows",
          { kind: kind.kind, recordType: "time-window-index" }
        );
      }
      const timeIndex = kind.timeIndex;
      if (
        !isRecord(operationOptions) ||
        operationOptions.partition !== timeIndex.partition
      ) {
        fail(
          "INVALID_ARGUMENT",
          "The accepted-time partition is invalid.",
          "list-time-windows",
          { kind: kind.kind, recordType: "time-window-index" }
        );
      }
      const bounds = assertExactTimeWindow(
        operationOptions.windowStart,
        operationOptions.windowEnd,
        timeIndex.partition,
        "list-time-windows",
        kind.kind,
        false
      );
      const maxItems = resolveTimeWindowLimit(
        operationOptions.maxItems,
        timeWindowIndexEntryLimit(config.maxManifestEntries),
        "maxItems",
        "list-time-windows",
        kind.kind
      );
      const maxBytes = resolveTimeWindowLimit(
        operationOptions.maxBytes,
        config.maxReadBytes,
        "maxBytes",
        "list-time-windows",
        kind.kind
      );
      const step = partitionMilliseconds(timeIndex.partition);
      const startMs = new Date(bounds.windowStart).getTime();
      const endMs = new Date(bounds.windowEnd).getTime();
      const count = (endMs - startMs) / step;
      if (!Number.isSafeInteger(count) || count < 1 || count > maxItems) {
        fail(
          "LIMIT_EXCEEDED",
          "The accepted-time window range exceeds its exact-read limit.",
          "list-time-windows",
          { kind: kind.kind, recordType: "time-window-index" }
        );
      }
      return withContext(
        "list-time-windows",
        kind.kind,
        resolveTimeout(
          operationOptions.timeoutMs,
          config.timeoutMs,
          "list-time-windows"
        ),
        operationOptions.signal,
        async (context) => {
          let byteLength = 0;
          const windows: ImmutableJsonPacketTimeWindowDescriptor[] = [];
          for (let index = 0; index < count; index += 1) {
            context.throwIfAborted();
            const windowStart = new Date(startMs + index * step).toISOString();
            const exactBounds = alignedPartitionBounds(
              windowStart,
              timeIndex.partition
            );
            const result = await readTimeWindowPropertiesIfPresent(
              config,
              kind,
              exactBounds,
              context
            );
            if (!result) continue;
            if (
              result.byteLength > maxBytes - byteLength ||
              !Number.isSafeInteger(byteLength + result.byteLength)
            ) {
              fail(
                "LIMIT_EXCEEDED",
                "The accepted-time index range exceeds its byte limit.",
                "list-time-windows",
                { kind: kind.kind, recordType: "time-window-index" }
              );
            }
            byteLength += result.byteLength;
            windows.push(result.descriptor);
          }
          return Object.freeze({
            kind: kind.kind,
            complete: true as const,
            windows: Object.freeze(windows),
          });
        }
      );
    },

    writeManifest: async (
      kindInput,
      manifestIdInput,
      input,
      operationOptions = {}
    ) => {
      const kind = kindFor(config, kindInput, "write-manifest");
      const manifestId = normalizeIdentifier(manifestIdInput, "write-manifest");
      if (
        !isRecord(input) ||
        !hasExactKeys(input, ["packets", "revision", "windowEnd", "windowStart"]) ||
        !Number.isSafeInteger(input.revision) ||
        (input.revision as number) < 0 ||
        !Array.isArray(input.packets) ||
        input.packets.length === 0 ||
        input.packets.length > config.maxManifestEntries
      ) {
        fail("INVALID_ARGUMENT", "The immutable packet manifest is invalid.", "write-manifest", {
          kind: kind.kind,
        });
      }
      const windowStart = normalizeTimestamp(input.windowStart, "write-manifest");
      const windowEnd = normalizeTimestamp(input.windowEnd, "write-manifest");
      if (windowEnd <= windowStart) {
        fail("INVALID_ARGUMENT", "The manifest window is invalid.", "write-manifest", {
          kind: kind.kind,
        });
      }
      const seen = new Set<string>();
      const packets = input.packets.map((candidate) => {
        if (
          !isRecord(candidate) ||
          !hasExactKeys(candidate, ["byteLength", "packetId", "sha256"])
        ) {
          fail("INVALID_ARGUMENT", "A manifest packet receipt is invalid.", "write-manifest", {
            kind: kind.kind,
          });
        }
        const packetId = normalizeIdentifier(candidate.packetId, "write-manifest");
        if (
          seen.has(packetId) ||
          typeof candidate.sha256 !== "string" ||
          !SHA256_PATTERN.test(candidate.sha256) ||
          !Number.isSafeInteger(candidate.byteLength) ||
          (candidate.byteLength as number) < 1 ||
          (candidate.byteLength as number) > kind.maxPacketBytes
        ) {
          fail("INVALID_ARGUMENT", "A manifest packet receipt is invalid.", "write-manifest", {
            kind: kind.kind,
          });
        }
        seen.add(packetId);
        return Object.freeze({
          packetId,
          sha256: candidate.sha256,
          byteLength: candidate.byteLength as number,
        });
      });
      packets.sort((left, right) =>
        left.packetId < right.packetId ? -1 : left.packetId > right.packetId ? 1 : 0
      );
      const schemaId = "plasiusPacketManifest";
      const schemaVersion = "1.0.0";
      const envelope = snapshotJson(
        {
          storageSchema: IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA,
          recordType: "manifest",
          kind: kind.kind,
          recordId: manifestId,
          schema: { id: schemaId, version: schemaVersion },
          windowStart,
          windowEnd,
          revision: input.revision,
          packetCount: packets.length,
          packets,
        },
        "write-manifest",
        false
      );
      const prepared = prepareRecord(
        envelope,
        "manifest",
        kind.kind,
        manifestId,
        schemaId,
        schemaVersion,
        config.maxReadBytes,
        "write-manifest"
      );
      return withContext(
        "write-manifest",
        kind.kind,
        resolveTimeout(operationOptions.timeoutMs, config.timeoutMs, "write-manifest"),
        operationOptions.signal,
        async (context) => {
          const write = await putImmutable(
            config,
            kind.kind,
            `${kind.prefix}/manifests/${manifestId}.json`,
            prepared,
            config.maxReadBytes,
            "write-manifest",
            "manifest",
            context
          );
          return Object.freeze({
            ...receiptFor(kind, "manifest", manifestId, prepared, write),
            recordType: "manifest" as const,
            entryCount: packets.length,
          });
        }
      );
    },

    writeDeadLetter: async (
      kindInput,
      deadLetterIdInput,
      input,
      operationOptions = {}
    ) => {
      const kind = kindFor(config, kindInput, "write-dead-letter");
      const deadLetterId = normalizeIdentifier(
        deadLetterIdInput,
        "write-dead-letter"
      );
      if (
        !isRecord(input) ||
        !hasExactKeys(input, [
          "attempt",
          "errorCode",
          "packetId",
          "retryable",
        ]) ||
        typeof input.errorCode !== "string" ||
        !kind.safeDeadLetterCodes.has(input.errorCode) ||
        !Number.isSafeInteger(input.attempt) ||
        (input.attempt as number) < 1 ||
        (input.attempt as number) > 100 ||
        typeof input.retryable !== "boolean"
      ) {
        fail("INVALID_ARGUMENT", "The dead-letter metadata is invalid.", "write-dead-letter", {
          kind: kind.kind,
        });
      }
      const packetId = normalizeIdentifier(input.packetId, "write-dead-letter");
      const recordedAt = now(config, "write-dead-letter").toISOString();
      const schemaId = "plasiusPacketDeadLetter";
      const schemaVersion = "1.0.0";
      const envelope = snapshotJson(
        {
          storageSchema: IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA,
          recordType: "dead-letter",
          kind: kind.kind,
          recordId: deadLetterId,
          schema: { id: schemaId, version: schemaVersion },
          packetId,
          errorCode: input.errorCode,
          recordedAt,
          attempt: input.attempt,
          retryable: input.retryable,
        },
        "write-dead-letter",
        false
      );
      const prepared = prepareRecord(
        envelope,
        "dead-letter",
        kind.kind,
        deadLetterId,
        schemaId,
        schemaVersion,
        16 * 1024,
        "write-dead-letter"
      );
      return withContext(
        "write-dead-letter",
        kind.kind,
        resolveTimeout(
          operationOptions.timeoutMs,
          config.timeoutMs,
          "write-dead-letter"
        ),
        operationOptions.signal,
        async (context) => {
          const write = await putServerTimestampedDeadLetter(
            config,
            kind,
            `${kind.prefix}/dead-letters/${deadLetterId}.json`,
            deadLetterId,
            prepared,
            {
              packetId,
              errorCode: input.errorCode,
              attempt: input.attempt,
              retryable: input.retryable,
            },
            context
          );
          return Object.freeze({
            ...receiptFor(
              kind,
              "dead-letter",
              deadLetterId,
              write.prepared,
              write
            ),
            recordType: "dead-letter" as const,
          });
        }
      );
    },

    readCheckpoint: async (kindInput, nameInput, operationOptions = {}) => {
      const kind = kindFor(config, kindInput, "read-checkpoint");
      const name = normalizeIdentifier(nameInput, "read-checkpoint");
      if (!kind.checkpointSchema) {
        fail("INVALID_CONFIG", "No checkpoint schema is registered for this kind.", "read-checkpoint", {
          kind: kind.kind,
        });
      }
      const checkpointSchema = kind.checkpointSchema;
      return withContext(
        "read-checkpoint",
        kind.kind,
        resolveTimeout(
          operationOptions.timeoutMs,
          config.timeoutMs,
          "read-checkpoint"
        ),
        operationOptions.signal,
        async (context) => {
          let downloaded: DownloadedRecord;
          try {
            downloaded = await downloadRecord(
              config,
              kind.kind,
              `${kind.prefix}/control/checkpoints/${name}.json`,
              kind.maxPacketBytes,
              "read-checkpoint",
              context
            );
          } catch (error) {
            if (
              error instanceof ImmutableJsonPacketStorageError &&
              error.code === "NOT_FOUND"
            ) {
              return undefined;
            }
            throw error;
          }
          assertStoredMetadata(
            downloaded,
            {
              kind: kind.kind,
              recordId: name,
              recordType: "checkpoint",
              schemaId: checkpointSchema.id,
              schemaVersion: checkpointSchema.version,
            },
            "read-checkpoint"
          );
          const parsed = parseStoredJson(downloaded, "read-checkpoint", kind.kind);
          if (
            !isRecord(parsed) ||
            !hasExactKeys(parsed, [
              "kind",
              "recordId",
              "recordType",
              "schema",
              "storageSchema",
              "value",
            ]) ||
            parsed.storageSchema !== IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA ||
            parsed.recordType !== "checkpoint" ||
            parsed.kind !== kind.kind ||
            parsed.recordId !== name ||
            !isRecord(parsed.schema) ||
            !hasExactKeys(parsed.schema, ["id", "version"]) ||
            parsed.schema.id !== checkpointSchema.id ||
            parsed.schema.version !== checkpointSchema.version
          ) {
            fail("CORRUPT_RECORD", "The checkpoint envelope is invalid.", "read-checkpoint", {
              kind: kind.kind,
            });
          }
          const value = validateSchemaValue(
            checkpointSchema,
            parsed.value,
            "read-checkpoint"
          );
          return Object.freeze({
            kind: kind.kind,
            name,
            schemaId: checkpointSchema.id,
            schemaVersion: checkpointSchema.version,
            value,
            sha256: sha256(downloaded.bytes),
            byteLength: downloaded.bytes.byteLength,
            etag: downloaded.etag,
            replayed: false,
          });
        }
      );
    },

    compareAndSwapCheckpoint: async (
      kindInput,
      nameInput,
      expectedEtag,
      valueInput,
      operationOptions = {}
    ) => {
      const kind = kindFor(config, kindInput, "write-checkpoint");
      const name = normalizeIdentifier(nameInput, "write-checkpoint");
      if (!kind.checkpointSchema) {
        fail("INVALID_CONFIG", "No checkpoint schema is registered for this kind.", "write-checkpoint", {
          kind: kind.kind,
        });
      }
      const checkpointSchema = kind.checkpointSchema;
      if (
        expectedEtag !== null &&
        (typeof expectedEtag !== "string" ||
          !ETAG_PATTERN.test(expectedEtag) ||
          expectedEtag === "*")
      ) {
        fail("INVALID_ARGUMENT", "The expected checkpoint ETag is invalid.", "write-checkpoint", {
          kind: kind.kind,
        });
      }
      const value = validateSchemaValue(
        checkpointSchema,
        valueInput,
        "write-checkpoint"
      );
      const envelope = snapshotJson(
        {
          storageSchema: IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA,
          recordType: "checkpoint",
          kind: kind.kind,
          recordId: name,
          schema: {
            id: checkpointSchema.id,
            version: checkpointSchema.version,
          },
          value,
        },
        "write-checkpoint",
        false
      );
      const prepared = prepareRecord(
        envelope,
        "checkpoint",
        kind.kind,
        name,
        checkpointSchema.id,
        checkpointSchema.version,
        kind.maxPacketBytes,
        "write-checkpoint"
      );
      return withContext(
        "write-checkpoint",
        kind.kind,
        resolveTimeout(
          operationOptions.timeoutMs,
          config.timeoutMs,
          "write-checkpoint"
        ),
        operationOptions.signal,
        async (context) => {
          const path = `${kind.prefix}/control/checkpoints/${name}.json`;
          try {
            const response = await context.race(
              config.container.getBlockBlobClient(path).uploadData(prepared.bytes, {
                abortSignal: context.signal,
                conditions:
                  expectedEtag === null
                    ? { ifNoneMatch: "*" }
                    : { ifMatch: expectedEtag },
                blobHTTPHeaders: {
                  blobContentType: IMMUTABLE_JSON_PACKET_CONTENT_TYPE,
                },
                metadata: prepared.metadata,
              })
            );
            const etag = providerEtag(
              response.etag,
              "write-checkpoint",
              kind.kind,
              "write",
              "checkpoint"
            );
            return Object.freeze({
              kind: kind.kind,
              name,
              schemaId: checkpointSchema.id,
              schemaVersion: checkpointSchema.version,
              value,
              sha256: prepared.digest,
              byteLength: prepared.bytes.byteLength,
              etag,
              replayed: false,
            });
          } catch (error) {
            if (error instanceof ImmutableJsonPacketStorageError) throw error;
            if (!isBlobConditionalConflict(error)) {
              throw asStorageFailure(
                error,
                "write-checkpoint",
                kind.kind,
                "checkpoint"
              );
            }
            const downloaded = await downloadRecord(
              config,
              kind.kind,
              path,
              kind.maxPacketBytes,
              "write-checkpoint",
              context
            );
            assertDownloadedRecord(
              downloaded,
              prepared,
              "write-checkpoint",
              kind.kind,
              "CHECKPOINT_CONFLICT"
            );
            return Object.freeze({
              kind: kind.kind,
              name,
              schemaId: checkpointSchema.id,
              schemaVersion: checkpointSchema.version,
              value,
              sha256: prepared.digest,
              byteLength: prepared.bytes.byteLength,
              etag: downloaded.etag,
              replayed: true,
            });
          }
        }
      );
    },

    acquireLease: async (kindInput, nameInput, operationOptions = {}) => {
      const kind = kindFor(config, kindInput, "acquire-lease");
      const name = normalizeIdentifier(nameInput, "acquire-lease");
      const durationSeconds = operationOptions.durationSeconds ?? 30;
      if (
        !Number.isInteger(durationSeconds) ||
        durationSeconds < 15 ||
        durationSeconds > 60
      ) {
        fail("INVALID_ARGUMENT", "Lease duration must be 15 to 60 seconds.", "acquire-lease", {
          kind: kind.kind,
        });
      }
      const timeoutMs = resolveTimeout(
        operationOptions.timeoutMs,
        config.timeoutMs,
        "acquire-lease"
      );
      const initialExpiresAt = new Date(
        now(config, "acquire-lease").getTime() + durationSeconds * 1_000
      ).toISOString();
      const path = `${kind.prefix}/control/leases/${name}.json`;
      const schemaId = "plasiusPacketLeaseSentinel";
      const schemaVersion = "1.0.0";
      const sentinel = prepareRecord(
        snapshotJson(
          {
            storageSchema: IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA,
            recordType: "lease",
            kind: kind.kind,
            recordId: name,
            schema: { id: schemaId, version: schemaVersion },
          },
          "acquire-lease",
          false
        ),
        "lease",
        kind.kind,
        name,
        schemaId,
        schemaVersion,
        4 * 1024,
        "acquire-lease"
      );
      return withContext(
        "acquire-lease",
        kind.kind,
        timeoutMs,
        operationOptions.signal,
        async (context) => {
          await putImmutable(
            config,
            kind.kind,
            path,
            sentinel,
            4 * 1024,
            "acquire-lease",
            "lease",
            context
          );
          let leaseClient: JsonPacketBlobLeaseClientPort;
          try {
            leaseClient = config.container
              .getBlockBlobClient(path)
              .getBlobLeaseClient();
            const response = await context.race(
              leaseClient.acquireLease(durationSeconds, {
                abortSignal: context.signal,
              })
            );
            assertProviderLeaseToken(
              response.leaseId,
              "acquire-lease",
              kind.kind
            );
          } catch (error) {
            if (error instanceof ImmutableJsonPacketStorageError) throw error;
            if (isLeaseConflict(error)) {
              fail(
                "LEASE_CONFLICT",
                "The processor lease is already held.",
                "acquire-lease",
                { kind: kind.kind, recordType: "lease", retryable: true }
              );
            }
            throw asStorageFailure(error, "acquire-lease", kind.kind, "lease");
          }

          let released = false;
          let providerReleasePromise: Promise<void> | undefined;
          const startProviderRelease = (
            providerTimeoutMs: number
          ): Promise<void> => {
            const providerController = new AbortController();
            const providerTimer = setTimeout(
              () => providerController.abort(),
              providerTimeoutMs
            );
            providerTimer.unref();
            let pending: Promise<void>;
            pending = Promise.resolve()
              .then(() =>
                leaseClient.releaseLease({
                  abortSignal: providerController.signal,
                })
              )
              .then(
                () => {
                  released = true;
                },
                (error: unknown) => {
                  if (isReleaseAlreadyComplete(error)) {
                    released = true;
                    return;
                  }
                  if (isLeaseConflict(error)) {
                    fail(
                      "LEASE_CONFLICT",
                      "The processor lease could not be released.",
                      "release-lease",
                      { kind: kind.kind, recordType: "lease" }
                    );
                  }
                  throw asStorageFailure(
                    error,
                    "release-lease",
                    kind.kind,
                    "lease"
                  );
                }
              )
              .finally(() => {
                clearTimeout(providerTimer);
                if (providerReleasePromise === pending) {
                  providerReleasePromise = undefined;
                }
              });
            providerReleasePromise = pending;
            return pending;
          };
          const lease: JsonPacketLease = {
            kind: kind.kind,
            name,
            durationSeconds,
            expiresAt: initialExpiresAt,
            renew: async (renewOptions = {}) => {
              if (released || providerReleasePromise !== undefined) {
                fail("LEASE_CONFLICT", "The processor lease has been released.", "renew-lease", {
                  kind: kind.kind,
                  recordType: "lease",
                });
              }
              return withContext(
                "renew-lease",
                kind.kind,
                resolveTimeout(
                  renewOptions.timeoutMs,
                  config.timeoutMs,
                  "renew-lease"
                ),
                renewOptions.signal,
                async (renewContext) => {
                  const renewalStartedAt = now(config, "renew-lease");
                  try {
                    const response = await renewContext.race(
                      leaseClient.renewLease({
                        abortSignal: renewContext.signal,
                      })
                    );
                    assertProviderLeaseToken(
                      response.leaseId,
                      "renew-lease",
                      kind.kind
                    );
                    return new Date(
                      renewalStartedAt.getTime() + durationSeconds * 1_000
                    ).toISOString();
                  } catch (error) {
                    if (error instanceof ImmutableJsonPacketStorageError) throw error;
                    if (isLeaseConflict(error)) {
                      fail(
                        "LEASE_CONFLICT",
                        "The processor lease could not be renewed.",
                        "renew-lease",
                        {
                          kind: kind.kind,
                          recordType: "lease",
                          retryable: true,
                        }
                      );
                    }
                    throw asStorageFailure(
                      error,
                      "renew-lease",
                      kind.kind,
                      "lease"
                    );
                  }
                }
              );
            },
            release: async (releaseOptions = {}) => {
              if (released) return;
              const releaseTimeoutMs = resolveTimeout(
                releaseOptions.timeoutMs,
                config.timeoutMs,
                "release-lease"
              );
              return withContext(
                "release-lease",
                kind.kind,
                releaseTimeoutMs,
                releaseOptions.signal,
                async (releaseContext) =>
                  releaseContext.race(
                    providerReleasePromise ??
                      startProviderRelease(
                        Math.max(config.timeoutMs, releaseTimeoutMs)
                      )
                  )
              );
            },
          };
          return Object.freeze(lease);
        }
      );
    },
  };

  return Object.freeze(store);
}
