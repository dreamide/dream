/**
 * This computer's remote access, on Settings > Sharing & access: whether
 * paired devices can reach it and how (Tailscale Serve or a Cloudflare
 * Tunnel), then its authorized clients and pairing a computer with a
 * one-time code. The host owns all of it (host/remote-access/, host/auth/).
 *
 * Remote access the host was started with (`--remote-port`, `mode:
 * "proxy"`) is shown read-only with the reason. How to reach the host is
 * edited in a setup dialog, whose drafts are discarded when it closes.
 */
import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  KeyRound,
  Laptop,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import {
  type ApiRequestOf,
  getApiErrorMessage,
  type RemoteAccessProblem,
  type RemoteAccessProblemCode,
  type RemoteAccessStatus,
  type RemoteDeviceSession,
} from "@/lib/api-client";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import { useIdeStore } from "../ide-store";
import { createRemoteAccessState } from "./remote-access-state";
import { SettingsGroup } from "./settings-shared";

type Mode = RemoteAccessStatus["mode"];
/** What the setup dialog sets up; `proxy` is set only when a host starts. */
type SetupMode = Exclude<Mode, "proxy">;
const MODES: SetupMode[] = ["tailscale", "cloudflare"];

const isValidPort = (value: string) => {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
};

type ScopeChoice = "view" | "operate" | "manage";

/**
 * The access levels a pairing can grant, lowest first. A pairing names only
 * its level; the host adds the levels below it (host/auth/scopes.js).
 */
const SCOPE_CHOICES = [
  { value: "view", label: "scopeView", hint: "scopeViewHint" },
  { value: "operate", label: "scopeOperate", hint: "scopeOperateHint" },
  { value: "manage", label: "scopeManage", hint: "scopeManageHint" },
] as const satisfies readonly {
  value: ScopeChoice;
  label: string;
  hint: string;
}[];

/** The words for each problem code the host reports; others use its text. */
const PROBLEM_KEYS = {
  "not-installed": "notInstalled",
  "not-running": "notRunning",
  "needs-login": "needsLogin",
  "needs-approval": "needsApproval",
  "https-disabled": "httpsDisabled",
  "port-taken": "portTaken",
  permission: "permission",
  "needs-origin": "needsOrigin",
  "quick-tunnel": "quickTunnel",
  "port-in-use": "portInUse",
} as const satisfies Partial<Record<RemoteAccessProblemCode, string>>;

/** A problem in the user's language, from its code and values. */
const useProblemText = () => {
  const t = useTranslations("remote.problems");
  return (problem: RemoteAccessProblem, mode: Mode) => {
    const { origin, port } = problem.params ?? {};
    // A host older than these words sends no values: use its own text.
    if (problem.code === "unreachable")
      return origin && port
        ? t(
            mode === "cloudflare"
              ? "unreachableCloudflare"
              : "unreachableTailscale",
            { origin, port: String(port) },
          )
        : problem.message;
    if (
      (problem.code === "port-taken" || problem.code === "port-in-use") &&
      !port
    )
      return problem.message;
    const key = PROBLEM_KEYS[problem.code as keyof typeof PROBLEM_KEYS];
    return key
      ? t(key, { origin: origin ?? "", port: String(port) })
      : problem.message;
  };
};

const copyText = async (text: string) => {
  const desktop = getDesktopApi();
  if (desktop) return desktop.writeClipboardText(text);
  await navigator.clipboard.writeText(text);
  return true;
};

