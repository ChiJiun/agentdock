import { createContext, useContext, type ReactNode } from 'react';
import { t, type MessageKey } from './messages';
import type { Locale } from './language';

const LanguageContext = createContext<Locale>('zh-TW');

export function LanguageProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LanguageContext.Provider value={locale}>{children}</LanguageContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LanguageContext);
}
export function useT(): (key: MessageKey, vars?: Record<string, string | number>) => string {
  const locale = useLocale();
  return (key, vars) => t(locale, key, vars);
}
