/**
 * Host-owned language preferences. The profile can only influence output language,
 * never tool permissions, source code, logs or vendor-owned system instructions.
 *
 * Aligned with docs/architecture/language-policy.md in the pending research PR #19.
 */
export const SUPPORTED_LOCALES = ['zh-TW', 'en-US'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type OutputLocale = Locale | 'inherit' | 'preserve-original';
export type OutputStage =
  | 'conversation' | 'plan' | 'review' | 'issue' | 'pullRequest'
  | 'commitMessage' | 'documentation' | 'codeComments'
  | 'sessionSummary' | 'notification' | 'skillExplanation';
export type Role = 'executor' | 'explorer' | 'advisor' | 'reviewer' | 'progress';

export interface LanguageProfile {
  uiLocale?: Locale;
  workflowLocale?: Locale;
  artifactLocale?: OutputLocale;
  outputs?: Partial<Record<OutputStage, OutputLocale>>;
}
export interface LanguageSettings {
  version: 1;
  global: LanguageProfile;
  projects: Record<string, LanguageProfile>;
  sessions: Record<string, LanguageProfile>;
}
export interface LanguageScope {
  projectId?: string;
  sessionId?: string;
  task?: LanguageProfile;
}
export type EffectiveLocale = Locale | 'preserve-original';

const ARTIFACT_STAGES = new Set<OutputStage>([
  'issue', 'pullRequest', 'commitMessage', 'documentation', 'codeComments',
]);
const OUTPUT_STAGES: ReadonlySet<string> = new Set([
  'conversation', 'plan', 'review', 'issue', 'pullRequest',
  'commitMessage', 'documentation', 'codeComments',
  'sessionSummary', 'notification', 'skillExplanation',
]);
const LANGUAGE_VERSION = 'agentdock-language-v1';
export const STORAGE_KEY = 'agentdock.language.v1';

export const DEFAULT_SETTINGS: LanguageSettings = {
  version: 1,
  global: {
    uiLocale: 'zh-TW',
    workflowLocale: 'zh-TW',
    artifactLocale: 'inherit',
    outputs: { commitMessage: 'en-US', codeComments: 'preserve-original' },
  },
  projects: {},
  sessions: {},
};

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-TW' || value === 'en-US';
}
function isOutputLocale(value: unknown): value is OutputLocale {
  return isLocale(value) || value === 'inherit' || value === 'preserve-original';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject malformed saved preferences rather than trusting unvalidated LocalStorage. */
function sanitizeProfile(value: unknown): LanguageProfile {
  if (!isRecord(value)) return {};
  const profile: LanguageProfile = {};
  if (isLocale(value.uiLocale)) profile.uiLocale = value.uiLocale;
  if (isLocale(value.workflowLocale)) profile.workflowLocale = value.workflowLocale;
  if (isOutputLocale(value.artifactLocale)) profile.artifactLocale = value.artifactLocale;
  if (isRecord(value.outputs)) {
    const outputs: NonNullable<LanguageProfile['outputs']> = {};
    for (const [key, locale] of Object.entries(value.outputs)) {
      if (OUTPUT_STAGES.has(key) && isOutputLocale(locale)) {
        Object.defineProperty(outputs, key, {
          value: locale, enumerable: true, writable: true, configurable: true,
        });
      }
    }
    profile.outputs = outputs;
  }
  return profile;
}

function sanitizeOverrides(value: unknown): Record<string, LanguageProfile> {
  const overrides: Record<string, LanguageProfile> = Object.create(null);
  if (!isRecord(value)) return overrides;
  // No arbitrary infinite mapping or special prototype property names; keep the newest entries.
  for (const [key, raw] of Object.entries(value).slice(-200)) {
    if (!key || key.length > 128 || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    Object.defineProperty(overrides, key, {
      value: sanitizeProfile(raw), enumerable: true, writable: true, configurable: true,
    });
  }
  return overrides;
}

export function parseSettings(value: unknown): LanguageSettings {
  if (!isRecord(value) || value.version !== 1) return structuredClone(DEFAULT_SETTINGS);
  const rawGlobal = sanitizeProfile(value.global);
  return {
    version: 1,
    global: {
      ...structuredClone(DEFAULT_SETTINGS.global),
      ...rawGlobal,
      outputs: { ...DEFAULT_SETTINGS.global.outputs, ...rawGlobal.outputs },
    },
    projects: sanitizeOverrides(value.projects),
    sessions: sanitizeOverrides(value.sessions),
  };
}

export function loadLanguageSettings(): LanguageSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? parseSettings(JSON.parse(raw) as unknown) : structuredClone(DEFAULT_SETTINGS);
  } catch {
    // WebView storage may be disabled or contain corrupt data.
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveLanguageSettings(settings: LanguageSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // A language preference must never break running tasks.
  }
}

export function resolveLocale(
  settings: LanguageSettings,
  stage: OutputStage,
  scope: LanguageScope = {},
): EffectiveLocale {
  const layers: (LanguageProfile | undefined)[] = [
    scope.task,
    scope.sessionId ? settings.sessions[scope.sessionId] : undefined,
    scope.projectId ? settings.projects[scope.projectId] : undefined,
    settings.global,
  ];

  // Resolve stage-specific and artifact preferences before falling back to a
  // workflow language. A session's workflow locale must not silently override
  // a project's generated-prose locale or the default commit-message policy.
  for (const profile of layers) {
    if (!profile) continue;
    const explicit = profile.outputs?.[stage];
    if (explicit && explicit !== 'inherit') return explicit;
    if (ARTIFACT_STAGES.has(stage) && stage !== 'codeComments'
        && profile.artifactLocale && profile.artifactLocale !== 'inherit') {
      return profile.artifactLocale;
    }
  }
  if (stage === 'codeComments') return 'preserve-original';
  for (const profile of layers) {
    if (profile?.workflowLocale) return profile.workflowLocale;
  }
  return 'zh-TW';
}

export function resolveUiLocale(settings: LanguageSettings): Locale {
  return settings.global.uiLocale ?? 'zh-TW';
}

export interface LanguagePolicySnapshot {
  version: string;
  workflowLocale: EffectiveLocale;
  artifactLocale: EffectiveLocale;
  source: 'task' | 'session' | 'project' | 'global';
}

export function languageSnapshot(settings: LanguageSettings, scope: LanguageScope = {}): LanguagePolicySnapshot {
  let source: LanguagePolicySnapshot['source'] = 'global';
  if (scope.task?.workflowLocale) source = 'task';
  else if (scope.sessionId && settings.sessions[scope.sessionId]?.workflowLocale) source = 'session';
  else if (scope.projectId && settings.projects[scope.projectId]?.workflowLocale) source = 'project';
  return {
    version: LANGUAGE_VERSION,
    workflowLocale: resolveLocale(settings, 'conversation', scope),
    artifactLocale: resolveLocale(settings, 'documentation', scope),
    source,
  };
}

const LANG_INSTRUCTIONS: Record<Locale, string> = {
  'zh-TW': '面向使用者的計畫、解釋、審查、Advisor、Subagent 摘要與敘述性產物，請使用臺灣繁體中文。保留程式碼、命令、檔案路徑、JSON 欄位、API 契約、原始 Log 與引用原文。Skill、AGENTS.md、CLAUDE.md 的操作步驟及安全／權限規範不得因語言切換而更動。',
  'en-US': 'Use US English for user-facing plans, explanations, reviews, advisor and subagent summaries, and prose artifacts. Preserve code, commands, file paths, JSON keys, API contracts, raw logs and quotations. Do not rewrite operational Skill, AGENTS.md, CLAUDE.md or security instructions merely to change output language.',
};

/**
 * This is an output-language *preference* for a host-owned prompt composer,
 * not a system-prompt override for Claude Code, Codex or other ACP runtimes.
 */
export function compileLanguageOverlay(settings: LanguageSettings, stage: OutputStage, scope: LanguageScope = {}) {
  const locale = resolveLocale(settings, stage, scope);
  return {
    locale,
    instruction: locale === 'preserve-original' ? '' : LANG_INSTRUCTIONS[locale],
    policyVersion: LANGUAGE_VERSION,
  };
}

/** Store the original Skill bytes verbatim, together with a separate output-language hint. */
export function skillContext(source: string, settings: LanguageSettings, scope: LanguageScope = {}) {
  if (typeof source !== 'string') throw new TypeError('Skill source must be a string');
  return { original: source, overlay: compileLanguageOverlay(settings, 'skillExplanation', scope), sourceUnchanged: true };
}

export type AdapterLanguageSupport = 'owned' | 'confirmed' | 'best-effort' | 'unsupported';
export function languageCapability(capabilities: {
  ownedPromptComposer?: boolean;
  acceptsLocaleInstructions?: boolean;
  supportsUserPrompt?: boolean;
}): AdapterLanguageSupport {
  if (capabilities.ownedPromptComposer) return 'owned';
  if (capabilities.acceptsLocaleInstructions) return 'confirmed';
  if (capabilities.supportsUserPrompt) return 'best-effort';
  return 'unsupported';
}
