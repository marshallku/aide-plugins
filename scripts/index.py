#!/usr/bin/env python3
"""Checks submissions and builds the AIDE plugin index.

    index.py check <submission.json>...   verify submissions (PR CI); writes a review report
    index.py publish                      copy every verified submission into packages/ (main CI)
    index.py site <out>                   write the Pages site: packages/ + plugins.json

A submission is submissions/<id>/<version>.json = {"repo": "owner/name", "tag": "...", "hash": "..."}.
The hash is the bundle hash `aide-plugin-check` prints; review approves exactly those bytes, and
publishing refuses anything else. Published versions never change.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUBMISSIONS = ROOT / "submissions"
PACKAGES = ROOT / "packages"
CHECKER = os.environ.get("AIDE_PLUGIN_CHECK", str(ROOT / "tools/check/aide-plugin-check"))
ASSETS = ["manifest.json", "main.js", "index.html", "styles.css"]

ID = re.compile(r"^[a-z][a-z0-9-]{1,39}$")
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$")
REPO = re.compile(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")
TAG = re.compile(r"^[A-Za-z0-9._/-]{1,100}$")
HASH = re.compile(r"^[0-9a-f]{64}$")


class Refused(Exception):
    pass


def run_checker(folder):
    result = subprocess.run([CHECKER, "--publish", str(folder)], capture_output=True, text=True)
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise Refused(f"checker failed: {result.stderr.strip()}")
    if not report.get("ok"):
        raise Refused(report.get("error", "refused"))
    return report


def read_submission(path):
    path = Path(path).resolve()
    try:
        rel = path.relative_to(SUBMISSIONS)
    except ValueError:
        raise Refused(f"{path} is not under submissions/")
    parts = rel.parts
    if len(parts) != 2 or not parts[1].endswith(".json"):
        raise Refused("submissions are submissions/<id>/<version>.json")
    plugin_id, version = parts[0], parts[1][: -len(".json")]
    if not ID.match(plugin_id) or not VERSION.match(version) or len(version) > 32:
        raise Refused(f"bad id or version in {rel}")
    data = json.loads(path.read_text())
    if not isinstance(data, dict) or set(data) != {"repo", "tag", "hash"}:
        raise Refused("a submission is exactly {repo, tag, hash}")
    if not (isinstance(data["repo"], str) and REPO.match(data["repo"])):
        raise Refused("repo must be owner/name")
    if not (isinstance(data["tag"], str) and TAG.match(data["tag"]) and ".." not in data["tag"]):
        raise Refused("bad tag")
    if not (isinstance(data["hash"], str) and HASH.match(data["hash"])):
        raise Refused("hash must be 64 lowercase hex characters")
    return {"id": plugin_id, "version": version, **data}


def submissions():
    out = []
    for path in sorted(SUBMISSIONS.glob("*/*.json")):
        out.append(read_submission(path))
    return out


def owner_check(sub, all_subs):
    """One id belongs to one repo: the first submission's."""
    for other in all_subs:
        if other["id"] == sub["id"] and other["repo"].lower() != sub["repo"].lower():
            raise Refused(f"{sub['id']} is already published from {other['repo']}")


def fetch(sub, into):
    """Downloads the release assets an AIDE package may hold."""
    into.mkdir(parents=True)
    args = ["gh", "release", "download", sub["tag"], "-R", sub["repo"], "-D", str(into)]
    for name in ASSETS:
        args += ["-p", name]
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        raise Refused(f"couldn't download {sub['repo']}@{sub['tag']}: {result.stderr.strip()}")


def verify(sub, folder):
    report = run_checker(folder)
    if report["id"] != sub["id"] or report["version"] != sub["version"]:
        raise Refused(f"the package is {report['id']} {report['version']}, the submission says {sub['id']} {sub['version']}")
    if report["hash"] != sub["hash"]:
        raise Refused(f"the release's hash is {report['hash']}, the submission says {sub['hash']}")
    return report


def published(sub):
    return PACKAGES / sub["id"] / sub["version"]


def semver_key(version):
    core, _, pre = version.partition("-")
    numbers = tuple(int(n) for n in core.split("."))
    if not pre:
        return numbers + ((1,),)
    ids = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split("."))
    return numbers + ((0,) + ids,)


def previous_version(sub, all_subs):
    older = [s for s in all_subs if s["id"] == sub["id"] and semver_key(s["version"]) < semver_key(sub["version"])]
    older = [s for s in older if published(s).is_dir()]
    return max(older, key=lambda s: semver_key(s["version"])) if older else None


def diff(old, new):
    result = subprocess.run(["diff", "-ruN", str(old), str(new)], capture_output=True, text=True)
    return result.stdout


