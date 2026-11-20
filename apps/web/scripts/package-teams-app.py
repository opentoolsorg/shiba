import argparse
import json
import re
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def main():
    parser = argparse.ArgumentParser(description="Build the Shiba custom app ZIP for Teams.")
    parser.add_argument("app_id", metavar="APP_ID", help="Azure Bot's Microsoft App ID")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", args.app_id, re.I):
        parser.error("APP_ID must be the hyphenated Application (client) ID")

    web = Path(__file__).resolve().parents[1]
    source = web / "teams-app"
    manifest = json.loads((source / "manifest.template.json").read_text(encoding="utf-8"))
    manifest["id"] = args.app_id
    manifest["bots"][0]["botId"] = args.app_id
    output = web / ".build" / "teams" / "shiba-teams.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as package:
        package.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
        for icon in manifest["icons"].values():
            package.write(source / icon, icon)
    print(output)


if __name__ == "__main__":
    main()
