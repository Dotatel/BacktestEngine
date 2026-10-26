"""Synthetic transport tests and actual unchanged Python CLI processing; no C# engine is executed."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / "src-tauri/optimizer-host/ValidationOutput.py"
SPEC = importlib.util.spec_from_file_location("validation_output_adapter", ADAPTER)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


def decode(raw: bytes) -> dict:
    """Require the produced sidecar itself to contain strict JSON, never non-finite literals."""
    def reject(token):
        """Fail a test if the adapter leaked a non-standard JSON literal."""
        raise ValueError(token)
    return json.loads(adapter.normalize_bytes(raw), parse_constant=reject)


class OutputTests(unittest.TestCase):
    """Verify allowed statistics and fail-closed malformed transport using explicit fixtures."""

    def test_all_five_path_families_are_annotated_and_original_null_is_not(self):
        """Only literal positive Infinity gains provenance; no annotation is invented for null."""
        raw = b'{"combined_report":{"profit_factor":Infinity},"latency_report":{"profit_factor":Infinity},"walk_forward_report":{"profit_factor":Infinity},"monte_carlo":{"distributions":[{"pf":Infinity},{"pf":null}],"concentration":{"remove_best":[{"pf":Infinity}]}},"verdict":{"status":"UNPROVEN","unproven":["stress"]}}'
        envelope = decode(raw)
        self.assertEqual(envelope["originalSha256"], hashlib.sha256(raw).hexdigest())
        paths = {row["pointer"] for row in envelope["nonFinite"]}
        self.assertEqual(len(paths), 5)
        self.assertNotIn("/monte_carlo/distributions/1/pf", paths)
        self.assertEqual(envelope["payload"]["verdict"], {"status": "UNPROVEN", "unproven": ["stress"]})
        self.assertTrue(all(row["meaning"] == "positiveUnbounded" for row in envelope["nonFinite"]))

    def test_finite_null_and_quoted_label_values_are_unchanged(self):
        """Retain source values, including original zero/null and ordinary strings containing Infinity."""
        payload = {"combined_report": {"profit_factor": None}, "label": "Infinity NaN </é>", "monte_carlo": {"summary": [{"pf_p05": 0.0}]}, "verdict": {"status": "FAIL"}}
        envelope = decode(json.dumps(payload).encode())
        self.assertEqual(envelope["payload"], payload)
        self.assertEqual(envelope["nonFinite"], [])

    def test_unsupported_literals_paths_and_statistic_types_fail(self):
        """Reject negative/undefined tokens, lookalike object indices and malformed known PF values."""
        invalid = [
            b'{"combined_report":{"profit_factor":NaN}}',
            b'{"combined_report":{"profit_factor":-Infinity}}',
            b'{"combined_report":{"net_profit":Infinity}}',
            b'{"monte_carlo":{"summary":[{"pf_p05":Infinity}]}}',
            b'{"monte_carlo":{"distributions":{"0":{"pf":Infinity}}}}',
            b'{"other":{"profit_factor":Infinity}}',
            b'{"combined_report":{"profit_factor":"Infinity"}}',
            b'{"combined_report":{"profit_factor":true}}',
            b'{"combined_report":{"profit_factor":{}}}',
        ]
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                decode(raw)

    def test_overflow_duplicate_malformed_and_non_object_documents_fail(self):
        """Do not lose overwritten invalid members or reinterpret numeric overflow as a supported token."""
        for raw in [b'{"combined_report":{"profit_factor":1e999}}', b'{"x":NaN,"x":0}', b'{"x":0,"x":1}', b'{broken', b'[]', b'Infinity', b'{"x":"\xff"}']:
            with self.subTest(raw=raw), self.assertRaises((ValueError, UnicodeError)):
                decode(raw)

    def test_depth_node_annotation_and_byte_budgets_fail(self):
        """Exercise all resource caps with small injected limits rather than large allocations."""
        for limit in ["MAX_DEPTH", "MAX_NODES", "MAX_ANNOTATIONS", "MAX_BYTES"]:
            raw = b'{"monte_carlo":{"distributions":[{"pf":Infinity},{"pf":Infinity}]}}'
            with self.subTest(limit=limit), patch.object(adapter, limit, 1), self.assertRaises(ValueError):
                decode(raw)
        with patch.object(adapter, "MAX_BYTES", 5), self.assertRaises(ValueError):
            decode(b'{}')

    def test_atomic_publication_preserves_raw_markdown_and_refuses_existing_sidecar(self):
        """Sidecar publication changes neither original artifact and never overwrites accepted transport."""
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            raw = b'{"combined_report":{"profit_factor":Infinity}}'
            (output / "FinalVerdict.json").write_bytes(raw)
            (output / "FinalReport.md").write_bytes(b"original Markdown\r\n")
            digest = adapter.publish(output)
            self.assertEqual(digest, hashlib.sha256((output / "FinalVerdict.adapter.json").read_bytes()).hexdigest())
            self.assertEqual((output / "FinalVerdict.json").read_bytes(), raw)
            self.assertEqual((output / "FinalReport.md").read_bytes(), b"original Markdown\r\n")
            self.assertEqual(list(output.glob(".validation-output-*")), [])
            with self.assertRaises(ValueError):
                adapter.publish(output)

    def test_original_cli_generates_unbounded_pf_and_wrapper_preserves_original_verdict(self):
        """Actual staged CPython+unchanged CLI reproduce the retained economic-basket Infinity case."""
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            config = original_cli_fixture(directory)
            source = ROOT / "src-tauri/resources/validation"
            self.assertTrue((source / "ValidationEngine/Cli.py").is_file(), "Stage unchanged validation package first.")
            result = subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", "-c", ADAPTER.read_text(), str(source), str(directory / "validation"), "--config", str(config)], cwd=directory, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            raw = (directory / "validation/FinalVerdict.json").read_bytes()
            self.assertIn(b'"pf": Infinity', raw)
            original = json.loads(raw)
            sidecar = (directory / "validation/FinalVerdict.adapter.json").read_bytes()
            envelope = json.loads(sidecar)
            self.assertEqual(len(envelope["nonFinite"]), 23)
            self.assertEqual(envelope["payload"]["verdict"], original["verdict"])
            self.assertEqual(envelope["payload"]["monte_carlo"]["summary"], original["monte_carlo"]["summary"])
            self.assertEqual(result.stdout.decode().splitlines()[-1], adapter.MARKER + hashlib.sha256(sidecar).hexdigest())
            self.assertEqual(envelope["originalSha256"], hashlib.sha256(raw).hexdigest())


def original_cli_fixture(directory: Path) -> Path:
    """Freeze explicit synthetic economic legs that the original algorithm groups into one profitable basket."""
    trades = []
    for index in range(20):
        profit = 100.0 if index % 2 == 0 else -50.0
        trades.append({"symbol": "EURUSD", "side": "Buy", "net_profit": profit, "gross_profit": profit, "pips": profit, "entry_time_utc": "2026-06-01T00:00:00Z", "close_time_utc": f"2026-06-02T{index:02}:00:00Z", "label": f"synthetic-{index}"})
    report = directory / "source-report.json"
    report.write_text(json.dumps({"symbol": "EURUSD", "account": {"starting_capital": 10000}, "trade_statistics": {"net_profit": 500, "gross_profit": 1000, "gross_loss": 500, "profit_factor": 2, "total_trades": 20}, "trades": trades}))
    parameters = directory / "parameters.cbotset"
    parameters.write_text("")
    config = {"RunName": "validation", "Strategy": "Synthetic", "ParameterFile": str(parameters), "OutputRoot": str(directory), "RunBacktests": False, "Backtest": {"Project": str(directory / "disabled.csproj")}, "Symbols": [], "Windows": [], "CostStress": {"SpreadMultipliers": [], "CommissionMultipliers": []}, "LatencyStress": {"LatencyTicks": []}, "WalkForward": {"StartUtc": "2026-06-01T00:00:00Z", "EndUtc": "2026-06-01T00:00:00Z"}, "MonteCarlo": {"Runs": 5, "Seed": 42, "Balance": 10000}, "ExistingReports": [str(report)]}
    path = directory / "validation-config.json"
    path.write_text(json.dumps(config))
    return path


if __name__ == "__main__":
    unittest.main()
