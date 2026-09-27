import { CheckIcon, CopyIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogTitle } from "@/components/ui/dialog";
import { copyImageToClipboard } from "@/lib/copy-image";

const COPIED_FEEDBACK_MS = 2000;

/**
 * Fullscreen image shown inside a <Dialog>. Hovering the image reveals a
 * copy button in its top-right corner.
 */
export const ImageLightboxContent = ({
  label,
  url,
}: {
  label: string;
  url: string;
}) => {
  const t = useTranslations("imageViewer");
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const resetTimerRef = useRef<number>(0);

  useEffect(() => () => window.clearTimeout(resetTimerRef.current), []);

  const handleCopy = async () => {
    setCopying(true);
    try {
      await copyImageToClipboard(url);
      setCopied(true);
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(
        () => setCopied(false),
        COPIED_FEEDBACK_MS,
      );
    } catch (error) {
      toast.error(t("copyFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCopying(false);
    }
  };

  const buttonLabel = copied ? t("copied") : t("copyImage");

  return (
    <DialogContent className="flex w-fit max-h-[90vh] max-w-[90vw] items-center justify-center overflow-visible border-0 bg-transparent p-0 shadow-none sm:max-w-[90vw]">
      <DialogTitle className="sr-only">{label}</DialogTitle>
      <div className="group/lightbox relative">
        <img
          alt={label}
          className="mx-auto max-h-[85vh] w-auto rounded-lg object-contain shadow-md"
          src={url}
        />
        <Button
          aria-label={buttonLabel}
          className="absolute top-2 right-2 bg-background/80 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover/lightbox:opacity-100 focus-visible:opacity-100 data-[copied=true]:opacity-100"
          data-copied={copied}
          disabled={copying}
          onClick={() => {
            void handleCopy();
          }}
          size="icon-sm"
          title={buttonLabel}
          type="button"
          variant="outline"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </DialogContent>
  );
};
