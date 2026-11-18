// Minimal Electron main for the preload gate corpus: one window, the built
// preload, and the additionalArguments the test asks for. Nothing else ships.
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

app.setPath("userData", process.env.SHIBA_GATE_USER_DATA);

app.whenReady().then(() => {
  const extra = JSON.parse(process.env.SHIBA_GATE_ARGS || "[]");
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, "../dist/preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      additionalArguments: extra,
    },
  });
  win.loadURL(process.env.SHIBA_GATE_URL);
});

app.on("window-all-closed", () => {
  app.quit();
});
