"use strict";

const { app, Menu, shell } = require("electron");

/** Build the application menu for the Path desktop shell. */
function buildMenu({ repo, onOpenRepo }) {
  const isMac = process.platform === "darwin";

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Data Folder",
          enabled: !!repo,
          click: () => onOpenRepo(repo),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
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
      label: "Help",
      submenu: [
        {
          label: "Career-Ops Website",
          click: () => shell.openExternal("https://github.com/santifer/career-ops"),
        },
        {
          label: "Learn More (docs)",
          click: () => shell.openExternal("https://github.com/santifer/career-ops/tree/main/docs"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };