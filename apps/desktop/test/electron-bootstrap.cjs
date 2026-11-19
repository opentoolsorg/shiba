// Keep native smoke tests out of the user's profile and OS protocol settings,
// and answer notifications locally so the click path runs without a desktop
// notification service. Nothing here ships in the packaged app.
const path = require("node:path");
const electron = require("electron");
const { app } = electron;

// biome-ignore lint/suspicious/noUndeclaredEnvVars: direct native tests bypass Turbo caching.
app.setPath("userData", process.env.SHIBA_DESKTOP_TEST_USER_DATA);
globalThis.__protocolRegistrations = 0;
app.setAsDefaultProtocolClient = () => {
  globalThis.__protocolRegistrations += 1;
  return false;
};

// Electron exposes Notification as a non-configurable getter, so the stub goes
// on the class itself: show() records instead of reaching the OS, and the click
// handler main attached is what fires.
globalThis.__notifications = [];
globalThis.__notificationClicks = 0;
const { Notification } = electron;
Notification.isSupported = () => true;
Notification.prototype.show = function () {
  globalThis.__notifications.push(this);
  setTimeout(() => {
    globalThis.__notificationClicks += 1;
    this.emit("click");
  }, 0);
};

require(path.resolve(__dirname, "../dist/main.js"));
