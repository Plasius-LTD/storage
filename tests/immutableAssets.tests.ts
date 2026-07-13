import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  IMMUTABLE_ASSET_ROOTS,
  IMMUTABLE_VERSION_MANIFEST_PATH,
  MAX_IMMUTABLE_BLOB_NAME_LENGTH,
  MAX_IMMUTABLE_VERSION_FILES,
  MAX_IMMUTABLE_VERSION_PAYLOAD_FILES,
  ImmutableAssetStorageError,
  createImmutableAssetStore,
  createImmutableAssetVersion,
  readImmutableAssetVersionFile,
  verifyImmutableAssetVersion,
  type BlobContainerPort,
  type BlockBlobClientPort,
  type CreateImmutableAssetVersionInput,
  type ImmutableAssetIdentity,
  type ImmutableAssetKind,
} from "../src/immutable-assets.js";

type UploadOptions = Parameters<BlockBlobClientPort["uploadData"]>[1];

interface StoredBlob {
  bytes: Uint8Array;
  contentType: string;
  metadata: Record<string, string>;
  etag: string;
  contentLength?: number;
}

interface Operation {
  readonly type: "download" | "upload";
  readonly path: string;
  readonly options?: UploadOptions;
}

function storageFailure(statusCode: number, code: string): Error {
  return Object.assign(new Error(code), { statusCode, code });
}

class MemoryBlobContainer implements BlobContainerPort {
  readonly blobs = new Map<string, StoredBlob>();
  readonly operations: Operation[] = [];
  onUpload?: (
    path: string,
    bytes: Uint8Array,
    options: UploadOptions,
    container: MemoryBlobContainer
  ) => void | Promise<void>;
  onDownload?: (
    path: string,
    container: MemoryBlobContainer
  ) => void | Promise<void>;
  activeUploads = 0;
  maxActiveUploads = 0;
  private nextEtag = 1;

  getBlockBlobClient(path: string): BlockBlobClientPort {
    return {
      uploadData: async (bytes, options) => {
        this.operations.push({ type: "upload", path, options });
        this.activeUploads += 1;
        this.maxActiveUploads = Math.max(this.maxActiveUploads, this.activeUploads);
        try {
          await this.onUpload?.(path, bytes, options, this);
          if (this.blobs.has(path)) throw storageFailure(409, "BlobAlreadyExists");
          const etag = `"etag-${this.nextEtag++}"`;
          this.blobs.set(path, {
            bytes: new Uint8Array(bytes),
            contentType: options.blobHTTPHeaders.blobContentType,
            metadata: { ...options.metadata },
            etag,
          });
          return { etag };
        } finally {
          this.activeUploads -= 1;
        }
      },
      download: async (_offset, _count, options) => {
        this.operations.push({ type: "download", path });
        await this.onDownload?.(path, this);
        if (options?.abortSignal?.aborted) {
          throw storageFailure(499, "AbortError");
        }
        const blob = this.blobs.get(path);
        if (!blob) throw storageFailure(404, "BlobNotFound");
        const bytes = new Uint8Array(blob.bytes);
        const body = async function* (): AsyncIterable<Uint8Array> {
          const midpoint = Math.floor(bytes.byteLength / 2);
          if (midpoint > 0) yield bytes.slice(0, midpoint);
          if (midpoint < bytes.byteLength) yield bytes.slice(midpoint);
        };
        return {
          readableStreamBody: body(),
          contentLength: blob.contentLength ?? bytes.byteLength,
          contentType: blob.contentType,
          metadata: { ...blob.metadata },
          etag: blob.etag,
        };
      },
    };
  }

  putDirect(path: string, blob: Omit<StoredBlob, "etag"> & { etag?: string }): void {
    this.blobs.set(path, {
      ...blob,
      bytes: new Uint8Array(blob.bytes),
      metadata: { ...blob.metadata },
      etag: blob.etag ?? `"etag-${this.nextEtag++}"`,
    });
  }

  clearOperations(): void {
    this.operations.length = 0;
  }
}

const identity: ImmutableAssetIdentity = {
  kind: "shader",
  id: "toon-material",
  version: "1.2.3",
};

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function input(
  files: CreateImmutableAssetVersionInput["files"] = [
    { path: "material.wgsl", bytes: bytes("@compute @workgroup_size(1) fn main() {}") },
  ],
  assetIdentity: ImmutableAssetIdentity = identity
): CreateImmutableAssetVersionInput {
  return { identity: assetIdentity, files };
}

function prefix(assetIdentity: ImmutableAssetIdentity = identity): string {
  return `${IMMUTABLE_ASSET_ROOTS[assetIdentity.kind]}/${assetIdentity.id}/versions/${assetIdentity.version}`;
}

function markerPath(assetIdentity: ImmutableAssetIdentity = identity): string {
  return `${prefix(assetIdentity)}/${IMMUTABLE_VERSION_MANIFEST_PATH}`;
}

async function rejectedStorageError(
  promise: Promise<unknown>,
  code: ImmutableAssetStorageError["code"]
): Promise<ImmutableAssetStorageError> {
  return promise.then(
    () => {
      throw new Error(`Expected ${code}.`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ImmutableAssetStorageError);
      expect(error).toMatchObject({ code });
      return error as ImmutableAssetStorageError;
    }
  );
}

function cloneStored(blob: StoredBlob): StoredBlob {
  return {
    bytes: new Uint8Array(blob.bytes),
    contentType: blob.contentType,
    metadata: { ...blob.metadata },
    etag: blob.etag,
    ...(blob.contentLength === undefined ? {} : { contentLength: blob.contentLength }),
  };
}

