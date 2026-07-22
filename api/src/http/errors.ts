/**
 * Errors carry a stable machine-readable `code` alongside the HTTP status, so
 * the frontend can branch on behaviour without string-matching prose.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (resource = "Resource") =>
  new AppError(404, "not_found", `${resource} not found`);

export const unauthorized = (message = "Authentication required") =>
  new AppError(401, "unauthorized", message);

/**
 * Deliberately indistinguishable from a 404 at the API boundary for
 * tenant-scoped resources — see authz/policy.ts. Use this only where the
 * caller is already known to be able to see that the resource exists.
 */
export const forbidden = (message = "You do not have access to this") =>
  new AppError(403, "forbidden", message);

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "bad_request", message, details);

export const conflict = (code: string, message: string) =>
  new AppError(409, code, message);

export const serviceUnavailable = (code: string, message: string) =>
  new AppError(503, code, message);
