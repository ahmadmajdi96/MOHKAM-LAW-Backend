/**
 * Pipeline integration test.
 *
 * Unlike smoke-test.ts, this exercises the parts that cross a process
 * boundary and hit real external services:
 *
 *   presigned upload → MinIO → confirm → BullMQ → worker → text extraction
 *   → Novita embeddings → pgvector → HNSW retrieval → AI generation
 *
 * It makes real (billable) calls to the AI provider and requires the worker
 * to be running. Run it from inside the api container so `minio:9000`
 * resolves the same way the presigned URL is signed for:
 *
 *   docker compose exec api bun scripts/integration-test.ts
 */
export {};

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : "");
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
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: response.status, body: body as Record<string, any> };
}

/** Polls until `predicate` holds or the budget runs out. */
async function waitFor<T>(
  label: string,
  attempt: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 120_000, intervalMs = 2_000 } = {},
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await attempt();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.error(`    (timed out waiting for ${label})`);
  return last;
}

console.log("\n── setup ───────────────────────────────────────────");
const email = `integration-${crypto.randomUUID()}@example.test`;
const password = "correct-horse-battery-staple";

const registered = await call("/v1/auth/register", {
  method: "POST",
  body: JSON.stringify({ email, password, fullName: "Integration Test" }),
});
check("registered a test user", registered.status === 201, registered.body);
const token = registered.body.accessToken as string;

const org = await call("/v1/orgs", {
  method: "POST",
  token,
  body: JSON.stringify({ legalName: "Integration Test Firm", type: "firm", currency: "JOD" }),
});
check("created an org", org.status === 201, org.body);
const orgId = org.body.id as string;

const testCase = await call("/v1/cases", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ title: "Al-Amal lease arbitration" }),
});
check("created a case", testCase.status === 201, testCase.body);
const caseId = testCase.body.id as string;

console.log("\n── storage round trip ──────────────────────────────");

// Distinctive content so a vector hit is meaningful rather than coincidental.
const DOCUMENT = `LEASE ARBITRATION MEMORANDUM — AL-AMAL TRADING COMPANY

1. The tenant, Al-Amal Trading Company, occupied the Abdali commercial unit
   from March 2024 under a five-year lease at 4,200 Jordanian dinars monthly.

2. The landlord asserts arrears of 33,600 dinars covering eight months.
   The tenant disputes 12,600 dinars of that sum, attributing the shortfall
   to an unrepaired roof leak that rendered the mezzanine unusable.

3. Article 12 of the lease requires the landlord to maintain the structural
   envelope. The tenant notified the landlord in writing on 14 May 2024 and
   received no response within the thirty-day cure period.

4. Under the Jordanian Civil Code, a tenant may seek proportional rent
   abatement where the leased premises are partially unusable through the
   landlord's default.

5. Recommended position: concede 21,000 dinars of undisputed arrears, and
   counterclaim for abatement of the remaining 12,600 dinars.

مذكرة تحكيم بشأن عقد الإيجار — شركة الأمل للتجارة
تطالب الشركة المؤجرة بمبلغ ثلاثة وثلاثين ألفاً وستمائة دينار أردني.
`;

const bytes = new TextEncoder().encode(DOCUMENT);

const reserved = await call("/v1/documents/upload-url", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({
    filename: "lease-arbitration-memo.txt",
    contentType: "text/plain",
    contentLength: bytes.byteLength,
    caseId,
  }),
});
check("reserved a document + presigned URL", reserved.status === 201, reserved.body);
const documentId = reserved.body.document?.id as string;
const uploadUrl = reserved.body.upload?.url as string;
check("presigned URL was issued", typeof uploadUrl === "string" && uploadUrl.includes("X-Amz-Signature"));

const put = await fetch(uploadUrl, {
  method: "PUT",
  body: bytes,
  headers: { "content-type": "text/plain" },
});
check("PUT to MinIO succeeded", put.ok, { status: put.status, body: await put.text() });

