#!/usr/bin/env python3
"""Calibrate native fees on the largest diagnostic volume; validate all others."""
import argparse
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    probe = args.probe.resolve()
    events_path = probe / "capture/events.jsonl"
    report_path = probe / "report.json"
    spec_path = probe / "capture/symbol_spec.json"
    events = [json.loads(line) for line in events_path.read_text().splitlines()]
    fills = [row for row in events if row["event_type"] == "opened"]
    report = json.loads(report_path.read_text())
    spec = json.loads(spec_path.read_text())
    rate = Decimal(str(report["main"]["commissions"]["value"]))
    if rate <= 0 or not fills:
        raise ValueError("A positive native fee rate and filled diagnostic orders are required.")
    if spec["account_asset"] != "USD":
        raise ValueError("This calibration currently requires a USD account.")
    max_volume = max(Decimal(str(fill["volume"])) for fill in fills)
    calibration = [fill for fill in fills if Decimal(str(fill["volume"])) == max_volume]
    quantum = Decimal(1).scaleb(-spec["account_digits"])
    half = quantum / 2
    lows, highs = [], []
    for fill in calibration:
        cost = -Decimal(str(fill["commissions"]))
        divisor = max_volume * rate / Decimal(1000000)
        lows.append((cost - half) / divisor)
        highs.append((cost + half) / divisor)
    low, high = max(lows), min(highs)
    if low >= high:
        raise ValueError("No common conversion interval fits the calibration fills.")
    midpoint = (low + high) / 2
    # cTrader's one-unit asset conversion is itself rounded to destination
    # currency digits. Prefer that quantum only when the calibration fills
    # permit it; this choice does not consult the held-out volumes.
    quantized_rate = midpoint.quantize(quantum, rounding=ROUND_HALF_UP)
    selected_rate = quantized_rate if low <= quantized_rate < high else midpoint
    cases = []
    for fill in fills:
        volume = Decimal(str(fill["volume"]))
        observed = Decimal(str(fill["commissions"]))
        predicted = -(volume * rate * selected_rate / Decimal(1000000)).quantize(quantum, rounding=ROUND_HALF_UP)
        cases.append({"side": fill["side"], "volume": float(volume),
            "observed_entry_commission": float(observed), "predicted_entry_commission": float(predicted),
            "calibration": volume == max_volume, "passed": observed == predicted,
            "entry_time_utc": fill["time_utc"]})
    if not all(case["passed"] for case in cases) or not any(not case["calibration"] for case in cases):
        raise ValueError("Independent volume holdouts did not all pass.")
    result = {
        "schema_version": "native-commission-calibration/v1", "symbol": spec["symbol"],
        "commission_model": "UsdPerMillionUsdVolume", "commission_rate": float(rate),
        "account_currency": "USD", "account_digits": spec["account_digits"],
        "rounding": "nearest account quantum per fill, midpoint away from zero",
        "fixed_base_to_usd_rate": float(selected_rate), "calibration_interval_midpoint": float(midpoint),
        "rate_selection": "Nearest destination-asset quantum inside calibration-only interval, otherwise interval midpoint",
        "interval_lower_inclusive": float(low),
        "interval_upper_exclusive": float(high), "calibration_volume": float(max_volume),
        "requested_native_end_utc": datetime.fromtimestamp(report["main"]["testingPeriod"]["endDate"] / 1000, timezone.utc).isoformat().replace("+00:00", "Z"),
        "source_events_path": str(events_path), "source_events_sha256": hashlib.sha256(events_path.read_bytes()).hexdigest(),
        "source_report_path": str(report_path), "source_report_sha256": hashlib.sha256(report_path.read_bytes()).hexdigest(),
        "source_spec_path": str(spec_path), "source_spec_sha256": hashlib.sha256(spec_path.read_bytes()).hexdigest(),
        "method": "Infer the rounding interval using only the largest controlled volume; select the nearest account-asset-quantum rate if permitted by that interval, otherwise its midpoint; then validate held-out volumes. No strategy outcomes used.",
        "scope": "Empirical native fee authority for this symbol, rate, account currency and requested end date only. Not AssetConverter API output or a universal historical rate.",
        "cases": cases, "all_holdouts_passed": True,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"authority": str(args.output), "rate": float(selected_rate),
        "calibration_fills": len(calibration), "held_out_fills": len(cases) - len(calibration)}))


if __name__ == "__main__":
    main()
