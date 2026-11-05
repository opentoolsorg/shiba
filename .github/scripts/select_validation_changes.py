"""Select independent Desktop, coding-image and offline-desktop checks."""

import json
import os
import urllib.request
from pathlib import PurePosixPath


IMAGE_INPUTS = frozenset(
    {
        "apps/backend/Dockerfile",
        "apps/backend/scripts/acp-install.sh",
        ".github/workflows/desktop.yml",
        ".github/workflows/build-sandbox-image.yml",
        ".github/scripts/select_validation_changes.py",
        ".github/scripts/test_select_validation_changes.py",
    }
)


def desktop_relevant(path):
    if path.startswith(
        ("apps/", "packages/", "scripts/", "patches/", ".cursor/skills/verify-shiba/", ".github/")
    ):
        return True
    if path.startswith(("docs/", "screenshots/")):
        return False
    # Preserve the existing conservative selection for unknown/root configuration.
    return True


def image_relevant(path):
    return path in IMAGE_INPUTS or PurePosixPath(path).name in (
        ".dockerignore",
        "Dockerfile.dockerignore",
    )


def computer_image_relevant(path):
    return path in {
        "apps/backend/Dockerfile.computer", ".github/workflows/desktop.yml",
        ".github/scripts/select_validation_changes.py",
        ".github/scripts/test_select_validation_changes.py",
    } or path.startswith("apps/backend/computer/") or PurePosixPath(path).name in (
        ".dockerignore", "Dockerfile.computer.dockerignore",
    )


def select_checks(pr_number, fetch_page):
    if not pr_number.strip():
        # Existing manual Desktop verification must not implicitly build an image.
        return {"desktop": True, "sandbox_image": False, "computer_image": False}

    selected = {"desktop": False, "sandbox_image": False, "computer_image": False}
    try:
        number = int(pr_number)
        if number <= 0:
            raise ValueError("Invalid PR number")
        for page in range(1, 31):
            files = fetch_page(number, page)
            if not isinstance(files, list) or len(files) > 100:
                raise ValueError("Invalid PR files response")
            for item in files:
                paths = [item["filename"]]
                if item.get("previous_filename") is not None:
                    paths.append(item["previous_filename"])
                for path in paths:
                    if not isinstance(path, str) or not path:
                        raise ValueError("Invalid PR file path")
                    selected["desktop"] |= desktop_relevant(path)
                    selected["sandbox_image"] |= image_relevant(path)
                    selected["computer_image"] |= computer_image_relevant(path)
            if all(selected.values()) or len(files) < 100:
                return selected
        # The API exposes at most 3,000 files; a full final page may be truncated.
    except Exception:
        # API/auth/schema failures must not silently skip either validation job.
        pass
    return {"desktop": True, "sandbox_image": True, "computer_image": True}


def fetch_github_page(repository, token, number, page):
    url = (
        f"https://api.github.com/repos/{repository}/pulls/{number}/files"
        f"?per_page=100&page={page}"
    )
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
        },
    )
    # Thirty bounded requests fit inside the selector job's three-minute limit.
    with urllib.request.urlopen(request, timeout=4) as response:
        return json.load(response)


def main():
    selected = select_checks(
        os.environ.get("PR_NUMBER", ""),
        lambda number, page: fetch_github_page(
            os.environ["GH_REPO"], os.environ["GH_TOKEN"], number, page
        ),
    )
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for name, value in selected.items():
            output.write(f"{name}={str(value).lower()}\n")


if __name__ == "__main__":
    main()