describe("immutable asset version creation", () => {
  it("keeps the exported fixed-root authority immutable", async () => {
    expect(Object.isFrozen(IMMUTABLE_ASSET_ROOTS)).toBe(true);
    expect(Object.keys(IMMUTABLE_ASSET_ROOTS)).toEqual([
      "model",
      "gpu-interface",
      "shader",
      "shader-style-profile",
      "shader-validation-evidence",
    ]);
    expect(Reflect.set(IMMUTABLE_ASSET_ROOTS, "shader", "caller-controlled")).toBe(false);
    expect(Reflect.set(IMMUTABLE_ASSET_ROOTS, "constructor", "caller-controlled")).toBe(false);
    expect(Reflect.deleteProperty(IMMUTABLE_ASSET_ROOTS, "shader")).toBe(false);

    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    expect([...container.blobs.keys()].every((path) => path.startsWith("shaders/"))).toBe(true);
  });

  it("uses every fixed kind root and never accepts an arbitrary root", async () => {
    for (const [kind, root] of Object.entries(IMMUTABLE_ASSET_ROOTS) as [
      ImmutableAssetKind,
      string,
    ][]) {
      const container = new MemoryBlobContainer();
      const assetIdentity = { kind, id: "asset-one", version: "2026.7.13" };

      await createImmutableAssetVersion(container, input(undefined, assetIdentity));

      expect([...container.blobs.keys()]).toEqual(
        expect.arrayContaining([
          `${root}/asset-one/versions/2026.7.13/material.wgsl`,
          `${root}/asset-one/versions/2026.7.13/${IMMUTABLE_VERSION_MANIFEST_PATH}`,
        ])
      );
    }
  });

  it("uploads payloads conditionally and the service-generated manifest last", async () => {
    const container = new MemoryBlobContainer();
    const result = await createImmutableAssetVersion(
      container,
      input([
        { path: "shader.wgsl", bytes: bytes("shader") },
        { path: "pipeline.json", bytes: bytes("{}") },
      ])
    );
    const uploads = container.operations.filter((operation) => operation.type === "upload");

    expect(uploads.at(-1)?.path).toBe(markerPath());
    expect(uploads).toHaveLength(3);
    for (const operation of uploads) {
      expect(operation.options?.conditions).toEqual({ ifNoneMatch: "*" });
    }
    expect(result.fileCount).toBe(3);
    expect(result.replayed).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/https?:|\?|sas/iu);
  });

  it("computes lowercase SHA-256, byte length, identity metadata, and canonical MIME", async () => {
    const container = new MemoryBlobContainer();
    const source = bytes("shader-source");
    await createImmutableAssetVersion(container, input([{ path: "shader.wgsl", bytes: source }]));

    const stored = container.blobs.get(`${prefix()}/shader.wgsl`);
    const expectedDigest = createHash("sha256").update(source).digest("hex");
    expect(stored?.contentType).toBe("text/wgsl; charset=utf-8");
    expect(stored?.metadata).toMatchObject({
      plasiusassetid: identity.id,
      plasiusassetkind: identity.kind,
      plasiusassetversion: identity.version,
      plasiusbytelength: String(source.byteLength),
      plasiuscontenttype: "text/wgsl; charset=utf-8",
      plasiusrelativepath: "shader.wgsl",
      plasiusrole: "payload",
      plasiussha256: expectedDigest,
    });
    expect(stored?.metadata.plasiussha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses deterministic code-unit path ordering in canonical manifest bytes", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(
      container,
      input([
        { path: "z_file.wgsl", bytes: bytes("z") },
        { path: "a-file.wgsl", bytes: bytes("a") },
        { path: "A.file.wgsl", bytes: bytes("A") },
      ])
    );
    const marker = container.blobs.get(markerPath());
    const parsed = JSON.parse(new TextDecoder().decode(marker?.bytes)) as {
      files: { path: string }[];
    };
    expect(parsed.files.map((file) => file.path)).toEqual([
      "A.file.wgsl",
      "a-file.wgsl",
      "z_file.wgsl",
    ]);
  });

  it("copies caller bytes before asynchronous Blob work", async () => {
    const container = new MemoryBlobContainer();
    const callerBytes = bytes("original");
    const promise = createImmutableAssetVersion(
      container,
      input([{ path: "payload.bin", bytes: callerBytes }])
    );
    callerBytes.fill(0);

    await promise;

    expect(new TextDecoder().decode(container.blobs.get(`${prefix()}/payload.bin`)?.bytes)).toBe(
      "original"
    );
  });

  it("admits exactly 512 payloads plus one marker", async () => {
    const container = new MemoryBlobContainer();
    const files = Array.from({ length: MAX_IMMUTABLE_VERSION_PAYLOAD_FILES }, (_, index) => ({
      path: `files/${String(index).padStart(3, "0")}.bin`,
      bytes: new Uint8Array([index % 251]),
    }));

    const result = await createImmutableAssetVersion(container, input(files), {
      maxConcurrency: 32,
    });

    expect(MAX_IMMUTABLE_VERSION_FILES).toBe(513);
    expect(result.fileCount).toBe(513);
    expect(container.blobs.size).toBe(513);
  });

  it("rejects a 513th payload before any Blob access", async () => {
    const container = new MemoryBlobContainer();
    const files = Array.from(
      { length: MAX_IMMUTABLE_VERSION_PAYLOAD_FILES + 1 },
      (_, index) => ({ path: `files/${index}.bin`, bytes: new Uint8Array() })
    );

    await rejectedStorageError(
      createImmutableAssetVersion(container, input(files)),
      "LIMIT_EXCEEDED"
    );
    expect(container.operations).toEqual([]);
  });

  it("rejects sparse and inherited array entries before any Blob access", async () => {
    const container = new MemoryBlobContainer();
    const files = new Array<CreateImmutableAssetVersionInput["files"][number]>(2);
    files[0] = { path: "first.bin", bytes: bytes("first") };
    Object.defineProperty(Array.prototype, "1", {
      configurable: true,
      writable: true,
      value: { path: "inherited.bin", bytes: bytes("inherited") },
    });
    try {
      await rejectedStorageError(
        createImmutableAssetVersion(container, input(files)),
        "INVALID_ARGUMENT"
      );
    } finally {
      Reflect.deleteProperty(Array.prototype, "1");
    }
    expect(container.operations).toEqual([]);
  });

  it("rejects accessor-backed input fields before validation or Blob access", async () => {
    const container = new MemoryBlobContainer();
    const accessorInput = {} as CreateImmutableAssetVersionInput;
    Object.defineProperties(accessorInput, {
      identity: { enumerable: true, get: () => identity },
      files: { enumerable: true, value: input().files },
    });

    await rejectedStorageError(
      createImmutableAssetVersion(container, accessorInput),
      "INVALID_ARGUMENT"
    );

    const accessorFile = { path: "payload.bin" } as unknown as Record<string, unknown>;
    Object.defineProperty(accessorFile, "bytes", {
      enumerable: true,
      get: () => bytes("payload"),
    });
    await rejectedStorageError(
      createImmutableAssetVersion(
        container,
        input([accessorFile as unknown as CreateImmutableAssetVersionInput["files"][number]])
      ),
      "INVALID_ARGUMENT"
    );
    expect(container.operations).toEqual([]);
  });

  it("uses intrinsic Uint8Array length so an own accessor cannot bypass byte budgets", async () => {
    const container = new MemoryBlobContainer();
    const spoofed = new Uint8Array(1_000);
    Object.defineProperty(spoofed, "byteLength", {
      configurable: true,
      get: () => 1,
    });

    await rejectedStorageError(
      createImmutableAssetVersion(
        container,
        input([{ path: "spoofed.bin", bytes: spoofed }]),
        { maxFileBytes: 2, maxVersionBytes: 2 }
      ),
      "LIMIT_EXCEEDED"
    );
    expect(container.operations).toEqual([]);
  });

  it("enforces configured per-file and total byte limits before writes", async () => {
    const one = new MemoryBlobContainer();
    await rejectedStorageError(
      createImmutableAssetVersion(
        one,
        input([{ path: "big.bin", bytes: new Uint8Array(3) }]),
        { maxFileBytes: 2, maxVersionBytes: 4 }
      ),
      "LIMIT_EXCEEDED"
    );
    expect(one.operations).toEqual([]);

    const total = new MemoryBlobContainer();
    await rejectedStorageError(
      createImmutableAssetVersion(
        total,
        input([
          { path: "a.bin", bytes: new Uint8Array(2) },
          { path: "b.bin", bytes: new Uint8Array(2) },
        ]),
        { maxFileBytes: 3, maxVersionBytes: 3 }
      ),
      "LIMIT_EXCEEDED"
    );
    expect(total.operations).toEqual([]);
  });
});

