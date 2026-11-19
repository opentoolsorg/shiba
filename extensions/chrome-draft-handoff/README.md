# Chrome draft handoff

A minimal MV3 action that opens the page you are reading in a Shiba chat draft.
It hands over one sanitized web address and nothing else, and it does so only
when you click.

## What it does

1. You click the Shiba toolbar button on a page.
2. The popup shows the address it is willing to send — scheme, host and path.
   Credentials, query and fragment are gone.
3. The draft starts as that address and you may edit it.
4. You click **Open draft in Shiba**, and the dashboard opens the thread it
   would restore anyway (a linked or remembered thread, else the default one)
   with the draft in that thread's composer, unsent. An unsent draft already
   there is kept, with the handoff below it. Sending is your decision, in the
   composer, as usual.

The handoff is the dashboard's existing deep link: `/threads/?prompt=<draft>`.
The Threads route prefills the composer from `?prompt=`, strips the parameter
from the address and never submits it (`apps/frontend/src/ui-helpers.ts`,
`readPromptParam`; the 4000-character cap there is mirrored here). The Worker's
shell route serves `/threads/`; the older `/app/` spelling is not in that
allowlist, so the extension does not use it.

## Install

Chrome no longer honours `--load-extension` (it was removed from the command
line), so use the browser UI:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** and pick this folder.

Then open the extension's options, and set the dashboard origin —
`https://shiba.example.com` for a deployment, or `http://localhost:8788` for a
local Worker. Only the origin is accepted: a path, query, fragment or embedded
username/password is refused rather than trimmed, and plain http is accepted
only for a loopback address.

## Permission boundary

`manifest.json` asks for exactly two permissions and nothing else:

| Permission | Why | What it does not allow |
| --- | --- | --- |
| `activeTab` | Read the address of the tab you invoked the action on | No standing access to any site; the grant ends with the tab or the navigation |
| `storage` | Remember the one dashboard origin you configured | No page data, no history, no synced account state |

There are no host permissions, no optional permissions, no content scripts, no
background service worker, no `chrome.scripting`, `webRequest`, `cookies`,
`debugger`, `history`, `bookmarks`, `identity` or native messaging, and no
`externally_connectable`. The extension injects nothing into pages and scrapes
nothing. It cannot start a run, mint an approval, call a provider, send a
message, reach a paired device or the local daemon. `test/handoff.test.mjs`
asserts each of those absences against the manifest and the sources, so adding
one fails the suite.

What still reaches Shiba when you click: the sanitized address, inside the
draft, in a normal browser navigation to your own dashboard. The dashboard
stores it exactly as it stores anything you type into the composer, and the
draft waits unsent until you send it.

## Limitations

- **Address only.** No page title, selection, screenshot or contents. A page
  whose meaning lives in the query string loses it; the draft says so by
  showing exactly what will be sent before you click.
- **Origin-only destination.** The dashboard's routes are root-flat, so an
  installation under a subpath is not supported.
- **No attachments or tabs beyond one.** One page per handoff.
- **Unpacked only.** There is no store package, signing, update channel or
  published release; the folder is loaded by hand.
- **A toolbar click is still a person's action.** Chrome grants `activeTab` on
  invocation, so a script cannot drive the happy path end to end; the harness
  below stands in only for that one browser call and says so.

## Checks

```bash
node --test test/*.test.mjs          # policy, manifest and source invariants
node test/chrome-handoff.e2e.mjs     # real Chrome, unpacked, synthetic pages
```

`node test/chrome-handoff.e2e.mjs --chrome=/path/to/chrome` overrides the
browser binary; with no Chrome at the default path the e2e prints a skip and
exits 0. The e2e loads the folder through Chrome
itself (`Extensions.loadUnpacked`), so the id it uses is the one Chrome
assigned. It then serves a synthetic article and a stub dashboard that mirrors
the `?prompt=` contract, and asserts that:

- with no action invocation, Chrome withholds every other tab's address and the
  popup reports that instead of guessing;
- the preview and the draft keep only scheme, host and path — a page address
  carrying `reader:hunter2@`, `?token=…&mail=…` and `#section-2` reaches the
  dashboard stripped of all three;
- nothing is requested before the click, and the click produces one `GET` to
  `/threads/` carrying the edited draft;
- the dashboard composer holds that draft, editable and unsent, with the
  parameter stripped from the address;
- no `/api/` request and no `POST` was made at any point, and the extension
  pages fetched only their own files;
- Chrome granted only `activeTab` and `storage`, with zero host origins.
