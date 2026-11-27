import { t, type MessageKey } from './messages';
import type { Locale } from './language';

// Only generated preview text uses these markers. Never translate user input.
const demoKeys = {
  newSession: 'demo.newSession',
  sessionCreated: 'demo.sessionCreated',
  notSent: 'demo.notSent',
  now: 'timeline.now',
} as const satisfies Record<string, MessageKey>;

export type DemoTextKey = keyof typeof demoKeys;
export function demoText(key: DemoTextKey): string {
  return `__agentdock_demo:${key}`;
}
export function displayDemoText(value: string, locale: Locale): string {
  if (!value.startsWith('__agentdock_demo:')) return value;
  const key = value.slice('__agentdock_demo:'.length);
  return Object.prototype.hasOwnProperty.call(demoKeys, key)
    ? t(locale, demoKeys[key as DemoTextKey]) : value;
}
