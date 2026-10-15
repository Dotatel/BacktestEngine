using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using cAlgo.API;

namespace BacktestEngine.Run
{
    internal static class ExecutionSmoke
    {
        public static int Run(string symbolSpecPath, string reportJsonPath)
        {
            var bot = new ExecutionSmokeBot
            {
                SymbolName = "XAUUSD",
                Symbol =
                {
                    Name = "XAUUSD",
                    Bid = 100.00,
                    Ask = 100.05
                },
                Account =
                {
                    StartingBalance = 10000.0,
                    Balance = 10000.0,
                    Equity = 10000.0
                },
                Server =
                {
                    Time = new DateTime(2026, 6, 25, 0, 0, 0, DateTimeKind.Utc)
                }
            };
            ConfigureEconomicSpec(bot, symbolSpecPath, "XAUUSD", 0.0, 0.0);

            TradeResult open = bot.Open(TradeType.Buy, 1.0);
            if (!open.IsSuccessful)
                throw new InvalidOperationException("Open failed: " + open.Error);

            bot.Server.Time = new DateTime(2026, 6, 25, 0, 15, 0, DateTimeKind.Utc);
            bot.Symbol.Bid = 101.00;
            bot.Symbol.Ask = 101.05;
            bot.MarkToMarket();

            TradeResult close = bot.Close(open.Position);
            if (!close.IsSuccessful)
                throw new InvalidOperationException("Close failed: " + close.Error);

            double expectedPips = 9.5;
            double expectedNet = 0.95;
            AssertNear(open.Position.Pips, expectedPips, "pips");
            AssertNear(open.Position.NetProfit, expectedNet, "net");
            AssertNear(bot.Account.Balance, 10000.0 + expectedNet, "balance");
            AssertNear(bot.Account.Equity, bot.Account.Balance, "equity");
            if (bot.History.ClosedPositions.Count != 1)
                throw new InvalidOperationException("Expected exactly one closed position.");

            bot.Server.Time = new DateTime(2026, 6, 25, 0, 30, 0, DateTimeKind.Utc);
            bot.Symbol.Bid = 200.00;
            bot.Symbol.Ask = 200.05;
            bot.MarkToMarket();

            TradeResult targetOpen = bot.OpenProtected(TradeType.Buy, 1.0, null, 5.0);
            if (!targetOpen.IsSuccessful)
                throw new InvalidOperationException("Target open failed: " + targetOpen.Error);

            bot.Server.Time = new DateTime(2026, 6, 25, 0, 45, 0, DateTimeKind.Utc);
            bot.Symbol.Bid = 200.55;
            bot.Symbol.Ask = 200.60;
            bot.MarkToMarket();
            bot.ProcessStopsAndTargets();

            AssertNear(targetOpen.Position.Pips, 5.0, "target pips");
            AssertNear(targetOpen.Position.NetProfit, 0.50, "target net");
            if (targetOpen.Position.ClosingReason != "take_profit")
                throw new InvalidOperationException("Expected take_profit close reason.");
            if (bot.History.ClosedPositions.Count != 2)
                throw new InvalidOperationException("Expected exactly two closed positions.");
            AssertNear(bot.Account.Balance, 10000.0 + expectedNet + 0.50, "target balance");

            var summary = new ReplaySummary
            {
                FirstTickTimeUtc = new DateTime(2026, 6, 25, 0, 0, 0, DateTimeKind.Utc),
                LastTickTimeUtc = bot.Server.Time,
                TickCount = 4,
                OnBarCount = 4,
                ChartBarCount = 4,
                HourBarCount = 1
            };
            summary.RecordEquity(bot.Server.Time, bot.Account.Balance, bot.Account.Equity);
            ReportWriter.WriteJson(
                reportJsonPath,
                bot,
                "ExecutionSmoke",
                "deterministic_economic_fixture",
                4,
                summary,
                "",
                0,
                0,
                Array.Empty<string>(),
                true);

            Console.WriteLine(
                "BACKTESTENGINE_EXECUTION_SMOKE status=passed side=Buy entry={0:F2} close={1:F2} pips={2:F2} net={3:F2} targetReason={4} balance={5:F2} history={6}",
                open.Position.EntryPrice,
                open.Position.ClosePrice,
                open.Position.Pips,
                open.Position.NetProfit,
                targetOpen.Position.ClosingReason,
                bot.Account.Balance,
                bot.History.ClosedPositions.Count);

            return 0;
        }

