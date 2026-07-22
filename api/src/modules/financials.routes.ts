import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  clientCredits,
  expenses,
  paymentAllocations,
  payments,
  quotes,
  taxInvoices,
} from "../db/schema/billing.ts";
import { activityLog } from "../db/schema/audit.ts";
import { CAN_MANAGE_BILLING, assertOrgRole } from "../authz/policy.ts";
import { getOrgScope, requireAuth, requireOrg } from "../http/middleware.ts";
import { paginated, paginationSchema, validate, validateQuery } from "../http/validate.ts";
import { notFound } from "../http/errors.ts";

/**
 * Financials — invoices, payments, quotes, expenses.
 *
 * Every table here is org-scoped (org_id NOT NULL), so all endpoints require an
 * active org and filter on it via getOrgScope. Money is numeric(14,2) and moves
 * as strings end to end; arithmetic that must be exact happens in SQL.
 */
const router = new Hono();
router.use("*", requireAuth);
router.use("*", requireOrg);

const lineItemsSchema = z
  .array(
    z.object({
      description: z.string(),
      quantity: z.number().optional(),
      unit_price: z.number().optional(),
      amount: z.number().optional(),
    }),
  )
  .default([]);

// ---------------------------------------------------------------- invoices

const invoiceInput = z.object({
  clientId: z.string().uuid().nullable().optional(),
  clientName: z.string().min(1).max(300),
  caseId: z.string().uuid().nullable().optional(),
  issueDate: z.string().optional(),
  dueDate: z.string().nullable().optional(),
  currency: z.string().length(3).default("JOD"),
  taxRate: z.string().default("0"),
  subtotal: z.string().default("0"),
  taxAmount: z.string().default("0"),
  total: z.string().default("0"),
  notes: z.string().max(20_000).nullable().optional(),
  items: lineItemsSchema,
});

router.get("/invoices", async (c) => {
  const auth = getOrgScope(c);
  const { limit, cursor } = validateQuery(c, paginationSchema);

  const filters = [eq(taxInvoices.orgId, auth.orgId)];
  if (cursor) filters.push(lt(taxInvoices.createdAt, new Date(cursor)));
  const status = c.req.query("status");
  if (status) filters.push(eq(taxInvoices.status, status as never));
  const caseId = c.req.query("caseId");
  if (caseId) filters.push(eq(taxInvoices.caseId, caseId));
  const clientId = c.req.query("clientId");
  if (clientId) filters.push(eq(taxInvoices.clientId, clientId));

  const rows = await db
    .select()
    .from(taxInvoices)
    .where(and(...filters))
    .orderBy(desc(taxInvoices.createdAt))
    .limit(limit + 1);

  return c.json(paginated(rows, limit));
});

router.get("/invoices/:id", async (c) => {
  const auth = getOrgScope(c);
  const [row] = await db
    .select()
    .from(taxInvoices)
    .where(and(eq(taxInvoices.id, c.req.param("id")), eq(taxInvoices.orgId, auth.orgId)))
    .limit(1);
  if (!row) throw notFound("Invoice");

  // Include the payment allocations so the detail view can show what has been
  // applied against this invoice.
  const allocations = await db
    .select()
    .from(paymentAllocations)
    .where(
      and(
        eq(paymentAllocations.invoiceId, row.id),
        eq(paymentAllocations.orgId, auth.orgId),
      ),
    );

  return c.json({ ...row, allocations });
});

/**
 * Invoice numbers must be gapless and unique per org for tax audit. Generated
 * inside the insert transaction, from the org's prefix + a per-org counter, so
 * two concurrent creates cannot collide on a number.
 */
router.post("/invoices", async (c) => {
  const auth = getOrgScope(c);
  await assertOrgRole(auth, auth.orgId, CAN_MANAGE_BILLING, "invoice:create");
  const body = await validate(c, invoiceInput);

  const created = await db.transaction(async (tx) => {
    const [{ number } = { number: "INV-1" }] = await tx.execute<{ number: string }>(sql`
      SELECT
        o.invoice_prefix || '-' || (
          COALESCE(
            (SELECT max(NULLIF(regexp_replace(ti.number, '\\D', '', 'g'), '')::bigint)
             FROM tax_invoices ti WHERE ti.org_id = ${auth.orgId}),
            0
          ) + 1
        )::text AS number
      FROM organizations o WHERE o.id = ${auth.orgId}
    `);

    const [row] = await tx
      .insert(taxInvoices)
      .values({
        orgId: auth.orgId,
        number,
        clientId: body.clientId ?? null,
        clientName: body.clientName,
        caseId: body.caseId ?? null,
        ...(body.issueDate ? { issueDate: body.issueDate } : {}),
        dueDate: body.dueDate ?? null,
        currency: body.currency,
        taxRate: body.taxRate,
        subtotal: body.subtotal,
        taxAmount: body.taxAmount,
        total: body.total,
        notes: body.notes ?? null,
        items: body.items,
        createdBy: auth.userId,
      })
      .returning();

    if (!row) throw new Error("invoice insert returned no row");

    await tx.insert(activityLog).values({
      orgId: auth.orgId,
      actorId: auth.userId,
      entityType: "invoice",
      entityId: row.id,
      caseId: row.caseId,
      action: "created",
      summary: row.number,
    });

    return row;
  });

  return c.json(created, 201);
});

