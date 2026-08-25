import fs from "node:fs";

const p = "src/components/ide/file-explorer-panel.tsx";
let s = fs.readFileSync(p, "utf8");
const rep = (from, to) => {
  const i = s.indexOf(from);
  if (i === -1) throw new Error("not found: " + from.slice(0, 80));
  if (s.indexOf(from, i + 1) !== -1)
    throw new Error("ambiguous: " + from.slice(0, 80));
  s = s.slice(0, i) + to + s.slice(i + from.length);
};

// 1. Cut the old header block out of the editor.
const headerStart = "                <CodeBlockHeader className=";
const headerEnd = "                </CodeBlockHeader>\n";
const a = s.indexOf(headerStart);
const b = s.indexOf(headerEnd, a);
if (a === -1 || b === -1) throw new Error("header not found");
s = s.slice(0, a) + s.slice(b + headerEnd.length);

// 2. Actions in the tab row (only when a text buffer is active).
rep(
  `                onReorder={handleReorderTabs}
              />
            </div>
          ) : null}`,
  `                onReorder={handleReorderTabs}
              />
              {selectedFilePath &&
              selectedFileBuffer &&
              selectedFileBufferKey &&
              !isImageFile(selectedFilePath) ? (
                <div className="ml-2 flex shrink-0 items-center gap-1">
                  {selectedFileBuffer.status === "dirty" ||
                  selectedFileBuffer.status === "conflict" ? (
                    <Button
                      onClick={handleDiscardChanges}
                      size="xs"
                      type="button"
                      variant="ghost"
                    >
                      Discard changes
                    </Button>
                  ) : null}
                  <Button
                    aria-label={uiT("searchCurrentFile")}
                    aria-pressed={isEditorSearchOpen}
                    className={
                      isEditorSearchOpen
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground"
                    }
                    onClick={() =>
                      setEditorSearchRequest((current) => current + 1)
                    }
                    size="icon-xs"
                    title={uiT("searchCurrentFile")}
                    type="button"
                    variant="ghost"
                  >
                    <Search className="size-3.5" />
                  </Button>
                  <CodeBlockCopyButton text={selectedFileBuffer.draftContent} />
                  <Button
                    aria-label={commonT("save")}
                    className={
                      selectedFileBuffer.draftContent !==
                      selectedFileBuffer.diskContent
                        ? undefined
                        : "text-muted-foreground"
                    }
                    disabled={
                      selectedFileBuffer.status !== "dirty" ||
                      !selectedFileMetadata?.writable
                    }
                    onClick={() => void handleSaveEditing()}
                    size="icon-xs"
                    title={commonT("save")}
                    type="button"
                    variant={
                      selectedFileBuffer.draftContent !==
                      selectedFileBuffer.diskContent
                        ? "accent-subtle"
                        : "ghost"
                    }
                  >
                    {selectedFileBuffer.status === "saving" ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}`,
);

// 3. Prune unused imports.
rep(
  `import {
  CodeBlockActions,
  CodeBlockContainer,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";`,
  `import {
  CodeBlockContainer,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";`,
);

fs.writeFileSync(p, s);
console.log("edited");