        public static int RunProbeEvents(string eventsCsvPath, string reportJsonPath, string symbolSpecPath, double commissionUsdPerMillion, double slippagePips)
        {
            if (string.IsNullOrWhiteSpace(eventsCsvPath))
                throw new ArgumentException("Execution probe events path is required.", nameof(eventsCsvPath));
            if (!File.Exists(eventsCsvPath))
                throw new FileNotFoundException("Execution probe events file was not found.", eventsCsvPath);

            List<ProbeEvent> events = ProbeEvent.Load(eventsCsvPath);
            ProbeCapture capture = ProbeCapture.LoadForEvents(eventsCsvPath);
            ProbeEvent openEvent = events.FirstOrDefault(item => item.Event == "open_filled" && !string.IsNullOrWhiteSpace(item.PositionId))
                ?? events.FirstOrDefault(item => item.Event == "bar" && string.IsNullOrWhiteSpace(item.PositionId));
            ProbeEvent closeEvent = events.FirstOrDefault(item => item.Event == "bar" && !string.IsNullOrWhiteSpace(item.PositionId))
                ?? events.FirstOrDefault(item => item.Event == "closed" && !string.IsNullOrWhiteSpace(item.PositionId));
            if (openEvent == null || closeEvent == null)
                throw new InvalidOperationException("Could not find open/close events in probe event file.");

            string symbol = RequiredProbeSymbol(events);
            TradeType tradeType = string.Equals(openEvent.Side, "Sell", StringComparison.OrdinalIgnoreCase) ? TradeType.Sell : TradeType.Buy;

            var bot = new ExecutionSmokeBot
            {
                SymbolName = symbol,
                TimeFrame = TimeFrame.Minute,
                Symbol = { Name = symbol },
                Account =
                {
                    StartingBalance = 10000.0,
                    Balance = 10000.0,
                    Equity = 10000.0
                }
            };
            ConfigureEconomicSpec(bot, symbolSpecPath, symbol, commissionUsdPerMillion, slippagePips);

            ReplaySummary summary = new ReplaySummary
            {
                FirstTickTimeUtc = openEvent.TimeUtc,
                LastTickTimeUtc = closeEvent.TimeUtc,
                TickCount = 2,
                OnBarCount = 2,
                ChartBarCount = 2,
                HourBarCount = 1
            };

            bot.Server.Time = openEvent.TimeUtc;
            bot.Symbol.Bid = openEvent.Bid;
            bot.Symbol.Ask = openEvent.Ask;
            bot.MarkToMarket();
            TradeResult open = bot.OpenProtected(
                tradeType,
                capture.VolumeInUnits > 0.0 ? capture.VolumeInUnits : 1.0,
                capture.StopLossPips > 0.0 ? capture.StopLossPips : (double?)null,
                capture.TakeProfitPips > 0.0 ? capture.TakeProfitPips : (double?)null);
            if (!open.IsSuccessful)
                throw new InvalidOperationException("Engine probe open failed: " + open.Error);
            summary.RecordEquity(bot.Server.Time, bot.Account.Balance, bot.Account.Equity);

            bot.Server.Time = closeEvent.TimeUtc;
            ApplyCloseEventMarket(bot, closeEvent, tradeType, openEvent.Ask - openEvent.Bid);
            bot.MarkToMarket();
            bool protectedCloseEvent = closeEvent.Event == "closed"
                && closeEvent.CurrentPrice.HasValue
                && (capture.StopLossPips > 0.0 || capture.TakeProfitPips > 0.0);
            bot.ProcessStopsAndTargets(protectedCloseEvent ? ProtectionFillMode.CurrentPrice : ProtectionFillMode.StopOrTargetPrice);
            if (bot.History.ClosedPositions.Count == 0 && protectedCloseEvent)
                throw new InvalidOperationException("Protected cTrader close event did not trigger in engine replay.");

            if (bot.History.ClosedPositions.Count == 0)
            {
                TradeResult close = bot.Close(open.Position);
                if (!close.IsSuccessful)
                    throw new InvalidOperationException("Engine probe close failed: " + close.Error);
            }
            summary.RecordEquity(bot.Server.Time, bot.Account.Balance, bot.Account.Equity);

            ReportWriter.WriteJson(
                reportJsonPath,
                bot,
                "CTraderExecutionProbe",
                "execution_probe_events",
                events.Count,
                summary,
                eventsCsvPath,
                0,
                0,
                Array.Empty<string>(),
                true);

            Console.WriteLine(
                "BACKTESTENGINE_EXECUTION_PROBE_REPLAY status=passed events={0} entry={1:F2} close={2:F2} pips={3:F2} commissions={4:F2} net={5:F2} balance={6:F2}",
                events.Count,
                open.Position.EntryPrice,
                open.Position.ClosePrice,
                open.Position.Pips,
                open.Position.Commissions,
                open.Position.NetProfit,
                bot.Account.Balance);

            return 0;
        }

