import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
export const DEFAULT_MOCK = { id: 'mock', label: 'ACP local mock (no model)', bin: process.execPath, args: [fileURLToPath(new URL('./mock-agent.mjs', import.meta.url))], authEnv: [] };

/** Agent binaries must be configured by the local operator, never posted by a browser. */
export function loadAdapters(filename) {
  const entries = [DEFAULT_MOCK];
  if (!filename) return entries;
  const parsed = JSON.parse(readFileSync(filename, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length > 12) throw new Error('adapter config must be an array of at most 12 entries');
  for (const item of parsed) {
    if (!item || !SAFE_ID.test(item.id) || item.id === 'mock' || typeof item.bin !== 'string' || !item.bin || item.bin.length > 512 ||
      !Array.isArray(item.args) || item.args.some(a => typeof a !== 'string' || a.length > 400) ||
      (item.authEnv && (!Array.isArray(item.authEnv) || item.authEnv.some(a => !/^[A-Z_][A-Z0-9_]{0,50}$/.test(a)))))
      throw new Error('invalid adapter configuration');
    entries.push({ id: item.id, label: String(item.label || item.id).slice(0, 80), bin: item.bin, args: item.args, authEnv: item.authEnv ?? [] });
  }
  return entries;
}
export function ensureInside(candidate, permittedRoots) {
  if (!isAbsolute(candidate)) throw new Error('workspace path must be absolute');
  const path = realpathSync(candidate);
  const allowed = permittedRoots.some(root => {
    const base = realpathSync(root);
    const rel = relative(base, path);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
  });
  if (!allowed) throw new Error('workspace outside approved roots');
  return path;
}
export function childEnvironment(authEnv) {
  const allowed = ['PATH','HOME','USER','TMPDIR','TMP','TEMP','SystemRoot','WINDIR','APPDATA','LOCALAPPDATA','COMSPEC','PATHEXT','LANG','LC_ALL','TERM','USERPROFILE','HOMEDRIVE','HOMEPATH'];
  const keys = new Set([...allowed, ...(authEnv ?? [])]);
  return Object.fromEntries([...keys].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
}
