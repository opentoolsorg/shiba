# PR188 computer-access increment — 2026-11-05

Base: `7a96effab47d56820ae24f2c869d7d70eb1709f2`.
Dedicated branch: `feat/prince-multi-agent-control-plane--computer-access`.

## Scope

API-only preview and human-reviewed import of one fixed bundled RFC 2606 factual
summary. No external request, browser navigation, authenticated browsing, agent
grant, UI, dependency, image, network policy or generated-file change. Existing
funding/approval/start, native tenant/session authority and exclusive human lease
are required for effects. Protocol and exact remaining owner choice:
[shared-computer-online-boundary.md](../shared-computer-online-boundary.md).

## Focused acceptance — passed

- Real SQLite stores and the ComputerSession DO with a **fake Container**:
  `pnpm -C apps/backend exec vitest run test/shared-computers.test.ts test/shared-computer.security-v3.test.ts test/shared-computer-image-policy.test.ts`.
- **74 tests passed across three files** (57 shared-computer, 13 security, four image-policy).
- Backend source and test types: `pnpm -C apps/backend typecheck`.
- Changed-file CI-mode Biome lint and ESLint import-boundary checks passed; parent owns integrated CI.
  An initial formatter/assist-enabled Biome probe rejected the existing compressed
  files; the repository CI intentionally disables those checks. No broad reformat
  was applied. Existing lint warnings remain.
- Dependencies were refreshed with the fetched head's frozen lockfile after the
  initial typecheck found packages absent from the older setup checkout. The
  refreshed typecheck passed; no manifest or lockfile changed.
- Independent read-only security review found no critical flaw. It confirmed raw
  installed Container interception types are not proof of comprehensive outbound
  enforcement; the desktop remains internet-disabled with existing root /
  `--no-sandbox` assumptions, unsuitable for hostile-web activation.

New fixtures cover exact bounded text, no fetch or credential inheritance,
session/workspace/version/digest binding, immutable server-side bytes, explicit
review, duplicate refusal, uncertain outcome/no replay, viewer/controller/agent
separation, foreign workspace denial, room/account/lease/expiry/STOP revocation,
and native-session replacement between claim and dispatch. URL/private-IP/
metadata/IPv6/rebinding/redirect-looking identifiers and URL extensions are
rejected rather than resolved. These tests prove **no URL retrieval surface**;
they do not claim a DNS-rebinding-safe online fetch implementation.

No real containers, browser interaction, live accounts, providers, payments,
managed preview, production deployment or merge used. No UI changed, so no fresh
UI screenshot is claimed. Existing PR188 full desktop failure is not resolved by
this increment.
