import { inspect } from "node:util";
import type { ContainerClient as AzureBlobContainerClient } from "@azure/storage-blob";
import { createSchema, field, validateUUID } from "@plasius/schema";
import { describe, expect, it } from "vitest";
import {
  IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA,
  ImmutableJsonPacketStorageError,
  createImmutableJsonPacketStore,
  type ImmutableJsonPacketKindConfig,
  type JsonPacketBlobClientPort,
  type JsonPacketBlobContainerPort,
  type JsonPacketBlobDownloadResponsePort,
  type JsonPacketBlobListOptions,
  type JsonPacketBlobListPagePort,
  type JsonPacketBlobPageSettings,
  type JsonPacketBlobUploadOptions,
  type PersistableJsonSchemaPort,
} from "../src/immutable-json-packets.js";

type AzureContainerClientIsStructurallyCompatible =
  AzureBlobContainerClient extends JsonPacketBlobContainerPort ? true : false;
const azureContainerClientIsStructurallyCompatible:
  AzureContainerClientIsStructurallyCompatible = true;

interface StoredBlob {
  bytes: Uint8Array;
  contentType: string;
  metadata: Record<string, string>;
  etag: string;
}

function storageFailure(statusCode: number, code: string, message = code): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

class MemoryLeaseClient {
  leaseId?: string;
  renewCount = 0;
  releaseAttemptCount = 0;
  releaseCount = 0;
  failAcquire?: Error;
  failRenew?: Error;
  failRelease?: Error;
  onRenew?: () => void | Promise<void>;
  onRelease?: () => void | Promise<void>;
  omitAcquireLeaseId = false;
  omitRenewLeaseId = false;

  async acquireLease(): Promise<{ leaseId?: string }> {
    if (this.failAcquire) throw this.failAcquire;
    if (this.leaseId) throw storageFailure(409, "LeaseAlreadyPresent");
    this.leaseId = "synthetic-lease-token";
    return this.omitAcquireLeaseId ? {} : { leaseId: this.leaseId };
  }

  async renewLease(): Promise<{ leaseId?: string }> {
    if (this.failRenew) throw this.failRenew;
    if (!this.leaseId) throw storageFailure(409, "LeaseLost");
    await this.onRenew?.();
    this.renewCount += 1;
    return this.omitRenewLeaseId ? {} : { leaseId: this.leaseId };
  }

  async releaseLease(): Promise<void> {
    this.releaseAttemptCount += 1;
    if (this.failRelease) throw this.failRelease;
    if (!this.leaseId) throw storageFailure(409, "LeaseLost");
    await this.onRelease?.();
    if (!this.leaseId) throw storageFailure(409, "LeaseLost");
    this.releaseCount += 1;
    this.leaseId = undefined;
  }
}

class MemoryJsonBlobContainer implements JsonPacketBlobContainerPort {
  readonly blobs = new Map<string, StoredBlob>();
  readonly operations: Array<{
    type: "download" | "list" | "properties" | "upload";
    path: string;
    options?: JsonPacketBlobUploadOptions;
    listOptions?: JsonPacketBlobListOptions;
    pageSettings?: JsonPacketBlobPageSettings;
  }> = [];
  readonly leases = new Map<string, MemoryLeaseClient>();
  onUpload?: (
    path: string,
    bytes: Uint8Array,
    options: JsonPacketBlobUploadOptions
  ) => void | Promise<void>;
  onDownload?: (path: string) => void | Promise<void>;
  onProperties?: (path: string) => void | Promise<void>;
  onList?: (
    options: JsonPacketBlobListOptions,
    settings: JsonPacketBlobPageSettings
  ) => void | Promise<void>;
  listPageOverride?: JsonPacketBlobListPagePort;
  omitUploadEtag = false;
  uploadEtagOverride?: string;
  private etagSequence = 1;

  getBlockBlobClient(path: string): JsonPacketBlobClientPort {
    return {
      uploadData: async (bytes, options) => {
        this.operations.push({ type: "upload", path, options });
        await this.onUpload?.(path, bytes, options);
        const existing = this.blobs.get(path);
        if (options.conditions.ifNoneMatch === "*" && existing) {
          throw storageFailure(409, "BlobAlreadyExists");
        }
        if (
          options.conditions.ifMatch !== undefined &&
          existing?.etag !== options.conditions.ifMatch
        ) {
          throw storageFailure(412, "ConditionNotMet");
        }
        const etag =
          this.uploadEtagOverride ?? `"etag-${this.etagSequence++}"`;
        this.blobs.set(path, {
          bytes: new Uint8Array(bytes),
          contentType: options.blobHTTPHeaders.blobContentType,
          metadata: { ...options.metadata },
          etag,
        });
        return this.omitUploadEtag ? {} : { etag };
      },
      download: async (_offset, _count, options) => {
        this.operations.push({ type: "download", path });
        await this.onDownload?.(path);
        if (options?.abortSignal?.aborted) {
          throw storageFailure(499, "AbortError");
        }
        const blob = this.blobs.get(path);
        if (!blob) throw storageFailure(404, "BlobNotFound");
        const bytes = new Uint8Array(blob.bytes);
        const body = async function* (): AsyncIterable<Uint8Array> {
          if (bytes.byteLength > 0) yield bytes;
        };
        const response: JsonPacketBlobDownloadResponsePort = {
          readableStreamBody: body(),
          contentLength: bytes.byteLength,
          contentType: blob.contentType,
          metadata: { ...blob.metadata },
          etag: blob.etag,
        };
        return response;
      },
      getProperties: async (options) => {
        this.operations.push({ type: "properties", path });
        await this.onProperties?.(path);
        if (options?.abortSignal?.aborted) {
          throw storageFailure(499, "AbortError");
        }
        const blob = this.blobs.get(path);
        if (!blob) throw storageFailure(404, "BlobNotFound");
        return {
          contentLength: blob.bytes.byteLength,
          contentType: blob.contentType,
          metadata: { ...blob.metadata },
          etag: blob.etag,
        };
      },
      getBlobLeaseClient: () => {
        let lease = this.leases.get(path);
        if (!lease) {
          lease = new MemoryLeaseClient();
          this.leases.set(path, lease);
        }
        return lease;
      },
    };
  }

  listBlobsFlat(options: JsonPacketBlobListOptions) {
    return {
      byPage: (settings: JsonPacketBlobPageSettings = {}) =>
        this.listPages(options, settings),
    };
  }

  private async *listPages(
    options: JsonPacketBlobListOptions,
    settings: JsonPacketBlobPageSettings
  ): AsyncIterable<JsonPacketBlobListPagePort> {
    this.operations.push({
      type: "list",
      path: options.prefix,
      listOptions: options,
      pageSettings: settings,
    });
    await this.onList?.(options, settings);
    if (options.abortSignal?.aborted) {
      throw storageFailure(499, "AbortError");
    }
    if (this.listPageOverride) {
      yield this.listPageOverride;
      return;
    }
    const offset = settings.continuationToken
      ? Number(settings.continuationToken.replace("synthetic-offset-", ""))
      : 0;
    const maxPageSize = settings.maxPageSize ?? 5_000;
    const matches = [...this.blobs.entries()]
      .filter(([name]) => name.startsWith(options.prefix))
      .sort(([left], [right]) => left.localeCompare(right));
    const selected = matches.slice(offset, offset + maxPageSize);
    const nextOffset = offset + selected.length;
    yield {
      continuationToken:
        nextOffset < matches.length
          ? `synthetic-offset-${nextOffset}`
          : undefined,
      segment: {
        blobItems: selected.map(([name, blob]) => ({
          name,
          metadata: { ...blob.metadata },
          properties: {
            contentLength: blob.bytes.byteLength,
            contentType: blob.contentType,
            etag: blob.etag,
          },
        })),
      },
    };
  }
}

interface SafePacket {
  readonly schema: string;
  readonly severity: number;
  readonly issueType: string;
  readonly surfaceId: string;
  readonly intentIds: readonly string[];
}

interface IndexedSafePacket extends SafePacket {
  readonly acceptedAt: string;
}

