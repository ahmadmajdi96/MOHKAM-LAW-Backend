import type { Job } from "bullmq";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { smsMessages, smsOptOuts } from "../../db/schema/comms.ts";
import { organizations } from "../../db/schema/org.ts";
import { env, features } from "../../env.ts";
import { logger } from "../../observability/logger.ts";
import { smsSentTotal } from "../../observability/metrics.ts";
import type { SmsJob } from "../../queue/queues.ts";

/**
 * Outbound SMS with compliance gates applied before anything reaches Twilio.
 *
 * Order matters: suppression, then quiet hours, then the per-recipient daily
 * cap. Every block is recorded in sms_messages with a blocked_reason, so the
 * audit trail shows what was suppressed and why — not just what was sent.
 */

const GSM7 =
  /^[A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\r\n]*$/;

/** Arabic forces UCS-2, which caps a segment at 70 chars instead of 160. */
export function computeSegments(body: string): {
  encoding: "GSM-7" | "UCS-2";
  segments: number;
} {
  const isGsm7 = GSM7.test(body);
  const encoding = isGsm7 ? "GSM-7" : "UCS-2";
  const single = isGsm7 ? 160 : 70;
  const concatenated = isGsm7 ? 153 : 67;

  const segments =
    body.length <= single ? 1 : Math.ceil(body.length / concatenated);

  return { encoding, segments };
}

/** Minutes since midnight, in the org's timezone. */
function minutesInZone(timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function toMinutes(time: string): number {
  const [h = "0", m = "0"] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Quiet hours normally wrap midnight (21:00 → 09:00), so the comparison is
 * inverted for a wrapping window.
 */
export function isWithinQuietHours(
  nowMinutes: number,
  startTime: string,
  endTime: string,
): boolean {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  return start > end
    ? nowMinutes >= start || nowMinutes < end
    : nowMinutes >= start && nowMinutes < end;
}

async function record(payload: SmsJob, fields: Record<string, unknown>) {
  await db.insert(smsMessages).values({
    orgId: payload.orgId,
    ownerId: payload.ownerId ?? null,
    clientId: payload.clientId ?? null,
    caseId: payload.caseId ?? null,
    debtCaseId: payload.debtCaseId ?? null,
    templateId: payload.templateId ?? null,
    context: payload.kind,
    toNumber: payload.to,
    fromNumber: env.TWILIO_MESSAGING_SERVICE_SID || "messaging-service",
    body: payload.body,
    language: payload.language ?? null,
    ...fields,
  });
}

export async function processSms(job: Job) {
  const payload = job.data as SmsJob;

  if (!features.sms) {
    logger.warn({ to: payload.to }, "sms not configured — dropping");
    smsSentTotal.inc({ status: "blocked", reason: "unconfigured" });
    await record(payload, { status: "blocked", blockedReason: "unconfigured" });
    return { sent: false, reason: "unconfigured" };
  }

  const [org] = await db
    .select({
      smsQuietHoursStart: organizations.smsQuietHoursStart,
      smsQuietHoursEnd: organizations.smsQuietHoursEnd,
      smsTimezone: organizations.smsTimezone,
      smsDailyCapPerRecipient: organizations.smsDailyCapPerRecipient,
      smsSenderId: organizations.smsSenderId,
    })
    .from(organizations)
    .where(eq(organizations.id, payload.orgId))
    .limit(1);

  if (!org) throw new Error(`unknown org ${payload.orgId}`);

  // 1. Suppression list — an absolute block.
  const [optOut] = await db
    .select({ id: smsOptOuts.id })
    .from(smsOptOuts)
    .where(
      and(eq(smsOptOuts.orgId, payload.orgId), eq(smsOptOuts.phone, payload.to)),
    )
    .limit(1);

  if (optOut) {
    smsSentTotal.inc({ status: "blocked", reason: "opted_out" });
    await record(payload, { status: "blocked", blockedReason: "opted_out" });
    return { sent: false, reason: "opted_out" };
  }

  // 2. Quiet hours. Reschedule rather than drop — the message is still wanted,
  // just not at 02:00.
  if (
    isWithinQuietHours(
      minutesInZone(org.smsTimezone),
      org.smsQuietHoursStart,
      org.smsQuietHoursEnd,
    )
  ) {
    const retryInMs = 30 * 60 * 1000;
    logger.info({ to: payload.to }, "within quiet hours — deferring");
    await job.moveToDelayed(Date.now() + retryInMs, job.token);
    return { sent: false, reason: "quiet_hours_deferred" };
  }

  // 3. Per-recipient daily cap.
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(smsMessages)
    .where(
      and(
        eq(smsMessages.toNumber, payload.to),
        eq(smsMessages.orgId, payload.orgId),
        eq(smsMessages.status, "sent"),
        gte(smsMessages.sentAt, sql`date_trunc('day', now())`),
      ),
    );

  if (count >= org.smsDailyCapPerRecipient) {
    smsSentTotal.inc({ status: "blocked", reason: "daily_cap" });
    await record(payload, { status: "blocked", blockedReason: "daily_cap" });
    return { sent: false, reason: "daily_cap" };
  }

  const { encoding, segments } = computeSegments(payload.body);

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        authorization: `Basic ${Buffer.from(
          `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`,
        ).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: payload.to,
        Body: payload.body,
        MessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
      }),
    },
  );

  const result = (await response.json()) as {
    sid?: string;
    code?: number;
    message?: string;
  };

  if (!response.ok) {
    smsSentTotal.inc({ status: "failed", reason: String(result.code ?? "unknown") });
    await record(payload, {
      status: "failed",
      errorCode: String(result.code ?? ""),
      errorMessage: result.message ?? "",
      encoding,
      segmentCount: segments,
    });
    // 4xx from Twilio (bad number, blocked region) will not succeed on retry.
    if (response.status >= 400 && response.status < 500) {
      return { sent: false, reason: "rejected", code: result.code };
    }
    throw new Error(`twilio error ${response.status}: ${result.message}`);
  }

  smsSentTotal.inc({ status: "sent", reason: "ok" });
  await record(payload, {
    status: "sent",
    twilioSid: result.sid ?? null,
    encoding,
    segmentCount: segments,
    senderId: org.smsSenderId,
  });

  return { sent: true, sid: result.sid, segments };
}
