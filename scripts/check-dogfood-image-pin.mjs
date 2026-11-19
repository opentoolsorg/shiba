#!/usr/bin/env node
/**
 * A commit that changes the sandbox image inputs must also move the digest that
 * apps/backend/wrangler.dogfood.jsonc pins. Workers Builds only references the
 * pinned digest, so a Dockerfile change without a re-pin would deploy the
 * previous image; the guard keeps the two in step, and
 * .github/workflows/build-sandbox-image.yml builds the new image before the
 * pull request that carries the pin can merge.
 */
import { execFileSync } from "node:child_process";

const IMAGE_INPUTS = ["apps/backend/Dockerfile", "apps/backend/scripts/acp-install.sh"];
const DOGFOOD_CONFIG = "apps/backend/wrangler.dogfood.jsonc";
const PIN_PATTERN = /"image"\s*:\s*"([^"]+)"/;

/** Whether the pin moved in step with the image inputs. */
export function pinProblem({ changedInputs, head, previous }) {
  if (!changedInputs.length) return null;
  if (head && head !== previous) return null;
  return [
    "The sandbox image inputs changed, but the dogfood deploy still references the old image:",
    `  changed: ${changedInputs.join(", ")}`,
    `  pinned:  ${head ?? "(none)"}`,
    "",
    "Run the Build sandbox image workflow (it builds on this pull request), then pin the digest it prints:",
    "  node scripts/pin-dogfood-image.mjs <digest from the workflow summary>",
    "",
    "Workers Builds only references the pinned digest, so the deploy would otherwise keep running the previous image.",
  ].join("\n");
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function pinnedImage(source) {
  return source.match(PIN_PATTERN)?.[1] ?? null;
}

function main(argv) {
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex >= 0 ? argv[baseIndex + 1] : "HEAD~1";
  if (!base) {
    console.error("check-dogfood-image-pin: --base needs a git revision");
    process.exit(2);
  }
  let changedInputs;
  let previousConfig;
  try {
    changedInputs = git(["diff", "--name-only", `${base}...HEAD`, "--", ...IMAGE_INPUTS])
      .split("\n")
      .filter(Boolean);
    previousConfig = git(["show", `${base}:${DOGFOOD_CONFIG}`]);
  } catch (error) {
    console.error(`check-dogfood-image-pin: cannot diff against ${base}: ${error.message}`);
    process.exit(2);
  }
  const head = pinnedImage(git(["show", `HEAD:${DOGFOOD_CONFIG}`]));
  const problem = pinProblem({ changedInputs, head, previous: pinnedImage(previousConfig) });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(
    changedInputs.length
      ? `image inputs changed and ${DOGFOOD_CONFIG} re-pins the image: ${head}`
      : `sandbox image inputs unchanged since ${base.slice(0, 12)}; pin may stay`,
  );
}

if (process.argv[1]?.endsWith("check-dogfood-image-pin.mjs")) main(process.argv);
