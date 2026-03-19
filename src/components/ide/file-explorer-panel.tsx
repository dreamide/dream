import { FileIcon, FolderIcon, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BundledLanguage } from "shiki";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { AppShellPlaceholder, PanelResizeHandle } from "./ide-helpers";
import { useIdeStore } from "./ide-store";

const PROJECT_FILE_LIST_MAX_RESULTS = 2000;
const FILE_TREE_MIN_WIDTH_PX = 250;
const FILE_TREE_MAX_WIDTH_RATIO = 0.5;

type ProjectFilesListResponse = {
  count: number;
  files: string[];
};

type ProjectFileReadResponse = {
  content: string;
  filePath: string;
};

interface FileTreeNode {
  name: string;
  path: string;
  children: Map<string, FileTreeNode>;
  isFile: boolean;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

const isImageFile = (filePath: string): boolean => {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(extension);
};

const inferLanguage = (filePath: string): BundledLanguage => {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  const languages: Record<string, BundledLanguage> = {
    c: "c",
    cpp: "cpp",
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    txt: "log",
    yml: "yaml",
    yaml: "yaml",
  };

  return languages[extension] ?? "log";
};

const buildFileTree = (
  paths: string[],
): { root: FileTreeNode; defaultExpanded: Set<string> } => {
  const root: FileTreeNode = {
    children: new Map(),
    isFile: false,
    name: "",
    path: "",
  };

  for (const filePath of paths) {
    const parts = filePath.split(/[\\/]/).filter(Boolean);
    let current = root;

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      const currentPath = parts.slice(0, index + 1).join("/");
      const isLast = index === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          children: new Map(),
          isFile: isLast,
          name: part,
          path: currentPath,
        });
      }

      const nextNode = current.children.get(part);
      if (!nextNode) {
        continue;
      }
      current = nextNode;
    }
  }

  const defaultExpanded = new Set<string>();
  for (const child of root.children.values()) {
    if (!child.isFile) {
      defaultExpanded.add(child.path);
    }
  }

  return { defaultExpanded, root };
};

const FileTreeNodeView = ({ node }: { node: FileTreeNode }) => {
  const sortedChildren = [...node.children.values()].sort((left, right) => {
    if (left.isFile !== right.isFile) {
      return left.isFile ? 1 : -1;
    }

    return left.name.localeCompare(right.name);
  });

  if (node.isFile) {
    return <FileTreeFile name={node.name} path={node.path} />;
  }

  return (
    <FileTreeFolder name={node.name} path={node.path}>
      {sortedChildren.map((child) => (
        <FileTreeNodeView key={child.path} node={child} />
      ))}
    </FileTreeFolder>
  );
};

const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

