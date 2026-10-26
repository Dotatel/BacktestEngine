"""Walk-forward embargo validators.

Definition:
    Verifies that walk-forward windows contain configured embargo gaps.

Inputs example:
    result = validate_embargo(window, 2)

Expected output:
    A dictionary showing whether embargo checks passed.
"""

from __future__ import annotations

from datetime import datetime

from ValidationEngine.WalkForward.WindowBuilder import WalkForwardWindow


def validate_embargo(window: WalkForwardWindow, embargo_days: int) -> dict[str, bool | int]:
    """Validate one walk-forward embargo.

    Definition:
        Checks that train-to-validation and validation-to-test gaps meet the required embargo.

    Inputs example:
        validate_embargo(window, 2)

    Expected output:
        A dictionary with pass/fail booleans.
    """

    train_gap = days_between(window.train_end_utc, window.validation_start_utc)
    validation_gap = days_between(window.validation_end_utc, window.test_start_utc)
    return {
        "required_embargo_days": embargo_days,
        "train_to_validation_gap_days": train_gap,
        "validation_to_test_gap_days": validation_gap,
        "train_to_validation_passed": train_gap >= embargo_days,
        "validation_to_test_passed": validation_gap >= embargo_days,
    }


def days_between(left_utc: str, right_utc: str) -> int:
    """Count days between two UTC timestamps.

    Definition:
        Parses two timestamps and returns whole days from left to right.

    Inputs example:
        days_between("2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z")

    Expected output:
        An integer such as 2.
    """

    return (parse_utc(right_utc) - parse_utc(left_utc)).days


def parse_utc(value: str) -> datetime:
    """Parse a UTC timestamp.

    Definition:
        Converts ISO text into datetime.

    Inputs example:
        parse_utc("2026-01-01T00:00:00Z")

    Expected output:
        A datetime object.
    """

    return datetime.fromisoformat(value.replace("Z", "+00:00"))
