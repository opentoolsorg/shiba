import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pins from "./harness-canary-pins.json" with { type: "json" };
import { imageInputHash, isPinnedImage, readBoundedJson } from "./harness-canary-probe.mjs";

const requiredModels = [...new Set(Object.values(pins.lanes).map(([, model]) => model))].sort();
const probeReasons = {
  image: {
    passed: ["pinned-clis-present"],
    failed: ["image-probe-timeout", "cli-pin-or-startup-mismatch"],
    inconclusive: ["unverified-image-pin", "image-not-preloaded", "image-probe-not-started"],
  },
  model: {
    passed: ["exact-model-visible"],
    failed: [
      "model-not-visible", "metadata-auth-denied", "metadata-rate-limited", "metadata-http-failure", "invalid-model-metadata",
      "model-capability-unavailable", "metadata-timeout", "metadata-transport-failure",
    ],
    inconclusive: ["metadata-credential-not-configured"],
  },
};
const marker = (run) => `<!-- shiba-harness-canary:v1:${run} -->`;
const stateMarker = "<!-- shiba-harness-canary-ledger:v1 -->";
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const inconclusive = (reason) => ({ status: "inconclusive", reason });

function cleanResult(value, probe) {
  const reasons = Object.hasOwn(probeReasons[probe], value?.status) ? probeReasons[probe][value.status] : null;
  if (!reasons?.includes(value.reason)) {
    return inconclusive("probe-evidence-missing-or-invalid");
  }
  return { status: value.status, reason: value.reason };
}

export function evaluate({ revision, run, image: imageReport, models: modelReport, conformance }) {
  if (!/^[a-f0-9]{40}$/.test(revision) || !positive(run)) throw new Error("Invalid canary run identity.");
  const current = (report) => report?.revision === revision && report?.run === run ? report.evidence : null;
  const image = current(imageReport);
  const models = current(modelReport);
  const modelShape = models && Object.keys(models).length === requiredModels.length &&
    requiredModels.every((model) => Object.hasOwn(models, model));
  const modelResults = Object.fromEntries(requiredModels.map((model) => [model, cleanResult(modelShape ? models[model] : null, "model")]));
  const imageResult = cleanResult(image, "image");
  const inputsSha256 = image?.inputsSha256 === imageInputHash() ? image.inputsSha256 : null;
  const imageRef = isPinnedImage(image?.image) ? image.image : null;
  const evidence = {
    conformance: conformance === "passed" || conformance === "failed" ? conformance : "inconclusive",
    image: { ...(imageResult.status !== "inconclusive" && (!imageRef || !inputsSha256) ?
      inconclusive("unverified-image-pin") : imageResult), reference: imageRef, inputsSha256 },
    models: modelResults,
  };
  const statuses = [evidence.conformance, evidence.image.status, ...Object.values(modelResults).map((model) => model.status)];
  const verdict = statuses.includes("failed") ? "failed" : statuses.includes("inconclusive") ? "inconclusive" : "passed";
  return { version: 1, revision, run, verdict, modelRoute: "direct-provider-metadata", ...evidence, excluded: pins.excluded };
}

function validLedger(state) {
  if (state?.version !== 1 || !Number.isSafeInteger(state.lastRun) || state.lastRun < 0 ||
    ![0, 1, 2].includes(state.streak) ||
    (state.lastRun === 0 ? state.verdict !== null : !["passed", "failed", "inconclusive"].includes(state.verdict)) ||
    (state.streak > 0 ? !positive(state.firstFailure) || state.firstFailure > state.lastRun : state.firstFailure !== null)) return false;
  const incident = state.incident;
  if (incident === null) return state.streak < 2;
  return incident && positive(incident.generation) && incident.generation <= state.lastRun &&
    (incident.phase === "closing" ? state.streak === 0 :
      state.streak === 2 && state.firstFailure === incident.generation) &&
    (incident.phase === "opening" ? incident.number === null :
      ["open", "closing"].includes(incident.phase) && positive(incident.number));
}

export async function recordVerdict(api, { run, verdict }) {
  if (!positive(run) || !["passed", "failed", "inconclusive"].includes(verdict)) throw new Error("Invalid canary verdict.");
  const state = structuredClone(await api.readLedger());
  if (!validLedger(state)) throw new Error("Canary ledger is missing or invalid; stop and inspect it.");
  const save = () => api.saveLedger(state);
  const owned = (issue, generation) =>
    issue && positive(issue.number) && issue.user?.type === "Bot" && issue.user?.login === api.botLogin &&
    !issue.pull_request && ["open", "closed"].includes(issue.state) && issue.body?.split("\n")[0] === marker(generation);
  const reset = () => Object.assign(state, { streak: 0, firstFailure: null, incident: null });
  const checkIncident = async () => {
    const { number, generation } = state.incident;
    const issue = await api.getIssue(number);
    if (issue?.number !== number || !owned(issue, generation)) throw new Error("Canary incident identity no longer matches.");
    if (issue.state === "closed" || await api.wasClosed(number)) {
      reset();
      await save();
      return false;
    }
    return true;
  };
  const finishClose = async () => {
    if (await checkIncident()) {
      const { number, generation } = state.incident;
      const closed = await api.closeIssue(number);
      if (closed?.number !== number || !owned(closed, generation) || closed.state !== "closed") {
        throw new Error("Canary close was not confirmed.");
      }
      reset();
      await save();
    }
  };

  if (state.incident?.phase === "opening") {
    const matches = (await api.listIssues()).filter((issue) => owned(issue, state.incident.generation));
    if (matches.length !== 1) throw new Error("Canary create is unresolved; inspect the ledger before retrying.");
    state.incident = { ...state.incident, number: matches[0].number, phase: "open" };
    await save();
  }
  if (state.incident?.phase === "closing") await finishClose();
  else if (state.incident?.phase === "open") await checkIncident();

  if (run <= state.lastRun) return state;
  if (state.incident === null && run !== state.lastRun + 1) reset();
  state.lastRun = run;
  state.verdict = verdict;
  if (verdict === "passed" && state.incident) {
    state.streak = 0;
    state.firstFailure = null;
    state.incident.phase = "closing";
    await save();
    await finishClose();
  } else if (state.incident) {
    await save();
  } else if (verdict !== "failed") {
    reset();
    await save();
  } else if (state.streak === 0) {
    state.streak = 1;
    state.firstFailure = run;
    await save();
  } else {
    const generation = state.firstFailure;
    const matches = (await api.listIssues()).filter((issue) => owned(issue, generation));
    if (matches.length) throw new Error("Canary issue already exists outside its ledger; inspect before retrying.");
    state.streak = 2;
    state.incident = { generation, number: null, phase: "opening" };
    await save();
    const issue = await api.createIssue({
      title: "Shiba harness canary failed twice",
      body: [marker(generation), "", `Canary runs ${generation} and ${run} failed. Review their redacted workflow reports for the failing checks.`,
        "A later verified pass closes this issue. If you close it yourself, the next distinct failure starts a new streak."].join("\n"),
    });
    if (!owned(issue, generation) || issue.state !== "open") throw new Error("Canary creation was not confirmed.");
    state.incident = { generation, number: issue.number, phase: "open" };
    await save();
  }
  return state;
}

