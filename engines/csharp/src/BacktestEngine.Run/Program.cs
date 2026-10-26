using System;
using System.Collections.Generic;
using System.Globalization;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using cAlgo.API;

namespace BacktestEngine.Run
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
            CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;

            RunnerOptions options = RunnerOptions.Parse(args);
            if (!string.IsNullOrWhiteSpace(options.DescribeStrategyName))
                return StrategyMetadata.Print(options.DescribeStrategyName);
            if (options.RunExecutionSmoke)
                return ExecutionSmoke.Run(options.SymbolSpecPath, options.ReportJsonPath);
            if (!string.IsNullOrWhiteSpace(options.ExecutionProbeEventsPath))
            {
                if (!string.IsNullOrWhiteSpace(options.ExecutionProbeTicksPath))
                {
                    return ExecutionSmoke.RunProbeTicks(
                        options.ExecutionProbeEventsPath,
                        options.ExecutionProbeTicksPath,
                        options.ReportJsonPath,
                        options.SymbolSpecPath,
                        options.CommissionUsdPerMillion,
                        options.ExecutionSlippagePips);
                }

                return ExecutionSmoke.RunProbeEvents(
                    options.ExecutionProbeEventsPath,
                    options.ReportJsonPath,
                    options.SymbolSpecPath,
                    options.CommissionUsdPerMillion,
                    options.ExecutionSlippagePips);
            }

            StrategyDefinition strategy = StrategyRegistry.Resolve(options.StrategyName);
            Robot bot = strategy.Create();
            ConfigureDefaultEnvironment(bot, options.StartingBalance, strategy.DefaultSymbol);

            BotParameterLoadResult parameterResult = null;
            if (!string.IsNullOrWhiteSpace(options.ParameterPath))
            {
                parameterResult = BotParameterLoader.Apply(bot, options.ParameterPath);
                parameterResult = BotParameterLoader.ApplyOverrides(bot, parameterResult, options.ParameterOverrides);
                if (!string.IsNullOrWhiteSpace(parameterResult.ChartSymbol))
                    ConfigureSymbol(bot, parameterResult.ChartSymbol);
                if (parameterResult.ChartTimeFrame != null)
                    bot.TimeFrame = parameterResult.ChartTimeFrame;

                Console.WriteLine(
                    "BACKTESTENGINE_PARAMETER_LOAD strategy={0} source={1} defaults={2} overrides={3} unknown={4} symbol={5} period={6}",
                    strategy.Name,
                    parameterResult.SourcePath,
                    parameterResult.DefaultCount,
                    parameterResult.OverrideCount,
                    parameterResult.UnknownParameters.Count,
                    bot.SymbolName,
                    bot.TimeFrame);

                foreach (string unknown in parameterResult.UnknownParameters)
                    Console.WriteLine("BACKTESTENGINE_PARAMETER_UNKNOWN name={0}", unknown);
            }
            else if (options.ParameterOverrides.Count > 0)
            {
                parameterResult = BotParameterLoader.ApplyOverrides(bot, new BotParameterLoadResult(), options.ParameterOverrides);
                Console.WriteLine(
                    "BACKTESTENGINE_PARAMETER_LOAD strategy={0} source={1} defaults={2} overrides={3} unknown={4} symbol={5} period={6}",
                    strategy.Name,
                    parameterResult.SourcePath,
                    parameterResult.DefaultCount,
                    parameterResult.OverrideCount,
                    parameterResult.UnknownParameters.Count,
                    bot.SymbolName,
                    bot.TimeFrame);

                foreach (string unknown in parameterResult.UnknownParameters)
                    Console.WriteLine("BACKTESTENGINE_PARAMETER_UNKNOWN name={0}", unknown);
            }

            string parameterSymbol = parameterResult?.ChartSymbol ?? "";
            if (!string.IsNullOrWhiteSpace(parameterSymbol)
                && !string.IsNullOrWhiteSpace(options.Symbol)
                && !string.Equals(parameterSymbol, options.Symbol, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("Parameter symbol '" + parameterSymbol
                    + "' conflicts with requested --symbol '" + options.Symbol + "'.");
            }
            string requestedSymbol = !string.IsNullOrWhiteSpace(options.Symbol)
                ? options.Symbol
                : !string.IsNullOrWhiteSpace(parameterSymbol)
                    ? parameterSymbol
                    : bot.SymbolName;
            EffectiveSymbolSpecification effectiveSpec = EffectiveSymbolSpecificationLoader.Load(
                options.SymbolSpecPath,
                requestedSymbol);
            if (options.CommissionUsdPerMillion >= 0.0)
            {
                effectiveSpec = effectiveSpec.WithCommissionRateOverride(
                    options.CommissionUsdPerMillion,
                    "cli_commission_usd_per_million=" + options.CommissionUsdPerMillion.ToString("R", CultureInfo.InvariantCulture));
            }
            if (effectiveSpec.NativeCommissionEndUtc.HasValue
                && (!options.EndUtc.HasValue || options.EndUtc.Value != effectiveSpec.NativeCommissionEndUtc.Value.Date.AddDays(1)))
                throw new InvalidDataException("The native commission calibration is bound to its test end date; supply the matching exclusive --end-utc or capture a new calibration.");
            bot.RequestedSymbolName = requestedSymbol;
            bot.SymbolSpecificationPath = Path.GetFullPath(options.SymbolSpecPath);
            bot.Symbol.ApplyEffectiveSpecification(effectiveSpec);
            bot.SymbolName = effectiveSpec.Symbol;
            bot.Account.DepositAssetName = effectiveSpec.AccountCurrency;
            bot.Account.DepositAssetDigits = effectiveSpec.AccountCurrencyDigits;
            bot.CommissionUsdPerMillion = effectiveSpec.CommissionRate;
            bot.ExecutionSlippagePips = options.ExecutionSlippagePips;

            if (options.TimeFrame != null)
                bot.TimeFrame = options.TimeFrame;
            if (parameterResult?.ChartTimeFrame == null && options.TimeFrame == null && options.BarTimeFrame != null)
                bot.TimeFrame = options.BarTimeFrame;
            bot.Account.StartingBalance = options.StartingBalance;
            bot.Account.Balance = options.StartingBalance;
            bot.Account.Equity = options.StartingBalance;
            if (options.SpreadPips >= 0.0)
                bot.Symbol.Ask = bot.Symbol.Bid + options.SpreadPips * bot.Symbol.PipSize;

            if (options.TickPaths.Count > 0 && !string.IsNullOrWhiteSpace(options.BarPath))
                throw new ArgumentException("Use either --ticks or --bars, not both.");
            if (!string.IsNullOrWhiteSpace(options.BarPath)
                && (double.IsFinite(options.StopEquityAtOrAbove) || double.IsFinite(options.StopEquityAtOrBelow)))
                throw new ArgumentException("Equity first-passage barriers currently require tick replay.");
            if (options.SyntheticEnabled && !string.IsNullOrWhiteSpace(options.BarPath))
                throw new ArgumentException("Synthetic continuation requires tick replay, not --bars.");
            if (options.SyntheticTickCount < 0 || options.SyntheticCalibrationTicks < 100 || options.LivePublishEveryTicks <= 0)
                throw new ArgumentException("Synthetic tick limits must be non-negative and calibration must retain at least 100 ticks.");

            SyntheticCalibrationAccumulator syntheticCalibration = new SyntheticCalibrationAccumulator(options.SyntheticCalibrationTicks);
            SyntheticMarketModel syntheticModel = null;
            SyntheticScenario syntheticScenario = null;
            SyntheticTickSource syntheticSource = null;
            MarketTick prefetchedSyntheticTick = default;
            bool hasPrefetchedSyntheticTick = false;
            IEnumerator<IReadOnlyList<MarketTick>> historicalTickBatches = TickCsvDataSource.ReadBatches(
                options.TickPaths,
                options.TickChunkSize,
                options.MaxTicks,
                options.StartUtc,
                options.EndUtc).GetEnumerator();
            IReadOnlyList<MarketTick> firstTickChunk = Array.Empty<MarketTick>();
            while (historicalTickBatches.MoveNext())
            {
                IReadOnlyList<MarketTick> loaded = historicalTickBatches.Current;
                if (loaded.Count == 0)
                    continue;
                firstTickChunk = ApplyTickCostOverrides(loaded, options, bot);
                break;
            }
            IReadOnlyList<MarketBar> bars = BarCsvDataSource.Load(options.BarPath, options.MaxBars, options.StartUtc, options.EndUtc);
            IReadOnlyList<MarketBar> warmupBars = BarCsvDataSource.Load(options.WarmupBarPath, 0);
            if (warmupBars.Count > 0)
            {
                TimeFrame warmupTimeFrame = options.BarTimeFrame ?? bot.TimeFrame;
                BarReplay.Preload(bot, warmupBars, warmupTimeFrame);
                Console.WriteLine(
                    "BACKTESTENGINE_WARMUP_BARS bars={0} chartBars={1} hourBars={2} firstBar={3:o} lastBar={4:o} period={5}",
                    warmupBars.Count,
                    bot.Bars.Count,
                    bot.MarketData.GetBars(TimeFrame.Hour).Count,
                    warmupBars[0].OpenTimeUtc,
                    warmupBars[warmupBars.Count - 1].OpenTimeUtc,
                    warmupTimeFrame);
            }
            if (firstTickChunk.Count > 0)
            {
                MarketReplay.ApplyTick(bot, firstTickChunk[0]);
                MarketReplay.ApplyExecutionTick(bot, firstTickChunk[0]);
            }
            else if (bars.Count > 0)
                MarketReplay.ApplyBarOpen(bot, bars[0]);
            else if (options.SyntheticEnabled)
            {
                syntheticModel = SyntheticMarketModel.Load(options.SyntheticModelPath, bot);
                syntheticScenario = SyntheticScenario.Load(options.SyntheticScenarioPath);
                DateTime startTime = options.StartUtc ?? bot.Server.Time;
                MarketTick initialTick = CreateInitialSyntheticTick(syntheticModel, bot, startTime);
                syntheticSource = CreateSyntheticSource(syntheticModel, syntheticScenario, initialTick, options);
                if (!syntheticSource.TryGetNext(out prefetchedSyntheticTick))
                    throw new InvalidOperationException("Synthetic source produced no ticks for the requested horizon.");
                prefetchedSyntheticTick = ApplySyntheticTickCostOverrides(prefetchedSyntheticTick, options, bot);
                hasPrefetchedSyntheticTick = true;
                MarketReplay.ApplyTick(bot, prefetchedSyntheticTick);
                MarketReplay.ApplyExecutionTick(bot, prefetchedSyntheticTick);
            }

            MarketTick? startupQuote = null;
            if (!string.IsNullOrWhiteSpace(options.StartupQuotePath))
            {
                using var startupDocument = System.Text.Json.JsonDocument.Parse(File.ReadAllText(options.StartupQuotePath));
                var startup = startupDocument.RootElement;
                if (!string.Equals(startup.GetProperty("symbol").GetString(), bot.SymbolName, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Startup quote symbol does not match the requested symbol.");
                DateTime quoteTime = DateTime.Parse(startup.GetProperty("captured_at_utc").GetString(), CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
                double bid = startup.GetProperty("bid").GetDouble(), ask = startup.GetProperty("ask").GetDouble();
                if (quoteTime > bot.Server.Time || !double.IsFinite(bid) || !double.IsFinite(ask) || bid <= 0 || ask < bid)
                    throw new InvalidDataException("Startup quote must be valid and no later than the first replay event.");
                startupQuote = new MarketTick(quoteTime, bid, ask);
            }

            if (options.WarmupSeries.Count > 0)
            {
                if (firstTickChunk.Count == 0 && bars.Count == 0 && !hasPrefetchedSyntheticTick)
                    throw new InvalidOperationException("Independent warmup series require a first replay event to verify their historical boundary.");
                var histories = options.WarmupSeries.ToDictionary(
                    pair => pair.Key,
                    pair => BarCsvDataSource.Load(pair.Value, 0));
                BarReplay.PreloadSeries(bot, histories, startupQuote?.TimeUtc ?? bot.Server.Time);
                foreach (KeyValuePair<TimeFrame, IReadOnlyList<MarketBar>> series in histories)
                    Console.WriteLine("BACKTESTENGINE_WARMUP_SERIES period={0} bars={1} path={2}",
                        series.Key, series.Value.Count, Path.GetFullPath(options.WarmupSeries[series.Key]));
            }

            ReplaySummary replaySummary = new ReplaySummary(!options.SkipEquityCsv, options.MetricsStartUtc);
            string replayMode = "none";
            int replayInputCount = 0;

            if (startupQuote.HasValue)
            {
                MarketReplay.PrepareStart(bot, startupQuote.Value);
                Console.WriteLine("BACKTESTENGINE_STARTUP_QUOTE time={0:o} bid={1:R} ask={2:R}",
                    startupQuote.Value.TimeUtc, startupQuote.Value.Bid, startupQuote.Value.Ask);
            }
            else if (firstTickChunk.Count > 0 || bars.Count > 0 || hasPrefetchedSyntheticTick)
                MarketReplay.PrepareStart(bot, new MarketTick(bot.Server.Time, bot.Symbol.Bid, bot.Symbol.Ask));
            using var nativeDrawdown = new NativeReportDrawdown(bot);
            bot.EngineOnStart();
            if (firstTickChunk.Count > 0 || options.SyntheticEnabled)
            {
                Stopwatch stopwatch = Stopwatch.StartNew();
                int loadedTickCount = 0;
                long generatedTickCount = 0;
                MarketReplaySession session = new MarketReplaySession(
                    bot,
                    options.ExecutionLatencyTicks,
                    replaySummary,
                    options.StopEquityAtOrAbove,
                    options.StopEquityAtOrBelow,
                    options.ProtectionFillMode);
                bool usePrefetchedHistoricalChunk = firstTickChunk.Count > 0;
                while (!session.IsTerminated && (usePrefetchedHistoricalChunk || historicalTickBatches.MoveNext()))
                {
                    IReadOnlyList<MarketTick> chunk = usePrefetchedHistoricalChunk
                        ? firstTickChunk
                        : ApplyTickCostOverrides(historicalTickBatches.Current, options, bot);
                    usePrefetchedHistoricalChunk = false;
                    if (chunk.Count == 0)
                        continue;
                    if (replaySummary.LastTickTimeUtc != DateTime.MinValue
                        && chunk[0].TimeUtc <= replaySummary.LastTickTimeUtc)
                    {
                        int originalCount = chunk.Count;
                        chunk = chunk.Where(tick => tick.TimeUtc > replaySummary.LastTickTimeUtc).ToArray();
                        int skipped = originalCount - chunk.Count;
                        if (skipped > 0)
                        {
                            Console.WriteLine(
                                "BACKTESTENGINE_TICK_OVERLAP_SKIPPED path={0} skipped={1} lastProcessed={2:o}",
                                "streamed_tick_batch",
                                skipped,
                                replaySummary.LastTickTimeUtc);
                        }
                        if (chunk.Count == 0)
                            continue;
                    }

                    syntheticCalibration.Add(chunk);
                    int ticksBeforeChunk = replaySummary.TickCount;
                    session.Process(chunk);
                    loadedTickCount += replaySummary.TickCount - ticksBeforeChunk;
                }

                DateTime syntheticBoundary = replaySummary.LastTickTimeUtc;
                if (options.SyntheticEnabled && !session.IsTerminated)
                {
                    if (syntheticModel == null)
                    {
                        syntheticModel = string.IsNullOrWhiteSpace(options.SyntheticModelPath)
                            ? syntheticCalibration.Build(bot)
                            : SyntheticMarketModel.Load(options.SyntheticModelPath, bot);
                        syntheticScenario = SyntheticScenario.Load(options.SyntheticScenarioPath);
                        MarketTick initialTick = new MarketTick(
                            replaySummary.LastTickTimeUtc,
                            bot.Symbol.Bid,
                            bot.Symbol.Ask);
                        syntheticSource = CreateSyntheticSource(syntheticModel, syntheticScenario, initialTick, options);
                    }

                    syntheticModel.Save(options.SyntheticModelOutputPath);
                    ReplayPacer pacer = new ReplayPacer(options.SimulationSpeed);
                    using SyntheticTickRecorder recorder = new SyntheticTickRecorder(options.SyntheticRecordPath);
                    using LiveSimulationPublisher livePublisher = new LiveSimulationPublisher(
                        options.LiveEventsPath,
                        options.LivePublishEveryTicks);
                    MarketTick lastLiveTick = new MarketTick(
                        replaySummary.LastTickTimeUtc,
                        bot.Symbol.Bid,
                        bot.Symbol.Ask);
                    if (hasPrefetchedSyntheticTick)
                    {
                        pacer.Wait(prefetchedSyntheticTick.TimeUtc);
                        recorder.Write(prefetchedSyntheticTick);
                        session.Process(prefetchedSyntheticTick);
                        generatedTickCount++;
                        lastLiveTick = prefetchedSyntheticTick;
                        livePublisher.Publish(
                            bot, lastLiveTick, replaySummary, loadedTickCount,
                            generatedTickCount, syntheticSource.Regime);
                    }
                    while (!session.IsTerminated && syntheticSource.TryGetNext(out MarketTick generatedTick))
                    {
                        generatedTick = ApplySyntheticTickCostOverrides(generatedTick, options, bot);
                        pacer.Wait(generatedTick.TimeUtc);
                        recorder.Write(generatedTick);
                        session.Process(generatedTick);
                        generatedTickCount++;
                        lastLiveTick = generatedTick;
                        livePublisher.Publish(
                            bot, lastLiveTick, replaySummary, loadedTickCount,
                            generatedTickCount, syntheticSource.Regime);
                    }
                    livePublisher.Publish(
                        bot, lastLiveTick, replaySummary, loadedTickCount,
                        generatedTickCount, syntheticSource.Regime,
                        force: true, status: "completed");

                    replaySummary.Synthetic = new SyntheticReplayMetadata
                    {
                        ModelName = syntheticModel.Name,
                        ModelPath = options.SyntheticModelPath,
                        ModelSha256 = HashFile(options.SyntheticModelPath),
                        ScenarioName = syntheticScenario.Name,
                        ScenarioPath = options.SyntheticScenarioPath,
                        ScenarioSha256 = HashFile(options.SyntheticScenarioPath),
                        Seed = options.SyntheticSeed,
                        BoundaryTimeUtc = syntheticBoundary == DateTime.MinValue
                            ? (options.StartUtc ?? prefetchedSyntheticTick.TimeUtc)
                            : syntheticBoundary,
                        HistoricalTicks = loadedTickCount,
                        GeneratedTicks = generatedTickCount,
                        JumpCount = syntheticSource.JumpCount,
                        RegimeCounts = syntheticSource.RegimeCounts.ToArray(),
                        RecordedTicksPath = string.IsNullOrWhiteSpace(options.SyntheticRecordPath)
                            ? ""
                            : Path.GetFullPath(options.SyntheticRecordPath)
                    };
                }
                stopwatch.Stop();
                replaySummary.ReplayElapsedMilliseconds = stopwatch.Elapsed.TotalMilliseconds;
                replayMode = options.SyntheticEnabled
                    ? (loadedTickCount > 0 ? "ticks+synthetic" : "synthetic")
                    : "ticks";
                replayInputCount = (int)Math.Min(int.MaxValue, (long)loadedTickCount + generatedTickCount);
                Console.WriteLine(
                    "BACKTESTENGINE_REPLAY mode={0} ticks={1} historicalTicks={2} syntheticTicks={3} onBar={4} chartBars={5} hourBars={6} firstTick={7:o} lastTick={8:o}",
                    replayMode,
                    replaySummary.TickCount,
                    loadedTickCount,
                    generatedTickCount,
                    replaySummary.OnBarCount,
                    replaySummary.ChartBarCount,
                    replaySummary.HourBarCount,
                    replaySummary.FirstTickTimeUtc,
                    replaySummary.LastTickTimeUtc);
            }
            else if (bars.Count > 0)
            {
                TimeFrame barTimeFrame = options.BarTimeFrame ?? bot.TimeFrame;
                Stopwatch stopwatch = Stopwatch.StartNew();
                replaySummary = BarReplay.Run(bot, bars, barTimeFrame, options.BarPriceMode);
                stopwatch.Stop();
                replaySummary.ReplayElapsedMilliseconds = stopwatch.Elapsed.TotalMilliseconds;
                replayMode = "bars";
                replayInputCount = bars.Count;
                Console.WriteLine(
                    "BACKTESTENGINE_BAR_REPLAY bars={0} onBar={1} chartBars={2} hourBars={3} firstBar={4:o} lastBar={5:o} period={6}",
                    bars.Count,
                    replaySummary.OnBarCount,
                    replaySummary.ChartBarCount,
                    replaySummary.HourBarCount,
                    replaySummary.FirstTickTimeUtc,
                    replaySummary.LastTickTimeUtc,
                    barTimeFrame);
            }

            bot.EngineOnStop();
            nativeDrawdown.Complete();
            // Native report statistics cover the whole replay. Explicit metric
            // sub-windows retain their independently bounded full-path statistics.
            replaySummary.NativeDrawdown = options.MetricsStartUtc.HasValue ? null : nativeDrawdown;
            ReportWriter.WriteJson(
                options.ReportJsonPath,
                bot,
                strategy.Name,
                replayMode,
                replayInputCount,
                replaySummary,
                parameterResult?.SourcePath ?? "",
                parameterResult?.DefaultCount ?? 0,
                parameterResult?.OverrideCount ?? 0,
                parameterResult?.UnknownParameters ?? Array.Empty<string>(),
                !options.SkipEquityCsv,
                replayMode == "bars" ? options.BarPriceMode switch
                {
                    SourceBarPriceMode.NativeM1 => "native-m1",
                    SourceBarPriceMode.OpenOnly => "open",
                    _ => "ohlc"
                } : null);
            historicalTickBatches.Dispose();
            return 0;
        }

        private static void ConfigureDefaultEnvironment(Robot bot, double startingBalance, string defaultSymbol)
        {
            bot.Server.Time = new DateTime(2026, 6, 25, 0, 0, 0, DateTimeKind.Utc);
            bot.Account.StartingBalance = startingBalance;
            bot.Account.Balance = startingBalance;
            bot.Account.Equity = startingBalance;
            bot.Symbol.Name = defaultSymbol;
            bot.SymbolName = defaultSymbol;
            bot.Symbol.Bid = 0.0;
            bot.Symbol.Ask = 0.0;
        }

        private static void ConfigureSymbol(Robot bot, string symbolName)
        {
            bot.SymbolName = symbolName;
            bot.Symbol.Name = symbolName;
        }

        private static MarketTick CreateInitialSyntheticTick(SyntheticMarketModel model, Robot bot, DateTime startUtc)
        {
            double price = Math.Max(model.TickSize, model.InitialPrice > 0.0 ? model.InitialPrice : bot.Symbol.Bid);
            double spread = Math.Max(model.TickSize, model.BaseSpreadPips * model.PipSize);
            double bid = Math.Max(model.TickSize, Math.Round((price - spread * 0.5) / model.TickSize) * model.TickSize);
            double ask = Math.Max(bid + model.TickSize, Math.Round((price + spread * 0.5) / model.TickSize) * model.TickSize);
            return new MarketTick(DateTime.SpecifyKind(startUtc, DateTimeKind.Utc), bid, ask);
        }

        private static SyntheticTickSource CreateSyntheticSource(
            SyntheticMarketModel model,
            SyntheticScenario scenario,
            MarketTick initialTick,
            RunnerOptions options)
        {
            DateTime endUtc = options.SyntheticDuration > TimeSpan.Zero
                ? initialTick.TimeUtc.Add(options.SyntheticDuration)
                : DateTime.MaxValue;
            return new SyntheticTickSource(
                model,
                scenario,
                initialTick,
                endUtc,
                options.SyntheticTickCount,
                options.SyntheticSeed);
        }

        private static MarketTick ApplySyntheticTickCostOverrides(MarketTick tick, RunnerOptions options, Robot bot)
        {
            if (options.SpreadPips >= 0.0)
                return new MarketTick(tick.TimeUtc, tick.Bid, tick.Bid + options.SpreadPips * bot.Symbol.PipSize);
            if (Math.Abs(options.SpreadMultiplier - 1.0) < 0.000000001)
                return tick;
            double spread = Math.Max(0.0, tick.Ask - tick.Bid) * options.SpreadMultiplier;
            return new MarketTick(tick.TimeUtc, tick.Bid, tick.Bid + spread);
        }

        private static string HashFile(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                return "";
            using SHA256 sha256 = SHA256.Create();
            using FileStream stream = File.OpenRead(path);
            return Convert.ToHexString(sha256.ComputeHash(stream)).ToLowerInvariant();
        }

        private static IReadOnlyList<MarketTick> ApplyTickCostOverrides(
            IReadOnlyList<MarketTick> ticks,
            RunnerOptions options,
            Robot bot)
        {
            if (ticks == null || ticks.Count == 0)
                return Array.Empty<MarketTick>();
            if (options.SpreadPips >= 0.0)
                return TickCsvDataSource.WithFixedSpread(ticks, options.SpreadPips, bot.Symbol.PipSize);
            return TickCsvDataSource.WithSpreadMultiplier(ticks, options.SpreadMultiplier);
        }
    }

    internal sealed class RunnerOptions
    {
        public string ParameterPath { get; set; } = "";
        public List<string> TickPaths { get; } = new List<string>();
        public string BarPath { get; set; } = "";
        public string WarmupBarPath { get; set; } = "";
        public string StartupQuotePath { get; set; } = "";
        public Dictionary<TimeFrame, string> WarmupSeries { get; } = new Dictionary<TimeFrame, string>();
        public string SymbolSpecPath { get; set; } = "";
        public string Symbol { get; set; } = "";
        public string StrategyName { get; set; } = "";
        public Dictionary<string, string> ParameterOverrides { get; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public TimeFrame TimeFrame { get; set; }
        public TimeFrame BarTimeFrame { get; set; }
        public int MaxTicks { get; set; }
        public int TickChunkSize { get; set; } = 250000;
        public int MaxBars { get; set; }
        public DateTime? StartUtc { get; set; }
        public DateTime? EndUtc { get; set; }
        public double StartingBalance { get; set; } = 10000.0;
        public double SpreadPips { get; set; } = -1.0;
        public double SpreadMultiplier { get; set; } = 1.0;
        public int ExecutionLatencyTicks { get; set; }
        public double CommissionUsdPerMillion { get; set; } = -1.0;
        public double ExecutionSlippagePips { get; set; }
        public double StopEquityAtOrAbove { get; set; } = double.PositiveInfinity;
        public double StopEquityAtOrBelow { get; set; } = double.NegativeInfinity;
        public ProtectionFillMode ProtectionFillMode { get; set; } = ProtectionFillMode.CurrentPrice;
        public SourceBarPriceMode BarPriceMode { get; set; } = SourceBarPriceMode.OhlcSyntheticTicks;
        public bool RunExecutionSmoke { get; set; }
        public bool SkipEquityCsv { get; set; }
        public DateTime? MetricsStartUtc { get; set; }
        public string ExecutionProbeEventsPath { get; set; } = "";
        public string ExecutionProbeTicksPath { get; set; } = "";
        public string ReportJsonPath { get; set; } = "";
        public string DescribeStrategyName { get; set; } = "";
        public bool SyntheticEnabled { get; set; }
        public string SyntheticModelPath { get; set; } = "";
        public string SyntheticModelOutputPath { get; set; } = "";
        public string SyntheticScenarioPath { get; set; } = "";
        public string SyntheticRecordPath { get; set; } = "";
        public TimeSpan SyntheticDuration { get; set; } = TimeSpan.FromDays(1.0);
        public long SyntheticTickCount { get; set; }
        public int SyntheticSeed { get; set; } = 1;
        public int SyntheticCalibrationTicks { get; set; } = 500000;
        public string SimulationSpeed { get; set; } = "max";
        public string LiveEventsPath { get; set; } = "";
        public int LivePublishEveryTicks { get; set; } = 500;

        public static RunnerOptions Parse(string[] args)
        {
            RunnerOptions options = new RunnerOptions();
            int symbolSpecCount = 0;
            Queue<string> tokens = new Queue<string>(args ?? Array.Empty<string>());

            while (tokens.Count > 0)
            {
                string token = tokens.Dequeue();
                switch (token)
                {
                    case "--params":
                    case "--parameter-file":
                    case "-p":
                        options.ParameterPath = RequireValue(token, tokens);
                        break;
                    case "--symbol":
                        options.Symbol = RequireValue(token, tokens);
                        break;
                    case "--strategy":
                        options.StrategyName = RequireValue(token, tokens);
                        break;
                    case "--describe-strategy":
                        options.DescribeStrategyName = RequireValue(token, tokens);
                        break;
                    case "--param":
                    case "--parameter":
                        AddParameterOverride(options, RequireValue(token, tokens));
                        break;
                    case "--ticks":
                    case "--tick-csv":
                        options.TickPaths.Add(RequireValue(token, tokens));
                        break;
                    case "--bars":
                    case "--bar-csv":
                        options.BarPath = RequireValue(token, tokens);
                        break;
                    case "--warmup-bars":
                    case "--warmup-bar-csv":
                        options.WarmupBarPath = RequireValue(token, tokens);
                        break;
                    case "--startup-quote":
                        options.StartupQuotePath = RequireValue(token, tokens);
                        break;
                    case "--warmup-series":
                        AddWarmupSeries(options, RequireValue(token, tokens));
                        break;
                    case "--bar-period":
                    case "--bar-timeframe":
                        options.BarTimeFrame = BotParameterLoader.ParseTimeFrame(RequireValue(token, tokens));
                        break;
                    case "--bar-price-mode":
                        options.BarPriceMode = ParseBarPriceMode(RequireValue(token, tokens));
                        break;
                    case "--symbol-spec":
                        symbolSpecCount++;
                        if (symbolSpecCount > 1)
                            throw new ArgumentException("Exactly one --symbol-spec argument is permitted per run.");
                        options.SymbolSpecPath = RequireValue(token, tokens);
                        break;
                    case "--max-ticks":
                        options.MaxTicks = int.Parse(RequireValue(token, tokens), System.Globalization.CultureInfo.InvariantCulture);
                        break;
                    case "--tick-chunk-size":
                        options.TickChunkSize = int.Parse(RequireValue(token, tokens), System.Globalization.CultureInfo.InvariantCulture);
                        if (options.TickChunkSize <= 0)
                            throw new ArgumentOutOfRangeException(nameof(options.TickChunkSize));
                        break;
                    case "--max-bars":
                        options.MaxBars = int.Parse(RequireValue(token, tokens), System.Globalization.CultureInfo.InvariantCulture);
                        break;
                    case "--start-utc":
                        options.StartUtc = ParseUtc(RequireValue(token, tokens));
                        break;
                    case "--end-utc":
                        options.EndUtc = ParseUtc(RequireValue(token, tokens));
                        break;
                    case "--commission-usd-per-million":
                        options.CommissionUsdPerMillion = double.Parse(RequireValue(token, tokens), System.Globalization.CultureInfo.InvariantCulture);
                        break;
                    case "--balance":
                    case "--starting-balance":
                        options.StartingBalance = double.Parse(RequireValue(token, tokens), System.Globalization.CultureInfo.InvariantCulture);
                        break;
                    case "--spread":
                    case "--spread-pips":
                        options.SpreadPips = double.Parse(RequireValue(token, tokens), System.Globalization.CultureInfo.InvariantCulture);
                        break;
                    case "--spread-multiplier":
                        options.SpreadMultiplier = double.Parse(RequireValue(token, tokens), System.Globalization.CultureInfo.InvariantCulture);
                        break;
                    case "--execution-latency-ticks":
                        options.ExecutionLatencyTicks = int.Parse(RequireValue(token, tokens), System.Globalization.CultureInfo.InvariantCulture);
                        break;
                    case "--slippage-pips":
                        options.ExecutionSlippagePips = double.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                        if (options.ExecutionSlippagePips < 0.0 || double.IsNaN(options.ExecutionSlippagePips)
                            || double.IsInfinity(options.ExecutionSlippagePips))
                            throw new ArgumentOutOfRangeException(nameof(options.ExecutionSlippagePips));
                        break;
                    case "--stop-equity-at-or-above":
                        options.StopEquityAtOrAbove = double.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                        if (!double.IsFinite(options.StopEquityAtOrAbove))
                            throw new ArgumentOutOfRangeException(nameof(options.StopEquityAtOrAbove));
                        break;
                    case "--stop-equity-at-or-below":
                        options.StopEquityAtOrBelow = double.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                        if (!double.IsFinite(options.StopEquityAtOrBelow))
                            throw new ArgumentOutOfRangeException(nameof(options.StopEquityAtOrBelow));
                        break;
                    case "--protection-fill-mode":
                        options.ProtectionFillMode = ParseProtectionFillMode(RequireValue(token, tokens));
                        break;
                    case "--execution-smoke":
                        options.RunExecutionSmoke = true;
                        break;
                    case "--execution-probe-events":
                        options.ExecutionProbeEventsPath = RequireValue(token, tokens);
                        break;
                    case "--execution-probe-ticks":
                        options.ExecutionProbeTicksPath = RequireValue(token, tokens);
                        break;
                    case "--report-json":
                        options.ReportJsonPath = RequireValue(token, tokens);
                        break;
                    case "--skip-equity-csv":
                        options.SkipEquityCsv = true;
                        break;
                    case "--metrics-start-utc":
                        options.MetricsStartUtc = ParseUtc(RequireValue(token, tokens));
                        break;
                    case "--synthetic":
                        options.SyntheticEnabled = true;
                        break;
                    case "--synthetic-model":
                    case "--synthetic-continue":
                        options.SyntheticEnabled = true;
                        options.SyntheticModelPath = RequireValue(token, tokens);
                        break;
                    case "--synthetic-model-out":
                        options.SyntheticModelOutputPath = RequireValue(token, tokens);
                        break;
                    case "--synthetic-scenario":
                        options.SyntheticScenarioPath = RequireValue(token, tokens);
                        break;
                    case "--synthetic-record":
                        options.SyntheticRecordPath = RequireValue(token, tokens);
                        break;
                    case "--synthetic-duration":
                        options.SyntheticDuration = ParseDuration(RequireValue(token, tokens));
                        break;
                    case "--synthetic-ticks":
                        options.SyntheticTickCount = long.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                        break;
                    case "--synthetic-seed":
                        options.SyntheticSeed = int.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                        break;
                    case "--synthetic-calibration-ticks":
                        options.SyntheticCalibrationTicks = int.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                        break;
                    case "--simulation-speed":
                        options.SimulationSpeed = RequireValue(token, tokens);
                        break;
                    case "--live-events":
                        options.LiveEventsPath = RequireValue(token, tokens);
                        break;
                    case "--live-publish-every-ticks":
                        options.LivePublishEveryTicks = int.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                        break;
                    case "--period":
                    case "--timeframe":
                        options.TimeFrame = BotParameterLoader.ParseTimeFrame(RequireValue(token, tokens));
                        break;
                    case "--help":
                    case "-h":
                        PrintHelp();
                        Environment.Exit(0);
                        break;
                    default:
                        throw new ArgumentException("Unknown argument: " + token);
                }
            }

            if (options.WarmupSeries.Count > 0 && !string.IsNullOrWhiteSpace(options.WarmupBarPath))
                throw new ArgumentException("--warmup-series and --warmup-bars are mutually exclusive.");
            return options;
        }

        private static void AddWarmupSeries(RunnerOptions options, string value)
        {
            int separator = value.IndexOf('=');
            if (separator <= 0 || separator == value.Length - 1)
                throw new ArgumentException("--warmup-series requires timeframe=CSV, for example h1=/path/history.csv.");
            TimeFrame timeframe = BotParameterLoader.ParseTimeFrame(value.Substring(0, separator).Trim());
            string path = value.Substring(separator + 1);
            if (timeframe == null || string.IsNullOrWhiteSpace(path))
                throw new ArgumentException("--warmup-series requires an explicit timeframe and CSV path.");
            if (!options.WarmupSeries.TryAdd(timeframe, path))
                throw new ArgumentException("Duplicate --warmup-series timeframe: " + timeframe);
        }

        private static DateTime ParseUtc(string value)
        {
            return DateTime.Parse(
                value,
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal);
        }

        private static TimeSpan ParseDuration(string value)
        {
            string normalized = (value ?? "").Trim().ToLowerInvariant();
            if (normalized.EndsWith("d", StringComparison.Ordinal))
                return TimeSpan.FromDays(double.Parse(normalized[..^1], CultureInfo.InvariantCulture));
            if (normalized.EndsWith("h", StringComparison.Ordinal))
                return TimeSpan.FromHours(double.Parse(normalized[..^1], CultureInfo.InvariantCulture));
            if (normalized.EndsWith("m", StringComparison.Ordinal))
                return TimeSpan.FromMinutes(double.Parse(normalized[..^1], CultureInfo.InvariantCulture));
            if (TimeSpan.TryParse(normalized, CultureInfo.InvariantCulture, out TimeSpan parsed) && parsed > TimeSpan.Zero)
                return parsed;
            throw new ArgumentException("Synthetic duration must be positive, for example 30d, 12h, or 01:00:00.");
        }

        private static ProtectionFillMode ParseProtectionFillMode(string value)
        {
            string normalized = (value ?? "").Trim().Replace("-", "").Replace("_", "").ToLowerInvariant();
            return normalized switch
            {
                "current" or "currentprice" => ProtectionFillMode.CurrentPrice,
                "level" or "stoportargetprice" => ProtectionFillMode.StopOrTargetPrice,
                _ => throw new ArgumentException("Unsupported --protection-fill-mode '" + value + "'. Use current or level.")
            };
        }

        private static SourceBarPriceMode ParseBarPriceMode(string value)
        {
            string normalized = (value ?? "").Trim().Replace("-", "").Replace("_", "").ToLowerInvariant();
            switch (normalized)
            {
                case "":
                case "ohlc":
                case "ohlcsyntheticticks":
                    return SourceBarPriceMode.OhlcSyntheticTicks;
                case "open":
                case "openonly":
                    return SourceBarPriceMode.OpenOnly;
                case "nativem1":
                    return SourceBarPriceMode.NativeM1;
                default:
                    throw new ArgumentException("Unsupported --bar-price-mode '" + value + "'. Use ohlc, open or native-m1.");
            }
        }

        private static string RequireValue(string option, Queue<string> tokens)
        {
            if (tokens.Count == 0)
                throw new ArgumentException(option + " requires a value.");
            return tokens.Dequeue();
        }

        private static void AddParameterOverride(RunnerOptions options, string value)
        {
            int equals = value.IndexOf('=');
            if (equals <= 0)
                throw new ArgumentException("--param requires Name=Value.");
            string name = value.Substring(0, equals).Trim();
            string parameterValue = value.Substring(equals + 1).Trim();
            if (name.Length == 0)
                throw new ArgumentException("--param requires a non-empty parameter name.");
            options.ParameterOverrides[name] = parameterValue;
        }

        private static void PrintHelp()
        {
            Console.WriteLine("BacktestEngine.Run");
            Console.WriteLine("  --strategy <name>           Registered strategy to run (default: ExampleStrategy)");
            Console.WriteLine("  --params <file.cbotset>     Load cTrader parameter file");
            Console.WriteLine("  --describe-strategy <name>  Print strategy parameter metadata JSON and exit");
            Console.WriteLine("  --param <name=value>        Override one cBot parameter; repeatable");
            Console.WriteLine("  --ticks <ticks.csv>         Replay dumped cTrader bid/ask ticks; repeat to continue state across files");
            Console.WriteLine("  --bars <bars.csv>           Replay OHLC bars with time_utc,open,high,low,close");
            Console.WriteLine("  --warmup-bars <bars.csv>    Preload OHLC bars before OnStart without replaying decisions");
            Console.WriteLine("  --warmup-series <tf=csv>    Seed independently captured history before OnStart; repeat per timeframe");
            Console.WriteLine("  --startup-quote <json>      Use the native observed OnStart quote before replay begins");
            Console.WriteLine("  --bar-period <period>       Timeframe of --bars input");
            Console.WriteLine("  --bar-price-mode <ohlc|open|native-m1> Source replay path (default: ohlc); native-m1 requires M1 bars");
            Console.WriteLine("  --symbol-spec <spec.json>   Load a validated economic-symbol.v2 profile with cost authorities");
            Console.WriteLine("  --max-ticks <n>             Limit replay rows for smoke testing");
            Console.WriteLine("  --tick-chunk-size <n>       Stream tick CSVs in bounded batches (default: 250000)");
            Console.WriteLine("  --max-bars <n>              Limit bar rows for smoke testing");
            Console.WriteLine("  --start-utc <timestamp>     Inclusive replay start filter");
            Console.WriteLine("  --end-utc <timestamp>       Exclusive replay end filter");
            Console.WriteLine("  --commission-usd-per-million <n>");
            Console.WriteLine("  --balance <n>               Starting account balance");
            Console.WriteLine("  --spread-pips <n>           Fixed spread in pips");
            Console.WriteLine("  --spread-multiplier <n>     Multiply broker tick spread during tick replay");
            Console.WriteLine("  --execution-latency-ticks <n> Use market prices from n ticks ago for order fills");
            Console.WriteLine("  --slippage-pips <n>        Adverse slippage applied to every fill");
            Console.WriteLine("  --stop-equity-at-or-above <money> End replay at the first tick whose equity reaches this level");
            Console.WriteLine("  --stop-equity-at-or-below <money> End replay at the first tick whose equity reaches this level");
            Console.WriteLine("  --protection-fill-mode <current|level> Protected-exit fill behavior (default: current)");
            Console.WriteLine("  --execution-smoke           Run deterministic fill/accounting smoke");
            Console.WriteLine("  --execution-probe-events <events.csv>");
            Console.WriteLine("  --execution-probe-ticks <ticks.csv>");
            Console.WriteLine("  --report-json <path>        Write machine-readable run report");
            Console.WriteLine("  --skip-equity-csv           Skip large equity.csv artifact while preserving drawdown metrics");
            Console.WriteLine("  --metrics-start-utc <date>  Warm the strategy on earlier data but begin equity-path metrics at this UTC date");
            Console.WriteLine("  --symbol <symbol>           Override chart symbol");
            Console.WriteLine("  --period <m1|m5|m15|h1...>  Override chart timeframe");
            Console.WriteLine("  --synthetic                 Stream a synthetic market after any historical ticks");
            Console.WriteLine("  --synthetic-model <json>    Load a frozen synthetic market model");
            Console.WriteLine("  --synthetic-continue <json> Alias for --synthetic-model with historical continuation");
            Console.WriteLine("  --synthetic-model-out <json> Save the calibrated model used by the run");
            Console.WriteLine("  --synthetic-scenario <json> Apply volatility, spread, jump and activity multipliers");
            Console.WriteLine("  --synthetic-duration <30d>  Synthetic simulation duration (default: 1d)");
            Console.WriteLine("  --synthetic-ticks <n>       Optional generated-tick limit");
            Console.WriteLine("  --synthetic-seed <n>        Deterministic generator seed (default: 1)");
            Console.WriteLine("  --synthetic-record <csv>    Save generated ticks while backtesting them");
            Console.WriteLine("  --simulation-speed <mode>   max, realtime, step, or a multiplier such as 100x");
            Console.WriteLine("  --live-events <jsonl>       Publish live price/account/trade snapshots");
            Console.WriteLine("  --live-publish-every-ticks <n> Snapshot interval (default: 500)");
        }
    }
}
