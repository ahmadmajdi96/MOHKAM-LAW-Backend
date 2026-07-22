import { Queue } from "bullmq";
import { createQueueConnection } from "../services/redis.ts";
import { queueDepth } from "../observability/metrics.ts";

/**
 * Queue definitions, shared by the API (producer) and the worker (consumer).
 * Names live here so a typo cannot silently create an orphan queue that
 * nothing consumes.
 */
export const QUEUE_NAMES = {
  documentIndex: "document-index",
  aiTask: "ai-task",
  smsSend: "sms-send",
  maintenance: "maintenance",
} as const;

const connection = createQueueConnection();

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2_000 },
  // Keep a bounded history: enough to debug yesterday, not enough to grow
  // Redis without limit.
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const documentIndexQueue = new Queue(QUEUE_NAMES.documentIndex, {
  connection,
  defaultJobOptions,
});

export const aiTaskQueue = new Queue(QUEUE_NAMES.aiTask, {
  connection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 3 },
});

export const smsSendQueue = new Queue(QUEUE_NAMES.smsSend, {
  connection,
  defaultJobOptions: {
    ...defaultJobOptions,
    // Telephony spend is real money — a retry storm on a provider outage is
    // expensive, so back off hard and give up sooner.
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 30_000 },
  },
});

export const maintenanceQueue = new Queue(QUEUE_NAMES.maintenance, {
  connection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 2 },
});

export const allQueues = [
  documentIndexQueue,
  aiTaskQueue,
  smsSendQueue,
  maintenanceQueue,
];

export interface DocumentIndexJob {
  documentId: string;
  orgId: string | null;
  caseId: string | null;
}

export async function enqueueDocumentIndex(payload: DocumentIndexJob) {
  return documentIndexQueue.add("index", payload, {
    // Deduplicate: re-confirming the same upload must not queue a second
    // extraction pass over the same file.
    // BullMQ rejects ":" in a custom job id — it is their key separator.
    jobId: `doc-${payload.documentId}`,
  });
}

export interface SmsJob {
  orgId: string;
  to: string;
  body: string;
  kind: string;
  caseId?: string | null;
  payerId?: string | null;
  debtCaseId?: string | null;
  clientId?: string | null;
  templateId?: string | null;
  language?: string | null;
  ownerId?: string | null;
}

export async function enqueueSms(payload: SmsJob) {
  return smsSendQueue.add("send", payload);
}

export interface AiTaskJob {
  kind: "summarize-case" | "draft-document" | "analyze-document" | "research";
  userId: string;
  orgId: string | null;
  locale: "ar" | "en";
  input: Record<string, unknown>;
}

export async function enqueueAiTask(payload: AiTaskJob) {
  return aiTaskQueue.add(payload.kind, payload);
}

/** Refreshes the queue_depth gauge; called on the metrics scrape path. */
export async function sampleQueueDepths() {
  await Promise.all(
    allQueues.map(async (queue) => {
      const waiting = await queue.getWaitingCount();
      queueDepth.set({ queue: queue.name }, waiting);
    }),
  );
}

export async function closeQueues() {
  await Promise.all(allQueues.map((queue) => queue.close()));
  await connection.quit().catch(() => connection.disconnect());
}
