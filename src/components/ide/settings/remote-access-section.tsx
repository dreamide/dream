/**
 * Settings > Remote access (the desktop's): whether paired devices can reach
 * this computer and how (Tailscale Serve or a Cloudflare Tunnel),
 * pairing a device by QR code, link or code, confirming code requests, and
 * revoking paired devices. The host owns all of it (host/remote-access/,
 * host/auth/); this section is its local operator's view.
 *
 * The page shows only what the host reports. How to reach this computer is
 * edited in a setup dialog, whose drafts are discarded when it closes.
 */
import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  QrCode,
  RefreshCw,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { encode } from "uqr";
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
import { Checkbox } from "@/components/ui/checkbox";
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
const MODES: Mode[] = ["tailscale", "cloudflare"];

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
  "cloudflare-token": "cloudflareToken",
  "cloudflare-connecting": "cloudflareConnecting",
  "needs-origin": "needsOrigin",
  "quick-tunnel": "quickTunnel",
  "port-in-use": "portInUse",
} as const satisfies Partial<Record<RemoteAccessProblemCode, string>>;

/** A problem in the user's language, from its code and values. */
const useProblemText = () => {
  const t = useTranslations("remote.problems");
  return (problem: RemoteAccessProblem, mode: Mode) => {
    const params = {
      origin: problem.params?.origin ?? "",
      port: String(problem.params?.port ?? "—"),
    };
    if (problem.code === "unreachable")
      return t(
        mode === "cloudflare"
          ? "unreachableCloudflare"
          : "unreachableTailscale",
        params,
      );
    const key = PROBLEM_KEYS[problem.code as keyof typeof PROBLEM_KEYS];
    return key ? t(key, params) : problem.message;
  };
};

