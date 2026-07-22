import { Hono } from "hono";
import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema/auth.ts";
import { organizationMembers, organizations } from "../db/schema/org.ts";
import { activityLog } from "../db/schema/audit.ts";
import {
  CAN_MANAGE_MEMBERS,
  CAN_MANAGE_ORG,
  assertOrgMember,
  assertOrgRole,
  invalidateMembership,
} from "../authz/policy.ts";
import { ORG_ROLES, outranks, type OrgRole } from "../authz/roles.ts";
import { getAuth, requireAuth } from "../http/middleware.ts";
import { validate } from "../http/validate.ts";
import { AppError, conflict, notFound } from "../http/errors.ts";

const router = new Hono();
router.use("*", requireAuth);

const orgSettingsSchema = z.object({
  legalName: z.string().min(1).max(300),
  displayName: z.string().max(300).nullable().optional(),
  type: z.enum(["solo", "firm"]).default("firm"),
  email: z.string().email().max(320).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  address: z.string().max(1000).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  taxId: z.string().max(100).nullable().optional(),
  currency: z.string().length(3).optional(),
  preferredLanguage: z.enum(["ar", "en"]).optional(),
  defaultTaxRate: z.string().optional(),
  invoicePrefix: z.string().min(1).max(10).optional(),
  quotePrefix: z.string().min(1).max(10).optional(),
  smsSenderId: z.string().max(20).nullable().optional(),
  smsQuietHoursStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  smsQuietHoursEnd: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  smsTimezone: z.string().max(64).optional(),
  smsDailyCapPerRecipient: z.number().int().min(0).max(20).optional(),
  smsBilingualFooter: z.boolean().optional(),
});

/**
 * Create a workspace — the replacement for the create_workspace() SQL function.
 *
 * The org and the creator's owner membership must be created together: an org
 * with no owner is unreachable by anyone, including its creator, and there is
 * no admin backdoor in this system to repair it.
 */
router.post("/", async (c) => {
  const auth = getAuth(c);
  const body = await validate(c, orgSettingsSchema);

  const created = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ ...body, createdBy: auth.userId })
      .returning();

    if (!org) throw new Error("organization insert returned no row");

    await tx.insert(organizationMembers).values({
      orgId: org.id,
      userId: auth.userId,
      role: "owner",
      status: "active",
    });

    await tx.insert(activityLog).values({
      orgId: org.id,
      actorId: auth.userId,
      entityType: "organization",
      entityId: org.id,
      action: "created",
      summary: org.legalName,
    });

    return org;
  });

  // The negative membership result may already be cached from a prior probe.
  await invalidateMembership(auth.userId, created.id);

  return c.json({ ...created, role: "owner" satisfies OrgRole }, 201);
});

/** Organizations the caller belongs to. */
router.get("/", async (c) => {
  const auth = getAuth(c);

  const rows = await db
    .select({
      id: organizations.id,
      legalName: organizations.legalName,
      displayName: organizations.displayName,
      type: organizations.type,
      currency: organizations.currency,
      preferredLanguage: organizations.preferredLanguage,
      logoPath: organizations.logoPath,
      role: organizationMembers.role,
      status: organizationMembers.status,
      createdAt: organizations.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(
      and(
        eq(organizationMembers.userId, auth.userId),
        eq(organizationMembers.status, "active"),
      ),
    );

  return c.json({ data: rows });
});

router.get("/:id", async (c) => {
  const auth = getAuth(c);
  const orgId = c.req.param("id");
  const role = await assertOrgMember(auth, orgId);

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) throw notFound("Organization");
  return c.json({ ...org, role });
});

router.patch("/:id", async (c) => {
  const auth = getAuth(c);
  const orgId = c.req.param("id");
  await assertOrgRole(auth, orgId, CAN_MANAGE_ORG, "org:update");

  const body = await validate(c, orgSettingsSchema.partial());

  const [updated] = await db
    .update(organizations)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(organizations.id, orgId))
    .returning();

  await db.insert(activityLog).values({
    orgId,
    actorId: auth.userId,
    entityType: "organization",
    entityId: orgId,
    action: "updated",
    metadata: { fields: Object.keys(body) },
  });

  return c.json(updated);
});

// ---------------------------------------------------------------- members

router.get("/:id/members", async (c) => {
  const auth = getAuth(c);
  const orgId = c.req.param("id");
  await assertOrgMember(auth, orgId);

  const rows = await db
    .select({
      id: organizationMembers.id,
      userId: organizationMembers.userId,
      invitedEmail: organizationMembers.invitedEmail,
      role: organizationMembers.role,
      status: organizationMembers.status,
      email: users.email,
      createdAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .leftJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.orgId, orgId));

  return c.json({ data: rows });
});

