import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { de } from "./locales/de";
import { en } from "./locales/en";

/** English is the default and reference language; other languages are community translations. */
export type MessageKey = keyof typeof en;
export type Locale = "en" | "de";
const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, de };
export const LOCALES: { id: Locale; name: string }[] = [
  { id: "en", name: "English" },
  { id: "de", name: "Deutsch" },
];

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;
const I18n = createContext<{ t: Translate; locale: Locale; setLocale: (l: Locale) => void }>({ t: (k) => en[k], locale: "en", setLocale: () => {} });

function initial(): Locale {
  const stored = localStorage.getItem("lotse.locale");
  if (stored === "en" || stored === "de") return stored;
  return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initial);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo(() => {
    const t: Translate = (key, vars) => {
      const text = dictionaries[locale][key] ?? en[key] ?? key;
      return vars ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`)) : text;
    };
    const setLocale = (next: Locale) => {
      localStorage.setItem("lotse.locale", next);
      setLocaleState(next);
    };
    return { t, locale, setLocale };
  }, [locale]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export const useI18n = () => useContext(I18n);
export const useT = () => useContext(I18n).t;
