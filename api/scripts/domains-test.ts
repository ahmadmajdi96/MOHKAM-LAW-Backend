/**
 * Domain routes test — financials, time entries, calendar, notifications, and
 * the clients/cases additions (aggregates, clientId filters, interactions,
 * conflict check). Exercised against a running stack.
 *
 *   docker compose exec api bun scripts/domains-test.ts
 */
export {};

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : "");
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
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  const t = await r.text();
  let body: any = t;
  try {
    body = JSON.parse(t);
  } catch {}
  return { status: r.status, body };
}

async function newUserOrg() {
  const email = `dom-${crypto.randomUUID()}@example.test`;
  const reg = await call("/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
  });
  const token = reg.body.accessToken as string;
  const org = await call("/v1/orgs", {
    method: "POST",
    token,
    body: JSON.stringify({ legalName: "Domains Firm", type: "firm", currency: "JOD" }),
  });
  return { token, orgId: org.body.id as string, email };
}

console.log("\n── setup ───────────────────────────────────────────");
const { token, orgId } = await newUserOrg();
const client = await call("/v1/clients", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ name: "Al-Amal Trading", type: "company", phone: "+962790001122", nationalId: "9876543" }),
});
const clientId = client.body.id as string;
const legalCase = await call("/v1/cases", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ title: "Al-Amal collections", clientId }),
});
const caseId = legalCase.body.id as string;
check("seed client + case", !!clientId && !!caseId);

console.log("\n── clients: aggregates, filters, conflict ──────────");
const list = await call("/v1/clients?limit=10", { token, orgId });
const listed = (list.body.data ?? []).find((x: any) => x.id === clientId);
check("client list returns the client", !!listed, list.body);
check("list carries case aggregates", listed?.totalCases === 1 && listed?.activeCases === 1, {
  total: listed?.totalCases,
  active: listed?.activeCases,
});

const byClient = await call(`/v1/cases?clientId=${clientId}`, { token, orgId });
check("cases?clientId= returns the client's case", (byClient.body.data ?? []).some((x: any) => x.id === caseId), byClient.body);

const unassignedCase = await call("/v1/cases", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ title: "Unlinked matter" }),
});
const unassigned = await call("/v1/cases?clientId=null", { token, orgId });
check(
  "cases?clientId=null returns unassigned only",
  (unassigned.body.data ?? []).some((x: any) => x.id === unassignedCase.body.id) &&
    !(unassigned.body.data ?? []).some((x: any) => x.id === caseId),
  unassigned.body,
);

const conflict = await call("/v1/clients/conflict-check", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ name: "Al-Amal", nationalId: "9876543" }),
});
check("conflict check finds the name match", (conflict.body.nameMatches ?? []).some((x: any) => x.id === clientId), conflict.body);
check("conflict check finds the identity match", (conflict.body.identityMatches ?? []).some((x: any) => x.id === clientId), conflict.body);

console.log("\n── interactions: create, update, delete ────────────");
const intr = await call(`/v1/clients/${clientId}/interactions`, {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ kind: "call", title: "Intro call", body: "Discussed retainer" }),
});
const interactionId = intr.body.id as string;
check("create interaction", intr.status === 201 && !!interactionId);

const updIntr = await call(`/v1/clients/interactions/${interactionId}`, {
  method: "PATCH",
  token,
  orgId,
  body: JSON.stringify({ title: "Intro call (updated)" }),
});
check("update interaction", updIntr.status === 200 && updIntr.body.title === "Intro call (updated)", updIntr.body);

const delIntr = await call(`/v1/clients/interactions/${interactionId}`, { method: "DELETE", token, orgId });
check("delete interaction returns 204", delIntr.status === 204);

console.log("\n── financials: invoice → payment → recompute ───────");
const inv = await call("/v1/financials/invoices", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ clientName: "Al-Amal Trading", clientId, caseId, total: "1000.00", subtotal: "1000.00" }),
});
check("create invoice returns 201", inv.status === 201, inv.body);
check("invoice number generated from org prefix", typeof inv.body.number === "string" && inv.body.number.startsWith("INV-"), inv.body.number);
const invoiceId = inv.body.id as string;

const inv2 = await call("/v1/financials/invoices", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ clientName: "Al-Amal Trading", total: "500.00", subtotal: "500.00" }),
});
check("second invoice number increments", inv2.body.number !== inv.body.number, { a: inv.body.number, b: inv2.body.number });

// Partial payment → status becomes 'partial', amount_paid tracks.
const pay1 = await call("/v1/financials/payments", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ clientName: "Al-Amal Trading", clientId, invoiceId, amount: "400.00" }),
});
check("record partial payment", pay1.status === 201, pay1.body);

