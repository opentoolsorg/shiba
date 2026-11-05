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

/** Follow the desktop rail and contextual panels used by the shared dashboard. */
export async function openAppView(page, view) {
  const rail = page.getByRole("navigation", { name: "App Icon Rail", exact: true });
  if (["Agents", "Chats", "Work"].includes(view)) {
    await rail.getByRole("button", { name: view, exact: true }).click();
    return;
  }
  if (!["Integrations", "Approvals", "Pull requests"].includes(view)) {
    throw new Error(`Unsupported fixture destination: ${view}`);
  }
  await rail.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menu", { name: "Additional views", exact: true })
    .getByRole("menuitem", { name: view === "Integrations" ? "Extensions" : /^Insights(?:\s+\d+)?$/, exact: true }).click();
  if (view !== "Integrations") {
    await page.getByRole("complementary", { name: "Insights", exact: true })
      .getByRole("button", { name: view === "Approvals" ? /^Approvals(?:\s+\d+(?: pending approvals)?)?$/ : view, exact: true }).click();
  }
}
