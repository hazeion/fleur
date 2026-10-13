#!/usr/bin/env python3
"""Read exact candidate metadata without installing or executing dependencies."""

import concurrent.futures
import datetime
import hashlib
import json
import platform
from pathlib import Path
import shutil
import sys
import urllib.error
import urllib.request


def probe(candidate):
    result = dict(candidate)
    request = urllib.request.Request(candidate["url"], headers={
        "User-Agent": "fleur-compatibility-probe",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read(4 * 1024 * 1024 + 1)
            result["http_status"] = response.status
        if len(payload) > 4 * 1024 * 1024:
            result["status"] = "invalid-metadata"
            result["reason"] = "metadata exceeds 4 MiB"
            return result
        metadata = json.loads(payload)
        result["metadata_sha256"] = hashlib.sha256(payload).hexdigest()
        if candidate["provider"] == "npm":
            expected_name = (
                "typescript" if candidate["name"].startswith("typescript-")
                and candidate["name"] != "typescript-eslint" else candidate["name"]
            )
            if metadata.get("version") != candidate["version"] or metadata.get("name") != expected_name:
                result["status"] = "identity-mismatch"
                return result
            distribution = metadata.get("dist", {})
            result["artifact"] = {key: distribution[key] for key in
                                  ("tarball", "integrity", "shasum") if key in distribution}
        else:
            if metadata.get("tag_name") != candidate["url"].rsplit("/", 1)[-1]:
                result["status"] = "identity-mismatch"
                return result
            result["assets"] = [{key: asset.get(key) for key in
                                ("name", "digest", "browser_download_url")}
                                for asset in metadata.get("assets", [])]
        result["status"] = "metadata-available"
    except urllib.error.HTTPError as error:
        result["http_status"] = error.code
        result["status"] = "unavailable" if error.code == 404 else "request-failed"
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        # Avoid exception strings that can disclose local paths or proxy credentials.
        result["status"] = "request-failed"
    return result


def main():
    candidates = json.loads(Path(__file__).with_name("candidates.json").read_text())
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(probe, candidates))
    report = {
        "format_version": 1,
        "observed_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "host": {"system": platform.system(), "architecture": platform.machine(),
                 "macos": platform.mac_ver()[0], "python": platform.python_version()},
        "prerequisites_on_path": {name: shutil.which(name) is not None
                                  for name in ("bun", "docker")},
        "results": results,
        "scope": "Metadata availability only; no artifact download, installation or execution.",
    }
    json.dump(report, sys.stdout, indent=2)
    print()
    return 0 if all(row["status"] == "metadata-available" for row in results) else 1


if __name__ == "__main__":
    sys.exit(main())
