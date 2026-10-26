using System.Globalization;
using System.Text.Json;

namespace BacktestEngine.MonteCarlo;

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
            CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;

            Options options = Options.Parse(args);
            BacktestInput input = BacktestInput.Load(options.ReportPath);
            MonteCarloReport report = MonteCarloRunner.Run(input, options);
            MonteCarloWriter.Write(options.OutputPath, report);

            Console.WriteLine(
                "BACKTESTENGINE_MONTE_CARLO simulations={0} trades={1} medianNet={2:F2} p05Net={3:F2} p95MaxDdPct={4:F2} output={5}",
                report.Simulations,
                report.TradesPerSimulation,
                report.NetProfit.Percentile50,
                report.NetProfit.Percentile05,
                report.MaxDrawdownPercent.Percentile95,
                Path.GetFullPath(options.OutputPath));
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("BACKTESTENGINE_MONTE_CARLO_ERROR " + ex.Message);
            return 1;
        }
    }
}

internal sealed class Options
{
    public string ReportPath { get; set; } = "";
    public string OutputPath { get; set; } = "";
    public int Simulations { get; set; } = 1000;
    public int TradesPerSimulation { get; set; } = 0;
    public int Seed { get; set; } = 42;
    public double StartingBalance { get; set; } = double.NaN;

    public static Options Parse(string[] args)
    {
        Options options = new Options();
        Queue<string> tokens = new Queue<string>(args ?? Array.Empty<string>());
        while (tokens.Count > 0)
        {
            string token = tokens.Dequeue();
            switch (token)
            {
                case "--report":
                case "--report-json":
                    options.ReportPath = RequireValue(token, tokens);
                    break;
                case "--out":
                    options.OutputPath = RequireValue(token, tokens);
                    break;
                case "--simulations":
                    options.Simulations = int.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                    break;
                case "--trades":
                case "--trades-per-simulation":
                    options.TradesPerSimulation = int.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                    break;
                case "--seed":
                    options.Seed = int.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
                    break;
                case "--balance":
                case "--starting-balance":
                    options.StartingBalance = double.Parse(RequireValue(token, tokens), CultureInfo.InvariantCulture);
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

        if (string.IsNullOrWhiteSpace(options.ReportPath))
            throw new ArgumentException("--report is required.");
        if (string.IsNullOrWhiteSpace(options.OutputPath))
            throw new ArgumentException("--out is required.");
        if (options.Simulations <= 0)
            throw new ArgumentException("--simulations must be positive.");
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
        Console.WriteLine("BacktestEngine.MonteCarlo");
        Console.WriteLine("  --report <engine-report.json>");
        Console.WriteLine("  --out <monte-carlo.json>");
        Console.WriteLine("  --simulations <n>");
        Console.WriteLine("  --trades-per-simulation <n>");
        Console.WriteLine("  --seed <n>");
        Console.WriteLine("  --balance <n>");
    }
}

internal sealed class BacktestInput
{
    public double StartingBalance { get; set; }
    public List<double> TradeNetProfits { get; set; } = new List<double>();

    public static BacktestInput Load(string path)
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        JsonElement root = document.RootElement;
        double startingBalance = GetDouble(root, "account.starting_capital") ?? 10000.0;
        List<double> trades = new List<double>();
        if (TryGet(root, "trades", out JsonElement tradesElement) && tradesElement.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement trade in tradesElement.EnumerateArray())
            {
                if (trade.TryGetProperty("net_profit", out JsonElement net) && net.ValueKind == JsonValueKind.Number)
                    trades.Add(net.GetDouble());
            }
        }

        if (trades.Count == 0)
            throw new InvalidOperationException("Report has no closed trades to resample.");

        return new BacktestInput
        {
            StartingBalance = startingBalance,
            TradeNetProfits = trades
        };
    }

