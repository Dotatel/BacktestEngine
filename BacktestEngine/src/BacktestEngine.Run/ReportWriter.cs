using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using cAlgo.API;

namespace BacktestEngine.Run
{
    internal static class ReportWriter
    {
        public static void WriteJson(
            string path,
            Robot bot,
            string strategyName,
            string replayMode,
            int inputCount,
            ReplaySummary replaySummary,
            string parameterFile,
            int parameterDefaults,
            int parameterOverrides,
            IReadOnlyList<string> parameterUnknown,
            bool writeEquityCsv,
            string barPriceMode = null)
        {
            if (string.IsNullOrWhiteSpace(path))
                return;

            EffectiveSymbolSpecification effectiveSpec = bot.Symbol.EffectiveSpecification
                ?? throw new InvalidOperationException("Cannot write an economic report without an effective symbol specification.");
            IReadOnlyList<Position> trades = bot.History.ClosedPositions;
            Position[] openPositions = bot.Positions.ToArray();
            DateTime valuationTime = replaySummary.LastTickTimeUtc != DateTime.MinValue
                ? replaySummary.LastTickTimeUtc
                : bot.Server.Time;
            DrawdownSummary drawdown = replaySummary.EquityPointCount > 0
                ? DrawdownSummary.From(replaySummary.EquityPath)
                : DrawdownSummary.From(
                    replaySummary.EquitySamples,
                    bot.Account.StartingBalance,
                    bot.Account.Balance,
                    bot.Account.Equity);
            RiskPathSummary riskPath = replaySummary.EquityPointCount > 0
                ? RiskPathSummary.From(replaySummary.EquityPath)
                : RiskPathSummary.From(replaySummary.EquitySamples);
            OpenRiskSummary openRisk = OpenRiskSummary.From(openPositions, valuationTime, bot.Account.StartingBalance);
            HoldingDurationSummary holding = HoldingDurationSummary.From(trades);
            var tradeItems = trades.Select(position => new
            {
                id = position.Id,
                symbol = position.SymbolName,
                label = position.Label,
                side = position.TradeType.ToString(),
                volume_in_units = position.VolumeInUnits,
                entry_time_utc = position.EntryTime,
                entry_price = position.EntryPrice,
                entry_bid = position.EntryBid,
                entry_ask = position.EntryAsk,
                entry_spread = position.EntryAsk - position.EntryBid,
                close_time_utc = position.ClosingTime,
                close_price = position.ClosePrice,
                close_bid = position.CloseBid,
                close_ask = position.CloseAsk,
                close_spread = position.CloseAsk - position.CloseBid,
                close_reason = position.ClosingReason,
                pips = position.Pips,
                gross_profit = position.GrossProfit,
                pnl_conversion_fees = position.PnLConversionFees,
                commissions = position.Commissions,
                swaps = position.Swaps,
                net_profit = position.NetProfit,
                intended_risk_money = position.IntendedRiskMoney,
                mae_net_profit = position.MaeNetProfit,
                mfe_net_profit = position.MfeNetProfit,
                net_r = position.NetR,
                economic_specification_hash = position.EconomicSpecificationHash
            }).ToArray();
            var openPositionItems = openPositions.Select(position => new
            {
                id = position.Id,
                symbol = position.SymbolName,
                label = position.Label,
                side = position.TradeType.ToString(),
                volume_in_units = position.VolumeInUnits,
                entry_time_utc = position.EntryTime,
                entry_price = position.EntryPrice,
                valuation_time_utc = valuationTime,
                valuation_price = position.TradeType == TradeType.Buy ? bot.Symbol.Bid : bot.Symbol.Ask,
                age_hours = Math.Max(0.0, (valuationTime - position.EntryTime).TotalHours),
                pips = position.Pips,
                gross_profit = position.GrossProfit,
                pnl_conversion_fees = position.PnLConversionFees,
                commissions = position.Commissions,
                swaps = position.Swaps,
                net_profit = position.NetProfit,
                intended_risk_money = position.IntendedRiskMoney,
                mae_net_profit = position.MaeNetProfit,
                mfe_net_profit = position.MfeNetProfit,
                net_r = position.NetR,
                economic_specification_hash = position.EconomicSpecificationHash
            }).ToArray();

            TradeStats allStats = TradeStats.From(trades);
            TradeStats longStats = TradeStats.From(trades.Where(position => position.TradeType == TradeType.Buy));
            TradeStats shortStats = TradeStats.From(trades.Where(position => position.TradeType == TradeType.Sell));

            var report = new
            {
                generated_at_utc = DateTime.UtcNow,
                strategy = strategyName,
                symbol = bot.SymbolName,
                requested_symbol = bot.RequestedSymbolName,
                effective_symbol = effectiveSpec.Symbol,
                timeframe = bot.TimeFrame.ToString(),
                period = ToCTraderPeriod(bot.TimeFrame),
                parameter_file = parameterFile ?? "",
                parameter_defaults = parameterDefaults,
                parameter_overrides = parameterOverrides,
                parameter_unknown = parameterUnknown ?? Array.Empty<string>(),
                commission_usd_per_million = bot.CommissionUsdPerMillion,
                execution_slippage_pips_per_fill = bot.ExecutionSlippagePips,
                economic_contract = effectiveSpec.ToContractRecord(),
                economic_contract_provenance = new
                {
                    schema_version = effectiveSpec.SchemaVersion,
                    canonical_spec_sha256 = effectiveSpec.CanonicalSpecSha256,
                    requested_specification_path = bot.SymbolSpecificationPath,
                    specification_source = effectiveSpec.SpecificationSource,
                    specification_source_kind = effectiveSpec.SpecificationSourceKind,
                    specification_source_sha256 = effectiveSpec.SpecificationSourceSha256,
                    account_currency = effectiveSpec.AccountCurrency,
                    commission_model = effectiveSpec.CommissionModel.ToString(),
                    commission_side_semantics = effectiveSpec.CommissionSideSemantics.ToString(),
                    swap_calculation_type = effectiveSpec.SwapCalculationType.ToString(),
                    quote_to_account_conversion_model = effectiveSpec.QuoteToAccountConversionModel.ToString(),
                    quote_to_account_conversion_rate_used = effectiveSpec.QuoteToAccountConversionRate,
                    pnl_conversion_fee_rate = effectiveSpec.PnLConversionFeeRate
                },
                replay = new
                {
                    mode = replayMode,
                    bar_price_mode = barPriceMode,
                    input_count = inputCount,
                    ticks_or_synthetic_ticks = replaySummary.TickCount,
                    on_bar_count = replaySummary.OnBarCount,
                    chart_bar_count = replaySummary.ChartBarCount,
                    hour_bar_count = replaySummary.HourBarCount,
                    elapsed_ms = replaySummary.ReplayElapsedMilliseconds,
                    ticks_or_synthetic_ticks_per_second = replaySummary.ReplayElapsedMilliseconds > 0.0
                        ? replaySummary.TickCount / (replaySummary.ReplayElapsedMilliseconds / 1000.0)
                        : 0.0,
                    first_time_utc = replaySummary.FirstTickTimeUtc,
                    last_time_utc = replaySummary.LastTickTimeUtc
                },
                termination = new
                {
                    reason = replaySummary.TerminationReason,
                    time_utc = replaySummary.TerminationTimeUtc,
                    balance = replaySummary.TerminationBalance,
                    equity = replaySummary.TerminationEquity
                },
                synthetic = replaySummary.Synthetic == null ? null : new
                {
                    model_name = replaySummary.Synthetic.ModelName,
                    model_path = replaySummary.Synthetic.ModelPath,
                    model_sha256 = replaySummary.Synthetic.ModelSha256,
                    scenario_name = replaySummary.Synthetic.ScenarioName,
                    scenario_path = replaySummary.Synthetic.ScenarioPath,
                    scenario_sha256 = replaySummary.Synthetic.ScenarioSha256,
                    seed = replaySummary.Synthetic.Seed,
                    boundary_time_utc = replaySummary.Synthetic.BoundaryTimeUtc,
                    historical_ticks = replaySummary.Synthetic.HistoricalTicks,
                    generated_ticks = replaySummary.Synthetic.GeneratedTicks,
                    jump_count = replaySummary.Synthetic.JumpCount,
                    regime_counts = new
                    {
                        quiet = ReplayRegimeCount(replaySummary.Synthetic, SyntheticRegime.Quiet),
                        normal = ReplayRegimeCount(replaySummary.Synthetic, SyntheticRegime.Normal),
                        trend_up = ReplayRegimeCount(replaySummary.Synthetic, SyntheticRegime.TrendUp),
                        trend_down = ReplayRegimeCount(replaySummary.Synthetic, SyntheticRegime.TrendDown),
                        crisis = ReplayRegimeCount(replaySummary.Synthetic, SyntheticRegime.Crisis)
                    },
                    recorded_ticks_path = replaySummary.Synthetic.RecordedTicksPath
                },
                account = new
                {
                    currency = bot.Account.DepositAssetName,
                    currency_digits = bot.Account.DepositAssetDigits,
                    starting_capital = bot.Account.StartingBalance,
                    balance = bot.Account.Balance,
                    equity = bot.Account.Equity,
                    closed_net_profit = bot.Account.Balance - bot.Account.StartingBalance,
                    open_net_profit = openRisk.OpenNetProfit,
                    marked_to_market_net_profit = bot.Account.Equity - bot.Account.StartingBalance,
                    marked_to_market_return_percent = bot.Account.StartingBalance > 0.0
                        ? (bot.Account.Equity - bot.Account.StartingBalance) / bot.Account.StartingBalance * 100.0
                        : 0.0
                },
                native_report_drawdown = replaySummary.NativeDrawdown == null ? null : new
                {
                    method = "ctrader-price-extremes-and-deals-v1",
                    equity_points = replaySummary.NativeDrawdown.Samples,
                    max_equity_drawdown = replaySummary.NativeDrawdown.Equity.MaxEquityDrawdown,
                    max_equity_drawdown_percent = replaySummary.NativeDrawdown.Equity.MaxEquityDrawdownPercent,
                    max_balance_drawdown = replaySummary.NativeDrawdown.Balance.MaxBalanceDrawdown,
                    max_balance_drawdown_percent = replaySummary.NativeDrawdown.Balance.MaxBalanceDrawdownPercent
                },
                drawdown = new
                {
                    equity_points = replaySummary.EquityPointCount,
                    max_balance_drawdown = drawdown.MaxBalanceDrawdown,
                    max_balance_drawdown_percent = drawdown.MaxBalanceDrawdownPercent,
                    max_balance_drawdown_peak_time_utc = drawdown.MaxBalanceDrawdownPeakTimeUtc,
                    max_balance_drawdown_trough_time_utc = drawdown.MaxBalanceDrawdownTroughTimeUtc,
                    max_balance_drawdown_peak = drawdown.MaxBalanceDrawdownPeak,
                    max_balance_drawdown_trough = drawdown.MaxBalanceDrawdownTrough,
                    max_equity_drawdown = drawdown.MaxEquityDrawdown,
                    max_equity_drawdown_percent = drawdown.MaxEquityDrawdownPercent,
                    max_equity_drawdown_peak_time_utc = drawdown.MaxEquityDrawdownPeakTimeUtc,
                    max_equity_drawdown_trough_time_utc = drawdown.MaxEquityDrawdownTroughTimeUtc,
                    max_equity_drawdown_peak = drawdown.MaxEquityDrawdownPeak,
                    max_equity_drawdown_trough = drawdown.MaxEquityDrawdownTrough
                },
                daily_max_equity_drawdown = replaySummary.EquityPath.DailyMaxEquityDrawdown.Select(sample => new
                {
                    day_utc = sample.DayUtc,
                    max_percent = sample.MaxPercent
                }).ToArray(),
                risk_path = new
                {
                    max_day_start_equity_loss = riskPath.MaxDayStartEquityLoss,
                    max_day_start_equity_loss_percent = riskPath.MaxDayStartEquityLossPercent,
                    max_intraday_equity_drawdown = riskPath.MaxIntradayEquityDrawdown,
                    max_intraday_equity_drawdown_percent = riskPath.MaxIntradayEquityDrawdownPercent
                },
                open_risk = new
                {
                    position_count = openRisk.PositionCount,
                    winning_position_count = openRisk.WinningPositionCount,
                    losing_position_count = openRisk.LosingPositionCount,
                    open_net_profit = openRisk.OpenNetProfit,
                    open_gross_profit = openRisk.OpenGrossProfit,
                    open_commissions = openRisk.OpenCommissions,
                    open_swaps = openRisk.OpenSwaps,
                    open_loss = openRisk.OpenLoss,
                    open_loss_percent_of_starting_capital = openRisk.OpenLossPercentOfStartingCapital,
                    worst_position_net_profit = openRisk.WorstPositionNetProfit,
                    worst_position_loss_percent_of_starting_capital = openRisk.WorstPositionLossPercentOfStartingCapital,
                    max_position_age_hours = openRisk.MaxPositionAgeHours,
                    max_losing_position_age_hours = openRisk.MaxLosingPositionAgeHours
                },
                lifecycle_statistics = new
                {
                    average_closed_duration_hours = holding.AverageClosedDurationHours,
                    p95_closed_duration_hours = holding.P95ClosedDurationHours,
                    max_closed_duration_hours = holding.MaxClosedDurationHours,
                    max_losing_closed_duration_hours = holding.MaxLosingClosedDurationHours
                },
                trade_statistics = new
                {
                    total_trades = allStats.TotalTrades,
                    winning_trades = allStats.WinningTrades,
                    losing_trades = allStats.LosingTrades,
                    long_trades = longStats.TotalTrades,
                    short_trades = shortStats.TotalTrades,
                    gross_profit = allStats.GrossProfit,
                    gross_loss = allStats.GrossLoss,
                    commissions = allStats.Commissions,
                    swaps = allStats.Swaps,
                    net_profit = allStats.NetProfit,
                    profit_factor = allStats.ProfitFactor,
                    total_pips = allStats.TotalPips,
                    average_net_profit = allStats.AverageNetProfit,
                    largest_win = allStats.LargestWin,
                    largest_loss = allStats.LargestLoss
                },
                trade_statistics_by_side = new
                {
                    all = allStats,
                    @long = longStats,
                    @short = shortStats
                },
                trades = tradeItems,
                open_positions = openPositionItems
            };

            string fullPath = Path.GetFullPath(path);
            string directory = Path.GetDirectoryName(fullPath);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);

