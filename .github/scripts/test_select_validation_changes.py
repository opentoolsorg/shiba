import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from select_validation_changes import fetch_github_page, select_checks


class ValidationSelectionTests(unittest.TestCase):
    def select(self, files):
        return select_checks("188", lambda number, page: files)

    def test_manual_desktop_run_does_not_fetch_or_build_an_image(self):
        def unexpected_fetch(number, page):
            self.fail("Manual Desktop verification must not fetch a PR")

        for number in ("", " "):
            self.assertEqual(
                select_checks(number, unexpected_fetch),
                {"desktop": True, "sandbox_image": False},
            )

    def test_docs_and_screenshots_skip_both_checks(self):
        self.assertEqual(
            self.select([{"filename": "docs/setup.md"}, {"filename": "screenshots/app.png"}]),
            {"desktop": False, "sandbox_image": False},
        )

    def test_application_and_unknown_root_changes_keep_desktop_only(self):
        for path in ("apps/frontend/src/app.tsx", "pnpm-lock.yaml", "unknown-config.json"):
            with self.subTest(path=path):
                self.assertEqual(
                    self.select([{"filename": path}]),
                    {"desktop": True, "sandbox_image": False},
                )

    def test_each_image_input_selects_both_checks(self):
        for path in (
            "apps/backend/Dockerfile",
            "apps/backend/scripts/acp-install.sh",
            ".dockerignore",
            "apps/backend/.dockerignore",
            "apps/backend/Dockerfile.dockerignore",
            ".github/workflows/desktop.yml",
            ".github/workflows/build-sandbox-image.yml",
            ".github/scripts/select_validation_changes.py",
            ".github/scripts/test_select_validation_changes.py",
        ):
            with self.subTest(path=path):
                self.assertEqual(
                    self.select([{"filename": path}]),
                    {"desktop": True, "sandbox_image": True},
                )

    def test_renaming_an_image_input_into_docs_still_builds_image(self):
        self.assertEqual(
            self.select(
                [{"filename": "docs/old-image.txt", "previous_filename": "apps/backend/Dockerfile"}]
            ),
            {"desktop": True, "sandbox_image": True},
        )

    def test_renaming_application_code_into_docs_keeps_desktop_only(self):
        self.assertEqual(
            self.select(
                [{"filename": "docs/old-code.txt", "previous_filename": "apps/frontend/src/app.tsx"}]
            ),
            {"desktop": True, "sandbox_image": False},
        )

    def test_later_image_page_is_not_lost_after_desktop_is_selected(self):
        calls = []

        def fetch(number, page):
            calls.append((number, page))
            if page == 1:
                return [{"filename": f"apps/frontend/src/file-{i}.ts"} for i in range(100)]
            return [{"filename": "apps/backend/Dockerfile"}]

        self.assertEqual(select_checks("188", fetch), {"desktop": True, "sandbox_image": True})
        self.assertEqual(calls, [(188, 1), (188, 2)])

    def test_paginated_docs_can_finish_without_selecting_either_check(self):
        calls = []

        def fetch(number, page):
            calls.append(page)
            return [{"filename": f"docs/page-{i}.md"} for i in range(100)] if page == 1 else []

        self.assertEqual(select_checks("188", fetch), {"desktop": False, "sandbox_image": False})
        self.assertEqual(calls, [1, 2])

    def test_paginated_application_changes_do_not_imply_image_changes(self):
        def fetch(number, page):
            if page == 1:
                return [{"filename": f"docs/page-{i}.md"} for i in range(100)]
            return [{"filename": "apps/backend/src/runtime.ts"}]

        self.assertEqual(select_checks("188", fetch), {"desktop": True, "sandbox_image": False})

    def test_full_3000_file_limit_selects_both_checks_conservatively(self):
        calls = []

        def fetch(number, page):
            calls.append(page)
            return [{"filename": f"docs/page-{page}-{i}.md"} for i in range(100)]

        self.assertEqual(select_checks("188", fetch), {"desktop": True, "sandbox_image": True})
        self.assertEqual(calls, list(range(1, 31)))

    def test_fetch_failure_on_first_or_later_page_selects_both_checks(self):
        for failing_page in (1, 2):
            with self.subTest(failing_page=failing_page):
                def fetch(number, page):
                    if page == failing_page:
                        raise OSError("API unavailable")
                    return [{"filename": f"apps/frontend/src/file-{i}.ts"} for i in range(100)]

                self.assertEqual(
                    select_checks("188", fetch), {"desktop": True, "sandbox_image": True}
                )

    def test_malformed_responses_select_both_checks(self):
        for response in (
            {"message": "API error"},
            [None],
            [{}],
            [{"filename": ""}],
            [{"filename": 42}],
            [{"filename": "docs/file.md", "previous_filename": 42}],
            [{"filename": "docs/file.md"}] * 101,
        ):
            with self.subTest(response=response):
                self.assertEqual(self.select(response), {"desktop": True, "sandbox_image": True})

    def test_invalid_pr_numbers_select_both_without_a_request(self):
        for number in ("0", "-1", "not-a-number"):
            with self.subTest(number=number):
                self.assertEqual(
                    select_checks(number, lambda *_: self.fail("Unexpected request")),
                    {"desktop": True, "sandbox_image": True},
                )

    def test_api_adapter_requests_the_exact_page_with_bounded_timeout(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return json.dumps([{"filename": "docs/setup.md"}]).encode()

        with patch("urllib.request.urlopen", return_value=Response()) as request:
            self.assertEqual(
                fetch_github_page("opentoolsorg/shiba", "test-token", 188, 2),
                [{"filename": "docs/setup.md"}],
            )
        args, kwargs = request.call_args
        self.assertEqual(
            args[0].full_url,
            "https://api.github.com/repos/opentoolsorg/shiba/pulls/188/files?per_page=100&page=2",
        )
        self.assertEqual(args[0].get_header("Authorization"), "Bearer test-token")
        self.assertEqual(kwargs, {"timeout": 4})

    def test_manual_entrypoint_writes_both_outputs_without_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "outputs"
            env = {key: value for key, value in os.environ.items() if key not in ("GH_TOKEN", "GH_REPO")}
            env.update(PR_NUMBER="", GITHUB_OUTPUT=str(output))
            subprocess.run(
                [sys.executable, str(Path(__file__).with_name("select_validation_changes.py"))],
                env=env,
                check=True,
            )
            self.assertEqual(output.read_text(), "desktop=true\nsandbox_image=false\n")


if __name__ == "__main__":
    unittest.main()
