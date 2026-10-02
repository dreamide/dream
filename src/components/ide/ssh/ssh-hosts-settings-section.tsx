import { Pencil, Plug, PlugZap, Plus, Server, Trash2 } from "lucide-react";
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

type HostFormValues = Pick<SshHostConfig, "label" | "target" | "hostCommand">;

const EMPTY_FORM: HostFormValues = { hostCommand: "", label: "", target: "" };

/** How to reach a host: adding one, or editing one in place. */
const SshHostForm = ({
  idPrefix,
  initial,
  onCancel,
  onSave,
}: {
  idPrefix: string;
  initial: HostFormValues;
  onCancel: () => void;
  onSave: (values: HostFormValues) => void;
}) => {
  const t = useTranslations("sshHosts");
  const [label, setLabel] = useState(initial.label);
  const [target, setTarget] = useState(initial.target);
  const [hostCommand, setHostCommand] = useState(initial.hostCommand);

  return (
    <form
      className="grid gap-3 px-4 py-3"
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
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-target`}>{t("target")}</Label>
        <Input
          autoFocus
          id={`${idPrefix}-target`}
          onChange={(event) => setTarget(event.target.value)}
          placeholder={t("targetPlaceholder")}
          value={target}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-label`}>{t("name")}</Label>
        <Input
          id={`${idPrefix}-label`}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={target.trim() || t("targetPlaceholder")}
          value={label}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-command`}>{t("hostCommand")}</Label>
        <Input
          id={`${idPrefix}-command`}
          onChange={(event) => setHostCommand(event.target.value)}
          placeholder={t("hostCommandPlaceholder")}
          value={hostCommand}
        />
        <span className="text-muted-foreground text-xs">
          {t("hostCommandHint")}
        </span>
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} type="button" variant="ghost">
          {t("cancel")}
        </Button>
        <Button disabled={!target.trim()} type="submit">
          {t("save")}
        </Button>
      </div>
    </form>
  );
};

/**
 * Settings > SSH hosts: the machines projects can live on. Adding one only
 * records how to reach it; connecting runs ssh (prompts appear in a dialog)
 * and starts or reuses Dream's host there. Editing keeps the host (and its
 * projects); a live connection reconnects when how it is reached changed.
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
  const updateSshHost = useIdeStore((state) => state.updateSshHost);

  // "new" while adding, a host's id while editing it, or null.
  const [editing, setEditing] = useState<string | null>(null);
  const adding = editing === "new";

  const addHost = (values: HostFormValues) => {
    const host: SshHostConfig = { ...values, id: crypto.randomUUID() };
    setSettings((previous) => ({
      ...previous,
      sshHosts: [...previous.sshHosts, host],
    }));
    setEditing(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium text-base">{t("settingsTitle")}</h3>
          <p className="text-muted-foreground text-sm">
            {t("settingsDescription")}
          </p>
        </div>
        <Button
          disabled={editing !== null}
          onClick={() => setEditing("new")}
          size="sm"
          type="button"
        >
          <Plus className="size-4" />
          {t("add")}
        </Button>
      </div>
      <SettingsGroup>
        {sshHosts.length === 0 && !adding ? (
          <div className="px-4 py-3 text-muted-foreground text-sm">
            {t("noHosts")}
          </div>
        ) : null}
        {sshHosts.map((host) => {
          if (editing === host.id) {
            return (
              <SshHostForm
                idPrefix={`ssh-host-${host.id}`}
                initial={host}
                key={host.id}
                onCancel={() => setEditing(null)}
                onSave={(values) => {
                  setEditing(null);
                  void updateSshHost(host.id, values);
                }}
              />
            );
          }
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
                </div>
                {runtime?.error ? (
                  <div className="mt-1 select-text whitespace-pre-wrap break-words text-destructive text-xs">
                    {runtime.error}
                  </div>
                ) : null}
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
                aria-label={t("edit")}
                disabled={editing !== null}
                onClick={() => setEditing(host.id)}
                size="icon-sm"
                title={t("edit")}
                variant="ghost"
              >
                <Pencil className="size-3.5" />
              </Button>
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
          <SshHostForm
            idPrefix="ssh-host-new"
            initial={EMPTY_FORM}
            onCancel={() => setEditing(null)}
            onSave={addHost}
          />
        ) : null}
      </SettingsGroup>
    </div>
  );
};
