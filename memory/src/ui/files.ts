import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

import { manualFormat } from '../manuals/extract.js';

/** Largest upload accepted. Appliance manuals are rarely past a few tens of MB. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export class FileError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A file name the panel may create: a single path component, not hidden, no
 * control characters, with a manual extension. Uploads always land directly in
 * the manuals folder, so anything with a separator is refused rather than
 * interpreted.
 */
export function checkUploadName(name: string): string {
  const trimmed = name.normalize('NFC').trim();
  if (
    trimmed === '' ||
    trimmed.startsWith('.') ||
    /[/\\]/.test(trimmed) ||
    [...trimmed].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ||
    Buffer.byteLength(trimmed) > 255
  ) {
    throw new FileError(400, `not a valid file name: ${JSON.stringify(name)}`);
  }
  if (!manualFormat(trimmed)) {
    throw new FileError(400, 'only .pdf, .md and .markdown files can be uploaded');
  }
  return trimmed;
}

/** Resolves `relativePath` under `root`, or undefined if it would leave it. */
export function insideRoot(root: string, relativePath: string): string | undefined {
  const base = resolve(root);
  const full = resolve(base, relativePath);
  return full.startsWith(base + sep) ? full : undefined;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Counts bytes on their way through, failing once past the limit. */
function sizeLimit(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) {
        callback(
          new FileError(413, `files larger than ${limit / 1024 / 1024} MiB are not accepted`),
        );
      } else {
        callback(null, chunk);
      }
    },
  });
}

/**
 * Streams a request body into the manuals folder as `name`. It is written to a
 * hidden temporary file first and renamed into place only once complete and
 * checked, so a scan never sees half a file and a failed upload leaves the
 * previous version, if any, untouched.
 *
 * @returns whether an existing file was replaced
 */
export async function saveUpload(
  dir: string,
  rawName: string,
  body: IncomingMessage,
  overwrite: boolean,
  limit = MAX_UPLOAD_BYTES,
): Promise<{ path: string; replaced: boolean }> {
  const name = checkUploadName(rawName);
  const declared = Number(body.headers['content-length']);
  if (declared > limit) {
    throw new FileError(413, `files larger than ${limit / 1024 / 1024} MiB are not accepted`);
  }

  await mkdir(dir, { recursive: true });
  const target = join(dir, name);
  const replaced = await exists(target);
  if (replaced && !overwrite) {
    throw new FileError(409, `${name} already exists`);
  }

  const temp = join(dir, `.upload-${randomUUID()}.tmp`);
  try {
    await pipeline(body, sizeLimit(limit), createWriteStream(temp, { flags: 'wx' }));

    if (manualFormat(name) === 'pdf') {
      const handle = await open(temp, 'r');
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(5), 0, 5, 0);
      await handle.close();
      if (bytesRead < 5 || buffer.toString('latin1') !== '%PDF-') {
        throw new FileError(400, `${name} is not a PDF file`);
      }
    }

    await rename(temp, target);
    return { path: name, replaced };
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Deletes one manual file, which must lie inside the manuals folder. */
export async function deleteManualFile(dir: string, relativePath: string): Promise<void> {
  const full = insideRoot(dir, relativePath);
  if (!full) throw new FileError(404, 'not found');
  try {
    await unlink(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileError(404, 'not found');
    throw error;
  }
}
