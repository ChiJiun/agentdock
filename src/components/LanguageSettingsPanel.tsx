import { useEffect, useRef, useState } from 'react';
import { Globe2, ShieldCheck, X } from 'lucide-react';
import { useT } from '../i18n/context';
import {
  type LanguageProfile, type LanguageSettings, type Locale, type OutputLocale,
} from '../i18n/language';

type OverrideScope = 'global' | 'project' | 'session';
const localeOptions: Locale[] = ['zh-TW', 'en-US'];

export function LanguageSettingsPanel({
  settings,
  onChange,
  projectId,
  sessionId,
  onClose,
}: {
  settings: LanguageSettings;
  onChange: (settings: LanguageSettings) => void;
  projectId: string;
  sessionId?: string;
  onClose: () => void;
}) {
  const tr = useT();
  const [scope, setScope] = useState<OverrideScope>('global');
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
  }, [onClose]);

  const activeProfile: LanguageProfile =
    scope === 'global' ? settings.global
      : scope === 'project' ? settings.projects[projectId] ?? {}
        : (sessionId && settings.sessions[sessionId]) || {};

  function updateProfile(patch: Partial<LanguageProfile>) {
    const profile = { ...activeProfile, ...patch };
    if (scope === 'global') onChange({ ...settings, global: profile });
    else if (scope === 'project') {
      onChange({ ...settings, projects: { ...settings.projects, [projectId]: profile } });
    } else if (sessionId) {
      onChange({ ...settings, sessions: { ...settings.sessions, [sessionId]: profile } });
    }
  }

  function optionLabel(value: Locale): string {
    return tr(value === 'zh-TW' ? 'language.chinese' : 'language.english');
  }

  return <section className="language-panel" role="dialog" aria-label={tr('language.panelTitle')} aria-modal="false">
    <div className="language-panel-header">
      <span><Globe2 size={16} /> {tr('language.panelTitle')}</span>
      <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label={tr('language.close')}><X size={16}/></button>
    </div>
    <div className="language-fields">
      <label htmlFor="ui-locale">{tr('language.ui')}</label>
      <select id="ui-locale" value={settings.global.uiLocale ?? 'zh-TW'} onChange={event => onChange({ ...settings, global: { ...settings.global, uiLocale: event.target.value as Locale } })}>
        {localeOptions.map(locale => <option key={locale} value={locale}>{optionLabel(locale)}</option>)}
      </select>

      <label htmlFor="language-scope">{tr('language.scope')}</label>
      <select id="language-scope" value={scope} onChange={event => setScope(event.target.value as OverrideScope)}>
        <option value="global">{tr('language.global')}</option>
        <option value="project">{tr('language.project')}</option>
        {sessionId && <option value="session">{tr('language.session')}</option>}
      </select>

      <label htmlFor="workflow-locale">{tr('language.workflow')}</label>
      <select
        id="workflow-locale"
        value={activeProfile.workflowLocale ?? 'inherit'}
        onChange={event => updateProfile({ workflowLocale: event.target.value === 'inherit' ? undefined : event.target.value as Locale })}
      >
        {scope !== 'global' && <option value="inherit">{tr('language.clear')}</option>}
        {localeOptions.map(locale => <option key={locale} value={locale}>{optionLabel(locale)}</option>)}
      </select>
      <small>{tr('language.workflowHint')}</small>

      <label htmlFor="artifact-locale">{tr('language.artifacts')}</label>
      <select
        id="artifact-locale"
        value={activeProfile.artifactLocale ?? 'inherit'}
        onChange={event => updateProfile({ artifactLocale: event.target.value as OutputLocale })}
      >
        <option value="inherit">{tr('language.inherit')}</option>
        {localeOptions.map(locale => <option key={locale} value={locale}>{optionLabel(locale)}</option>)}
      </select>
      <small>{tr('language.artifactHint')}</small>
    </div>
    <div className="language-panel-footer">
      <div><ShieldCheck size={14} /> {tr('language.unsupported')}</div>
      <p>{tr('language.original')}</p>
    </div>
  </section>;
}
