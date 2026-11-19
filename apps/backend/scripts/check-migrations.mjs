import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ts = createRequire(join(root, "package.json"))("typescript");
const legacyDuplicate = new Set([
  "0036_slack_coworker_private_status.sql",
  "0036_team_work_tasks.sql",
  // Both shipped on main under 0061; renaming would break applied history.
  "0061_learning_review.sql",
  "0061_note_chat.sql",
  // Both pairs shipped on main under 0062 and 0063; renaming would break applied history.
  "0062_inbound_webhook_receipts.sql",
  "0062_media_generations.sql",
  "0063_runtime_d1_schema.sql",
  "0063_workspace_channel_facts.sql",
]);
// main skipped 0067 when it added 0068/0069; never fill it retroactively.
const skippedNumbers = new Set([67]);

const historicalNames = new Set([
  "0001_audit_log.sql",
  "0002_capability_invocations.sql",
  "0003_skills.sql",
  "0004_onboarding_accepted_artifact.sql",
  "0005_skill_installs.sql",
  "0006_spaces.sql",
  "0007_skill_installs_owner.sql",
  "0008_extensions.sql",
  "0009_org_extension_skills.sql",
  "0010_workspace_integrations.sql",
  "0011_personal_execution.sql",
  "0012_founder_review_schedules.sql",
  "0013_team_model_sessions.sql",
  "0014_founder_connector_jobs.sql",
  "0015_founder_evidence_reports.sql",
  "0016_report_slack_deliveries.sql",
  "0017_team_model_money.sql",
  "0018_slack_installations.sql",
  "0019_shared_computers.sql",
  "0021_founder_automatic_reads.sql",
  "0022_run_output_archives.sql",
  "0023_founder_automatic_slack.sql",
  "0024_slack_coworker.sql",
  "0025_team_model_budget_v3.sql",
  "0027_founder_stripe_reads.sql",
  "0028_founder_read_attestations.sql",
  "0029_founder_meta_reads.sql",
  "0030_founder_reconciliation.sql",
  "0031_founder_slack_sources.sql",
  "0032_founder_hubspot_reads.sql",
  "0033_founder_reconciliation_schedules.sql",
  "0034_founder_reconciliation_slack.sql",
  "0035_slack_coworker_execution_v2.sql",
  "0036_slack_coworker_private_status.sql",
  "0036_team_work_tasks.sql",
  "0037_operator_enrollment_review.sql",
  "0038_better_auth.sql",
  "0039_ws01_schema_marker.sql",
  "0040_email_outbox.sql",
  "0041_sso_connections.sql",
  "0042_workspace_connectors_v2.sql",
  "0043_workspace_connectors_app_link.sql",
  "0044_external_mcp_v2.sql",
  "0045_mcp_grants.sql",
  "0046_collab_v2.sql",
  "0047_collab_engagement.sql",
  "0048_governance.sql",
  "0049_audit_exports.sql",
  "0050_files_notes.sql",
  "0051_knowledge_indexes.sql",
  "0052_search_fts.sql",
  "0053_ask_user_and_claims.sql",
  "0054_webhooks.sql",
  "0055_automation_workflow_runs.sql",
  "0056_tool_usage.sql",
  "0057_tool_usage_budget_index.sql",
  "0058_slack_import.sql",
  "0059_coordination.sql",
  "0060_palette_search.sql"
]);

export function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