router.patch("/invoices/:id", async (c) => {
  const auth = getOrgScope(c);
  await assertOrgRole(auth, auth.orgId, CAN_MANAGE_BILLING, "invoice:update");
  const body = await validate(c, invoiceInput.partial().extend({
    status: z
      .enum([
        "draft", "issued", "partial", "paid", "overdue",
        "void", "sent", "viewed", "written_off",
      ])
      .optional(),
  }));

  const [updated] = await db
    .update(taxInvoices)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(taxInvoices.id, c.req.param("id")), eq(taxInvoices.orgId, auth.orgId)))
    .returning();

  if (!updated) throw notFound("Invoice");
  return c.json(updated);
});

// ---------------------------------------------------------------- payments

const paymentInput = z.object({
  clientId: z.string().uuid().nullable().optional(),
  clientName: z.string().min(1).max(300),
  invoiceId: z.string().uuid().nullable().optional(),
  amount: z.string(),
  currency: z.string().length(3).default("JOD"),
  method: z.enum(["cash", "bank_transfer", "card", "cheque", "other"]).default("bank_transfer"),
  reference: z.string().max(200).nullable().optional(),
  paidAt: z.string().optional(),
  notes: z.string().max(5_000).nullable().optional(),
});

router.get("/payments", async (c) => {
  const auth = getOrgScope(c);
  const { limit, cursor } = validateQuery(c, paginationSchema);

  const filters = [eq(payments.orgId, auth.orgId)];
  if (cursor) filters.push(lt(payments.createdAt, new Date(cursor)));
  const clientId = c.req.query("clientId");
  if (clientId) filters.push(eq(payments.clientId, clientId));
  const invoiceId = c.req.query("invoiceId");
  if (invoiceId) filters.push(eq(payments.invoiceId, invoiceId));

  const rows = await db
    .select()
    .from(payments)
    .where(and(...filters))
    .orderBy(desc(payments.createdAt))
    .limit(limit + 1);

  return c.json(paginated(rows, limit));
});

/**
 * Recording a payment optionally allocates it to an invoice, then recomputes
 * that invoice's amount_paid and status from the sum of its allocations. All
 * in one transaction — a payment that half-applied would corrupt the ledger.
 */
router.post("/payments", async (c) => {
  const auth = getOrgScope(c);
  await assertOrgRole(auth, auth.orgId, CAN_MANAGE_BILLING, "payment:create");
  const body = await validate(c, paymentInput);

  const created = await db.transaction(async (tx) => {
    const [payment] = await tx
      .insert(payments)
      .values({
        orgId: auth.orgId,
        clientId: body.clientId ?? null,
        clientName: body.clientName,
        invoiceId: body.invoiceId ?? null,
        amount: body.amount,
        currency: body.currency,
        method: body.method,
        reference: body.reference ?? null,
        ...(body.paidAt ? { paidAt: body.paidAt } : {}),
        notes: body.notes ?? null,
        createdBy: auth.userId,
      })
      .returning();

    if (!payment) throw new Error("payment insert returned no row");

    if (body.invoiceId) {
      await tx.insert(paymentAllocations).values({
        orgId: auth.orgId,
        paymentId: payment.id,
        kind: "invoice",
        invoiceId: body.invoiceId,
        amount: body.amount,
        currency: body.currency,
        createdBy: auth.userId,
      });

      await recomputeInvoice(tx, auth.orgId, body.invoiceId);
    }

    await tx.insert(activityLog).values({
      orgId: auth.orgId,
      actorId: auth.userId,
      entityType: "payment",
      entityId: payment.id,
      action: "recorded",
      summary: `${body.amount} ${body.currency}`,
    });

    return payment;
  });

  return c.json(created, 201);
});

/**
 * Recompute an invoice's amount_paid and status from its allocations — the
 * ledger's source of truth. Mirrors the old recompute_invoice_from_allocations
 * SQL function. amount_paid is never incremented directly; it is always
 * re-derived, so a reversed or edited allocation stays consistent.
 */
async function recomputeInvoice(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orgId: string,
  invoiceId: string,
) {
  await tx.execute(sql`
    WITH paid AS (
      SELECT COALESCE(sum(amount), 0) AS total_paid
      FROM payment_allocations
      WHERE invoice_id = ${invoiceId} AND org_id = ${orgId}
    )
    UPDATE tax_invoices ti
    SET amount_paid = paid.total_paid,
        status = CASE
          WHEN paid.total_paid >= ti.total AND ti.total > 0 THEN 'paid'
          WHEN paid.total_paid > 0 THEN 'partial'
          WHEN ti.due_date IS NOT NULL AND ti.due_date < CURRENT_DATE THEN 'overdue'
          ELSE ti.status
        END,
        updated_at = now()
    FROM paid
    WHERE ti.id = ${invoiceId} AND ti.org_id = ${orgId}
  `);
}

