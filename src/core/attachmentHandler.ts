import type { MattermostClient } from "../mattermost/client.js";
import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { uploadAttachment } from "../outline/attachments.js";
import { config } from "../config.js";
import { extractTextFromFile } from "./fileSummarizer.js";

export interface ExtractedAttachment {
  fileId: string;
  filename: string;
  mimeType: string;
  isImage: boolean;
  /** Raw extracted text, fed to the AI as authoritative source material. */
  text?: string;
  /** Non-image file whose text could not be extracted (scanned PDF, unsupported format…). */
  unreadable: boolean;
}

export interface UploadedAttachment {
  fileId: string;
  filename: string;
  url: string;
  isImage: boolean;
}

const MAX_TEXT_PER_FILE = 20_000;

function collectFileIds(thread: Array<{ file_ids?: string[] }>): string[] {
  const ids = new Set<string>();
  for (const post of thread) for (const fid of post.file_ids ?? []) ids.add(fid);
  return [...ids];
}

/**
 * Downloads thread attachments from Mattermost and extracts their text.
 * Nothing is uploaded to Outline here — that only happens once a proposal
 * is approved (see uploadAttachments).
 */
export async function extractThreadAttachments(opts: {
  thread: Array<{ file_ids?: string[] }>;
  mmClient: MattermostClient;
  logger: Logger;
}): Promise<ExtractedAttachment[]> {
  const { thread, mmClient, logger } = opts;
  const out: ExtractedAttachment[] = [];

  for (const fileId of collectFileIds(thread)) {
    try {
      const download = await mmClient.getFileBlob(fileId);
      const isImage = download.mimeType.startsWith("image/");
      let text: string | undefined;
      if (!isImage) {
        try {
          const extracted = await extractTextFromFile(download.buffer, download.name, download.mimeType);
          if (extracted.skipReason) {
            logger.info({ fileId, filename: download.name, reason: extracted.skipReason }, "attachment_text_extraction_skipped");
          } else if (extracted.text.trim().length > 0) {
            text = extracted.text.slice(0, MAX_TEXT_PER_FILE);
          }
        } catch (err) {
          logger.warn({ err, fileId, filename: download.name }, "attachment_text_extraction_failed");
        }
      }
      out.push({
        fileId,
        filename: download.name,
        mimeType: download.mimeType,
        isImage,
        ...(text !== undefined && { text }),
        unreadable: !isImage && text === undefined,
      });
    } catch (err) {
      logger.warn({ err, fileId }, "attachment_download_failed");
    }
  }
  return out;
}

/** Re-downloads the given Mattermost files and uploads them to an Outline document. */
export async function uploadAttachments(opts: {
  fileIds: string[];
  documentId: string;
  mmClient: MattermostClient;
  outlineClient: OutlineClient;
  logger: Logger;
}): Promise<UploadedAttachment[]> {
  const { fileIds, documentId, mmClient, outlineClient, logger } = opts;
  const out: UploadedAttachment[] = [];

  for (const fileId of fileIds) {
    try {
      const download = await mmClient.getFileBlob(fileId);
      const attachment = await uploadAttachment(outlineClient, {
        buffer: download.buffer,
        filename: download.name,
        mimeType: download.mimeType,
        size: download.size,
        documentId,
      });
      const url = attachment.url.startsWith("/")
        ? `${config.OUTLINE_URL.replace(/\/$/, "")}${attachment.url}`
        : attachment.url;
      out.push({ fileId, filename: download.name, url, isImage: download.mimeType.startsWith("image/") });
    } catch (err) {
      logger.warn({ err, fileId }, "attachment_upload_failed");
    }
  }
  return out;
}
