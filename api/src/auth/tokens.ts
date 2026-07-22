import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { env } from "../env.ts";

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export interface AccessClaims extends JWTPayload {
  sub: string; // user id
  email: string;
  sid: string; // session id — lets a single session be revoked
}

/**
 * Access tokens are stateless and short-lived (15 min by default). They are
 * deliberately NOT checked against the database on every request; that is the
 * entire point of the split. Revocation latency is therefore bounded by
 * JWT_ACCESS_TTL, which is the tradeoff being made for read scalability.
 *
 * Note the org id is absent from the claims. Membership is re-read per request
 * so that a role change or removal takes effect immediately rather than at the
 * next token refresh — the one place the extra query is worth paying for.
 */
export async function signAccessToken(claims: {
  userId: string;
  email: string;
  sessionId: string;
}): Promise<string> {
  return new SignJWT({ email: claims.email, sid: claims.sessionId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setIssuer("mohkam")
    .setAudience("mohkam-api")
    .setExpirationTime(`${env.JWT_ACCESS_TTL}s`)
    .sign(accessSecret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, accessSecret, {
    issuer: "mohkam",
    audience: "mohkam-api",
    algorithms: ["HS256"],
  });

  if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
    throw new Error("malformed access token");
  }
  return payload as AccessClaims;
}

/**
 * Refresh tokens are opaque random strings, not JWTs — there is nothing to
 * read from them, and they are only ever compared against a stored hash.
 */
export function generateRefreshToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Buffer.from(digest).toString("hex");
}
