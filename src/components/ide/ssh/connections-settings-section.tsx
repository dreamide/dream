/**
 * Settings > Remote hosts: one row per host this client can open projects
 * on, with its connection state and the route it uses. A host reached more
 * than one way keeps its ordered routes in a dialog, not on the page.
 */
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Pencil,
  Plug,
  PlugZap,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot, type StatusDotColor } from "@/components/ui/status-dot";
import { getClientPlatform } from "@/lib/connections/platform";
import { desktopErrorMessage, getDesktopApi } from "@/lib/electron";
import type {
  HostConnectionState,
  HostRoute,
  SavedHostConnection,
} from "@/types/ide";
import {
  listHostChoices,
  MAX_HOST_ROUTES,
} from "../../../../electron/shared/host-connections.js";
import { useIdeStore } from "../ide-store";
import { SettingsGroup } from "../settings/settings-shared";
import type { HostRuntimeState } from "../store/ide-store-types";
import {
  EMPTY_HOST_FORM,
  type HostFormValues,
  SshHostDialog,
  useAddSshHost,
  useHostStateLabel,
} from "./ssh-hosts-settings-section";

const STATE_DOTS: Record<
  HostConnectionState,
  { color: StatusDotColor; pulse: boolean }
> = {
  connected: { color: "green", pulse: false },
  connecting: { color: "amber", pulse: true },
  disconnected: { color: "neutral", pulse: false },
  failed: { color: "red", pulse: false },
  idle: { color: "neutral", pulse: false },
  reconnecting: { color: "amber", pulse: true },
};

/** One host as the page shows it. */
interface HostView {
  id: string;
  label: string;
  /** Its saved connection; only a saved host can reorder or add routes. */
  saved: SavedHostConnection | undefined;
  isHome: boolean;
  runtime: HostRuntimeState | undefined;
  routes: HostRoute[];
}

/** Where one route goes, for display: an address or the local machine. */
const useRouteTarget = () => {
  const sshT = useTranslations("sshHosts");
  const sshHosts = useIdeStore((state) => state.settings.sshHosts);
  return (route: HostRoute) =>
    route.kind === "ssh"
      ? (sshHosts.find((host) => host.id === route.sshHostId)?.target ?? "")
      : route.kind === "local"
        ? sshT("localMachine")
        : route.origin;
};

const routeKindLabel = (route: HostRoute) =>
  route.kind === "ssh" ? "SSH" : route.kind === "local" ? null : "HTTPS";

