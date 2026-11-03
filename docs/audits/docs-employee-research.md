# AI employee documentation research

Research date: 2026-11-03.

Overlay's [documentation navigation](https://github.com/LayerNorm/overlay-web/blob/49146167572130e171db8d566edc0bf2f176aa73/docs/docs.json) separates help, self-hosting, and developer material. Its [agent guide](https://github.com/LayerNorm/overlay-web/blob/49146167572130e171db8d566edc0bf2f176aa73/docs/help/agents.mdx) explains an agent through its instructions, tools, scope, and interactions. Its [extensions guide](https://github.com/LayerNorm/overlay-web/blob/49146167572130e171db8d566edc0bf2f176aa73/docs/help/extensions.mdx) groups skills, connectors, and MCP servers by the user's goal. These are information-architecture references, not evidence that Shiba implements Overlay's permissions, tools, or billing.

Shiba's own evidence is `packages/shared/src/agent-templates.ts`, `apps/frontend/src/components/CustomAgentsView.tsx`, `apps/frontend/src/components/ExtensionSkillsView.tsx`, `apps/backend/src/agents/orchestrator.ts`, and `apps/backend/src/egress.ts`. The current docs describe employees across functions, retain the repository-backed approval boundary, and distinguish configured capabilities from verified live operation. The broader comparison and evidence limits are recorded in [the existing Overlay reference audit](overlay-reference.md).