describe("immutable identity, path, and MIME validation", () => {
  it.each([
    "latest",
    "current",
    "stable",
    "preview",
    "default",
    "production",
    "canary",
    "next",
    "head",
    "main",
    "x",
    "vX",
    "1.x",
    "1.x.preview",
    "^1.2.3",
    "https://example.test/v1",
  ])("rejects non-exact version %s before Blob access", async (version) => {
    const container = new MemoryBlobContainer();

    await rejectedStorageError(
      createImmutableAssetVersion(container, input(undefined, { ...identity, version })),
      "INVALID_IDENTITY"
    );
    expect(container.operations).toEqual([]);
  });

  it.each(["build-x", "dev", "development", "1.2.3-beta-x"])(
    "retains canonical asset-contracts exact-token parity for %s",
    async (version) => {
      const container = new MemoryBlobContainer();
      const receipt = await createImmutableAssetVersion(
        container,
        input(undefined, { ...identity, version })
      );
      expect(receipt.identity.version).toBe(version);
    }
  );

  it.each(["toString", "constructor", "__proto__"])(
    "rejects prototype kind %s without querying Blob storage",
    async (kind) => {
      const container = new MemoryBlobContainer();
      await rejectedStorageError(
        createImmutableAssetVersion(
          container,
          input(undefined, { ...identity, kind } as unknown as ImmutableAssetIdentity)
        ),
        "INVALID_IDENTITY"
      );
      expect(container.operations).toEqual([]);
    }
  );

  it.each([
    "../secret.bin",
    "dir/../../secret.bin",
    "/absolute.bin",
    "dir\\file.bin",
    "https://example.test/file.bin",
    "file:/etc/passwd",
    "data:text/plain,hello",
    "encoded%2fpath.bin",
    "query.bin?mutable=true",
    "channels/latest.bin",
    "_plasius/other.json",
    "dir//file.bin",
    "dir/./file.bin",
  ])("rejects unsafe relative path %s before Blob access", async (path) => {
    const container = new MemoryBlobContainer();

    await rejectedStorageError(
      createImmutableAssetVersion(container, input([{ path, bytes: new Uint8Array() }])),
      "INVALID_PATH"
    );
    expect(container.operations).toEqual([]);
  });

  it.each(["café.bin", `caf${"e\u0301"}.bin`])(
    "rejects non-ASCII metadata-unsafe path %s before Blob access",
    async (path) => {
      const container = new MemoryBlobContainer();

      await rejectedStorageError(
        createImmutableAssetVersion(
          container,
          input([{ path, bytes: new Uint8Array() }])
        ),
        "INVALID_PATH"
      );
      expect(container.operations).toEqual([]);
    }
  );

  it("rejects a path whose complete root/id/version Blob name exceeds 1024 characters", async () => {
    const container = new MemoryBlobContainer();
    const longIdentity: ImmutableAssetIdentity = {
      kind: "shader-style-profile",
      id: `i${"d".repeat(127)}`,
      version: `v${"1".repeat(127)}`,
    };
    const longPath = `${"a".repeat(255)}/${"b".repeat(255)}/${"c".repeat(255)}`;
    expect(`${prefix(longIdentity)}/${longPath}`.length).toBeGreaterThan(
      MAX_IMMUTABLE_BLOB_NAME_LENGTH
    );

    await rejectedStorageError(
      createImmutableAssetVersion(
        container,
        input([{ path: longPath, bytes: new Uint8Array() }], longIdentity)
      ),
      "INVALID_PATH"
    );
    expect(container.operations).toEqual([]);
  });

  it("rejects duplicate paths and caller-supplied manifest or file metadata", async () => {
    const duplicate = new MemoryBlobContainer();
    await rejectedStorageError(
      createImmutableAssetVersion(
        duplicate,
        input([
          { path: "same.bin", bytes: new Uint8Array() },
          { path: "same.bin", bytes: new Uint8Array() },
        ])
      ),
      "INVALID_PATH"
    );
    expect(duplicate.operations).toEqual([]);

    const suppliedManifest = new MemoryBlobContainer();
    await rejectedStorageError(
      createImmutableAssetVersion(suppliedManifest, {
        ...input(),
        manifest: { callerControlled: true },
      } as unknown as CreateImmutableAssetVersionInput),
      "INVALID_ARGUMENT"
    );
    expect(suppliedManifest.operations).toEqual([]);

    const suppliedDigest = new MemoryBlobContainer();
    await rejectedStorageError(
      createImmutableAssetVersion(
        suppliedDigest,
        input([
          {
            path: "file.bin",
            bytes: new Uint8Array(),
            sha256: "0".repeat(64),
          } as unknown as CreateImmutableAssetVersionInput["files"][number],
        ])
      ),
      "INVALID_ARGUMENT"
    );
    expect(suppliedDigest.operations).toEqual([]);
  });

  it("requires canonical known-extension content types and rejects active content", async () => {
    const noncanonical = new MemoryBlobContainer();
    await rejectedStorageError(
      createImmutableAssetVersion(
        noncanonical,
        input([
          {
            path: "shader.wgsl",
            bytes: bytes("shader"),
            contentType: "text/wgsl",
          },
        ])
      ),
      "INVALID_ARGUMENT"
    );
    expect(noncanonical.operations).toEqual([]);

    for (const contentType of ["text/html", "image/svg+xml", "application/javascript"]) {
      const container = new MemoryBlobContainer();
      await rejectedStorageError(
        createImmutableAssetVersion(
          container,
          input([{ path: "payload.bin", bytes: new Uint8Array(), contentType }])
        ),
        "INVALID_ARGUMENT"
      );
      expect(container.operations).toEqual([]);
    }

    const nonString = new MemoryBlobContainer();
    await rejectedStorageError(
      createImmutableAssetVersion(
        nonString,
        input([{
          path: "payload.bin",
          bytes: new Uint8Array(),
          contentType: 42,
        } as unknown as CreateImmutableAssetVersionInput["files"][number]])
      ),
      "INVALID_ARGUMENT"
    );
    expect(nonString.operations).toEqual([]);
  });

  it("validates operation limits and structural ports synchronously", async () => {
    const container = new MemoryBlobContainer();
    await rejectedStorageError(
      createImmutableAssetVersion(container, input(), { maxConcurrency: 0 }),
      "INVALID_ARGUMENT"
    );
    await rejectedStorageError(
      createImmutableAssetVersion(container, input(), {
        maxFileBytes: 2,
        maxVersionBytes: 1,
      }),
      "INVALID_ARGUMENT"
    );
    await rejectedStorageError(
      createImmutableAssetVersion({} as BlobContainerPort, input()),
      "INVALID_ARGUMENT"
    );
    expect(container.operations).toEqual([]);
  });
});

