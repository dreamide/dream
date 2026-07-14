import type { AppLocale } from "./config";
import de from "./messages/de.json";
import en from "./messages/en.json";
import es from "./messages/es.json";
import fr from "./messages/fr.json";
import it from "./messages/it.json";
import ja from "./messages/ja.json";
import ko from "./messages/ko.json";
import pt from "./messages/pt.json";
import vi from "./messages/vi.json";
import zhHans from "./messages/zh-Hans.json";
import zhHant from "./messages/zh-Hant.json";
import { supplementalMessages } from "./supplemental-messages";

type MessageObject = Record<string, unknown>;

const isMessageObject = (value: unknown): value is MessageObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mergeMessages = <Base extends MessageObject, Extra extends MessageObject>(
  base: Base,
  extra: Extra,
): Base & Extra => {
  const merged: MessageObject = { ...base };

  for (const [key, value] of Object.entries(extra)) {
    const baseValue = merged[key];
    merged[key] =
      isMessageObject(baseValue) && isMessageObject(value)
        ? mergeMessages(baseValue, value)
        : value;
  }

  return merged as Base & Extra;
};

export const messages = {
  de: mergeMessages(de, supplementalMessages.de),
  en: mergeMessages(en, supplementalMessages.en),
  es: mergeMessages(es, supplementalMessages.es),
  fr: mergeMessages(fr, supplementalMessages.fr),
  it: mergeMessages(it, supplementalMessages.it),
  ja: mergeMessages(ja, supplementalMessages.ja),
  ko: mergeMessages(ko, supplementalMessages.ko),
  pt: mergeMessages(pt, supplementalMessages.pt),
  vi: mergeMessages(vi, supplementalMessages.vi),
  "zh-Hans": mergeMessages(zhHans, supplementalMessages["zh-Hans"]),
  "zh-Hant": mergeMessages(zhHant, supplementalMessages["zh-Hant"]),
} satisfies Record<AppLocale, MessageObject>;
