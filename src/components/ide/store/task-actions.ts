import { createTask } from "@/lib/ide-defaults";
import { renderTaskPrompt } from "@/lib/task-prompt";
import type { Task } from "@/types/ide";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";

const replaceTask = (
  tasks: Task[],
  taskId: string,
  updater: (task: Task) => Task,
): Task[] => {
  let changed = false;
  const next = tasks.map((task) => {
    if (task.id !== taskId) {
      return task;
    }
    const updated = updater(task);
    changed ||= updated !== task;
    return updated;
  });
  return changed ? next : tasks;
};

export const createTaskActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  "addTask" | "updateTask" | "deleteTask" | "moveTask" | "runTask"
> => ({
  addTask: ({ prompt, title }) => {
    if (!title.trim() || !prompt.trim()) {
      return null;
    }

    const task = createTask({ prompt, title });
    set((state) => ({ tasks: [...state.tasks, task] }));
    return task.id;
  },

  updateTask: (taskId, updates) => {
    set((state) => {
      const tasks = replaceTask(state.tasks, taskId, (task) => {
        const title = updates.title?.trim() || task.title;
        const prompt = updates.prompt?.trim() || task.prompt;
        return title === task.title && prompt === task.prompt
          ? task
          : { ...task, prompt, title, updatedAt: new Date().toISOString() };
      });
      return tasks === state.tasks ? state : { tasks };
    });
  },

  deleteTask: (taskId) => {
    set((state) =>
      state.tasks.some((task) => task.id === taskId)
        ? { tasks: state.tasks.filter((task) => task.id !== taskId) }
        : state,
    );
  },

  moveTask: (taskId, index) => {
    set((state) => {
      const from = state.tasks.findIndex((task) => task.id === taskId);
      if (from < 0) {
        return state;
      }
      const to = Math.max(0, Math.min(index, state.tasks.length - 1));
      if (from === to) {
        return state;
      }
      const tasks = [...state.tasks];
      const [task] = tasks.splice(from, 1);
      tasks.splice(to, 0, task as Task);
      return { tasks };
    });
  },

  runTask: (projectId, taskId, { branch, chatId }) => {
    const state = get();
    const project = state.projects.find((entry) => entry.id === projectId);
    const task = state.tasks.find((entry) => entry.id === taskId);
    const chat = state.chats.find((entry) => entry.id === chatId);
    if (
      !project ||
      !task ||
      !chat ||
      chat.projectId !== projectId ||
      chat.deletedAt !== null
    ) {
      return false;
    }

    const text = renderTaskPrompt({ branch, project, prompt: task.prompt });
    // If the send fails, the prompt lands in the composer instead of being lost.
    return (
      text.length > 0 &&
      state.queueChatSubmit(chatId, {
        preserveDraft: true,
        references: [],
        text,
      })
    );
  },
});
