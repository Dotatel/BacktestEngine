# ValidationEngine

Validates frozen parameters using replay, cost and latency stress, trade-basket Monte Carlo,
random windows, walk-forward embargoes and final evidence gates.

Set local tick and economic-profile paths in `Configs/XauTickValidation.example.json`.
The example parameters belong to the mechanical `ExampleStrategy`.

```sh
PYTHONPATH=ValidationEngine python3 -m ValidationEngine.Cli --config ValidationEngine/Configs/XauTickValidation.example.json --dry-run
```

Remove `--dry-run` for execution. Outputs go to `runs/validation/<RunName>/`:
`FinalReport.md`, `FinalVerdict.json`, and `CombinedTrades.csv`.
Missing evidence is `UNPROVEN`, not a pass.
