"""App-owned output transport for the unchanged validation CLI; no statistics are recalculated."""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import runpy
import sys
import tempfile

MAX_BYTES = 64 * 1024 * 1024
MAX_DEPTH = 64
MAX_NODES = 8_000_000
MAX_ANNOTATIONS = 500_007
MARKER = "BACKTESTENGINE_VALIDATION_OUTPUT_SHA256 "


class NonFinite:
    """Distinguish parser-produced literal tokens from ordinary user strings or JSON objects."""

    def __init__(self, token: str):
        """Retain the exact stdlib parse_constant token until its structural path is checked."""
        self.token = token


def unique_object(pairs: list[tuple[str, object]]) -> dict:
    """Reject duplicate members before an overwritten value could conceal an invalid token."""
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Validation output has duplicate JSON members.")
        result[key] = value
    return result


def finite_float(text: str) -> float:
    """Reject numeric exponent overflow, which is distinct from the retained literal Infinity output."""
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("Validation output has an overflowing JSON number.")
    return value


def is_statistic(path: tuple) -> bool:
    """Recognize only exact retained profit-factor fields; array positions must be real list indices."""
    if len(path) == 2:
        return path[0] in {"combined_report", "latency_report", "walk_forward_report"} and path[1] == "profit_factor"
    if len(path) == 4:
        return path[:2] == ("monte_carlo", "distributions") and type(path[2]) is int and path[3] == "pf"
    if len(path) == 5:
        return path[:3] == ("monte_carlo", "concentration", "remove_best") and type(path[3]) is int and path[4] == "pf"
    return False


def pointer(path: tuple) -> str:
    """Encode an exact RFC 6901 pointer without confusing escaped object keys and list positions."""
    return "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in path)


def replace_statistic(value: object, path: tuple, annotations: list) -> object:
    """Normalize only evidenced positive-unbounded tokens; existing nulls never gain annotations."""
    if isinstance(value, NonFinite):
        if value.token != "Infinity" or not is_statistic(path):
            raise ValueError("Validation output has unsupported non-finite statistics at " + pointer(path))
        if len(annotations) >= MAX_ANNOTATIONS:
            raise ValueError("Validation non-finite annotation count exceeds its bound.")
        annotations.append({"pointer": pointer(path), "token": "Infinity", "meaning": "positiveUnbounded", "origin": "retainedProfitFactor"})
        return None
    if is_statistic(path) and value is not None and type(value) not in {int, float}:
        raise ValueError("Validation profit factor has an unsupported type at " + pointer(path))
    return value


def normalize_tree(payload: dict) -> list:
    """Walk a bounded decoded document iteratively, preserving every finite value and verdict."""
    annotations = []
    pending = [(payload, (), 0)]
    nodes = 0
    while pending:
        value, path, depth = pending.pop()
        nodes += 1
        if depth > MAX_DEPTH or nodes > MAX_NODES:
            raise ValueError("Validation output exceeds its structural bound.")
        normalize_children(value, path, depth, pending, annotations)
    return annotations


def normalize_children(value: object, path: tuple, depth: int, pending: list, annotations: list) -> None:
    """Replace only direct scalar children and queue containers without recursive Python stack growth."""
    if not isinstance(value, (dict, list)):
        return
    items = value.items() if isinstance(value, dict) else enumerate(value)
    for key, child in items:
        child_path = path + (key,)
        value[key] = replace_statistic(child, child_path, annotations)
        pending.append((value[key], child_path, depth + 1))


def normalize_bytes(raw: bytes) -> bytes:
    """Produce strict transport JSON from bounded original UTF-8 bytes, retaining their exact digest."""
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("Validation original output is empty or exceeds 64 MiB.")
    payload = json.loads(raw.decode("utf-8"), parse_constant=NonFinite, parse_float=finite_float, object_pairs_hook=unique_object)
    if not isinstance(payload, dict):
        raise ValueError("Validation original output must be a JSON object.")
    annotations = normalize_tree(payload)
    envelope = {"version": 1, "originalSha256": hashlib.sha256(raw).hexdigest(), "payload": payload, "nonFinite": annotations}
    encoded = json.dumps(envelope, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_BYTES:
        raise ValueError("Validation normalized output exceeds 64 MiB.")
    return encoded


def plain_path(path: Path) -> Path:
    """Require a fixed absolute existing path with no links, junctions or redirected ancestors."""
    if not path.is_absolute():
        raise ValueError("Validation output path must be host-owned and absolute.")
    for item in (path, *path.parents):
        if item.is_symlink() or item.is_junction():
            raise ValueError("Validation output path is redirected.")
    if not path.exists():
        raise ValueError("Validation original output is missing.")
    return path


def publish(output: Path) -> str:
    """Write one atomic sidecar beside original files; raw JSON and Markdown are never modified."""
    original = plain_path(output / "FinalVerdict.json")
    if not original.is_file():
        raise ValueError("Validation original output is not a file.")
    with original.open("rb") as handle:
        raw = handle.read(MAX_BYTES + 1)
    encoded = normalize_bytes(raw)
    destination = output / "FinalVerdict.adapter.json"
    if destination.exists() or destination.is_symlink() or destination.is_junction():
        raise ValueError("Validation adapter output already exists.")
    atomic_sidecar(output, destination, encoded)
    return hashlib.sha256(encoded).hexdigest()


def atomic_sidecar(output: Path, destination: Path, encoded: bytes) -> None:
    """Flush a unique sibling before atomic publication, cleaning only that exact temporary file on error."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".validation-output-", dir=output, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        # Windows rename refuses an existing target, including one created after the initial check.
        os.rename(temporary, destination)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main() -> None:
    """Run the unchanged CLI once, then adapt its fixed native output inside the same process boundary."""
    source = sys.argv.pop(1)
    output = Path(sys.argv.pop(1))
    sys.path.insert(0, source)
    runpy.run_module("ValidationEngine.Cli", run_name="__main__")
    print(MARKER + publish(output), flush=True)


if __name__ == "__main__":
    main()
