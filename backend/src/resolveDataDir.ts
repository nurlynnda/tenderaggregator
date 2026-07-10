import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// new URL(metaUrl).pathname is NOT a valid filesystem path on Windows — it returns
// "/C:/Projects/.../data", which Node's fs functions then resolve to the broken
// "C:\C:\Projects\...\data" (silently ENOENT, since the leading slash gets treated as
// a path segment rather than stripped). fileURLToPath handles the platform-specific
// conversion correctly.
export function resolveDataDir(metaUrl: string, envValue: string | undefined): string {
  return envValue || join(dirname(fileURLToPath(metaUrl)), '..', 'data');
}
