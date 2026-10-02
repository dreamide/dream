import { Plug, PlugZap, Plus, Server, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { HostConnectionState, SshHostConfig } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { SettingsGroup } from "../settings/settings-shared";

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

/**
 * Settings > SSH hosts: the machines projects can live on. Adding one only
 * records how to reach it; connecting runs ssh (prompts appear in a dialog)
 * and starts or reuses Dream's host there.
 */
export const SshHostsSettingsSection = () => {
  const t = useTranslations("sshHosts");
  const stateLabel = useHostStateLabel();
  const sshHosts = useIdeStore((state) => state.settings.sshHosts);
  const hosts = useIdeStore((state) => state.hosts);
  const setSettings = useIdeStore((state) => state.setSettings);
  const connectHost = useIdeStore((state) => state.connectHost);
  const disconnectHost = useIdeStore((state) => state.disconnectHost);
  const removeSshHost = useIdeStore((state) => state.removeSshHost);

  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [hostCommand, setHostCommand] = useState("");

  const resetForm = () => {
    setAdding(false);
    setLabel("");
    setTarget("");
    setHostCommand("");
  };

  const handleSave = () => {
    const trimmedTarget = target.trim();
    if (!trimmedTarget) return;
    const host: SshHostConfig = {
      hostCommand: hostCommand.trim(),
      id: crypto.randomUUID(),
      label: label.trim() || trimmedTarget,
      target: trimmedTarget,
    };
    setSettings((previous) => ({
      ...previous,
      sshHosts: [...previous.sshHosts, host],
    }));
    resetForm();
  };

  return (
    <div className="space-y-4">
      <p className="px-4 text-muted-foreground text-sm">
        {t("settingsDescription")}
      </p>
      <SettingsGroup>
        {sshHosts.length === 0 && !adding ? (
          <div className="px-4 py-3 text-muted-foreground text-sm">
            {t("noHosts")}
          </div>
        ) : null}
        {sshHosts.map((host) => {
          const runtime = hosts[host.id];
          const connected =
            runtime?.state === "connected" || runtime?.state === "reconnecting";
          const busy = runtime?.state === "connecting";
          return (
            <div className="flex items-center gap-3 px-4 py-3" key={host.id}>
              <Server className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-sm">{host.label}</div>
                <div className="truncate text-muted-foreground text-xs">
                  {host.target} · {stateLabel(runtime?.state)}
                  {runtime?.error ? ` — ${runtime.error}` : ""}
                </div>
              </div>
              {connected ? (
                <Button
                  onClick={() => void disconnectHost(host.id)}
                  size="sm"
                  variant="outline"
                >
                  <Plug className="size-3.5" />
                  {t("disconnect")}
                </Button>
              ) : (
                <Button
                  disabled={busy}
                  onClick={() => void connectHost(host.id)}
                  size="sm"
                  variant="outline"
                >
                  <PlugZap className="size-3.5" />
                  {t("connect")}
                </Button>
              )}
              <Button
                aria-label={t("remove")}
                onClick={() => void removeSshHost(host.id)}
                size="icon-sm"
                title={t("remove")}
                variant="ghost"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          );
        })}
        {adding ? (
          <form
            className="grid gap-3 px-4 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              handleSave();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-host-target">{t("target")}</Label>
              <Input
                autoFocus
                id="ssh-host-target"
                onChange={(event) => setTarget(event.target.value)}
                placeholder={t("targetPlaceholder")}
                value={target}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-host-label">{t("name")}</Label>
              <Input
                id="ssh-host-label"
                onChange={(event) => setLabel(event.target.value)}
                placeholder={target.trim() || t("targetPlaceholder")}
                value={label}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-host-command">{t("hostCommand")}</Label>
              <Input
                id="ssh-host-command"
                onChange={(event) => setHostCommand(event.target.value)}
                placeholder={t("hostCommandPlaceholder")}
                value={hostCommand}
              />
              <span className="text-muted-foreground text-xs">
                {t("hostCommandHint")}
              </span>
            </div>
            <div className="flex justify-end gap-2">
              <Button onClick={resetForm} type="button" variant="ghost">
                {t("cancel")}
              </Button>
              <Button disabled={!target.trim()} type="submit">
                {t("save")}
              </Button>
            </div>
          </form>
        ) : null}
      </SettingsGroup>
      {adding ? null : (
        <Button onClick={() => setAdding(true)} variant="outline">
          <Plus className="size-4" />
          {t("add")}
        </Button>
      )}
    </div>
  );
};
