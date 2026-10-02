import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getDesktopApi } from "@/lib/electron";
import type { HostPromptEvent } from "@/types/ide";
import { useIdeStore } from "../ide-store";

/**
 * What ssh asks while connecting an SSH host (a password, a 2FA code, "trust
 * this host key?"), one question at a time. Closing the dialog declines,
 * which fails that connection attempt.
 */
export const SshPromptDialog = () => {
  const t = useTranslations("sshHosts");
  const sshHosts = useIdeStore((state) => state.settings.sshHosts);
  const [queue, setQueue] = useState<HostPromptEvent[]>([]);
  const [answer, setAnswer] = useState("");

  useEffect(
    () =>
      getDesktopApi()?.onHostPrompt((prompt) =>
        setQueue((current) => [...current, prompt]),
      ),
    [],
  );

  const prompt = queue[0] ?? null;
  const hostLabel =
    sshHosts.find((host) => host.id === prompt?.hostId)?.label ??
    prompt?.target ??
    "ssh";

  const respond = (value: string | null) => {
    if (!prompt) return;
    getDesktopApi()?.answerHostPrompt(prompt.promptId, value);
    setAnswer("");
    setQueue((current) => current.slice(1));
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) respond(null);
      }}
      open={prompt !== null}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {prompt?.kind === "confirm"
              ? t("promptConfirmTitle")
              : t("promptTitle", { host: hostLabel })}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words font-mono text-xs">
            {prompt?.message}
          </DialogDescription>
        </DialogHeader>
        {prompt?.kind === "confirm" ? (
          <DialogFooter>
            <Button onClick={() => respond("no")} variant="ghost">
              {t("no")}
            </Button>
            <Button onClick={() => respond("yes")}>{t("yes")}</Button>
          </DialogFooter>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              respond(answer);
            }}
          >
            <Input
              autoComplete="off"
              autoFocus
              onChange={(event) => setAnswer(event.target.value)}
              placeholder={t("promptAnswer")}
              type="password"
              value={answer}
            />
            <DialogFooter>
              <Button
                onClick={() => respond(null)}
                type="button"
                variant="ghost"
              >
                {t("cancel")}
              </Button>
              <Button type="submit">{t("submit")}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};
