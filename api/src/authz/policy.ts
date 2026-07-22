import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { organizationMembers } from "../db/schema/org.ts";
import { caseMembers, cases } from "../db/schema/cases.ts";
import { authzDenialsTotal } from "../observability/metrics.ts";
import { AppError, notFound } from "../http/errors.ts";
import { cache } from "../services/cache.ts";
import type { OrgRole } from "./roles.ts";

/**
 * ============================================================================
 * THE RLS REPLACEMENT
 * ============================================================================
 *
 * Under Supabase, Postgres enforced tenancy: every table had RLS policies and
 * a forgotten WHERE clause was still safe. That safety net is gone. Nothing in
 * Postgres now prevents `SELECT * FROM cases` from returning every firm's data.
 *
 * The rules below are the sole remaining boundary between tenants. Two
 * invariants make that tractable:
 *
 *   1. No route handler builds a tenant-scoped query by hand. Handlers receive
 *      an AuthContext and pass it to a scope helper, which contributes the
 *      org/owner predicate. Grep for `scopeToOrg(` to audit every such query.
 *
 *   2. Denials are logged and counted (authz_denials_total). A tenancy bug
 *      shows up as a metric spike, not as silent cross-tenant reads.
 *
 * These functions mirror the original SQL helpers one-for-one:
 *   is_org_member  → assertOrgMember / isOrgMember
 *   has_org_role   → assertOrgRole
 *   org_role_of    → getOrgRole
 *   is_case_member → assertCaseAccess
 *   is_case_owner  → (case.ownerId === userId)
 */

export interface AuthContext {
  userId: string;
  email: string;
  sessionId: string;
  /** Active organization, from the X-Org-Id header. Null for personal scope. */
  orgId: string | null;
  orgRole: OrgRole | null;
}

const MEMBERSHIP_TTL_SECONDS = 30;

/**
 * Resolves a user's role in an org.
 *
 * Cached for 30s: this runs on essentially every authenticated request, and an
 * uncached lookup would put a query in front of all of them. The window is
 * short enough that a revoked member loses access within half a minute, which
 * is the deliberate tradeoff. Call `invalidateMembership` on any membership
 * write to close it immediately.
 */
export async function getOrgRole(
  userId: string,
  orgId: string,
): Promise<OrgRole | null> {
  const key = `authz:member:${orgId}:${userId}`;

  const cached = await cache.get<OrgRole | "none">(key);
  if (cached !== null) return cached === "none" ? null : cached;

  const membership = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, userId),
      eq(organizationMembers.status, "active"),
    ),
    columns: { role: true },
  });

  const role = membership?.role ?? null;
  // Negative results are cached too, so a probing loop cannot turn into a
  // query-per-request denial-of-service against Postgres.
  await cache.set(key, role ?? "none", MEMBERSHIP_TTL_SECONDS);
  return role;
}

export async function invalidateMembership(userId: string, orgId: string) {
  await cache.del(`authz:member:${orgId}:${userId}`);
}

export async function isOrgMember(userId: string, orgId: string) {
  return (await getOrgRole(userId, orgId)) !== null;
}

/** Throws unless the caller is an active member of the org. */
export async function assertOrgMember(
  auth: AuthContext,
  orgId: string,
): Promise<OrgRole> {
  const role = await getOrgRole(auth.userId, orgId);
  if (!role) {
    authzDenialsTotal.inc({ resource: "organization", action: "read" });
    // 404, not 403: a 403 would confirm that this org id exists.
    throw notFound("Organization");
  }
  return role;
}

/** Mirrors has_org_role(_org_id, _roles[], _user_id). */
export async function assertOrgRole(
  auth: AuthContext,
  orgId: string,
  allowed: readonly OrgRole[],
  action = "write",
): Promise<OrgRole> {
  const role = await assertOrgMember(auth, orgId);
  if (!allowed.includes(role)) {
    authzDenialsTotal.inc({ resource: "organization", action });
    throw new AppError(
      403,
      "insufficient_role",
      `This action requires one of: ${allowed.join(", ")}`,
    );
  }
  return role;
}

