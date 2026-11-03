/** Select the existing repository mode before exercising coding controls. */
export async function selectRepositoryTask(page) {
  const work = page.getByRole("tablist", { name: "Conversation mode", exact: true })
    .getByRole("tab", { name: "Work", exact: true });
  await work.waitFor({ state: "visible" });
  if (await work.getAttribute("aria-selected") !== "true") await work.click();
  const skip = page.getByRole("button", { name: "Skip for now", exact: true });
  if (await skip.isVisible()) await skip.click();
  const composer = page.getByTestId("task-composer");
  await composer.waitFor({ state: "visible" });
  const target = composer.getByRole("combobox", { name: "Work target", exact: true });
  await target.selectOption("repository");
  const repository = page.getByRole("form", { name: "Task composer", exact: true });
  await repository.waitFor({ state: "visible" });
  await repository.getByRole("textbox", { name: "Task description", exact: true }).waitFor({ state: "visible" });
  return repository;
}
