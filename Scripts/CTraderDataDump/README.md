# Native data export

Build with `dotnet build Scripts/CTraderDataDump -p:AlgoPublish=false` and run the
resulting diagnostic in a native cTrader backtest. Configure `OutputDirectory`,
tick/bar capture and limits with the sample `.cbotset` file. Captures include ticks,
bars and symbol metadata; keep broker/account captures external to version control.
Raw metadata must be converted into a validated economic replay contract before use.
