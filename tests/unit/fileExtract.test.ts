import { describe, it, expect } from "vitest";
import { extractTextFromFile } from "../../src/core/fileSummarizer.js";

/** Smallest valid one-page PDF with a text object, offsets computed at runtime. */
function tinyPdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("extractTextFromFile", () => {
  it("extracts text from a PDF", async () => {
    const res = await extractTextFromFile(tinyPdf("Servizi SOAP WSDL"), "doc.pdf", "application/pdf");
    expect(res.skipReason).toBeNull();
    expect(res.text).toContain("Servizi SOAP WSDL");
  });

  it("reads plain text and rejects unsupported formats", async () => {
    expect((await extractTextFromFile(Buffer.from("ciao"), "a.md", "text/markdown")).text).toBe("ciao");
    expect((await extractTextFromFile(Buffer.from([0, 1]), "a.bin", "application/octet-stream")).skipReason).toMatch(/unsupported/);
  });
});