export const FileExplorerPanel = () => {
  const activeProject = useIdeStore((s) => s.getActiveProject());
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const treePaneRef = useRef<HTMLDivElement | null>(null);
  const treeWidthRef = useRef<number | null>(null);
  const treeWidthAtDragStart = useRef(0);

  const [fileListsByProject, setFileListsByProject] = useState<
    Record<string, string[]>
  >({});
  const [selectedFileByProject, setSelectedFileByProject] = useState<
    Record<string, string | null>
  >({});
  const [fileContentsByProject, setFileContentsByProject] = useState<
    Record<string, Record<string, string>>
  >({});
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const projectId = activeProject?.id ?? null;
  const projectPath = activeProject?.path ?? null;
  const files = projectId ? (fileListsByProject[projectId] ?? []) : [];
  const selectedFilePath = projectId
    ? (selectedFileByProject[projectId] ?? null)
    : null;
  const selectedFileContent =
    projectId && selectedFilePath
      ? (fileContentsByProject[projectId]?.[selectedFilePath] ?? null)
      : null;

  const loadProjectFiles = useCallback(async () => {
    if (!projectId || !projectPath) {
      return;
    }

    setFilesLoading(true);
    setFilesError(null);

    try {
      const response = await fetch("/api/project-files", {
        body: JSON.stringify({
          directory: ".",
          maxResults: PROJECT_FILE_LIST_MAX_RESULTS,
          projectPath,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(await readResponseText(response));
      }

      const payload = (await response.json()) as ProjectFilesListResponse;
      const nextFiles = payload.files;

      setFileListsByProject((current) => ({
        ...current,
        [projectId]: nextFiles,
      }));

      setSelectedFileByProject((current) => {
        const existingSelection = current[projectId] ?? null;
        if (existingSelection && nextFiles.includes(existingSelection)) {
          return current;
        }

        return {
          ...current,
          [projectId]: null,
        };
      });
    } catch (error) {
      setFilesError(
        error instanceof Error
          ? error.message
          : "Failed to load project files.",
      );
    } finally {
      setFilesLoading(false);
    }
  }, [projectId, projectPath]);

  useEffect(() => {
    if (!projectId || !projectPath) {
      return;
    }

    if (fileListsByProject[projectId]) {
      return;
    }

    void loadProjectFiles();
  }, [fileListsByProject, loadProjectFiles, projectId, projectPath]);

  useEffect(() => {
    if (!projectId || !projectPath || !selectedFilePath) {
      return;
    }

    if (isImageFile(selectedFilePath)) {
      return;
    }

    if (fileContentsByProject[projectId]?.[selectedFilePath]) {
      return;
    }

    let cancelled = false;

    const loadSelectedFile = async () => {
      setFileLoading(true);
      setFileError(null);

      try {
        const response = await fetch("/api/project-file", {
          body: JSON.stringify({
            filePath: selectedFilePath,
            projectPath,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        if (!response.ok) {
          throw new Error(await readResponseText(response));
        }

        const payload = (await response.json()) as ProjectFileReadResponse;
        if (cancelled) {
          return;
        }

        setFileContentsByProject((current) => ({
          ...current,
          [projectId]: {
            ...(current[projectId] ?? {}),
            [payload.filePath]: payload.content,
          },
        }));
      } catch (error) {
        if (!cancelled) {
          setFileError(
            error instanceof Error
              ? error.message
              : "Failed to read the selected file.",
          );
        }
      } finally {
        if (!cancelled) {
          setFileLoading(false);
        }
      }
    };

    void loadSelectedFile();

    return () => {
      cancelled = true;
    };
  }, [fileContentsByProject, projectId, projectPath, selectedFilePath]);

  const { defaultExpanded, root } = useMemo(() => {
    if (files.length === 0) {
      return { defaultExpanded: new Set<string>(), root: null };
    }

    return buildFileTree(files);
  }, [files]);

  const sortedChildren = useMemo(() => {
    if (!root) {
      return [];
    }

    return [...root.children.values()].sort((left, right) => {
      if (left.isFile !== right.isFile) {
        return left.isFile ? 1 : -1;
      }

      return left.name.localeCompare(right.name);
    });
  }, [root]);

  const handleTreeResizeStart = useCallback(() => {
    treeWidthAtDragStart.current =
      treePaneRef.current?.getBoundingClientRect().width ??
      FILE_TREE_MIN_WIDTH_PX;
  }, []);

  const handleTreeResize = useCallback((deltaX: number) => {
    const containerWidth =
      splitContainerRef.current?.getBoundingClientRect().width ?? 0;
    const maxWidth = Math.max(
      FILE_TREE_MIN_WIDTH_PX,
      containerWidth * FILE_TREE_MAX_WIDTH_RATIO,
    );
    const nextWidth = Math.min(
      maxWidth,
      Math.max(FILE_TREE_MIN_WIDTH_PX, treeWidthAtDragStart.current + deltaX),
    );

    treeWidthRef.current = nextWidth;
    if (treePaneRef.current) {
      treePaneRef.current.style.width = `${nextWidth}px`;
    }
  }, []);

  if (!activeProject) {
    return (
      <div className="flex h-full flex-col overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md">
        <div className="flex items-center gap-2 border-b border-foreground/10 px-3 py-2 text-sm font-medium">
          <FolderIcon className="size-4 text-muted-foreground" />
          <span></span>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <AppShellPlaceholder message="Add a project to browse its files." />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md">
      <div className="flex items-center gap-2 border-b border-foreground/10 px-3 py-2">
        <FolderIcon className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium"></div>
          <div className="truncate text-muted-foreground text-xs">
            {activeProject.path}
          </div>
        </div>
        <Button
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={() => void loadProjectFiles()}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {filesLoading ? (
            <Spinner className="size-3.5 text-muted-foreground" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
      </div>

      <div ref={splitContainerRef} className="flex min-h-0 flex-1">
        {/* File tree */}
        <div
          ref={treePaneRef}
          className="shrink-0 overflow-hidden"
          style={{
            width: `${treeWidthRef.current ?? FILE_TREE_MIN_WIDTH_PX}px`,
            minWidth: FILE_TREE_MIN_WIDTH_PX,
            maxWidth: `${FILE_TREE_MAX_WIDTH_RATIO * 100}%`,
          }}
        >
          <div className="h-full border-r border-foreground/10 bg-muted/20">
            <ScrollArea className="h-full">
              <div className="p-3">
                {filesError ? (
                  <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-xs">
                    {filesError}
                  </div>
                ) : null}

                {!filesError && filesLoading && files.length === 0 ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Spinner className="size-4" />
                    <span>Loading project files…</span>
                  </div>
                ) : null}

                {!filesError && !filesLoading && files.length === 0 ? (
                  <div className="text-muted-foreground text-sm">
                    No project files found.
                  </div>
                ) : null}

                {root ? (
                  <FileTree
                    className="border-0 bg-transparent p-0 text-xs shadow-none"
                    defaultExpanded={defaultExpanded}
                    onSelect={(path) => {
                      if (!files.includes(path)) {
                        return;
                      }

                      setSelectedFileByProject((current) => ({
                        ...current,
                        [activeProject.id]: path,
                      }));
                      setFileError(null);
                    }}
                    selectedPath={selectedFilePath ?? undefined}
                  >
                    {sortedChildren.map((child) => (
                      <FileTreeNodeView key={child.path} node={child} />
                    ))}
                  </FileTree>
                ) : null}
              </div>
            </ScrollArea>
          </div>
        </div>

        <PanelResizeHandle
          side="right"
          onResize={handleTreeResize}
          onResizeStart={handleTreeResizeStart}
        />

        {/* File content */}
        <div className="min-w-0 flex-1 overflow-hidden">
          {!selectedFilePath ? (
            <div className="h-full p-3">
              <AppShellPlaceholder message="Select a file from the tree to open it here." />
            </div>
          ) : fileError ? (
            <div className="p-3">
              <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm">
                {fileError}
              </div>
            </div>
          ) : fileLoading && !selectedFileContent ? (
            <div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
              <Spinner className="size-4" />
              <span>Opening {selectedFilePath}…</span>
            </div>
          ) : isImageFile(selectedFilePath) ? (
            <div className="flex h-full items-center justify-center p-6">
              <img
                alt={selectedFilePath}
                className="max-h-full max-w-full object-contain"
                src={`/api/project-file-raw?projectPath=${encodeURIComponent(projectPath ?? "")}&filePath=${encodeURIComponent(selectedFilePath)}`}
              />
            </div>
          ) : selectedFileContent !== null ? (
            <div className="h-full">
              <CodeBlock
                className="flex h-full max-h-full flex-col overflow-hidden rounded-none border-0 shadow-none [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
                code={selectedFileContent}
                language={inferLanguage(selectedFilePath)}
                showLineNumbers
                style={{ contentVisibility: "visible" }}
              >
                <CodeBlockHeader className="shrink-0 border-0 bg-transparent">
                  <CodeBlockTitle>
                    <FileIcon size={14} />
                    <CodeBlockFilename>{selectedFilePath}</CodeBlockFilename>
                  </CodeBlockTitle>
                  <CodeBlockActions>
                    <CodeBlockCopyButton />
                  </CodeBlockActions>
                </CodeBlockHeader>
              </CodeBlock>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
