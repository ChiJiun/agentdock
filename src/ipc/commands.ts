import { invoke } from '@tauri-apps/api/core';

export interface AppInfo {
  app_version: string;
  core_version: string;
  schema_version: number;
  platform: string;
}

export interface IpcError {
  code: string;
  message: string;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isAppInfo(v: unknown): v is AppInfo {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.app_version === 'string' &&
    typeof o.core_version === 'string' &&
    typeof o.schema_version === 'number' &&
    typeof o.platform === 'string'
  );
}

export async function appInfo(): Promise<AppInfo> {
  if (!isTauri()) {
    throw new Error('app_info unavailable: not running inside Tauri');
  }
  const result: unknown = await invoke('app_info');
  if (!isAppInfo(result)) {
    throw new Error('app_info returned an unexpected shape');
  }
  return result;
}
