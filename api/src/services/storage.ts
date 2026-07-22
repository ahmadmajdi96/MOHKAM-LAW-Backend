import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env.ts";
import { logger } from "../observability/logger.ts";

/**
 * Replaces Supabase Storage. Backed by MinIO in this stack, but the client is
 * plain S3 — pointing S3_ENDPOINT at AWS, R2 or Wasabi requires no code change.
 *
 * Two clients, because two audiences reach the object store by different hosts:
 *
 *  - `s3` uses the INTERNAL endpoint (minio:9000). Server-side operations —
 *    HEAD, GET-stream, DELETE — go container-to-container and never leave the
 *    private network.
 *
 *  - `s3Public` signs presigned URLs against S3_PUBLIC_URL, the host a browser
 *    can actually reach (Caddy-proxied in production). A URL signed for
 *    minio:9000 is unreachable and unverifiable from outside; this is the
 *    difference between uploads working and not working in the browser.
 *
 * SigV4 binds the signature to the request host, so the two cannot be merged:
 * whichever host the client reaches must match the host it was signed for.
 */
const credentials = {
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
};

export const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  // MinIO serves bucket-as-path, not bucket-as-subdomain.
  forcePathStyle: true,
  credentials,
});

const s3Public = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_PUBLIC_URL,
  forcePathStyle: true,
  credentials,
});

const UPLOAD_URL_TTL = 300; // 5 min — long enough to pick a file, short enough to not be a shareable link
const DOWNLOAD_URL_TTL = 900;

/**
 * Object keys are namespaced by org and case so that a bulk export or a
 * tenant deletion is a prefix operation rather than a table scan.
 */
export function buildObjectKey(parts: {
  orgId: string | null;
  caseId?: string | null;
  documentId: string;
  filename: string;
}): string {
  const safeName = parts.filename
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .slice(0, 120);
  const scope = parts.orgId ?? "personal";
  const caseSegment = parts.caseId ? `cases/${parts.caseId}` : "unfiled";
  return `orgs/${scope}/${caseSegment}/${parts.documentId}/${safeName}`;
}

/**
 * Presigned PUT. Uploads go browser → MinIO directly, never through the API,
 * so a 200MB discovery bundle does not occupy an API worker for its duration.
 */
export async function createUploadUrl(input: {
  key: string;
  contentType: string;
  contentLength: number;
}): Promise<{ url: string; key: string; expiresIn: number }> {
  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: input.key,
    ContentType: input.contentType,
    // Signing the length stops a client from using the URL to upload
    // something far larger than it declared.
    ContentLength: input.contentLength,
  });

  // Signed against the public host — the browser PUTs here directly.
  const url = await getSignedUrl(s3Public, command, { expiresIn: UPLOAD_URL_TTL });
  return { url, key: input.key, expiresIn: UPLOAD_URL_TTL };
}

export async function createDownloadUrl(
  key: string,
  filename?: string,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ...(filename
      ? {
          ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        }
      : {}),
  });
  // Also public: the browser follows this URL to download the object.
  return getSignedUrl(s3Public, command, { expiresIn: DOWNLOAD_URL_TTL });
}

export async function getObjectStream(key: string) {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  );
  return result.Body;
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

export async function checkStorage(): Promise<boolean> {
  try {
    // HEAD on a key that will not exist still proves connectivity and auth;
    // a 404 is a success signal here, only transport/credential errors throw.
    await s3.send(
      new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: "__healthcheck__" }),
    );
    return true;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "NotFound" || name === "NoSuchKey") return true;
    logger.error({ err: error }, "storage healthcheck failed");
    return false;
  }
}