// ----------------------------------------------------------------- quotes

const quoteInput = z.object({
  clientId: z.string().uuid().nullable().optional(),
  clientName: z.string().min(1).max(300),
  caseId: z.string().uuid().nullable().optional(),
  validUntil: z.string().nullable().optional(),
  currency: z.string().length(3).default("JOD"),
  taxRate: z.string().default("0"),
  subtotal: z.string().default("0"),
  taxAmount: z.string().default("0"),
  total: z.string().default("0"),
  notes: z.string().max(20_000).nullable().optional(),
  items: lineItemsSchema,
});

router.get("/quotes", async (c) => {
  const auth = getOrgScope(c);
  const { limit, cursor } = validateQuery(c, paginationSchema);
  const filters = [eq(quotes.orgId, auth.orgId)];
  if (cursor) filters.push(lt(quotes.createdAt, new Date(cursor)));

  const rows = await db
    .select()
    .from(quotes)
    .where(and(...filters))
    .orderBy(desc(quotes.createdAt))
    .limit(limit + 1);
  return c.json(paginated(rows, limit));
});

router.post("/quotes", async (c) => {
  const auth = getOrgScope(c);
  await assertOrgRole(auth, auth.orgId, CAN_MANAGE_BILLING, "quote:create");
  const body = await validate(c, quoteInput);

  const created = await db.transaction(async (tx) => {
    const [{ number } = { number: "QUO-1" }] = await tx.execute<{ number: string }>(sql`
      SELECT o.quote_prefix || '-' || (
        COALESCE((SELECT max(NULLIF(regexp_replace(q.number, '\\D', '', 'g'), '')::bigint)
                  FROM quotes q WHERE q.org_id = ${auth.orgId}), 0) + 1
      )::text AS number
      FROM organizations o WHERE o.id = ${auth.orgId}
    `);

    const [row] = await tx
      .insert(quotes)
      .values({
        orgId: auth.orgId,
        number,
        clientId: body.clientId ?? null,
        clientName: body.clientName,
        caseId: body.caseId ?? null,
        validUntil: body.validUntil ?? null,
        currency: body.currency,
        taxRate: body.taxRate,
        subtotal: body.subtotal,
        taxAmount: body.taxAmount,
        total: body.total,
        notes: body.notes ?? null,
        items: body.items,
        createdBy: auth.userId,
      })
      .returning();
    return row;
  });

  return c.json(created, 201);
});

// --------------------------------------------------------------- expenses

const expenseInput = z.object({
  caseId: z.string().uuid().nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  kind: z.enum(["court_fee", "expert", "translation", "filing", "travel", "other"]).default("other"),
  description: z.string().max(2_000).nullable().optional(),
  amount: z.string(),
  currency: z.string().length(3).default("JOD"),
  incurredOn: z.string().optional(),
  billable: z.boolean().default(true),
});

router.get("/expenses", async (c) => {
  const auth = getOrgScope(c);
  const { limit, cursor } = validateQuery(c, paginationSchema);
  const filters = [eq(expenses.orgId, auth.orgId)];
  if (cursor) filters.push(lt(expenses.createdAt, new Date(cursor)));
  const caseId = c.req.query("caseId");
  if (caseId) filters.push(eq(expenses.caseId, caseId));

  const rows = await db
    .select()
    .from(expenses)
    .where(and(...filters))
    .orderBy(desc(expenses.createdAt))
    .limit(limit + 1);
  return c.json(paginated(rows, limit));
});

router.post("/expenses", async (c) => {
  const auth = getOrgScope(c);
  await assertOrgRole(auth, auth.orgId, CAN_MANAGE_BILLING, "expense:create");
  const body = await validate(c, expenseInput);

  const [row] = await db
    .insert(expenses)
    .values({
      orgId: auth.orgId,
      caseId: body.caseId ?? null,
      clientId: body.clientId ?? null,
      kind: body.kind,
      description: body.description ?? null,
      amount: body.amount,
      currency: body.currency,
      ...(body.incurredOn ? { incurredOn: body.incurredOn } : {}),
      billable: body.billable,
      createdBy: auth.userId,
    })
    .returning();

  return c.json(row, 201);
});

/** Client credits — surfaced read-only here; created via payment overpayment flows. */
router.get("/credits", async (c) => {
  const auth = getOrgScope(c);
  const clientId = c.req.query("clientId");
  const filters = [eq(clientCredits.orgId, auth.orgId)];
  if (clientId) filters.push(eq(clientCredits.clientId, clientId));

  const rows = await db
    .select()
    .from(clientCredits)
    .where(and(...filters))
    .orderBy(desc(clientCredits.createdAt))
    .limit(200);
  return c.json({ data: rows });
});

export default router;
