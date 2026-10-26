"""Random historical window builder.

Definition:
    Builds random date windows for robustness checks without changing strategy parameters.

Inputs example:
    windows = build_random_windows("2023-01-01T00:00:00Z", "2026-01-01T00:00:00Z", 30, 10, 42)

Expected output:
    A list of RandomWindow objects.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
import random


@dataclass(frozen=True)
class RandomWindow:
    """One random validation window.

    Definition:
        Stores a random date range and stable index.

    Inputs example:
        RandomWindow(index=1, start_utc="2026-01-01T00:00:00Z", end_utc="2026-01-31T00:00:00Z")

    Expected output:
        Immutable random window object.
    """

    index: int
    start_utc: str
    end_utc: str


def build_random_windows(
    start_utc: str,
    end_utc: str,
    window_days: int,
    samples: int,
    seed: int,
) -> list[RandomWindow]:
    """Build random windows.

    Definition:
        Samples random fixed-length windows inside a larger date range.

    Inputs example:
        build_random_windows("2026-01-01T00:00:00Z", "2026-07-01T00:00:00Z", 30, 5, 42)

    Expected output:
        A list of RandomWindow objects.
    """

    start = parse_utc(start_utc)
    end = parse_utc(end_utc)
    max_offset = max(0, (end - start).days - window_days)
    rng = random.Random(seed)
    return [build_window(start, window_days, rng.randint(0, max_offset), index) for index in range(samples)]


def build_window(start: datetime, window_days: int, offset_days: int, index: int) -> RandomWindow:
    """Build one random window from offset.

    Definition:
        Converts a sampled day offset into start and end timestamps.

    Inputs example:
        build_window(datetime(...), 30, 10, 1)

    Expected output:
        A RandomWindow object.
    """

    window_start = start + timedelta(days=offset_days)
    window_end = window_start + timedelta(days=window_days)
    return RandomWindow(index=index, start_utc=format_utc(window_start), end_utc=format_utc(window_end))


def parse_utc(value: str) -> datetime:
    """Parse a UTC timestamp.

    Definition:
        Converts ISO text into a datetime object.

    Inputs example:
        parse_utc("2026-01-01T00:00:00Z")

    Expected output:
        A datetime object.
    """

    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def format_utc(value: datetime) -> str:
    """Format a UTC timestamp.

    Definition:
        Converts a datetime into Z-suffixed ISO text.

    Inputs example:
        format_utc(datetime(...))

    Expected output:
        A string such as "2026-01-01T00:00:00Z".
    """

    return value.isoformat().replace("+00:00", "Z")
