import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectiveLanguage, languageOverlay, skillContext, languageCapability } from './resolve.mjs';

const zh = JSON.parse(readFileSync(new URL('../../examples/language-profiles/zh-TW.json', import.meta.url)));
const en = JSON.parse(readFileSync(new URL('../../examples/language-profiles/en-US.json', import.meta.url)));

test('zh-TW profile applies to workflow while preserving code comments and custom English commits', () => {
  const scopes = { global: zh };
  for (const stage of ['conversation', 'plan', 'review', 'issue', 'pullRequest', 'sessionSummary', 'notification', 'skillExplanation']) {
    assert.equal(effectiveLanguage(scopes, stage), 'zh-TW');
  }
  assert.equal(effectiveLanguage(scopes, 'ui'), 'zh-TW');
  assert.equal(effectiveLanguage(scopes, 'commitMessage'), 'en-US');
  assert.equal(effectiveLanguage(scopes, 'codeComments'), 'preserve-original');
});

test('task > session > project > global, independently for each requested stage', () => {
  const scopes = { global: zh, project: { workflowLocale: 'en-US' },
    session: { workflowLocale: 'zh-TW' }, task: { outputs: { review: 'en-US' } } };
  assert.equal(effectiveLanguage(scopes, 'review'), 'en-US');
  assert.equal(effectiveLanguage(scopes, 'plan'), 'zh-TW');
  assert.equal(effectiveLanguage({ global: zh, project: { workflowLocale: 'en-US' } }, 'plan'), 'en-US');
  assert.equal(effectiveLanguage(scopes, 'ui'), 'zh-TW');
});

test('skill original text and code are byte-equivalent before and after overlay', () => {
  const source = '---\nname: test\n---\nRun `git status --short`; return a brief summary.\n';
  const context = skillContext({ global: zh }, source);
  assert.equal(context.source, source);
  assert.equal(context.overlay.locale, 'zh-TW');
  assert.equal(context.mutatesSource, false);
  assert.ok(context.overlay.instruction.includes('繁體中文'));
});

test('no silent claim of controlling an external agent', () => {
  assert.equal(languageCapability({ ownedPromptComposer: true }), 'owned');
  assert.equal(languageCapability({ acceptsLocaleInstructions: true }), 'confirmed');
  assert.equal(languageCapability({ supportsUserPrompt: true }), 'best-effort');
  assert.equal(languageCapability({}), 'unsupported');
  assert.equal(languageCapability(undefined), 'unsupported');
  // A profile asking for zh-TW says nothing about what the adapter can do.
  assert.equal(languageCapability({ workflowLocale: 'zh-TW' }), 'unsupported');
});

test('artifactLocale applies to prose artifacts only, below explicit outputs and above workflowLocale', () => {
  const scopes = { global: { workflowLocale: 'zh-TW', artifactLocale: 'en-US', outputs: { issue: 'zh-TW' } } };
  assert.equal(effectiveLanguage(scopes, 'documentation'), 'en-US');
  assert.equal(effectiveLanguage(scopes, 'pullRequest'), 'en-US');
  assert.equal(effectiveLanguage(scopes, 'commitMessage'), 'en-US');
  assert.equal(effectiveLanguage(scopes, 'issue'), 'zh-TW');
  for (const stage of ['conversation', 'plan', 'review', 'sessionSummary', 'notification', 'skillExplanation']) {
    assert.equal(effectiveLanguage(scopes, stage), 'zh-TW');
  }
  assert.equal(effectiveLanguage(scopes, 'codeComments'), 'preserve-original');
  // `inherit` falls through to workflowLocale.
  assert.equal(effectiveLanguage({ global: { workflowLocale: 'zh-TW', artifactLocale: 'inherit' } }, 'documentation'), 'zh-TW');
  // A nearer workflowLocale does not override a farther artifactLocale...
  assert.equal(effectiveLanguage({ global: scopes.global, session: { workflowLocale: 'zh-TW' } }, 'documentation'), 'en-US');
  // ...but a nearer artifactLocale or explicit stage setting does.
  assert.equal(effectiveLanguage({ global: scopes.global, session: { artifactLocale: 'zh-TW' } }, 'documentation'), 'zh-TW');
  assert.equal(effectiveLanguage({ global: scopes.global, task: { outputs: { documentation: 'zh-TW' } } }, 'documentation'), 'zh-TW');
});

test('a nearer workflowLocale does not override a farther explicit per-stage setting', () => {
  // Same rule as src/i18n/language.ts on main: the default commit-message policy survives.
  assert.equal(effectiveLanguage({ global: zh }, 'commitMessage'), 'en-US');
  assert.equal(effectiveLanguage({ global: zh, project: { workflowLocale: 'zh-TW' } }, 'commitMessage'), 'en-US');
  assert.equal(effectiveLanguage({ global: en, session: { workflowLocale: 'zh-TW' } }, 'codeComments'), 'preserve-original');
  // The nearer workflowLocale still decides stages nobody pinned.
  assert.equal(effectiveLanguage({ global: zh, project: { workflowLocale: 'en-US' } }, 'review'), 'en-US');
  // A nearer explicit setting for the same stage wins over the farther one.
  assert.equal(effectiveLanguage({ global: zh, project: { outputs: { commitMessage: 'zh-TW' } } }, 'commitMessage'), 'zh-TW');
});

test('unsupported locale tags are rejected, never substituted', () => {
  assert.throws(() => effectiveLanguage({ global: { workflowLocale: 'zh-CN' } }, 'plan'), /Unsupported locale/);
  assert.throws(() => effectiveLanguage({ global: { workflowLocale: 'zh' } }, 'plan'), /Unsupported locale/);
  assert.throws(() => effectiveLanguage({ global: { uiLocale: 'zh-CN' } }, 'ui'), /Unsupported locale/);
  assert.throws(() => effectiveLanguage({ global: { artifactLocale: 'zh-Hans' } }, 'documentation'), /Unsupported artifact locale/);
});

test('default language is zh-TW, en-US is explicit, and unknown values/stages are rejected', () => {
  assert.equal(effectiveLanguage({ global: en }, 'review'), 'en-US');
  assert.equal(effectiveLanguage({ global: en }, 'ui'), 'en-US');
  assert.equal(effectiveLanguage({}, 'conversation'), 'zh-TW');
  assert.equal(effectiveLanguage({}, 'ui'), 'zh-TW');
  assert.equal(effectiveLanguage(undefined, 'documentation'), 'zh-TW');
  assert.equal(effectiveLanguage({}, 'codeComments'), 'preserve-original');
  assert.throws(() => effectiveLanguage({ global: zh }, 'shell'), /Unsupported/);
  assert.throws(() => effectiveLanguage({ global: { outputs: { review: 'fr-FR' } } }, 'review'), /Unsupported/);
});

test('language overlay never orders changes to commands or filenames', () => {
  for (const locale of [zh, en]) {
    const x = languageOverlay({ global: locale }, 'review');
    assert.match(x.instruction, /CLI|commands/);
    assert.equal(x.status, 'preference-only');
    assert.equal(x.policyVersion, 'agentdock-language-v1');
  }
});
