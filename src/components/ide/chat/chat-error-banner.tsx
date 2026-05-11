import { AlertCircle, X } from "lucide-react";

export interface ChatErrorBannerProps {
  error: string;
  onDismiss: () => void;
}

export const ChatErrorBanner = ({ error, onDismiss }: ChatErrorBannerProps) => (
  <div className="shrink-0 px-2 pb-1">
    <div className="mx-auto flex w-full max-w-[700px] items-start gap-2 rounded-md border border-destructive-border bg-destructive-surface px-3 py-2 text-sm text-destructive">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{error}</span>
      <button
        type="button"
        className="mt-0.5 shrink-0 rounded p-0.5 hover:bg-destructive-surface"
        onClick={onDismiss}
      >
        <X className="size-3.5" />
      </button>
    </div>
  </div>
);
