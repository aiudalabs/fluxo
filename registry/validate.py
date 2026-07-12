#!/usr/bin/env python3
"""Validate the Fluxo registry (F0-05).

The registry IS the method-as-data (docs/01-arquitectura.md, golden rule 1). This
script is the parse/shape gate: it must stay green in CI (F0-03). It does NOT
encode methodology — only structural invariants that any registry must satisfy.

Checks:
  1. Every .yaml/.yml under registry/ parses as YAML and has a top-level `id`.
  2. Every agent has a matching .md + .yaml pair (role prose + spec).
  3. Every workflow declares `id` and a non-empty `steps` list.
  4. Reports counts per category.

Exit code is non-zero if any check fails. Requires PyYAML.
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: pip install pyyaml")

REGISTRY = Path(__file__).resolve().parent
# Directories carried from v1 (F0-05). `providers/` (F4-02) and a dedicated
# `stacks/` are added by later phases; absence here is expected, not an error.
CATEGORIES = ("agents", "skills", "workflows", "templates")


def load_yaml(path: Path) -> object:
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def check_yaml_parses(errors: list[str]) -> int:
    count = 0
    for path in sorted(REGISTRY.rglob("*.y*ml")):
        rel = path.relative_to(REGISTRY)
        try:
            doc = load_yaml(path)
        except yaml.YAMLError as exc:
            errors.append(f"{rel}: YAML parse error: {exc}")
            continue
        count += 1
        if isinstance(doc, dict) and "id" not in doc:
            errors.append(f"{rel}: missing top-level `id`")
    return count


def check_agent_pairs(errors: list[str]) -> int:
    agents = REGISTRY / "agents"
    if not agents.is_dir():
        errors.append("agents/ directory is missing")
        return 0
    stems_md = {p.stem for p in agents.glob("*.md")}
    stems_yaml = {p.stem for p in agents.glob("*.yaml")}
    for stem in sorted(stems_yaml - stems_md):
        errors.append(f"agents/{stem}.yaml has no matching {stem}.md")
    for stem in sorted(stems_md - stems_yaml):
        errors.append(f"agents/{stem}.md has no matching {stem}.yaml")
    return len(stems_yaml & stems_md)


def check_workflows(errors: list[str]) -> int:
    workflows = REGISTRY / "workflows"
    if not workflows.is_dir():
        errors.append("workflows/ directory is missing")
        return 0
    count = 0
    for path in sorted(workflows.glob("*.yaml")):
        doc = load_yaml(path)
        count += 1
        steps = doc.get("steps") if isinstance(doc, dict) else None
        if not isinstance(steps, list) or not steps:
            errors.append(f"workflows/{path.name}: missing non-empty `steps` list")
    return count


def count_files() -> dict[str, int]:
    counts: dict[str, int] = {}
    for cat in CATEGORIES:
        d = REGISTRY / cat
        counts[cat] = sum(1 for _ in d.rglob("*") if _.is_file()) if d.is_dir() else 0
    return counts


def main() -> int:
    errors: list[str] = []

    yaml_count = check_yaml_parses(errors)
    agent_pairs = check_agent_pairs(errors)
    workflow_count = check_workflows(errors)
    counts = count_files()

    print("registry validation")
    print(f"  yaml documents parsed : {yaml_count}")
    print(f"  agent role pairs      : {agent_pairs}")
    print(f"  workflows             : {workflow_count}")
    print("  files per category    : " + ", ".join(f"{k}={v}" for k, v in counts.items()))

    if errors:
        print(f"\nFAILED ({len(errors)} issue(s)):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print("\nOK — registry parses and shape checks pass.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
