import { readFile } from 'node:fs/promises';

// Tiny .env loader so local runs need no extra dependency.
export async function loadEnv(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return; // .env is optional
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
