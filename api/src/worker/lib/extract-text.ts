import { logger } from "../../observability/logger.ts";

/**
 * Text extraction for the RAG pipeline.
 *
 * Runs in the worker, never in the API — parsing a large PDF is CPU-bound and
 * would block the request path.
 */
export async function extractText(
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  try {
    if (mimeType === "text/plain" || mimeType === "text/csv") {
      return buffer.toString("utf-8");
    }

    if (
      mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    if (mimeType === "application/pdf") {
      return await extractPdfText(buffer);
    }

    // Images require OCR, which is not wired up. Returning empty is handled
    // upstream as "no extractable text" rather than as a failure.
    if (mimeType.startsWith("image/")) return "";

    logger.warn({ mimeType }, "no extractor for mime type");
    return "";
  } catch (error) {
    logger.error({ err: error, mimeType }, "text extraction failed");
    return "";
  }
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  // Legacy build: the modern ESM build assumes browser globals that do not
  // exist under Bun.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // Fonts are irrelevant when only text is wanted, and disabling them avoids
  // pulling in browser-only asset paths.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
  });

  const doc = await loadingTask.promise;

  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      pages.push(text);
      page.cleanup();
    }
    return pages.join("\n\n");
  } finally {
    // Releases the worker and the parsed document; without this a large batch
    // of PDFs steadily grows the worker's heap.
    await loadingTask.destroy();
  }
}
