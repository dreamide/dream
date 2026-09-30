import type { AppLocale } from "./config";
import type en from "./messages/en.json";

/**
 * Every UI string, keyed by namespace. English is the source of truth: each
 * other locale's file must have exactly its keys, which the loader's type
 * below enforces at compile time (a missing key fails `tsc`) and
 * `messages.test.ts` enforces at test time (along with extra keys and ICU
 * argument names).
 */
export type Messages = typeof en;

const localeMessageLoaders: Record<
  AppLocale,
  () => Promise<{ default: Messages }>
> = {
  de: () => import("./messages/de.json"),
  en: () => import("./messages/en.json"),
  es: () => import("./messages/es.json"),
  fr: () => import("./messages/fr.json"),
  it: () => import("./messages/it.json"),
  ja: () => import("./messages/ja.json"),
  ko: () => import("./messages/ko.json"),
  pt: () => import("./messages/pt.json"),
  vi: () => import("./messages/vi.json"),
  "zh-Hans": () => import("./messages/zh-Hans.json"),
  "zh-Hant": () => import("./messages/zh-Hant.json"),
};

const messageCache = new Map<AppLocale, Promise<Messages>>();

export const loadMessages = (locale: AppLocale): Promise<Messages> => {
  const cached = messageCache.get(locale);
  if (cached) {
    return cached;
  }

  const messagesPromise = localeMessageLoaders[locale]().then(
    (module) => module.default,
  );
  messageCache.set(locale, messagesPromise);
  return messagesPromise;
};