/** The QR code of `text`, as an SVG drawn from its modules. */
const QrImage = ({ text, label }: { text: string; label: string }) => {
  const path = useMemo(() => {
    const { data, size } = encode(text, { border: 2 });
    let d = "";
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (data[y]?.[x]) d += `M${x} ${y}h1v1h-1z`;
      }
    }
    return { d, size };
  }, [text]);
  return (
    <svg
      aria-label={label}
      className="size-48 rounded-md bg-white"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${path.size} ${path.size}`}
    >
      <path d={path.d} fill="#000" />
    </svg>
  );
};

const copyText = async (text: string) => {
  const desktop = getDesktopApi();
  if (desktop) return desktop.writeClipboardText(text);
  await navigator.clipboard.writeText(text);
  return true;
};

const useModeText = () => {
  const t = useTranslations("remote");
  return {
    label: (mode: Mode) =>
      mode === "tailscale" ? t("modeTailscale") : t("modeCloudflare"),
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
    installing,
    error: failure,
    claims,
    devices,
    pairing,
    pairingUrl,
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
  const [copied, setCopied] = useState(false);
  const [pendingRevoke, setPendingRevoke] =
    useState<RemoteDeviceSession | null>(null);
  const enabled = status?.enabled ?? false;
  const configured = status?.configured ?? false;
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
  const connector =
    status?.mode === "cloudflare" && status.cloudflare?.managed
      ? t("cloudflareState", {
          state: t(`cloudflare_${status.cloudflare.state}`),
        })
      : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="font-medium text-base">{t("accessTitle")}</h3>
        <p className="text-muted-foreground text-sm">
          {t("accessDescription")}
        </p>
      </div>

      <SettingsGroup>
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm">{t("accessToggle")}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
              {status === null ? (
                <Spinner className="size-3" />
              ) : !enabled ? (
                t("statusOff")
              ) : status.ready ? (
                <Badge className="gap-1.5" variant="outline">
                  <StatusDot color="green" />
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
            disabled={busy || status === null}
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
                    {connector ? ` · ${connector}` : null}
                  </>
                ) : (
                  t("notSetUp")
                )}
              </div>
            </div>
            {enabled ? (
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
              disabled={busy || status === null}
              onClick={() => setSetupOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              {configured ? t("change") : t("setUp")}
            </Button>
          </div>
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
          installing={installing}
          onCancel={() => setSetupOpen(false)}
          onInstallCloudflare={() => void remote.installCloudflare()}
          onOpenUrl={openExternalUrl}
          onSave={save}
          status={status}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h4 className="font-medium text-sm">{t("devicesTitle")}</h4>
          {status?.ready ? null : (
            <p className="text-muted-foreground text-xs">
              {t("pairNeedsAccess")}
            </p>
          )}
        </div>
        <Button
          disabled={busy || !status?.ready}
          onClick={() => {
            remote.clearPairing();
            setPairOpen(true);
          }}
          size="sm"
          type="button"
        >
          <QrCode className="size-4" />
          {t("pairDevice")}
        </Button>
      </div>

      {claims.length > 0 ? (
        <SettingsGroup label={t("requestsTitle")}>
          {claims.map((claim) => (
            <div
              className="flex items-center gap-3 px-4 py-3"
              key={claim.claimId}
            >
              <Smartphone className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-sm">
                  {claim.deviceName}
                </div>
                <div className="text-muted-foreground text-xs">
                  {scopeLabel(claim.scopes)}
                </div>
              </div>
              <Button
                disabled={busy}
                onClick={() => void remote.answer(claim.claimId, false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <X className="size-3.5" />
                {t("deny")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => void remote.answer(claim.claimId, true)}
                size="sm"
                type="button"
              >
                <Check className="size-3.5" />
                {t("confirm")}
              </Button>
            </div>
          ))}
        </SettingsGroup>
      ) : null}

      {devices.length === 0 ? (
        <p className="py-3 text-center text-muted-foreground text-sm">
          {t("noDevices")}
        </p>
      ) : (
        <SettingsGroup>
          {devices.map((device) => (
            <div className="flex items-center gap-3 px-4 py-3" key={device.id}>
              <Smartphone className="size-4 shrink-0 text-muted-foreground" />
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
      )}

      <Dialog onOpenChange={changePairOpen} open={pairOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("pairDevice")}</DialogTitle>
            <DialogDescription>{t("pairDialogDescription")}</DialogDescription>
          </DialogHeader>
          {pairing ? (
            <div className="grid justify-items-center gap-3">
              {pairingUrl ? (
                <>
                  <QrImage label={t("pairDevice")} text={pairingUrl} />
                  <div className="flex w-full items-center gap-2">
                    <Input
                      className="font-mono text-xs"
                      readOnly
                      value={pairingUrl}
                    />
                    <Button
                      aria-label={t("copyLink")}
                      onClick={() =>
                        void copyText(pairingUrl).then(() => {
                          setCopied(true);
                          window.setTimeout(() => setCopied(false), 1500);
                        })
                      }
                      size="icon-sm"
                      title={t("copyLink")}
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
                </>
              ) : null}
              <p className="text-center text-muted-foreground text-sm">
                {t("pairingCodeHint", { code: pairing.code })}
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
 * is the live one, for cloudflared's install state and a refused save.
 * Saving turns access on with these settings.
 */
const RemoteAccessSetupDialog = ({
  busy,
  error,
  initial,
  installing,
  onCancel,
  onInstallCloudflare,
  onOpenUrl,
  onSave,
  status,
}: {
  busy: boolean;
  error: string | null;
  initial: RemoteAccessStatus;
  installing: boolean;
  onCancel: () => void;
  onInstallCloudflare: () => void;
  onOpenUrl: (url: string) => void;
  onSave: (options: ApiRequestOf<"remoteAccessEnable">) => Promise<void>;
  status: RemoteAccessStatus;
}) => {
  const t = useTranslations("remote");
  const modeText = useModeText();
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [origin, setOrigin] = useState(initial.requestedOrigin ?? "");
  const [managed, setManaged] = useState(initial.cloudflare?.managed ?? true);
  const [token, setToken] = useState("");
  const [httpsPort, setHttpsPort] = useState(String(initial.httpsPort));
  const [localPort, setLocalPort] = useState(
    initial.port == null ? "" : String(initial.port),
  );
  const portsValid =
    (localPort === "" || isValidPort(localPort)) &&
    (mode !== "tailscale" || isValidPort(httpsPort));
  const needsOrigin = mode === "cloudflare" && !origin.trim();
  const needsToken =
    mode === "cloudflare" &&
    managed &&
    !token.trim() &&
    !status.cloudflare?.tokenSaved;
  const blocker = !portsValid
    ? t("portRange")
    : needsOrigin
      ? t("needsOrigin")
      : needsToken
        ? t("needsToken")
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
                    cloudflareManaged: managed,
                    mode,
                    origin: origin.trim(),
                    port,
                    ...(token.trim() ? { cloudflareToken: token.trim() } : {}),
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
              if (MODES.includes(value as Mode)) setMode(value as Mode);
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
              {managed ? (
                <>
                  <div className="grid gap-1.5">
                    <Label htmlFor="remote-cloudflare-token">
                      {t("cloudflareToken")}
                    </Label>
                    <Input
                      autoComplete="off"
                      id="remote-cloudflare-token"
                      onChange={(event) => setToken(event.target.value)}
                      placeholder={
                        status.cloudflare?.tokenSaved
                          ? t("cloudflareTokenSaved")
                          : "eyJ…"
                      }
                      spellCheck={false}
                      type="password"
                      value={token}
                    />
                    <p className="text-muted-foreground text-xs">
                      {t("cloudflareTokenHint")}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 rounded-md border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm">cloudflared</div>
                      <div className="text-muted-foreground text-xs">
                        {status.cloudflare?.version ?? t("cloudflareMissing")}
                      </div>
                    </div>
                    <Button
                      disabled={installing}
                      onClick={onInstallCloudflare}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {installing ? <Spinner className="size-3.5" /> : null}
                      {t(
                        status.cloudflare?.installed
                          ? "cloudflareUpdate"
                          : "cloudflareInstall",
                      )}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground text-xs">
                  {t("cloudflareExternal")}
                </p>
              )}
              <div className="grid gap-2">
                <p className="select-text break-words text-muted-foreground text-xs">
                  {t("cloudflareRouteHint", { port: shownPort })}
                </p>
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
              {mode === "cloudflare" ? (
                <Label className="flex items-center gap-2 font-normal">
                  <Checkbox
                    checked={!managed}
                    onCheckedChange={(checked) => setManaged(!checked)}
                  />
                  {t("cloudflareSelfManaged")}
                </Label>
              ) : null}
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
