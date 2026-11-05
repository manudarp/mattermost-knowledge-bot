const MAX_EXTRACT_BYTES = 5 * 1024 * 1024; // 5 MB

const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "json", "csv", "tsv", "log",
  "js", "ts", "tsx", "jsx", "py", "go", "rs", "java", "rb",
  "yml", "yaml", "html", "css", "sh", "sql",
]);

function getExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : "";
}

export interface ExtractResult {
  text: string;
  /** Reason text is empty/unsupported, useful for logging. Null means success. */
  skipReason: string | null;
}

export async function extractTextFromFile(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<ExtractResult> {
  if (buffer.length > MAX_EXTRACT_BYTES) {
    return { text: "", skipReason: `file too large (${buffer.length} bytes)` };
  }

  const ext = getExt(filename);

  if (TEXT_EXTS.has(ext) || mimeType.startsWith("text/")) {
    return { text: buffer.toString("utf8"), skipReason: null };
  }

  if (ext === "pdf" || mimeType === "application/pdf") {
    // Dynamic import keeps cold start cheap for non-PDF saves (pdf.js is large).
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const parsed = await parser.getText();
      return { text: parsed.text ?? "", skipReason: null };
    } finally {
      await parser.destroy();
    }
  }

  if (
    ext === "docx" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value ?? "", skipReason: null };
  }

  return { text: "", skipReason: `unsupported format (.${ext} / ${mimeType})` };
}