export function githubIssues(env, fetchImpl = fetch) {
  const { GITHUB_REPOSITORY: repo, SHIBA_CANARY_ISSUES_TOKEN: token } = env;
  const ledger = Number(env.SHIBA_CANARY_LEDGER_ISSUE);
  if (env.GITHUB_ACTIONS !== "true" || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo ?? "") ||
    repo.toLowerCase() === "opentoolsorg/shiba" || env.SHIBA_CANARY_SOURCE_REPO !== repo || !token || !positive(ledger)) {
    throw new Error("Configure the isolated Actions repository and ledger before reconciliation.");
  }
  const root = `https://api.github.com/repos/${repo}/issues`;
  const deadline = AbortSignal.timeout(40_000);
  async function call(path, method = "GET", body) {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(5_000)]);
    try {
      const response = await fetchImpl(root + path, {
        method, signal, redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status !== (method === "POST" ? 201 : 200)) {
        void response.body?.cancel().catch(() => {});
        throw new Error("Unexpected GitHub HTTP status.");
      }
      return { data: await readBoundedJson(response, 1024 * 1024), more: /rel="next"/.test(response.headers.get("link") ?? "") };
    } catch {
      throw new Error(`Canary GitHub ${method} failed or was not confirmed.`);
    }
  }
  async function pages(path) {
    const rows = [];
    for (let page = 1; page <= 5; page++) {
      const { data, more } = await call(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(data)) throw new Error("Canary GitHub listing was invalid.");
      rows.push(...data);
      if (!more) return rows;
    }
    throw new Error("Canary GitHub listing exceeded its page limit.");
  }
  const encode = (state) => `${stateMarker}\n\n${JSON.stringify(state, null, 2)}`;
  function decode(issue) {
    if (issue?.number !== ledger || issue.state !== "open" || issue.pull_request ||
      !issue.body?.startsWith(`${stateMarker}\n\n`)) throw new Error("Canary state issue is not initialized or is closed.");
    try {
      return JSON.parse(issue.body.slice(stateMarker.length + 2));
    } catch {
      throw new Error("Canary state issue is not valid JSON.");
    }
  }
  return {
    botLogin: "github-actions[bot]",
    readLedger: async () => decode((await call(`/${ledger}`)).data),
    saveLedger: async (state) => {
      if (encode(decode((await call(`/${ledger}`, "PATCH", { body: encode(state) })).data)) !== encode(state)) {
        throw new Error("Canary state write was not confirmed.");
      }
    },
    listIssues: () => pages("?state=all&sort=created&direction=desc"),
    getIssue: async (number) => (await call(`/${number}`)).data,
    wasClosed: async (number) => (await pages(`/${number}/events`)).some(({ event }) => event === "closed"),
    createIssue: async (payload) => (await call("", "POST", payload)).data,
    closeIssue: async (number) => (await call(`/${number}`, "PATCH", { state: "closed", state_reason: "completed" })).data,
  };
}

function parseEvidence(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function main() {
  const [mode, path] = process.argv.slice(2);
  const env = process.env;
  if (!path) throw new Error("Missing canary report path.");
  if (mode === "evaluate") {
    const report = evaluate({
      revision: env.GITHUB_SHA, run: Number(env.GITHUB_RUN_NUMBER),
      conformance: env.CONFORMANCE_RESULT,
      image: parseEvidence(env.IMAGE_REPORT), models: parseEvidence(env.MODEL_REPORT),
    });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  } else if (mode === "record") {
    const report = JSON.parse(readFileSync(path, "utf8"));
    if (report.version !== 1 || report.revision !== env.GITHUB_SHA || report.run !== Number(env.GITHUB_RUN_NUMBER)) {
      throw new Error("Canary report does not belong to this run.");
    }
    const state = await recordVerdict(githubIssues(env), report);
    const accepted = state.lastRun === report.run ? state.verdict : "stale-run";
    console.log(`Harness canary: ${report.verdict}; accepted verdict: ${accepted}. See the redacted report artifact.`);
    if (report.verdict !== "passed" || accepted !== "passed") process.exitCode = 1;
  } else {
    throw new Error("Unknown canary report mode.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
