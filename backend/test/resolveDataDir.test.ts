import { describe, expect, it } from 'vitest';
import { resolveDataDir } from '../src/resolveDataDir.js';

describe('resolveDataDir', () => {
  it('prefers an explicit env override when set', () => {
    expect(resolveDataDir('file:///C:/app/src/index.ts', '/custom/data')).toBe('/custom/data');
  });

  it('ignores an empty-string env override and falls back to the derived path', () => {
    const result = resolveDataDir('file:///C:/Projects/tms-v2/backend/src/index.ts', '');
    expect(result).toBe('C:\\Projects\\tms-v2\\backend\\data');
  });

  it('derives ../data relative to the module file on a Windows file:// URL, without doubling the drive letter', () => {
    // Regression test: new URL(metaUrl).pathname on Windows yields "/C:/Projects/.../data",
    // which Node's fs functions resolve to the broken "C:\C:\Projects\...\data" — silently
    // ENOENT, making the app think its own data directory doesn't exist. fileURLToPath avoids this.
    const result = resolveDataDir('file:///C:/Projects/tms-v2/backend/src/index.ts', undefined);
    expect(result).toBe('C:\\Projects\\tms-v2\\backend\\data');
    expect(result).not.toContain('C:\\C:');
  });
});
