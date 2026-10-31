# Employee tool policy

This file is the legacy uppercase entry point. The current policy and lifecycle
documentation is maintained in [employee-tool-policy.md](employee-tool-policy.md).

The supported Worker-side app actions are `gmail_read`, `run_status`,
`queue_run`, and `send_email`. They use the authenticated employee selection,
current membership and exact resource grants; write actions require their
existing human approval flows. Normal employee Work threads expose only the
selected supported app tools, and each call rechecks current authority. A
managed profile with all actions cleared stays deny-all for Worker app tools;
it does not fall back to the legacy `run_code` tool. Profiles that have never
had a managed app-tool selection keep their existing legacy behavior.

These grants govern only the listed Worker-side app tools. They do not
constrain shell or CLI tools inside a coding harness, add credentials to a
sandbox, or narrow arbitrary code executed by a harness. Those capabilities
remain governed by the existing sandbox and egress controls. External MCP and
connector actions are not implicitly granted by this policy.
