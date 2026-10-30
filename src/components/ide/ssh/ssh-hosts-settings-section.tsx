import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getDesktopApi } from "@/lib/electron";
import type { HostConnectionState, SshHostConfig } from "@/types/ide";
import { useIdeStore } from "../ide-store";

const STATE_MESSAGE_KEYS: Record<
  HostConnectionState,
  | "stateIdle"
  | "stateConnecting"
  | "stateConnected"
  | "stateReconnecting"
  | "stateDisconnected"
  | "stateFailed"
> = {
  connected: "stateConnected",
  connecting: "stateConnecting",
  disconnected: "stateDisconnected",
  failed: "stateFailed",
  idle: "stateIdle",
  reconnecting: "stateReconnecting",
};

/** One host's connection state as a short line, with its error if any. */
export const useHostStateLabel = () => {
  const t = useTranslations("sshHosts");
  return (state: HostConnectionState | undefined) =>
    t(STATE_MESSAGE_KEYS[state ?? "idle"]);
};

export type HostFormValues = Pick<
  SshHostConfig,
  "label" | "target" | "hostCommand"
>;

export const EMPTY_HOST_FORM: HostFormValues = {
  hostCommand: "",
  label: "",
  target: "",
};

/** Suggested aliases shown at most, beside the target field. */
const SSH_CONFIG_SUGGESTION_LIMIT = 8;

/**
 * The aliases in the user's ssh config not already saved as a host, to
 * suggest as targets. Empty outside the desktop.
 */
const useSshConfigSuggestions = (enabled: boolean) => {
  const savedTargets = useIdeStore((state) => state.settings.sshHosts);
  const [aliases, setAliases] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getDesktopApi()
      ?.listSshConfigHosts()
      .then((hosts) => {
        if (!cancelled) setAliases(hosts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return aliases
    .filter((alias) => !savedTargets.some((host) => host.target === alias))
    .slice(0, SSH_CONFIG_SUGGESTION_LIMIT);
};

/** Saves a new SSH host in settings; returns it. */
export const useAddSshHost = () => {
  const setSettings = useIdeStore((state) => state.setSettings);
  return (values: HostFormValues) => {
    const host: SshHostConfig = { ...values, id: crypto.randomUUID() };
    setSettings((previous) => ({
      ...previous,
      sshHosts: [...previous.sshHosts, host],
    }));
    return host;
  };
};

/**
 * How to reach a host: adding one, or editing an existing one. Mount it only
 * while open, keyed by the host, so the form initialises from `initial`.
 * A new host is offered the aliases in the user's ssh config.
 */
export const SshHostDialog = ({
  initial,
  isNew,
  onCancel,
  onSave,
}: {
  initial: HostFormValues;
  isNew: boolean;
  onCancel: () => void;
  onSave: (values: HostFormValues) => void;
}) => {
  const t = useTranslations("sshHosts");
  const [label, setLabel] = useState(initial.label);
  const [target, setTarget] = useState(initial.target);
  const [hostCommand, setHostCommand] = useState(initial.hostCommand);
  const suggestions = useSshConfigSuggestions(isNew);

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
      open
    >
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmedTarget = target.trim();
            if (!trimmedTarget) return;
            onSave({
              hostCommand: hostCommand.trim(),
              label: label.trim() || trimmedTarget,
              target: trimmedTarget,
            });
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base leading-6">
              {isNew ? t("add") : t("editHost")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="ssh-host-target">{t("target")}</Label>
            <Input
              autoFocus
              id="ssh-host-target"
              onChange={(event) => setTarget(event.target.value)}
              placeholder={t("targetPlaceholder")}
              value={target}
            />
            {suggestions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground text-xs">
                  {t("fromSshConfig")}
                </span>
                {suggestions.map((alias) => (
                  <Button
                    className="font-mono"
                    key={alias}
                    onClick={() => setTarget(alias)}
                    size="xs"
                    type="button"
                    variant={alias === target.trim() ? "secondary" : "outline"}
                  >
                    {alias}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="ssh-host-label">{t("name")}</Label>
            <Input
              id="ssh-host-label"
              onChange={(event) => setLabel(event.target.value)}
              placeholder={target.trim() || t("targetPlaceholder")}
              value={label}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ssh-host-command">{t("hostCommand")}</Label>
            <Input
              id="ssh-host-command"
              onChange={(event) => setHostCommand(event.target.value)}
              placeholder={t("hostCommandPlaceholder")}
              value={hostCommand}
            />
            <p className="text-muted-foreground text-xs">
              {t("hostCommandHint")}
            </p>
          </div>
          <DialogFooter>
            <Button onClick={onCancel} type="button" variant="outline">
              {t("cancel")}
            </Button>
            <Button disabled={!target.trim()} type="submit">
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export { ConnectionsSettingsSection as SshHostsSettingsSection } from "./connections-settings-section";