        public static int RunProbeTicks(string eventsCsvPath, string ticksCsvPath, string reportJsonPath, string symbolSpecPath, double commissionUsdPerMillion, double slippagePips)
        {
            if (string.IsNullOrWhiteSpace(eventsCsvPath))
                throw new ArgumentException("Execution probe events path is required.", nameof(eventsCsvPath));
            if (string.IsNullOrWhiteSpace(ticksCsvPath))
                throw new ArgumentException("Execution probe ticks path is required.", nameof(ticksCsvPath));
            if (!File.Exists(eventsCsvPath))
                throw new FileNotFoundException("Execution probe events file was not found.", eventsCsvPath);
            if (!File.Exists(ticksCsvPath))
                throw new FileNotFoundException("Execution probe ticks file was not found.", ticksCsvPath);

            List<ProbeEvent> events = ProbeEvent.Load(eventsCsvPath);
            IReadOnlyList<MarketTick> ticks = TickCsvDataSource.Load(ticksCsvPath, 0);
            ProbeCapture capture = ProbeCapture.LoadForEvents(eventsCsvPath);
            if (ticks.Count == 0)
                throw new InvalidOperationException("Execution probe tick CSV did not contain any ticks.");

            ProbeEvent openProbeEvent = events.FirstOrDefault(item => item.Event == "open_filled" && !string.IsNullOrWhiteSpace(item.PositionId));
            ProbeEvent closeProbeEvent = events.FirstOrDefault(item => item.Event == "closed" && !string.IsNullOrWhiteSpace(item.PositionId));
            if (openProbeEvent == null || closeProbeEvent == null)
                throw new InvalidOperationException("Could not find cTrader open_filled/closed events in probe event file.");

            string symbol = RequiredProbeSymbol(events);
            TradeType tradeType = string.Equals(openProbeEvent.Side, "Sell", StringComparison.OrdinalIgnoreCase) ? TradeType.Sell : TradeType.Buy;

            var bot = new ExecutionSmokeBot
            {
                SymbolName = symbol,
                TimeFrame = TimeFrame.Minute,
                Symbol = { Name = symbol },
                Account =
                {
                    StartingBalance = 10000.0,
                    Balance = 10000.0,
                    Equity = 10000.0
                }
            };
            ConfigureEconomicSpec(bot, symbolSpecPath, symbol, commissionUsdPerMillion, slippagePips);

            var summary = new ReplaySummary
            {
                FirstTickTimeUtc = ticks[0].TimeUtc
            };
            TimeFrameInfo minute = TimeFrameInfo.From(TimeFrame.Minute);
            DateTime currentBarOpen = minute.GetOpenTime(ticks[0].TimeUtc);
            int barCount = 0;
            TradeResult open = null;

            foreach (MarketTick tick in ticks)
            {
                bot.Server.Time = tick.TimeUtc;
                bot.Symbol.Bid = tick.Bid;
                bot.Symbol.Ask = tick.Ask;
                bot.MarkToMarket();

                DateTime tickBarOpen = minute.GetOpenTime(tick.TimeUtc);
                if (tickBarOpen > currentBarOpen)
                {
                    currentBarOpen = tickBarOpen;
                    barCount++;
                    summary.OnBarCount++;

                    if (open == null && barCount >= capture.OpenOnBar)
                    {
                        open = bot.OpenProtected(
                            tradeType,
                            capture.VolumeInUnits > 0.0 ? capture.VolumeInUnits : 1.0,
                            capture.StopLossPips > 0.0 ? capture.StopLossPips : (double?)null,
                            capture.TakeProfitPips > 0.0 ? capture.TakeProfitPips : (double?)null);
                        if (!open.IsSuccessful)
                            throw new InvalidOperationException("Engine probe tick open failed: " + open.Error);
                    }
                }

                bot.ProcessStopsAndTargets(ProtectionFillMode.CurrentPrice);

                summary.TickCount++;
                summary.LastTickTimeUtc = tick.TimeUtc;
                summary.RecordEquity(bot.Server.Time, bot.Account.Balance, bot.Account.Equity);

                if (bot.History.ClosedPositions.Count > 0)
                    break;
                if (capture.MaxBars > 0 && barCount >= capture.MaxBars)
                    break;
            }

            if (open == null)
                throw new InvalidOperationException("Engine probe tick replay did not open a position.");
            if (bot.History.ClosedPositions.Count == 0)
                throw new InvalidOperationException("Engine probe tick replay did not close a position.");

            summary.ChartBarCount = Math.Max(1, barCount + 1);
            summary.HourBarCount = Math.Max(1, (int)Math.Ceiling(summary.ChartBarCount / 60.0));

            ReportWriter.WriteJson(
                reportJsonPath,
                bot,
                "CTraderExecutionProbe",
                "execution_probe_ticks",
                summary.TickCount,
                summary,
                ticksCsvPath,
                0,
                0,
                Array.Empty<string>(),
                true);

            Position closed = bot.History.ClosedPositions[0];
            Console.WriteLine(
                "BACKTESTENGINE_EXECUTION_PROBE_TICK_REPLAY status=passed ticks={0} bars={1} entry={2:F2} close={3:F2} pips={4:F2} commissions={5:F2} net={6:F2} balance={7:F2}",
                summary.TickCount,
                barCount,
                closed.EntryPrice,
                closed.ClosePrice,
                closed.Pips,
                closed.Commissions,
                closed.NetProfit,
                bot.Account.Balance);

            return 0;
        }