    private static double? GetDouble(JsonElement root, string path)
    {
        if (!TryGet(root, path, out JsonElement element) || element.ValueKind != JsonValueKind.Number)
            return null;
        return element.GetDouble();
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
}

internal static class MonteCarloRunner
{
    public static MonteCarloReport Run(BacktestInput input, Options options)
    {
        Random random = new Random(options.Seed);
        int tradesPerSimulation = options.TradesPerSimulation > 0 ? options.TradesPerSimulation : input.TradeNetProfits.Count;
        double startingBalance = double.IsNaN(options.StartingBalance) ? input.StartingBalance : options.StartingBalance;
        List<SimulationResult> results = new List<SimulationResult>();

        for (int i = 0; i < options.Simulations; i++)
        {
            double balance = startingBalance;
            double peak = startingBalance;
            double maxDrawdown = 0.0;
            int wins = 0;

            for (int tradeIndex = 0; tradeIndex < tradesPerSimulation; tradeIndex++)
            {
                double net = input.TradeNetProfits[random.Next(input.TradeNetProfits.Count)];
                if (net > 0.0)
                    wins++;
                balance += net;
                peak = Math.Max(peak, balance);
                maxDrawdown = Math.Max(maxDrawdown, peak - balance);
            }

            results.Add(new SimulationResult
            {
                NetProfit = balance - startingBalance,
                EndingBalance = balance,
                MaxDrawdown = maxDrawdown,
                MaxDrawdownPercent = peak > 0.0 ? maxDrawdown / peak * 100.0 : 0.0,
                WinRate = tradesPerSimulation > 0 ? wins * 100.0 / tradesPerSimulation : 0.0
            });
        }

        return new MonteCarloReport
        {
            GeneratedAtUtc = DateTime.UtcNow,
            Simulations = options.Simulations,
            TradesPerSimulation = tradesPerSimulation,
            Seed = options.Seed,
            StartingBalance = startingBalance,
            SourceTradeCount = input.TradeNetProfits.Count,
            NetProfit = Distribution.From(results.Select(result => result.NetProfit)),
            EndingBalance = Distribution.From(results.Select(result => result.EndingBalance)),
            MaxDrawdown = Distribution.From(results.Select(result => result.MaxDrawdown)),
            MaxDrawdownPercent = Distribution.From(results.Select(result => result.MaxDrawdownPercent)),
            WinRate = Distribution.From(results.Select(result => result.WinRate))
        };
    }
}

internal sealed class SimulationResult
{
    public double NetProfit { get; set; }
    public double EndingBalance { get; set; }
    public double MaxDrawdown { get; set; }
    public double MaxDrawdownPercent { get; set; }
    public double WinRate { get; set; }
}

internal sealed class MonteCarloReport
{
    public DateTime GeneratedAtUtc { get; set; }
    public int Simulations { get; set; }
    public int TradesPerSimulation { get; set; }
    public int Seed { get; set; }
    public double StartingBalance { get; set; }
    public int SourceTradeCount { get; set; }
    public Distribution NetProfit { get; set; } = new Distribution();
    public Distribution EndingBalance { get; set; } = new Distribution();
    public Distribution MaxDrawdown { get; set; } = new Distribution();
    public Distribution MaxDrawdownPercent { get; set; } = new Distribution();
    public Distribution WinRate { get; set; } = new Distribution();
}

internal sealed class Distribution
{
    public double Minimum { get; set; }
    public double Percentile05 { get; set; }
    public double Percentile25 { get; set; }
    public double Percentile50 { get; set; }
    public double Percentile75 { get; set; }
    public double Percentile95 { get; set; }
    public double Maximum { get; set; }
    public double Mean { get; set; }

    public static Distribution From(IEnumerable<double> values)
    {
        double[] sorted = values.OrderBy(value => value).ToArray();
        if (sorted.Length == 0)
            return new Distribution();

        return new Distribution
        {
            Minimum = sorted[0],
            Percentile05 = Percentile(sorted, 0.05),
            Percentile25 = Percentile(sorted, 0.25),
            Percentile50 = Percentile(sorted, 0.50),
            Percentile75 = Percentile(sorted, 0.75),
            Percentile95 = Percentile(sorted, 0.95),
            Maximum = sorted[^1],
            Mean = sorted.Average()
        };
    }

    private static double Percentile(double[] sorted, double p)
    {
        if (sorted.Length == 1)
            return sorted[0];
        double index = (sorted.Length - 1) * p;
        int lower = (int)Math.Floor(index);
        int upper = (int)Math.Ceiling(index);
        if (lower == upper)
            return sorted[lower];
        double weight = index - lower;
        return sorted[lower] * (1.0 - weight) + sorted[upper] * weight;
    }
}

internal static class MonteCarloWriter
{
    public static void Write(string path, MonteCarloReport report)
    {
        string fullPath = Path.GetFullPath(path);
        string? directory = Path.GetDirectoryName(fullPath);
        if (!string.IsNullOrWhiteSpace(directory))
            Directory.CreateDirectory(directory);
        JsonSerializerOptions options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            WriteIndented = true
        };
        File.WriteAllText(fullPath, JsonSerializer.Serialize(report, options));
    }
}
