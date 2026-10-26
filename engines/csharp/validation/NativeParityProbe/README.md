# Neutral native parity probe

Build `NativeParityProbe.csproj` with `-p:AlgoPublish=false`, then run the diagnostic
in native cTrader backtests with your own credentials. It captures execution and fee
observations for mechanical orders. `calibrate_commission.py` consumes native captures;
`../TradeParity/build_contract.py` builds explicit replay economics from those authorities.
Keep account captures and raw native logs external to version control.
