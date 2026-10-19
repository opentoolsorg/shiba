# PR publish

## Sub-features

- Create pull request checked.
- Worker publishes via GitHub REST (never the container).
- PR card shows link/state/checks when UI is present.

## How to get to it (user POV)

Check Create pull request, send, approve. After the run completes, open the thread/run detail.

## Driving it with Playwright

Toggle Create pull request. After completion: getByTestId('pr-card'). Read /pr/status and GitHub or mock reviews.

## Gotchas

- publishPullRequest without GITHUB_TOKEN is 400.
- No SHIBA_TEST_REPO: mock boundary mode, label mock GitHub, not live proof.
- Baseline UI has no pr-card until Phase 1 UI lands.
