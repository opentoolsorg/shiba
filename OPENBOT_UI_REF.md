# OpenBot UI reference (1:1 Tasks layout)

Cloned: ~/oss/openbot (nightly-labs/openbot)

## 1. Left Icon Rail (OpenBot PageRail / ServerRail)
- 56px primary navigation rail on the far left.
- Top mark: Shiba brand mark.
- Main nav icons:
  - Chat / Threads (MessagesSquare) -> live conversation pane
  - Connections / Integrations (Blocks) -> provider/connector configurations
  - Tasks (ListChecks) -> task queues & prompt composer
  - Graph / Work (Waypoints) -> workboard, DAG, and activity logs
- Bottom utility stack:
  - Live agent/bot avatar stack with status rings and click-to-chat triggers
  - Spaces & mini-app store (Store)
  - Keyboard shortcuts & help (Keyboard)
  - Deployment settings (Settings) with alert indicators

## 2. Desktop Tasks Surface (TasksHomeView.tsx)
Reference components in OpenBot:
- packages/ui/src/features/tasks/TasksPage.tsx
- packages/ui/src/features/tasks/TasksEmpty.tsx
- packages/ui/src/features/tasks/TaskPanel.tsx
- src/renderer/src/features/tasks/TasksView.tsx
- src/renderer/src/features/tasks/TasksPanel.tsx
- packages/ui/src/features/conversation/TaskList.tsx
- packages/ui/src/features/conversation/AgentTasks.tsx

Layout:
- Sticky subheader with workspace title, agent toggle button, and live status pills
- Hero greeting with bold typography
- Form composer with agent picker pill, repo input, speech/mic input, and submit
- Responsive 3-column queues: "Needs you", "Working", and "Waiting"

## 3. Sidebar (AppNavRail.tsx & WorkspaceSidebar)
- Team workspace dropdown with settings & agent management triggers
- Fast filter search (Cmd+K)
- View switcher tabs: Agents vs. Workflows
- In Agents view: Needs approval, custom agent directory, and thread list
- In Workflows view: Automated routines, schedules, and manual trigger controls
- Bottom machine card: Cloudflare Worker status, active sandboxes, and setup progress

All styling strictly adheres to Shiba OKLCH theme tokens.
