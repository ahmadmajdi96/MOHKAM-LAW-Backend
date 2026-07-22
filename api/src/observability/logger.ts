import pino from "pino";
import { env, isProduction } from "../env.ts";

/**
 * Structured JSON logs on stdout; the container runtime owns shipping them.
 *
 * The redact list is not optional — this system handles privileged legal
 * material, so credentials and client-identifying fields must never reach the
 * log pipeline even by accident.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.passwordHash",
      "*.password_hash",
      "*.refreshToken",
      "*.refresh_token",
      "*.token",
      "*.apiKey",
      "*.api_key",
      "*.nationalId",
      "*.national_id",
      "*.NOVITA_API_KEY",
      "*.ELEVENLABS_API_KEY",
      "*.TWILIO_AUTH_TOKEN",
    ],
    censor: "[redacted]",
  },
  base: { service: env.OTEL_SERVICE_NAME },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isProduction
    ? undefined
    : { target: "pino-pretty", options: { colorize: true } },
});

export type Logger = typeof logger;
