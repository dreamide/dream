import { NextIntlClientProvider } from "next-intl";
import { useEffect, useState } from "react";
import { IdeShell } from "@/components/ide/ide-shell";
import { PairingScreen } from "@/components/remote/pairing-screen";
import { ThemeProvider } from "@/components/theme-provider";
import { type AppLocale, DEFAULT_LOCALE } from "@/i18n/config";
import { loadMessages, type Messages } from "@/i18n/messages";
import { getClientPlatform } from "@/lib/connections/platform";
import { useConnectionState } from "@/lib/connections/use-connection-state";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { useIdeStore } from "./components/ide/ide-store";

/**
 * A browser client pairs before it shows the IDE, whenever its home host
 * refuses it (never paired, or its session revoked or expired). The
 * desktop never pairs.
 */
const useNeedsPairing = () => {
  const platform = getClientPlatform();
  const home = useConnectionState(LOCAL_HOST_ID);
  return platform.kind === "web" && home.status === "unauthorized";
};

export const App = () => {
  const locale = useIdeStore((s) => s.settings.locale);
  const needsPairing = useNeedsPairing();
  const [loadedMessages, setLoadedMessages] = useState<{
    locale: AppLocale;
    messages: Messages;
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
        {needsPairing ? (
          <PairingScreen host={getClientPlatform().homeLabel} />
        ) : (
          <IdeShell />
        )}
      </ThemeProvider>
    </NextIntlClientProvider>
  );
};
