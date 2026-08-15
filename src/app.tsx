import { NextIntlClientProvider } from "next-intl";
import { useEffect, useState } from "react";
import { IdeShell } from "@/components/ide/ide-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { type AppLocale, DEFAULT_LOCALE } from "@/i18n/config";
import { loadMessages } from "@/i18n/messages";
import { useIdeStore } from "./components/ide/ide-store";

export const App = () => {
  const locale = useIdeStore((s) => s.settings.locale);
  const [loadedMessages, setLoadedMessages] = useState<{
    locale: AppLocale;
    messages: Record<string, unknown>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    void loadMessages(locale)
      .then((messages) => ({ locale, messages }))
      .catch(async () => ({
        locale: DEFAULT_LOCALE,
        messages: await loadMessages(DEFAULT_LOCALE),
      }))
      .then((loadedLocale) => {
        if (!cancelled) {
          setLoadedMessages(loadedLocale);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [locale]);

  useEffect(() => {
    if (loadedMessages) {
      document.documentElement.lang = loadedMessages.locale;
    }
  }, [loadedMessages]);

  if (!loadedMessages) {
    return null;
  }

  return (
    <NextIntlClientProvider
      locale={loadedMessages.locale}
      messages={loadedMessages.messages}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        disableTransitionOnChange
        enableSystem
        storageKey="dream-theme"
      >
        <IdeShell />
      </ThemeProvider>
    </NextIntlClientProvider>
  );
};
