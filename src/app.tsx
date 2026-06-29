import { NextIntlClientProvider } from "next-intl";
import { useEffect } from "react";
import { IdeShell } from "@/components/ide/ide-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { messages } from "@/i18n/messages";
import { useIdeStore } from "./components/ide/ide-store";

export const App = () => {
  const locale = useIdeStore((s) => s.settings.locale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <NextIntlClientProvider locale={locale} messages={messages[locale]}>
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