/** A read-only value with a copy button, for the pairing dialog. */
const CopyField = ({
  copyLabel,
  label,
  large = false,
  value,
}: {
  copyLabel: string;
  label: string;
  large?: boolean;
  value: string;
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          aria-label={label}
          className={
            large
              ? "h-10 text-center font-mono text-lg tracking-widest"
              : "font-mono text-xs"
          }
          readOnly
          value={value}
        />
        <Button
          aria-label={copyLabel}
          onClick={() =>
            void copyText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
          }
          size="icon-sm"
          title={copyLabel}
          type="button"
          variant="outline"
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
};

const useModeText = () => {
  const t = useTranslations("remote");
  return {
    label: (mode: Mode) =>
      mode === "tailscale"
        ? t("modeTailscale")
        : mode === "proxy"
          ? t("modeProxy")
          : t("modeCloudflare"),
    hint: (mode: Mode) =>
      mode === "tailscale" ? t("modeTailscaleHint") : t("modeCloudflareHint"),
  };
};

export const RemoteAccessSection = () => {
  const t = useTranslations("remote");
  const modeText = useModeText();
  const openExternalUrl = useIdeStore((state) => state.openExternalUrl);
  const remote = useMemo(() => createRemoteAccessState(), []);
  const {
    status,
    busy,
    error: failure,
    devices,
    pairing,
  } = useSyncExternalStore(
    remote.subscribe,
    remote.getSnapshot,
    remote.getSnapshot,
  );
  useEffect(() => {
    remote.start();
    return remote.stop;
  }, [remote]);
  const error = failure
    ? getApiErrorMessage(
        failure.cause,
        t(
          failure.kind === "load"
            ? "loadFailed"
            : failure.kind === "pair"
              ? "pairFailed"
              : "changeFailed",
        ),
      )
    : null;
  const [setupOpen, setSetupOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const changePairOpen = (open: boolean) => {
    setPairOpen(open);
    if (!open) remote.clearPairing();
  };
  const [scope, setScope] = useState<ScopeChoice>("operate");
  const [pendingRevoke, setPendingRevoke] =
    useState<RemoteDeviceSession | null>(null);
  const [pendingRevokeAll, setPendingRevokeAll] = useState(false);
  // Set when the host started (`--remote-port`): not Settings' to change.
  const fixedBy =
    status?.mode === "proxy"
      ? Object.values(status.override?.sources ?? {}).join(", ")
      : null;
  const locked = fixedBy !== null;
  const lockReason =
    fixedBy !== null
      ? t("setByOptions", { sources: fixedBy || "--remote-port" })
      : null;
  const enabled = status?.enabled ?? false;
  // A host older than `configured` was set up if it is on.
  const configured = status?.configured ?? status?.enabled ?? false;
  const problemText = useProblemText();
  // A refused save is the setup dialog's to show; it changed nothing here.
  const problem = status?.problem?.refused ? null : (status?.problem ?? null);
  const save = async (options: ApiRequestOf<"remoteAccessEnable">) => {
    const changed = await remote.enable(options);
    if (changed && !remote.getSnapshot().status?.problem?.refused)
      setSetupOpen(false);
  };
  const scopeLabel = (scopes: string[]) =>
    scopes.includes("manage")
      ? t("scopeManage")
      : scopes.includes("operate")
        ? t("scopeOperate")
        : t("scopeView");
  const address = status?.ready ? status.origin : status?.requestedOrigin;

  return (
    <div className="space-y-6">
      <SettingsGroup>
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <div className="font-medium text-sm">{t("accessToggle")}</div>
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
              {status === null ? (
                <Spinner className="size-3" />
              ) : !enabled ? (
                t("statusOff")
              ) : status.ready ? (
                <Badge className="gap-1.5" variant="outline">
                  <StatusDot color="green" pulse={false} />
                  {t("statusReady")}
                </Badge>
              ) : (
                <Badge className="gap-1.5" variant="outline">
                  <StatusDot
                    color={problem ? "red" : "amber"}
                    pulse={!problem}
                  />
                  {problem ? t("statusNotReady") : t("statusChecking")}
                </Badge>
              )}
            </div>
          </div>
          <Switch
            aria-label={t("accessToggle")}
            checked={enabled}
            disabled={busy || status === null || locked}
            onCheckedChange={(checked) => {
              if (!checked) void remote.disable();
              else if (configured) void remote.enable({});
              else setSetupOpen(true);
            }}
          />
        </div>

        <div className="grid gap-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm">{t("connectionLabel")}</div>
              <div className="mt-0.5 text-muted-foreground text-xs">
                {status === null ? null : configured ? (
                  <>
                    {modeText.label(status.mode)}
                    {address ? (
                      <>
                        {" · "}
                        <span className="select-text break-all font-mono">
                          {address}
                        </span>
                      </>
                    ) : null}
                  </>
                ) : (
                  t("notSetUp")
                )}
              </div>
            </div>
            {enabled && !locked ? (
              <Button
                aria-label={t("checkAgain")}
                disabled={busy}
                onClick={() => void remote.check()}
                size="icon-sm"
                title={t("checkAgain")}
                type="button"
                variant="ghost"
              >
                <RefreshCw className="size-3.5" />
              </Button>
            ) : null}
            <Button
              disabled={busy || status === null || locked}
              onClick={() => setSetupOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              {configured ? t("change") : t("setUp")}
            </Button>
          </div>
          {lockReason ? (
            <p className="text-muted-foreground text-xs">{lockReason}</p>
          ) : null}
          {enabled && status && problem ? (
            <div className="grid gap-2 rounded-md border border-destructive-border bg-destructive-surface px-3 py-2 text-destructive text-sm">
              <span className="select-text break-words">
                {problemText(problem, status.mode)}
              </span>
              {problem.params?.detail ? (
                <span className="select-text break-words text-xs opacity-80">
                  {problem.params.detail}
                </span>
              ) : null}
              {problem.url ? (
                <Button
                  className="w-fit"
                  onClick={() => openExternalUrl(problem.url ?? "")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <ExternalLink className="size-3.5" />
                  {t("openSetupPage")}
                </Button>
              ) : null}
            </div>
          ) : null}
          {error && !setupOpen ? (
            <p className="select-text text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </SettingsGroup>

      {setupOpen && status ? (
        <RemoteAccessSetupDialog
          busy={busy}
          error={error}
          initial={status}
          onCancel={() => setSetupOpen(false)}
          onOpenUrl={openExternalUrl}
          onSave={save}
          status={status}
        />
      ) : null}

      <SettingsGroup>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="space-y-1">
            <h4 className="font-medium text-sm">
              {t("devicesTitle")}
              <span className="ml-2 font-normal text-muted-foreground text-xs">
                {t("devicesCount", { count: devices.length })}
              </span>
            </h4>
            {status?.ready ? null : (
              <p className="text-muted-foreground text-xs">
                {t("pairNeedsAccess")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {devices.length > 0 ? (
              <Button
                disabled={busy}
                onClick={() => setPendingRevokeAll(true)}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("revokeAll")}
              </Button>
            ) : null}
            <Button
              disabled={busy || !status?.ready}
              onClick={() => {
                remote.clearPairing();
                setPairOpen(true);
              }}
              size="sm"
              type="button"
            >
              <KeyRound className="size-4" />
              {t("pairDevice")}
            </Button>
          </div>
        </div>

        {devices.length === 0 ? (
          <p className="px-4 py-3 text-center text-muted-foreground text-sm">
            {t("noDevices")}
          </p>
        ) : null}
        {devices.map((device) => (
          <div className="flex items-center gap-3 px-4 py-3" key={device.id}>
            <Laptop className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-sm">
                {device.deviceName}
              </div>
              <div className="text-muted-foreground text-xs">
                {scopeLabel(device.scopes)} ·{" "}
                {t("lastUsed", {
                  time: new Date(device.lastUsedAt).toLocaleString(),
                })}
              </div>
            </div>
            <Button
              aria-label={t("revokeTitle", { device: device.deviceName })}
              disabled={busy}
              onClick={() => setPendingRevoke(device)}
              size="icon-sm"
              title={t("revoke")}
              type="button"
              variant="ghost"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </SettingsGroup>

      <Dialog onOpenChange={changePairOpen} open={pairOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("pairDevice")}</DialogTitle>
            <DialogDescription>{t("pairDialogDescription")}</DialogDescription>
          </DialogHeader>
          {pairing ? (
            <div className="grid gap-3">
              <CopyField
                copyLabel={t("copyCode")}
                label={t("pairingCode")}
                large
                value={pairing.code}
              />
              {status?.origin ? (
                <CopyField
                  copyLabel={t("copyAddress")}
                  label={t("hostAddress")}
                  value={status.origin}
                />
              ) : null}
              <p className="text-muted-foreground text-sm">
                {t("pairingCodeHint")}
              </p>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="remote-access-scope">{t("accessLevel")}</Label>
              <Select
                onValueChange={(value) => {
                  if (
                    value === "view" ||
                    value === "operate" ||
                    value === "manage"
                  )
                    setScope(value);
                }}
                value={scope}
              >
                <SelectTrigger className="w-full" id="remote-access-scope">
                  <SelectValue>
                    {t(
                      SCOPE_CHOICES.find((choice) => choice.value === scope)
                        ?.label ?? "scopeOperate",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  {SCOPE_CHOICES.map(({ value, label, hint }) => (
                    <SelectItem key={value} value={value}>
                      <span className="grid gap-0.5 whitespace-normal">
                        <span>{t(label)}</span>
                        <span className="text-muted-foreground text-xs">
                          {t(hint)}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            {pairing ? (
              <Button onClick={() => changePairOpen(false)} type="button">
                {t("done")}
              </Button>
            ) : (
              <>
                <Button
                  onClick={() => changePairOpen(false)}
                  type="button"
                  variant="ghost"
                >
                  {t("cancel")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => void remote.createPairing([scope])}
                  type="button"
                >
                  {t("createPairing")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog onOpenChange={setPendingRevokeAll} open={pendingRevokeAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("revokeAllTitle", { count: devices.length })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("revokeDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                setPendingRevokeAll(false);
                void (async () => {
                  for (const device of devices) {
                    await remote.revoke(device.id);
                  }
                })();
              }}
              variant="destructive"
            >
              {t("revokeAll")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setPendingRevoke(null);
        }}
        open={pendingRevoke !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("revokeTitle", { device: pendingRevoke?.deviceName ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("revokeDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (pendingRevoke) void remote.revoke(pendingRevoke.id);
                setPendingRevoke(null);
              }}
              variant="destructive"
            >
              {t("revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

/**
 * How paired devices reach this computer. Drafts start from `initial` (the
 * status when it opened), so later polls never overwrite an edit; `status`
 * is the live one, for a refused save. Saving turns access on with these
 * settings. A Cloudflare route goes through the user's own cloudflared.
 */
const RemoteAccessSetupDialog = ({
  busy,
  error,
  initial,
  onCancel,
  onOpenUrl,
  onSave,
  status,
}: {
  busy: boolean;
  error: string | null;
  initial: RemoteAccessStatus;
  onCancel: () => void;
  onOpenUrl: (url: string) => void;
  onSave: (options: ApiRequestOf<"remoteAccessEnable">) => Promise<void>;
  status: RemoteAccessStatus;
}) => {
  const t = useTranslations("remote");
  const modeText = useModeText();
  const [mode, setMode] = useState<SetupMode>(
    initial.mode === "proxy" ? "tailscale" : initial.mode,
  );
  const [origin, setOrigin] = useState(initial.requestedOrigin ?? "");
  const [httpsPort, setHttpsPort] = useState(String(initial.httpsPort));
  const [localPort, setLocalPort] = useState(
    initial.port == null ? "" : String(initial.port),
  );
  const portsValid =
    (localPort === "" || isValidPort(localPort)) &&
    (mode !== "tailscale" || isValidPort(httpsPort));
  const needsOrigin = mode === "cloudflare" && !origin.trim();
  const blocker = !portsValid
    ? t("portRange")
    : needsOrigin
      ? t("needsOrigin")
      : null;
  const port = localPort === "" ? null : Number(localPort);
  const shownPort = String(
    status.port ?? (localPort || status.cloudflare?.defaultPort || "—"),
  );
  const problemText = useProblemText();
  // Only a save made in this dialog can have been refused here.
  const [attempted, setAttempted] = useState(false);
  const refused =
    attempted && status.problem?.refused
      ? problemText(status.problem, mode)
      : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (blocker) return;
            setAttempted(true);
            void onSave(
              mode === "tailscale"
                ? { httpsPort: Number(httpsPort), mode, port }
                : {
                    // An older host would otherwise run a connector itself.
                    cloudflareManaged: false,
                    mode,
                    origin: origin.trim(),
                    port,
                  },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base leading-6">
              {t("setupTitle")}
            </DialogTitle>
            <DialogDescription>{t("modeLabel")}</DialogDescription>
          </DialogHeader>

          <RadioGroup
            aria-label={t("modeLabel")}
            className="gap-2"
            onValueChange={(value) => {
              if (MODES.includes(value as SetupMode))
                setMode(value as SetupMode);
            }}
            value={mode}
          >
            {MODES.map((item) => (
              <Label
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 font-normal",
                  item === mode && "border-primary",
                )}
                key={item}
              >
                <RadioGroupItem className="mt-0.5" value={item} />
                <span className="grid gap-0.5">
                  <span className="font-medium text-sm">
                    {modeText.label(item)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {modeText.hint(item)}
                  </span>
                </span>
              </Label>
            ))}
          </RadioGroup>

          {mode === "cloudflare" ? (
            <>
              <div className="grid gap-2 rounded-md border px-3 py-2.5">
                <ol className="grid list-decimal gap-1 pl-4 text-muted-foreground text-xs">
                  <li>{t("cloudflareStepTunnel")}</li>
                  <li className="select-text break-words">
                    {t("cloudflareStepRoute", { port: shownPort })}
                  </li>
                  <li>{t("cloudflareStepAddress")}</li>
                </ol>
                <Button
                  className="w-fit"
                  onClick={() => onOpenUrl("https://one.dash.cloudflare.com/")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <ExternalLink className="size-3.5" />
                  {t("openSetupPage")}
                </Button>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="remote-access-origin">{t("originLabel")}</Label>
                <Input
                  className="font-mono"
                  id="remote-access-origin"
                  onChange={(event) => setOrigin(event.target.value)}
                  placeholder="https://dream.example.com"
                  spellCheck={false}
                  value={origin}
                />
              </div>
            </>
          ) : null}

          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
              <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" />
              {t("advanced")}
            </CollapsibleTrigger>
            <CollapsibleContent className="grid gap-3 pt-3">
              {mode === "tailscale" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="remote-access-https-port">
                    {t("httpsPortLabel")}
                  </Label>
                  <Input
                    aria-invalid={!isValidPort(httpsPort)}
                    className="w-28 font-mono"
                    id="remote-access-https-port"
                    inputMode="numeric"
                    onChange={(event) =>
                      setHttpsPort(event.target.value.replace(/\D/g, ""))
                    }
                    value={httpsPort}
                  />
                </div>
              ) : null}
              <div className="grid gap-1.5">
                <Label htmlFor="remote-access-local-port">
                  {t("localPortLabel")}
                </Label>
                <Input
                  aria-invalid={localPort !== "" && !isValidPort(localPort)}
                  className="w-28 font-mono"
                  id="remote-access-local-port"
                  inputMode="numeric"
                  onChange={(event) =>
                    setLocalPort(event.target.value.replace(/\D/g, ""))
                  }
                  placeholder={t("portAutomatic")}
                  value={localPort}
                />
                <span className="text-muted-foreground text-xs">
                  {t("localPortHint")}
                </span>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {refused || error ? (
            <p
              className="select-text break-words text-destructive text-sm"
              role="alert"
            >
              {refused ?? error}
            </p>
          ) : null}

          <DialogFooter className="items-center">
            {blocker ? (
              <span className="mr-auto text-muted-foreground text-xs">
                {blocker}
              </span>
            ) : null}
            <Button
              disabled={busy}
              onClick={onCancel}
              type="button"
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button disabled={busy || Boolean(blocker)} type="submit">
              {busy ? <Spinner className="size-3.5" /> : null}
              {status.enabled ? t("save") : t("turnOn")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