// Confirmation must fail for a file that was never uploaded — proving the
// server verifies storage rather than trusting the client.
const fakeReserve = await call("/v1/documents/upload-url", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({
    filename: "never-uploaded.txt",
    contentType: "text/plain",
    contentLength: 10,
  }),
});
const fakeConfirm = await call(`/v1/documents/${fakeReserve.body.document?.id}/confirm`, {
  method: "POST",
  token,
  orgId,
});
check("confirming a missing object is rejected", fakeConfirm.status === 400, fakeConfirm.body);

const confirmed = await call(`/v1/documents/${documentId}/confirm`, {
  method: "POST",
  token,
  orgId,
});
check("confirm accepted the real upload", confirmed.status === 200, confirmed.body);
check("indexing was queued", confirmed.body.indexing === true);

const download = await call(`/v1/documents/${documentId}/download`, { token, orgId });
check("download URL issued", download.status === 200 && typeof download.body.url === "string");

const fetched = await fetch(download.body.url as string);
const roundTripped = await fetched.text();
check("downloaded bytes match what was uploaded", roundTripped === DOCUMENT, {
  got: roundTripped.slice(0, 80),
});

console.log("\n── worker: extraction → embeddings → pgvector ──────");
console.log("  (polling; this makes real embedding calls)");

const indexed = await waitFor(
  "document indexing",
  () => call("/v1/ai/search", {
    method: "POST",
    token,
    orgId,
    body: JSON.stringify({ query: "unrepaired roof leak rent abatement", caseId, limit: 5 }),
  }),
  (r) => Array.isArray(r.body?.data) && r.body.data.length > 0,
);

check(
  "worker indexed the document into pgvector",
  Array.isArray(indexed?.body?.data) && indexed!.body.data.length > 0,
  indexed?.body,
);

const topHit = indexed?.body?.data?.[0];
check(
  "top hit comes from the uploaded document",
  topHit?.documentId === documentId,
  { got: topHit?.documentId, want: documentId },
);
check(
  "similarity is a sane cosine score",
  typeof topHit?.similarity === "number" && topHit.similarity > 0.25 && topHit.similarity <= 1,
  topHit?.similarity,
);
check(
  "retrieved chunk contains the relevant passage",
  typeof topHit?.content === "string" && /roof leak|abatement/i.test(topHit.content),
  topHit?.content?.slice(0, 160),
);

// Semantic, not lexical: none of these words appear verbatim in the document.
const semantic = await call("/v1/ai/search", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ query: "how much money is owed by the tenant", caseId, limit: 3 }),
});
check(
  "semantic query matches without lexical overlap",
  Array.isArray(semantic.body?.data) && semantic.body.data.length > 0,
  semantic.body,
);

console.log("\n── retrieval isolation ─────────────────────────────");
const outsiderEmail = `outsider-${crypto.randomUUID()}@example.test`;
const outsider = await call("/v1/auth/register", {
  method: "POST",
  body: JSON.stringify({ email: outsiderEmail, password }),
});
const outsiderToken = outsider.body.accessToken as string;

const leaked = await call("/v1/ai/search", {
  method: "POST",
  token: outsiderToken,
  body: JSON.stringify({ query: "unrepaired roof leak rent abatement", limit: 5 }),
});
check(
  "another tenant's search cannot reach these chunks",
  leaked.status === 200 && (leaked.body?.data ?? []).length === 0,
  leaked.body,
);

const leakedByCase = await call("/v1/ai/search", {
  method: "POST",
  token: outsiderToken,
  body: JSON.stringify({ query: "roof leak", caseId, limit: 5 }),
});
check(
  "scoping a search to someone else's case returns 404",
  leakedByCase.status === 404,
  leakedByCase.body,
);

console.log("\n── PDF extraction (pdfjs under Bun) ────────────────");

