#!/usr/bin/env node
/** Generate the route reference without evaluating Worker modules. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "apps/backend/src/routes/table.ts");
const outputPath = resolve(root, "docs/ROUTES.md");
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  console.error("Usage: node scripts/generate-routes.mjs [--check]");
  process.exit(1);
}

function readRoutes() {
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let declarations;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "ROUTES") {
      if (!node.initializer || !ts.isArrayLiteralExpression(node.initializer)) {
        throw new Error("ROUTES must be a literal array of route declarations.");
      }
      declarations = node.initializer.elements;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!declarations?.length) throw new Error("No route declarations found.");

  return declarations.map((declaration) => {
    if (!ts.isCallExpression(declaration) || declaration.expression.getText(source) !== "route") {
      throw new Error("Each ROUTES entry must be a route(...) declaration.");
    }
    const args = declaration.arguments;
    if (args.length < 6 || args.length > 7) throw new Error("Unexpected route argument count.");
    function stringArgument(index) {
      const argument = args[index];
      if (!argument || !ts.isStringLiteral(argument)) {
        throw new Error(`Route argument ${index + 1} must be a string literal.`);
      }
      return argument.text;
    }
    return {
      id: stringArgument(0),
      phase: stringArgument(1),
      method: stringArgument(2),
      pattern: stringArgument(3),
      auth: stringArgument(4),
      note: args.length === 7 ? stringArgument(6) : "",
    };
  });
}

function cell(value) {
  return value.replaceAll("|", "\\|").replaceAll("`", "&#96;").replaceAll(/\r?\n/g, " ");
}

function render(routes) {
  const rows = routes.map(({ id, phase, method, pattern, auth, note }) =>
    `| ${cell(id)} | ${cell(phase)} | \`${cell(method)}\` | \`${cell(pattern)}\` | ${cell(auth)} | ${cell(note)} |`,
  );
  return `# Routes

Generated from \`apps/backend/src/routes/table.ts\`. Run \`node scripts/generate-routes.mjs\` to update; CI runs the same script with \`--check\`.

Entries appear in dispatch order. Patterns are regular expressions; \`*\` accepts every method. Thin adapters retain exact matching, method checks, and return-null behavior.

Auth metadata records existing per-surface verification together with ingress gates. A session may use the built-in login or verified Access identity; bearer notes identify surfaces that also accept a scoped API key. Public means an explicitly reviewed anonymous surface, including protocol endpoints and token capability reads. It does not grant private API access. Handlers retain their own verification.

Phase boundaries preserve precedence: \`capability\` runs before identity verification, \`ingress\` before the shared authentication gate, \`authenticated\` after authentication and team-member policy, and \`model\` after live-model validation.

| ID | Phase | Method | Pattern | Auth | Note |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
}

try {
  const routes = readRoutes();
  const generated = render(routes);
  if (check) {
    let current;
    try {
      current = readFileSync(outputPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current !== generated) {
      console.error("docs/ROUTES.md is missing or stale. Run node scripts/generate-routes.mjs.");
      process.exitCode = 1;
    } else {
      console.log(`docs/ROUTES.md is current (${routes.length} entries).`);
    }
  } else {
    writeFileSync(outputPath, generated);
    console.log(`Generated docs/ROUTES.md (${routes.length} entries).`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