describe("exact replay and completion marker races", () => {
  it("returns an exact replay only after rereading every declared file", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(
      container,
      input([
        { path: "a.bin", bytes: bytes("a") },
        { path: "b.bin", bytes: bytes("b") },
      ])
    );
    container.clearOperations();

    const replay = await createImmutableAssetVersion(
      container,
      input([
        { path: "a.bin", bytes: bytes("a") },
        { path: "b.bin", bytes: bytes("b") },
      ])
    );

    expect(replay.replayed).toBe(true);
    expect(container.operations.filter((operation) => operation.type === "upload")).toEqual([]);
    expect(
      container.operations.filter((operation) => operation.path.endsWith("/a.bin"))
    ).toHaveLength(1);
    expect(
      container.operations.filter((operation) => operation.path.endsWith("/b.bin"))
    ).toHaveLength(1);
    expect(
      container.operations.filter((operation) => operation.path === markerPath())
    ).toHaveLength(3);
  });

  it("conflicts on a mismatched completed version before payload effects", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    container.clearOperations();

    await rejectedStorageError(
      createImmutableAssetVersion(
        container,
        input([{ path: "different.wgsl", bytes: bytes("different") }])
      ),
      "VERSION_CONFLICT"
    );

    expect(container.operations.filter((operation) => operation.type === "upload")).toEqual([]);
    expect(container.operations).toHaveLength(1);
    expect(container.operations[0]?.path).toBe(markerPath());
  });

  it("completes an exact replay of orphaned payloads when no marker exists", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    container.blobs.delete(markerPath());
    container.clearOperations();

    const result = await createImmutableAssetVersion(container, input());

    expect(result.replayed).toBe(false);
    expect(container.operations.filter((operation) => operation.type === "upload")).toHaveLength(2);
    expect(container.blobs.has(markerPath())).toBe(true);
  });

  it("retains unreachable payloads after a write failure and performs no unsafe deletion", async () => {
    const container = new MemoryBlobContainer();
    container.onUpload = (path) => {
      if (path.endsWith("/b.bin")) throw storageFailure(500, "InternalError");
    };

    await rejectedStorageError(
      createImmutableAssetVersion(
        container,
        input([
          { path: "a.bin", bytes: bytes("a") },
          { path: "b.bin", bytes: bytes("b") },
        ]),
        { maxConcurrency: 1 }
      ),
      "STORAGE_OPERATION_FAILED"
    );

    expect(container.blobs.has(`${prefix()}/a.bin`)).toBe(true);
    expect(container.blobs.has(markerPath())).toBe(false);
    expect(container.operations.filter((operation) => operation.path.endsWith("/b.bin"))).toHaveLength(1);
  });

  it("does not delete a payload adopted by a competing completion marker", async () => {
    const complete = new MemoryBlobContainer();
    const versionInput = input([
      { path: "a.bin", bytes: bytes("a") },
      { path: "b.bin", bytes: bytes("b") },
    ]);
    await createImmutableAssetVersion(complete, versionInput);
    const container = new MemoryBlobContainer();
    let adopted = false;
    container.onUpload = (path, _data, _options, target) => {
      if (path.endsWith("/b.bin") && !adopted) {
        adopted = true;
        target.putDirect(
          `${prefix()}/b.bin`,
          cloneStored(complete.blobs.get(`${prefix()}/b.bin`) as StoredBlob)
        );
        target.putDirect(
          markerPath(),
          cloneStored(complete.blobs.get(markerPath()) as StoredBlob)
        );
        throw storageFailure(500, "InternalError");
      }
    };

    await rejectedStorageError(
      createImmutableAssetVersion(container, versionInput, { maxConcurrency: 1 }),
      "STORAGE_OPERATION_FAILED"
    );
    expect(container.blobs.has(`${prefix()}/a.bin`)).toBe(true);
    container.onUpload = undefined;
    await expect(verifyImmutableAssetVersion(container, identity)).resolves.toMatchObject({
      fileCount: 3,
    });
  });

  it("accepts an exact competing marker that wins the final conditional create", async () => {
    const container = new MemoryBlobContainer();
    container.onUpload = (path, data, options, target) => {
      if (path === markerPath() && !target.blobs.has(path)) {
        target.putDirect(path, {
          bytes: data,
          contentType: options.blobHTTPHeaders.blobContentType,
          metadata: { ...options.metadata },
        });
      }
    };

    const receipt = await createImmutableAssetVersion(container, input());

    expect(receipt.replayed).toBe(true);
    expect(container.blobs.has(`${prefix()}/material.wgsl`)).toBe(true);
    await expect(verifyImmutableAssetVersion(container, identity)).resolves.toBeDefined();
  });

  it("conflicts with a mismatched marker race but retains potentially adopted payloads", async () => {
    const container = new MemoryBlobContainer();
    container.onUpload = (path, _data, _options, target) => {
      if (path === markerPath() && !target.blobs.has(path)) {
        target.putDirect(path, {
          bytes: bytes("not-a-manifest"),
          contentType: "application/json",
          metadata: { invalid: "true" },
        });
      }
    };

    await rejectedStorageError(createImmutableAssetVersion(container, input()), "VERSION_CONFLICT");

    expect(container.blobs.has(`${prefix()}/material.wgsl`)).toBe(true);
    expect(container.blobs.has(markerPath())).toBe(true);
  });
});