const afterPartial = await call(`/v1/financials/invoices/${invoiceId}`, { token, orgId });
check("invoice recomputed to partial", afterPartial.body.status === "partial", afterPartial.body.status);
check("amount_paid tracks allocations", Number(afterPartial.body.amountPaid) === 400, afterPartial.body.amountPaid);
check("allocation recorded on invoice", (afterPartial.body.allocations ?? []).length === 1, afterPartial.body.allocations);

// Paying the balance → status becomes 'paid'.
const pay2 = await call("/v1/financials/payments", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ clientName: "Al-Amal Trading", clientId, invoiceId, amount: "600.00" }),
});
check("record balance payment", pay2.status === 201);
const afterFull = await call(`/v1/financials/invoices/${invoiceId}`, { token, orgId });
check("invoice recomputed to paid", afterFull.body.status === "paid", afterFull.body.status);
check("amount_paid reaches total", Number(afterFull.body.amountPaid) === 1000, afterFull.body.amountPaid);

const invByClient = await call(`/v1/financials/invoices?clientId=${clientId}`, { token, orgId });
check("invoices filter by client", (invByClient.body.data ?? []).some((x: any) => x.id === invoiceId), invByClient.body);

console.log("\n── financials: role gating ─────────────────────────");
const { token: outsiderToken } = await newUserOrg();
const noOrgInvoice = await call("/v1/financials/invoices", {
  method: "POST",
  token: outsiderToken, // authenticated, but no X-Org-Id header
  body: JSON.stringify({ clientName: "X", total: "1" }),
});
check("invoice without an org is rejected", noOrgInvoice.status === 400, noOrgInvoice.body);

const foreignInvoice = await call(`/v1/financials/invoices/${invoiceId}`, {
  token: outsiderToken,
  orgId, // an org they are not a member of
});
check("reading another org's invoice is forbidden", foreignInvoice.status === 403, foreignInvoice.body);

console.log("\n── time entries: start/stop timer ──────────────────");
const started = await call("/v1/time-entries/start", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ caseId, description: "Drafting" }),
});
check("start timer returns 201 running", started.status === 201 && started.body.isRunning === true, started.body);

const doubleStart = await call("/v1/time-entries/start", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ caseId, description: "Second" }),
});
check("second concurrent timer rejected with 409", doubleStart.status === 409, doubleStart.body);

const running = await call("/v1/time-entries/running", { token, orgId });
check("running timer is reported", running.body.running?.id === started.body.id, running.body);

await new Promise((r) => setTimeout(r, 1100));
const stopped = await call(`/v1/time-entries/${started.body.id}/stop`, { method: "POST", token, orgId });
check("stop timer computes duration", stopped.status === 200 && stopped.body.durationSeconds >= 1, stopped.body);
check("after stop, no timer runs", (await call("/v1/time-entries/running", { token, orgId })).body.running === null);

console.log("\n── calendar: appointments + deadlines ──────────────");
const appt = await call("/v1/calendar/appointments", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({
    title: "Client meeting",
    caseId,
    startsAt: "2026-08-01T09:00:00Z",
    endsAt: "2026-08-01T10:00:00Z",
  }),
});
check("create appointment", appt.status === 201, appt.body);

const apptList = await call("/v1/calendar/appointments?from=2026-07-01T00:00:00Z&to=2026-09-01T00:00:00Z", { token, orgId });
check("appointments list by date window", (apptList.body.data ?? []).some((x: any) => x.id === appt.body.id), apptList.body);

const dl = await call("/v1/calendar/deadlines", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ title: "File appeal", caseId, dueAt: "2026-08-15T00:00:00Z" }),
});
check("create deadline", dl.status === 201, dl.body);

const dlDone = await call(`/v1/calendar/deadlines/${dl.body.id}/complete`, { method: "POST", token, orgId });
check("complete deadline records completion", dlDone.body.status === "done" && !!dlDone.body.completedAt, dlDone.body);

console.log("\n── notifications ───────────────────────────────────");
const notifs = await call("/v1/notifications?limit=5", { token, orgId });
check("notifications list is a page envelope", Array.isArray(notifs.body.data) && "nextCursor" in notifs.body, notifs.body);
const count = await call("/v1/notifications/unread-count", { token, orgId });
check("unread-count returns a number", typeof count.body.count === "number", count.body);

console.log(`\n════════════════════════════════════════════════════`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`════════════════════════════════════════════════════\n`);
process.exit(failed === 0 ? 0 : 1);
