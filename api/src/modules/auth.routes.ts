import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import * as authService from "../auth/service.ts";
import { db } from "../db/index.ts";
import { profiles, users } from "../db/schema/auth.ts";
import { organizationMembers, organizations } from "../db/schema/org.ts";
import { getAuth, requireAuth } from "../http/middleware.ts";
import { authRateLimit } from "../http/rate-limit.ts";
import { validate } from "../http/validate.ts";
import { and, eq as eqOp } from "drizzle-orm";

const router = new Hono();

// A 12-char minimum with no composition rules follows current NIST guidance:
// length dominates, and forced symbol classes push users toward "Password1!".
const passwordSchema = z.string().min(12).max(200);

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: passwordSchema,
  fullName: z.string().min(1).max(200).optional(),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

function sessionContext(c: Context) {
  return {
    userAgent: c.req.header("user-agent"),
    ip: c.req.header("x-real-ip") ?? undefined,
  };
}

router.post("/register", authRateLimit, async (c) => {
  const body = await validate(c, credentialsSchema);
  const tokens = await authService.register({
    email: body.email,
    password: body.password,
    fullName: body.fullName,
    context: sessionContext(c),
  });
  return c.json(tokens, 201);
});

router.post("/login", authRateLimit, async (c) => {
  const body = await validate(
    c,
    credentialsSchema.pick({ email: true, password: true }),
  );
  const tokens = await authService.login({
    email: body.email,
    password: body.password,
    context: sessionContext(c),
  });
  return c.json(tokens);
});

router.post("/refresh", async (c) => {
  const body = await validate(c, refreshSchema);
  const tokens = await authService.refresh({
    refreshToken: body.refreshToken,
    context: sessionContext(c),
  });
  return c.json(tokens);
});

router.post("/logout", async (c) => {
  const body = await validate(c, refreshSchema);
  await authService.logout(body.refreshToken);
  // Always 204, even for an unknown token — logout must be idempotent and
  // must not report whether the token was real.
  return c.body(null, 204);
});

/**
 * Everything the client needs to boot: identity, profile, and the orgs this
 * user belongs to. Replaces several separate Supabase round trips.
 */
router.get("/me", requireAuth, async (c) => {
  const auth = getAuth(c);

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      createdAt: users.createdAt,
      fullName: profiles.fullName,
      avatarUrl: profiles.avatarUrl,
      role: profiles.role,
    })
    .from(users)
    .leftJoin(profiles, eq(profiles.id, users.id))
    .where(eq(users.id, auth.userId))
    .limit(1);

  if (!user) return c.json({ error: { code: "not_found" } }, 404);

  const memberships = await db
    .select({
      orgId: organizations.id,
      legalName: organizations.legalName,
      displayName: organizations.displayName,
      type: organizations.type,
      currency: organizations.currency,
      preferredLanguage: organizations.preferredLanguage,
      role: organizationMembers.role,
      status: organizationMembers.status,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(
      and(
        eqOp(organizationMembers.userId, auth.userId),
        eqOp(organizationMembers.status, "active"),
      ),
    );

  return c.json({
    user,
    organizations: memberships,
    activeOrgId: auth.orgId,
  });
});

router.patch("/me", requireAuth, async (c) => {
  const auth = getAuth(c);
  const body = await validate(
    c,
    z.object({
      fullName: z.string().min(1).max(200).optional(),
      avatarUrl: z.string().url().max(2000).nullable().optional(),
    }),
  );

  const [updated] = await db
    .update(profiles)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(profiles.id, auth.userId))
    .returning();

  return c.json(updated);
});

export default router;
