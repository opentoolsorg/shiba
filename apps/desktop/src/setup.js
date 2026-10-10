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
    if (result && !result.ok) error.textContent = result.error;
  } catch (e) {
    error.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    input.disabled = false;
    button.disabled = false;
  }
});
