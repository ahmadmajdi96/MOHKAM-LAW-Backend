/**
 * End-to-end smoke test. Exercises the real HTTP surface against a running
 * stack — registration, token refresh with rotation, tenancy, and CRUD.
 *
 *   docker compose exec api bun scripts/smoke-test.ts
 *
 * Exits non-zero on the first failure, so it works as a deploy gate.
 */
export {};

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

async function call(
  path: string,
  init: RequestInit & { token?: string; orgId?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.orgId) headers.set("x-org-id", init.orgId);

  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON response body */
  }
  return { status: response.status, body: body as Record<string, unknown> };
}

console.log("\n── health ──────────────────────────────────────────");
const health = await call("/healthz");
check("GET /healthz returns 200", health.status === 200, health.body);

const ready = await call("/readyz");
check("GET /readyz reports ready", ready.status === 200, ready.body);
check(
  "all dependency checks pass",
  JSON.stringify((ready.body as { checks?: unknown }).checks) ===
    JSON.stringify({ database: true, redis: true, storage: true }),
  (ready.body as { checks?: unknown }).checks,
);

const metrics = await call("/metrics");
check("GET /metrics exposes Prometheus data", metrics.status === 200);

console.log("\n── auth ────────────────────────────────────────────");
const email = `smoke-${crypto.randomUUID()}@example.test`;
const password = "correct-horse-battery-staple";

const registered = await call("/v1/auth/register", {
  method: "POST",
  body: JSON.stringify({ email, password, fullName: "Smoke Test" }),
});
check("register returns 201", registered.status === 201, registered.body);
check("register issues an access token", typeof registered.body.accessToken === "string");

const weak = await call("/v1/auth/register", {
  method: "POST",
  body: JSON.stringify({ email: `w-${crypto.randomUUID()}@example.test`, password: "short" }),
});
check("short password rejected with 422", weak.status === 422, weak.body);

const duplicate = await call("/v1/auth/register", {
  method: "POST",
  body: JSON.stringify({ email, password }),
});
check("duplicate email rejected with 409", duplicate.status === 409, duplicate.body);

const loggedIn = await call("/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ email, password }),
});
check("login returns 200", loggedIn.status === 200, loggedIn.body);

const badLogin = await call("/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ email, password: "wrong-password-entirely" }),
});
check("wrong password rejected with 401", badLogin.status === 401);

let token = loggedIn.body.accessToken as string;
const refreshToken = loggedIn.body.refreshToken as string;

const me = await call("/v1/auth/me", { token });
check("GET /me returns the caller", (me.body as { user?: { email?: string } }).user?.email === email, me.body);

const noToken = await call("/v1/auth/me");
check("GET /me without a token returns 401", noToken.status === 401);

const badToken = await call("/v1/auth/me", { token: "not-a-real-token" });
check("GET /me with a bogus token returns 401", badToken.status === 401);

console.log("\n── refresh rotation ────────────────────────────────");
const refreshed = await call("/v1/auth/refresh", {
  method: "POST",
  body: JSON.stringify({ refreshToken }),
});
check("refresh returns a new token pair", refreshed.status === 200, refreshed.body);
check(
  "refresh token was rotated",
  refreshed.body.refreshToken !== refreshToken,
);

// The security property that matters: replaying a consumed refresh token must
// fail, and must revoke the whole family.
const replayed = await call("/v1/auth/refresh", {
  method: "POST",
  body: JSON.stringify({ refreshToken }),
});
check("replaying a used refresh token returns 401", replayed.status === 401);

const afterReuse = await call("/v1/auth/refresh", {
  method: "POST",
  body: JSON.stringify({ refreshToken: refreshed.body.refreshToken }),
});
check(
  "reuse detection revoked the whole family",
  afterReuse.status === 401,
  afterReuse.body,
);

token = (await call("/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ email, password }),
})).body.accessToken as string;

console.log("\n── clients ─────────────────────────────────────────");
const createdClient = await call("/v1/clients", {
  method: "POST",
  token,
  body: JSON.stringify({ name: "شركة الأمل للتجارة", type: "company", phone: "+962790000000" }),
});
check("create client returns 201", createdClient.status === 201, createdClient.body);
check(
  "Arabic client name round-trips intact",
  createdClient.body.name === "شركة الأمل للتجارة",
  createdClient.body.name,
);

const clientId = createdClient.body.id as string;

