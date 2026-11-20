import { describe, expect, it } from 'vitest';
import {
  compileLanguageOverlay, DEFAULT_SETTINGS, languageCapability, languageSnapshot,
  parseSettings, resolveLocale, resolveUiLocale, skillContext,
} from './language';
import { catalogs, t } from './messages';

describe('end-to-end language preferences (host-owned, no adapter attached)', () => {
  it('defaults to Taiwan Traditional Chinese for UI and workflow', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    expect(resolveUiLocale(settings)).toBe('zh-TW');
    expect(resolveLocale(settings, 'conversation')).toBe('zh-TW');
    expect(resolveLocale(settings, 'review')).toBe('zh-TW');
    expect(resolveLocale(settings, 'commitMessage')).toBe('en-US');
    expect(resolveLocale(settings, 'codeComments')).toBe('preserve-original');
  });

  it('supports task > session > project > global precedence without changing global UI', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.alpha = { workflowLocale: 'en-US' };
    settings.sessions.one = { workflowLocale: 'zh-TW' };
    const scope = { projectId: 'alpha', sessionId: 'one', task: { outputs: { review: 'en-US' as const } } };
    expect(resolveLocale(settings, 'review', scope)).toBe('en-US');
    expect(resolveLocale(settings, 'plan', scope)).toBe('zh-TW');
    expect(resolveLocale(settings, 'plan', { projectId: 'alpha' })).toBe('en-US');
    expect(resolveUiLocale(settings)).toBe('zh-TW');
    expect(languageSnapshot(settings, scope).source).toBe('session');
  });

  it('allows artifact output locale independent from workflow and exact source preservation', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.projects.alpha = { workflowLocale: 'zh-TW', artifactLocale: 'en-US' };
    expect(resolveLocale(settings, 'issue', { projectId: 'alpha' })).toBe('en-US');
    expect(resolveLocale(settings, 'plan', { projectId: 'alpha' })).toBe('zh-TW');
    expect(resolveLocale(settings, 'codeComments', { projectId: 'alpha' })).toBe('preserve-original');
  });

  it('keeps Skill source byte-for-byte and only adds a separate language hint', () => {
    const source = '---\nname: check\n---\nRun `git status --short`, print English raw logs.\n';
    const result = skillContext(source, structuredClone(DEFAULT_SETTINGS));
    expect(result.original).toBe(source);
    expect(result.overlay.instruction).toContain('繁體中文');
    expect(result.sourceUnchanged).toBe(true);
    expect(compileLanguageOverlay(DEFAULT_SETTINGS, 'codeComments').instruction).toBe('');
  });

  it('never claims hidden external Harness language enforcement', () => {
    expect(languageCapability({})).toBe('unsupported');
    expect(languageCapability({ supportsUserPrompt: true })).toBe('best-effort');
    expect(languageCapability({ acceptsLocaleInstructions: true })).toBe('confirmed');
    expect(languageCapability({ ownedPromptComposer: true })).toBe('owned');
  });

  it('rejects unsupported or malicious saved data and restores known defaults', () => {
    expect(parseSettings({ version: 2 }).global.uiLocale).toBe('zh-TW');
    const settings = parseSettings({ version: 1, global: { uiLocale: 'fr-FR', workflowLocale: 'en-US', outputs: { review: 'zh-TW', fake: 'fr-FR' } },
      projects: { '__proto__': { workflowLocale: 'en-US' }, alpha: { workflowLocale: 'en-US' } } });
    expect(settings.global.uiLocale).toBe('zh-TW');
    expect(settings.global.workflowLocale).toBe('en-US');
    expect(resolveLocale(settings, 'review')).toBe('zh-TW');
    expect(resolveLocale(settings, 'plan', { projectId: 'alpha' })).toBe('en-US');
    expect({}.toString).toBe(Object.prototype.toString);
  });

  it('has complete zh-TW/en-US keys with no missing raw translation', () => {
    expect(Object.keys(catalogs['zh-TW']).sort()).toEqual(Object.keys(catalogs['en-US']).sort());
    expect(t('zh-TW', 'monitor.group.decision')).toBe('需要你決策');
    expect(t('en-US', 'monitor.group.decision')).toBe('Needs your decision');
    expect(t('zh-TW', 'header.notifications', { count: 2 })).toContain('2');
  });
  it('really skips an own __proto__ key from parsed JSON and keeps the newest 200 overrides', () => {
    const polluted = JSON.parse('{"version":1,"projects":{"__proto__":{"workflowLocale":"en-US"},"ok":{"workflowLocale":"en-US"}}}') as unknown;
    const parsed = parseSettings(polluted);
    expect(Object.keys(parsed.projects)).toEqual(['ok']);
    expect(({} as { workflowLocale?: string }).workflowLocale).toBeUndefined();

    const sessions = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`s${i}`, { workflowLocale: 'en-US' }]));
    const kept = parseSettings({ version: 1, sessions }).sessions;
    expect(Object.keys(kept)).toHaveLength(200);
    expect(kept.s204).toBeDefined();
    expect(kept.s0).toBeUndefined();
  });

  it('resolves artifact preferences independently of workflow language across scopes', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.global.artifactLocale = 'en-US';
    settings.projects.alpha = { artifactLocale: 'zh-TW', workflowLocale: 'en-US' };
    settings.sessions.one = { workflowLocale: 'en-US' };
    const scope = { projectId: 'alpha', sessionId: 'one' };
    expect(resolveLocale(settings, 'documentation', scope)).toBe('zh-TW');
    expect(resolveLocale(settings, 'plan', scope)).toBe('en-US');
    expect(resolveLocale(settings, 'commitMessage', scope)).toBe('zh-TW');
    expect(resolveLocale(settings, 'commitMessage', { sessionId: 'one' })).toBe('en-US');
    expect(resolveLocale(settings, 'documentation', { sessionId: 'one' })).toBe('en-US');
    settings.sessions.one = { workflowLocale: 'en-US', outputs: { documentation: 'en-US' } };
    expect(resolveLocale(settings, 'documentation', scope)).toBe('en-US');
    expect(resolveLocale(settings, 'codeComments', scope)).toBe('preserve-original');
  });
});
