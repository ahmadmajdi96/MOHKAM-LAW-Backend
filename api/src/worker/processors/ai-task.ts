import type { Job } from "bullmq";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { cases } from "../../db/schema/cases.ts";
import { notifications } from "../../db/schema/comms.ts";
import { chatModel, recordTokenUsage, withAiRetry } from "../../services/ai.ts";
import {
  sanitizeLanguageText,
  strictLanguageDirective,
} from "../../services/language.ts";
import { searchChunks } from "../../services/retrieval.ts";
import { logger } from "../../observability/logger.ts";
import type { AiTaskJob } from "../../queue/queues.ts";

/**
 * Long-running AI work, moved off the request path. The client submits a task,
 * gets a job id, and is notified when it lands — a 40-second generation must
 * not hold an HTTP connection open.
 */
export async function processAiTask(job: Job) {
  const payload = job.data as AiTaskJob;
  const { locale } = payload;

  const system = strictLanguageDirective(locale);
  let prompt: string;

  switch (payload.kind) {
    case "summarize-case": {
      const caseId = String(payload.input.caseId);
      const [row] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
      if (!row) return { skipped: true, reason: "case_deleted" };

      // Ground the summary in indexed documents rather than the model's
      // priors — an ungrounded summary of a legal matter is a liability.
      const context = await searchChunks({
        query: row.title,
        caseId,
        orgId: payload.orgId,
        limit: 12,
      });

      prompt = [
        `Summarise this legal matter for the responsible lawyer.`,
        `Title: ${row.title}`,
        row.description ? `Description: ${row.description}` : "",
        row.court ? `Court: ${row.court}` : "",
        context.length > 0
          ? `\nRelevant document extracts:\n${context.map((chunk, i) => `[${i + 1}] ${chunk.content}`).join("\n\n")}`
          : "\nNo indexed documents are available for this matter.",
        `\nCover: current posture, key dates, obligations, and open risks.`,
        `State explicitly when the record is insufficient rather than inferring.`,
      ]
        .filter(Boolean)
        .join("\n");
      break;
    }

    case "research": {
      const question = String(payload.input.question ?? "");
      const context = await searchChunks({
        query: question,
        orgId: payload.orgId,
        limit: 15,
      });

      prompt = [
        `Answer the question using the firm's indexed material.`,
        `Question: ${question}`,
        context.length > 0
          ? `\nSources:\n${context.map((chunk, i) => `[${i + 1}] ${chunk.content}`).join("\n\n")}`
          : "\nNo indexed sources matched.",
        `\nCite sources as [n]. If the sources do not answer the question, say so plainly.`,
      ].join("\n");
      break;
    }

    case "draft-document":
    case "analyze-document": {
      prompt = String(payload.input.prompt ?? "");
      break;
    }

    default: {
      throw new Error(`unknown ai task kind: ${payload.kind satisfies never}`);
    }
  }

  const result = await withAiRetry(payload.kind, async (signal) =>
    generateText({
      model: chatModel(),
      system,
      prompt,
      abortSignal: signal,
      maxOutputTokens: 4_000,
    }),
  );

  recordTokenUsage({
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
  });

  // The prompt-level language lock is not fully reliable on open-weight
  // models; this is the second of the two required layers.
  const text = sanitizeLanguageText(result.text, locale);

  await db.insert(notifications).values({
    orgId: payload.orgId,
    userId: payload.userId,
    kind: `ai.${payload.kind}`,
    title: locale === "ar" ? "اكتملت مهمة الذكاء الاصطناعي" : "AI task complete",
    body: text.slice(0, 500),
    entityType: "ai_task",
    entityId: null,
  });

  logger.info({ kind: payload.kind, userId: payload.userId }, "ai task complete");
  return { text };
}
