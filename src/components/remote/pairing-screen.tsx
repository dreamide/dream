/**
 * What a browser client shows until it is paired with the host serving it
 * (or after its session was revoked): a short code created on the host,
 * redeemed at once.
 */
import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { dismissBootScreen } from "@/lib/boot-screen";
import {
  describeThisDevice,
  pairWithCode,
  restartPaired,
} from "@/lib/connections/pairing";

const errorText = (error: unknown) =>
  error instanceof Error && error.message ? error.message : null;

export const PairingScreen = ({ host }: { host: string }) => {
  const t = useTranslations("remote");
  const [deviceName, setDeviceName] = useState(describeThisDevice);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(dismissBootScreen, []);

  const submitCode = async () => {
    if (!code.trim() || !deviceName.trim() || busy) return;
    setError(null);
    setBusy(true);
    try {
      await pairWithCode(code, deviceName.trim());
      restartPaired();
    } catch (failure) {
      setError(errorText(failure) ?? t("pairFailed"));
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-50 px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground dark:bg-surface-900">
      <div className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <KeyRound className="size-5" />
          </div>
          <h1 className="font-semibold text-lg">{t("pairTitle")}</h1>
          <p className="text-muted-foreground text-sm">
            {t("pairDescription", { host })}
          </p>
        </div>

        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCode();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="pair-code">{t("codeLabel")}</Label>
            <Input
              autoCapitalize="characters"
              autoComplete="one-time-code"
              autoCorrect="off"
              className="font-mono tracking-widest"
              id="pair-code"
              inputMode="text"
              onChange={(event) => setCode(event.target.value)}
              placeholder="ABCD-EFGH"
              spellCheck={false}
              value={code}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pair-device">{t("deviceNameLabel")}</Label>
            <Input
              id="pair-device"
              onChange={(event) => setDeviceName(event.target.value)}
              value={deviceName}
            />
            <span className="text-muted-foreground text-xs">
              {t("deviceNameHint")}
            </span>
          </div>
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            disabled={busy || !code.trim() || !deviceName.trim()}
            type="submit"
          >
            {busy ? (
              <>
                <Spinner className="size-4" />
                {t("pairing")}
              </>
            ) : (
              t("pair")
            )}
          </Button>
        </form>
      </div>
    </div>
  );
};
