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
  const inspectorClose = page.getByRole("button", { name: "Close task", exact: true });
  if (await inspectorClose.isVisible()) await inspectorClose.click();
  const rail = page.getByRole("navigation", { name: "Workspace areas", exact: true }).filter({ visible: true }).first();
  if (["Agents", "Chats", "Work"].includes(view)) {
    const area = { Agents: "Team", Chats: "Chat", Work: "Work" }[view];
    await rail.getByRole("button", { name: area, exact: true }).click();
    return;
  }
  if (!["Integrations", "Approvals", "Pull requests"].includes(view)) {
    throw new Error(`Unsupported fixture destination: ${view}`);
  }
  const area = view === "Integrations" ? "Settings" : "Work";
  await rail.getByRole("button", { name: area, exact: true }).click();
  await page.getByRole("navigation", { name: `${area} destinations`, exact: true }).filter({ visible: true }).first()
    .getByRole("button", { name: view, exact: true }).click();
}