export function checkMigrations(repository = root) {
  const errors = [];
  const directory = join(repository, "apps/backend/migrations");
  const names = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
  const prefixes = new Map();
  for (const name of names) {
    const match = /^(\d{4})_.+\.sql$/.exec(name);
    if (!match) { errors.push(`Invalid migration filename: ${name}`); continue; }
    const prefix = Number(match[1]);
    if (prefix <= 60 && !historicalNames.has(name)) errors.push(`Migration number goes backwards: ${name}; append after 0060`);
    const group = prefixes.get(prefix) ?? [];
    group.push(name);
    prefixes.set(prefix, group);
  }
  for (const [prefix, group] of prefixes) {
    if (group.length > 1 && !group.every(name => legacyDuplicate.has(name))) {
      errors.push(`Duplicate migration prefix: ${group.join(", ")}`);
    }
  }
  let previous = 60;
  for (const number of [...prefixes.keys()].filter(number => number > 60)) {
    while (skippedNumbers.has(previous + 1)) previous++;
    if (number !== previous + 1) errors.push(`Migration sequence after 0060: expected ${previous + 1}, found ${number}`);
    previous = number;
  }
  const modules = new Map();
  function moduleAt(path) {
    if (modules.has(path)) return modules.get(path);
    const source = readFileSync(path, "utf8");
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const declarations = new Map();
    const imports = new Map();
    const exports = new Map();
    for (const statement of ast.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          declarations.set(declaration.name.text, declaration.initializer);
          if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
            exports.set(declaration.name.text, declaration.name.text);
          }
        }
      }
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = relativeModule(path, statement.moduleSpecifier.text);
        const clause = statement.importClause;
        if (!target || !clause || clause.isTypeOnly) continue;
        if (clause.name) imports.set(clause.name.text, { path: target, name: "default" });
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            if (!element.isTypeOnly) imports.set(element.name.text, { path: target, name: (element.propertyName ?? element.name).text });
          }
        } else if (clause.namedBindings) imports.set(clause.namedBindings.name.text, { path: target, name: "*" });
      }
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        declarations.set("default", statement.expression);
        exports.set("default", "default");
      }
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? relativeModule(path, statement.moduleSpecifier.text) : null;
        for (const element of statement.exportClause.elements) {
          const name = (element.propertyName ?? element.name).text;
          exports.set(element.name.text, target ? { path: target, name } : name);
        }
      }
    }
    const result = { path, source, ast, declarations, imports, exports };
    modules.set(path, result);
    return result;
  }
  function relativeModule(from, specifier) {
    if (!specifier.startsWith(".")) return null;
    const base = resolve(dirname(from), specifier).replace(/\.[cm]?js$/, "");
    const candidates = [base, `${base}.ts`, `${base}.mts`, `${base}.js`, join(base, "index.ts")];
    return candidates.find(candidate => files.has(candidate)) ?? null;
  }
  const files = new Set(["apps/backend/src", "packages/auth/src"].flatMap(base => sourceFiles(join(repository, base))));
  const reported = new Set();
  function report(module, node) {
    const location = `${relative(repository, module.path)}:${module.ast.getLineAndCharacterOfPosition(node.getStart(module.ast)).line + 1}`;
    if (!reported.has(location)) { reported.add(location); errors.push(`Runtime D1 DDL: ${location}`); }
  }
  function ddlText(node) {
    return ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text : "";
  }
  function isLocalSql(module, node) {
    const call = node.parent;
    const receiver = ts.isCallExpression(call) ? call.expression.getText(module.ast) : "";
    return /^(?:ctx\.storage\.sql|this\.sql|this\.ctx\.storage\.sql|storage\.sql)\.exec$/.test(receiver)
      || (receiver === "sql.exec" && /\bSqlStorage\b/.test(module.source));
  }
  const ddl = /\bCREATE\s+(?:(?:UNIQUE|VIRTUAL)\s+)?(?:TABLE|INDEX)\b/i;
  function inspectConstant(module, name, seen = new Set()) {
    const key = `${module.path}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const exported = module.exports.get(name);
    if (exported && typeof exported !== "string") {
      inspectConstant(moduleAt(exported.path), exported.name, seen);
      return;
    }
    const localName = typeof exported === "string" ? exported : name;
    const initializer = module.declarations.get(localName);
    if (!initializer) {
      const imported = module.imports.get(localName);
      if (imported && imported.name !== "*") inspectConstant(moduleAt(imported.path), imported.name, seen);
      return;
    }
    function visit(node) {
      if (ddl.test(ddlText(node))) report(module, node);
      if (ts.isIdentifier(node)) inspectConstant(module, node.text, seen);
      ts.forEachChild(node, visit);
    }
    visit(initializer);
  }
  // Follow imported constant bindings, not whole import trees: D1 routers also
  // import Durable Objects and utilities whose private schemas belong to local SQLite.
  for (const path of files) {
    const module = moduleAt(path);
    if (!/\b(?:AGENT_AUDIT|D1Database)\b/.test(module.source)) continue;
    function visit(node) {
      if (ddl.test(ddlText(node)) && !isLocalSql(module, node)) report(module, node);
      if (ts.isIdentifier(node) && module.imports.has(node.text)) {
        const imported = module.imports.get(node.text);
        if (imported.name !== "*") inspectConstant(moduleAt(imported.path), imported.name);
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const imported = module.imports.get(node.expression.text);
        if (imported?.name === "*") inspectConstant(moduleAt(imported.path), node.name.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(module.ast);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkMigrations(process.argv[2] ? resolve(process.argv[2]) : root);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Migration checks passed.");
}
