// Keep native smoke tests out of the user's profile and OS protocol settings.
const path = require("node:path");
const { app } = require("electron");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: direct native tests bypass Turbo caching.
app.setPath("userData", process.env.SHIBA_DESKTOP_TEST_USER_DATA);
globalThis.__protocolRegistrations = 0;
app.setAsDefaultProtocolClient = () => {
  globalThis.__protocolRegistrations += 1;
  return false;
};
require(path.resolve(__dirname, "../dist/main.js"));
