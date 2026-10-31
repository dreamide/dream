/**
 * The one way to open a folder as a project: pick where it is (this
 * computer, or an SSH host on the desktop), then type its path with the
 * folders that could come next listed from that host. An SSH host is
 * connected as soon as it is picked. On the desktop's own computer the
 * system's folder picker is offered too.
 */
import { FolderOpen, PlugZap, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { apiClient, getApiErrorMessage } from "@/lib/api-client";
import { getClientPlatform } from "@/lib/connections/platform";
import { useConnectionState } from "@/lib/connections/use-connection-state";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { SshHostConfig } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import {
  EMPTY_HOST_FORM,
  SshHostDialog,
  useAddSshHost,
} from "../ssh/ssh-hosts-settings-section";
import { useHostChoices } from "../ssh/use-host-choices";
import { HOME_FOLDER_INPUT } from "./folder-path";
import { FolderPathField } from "./folder-path-field";
import { createOpenProjectAttempt } from "./open-project-attempt";
import { useOpenProjectDialog } from "./open-project-dialog-state";

const NO_SSH_HOSTS: SshHostConfig[] = [];

/** The Select value that opens the Add SSH host form instead of a host. */
const ADD_SSH_HOST = "__add-ssh-host__";

export const OpenProjectDialog = () => {
  const open = useOpenProjectDialog((state) => state.open);
  const setOpen = useOpenProjectDialog((state) => state.setOpen);
  // Mounted only while open, so each opening starts fresh.
  return open ? <OpenProjectForm onClose={() => setOpen(false)} /> : null;
};

const OpenProjectForm = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslations("openProject");
  const sshT = useTranslations("sshHosts");
  const platform = getClientPlatform();
  const desktop = platform.desktop;
  // SSH hosts are the desktop's: a browser client opens on its own host.
  const savedSshHosts = useHostChoices();
  const connections = useIdeStore((state) => state.hostConnections);
  const sshHosts = desktop ? savedSshHosts : NO_SSH_HOSTS;
  const hosts = useIdeStore((state) => state.hosts);
  const connectHost = useIdeStore((state) => state.connectHost);
  const openProject = useIdeStore((state) => state.openProject);
  const setSettingsOpen = useIdeStore((state) => state.setSettingsOpen);
  const addSshHost = useAddSshHost();
  const homeState = useConnectionState(LOCAL_HOST_ID);

  const [hostId, setHostId] = useState(LOCAL_HOST_ID);
  const [path, setPath] = useState(HOME_FOLDER_INPUT);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingHost, setAddingHost] = useState(false);
  const dependencies = useRef({ connectHost, desktop, openProject });
  dependencies.current = { connectHost, desktop, openProject };
  const [attempt] = useState(() =>
    createOpenProjectAttempt({
      connect: (id) => dependencies.current.connectHost(id),
      resolveFolder: async (id, folder, signal) =>
        (
          await apiClient.hostDirectories(
            { path: folder },
            { hostId: id, signal },
          )
        ).path,
      pickFolder: () =>
        dependencies.current.desktop?.pickProjectDirectory() ??
        Promise.resolve(null),
      openProject: (id, folder, signal) =>
        dependencies.current.openProject(folder, { hostId: id, signal }),
    }),
  );
  useEffect(() => () => attempt.cancel(), [attempt]);

  const cancelAttempt = () => {
    attempt.cancel();
    setOpening(false);
  };
  const close = () => {
    cancelAttempt();
    onClose();
  };

  const home = hostId === LOCAL_HOST_ID;
  const sshHost = sshHosts.find((host) => host.id === hostId);
  const runtime = home ? undefined : hosts[hostId];
  const reachable = home
    ? homeState.status === "ready"
    : runtime?.state === "connected";
  const hostLabel = home ? platform.homeLabel : (sshHost?.label ?? hostId);

  // A host removed while picked falls back to this computer.
  useEffect(() => {
    if (!home && !sshHost) {
      attempt.cancel();
      setOpening(false);
      const merged = connections.find((host) =>
        host.routes.some(
          (route) => route.kind === "ssh" && route.sshHostId === hostId,
        ),
      );
      setHostId(merged?.id ?? LOCAL_HOST_ID);
    }
  }, [attempt, home, sshHost, connections, hostId]);

  // Picking an SSH host connects it; ssh's prompts appear in their own
  // dialog. A failed attempt waits for Connect rather than retrying.
  useEffect(() => {
    if (!hostId || hostId === LOCAL_HOST_ID) return;
    const state = useIdeStore.getState().hosts[hostId]?.state;
    if (state !== "connected" && state !== "connecting") {
      void connectHost(hostId);
    }
  }, [connectHost, hostId]);

  const pickHost = (next: string) => {
    cancelAttempt();
    if (next === ADD_SSH_HOST) {
      setAddingHost(true);
      return;
    }
    setHostId(next);
    setPath(HOME_FOLDER_INPUT);
    setError(null);
  };

  const handleAttempt = async (work: ReturnType<typeof attempt.typed>) => {
    setOpening(true);
    setError(null);
    const result = await work;
    if (result.status === "cancelled") return;
    setOpening(false);
    if (result.status === "failed") {
      setError(getApiErrorMessage(result.error, sshT("foldersFailed")));
    } else if (result.status === "opened") {
      setSettingsOpen(false);
      onClose();
    }
  };

  const busy =
    runtime?.state === "connecting" || runtime?.state === "reconnecting";
  const unavailable = reachable ? undefined : home ? (
    <Spinner className="size-4" />
  ) : busy ? (
    <>
      <Spinner className="size-4" />
      <span>{sshT("connectingTo", { host: hostLabel })}</span>
    </>
  ) : (
    <>
      <span>
        {runtime?.state === "failed" && runtime.error
          ? runtime.error
          : sshT("connectToBrowse", { host: hostLabel })}
      </span>
      <Button
        onClick={() => void connectHost(hostId)}
        size="sm"
        type="button"
        variant="outline"
      >
        <PlugZap className="size-3.5" />
        {sshT("connect")}
      </Button>
    </>
  );

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) close();
      }}
      open
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) void handleAttempt(attempt.typed(hostId, path));
          }}
        >
          {sshHosts.length > 0 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="open-project-host">{t("openOn")}</Label>
              <Select
                onValueChange={(value) => {
                  if (value !== null) pickHost(value);
                }}
                value={hostId}
              >
                <SelectTrigger className="w-full" id="open-project-host">
                  <SelectValue>{hostLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  <SelectItem value={LOCAL_HOST_ID}>
                    {platform.homeLabel}
                  </SelectItem>
                  {sshHosts.map((host) => (
                    <SelectItem key={host.id} value={host.id}>
                      {host.label}
                    </SelectItem>
                  ))}
                  <SelectSeparator />
                  <SelectItem value={ADD_SSH_HOST}>
                    <Plus className="size-3.5" />
                    {t("addSshHost")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="open-project-path">{sshT("folderPath")}</Label>
            <FolderPathField
              hostId={hostId}
              id="open-project-path"
              key={hostId}
              onChange={(next) => {
                if (next !== path) cancelAttempt();
                setPath(next);
                setError(null);
              }}
              trailing={
                desktop && home ? (
                  <Button
                    onClick={() => void handleAttempt(attempt.browse(hostId))}
                    type="button"
                    variant="outline"
                  >
                    <FolderOpen className="size-4" />
                    {t("browse")}
                  </Button>
                ) : null
              }
              unavailable={unavailable}
              value={path}
            />
            {error ? (
              <p className="break-words text-destructive text-xs">{error}</p>
            ) : null}
          </div>
          <DialogFooter className="sm:justify-between">
            {desktop && sshHosts.length === 0 ? (
              <Button
                onClick={() => {
                  cancelAttempt();
                  setAddingHost(true);
                }}
                type="button"
                variant="ghost"
              >
                <Plus className="size-4" />
                {t("addSshHost")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button onClick={close} type="button" variant="ghost">
                {sshT("cancel")}
              </Button>
              <Button disabled={opening || !path.trim()} type="submit">
                {opening ? <Spinner className="size-3.5" /> : null}
                {sshT("open")}
              </Button>
            </div>
          </DialogFooter>
        </form>
        {/* Nested in this dialog, outside its form: the host form's
              submit must not also open a folder. */}
        {addingHost ? (
          <SshHostDialog
            initial={EMPTY_HOST_FORM}
            isNew
            onCancel={() => setAddingHost(false)}
            onSave={(values) => {
              const host = addSshHost(values);
              setAddingHost(false);
              pickHost(host.id);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