describe("abort, deadline, and bounded work", () => {
  it("preserves a transient completion precheck failure and performs no payload write", async () => {
    const container = new MemoryBlobContainer();
    container.onDownload = (path) => {
      if (path === markerPath()) throw storageFailure(503, "ServerBusy");
    };

    const error = await rejectedStorageError(
      createImmutableAssetVersion(container, input()),
      "STORAGE_OPERATION_FAILED"
    );

    expect(error.diagnostic.retryable).toBe(true);
    expect(container.operations).toEqual([{ type: "download", path: markerPath() }]);
  });

  it("classifies a missing container as a permanent provider failure", async () => {
    const container = new MemoryBlobContainer();
    container.onDownload = () => {
      throw storageFailure(404, "ContainerNotFound");
    };

    const error = await rejectedStorageError(
      createImmutableAssetVersion(container, input()),
      "STORAGE_OPERATION_FAILED"
    );

    expect(error.diagnostic.retryable).toBe(false);
    expect(container.operations.filter((operation) => operation.type === "upload")).toEqual([]);
  });

  it("does not classify permanent provider authorization failures as retryable", async () => {
    const container = new MemoryBlobContainer();
    container.onDownload = () => {
      throw storageFailure(403, "AuthorizationPermissionMismatch");
    };

    const error = await rejectedStorageError(
      createImmutableAssetVersion(container, input()),
      "STORAGE_OPERATION_FAILED"
    );
    expect(error.diagnostic.retryable).toBe(false);
    expect(container.operations.filter((operation) => operation.type === "upload")).toEqual([]);
  });

  it("redacts raw provider causes from JSON and diagnostic inspection", async () => {
    const container = new MemoryBlobContainer();
    container.onDownload = () => {
      throw Object.assign(new Error("https://account.test/blob?sig=secret"), {
        statusCode: 503,
        request: { url: "https://account.test/blob?sig=secret" },
      });
    };

    const error = await rejectedStorageError(
      createImmutableAssetVersion(container, input()),
      "STORAGE_OPERATION_FAILED"
    );
    expect(JSON.stringify(error)).not.toContain("sig=secret");
    expect(inspect(error)).not.toContain("sig=secret");
    expect(error.cause).toEqual({ redacted: true });
  });

  it("preserves precheck timeout classification with zero payload writes", async () => {
    const container = new MemoryBlobContainer();
    container.onDownload = async (path) => {
      if (path === markerPath()) await new Promise<void>(() => undefined);
    };

    await rejectedStorageError(
      createImmutableAssetVersion(container, input(), { timeoutMs: 5 }),
      "DEADLINE_EXCEEDED"
    );

    expect(container.operations.filter((operation) => operation.type === "upload")).toEqual([]);
  });

  it("honours a pre-aborted signal before any Blob access", async () => {
    const container = new MemoryBlobContainer();
    const controller = new AbortController();
    controller.abort();

    await rejectedStorageError(
      createImmutableAssetVersion(container, input(), { signal: controller.signal }),
      "ABORTED"
    );
    expect(container.operations).toEqual([]);
  });

  it("retains payloads when marker upload completion is ambiguous after deadline", async () => {
    const container = new MemoryBlobContainer();
    container.onUpload = async (path, data, options, target) => {
      if (path !== markerPath()) return;
      await new Promise<void>((resolve) => {
        options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      target.putDirect(path, {
        bytes: data,
        contentType: options.blobHTTPHeaders.blobContentType,
        metadata: { ...options.metadata },
      });
    };

    await rejectedStorageError(
      createImmutableAssetVersion(container, input(), { timeoutMs: 5 }),
      "DEADLINE_EXCEEDED"
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(container.blobs.has(`${prefix()}/material.wgsl`)).toBe(true);
    expect(container.blobs.has(markerPath())).toBe(true);
    container.onUpload = undefined;
    await expect(verifyImmutableAssetVersion(container, identity)).resolves.toBeDefined();
  });

  it("bounds parallel uploads and does not retry a failed Blob call", async () => {
    const container = new MemoryBlobContainer();
    container.onUpload = async (path) => {
      if (path.endsWith("/c.bin")) throw storageFailure(500, "InternalError");
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    await rejectedStorageError(
      createImmutableAssetVersion(
        container,
        input([
          { path: "a.bin", bytes: bytes("a") },
          { path: "b.bin", bytes: bytes("b") },
          { path: "c.bin", bytes: bytes("c") },
          { path: "d.bin", bytes: bytes("d") },
        ]),
        { maxConcurrency: 2 }
      ),
      "STORAGE_OPERATION_FAILED"
    );

    expect(container.maxActiveUploads).toBeLessThanOrEqual(2);
    expect(container.maxActiveUploads).toBeGreaterThanOrEqual(2);
    expect(
      container.operations.filter((operation) => operation.path.endsWith("/c.bin"))
    ).toHaveLength(1);
  });
});

describe("full-version verification and marker binding", () => {
  it("fails when payload bytes change without matching immutable metadata", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    const blob = container.blobs.get(`${prefix()}/material.wgsl`) as StoredBlob;
    blob.bytes = bytes("tampered");

    await rejectedStorageError(
      verifyImmutableAssetVersion(container, identity),
      "BLOB_CORRUPT"
    );
  });

  it("uses intrinsic download-chunk lengths and returns a typed corruption failure", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    const payloadPath = `${prefix()}/material.wgsl`;
    const stored = container.blobs.get(payloadPath) as StoredBlob;
    const spoofed = new Uint8Array(stored.bytes.byteLength + 1_000);
    Object.defineProperty(spoofed, "byteLength", {
      configurable: true,
      get: () => stored.bytes.byteLength,
    });
    const adversarial: BlobContainerPort = {
      getBlockBlobClient: (path) => {
        const delegated = container.getBlockBlobClient(path);
        if (path !== payloadPath) return delegated;
        return {
          uploadData: delegated.uploadData,
          download: async () => ({
            readableStreamBody: (async function* () { yield spoofed; })(),
            contentLength: stored.bytes.byteLength,
            contentType: stored.contentType,
            metadata: stored.metadata,
            etag: stored.etag,
          }),
        };
      },
    };

    await rejectedStorageError(
      verifyImmutableAssetVersion(adversarial, identity),
      "BLOB_CORRUPT"
    );
  });

  it("snapshots a changing response content length exactly once before allocation", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(
      container,
      input([{ path: "material.wgsl", bytes: new Uint8Array([1]) }])
    );
    const payloadPath = `${prefix()}/material.wgsl`;
    const stored = container.blobs.get(payloadPath) as StoredBlob;
    let lengthReads = 0;
    const adversarial: BlobContainerPort = {
      getBlockBlobClient: (path) => {
        const delegated = container.getBlockBlobClient(path);
        if (path !== payloadPath) return delegated;
        return {
          uploadData: delegated.uploadData,
          download: async () => {
            const response = {
              readableStreamBody: (async function* () { yield stored.bytes; })(),
              contentType: stored.contentType,
              metadata: stored.metadata,
              etag: stored.etag,
            } as BlobDownloadResponsePort;
            Object.defineProperty(response, "contentLength", {
              enumerable: true,
              get: () => lengthReads++ === 0 ? 1 : 1_000,
            });
            return response;
          },
        };
      },
    };

    await expect(verifyImmutableAssetVersion(adversarial, identity, {
      maxFileBytes: 2,
      maxVersionBytes: 2,
    })).resolves.toBeDefined();
    expect(lengthReads).toBe(1);
  });

  it("rejects empty download chunks instead of allowing unbounded stream work", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    const payloadPath = `${prefix()}/material.wgsl`;
    const stored = container.blobs.get(payloadPath) as StoredBlob;
    const adversarial: BlobContainerPort = {
      getBlockBlobClient: (path) => {
        const delegated = container.getBlockBlobClient(path);
        if (path !== payloadPath) return delegated;
        return {
          uploadData: delegated.uploadData,
          download: async () => ({
            readableStreamBody: (async function* () {
              yield new Uint8Array();
              yield stored.bytes;
            })(),
            contentLength: stored.bytes.byteLength,
            contentType: stored.contentType,
            metadata: stored.metadata,
            etag: stored.etag,
          }),
        };
      },
    };

    await rejectedStorageError(
      verifyImmutableAssetVersion(adversarial, identity),
      "BLOB_CORRUPT"
    );
  });

  it.each(["metadata", "contentType", "contentLength"])(
    "fails when payload %s differs from its manifest",
    async (field) => {
      const container = new MemoryBlobContainer();
      await createImmutableAssetVersion(container, input());
      const blob = container.blobs.get(`${prefix()}/material.wgsl`) as StoredBlob;
      if (field === "metadata") blob.metadata.unexpected = "caller";
      if (field === "contentType") blob.contentType = "application/octet-stream";
      if (field === "contentLength") blob.contentLength = blob.bytes.byteLength + 1;

      await rejectedStorageError(
        verifyImmutableAssetVersion(container, identity),
        "BLOB_CORRUPT"
      );
    }
  );

  it("fails closed when a declared payload is missing", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    container.blobs.delete(`${prefix()}/material.wgsl`);

    await rejectedStorageError(
      verifyImmutableAssetVersion(container, identity),
      "BLOB_NOT_FOUND"
    );
  });

  it("rejects noncanonical or caller-authored manifest bytes", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    const marker = container.blobs.get(markerPath()) as StoredBlob;
    marker.bytes = bytes("{}\n");
    const digest = createHash("sha256").update(marker.bytes).digest("hex");
    marker.metadata.plasiussha256 = digest;
    marker.metadata.plasiusbytelength = String(marker.bytes.byteLength);

    await rejectedStorageError(
      verifyImmutableAssetVersion(container, identity),
      "INVALID_MANIFEST"
    );
  });

  it("rejects a canonical manifest that assigns a noncanonical MIME to a known extension", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    const marker = container.blobs.get(markerPath()) as StoredBlob;
    const manifest = JSON.parse(new TextDecoder().decode(marker.bytes)) as {
      files: Array<{ contentType: string }>;
    };
    manifest.files[0]!.contentType = "application/octet-stream";
    marker.bytes = bytes(`${JSON.stringify(manifest)}\n`);
    marker.metadata.plasiussha256 = createHash("sha256").update(marker.bytes).digest("hex");
    marker.metadata.plasiusbytelength = String(marker.bytes.byteLength);

    await rejectedStorageError(
      verifyImmutableAssetVersion(container, identity),
      "INVALID_MANIFEST"
    );
  });

  it("rejects unexpected prototype-named immutable metadata", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    const payload = container.blobs.get(`${prefix()}/material.wgsl`) as StoredBlob;
    Object.defineProperty(payload.metadata, "__proto__", {
      configurable: true,
      enumerable: true,
      value: "unexpected",
    });

    await rejectedStorageError(
      verifyImmutableAssetVersion(container, identity),
      "BLOB_CORRUPT"
    );
  });

  it("requires a marker ETag for snapshot binding", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    const marker = container.blobs.get(markerPath()) as StoredBlob;
    marker.etag = "";

    await rejectedStorageError(
      verifyImmutableAssetVersion(container, identity),
      "BLOB_CORRUPT"
    );
  });

  it("rereads the same marker after payload probes and rejects ETag replacement", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    let markerReads = 0;
    container.onDownload = (path, target) => {
      if (path !== markerPath()) return;
      markerReads += 1;
      if (markerReads === 2) {
        const marker = target.blobs.get(path) as StoredBlob;
        target.putDirect(path, { ...cloneStored(marker), etag: '"replacement"' });
      }
    };

    await rejectedStorageError(
      verifyImmutableAssetVersion(container, identity),
      "BLOB_CORRUPT"
    );
    expect(markerReads).toBe(2);
  });

  it("rejects a different valid manifest swapped between initial and final reads", async () => {
    const first = new MemoryBlobContainer();
    await createImmutableAssetVersion(first, input([{ path: "first.bin", bytes: bytes("one") }]));
    const second = new MemoryBlobContainer();
    await createImmutableAssetVersion(
      second,
      input([{ path: "second.bin", bytes: bytes("two") }])
    );
    let markerReads = 0;
    first.onDownload = (path, target) => {
      if (path !== markerPath()) return;
      markerReads += 1;
      if (markerReads === 2) {
        target.putDirect(
          markerPath(),
          cloneStored(second.blobs.get(markerPath()) as StoredBlob)
        );
      }
    };

    await rejectedStorageError(
      verifyImmutableAssetVersion(first, identity),
      "BLOB_CORRUPT"
    );
  });

  it("binds exact replay to the caller-prepared marker across the precheck TOCTOU window", async () => {
    const expected = new MemoryBlobContainer();
    await createImmutableAssetVersion(
      expected,
      input([{ path: "expected.bin", bytes: bytes("expected") }])
    );
    const other = new MemoryBlobContainer();
    await createImmutableAssetVersion(other, input([{ path: "other.bin", bytes: bytes("other") }]));
    let markerReads = 0;
    expected.clearOperations();
    expected.onDownload = (path, target) => {
      if (path !== markerPath()) return;
      markerReads += 1;
      if (markerReads === 2) {
        target.putDirect(
          markerPath(),
          cloneStored(other.blobs.get(markerPath()) as StoredBlob)
        );
      }
    };

    await rejectedStorageError(
      createImmutableAssetVersion(
        expected,
        input([{ path: "expected.bin", bytes: bytes("expected") }])
      ),
      "VERSION_CONFLICT"
    );
    expect(expected.operations.filter((operation) => operation.type === "upload")).toEqual([]);
  });
});

