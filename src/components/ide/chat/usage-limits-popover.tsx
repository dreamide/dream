import { GaugeIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import anthropicLogo from "@/assets/anthropic.svg";
import openAiLogo from "@/assets/openai.svg";
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

type UsageLimitsResponse = {
  error?: string | null;
  fetchedAt?: string;
  limits?: UsageLimitWindow[];
  provider?: ChatConfig["provider"];
  source?: string;
  status?: "ok" | "unavailable";
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

export const UsageLimitsPopover = ({
  provider,
}: {
  provider: ChatConfig["provider"];
}) => {
  const [open, setOpen] = useState(false);
  const [usageLimits, setUsageLimits] = useState<UsageLimitsState>({
    data: null,
    error: null,
    loading: false,
  });
  const logoSrc = provider === "anthropic" ? anthropicLogo : openAiLogo;
  const now = Date.now();
  const limits = usageLimits.data?.limits ?? [];

  const fetchUsageLimits = useCallback(async () => {
    setUsageLimits((current) => ({
      ...current,
      error: null,
      loading: true,
    }));

    try {
      const response = await fetch("/api/provider-usage-limits", {
        body: JSON.stringify({ provider }),
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
  }, [provider]);

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
            aria-label="Usage limits"
            className="h-7 border-none bg-transparent px-2 text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
            title="Usage limits"
            type="button"
            variant="ghost"
          />
        }
      >
        <GaugeIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 gap-4 rounded-lg bg-popover p-3"
        side="top"
      >
        <div className="flex items-center gap-2 font-medium text-sm">
          <img
            alt=""
            aria-hidden="true"
            className="size-4 shrink-0 dark:invert"
            src={logoSrc}
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