            string tradeCsvPath = Path.Combine(directory ?? "", "trades.csv");
            string openPositionCsvPath = Path.Combine(directory ?? "", "open_positions.csv");
            string equityCsvPath = Path.Combine(directory ?? "", "equity.csv");
            WriteTradesCsv(tradeCsvPath, trades);
            WriteOpenPositionsCsv(openPositionCsvPath, openPositions, valuationTime, bot.Symbol);
            if (writeEquityCsv)
                WriteEquityCsv(equityCsvPath, replaySummary.EquitySamples);

            var options = new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
                WriteIndented = true
            };
            options.Converters.Add(new JsonStringEnumConverter());
            File.WriteAllText(fullPath, JsonSerializer.Serialize(report, options));
            Console.WriteLine("BACKTESTENGINE_REPORT_JSON path={0}", fullPath);
            Console.WriteLine("BACKTESTENGINE_TRADES_CSV path={0}", tradeCsvPath);
            Console.WriteLine("BACKTESTENGINE_OPEN_POSITIONS_CSV path={0}", openPositionCsvPath);
            if (writeEquityCsv)
                Console.WriteLine("BACKTESTENGINE_EQUITY_CSV path={0}", equityCsvPath);
        }

        private static long ReplayRegimeCount(SyntheticReplayMetadata metadata, SyntheticRegime regime)
        {
            int index = (int)regime;
            return metadata?.RegimeCounts != null && index >= 0 && index < metadata.RegimeCounts.Length
                ? metadata.RegimeCounts[index]
                : 0L;
        }

        private static void WriteTradesCsv(string path, IReadOnlyList<Position> trades)
        {
            using StreamWriter writer = new StreamWriter(path, false);
            writer.WriteLine("id,symbol,label,side,volume_in_units,entry_time_utc,entry_price,close_time_utc,close_price,close_reason,pips,gross_profit,pnl_conversion_fees,commissions,swaps,net_profit,intended_risk_money,mae_net_profit,mfe_net_profit,net_r,economic_specification_hash");
            foreach (Position position in trades)
            {
                writer.WriteLine(string.Join(",",
                    Csv(position.Id),
                    Csv(position.SymbolName),
                    Csv(position.Label),
                    Csv(position.TradeType.ToString()),
                    Csv(position.VolumeInUnits),
                    Csv(position.EntryTime),
                    Csv(position.EntryPrice),
                    Csv(position.ClosingTime),
                    Csv(position.ClosePrice),
                    Csv(position.ClosingReason),
                    Csv(position.Pips),
                    Csv(position.GrossProfit),
                    Csv(position.PnLConversionFees),
                    Csv(position.Commissions),
                    Csv(position.Swaps),
                    Csv(position.NetProfit),
                    Csv(position.IntendedRiskMoney),
                    Csv(position.MaeNetProfit),
                    Csv(position.MfeNetProfit),
                    Csv(position.NetR),
                    Csv(position.EconomicSpecificationHash)));
            }
        }

        private static void WriteEquityCsv(string path, IReadOnlyList<EquitySample> samples)
        {
            using StreamWriter writer = new StreamWriter(path, false);
            writer.WriteLine("time_utc,balance,equity");
            foreach (EquitySample sample in samples)
            {
                writer.WriteLine(string.Join(",",
                    Csv(sample.TimeUtc),
                    Csv(sample.Balance),
                    Csv(sample.Equity)));
            }
        }

        private static void WriteOpenPositionsCsv(string path, IReadOnlyList<Position> positions, DateTime valuationTime, Symbol symbol)
        {
            using StreamWriter writer = new StreamWriter(path, false);
            writer.WriteLine("id,symbol,label,side,volume_in_units,entry_time_utc,entry_price,valuation_time_utc,valuation_price,age_hours,pips,gross_profit,pnl_conversion_fees,commissions,swaps,net_profit,intended_risk_money,mae_net_profit,mfe_net_profit,net_r,economic_specification_hash");
            foreach (Position position in positions)
            {
                double valuationPrice = position.TradeType == TradeType.Buy ? symbol.Bid : symbol.Ask;
                writer.WriteLine(string.Join(",",
                    Csv(position.Id),
                    Csv(position.SymbolName),
                    Csv(position.Label),
                    Csv(position.TradeType.ToString()),
                    Csv(position.VolumeInUnits),
                    Csv(position.EntryTime),
                    Csv(position.EntryPrice),
                    Csv(valuationTime),
                    Csv(valuationPrice),
                    Csv(Math.Max(0.0, (valuationTime - position.EntryTime).TotalHours)),
                    Csv(position.Pips),
                    Csv(position.GrossProfit),
                    Csv(position.PnLConversionFees),
                    Csv(position.Commissions),
                    Csv(position.Swaps),
                    Csv(position.NetProfit),
                    Csv(position.IntendedRiskMoney),
                    Csv(position.MaeNetProfit),
                    Csv(position.MfeNetProfit),
                    Csv(position.NetR),
                    Csv(position.EconomicSpecificationHash)));
            }
        }

        private static string Csv(DateTime value)
        {
            return value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        }

        private static string Csv(double value)
        {
            return value.ToString("G17", CultureInfo.InvariantCulture);
        }

        private static string Csv(long value)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }

        private static string Csv(string value)
        {
            string text = value ?? "";
            if (!text.Contains(',') && !text.Contains('"') && !text.Contains('\n') && !text.Contains('\r'))
                return text;
            return "\"" + text.Replace("\"", "\"\"") + "\"";
        }

        private static string ToCTraderPeriod(TimeFrame timeFrame)
        {
            string name = timeFrame?.ToString() ?? "";
            switch (name.ToLowerInvariant())
            {
                case "minute":
                    return "m1";
                case "minute5":
                    return "m5";
                case "minute15":
                    return "m15";
                case "minute30":
                    return "m30";
                case "hour":
                    return "h1";
                case "hour4":
                    return "h4";
                case "daily":
                    return "d1";
                case "weekly":
                    return "w1";
                case "monthly":
                    return "mn1";
                default:
                    return name;
            }
        }
    }

    internal sealed class TradeStats
    {
        public int TotalTrades { get; set; }
        public int WinningTrades { get; set; }
        public int LosingTrades { get; set; }
        public double GrossProfit { get; set; }
        public double GrossLoss { get; set; }
        public double Commissions { get; set; }
        public double Swaps { get; set; }
        public double NetProfit { get; set; }
        public double? ProfitFactor { get; set; }
        public double TotalPips { get; set; }
        public double AverageNetProfit { get; set; }
        public double LargestWin { get; set; }
        public double LargestLoss { get; set; }
        public double WinRate { get; set; }
        public double LossRate { get; set; }

        public static TradeStats From(IEnumerable<Position> positions)
        {
            Position[] trades = positions.ToArray();
            double grossProfit = trades.Where(position => position.NetProfit > 0.0).Sum(position => position.NetProfit);
            double grossLoss = trades.Where(position => position.NetProfit < 0.0).Sum(position => position.NetProfit);

            return new TradeStats
            {
                TotalTrades = trades.Length,
                WinningTrades = trades.Count(position => position.NetProfit > 0.0),
                LosingTrades = trades.Count(position => position.NetProfit < 0.0),
                GrossProfit = grossProfit,
                GrossLoss = grossLoss,
                Commissions = trades.Sum(position => position.Commissions),
                Swaps = trades.Sum(position => position.Swaps),
                NetProfit = trades.Sum(position => position.NetProfit),
                ProfitFactor = grossLoss < 0.0 ? grossProfit / Math.Abs(grossLoss) : null,
                TotalPips = trades.Sum(position => position.Pips),
                AverageNetProfit = trades.Length > 0 ? trades.Average(position => position.NetProfit) : 0.0,
                LargestWin = trades.Length > 0 ? trades.Max(position => position.NetProfit) : 0.0,
                LargestLoss = trades.Length > 0 ? trades.Min(position => position.NetProfit) : 0.0,
                WinRate = trades.Length > 0 ? trades.Count(position => position.NetProfit > 0.0) * 100.0 / trades.Length : 0.0,
                LossRate = trades.Length > 0 ? trades.Count(position => position.NetProfit < 0.0) * 100.0 / trades.Length : 0.0
            };
        }
    }

    internal sealed class DrawdownSummary
    {
        public double MaxBalanceDrawdown { get; set; }
        public double MaxBalanceDrawdownPercent { get; set; }
        public double MaxEquityDrawdown { get; set; }
        public double MaxEquityDrawdownPercent { get; set; }
        public DateTime MaxBalanceDrawdownPeakTimeUtc { get; set; }
        public DateTime MaxBalanceDrawdownTroughTimeUtc { get; set; }
        public double MaxBalanceDrawdownPeak { get; set; }
        public double MaxBalanceDrawdownTrough { get; set; }
        public DateTime MaxEquityDrawdownPeakTimeUtc { get; set; }
        public DateTime MaxEquityDrawdownTroughTimeUtc { get; set; }
        public double MaxEquityDrawdownPeak { get; set; }
        public double MaxEquityDrawdownTrough { get; set; }

        public static DrawdownSummary From(
            IReadOnlyList<EquitySample> samples,
            double startingBalance,
            double fallbackBalance,
            double fallbackEquity)
        {
            if (samples == null || samples.Count == 0)
            {
                samples = new[]
                {
                    new EquitySample(DateTime.MinValue, fallbackBalance, fallbackEquity)
                };
            }

            double balancePeak = startingBalance > 0.0 ? startingBalance : samples[0].Balance;
            double equityPeak = samples[0].Equity;
            DrawdownSummary summary = new DrawdownSummary();

            foreach (EquitySample sample in samples)
            {
                balancePeak = Math.Max(balancePeak, sample.Balance);
                equityPeak = Math.Max(equityPeak, sample.Equity);

                double balanceDrawdown = Math.Max(0.0, balancePeak - sample.Balance);
                double equityDrawdown = Math.Max(0.0, equityPeak - sample.Equity);

                summary.MaxBalanceDrawdown = Math.Max(summary.MaxBalanceDrawdown, balanceDrawdown);
                summary.MaxEquityDrawdown = Math.Max(summary.MaxEquityDrawdown, equityDrawdown);

                if (balancePeak > 0.0)
                    summary.MaxBalanceDrawdownPercent = Math.Max(summary.MaxBalanceDrawdownPercent, balanceDrawdown / balancePeak * 100.0);
                if (equityPeak > 0.0)
                    summary.MaxEquityDrawdownPercent = Math.Max(summary.MaxEquityDrawdownPercent, equityDrawdown / equityPeak * 100.0);
            }

            return summary;
        }

        public static DrawdownSummary From(EquityPathMetrics metrics)
        {
            return new DrawdownSummary
            {
                MaxBalanceDrawdown = metrics?.MaxBalanceDrawdown ?? 0.0,
                MaxBalanceDrawdownPercent = metrics?.MaxBalanceDrawdownPercent ?? 0.0,
                MaxEquityDrawdown = metrics?.MaxEquityDrawdown ?? 0.0,
                MaxEquityDrawdownPercent = metrics?.MaxEquityDrawdownPercent ?? 0.0,
                MaxBalanceDrawdownPeakTimeUtc = metrics?.MaxBalanceDrawdownPeakTimeUtc ?? DateTime.MinValue,
                MaxBalanceDrawdownTroughTimeUtc = metrics?.MaxBalanceDrawdownTroughTimeUtc ?? DateTime.MinValue,
                MaxBalanceDrawdownPeak = metrics?.MaxBalanceDrawdownPeak ?? 0.0,
                MaxBalanceDrawdownTrough = metrics?.MaxBalanceDrawdownTrough ?? 0.0,
                MaxEquityDrawdownPeakTimeUtc = metrics?.MaxEquityDrawdownPeakTimeUtc ?? DateTime.MinValue,
                MaxEquityDrawdownTroughTimeUtc = metrics?.MaxEquityDrawdownTroughTimeUtc ?? DateTime.MinValue,
                MaxEquityDrawdownPeak = metrics?.MaxEquityDrawdownPeak ?? 0.0,
                MaxEquityDrawdownTrough = metrics?.MaxEquityDrawdownTrough ?? 0.0
            };
        }
    }

    internal sealed class RiskPathSummary
    {
        public double MaxDayStartEquityLoss { get; set; }
        public double MaxDayStartEquityLossPercent { get; set; }
        public double MaxIntradayEquityDrawdown { get; set; }
        public double MaxIntradayEquityDrawdownPercent { get; set; }

        public static RiskPathSummary From(IReadOnlyList<EquitySample> samples)
        {
            RiskPathSummary summary = new RiskPathSummary();
            if (samples == null || samples.Count == 0)
                return summary;

            DateTime day = DateTime.MinValue;
            double dayStartEquity = 0.0;
            double dayPeakEquity = 0.0;
            foreach (EquitySample sample in samples.OrderBy(item => item.TimeUtc))
            {
                if (day == DateTime.MinValue || sample.TimeUtc.Date != day)
                {
                    day = sample.TimeUtc.Date;
                    dayStartEquity = sample.Equity;
                    dayPeakEquity = sample.Equity;
                }

                dayPeakEquity = Math.Max(dayPeakEquity, sample.Equity);
                double fromStart = Math.Max(0.0, dayStartEquity - sample.Equity);
                double fromPeak = Math.Max(0.0, dayPeakEquity - sample.Equity);
                summary.MaxDayStartEquityLoss = Math.Max(summary.MaxDayStartEquityLoss, fromStart);
                summary.MaxIntradayEquityDrawdown = Math.Max(summary.MaxIntradayEquityDrawdown, fromPeak);
                if (dayStartEquity > 0.0)
                    summary.MaxDayStartEquityLossPercent = Math.Max(summary.MaxDayStartEquityLossPercent, fromStart / dayStartEquity * 100.0);
                if (dayPeakEquity > 0.0)
                    summary.MaxIntradayEquityDrawdownPercent = Math.Max(summary.MaxIntradayEquityDrawdownPercent, fromPeak / dayPeakEquity * 100.0);
            }

            return summary;
        }

        public static RiskPathSummary From(EquityPathMetrics metrics)
        {
            return new RiskPathSummary
            {
                MaxDayStartEquityLoss = metrics?.MaxDayStartEquityLoss ?? 0.0,
                MaxDayStartEquityLossPercent = metrics?.MaxDayStartEquityLossPercent ?? 0.0,
                MaxIntradayEquityDrawdown = metrics?.MaxIntradayEquityDrawdown ?? 0.0,
                MaxIntradayEquityDrawdownPercent = metrics?.MaxIntradayEquityDrawdownPercent ?? 0.0
            };
        }
    }

    internal sealed class OpenRiskSummary
    {
        public int PositionCount { get; set; }
        public int WinningPositionCount { get; set; }
        public int LosingPositionCount { get; set; }
        public double OpenNetProfit { get; set; }
        public double OpenGrossProfit { get; set; }
        public double OpenCommissions { get; set; }
        public double OpenSwaps { get; set; }
        public double OpenLoss { get; set; }
        public double OpenLossPercentOfStartingCapital { get; set; }
        public double WorstPositionNetProfit { get; set; }
        public double WorstPositionLossPercentOfStartingCapital { get; set; }
        public double MaxPositionAgeHours { get; set; }
        public double MaxLosingPositionAgeHours { get; set; }

        public static OpenRiskSummary From(IReadOnlyList<Position> positions, DateTime valuationTime, double startingCapital)
        {
            Position[] open = positions?.ToArray() ?? Array.Empty<Position>();
            double openLoss = open.Where(position => position.NetProfit < 0.0).Sum(position => -position.NetProfit);
            double worst = open.Length > 0 ? open.Min(position => position.NetProfit) : 0.0;
            return new OpenRiskSummary
            {
                PositionCount = open.Length,
                WinningPositionCount = open.Count(position => position.NetProfit > 0.0),
                LosingPositionCount = open.Count(position => position.NetProfit < 0.0),
                OpenNetProfit = open.Sum(position => position.NetProfit),
                OpenGrossProfit = open.Sum(position => position.GrossProfit),
                OpenCommissions = open.Sum(position => position.Commissions),
                OpenSwaps = open.Sum(position => position.Swaps),
                OpenLoss = openLoss,
                OpenLossPercentOfStartingCapital = startingCapital > 0.0 ? openLoss / startingCapital * 100.0 : 0.0,
                WorstPositionNetProfit = worst,
                WorstPositionLossPercentOfStartingCapital = startingCapital > 0.0 ? Math.Max(0.0, -worst) / startingCapital * 100.0 : 0.0,
                MaxPositionAgeHours = open.Length > 0 ? open.Max(position => Math.Max(0.0, (valuationTime - position.EntryTime).TotalHours)) : 0.0,
                MaxLosingPositionAgeHours = open.Any(position => position.NetProfit < 0.0)
                    ? open.Where(position => position.NetProfit < 0.0).Max(position => Math.Max(0.0, (valuationTime - position.EntryTime).TotalHours))
                    : 0.0
            };
        }
    }

    internal sealed class HoldingDurationSummary
    {
        public double AverageClosedDurationHours { get; set; }
        public double P95ClosedDurationHours { get; set; }
        public double MaxClosedDurationHours { get; set; }
        public double MaxLosingClosedDurationHours { get; set; }

        public static HoldingDurationSummary From(IReadOnlyList<Position> positions)
        {
            Position[] closed = positions?.Where(position => position.ClosingTime != DateTime.MinValue).ToArray() ?? Array.Empty<Position>();
            if (closed.Length == 0)
                return new HoldingDurationSummary();

            double[] durations = closed
                .Select(position => Math.Max(0.0, (position.ClosingTime - position.EntryTime).TotalHours))
                .OrderBy(value => value)
                .ToArray();
            int p95Index = Math.Max(0, (int)Math.Ceiling(durations.Length * 0.95) - 1);
            Position[] losing = closed.Where(position => position.NetProfit < 0.0).ToArray();
            return new HoldingDurationSummary
            {
                AverageClosedDurationHours = durations.Average(),
                P95ClosedDurationHours = durations[p95Index],
                MaxClosedDurationHours = durations[^1],
                MaxLosingClosedDurationHours = losing.Length > 0
                    ? losing.Max(position => Math.Max(0.0, (position.ClosingTime - position.EntryTime).TotalHours))
                    : 0.0
            };
        }
    }
}
