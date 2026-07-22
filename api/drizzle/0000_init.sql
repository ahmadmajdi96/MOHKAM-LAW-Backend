CREATE TYPE "public"."allocation_kind" AS ENUM('invoice', 'schedule', 'retainer', 'credit_apply', 'debt_case');--> statement-breakpoint
CREATE TYPE "public"."debt_case_status" AS ENUM('active', 'paid', 'partial', 'overdue', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."debt_payer_status" AS ENUM('pending', 'partial', 'paid', 'overdue', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."debt_sms_kind" AS ENUM('reminder_upcoming', 'reminder_due', 'reminder_overdue', 'assignment', 'manual');--> statement-breakpoint
CREATE TYPE "public"."debt_type" AS ENUM('rent', 'loan', 'service', 'installment', 'other');--> statement-breakpoint
CREATE TYPE "public"."expense_kind" AS ENUM('court_fee', 'expert', 'translation', 'filing', 'travel', 'other');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('wip', 'billed', 'written_off', 'non_billable');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'partial', 'paid', 'overdue', 'void', 'sent', 'viewed', 'written_off');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('active', 'invited', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'partner', 'associate', 'paralegal', 'accountant', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."org_type" AS ENUM('solo', 'firm');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'bank_transfer', 'card', 'cheque', 'other');--> statement-breakpoint
CREATE TYPE "public"."prebill_status" AS ENUM('draft', 'approved', 'billed', 'void');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'sent', 'accepted', 'rejected', 'expired', 'converted');--> statement-breakpoint
CREATE TYPE "public"."schedule_status" AS ENUM('upcoming', 'due', 'paid', 'overdue', 'cancelled', 'paused');--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name" text,
	"avatar_url" text,
	"role" text DEFAULT 'lawyer',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"user_agent" text,
	"ip" "inet",
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text,
	"email_confirmed_at" timestamp with time zone,
	"last_sign_in_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"invited_email" text,
	"role" "org_role" DEFAULT 'associate' NOT NULL,
	"status" "member_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "org_type" NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text,
	"email" text,
	"phone" text,
	"address" text,
	"tax_id" text,
	"logo_path" text,
	"country" text,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"preferred_language" text DEFAULT 'en' NOT NULL,
	"default_tax_rate" numeric(5, 2) DEFAULT '15.00' NOT NULL,
	"invoice_prefix" text DEFAULT 'INV' NOT NULL,
	"quote_prefix" text DEFAULT 'QUO' NOT NULL,
	"sms_sender_id" text,
	"sms_quiet_hours_start" time DEFAULT '21:00:00' NOT NULL,
	"sms_quiet_hours_end" time DEFAULT '09:00:00' NOT NULL,
	"sms_timezone" text DEFAULT 'Asia/Amman' NOT NULL,
	"sms_daily_cap_per_recipient" integer DEFAULT 1 NOT NULL,
	"sms_bilingual_footer" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"title" text,
	"body" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'individual' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"email" text,
	"phone" text,
	"company" text,
	"national_id" text,
	"address" text,
	"country" text,
	"tax_id" text,
	"notes" text,
	"sms_consent_at" timestamp with time zone,
	"sms_consent_source" text,
	"preferred_sms_language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"case_id" uuid,
	"client_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"kind" text DEFAULT 'meeting' NOT NULL,
	"color" text,
	"all_day" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text DEFAULT 'update' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"scheduled_at" timestamp with time zone,
	"completed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'associate' NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'other' NOT NULL,
	"contact" text,
	"email" text,
	"phone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"org_id" uuid,
	"client_id" uuid,
	"responsible_lawyer" uuid,
	"title" text NOT NULL,
	"case_number" text,
	"court" text,
	"court_room" text,
	"jurisdiction" text,
	"judge" text,
	"opposing_party" text,
	"opposing_counsel" text,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'medium',
	"description" text,
	"agreed_fee" numeric,
	"retainer_amount" numeric,
	"hourly_rate" numeric,
	"fee_currency" text DEFAULT 'JOD',
	"close_result" text,
	"close_note" text,
	"closed_at" timestamp with time zone,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deadlines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"case_id" uuid,
	"owner_id" uuid NOT NULL,
	"assigned_to" uuid,
	"kind" text DEFAULT 'deadline' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"court" text,
	"due_at" timestamp with time zone NOT NULL,
	"reminder_days" integer[] DEFAULT ARRAY[7, 3, 1] NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courtroom_simulations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"case_id" uuid,
	"title" text,
	"scenario" jsonb NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verdict" jsonb,
	"score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"document_id" uuid NOT NULL,
	"case_id" uuid,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"token_count" integer,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"token" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"storage_path" text NOT NULL,
	"size" bigint,
	"mime_type" text,
	"note" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"case_id" uuid,
	"client_id" uuid,
	"name" text NOT NULL,
	"mime_type" text,
	"size" bigint,
	"storage_path" text NOT NULL,
	"extracted_text" text,
	"tags" text[],
	"category" text,
	"is_template" boolean DEFAULT false NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"case_id" uuid,
	"title" text NOT NULL,
	"template" text,
	"variables" jsonb DEFAULT '{}'::jsonb,
	"content" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid,
	"client_name" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"applied_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	"source_payment_id" uuid,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text,
	"client_id" uuid,
	"client_name" text NOT NULL,
	"case_id" uuid,
	"issue_date" date DEFAULT CURRENT_DATE NOT NULL,
	"due_date" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"time_entry_ids" uuid[] DEFAULT '{}' NOT NULL,
	"accepted_invoice_id" uuid,
	"accepted_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"case_id" uuid,
	"client_id" uuid,
	"kind" "expense_kind" DEFAULT 'other' NOT NULL,
	"description" text,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'JOD' NOT NULL,
	"incurred_on" date DEFAULT CURRENT_DATE NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"status" "expense_status" DEFAULT 'wip' NOT NULL,
	"invoice_id" uuid,
	"receipt_url" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"kind" "allocation_kind" NOT NULL,
	"invoice_id" uuid,
	"schedule_id" uuid,
	"retainer_case_id" uuid,
	"credit_id" uuid,
	"debt_case_id" uuid,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_id" uuid,
	"client_id" uuid,
	"client_name" text NOT NULL,
	"description" text,
	"due_date" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'JOD' NOT NULL,
	"status" "schedule_status" DEFAULT 'upcoming' NOT NULL,
	"reminder_sent_at" timestamp with time zone,
	"plan_id" uuid,
	"installment_no" integer,
	"installment_count" integer,
	"debt_case_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_id" uuid,
	"schedule_id" uuid,
	"client_id" uuid,
	"client_name" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'JOD' NOT NULL,
	"method" "payment_method" DEFAULT 'bank_transfer' NOT NULL,
	"reference" text,
	"paid_at" date DEFAULT CURRENT_DATE NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prebill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prebill_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"time_entry_id" uuid,
	"expense_id" uuid,
	"description" text,
	"quantity" numeric(14, 2) DEFAULT '0' NOT NULL,
	"unit_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"included" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prebills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"case_id" uuid,
	"client_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" "prebill_status" DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'JOD' NOT NULL,
	"subtotal_time" numeric(14, 2) DEFAULT '0' NOT NULL,
	"subtotal_expenses" numeric(14, 2) DEFAULT '0' NOT NULL,
	"discount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"narrative" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"invoice_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"client_id" uuid,
	"client_name" text NOT NULL,
	"case_id" uuid,
	"issue_date" date DEFAULT CURRENT_DATE NOT NULL,
	"valid_until" date,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"quote_id" uuid,
	"client_id" uuid,
	"client_name" text NOT NULL,
	"case_id" uuid,
	"issue_date" date DEFAULT CURRENT_DATE NOT NULL,
	"due_date" date,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'JOD' NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(14, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"case_id" uuid,
	"client_id" uuid,
	"description" text DEFAULT '' NOT NULL,
	"activity_type" text DEFAULT 'work' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"hourly_rate" numeric(12, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'logged' NOT NULL,
	"invoice_id" uuid,
	"is_running" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debt_case_assignees" (
	"case_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'collector' NOT NULL,
	"phone" text,
	"notify_sms" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "debt_case_assignees_case_id_user_id_pk" PRIMARY KEY("case_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "debt_case_payers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"client_id" uuid,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"amount_due" numeric(14, 2) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(14, 2) DEFAULT '0' NOT NULL,
	"due_date" date,
	"status" "debt_payer_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"last_reminder_sent_at" timestamp with time zone,
	"last_reminder_kind" "debt_sms_kind",
	"sms_consent_at" timestamp with time zone,
	"sms_consent_source" text,
	"opted_out_at" timestamp with time zone,
	"promise_to_pay_date" date,
	"promise_amount" numeric(14, 2),
	"promised_at" timestamp with time zone,
	"dispute_reason" text,
	"disputed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debt_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"debt_type" "debt_type" DEFAULT 'other' NOT NULL,
	"total_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"service_fee_type" text DEFAULT 'percent' NOT NULL,
	"service_fee_value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"status" "debt_case_status" DEFAULT 'active' NOT NULL,
	"due_date" date,
	"forwarder_name" text,
	"forwarder_contact" text,
	"reference" text,
	"recurrence" text DEFAULT 'none',
	"recurrence_interval" integer DEFAULT 1,
	"next_recur_at" date,
	"parent_debt_case_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debt_collection_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"payer_id" uuid,
	"amount_received" numeric(14, 2) DEFAULT '0' NOT NULL,
	"service_fee" numeric(14, 2) DEFAULT '0' NOT NULL,
	"amount_forwarded" numeric(14, 2) DEFAULT '0' NOT NULL,
	"forwarder_name" text,
	"method" text DEFAULT 'bank_transfer' NOT NULL,
	"reference" text,
	"paid_at" date DEFAULT CURRENT_DATE NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"notes" text,
	"invoice_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debt_reminder_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"label" text NOT NULL,
	"offset_days" integer DEFAULT 0 NOT NULL,
	"kind" text DEFAULT 'reminder_upcoming' NOT NULL,
	"message_template" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debt_sms_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"case_id" uuid,
	"payer_id" uuid,
	"assignee_user_id" uuid,
	"phone" text NOT NULL,
	"message" text NOT NULL,
	"kind" "debt_sms_kind" DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"twilio_sid" text,
	"error" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"case_id" uuid,
	"client_id" uuid,
	"title" text DEFAULT 'Live session' NOT NULL,
	"status" text DEFAULT 'recording' NOT NULL,
	"language" text DEFAULT 'ar' NOT NULL,
	"transcript" text DEFAULT '' NOT NULL,
	"turns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text DEFAULT 'Meeting' NOT NULL,
	"room_name" text NOT NULL,
	"case_id" uuid,
	"client_id" uuid,
	"transcript" text DEFAULT '',
	"turns" jsonb DEFAULT '[]'::jsonb,
	"participants" jsonb DEFAULT '[]'::jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"entity_type" text,
	"entity_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"org_id" uuid,
	"client_id" uuid,
	"case_id" uuid,
	"debt_case_id" uuid,
	"template_id" uuid,
	"context" text DEFAULT 'manual' NOT NULL,
	"to_number" text NOT NULL,
	"from_number" text NOT NULL,
	"sender_id" text,
	"body" text NOT NULL,
	"language" text,
	"encoding" text,
	"segment_count" integer,
	"twilio_sid" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"error_message" text,
	"blocked_reason" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_opt_outs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"reason" text,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "sms_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"language" text NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"actor_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"case_id" uuid,
	"action" text NOT NULL,
	"summary" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_interactions" ADD CONSTRAINT "client_interactions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_interactions" ADD CONSTRAINT "client_interactions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_parties" ADD CONSTRAINT "case_parties_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_parties" ADD CONSTRAINT "case_parties_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_responsible_lawyer_users_id_fk" FOREIGN KEY ("responsible_lawyer") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courtroom_simulations" ADD CONSTRAINT "courtroom_simulations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courtroom_simulations" ADD CONSTRAINT "courtroom_simulations_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_credits" ADD CONSTRAINT "client_credits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_credits" ADD CONSTRAINT "client_credits_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_credits" ADD CONSTRAINT "client_credits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_invoices" ADD CONSTRAINT "draft_invoices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_invoices" ADD CONSTRAINT "draft_invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_invoices" ADD CONSTRAINT "draft_invoices_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_invoices" ADD CONSTRAINT "draft_invoices_accepted_invoice_id_tax_invoices_id_fk" FOREIGN KEY ("accepted_invoice_id") REFERENCES "public"."tax_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_invoices" ADD CONSTRAINT "draft_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_invoice_id_tax_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."tax_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_tax_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."tax_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_schedule_id_payment_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."payment_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_retainer_case_id_cases_id_fk" FOREIGN KEY ("retainer_case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_credit_id_client_credits_id_fk" FOREIGN KEY ("credit_id") REFERENCES "public"."client_credits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_invoice_id_tax_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."tax_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_tax_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."tax_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_schedule_id_payment_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."payment_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebill_lines" ADD CONSTRAINT "prebill_lines_prebill_id_prebills_id_fk" FOREIGN KEY ("prebill_id") REFERENCES "public"."prebills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebill_lines" ADD CONSTRAINT "prebill_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebill_lines" ADD CONSTRAINT "prebill_lines_time_entry_id_time_entries_id_fk" FOREIGN KEY ("time_entry_id") REFERENCES "public"."time_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebill_lines" ADD CONSTRAINT "prebill_lines_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebills" ADD CONSTRAINT "prebills_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebills" ADD CONSTRAINT "prebills_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebills" ADD CONSTRAINT "prebills_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebills" ADD CONSTRAINT "prebills_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebills" ADD CONSTRAINT "prebills_invoice_id_tax_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."tax_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prebills" ADD CONSTRAINT "prebills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_invoice_id_tax_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."tax_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_case_assignees" ADD CONSTRAINT "debt_case_assignees_case_id_debt_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."debt_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_case_assignees" ADD CONSTRAINT "debt_case_assignees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_case_payers" ADD CONSTRAINT "debt_case_payers_case_id_debt_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."debt_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_case_payers" ADD CONSTRAINT "debt_case_payers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_cases" ADD CONSTRAINT "debt_cases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_cases" ADD CONSTRAINT "debt_cases_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_cases" ADD CONSTRAINT "debt_cases_parent_debt_case_id_debt_cases_id_fk" FOREIGN KEY ("parent_debt_case_id") REFERENCES "public"."debt_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_cases" ADD CONSTRAINT "debt_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_collection_payments" ADD CONSTRAINT "debt_collection_payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_collection_payments" ADD CONSTRAINT "debt_collection_payments_case_id_debt_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."debt_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_collection_payments" ADD CONSTRAINT "debt_collection_payments_payer_id_debt_case_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."debt_case_payers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_collection_payments" ADD CONSTRAINT "debt_collection_payments_invoice_id_tax_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."tax_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_collection_payments" ADD CONSTRAINT "debt_collection_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_reminder_rules" ADD CONSTRAINT "debt_reminder_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_reminder_rules" ADD CONSTRAINT "debt_reminder_rules_case_id_debt_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."debt_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_reminder_rules" ADD CONSTRAINT "debt_reminder_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_sms_log" ADD CONSTRAINT "debt_sms_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_sms_log" ADD CONSTRAINT "debt_sms_log_case_id_debt_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."debt_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_sms_log" ADD CONSTRAINT "debt_sms_log_payer_id_debt_case_payers_id_fk" FOREIGN KEY ("payer_id") REFERENCES "public"."debt_case_payers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_sms_log" ADD CONSTRAINT "debt_sms_log_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_debt_case_id_debt_cases_id_fk" FOREIGN KEY ("debt_case_id") REFERENCES "public"."debt_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_template_id_sms_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."sms_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_opt_outs" ADD CONSTRAINT "sms_opt_outs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_opt_outs" ADD CONSTRAINT "sms_opt_outs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_templates" ADD CONSTRAINT "sms_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_templates" ADD CONSTRAINT "sms_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_user_kind_idx" ON "auth_tokens" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_family_id_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_org_user_key" ON "organization_members" USING btree ("org_id","user_id") WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "organization_members_org_idx" ON "organization_members" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "organization_members_invited_email_idx" ON "organization_members" USING btree ("invited_email");--> statement-breakpoint
CREATE INDEX "client_interactions_client_idx" ON "client_interactions" USING btree ("client_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "client_interactions_owner_idx" ON "client_interactions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "clients_owner_idx" ON "clients" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "clients_name_trgm_idx" ON "clients" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clients_phone_idx" ON "clients" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "appointments_owner_starts_idx" ON "appointments" USING btree ("owner_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_case_idx" ON "appointments" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_events_case_idx" ON "case_events" USING btree ("case_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "case_events_scheduled_idx" ON "case_events" USING btree ("scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "case_members_case_user_key" ON "case_members" USING btree ("case_id","user_id");--> statement-breakpoint
CREATE INDEX "case_members_user_idx" ON "case_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "case_notes_case_idx" ON "case_notes" USING btree ("case_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "case_parties_case_idx" ON "case_parties" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "cases_owner_idx" ON "cases" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "cases_org_idx" ON "cases" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "cases_client_idx" ON "cases" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "cases_org_status_idx" ON "cases" USING btree ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cases_title_trgm_idx" ON "cases" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cases_case_number_idx" ON "cases" USING btree ("case_number");--> statement-breakpoint
CREATE INDEX "deadlines_status_due_idx" ON "deadlines" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "deadlines_org_due_idx" ON "deadlines" USING btree ("org_id","due_at");--> statement-breakpoint
CREATE INDEX "deadlines_case_idx" ON "deadlines" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "deadlines_assigned_idx" ON "deadlines" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "courtroom_simulations_owner_idx" ON "courtroom_simulations" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_chunks_doc_index_key" ON "document_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "document_chunks_org_idx" ON "document_chunks" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_shares_token_key" ON "document_shares" USING btree ("token");--> statement-breakpoint
CREATE INDEX "document_shares_document_idx" ON "document_shares" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_doc_version_key" ON "document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX "documents_owner_idx" ON "documents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "documents_case_idx" ON "documents" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "documents_client_idx" ON "documents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "documents_tags_idx" ON "documents" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "documents_text_fts_idx" ON "documents" USING gin (to_tsvector('simple', coalesce("extracted_text", '')));--> statement-breakpoint
CREATE INDEX "drafts_owner_idx" ON "drafts" USING btree ("owner_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "drafts_case_idx" ON "drafts" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "client_credits_org_idx" ON "client_credits" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "client_credits_client_idx" ON "client_credits" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "draft_invoices_org_status_idx" ON "draft_invoices" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "draft_invoices_client_idx" ON "draft_invoices" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "expenses_org_status_idx" ON "expenses" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "expenses_case_idx" ON "expenses" USING btree ("case_id","incurred_on");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_org_idx" ON "payment_allocations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payment_schedules_status_due_idx" ON "payment_schedules" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "payment_schedules_org_idx" ON "payment_schedules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "payment_schedules_plan_idx" ON "payment_schedules" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "payments_org_paid_idx" ON "payments" USING btree ("org_id","paid_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payments_client_idx" ON "payments" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "prebill_lines_prebill_idx" ON "prebill_lines" USING btree ("prebill_id");--> statement-breakpoint
CREATE INDEX "prebills_org_status_idx" ON "prebills" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "prebills_case_period_idx" ON "prebills" USING btree ("case_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_org_number_key" ON "quotes" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "quotes_org_status_idx" ON "quotes" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "quotes_client_idx" ON "quotes" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_invoices_org_number_key" ON "tax_invoices" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "tax_invoices_org_status_idx" ON "tax_invoices" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "tax_invoices_due_date_idx" ON "tax_invoices" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "tax_invoices_client_idx" ON "tax_invoices" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "tax_invoices_case_idx" ON "tax_invoices" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "time_entries_owner_started_idx" ON "time_entries" USING btree ("owner_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "time_entries_case_idx" ON "time_entries" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "time_entries_one_running_per_user" ON "time_entries" USING btree ("owner_id") WHERE is_running;--> statement-breakpoint
CREATE INDEX "debt_case_assignees_user_idx" ON "debt_case_assignees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "debt_case_payers_case_idx" ON "debt_case_payers" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "debt_case_payers_status_due_idx" ON "debt_case_payers" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "debt_case_payers_phone_idx" ON "debt_case_payers" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "debt_cases_org_status_idx" ON "debt_cases" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "debt_cases_client_idx" ON "debt_cases" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "debt_cases_next_recur_idx" ON "debt_cases" USING btree ("next_recur_at");--> statement-breakpoint
CREATE INDEX "debt_collection_payments_case_idx" ON "debt_collection_payments" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "debt_collection_payments_org_paid_idx" ON "debt_collection_payments" USING btree ("org_id","paid_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "debt_reminder_rules_case_active_idx" ON "debt_reminder_rules" USING btree ("case_id","active");--> statement-breakpoint
CREATE INDEX "debt_sms_log_phone_sent_idx" ON "debt_sms_log" USING btree ("phone","sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "debt_sms_log_case_idx" ON "debt_sms_log" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "debt_sms_log_org_sent_idx" ON "debt_sms_log" USING btree ("org_id","sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "live_sessions_owner_started_idx" ON "live_sessions" USING btree ("owner_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "meetings_owner_started_idx" ON "meetings" USING btree ("owner_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "meetings_room_idx" ON "meetings" USING btree ("room_name");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE read_at IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sms_messages_twilio_sid_idx" ON "sms_messages" USING btree ("twilio_sid");--> statement-breakpoint
CREATE INDEX "sms_messages_org_sent_idx" ON "sms_messages" USING btree ("org_id","sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sms_messages_to_number_idx" ON "sms_messages" USING btree ("to_number","sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sms_messages_case_idx" ON "sms_messages" USING btree ("case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_opt_outs_org_phone_key" ON "sms_opt_outs" USING btree ("org_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_templates_active_key" ON "sms_templates" USING btree ("org_id","kind","language") WHERE is_active;--> statement-breakpoint
CREATE INDEX "activity_log_org_created_idx" ON "activity_log" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_log_case_idx" ON "activity_log" USING btree ("case_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_log_entity_idx" ON "activity_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "activity_log_actor_idx" ON "activity_log" USING btree ("actor_id");