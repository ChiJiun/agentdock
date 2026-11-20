import { readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
export const DEFAULT_MOCK = { id: 'mock', label: 'ACP local mock (no model)', bin: process.execPath, args: [fileURLToPath(new URL('./mock-agent.mjs', import.meta.url))], authEnv: [] };

/**
 * Why a configured executable cannot be launched safely, or null when it can.
 * - A bare name is looked up in the session's working directory first on Windows,
 *   so a repository could plant an executable with that name: require a full path.
 * - `.cmd`/`.bat` shims need cmd.exe, whose argument quoting is not safe to
 *   automate here; point `bin` at node.exe (or the real .exe) and put the script in `args`.
 */
export function launchProblem(bin, platform = process.platform) {
  const absolute = isAbsolute(bin) || (platform === 'win32' && /^[a-zA-Z]:[\\/]/.test(bin));
  if (!absolute) return 'adapter "bin" must be an absolute path';
  if (platform === 'win32' && ['.cmd', '.bat', '.ps1'].includes(extname(bin).toLowerCase()))
    return 'adapter "bin" cannot be a .cmd/.bat/.ps1 shim; use node.exe (or the real .exe) and pass the script in "args"';
  return null;
}

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
    const problem = launchProblem(item.bin);
    if (problem) throw new Error(`invalid adapter configuration for "${item.id}": ${problem}`);
    if (entries.some(e => e.id === item.id)) throw new Error(`invalid adapter configuration: duplicate id "${item.id}"`);
    entries.push({ id: item.id, label: String(item.label || item.id).slice(0, 80), bin: item.bin, args: item.args, authEnv: item.authEnv ?? [] });
  }
  return entries;
}
export function ensureInside(candidate, permittedRoots) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) throw new Error('workspace path must be absolute');
  let path;
  try { path = realpathSync(candidate); }
  catch { throw new Error('workspace path does not exist'); }
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
