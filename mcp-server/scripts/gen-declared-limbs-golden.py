#!/usr/bin/env python3
"""
gen-declared-limbs-golden.py — build the GOLDEN FIXTURE that pins the production
TypeScript declared-limb extractor to the eval's Python derivation.

WHY THIS EXISTS (an earlier decision guard #1)
The 0.756 precision that justifies the branch build was measured with a PYTHON regex
derivation (`evals/branch-meter/hierarchy.py` on branch eval/branch-membership-meter).
The product reimplements that rule in TypeScript. If the two rules differ by one
character, every shipped number describes a rule nobody measured. So the expected limb
sets in this fixture are produced BY THE PYTHON ITSELF — never hand-written, never
copied from the TypeScript — and the checked-in test asserts byte-identical output.

WHAT IT EMITS
  records[]   — the 192 pinned labeled records: {id, type, body, tags}
  named{}     — id -> {tags, body}: the id8s hierarchy.py's OWN patterns extract from each
                record. The test asserts the TypeScript extracts exactly these. This is the
                load-bearing one, and it exists because of a FALSE GREEN found in review:
                the resolver below is reduced using those same Python patterns, so an id8
                the TypeScript names and the Python does not was absent from the injected
                universe, resolved to nothing, and both sides agreed on a wrong answer.
                Measured: deleting the word boundaries from the TypeScript pattern named 39
                extra ids over these 192 records and the guard stayed GREEN. Pinning the
                extraction directly catches all 39; widening the resolver instead caught
                only 1 of them (one sha fragment happened to collide with a real record
                prefix), i.e. it would have passed on a corpus one record different.
  resolver[]  — {id, type} for every node in the pinned node table whose FIRST 8 HEX
                CHARACTERS match an id8 named by any of those records: the resolution
                universe, reduced to what the derivation can consult. The reduction is
                LOSSLESS GIVEN `named`: the TypeScript is asserted to look up exactly the
                id8s in `named`, and for each of those every node sharing that prefix is
                carried, so no collision can be hidden.
  expected{}  — id -> sorted limb uuids, straight out of hierarchy.Hierarchy.limbs().

INPUTS ARE READ-ONLY and live outside this repo (a measurement run is not product code):
  --pinned  reports/threading-eval/E8-branch-meter/run-<stamp>/pinned
  --eval    wt-branch-meter/evals/branch-meter   (hierarchy.py + graph.py)

REGENERATING is a deliberate act: it re-pins the contract. Do it only when the eval's
derivation itself changes, and say so in the commit.

Usage:
  python3 scripts/gen-declared-limbs-golden.py \
      --pinned <pinned-dir> --eval <eval-dir> \
      --out mcp-server/src/tests/fixtures/declaredLimbs.golden.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


# CREDENTIAL REDACTION — applied to every body BEFORE the Python derives the expected limbs,
# so both sides of the parity test see the SAME bytes and the fixture is safe to commit.
#
# WHY IT IS NEEDED: these are real prod record bodies, and at least one of them contains a
# `<NAME>_TOKEN=<literal>` assignment — a secret pasted into a work note. The repo's
# pre-commit gitleaks rule `mandrel-credential-env-assignment` blocks it, correctly. The
# pattern below is that rule's own regex, so what the fixture strips is exactly what the
# gate looks for; the replacement keeps the KEY (which carries no secret) and drops the
# value.
#
# WHY IT DOES NOT WEAKEN THE PARITY TEST: the redaction happens before `Hierarchy` sees the
# body, so `expected` describes the redacted text and the TypeScript is fed the same
# redacted text. Both derivations still run over real prose; only a credential literal is
# gone, and a credential literal is not an id8 reference.
CREDENTIAL_ASSIGNMENT = re.compile(
    r"""(?:^|[\s'"({;&|=])(?:[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY)"""
    r"""|(?:[A-Z][A-Z0-9_]*_)?(?:PASS|PWD|PW))=["']?([^\s"'`$<>{},;)\\]{6,200})"""
)


# `<redacted>` and not a word: the angle brackets are OUTSIDE the rule's value character
# class, so the redacted text cannot itself match the credential pattern. A word-shaped
# placeholder would still trip the same gate.
REDACTION = "<redacted>"


def redact_credentials(body: str) -> str:
    """Replace the VALUE of every credential-shaped assignment; keep everything else."""
    out, last = [], 0
    for m in CREDENTIAL_ASSIGNMENT.finditer(body):
        out.append(body[last:m.start(1)])
        out.append(REDACTION)
        last = m.end(1)
    out.append(body[last:])
    return "".join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pinned", required=True, type=Path)
    ap.add_argument("--eval", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    sys.path.insert(0, str(args.eval))
    from graph import Graph  # type: ignore
    # The patterns come from the eval module itself — never a copy in this file. A copy is
    # a second implementation of the rule, and pinning the TypeScript against a copy would
    # pin it against something that was never measured.
    from hierarchy import Hierarchy, assert_label_free, _ID8, _TAG_REF  # type: ignore

    # The eval's own anti-tautology check, run here too: if hierarchy.py ever grew an
    # import that could reach the ground-truth labels, this fixture would be pinning a
    # laundered rule.
    assert_label_free(str(args.eval / "hierarchy.py"))

    g = Graph.load(args.pinned)
    raw = json.loads((args.pinned / "bodies.json").read_text())
    # Hierarchy must see the SAME (redacted) bodies the TypeScript will be handed.
    bodies = {
        r["id"]: {**r, "body": redact_credentials(r.get("body") or "")} for r in raw
    }
    h = Hierarchy(g, bodies)

    records = []
    named: dict[str, dict[str, list[str]]] = {}
    named_id8s: set[str] = set()
    for r in raw:
        nid = r["id"]
        node = g.nodes.get(nid)
        if node is None:
            raise SystemExit(f"pinned body {nid} has no node row; the pin is inconsistent")
        body = redact_credentials(r.get("body") or "")
        tags = r.get("tags") or []
        records.append({"id": nid, "type": node.type, "body": body, "tags": tags})
        tag_ids = [m.group(2) for m in (_TAG_REF.match(t.strip()) for t in tags) if m]
        body_ids = sorted(set(_ID8.findall(body)))
        named[nid] = {"tags": sorted(tag_ids), "body": body_ids}
        named_id8s |= set(tag_ids) | set(body_ids)

    resolver = [
        {"id": n.id, "type": n.type}
        for n in g.nodes.values()
        if n.id[:8] in named_id8s
    ]
    resolver.sort(key=lambda x: x["id"])

    expected = {r["id"]: sorted(h.limbs(r["id"])) for r in records}

    out = {
        "_source": {
            "pinned": str(args.pinned),
            "eval_derivation": str(args.eval / "hierarchy.py"),
            "generator": "mcp-server/scripts/gen-declared-limbs-golden.py",
        },
        "records": records,
        "named": named,
        "resolver": resolver,
        "expected": expected,
        "stats": {
            "records": len(records),
            "resolver_nodes": len(resolver),
            "distinct_id8s_named": len(named_id8s),
            "id8_mentions_named": sum(len(v["tags"]) + len(v["body"]) for v in named.values()),
            "records_with_limbs": sum(1 for v in expected.values() if v),
            "ambiguous_mentions_dropped": h.ambiguous_mentions,
        },
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=1, sort_keys=False) + "\n")
    print(json.dumps(out["stats"], indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
