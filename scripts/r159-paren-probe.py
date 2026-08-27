"""R159: does removing a `parenthesized_expression` produce AL that COMPILES?

The census says 763 in-body parens on the corpus, dominated by `(A = B) and (C = D)`:
parent `logical_expression` 626, inner `comparison_expression` 579. Whether that is a
mutation candidate or a refusal depends entirely on whether the reparse compiles, and
AL's precedence (and/or bind TIGHTER than comparison, unlike C) is exactly the kind of
claim this repo requires measuring rather than asserting.
"""
import json
import os
import shutil
import subprocess
import tempfile
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.join(tempfile.gettempdir(), "lethal-r159-parenprobe")
# Symbols come from the fixture that already has them staged, so this probe downloads nothing.
SYMS = os.path.join(REPO, "fixtures", "sandbox-app", ".alpackages")
ALC = os.environ.get("LETHAL_ALC_PATH") or os.path.join(
    os.path.expanduser("~"),
    ".vscode",
    "extensions",
    "ms-dynamics-smb.al-18.0.2668733",
    "bin",
    "alc.exe",
)

CASES = [
    ("orig_and", "exit((A = B) and (C = D));", "CONTROL: the shape as written in the corpus"),
    ("removed_and", "exit(A = B and C = D);", "the mutant: parens removed, 626/786 shape"),
    ("orig_not", "exit(not (A = B));", "CONTROL: `not (X)`, parent unary_expression, 43 sites"),
    ("removed_not", "exit(not A = B);", "the mutant: `not` paren removed"),
    ("orig_if", "if (A > B) then exit(true); exit(false);", "CONTROL: redundant paren, parent if_statement, 67 sites"),
    ("removed_if", "if A > B then exit(true); exit(false);", "the mutant: redundant paren removed"),
    ("orig_mul", "exit(((A + B) * C) = D);", "CONTROL: arithmetic, parent multiplicative_expression, 4 sites"),
    ("removed_mul", "exit((A + B * C) = D);", "the mutant: arithmetic paren removed"),
    # Each comparison keeps its OWN parens: in AL `and`/`or` bind tighter than `>`, so
    # `C > D and A > D` parses as `C > (D and A) > D` and is a type error. Only the OUTER
    # paren is the one under test here.
    ("orig_orand", "exit(((A > B) or (C > D)) and (A > D));", "CONTROL: `or` inside `and`, CANDIDATE shape 1 of 3 (15 sites)"),
    ("removed_orand", "exit((A > B) or (C > D) and (A > D));", "the mutant: boolean regroup, must COMPILE and change meaning"),
    ("orig_notand", "exit(not ((A > B) and (C > D)));", "CONTROL: `and` inside `not`, CANDIDATE shape 2 of 3 (11 sites)"),
    ("removed_notand", "exit(not (A > B) and (C > D));", "the mutant: `not` now binds only the first operand"),
    ("orig_notor", "exit(not ((A > B) or (C > D)));", "CONTROL: `or` inside `not`, CANDIDATE shape 3 of 3 (6 sites)"),
    ("removed_notor", "exit(not (A > B) or (C > D));", "the mutant: `not` now binds only the first operand"),
]


def build(name, body):
    d = os.path.join(ROOT, name)
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(d)
    shutil.copytree(SYMS, os.path.join(d, ".alpackages"))
    with open(os.path.join(d, "app.json"), "w", encoding="utf-8") as f:
        json.dump({
            "id": str(uuid.uuid4()), "name": "P" + name, "publisher": "LethAL",
            "version": "1.0.0.0", "runtime": "13.0",
            "idRanges": [{"from": 51900, "to": 51999}],
        }, f)
    src = (
        'codeunit 51900 "P%s"\n{\n'
        "    procedure Probe(A: Integer; B: Integer; C: Integer; D: Integer): Boolean\n"
        "    begin\n        %s\n    end;\n}\n" % (name, body)
    )
    with open(os.path.join(d, "P.Codeunit.al"), "w", encoding="utf-8") as f:
        f.write(src)
    return d


def compile_dir(d):
    p = subprocess.run(
        [ALC, "/project:" + d, "/packagecachepath:" + os.path.join(d, ".alpackages"),
         "/out:" + os.path.join(d, "p.app")],
        capture_output=True, text=True, timeout=600,
    )
    out = (p.stdout or "") + (p.stderr or "")
    errs = [l.strip() for l in out.splitlines() if ": error " in l]
    return errs


print("case            verdict    detail")
print("-" * 78)
for name, body, why in CASES:
    d = build(name, body)
    errs = compile_dir(d)
    verdict = "COMPILES" if not errs else "REJECTED"
    print("%-15s %-10s %s" % (name, verdict, why))
    for e in errs[:2]:
        msg = e.split(": error ", 1)[-1]
        print("                           %s" % msg[:150])
