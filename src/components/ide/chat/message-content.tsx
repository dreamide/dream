import type { UIMessage } from "ai";
import { PaperclipIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
  getMediaCategory,
} from "@/components/ai-elements/attachments";
import { MessageResponse } from "@/components/ai-elements/message";
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ProjectReference } from "@/types/ide";
import { MaterialFileIcon, MaterialFolderIcon } from "../material-file-icon";
import {
  MarkdownFileLink,
  normalizeProjectFileLinksInMarkdown,
} from "./markdown-file-link";

const isProjectReferenceMentionBoundary = (character: string | undefined) =>
  !character || /\s|[),.;:!?]/.test(character);

const hasInlineProjectReferenceMention = (
  text: string,
  reference: ProjectReference,
) => {
  const mention = `@${reference.path}`;
  let index = text.indexOf(mention);

  while (index !== -1) {
    if (isProjectReferenceMentionBoundary(text.at(index + mention.length))) {
      return true;
    }
    index = text.indexOf(mention, index + mention.length);
  }

  return false;
};

const escapeMarkdownLinkDestination = (value: string) =>
  value.replace(/>/g, "%3E");

const normalizeInlineProjectReferenceMentions = (
  text: string,
  references: ProjectReference[],
) => {
  if (!text || references.length === 0) {
    return text;
  }

  const sortedReferences = [...references].sort(
    (left, right) => right.path.length - left.path.length,
  );
  let output = "";
  let index = 0;

  while (index < text.length) {
    const reference = sortedReferences.find((item) => {
      const mention = `@${item.path}`;
      return (
        text.startsWith(mention, index) &&
        isProjectReferenceMentionBoundary(text.at(index + mention.length))
      );
    });

    if (!reference) {
      output += text[index];
      index += 1;
      continue;
    }

    const mention = `@${reference.path}`;
    output += `[${reference.name}](<${escapeMarkdownLinkDestination(
      reference.path,
    )}>)`;
    index += mention.length;
  }

  return output;
};

export const PromptAttachments = () => {
  const assistantT = useTranslations("assistant");
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <Attachments
      className="w-full shrink-0 basis-full px-3 pt-3"
      variant="inline"
    >
      {attachments.files.map((file) => {
        const isImage =
          file.type === "file" &&
          getMediaCategory(file) === "image" &&
          file.url;

        const attachment = (
          <Attachment
            data={file}
            key={file.id}
            onRemove={() => attachments.remove(file.id)}
          >
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </Attachment>
        );

        if (!isImage) {
          return attachment;
        }

        return (
          <Dialog key={file.id}>
            <DialogTrigger render={<div className="cursor-pointer" />}>
              {attachment}
            </DialogTrigger>
            <DialogContent className="flex w-fit max-h-[90vh] max-w-[90vw] items-center justify-center overflow-visible border-0 bg-transparent p-0 shadow-none sm:max-w-[90vw]">
              <DialogTitle className="sr-only">
                {file.filename || assistantT("image")}
              </DialogTitle>
              <img
                alt={file.filename || assistantT("image")}
                className="mx-auto max-h-[85vh] w-auto rounded-lg object-contain shadow-md"
                src={file.url}
              />
            </DialogContent>
          </Dialog>
        );
      })}
    </Attachments>
  );
};

const ImageAttachmentPreview = ({
  label,
  url,
}: {
  label: string;
  url: string;
}) => {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            className="max-w-48 cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
          />
        }
      >
        <img
          alt={label}
          className="block max-h-48 w-auto rounded-lg object-contain shadow-md"
          src={url}
        />
      </DialogTrigger>
      <DialogContent className="flex w-fit max-h-[90vh] max-w-[90vw] items-center justify-center overflow-visible border-0 bg-transparent p-0 shadow-none sm:max-w-[90vw]">
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <img
          alt={label}
          className="mx-auto max-h-[85vh] w-auto rounded-lg object-contain shadow-md"
          src={url}
        />
      </DialogContent>
    </Dialog>
  );
};

export const UserMessageContent = ({
  message,
  projectPath,
}: {
  message: UIMessage;
  projectPath: string;
}) => {
  const assistantT = useTranslations("assistant");
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const attachments = parts.flatMap((part) => {
    if (!part || typeof part !== "object" || part.type !== "file") {
      return [];
    }

    const label =
      (typeof part.filename === "string" && part.filename.trim()) ||
      (typeof part.mediaType === "string" && part.mediaType.trim()) ||
      assistantT("attachment");

    const url = typeof part.url === "string" ? part.url : undefined;
    const mediaType =
      typeof part.mediaType === "string" ? part.mediaType : undefined;
    const isImage = mediaType?.startsWith("image/") ?? false;

    return [
      {
        key:
          url ||
          `${label}-${typeof part.mediaType === "string" ? part.mediaType : "file"}`,
        label,
        url,
        isImage,
      },
    ];
  });
  const text = getMessageText(message);
  const metadata = message.metadata as
    | { projectReferences?: ProjectReference[] }
    | undefined;
  const projectReferences = Array.isArray(metadata?.projectReferences)
    ? metadata.projectReferences
    : [];
  const hasInlineProjectReferences = projectReferences.some((reference) =>
    hasInlineProjectReferenceMention(text, reference),
  );
  const renderedText = hasInlineProjectReferences
    ? normalizeInlineProjectReferenceMentions(text, projectReferences)
    : text;

  return (
    <>
      {projectReferences.length > 0 && !hasInlineProjectReferences ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {projectReferences.map((reference) => (
            <Badge
              className="max-w-full gap-1.5 rounded-full border border-info-border bg-info-surface px-2.5 py-1 font-medium text-info-foreground dark:text-info-foreground"
              key={`${reference.kind}:${reference.path}`}
              variant="secondary"
            >
              {reference.kind === "folder" ? (
                <MaterialFolderIcon
                  className="size-3.5 shrink-0"
                  name={reference.name}
                />
              ) : (
                <MaterialFileIcon
                  className="size-3.5 shrink-0"
                  path={reference.path}
                />
              )}
              <span className="truncate font-mono text-xs">
                {reference.path}
              </span>
            </Badge>
          ))}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map(({ key, label, url, isImage }) =>
            isImage && url ? (
              <ImageAttachmentPreview key={key} label={label} url={url} />
            ) : (
              <Badge
                className="max-w-full gap-1.5 rounded-full bg-muted px-2.5 py-1 font-medium text-foreground"
                key={key}
                variant="secondary"
              >
                <PaperclipIcon className="size-3 shrink-0" />
                <span className="truncate font-mono text-xs">
                  {assistantT("attachedFileLabel", { name: label })}
                </span>
              </Badge>
            ),
          )}
        </div>
      ) : null}
      {text ? (
        <MessageResponse
          components={{
            a: (props) => (
              <MarkdownFileLink {...props} projectPath={projectPath} />
            ),
          }}
        >
          {normalizeProjectFileLinksInMarkdown(renderedText, projectPath)}
        </MessageResponse>
      ) : null}
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
