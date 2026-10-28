/**
 * What a browser client shows until it is paired with the host serving it
 * (or after its session was revoked): pair by the link it was opened with,
 * or by a short code someone on the host confirms by this device's name.
 */
import { Link2, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { dismissBootScreen } from "@/lib/boot-screen";
import {
  describeThisDevice,
  type PairingClaim,
  pairWithLink,
  pollPairingClaim,
  requestPairingWithCode,
  restartPaired,
  takePairingFromLocation,
} from "@/lib/connections/pairing";

const POLL_MS = 2_000;

const errorText = (error: unknown) =>
  error instanceof Error && error.message ? error.message : null;

type Phase =
  | { kind: "form" }
  | { kind: "linking" }
  | { kind: "waiting"; claim: PairingClaim }
  | { kind: "paired" };

export const PairingScreen = ({ host }: { host: string }) => {
  const t = useTranslations("remote");
  // Read (and removed from the address bar) once, before anything renders.
  const [linkSecret] = useState(takePairingFromLocation);
  const [phase, setPhase] = useState<Phase>(() =>
    linkSecret ? { kind: "linking" } : { kind: "form" },
  );
  const [deviceName, setDeviceName] = useState(describeThisDevice);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const exchanged = useRef(false);

  useEffect(dismissBootScreen, []);

  // A pairing link: exchanged at once (it works once; StrictMode's second
  // effect must not spend it again).
  useEffect(() => {
    if (!linkSecret || exchanged.current) return;
    exchanged.current = true;
    void pairWithLink(linkSecret, describeThisDevice())
      .then(() => {
        setPhase({ kind: "paired" });
        restartPaired();
      })
      .catch((failure: unknown) => {
        setError(errorText(failure) ?? t("pairFailed"));
        setPhase({ kind: "form" });
      });
  }, [linkSecret, t]);

  // A code request: polled until someone on the host answers it.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        if ((await pollPairingClaim(phase.claim)) === "confirmed") {
          if (stopped) return;
          setPhase({ kind: "paired" });
          restartPaired();
          return;
        }
        if (!stopped) timer = setTimeout(poll, POLL_MS);
      } catch (failure) {
        if (stopped) return;
        setError(errorText(failure) ?? t("pairFailed"));
        setPhase({ kind: "form" });
      }
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [phase, t]);

  const submitCode = async () => {
    if (!code.trim() || !deviceName.trim()) return;
    setError(null);
    try {
      const claim = await requestPairingWithCode(code, deviceName.trim());
      setPhase({ kind: "waiting", claim });
    } catch (failure) {
      setError(errorText(failure) ?? t("pairFailed"));
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-50 px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground dark:bg-surface-900">
      <div className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            {phase.kind === "form" ? (
              <Smartphone className="size-5" />
            ) : (
              <Link2 className="size-5" />
            )}
          </div>
          <h1 className="font-semibold text-lg">{t("pairTitle")}</h1>
          <p className="text-muted-foreground text-sm">
            {t("pairDescription", { host })}
          </p>
        </div>

        {phase.kind === "linking" || phase.kind === "paired" ? (
          <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            {t("pairing")}
          </div>
        ) : phase.kind === "waiting" ? (
          <div className="flex flex-col items-center gap-3 text-center text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-4" />
              {t("waitingForConfirm", { device: deviceName.trim() })}
            </div>
            <Button
              onClick={() => setPhase({ kind: "form" })}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("cancel")}
            </Button>
          </div>
        ) : (
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
            <Button disabled={!code.trim() || !deviceName.trim()} type="submit">
              {t("pair")}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
};
