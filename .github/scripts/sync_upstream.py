"""Synchronize only the four explicitly mapped upstream branches."""

import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


UPSTREAMS = (
    "max-sixty/worktrunk",
    "stablyai/orca",
    "yoonjae26/AgentBridge",
    "andyyaro/orkestra",
)
TRACKING_REF = "refs/heads/main"


def run(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True,
                          encoding="utf-8", errors="replace").stdout.strip()


def sync(upstream, record):
    fork = "ChiJiun/" + upstream.split("/")[-1]
    metadata = json.loads(run("gh", "api", f"repos/{fork}"))
    if (metadata.get("parent", {}).get("full_name") != upstream
            or metadata.get("default_branch") != "main"
            or metadata["parent"].get("default_branch") != "main"):
        raise ValueError("Fork parent or tracking branch changed")
    if not metadata.get("permissions", {}).get("push"):
        raise ValueError("Credential lacks push access to the fork")

    source_url = record["upstream"]
    fork_url = f"https://github.com/{fork}.git"
    with tempfile.TemporaryDirectory() as directory:
        run("git", "init", "--bare", directory)
        run("git", "fetch", "--no-tags", fork_url,
            f"{TRACKING_REF}:refs/sync/fork", cwd=directory)
        old = run("git", "rev-parse", "refs/sync/fork", cwd=directory)
        record["old_sha"] = old
        record["new_sha"] = old
        run("git", "fetch", "--no-tags", source_url,
            f"{TRACKING_REF}:refs/sync/upstream", cwd=directory)
        candidate = run("git", "rev-parse", "refs/sync/upstream", cwd=directory)
        record["upstream_sha"] = candidate
        if old == candidate:
            return "up-to-date"

        ancestry = subprocess.run(
            ["git", "merge-base", "--is-ancestor", old, candidate],
            cwd=directory, check=False,
        )
        if ancestry.returncode == 1:
            raise ValueError("Blocked: fork is ahead of or has diverged from upstream")
        ancestry.check_returncode()
        paths = run("git", "diff", "--name-only", "--no-renames", "-z",
                    old, candidate, cwd=directory).split("\0")
        record["license_notice_changes"] = [
            path for path in paths
            if re.match(r"^(licen[cs]es?|notice)(?:$|[._ -])",
                        Path(path).name, re.IGNORECASE)
        ]
        current = run("git", "ls-remote", "--exit-code", fork_url, TRACKING_REF,
                      cwd=directory).split()[0]
        if current != old:
            raise ValueError("Blocked: fork tracking ref changed during validation")
        run("git", "-c", "credential.helper=",
            "-c", "credential.helper=!gh auth git-credential", "push", "--no-follow-tags",
            fork_url, f"{candidate}:{TRACKING_REF}", cwd=directory)
        record["new_sha"] = run(
            "git", "ls-remote", "--exit-code", fork_url, TRACKING_REF, cwd=directory,
        ).split()[0]
        if record["new_sha"] != candidate:
            raise ValueError("Tracking ref changed after push")
        return "fast-forwarded"


def main():
    failed = False
    for upstream in UPSTREAMS:
        record = {
            "time_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "upstream": f"https://github.com/{upstream}.git",
            "tracking_ref": TRACKING_REF,
            "old_sha": None,
            "new_sha": None,
            "license_notice_changes": [],
        }
        try:
            record["result"] = sync(upstream, record)
        except (ValueError, subprocess.CalledProcessError, OSError) as error:
            failed = True
            record["result"] = "blocked"
            if isinstance(error, subprocess.CalledProcessError):
                record["reason"] = f"{error.cmd[0]} {error.cmd[1]} exited {error.returncode}"
            else:
                record["reason"] = str(error)
            print(f"::error::{upstream} sync blocked. See the synchronization record.")

        output = json.dumps(record)
        print(output)
        if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(summary, "a", encoding="utf-8") as report:
                report.write(f"\n```json\n{output}\n```\n")
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
