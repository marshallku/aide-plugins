#!/usr/bin/env python3
"""Checks submissions and builds the AIDE plugin index.

    index.py check <base-sha> <submission.json>...   verify new submissions (PR CI); writes a review report
    index.py publish                      copy every verified submission into packages/ (main CI)
    index.py site <out>                   write the Pages site: packages/, plugins.json and a page listing them

A submission is submissions/<id>/<version>.json = {"repo": "owner/name", "tag": "...", "hash": "..."}.
The hash is the bundle hash `aide-plugin-check` prints; review approves exactly those bytes, and
publishing refuses anything else. Published versions never change. published.json keeps the day each
version was published (`updated` in the index).
"""

import html
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
PUBLISHED = ROOT / "published.json"
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


def base_submissions(base):
    """Submissions as of the PR's base commit, which the PR can't have changed."""
    listing = subprocess.run(["git", "ls-tree", "-r", "--name-only", base, "submissions/"],
                             capture_output=True, text=True, check=True, cwd=ROOT).stdout.split()
    out = []
    for name in listing:
        parts = Path(name).parts
        if len(parts) != 3 or not name.endswith(".json"):
            continue
        data = json.loads(subprocess.run(["git", "show", f"{base}:{name}"], capture_output=True, text=True,
                                         check=True, cwd=ROOT).stdout)
        out.append({"id": parts[1], "version": parts[2][: -len(".json")], **data})
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
    for file in folder.iterdir():
        data = file.read_bytes()
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise Refused(f"{file.name} isn't UTF-8 text, so it can't be reviewed")
        if "\x00" in text:
            raise Refused(f"{file.name} contains NUL bytes, so it can't be reviewed")
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
    result = subprocess.run(["diff", "-ruNa", str(old), str(new)], capture_output=True, text=True)
    return result.stdout


def cmd_check(base, paths):
    trusted = base_submissions(base)
    all_subs = submissions()
    report = ["# Plugin submission review", ""]
    failed = False
    for path in paths:
        try:
            sub = read_submission(path)
            owner_check(sub, trusted)
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
                           f"- Capabilities: {', '.join(info.get('capabilities', [])) or '(none)'}"]
                previous = previous_version(sub, all_subs)
                if previous:
                    before = set(run_checker(published(previous)).get("capabilities", []))
                    now = set(info.get("capabilities", []))
                    added, removed = now - before, before - now
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


def read_published():
    return json.loads(PUBLISHED.read_text()) if PUBLISHED.is_file() else {}


def cmd_publish():
    all_subs = submissions()
    dates = read_published()
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
                dates[f"{sub['id']}/{sub['version']}"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                print(f"published {sub['id']} {sub['version']}")
        except Refused as error:
            failed = True
            print(f"::error::{sub['id']} {sub['version']}: {error}")
    PUBLISHED.write_text(json.dumps(dict(sorted(dates.items())), indent=2) + "\n")
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
    dates = read_published()
    plugins = []
    for plugin_id in sorted(latest):
        sub = latest[plugin_id]
        info = run_checker(published(sub))
        if info["hash"] != sub["hash"]:
            raise Refused(f"{plugin_id} {sub['version']} doesn't match its submission")
        entry = {"id": plugin_id, "name": info["name"], "description": info.get("description", ""),
                 "repo": f"https://github.com/{sub['repo']}", "version": sub["version"], "hash": info["hash"],
                 "url": f"packages/{plugin_id}/{sub['version']}/", "files": info["files"],
                 "capabilities": info.get("capabilities", [])}
        if info.get("author"):
            entry["author"] = info["author"]
        if dates.get(f"{plugin_id}/{sub['version']}"):
            entry["updated"] = dates[f"{plugin_id}/{sub['version']}"]
        plugins.append(entry)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(PACKAGES, out / "packages")
    index = {"generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "plugins": plugins, "revoked": revoked}
    (out / "plugins.json").write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    (out / "index.html").write_text(directory(plugins))
    print(f"site: {len(plugins)} plugins, {len(revoked)} revocations")
    return 0


# What a capability lets a plugin do, as the app's install screen says it (CapabilityText).
CAPABILITIES = {
    "todos:read": "Read your todos, open and done, in any note",
    "todos:write": "Check off and add todos, in any note",
    "storage": "Keep its own data on the device",
    "schedule": "Run at set times while AIDE is open on a computer",
    "attachments:read": "Read the images and documents your notes show",
    "attachments:write": "Add images and documents to your notes",
}


def describe(capability):
    if capability in CAPABILITIES:
        return CAPABILITIES[capability]
    kind, _, rest = capability.partition(":")
    if kind == "net":
        return f"Reach {rest}"
    if kind == "notes":
        access, _, prefix = rest.partition(":")
        where = "all notes" if prefix == "*" else f"notes in {prefix}"
        return f"Read {where}" if access == "read" else f"Read and change {where}"
    return capability


def directory(plugins):
    """The site's front page: every plugin as the app's Browse community plugins lists it."""
    cards = []
    for entry in plugins:
        capabilities = entry.get("capabilities", [])
        asks = "".join(f"<li>{html.escape(describe(c))}</li>" for c in capabilities) or "<li>Asks for no access</li>"
        meta = [f"v{html.escape(entry['version'])}"]
        if entry.get("author"):
            meta.insert(0, f"by {html.escape(entry['author'])}")
        if entry.get("updated"):
            meta.append(f"updated {html.escape(entry['updated'])}")
        cards.append(
            f'<article id="{html.escape(entry["id"])}"><h2>{html.escape(entry["name"])}</h2>'
            f'<p class="meta">{" · ".join(meta)}</p><p>{html.escape(entry["description"])}</p>'
            f'<details><summary>It asks to</summary><ul>{asks}</ul></details>'
            f'<p class="links"><a href="{html.escape(entry["repo"])}">Source</a> · '
            f'<a href="{html.escape(entry["url"])}manifest.json">Manifest</a></p></article>')
    count = f"{len(plugins)} plugin{'s' if len(plugins) != 1 else ''}"
    return f"""<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIDE community plugins</title>
<style>
:root {{ color-scheme: light dark; --line: color-mix(in srgb, currentColor 15%, transparent); }}
body {{ font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 960px; padding: 32px 16px; }}
header p {{ opacity: .75; }}
main {{ display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }}
article {{ border: 1px solid var(--line); border-radius: 12px; padding: 16px; }}
h2 {{ font-size: 1.1rem; margin: 0; }}
.meta {{ font-size: .85rem; margin: 2px 0 8px; opacity: .7; }}
details {{ font-size: .9rem; }}
ul {{ margin: 4px 0; padding-left: 20px; }}
.links {{ font-size: .9rem; margin-bottom: 0; }}
</style>
<header>
<h1>AIDE community plugins</h1>
<p>{count}, each version reviewed and pinned by hash. Install them in AIDE from
<b>Settings › Community plugins › Browse community plugins</b>; they run in a sandbox with only the access you approve.
The index for apps is <a href="plugins.json">plugins.json</a>.
<a href="https://github.com/marshallku/aide-plugins">Submit a plugin</a> ·
<a href="https://github.com/marshallku/aide-plugins/issues/new?template=report-plugin.md">Report one</a></p>
</header>
<main>
{chr(10).join(cards)}
</main>
</html>
"""


def main(argv):
    if len(argv) >= 3 and argv[0] == "check":
        return cmd_check(argv[1], argv[2:])
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
