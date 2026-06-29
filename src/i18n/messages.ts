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

export const messages: Record<AppLocale, typeof en> = {
  de,
  en,
  es,
  fr,
  it,
  ja,
  ko,
  pt,
  vi,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
};
