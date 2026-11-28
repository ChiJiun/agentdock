import { describe, expect, test } from 'vitest';
import fixture from '../../src-tauri/tests/fixtures/ipc/app_info.json';
import { isAppInfo, isTauri, appInfo } from './commands';

describe('ipc contract', () => {
  test('shared Rust fixture satisfies the TS AppInfo shape', () => {
    expect(isAppInfo(fixture)).toBe(true);
  });
  test('rejects wrong shapes', () => {
    expect(isAppInfo({ ...fixture, schema_version: '1' })).toBe(false);
    expect(isAppInfo(null)).toBe(false);
  });
  test('outside Tauri the wrapper fails explicitly instead of faking data', async () => {
    expect(isTauri()).toBe(false);
    await expect(appInfo()).rejects.toThrow(/not running inside Tauri/);
  });
});
