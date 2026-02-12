import { ShareServiceClient } from "@azure/storage-file-share";

interface UploadOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * Uploads a user image to Azure File Share storage with retries and error handling.
 * @param userId - The user's ID (used as directory name)
 * @param version - The version number (used as file name)
 * @param buffer - The file data as a Buffer
 * @param contentType - The MIME type of the file
 * @param options - Optional settings for retries and backoff
 * @returns URL to the uploaded file
 */
export async function uploadUserImageShare(
  userId: string,
  version: number,
  buffer: Buffer,
  contentType: string,
  options: UploadOptions = {}
): Promise<string> {
  // Parameter validation
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    throw new Error(
      "AZURE_STORAGE_CONNECTION_STRING is not set in environment variables."
    );
  }
  if (!userId || typeof userId !== "string") {
    throw new Error("userId is required and must be a string.");
  }
  if (typeof version !== "number" || isNaN(version)) {
    throw new Error("version is required and must be a number.");
  }
  if (!buffer || !(buffer instanceof Buffer)) {
    throw new Error("buffer is required and must be a Buffer.");
  }
  if (!contentType || typeof contentType !== "string") {
    throw new Error("contentType is required and must be a string.");
  }

  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;

  const shareName = "avatars";
  const directoryName = userId;
  const fileName = `${version}.jpg`;

  const serviceClient = ShareServiceClient.fromConnectionString(
    process.env.AZURE_STORAGE_CONNECTION_STRING
  );
  const shareClient = serviceClient.getShareClient(shareName);
  const directoryClient = shareClient.getDirectoryClient(directoryName);
  const fileClient = directoryClient.getFileClient(fileName);

  // Retry logic with exponential backoff
  let attempt = 0;
  let lastError: unknown = null;
  while (attempt < maxRetries) {
    try {
      // Ensure share exists
      await shareClient.createIfNotExists();
      // Ensure directory exists
      await directoryClient.createIfNotExists();
      // Create file (set size)
      await fileClient.create(buffer.length, {
        fileHttpHeaders: { fileContentType: contentType },
      });
      // Upload content
      await fileClient.uploadRange(buffer, 0, buffer.length);
      // Return file URL
      return fileClient.url;
    } catch (err: unknown) {
      lastError = err;
      if (
        err &&
        typeof err === "object" &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string"
      ) {
        console.error(
          `Attempt ${attempt + 1} to upload user image failed: ${
            (err as { message: string }).message
          }`
        );
      } else {
        console.error(
          `Attempt ${attempt + 1} to upload user image failed:`,
          err
        );
      }
      // Exponential backoff with jitter
      if (attempt < maxRetries - 1) {
        const baseDelay = Math.pow(2, attempt) * baseDelayMs;
        const jitter = Math.random() * baseDelay;
        const delay = baseDelay / 2 + jitter; // Between 0.5x and 1.5x base delay
        console.warn(
          `Backing off for ${Math.round(delay)} ms before retrying...`
        );
        await new Promise((res) => setTimeout(res, delay));
      }
    }
    attempt++;
  }
  const lastErrorMsg =
    lastError &&
    typeof lastError === "object" &&
    "message" in lastError &&
    typeof (lastError as { message: unknown }).message === "string"
      ? (lastError as { message: string }).message
      : String((lastError as Error) ?? "");
  throw new Error(
    `Failed to upload user image after ${maxRetries} attempts: ${lastErrorMsg}`
  );
}