const listedClients = await call("/v1/clients?limit=10", { token });
check("list clients returns 200", listedClients.status === 200);
check(
  "list is a paginated envelope",
  Array.isArray((listedClients.body as { data?: unknown }).data) &&
    "nextCursor" in listedClients.body,
  listedClients.body,
);

const searched = await call("/v1/clients?q=%D8%A7%D9%84%D8%A3%D9%85%D9%84", { token });
check(
  "Arabic substring search finds the client",
  ((searched.body as { data?: unknown[] }).data ?? []).length >= 1,
  searched.body,
);

console.log("\n── cases ───────────────────────────────────────────");
const createdCase = await call("/v1/cases", {
  method: "POST",
  token,
  body: JSON.stringify({ title: "Labour dispute — Al-Amal", clientId, court: "Amman First Instance" }),
});
check("create case returns 201", createdCase.status === 201, createdCase.body);
const caseId = createdCase.body.id as string;

const fetchedCase = await call(`/v1/cases/${caseId}`, { token });
check("fetch case returns 200", fetchedCase.status === 200);
check("case includes its member list", Array.isArray(fetchedCase.body.members));

const closed = await call(`/v1/cases/${caseId}/close`, {
  method: "POST",
  token,
  body: JSON.stringify({ result: "settled", note: "Settled out of court" }),
});
check("close case returns 200", closed.status === 200, closed.body);
check("case status is closed", closed.body.status === "closed");
check("close result recorded", closed.body.closeResult === "settled");

console.log("\n── tenant isolation ────────────────────────────────");
// A second, unrelated user must not be able to see the first user's data.
const otherEmail = `smoke-${crypto.randomUUID()}@example.test`;
const other = await call("/v1/auth/register", {
  method: "POST",
  body: JSON.stringify({ email: otherEmail, password }),
});
const otherToken = other.body.accessToken as string;

const leakedCase = await call(`/v1/cases/${caseId}`, { token: otherToken });
check(
  "another user gets 404 for a case they cannot see",
  leakedCase.status === 404,
  leakedCase.body,
);

const leakedClient = await call(`/v1/clients/${clientId}`, { token: otherToken });
check(
  "another user gets 404 for a client they cannot see",
  leakedClient.status === 404,
  leakedClient.body,
);

const otherList = await call("/v1/clients", { token: otherToken });
check(
  "another user's client list is empty",
  ((otherList.body as { data?: unknown[] }).data ?? []).length === 0,
  otherList.body,
);

const forgedOrg = await call("/v1/clients", {
  token: otherToken,
  orgId: crypto.randomUUID(),
});
check(
  "a forged X-Org-Id is rejected with 403",
  forgedOrg.status === 403,
  forgedOrg.body,
);

console.log("\n── organizations ───────────────────────────────────");
const org = await call("/v1/orgs", {
  method: "POST",
  token,
  body: JSON.stringify({ legalName: "مكتب الأمل للمحاماة", type: "firm", currency: "JOD" }),
});
check("create org returns 201", org.status === 201, org.body);
check("creator is seeded as owner", org.body.role === "owner", org.body);
const orgId = org.body.id as string;

const myOrgs = await call("/v1/orgs", { token });
check(
  "new org appears in the caller's list",
  ((myOrgs.body as { data?: { id?: string }[] }).data ?? []).some((o) => o.id === orgId),
  myOrgs.body,
);

const orgAsNonMember = await call(`/v1/orgs/${orgId}`, { token: otherToken });
check("non-member gets 404 for the org", orgAsNonMember.status === 404, orgAsNonMember.body);

const renamed = await call(`/v1/orgs/${orgId}`, {
  method: "PATCH",
  token,
  orgId,
  body: JSON.stringify({ displayName: "Al-Amal Law" }),
});
check("owner can update org settings", renamed.status === 200, renamed.body);

console.log("\n── membership & roles ──────────────────────────────");
const invited = await call(`/v1/orgs/${orgId}/members`, {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ email: otherEmail, role: "associate" }),
});
check("invite existing user returns 201", invited.status === 201, invited.body);
check("existing account joins as active", invited.body.status === "active", invited.body);
const memberId = invited.body.id as string;

const dupInvite = await call(`/v1/orgs/${orgId}/members`, {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ email: otherEmail, role: "associate" }),
});
check("duplicate invite rejected with 409", dupInvite.status === 409, dupInvite.body);

const pending = await call(`/v1/orgs/${orgId}/members`, {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ email: `pending-${crypto.randomUUID()}@example.test`, role: "paralegal" }),
});
check("inviting an unregistered email returns 201", pending.status === 201);
check("unregistered invitee is left pending", pending.body.status === "invited", pending.body);

