using cAlgo.API;
using System.Text.Json;

namespace BacktestEngine.Run.Tests;

internal static class WarmupTests
{
    private static int _assertions;
    private static readonly DateTime Start = new DateTime(2025, 1, 6, 8, 0, 0, DateTimeKind.Utc);
    private static EffectiveSymbolSpecification _specification;

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2 || args[0] != "--symbol-spec")
                throw new ArgumentException("Usage: WarmupContract --symbol-spec <authenticated economic-symbol.v2.json>");
            using (JsonDocument specification = JsonDocument.Parse(File.ReadAllText(args[1])))
                _specification = EffectiveSymbolSpecificationLoader.Load(args[1], specification.RootElement.GetProperty("symbol").GetString());
            ValidateOptions();
            SeedIndependentHistories();
            PrepareNativeStartupBar();
            RejectInvalidCaptures();
            Console.WriteLine($"WARMUP_CONTRACT status=passed assertions={_assertions}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("WARMUP_CONTRACT status=failed " + ex);
            return 1;
        }
    }

    private static void PrepareNativeStartupBar()
    {
        var robot = new ObservingRobot { TimeFrame = TimeFrame.Hour };
        robot.Symbol.ApplyEffectiveSpecification(_specification);
        var histories = new Dictionary<TimeFrame, IReadOnlyList<MarketBar>>
        {
            [TimeFrame.Hour] = new[] { Bar(Start.AddHours(-1), 100) },
            [TimeFrame.Minute15] = new[] { Bar(Start.AddMinutes(-15), 200) }
        };
        BarReplay.PreloadSeries(robot, histories, Start);
        var first = new MarketTick(Start.AddMilliseconds(599), 120, 120.1);
        MarketReplay.PrepareStart(robot, first);
        Check(robot.Bars.Count == 2 && robot.Bars.OpenTimes[1] == Start, "native startup includes current chart bar");
        Check(robot.Bars.OpenPrices[1] == 120 && robot.Bars.HighPrices[1] == 120
            && robot.Bars.LowPrices[1] == 120 && robot.Bars.ClosePrices[1] == 120, "startup bar contains only observed opening quote");
        Check(robot.MarketData.GetBars(TimeFrame.Minute15).Count == 2, "native startup includes current additional timeframe bar");
        Check(robot.MarketData.GetBars(TimeFrame.Minute).Count == 1, "native startup includes current M1 bar");
        Check(robot.TickCalls == 0 && robot.BarCalls == 0, "startup preparation has no trading callbacks");
        MarketReplay.PrepareStart(robot, first);
        Check(robot.Bars.Count == 2, "preparing an existing current bar does not duplicate it");
        robot.EngineOnStart();
        Check(robot.StartupChartCount == 2 && robot.StartupM15Count == 2, "OnStart observes both completed history and current bar");
        new MarketReplaySession(robot).Process(new MarketTick(first.TimeUtc.AddMilliseconds(513), 120.2, 120.3));
        Check(robot.BarCalls == 0 && robot.TickCalls == 1, "first same-bar replay tick does not fire a false OnBar");
        MarketReplay.ApplyBarPrice(robot, Start.AddMinutes(1), 121.5);
        Check(robot.ExecutionBid == 121.5 && Math.Abs(robot.ExecutionAsk - 121.6) < 1e-9,
            "bar execution quotes advance beyond the prepared startup quote");
    }

    private static void ValidateOptions()
    {
        RunnerOptions options = RunnerOptions.Parse(new[]
        {
            "--warmup-series", "h1=/tmp/native h1.csv",
            "--warmup-series", "m15=/tmp/native m15.csv",
            "--warmup-series", "m5=/tmp/native m5.csv",
            "--warmup-series", "m1=/tmp/native m1.csv"
        });
        Check(options.WarmupSeries.Count == 4, "four independent timeframe files parsed");
        Check(options.WarmupSeries[TimeFrame.Hour] == "/tmp/native h1.csv", "path spaces preserved");
        Reject(() => RunnerOptions.Parse(new[] { "--warmup-series", "history.csv" }), "timeframe=CSV", "timeframe declaration required");
        Reject(() => RunnerOptions.Parse(new[] { "--warmup-series", "h1=" }), "timeframe=CSV", "CSV path required");
        Reject(() => RunnerOptions.Parse(new[] { "--warmup-series", "h1=a.csv", "--warmup-series", "Hour=b.csv" }), "Duplicate", "aliases cannot double-seed one timeframe");
        Reject(() => RunnerOptions.Parse(new[] { "--warmup-series", "m1=a.csv", "--warmup-bars", "b.csv" }), "mutually exclusive", "mixed history loading rejected");
        Check(RunnerOptions.Parse(Array.Empty<string>()).WarmupSeries.Count == 0, "default run remains unchanged");
    }

    private static void SeedIndependentHistories()
    {
        var histories = new Dictionary<TimeFrame, IReadOnlyList<MarketBar>>
        {
            [TimeFrame.Hour] = new[] { Bar(Start.AddHours(-3), 100), Bar(Start.AddHours(-2), 105), Bar(Start.AddHours(-1), 110) },
            [TimeFrame.Minute15] = new[] { Bar(Start.AddMinutes(-30), 201), Bar(Start.AddMinutes(-15), 202) },
            [TimeFrame.Minute5] = new[] { Bar(Start.AddMinutes(-5), 303) },
            [TimeFrame.Minute] = new[] { Bar(Start.AddMinutes(-1), 404) }
        };
        var robot = new ObservingRobot { TimeFrame = TimeFrame.Hour };
        robot.Symbol.ApplyEffectiveSpecification(_specification);
        robot.Server.Time = Start;
        robot.Symbol.Bid = 999;
        robot.Symbol.Ask = 1000;
        BarReplay.PreloadSeries(robot, histories, Start);
        Check(robot.Bars.Count == 3, "chart timeframe maps to Robot.Bars");
        Check(robot.MarketData.GetBars(TimeFrame.Minute15).Count == 2, "native M15 depth preserved independently");
        Check(robot.MarketData.GetBars(TimeFrame.Minute5).Count == 1, "native M5 depth preserved independently");
        Check(robot.MarketData.GetBars(TimeFrame.Minute).Count == 1, "native M1 depth preserved independently");
        Check(robot.MarketData.GetBars(TimeFrame.Minute15).ClosePrices[1] == 202.5, "native M15 prices are not synthesized from H1");
        Check(robot.Bars.HighPrices[2] == 111 && robot.Bars.LowPrices[2] == 109, "all OHLC fields preserved");
        Check(robot.Server.Time == Start && robot.Symbol.Bid == 999 && robot.Symbol.Ask == 1000, "history loading preserves current execution time and quote");
        robot.EngineOnStart();
        Check(robot.StartupChartCount == 3 && robot.StartupM15Count == 2, "OnStart sees supplied histories");
        Check(robot.TickCalls == 0 && robot.BarCalls == 0, "history loading does not replay trading callbacks");

        var session = new MarketReplaySession(robot);
        session.Process(new MarketTick(Start, 120, 121));
        Check(robot.Bars.Count == 4 && robot.Bars.OpenTimes[3] == Start, "first replay tick appends chart bar without overwriting history");
        Check(robot.MarketData.GetBars(TimeFrame.Minute15).Count == 3, "additional native history continues into replay");
        Check(robot.MarketData.GetBars(TimeFrame.Minute15).ClosePrices[1] == 202.5, "historical values remain frozen after replay starts");
        Check(robot.TickCalls == 1 && robot.BarCalls == 1, "callbacks begin only with replay tick");
    }

    private static void RejectInvalidCaptures()
    {
        foreach (DateTime badTime in new[] { Start, Start.AddMinutes(1) })
        {
            var robot = new ObservingRobot { TimeFrame = TimeFrame.Hour };
            var mixed = new Dictionary<TimeFrame, IReadOnlyList<MarketBar>>
            {
                [TimeFrame.Hour] = new[] { Bar(Start.AddHours(-1), 100) },
                [TimeFrame.Minute15] = new[] { Bar(badTime, 200) }
            };
            Reject(() => BarReplay.PreloadSeries(robot, mixed, Start), "at or after", "current or future source bar rejected");
            Check(robot.Bars.Count == 0, "failed capture does not partially seed another timeframe");
        }
        foreach (MarketBar[] bars in new[]
        {
            new[] { Bar(Start.AddHours(-1), 1), Bar(Start.AddHours(-1), 2) },
            new[] { Bar(Start.AddHours(-1), 1), Bar(Start.AddHours(-2), 2) }
        })
        {
            var robot = new ObservingRobot { TimeFrame = TimeFrame.Hour };
            var history = new Dictionary<TimeFrame, IReadOnlyList<MarketBar>> { [TimeFrame.Hour] = bars };
            Reject(() => BarReplay.PreloadSeries(robot, history, Start), "chronological unique", "duplicate or reversed source timestamps rejected");
        }
        var seeded = new ObservingRobot { TimeFrame = TimeFrame.Hour };
        seeded.Bars.Add(Start.AddHours(-2), 1, 1, 1, 1);
        var earlier = new Dictionary<TimeFrame, IReadOnlyList<MarketBar>> { [TimeFrame.Hour] = new[] { Bar(Start.AddHours(-1), 100) } };
        Reject(() => BarReplay.PreloadSeries(seeded, earlier, Start), "overwrite", "existing bars cannot be double-seeded");
    }

    private static MarketBar Bar(DateTime time, double price) => new MarketBar(time, price, price + 1, price - 1, price + 0.5);

    private static void Reject(Action action, string message, string label)
    {
        try { action(); }
        catch (Exception ex) when ((ex is ArgumentException || ex is InvalidDataException || ex is InvalidOperationException)
            && ex.Message.Contains(message, StringComparison.Ordinal))
        {
            Check(true, label);
            return;
        }
        throw new InvalidOperationException("Expected rejection: " + label);
    }

    private static void Check(bool condition, string label)
    {
        if (!condition) throw new InvalidOperationException("Contract assertion failed: " + label);
        _assertions++;
    }

    private sealed class ObservingRobot : Robot
    {
        public int StartupChartCount { get; private set; }
        public int StartupM15Count { get; private set; }
        public int TickCalls { get; private set; }
        public int BarCalls { get; private set; }
        protected override void OnStart()
        {
            StartupChartCount = Bars.Count;
            StartupM15Count = MarketData.GetBars(TimeFrame.Minute15).Count;
        }
        protected override void OnTick() { TickCalls++; }
        protected override void OnBar() { BarCalls++; }
    }
}
