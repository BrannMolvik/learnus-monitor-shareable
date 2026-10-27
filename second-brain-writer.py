"""Optional exact-path Obsidian handoff. No credentials or personal defaults."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

ID = re.compile(r"learnus:[a-z_]+:[a-f0-9]{24}")
PREFIX = "- learnus-capture "
MARKER = "<!-- learnus-monitor:course-captures -->"


def normalize(value):
    return re.sub(r"[\W_]+", " ", unicodedata.normalize("NFKC", str(value or "")).lower()).strip()


def note_path(value, course=False):
    if (not isinstance(value, str) or not value.endswith(".md") or "\\" in value
            or re.search(r"[:\x00-\x1f]", value)
            or any(not p or p in (".", "..") or p.endswith((".", " "))
                   or re.match(r"^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", p, re.I)
                   for p in value.split("/"))
            or course and not value.startswith("Courses/")):
        raise ValueError("Unsafe note path. Use a vault-relative Markdown path.")
    return value


def settings(config_file):
    config_file = Path(config_file).resolve()
    raw = json.loads(config_file.read_text(encoding="utf-8-sig"))
    cfg = raw.get("secondBrain", {})
    if raw.get("schemaVersion") != 1 or cfg.get("mode") != "obsidian":
        raise ValueError("Obsidian integration is not explicitly enabled.")
    project = Path(cfg.get("projectDirectory", ""))
    vault = Path(cfg.get("vaultDirectory", ""))
    if not project.is_absolute() or not vault.is_absolute() or not vault.is_dir():
        raise ValueError("Select explicit existing MCP project and vault directories.")
    routes = {}
    for route in cfg.get("courses", []):
        target = note_path(route.get("path"), True)
        if not isinstance(route.get("aliases"), list) or not route["aliases"]:
            raise ValueError("Each route needs aliases.")
        for alias in route["aliases"]:
            key = normalize(alias)
            if not key or key in routes and routes[key] != target:
                raise ValueError("Empty or conflicting course alias.")
            routes[key] = target
    intake = note_path(cfg.get("intakeNote", "AI Inbox/LearnUs Intake.md"))
    targets = sorted({intake, *routes.values()})
    create = cfg.get("createMissingNotes", False)
    if not isinstance(create, bool):
        raise ValueError("createMissingNotes must be a boolean.")
    scope = {"path_prefixes": targets, "operations": ["append", "create"] if create else ["append"], "property_names": [], "managed_blocks": []}
    data = (config_file.parent / raw.get("dataDirectory", "data")).resolve()
    scope_name = "learnus-" + hashlib.sha256((str(vault.resolve()) + json.dumps(scope, sort_keys=True)).encode()).hexdigest()[:16]
    return {"project": project, "vault": vault, "data": data, "intake": intake,
            "routes": routes, "targets": targets, "scope": scope,
            "scope_name": scope_name, "create": create}


def load_modules(cfg):
    source = cfg["project"] / "src"
    if not source.is_dir():
        raise ValueError("The selected MCP project has no src directory.")
    os.environ["OBSIDIAN_MCP_VAULT"] = str(cfg["vault"])
    os.environ["OBSIDIAN_MCP_LOCAL_STATE"] = str(cfg["data"] / "obsidian-policy")
    os.environ.pop("OBSIDIAN_MCP_VAULT_ID", None)
    sys.path.insert(0, str(source))
    from obsidian_mcp.config import configured_scope_path, resolve_vault_relative_path
    from obsidian_mcp.tools.read_note import read_note
    from obsidian_mcp.tools.append_to_note import append_to_note
    from obsidian_mcp.tools.create_note import create_note
    from obsidian_mcp.write_policy import load_automation_scopes
    return dict(read=read_note, append=append_to_note, create=create_note, resolve=resolve_vault_relative_path,
                scope_path=configured_scope_path, scopes=load_automation_scopes)


def current(modules, cfg, target):
    if target not in cfg["targets"]:
        raise ValueError("Unapproved note target.")
    resolved = modules["resolve"](target, vault_root=cfg["vault"])
    if not resolved.exists():
        return None
    if not resolved.is_file():
        raise ValueError("A selected note is not a file.")
    try:
        result = modules["read"](target)
    except FileNotFoundError:
        return None
    content = result.get("content")
    if result.get("error") and not content:
        raise ValueError("A selected note is missing or unreadable.")
    if not isinstance(content, str):
        raise ValueError("MCP did not return readable note content.")
    return content


def verify_scope(modules, cfg):
    scope = modules["scopes"]().get(cfg["scope_name"])
    if (scope is None or list(scope.path_prefixes) != cfg["scope"]["path_prefixes"]
            or sorted(scope.operations) != cfg["scope"]["operations"]
            or list(scope.property_names) or list(scope.managed_blocks)):
        raise ValueError("Exact note permissions are not installed. Run explicit handoff setup first.")


def setup(modules, cfg, approve=False):
    if not approve:
        raise ValueError("Review exact target paths and explicitly approve setup first.")
    scope_file = modules["scope_path"]()
    scope_file.parent.mkdir(parents=True, exist_ok=True)
    payload = json.loads(scope_file.read_text(encoding="utf-8")) if scope_file.exists() else {"scopes": {}}
    if set(payload) != {"scopes"} or not isinstance(payload["scopes"], dict):
        raise ValueError("Unexpected scope file; preserved without modification.")
    existing = payload["scopes"].get(cfg["scope_name"])
    if existing is not None and existing != cfg["scope"]:
        raise ValueError("Existing scope differs; refusing to replace or broaden it.")
    if existing is None:
        payload["scopes"][cfg["scope_name"]] = cfg["scope"]
        temp = scope_file.with_suffix(".next")
        temp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(temp, scope_file)
    verify_scope(modules, cfg)
    # Missing notes are never created unless the user's configuration explicitly opted in.
    if cfg["create"]:
        for target in cfg["targets"]:
            if current(modules, cfg, target) is not None:
                continue
            proposal = modules["create"](action="propose", path=target, content="# LearnUs", client_id="learnus-monitor", automation_scope=cfg["scope_name"])
            result = modules["create"](action="apply", proposal_id=proposal["proposal_id"], client_id="learnus-monitor", automatic=True)
            if result.get("path") != target:
                raise ValueError("Note creation was not verified.")
    for target in cfg["targets"]:
        if current(modules, cfg, target) is None:
            raise ValueError("Create the selected notes first, or explicitly opt in to no-overwrite creation.")


def parse_line(line):
    if not isinstance(line, str) or not line.startswith(PREFIX) or len(line) > 5500 or "\n" in line or "\r" in line:
        raise ValueError("Invalid capture line.")
    record = json.loads(line[len(PREFIX):])
    if (record.get("source") != "Yonsei LearnUs" or record.get("source_kind") != "external_lms"
            or record.get("schema_version") != 1 or not ID.fullmatch(record.get("capture_id", ""))):
        raise ValueError("Invalid capture provenance or identifier.")
    return record


def append(modules, cfg, target, line):
    record = parse_line(line)
    for attempt in range(2):
        text = current(modules, cfg, target)
        if text is None:
            raise ValueError("Target note is missing. Automatic runs never create notes.")
        existing = set(re.findall(r'"capture_id"\s*:\s*"(learnus:[a-z_]+:[a-f0-9]{24})"', text))
        if record["capture_id"] in existing:
            return 0
        section = "\n\n" + MARKER + "\n## LearnUs\n" if target != cfg["intake"] and MARKER not in text else "\n"
        try:
            proposal = modules["append"](action="propose", path=target, text=section + line, client_id="learnus-monitor", automation_scope=cfg["scope_name"])
            result = modules["append"](action="apply", proposal_id=proposal["proposal_id"], client_id="learnus-monitor", automatic=True)
            if result.get("status") == "approval_pending" or result.get("path") != target:
                raise ValueError("Append was not verified.")
            return 1
        except RuntimeError as error:
            if attempt == 0 and "STALE PROPOSAL" in str(error):
                continue
            raise

def write_batch(modules, cfg, batch):
    verify_scope(modules, cfg)
    if batch.get("schema_version") != 1 or batch.get("target_path") != cfg["intake"] or not isinstance(batch.get("captures"), list):
        raise ValueError("Batch targets were not approved.")
    validated = []
    for capture in batch["captures"]:
        record = parse_line(capture.get("line"))
        target = cfg["routes"].get(normalize(record.get("course")))
        if capture.get("target_path") != cfg["intake"] or capture.get("capture_id") != record["capture_id"] or capture.get("course_note_path") != target:
            raise ValueError("Capture attempted to change an approved route or identifier.")
        validated.append((target, capture["line"]))
    added = 0
    for target, line in validated:
        added += append(modules, cfg, cfg["intake"], line)
        if target:
            added += append(modules, cfg, target, line)
    return added


def backfill(modules, cfg):
    verify_scope(modules, cfg)
    added = 0
    for line in (current(modules, cfg, cfg["intake"]) or "").splitlines():
        try:
            record = parse_line(line)
        except (ValueError, TypeError):
            continue
        target = cfg["routes"].get(normalize(record.get("course")))
        if target:
            added += append(modules, cfg, target, line)
    return added


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--setup", action="store_true")
    action.add_argument("--batch")
    action.add_argument("--backfill-courses", action="store_true")
    parser.add_argument("--approve-paths", action="store_true")
    args = parser.parse_args()
    cfg = settings(args.config)
    modules = load_modules(cfg)
    if args.setup:
        setup(modules, cfg, args.approve_paths)
        print("Exact-path Obsidian permissions configured.")
    else:
        added = write_batch(modules, cfg, json.loads(Path(args.batch).read_text(encoding="utf-8-sig"))) if args.batch else backfill(modules, cfg)
        print(json.dumps({"ok": True, "appended": added}))


if __name__ == "__main__":
    try:
        main()
    except ValueError as exc:
        print("Handoff configuration rejected: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        print("Handoff failed; verify MCP availability and approved note permissions. Scan state is unchanged.", file=sys.stderr)
        raise SystemExit(1)
