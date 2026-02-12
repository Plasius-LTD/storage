import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadUserImageShare } from "../src/index.js";
import { ShareServiceClient } from "@azure/storage-file-share";

const mockState = vi.hoisted(() => {
  const fileClient = {
    create: vi.fn(),
    uploadRange: vi.fn(),
    url: "https://example.com/avatars/user-1/1.jpg",
  };
  const directoryClient = {
    createIfNotExists: vi.fn(),
    getFileClient: vi.fn(() => fileClient),
  };
  const shareClient = {
    createIfNotExists: vi.fn(),
    getDirectoryClient: vi.fn(() => directoryClient),
  };
  const serviceClient = {
    getShareClient: vi.fn(() => shareClient),
  };

  return { fileClient, directoryClient, shareClient, serviceClient };
});

vi.mock("@azure/storage-file-share", () => ({
  ShareServiceClient: {
    fromConnectionString: vi.fn(() => mockState.serviceClient),
  },
}));

const originalConnectionString =
  process.env.AZURE_STORAGE_CONNECTION_STRING ?? undefined;

beforeEach(() => {
  process.env.AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
  vi.clearAllMocks();
  mockState.shareClient.createIfNotExists.mockResolvedValue(undefined);
  mockState.directoryClient.createIfNotExists.mockResolvedValue(undefined);
  mockState.fileClient.create.mockResolvedValue(undefined);
  mockState.fileClient.uploadRange.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  if (originalConnectionString === undefined) {
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
  } else {
    process.env.AZURE_STORAGE_CONNECTION_STRING = originalConnectionString;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("uploadUserImageShare", () => {
  it("throws when the storage connection string is missing", async () => {
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;

    await expect(
      uploadUserImageShare(
        "user-1",
        1,
        Buffer.from("data"),
        "image/jpeg"
      )
    ).rejects.toThrow(
      "AZURE_STORAGE_CONNECTION_STRING is not set in environment variables."
    );

    expect(ShareServiceClient.fromConnectionString).not.toHaveBeenCalled();
  });

  it("validates required parameters", async () => {
    await expect(
      uploadUserImageShare("", 1, Buffer.from("data"), "image/jpeg")
    ).rejects.toThrow("userId is required and must be a string.");

    await expect(
      uploadUserImageShare(
        "user-1",
        1,
        "invalid" as unknown as Buffer,
        "image/jpeg"
      )
    ).rejects.toThrow("buffer is required and must be a Buffer.");
  });

  it("uploads successfully and returns the file URL", async () => {
    const buffer = Buffer.from("data");

    const url = await uploadUserImageShare(
      "user-1",
      1,
      buffer,
      "image/jpeg"
    );

    expect(url).toBe(mockState.fileClient.url);
    expect(mockState.shareClient.createIfNotExists).toHaveBeenCalledOnce();
    expect(mockState.directoryClient.createIfNotExists).toHaveBeenCalledOnce();
    expect(mockState.fileClient.create).toHaveBeenCalledWith(buffer.length, {
      fileHttpHeaders: { fileContentType: "image/jpeg" },
    });
    expect(mockState.fileClient.uploadRange).toHaveBeenCalledWith(
      buffer,
      0,
      buffer.length
    );
  });

  it("retries after failures and succeeds on a later attempt", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    const buffer = Buffer.from("data");
    mockState.fileClient.create
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const uploadPromise = uploadUserImageShare(
      "user-1",
      1,
      buffer,
      "image/jpeg",
      { maxRetries: 2, baseDelayMs: 5 }
    );

    await vi.advanceTimersByTimeAsync(10);

    const url = await uploadPromise;

    expect(url).toBe(mockState.fileClient.url);
    expect(mockState.fileClient.create).toHaveBeenCalledTimes(2);
    expect(mockState.fileClient.uploadRange).toHaveBeenCalledTimes(1);
  });
});