/**
 * Invite by email.
 *
 * If the address already has an account it is linked immediately; otherwise a
 * pending row is created and bound on signup (see auth/service.ts register).
 * Either way the invite is addressed to an email, so the inviter does not need
 * to know whether that person has registered yet.
 */
router.post("/:id/members", async (c) => {
  const auth = getAuth(c);
  const orgId = c.req.param("id");
  const actorRole = await assertOrgRole(auth, orgId, CAN_MANAGE_MEMBERS, "member:invite");

  const body = await validate(
    c,
    z.object({
      email: z.string().email().max(320),
      role: z.enum(ORG_ROLES).default("associate"),
    }),
  );

  // You cannot mint someone at or above your own seniority — otherwise a
  // partner could create an owner and then be removed by them.
  if (!outranks(actorRole, body.role) && actorRole !== "owner") {
    throw new AppError(
      403,
      "insufficient_role",
      `You cannot grant the ${body.role} role`,
    );
  }

  const email = body.email.trim().toLowerCase();

  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true },
  });

  const duplicate = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      existingUser
        ? eq(organizationMembers.userId, existingUser.id)
        : eq(organizationMembers.invitedEmail, email),
    ),
    columns: { id: true },
  });

  if (duplicate) throw conflict("already_member", "That person is already invited or a member");

  const [member] = await db
    .insert(organizationMembers)
    .values({
      orgId,
      userId: existingUser?.id ?? null,
      invitedEmail: email,
      role: body.role,
      // An existing account joins active; an unregistered invitee stays
      // pending until they sign up.
      status: existingUser ? "active" : "invited",
    })
    .returning();

  if (existingUser) await invalidateMembership(existingUser.id, orgId);

  await db.insert(activityLog).values({
    orgId,
    actorId: auth.userId,
    entityType: "organization_member",
    entityId: member?.id ?? null,
    action: "invited",
    summary: email,
    metadata: { role: body.role },
  });

  return c.json(member, 201);
});

/** Counts active owners — used to protect against removing the last one. */
async function countOwners(orgId: string, excludingMemberId?: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.role, "owner"),
        eq(organizationMembers.status, "active"),
        excludingMemberId ? ne(organizationMembers.id, excludingMemberId) : undefined,
      ),
    );
  return row?.count ?? 0;
}

router.patch("/:id/members/:memberId", async (c) => {
  const auth = getAuth(c);
  const orgId = c.req.param("id");
  const memberId = c.req.param("memberId");
  const actorRole = await assertOrgRole(auth, orgId, CAN_MANAGE_MEMBERS, "member:update");

  const body = await validate(
    c,
    z.object({
      role: z.enum(ORG_ROLES).optional(),
      status: z.enum(["active", "disabled"]).optional(),
    }),
  );

  const target = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.id, memberId),
      eq(organizationMembers.orgId, orgId),
    ),
  });

  if (!target) throw notFound("Member");

  // Only an owner may modify another owner.
  if (target.role === "owner" && actorRole !== "owner") {
    throw new AppError(403, "insufficient_role", "Only an owner can modify another owner");
  }

  // Demoting or disabling the last owner would leave the org unadministrable.
  const losingOwner =
    target.role === "owner" &&
    ((body.role && body.role !== "owner") || body.status === "disabled");

  if (losingOwner && (await countOwners(orgId, memberId)) === 0) {
    throw conflict("last_owner", "An organization must keep at least one active owner");
  }

  const [updated] = await db
    .update(organizationMembers)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(organizationMembers.id, memberId))
    .returning();

  // Role and status changes must take effect now, not after the 30s
  // membership cache expires.
  if (target.userId) await invalidateMembership(target.userId, orgId);

  await db.insert(activityLog).values({
    orgId,
    actorId: auth.userId,
    entityType: "organization_member",
    entityId: memberId,
    action: "updated",
    metadata: { ...body },
  });

  return c.json(updated);
});

router.delete("/:id/members/:memberId", async (c) => {
  const auth = getAuth(c);
  const orgId = c.req.param("id");
  const memberId = c.req.param("memberId");
  const actorRole = await assertOrgRole(auth, orgId, CAN_MANAGE_MEMBERS, "member:remove");

  const target = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.id, memberId),
      eq(organizationMembers.orgId, orgId),
    ),
  });

  if (!target) throw notFound("Member");

  if (target.role === "owner" && actorRole !== "owner") {
    throw new AppError(403, "insufficient_role", "Only an owner can remove another owner");
  }

  if (target.role === "owner" && (await countOwners(orgId, memberId)) === 0) {
    throw conflict("last_owner", "An organization must keep at least one active owner");
  }

  await db.delete(organizationMembers).where(eq(organizationMembers.id, memberId));

  if (target.userId) await invalidateMembership(target.userId, orgId);

  await db.insert(activityLog).values({
    orgId,
    actorId: auth.userId,
    entityType: "organization_member",
    entityId: memberId,
    action: "removed",
  });

  return c.body(null, 204);
});

export default router;
