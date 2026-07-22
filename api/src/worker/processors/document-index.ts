import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { documentChunks, documents } from "../../db/schema/documents.ts";
import { getObjectStream } from "../../services/storage.ts";
import { embed } from "../../services/ai.ts";
import { logger } from "../../observability/logger.ts";
import type { DocumentIndexJob } from "../../queue/queues.ts";
import { extractText } from "../lib/extract-text.ts";

// Sized so a chunk carries enough context to stand alone as a retrieval
// result, while staying well inside the embedding model's window.
const CHUNK_SIZE = 1_200;
const CHUNK_OVERLAP = 150;
const EMBED_BATCH = 32;

/**
 * Splits on paragraph boundaries where possible so a chunk does not begin
 * mid-sentence. Overlap keeps a fact that straddles a boundary retrievable
 * from either side.
 */
export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= CHUNK_SIZE) return [normalized];

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    let end = Math.min(cursor + CHUNK_SIZE, normalized.length);

    if (end < normalized.length) {
      const window = normalized.slice(cursor, end);
      // Prefer a paragraph break, then a sentence end, then a space.
      const breakAt =
        window.lastIndexOf("\n\n") >= CHUNK_SIZE * 0.5
          ? window.lastIndexOf("\n\n")
          : window.lastIndexOf(". ") >= CHUNK_SIZE * 0.5
            ? window.lastIndexOf(". ") + 1
            : window.lastIndexOf(" ");

      if (breakAt > 0) end = cursor + breakAt;
    }

    const piece = normalized.slice(cursor, end).trim();
    if (piece.length > 0) chunks.push(piece);

    if (end >= normalized.length) break;
    cursor = Math.max(end - CHUNK_OVERLAP, cursor + 1);
  }

  return chunks;
}

export async function processDocumentIndex(job: Job) {
  const { documentId, orgId, caseId } = job.data as DocumentIndexJob;

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!doc) {
    // The document was deleted between enqueue and execution — not an error.
    logger.info({ documentId }, "document gone before indexing; skipping");
    return { skipped: true };
  }

  const body = await getObjectStream(doc.storagePath);
  if (!body) throw new Error(`object missing in storage: ${doc.storagePath}`);

  const buffer = Buffer.from(await body.transformToByteArray());
  const text = await extractText(buffer, doc.mimeType ?? "application/octet-stream");

  if (!text || text.trim().length === 0) {
    // Scanned images without OCR land here. Record the outcome rather than
    // failing and burning five retries on a file that will never yield text.
    logger.warn({ documentId, mimeType: doc.mimeType }, "no extractable text");
    await db
      .update(documents)
      .set({ extractedText: "" })
      .where(eq(documents.id, documentId));
    return { chunks: 0, reason: "no_text" };
  }

  await db
    .update(documents)
    .set({ extractedText: text.slice(0, 1_000_000) })
    .where(eq(documents.id, documentId));

  const chunks = chunkText(text);
  await job.updateProgress(30);

  // Re-indexing replaces the previous pass wholesale; partial updates would
  // leave stale chunks that still match queries.
  await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));

  let written = 0;
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const vectors = await embed(batch);

    await db.insert(documentChunks).values(
      batch.map((content, index) => ({
        orgId,
        documentId,
        caseId,
        chunkIndex: i + index,
        content,
        tokenCount: Math.ceil(content.length / 4),
        embedding: vectors[index] ?? null,
      })),
    );

    written += batch.length;
    await job.updateProgress(30 + Math.floor((written / chunks.length) * 70));
  }

  logger.info({ documentId, chunks: written }, "document indexed");
  return { chunks: written };
}
