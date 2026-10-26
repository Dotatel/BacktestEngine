# Optimizer

Run `dotnet run --project BacktestEngine/src/BacktestEngine.Optimizer -- --help`
for the configuration interface. Select a compiled strategy, runner project, frozen
base parameter file, explicit scenario economics, search dimensions and output directory.
The default strategy is `ExampleStrategy`.

Grid and seeded-random searches export complete candidate `.cbotset` files and reports.
Replay fingerprints cover source inputs and transitive economic authorities before
cache reuse. Failed runs and unknown parameters must be reviewed rather than counted
as passing candidates. Native report drawdown and full replay-path drawdown remain distinct.