        private static string RequiredProbeSymbol(IEnumerable<ProbeEvent> events)
        {
            string symbol = events.FirstOrDefault(item => !string.IsNullOrWhiteSpace(item.Symbol))?.Symbol;
            if (string.IsNullOrWhiteSpace(symbol))
                throw new InvalidDataException("Execution probe events must record a symbol; XAU fallback is prohibited.");
            return symbol.Trim().ToUpperInvariant();
        }

        private static void ConfigureEconomicSpec(
            ExecutionSmokeBot bot,
            string symbolSpecPath,
            string requestedSymbol,
            double commissionUsdPerMillion,
            double slippagePips)
        {
            EffectiveSymbolSpecification spec = EffectiveSymbolSpecificationLoader.Load(symbolSpecPath, requestedSymbol);
            if (commissionUsdPerMillion >= 0.0)
            {
                spec = spec.WithCommissionRateOverride(
                    commissionUsdPerMillion,
                    "execution_probe_commission_override=" + commissionUsdPerMillion.ToString("R", CultureInfo.InvariantCulture));
            }
            bot.RequestedSymbolName = requestedSymbol;
            bot.SymbolSpecificationPath = Path.GetFullPath(symbolSpecPath);
            bot.Symbol.ApplyEffectiveSpecification(spec);
            bot.SymbolName = spec.Symbol;
            bot.Account.DepositAssetName = spec.AccountCurrency;
            bot.Account.DepositAssetDigits = spec.AccountCurrencyDigits;
            bot.CommissionUsdPerMillion = spec.CommissionRate;
            bot.ExecutionSlippagePips = slippagePips;
        }

        private static void ApplyCloseEventMarket(ExecutionSmokeBot bot, ProbeEvent closeEvent, TradeType tradeType, double fallbackSpread)
        {
            double spread = fallbackSpread > 0.0 ? fallbackSpread : Math.Max(0.0, closeEvent.Ask - closeEvent.Bid);
            if (closeEvent.Event == "closed" && closeEvent.CurrentPrice.HasValue)
            {
                double currentPrice = closeEvent.CurrentPrice.Value;
                if (tradeType == TradeType.Buy)
                {
                    bot.Symbol.Bid = currentPrice;
                    bot.Symbol.Ask = currentPrice + spread;
                }
                else
                {
                    bot.Symbol.Ask = currentPrice;
                    bot.Symbol.Bid = currentPrice - spread;
                }

                return;
            }

            bot.Symbol.Bid = closeEvent.Bid;
            bot.Symbol.Ask = closeEvent.Ask;
        }

        private static void AssertNear(double actual, double expected, string label)
        {
            if (Math.Abs(actual - expected) > 1e-9)
                throw new InvalidOperationException(label + " expected " + expected + " but got " + actual + ".");
        }
    }

    internal sealed class ExecutionSmokeBot : Robot
    {
        public TradeResult Open(TradeType tradeType, double volume)
        {
            return ExecuteMarketOrder(tradeType, SymbolName, volume, "SMOKE");
        }

        public TradeResult OpenProtected(TradeType tradeType, double volume, double? stopLossPips, double? takeProfitPips)
        {
            return ExecuteMarketOrder(tradeType, SymbolName, volume, "SMOKE", stopLossPips, takeProfitPips);
        }

