using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace BacktestEngine.ReportComparator
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            try
            {
                ComparatorOptions options = ComparatorOptions.Parse(args);
                ReportSnapshot cTrader = ReportSnapshot.FromCTrader(options.CTraderReportPath);
                ReportSnapshot engine = ReportSnapshot.FromEngine(options.EngineReportPath);
                ComparisonReport report = ReportComparer.Compare(options, cTrader, engine);
                ComparisonReportWriter.Write(options.OutputPath, report);

                Console.WriteLine(
                    "BACKTESTENGINE_COMPARE status={0} passed={1} failed={2} skipped={3} output={4}",
                    report.Passed ? "passed" : "failed",
                    report.PassedCount,
                    report.FailedCount,
                    report.SkippedCount,
                    Path.GetFullPath(options.OutputPath));

                return report.Passed ? 0 : 2;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("BACKTESTENGINE_COMPARE_ERROR " + ex.Message);
                return 1;
            }
        }
    }

    internal sealed class ComparatorOptions
    {
        public string CTraderReportPath { get; set; } = "";
        public string EngineReportPath { get; set; } = "";
        public string OutputPath { get; set; } = "";
        public double MoneyTolerance { get; set; } = 0.01;
        public double PriceTolerance { get; set; } = 0.01;
        public double VolumeTolerance { get; set; } = 0.000001;
        public double PipTolerance { get; set; } = 0.01;
        public double PercentTolerance { get; set; } = 0.000001;
        public double ProfitFactorTolerance { get; set; } = 0.01;

        public static ComparatorOptions Parse(string[] args)
        {
            ComparatorOptions options = new ComparatorOptions();
            Queue<string> tokens = new Queue<string>(args ?? Array.Empty<string>());

            while (tokens.Count > 0)
            {
                string token = tokens.Dequeue();
                switch (token)
                {
                    case "--ctrader":
                        options.CTraderReportPath = RequireValue(token, tokens);
                        break;
                    case "--engine":
                        options.EngineReportPath = RequireValue(token, tokens);
                        break;
                    case "--out":
                        options.OutputPath = RequireValue(token, tokens);
                        break;
                    case "--money-tolerance":
                        options.MoneyTolerance = double.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                        break;
                    case "--price-tolerance":
                        options.PriceTolerance = double.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                        break;
                    case "--volume-tolerance":
                        options.VolumeTolerance = double.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                        break;
                    case "--pip-tolerance":
                        options.PipTolerance = double.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                        break;
                    case "--percent-tolerance":
                        options.PercentTolerance = double.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                        break;
                    case "--profit-factor-tolerance":
                        options.ProfitFactorTolerance = double.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
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

            if (string.IsNullOrWhiteSpace(options.CTraderReportPath))
                throw new ArgumentException("--ctrader is required.");
            if (string.IsNullOrWhiteSpace(options.EngineReportPath))
                throw new ArgumentException("--engine is required.");
            if (string.IsNullOrWhiteSpace(options.OutputPath))
                throw new ArgumentException("--out is required.");

            return options;
        }

        private static string RequireValue(string option, Queue<string> tokens)
        {
            if (tokens.Count == 0)
                throw new ArgumentException(option + " requires a value.");
            return tokens.Dequeue();
        }

        private static void PrintHelp()
        {
            Console.WriteLine("BacktestEngine.ReportComparator");
            Console.WriteLine("  --ctrader <report.json>    cTrader CLI report JSON");
            Console.WriteLine("  --engine <report.json>     BacktestEngine report JSON");
            Console.WriteLine("  --out <parity.json>        Comparison output path");
            Console.WriteLine("  --money-tolerance <n>      Absolute tolerance for money values");
            Console.WriteLine("  --price-tolerance <n>      Absolute tolerance for entry/exit prices");
            Console.WriteLine("  --volume-tolerance <n>     Absolute tolerance for volume values");
            Console.WriteLine("  --pip-tolerance <n>        Absolute tolerance for pips values");
            Console.WriteLine("  --percent-tolerance <n>    Absolute tolerance for percent values");
        }
    }

    internal sealed class ReportSnapshot
    {
        public string SourceKind { get; set; } = "";
        public string SourcePath { get; set; } = "";
        public string StrategyName { get; set; } = "";
        public string Symbol { get; set; } = "";
        public string Period { get; set; } = "";
        public double? StartingCapital { get; set; }
        public double? EndingBalance { get; set; }
        public double? EndingEquity { get; set; }
        public double? NetProfit { get; set; }
        public double? ProfitFactor { get; set; }
        public int? TotalTrades { get; set; }
        public int? WinningTrades { get; set; }
        public int? LosingTrades { get; set; }
        public int? LongTrades { get; set; }
        public int? ShortTrades { get; set; }
        public double? MaxBalanceDrawdown { get; set; }
        public double? MaxBalanceDrawdownPercent { get; set; }
        public double? MaxEquityDrawdown { get; set; }
        public double? MaxEquityDrawdownPercent { get; set; }
        public List<TradeRecord> Trades { get; set; } = new List<TradeRecord>();

        public static ReportSnapshot FromCTrader(string path)
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
            JsonElement root = document.RootElement;

            return new ReportSnapshot
            {
                SourceKind = "ctrader",
                SourcePath = Path.GetFullPath(path),
                StrategyName = GetString(root, "main.cBotName"),
                Symbol = GetString(root, "main.symbol"),
                Period = NormalizePeriod(GetString(root, "main.period")),
                StartingCapital = GetDouble(root, "main.startingCapital"),
                EndingBalance = GetDouble(root, "main.endingBalance"),
                EndingEquity = GetDouble(root, "main.endingEquity"),
                NetProfit = GetDouble(root, "main.netProfit") ?? GetDouble(root, "tradeStatistics.netProfit.all"),
                ProfitFactor = GetDouble(root, "tradeStatistics.profitFactor.all"),
                TotalTrades = GetInt(root, "tradeStatistics.totalTrades.all"),
                WinningTrades = GetInt(root, "tradeStatistics.winningTrades.all"),
                LosingTrades = GetInt(root, "tradeStatistics.losingTrades.all"),
                LongTrades = GetInt(root, "tradeStatistics.totalTrades.long"),
                ShortTrades = GetInt(root, "tradeStatistics.totalTrades.short"),
                MaxBalanceDrawdown = GetDouble(root, "equity.maxBalanceDrawdownAbsolute"),
                MaxBalanceDrawdownPercent = GetDouble(root, "equity.maxBalanceDrawdownPercent"),
                MaxEquityDrawdown = GetDouble(root, "equity.maxEquityDrawdownAbsolute"),
                MaxEquityDrawdownPercent = GetDouble(root, "equity.maxEquityDrawdownPercent"),
                Trades = ReadCTraderHistory(root)
            };
        }

        public static ReportSnapshot FromEngine(string path)
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
            JsonElement root = document.RootElement;

            return new ReportSnapshot
            {
                SourceKind = "engine",
                SourcePath = Path.GetFullPath(path),
                StrategyName = GetString(root, "strategy"),
                Symbol = GetString(root, "symbol"),
                Period = NormalizePeriod(GetString(root, "period")),
                StartingCapital = GetDouble(root, "account.starting_capital"),
                EndingBalance = GetDouble(root, "account.balance"),
                EndingEquity = GetDouble(root, "account.equity"),
                NetProfit = GetDouble(root, "trade_statistics.net_profit"),
                ProfitFactor = GetDouble(root, "trade_statistics.profit_factor"),
                TotalTrades = GetInt(root, "trade_statistics.total_trades"),
                WinningTrades = GetInt(root, "trade_statistics.winning_trades"),
                LosingTrades = GetInt(root, "trade_statistics.losing_trades"),
                LongTrades = GetInt(root, "trade_statistics.long_trades"),
                ShortTrades = GetInt(root, "trade_statistics.short_trades"),
                MaxBalanceDrawdown = GetDouble(root, "drawdown.max_balance_drawdown"),
                MaxBalanceDrawdownPercent = GetDouble(root, "drawdown.max_balance_drawdown_percent"),
                MaxEquityDrawdown = GetDouble(root, "drawdown.max_equity_drawdown"),
                MaxEquityDrawdownPercent = GetDouble(root, "drawdown.max_equity_drawdown_percent"),
                Trades = ReadEngineTrades(root)
            };
        }

        private static string NormalizePeriod(string period)
        {
            return (period ?? "").Trim().ToLowerInvariant();
        }

        private static string GetString(JsonElement root, string path)
        {
            if (TryGet(root, path, out JsonElement element) && element.ValueKind == JsonValueKind.String)
                return element.GetString() ?? "";
            return "";
        }

        private static double? GetDouble(JsonElement root, string path)
        {
            if (!TryGet(root, path, out JsonElement element))
                return null;
            if (element.ValueKind == JsonValueKind.Null)
                return null;
            if (element.ValueKind == JsonValueKind.Number)
                return element.GetDouble();
            if (element.ValueKind == JsonValueKind.String
                && double.TryParse(element.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double value))
            {
                return value;
            }
            return null;
        }

        private static int? GetInt(JsonElement root, string path)
        {
            double? value = GetDouble(root, path);
            return value.HasValue ? (int)Math.Round(value.Value) : null;
        }

        private static bool TryGet(JsonElement root, string path, out JsonElement element)
        {
            element = root;
            foreach (string segment in path.Split('.'))
            {
                if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(segment, out element))
                    return false;
            }
            return true;
        }

        private static List<TradeRecord> ReadCTraderHistory(JsonElement root)
        {
            List<TradeRecord> trades = new List<TradeRecord>();
            if (!TryGet(root, "history.columns", out JsonElement columnsElement)
                || !TryGet(root, "history.items", out JsonElement itemsElement)
                || columnsElement.ValueKind != JsonValueKind.Array
                || itemsElement.ValueKind != JsonValueKind.Array)
            {
                return trades;
            }

            string[] columns = columnsElement.EnumerateArray()
                .Select(column => column.GetString() ?? "")
                .ToArray();
            Dictionary<string, int> indexByColumn = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < columns.Length; i++)
                indexByColumn[columns[i]] = i;

            foreach (JsonElement item in itemsElement.EnumerateArray())
            {
                trades.Add(new TradeRecord
                {
                    Id = ReadStringField(item, indexByColumn, "id"),
                    Symbol = ReadStringField(item, indexByColumn, "symbol"),
                    Side = NormalizeSide(ReadStringField(item, indexByColumn, "direction")),
                    Volume = ReadDoubleField(item, indexByColumn, "volume"),
                    EntryTimeUtc = ReadDateTimeField(item, indexByColumn, "entryTime"),
                    CloseTimeUtc = ReadDateTimeField(item, indexByColumn, "closeTime"),
                    EntryPrice = ReadDoubleField(item, indexByColumn, "entryPrice"),
                    ClosePrice = ReadDoubleField(item, indexByColumn, "closePrice"),
                    Pips = ReadDoubleField(item, indexByColumn, "pips"),
                    GrossProfit = ReadDoubleField(item, indexByColumn, "gross"),
                    Commissions = ReadDoubleField(item, indexByColumn, "commissions"),
                    Swaps = ReadDoubleField(item, indexByColumn, "swaps"),
                    NetProfit = ReadDoubleField(item, indexByColumn, "net")
                });
            }

            return trades;
        }

        private static List<TradeRecord> ReadEngineTrades(JsonElement root)
        {
            List<TradeRecord> trades = new List<TradeRecord>();
            if (!TryGet(root, "trades", out JsonElement tradesElement) || tradesElement.ValueKind != JsonValueKind.Array)
                return trades;

            foreach (JsonElement item in tradesElement.EnumerateArray())
            {
                trades.Add(new TradeRecord
                {
                    Id = GetRawString(item, "id"),
                    Symbol = GetString(item, "symbol"),
                    Side = NormalizeSide(GetString(item, "side")),
                    Volume = GetDouble(item, "volume_in_units"),
                    EntryTimeUtc = GetDateTime(item, "entry_time_utc"),
                    CloseTimeUtc = GetDateTime(item, "close_time_utc"),
                    EntryPrice = GetDouble(item, "entry_price"),
                    ClosePrice = GetDouble(item, "close_price"),
                    Pips = GetDouble(item, "pips"),
                    GrossProfit = GetDouble(item, "gross_profit"),
                    Commissions = GetDouble(item, "commissions"),
                    Swaps = GetDouble(item, "swaps"),
                    NetProfit = GetDouble(item, "net_profit")
                });
            }

            return trades;
        }

        private static string ReadStringField(JsonElement item, Dictionary<string, int> indexByColumn, string column)
        {
            if (TryGetColumn(item, indexByColumn, column, out JsonElement value))
                return ElementToString(value);
            return "";
        }

        private static double? ReadDoubleField(JsonElement item, Dictionary<string, int> indexByColumn, string column)
        {
            if (!TryGetColumn(item, indexByColumn, column, out JsonElement value))
                return null;
            return ElementToDouble(value);
        }

        private static DateTime? ReadDateTimeField(JsonElement item, Dictionary<string, int> indexByColumn, string column)
        {
            if (!TryGetColumn(item, indexByColumn, column, out JsonElement value))
                return null;
            return ElementToDateTime(value);
        }

        private static bool TryGetColumn(JsonElement item, Dictionary<string, int> indexByColumn, string column, out JsonElement value)
        {
            value = default;
            if (item.ValueKind == JsonValueKind.Object)
                return item.TryGetProperty(column, out value);
            if (item.ValueKind != JsonValueKind.Array || !indexByColumn.TryGetValue(column, out int index))
                return false;
            if (index < 0 || index >= item.GetArrayLength())
                return false;
            value = item[index];
            return true;
        }

        private static string GetRawString(JsonElement root, string path)
        {
            if (!TryGet(root, path, out JsonElement element))
                return "";
            return ElementToString(element);
        }

        private static DateTime? GetDateTime(JsonElement root, string path)
        {
            if (!TryGet(root, path, out JsonElement element))
                return null;
            return ElementToDateTime(element);
        }

        private static string ElementToString(JsonElement element)
        {
            return element.ValueKind switch
            {
                JsonValueKind.String => element.GetString() ?? "",
                JsonValueKind.Number => element.GetRawText(),
                JsonValueKind.True => "true",
                JsonValueKind.False => "false",
                _ => ""
            };
        }

        private static double? ElementToDouble(JsonElement element)
        {
            if (element.ValueKind == JsonValueKind.Number)
                return element.GetDouble();
            if (element.ValueKind == JsonValueKind.String
                && double.TryParse(element.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double value))
            {
                return value;
            }
            return null;
        }

        private static DateTime? ElementToDateTime(JsonElement element)
        {
            if (element.ValueKind == JsonValueKind.Number)
            {
                long milliseconds = element.GetInt64();
                return DateTimeOffset.FromUnixTimeMilliseconds(milliseconds).UtcDateTime;
            }

            if (element.ValueKind == JsonValueKind.String
                && DateTime.TryParse(
                    element.GetString(),
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out DateTime value))
            {
                return value;
            }

            return null;
        }

        private static string NormalizeSide(string side)
        {
            string normalized = (side ?? "").Trim().ToLowerInvariant();
            if (normalized == "buy" || normalized == "long")
                return "Buy";
            if (normalized == "sell" || normalized == "short")
                return "Sell";
            return side ?? "";
        }
    }

    internal sealed class TradeRecord
    {
        public string Id { get; set; } = "";
        public string Symbol { get; set; } = "";
        public string Side { get; set; } = "";
        public double? Volume { get; set; }
        public DateTime? EntryTimeUtc { get; set; }
        public DateTime? CloseTimeUtc { get; set; }
        public double? EntryPrice { get; set; }
        public double? ClosePrice { get; set; }
        public double? Pips { get; set; }
        public double? GrossProfit { get; set; }
        public double? Commissions { get; set; }
        public double? Swaps { get; set; }
        public double? NetProfit { get; set; }
    }

    internal static class ReportComparer
    {
        public static ComparisonReport Compare(ComparatorOptions options, ReportSnapshot cTrader, ReportSnapshot engine)
        {
            List<MetricComparison> metrics = new List<MetricComparison>
            {
                ExactString("symbol", cTrader.Symbol, engine.Symbol, "high"),
                ExactString("period", cTrader.Period, engine.Period, "high"),
                Numeric("starting_capital", cTrader.StartingCapital, engine.StartingCapital, options.MoneyTolerance, "high"),
                Numeric("ending_balance", cTrader.EndingBalance, engine.EndingBalance, options.MoneyTolerance, "high"),
                Numeric("ending_equity", cTrader.EndingEquity, engine.EndingEquity, options.MoneyTolerance, "high"),
                Numeric("net_profit", cTrader.NetProfit, engine.NetProfit, options.MoneyTolerance, "high"),
                ProfitFactor(
                    "profit_factor",
                    cTrader.ProfitFactor,
                    engine.ProfitFactor,
                    cTrader.TotalTrades,
                    engine.TotalTrades,
                    cTrader.LosingTrades,
                    engine.LosingTrades,
                    options.ProfitFactorTolerance),
                Integer("total_trades", cTrader.TotalTrades, engine.TotalTrades, "high"),
                Integer("winning_trades", cTrader.WinningTrades, engine.WinningTrades, "high"),
                Integer("losing_trades", cTrader.LosingTrades, engine.LosingTrades, "high"),
                Integer("long_trades", cTrader.LongTrades, engine.LongTrades, "medium"),
                Integer("short_trades", cTrader.ShortTrades, engine.ShortTrades, "medium"),
                Numeric("max_balance_drawdown", cTrader.MaxBalanceDrawdown, engine.MaxBalanceDrawdown, options.MoneyTolerance, "medium"),
                Numeric("max_balance_drawdown_percent", cTrader.MaxBalanceDrawdownPercent, engine.MaxBalanceDrawdownPercent, options.PercentTolerance, "medium"),
                Numeric("max_equity_drawdown", cTrader.MaxEquityDrawdown, engine.MaxEquityDrawdown, options.MoneyTolerance, "medium"),
                Numeric("max_equity_drawdown_percent", cTrader.MaxEquityDrawdownPercent, engine.MaxEquityDrawdownPercent, options.PercentTolerance, "medium"),
                InfoString("strategy_name", cTrader.StrategyName, engine.StrategyName)
            };
            AddTradeComparisons(metrics, options, cTrader.Trades, engine.Trades);

            return new ComparisonReport
            {
                GeneratedAtUtc = DateTime.UtcNow,
                CTraderReport = cTrader.SourcePath,
                EngineReport = engine.SourcePath,
                Passed = metrics.All(metric => metric.Status != "fail"),
                Metrics = metrics
            };
        }

        private static MetricComparison ExactString(string name, string cTrader, string engine, string severity)
        {
            bool passed = string.Equals(cTrader ?? "", engine ?? "", StringComparison.OrdinalIgnoreCase);
            return new MetricComparison
            {
                Name = name,
                Status = passed ? "pass" : "fail",
                Severity = severity,
                CTrader = cTrader ?? "",
                Engine = engine ?? "",
                Notes = passed ? "" : "exact string mismatch"
            };
        }

        private static MetricComparison InfoString(string name, string cTrader, string engine)
        {
            return new MetricComparison
            {
                Name = name,
                Status = "info",
                Severity = "info",
                CTrader = cTrader ?? "",
                Engine = engine ?? "",
                Notes = "informational only because fixture may use a diagnostic cBot"
            };
        }

        private static MetricComparison Integer(string name, int? cTrader, int? engine, string severity)
        {
            if (!cTrader.HasValue || !engine.HasValue)
                return Skipped(name, cTrader?.ToString(CultureInfo.InvariantCulture), engine?.ToString(CultureInfo.InvariantCulture), "missing integer value");

            bool passed = cTrader.Value == engine.Value;
            return new MetricComparison
            {
                Name = name,
                Status = passed ? "pass" : "fail",
                Severity = severity,
                CTrader = cTrader.Value,
                Engine = engine.Value,
                Difference = Math.Abs(cTrader.Value - engine.Value),
                Tolerance = 0,
                Notes = passed ? "" : "integer mismatch"
            };
        }

        private static MetricComparison Numeric(string name, double? cTrader, double? engine, double tolerance, string severity)
        {
            if (!cTrader.HasValue || !engine.HasValue)
                return Skipped(name, cTrader, engine, "missing numeric value");

            double difference = Math.Abs(cTrader.Value - engine.Value);
            bool passed = difference <= tolerance;
            return new MetricComparison
            {
                Name = name,
                Status = passed ? "pass" : "fail",
                Severity = severity,
                CTrader = cTrader.Value,
                Engine = engine.Value,
                Difference = difference,
                Tolerance = tolerance,
                Notes = passed ? "" : "numeric mismatch outside tolerance"
            };
        }

        private static MetricComparison ProfitFactor(
            string name,
            double? cTrader,
            double? engine,
            int? cTraderTrades,
            int? engineTrades,
            int? cTraderLosingTrades,
            int? engineLosingTrades,
            double tolerance)
        {
            bool noTrades = cTraderTrades.GetValueOrDefault() == 0 && engineTrades.GetValueOrDefault() == 0;
            if (noTrades)
            {
                return new MetricComparison
                {
                    Name = name,
                    Status = "pass",
                    Severity = "medium",
                    CTrader = cTrader,
                    Engine = engine,
                    Difference = 0,
                    Tolerance = tolerance,
                    Notes = "no-trade profit factor treated as equivalent"
                };
            }

            bool noLosingTrades = cTraderLosingTrades.GetValueOrDefault() == 0 && engineLosingTrades.GetValueOrDefault() == 0;
            if (noLosingTrades)
            {
                return new MetricComparison
                {
                    Name = name,
                    Status = "pass",
                    Severity = "medium",
                    CTrader = cTrader,
                    Engine = engine,
                    Difference = 0,
                    Tolerance = tolerance,
                    Notes = "no-loss profit factor sentinel treated as equivalent"
                };
            }

            return Numeric(name, cTrader, engine, tolerance, "medium");
        }

        private static void AddTradeComparisons(
            List<MetricComparison> metrics,
            ComparatorOptions options,
            IReadOnlyList<TradeRecord> cTraderTrades,
            IReadOnlyList<TradeRecord> engineTrades)
        {
            int count = Math.Min(cTraderTrades.Count, engineTrades.Count);
            for (int i = 0; i < count; i++)
            {
                TradeRecord cTrader = cTraderTrades[i];
                TradeRecord engine = engineTrades[i];
                string prefix = "trade[" + i.ToString(CultureInfo.InvariantCulture) + "].";

                metrics.Add(ExactString(prefix + "symbol", cTrader.Symbol, engine.Symbol, "high"));
                metrics.Add(ExactString(prefix + "side", cTrader.Side, engine.Side, "high"));
                metrics.Add(Numeric(prefix + "volume", cTrader.Volume, engine.Volume, options.VolumeTolerance, "high"));
                metrics.Add(DateTimeMetric(prefix + "entry_time_utc", cTrader.EntryTimeUtc, engine.EntryTimeUtc, TimeSpan.FromSeconds(1), "medium"));
                metrics.Add(DateTimeMetric(prefix + "close_time_utc", cTrader.CloseTimeUtc, engine.CloseTimeUtc, TimeSpan.FromSeconds(1), "medium"));
                metrics.Add(Numeric(prefix + "entry_price", cTrader.EntryPrice, engine.EntryPrice, options.PriceTolerance, "high"));
                metrics.Add(Numeric(prefix + "close_price", cTrader.ClosePrice, engine.ClosePrice, options.PriceTolerance, "high"));
                metrics.Add(Numeric(prefix + "pips", cTrader.Pips, engine.Pips, options.PipTolerance, "high"));
                metrics.Add(Numeric(prefix + "gross_profit", cTrader.GrossProfit, engine.GrossProfit, options.MoneyTolerance, "high"));
                metrics.Add(Numeric(prefix + "commissions", cTrader.Commissions, engine.Commissions, options.MoneyTolerance, "medium"));
                metrics.Add(Numeric(prefix + "swaps", cTrader.Swaps, engine.Swaps, options.MoneyTolerance, "medium"));
                metrics.Add(Numeric(prefix + "net_profit", cTrader.NetProfit, engine.NetProfit, options.MoneyTolerance, "high"));
            }
        }

        private static MetricComparison DateTimeMetric(string name, DateTime? cTrader, DateTime? engine, TimeSpan tolerance, string severity)
        {
            if (!cTrader.HasValue || !engine.HasValue)
                return Skipped(name, cTrader?.ToString("o", CultureInfo.InvariantCulture), engine?.ToString("o", CultureInfo.InvariantCulture), "missing datetime value");

            double differenceSeconds = Math.Abs((cTrader.Value - engine.Value).TotalSeconds);
            bool passed = differenceSeconds <= tolerance.TotalSeconds;
            return new MetricComparison
            {
                Name = name,
                Status = passed ? "pass" : "fail",
                Severity = severity,
                CTrader = cTrader.Value,
                Engine = engine.Value,
                Difference = differenceSeconds,
                Tolerance = tolerance.TotalSeconds,
                Notes = passed ? "" : "datetime mismatch outside tolerance"
            };
        }

        private static MetricComparison Skipped(string name, object cTrader, object engine, string notes)
        {
            return new MetricComparison
            {
                Name = name,
                Status = "skip",
                Severity = "unknown",
                CTrader = cTrader,
                Engine = engine,
                Notes = notes
            };
        }
    }

    internal sealed class ComparisonReport
    {
        public DateTime GeneratedAtUtc { get; set; }
        public string CTraderReport { get; set; } = "";
        public string EngineReport { get; set; } = "";
        public bool Passed { get; set; }
        public List<MetricComparison> Metrics { get; set; } = new List<MetricComparison>();
        public int PassedCount { get { return Metrics.Count(metric => metric.Status == "pass"); } }
        public int FailedCount { get { return Metrics.Count(metric => metric.Status == "fail"); } }
        public int SkippedCount { get { return Metrics.Count(metric => metric.Status == "skip"); } }
    }

    internal sealed class MetricComparison
    {
        public string Name { get; set; } = "";
        public string Status { get; set; } = "";
        public string Severity { get; set; } = "";
        public object CTrader { get; set; }
        public object Engine { get; set; }
        public double? Difference { get; set; }
        public double? Tolerance { get; set; }
        public string Notes { get; set; } = "";
    }

    internal static class ComparisonReportWriter
    {
        public static void Write(string path, ComparisonReport report)
        {
            string fullPath = Path.GetFullPath(path);
            string directory = Path.GetDirectoryName(fullPath);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);

            var options = new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
                WriteIndented = true
            };
            File.WriteAllText(fullPath, JsonSerializer.Serialize(report, options));
        }
    }
}
