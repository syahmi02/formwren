import { readFileSync } from 'node:fs';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type SourceRead = { ok: true; text: string; bytes: Buffer } | { ok: false; message: string };

/**
 * Reads a form file as strict UTF-8. Bytes that aren't valid UTF-8 would silently become U+FFFD
 * with a lenient decoder, and writing that back would destroy the file, so they are refused.
 * A byte order mark is kept in the text.
 */
export function readFormFile(file: string): SourceRead {
  const bytes = readFileSync(file);
  try {
    return { ok: true, text: decoder.decode(bytes), bytes };
  } catch {
    return { ok: false, message: 'This file is not valid UTF-8. It was left as it is.' };
  }
}
