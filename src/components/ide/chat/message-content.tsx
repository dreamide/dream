import type { UIMessage } from "ai";
import { PaperclipIcon } from "lucide-react";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import { MessageResponse } from "@/components/ai-elements/message";
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import { Badge } from "@/components/ui/badge";

export const PromptAttachments = () => {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <Attachments className="w-full px-3 pt-3" variant="inline">
      {attachments.files.map((file) => (
        <Attachment
          data={file}
          key={file.id}
          onRemove={() => attachments.remove(file.id)}
        >
          <AttachmentPreview />
          <AttachmentInfo />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
};

export const UserMessageContent = ({ message }: { message: UIMessage }) => {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const attachments = parts.flatMap((part) => {
    if (!part || typeof part !== "object" || part.type !== "file") {
      return [];
    }

    const label =
      (typeof part.filename === "string" && part.filename.trim()) ||
      (typeof part.mediaType === "string" && part.mediaType.trim()) ||
      "attachment";

    return [
      {
        key:
          (typeof part.url === "string" && part.url) ||
          `${label}-${typeof part.mediaType === "string" ? part.mediaType : "file"}`,
        label,
      },
    ];
  });
  const text = getMessageText(message);

  return (
    <>
      {attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map(({ key, label }) => (
            <Badge
              className="max-w-full gap-1.5 rounded-full bg-muted px-2.5 py-1 font-medium text-foreground"
              key={key}
              variant="secondary"
            >
              <PaperclipIcon className="size-3 shrink-0" />
              <span className="truncate font-mono text-xs">
                Attached file: {label}
              </span>
            </Badge>
          ))}
        </div>
      ) : null}
      {text ? <MessageResponse>{text}</MessageResponse> : null}
    </>
  );
};

export const getMessageText = (message: UIMessage) =>
  message.parts
    .flatMap((part) => {
      if (!part || typeof part !== "object" || part.type !== "text") {
        return [];
      }

      const value = typeof part.text === "string" ? part.text.trim() : "";
      return value ? [value] : [];
    })
    .join("\n\n");
