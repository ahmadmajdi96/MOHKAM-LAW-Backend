import type { Job } from "bullmq";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { taxInvoices, paymentSchedules } from "../../db/schema/billing.ts";
import { deadlines } from "../../db/schema/cases.ts";
import { debtCasePayers, debtCases, debtReminderRules } from "../../db/schema/debt.ts";
import { notifications } from "../../db/schema/comms.ts";
import { pruneExpiredSessions } from "../../auth/service.ts";
import { enqueueSms } from "../../queue/queues.ts";
import { logger } from "../../observability/logger.ts";

/**
 * Scheduled maintenance, replacing the Supabase cron functions and the
 * /api/public/hooks/debt-reminders endpoint that previously had to be poked
 * by an external scheduler.
 *
 * Every task here must be idempotent — a repeatable job can fire twice after
 * a worker restart, and sending a client two identical reminders is a real
 * consequence, not a cosmetic one.
 */
export async function processMaintenance(job: Job) {
  const task = (job.data as { task: string }).task;

  switch (task) {
    case "mark-invoices-overdue":
      return markInvoicesOverdue();
    case "debt-reminders":
      return sendDebtReminders();
    case "deadline-reminders":
      return sendDeadlineReminders();
    case "payment-schedule-sweep":
      return sweepPaymentSchedules();
    case "recur-debt-cases":
      return recurDebtCases();
    case "prune-sessions": {
      const removed = await pruneExpiredSessions();
      logger.info({ removed }, "pruned expired sessions");
      return { removed };
    }
    default:
      throw new Error(`unknown maintenance task: ${task}`);
  }
}

/** Mirrors the old mark_invoices_overdue() SQL function. */
async function markInvoicesOverdue() {
  const result = await db
    .update(taxInvoices)
    .set({ status: "overdue", updatedAt: new Date() })
    .where(
      and(
        sql`${taxInvoices.status} IN ('issued', 'sent', 'viewed', 'partial')`,
        sql`${taxInvoices.dueDate} < CURRENT_DATE`,
        sql`${taxInvoices.amountPaid} < ${taxInvoices.total}`,
      ),
    );

  logger.info({ updated: result.count }, "marked invoices overdue");
  return { updated: result.count };
}

/**
 * Debt reminders: for each active rule, find payers whose due date matches the
 * rule's offset and who have not already been reminded today.
 */
async function sendDebtReminders() {
  const rows = await db
    .select({
      payerId: debtCasePayers.id,
      payerName: debtCasePayers.name,
      phone: debtCasePayers.phone,
      amountDue: debtCasePayers.amountDue,
      amountPaid: debtCasePayers.amountPaid,
      dueDate: debtCasePayers.dueDate,
      caseId: debtCases.id,
      caseTitle: debtCases.title,
      currency: debtCases.currency,
      orgId: debtCases.orgId,
      ruleKind: debtReminderRules.kind,
      template: debtReminderRules.messageTemplate,
    })
    .from(debtCasePayers)
    .innerJoin(debtCases, eq(debtCases.id, debtCasePayers.caseId))
    .innerJoin(
      debtReminderRules,
      and(
        eq(debtReminderRules.caseId, debtCases.id),
        eq(debtReminderRules.active, true),
      ),
    )
    .where(
      and(
        sql`${debtCasePayers.status} IN ('pending', 'partial', 'overdue')`,
        // The rule fires when today is due_date + offset_days.
        sql`${debtCasePayers.dueDate} + (${debtReminderRules.offsetDays} || ' days')::interval = CURRENT_DATE`,
        sql`${debtCasePayers.phone} IS NOT NULL`,
        isNull(debtCasePayers.optedOutAt),
        // Idempotency guard: never twice in one day, even if the job reruns.
        sql`(${debtCasePayers.lastReminderSentAt} IS NULL
             OR ${debtCasePayers.lastReminderSentAt} < date_trunc('day', now()))`,
      ),
    );

  let queued = 0;
  for (const row of rows) {
    if (!row.phone) continue;

    const outstanding =
      Number(row.amountDue ?? 0) - Number(row.amountPaid ?? 0);
    if (outstanding <= 0) continue;

    const body = row.template
      .replaceAll("{{name}}", row.payerName)
      .replaceAll("{{amount}}", outstanding.toFixed(2))
      .replaceAll("{{currency}}", row.currency)
      .replaceAll("{{due_date}}", row.dueDate ?? "")
      .replaceAll("{{case}}", row.caseTitle);

    await enqueueSms({
      orgId: row.orgId,
      to: row.phone,
      body,
      kind: row.ruleKind,
      debtCaseId: row.caseId,
      payerId: row.payerId,
    });

    // Stamped at enqueue, not at send: the SMS processor may legitimately
    // defer for quiet hours, and that must not re-trigger tomorrow's sweep.
    await db
      .update(debtCasePayers)
      .set({ lastReminderSentAt: new Date(), updatedAt: new Date() })
      .where(eq(debtCasePayers.id, row.payerId));

    queued++;
  }

  logger.info({ queued, candidates: rows.length }, "debt reminders queued");
  return { queued };
}