function schema<T>(
  entityType: string,
  validate: (input: unknown) => T | undefined,
  piiAudit: readonly { field: string; classification: string }[] = []
): PersistableJsonSchemaPort<T> {
  return {
    meta: { entityType, version: "1.0.0" },
    validate: (input) => {
      const value = validate(input);
      return value === undefined
        ? { valid: false, issues: [{ code: "invalid", path: "", message: "invalid" }] }
        : { valid: true, value };
    },
    getPiiAudit: () => piiAudit,
  };
}

const packetSchema = schema<SafePacket>("feedbackBugPacket", (input) => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    return undefined;
  }
  const candidate = input as Record<string, unknown>;
  if (
    candidate.schema !== "feedback.bug/1" ||
    !Number.isInteger(candidate.severity) ||
    typeof candidate.issueType !== "string" ||
    typeof candidate.surfaceId !== "string" ||
    !Array.isArray(candidate.intentIds) ||
    !candidate.intentIds.every((value) => typeof value === "string")
  ) {
    return undefined;
  }
  return {
    schema: candidate.schema,
    severity: candidate.severity as number,
    issueType: candidate.issueType,
    surfaceId: candidate.surfaceId,
    intentIds: [...candidate.intentIds] as string[],
  };
});

const checkpointSchema = schema<{ cursor: number; revision: number }>(
  "feedbackBugCheckpoint",
  (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return undefined;
    }
    const candidate = input as Record<string, unknown>;
    if (
      !Number.isSafeInteger(candidate.cursor) ||
      !Number.isSafeInteger(candidate.revision)
    ) {
      return undefined;
    }
    return {
      cursor: candidate.cursor as number,
      revision: candidate.revision as number,
    };
  }
);

const indexedPacketSchema = schema<IndexedSafePacket>(
  "feedbackIndexedBugPacket",
  (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return undefined;
    }
    const candidate = input as Record<string, unknown>;
    const base = packetSchema.validate(candidate);
    if (
      !base.valid ||
      base.value === undefined ||
      typeof candidate.acceptedAt !== "string" ||
      new Date(candidate.acceptedAt).toISOString() !== candidate.acceptedAt
    ) {
      return undefined;
    }
    return { ...base.value, acceptedAt: candidate.acceptedAt };
  }
);

const kindConfig: ImmutableJsonPacketKindConfig<SafePacket> = {
  prefix: "feedback/bugs",
  packetSchema,
  checkpointSchema,
  safeDeadLetterCodes: ["CLASSIFIER_UNAVAILABLE", "PACKET_SCHEMA_REJECTED"],
};

function packet(overrides: Partial<SafePacket> = {}): SafePacket {
  return {
    schema: "feedback.bug/1",
    severity: 3,
    issueType: "functionality",
    surfaceId: "gameplay",
    intentIds: ["controls"],
    ...overrides,
  };
}

function indexedPacket(
  acceptedAt: string,
  overrides: Partial<SafePacket> = {}
): IndexedSafePacket {
  return { ...packet(overrides), acceptedAt };
}

function createIndexedStore(
  container = new MemoryJsonBlobContainer(),
  clock: () => Date = () => new Date("2026-07-18T13:05:00.000Z"),
  partition: "hour" | "day" = "hour"
) {
  return {
    container,
    store: createImmutableJsonPacketStore({
      container,
      kinds: {
        bug: {
          ...kindConfig,
          packetSchema: indexedPacketSchema,
          timeIndex: {
            prefix: "feedback-index/bugs",
            timestampField: "acceptedAt",
            partition,
          },
        },
      },
      timeoutMs: 1_000,
      maxPacketBytes: 8_192,
      maxReadBytes: 64 * 1024,
      maxListPageItems: 10,
      maxListPageBytes: 64 * 1024,
      maxManifestEntries: 100,
      clock,
    }),
  };
}

function createStore(
  container = new MemoryJsonBlobContainer(),
  overrides: Partial<ImmutableJsonPacketKindConfig<SafePacket>> = {}
) {
  return {
    container,
    store: createImmutableJsonPacketStore({
      container,
      kinds: {
        bug: { ...kindConfig, ...overrides },
      },
      timeoutMs: 1_000,
      maxPacketBytes: 8_192,
      maxReadBytes: 64 * 1024,
      maxListPageItems: 10,
      maxListPageBytes: 64 * 1024,
      maxManifestEntries: 100,
      clock: () => new Date("2026-07-18T12:00:00.000Z"),
    }),
  };
}

function listedBlob(
  container: MemoryJsonBlobContainer,
  path: string
): JsonPacketBlobListPagePort["segment"]["blobItems"][number] {
  const blob = container.blobs.get(path);
  if (!blob) throw new Error("missing test blob");
  return {
    name: path,
    metadata: { ...blob.metadata },
    properties: {
      contentLength: blob.bytes.byteLength,
      contentType: blob.contentType,
      etag: blob.etag,
    },
  };
}

