import type { Context } from "hono";
import { z } from "zod";
import { AppError } from "./errors.ts";

/**
 * Parses and validates a JSON body. Validation failures return a 422 with the
 * per-field issues, so the client can attach messages to form inputs instead
 * of showing one generic error.
 */
export async function validate<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be valid JSON");
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new AppError(422, "validation_failed", "Request validation failed", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    });
  }

  return result.data;
}

/** Same, for query strings. */
export function validateQuery<T extends z.ZodType>(
  c: Context,
  schema: T,
): z.infer<T> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    throw new AppError(422, "validation_failed", "Query validation failed", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

/**
 * Shared pagination contract.
 *
 * Keyset pagination via `cursor` (an ISO timestamp) rather than OFFSET: at
 * page 500 an OFFSET scan walks and discards 500 pages of rows, while a
 * cursor seeks straight to the index entry. The hard limit cap of 100 means
 * no client can ask for an unbounded result set.
 */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().datetime().optional(),
  q: z.string().max(200).optional(),
});

export type Pagination = z.infer<typeof paginationSchema>;

/** Builds the response envelope every list endpoint returns. */
export function paginated<T extends { createdAt: Date }>(
  rows: T[],
  limit: number,
): { data: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return {
    data,
    nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
  };
}
