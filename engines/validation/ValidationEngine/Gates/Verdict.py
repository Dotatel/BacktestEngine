"""Validation verdict builder.

Definition:
    Converts evidence and gate checks into PASS, FAIL, or UNPROVEN verdicts.

Inputs example:
    verdict = build_verdict(deterministic, monte_carlo, robustness, missing_evidence)

Expected output:
    A dictionary containing final validation status and reasons.
"""

from __future__ import annotations


def build_verdict(
    deterministic: dict[str, bool],
    monte_carlo: dict[str, bool],
    robustness: dict[str, bool],
    missing_evidence: list[str],
) -> dict[str, str | list[str]]:
    """Build final validation verdict.

    Definition:
        Returns FAIL for failed checks, UNPROVEN for missing evidence, and PASS otherwise.

    Inputs example:
        build_verdict({"net_positive": True}, {"all_methods_survive": True}, {}, [])

    Expected output:
        A dictionary with status and reasons.
    """

    failed = (
        failed_checks(deterministic, "deterministic")
        + failed_checks(monte_carlo, "monte_carlo")
        + failed_checks(robustness, "robustness")
    )
    if failed:
        return {"status": "FAIL", "failed": failed, "unproven": missing_evidence}
    if missing_evidence:
        return {"status": "UNPROVEN", "failed": [], "unproven": missing_evidence}
    return {"status": "PASS", "failed": [], "unproven": []}


def failed_checks(checks: dict[str, bool], prefix: str) -> list[str]:
    """List failed checks.

    Definition:
        Converts false check values into prefixed reason strings.

    Inputs example:
        failed_checks({"net": False}, "deterministic")

    Expected output:
        A list such as ["deterministic.net"].
    """

    return [f"{prefix}.{name}" for name, passed in checks.items() if not passed]