describe("immutable schema-backed JSON packet storage", () => {
  it("accepts the structural validation and empty PII audit surface from @plasius/schema", async () => {
    const compatibleSchema = createSchema(
      {
        packetId: field.string().required().validator(validateUUID),
        acceptedAt: field.dateTimeISO().required(),
        severity: field.number().required().min(1).max(5),
        issueType: field
          .string()
          .required()
          .enum(["functionality", "visual"] as const),
        surfaceId: field
          .string()
          .required()
          .enum(["gameplay", "public-home"] as const),
        intentIds: field.array(
          field.string().enum(["controls", "rendering"] as const)
        ),
      },
      "storageFeedbackPacketCompatibility",
      { version: "1.0.0", piiEnforcement: "strict" }
    );
    const container = new MemoryJsonBlobContainer();
    const store = createImmutableJsonPacketStore({
      container,
      kinds: {
        bug: {
          prefix: "feedback/bugs",
          packetSchema: compatibleSchema,
          safeDeadLetterCodes: [],
        },
      },
    });

    await expect(
      store.writePacket("bug", "bug_01j1te5t000000000000000000", {
        type: "storageFeedbackPacketCompatibility",
        version: "1.0.0",
        packetId: "550e8400-e29b-41d4-a716-446655440000",
        acceptedAt: "2026-07-18T12:00:00.000Z",
        severity: 3,
        issueType: "functionality",
        surfaceId: "gameplay",
        intentIds: ["controls"],
      })
    ).resolves.toMatchObject({
      schemaId: "storageFeedbackPacketCompatibility",
      schemaVersion: "1.0.0",
    });
  });

  it("conditionally creates canonical schema-validated packets and exactly replays them", async () => {
    const { container, store } = createStore();
    const packetId = "bug_01j1te5t000000000000000001";

    const first = await store.writePacket("bug", packetId, packet());
    const second = await store.writePacket("bug", packetId, {
      intentIds: ["controls"],
      surfaceId: "gameplay",
      issueType: "functionality",
      severity: 3,
      schema: "feedback.bug/1",
    });

    expect(first).toMatchObject({
      recordType: "packet",
      kind: "bug",
      packetId,
      schemaId: "feedbackBugPacket",
      schemaVersion: "1.0.0",
      replayed: false,
    });
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.byteLength).toBeGreaterThan(0);
    expect(second).toMatchObject({ ...first, replayed: true });
    expect(
      container.operations.filter((operation) => operation.type === "upload")
    ).toHaveLength(2);
    expect(
      container.operations.find((operation) => operation.type === "upload")
        ?.options?.conditions
    ).toEqual({ ifNoneMatch: "*" });
    const stored = [...container.blobs.values()][0];
    expect(stored?.contentType).toBe("application/json");
    expect(new TextDecoder().decode(stored?.bytes)).toContain(
      `"storageSchema":"${IMMUTABLE_JSON_PACKET_STORAGE_SCHEMA}"`
    );
  });

  it("rejects a different packet at the same immutable identifier", async () => {
    const { store } = createStore();
    const packetId = "bug_01j1te5t000000000000000002";
    await store.writePacket("bug", packetId, packet());

    await expect(
      store.writePacket("bug", packetId, packet({ severity: 5 }))
    ).rejects.toMatchObject({
      code: "IMMUTABLE_CONFLICT",
      diagnostic: {
        operation: "write-packet",
        retryable: false,
      },
    });
  });

  it("converges identical concurrent packet writers and rejects a different racer", async () => {
    const { store } = createStore();
    const identicalId = "bug_01j1te5t000000000000000021";
    const identical = await Promise.all([
      store.writePacket("bug", identicalId, packet()),
      store.writePacket("bug", identicalId, packet()),
    ]);
    expect(identical.map((receipt) => receipt.replayed).sort()).toEqual([
      false,
      true,
    ]);

    const conflictingId = "bug_01j1te5t000000000000000022";
    const conflicting = await Promise.allSettled([
      store.writePacket("bug", conflictingId, packet({ severity: 2 })),
      store.writePacket("bug", conflictingId, packet({ severity: 4 })),
    ]);
    expect(
      conflicting.filter((outcome) => outcome.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      conflicting.find((outcome) => outcome.status === "rejected")
    ).toMatchObject({
      status: "rejected",
      reason: { code: "IMMUTABLE_CONFLICT" },
    });
  });

  it("rejects schema failures and privacy-unsafe packet shapes before Blob access", async () => {
    const { container, store } = createStore();

    await expect(
      store.writePacket("bug", "bug_01j1te5t000000000000000003", {
        ...packet(),
        severity: "critical",
      })
    ).rejects.toMatchObject({ code: "SCHEMA_REJECTED" });

    await expect(
      store.writePacket("bug", "bug_01j1te5t000000000000000004", {
        ...packet(),
        narrative: "synthetic-only",
      })
    ).rejects.toMatchObject({ code: "SENSITIVE_FIELD_REJECTED" });

    expect(container.operations).toHaveLength(0);
  });

  it("fails closed when a registered schema declares PII or a prefix is unsafe", () => {
    const container = new MemoryJsonBlobContainer();
    const unsafeSchema = schema(
      "unsafePacket",
      () => packet(),
      [{ field: "accountSubject", classification: "high" }]
    );

    expect(() =>
      createImmutableJsonPacketStore({
        container,
        kinds: {
          bug: { ...kindConfig, packetSchema: unsafeSchema },
        },
      })
    ).toThrowError(
      expect.objectContaining({ code: "SCHEMA_PII_NOT_ALLOWED" })
    );

    expect(() =>
      createImmutableJsonPacketStore({
        container,
        kinds: {
          bug: { ...kindConfig, prefix: "feedback/../private" },
        },
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it("enforces byte limits and deadlines without leaking provider details", async () => {
    const oversized = createStore(new MemoryJsonBlobContainer(), {
      maxPacketBytes: 180,
    });
    await expect(
      oversized.store.writePacket(
        "bug",
        "bug_01j1te5t000000000000000005",
        packet()
      )
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(oversized.container.operations).toHaveLength(0);

    const { container, store } = createStore();
    container.onUpload = async () => {
      await new Promise<void>(() => undefined);
    };
    const error = await store
      .writePacket(
        "bug",
        "bug_01j1te5t000000000000000006",
        packet(),
        { timeoutMs: 5 }
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImmutableJsonPacketStorageError);
    expect(error).toMatchObject({ code: "DEADLINE_EXCEEDED" });
  });

  it("redacts storage causes, packet values, and provider messages from errors", async () => {
    const { container, store } = createStore();
    container.onUpload = () => {
      throw storageFailure(
        500,
        "InternalError",
        "synthetic-provider-detail?sig=synthetic-secret"
      );
    };

    const error = await store
      .writePacket(
        "bug",
        "bug_01j1te5t000000000000000007",
        packet({ surfaceId: "private-synthetic-value" })
      )
      .catch((caught: unknown) => caught);
    const rendered = inspect(error, { depth: 10 });

    expect(error).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      cause: { redacted: true },
    });
    expect(rendered).not.toContain("synthetic-provider-detail");
    expect(rendered).not.toContain("synthetic-secret");
    expect(rendered).not.toContain("private-synthetic-value");
  });

  it("reads packets only through exact kind/id addressing and verifies integrity", async () => {
    const { container, store } = createStore();
    const packetId = "bug_01j1te5t000000000000000008";
    await store.writePacket("bug", packetId, packet());

    await expect(store.readPacket("bug", packetId)).resolves.toEqual(packet());

    const stored = [...container.blobs.values()][0];
    if (!stored) throw new Error("missing test blob");
    stored.bytes = new TextEncoder().encode('{"tampered":true}\n');
    await expect(store.readPacket("bug", packetId)).rejects.toMatchObject({
      code: "CORRUPT_RECORD",
    });
  });

  it("rejects malformed structured values, unsafe strings, identifiers, and operation options", async () => {
    const { container, store } = createStore();
    const cyclic: Record<string, unknown> = { ...packet() };
    cyclic.extra = cyclic;
    const intentIds = ["controls"];
    Object.defineProperty(intentIds, "hidden", {
      value: "synthetic-only",
      enumerable: false,
    });

    const cases: Array<Promise<unknown>> = [
      store.writePacket("bug", "x", packet()),
      store.writePacket("bug", "bug_01j1te5t000000000000000011", {
        ...packet(),
        surfaceId: "https://example.invalid/synthetic",
      }),
      store.writePacket("bug", "bug_01j1te5t000000000000000012", cyclic),
      store.writePacket("bug", "bug_01j1te5t000000000000000013", {
        ...packet(),
        severity: Number.NaN,
      }),
      store.writePacket("bug", "bug_01j1te5t000000000000000014", {
        ...packet(),
        intentIds,
      }),
      store.writePacket(
        "bug",
        "bug_01j1te5t000000000000000015",
        packet(),
        { timeoutMs: 0 }
      ),
      store.writePacket(
        "missing" as "bug",
        "bug_01j1te5t000000000000000016",
        packet()
      ),
    ];

    const outcomes = await Promise.allSettled(cases);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(
      outcomes.map((outcome) =>
        outcome.status === "rejected" ? outcome.reason.code : "fulfilled"
      )
    ).toEqual([
      "INVALID_ARGUMENT",
      "SENSITIVE_FIELD_REJECTED",
      "INVALID_ARGUMENT",
      "INVALID_ARGUMENT",
      "INVALID_ARGUMENT",
      "INVALID_ARGUMENT",
      "INVALID_ARGUMENT",
    ]);
    expect(container.operations).toHaveLength(0);
  });

  it("rejects sensitive, unbounded, control-bearing, URL-like, and dynamic object keys", async () => {
    const { container, store } = createStore();
    const unsafeKeys = [
      "user-id",
      "someone@example.invalid",
      "https://example.invalid/private",
      "dynamic key",
      `control\u0007key`,
      `a${"b".repeat(128)}`,
    ];

    const outcomes = await Promise.allSettled(
      unsafeKeys.map((key, index) =>
        store.writePacket(
          "bug",
          `bug_01j1te5t0000000000000001${index}`,
          { ...packet(), [key]: "synthetic-only" }
        )
      )
    );

    expect(outcomes).toHaveLength(unsafeKeys.length);
    expect(
      outcomes.every(
        (outcome) =>
          outcome.status === "rejected" &&
          outcome.reason instanceof ImmutableJsonPacketStorageError &&
          outcome.reason.code === "SENSITIVE_FIELD_REJECTED"
      )
    ).toBe(true);
    expect(container.operations).toHaveLength(0);
  });

  it("revalidates object keys emitted by a schema and rejects unsafe dynamic output", async () => {
    const container = new MemoryJsonBlobContainer();
    const unsafeOutputSchema = schema<Record<string, unknown>>(
      "unsafeDynamicOutput",
      () => ({ ...packet(), "user-id": "synthetic-only" })
    );
    const store = createImmutableJsonPacketStore({
      container,
      kinds: {
        bug: {
          prefix: "feedback/bugs",
          packetSchema: unsafeOutputSchema,
        },
      },
    });

    await expect(
      store.writePacket(
        "bug",
        "bug_01j1te5t000000000000000170",
        packet()
      )
    ).rejects.toMatchObject({ code: "SENSITIVE_FIELD_REJECTED" });
    expect(container.operations).toHaveLength(0);
  });

  it("rejects arrays over the member budget before enumerating sparse keys", async () => {
    const { container, store } = createStore();
    const sparse = new Proxy(new Array(10_001), {
      ownKeys: () => {
        throw new Error("array keys must not be enumerated after the length bound");
      },
    });

    await expect(
      store.writePacket(
        "bug",
        "bug_01j1te5t000000000000000171",
        { ...packet(), intentIds: sparse }
      )
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(container.operations).toHaveLength(0);
  });

  it("honours caller cancellation before touching Blob storage", async () => {
    const { container, store } = createStore();
    const controller = new AbortController();
    controller.abort();

    await expect(
      store.writePacket(
        "bug",
        "bug_01j1te5t000000000000000017",
        packet(),
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(container.operations).toHaveLength(0);
  });

  it("reports missing records and malformed integrity metadata safely", async () => {
    const { container, store } = createStore();
    await expect(
      store.readPacket("bug", "bug_01j1te5t000000000000000018")
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const packetId = "bug_01j1te5t000000000000000019";
    await store.writePacket("bug", packetId, packet());
    const stored = [...container.blobs.values()][0];
    if (!stored) throw new Error("missing test blob");
    stored.metadata = {};
    await expect(store.readPacket("bug", packetId)).rejects.toMatchObject({
      code: "CORRUPT_RECORD",
    });
  });

  it("rejects write acknowledgements without an ETag", async () => {
    const container = new MemoryJsonBlobContainer();
    container.omitUploadEtag = true;
    const { store } = createStore(container);

    await expect(
      store.writePacket("bug", "bug_01j1te5t000000000000000020", packet())
    ).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      diagnostic: { retryable: true },
    });
  });

  it("bounds and validates provider-returned ETags on writes and reads", async () => {
    const invalidWrite = new MemoryJsonBlobContainer();
    invalidWrite.uploadEtagOverride = "invalid\r\netag";
    await expect(
      createStore(invalidWrite).store.writePacket(
        "bug",
        "bug_01j1te5t000000000000000172",
        packet()
      )
    ).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      diagnostic: { retryable: true },
    });

    const { container, store } = createStore();
    const packetId = "bug_01j1te5t000000000000000173";
    await store.writePacket("bug", packetId, packet());
    const stored = [...container.blobs.values()][0];
    if (!stored) throw new Error("missing test blob");
    stored.etag = `"${"e".repeat(300)}"`;
    await expect(store.readPacket("bug", packetId)).rejects.toMatchObject({
      code: "CORRUPT_RECORD",
    });
  });

  it("does not misclassify arbitrary HTTP 409 failures as immutable collisions", async () => {
    const { container, store } = createStore();
    container.onUpload = () => {
      throw storageFailure(409, "InternalError");
    };

    await expect(
      store.writePacket(
        "bug",
        "bug_01j1te5t000000000000000174",
        packet()
      )
    ).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(
      container.operations.filter((operation) => operation.type === "download")
    ).toHaveLength(0);
  });
});

describe("bounded fixed-prefix packet enumeration", () => {
  it("lists only fixed-prefix packet descriptors with deterministic cursor paging", async () => {
    expect(azureContainerClientIsStructurallyCompatible).toBe(true);
    const { container, store } = createStore();
    const packetIds = [
      "bug_01j1te5t000000000000000203",
      "bug_01j1te5t000000000000000201",
      "bug_01j1te5t000000000000000202",
    ];
    for (const packetId of packetIds) {
      await store.writePacket("bug", packetId, packet());
    }
    await store.compareAndSwapCheckpoint(
      "bug",
      "hourly-materializer",
      null,
      { cursor: 0, revision: 0 }
    );

    const first = await store.listPacketPage("bug", {
      maxItems: 2,
      maxBytes: 32 * 1024,
    });
    const repeated = await store.listPacketPage("bug", {
      maxItems: 2,
      maxBytes: 32 * 1024,
    });

    expect(first).toMatchObject({
      kind: "bug",
      complete: false,
      packets: [
        { packetId: packetIds[1], schemaId: "feedbackBugPacket" },
        { packetId: packetIds[2], schemaId: "feedbackBugPacket" },
      ],
    });
    expect(first.nextCursor).toBe(repeated.nextCursor);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first.nextCursor).not.toContain("synthetic-offset-2");
    expect(first.byteLength).toBe(
      first.packets.reduce((total, item) => total + item.byteLength, 0)
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.packets)).toBe(true);
    expect(Object.isFrozen(first.packets[0])).toBe(true);

    const second = await store.listPacketPage("bug", {
      cursor: first.nextCursor,
      maxItems: 2,
      maxBytes: 32 * 1024,
    });
    expect(second).toMatchObject({
      kind: "bug",
      complete: true,
      packets: [{ packetId: packetIds[0] }],
    });
    expect(second.nextCursor).toBeUndefined();
    await expect(
      store.readPacket("bug", second.packets[0]?.packetId as string)
    ).resolves.toEqual(packet());

    const listOperations = container.operations.filter(
      (operation) => operation.type === "list"
    );
    expect(listOperations).toHaveLength(3);
    expect(listOperations[0]).toMatchObject({
      path: "feedback/bugs/packets/",
      listOptions: {
        prefix: "feedback/bugs/packets/",
        includeMetadata: true,
      },
      pageSettings: { maxPageSize: 2 },
    });
    expect(listOperations[2]?.pageSettings?.continuationToken).toBe(
      "synthetic-offset-2"
    );
    const renderedPage = inspect(first, { depth: 10 });
    expect(renderedPage).not.toContain("feedback/bugs");
    expect(renderedPage).not.toContain("functionality");
    expect(renderedPage).not.toContain("gameplay");
    expect(renderedPage).not.toContain("controls");
  });

  it("ignores runtime attempts to inject a scan prefix and fails closed without a list driver", async () => {
    const { container, store } = createStore();
    await store.writePacket(
      "bug",
      "bug_01j1te5t000000000000000209",
      packet()
    );
    await store.listPacketPage("bug", {
      prefix: "feedback/reviews/packets/",
    } as never);
    expect(
      container.operations.find((operation) => operation.type === "list")?.path
    ).toBe("feedback/bugs/packets/");

    const writeOnlyContainer: JsonPacketBlobContainerPort = {
      getBlockBlobClient: (path) => container.getBlockBlobClient(path),
    };
    const writeOnlyStore = createImmutableJsonPacketStore({
      container: writeOnlyContainer,
      kinds: { bug: kindConfig },
    });
    await expect(writeOnlyStore.listPacketPage("bug")).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      diagnostic: { operation: "list-packets", recordType: "packet" },
    });
  });

  it("binds opaque cursors to their configured packet kind", async () => {
    const container = new MemoryJsonBlobContainer();
    const store = createImmutableJsonPacketStore({
      container,
      kinds: {
        bug: kindConfig,
        review: { ...kindConfig, prefix: "feedback/reviews" },
      },
      maxListPageItems: 1,
      maxListPageBytes: 64 * 1024,
    });
    await store.writePacket(
      "bug",
      "bug_01j1te5t000000000000000211",
      packet()
    );
    await store.writePacket(
      "bug",
      "bug_01j1te5t000000000000000212",
      packet()
    );
    const first = await store.listPacketPage("bug");

    await expect(
      store.listPacketPage("review", { cursor: first.nextCursor })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      store.listPacketPage("bug", { cursor: "not-a-valid-cursor" })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      store.listPacketPage("bug", { cursor: "x".repeat(8 * 1024 + 1) })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(
      container.operations.filter((operation) => operation.type === "list")
    ).toHaveLength(1);
  });

  it("rejects request bounds before invoking the Blob listing port", async () => {
    const { container, store } = createStore();
    const outcomes = await Promise.allSettled([
      store.listPacketPage("bug", { maxItems: 0 }),
      store.listPacketPage("bug", { maxItems: 11 }),
      store.listPacketPage("bug", { maxBytes: 0 }),
      store.listPacketPage("bug", { maxBytes: 64 * 1024 + 1 }),
      store.listPacketPage("bug", { timeoutMs: 0 }),
      store.listPacketPage("missing" as "bug"),
    ]);

    expect(
      outcomes.every(
        (outcome) =>
          outcome.status === "rejected" &&
          outcome.reason instanceof ImmutableJsonPacketStorageError &&
          outcome.reason.code === "INVALID_ARGUMENT"
      )
    ).toBe(true);
    expect(container.operations).toHaveLength(0);
  });

  it("fails closed on out-of-prefix, malformed, duplicate, and non-progressing pages", async () => {
    const path = "feedback/bugs/packets/bug_01j1te5t000000000000000221.json";
    const makeCase = async (
      page: (item: ReturnType<typeof listedBlob>) => JsonPacketBlobListPagePort,
      expectedCode: "CORRUPT_RECORD" | "LIMIT_EXCEEDED",
      maxBytes = 16 * 1024
    ) => {
      const { container, store } = createStore();
      await store.writePacket(
        "bug",
        "bug_01j1te5t000000000000000221",
        packet()
      );
      container.listPageOverride = page(listedBlob(container, path));
      await expect(
        store.listPacketPage("bug", { maxItems: 2, maxBytes })
      ).rejects.toMatchObject({ code: expectedCode });
    };

    await makeCase(
      (item) => ({
        segment: {
          blobItems: [{ ...item, name: "feedback/reviews/packets/foreign.json" }],
        },
      }),
      "CORRUPT_RECORD"
    );
    await makeCase(
      (item) => ({
        segment: {
          blobItems: [
            {
              ...item,
              properties: { ...item.properties, contentLength: 1 },
            },
          ],
        },
      }),
      "CORRUPT_RECORD"
    );
    await makeCase(
      (item) => ({
        segment: {
          blobItems: [
            { ...item, metadata: { ...item.metadata, userid: "synthetic" } },
          ],
        },
      }),
      "CORRUPT_RECORD"
    );
    await makeCase(
      (item) => ({ segment: { blobItems: [item, item] } }),
      "CORRUPT_RECORD"
    );
    await makeCase(
      () => ({
        continuationToken: "synthetic-non-progressing-token",
        segment: { blobItems: [] },
      }),
      "CORRUPT_RECORD"
    );
    await makeCase(
      (item) => ({ segment: { blobItems: [item] } }),
      "LIMIT_EXCEEDED",
      1
    );
  });

  it("bounds provider pages independently of requested page size", async () => {
    const { container, store } = createStore();
    await store.writePacket(
      "bug",
      "bug_01j1te5t000000000000000231",
      packet()
    );
    const item = listedBlob(
      container,
      "feedback/bugs/packets/bug_01j1te5t000000000000000231.json"
    );
    container.listPageOverride = {
      segment: { blobItems: [item, { ...item, name: item.name.replace("231", "232") }] },
    };

    await expect(
      store.listPacketPage("bug", { maxItems: 1 })
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("rejects oversized and non-advancing provider continuations", async () => {
    const { container, store } = createStore();
    await store.writePacket(
      "bug",
      "bug_01j1te5t000000000000000235",
      packet()
    );
    const item = listedBlob(
      container,
      "feedback/bugs/packets/bug_01j1te5t000000000000000235.json"
    );
    container.listPageOverride = {
      continuationToken: "x".repeat(4 * 1024 + 1),
      segment: { blobItems: [item] },
    };
    await expect(store.listPacketPage("bug")).rejects.toMatchObject({
      code: "CORRUPT_RECORD",
    });

    container.listPageOverride = undefined;
    await store.writePacket(
      "bug",
      "bug_01j1te5t000000000000000236",
      packet()
    );
    const first = await store.listPacketPage("bug", { maxItems: 1 });
    const rawContinuation = container.operations
      .filter((operation) => operation.type === "list")
      .at(-1)?.pageSettings?.continuationToken;
    expect(rawContinuation).toBeUndefined();
    container.listPageOverride = {
      continuationToken: "synthetic-offset-1",
      segment: { blobItems: [item] },
    };
    await expect(
      store.listPacketPage("bug", {
        cursor: first.nextCursor,
        maxItems: 1,
      })
    ).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
  });

  it("honours cancellation and deadlines and redacts listing-provider failures", async () => {
    const cancelled = createStore();
    const controller = new AbortController();
    controller.abort();
    await expect(
      cancelled.store.listPacketPage("bug", { signal: controller.signal })
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(cancelled.container.operations).toHaveLength(0);

    const timed = createStore();
    let deadlineSignal: AbortSignal | undefined;
    timed.container.onList = async () => {
      deadlineSignal = timed.container.operations.at(-1)?.listOptions?.abortSignal;
      await new Promise<void>(() => undefined);
    };
    await expect(
      timed.store.listPacketPage("bug", { timeoutMs: 5 })
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(deadlineSignal?.aborted).toBe(true);

    const failed = createStore();
    failed.container.onList = () => {
      throw storageFailure(
        500,
        "InternalError",
        "synthetic-list-provider-detail?sig=synthetic-secret"
      );
    };
    const error = await failed.store
      .listPacketPage("bug")
      .catch((caught: unknown) => caught);
    const rendered = inspect(error, { depth: 10 });
    expect(error).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      cause: { redacted: true },
      diagnostic: { operation: "list-packets", recordType: "packet" },
    });
    expect(rendered).not.toContain("synthetic-list-provider-detail");
    expect(rendered).not.toContain("synthetic-secret");
  });

  it("keeps payload validation and full byte integrity at the exact read boundary", async () => {
    const { container, store } = createStore();
    const packetId = "bug_01j1te5t000000000000000241";
    await store.writePacket("bug", packetId, packet());
    const page = await store.listPacketPage("bug");
    expect(page.packets).toHaveLength(1);

    const stored = container.blobs.get(
      `feedback/bugs/packets/${packetId}.json`
    );
    if (!stored) throw new Error("missing test blob");
    stored.bytes = new TextEncoder().encode('{"tampered":true}\n');
    await expect(store.readPacket("bug", packetId)).rejects.toMatchObject({
      code: "CORRUPT_RECORD",
    });
  });
});

describe("processor coordination records", () => {
  it("performs create/update checkpoint CAS and treats exact uncertain retries idempotently", async () => {
    const { container, store } = createStore();

    const created = await store.compareAndSwapCheckpoint(
      "bug",
      "hourly-materializer",
      null,
      { cursor: 10, revision: 1 }
    );
    expect(created).toMatchObject({ replayed: false, value: { cursor: 10, revision: 1 } });

    const retried = await store.compareAndSwapCheckpoint(
      "bug",
      "hourly-materializer",
      null,
      { cursor: 10, revision: 1 }
    );
    expect(retried).toMatchObject({ replayed: true, etag: created.etag });

    const updated = await store.compareAndSwapCheckpoint(
      "bug",
      "hourly-materializer",
      created.etag,
      { cursor: 20, revision: 2 }
    );
    expect(updated.etag).not.toBe(created.etag);
    expect(await store.readCheckpoint("bug", "hourly-materializer")).toMatchObject({
      etag: updated.etag,
      value: { cursor: 20, revision: 2 },
    });

    const uploadOptions = container.operations
      .filter((operation) => operation.type === "upload")
      .at(-1)?.options;
    expect(uploadOptions?.conditions).toEqual({ ifMatch: created.etag });
  });

  it("returns no checkpoint for an uninitialised processor and requires a schema", async () => {
    const { store } = createStore();
    await expect(
      store.readCheckpoint("bug", "hourly-materializer")
    ).resolves.toBeUndefined();

    const withoutCheckpointSchema = createStore(
      new MemoryJsonBlobContainer(),
      { checkpointSchema: undefined }
    ).store;
    await expect(
      withoutCheckpointSchema.readCheckpoint("bug", "hourly-materializer")
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      withoutCheckpointSchema.compareAndSwapCheckpoint(
        "bug",
        "hourly-materializer",
        null,
        { cursor: 1, revision: 1 }
      )
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("allows only one different concurrent checkpoint writer to win", async () => {
    const { store } = createStore();
    const created = await store.compareAndSwapCheckpoint(
      "bug",
      "hourly-materializer",
      null,
      { cursor: 1, revision: 1 }
    );

    const outcomes = await Promise.allSettled([
      store.compareAndSwapCheckpoint(
        "bug",
        "hourly-materializer",
        created.etag,
        { cursor: 2, revision: 2 }
      ),
      store.compareAndSwapCheckpoint(
        "bug",
        "hourly-materializer",
        created.etag,
        { cursor: 3, revision: 2 }
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: { code: "CHECKPOINT_CONFLICT" },
    });
  });

  it("writes replay-safe manifests containing only bounded receipt facts", async () => {
    const { store } = createStore();
    const packetId = "bug_01j1te5t000000000000000009";
    const receipt = await store.writePacket("bug", packetId, packet());
    const input = {
      windowStart: "2026-07-18T11:00:00.000Z",
      windowEnd: "2026-07-18T12:00:00.000Z",
      revision: 1,
      packets: [
        {
          packetId,
          sha256: receipt.sha256,
          byteLength: receipt.byteLength,
        },
      ],
    };

    const first = await store.writeManifest("bug", "2026-07-18t11-r1", input);
    const replay = await store.writeManifest("bug", "2026-07-18t11-r1", input);

    expect(first).toMatchObject({
      recordType: "manifest",
      replayed: false,
      entryCount: 1,
    });
    expect(replay).toMatchObject({ ...first, replayed: true });
    await expect(
      store.writeManifest("bug", "2026-07-18t11-r2", {
        ...input,
        packets: [input.packets[0], input.packets[0]],
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await expect(
      store.writeManifest("bug", "2026-07-18t11-r3", {
        ...input,
        windowEnd: input.windowStart,
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      store.writeManifest("bug", "2026-07-18t11-r4", {
        ...input,
        windowStart: "not-a-timestamp",
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("stores only allowlisted dead-letter codes and fixed safe metadata", async () => {
    const { container, store } = createStore();
    const receipt = await store.writeDeadLetter(
      "bug",
      "dead_01j1te5t00000000000000001",
      {
        packetId: "bug_01j1te5t000000000000000010",
        errorCode: "CLASSIFIER_UNAVAILABLE",
        attempt: 2,
        retryable: true,
      }
    );
    expect(receipt).toMatchObject({ recordType: "dead-letter", replayed: false });

    const storedText = [...container.blobs.values()]
      .map((blob) => new TextDecoder().decode(blob.bytes))
      .join("\n");
    expect(storedText).toContain("CLASSIFIER_UNAVAILABLE");
    expect(storedText).toContain('"recordedAt":"2026-07-18T12:00:00.000Z"');
    expect(storedText).not.toContain("message");
    expect(storedText).not.toContain("stack");

    const callerTimestamped = {
      packetId: "bug_01j1te5t000000000000000010",
      errorCode: "CLASSIFIER_UNAVAILABLE",
      recordedAt: "2020-01-01T00:00:00.000Z",
      attempt: 2,
      retryable: true,
    };
    await expect(
      store.writeDeadLetter(
        "bug",
        "dead_01j1te5t00000000000000003",
        callerTimestamped
      )
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await expect(
      store.writeDeadLetter("bug", "dead_01j1te5t00000000000000002", {
        packetId: "bug_01j1te5t000000000000000010",
        errorCode: "RAW_PROVIDER_MESSAGE",
        attempt: 2,
        retryable: true,
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("replays a server-timestamped dead letter after the server clock advances", async () => {
    const container = new MemoryJsonBlobContainer();
    let clockValue = new Date("2026-07-18T12:00:00.000Z");
    const store = createImmutableJsonPacketStore({
      container,
      kinds: { bug: kindConfig },
      clock: () => new Date(clockValue.getTime()),
    });
    const input = {
      packetId: "bug_01j1te5t000000000000000180",
      errorCode: "CLASSIFIER_UNAVAILABLE",
      attempt: 2,
      retryable: true,
    };

    const first = await store.writeDeadLetter(
      "bug",
      "dead_01j1te5t00000000000000004",
      input
    );
    clockValue = new Date("2026-07-18T12:05:00.000Z");
    const replay = await store.writeDeadLetter(
      "bug",
      "dead_01j1te5t00000000000000004",
      input
    );

    expect(replay).toMatchObject({
      ...first,
      replayed: true,
    });
  });

  it("does not misclassify arbitrary HTTP 409 failures as checkpoint collisions", async () => {
    const { container, store } = createStore();
    container.onUpload = () => {
      throw storageFailure(409, "InternalError");
    };

    await expect(
      store.compareAndSwapCheckpoint(
        "bug",
        "hourly-materializer",
        null,
        { cursor: 1, revision: 1 }
      )
    ).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
    expect(
      container.operations.filter((operation) => operation.type === "download")
    ).toHaveLength(0);
  });

  it("acquires only bounded leases and encapsulates lease tokens", async () => {
    const { container, store } = createStore();
    await expect(
      store.acquireLease("bug", "hourly-materializer", { durationSeconds: 10 })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const lease = await store.acquireLease("bug", "hourly-materializer", {
      durationSeconds: 30,
    });
    expect(lease).toMatchObject({
      kind: "bug",
      name: "hourly-materializer",
      durationSeconds: 30,
      expiresAt: "2026-07-18T12:00:30.000Z",
    });
    expect(inspect(lease)).not.toContain("synthetic-lease-token");

    await expect(lease.renew()).resolves.toBe("2026-07-18T12:00:30.000Z");
    await expect(lease.release()).resolves.toBeUndefined();
    const leasePort = [...container.leases.values()][0];
    expect(leasePort?.renewCount).toBe(1);
    expect(leasePort?.releaseCount).toBe(1);
    await expect(lease.release()).resolves.toBeUndefined();
    await expect(lease.renew()).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
  });

  it("maps lease contention and renewal failures to redacted bounded errors", async () => {
    const path = "feedback/bugs/control/leases/hourly-materializer.json";
    const contendedContainer = new MemoryJsonBlobContainer();
    const contendedLease = new MemoryLeaseClient();
    contendedLease.failAcquire = storageFailure(409, "LeaseAlreadyPresent");
    contendedContainer.leases.set(path, contendedLease);
    const contendedStore = createStore(contendedContainer).store;

    await expect(
      contendedStore.acquireLease("bug", "hourly-materializer")
    ).rejects.toMatchObject({
      code: "LEASE_CONFLICT",
      diagnostic: { retryable: true },
    });

    const renewalContainer = new MemoryJsonBlobContainer();
    const renewalLease = new MemoryLeaseClient();
    renewalContainer.leases.set(path, renewalLease);
    const renewalStore = createStore(renewalContainer).store;
    const lease = await renewalStore.acquireLease("bug", "hourly-materializer");
    renewalLease.failRenew = storageFailure(409, "LeaseLost");
    await expect(lease.renew()).rejects.toMatchObject({
      code: "LEASE_CONFLICT",
      diagnostic: { retryable: true },
    });
    renewalLease.failRenew = undefined;
    renewalLease.failRelease = storageFailure(500, "InternalError");
    await expect(lease.release()).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
    });
  });

  it("coalesces concurrent lease releases and treats an already-lost lease as released", async () => {
    const { container, store } = createStore();
    const lease = await store.acquireLease("bug", "hourly-materializer");
    const leasePort = [...container.leases.values()][0];
    if (!leasePort) throw new Error("missing test lease");

    await expect(lease.release({ timeoutMs: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      Promise.all([lease.release(), lease.release(), lease.release()])
    ).resolves.toEqual([undefined, undefined, undefined]);
    expect(leasePort.releaseCount).toBe(1);

    const secondLease = await store.acquireLease("bug", "daily-materializer");
    const secondPort = [...container.leases.values()][1];
    if (!secondPort) throw new Error("missing second test lease");
    secondPort.onRelease = () => {
      secondPort.leaseId = undefined;
    };
    await expect(secondLease.release()).resolves.toBeUndefined();
    await expect(secondLease.release()).resolves.toBeUndefined();
  });

  it("keeps one provider release in flight across immediate caller-deadline retries", async () => {
    const { container, store } = createStore();
    const lease = await store.acquireLease("bug", "hourly-materializer");
    const leasePort = [...container.leases.values()][0];
    if (!leasePort) throw new Error("missing test lease");
    let finishProviderRelease: (() => void) | undefined;
    const providerRelease = new Promise<void>((resolve) => {
      finishProviderRelease = resolve;
    });
    leasePort.onRelease = () => providerRelease;

    await expect(lease.release({ timeoutMs: 5 })).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
    });
    await expect(lease.release({ timeoutMs: 5 })).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
    });
    expect(leasePort.releaseAttemptCount).toBe(1);

    const completionRetry = lease.release({ timeoutMs: 100 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(leasePort.releaseAttemptCount).toBe(1);
    finishProviderRelease?.();
    await expect(completionRetry).resolves.toBeUndefined();
    expect(leasePort.releaseCount).toBe(1);
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("uses the renewal request start to report a conservative lease expiry", async () => {
    const container = new MemoryJsonBlobContainer();
    let clockValue = new Date("2026-07-18T12:00:00.000Z");
    const store = createImmutableJsonPacketStore({
      container,
      kinds: { bug: kindConfig },
      timeoutMs: 1_000,
      maxPacketBytes: 8_192,
      maxReadBytes: 64 * 1024,
      maxManifestEntries: 100,
      clock: () => new Date(clockValue.getTime()),
    });
    const lease = await store.acquireLease("bug", "hourly-materializer", {
      durationSeconds: 30,
    });
    const leasePort = [...container.leases.values()][0];
    if (!leasePort) throw new Error("missing test lease");

    clockValue = new Date("2026-07-18T12:00:10.000Z");
    leasePort.onRenew = () => {
      clockValue = new Date("2026-07-18T12:00:25.000Z");
    };

    await expect(lease.renew()).resolves.toBe(
      "2026-07-18T12:00:40.000Z"
    );
    await lease.release();
  });

  it("keeps generic lease-provider 409 failures separate from lease conflicts", async () => {
    const path = "feedback/bugs/control/leases/hourly-materializer.json";
    const container = new MemoryJsonBlobContainer();
    const leasePort = new MemoryLeaseClient();
    leasePort.failAcquire = storageFailure(409, "InternalError");
    container.leases.set(path, leasePort);

    await expect(
      createStore(container).store.acquireLease("bug", "hourly-materializer")
    ).rejects.toMatchObject({ code: "STORAGE_OPERATION_FAILED" });
  });

  it("validates fixed accepted-time index configuration before Blob access", () => {
    const container = new MemoryJsonBlobContainer();
    const invalid = [
      { prefix: "feedback/bugs/index", timestampField: "acceptedAt", partition: "hour" },
      { prefix: "feedback-index/bugs", timestampField: "narrative", partition: "hour" },
      { prefix: "feedback-index/bugs", timestampField: "acceptedAt", partition: "week" },
    ] as const;

    for (const timeIndex of invalid) {
      expect(() =>
        createImmutableJsonPacketStore({
          container,
          kinds: {
            bug: { ...kindConfig, packetSchema: indexedPacketSchema, timeIndex },
          },
        })
      ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    }
    expect(container.operations).toHaveLength(0);
  });

  it("indexes packet-first, reads one complete aligned window, and exactly replays", async () => {
    const { container, store } = createIndexedStore();
    const packetId = "bug_01j1te5t000000000000001101";
    const acceptedAt = "2026-07-18T12:34:56.000Z";

    const first = await store.writePacket(
      "bug",
      packetId,
      indexedPacket(acceptedAt)
    );
    const replay = await store.writePacket(
      "bug",
      packetId,
      indexedPacket(acceptedAt)
    );

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(
      container.operations
        .filter((operation) => operation.type === "upload")
        .map((operation) => operation.path)
        .slice(0, 2)
    ).toEqual([
      `feedback/bugs/packets/${packetId}.json`,
      "feedback-index/bugs/windows/2026/07/18/12.json",
    ]);

    await expect(
      store.readPacketTimeWindow("bug", {
        windowStart: "2026-07-18T12:00:00.000Z",
        windowEnd: "2026-07-18T13:00:00.000Z",
        maxItems: 10,
        maxBytes: 64 * 1024,
      })
    ).resolves.toMatchObject({
      kind: "bug",
      windowStart: "2026-07-18T12:00:00.000Z",
      windowEnd: "2026-07-18T13:00:00.000Z",
      complete: true,
      packets: [
        {
          packetId,
          acceptedAt,
          schemaId: "feedbackIndexedBugPacket",
          schemaVersion: "1.0.0",
          packet: indexedPacket(acceptedAt),
        },
      ],
    });
  });

  it("repairs a missing index after an ambiguous cross-Blob failure", async () => {
    const { container, store } = createIndexedStore();
    const packetId = "bug_01j1te5t000000000000001102";
    const indexPath = "feedback-index/bugs/windows/2026/07/18/12.json";
    let failIndexOnce = true;
    container.onUpload = (path) => {
      if (path === indexPath && failIndexOnce) {
        failIndexOnce = false;
        throw storageFailure(
          503,
          "ServerBusy",
          "provider-private-detail?sig=synthetic-secret"
        );
      }
    };

    const error = await store
      .writePacket(
        "bug",
        packetId,
        indexedPacket("2026-07-18T12:10:00.000Z")
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      diagnostic: { operation: "write-packet", retryable: true },
      cause: { redacted: true },
    });
    expect(inspect(error, { depth: 10 })).not.toContain("synthetic-secret");
    expect(container.blobs.has(`feedback/bugs/packets/${packetId}.json`)).toBe(true);
    expect(container.blobs.has(indexPath)).toBe(false);

    await expect(
      store.writePacket(
        "bug",
        packetId,
        indexedPacket("2026-07-18T12:10:00.000Z")
      )
    ).resolves.toMatchObject({ replayed: true });
    expect(container.blobs.has(indexPath)).toBe(true);
  });

  it("rebuilds a deleted head on replay and keeps packet payloads out of the index", async () => {
    const { container, store } = createIndexedStore();
    const packetId = "bug_01j1te5t000000000000001111";
    const indexPath = "feedback-index/bugs/windows/2026/07/18/12.json";
    await store.writePacket(
      "bug",
      packetId,
      indexedPacket("2026-07-18T12:20:00.000Z", {
        surfaceId: "private-synthetic-safe-id",
        intentIds: ["synthetic-derived-intent"],
      })
    );
    const storedIndex = container.blobs.get(indexPath);
    if (!storedIndex) throw new Error("missing test index");
    const indexText = new TextDecoder().decode(storedIndex.bytes);
    expect(indexText).not.toContain("private-synthetic-safe-id");
    expect(indexText).not.toContain("synthetic-derived-intent");
    expect(indexText).not.toContain("surfaceId");
    expect(indexText).not.toContain("intentIds");

    container.blobs.delete(indexPath);
    await expect(
      store.writePacket(
        "bug",
        packetId,
        indexedPacket("2026-07-18T12:20:00.000Z", {
          surfaceId: "private-synthetic-safe-id",
          intentIds: ["synthetic-derived-intent"],
        })
      )
    ).resolves.toMatchObject({ replayed: true });
    expect(container.blobs.has(indexPath)).toBe(true);
  });

  it("converges concurrent CAS writers without duplicate or lost entries", async () => {
    const { store } = createIndexedStore();
    const ids = [
      "bug_01j1te5t000000000000001103",
      "bug_01j1te5t000000000000001104",
      "bug_01j1te5t000000000000001105",
    ];
    await Promise.all(
      ids.map((packetId, index) =>
        store.writePacket(
          "bug",
          packetId,
          indexedPacket(`2026-07-18T12:0${index}:00.000Z`)
        )
      )
    );

    const window = await store.readPacketTimeWindow("bug", {
      windowStart: "2026-07-18T12:00:00.000Z",
      windowEnd: "2026-07-18T13:00:00.000Z",
      maxItems: 10,
      maxBytes: 64 * 1024,
    });
    expect(window.packets.map((entry) => entry.packetId)).toEqual(ids);
    expect(new Set(window.packets.map((entry) => entry.packetId)).size).toBe(3);
  });

  it("keeps snapshots stable until a late accepted packet changes membership", async () => {
    let clock = new Date("2026-07-18T13:05:00.000Z");
    const { store } = createIndexedStore(
      new MemoryJsonBlobContainer(),
      () => new Date(clock.getTime())
    );
    const options = {
      windowStart: "2026-07-18T12:00:00.000Z",
      windowEnd: "2026-07-18T13:00:00.000Z",
      maxItems: 10,
      maxBytes: 64 * 1024,
    } as const;
    const empty = await store.readPacketTimeWindow("bug", options);
    expect(empty).toMatchObject({
      complete: true,
      observedAt: options.windowStart,
      packets: [],
    });

    await store.writePacket(
      "bug",
      "bug_01j1te5t000000000000001106",
      indexedPacket("2026-07-18T12:01:00.000Z")
    );
    const first = await store.readPacketTimeWindow("bug", options);
    const unchanged = await store.readPacketTimeWindow("bug", options);
    expect(unchanged.snapshot).toBe(first.snapshot);
    expect(unchanged.observedAt).toBe(first.observedAt);

    clock = new Date("2026-07-18T13:04:00.000Z");
    await store.writePacket(
      "bug",
      "bug_01j1te5t000000000000001107",
      indexedPacket("2026-07-18T12:02:00.000Z")
    );
    const late = await store.readPacketTimeWindow("bug", options);
    expect(late.snapshot).not.toBe(first.snapshot);
    expect(late.observedAt > first.observedAt).toBe(true);
  });

  it("lists only bounded exact window properties and never scans a Blob prefix", async () => {
    const { container, store } = createIndexedStore();
    await store.writePacket(
      "bug",
      "bug_01j1te5t000000000000001108",
      indexedPacket("2026-07-18T12:59:00.000Z")
    );
    await store.writePacket(
      "bug",
      "bug_01j1te5t000000000000001109",
      indexedPacket("2026-07-18T14:01:00.000Z")
    );
    container.operations.length = 0;

    await expect(
      store.listPacketTimeWindows("bug", {
        windowStart: "2026-07-18T12:00:00.000Z",
        windowEnd: "2026-07-18T15:00:00.000Z",
        partition: "hour",
        maxItems: 3,
        maxBytes: 64 * 1024,
      })
    ).resolves.toMatchObject({
      kind: "bug",
      complete: true,
      windows: [
        {
          windowStart: "2026-07-18T12:00:00.000Z",
          windowEnd: "2026-07-18T13:00:00.000Z",
        },
        {
          windowStart: "2026-07-18T14:00:00.000Z",
          windowEnd: "2026-07-18T15:00:00.000Z",
        },
      ],
    });
    expect(container.operations.some((operation) => operation.type === "list")).toBe(false);
    expect(
      container.operations.filter((operation) => operation.type === "properties")
    ).toHaveLength(3);
  });

  it("supports exact UTC day partitions with the same bounded contract", async () => {
    const { container, store } = createIndexedStore(
      new MemoryJsonBlobContainer(),
      () => new Date("2026-07-19T00:05:00.000Z"),
      "day"
    );
    await store.writePacket(
      "bug",
      "bug_01j1te5t000000000000001113",
      indexedPacket("2026-07-18T23:59:59.999Z")
    );
    expect(
      container.blobs.has("feedback-index/bugs/windows/2026/07/18.json")
    ).toBe(true);
    await expect(
      store.readPacketTimeWindow("bug", {
        windowStart: "2026-07-18T00:00:00.000Z",
        windowEnd: "2026-07-19T00:00:00.000Z",
        maxItems: 10,
        maxBytes: 64 * 1024,
      })
    ).resolves.toMatchObject({
      complete: true,
      packets: [{ acceptedAt: "2026-07-18T23:59:59.999Z" }],
    });
  });

  it("bounds CAS contention and exact-property deadlines without partial success", async () => {
    const contended = createIndexedStore();
    let indexAttempts = 0;
    contended.container.onUpload = (path) => {
      if (path.includes("feedback-index/bugs/windows/")) {
        indexAttempts += 1;
        throw storageFailure(412, "ConditionNotMet");
      }
    };
    await expect(
      contended.store.writePacket(
        "bug",
        "bug_01j1te5t000000000000001114",
        indexedPacket("2026-07-18T12:40:00.000Z")
      )
    ).rejects.toMatchObject({
      code: "STORAGE_OPERATION_FAILED",
      diagnostic: { operation: "write-packet", retryable: true },
    });
    expect(indexAttempts).toBe(8);

    const deadline = createIndexedStore();
    deadline.container.onProperties = async () => {
      await new Promise<void>(() => undefined);
    };
    await expect(
      deadline.store.listPacketTimeWindows("bug", {
        windowStart: "2026-07-18T12:00:00.000Z",
        windowEnd: "2026-07-18T13:00:00.000Z",
        partition: "hour",
        maxItems: 1,
        maxBytes: 64 * 1024,
        timeoutMs: 5,
      })
    ).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
      diagnostic: { operation: "list-time-windows" },
    });
  });

  it("fails closed on corrupt heads, packet mismatches, and a missing exact-properties driver", async () => {
    const { container, store } = createIndexedStore();
    const packetId = "bug_01j1te5t000000000000001112";
    const indexPath = "feedback-index/bugs/windows/2026/07/18/12.json";
    const options = {
      windowStart: "2026-07-18T12:00:00.000Z",
      windowEnd: "2026-07-18T13:00:00.000Z",
      maxItems: 10,
      maxBytes: 64 * 1024,
    } as const;
    await store.writePacket(
      "bug",
      packetId,
      indexedPacket("2026-07-18T12:30:00.000Z")
    );
    const index = container.blobs.get(indexPath);
    if (!index) throw new Error("missing test index");
    index.metadata.plasiussnapshot = "0".repeat(64);
    await expect(store.readPacketTimeWindow("bug", options)).rejects.toMatchObject({
      code: "CORRUPT_RECORD",
      diagnostic: { operation: "read-time-window" },
    });
    index.metadata.plasiussnapshot = JSON.parse(
      new TextDecoder().decode(index.bytes)
    ).snapshot as string;

    const packetBlob = container.blobs.get(
      `feedback/bugs/packets/${packetId}.json`
    );
    if (!packetBlob) throw new Error("missing test packet");
    packetBlob.metadata.plasiussha256 = "f".repeat(64);
    await expect(store.readPacketTimeWindow("bug", options)).rejects.toMatchObject({
      code: "CORRUPT_RECORD",
    });

    const noPropertiesContainer: JsonPacketBlobContainerPort = {
      getBlockBlobClient: (path) => {
        const delegated = container.getBlockBlobClient(path);
        return {
          uploadData: delegated.uploadData.bind(delegated),
          download: delegated.download.bind(delegated),
          getBlobLeaseClient: delegated.getBlobLeaseClient.bind(delegated),
        };
      },
    };
    const noPropertiesStore = createImmutableJsonPacketStore({
      container: noPropertiesContainer,
      kinds: {
        bug: {
          ...kindConfig,
          packetSchema: indexedPacketSchema,
          timeIndex: {
            prefix: "feedback-index/bugs",
            timestampField: "acceptedAt",
            partition: "hour",
          },
        },
      },
    });
    await expect(
      noPropertiesStore.listPacketTimeWindows("bug", {
        ...options,
        partition: "hour",
      })
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("rejects misaligned, wrong-partition, over-bounds, and conflicting indexed values", async () => {
    const { store } = createIndexedStore();
    const packetId = "bug_01j1te5t000000000000001110";
    await store.writePacket(
      "bug",
      packetId,
      indexedPacket("2026-07-18T12:01:00.000Z")
    );

    await expect(
      store.readPacketTimeWindow("bug", {
        windowStart: "2026-07-18T12:01:00.000Z",
        windowEnd: "2026-07-18T13:00:00.000Z",
        maxItems: 10,
        maxBytes: 64 * 1024,
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      store.readPacketTimeWindow("bug", {
        windowStart: "2026-07-18T12:00:00.000Z",
        windowEnd: "2026-07-18T13:00:00.000Z",
        maxItems: 1,
        maxBytes: 1,
      })
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(
      store.readPacketTimeWindow("bug", {
        windowStart: "2026-07-18T12:00:00.000Z",
        windowEnd: "2026-07-18T13:00:00.000Z",
        maxItems: 0,
        maxBytes: 64 * 1024,
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      store.listPacketTimeWindows("bug", {
        windowStart: "2026-07-18T12:00:00.000Z",
        windowEnd: "2026-07-18T13:00:00.000Z",
        partition: "day",
        maxItems: 1,
        maxBytes: 64 * 1024,
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      store.writePacket(
        "bug",
        packetId,
        indexedPacket("2026-07-18T12:02:00.000Z")
      )
    ).rejects.toMatchObject({ code: "IMMUTABLE_CONFLICT" });

    await expect(
      store.writePacket(
        "bug",
        "bug_01j1te5t000000000000001115",
        indexedPacket("+010000-01-01T00:00:00.000Z")
      )
    ).rejects.toMatchObject({ code: "SCHEMA_REJECTED" });

    const invalidClock = createIndexedStore(
      new MemoryJsonBlobContainer(),
      () => new Date("+010000-01-01T00:00:00.000Z")
    );
    await expect(
      invalidClock.store.writePacket(
        "bug",
        "bug_01j1te5t000000000000001116",
        indexedPacket("2026-07-18T12:03:00.000Z")
      )
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(invalidClock.container.operations).toHaveLength(0);
  });
});
