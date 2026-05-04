import { Menu } from "electron";

export function configureApplicationMenu(app, appName) {
  if (process.platform !== "darwin") {
    return;
  }

  app.setAboutPanelOptions({
    applicationName: appName,
    applicationVersion: app.getVersion(),
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: appName,
        submenu: [
          { label: `About ${appName}`, role: "about" },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { label: `Hide ${appName}`, role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { label: `Quit ${appName}`, role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          { type: "separator" },
          { role: "front" },
        ],
      },
      {
        label: "Help",
        role: "help",
        submenu: [],
      },
    ]),
  );
}
