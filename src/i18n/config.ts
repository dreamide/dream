import {
  APP_LOCALES,
  type AppLocale,
  DEFAULT_LOCALE,
  normalizeLocale,
  normalizeLocalePreference,
} from "../../electron/shared/locales.js";

export {
  APP_LOCALES,
  type AppLocale,
  DEFAULT_LOCALE,
  normalizeLocale,
  normalizeLocalePreference,
};

export const LOCALE_LABELS: Record<AppLocale, string> = {
  de: "Deutsch",
  en: "English",
  es: "Español",
  fr: "Français",
  it: "Italiano",
  ja: "日本語",
  ko: "한국어",
  pt: "Português",
  vi: "Tiếng Việt",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
};
