import { z } from "zod";

/**
 * Fail fast, at boot, on a bad environment — never at 3am inside a request
 * handler. Every consumer imports the parsed object, not process.env.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  APP_URL: z.string().url(),
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((raw) =>
      raw
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: z.string().min(1),
  DATABASE_DIRECT_URL: z.string().min(1).optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().min(1),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_PUBLIC_URL: z.string().url(),

  // 32 chars is the floor for a credible HMAC key; shorter values are almost
  // always a placeholder that slipped into production.
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2_592_000),
  DOCUMENT_SHARE_SECRET: z.string().min(32),

  NOVITA_API_KEY: z.string().default(""),
  AI_GATEWAY_BASE_URL: z.string().url().default("https://api.novita.ai/v3/openai"),
  AI_MODEL: z.string().default("meta-llama/llama-3.3-70b-instruct"),
  AI_EMBEDDING_MODEL: z.string().default("baai/bge-m3"),

  ELEVENLABS_API_KEY: z.string().default(""),

  TWILIO_ACCOUNT_SID: z.string().default(""),
  TWILIO_AUTH_TOKEN: z.string().default(""),
  TWILIO_MESSAGING_SERVICE_SID: z.string().default(""),

  // Rate limits. Defaults are production-safe; tunable per environment (a load
  // test or a shared-IP office may legitimately need them raised).
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  AUTH_RATE_WINDOW: z.coerce.number().int().positive().default(300),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(8),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(""),
  OTEL_SERVICE_NAME: z.string().default("mohkam-api"),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  console.error(`Invalid environment:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";

/**
 * Optional integrations degrade to a clear 503 rather than a stack trace when
 * their key is absent — ElevenLabs in particular ships unconfigured.
 */
export const features = {
  ai: env.NOVITA_API_KEY.length > 0,
  speechToText: env.ELEVENLABS_API_KEY.length > 0,
  sms: env.TWILIO_ACCOUNT_SID.length > 0 && env.TWILIO_AUTH_TOKEN.length > 0,
  tracing: env.OTEL_EXPORTER_OTLP_ENDPOINT.length > 0,
} as const;
