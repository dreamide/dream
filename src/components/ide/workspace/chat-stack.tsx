import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { ChatPanel } from "../chat-panel";
import { CHAT_PANEL_MIN_HEIGHT_PX } from "./constants";

export interface WorkspaceChatStackProps {
  active: boolean;
  activeChatId: string | null;
  mountedChats: ChatConfig[];
  project: ProjectConfig;
}

export const WorkspaceChatStack = ({
  active,
  activeChatId,
  mountedChats,
  project,
}: WorkspaceChatStackProps) => (
  <div
    className="min-h-0 flex-1"
    style={{ minHeight: CHAT_PANEL_MIN_HEIGHT_PX }}
  >
    {mountedChats.length > 0
      ? mountedChats.map((chat) => {
          const isVisible = chat.id === activeChatId;

          return (
            <div
              aria-hidden={!isVisible}
              inert={!isVisible}
              key={chat.id}
              className={isVisible ? "flex h-full min-h-0 flex-col" : "hidden"}
            >
              <ChatPanel
                isActive={active && isVisible}
                project={project}
                chat={chat}
              />
            </div>
          );
        })
      : null}
  </div>
);
