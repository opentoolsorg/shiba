---
title: Employee templates
description: Start an AI employee from a reusable role, then adapt it to your work.
sidebar:
  order: 11
---

Templates are starting points for AI employees. Each pack supplies a role, instructions, and suggested outputs so you do not have to write the profile from scratch.

Choose a pack that matches a real job, such as a product specification, support triage, competitor summary, or pull request review. Read the instructions and adapt the scope before using it.

## Choose and use a template

1. Open **Agents → Template catalog**.
2. Browse the official packs by category. Choose **My** to see saved workspace profiles as reusable packs.
3. Read the role and instructions, then choose **Use** to create the employee.
4. Check its model connection, required deliverables, and permissions before launching a task.

Creating an employee from a pack does not connect an account, install app tools, or approve execution. Packs are currently Slack-first for their chat-channel instructions; other channels have their own setup and supported flows.

## Copy or import a pack

**Copy pack** copies the profile metadata and instructions. To reuse a pack, open **Paste import**, paste it, and review the contents before creating the employee.

Treat imported instructions as something to inspect, especially their requested tools, data, and external actions. Import only into the personal or team workspace where you intend the profile to live.

## Employee templates and skill templates

An employee template defines a role. A [skill template](/docs/skills/) supplies a reusable method or checklist. Installing a run-attached skill template creates a draft that needs separate review and activation.

## Contribute a template

Developer packs live under [`templates/`](https://github.com/opentoolsorg/shiba/tree/main/templates). Add a lowercase kebab-case folder with `template.json` matching the [schema](https://github.com/opentoolsorg/shiba/blob/main/templates/template.schema.json), `INSTRUCTIONS.md`, `getting-started.md`, and up to three focused `skills/*/SKILL.md` files.

Keep descriptions at 220 characters or fewer and use original instructions. Add the pack to `packages/shared/src/agent-templates.ts` and run its validation tests. See [Contributing](/docs/contributing/) for the development workflow.
