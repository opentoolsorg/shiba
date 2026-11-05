import { useState, type FormEvent, type JSX } from "react";
import { parseMicroUsd, formatMicroUsd, teamModelMaximumDebitMicroUsd, type TeamModelFundingInput } from "@shiba/shared";
import { TEAM_MODEL_COST_DISCLOSURE } from "./TeamModelMoneyDetails";

const FIELD = "mt-1 min-h-11 min-w-0 w-full border border-[var(--input-line)] bg-[var(--paper)] px-3 py-2 text-sm";
const BUTTON = "min-h-11 border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--navy)]";

/** Preparing a review never enables funding or starts a model request. */
export function TeamModelFundingForm({ model, employees, actors, disabled, onChanged, onPrepare }: {
  model: TeamModelFundingInput["model"]; employees: Array<{ id: string; name: string; version: number }>;
  actors: Array<{ userId: string; version: number }>; disabled: boolean;
  onChanged: () => void; onPrepare: (input: Omit<TeamModelFundingInput, "roomId">) => void;
}): JSX.Element {
  const [employeeId, setEmployeeId] = useState(""), [memberId, setMemberId] = useState(""), [chosenModel, setChosenModel] = useState("");
  const [requests, setRequests] = useState(""), [inputBytes, setInputBytes] = useState(""), [outputTokens, setOutputTokens] = useState(""), [minutes, setMinutes] = useState("");
  const [budget, setBudget] = useState("");
  const budgetMicroUsd = parseMicroUsd(budget), maximumDebit = [64, 256, 512, 1024].includes(Number(outputTokens)) ? teamModelMaximumDebitMicroUsd(Number(outputTokens)) : null;
  const employee = employees.find((item) => item.id === employeeId), member = actors.find((item) => item.userId === memberId);
  const valid = Boolean(employee && member && chosenModel === model && model && Number.isSafeInteger(Number(requests)) && Number(requests) >= 1 && Number(requests) <= 10 && [1024, 4096, 8192, 16384].includes(Number(inputBytes)) && maximumDebit && budgetMicroUsd !== null && budgetMicroUsd >= maximumDebit && [15, 60, 240, 1440].includes(Number(minutes)));
  const update = (set: (value: string) => void, value: string) => { set(value); onChanged(); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled || !valid || !employee || !member || budgetMicroUsd === null) return;
    onPrepare({ employeeId, employeeVersion: employee.version, memberId, memberVersion: member.version, model,
      currency: "USD", budgetMicroUsd, maxRequests: Number(requests), maxInputBytes: Number(inputBytes), maxOutputTokens: Number(outputTokens), expiresAt: Date.now() + Number(minutes) * 60_000 });
  };
  return <form aria-label="Prepare deployment-funded text allowance" onSubmit={submit} className="mt-3 grid min-w-0 gap-3">
    <p className="text-xs text-[var(--ink-2)]">Only a deployment operator who is also a current workspace manager can enable this allowance. Select one employee version, one member and each limit explicitly. Job titles grant no billing authority.</p>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className="text-xs">Funded employee<select className={FIELD} value={employeeId} disabled={disabled} onChange={(event) => update(setEmployeeId, event.target.value)}><option value="">Choose an employee version</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select></label>
      <label className="text-xs">Funded member<select className={FIELD} value={memberId} disabled={disabled} onChange={(event) => update(setMemberId, event.target.value)}><option value="">Choose a current workspace member</option>{actors.map((item) => <option key={item.userId} value={item.userId}>{item.userId} · membership v{item.version}</option>)}</select></label></div>
    <label className="text-xs">Exact Workers AI model<select className={FIELD} value={chosenModel} disabled={disabled} onChange={(event) => update(setChosenModel, event.target.value)}><option value="">Choose the deployment model</option>{model && <option value={model}>{model}</option>}</select></label>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className="text-xs">Maximum model requests<input type="number" min={1} max={10} step={1} className={FIELD} value={requests} disabled={disabled} onChange={(event) => update(setRequests, event.target.value)} /></label>
      <label className="text-xs">Maximum full input bytes per request<select className={FIELD} value={inputBytes} disabled={disabled} onChange={(event) => update(setInputBytes, event.target.value)}><option value="">Choose an input bound</option>{[1024, 4096, 8192, 16384].map((limit) => <option key={limit} value={limit}>{limit.toLocaleString()} UTF-8 bytes</option>)}</select></label>
      <label className="text-xs">Maximum output tokens per request<select className={FIELD} value={outputTokens} disabled={disabled} onChange={(event) => update(setOutputTokens, event.target.value)}><option value="">Choose an output bound</option>{[64, 256, 512, 1024].map((limit) => <option key={limit} value={limit}>{limit.toLocaleString()} tokens</option>)}</select></label>
      <label className="text-xs">Funding expiry<select className={FIELD} value={minutes} disabled={disabled} onChange={(event) => update(setMinutes, event.target.value)}><option value="">Choose a duration</option><option value="15">15 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="1440">24 hours</option></select></label></div>
    <label className="text-xs">Maximum quoted inference budget (USD)<input type="text" inputMode="decimal" maxLength={9} className={FIELD} value={budget} placeholder="Enter up to 1.000000" disabled={disabled} onChange={(event) => update(setBudget, event.target.value)} /></label>
    <p className="text-xs text-[var(--ink-2)]">{maximumDebit ? `At least ${formatMicroUsd(maximumDebit)} is needed for one full-context reservation. ` : "Choose an output bound to see its full-context reservation. "}The exact server quote is reviewed next and permits new calls for at most 15 minutes; there is no automatic renewal. Employee instructions and selected context count toward the full input bound. Tools, CLI execution and fallback providers are unavailable.</p>
    <p className="text-xs text-[var(--ink-2)]">{TEAM_MODEL_COST_DISCLOSURE}</p>
    <button type="submit" className={BUTTON} disabled={disabled || !valid}>Prepare exact funding review</button>
  </form>;
}
