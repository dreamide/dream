import { Pencil, Plug, PlugZap, Plus, Server, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
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

/**
 * How to reach a host: adding one, or editing an existing one. Mount it only
 * while open, keyed by the host, so the form initialises from `initial`.
 */
const SshHostDialog = ({
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
  const editingHost =
    editing && editing !== "new"
      ? sshHosts.find((host) => host.id === editing)
      : undefined;

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
        <Button onClick={() => setEditing("new")} size="sm" type="button">
          <Plus className="size-4" />
          {t("add")}
        </Button>
      </div>
      <SettingsGroup>
        {sshHosts.length === 0 ? (
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
      </SettingsGroup>
      {editing === "new" ? (
        <SshHostDialog
          initial={EMPTY_FORM}
          isNew
          key="new"
          onCancel={() => setEditing(null)}
          onSave={addHost}
        />
      ) : editingHost ? (
        <SshHostDialog
          initial={editingHost}
          isNew={false}
          key={editingHost.id}
          onCancel={() => setEditing(null)}
          onSave={(values) => {
            setEditing(null);
            void updateSshHost(editingHost.id, values);
          }}
        />
      ) : null}
    </div>
  );
};