def cmd_check(paths):
    all_subs = submissions()
    report = ["# Plugin submission review", ""]
    failed = False
    for path in paths:
        try:
            sub = read_submission(path)
            owner_check(sub, all_subs)
            with tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp) / "package"
                fetch(sub, folder)
                info = verify(sub, folder)
                if published(sub).is_dir() and run_checker(published(sub))["hash"] != sub["hash"]:
                    raise Refused("this version is already published with different contents")
                report += [f"## ✅ {info['id']} {info['version']}", "",
                           f"- From `{sub['repo']}` @ `{sub['tag']}`, hash `{info['hash']}`",
                           f"- {info.get('name')}: {info.get('description', '')}",
                           f"- Capabilities: {', '.join(info['capabilities']) or '(none)'}"]
                previous = previous_version(sub, all_subs)
                if previous:
                    before = set(run_checker(published(previous))["capabilities"])
                    added, removed = set(info["capabilities"]) - before, before - set(info["capabilities"])
                    report.append(f"- Since {previous['version']}: added {sorted(added) or 'nothing'}, removed {sorted(removed) or 'nothing'}")
                    changes = diff(published(previous), folder)
                else:
                    (Path(tmp) / "empty").mkdir()
                    changes = diff(Path(tmp) / "empty", folder)
                report += ["", "<details><summary>Files as published (review these, not the repo's source)</summary>", "",
                           "```diff", changes.replace("```", "`​``"), "```", "</details>", ""]
        except (Refused, json.JSONDecodeError, OSError) as error:
            failed = True
            report += [f"## ❌ {path}", "", str(error), ""]
    text = "\n".join(report)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write(text + "\n")
    return 1 if failed else 0


def cmd_publish():
    all_subs = submissions()
    failed = False
    for sub in all_subs:
        target = published(sub)
        try:
            owner_check(sub, all_subs)
            if target.is_dir():
                if run_checker(target)["hash"] != sub["hash"]:
                    raise Refused("published copy doesn't match its submission")
                continue
            with tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp) / "package"
                fetch(sub, folder)
                verify(sub, folder)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(folder, target)
                print(f"published {sub['id']} {sub['version']}")
        except Refused as error:
            failed = True
            print(f"::error::{sub['id']} {sub['version']}: {error}")
    return 1 if failed else 0


def read_revoked():
    revoked = json.loads((ROOT / "revoked.json").read_text())
    if not isinstance(revoked, list):
        raise Refused("revoked.json must be a list")
    for item in revoked:
        if not isinstance(item, dict) or not set(item) <= {"id", "hash", "reason"} or not ID.match(str(item.get("id"))):
            raise Refused(f"bad revocation {item}")
        if "hash" in item and not HASH.match(str(item["hash"])):
            raise Refused(f"bad revocation hash {item}")
        if not isinstance(item.get("reason"), str) or not item["reason"]:
            raise Refused(f"revocation of {item['id']} needs a reason")
    return revoked


def cmd_site(out):
    out = Path(out)
    revoked = read_revoked()
    whole = {r["id"] for r in revoked if "hash" not in r}
    hashes = {(r["id"], r["hash"]) for r in revoked if "hash" in r}
    latest = {}
    for sub in submissions():
        if not published(sub).is_dir() or sub["id"] in whole or (sub["id"], sub["hash"]) in hashes:
            continue
        current = latest.get(sub["id"])
        if current is None or semver_key(sub["version"]) > semver_key(current["version"]):
            latest[sub["id"]] = sub
    plugins = []
    for plugin_id in sorted(latest):
        sub = latest[plugin_id]
        info = run_checker(published(sub))
        if info["hash"] != sub["hash"]:
            raise Refused(f"{plugin_id} {sub['version']} doesn't match its submission")
        entry = {"id": plugin_id, "name": info["name"], "description": info.get("description", ""),
                 "repo": f"https://github.com/{sub['repo']}", "version": sub["version"], "hash": info["hash"],
                 "url": f"packages/{plugin_id}/{sub['version']}/", "files": info["files"],
                 "capabilities": info["capabilities"]}
        if info.get("author"):
            entry["author"] = info["author"]
        plugins.append(entry)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(PACKAGES, out / "packages")
    index = {"generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "plugins": plugins, "revoked": revoked}
    (out / "plugins.json").write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    (out / "index.html").write_text('<!doctype html><meta charset="utf-8"><title>AIDE plugins</title>'
                                     '<p>The AIDE community plugin index: <a href="plugins.json">plugins.json</a>. '
                                     'Submit at <a href="https://github.com/marshallku/aide-plugins">github.com/marshallku/aide-plugins</a>.</p>\n')
    print(f"site: {len(plugins)} plugins, {len(revoked)} revocations")
    return 0


def main(argv):
    if len(argv) >= 2 and argv[0] == "check":
        return cmd_check(argv[1:])
    if argv == ["publish"]:
        return cmd_publish()
    if len(argv) == 2 and argv[0] == "site":
        return cmd_site(argv[1])
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Refused as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
