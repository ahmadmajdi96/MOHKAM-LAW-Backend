import { sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { embed } from "./ai.ts";
import { logger } from "../observability/logger.ts";

export interface RetrievedChunk {
  content: string;
  documentId: string;
  similarity: number;
}

/**
 * Vector search over indexed document chunks (pgvector, cosine distance).
 *
 * The org/case filter is applied in SQL alongside the vector predicate, not
 * after — retrieval must never surface another firm's material into a prompt,
 * and post-filtering would already have leaked it into the candidate set.
 */
export async function searchChunks(params: {
  query: string;
  orgId: string | null;
  caseId?: string;
  limit?: number;
  minSimilarity?: number;
}): Promise<RetrievedChunk[]> {
  const limit = params.limit ?? 10;
  const minSimilarity = params.minSimilarity ?? 0.25;

  const [vector] = await embed([params.query]);
  if (!vector) return [];

  const literal = `[${vector.join(",")}]`;

  try {
    const rows = await db.execute<{
      content: string;
      document_id: string;
      similarity: number;
    }>(sql`
      SELECT
        content,
        document_id,
        1 - (embedding <=> ${literal}::vector) AS similarity
      FROM document_chunks
      WHERE embedding IS NOT NULL
        AND ${params.orgId ? sql`org_id = ${params.orgId}` : sql`org_id IS NULL`}
        ${params.caseId ? sql`AND case_id = ${params.caseId}` : sql``}
        AND 1 - (embedding <=> ${literal}::vector) > ${minSimilarity}
      ORDER BY embedding <=> ${literal}::vector
      LIMIT ${limit}
    `);

    return rows.map((row) => ({
      content: row.content,
      documentId: row.document_id,
      similarity: Number(row.similarity),
    }));
  } catch (error) {
    // Retrieval failure degrades the answer; it should not fail the whole job.
    logger.error({ err: error }, "vector search failed — continuing without context");
    return [];
  }
}
