import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const COLLAPSED_USER_MESSAGE_HEIGHT_PX = 192;

export const CollapsibleUserMessage = ({
  children,
}: {
  children: ReactNode;
}) => {
  const aiT = useTranslations("aiElements");
  const contentId = useId();
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCollapsible, setIsCollapsible] = useState(false);
  const handleContentRef = useCallback((element: HTMLDivElement | null) => {
    setContentElement(element);
  }, []);

  useEffect(() => {
    if (!contentElement) {
      setIsCollapsible(false);
      return;
    }

    const updateCollapsibleState = () => {
      const shouldCollapse =
        contentElement.getBoundingClientRect().height >
        COLLAPSED_USER_MESSAGE_HEIGHT_PX + 1;
      setIsCollapsible(shouldCollapse);
      if (!shouldCollapse) {
        setIsExpanded(false);
      }
    };

    updateCollapsibleState();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateCollapsibleState);
      return () => window.removeEventListener("resize", updateCollapsibleState);
    }

    const resizeObserver = new ResizeObserver(updateCollapsibleState);
    resizeObserver.observe(contentElement);
    window.addEventListener("resize", updateCollapsibleState);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateCollapsibleState);
    };
  }, [contentElement]);

  const toggleExpanded = useCallback(() => {
    setIsExpanded((current) => !current);
  }, []);

  return (
    <div className="min-w-0">
      <div
        className={cn("relative", !isExpanded && "overflow-hidden")}
        id={contentId}
        style={
          isExpanded
            ? undefined
            : { maxHeight: COLLAPSED_USER_MESSAGE_HEIGHT_PX }
        }
      >
        <div ref={handleContentRef}>{children}</div>
        {isCollapsible && !isExpanded ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-secondary to-transparent"
          />
        ) : null}
      </div>
      {isCollapsible ? (
        <Button
          aria-controls={contentId}
          aria-expanded={isExpanded}
          className="mt-1 h-6 px-1.5 text-xs"
          onClick={toggleExpanded}
          size="xs"
          type="button"
          variant="ghost"
        >
          {isExpanded ? (
            <ChevronUpIcon aria-hidden="true" />
          ) : (
            <ChevronDownIcon aria-hidden="true" />
          )}
          {isExpanded ? aiT("showLess") : aiT("showMore")}
        </Button>
      ) : null}
    </div>
  );
};
