import { createContext, useContext, useMemo, useState } from 'react'
import de from '../i18n/locales/de'
import en from '../i18n/locales/en'

export type Language = 'de' | 'en'

interface I18nContextValue {
  language: Language
  setLanguage: (language: Language) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const I18N_STORAGE_KEY = 'ui-language'

const dictionaries: Record<Language, Record<string, string>> = {
  de,
  en,
}

const I18nContext = createContext<I18nContextValue>({
  language: 'de',
  setLanguage: () => undefined,
  t: (key: string) => key,
})

function getInitialLanguage(): Language {
  if (typeof window === 'undefined') return 'de'
  const stored = window.localStorage.getItem(I18N_STORAGE_KEY)
  if (stored === 'de' || stored === 'en') return stored
  const browserLanguage = window.navigator.language.toLowerCase()
  return browserLanguage.startsWith('de') ? 'de' : 'en'
}

function interpolate(template: string, vars?: Record<string, string | number>) {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? `{${key}}`))
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>(getInitialLanguage)

  const value = useMemo<I18nContextValue>(() => ({
    language,
    setLanguage: (nextLanguage: Language) => {
      setLanguageState(nextLanguage)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(I18N_STORAGE_KEY, nextLanguage)
      }
    },
    t: (key: string, vars?: Record<string, string | number>) => {
      const selected = dictionaries[language][key] ?? key
      return interpolate(selected, vars)
    },
  }), [language])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}