/**
 * Proof-of-concept resolver for effective locale in AgentDock.
 * Not yet wired into React, Rust, ACP or any external agent.
 * Pure JS + Node test runner, deliberately no runtime dependencies.
 */
const LOCALES = new Set(['zh-TW', 'en-US']);
const OVERRIDE_VALUES = new Set(['zh-TW', 'en-US', 'inherit', 'preserve-original']);
const PRESERVED = new Set(['codeComments']);
// Prose artifacts follow `artifactLocale` before `workflowLocale`.
const ARTIFACT_STAGES = new Set(['issue', 'pullRequest', 'commitMessage', 'documentation']);
const STAGES = new Set(['ui', 'conversation', 'plan', 'review', 'issue', 'pullRequest',
  'commitMessage', 'documentation', 'codeComments', 'sessionSummary', 'notification', 'skillExplanation']);
const LAYERS = ['task', 'session', 'project', 'global'];
export const POLICY_VERSION = 'agentdock-language-v1';

/** Unsupported tags (for example zh-CN) are rejected, never substituted. */
function assertLocale(value, where) {
  if (value != null && !LOCALES.has(value)) {
    throw new Error(`Unsupported locale in ${where}: ${value}`);
  }
}

export function effectiveLanguage(scopes, stage) {
  if (!STAGES.has(stage)) throw new Error(`Unsupported output stage: ${stage}`);
  const global = scopes?.global ?? {};
  if (stage === 'ui') {
    assertLocale(global.uiLocale, 'global.uiLocale');
    return global.uiLocale ?? 'en-US';
  }

  for (const layer of LAYERS) {
    const profile = scopes?.[layer];
    if (!profile || typeof profile !== 'object') continue;
    const explicit = profile.outputs?.[stage];
    if (explicit != null && !OVERRIDE_VALUES.has(explicit)) {
      throw new Error(`Unsupported output locale value in ${layer}: ${explicit}`);
    }
    if (explicit && explicit !== 'inherit') return explicit;

    // Code comments follow repository conventions unless explicitly overridden.
    if (PRESERVED.has(stage)) continue;

    if (ARTIFACT_STAGES.has(stage)) {
      const artifact = profile.artifactLocale;
      if (artifact != null && !OVERRIDE_VALUES.has(artifact)) {
        throw new Error(`Unsupported artifact locale value in ${layer}: ${artifact}`);
      }
      if (artifact && artifact !== 'inherit') return artifact;
    }

    assertLocale(profile.workflowLocale, `${layer}.workflowLocale`);
    if (profile.workflowLocale) return profile.workflowLocale;
  }
  return PRESERVED.has(stage) ? 'preserve-original' : 'en-US';
}

const INSTRUCTIONS = {
  'zh-TW': [
    '在遵守適用的安全、工具與專案規範前提下，以繁體中文（臺灣用語）撰寫面向使用者的自然語言內容。',
    '保留程式碼、CLI 命令、參數、檔案路徑、識別字、JSON 欄位、API 契約、測試快照、引文與原始 Log。',
    'Skill／AGENTS.md／CLAUDE.md 的原始操作內容不得被翻譯後取代；只將可翻譯的執行說明與摘要使用繁體中文。',
    '如無法遵守語言偏好，說明原因；不得捏造已修改的外部 Harness System Prompt。',
  ].join(' '),
  'en-US': [
    'Use English for user-facing narrative while following all applicable safety, tool and project instructions.',
    'Preserve code, commands, arguments, paths, identifiers, API/JSON keys, test fixtures, quotes and raw logs exactly.',
    'Do not rewrite operational source material of skills, AGENTS.md or CLAUDE.md for localization.',
    'Describe unsupported locale behavior accurately; never claim to control opaque external agent prompts.',
  ].join(' '),
};

export function languageOverlay(scopes, stage) {
  const locale = effectiveLanguage(scopes, stage);
  if (locale === 'preserve-original') {
    return { locale, instruction: '', status: 'no-rewrite', policyVersion: POLICY_VERSION };
  }
  return { locale, instruction: INSTRUCTIONS[locale], status: 'preference-only', policyVersion: POLICY_VERSION };
}

/** Preserve source bytes; attach a separate language preference only. */
export function skillContext(scopes, skillSource) {
  if (typeof skillSource !== 'string') throw new TypeError('Skill source must be a string');
  return {
    source: skillSource,
    overlay: languageOverlay(scopes, 'skillExplanation'),
    mutatesSource: false,
  };
}

/**
 * Language support must be learned from the adapter, not inferred from a profile.
 * The four states describe whether the instruction was legitimately delivered,
 * not how well a model follows it.
 */
export function languageCapability(adapter) {
  if (adapter?.ownedPromptComposer === true) return 'owned';
  if (adapter?.acceptsLocaleInstructions === true) return 'confirmed';
  if (adapter?.supportsUserPrompt === true) return 'best-effort';
  return 'unsupported';
}