// Membership is re-read per request, so the invite must be usable immediately.
const memberView = await call(`/v1/orgs/${orgId}`, { token: otherToken, orgId });
check("invited member can now read the org", memberView.status === 200, memberView.body);
check("member sees their own role", memberView.body.role === "associate", memberView.body);

const deniedPatch = await call(`/v1/orgs/${orgId}`, {
  method: "PATCH",
  token: otherToken,
  orgId,
  body: JSON.stringify({ displayName: "Hijacked" }),
});
check("associate cannot update org settings", deniedPatch.status === 403, deniedPatch.body);

const deniedInvite = await call(`/v1/orgs/${orgId}/members`, {
  method: "POST",
  token: otherToken,
  orgId,
  body: JSON.stringify({ email: `x-${crypto.randomUUID()}@example.test`, role: "associate" }),
});
check("associate cannot invite members", deniedInvite.status === 403, deniedInvite.body);

// This is the invalidateMembership() contract: a role change must apply now,
// not after the 30s membership cache expires.
const promoted = await call(`/v1/orgs/${orgId}/members/${memberId}`, {
  method: "PATCH",
  token,
  orgId,
  body: JSON.stringify({ role: "partner" }),
});
check("owner can promote a member", promoted.status === 200, promoted.body);

const nowAllowed = await call(`/v1/orgs/${orgId}`, {
  method: "PATCH",
  token: otherToken,
  orgId,
  body: JSON.stringify({ displayName: "Al-Amal Law Firm" }),
});
check(
  "promotion takes effect immediately (cache invalidated)",
  nowAllowed.status === 200,
  nowAllowed.body,
);

console.log("\n── org guardrails ──────────────────────────────────");
const owners = await call(`/v1/orgs/${orgId}/members`, { token, orgId });
const ownerMember = ((owners.body as { data?: { id?: string; role?: string }[] }).data ?? [])
  .find((m) => m.role === "owner");

const demoteLastOwner = await call(`/v1/orgs/${orgId}/members/${ownerMember?.id}`, {
  method: "PATCH",
  token,
  orgId,
  body: JSON.stringify({ role: "associate" }),
});
check(
  "demoting the last owner is rejected with 409",
  demoteLastOwner.status === 409,
  demoteLastOwner.body,
);

const removeLastOwner = await call(`/v1/orgs/${orgId}/members/${ownerMember?.id}`, {
  method: "DELETE",
  token,
  orgId,
});
check(
  "removing the last owner is rejected with 409",
  removeLastOwner.status === 409,
  removeLastOwner.body,
);

console.log("\n── org-scoped case sharing ─────────────────────────");
const orgCase = await call("/v1/cases", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ title: "Org-scoped matter" }),
});
check("create org-scoped case returns 201", orgCase.status === 201, orgCase.body);
check("case carries the org id", orgCase.body.orgId === orgId, orgCase.body);

const colleagueView = await call(`/v1/cases/${orgCase.body.id}`, {
  token: otherToken,
  orgId,
});
check(
  "a colleague in the same org can read the case",
  colleagueView.status === 200,
  colleagueView.body,
);

// Removal must revoke access immediately, for the same cache reason.
await call(`/v1/orgs/${orgId}/members/${memberId}`, { method: "DELETE", token, orgId });
const afterRemoval = await call(`/v1/cases/${orgCase.body.id}`, { token: otherToken });
check(
  "removed member immediately loses access to org cases",
  afterRemoval.status === 404,
  afterRemoval.body,
);

console.log("\n── validation & errors ─────────────────────────────");
const invalid = await call("/v1/cases", {
  method: "POST",
  token,
  body: JSON.stringify({ title: "" }),
});
check("empty title rejected with 422", invalid.status === 422, invalid.body);
check(
  "validation errors list offending fields",
  Array.isArray(((invalid.body.error as { details?: { issues?: unknown[] } })?.details)?.issues),
  invalid.body,
);

const missing = await call("/v1/cases/00000000-0000-0000-0000-000000000000", { token });
check("unknown case returns 404", missing.status === 404);

const noRoute = await call("/v1/nonexistent", { token });
check("unknown route returns 404", noRoute.status === 404);

console.log(`\n════════════════════════════════════════════════════`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`════════════════════════════════════════════════════\n`);

process.exit(failed === 0 ? 0 : 1);
