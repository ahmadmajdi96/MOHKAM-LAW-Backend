import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "../db/index.ts";
import { documents, documentVersions } from "../db/schema/documents.ts";
import { assertCaseAccess } from "../authz/policy.ts";
import { getAuth, requireAuth } from "../http/middleware.ts";
import { uploadRateLimit } from "../http/rate-limit.ts";
import {
  paginated,
  paginationSchema,
  validate,
  validateQuery,
} from "../http/validate.ts";
import { badRequest, notFound } from "../http/errors.ts";
import {
  buildObjectKey,
  createDownloadUrl,
  createUploadUrl,
  objectExists,
} from "../services/storage.ts";
import { enqueueDocumentIndex } from "../queue/queues.ts";

const router = new Hono();
router.use("*", requireAuth);

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB — discovery bundles get large

// Deny-list by extension is not enough; this is an allow-list of what the
// parsing pipeline can actually handle.
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
]);

router.get("/", async (c) => {
  const auth = getAuth(c);
  const { limit, cursor } = validateQuery(c, paginationSchema);
  const caseId = c.req.query("caseId");

  const filters = [eq(documents.ownerId, auth.userId)];

  if (caseId) {
    // Authorize the case first, then filter by it — this is what allows a
    // colleague to list documents they do not own.
    await assertCaseAccess(auth, caseId);
    filters.length = 0;
    filters.push(eq(documents.caseId, caseId));
  }

  // Owner-scoped clientId filter for the client detail view.
  const clientId = c.req.query("clientId");
  if (clientId) filters.push(eq(documents.clientId, clientId));

  if (cursor) filters.push(lt(documents.createdAt, new Date(cursor)));

  const rows = await db
    .select()
    .from(documents)
    .where(and(...filters))
    .orderBy(desc(documents.createdAt))
    .limit(limit + 1);

  return c.json(paginated(rows, limit));
});

/**
 * Step 1 of upload: reserve a document row and hand back a presigned PUT.
 *
 * The file goes browser → MinIO directly. Streaming it through the API would
 * pin a worker for the whole transfer, which at 200MB and a few concurrent
 * uploads is enough to starve the request pool.
 */
router.post("/upload-url", uploadRateLimit, async (c) => {
  const auth = getAuth(c);
  const body = await validate(
    c,
    z.object({
      filename: z.string().min(1).max(300),
      contentType: z.string().min(1).max(200),
      contentLength: z.number().int().positive().max(MAX_UPLOAD_BYTES),
      caseId: z.string().uuid().nullable().optional(),
      clientId: z.string().uuid().nullable().optional(),
      category: z.string().max(100).nullable().optional(),
    }),
  );

  // Browsers append parameters to the MIME type ("text/plain;charset=utf-8"),
  // so normalise to the base type before the allow-list check and before
  // storing it — otherwise every browser upload of a text file is rejected.
  const contentType = body.contentType.split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED_MIME.has(contentType)) {
    throw badRequest(`Unsupported file type: ${contentType}`);
  }

  if (body.caseId) await assertCaseAccess(auth, body.caseId);

  const documentId = crypto.randomUUID();
  const key = buildObjectKey({
    orgId: auth.orgId,
    caseId: body.caseId ?? null,
    documentId,
    filename: body.filename,
  });

  const [created] = await db
    .insert(documents)
    .values({
      id: documentId,
      ownerId: auth.userId,
      caseId: body.caseId ?? null,
      clientId: body.clientId ?? null,
      name: body.filename,
      // Store the normalised type; the worker's extractor matches base types.
      mimeType: contentType,
      size: body.contentLength,
      storagePath: key,
      category: body.category ?? null,
    })
    .returning();

  const upload = await createUploadUrl({
    key,
    // Sign the RAW content-type: SigV4 signs this header, and the browser will
    // PUT the same parameterised value, so the two must match exactly.
    contentType: body.contentType,
    contentLength: body.contentLength,
  });

  return c.json({ document: created, upload }, 201);
});

/**
 * Step 2: the client confirms the PUT succeeded. The object's existence is
 * verified server-side — a client claiming success is not evidence, and an
 * unverified row would leave a document that can never be downloaded.
 */
router.post("/:id/confirm", async (c) => {
  const auth = getAuth(c);
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, c.req.param("id")), eq(documents.ownerId, auth.userId)))
    .limit(1);

  if (!doc) throw notFound("Document");

  if (!(await objectExists(doc.storagePath))) {
    throw badRequest("Upload was not completed — the object is not in storage");
  }

  await db.insert(documentVersions).values({
    documentId: doc.id,
    version: doc.currentVersion,
    storagePath: doc.storagePath,
    size: doc.size,
    mimeType: doc.mimeType,
    uploadedBy: auth.userId,
  });

  // Text extraction and embedding happen off the request path; a 40-page
  // scanned PDF can take a minute and must not block the response.
  await enqueueDocumentIndex({
    documentId: doc.id,
    orgId: auth.orgId,
    caseId: doc.caseId,
  });

  return c.json({ ok: true, indexing: true });
});

router.get("/:id/download", async (c) => {
  const auth = getAuth(c);
  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, c.req.param("id")))
    .limit(1);

  if (!doc) throw notFound("Document");

  if (doc.ownerId !== auth.userId) {
    if (!doc.caseId) throw notFound("Document");
    await assertCaseAccess(auth, doc.caseId);
  }

  const url = await createDownloadUrl(doc.storagePath, doc.name);
  return c.json({ url, expiresIn: 900 });
});

router.delete("/:id", async (c) => {
  const auth = getAuth(c);
  // Storage objects are intentionally left in place: versioning is enabled on
  // the bucket, and legal records need a recoverable delete. A retention job
  // reaps them separately.
  const result = await db
    .delete(documents)
    .where(and(eq(documents.id, c.req.param("id")), eq(documents.ownerId, auth.userId)));

  if (result.count === 0) throw notFound("Document");
  return c.body(null, 204);
});

export default router;
