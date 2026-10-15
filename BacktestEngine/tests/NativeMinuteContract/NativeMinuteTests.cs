using System.Text.Json;
using cAlgo.API;

namespace BacktestEngine.Run.Tests;

internal static class NativeMinuteTests
{
    private static int _assertions;
    private static EffectiveSymbolSpecification _specification;
    private static readonly DateTime Start = new DateTime(2025, 1, 10, 0, 0, 0, DateTimeKind.Utc);

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2 || args[0] != "--symbol-spec")
                throw new ArgumentException("Usage: NativeMinuteContract --symbol-spec <XAUUSD economic-symbol.v2.json>");
            _specification = EffectiveSymbolSpecificationLoader.Load(args[1], "XAUUSD");
            VerifyObservedMinuteReplay();
            VerifyBothTouchedPriority();
            VerifyTerminalRange();
            VerifyHigherTimeframe();
            VerifySourceRestriction();
            VerifyNativeTickBoundaryOrder();
            VerifyNativeMutableRangeBook();
            VerifyIndependentFourPairProbe();
            VerifyWeekendOpeningBeforeSwap();
            VerifyTickOpeningBeforeSwap();
            VerifyNativeReportSampling();
            Console.WriteLine($"NATIVE_MINUTE_CONTRACT status=passed assertions={_assertions}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("NATIVE_MINUTE_CONTRACT status=failed " + ex);
            return 1;
        }
    }

    private static void VerifyNativeReportSampling()
    {
        using var stream = typeof(NativeMinuteTests).Assembly.GetManifestResourceStream("NativeMinuteContract.equity-sampling-probe.json");
        using var document = JsonDocument.Parse(stream);
        var root = document.RootElement;
        var opening = root.GetProperty("opening_quote");
        var bot = new Probe { TimeFrame = TimeFrame.Hour, SymbolName = "XAUUSD" };
        // This isolated reporting probe ended June 2: its four native fills
        // each cost $0.11. The full suite uses independently calibrated June 30 costs.
        bot.Symbol.ApplyEffectiveSpecification(_specification.WithCommissionTermsForDeterministicFixture(0, .11, "native-june2-equity-observation"));
        bot.Account.StartingBalance = bot.Account.Balance = bot.Account.Equity = 100000;
        MarketReplay.PrepareStart(bot, new MarketTick(opening.GetProperty("time_utc").GetDateTime(),
            opening.GetProperty("bid").GetDouble(), opening.GetProperty("ask").GetDouble()));
        using var report = new NativeReportDrawdown(bot);
        bot.EngineOnStart();
        bot.OpenPair(1000000, false, 2);
        double observedPeak = 0;
        foreach (var tick in root.GetProperty("ticks").EnumerateArray())
        {
            var quote = new MarketTick(tick.GetProperty("time_utc").GetDateTime(),
                tick.GetProperty("bid").GetDouble(), tick.GetProperty("ask").GetDouble());
            MarketReplay.ApplyTick(bot, quote);
            MarketReplay.ApplyExecutionTick(bot, quote);
            Near(bot.Account.Equity, tick.GetProperty("account_equity").GetDouble(), "native observed equity on each hedge tick");
            observedPeak = Math.Max(observedPeak, bot.Account.Equity);
        }
        bot.CloseAll();
        report.Complete();
        var expected = root.GetProperty("native_equity");
        Near(report.Equity.MaxEquityDrawdown, expected.GetProperty("maxEquityDrawdownAbsolute").GetDouble(), "native report equity drawdown absolute");
        Near(report.Equity.MaxEquityDrawdownPercent, expected.GetProperty("maxEquityDrawdownPercent").GetDouble(), "native report equity drawdown percentage");
        Near(report.Balance.MaxBalanceDrawdown, expected.GetProperty("maxBalanceDrawdownAbsolute").GetDouble(), "native intermediate deal balance drawdown absolute");
        Near(report.Balance.MaxBalanceDrawdownPercent, expected.GetProperty("maxBalanceDrawdownPercent").GetDouble(), "native intermediate deal balance drawdown percentage");
        Near(bot.Account.Balance, root.GetProperty("native_ending_balance").GetDouble(), "native hedge ending balance");
        Check(observedPeak > 100006, "crossed quote remains observable; report sampling must not rewrite actual equity");
    }

    private static MarketBar[] ObservedBars() => new[]
    {
        new MarketBar(Start, 2670.02, 2670.18, 2669.76, 2669.83),
        new MarketBar(Start.AddMinutes(1), 2670.00, 2670.50, 2670.00, 2670.20),
        new MarketBar(Start.AddMinutes(2), 2670.20, 2670.30, 2670.00, 2670.01)
    };

    private static Probe Robot(TimeFrame timeframe, DateTime time, double bid)
    {
        var bot = new Probe { TimeFrame = timeframe, SymbolName = "XAUUSD" };
        bot.Symbol.ApplyEffectiveSpecification(_specification);
        bot.Symbol.Bid = bid;
        bot.Symbol.Ask = bid + 0.1;
        MarketReplay.PrepareStart(bot, new MarketTick(time, bid, bid + 0.1));
        bot.EngineOnStart();
        return bot;
    }

    private static void VerifyObservedMinuteReplay()
    {
        MarketBar[] bars = ObservedBars();
        Probe bot = Robot(TimeFrame.Minute, Start, bars[0].Open);
        bot.OpenOnFirstTick = true;
        ReplaySummary result = BarReplay.Run(bot, bars, TimeFrame.Minute, SourceBarPriceMode.NativeM1);
        Check(result.TickCount == 2 && result.OnBarCount == 2, "opening quote is startup only, then one Tick and Bar per minute");
        Check(string.Join(",", bot.Events) == "tick,bar,close:Sell,close:Buy,tick,bar", "observed native callback order and deferred closed events");
        Check(bot.History.ClosedPositions.Count == 2, "observed protected order count");
        Position sell = bot.History.ClosedPositions[0];
        Position buy = bot.History.ClosedPositions[1];
        Check(sell.TradeType == TradeType.Sell && sell.ClosingReason == "stop_loss", "high-side SL is processed before high-side TP");
        Check(buy.TradeType == TradeType.Buy && buy.ClosingReason == "take_profit", "buy target survives range when SL not touched");
        Near(sell.EntryPrice, 2670.0, "native sell entry");
        Near(buy.EntryPrice, 2670.1, "native buy entry");
        Near(sell.ClosePrice, 2670.6, "native sell fills high ask, not SL level");
        Near(buy.ClosePrice, 2670.5, "native buy fills high bid, not TP level");
        Check(sell.ClosingTime == Start.AddMinutes(2) && buy.ClosingTime == Start.AddMinutes(2), "prior bar protection fills use next minute timestamp");
        Check(bot.ClosedQuotes.All(quote => Math.Abs(quote - 2670.0) < 1e-9), "closed callbacks still observe prior opening quote");
        Check(bot.ClosedBarHighs.All(high => Math.Abs(high - 2670.0) < 1e-9), "closed callbacks precede completed OHLC update");
        Near(bot.Symbol.Bid, 2670.2, "terminal visible quote stays final open");
        Near(bot.Bars.ClosePrices.Last(), 2670.01, "terminal chart includes final close");
    }

    private static void VerifyBothTouchedPriority()
    {
        foreach (bool sellFirst in new[] { false, true })
        {
            Probe bot = Robot(TimeFrame.Minute, Start.AddMinutes(61), 2669.83);
            bot.OpenPair(3, sellFirst);
            bot.Server.Time = Start.AddMinutes(62);
            bot.ProcessNativeMinuteBarProtections(2670.76, 2669.51, 0.1);
            Check(bot.History.ClosedPositions.Count == 2, "both-touch minute closes both positions");
            Position sell = bot.History.ClosedPositions[0];
            Position buy = bot.History.ClosedPositions[1];
            Check(sell.TradeType == TradeType.Sell && buy.TradeType == TradeType.Buy, "high-side SL precedes low-side SL independently of insertion order");
            Check(sell.ClosingReason == "stop_loss" && buy.ClosingReason == "stop_loss", "SL anywhere in bullish range beats touched TP");
            Near(sell.ClosePrice, 2670.86, "bullish both-touch sell high ask");
            Near(buy.ClosePrice, 2669.51, "bullish both-touch buy low bid");
            Near(bot.Symbol.Bid, 2669.83, "range processing does not expose fictional extrema as quote events");
        }
        Probe bearish = Robot(TimeFrame.Minute, Start.AddMinutes(9), 2670.26);
        bearish.OpenPair(1.8, false);
        bearish.Server.Time = Start.AddMinutes(10);
        bearish.ProcessNativeMinuteBarProtections(2670.39, 2669.97, 0.1);
        Check(bearish.History.ClosedPositions.All(p => p.ClosingReason == "stop_loss"), "bearish both-touch has the same SL priority");
        Near(bearish.History.ClosedPositions[0].ClosePrice, 2670.49, "bearish sell high ask");
        Near(bearish.History.ClosedPositions[1].ClosePrice, 2669.97, "bearish buy low bid");
    }

    private static void VerifyTerminalRange()
    {
        DateTime time = Start.AddHours(21).AddMinutes(57);
        var bars = new[]
        {
            new MarketBar(time, 2689.05, 2689.70, 2689.05, 2689.22),
            new MarketBar(time.AddMinutes(1), 2689.22, 2689.91, 2689.22, 2689.80)
        };
        Probe bot = Robot(TimeFrame.Minute, time, bars[0].Open);
        bot.OpenOnFirstTick = true;
        BarReplay.Run(bot, bars, TimeFrame.Minute, SourceBarPriceMode.NativeM1);
        Check(bot.History.ClosedPositions.Count == 2, "final bar range fills are included in report ledger");
        Check(bot.ClosedQuotes.Count == 0, "native terminal range events are not delivered before OnStop");
        Check(bot.History.ClosedPositions.All(p => p.ClosingTime == time.AddMinutes(1)), "terminal fills retain last opening timestamp");
        Near(bot.History.ClosedPositions[0].ClosePrice, 2690.01, "terminal sell SL fills high ask");
        Near(bot.History.ClosedPositions[1].ClosePrice, 2689.91, "terminal buy TP fills high bid");
        Near(bot.Symbol.Bid, 2689.22, "terminal quote remains open after hidden fills");
        Near(bot.Bars.ClosePrices.Last(), 2689.80, "OnStop chart includes terminal close");
    }

    private static void VerifyHigherTimeframe()
    {
        Probe bot = Robot(TimeFrame.Hour, Start, ObservedBars()[0].Open);
        ReplaySummary result = BarReplay.Run(bot, ObservedBars(), TimeFrame.Minute, SourceBarPriceMode.NativeM1);
        Check(result.TickCount == 2 && result.OnBarCount == 0, "H1 chart gets minute ticks without false hourly bars");
        Near(bot.TickChartHighs[0], 2670.18, "first callback sees only completed prior-minute high");
        Near(bot.TickChartHighs[1], 2670.50, "next callback incorporates the now completed minute");
        Near(bot.TickChartLows[0], 2669.76, "higher timeframe incorporates completed prior-minute low");
        Check(bot.MarketData.GetBars(TimeFrame.Minute).Count == 3, "native M1 market series advances independently of chart");
    }

    private static void VerifySourceRestriction()
    {
        try
        {
            BarReplay.Run(Robot(TimeFrame.Hour, Start, 2670), ObservedBars(), TimeFrame.Minute5, SourceBarPriceMode.NativeM1);
        }
        catch (ArgumentException ex) when (ex.Message.Contains("one-minute"))
        {
            Check(true, "M5 bars cannot masquerade as native M1 data");
            return;
        }
        throw new InvalidOperationException("Expected native M1 source restriction.");
    }

    private static void VerifyNativeTickBoundaryOrder()
    {
        Probe bot = Robot(TimeFrame.Hour, Start, 2670.02);
        var session = new MarketReplaySession(bot);
        session.Process(new MarketTick(Start.AddSeconds(1), 2670.03, 2670.13));
        session.Process(new MarketTick(Start.AddHours(1), 2671.00, 2671.10));
        Check(string.Join(",", bot.Events) == "tick,tick,bar", "native boundary quote delivers OnTick before OnBar");
        Check(session.Summary.TickCount == 2 && session.Summary.OnBarCount == 1, "startup suppresses false initial OnBar without dropping first actual tick");
        Near(bot.TickChartHighs[1], 2671.00, "boundary OnTick already sees new chart forming bar");
        Near(bot.TickChartLows[1], 2671.00, "boundary OnTick cannot see completed previous chart range as current");
        Check(bot.TickMinuteTimes[1] == Start.AddHours(1), "H1 chart tick callback sees independent M1 series advance to the current minute");
        Near(bot.TickMinuteCloses[1], 2671.00, "independent M1 quote visible before strategy callback");
        Check(bot.MarketData.GetBars(TimeFrame.Minute).Count == 2, "M1 startup bar advances without creating empty gap bars");
    }

    private static void VerifyNativeMutableRangeBook()
    {
        // Native protected-order fixture: the higher buy SL fills at the prior minute
        // low, while the adjacent lower SL waits until the following range.
        Probe delayed = Robot(TimeFrame.Minute, Start, 2692.63);
        Position lower = delayed.OpenBuy(2, "LOWER", 312.5, 1000);
        MarketReplay.ApplyBarPrice(delayed, Start, 2691.35);
        Position higher = delayed.OpenBuy(2, "HIGHER", 297.7, 1000);
        delayed.Server.Time = Start.AddMinutes(1);
        delayed.ProcessNativeMinuteBarProtections(2662.38, 2661.39, 0.1);
        Check(delayed.History.ClosedPositions.Count == 1 && delayed.History.ClosedPositions[0].Id == higher.Id,
            "hidden range processes higher buy SL first and skips adjacent lower SL");
        Near(higher.ClosePrice, 2661.39, "native first range fill");
        MarketReplay.ApplyBarPrice(delayed, Start.AddMinutes(1), 2662.0);
        delayed.ProcessStopsAndTargets(ProtectionFillMode.CurrentPrice, nativeTraversal: true);
        Check(delayed.History.ClosedPositions.Count == 1, "non-triggering next open cannot fill skipped protection");
        delayed.Server.Time = Start.AddMinutes(2);
        delayed.ProcessNativeMinuteBarProtections(2662.14, 2661.06, 0.1);
        Near(lower.ClosePrice, 2661.06, "skipped lower SL fills following minute low");
        Check(lower.ClosingTime == Start.AddMinutes(2), "mutable book reproduces observed one-minute delayed close");

        // If the next open itself also breaches the skipped SL, it instead
        // fills at that quote with the same timestamp as the first range fill.
        Probe opening = Robot(TimeFrame.Minute, Start, 2670.0);
        Position first = opening.OpenBuy(1, "LOWER", 3, 10);
        Position second = opening.OpenBuy(1, "HIGHER", 2, 10);
        opening.Server.Time = Start.AddMinutes(1);
        opening.ProcessNativeMinuteBarProtections(2670.0, 2669.7, 0.1);
        Check(opening.History.ClosedPositions.Single().Id == second.Id, "same-side hidden book uses stop level before position ID");
        MarketReplay.ApplyBarPrice(opening, Start.AddMinutes(1), 2669.75);
        opening.ProcessStopsAndTargets(ProtectionFillMode.CurrentPrice, nativeTraversal: true);
        Near(first.ClosePrice, 2669.75, "skipped range SL fills at next opening quote, not previous extreme");
        Check(first.ClosingTime == second.ClosingTime, "range and next-open closes can share timestamp with distinct execution prices");
    }

    private static void VerifyIndependentFourPairProbe()
    {
        var bars = ObservedBars().Concat(new[]
        {
            new MarketBar(Start.AddMinutes(3), 2670.10, 2670.10, 2669.59, 2669.59),
            new MarketBar(Start.AddMinutes(4), 2669.59, 2669.89, 2669.59, 2669.72)
        }).ToArray();
        Probe bot = Robot(TimeFrame.Minute, Start, bars[0].Open);
        bot.PairVolumes = new[] { 1.0, 2.0, 4.0, 8.0 };
        bot.OpenOnFirstTick = true;
        BarReplay.Run(bot, bars, TimeFrame.Minute, SourceBarPriceMode.NativeM1);
        long[] ids = { 8, 4, 7, 3, 6, 5, 2, 1 };
        double[] prices = { 2670.6, 2670.6, 2670.5, 2670.5, 2670.4, 2669.59, 2669.69, 2669.59 };
        int[] minutes = { 2, 2, 2, 2, 3, 4, 4, 4 };
        Position[] closed = bot.History.ClosedPositions.ToArray();
        Check(closed.Select(p => p.Id).SequenceEqual(ids), "independent neutral native four-pair probe preserves cross-book and removal order");
        for (int index = 0; index < ids.Length; index++)
        {
            Near(closed[index].ClosePrice, prices[index], "neutral multiple-protection native fill " + ids[index]);
            Check(closed[index].ClosingTime == Start.AddMinutes(minutes[index]), "neutral multiple-protection native close timestamp " + ids[index]);
        }
    }

    private static void VerifyWeekendOpeningBeforeSwap()
    {
        DateTime friday = new DateTime(2025, 8, 1, 19, 59, 0, DateTimeKind.Utc);
        DateTime sunday = new DateTime(2025, 8, 3, 22, 0, 0, DateTimeKind.Utc);
        // Representative native quotes around the gap. Interior Friday bars
        // remain between both protections and do not change the observed path.
        var bars = new[]
        {
            new MarketBar(friday, 3357.08, 3357.74, 3356.76, 3357.23),
            new MarketBar(friday.AddMinutes(1), 3357.32, 3357.91, 3357.02, 3357.77),
            new MarketBar(sunday, 3365.45, 3369.05, 3364.31, 3366.33),
            new MarketBar(sunday.AddMinutes(1), 3365.54, 3365.66, 3362.76, 3362.81)
        };
        Probe bot = Robot(TimeFrame.Minute, friday, bars[0].Open);
        bot.PairVolumes = new[] { 4.0 };
        bot.PairStopPips = 100;
        bot.PairTargetPips = 70;
        bot.OpenOnFirstTick = true;
        BarReplay.Run(bot, bars, TimeFrame.Minute, SourceBarPriceMode.NativeM1);
        Position buy = bot.History.ClosedPositions.Single(position => position.TradeType == TradeType.Buy);
        Position sell = bot.History.ClosedPositions.Single(position => position.TradeType == TradeType.Sell);
        Near(buy.ClosePrice, 3365.45, "weekend native opening-gap target fill");
        Check(buy.ClosingTime == sunday, "opening-gap close precedes next-minute range");
        Near(buy.Swaps, 0, "position closing at gap open does not accrue deferred Friday swap");
        Near(sell.ClosePrice, 3369.15, "survivor closes at next hidden high ask");
        Check(sell.ClosingTime == sunday.AddMinutes(1), "survivor range close timestamp");
        Near(sell.Swaps, 1.28, "position surviving opening quote accrues deferred Friday swap");
    }

    private static void VerifyTickOpeningBeforeSwap()
    {
        // Native RegressionSuite strategy 8, XAUUSD ticks, 25 June 2026.
        // The short stops on the first quote after the daily break with zero
        // swap. A surviving long must still receive its ordinary rollover.
        DateTime entry = new DateTime(2026, 6, 25, 20, 0, 0, DateTimeKind.Utc).AddMilliseconds(106);
        DateTime last = new DateTime(2026, 6, 25, 20, 58, 59, DateTimeKind.Utc).AddMilliseconds(642);
        DateTime opening = new DateTime(2026, 6, 25, 22, 0, 10, DateTimeKind.Utc).AddMilliseconds(838);
        Probe bot = Robot(TimeFrame.Hour, entry, 4027.05);
        bot.PairVolumes = new[] { 2.0 };
        bot.PairStopPips = 100;
        bot.PairTargetPips = 150;
        bot.OpenOnFirstTick = true;
        var session = new MarketReplaySession(bot);
        session.Process(new MarketTick(entry, 4027.05, 4027.15));
        session.Process(new MarketTick(last, 4026.69, 4026.89));
        Check(bot.Positions.Count() == 2, "both tick positions survive before the daily gap");
        session.Process(new MarketTick(opening, 4039.88, 4040.00));
        Position sell = bot.History.ClosedPositions.Single();
        Check(sell.TradeType == TradeType.Sell && sell.ClosingTime == opening, "native tick gap stop identity and timestamp");
        Near(sell.ClosePrice, 4040, "native tick gap stop fill");
        Near(sell.Swaps, 0, "native tick opening stop precedes deferred daily swap");
        Position buy = bot.Positions.Single();
        Near(buy.Swaps, -1.35, "surviving tick position still receives deferred daily swap");
    }

    private static void Check(bool condition, string label)
    {
        if (!condition) throw new InvalidOperationException("Contract assertion failed: " + label);
        _assertions++;
    }

    private static void Near(double actual, double expected, string label) => Check(Math.Abs(actual - expected) <= 1e-9, label + $" actual={actual:R} expected={expected:R}");

    private sealed class Probe : Robot
    {
        public bool OpenOnFirstTick { get; set; }
        public double[] PairVolumes { get; set; } = new[] { 1.0 };
        public double PairStopPips { get; set; } = 3;
        public double PairTargetPips { get; set; } = 3;
        public List<string> Events { get; } = new List<string>();
        public List<double> ClosedQuotes { get; } = new List<double>();
        public List<double> ClosedBarHighs { get; } = new List<double>();
        public List<double> TickChartHighs { get; } = new List<double>();
        public List<double> TickChartLows { get; } = new List<double>();
        public List<DateTime> TickMinuteTimes { get; } = new List<DateTime>();
        public List<double> TickMinuteCloses { get; } = new List<double>();

        protected override void OnStart()
        {
            Positions.Closed += args =>
            {
                Events.Add("close:" + args.Position.TradeType);
                ClosedQuotes.Add(Symbol.Bid);
                ClosedBarHighs.Add(Bars.HighPrices.Last());
            };
        }

        protected override void OnTick()
        {
            Events.Add("tick");
            TickChartHighs.Add(Bars.HighPrices.Last());
            TickChartLows.Add(Bars.LowPrices.Last());
            TickMinuteTimes.Add(MarketData.GetBars(TimeFrame.Minute).OpenTimes.Last());
            TickMinuteCloses.Add(MarketData.GetBars(TimeFrame.Minute).ClosePrices.Last());
            if (OpenOnFirstTick)
            {
                OpenOnFirstTick = false;
                foreach (double volume in PairVolumes) OpenPair(PairStopPips, false, volume, PairTargetPips);
            }
        }

        protected override void OnBar() { Events.Add("bar"); }

        public void CloseAll()
        {
            foreach (var position in Positions.ToArray()) ClosePosition(position);
        }

        public Position OpenBuy(double volume, string label, double stopPips, double targetPips)
        {
            TradeResult result = ExecuteMarketOrder(TradeType.Buy, SymbolName, volume, label, stopPips, targetPips);
            if (!result.IsSuccessful) throw new InvalidOperationException(result.Error);
            return result.Position;
        }

        public void OpenPair(double distance, bool sellFirst, double volume = 1, double? targetDistance = null)
        {
            TradeType[] order = sellFirst ? new[] { TradeType.Sell, TradeType.Buy } : new[] { TradeType.Buy, TradeType.Sell };
            foreach (TradeType side in order)
            {
                TradeResult result = ExecuteMarketOrder(side, SymbolName, volume, "NATIVE_M1_TEST", distance, targetDistance ?? distance);
                if (!result.IsSuccessful) throw new InvalidOperationException(result.Error);
            }
        }
    }
}
