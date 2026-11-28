import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { visibleQueueRuns } from "@/lib/chat-queue";
import { chatQueues } from "../ide-store";

export function ChatQueue({ chatId }: { chatId: string }) {
  const t = useTranslations("chat");
  const view = useStore(chatQueues.views, (state) => state.get(chatId));
  const { queue, error } = view ?? {};
  useEffect(() => {
    void chatQueues.refresh(chatId);
  }, [chatId]);
  const runs = visibleQueueRuns(queue?.runs ?? []);
  if (!runs.length && !error) return null;
  return (
    <div
      className="mx-auto mb-2 w-full max-w-[700px] rounded-md border p-2 text-sm"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2">
        <span>{t(queue?.paused ? "queuePaused" : "queueTitle")}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void chatQueues.control({
              chatId,
              action: queue?.paused ? "resume" : "pause",
            })
          }
        >
          {t(queue?.paused ? "queueResume" : "queuePause")}
        </Button>
      </div>
      {error ? (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <ol className="max-h-40 overflow-y-auto">
        {runs.map((run) => (
          <li key={run.id} className="mt-2 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate">{run.text || t("queueAttachment")}</p>
              <p className="text-xs text-muted-foreground">
                {run.model} · {t(`queueStatus.${run.status}`)}
              </p>
              {run.error ? (
                <p className="text-xs text-destructive">{run.error}</p>
              ) : run.status === "interrupted" ? (
                <p className="text-xs text-muted-foreground">
                  {t("queueInterruptedHint")}
                </p>
              ) : null}
            </div>
            {run.status === "failed" || run.status === "interrupted" ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void chatQueues.control({
                    chatId,
                    action: "cancel",
                    id: run.id,
                  })
                }
              >
                {t("queueRemove")}
              </Button>
            ) : null}
            {run.status === "queued" ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void chatQueues.control({
                    chatId,
                    action: "cancel",
                    id: run.id,
                  })
                }
              >
                {t("queueCancel")}
              </Button>
            ) : null}
            {run.status === "failed" || run.status === "interrupted" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void chatQueues.control({
                    chatId,
                    action: "retry",
                    id: run.id,
                  })
                }
              >
                {t("queueRetry")}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
