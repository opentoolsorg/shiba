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
const input = document.getElementById("url");
if (params.get("error")) error.textContent = params.get("error");
if (params.get("url")) input.value = params.get("url");

const button = document.querySelector("#form button");

document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  error.textContent = "";
  input.disabled = true;
  button.disabled = true;
  try {
    const result = await window.shibaSetup.setUrl(input.value);
    if (result && !result.ok) {
      error.textContent = result.error || FAILURE_COPY[result.code] || FALLBACK_COPY;
    }
  } catch (e) {
    error.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    input.disabled = false;
    button.disabled = false;
  }
});
