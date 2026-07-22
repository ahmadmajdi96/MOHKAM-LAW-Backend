import { maintenanceQueue } from "../queue/queues.ts";
import { logger } from "../observability/logger.ts";

/**
 * Recurring jobs, replacing the Supabase scheduled functions and the
 * /api/public/hooks/debt-reminders cron endpoint.
 *
 * Repeatable jobs are keyed by name, so every worker replica registering the
 * same schedule on boot converges on one entry rather than N duplicates.
 * Times are Asia/Amman — the operating timezone for the firms using this.
 */
const SCHEDULES = [
  {
    name: "debt-reminders",
    // 09:00 daily, safely after the 09:00 quiet-hours boundary.
    pattern: "0 9 * * *",
    data: { task: "debt-reminders" as const },
  },
  {
    name: "deadline-reminders",
    pattern: "0 7 * * *",
    data: { task: "deadline-reminders" as const },
  },
  {
    name: "mark-invoices-overdue",
    pattern: "30 0 * * *",
    data: { task: "mark-invoices-overdue" as const },
  },
  {
    name: "payment-schedule-sweep",
    pattern: "0 8 * * *",
    data: { task: "payment-schedule-sweep" as const },
  },
  {
    name: "recur-debt-cases",
    pattern: "15 1 * * *",
    data: { task: "recur-debt-cases" as const },
  },
  {
    name: "prune-sessions",
    pattern: "0 3 * * *",
    data: { task: "prune-sessions" as const },
  },
];

export async function registerSchedules() {
  for (const schedule of SCHEDULES) {
    await maintenanceQueue.add(schedule.name, schedule.data, {
      repeat: { pattern: schedule.pattern, tz: "Asia/Amman" },
      jobId: schedule.name,
    });
  }

  logger.info(
    { schedules: SCHEDULES.map((s) => s.name) },
    "recurring jobs registered",
  );
}