describe("manifest-gated reads", () => {
  it("returns a verified defensive byte copy and binds the marker before and after", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    container.clearOperations();

    const read = await readImmutableAssetVersionFile(
      container,
      identity,
      "material.wgsl"
    );

    expect(new TextDecoder().decode(read.bytes)).toContain("@compute");
    expect(read.contentType).toBe("text/wgsl; charset=utf-8");
    expect(container.operations.filter((operation) => operation.path === markerPath())).toHaveLength(2);
    read.bytes.fill(0);
    expect(container.blobs.get(`${prefix()}/material.wgsl`)?.bytes[0]).not.toBe(0);
  });

  it("rejects undeclared paths without requesting the payload Blob", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    container.clearOperations();

    await rejectedStorageError(
      readImmutableAssetVersionFile(container, identity, "undeclared.bin"),
      "UNDECLARED_FILE"
    );

    expect(container.operations.some((operation) => operation.path.endsWith("undeclared.bin"))).toBe(
      false
    );
    expect(container.operations).toEqual([{ type: "download", path: markerPath() }]);
  });

  it.each([
    IMMUTABLE_VERSION_MANIFEST_PATH,
    "../material.wgsl",
    "channels/latest",
    "https://example.test/material.wgsl",
    "file:/material.wgsl",
  ])("rejects control, traversal, channel, or URL read %s before Blob access", async (path) => {
    const container = new MemoryBlobContainer();

    await rejectedStorageError(
      readImmutableAssetVersionFile(container, identity, path),
      "INVALID_PATH"
    );
    expect(container.operations).toEqual([]);
  });

  it("rejects marker replacement during an otherwise valid file read", async () => {
    const container = new MemoryBlobContainer();
    await createImmutableAssetVersion(container, input());
    let markerReads = 0;
    container.onDownload = (path, target) => {
      if (path !== markerPath()) return;
      markerReads += 1;
      if (markerReads === 2) {
        const marker = target.blobs.get(path) as StoredBlob;
        target.putDirect(path, { ...cloneStored(marker), etag: '"new-etag"' });
      }
    };

    await rejectedStorageError(
      readImmutableAssetVersionFile(container, identity, "material.wgsl"),
      "BLOB_CORRUPT"
    );
  });

  it("does not treat a missing completion marker as a readable partial version", async () => {
    const container = new MemoryBlobContainer();
    container.putDirect(`${prefix()}/material.wgsl`, {
      bytes: bytes("orphan"),
      contentType: "text/wgsl; charset=utf-8",
      metadata: {},
    });

    await rejectedStorageError(
      readImmutableAssetVersionFile(container, identity, "material.wgsl"),
      "BLOB_NOT_FOUND"
    );
  });
});

