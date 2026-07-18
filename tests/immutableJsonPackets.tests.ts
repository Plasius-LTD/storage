import { inspect } from "node:util";
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
  type JsonPacketBlobUploadOptions,
  type PersistableJsonSchemaPort,
} from "../src/immutable-json-packets.js";

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
    type: "download" | "upload";
    path: string;
    options?: JsonPacketBlobUploadOptions;
  }> = [];
  readonly leases = new Map<string, MemoryLeaseClient>();
  onUpload?: (
    path: string,
    bytes: Uint8Array,
    options: JsonPacketBlobUploadOptions
  ) => void | Promise<void>;
  onDownload?: (path: string) => void | Promise<void>;
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
}

interface SafePacket {
  readonly schema: string;
  readonly severity: number;
  readonly issueType: string;
  readonly surfaceId: string;
  readonly intentIds: readonly string[];
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
      maxManifestEntries: 100,
      clock: () => new Date("2026-07-18T12:00:00.000Z"),
    }),
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
});