/**
 * Case visibility, mirroring the original policy: a case is readable if the
 * caller owns it, is the responsible lawyer, is on its explicit member list,
 * or is a member of the org that owns it.
 *
 * Returns the case row so callers do not fetch it twice.
 */
export async function assertCaseAccess(
  auth: AuthContext,
  caseId: string,
): Promise<typeof cases.$inferSelect> {
  const [row] = await db
    .select()
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);

  if (!row) throw notFound("Case");

  if (row.ownerId === auth.userId || row.responsibleLawyer === auth.userId) {
    return row;
  }

  const [membership] = await db
    .select({ id: caseMembers.id })
    .from(caseMembers)
    .where(
      and(eq(caseMembers.caseId, caseId), eq(caseMembers.userId, auth.userId)),
    )
    .limit(1);

  if (membership) return row;

  if (row.orgId && (await isOrgMember(auth.userId, row.orgId))) {
    return row;
  }

  authzDenialsTotal.inc({ resource: "case", action: "read" });
  // Same 404 reasoning as above: never confirm existence to a non-member.
  throw notFound("Case");
}

/**
 * Predicate for org-scoped LIST queries.
 *
 * Every list endpoint over an org-scoped table must compose this into its
 * WHERE clause. It takes the *column*, so it cannot be applied to the wrong
 * table by accident.
 */
export function scopeToOrg(
  orgIdColumn: Parameters<typeof eq>[0],
  auth: AuthContext,
) {
  if (!auth.orgId) {
    throw new AppError(
      400,
      "org_required",
      "This endpoint requires an active organization (X-Org-Id header)",
    );
  }
  return eq(orgIdColumn, auth.orgId);
}

/**
 * Predicate for owner-scoped tables (clients, time_entries, documents, …),
 * which carry no org_id — see the tenancy note in schema/crm.ts.
 *
 * Visibility extends beyond the owner: rows attached to a case the caller can
 * see are visible too, which is how colleagues share a client record.
 */
export function scopeToOwner(
  ownerIdColumn: Parameters<typeof eq>[0],
  auth: AuthContext,
) {
  return eq(ownerIdColumn, auth.userId);
}

/**
 * Owner-scoped rows, widened to anything hanging off a case the caller can
 * reach. Expressed as a single EXISTS so it stays one round trip.
 */
export function scopeToOwnerOrSharedCase(
  ownerIdColumn: Parameters<typeof eq>[0],
  caseIdColumn: Parameters<typeof eq>[0],
  auth: AuthContext,
) {
  const orgClause = auth.orgId
    ? sql`OR c.org_id = ${auth.orgId}`
    : sql``;

  return or(
    eq(ownerIdColumn, auth.userId),
    sql`EXISTS (
      SELECT 1 FROM cases c
      WHERE c.id = ${caseIdColumn}
        AND (
          c.owner_id = ${auth.userId}
          OR c.responsible_lawyer = ${auth.userId}
          OR EXISTS (
            SELECT 1 FROM case_members cm
            WHERE cm.case_id = c.id AND cm.user_id = ${auth.userId}
          )
          ${orgClause}
        )
    )`,
  );
}

// --- Role sets, named after the operation rather than the role list ---------
// Keeping these as constants means a policy change happens in one place
// instead of being scattered across handlers.

export const CAN_MANAGE_ORG = ["owner", "partner"] as const;
export const CAN_MANAGE_MEMBERS = ["owner", "partner"] as const;
export const CAN_MANAGE_BILLING = ["owner", "partner", "accountant"] as const;
export const CAN_WRITE_CASES = [
  "owner",
  "partner",
  "associate",
  "paralegal",
] as const;
export const CAN_READ_ALL = [
  "owner",
  "partner",
  "associate",
  "paralegal",
  "accountant",
  "assistant",
] as const;
