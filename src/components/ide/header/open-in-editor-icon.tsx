import { ExternalLink, TerminalSquare } from "lucide-react";
import cursorIcon from "material-icon-theme/icons/cursor.svg";
import sublimeIcon from "material-icon-theme/icons/sublime.svg";
import vimIcon from "material-icon-theme/icons/vim.svg";
import powershellIcon from "@/assets/powershell.svg";
import vscodeIcon from "@/assets/vscode.svg";
import { cn } from "@/lib/utils";
import type { DetectedEditor } from "@/types/ide";

const VscodeMark = ({ className }: { className?: string }) => (
  <img
    alt=""
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    src={vscodeIcon}
  />
);

const EditorImageMark = ({
  className,
  src,
}: {
  className?: string;
  src: string;
}) => (
  <img
    alt=""
    aria-hidden="true"
    className={cn("size-4 shrink-0 object-contain", className)}
    draggable={false}
    src={src}
  />
);

const FinderMark = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    fill="none"
    viewBox="0 0 32 32"
  >
    <rect fill="#63C7FF" height="26" rx="6" width="26" x="3" y="3" />
    <path d="M16 3h7a6 6 0 0 1 6 6v17H16z" fill="#2494FF" />
    <path d="M16 6v20" stroke="#0B5CAD" strokeLinecap="round" />
    <path d="M10.5 13.5v2" stroke="#073B78" strokeLinecap="round" />
    <path d="M21.5 13.5v2" stroke="#073B78" strokeLinecap="round" />
    <path
      d="M10.5 21.5c2.8 2 8.2 2 11 0"
      stroke="#073B78"
      strokeLinecap="round"
      strokeWidth="1.5"
    />
  </svg>
);

const WindowsExplorerMark = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    viewBox="0 0 32 32"
  >
    <path
      d="M3 10.5A4.5 4.5 0 0 1 7.5 6H13l2.3 3H24.5A4.5 4.5 0 0 1 29 13.5V24a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"
      fill="#F7C948"
    />
    <path d="M3 12h26v4H3z" fill="#E7A720" />
    <path
      d="M4 14h24.3l-2.2 10.8A4 4 0 0 1 22.2 28H6.9A4 4 0 0 1 3 23.2z"
      fill="#FFD865"
    />
    <path
      d="M5 15.5h22l-1.9 8.9A3 3 0 0 1 22.2 27H7a3 3 0 0 1-3-3.4z"
      fill="#F6B73C"
    />
    <path d="M8 17.5h16" stroke="#FFF2B3" strokeLinecap="round" />
  </svg>
);

const LinuxFilesMark = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    viewBox="0 0 32 32"
  >
    <rect fill="#4F86F7" height="22" rx="5" width="26" x="3" y="7" />
    <path d="M3 12h26v12a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z" fill="#2F6FEA" />
    <path d="M7 5h8l2 4H7a3 3 0 0 1 0-4" fill="#7AA7FF" />
    <path d="M8 15h16" stroke="#CFE0FF" strokeLinecap="round" />
  </svg>
);

const JETBRAINS_MARKS: Record<
  string,
  { accent: string; label: string; primary: string; secondary: string }
> = {
  idea: {
    accent: "#FF3158",
    label: "IJ",
    primary: "#FF6B00",
    secondary: "#7B2FFF",
  },
  phpstorm: {
    accent: "#B15CFF",
    label: "PS",
    primary: "#6F42FF",
    secondary: "#FF4FD8",
  },
  pycharm: {
    accent: "#F8E71C",
    label: "PC",
    primary: "#23D18B",
    secondary: "#21A1FF",
  },
  webstorm: {
    accent: "#00E5FF",
    label: "WS",
    primary: "#00A3FF",
    secondary: "#005CFF",
  },
};

const JetBrainsMark = ({
  className,
  editorId,
}: {
  className?: string;
  editorId: string;
}) => {
  const mark = JETBRAINS_MARKS[editorId] ?? JETBRAINS_MARKS.idea;

  return (
    <svg
      aria-hidden="true"
      className={cn("size-4 shrink-0", className)}
      viewBox="0 0 32 32"
    >
      <rect fill={mark.primary} height="32" rx="7" width="32" />
      <path d="M0 32 32 0v32z" fill={mark.secondary} />
      <path d="M0 0h32L0 22z" fill={mark.accent} opacity="0.9" />
      <rect fill="#111111" height="18" rx="1.5" width="18" x="7" y="7" />
      <text
        fill="#ffffff"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="7"
        fontWeight="800"
        x="10"
        y="19"
      >
        {mark.label}
      </text>
    </svg>
  );
};

const PowerShellMark = ({ className }: { className?: string }) => (
  <img
    alt=""
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    src={powershellIcon}
  />
);

export const OpenInEditorIcon = ({
  editor,
  isMacOs,
}: {
  editor: DetectedEditor;
  isMacOs: boolean;
}) => {
  if (editor.id === "vscode") {
    return <VscodeMark />;
  }

  if (editor.id === "cursor") {
    return <EditorImageMark src={cursorIcon} />;
  }

  if (editor.id in JETBRAINS_MARKS) {
    return <JetBrainsMark editorId={editor.id} />;
  }

  if (editor.id === "sublime") {
    return <EditorImageMark src={sublimeIcon} />;
  }

  if (editor.id === "vim" || editor.id === "neovim") {
    return <EditorImageMark src={vimIcon} />;
  }

  if (editor.isFileExplorer) {
    return isMacOs ? (
      <FinderMark />
    ) : editor.name === "File Explorer" ? (
      <WindowsExplorerMark />
    ) : (
      <LinuxFilesMark />
    );
  }

  if (editor.isTerminal) {
    return isMacOs ? (
      <TerminalSquare className="size-4 shrink-0" />
    ) : (
      <PowerShellMark />
    );
  }

  return <ExternalLink className="size-4 shrink-0" />;
};
