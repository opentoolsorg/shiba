// Bundled setup page: the launcher's only job is choosing which Shiba server
// this window talks to. It holds no credential, opens no listener, and hands
// the choice to main through the setup-only bridge.
// Fixed copy per failure code. The shell sends an `error` sentence too, but an
// older main returns only `code`, so this table is the fallback and never
// interpolates anything the user typed.
const FAILURE_COPY = {
  url_invalid: "That is not a Shiba address. Use https:// (http://localhost only in dev).",
  url_wrong_frame: "Only the setup page can change the address.",
  pairing_busy: "A connection change is already running.",
};
const FALLBACK_COPY = "Could not save that address. Check the URL and try again.";
const params = new URLSearchParams(location.search);
const error = document.getElementById("error");
const form = document.getElementById("form");
const hosted = document.getElementById("hosted");
const selfHosted = document.getElementById("self-hosted");
const fields = document.getElementById("self-hosted-fields");
const input = document.getElementById("url");
const button = form.querySelector("button");
const hostedUrl = document.getElementById("hosted-url");

// Origin main considers "the hosted product"; the page never invents one.
const hostedOrigin = params.get("hosted") || "";
if (hostedOrigin) {
  hostedUrl.textContent = hostedOrigin.replace(/^https?:\/\//, "");
} else {
  hosted.removeAttribute("checked");
  hosted.setAttribute("disabled", "disabled");
}

// Declared before the saved-URL handling below reads it.
const setError = (message) => {
  error.textContent = message;
  input.setAttribute("aria-invalid", message && selfHosted.checked ? "true" : "false");
};

const savedUrl = params.get("url") || "";
if (savedUrl && savedUrl !== hostedOrigin) {
  selfHosted.checked = true;
  input.value = savedUrl;
}
if (savedUrl === hostedOrigin && hostedOrigin) hosted.checked = true;
if (params.get("error")) setError(params.get("error"));

const syncFields = () => {
  const self = selfHosted.checked;
  fields.hidden = !self;
  input.required = self;
  if (self) input.focus();
};

selfHosted.addEventListener("change", syncFields);
hosted.addEventListener("change", syncFields);
syncFields();

// The launcher owns the https/loopback rule; the page only rejects input that
// is not an address at all, and shows main's exact error for the rest.
function parseable(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password;
  } catch {
    return false;
  }
}

input.addEventListener("input", () => {
  if (error.textContent) setError("");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  setError("");
  const target = selfHosted.checked ? input.value.trim() : hostedOrigin;
  if (!target) {
    setError("Enter the address of your Shiba server.");
    return;
  }
  if (selfHosted.checked && !parseable(target)) {
    setError("Enter the address of your Shiba server, for example https://shiba.example.com.");
    input.focus();
    return;
  }
  input.disabled = true;
  button.disabled = true;
  try {
    const result = await window.shibaSetup.setUrl(target);
    if (result && !result.ok) {
      setError(result.error || FAILURE_COPY[result.code] || FALLBACK_COPY);
    }
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause));
  } finally {
    input.disabled = false;
    button.disabled = false;
  }
});
