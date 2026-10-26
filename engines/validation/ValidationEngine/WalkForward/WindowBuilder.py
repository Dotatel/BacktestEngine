"""Walk-forward window builder.

Definition:
    Creates chronological train, validation, and test windows.

Inputs example:
    packets = build_walk_forward_windows(config.walk_forward)

Expected output:
    A list of WalkForwardWindow objects.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from ValidationEngine.Config import WalkForwardConfig


@dataclass(frozen=True)
class WalkForwardWindow:
    """One walk-forward split.

    Definition:
        Stores train, validation, and test date ranges.

    Inputs example:
        WalkForwardWindow(index=0, train_start_utc="...", train_end_utc="...", ...)

    Expected output:
        Immutable walk-forward split object.
    """

    index: int
    train_start_utc: str
    train_end_utc: str
    validation_start_utc: str
    validation_end_utc: str
    test_start_utc: str
    test_end_utc: str


def build_walk_forward_windows(config: WalkForwardConfig) -> list[WalkForwardWindow]:
    """Build walk-forward windows.

    Definition:
        Creates chronological windows with an embargo gap after train and validation.

    Inputs example:
        build_walk_forward_windows(config)

    Expected output:
        A list of WalkForwardWindow objects.
    """

    start = parse_utc(config.start_utc)
    end = parse_utc(config.end_utc)
    step_days = config.validation_days + config.test_days
    count = max(0, (end - start).days // max(1, step_days))
    return [build_one_window(config, start, index, step_days) for index in range(count)]


def build_one_window(config: WalkForwardConfig, start: datetime, index: int, step_days: int) -> WalkForwardWindow:
    """Build one walk-forward split.

    Definition:
        Creates one train, validation, and test packet at a chronological offset.

    Inputs example:
        build_one_window(config, start, 0, 30)

    Expected output:
        A WalkForwardWindow object.
    """

    train_start = start + timedelta(days=index * step_days)
    train_end = train_start + timedelta(days=config.train_days)
    validation_start = train_end + timedelta(days=config.embargo_days)
    validation_end = validation_start + timedelta(days=config.validation_days)
    test_start = validation_end + timedelta(days=config.embargo_days)
    test_end = test_start + timedelta(days=config.test_days)
    return WalkForwardWindow(
        index=index,
        train_start_utc=format_utc(train_start),
        train_end_utc=format_utc(train_end),
        validation_start_utc=format_utc(validation_start),
        validation_end_utc=format_utc(validation_end),
        test_start_utc=format_utc(test_start),
        test_end_utc=format_utc(test_end),
    )


def parse_utc(value: str) -> datetime:
    """Parse a UTC timestamp.

    Definition:
        Converts ISO text to datetime.

    Inputs example:
        parse_utc("2026-01-01T00:00:00Z")

    Expected output:
        A datetime object.
    """

    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def format_utc(value: datetime) -> str:
    """Format a UTC timestamp.

    Definition:
        Converts datetime to Z-suffixed ISO text.

    Inputs example:
        format_utc(datetime(...))

    Expected output:
        A string timestamp.
    """

    return value.isoformat().replace("+00:00", "Z")
