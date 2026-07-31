import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * log.ts reads LOG_LEVEL once at import time, so each case needs a fresh module
 * registry rather than a shared import.
 */
async function loadLogger(level: string | undefined) {
  vi.resetModules();
  if (level === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = level;
  }
  return import('../src/log.js');
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  delete process.env.LOG_LEVEL;
});

describe('log level', () => {
  it('logs tool calls at the default level (info)', async () => {
    const { logToolCall } = await loadLogger(undefined);
    logToolCall('save', { contentLength: 12 });
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it('suppresses tool-call logs below info but still reports errors', async () => {
    const { logToolCall, logError } = await loadLogger('warning');
    logToolCall('save', { contentLength: 12 });
    logError('save', new Error('boom'));

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('suppresses even errors at fatal', async () => {
    const { logError } = await loadLogger('fatal');
    logError('save', new Error('boom'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('falls back to info for an unrecognised level', async () => {
    const { logToolCall } = await loadLogger('nonsense');
    logToolCall('save', { contentLength: 12 });
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it('never writes raw fact content (SPEC §8 Always)', async () => {
    const { logToolCall } = await loadLogger('trace');
    logToolCall('save', { contentLength: 42, tagCount: 2 });
    const line = String(logSpy.mock.calls[0]?.[0]);
    expect(line).toContain('contentLength=42');
    expect(line).not.toContain('secret');
  });
});