/** In-app notifications for deadlines entering their reminder window. */
async function sendDeadlineReminders() {
  const rows = await db
    .select()
    .from(deadlines)
    .where(
      and(
        eq(deadlines.status, "open"),
        sql`EXISTS (
          SELECT 1 FROM unnest(${deadlines.reminderDays}) AS d
          WHERE date_trunc('day', ${deadlines.dueAt}) - (d || ' days')::interval
                = date_trunc('day', now())
        )`,
      ),
    );

  for (const row of rows) {
    await db.insert(notifications).values({
      orgId: row.orgId,
      userId: row.assignedTo ?? row.ownerId,
      kind: "deadline.reminder",
      title: row.title,
      body: `Due ${row.dueAt.toISOString().slice(0, 10)}`,
      link: row.caseId ? `/app/cases/${row.caseId}` : "/app/deadlines",
      entityType: "deadline",
      entityId: row.id,
    });
  }

  logger.info({ notified: rows.length }, "deadline reminders sent");
  return { notified: rows.length };
}

/** Advances upcoming instalments to due/overdue. */
async function sweepPaymentSchedules() {
  const due = await db
    .update(paymentSchedules)
    .set({ status: "due", updatedAt: new Date() })
    .where(
      and(
        eq(paymentSchedules.status, "upcoming"),
        lte(paymentSchedules.dueDate, sql`CURRENT_DATE`),
      ),
    );

  const overdue = await db
    .update(paymentSchedules)
    .set({ status: "overdue", updatedAt: new Date() })
    .where(
      and(
        eq(paymentSchedules.status, "due"),
        sql`${paymentSchedules.dueDate} < CURRENT_DATE - interval '1 day'`,
      ),
    );

  return { due: due.count, overdue: overdue.count };
}

/** Spawns the next occurrence of recurring debt cases (rent, instalments). */
async function recurDebtCases() {
  const rows = await db
    .select()
    .from(debtCases)
    .where(
      and(
        sql`${debtCases.recurrence} IS DISTINCT FROM 'none'`,
        lte(debtCases.nextRecurAt, sql`CURRENT_DATE`),
        eq(debtCases.status, "active"),
      ),
    );

  let created = 0;
  for (const row of rows) {
    const interval = row.recurrenceInterval ?? 1;
    const unit = row.recurrence === "weekly" ? "weeks" : row.recurrence === "yearly" ? "years" : "months";

    await db.transaction(async (tx) => {
      await tx.insert(debtCases).values({
        orgId: row.orgId,
        clientId: row.clientId,
        title: row.title,
        description: row.description,
        debtType: row.debtType,
        totalAmount: row.totalAmount,
        currency: row.currency,
        serviceFeeType: row.serviceFeeType,
        serviceFeeValue: row.serviceFeeValue,
        dueDate: row.nextRecurAt,
        forwarderName: row.forwarderName,
        forwarderContact: row.forwarderContact,
        reference: row.reference,
        recurrence: "none",
        parentDebtCaseId: row.id,
        createdBy: row.createdBy,
      });

      await tx
        .update(debtCases)
        .set({
          nextRecurAt: sql`${row.nextRecurAt}::date + (${interval} || ' ${unit}')::interval`,
          updatedAt: new Date(),
        })
        .where(eq(debtCases.id, row.id));
    });

    created++;
  }

  logger.info({ created }, "recurring debt cases spawned");
  return { created };
}