        public TradeResult Close(Position position)
        {
            return ClosePosition(position);
        }
    }

    internal sealed class ProbeEvent
    {
        public DateTime TimeUtc { get; set; }
        public string Event { get; set; } = "";
        public string PositionId { get; set; } = "";
        public string Side { get; set; } = "";
        public string Symbol { get; set; } = "";
        public double Bid { get; set; }
        public double Ask { get; set; }
        public double? CurrentPrice { get; set; }

        public static List<ProbeEvent> Load(string path)
        {
            List<ProbeEvent> events = new List<ProbeEvent>();
            string[] lines = File.ReadAllLines(path);
            if (lines.Length <= 1)
                return events;

            string[] headers = SplitCsvLine(lines[0]).ToArray();
            Dictionary<string, int> index = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < headers.Length; i++)
                index[headers[i]] = i;

            foreach (string line in lines.Skip(1))
            {
                if (string.IsNullOrWhiteSpace(line))
                    continue;

                string[] parts = SplitCsvLine(line).ToArray();
                events.Add(new ProbeEvent
                {
                    TimeUtc = DateTime.Parse(Value(parts, index, "time_utc"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal),
                    Event = Value(parts, index, "event"),
                    PositionId = Value(parts, index, "position_id"),
                    Side = Value(parts, index, "side"),
                    Symbol = Value(parts, index, "symbol"),
                    Bid = ParseDouble(Value(parts, index, "bid")),
                    Ask = ParseDouble(Value(parts, index, "ask")),
                    CurrentPrice = ParseNullableDouble(Value(parts, index, "current_price"))
                });
            }

            return events;
        }

        private static IEnumerable<string> SplitCsvLine(string line)
        {
            List<string> values = new List<string>();
            bool inQuotes = false;
            string current = "";

            for (int i = 0; i < line.Length; i++)
            {
                char ch = line[i];
                if (ch == '"')
                {
                    if (inQuotes && i + 1 < line.Length && line[i + 1] == '"')
                    {
                        current += '"';
                        i++;
                    }
                    else
                    {
                        inQuotes = !inQuotes;
                    }
                }
                else if (ch == ',' && !inQuotes)
                {
                    values.Add(current);
                    current = "";
                }
                else
                {
                    current += ch;
                }
            }

            values.Add(current);
            return values;
        }

        private static string Value(string[] parts, Dictionary<string, int> index, string name)
        {
            if (!index.TryGetValue(name, out int i) || i < 0 || i >= parts.Length)
                return "";
            return parts[i];
        }

        private static double ParseDouble(string value)
        {
            return string.IsNullOrWhiteSpace(value) ? 0.0 : double.Parse(value, NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        private static double? ParseNullableDouble(string value)
        {
            return string.IsNullOrWhiteSpace(value) ? (double?)null : double.Parse(value, NumberStyles.Float, CultureInfo.InvariantCulture);
        }
    }

    internal sealed class ProbeCapture
    {
        public double VolumeInUnits { get; set; } = 1.0;
        public double StopLossPips { get; set; }
        public double TakeProfitPips { get; set; }
        public int OpenOnBar { get; set; } = 1;
        public int MaxBars { get; set; }

        public static ProbeCapture LoadForEvents(string eventsCsvPath)
        {
            string directory = Path.GetDirectoryName(Path.GetFullPath(eventsCsvPath)) ?? "";
            string capturePath = Path.Combine(directory, "execution_probe.json");
            if (!File.Exists(capturePath))
                return new ProbeCapture();

            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(capturePath));
            JsonElement root = document.RootElement;
            return new ProbeCapture
            {
                VolumeInUnits = GetDouble(root, "volume_in_units", 1.0),
                StopLossPips = GetDouble(root, "stop_loss_pips", 0.0),
                TakeProfitPips = GetDouble(root, "take_profit_pips", 0.0),
                OpenOnBar = GetInt(root, "open_on_bar", 1),
                MaxBars = GetInt(root, "max_bars", 0)
            };
        }

        private static double GetDouble(JsonElement root, string name, double fallback)
        {
            if (root.TryGetProperty(name, out JsonElement element) && element.ValueKind == JsonValueKind.Number)
                return element.GetDouble();
            return fallback;
        }

        private static int GetInt(JsonElement root, string name, int fallback)
        {
            if (root.TryGetProperty(name, out JsonElement element) && element.ValueKind == JsonValueKind.Number)
                return element.GetInt32();
            return fallback;
        }
    }
}
