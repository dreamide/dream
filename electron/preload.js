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
  writeClipboardText: (text) =>
    ipcRenderer.invoke("clipboard:write-text", { text }),
  saveTextFile: (payload) => ipcRenderer.invoke("files:save-text", payload),

  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowMaximize: () => ipcRenderer.invoke("window:maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),

  pickProjectDirectory: () => ipcRenderer.invoke("projects:pick-directory"),

  loadState: () => ipcRenderer.invoke("state:load"),
  saveState: (state) => ipcRenderer.invoke("state:save", state),

  getDefaultTerminalShell: () => ipcRenderer.invoke("terminal:get-default-shell"),
  startTerminal: (payload) => ipcRenderer.invoke("terminal:start", payload),
  sendTerminalInput: (payload) => ipcRenderer.send("terminal:input", payload),
  stopTerminal: (projectId) =>
    ipcRenderer.invoke("terminal:stop", { projectId }),
  onTerminalData: (listener) => subscribe("terminal:data", listener),
  onTerminalStatus: (listener) => subscribe("terminal:status", listener),

  updateBrowser: (payload) => ipcRenderer.send("browser:update", payload),
  onBrowserError: (listener) => subscribe("browser:error", listener),
  onBrowserPageState: (listener) => subscribe("browser:page-state", listener),
  onBrowserStatus: (listener) => subscribe("browser:status", listener),

  detectEditors: () => ipcRenderer.invoke("editors:detect"),
  openInEditor: (payload) => ipcRenderer.invoke("editors:open", payload),
});
