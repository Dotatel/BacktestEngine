#!/usr/bin/env python3
"""Apply the frozen optimizer objective to native ledgers and compare rankings.

The Python score must reproduce each actual optimizer result within 1e-10
before any native ranking is accepted. Native PF is calculated from unrounded
trade-ledger cents, not the UI's two-decimal summary.
"""
import argparse
import hashlib
import json
from pathlib import Path


def clip(value):
    return min(1.0, max(0.0, value))


def score(config, metrics):
    weights = config["weights"]
    net = metrics["marked_to_market_net_profit"]
    dd = metrics["max_equity_drawdown"]
    dd_percent = metrics["max_equity_drawdown_percent"]
    count = metrics["total_trades"]
    minimum = max(1, config["target_trades"])
    maximum = max(minimum, config["max_useful_trades"])
    quality = clip(count / minimum) if count < minimum else (1 if count <= maximum else clip(1 - (count - maximum) / maximum))
    profit_factor = metrics["profit_factor"] or 0
    penalty = 0 if dd_percent <= config["acceptable_drawdown_percent"] else clip(
        (dd_percent - config["acceptable_drawdown_percent"]) /
        (config["bad_drawdown_percent"] - config["acceptable_drawdown_percent"]))
    smoothness = clip(.7 * clip(metrics["recovery_factor"] / 3) + .3 * (1 - clip(metrics["top_trade_profit_share"])))
    return (weights["marked_to_market_net_profit"] * clip(net / max(1, abs(dd) * 5))
            + weights["profit_factor"] * clip((profit_factor - 1) / 2)
            + weights["average_trade"] * clip(metrics["average_economic_result"] / 100)
            + weights["trade_count_quality"] * quality
            + weights["equity_smoothness"] * smoothness
            - weights["drawdown_penalty"] * penalty)


def native_metrics(report):
    if report["positions"]["items"]:
        raise ValueError("Ranking adapter requires no uncompared open positions.")
    trades = report["history"]["items"]
    profits = [trade["net"] for trade in trades]
    positive = sum(value for value in profits if value > 0)
    negative = -sum(value for value in profits if value < 0)
    net = report["main"]["endingEquity"] - report["main"]["startingCapital"]
    dd = report["equity"]["maxEquityDrawdownAbsolute"]
    return {"marked_to_market_net_profit": net, "max_equity_drawdown": dd,
            "max_equity_drawdown_percent": report["equity"]["maxEquityDrawdownPercent"],
            "total_trades": len(trades), "profit_factor": positive / negative if negative else 999,
            "average_economic_result": net / len(trades) if trades else 0,
            "recovery_factor": net / dd if dd else max(0, net),
            "top_trade_profit_share": max(profits, default=0) / positive if positive else 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qualification", required=True, type=Path)
    parser.add_argument("--native", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    config_path = args.qualification / "optimizer_config.json"
    results_path = args.qualification / "results/results.json"
    config = json.loads(config_path.read_text())["scoring"]
    results = json.loads(results_path.read_text())["results"]
    records = []
    provenance = {}
    native_by_parameters = {}
    for case in args.native.glob("candidate_*"):
        identity = json.loads((case / "provenance.json").read_text())
        parameter_path = next(Path(path) for path in identity["input_hashes"] if path.endswith("/candidate.cbotset"))
        if hashlib.sha256(parameter_path.read_bytes()).hexdigest() != identity["input_hashes"][str(parameter_path)]:
            raise ValueError("Native parameter evidence changed: " + str(parameter_path))
        provenance[str(parameter_path.resolve())] = identity["input_hashes"][str(parameter_path)]
        provenance[str((case / "provenance.json").resolve())] = hashlib.sha256((case / "provenance.json").read_bytes()).hexdigest()
        parameter_key = json.dumps(json.loads(parameter_path.read_text()), sort_keys=True)
        if parameter_key in native_by_parameters:
            raise ValueError("Ambiguous duplicate native parameter evidence.")
        native_by_parameters[parameter_key] = case / "report.json"
    for result in results:
        computed = score(config, result["metrics"])
        if abs(computed - result["fitness_score"]) > 1e-10:
            raise ValueError("Score adapter disagrees with actual frozen optimizer: " + result["id"])
        name = Path(result["run_dir"]).name
        parameter_key = json.dumps(json.loads(Path(result["parameter_file_path"]).read_text()), sort_keys=True)
        native_path = native_by_parameters[parameter_key]
        native = native_metrics(json.loads(native_path.read_text()))
        provenance[str(native_path.resolve())] = hashlib.sha256(native_path.read_bytes()).hexdigest()
        records.append({"candidate": name, "parameters": result["parameters"],
                        "optimizer_score": result["fitness_score"], "native_score": score(config, native),
                        "native_metrics": native})
    local_order = [item["candidate"] for item in sorted(records, key=lambda item: -item["optimizer_score"])]
    native_order = [item["candidate"] for item in sorted(records, key=lambda item: -item["native_score"])]
    for path in (config_path, results_path, Path(__file__)):
        provenance[str(path.resolve())] = hashlib.sha256(path.read_bytes()).hexdigest()
    document = {"rankings_identical": local_order == native_order, "optimizer_ranking": local_order,
                "native_ranking": native_order, "candidates": records, "sha256": provenance,
                "score_adapter_validated_against_all_actual_optimizer_outputs": True}
    args.out.write_text(json.dumps(document, indent=2) + "\n")
    print(json.dumps({"rankings_identical": document["rankings_identical"], "ranking": native_order}))


if __name__ == "__main__":
    main()
