# T66 docs — worker-3
Changed: apps/web/src/content/docs/docs/remote-access.md (new "## Desktop app" section before "Security model"). No other files.
Check: `pnpm docs:verify` passed (49 HTML pages, 32 markdown files stale-claim check). It validates the existing built output, so the new section was not rendered by it.
Unverified claims (confirm against the real build): `<userData>` = ~/Library/Application Support/Shiba (depends on productName); `.dmg` artifact and `/Applications/Shiba.app` name; "Disconnect this computer" unpairs; run-finished notification wording; "Connect this computer" button label in the Remote Access view.
