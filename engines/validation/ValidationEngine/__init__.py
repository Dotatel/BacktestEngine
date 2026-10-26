"""ValidationEngine package for strategy validation workflows.

Definition:
    Exposes modules that run BacktestEngine scenarios, combine reports, run
    trade-ledger Monte Carlo, and produce final validation verdicts.

Inputs example:
    python -m ValidationEngine.Cli --config ValidationEngine/Configs/XauTickValidation.example.json

Expected output:
    A validation run folder containing planned scenarios, reports, Monte Carlo
    summaries, and final verdict artifacts.
"""
