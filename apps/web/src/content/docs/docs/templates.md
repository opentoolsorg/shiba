---
title: Agent templates
description: Browse, add, copy, and import Shiba agent template packs.
sidebar:
  order: 11
---

Shiba template packs are authored as folders under [`templates/`](https://github.com/princepal9120/shiba/tree/main/templates). Each pack contains `template.json`, original Shiba instructions, optional skill stubs, and a getting-started guide.

## Add a template

Create a folder with a lowercase kebab-case ID. Add `template.json` matching [`template.schema.json`](https://github.com/princepal9120/shiba/blob/main/templates/template.schema.json), `INSTRUCTIONS.md`, `getting-started.md`, and zero to three focused `skills/*/SKILL.md` files. Keep descriptions at 220 characters or fewer. Use original wording; do not copy proprietary instructions from other catalogs. Templates should be Slack-first: Slack is the only supported chat lane in these packs for now.

The TypeScript registry and validator live in `packages/shared/src/agent-templates.ts`; its tests check that every registry entry has a matching complete pack folder. Add a registry entry and test the pack when adding a template.

## Use, copy, and import

Open **Bots → Template catalog**. Browse official packs by category or choose **My** to see saved workspace bots as reusable packs. **Use** creates the bot through Shiba's existing custom-agent API. **Copy pack** copies JSON metadata plus an `INSTRUCTIONS.md` Markdown section. To import one, expand **Paste import**, paste the combined pack, and create the bot. Review its instructions before starting a task.

## Grok Bot Marketplace export

The pack format keeps instructions and skills portable for a future Grok Bot export. For a later listing, prepare a scrubbed bot share payload with xAI's `CreateBotShareJson` / export-bot-template flow, review included instructions, skills, routines, and plugins, then submit it as a Public template at <https://x.ai/bot/marketplace>. Publishing is a separate action and is not performed by Shiba in this release. Bot templates are distinct from xAI's plugin submission flow.
