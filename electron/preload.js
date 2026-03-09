import { contextBridge, ipcRenderer } from "electron";

const subscribe = (channel, listener) => {
  const subscription = (_event, payload) => {
    listener(payload);
  };

  ipcRenderer.on(channel, subscription);

  return () => {
    ipcRenderer.removeListener(channel, subscription);
  };
};

contextBridge.exposeInMainWorld("dream", {
  isElectron: true,

  openExternal: (url) => ipcRenderer.invoke("shell:open-external", { url }),

  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowMaximize: () => ipcRenderer.invoke("window:maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),

  pickProjectDirectory: () => ipcRenderer.invoke("projects:pick-directory"),
  importCodexThreads: () => ipcRenderer.invoke("codex:import-threads"),

  loadState: () => ipcRenderer.invoke("state:load"),
  saveState: (state) => ipcRenderer.invoke("state:save", state),

  startTerminal: (payload) => ipcRenderer.invoke("terminal:start", payload),
  sendTerminalInput: (payload) => ipcRenderer.send("terminal:input", payload),
  stopTerminal: (projectId) =>
    ipcRenderer.invoke("terminal:stop", { projectId }),
  onTerminalData: (listener) => subscribe("terminal:data", listener),
  onTerminalStatus: (listener) => subscribe("terminal:status", listener),

  updatePreview: (payload) => ipcRenderer.send("preview:update", payload),
  onPreviewError: (listener) => subscribe("preview:error", listener),
  onPreviewStatus: (listener) => subscribe("preview:status", listener),
});
