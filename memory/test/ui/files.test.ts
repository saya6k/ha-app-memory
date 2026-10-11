import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkUploadName, deleteManualFile, insideRoot, saveUpload } from '../../src/ui/files.js';

let dir: string;
let manuals: string;

/** A request body stand-in: a stream with headers. */
function body(content: string | Buffer, headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(content)]), {
    headers,
  }) as unknown as IncomingMessage;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-app-memory-files-'));
  manuals = join(dir, 'manuals');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('checkUploadName', () => {
  it('accepts plain manual names, including Korean', () => {
    expect(checkUploadName('드럼세탁기.pdf')).toBe('드럼세탁기.pdf');
    expect(checkUploadName(' Oven manual.MD ')).toBe('Oven manual.MD');
  });

  it.each([
    '../evil.pdf',
    'a/b.pdf',
    'a\\b.pdf',
    '.hidden.pdf',
    '',
    'x\u0000.pdf',
    'notes.txt',
    'pdf',
  ])('refuses %j', (name) => {
    expect(() => checkUploadName(name)).toThrow();
  });
});

describe('insideRoot', () => {
  it('only resolves paths inside the root', () => {
    expect(insideRoot('/share/manuals', 'a/b.pdf')).toBe('/share/manuals/a/b.pdf');
    expect(insideRoot('/share/manuals', '../secret')).toBeUndefined();
    expect(insideRoot('/share/manuals', '/etc/passwd')).toBeUndefined();
    expect(insideRoot('/share/manuals', '')).toBeUndefined();
  });
});

describe('saveUpload', () => {
  it('creates the folder and writes the file', async () => {
    const saved = await saveUpload(manuals, 'Dryer.md', body('# 필터\n'), false);
    expect(saved).toEqual({ path: 'Dryer.md', replaced: false });
    expect(readFileSync(join(manuals, 'Dryer.md'), 'utf8')).toBe('# 필터\n');
  });

  it('refuses to replace an existing file unless asked to', async () => {
    await saveUpload(manuals, 'Dryer.md', body('v1'), false);

    await expect(saveUpload(manuals, 'Dryer.md', body('v2'), false)).rejects.toMatchObject({
      status: 409,
    });
    expect(readFileSync(join(manuals, 'Dryer.md'), 'utf8')).toBe('v1');

    expect(await saveUpload(manuals, 'Dryer.md', body('v2'), true)).toEqual({
      path: 'Dryer.md',
      replaced: true,
    });
    expect(readFileSync(join(manuals, 'Dryer.md'), 'utf8')).toBe('v2');
  });

  it('refuses a .pdf that is not a PDF, and leaves nothing behind', async () => {
    await expect(saveUpload(manuals, 'Fake.pdf', body('hello'), false)).rejects.toMatchObject({
      status: 400,
    });
    expect(readdirSync(manuals)).toEqual([]);
  });

  it('stops at the size limit, keeping the previous version and no temp file', async () => {
    await saveUpload(manuals, 'Dryer.md', body('old'), false);

    await expect(
      saveUpload(manuals, 'Dryer.md', body('x'.repeat(2048)), true, 1024),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      saveUpload(manuals, 'Dryer.md', body('x', { 'content-length': '4096' }), true, 1024),
    ).rejects.toMatchObject({ status: 413 });

    expect(readFileSync(join(manuals, 'Dryer.md'), 'utf8')).toBe('old');
    expect(readdirSync(manuals)).toEqual(['Dryer.md']);
  });
});

describe('deleteManualFile', () => {
  it('deletes a file inside the folder', async () => {
    await saveUpload(manuals, 'Dryer.md', body('x'), false);
    await deleteManualFile(manuals, 'Dryer.md');
    expect(existsSync(join(manuals, 'Dryer.md'))).toBe(false);
  });

  it('never deletes outside the folder', async () => {
    writeFileSync(join(dir, 'secret.txt'), 'keep me');
    await expect(deleteManualFile(manuals, '../secret.txt')).rejects.toMatchObject({ status: 404 });
    expect(existsSync(join(dir, 'secret.txt'))).toBe(true);
  });

  it('reports a file that is already gone as not found', async () => {
    await expect(deleteManualFile(manuals, 'missing.pdf')).rejects.toMatchObject({ status: 404 });
  });
});