export function ConnectionsSettingsSection() {
  const t = useTranslations("connections");
  const sshT = useTranslations("sshHosts");
  const connections = useIdeStore((state) => state.hostConnections);
  const sshHosts = useIdeStore((state) => state.settings.sshHosts);
  const hosts = useIdeStore((state) => state.hosts);
  const home = connections.find(
    (host) => host.id === "local" && host.routes.length > 1,
  );
  const choices = [
    ...(home && getClientPlatform().hasHomeHost
      ? [{ id: "local", label: getClientPlatform().homeLabel }]
      : []),
    ...listHostChoices(connections, sshHosts),
  ];
  const views: HostView[] = choices.map((choice) => {
    const saved = connections.find((host) => host.id === choice.id);
    const isHome = choice.id === "local";
    return {
      id: choice.id,
      label: choice.label,
      saved,
      isHome,
      runtime: isHome
        ? { state: "connected", loaded: true, error: null, routeId: "local" }
        : hosts[choice.id],
      routes: saved?.routes ?? [
        { id: `ssh:${choice.id}`, kind: "ssh", sshHostId: choice.id },
      ],
    };
  });
  const saveSsh = useAddSshHost();
  // An SSH form: a new host, a new route of `owner`, or editing `edit`.
  // `back` reopens that host's routes dialog when the form closes.
  const [sshForm, setSshForm] = useState<{
    owner?: string;
    edit?: string;
    back?: string;
  } | null>(null);
  const [pairing, setPairing] = useState<{
    owner?: string;
    routeId?: string;
    back?: string;
  } | null>(null);
  const [routesOf, setRoutesOf] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (reason) {
      setError(desktopErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const edit = sshHosts.find((host) => host.id === sshForm?.edit);
  const closeSshForm = () => {
    if (sshForm?.back) setRoutesOf(sshForm.back);
    setSshForm(null);
  };
  const closePairing = () => {
    if (pairing?.back) setRoutesOf(pairing.back);
    setPairing(null);
  };
  const save = (values: HostFormValues) => {
    const form = sshForm;
    closeSshForm();
    void run(async () => {
      const state = useIdeStore.getState();
      if (form?.edit) await state.updateSshHost(form.edit, values);
      else if (form?.owner) await state.addSshRoute(form.owner, values);
      else {
        const host = saveSsh(values);
        await state.connectHost(host.id);
      }
    });
  };
  const openEdit = (view: HostView) => {
    setError(null);
    if (view.saved) setRoutesOf(view.id);
    else setSshForm({ edit: view.id });
  };
  const routesView = views.find((view) => view.id === routesOf);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium text-base">{t("hosts")}</h3>
          <p className="text-muted-foreground text-sm">{t("description")}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            render={<Button size="sm" type="button" />}
          >
            <Plus className="size-4" />
            {t("addHost")}
            <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-44">
            <DropdownMenuItem onClick={() => setSshForm({})}>
              {t("addSsh")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setPairing({})}>
              {t("addPairing")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && !routesView ? (
        <p role="alert" className="break-words text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <SettingsGroup>
        {views.length === 0 ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            {t("empty")}
          </p>
        ) : null}
        {views.map((view) => (
          <HostRow
            busy={busy}
            key={view.id}
            onEdit={() => openEdit(view)}
            onRemove={() => setPendingRemove(view)}
            onToggle={(live) =>
              void run(() =>
                live
                  ? useIdeStore.getState().disconnectHost(view.id)
                  : useIdeStore.getState().connectHost(view.id),
              )
            }
            view={view}
          />
        ))}
      </SettingsGroup>
      {routesView ? (
        <HostRoutesDialog
          busy={busy}
          error={error}
          onAddHttps={() => {
            setRoutesOf(null);
            setPairing({ owner: routesView.id, back: routesView.id });
          }}
          onAddSsh={() => {
            setRoutesOf(null);
            setSshForm({ owner: routesView.id, back: routesView.id });
          }}
          onClose={() => setRoutesOf(null)}
          onEditRoute={(route) => {
            setRoutesOf(null);
            if (route.kind === "ssh")
              setSshForm({ edit: route.sshHostId, back: routesView.id });
            else
              setPairing({
                owner: routesView.id,
                routeId: route.id,
                back: routesView.id,
              });
          }}
          onSetRoutes={(routes) =>
            void run(() =>
              useIdeStore.getState().setHostRoutes(routesView.id, routes),
            )
          }
          view={routesView}
        />
      ) : null}
      {sshForm ? (
        <SshHostDialog
          initial={edit ?? EMPTY_HOST_FORM}
          isNew={!edit}
          onCancel={closeSshForm}
          onSave={save}
        />
      ) : null}
      {pairing ? (
        <PairHostDialog
          onCancel={closePairing}
          onPair={async (url, label) => {
            await useIdeStore
              .getState()
              .pairHost(url, label, pairing.owner, pairing.routeId);
            closePairing();
          }}
        />
      ) : null}
      <AlertDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {sshT("removeTitle", { name: pendingRemove?.label ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {sshT("removeDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{sshT("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingRemove)
                  void run(() =>
                    useIdeStore.getState().removeSshHost(pendingRemove.id),
                  );
                setPendingRemove(null);
              }}
            >
              {sshT("remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** One host: its name, the address it uses, its state, and its actions. */
function HostRow({
  busy,
  onEdit,
  onRemove,
  onToggle,
  view,
}: {
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onToggle: (live: boolean) => void;
  view: HostView;
}) {
  const t = useTranslations("connections");
  const sshT = useTranslations("sshHosts");
  const stateLabel = useHostStateLabel();
  const routeTarget = useRouteTarget();
  const { runtime, routes, isHome } = view;
  const state = runtime?.state ?? "idle";
  const live = state === "connected" || state === "reconnecting";
  const connecting = state === "connecting";
  const shown =
    routes.find((route) => route.id === runtime?.routeId) ?? routes[0];
  const target = shown ? routeTarget(shown) : "";
  const dot = STATE_DOTS[state];
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Server className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm">{view.label}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <span className="truncate" title={target}>
            {target}
          </span>
          {routes.length > 1 ? (
            <span className="shrink-0">
              {t("otherRoutes", { count: routes.length - 1 })}
            </span>
          ) : null}
          <Badge className="shrink-0 gap-1.5" variant="outline">
            <StatusDot color={dot.color} pulse={dot.pulse} />
            {stateLabel(state)}
          </Badge>
        </div>
        {runtime?.error ? (
          <div className="mt-1 select-text whitespace-pre-wrap break-words text-destructive text-xs">
            {runtime.error}
          </div>
        ) : null}
      </div>
      {isHome ? null : (
        <Button
          aria-busy={connecting}
          disabled={busy || connecting}
          onClick={() => onToggle(live)}
          size="sm"
          type="button"
          variant="outline"
        >
          {connecting ? (
            <Spinner className="size-3.5" />
          ) : live ? (
            <Plug className="size-3.5" />
          ) : (
            <PlugZap className="size-3.5" />
          )}
          {connecting
            ? sshT("stateConnecting")
            : live
              ? sshT("disconnect")
              : sshT("connect")}
        </Button>
      )}
      <div className="flex shrink-0 items-center">
        <Button
          aria-label={sshT("edit")}
          disabled={busy}
          onClick={onEdit}
          size="icon-sm"
          title={sshT("edit")}
          type="button"
          variant="ghost"
        >
          <Pencil className="size-3.5" />
        </Button>
        {isHome ? null : (
          <Button
            aria-label={sshT("remove")}
            disabled={busy}
            onClick={onRemove}
            size="icon-sm"
            title={sshT("remove")}
            type="button"
            variant="ghost"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** A saved host's routes, tried in order: reorder, edit, add and remove. */
function HostRoutesDialog({
  busy,
  error,
  onAddHttps,
  onAddSsh,
  onClose,
  onEditRoute,
  onSetRoutes,
  view,
}: {
  busy: boolean;
  error: string | null;
  onAddHttps: () => void;
  onAddSsh: () => void;
  onClose: () => void;
  onEditRoute: (route: Exclude<HostRoute, { kind: "local" }>) => void;
  onSetRoutes: (routes: HostRoute[]) => void;
  view: HostView;
}) {
  const t = useTranslations("connections");
  const sshT = useTranslations("sshHosts");
  const routeTarget = useRouteTarget();
  const { routes, runtime, isHome } = view;
  const swap = (index: number, other: number) =>
    onSetRoutes(
      routes.map((item, i) =>
        i === index ? routes[other] : i === other ? routes[index] : item,
      ) as HostRoute[],
    );
  const full = routes.length >= MAX_HOST_ROUTES;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base leading-6">
            {view.label}
          </DialogTitle>
          <DialogDescription>{t("routesDescription")}</DialogDescription>
        </DialogHeader>
        <ol className="divide-y rounded-md border">
          {routes.map((route, index) => {
            const status = runtime?.routes?.find(
              (item) => item.routeId === route.id,
            );
            const target = routeTarget(route);
            const kind = routeKindLabel(route);
            return (
              <li key={route.id} className="flex items-center gap-1 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm" title={target}>
                    {kind ? `${kind} · ${target}` : target}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {runtime?.routeId === route.id
                      ? t("active")
                      : status
                        ? t(status.state)
                        : t("idle")}
                  </p>
                  {status?.error ? (
                    <p className="select-text break-words text-destructive text-xs">
                      {status.error}
                    </p>
                  ) : null}
                </div>
                {!isHome && routes.length > 1 ? (
                  <>
                    <Button
                      aria-label={t("up")}
                      disabled={busy || index === 0}
                      onClick={() => swap(index, index - 1)}
                      size="icon-sm"
                      title={t("up")}
                      type="button"
                      variant="ghost"
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      aria-label={t("down")}
                      disabled={busy || index === routes.length - 1}
                      onClick={() => swap(index, index + 1)}
                      size="icon-sm"
                      title={t("down")}
                      type="button"
                      variant="ghost"
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                  </>
                ) : null}
                {route.kind === "local" ? null : (
                  <>
                    <Button
                      aria-label={sshT("edit")}
                      disabled={busy}
                      onClick={() => onEditRoute(route)}
                      size="icon-sm"
                      title={sshT("edit")}
                      type="button"
                      variant="ghost"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      aria-label={t("removeRoute")}
                      disabled={busy || routes.length === 1}
                      onClick={() =>
                        onSetRoutes(
                          routes.filter((item) => item.id !== route.id),
                        )
                      }
                      size="icon-sm"
                      title={t("removeRoute")}
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ol>
        {error ? (
          <p role="alert" className="break-words text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            <Button
              disabled={busy || full}
              onClick={onAddSsh}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus className="size-3.5" />
              {t("addSshRoute")}
            </Button>
            <Button
              disabled={busy || full}
              onClick={onAddHttps}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus className="size-3.5" />
              {t("addHttpsRoute")}
            </Button>
          </div>
          <Button onClick={onClose} type="button">
            {t("done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PairHostDialog({
  onCancel,
  onPair,
}: {
  onCancel: () => void;
  onPair: (url: string, label: string) => Promise<void>;
}) {
  const t = useTranslations("connections");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            void onPair(url.trim(), label)
              .catch((reason) => setError(desktopErrorMessage(reason)))
              .finally(() => setBusy(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("pair")}</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">{t("pairHint")}</p>
          <div className="space-y-2">
            <Label htmlFor="pair-host-link">{t("pairLink")}</Label>
            <Input
              autoFocus
              id="pair-host-link"
              type="password"
              autoComplete="off"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pair-host-name">{t("name")}</Label>
            <Input
              id="pair-host-name"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="break-words text-destructive text-sm">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={busy}
              type="button"
              variant="outline"
              onClick={onCancel}
            >
              {t("cancel")}
            </Button>
            <Button
              disabled={busy || !url.trim() || !getDesktopApi()}
              type="submit"
            >
              {busy ? t("pairing") : t("pair")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