describe("intake and runtime store façade", () => {
  it("captures distinct container ports and rejects a collapsed intake/runtime boundary", async () => {
    const intake = new MemoryBlobContainer();
    const runtime = new MemoryBlobContainer();
    const config = { intakeContainer: intake, runtimeContainer: runtime };
    const store = createImmutableAssetStore(config);
    const replacement = new MemoryBlobContainer();
    config.intakeContainer = replacement;

    await store.stageVersion(input());
    expect(intake.blobs.size).toBeGreaterThan(0);
    expect(replacement.blobs.size).toBe(0);
    expect(() => createImmutableAssetStore({
      intakeContainer: intake,
      runtimeContainer: intake,
    })).toThrow(ImmutableAssetStorageError);
  });

  it("stages, fully verifies, publishes, and reads separate runtime bytes", async () => {
    const intake = new MemoryBlobContainer();
    const runtime = new MemoryBlobContainer();
    const store = createImmutableAssetStore({
      intakeContainer: intake,
      runtimeContainer: runtime,
      maxConcurrency: 2,
    });

    await store.stageVersion(input());
    const published = await store.publishVersion(identity);
    const verified = await store.verifyVersion("runtime", identity);
    const read = await store.readVersionFile("runtime", identity, "material.wgsl");

    expect(published.prefix).toBe(prefix());
    expect(verified.manifestSha256).toBe(published.manifestSha256);
    expect(read.sha256).toBe(published.files[0]?.sha256);
    expect(runtime.blobs.get(`${prefix()}/material.wgsl`)).not.toBe(
      intake.blobs.get(`${prefix()}/material.wgsl`)
    );
  });

  it("does not publish corrupt intake bytes into runtime", async () => {
    const intake = new MemoryBlobContainer();
    const runtime = new MemoryBlobContainer();
    const store = createImmutableAssetStore({ intakeContainer: intake, runtimeContainer: runtime });
    await store.stageVersion(input());
    (intake.blobs.get(`${prefix()}/material.wgsl`) as StoredBlob).bytes = bytes("tampered");

    await rejectedStorageError(store.publishVersion(identity), "BLOB_CORRUPT");

    expect(runtime.operations).toEqual([]);
    expect(runtime.blobs.size).toBe(0);
  });

  it("makes exact runtime publication idempotent", async () => {
    const intake = new MemoryBlobContainer();
    const runtime = new MemoryBlobContainer();
    const store = createImmutableAssetStore({ intakeContainer: intake, runtimeContainer: runtime });
    await store.stageVersion(input());
    await store.publishVersion(identity);
    runtime.clearOperations();

    const replay = await store.publishVersion(identity);

    expect(replay.replayed).toBe(true);
    expect(runtime.operations.filter((operation) => operation.type === "upload")).toEqual([]);
  });

  it("rejects unknown scopes without using either container", async () => {
    const intake = new MemoryBlobContainer();
    const runtime = new MemoryBlobContainer();
    const store = createImmutableAssetStore({ intakeContainer: intake, runtimeContainer: runtime });

    await rejectedStorageError(
      store.verifyVersion("catalog" as "runtime", identity),
      "INVALID_ARGUMENT"
    );
    expect(intake.operations).toEqual([]);
    expect(runtime.operations).toEqual([]);
  });
});
