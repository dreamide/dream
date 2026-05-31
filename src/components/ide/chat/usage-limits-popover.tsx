import { GaugeIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ProviderIcon } from "@/components/ai-elements/provider-icons";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import type { ChatConfig } from "@/types/ide";
import { PROVIDER_LABELS } from "./chat-message";

const USAGE_LIMIT_PERCENT_MAX = 100;

type UsageLimitWindow = {
  label: string;
  resetAfterSeconds?: number | null;
  resetAt?: string | null;
  usedPercent: number;
};

type UsageStatRow = {
  label: string;
  value: string;
};

type ModelUsageStat = {
  id: string;
  stats: UsageStatRow[];
};

type UsageLimitsResponse = {
  error?: string | null;
  fetchedAt?: string;
  limits?: UsageLimitWindow[];
  modelStats?: ModelUsageStat[];
  note?: string | null;
  provider?: ChatConfig["provider"];
  source?: string;
  stats?: UsageStatRow[];
  status?: "ok" | "unavailable";
  toolStats?: UsageStatRow[];
};

type UsageLimitsState = {
  data: UsageLimitsResponse | null;
  error: string | null;
  loading: boolean;
};

const formatResetDuration = (resetAfterMs: number) => {
  const totalMinutes = Math.max(0, Math.ceil(resetAfterMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    if (hours === 0) {
      return `${days}d`;
    }

    return `${days}d ${hours}h`;
  }

  if (hours === 0) {
    return `${minutes}m`;
  }

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
};

const formatResetAt = (resetAt: Date) =>
  new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(resetAt);

const getUsageLimitResetAfterMs = (limit: UsageLimitWindow, now: number) => {
  if (limit.resetAt) {
    const resetAtMs = Date.parse(limit.resetAt);
    if (!Number.isNaN(resetAtMs)) {
      return Math.max(0, resetAtMs - now);
    }
  }

  if (
    typeof limit.resetAfterSeconds === "number" &&
    Number.isFinite(limit.resetAfterSeconds)
  ) {
    return Math.max(0, limit.resetAfterSeconds * 1000);
  }

  return null;
};

const UsageLimitRow = ({
  now,
  limit,
}: {
  now: number;
  limit: UsageLimitWindow;
}) => {
  const usedPercent = Math.max(
    0,
    Math.min(USAGE_LIMIT_PERCENT_MAX, limit.usedPercent),
  );
  const resetAfterMs = getUsageLimitResetAfterMs(limit, now);
  const resetAt =
    limit.resetAt && !Number.isNaN(Date.parse(limit.resetAt))
      ? new Date(limit.resetAt)
      : resetAfterMs === null
        ? null
        : new Date(now + resetAfterMs);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-4 text-xs">
        <span>{limit.label}</span>
        <span>{usedPercent}% used</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-black dark:bg-white"
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-4 text-[11px] text-muted-foreground">
        {resetAfterMs === null || resetAt === null ? (
          <span>Reset time unavailable</span>
        ) : (
          <>
            <span>Resets in {formatResetDuration(resetAfterMs)}</span>
            <span>{formatResetAt(resetAt)}</span>
          </>
        )}
      </div>
    </div>
  );
};

const getModelUsageStatValue = (model: ModelUsageStat, label: string) =>
  model.stats.find((stat) => stat.label === label)?.value;

const OpenCodeUsageStats = ({
  modelStats,
  stats,
}: {
  modelStats: ModelUsageStat[];
  stats: UsageStatRow[];
}) => (
  <div className="space-y-3">
    {stats.length > 0 ? (
      <div className="grid grid-cols-2 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="min-w-0 rounded-md bg-muted/50 p-2">
            <div className="truncate text-[11px] text-muted-foreground">
              {stat.label}
            </div>
            <div className="truncate font-medium text-sm">{stat.value}</div>
          </div>
        ))}
      </div>
    ) : null}
    {modelStats.length > 0 ? (
      <div className="space-y-2">
        <div className="font-medium text-xs">Top models</div>
        <div className="space-y-2">
          {modelStats.slice(0, 3).map((model) => {
            const messages = getModelUsageStatValue(model, "Messages");
            const cost = getModelUsageStatValue(model, "Cost");

            return (
              <div key={model.id} className="min-w-0 space-y-0.5">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate">{model.id}</span>
                  {messages ? (
                    <span className="shrink-0 text-muted-foreground">
                      {messages} msgs
                    </span>
                  ) : null}
                </div>
                {cost ? (
                  <div className="truncate text-[11px] text-muted-foreground">
                    {cost}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    ) : null}
  </div>
);

export const UsageLimitsPopover = ({
  provider,
  projectPath,
}: {
  provider: ChatConfig["provider"];
  projectPath?: string;
}) => {
  const [open, setOpen] = useState(false);
  const [usageLimits, setUsageLimits] = useState<UsageLimitsState>({
    data: null,
    error: null,
    loading: false,
  });
  const now = Date.now();
  const limits = usageLimits.data?.limits ?? [];
  const stats = usageLimits.data?.stats ?? [];
  const modelStats = usageLimits.data?.modelStats ?? [];
  const hasUsageStats = stats.length > 0 || modelStats.length > 0;
  const usageTitle = provider === "opencode" ? "Usage stats" : "Usage limits";

  const fetchUsageLimits = useCallback(async () => {
    setUsageLimits((current) => ({
      ...current,
      error: null,
      loading: true,
    }));

    try {
      const response = await fetch("/api/provider-usage-limits", {
        body: JSON.stringify({
          provider,
          ...(provider === "opencode" && projectPath ? { projectPath } : {}),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Usage limits request failed (${response.status}).`);
      }

      const data = (await response.json()) as UsageLimitsResponse;
      setUsageLimits({
        data,
        error: data.status === "unavailable" ? (data.error ?? null) : null,
        loading: false,
      });
    } catch (error) {
      setUsageLimits((current) => ({
        ...current,
        error:
          error instanceof Error
            ? error.message
            : "Unable to fetch usage limits.",
        loading: false,
      }));
    }
  }, [projectPath, provider]);

  useEffect(() => {
    if (!open) {
      return;
    }

    void fetchUsageLimits();
    const intervalId = window.setInterval(fetchUsageLimits, 60_000);
    return () => window.clearInterval(intervalId);
  }, [fetchUsageLimits, open]);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={usageTitle}
            className="h-7 border-none bg-transparent px-2 text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
            title={usageTitle}
            type="button"
            variant="ghost"
          />
        }
      >
        <GaugeIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 gap-4 rounded-lg bg-popover p-3"
        side="top"
      >
        <div className="flex items-center gap-2 font-medium text-sm">
          <ProviderIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-foreground"
            provider={provider}
            role="presentation"
          />
          <span>{PROVIDER_LABELS[provider]}</span>
        </div>
        <div className="space-y-4">
          {usageLimits.loading && !usageLimits.data ? (
            <div className="flex justify-center py-2 text-muted-foreground">
              <Spinner className="size-4" />
            </div>
          ) : limits.length > 0 ? (
            limits.map((limit) => (
              <UsageLimitRow key={limit.label} limit={limit} now={now} />
            ))
          ) : hasUsageStats ? (
            <OpenCodeUsageStats modelStats={modelStats} stats={stats} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {usageLimits.error ?? "Usage limits are unavailable."}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
