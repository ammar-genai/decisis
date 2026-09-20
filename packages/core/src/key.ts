import { readFileSync } from 'node:fs';

/** Read `NAME=value` from a .env-style file; null when the file or the key is absent. */
export function keyFromFile(file: string, name: string): string | null {
  try {
    return readFileSync(file, 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/** Environment first, then the given .env files in order. Never logs or returns partial keys. */
export function loadKey(name: string, { env = process.env, files = [] as string[] } = {}): string | null {
  const fromEnv = env[name]?.trim();
  if (fromEnv) return fromEnv;
  for (const f of files) {
    const k = keyFromFile(f, name);
    if (k) return k;
  }
  return null;
}