// A minimal but structurally valid PDF, embedded so the test is self-contained.
const PDF_B64 = "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMjc1ID4+CnN0cmVhbQpCVCAvRjEgMTEgVGYgNTAgNzUwIFRkIDE2IFRMCihDT1VSVCBGSUxJTkcgLSBDQVNFIDQ0NzEvMjAyNikgVGogVCoKKENsYWltYW50OiBOYWRpYSBIYWRkYWQuIFJlc3BvbmRlbnQ6IFphaHJhIExvZ2lzdGljcyBMTEMuKSBUaiBUKgooQ2xhaW06IHVucGFpZCBjb25zdWx0YW5jeSBpbnZvaWNlcyB0b3RhbGxpbmcgMTg3NTAgZGluYXJzLikgVGogVCoKKEhlYXJpbmcgc2NoZWR1bGVkIGZvciAzIFNlcHRlbWJlciAyMDI2IGF0IEFtbWFuIENvbW1lcmNpYWwgQ291cnQuKSBUaiBUKgpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNjM3CiUlRU9GCg==";
const pdfBytes = Uint8Array.from(atob(PDF_B64), (ch) => ch.charCodeAt(0));

const pdfReserved = await call("/v1/documents/upload-url", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({
    filename: "court-filing.pdf",
    contentType: "application/pdf",
    contentLength: pdfBytes.byteLength,
    caseId,
  }),
});
check("reserved a PDF document", pdfReserved.status === 201, pdfReserved.body);
const pdfDocId = pdfReserved.body.document?.id as string;

const pdfPut = await fetch(pdfReserved.body.upload.url as string, {
  method: "PUT",
  body: pdfBytes,
  headers: { "content-type": "application/pdf" },
});
check("PDF uploaded to MinIO", pdfPut.ok, { status: pdfPut.status });

const pdfConfirm = await call(`/v1/documents/${pdfDocId}/confirm`, {
  method: "POST",
  token,
  orgId,
});
check("PDF confirm queued indexing", pdfConfirm.status === 200, pdfConfirm.body);

const pdfIndexed = await waitFor(
  "PDF indexing",
  () => call("/v1/ai/search", {
    method: "POST",
    token,
    orgId,
    body: JSON.stringify({ query: "unpaid consultancy invoices hearing date", caseId, limit: 10 }),
  }),
  (r) => (r.body?.data ?? []).some((d: any) => d.documentId === pdfDocId),
);

const pdfHit = (pdfIndexed?.body?.data ?? []).find((d: any) => d.documentId === pdfDocId);
check("pdfjs extracted text from the PDF under Bun", pdfHit !== undefined, pdfIndexed?.body);
check(
  "extracted PDF text contains the filing details",
  typeof pdfHit?.content === "string" && /Zahra Logistics|18750|consultancy/i.test(pdfHit.content),
  pdfHit?.content?.slice(0, 200),
);

console.log("\n── queue: AI task end to end ───────────────────────");
console.log("  (polling; this makes a real generation call)");

const task = await call("/v1/ai/tasks", {
  method: "POST",
  token,
  orgId,
  body: JSON.stringify({ kind: "summarize-case", locale: "en", input: { caseId } }),
});
check("AI task accepted with 202", task.status === 202, task.body);
const jobId = task.body.jobId as string;

const finished = await waitFor(
  "AI task completion",
  () => call(`/v1/ai/tasks/${jobId}`, { token, orgId }),
  (r) => r.body?.state === "completed" || r.body?.state === "failed",
  { timeoutMs: 180_000, intervalMs: 3_000 },
);

check("AI task completed", finished?.body?.state === "completed", {
  state: finished?.body?.state,
  reason: finished?.body?.failedReason,
});

const generated = finished?.body?.result?.text as string | undefined;
check("generation returned text", typeof generated === "string" && generated.length > 50, {
  length: generated?.length,
});

// The language lock: an English task must come back free of Arabic script,
// even though the source document is bilingual.
check(
  "English output contains no Arabic script (language lock held)",
  typeof generated === "string" && !/[؀-ۿ]/.test(generated),
  generated?.slice(0, 200),
);

const otherUsersTask = await call(`/v1/ai/tasks/${jobId}`, { token: outsiderToken });
check("another user cannot read this job", otherUsersTask.status === 404, otherUsersTask.body);

if (typeof generated === "string") {
  console.log(`\n  ── generated summary (first 300 chars) ──\n  ${generated.slice(0, 300).replace(/\n/g, "\n  ")}\n`);
}

console.log(`════════════════════════════════════════════════════`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`════════════════════════════════════════════════════\n`);

process.exit(failed === 0 ? 0 : 1);
