import type { AppLocale } from "./config";
import type { Messages } from "./messages";

declare module "next-intl" {
  interface AppConfig {
    Locale: AppLocale;
    Messages: Messages;
  }
}
