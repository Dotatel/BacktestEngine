using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;
using cAlgo.API;

namespace BacktestEngine.Run
{
    internal readonly struct MarketTick
    {
        public MarketTick(DateTime timeUtc, double bid, double ask)
        {
            TimeUtc = timeUtc;
            Bid = bid;
            Ask = ask;
        }

        public DateTime TimeUtc { get; }
        public double Bid { get; }
        public double Ask { get; }
    }

    internal readonly struct MarketBar
    {
        public MarketBar(DateTime openTimeUtc, double open, double high, double low, double close)
        {
            OpenTimeUtc = openTimeUtc;
            Open = open;
            High = high;
            Low = low;
            Close = close;
        }

        public DateTime OpenTimeUtc { get; }
        public double Open { get; }
        public double High { get; }
        public double Low { get; }
        public double Close { get; }
    }

    internal sealed class ReplaySummary
    {
        private readonly List<EquitySample> _equitySamples = new List<EquitySample>();
        private readonly DateTime? _metricsStartUtc;

        public ReplaySummary(bool retainEquitySamples = true, DateTime? metricsStartUtc = null)
        {
            RetainEquitySamples = retainEquitySamples;
            _metricsStartUtc = metricsStartUtc;
        }

        public int TickCount { get; set; }
        public int OnBarCount { get; set; }
        public int ChartBarCount { get; set; }
        public int HourBarCount { get; set; }
        public double ReplayElapsedMilliseconds { get; set; }
        public DateTime FirstTickTimeUtc { get; set; }
        public DateTime LastTickTimeUtc { get; set; }
        public bool RetainEquitySamples { get; }
        public long EquityPointCount { get; private set; }
        public NativeReportDrawdown NativeDrawdown { get; set; }
        public EquityPathMetrics EquityPath { get; } = new EquityPathMetrics();
        public IReadOnlyList<EquitySample> EquitySamples
        {
            get { return _equitySamples; }
        }
        public SyntheticReplayMetadata Synthetic { get; set; }
        public string TerminationReason { get; set; } = "";
        public DateTime TerminationTimeUtc { get; set; }
        public double TerminationBalance { get; set; }
        public double TerminationEquity { get; set; }

        public void RecordEquity(DateTime timeUtc, double balance, double equity)
        {
            if (_metricsStartUtc.HasValue && timeUtc < _metricsStartUtc.Value)
                return;
            EquityPointCount++;
            EquityPath.Add(timeUtc, balance, equity);
            if (RetainEquitySamples)
                _equitySamples.Add(new EquitySample(timeUtc, balance, equity));
        }
    }

    internal sealed class EquityPathMetrics
    {
        private readonly List<DailyDrawdownSample> _dailyMaxEquityDrawdown = new List<DailyDrawdownSample>();
        private bool _initialized;
        private DateTime _day = DateTime.MinValue;
        private double _balancePeak;
        private double _equityPeak;
        private DateTime _balancePeakTimeUtc;
        private DateTime _equityPeakTimeUtc;
        private double _dayStartEquity;
        private double _dayPeakEquity;

        public double MaxBalanceDrawdown { get; private set; }
        public double MaxBalanceDrawdownPercent { get; private set; }
        public double MaxEquityDrawdown { get; private set; }
        public double MaxEquityDrawdownPercent { get; private set; }
        public DateTime MaxBalanceDrawdownPeakTimeUtc { get; private set; }
        public DateTime MaxBalanceDrawdownTroughTimeUtc { get; private set; }
        public double MaxBalanceDrawdownPeak { get; private set; }
        public double MaxBalanceDrawdownTrough { get; private set; }
        public DateTime MaxEquityDrawdownPeakTimeUtc { get; private set; }
        public DateTime MaxEquityDrawdownTroughTimeUtc { get; private set; }
        public double MaxEquityDrawdownPeak { get; private set; }
        public double MaxEquityDrawdownTrough { get; private set; }
        public double MaxDayStartEquityLoss { get; private set; }
        public double MaxDayStartEquityLossPercent { get; private set; }
        public double MaxIntradayEquityDrawdown { get; private set; }
        public double MaxIntradayEquityDrawdownPercent { get; private set; }
        public IReadOnlyList<DailyDrawdownSample> DailyMaxEquityDrawdown => _dailyMaxEquityDrawdown;

        public void Add(DateTime timeUtc, double balance, double equity)
        {
            if (!_initialized)
            {
                _initialized = true;
                _balancePeak = balance;
                _equityPeak = equity;
                _balancePeakTimeUtc = timeUtc;
                _equityPeakTimeUtc = timeUtc;
                _day = timeUtc.Date;
                _dayStartEquity = equity;
                _dayPeakEquity = equity;
            }
            else if (timeUtc.Date != _day)
            {
                _day = timeUtc.Date;
                _dayStartEquity = equity;
                _dayPeakEquity = equity;
            }

            if (balance > _balancePeak)
            {
                _balancePeak = balance;
                _balancePeakTimeUtc = timeUtc;
            }
            if (equity > _equityPeak)
            {
                _equityPeak = equity;
                _equityPeakTimeUtc = timeUtc;
            }
            _dayPeakEquity = Math.Max(_dayPeakEquity, equity);

            double balanceDrawdown = Math.Max(0.0, _balancePeak - balance);
            double equityDrawdown = Math.Max(0.0, _equityPeak - equity);
            double dayStartLoss = Math.Max(0.0, _dayStartEquity - equity);
            double intradayDrawdown = Math.Max(0.0, _dayPeakEquity - equity);

            MaxBalanceDrawdown = Math.Max(MaxBalanceDrawdown, balanceDrawdown);
            MaxEquityDrawdown = Math.Max(MaxEquityDrawdown, equityDrawdown);
            MaxDayStartEquityLoss = Math.Max(MaxDayStartEquityLoss, dayStartLoss);
            MaxIntradayEquityDrawdown = Math.Max(MaxIntradayEquityDrawdown, intradayDrawdown);
            if (_balancePeak > 0.0)
            {
                double balanceDrawdownPercent = balanceDrawdown / _balancePeak * 100.0;
                if (balanceDrawdownPercent > MaxBalanceDrawdownPercent)
                {
                    MaxBalanceDrawdownPercent = balanceDrawdownPercent;
                    MaxBalanceDrawdownPeakTimeUtc = _balancePeakTimeUtc;
                    MaxBalanceDrawdownTroughTimeUtc = timeUtc;
                    MaxBalanceDrawdownPeak = _balancePeak;
                    MaxBalanceDrawdownTrough = balance;
                }
            }
            if (_equityPeak > 0.0)
            {
                double equityDrawdownPercent = equityDrawdown / _equityPeak * 100.0;
                DateTime sampleDay = timeUtc.Date;
                int lastIndex = _dailyMaxEquityDrawdown.Count - 1;
                if (lastIndex < 0 || _dailyMaxEquityDrawdown[lastIndex].DayUtc != sampleDay)
                    _dailyMaxEquityDrawdown.Add(new DailyDrawdownSample(sampleDay, equityDrawdownPercent));
                else if (equityDrawdownPercent > _dailyMaxEquityDrawdown[lastIndex].MaxPercent)
                    _dailyMaxEquityDrawdown[lastIndex] = new DailyDrawdownSample(sampleDay, equityDrawdownPercent);
                if (equityDrawdownPercent > MaxEquityDrawdownPercent)
                {
                    MaxEquityDrawdownPercent = equityDrawdownPercent;
                    MaxEquityDrawdownPeakTimeUtc = _equityPeakTimeUtc;
                    MaxEquityDrawdownTroughTimeUtc = timeUtc;
                    MaxEquityDrawdownPeak = _equityPeak;
                    MaxEquityDrawdownTrough = equity;
                }
            }
            if (_dayStartEquity > 0.0)
                MaxDayStartEquityLossPercent = Math.Max(MaxDayStartEquityLossPercent, dayStartLoss / _dayStartEquity * 100.0);
            if (_dayPeakEquity > 0.0)
                MaxIntradayEquityDrawdownPercent = Math.Max(MaxIntradayEquityDrawdownPercent, intradayDrawdown / _dayPeakEquity * 100.0);
        }
    }

    internal readonly struct DailyDrawdownSample
    {
        public DailyDrawdownSample(DateTime dayUtc, double maxPercent)
        {
            DayUtc = dayUtc;
            MaxPercent = maxPercent;
        }

        public DateTime DayUtc { get; }
        public double MaxPercent { get; }
    }

    internal enum SourceBarPriceMode
    {
        OhlcSyntheticTicks,
        OpenOnly,
        NativeM1
    }

    internal readonly struct EquitySample
    {
        public EquitySample(DateTime timeUtc, double balance, double equity)
        {
            TimeUtc = timeUtc;
            Balance = balance;
            Equity = equity;
        }

        public DateTime TimeUtc { get; }
        public double Balance { get; }
        public double Equity { get; }
    }

    internal static class TickCsvDataSource
    {
        public static IEnumerable<IReadOnlyList<MarketTick>> ReadBatches(
            IReadOnlyList<string> paths,
            int batchSize,
            int maxTicks,
            DateTime? startUtc,
            DateTime? endUtc)
        {
            if (paths == null || paths.Count == 0)
                yield break;
            if (batchSize <= 0)
                throw new ArgumentOutOfRangeException(nameof(batchSize));

            int emitted = 0;
            foreach (string path in paths)
            {
                if (string.IsNullOrWhiteSpace(path))
                    continue;
                if (!File.Exists(path))
                    throw new FileNotFoundException("Tick CSV file was not found.", path);

                List<MarketTick> batch = new List<MarketTick>(batchSize);
                bool headerSkipped = false;
                foreach (string line in File.ReadLines(path))
                {
                    if (!headerSkipped)
                    {
                        headerSkipped = true;
                        continue;
                    }
                    if (string.IsNullOrWhiteSpace(line))
                        continue;

                    MarketTick tick = ParseTick(line);
                    if (startUtc != null && tick.TimeUtc < startUtc.Value)
                        continue;
                    if (endUtc != null && tick.TimeUtc >= endUtc.Value)
                        break;

                    batch.Add(tick);
                    emitted++;
                    if (batch.Count >= batchSize)
                    {
                        yield return batch;
                        batch = new List<MarketTick>(batchSize);
                    }
                    if (maxTicks > 0 && emitted >= maxTicks)
                    {
                        if (batch.Count > 0)
                            yield return batch;
                        yield break;
                    }
                }
                if (batch.Count > 0)
                    yield return batch;
            }
        }

        public static IReadOnlyList<MarketTick> Load(string path, int maxTicks)
        {
            return Load(path, maxTicks, null, null);
        }

        public static IReadOnlyList<MarketTick> Load(string path, int maxTicks, DateTime? startUtc, DateTime? endUtc)
        {
            if (string.IsNullOrWhiteSpace(path))
                return Array.Empty<MarketTick>();
            if (!File.Exists(path))
                throw new FileNotFoundException("Tick CSV file was not found.", path);

            List<MarketTick> ticks = new List<MarketTick>();
            bool headerSkipped = false;

            foreach (string line in File.ReadLines(path))
            {
                if (!headerSkipped)
                {
                    headerSkipped = true;
                    continue;
                }

                if (string.IsNullOrWhiteSpace(line))
                    continue;

                MarketTick tick = ParseTick(line);
                DateTime timeUtc = tick.TimeUtc;
                if (startUtc != null && timeUtc < startUtc.Value)
                    continue;
                if (endUtc != null && timeUtc >= endUtc.Value)
                    break;

                ticks.Add(tick);
                if (maxTicks > 0 && ticks.Count >= maxTicks)
                    break;
            }

            return ticks;
        }

        private static MarketTick ParseTick(string line)
        {
            string[] parts = line.Split(',');
            if (parts.Length < 3)
                throw new InvalidOperationException("Invalid tick CSV row: " + line);
            DateTime timeUtc = DateTime.Parse(
                parts[0],
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
            double bid = double.Parse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture);
            double ask = double.Parse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture);
            return new MarketTick(timeUtc, bid, ask);
        }

        public static IReadOnlyList<MarketTick> WithFixedSpread(
            IReadOnlyList<MarketTick> ticks,
            double spreadPips,
            double pipSize)
        {
            if (ticks == null || ticks.Count == 0)
                return Array.Empty<MarketTick>();
            if (spreadPips < 0.0)
                return ticks;

            double spread = Math.Max(0.0, spreadPips) * pipSize;
            List<MarketTick> adjusted = new List<MarketTick>(ticks.Count);
            foreach (MarketTick tick in ticks)
                adjusted.Add(new MarketTick(tick.TimeUtc, tick.Bid, tick.Bid + spread));
            return adjusted;
        }

        public static IReadOnlyList<MarketTick> WithSpreadMultiplier(
            IReadOnlyList<MarketTick> ticks,
            double spreadMultiplier)
        {
            if (ticks == null || ticks.Count == 0)
                return Array.Empty<MarketTick>();
            if (Math.Abs(spreadMultiplier - 1.0) < 0.000000001)
                return ticks;
            if (spreadMultiplier < 0.0)
                throw new ArgumentOutOfRangeException(nameof(spreadMultiplier), "Spread multiplier cannot be negative.");

            List<MarketTick> adjusted = new List<MarketTick>(ticks.Count);
            foreach (MarketTick tick in ticks)
            {
                double spread = Math.Max(0.0, tick.Ask - tick.Bid) * spreadMultiplier;
                adjusted.Add(new MarketTick(tick.TimeUtc, tick.Bid, tick.Bid + spread));
            }
            return adjusted;
        }
    }

    internal static class BarCsvDataSource
    {
        public static IReadOnlyList<MarketBar> Load(string path, int maxBars)
        {
            return Load(path, maxBars, null, null);
        }

        public static IReadOnlyList<MarketBar> Load(string path, int maxBars, DateTime? startUtc, DateTime? endUtc)
        {
            if (string.IsNullOrWhiteSpace(path))
                return Array.Empty<MarketBar>();
            if (!File.Exists(path))
                throw new FileNotFoundException("Bar CSV file was not found.", path);

            List<MarketBar> bars = new List<MarketBar>();
            bool headerSkipped = false;

            foreach (string line in File.ReadLines(path))
            {
                if (!headerSkipped)
                {
                    headerSkipped = true;
                    continue;
                }

                if (string.IsNullOrWhiteSpace(line))
                    continue;

                string[] parts = line.Split(',');
                if (parts.Length < 5)
                    throw new InvalidOperationException("Invalid bar CSV row: " + line);

                DateTime openTimeUtc = DateTime.Parse(
                    parts[0],
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
                if (startUtc != null && openTimeUtc < startUtc.Value)
                    continue;
                if (endUtc != null && openTimeUtc >= endUtc.Value)
                    break;
                double open = double.Parse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture);
                double high = double.Parse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture);
                double low = double.Parse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture);
                double close = double.Parse(parts[4], NumberStyles.Float, CultureInfo.InvariantCulture);

                bars.Add(new MarketBar(openTimeUtc, open, high, low, close));
                if (maxBars > 0 && bars.Count >= maxBars)
                    break;
            }

            return bars;
        }
    }

    internal sealed class MarketReplaySession
    {
        private readonly Robot _bot;
        private readonly ReplaySummary _summary;
        private readonly int _executionLatencyTicks;
        private readonly BarSeriesBuilder _chartBuilder;
        private readonly BarSeriesBuilder _hourBuilder;
        private readonly BarSeriesBuilder _minute5Builder;
        private readonly BarSeriesBuilder _minute15Builder;
        private readonly BarSeriesBuilder _minuteBuilder;
        private readonly bool _chartIsHour;
        private readonly TimerDispatcher _timer;
        private readonly double _stopEquityAtOrAbove;
        private readonly double _stopEquityAtOrBelow;
        private readonly ProtectionFillMode _protectionFillMode;
        private readonly Queue<MarketTick> _latencyBuffer = new Queue<MarketTick>();
        private MarketTick _firstTick;
        private bool _hasFirstTick;

        public MarketReplaySession(
            Robot bot,
            int executionLatencyTicks = 0,
            ReplaySummary summary = null,
            double stopEquityAtOrAbove = double.PositiveInfinity,
            double stopEquityAtOrBelow = double.NegativeInfinity,
            ProtectionFillMode protectionFillMode = ProtectionFillMode.CurrentPrice)
        {
            if (bot == null)
                throw new ArgumentNullException(nameof(bot));
            if (executionLatencyTicks < 0)
                throw new ArgumentOutOfRangeException(nameof(executionLatencyTicks));

            _bot = bot;
            _summary = summary ?? new ReplaySummary();
            _executionLatencyTicks = executionLatencyTicks;
            _stopEquityAtOrAbove = stopEquityAtOrAbove;
            _stopEquityAtOrBelow = stopEquityAtOrBelow;
            _protectionFillMode = protectionFillMode;
            _chartBuilder = new BarSeriesBuilder(bot.TimeFrame, bot.Bars);
            _chartIsHour = string.Equals(bot.TimeFrame.ToString(), TimeFrame.Hour.ToString(), StringComparison.OrdinalIgnoreCase);
            _hourBuilder = new BarSeriesBuilder(
                TimeFrame.Hour, bot.MarketData.GetBars(TimeFrame.Hour));
            _minute5Builder = new BarSeriesBuilder(
                TimeFrame.Minute5, bot.MarketData.GetBars(TimeFrame.Minute5));
            _minute15Builder = new BarSeriesBuilder(TimeFrame.Minute15, bot.MarketData.GetBars(TimeFrame.Minute15));
            _minuteBuilder = new BarSeriesBuilder(TimeFrame.Minute, bot.MarketData.GetBars(TimeFrame.Minute));
            _timer = new TimerDispatcher(bot);
        }

        public ReplaySummary Summary => _summary;
        public bool IsTerminated => !string.IsNullOrWhiteSpace(_summary.TerminationReason);

        public void Process(MarketTick tick)
        {
            if (IsTerminated)
                return;
            if (!_hasFirstTick)
            {
                _hasFirstTick = true;
                _firstTick = tick;
                if (_summary.FirstTickTimeUtc == DateTime.MinValue)
                    _summary.FirstTickTimeUtc = tick.TimeUtc;
            }
            else if (tick.TimeUtc < _summary.LastTickTimeUtc)
                throw new InvalidOperationException("Market ticks must be chronological.");

            DateTime previousTime = _bot.Server.Time;
            MarketReplay.ApplyTick(_bot, tick);
            MarketReplay.ApplyExecutionTick(_bot, ResolveExecutionTick(tick));
            _bot.ProcessStopsAndTargets(_protectionFillMode, nativeTraversal: true);
            // Native tick replay, like server-M1, executes protections on the
            // opening quote before applying rollover deferred across a session
            // break. A position stopped on that quote must not receive swap.
            _bot.ApplyRolloverSwaps(previousTime, tick.TimeUtc);
            _bot.DispatchPositionClosedEvents();
            _timer.FireDue();

            _hourBuilder?.Update(tick.TimeUtc, tick.Bid);
            _minute5Builder?.Update(tick.TimeUtc, tick.Bid);
            _minute15Builder?.Update(tick.TimeUtc, tick.Bid);
            _minuteBuilder.Update(tick.TimeUtc, tick.Bid);
            bool newChartBar = _chartBuilder.Update(tick.TimeUtc, tick.Bid);
            if (TryTerminateAtEquityBarrier(tick))
                return;
            // Native cTrader updates the forming series and delivers OnTick
            // before OnBar when the same quote starts a new chart bar.
            _bot.EngineOnTick();
            _bot.DispatchPositionClosedEvents();
            if (TryTerminateAtEquityBarrier(tick))
                return;
            if (newChartBar)
            {
                _bot.EngineOnBar();
                _bot.DispatchPositionClosedEvents();
                if (TryTerminateAtEquityBarrier(tick))
                    return;
                _summary.OnBarCount++;
            }
            CompleteTick(tick);
            TrySetTermination();
        }

        public void Process(IEnumerable<MarketTick> ticks)
        {
            if (ticks == null)
                return;
            foreach (MarketTick tick in ticks)
            {
                Process(tick);
                if (IsTerminated)
                    break;
            }
        }

        private bool TryTerminateAtEquityBarrier(MarketTick tick)
        {
            if (!EquityBarrierReached())
                return false;
            CompleteTick(tick);
            TrySetTermination();
            return true;
        }

        private void CompleteTick(MarketTick tick)
        {
            _summary.TickCount++;
            _summary.LastTickTimeUtc = tick.TimeUtc;
            _summary.RecordEquity(_bot.Server.Time, _bot.Account.Balance, _bot.Account.Equity);
            _summary.ChartBarCount = _bot.Bars.Count;
            _summary.HourBarCount = _chartIsHour ? _bot.Bars.Count : _bot.MarketData.GetBars(TimeFrame.Hour).Count;
        }

        private bool EquityBarrierReached()
        {
            return _bot.Account.Equity >= _stopEquityAtOrAbove
                || _bot.Account.Equity <= _stopEquityAtOrBelow;
        }

        private void TrySetTermination()
        {
            if (IsTerminated)
                return;
            string reason = _bot.Account.Equity >= _stopEquityAtOrAbove
                ? "equity_at_or_above"
                : _bot.Account.Equity <= _stopEquityAtOrBelow
                    ? "equity_at_or_below"
                    : "";
            if (reason.Length == 0)
                return;

            _summary.TerminationReason = reason;
            _summary.TerminationTimeUtc = _bot.Server.Time;
            _summary.TerminationBalance = _bot.Account.Balance;
            _summary.TerminationEquity = _bot.Account.Equity;
            Console.WriteLine(
                "BACKTESTENGINE_EQUITY_BARRIER reason={0} time={1:o} balance={2:R} equity={3:R} upper={4:R} lower={5:R}",
                reason,
                _summary.TerminationTimeUtc,
                _summary.TerminationBalance,
                _summary.TerminationEquity,
                _stopEquityAtOrAbove,
                _stopEquityAtOrBelow);
        }

        private MarketTick ResolveExecutionTick(MarketTick current)
        {
            _latencyBuffer.Enqueue(current);
            if (_executionLatencyTicks <= 0)
                return current;
            while (_latencyBuffer.Count > _executionLatencyTicks + 1)
                _latencyBuffer.Dequeue();
            return _latencyBuffer.Count <= _executionLatencyTicks
                ? _firstTick
                : _latencyBuffer.Peek();
        }
    }

    internal static class MarketReplay
    {
        public static void PrepareStart(Robot bot, MarketTick firstTick)
        {
            if (bot == null) throw new ArgumentNullException(nameof(bot));
            ApplyTick(bot, firstTick);
            ApplyExecutionTick(bot, firstTick);
            // Native OnStart sees the current quote-only bar in addition to
            // completed history. Seeding through the same builders makes the
            // first replay event continue that bar without a spurious OnBar.
            new BarSeriesBuilder(bot.TimeFrame, bot.Bars).Update(firstTick.TimeUtc, firstTick.Bid);
            foreach (TimeFrame timeframe in new[] { TimeFrame.Hour, TimeFrame.Minute15, TimeFrame.Minute5, TimeFrame.Minute })
                new BarSeriesBuilder(timeframe, bot.MarketData.GetBars(timeframe)).Update(firstTick.TimeUtc, firstTick.Bid);
        }

        public static ReplaySummary Run(
            Robot bot,
            IReadOnlyList<MarketTick> ticks,
            int executionLatencyTicks = 0,
            ReplaySummary summary = null)
        {
            if (bot == null)
                throw new ArgumentNullException(nameof(bot));
            if (ticks == null || ticks.Count == 0)
                return summary ?? new ReplaySummary();

            MarketReplaySession session = new MarketReplaySession(bot, executionLatencyTicks, summary);
            session.Process(ticks);
            return session.Summary;
        }

        public static void ApplyTick(Robot bot, MarketTick tick)
        {
            bot.Server.Time = tick.TimeUtc;
            bot.Symbol.Bid = tick.Bid;
            bot.Symbol.Ask = tick.Ask;
            bot.MarkToMarket();
            bot.EngineObserveQuote();
        }

        public static void ApplyExecutionTick(Robot bot, MarketTick tick)
        {
            bot.ExecutionBid = tick.Bid;
            bot.ExecutionAsk = tick.Ask;
        }

        public static void ApplyBarOpen(Robot bot, MarketBar bar)
        {
            ApplyBarPrice(bot, bar.OpenTimeUtc, bar.Open);
        }

        public static void ApplyBarPrice(Robot bot, DateTime timeUtc, double bid)
        {
            double spread = Math.Max(0.0, bot.Symbol.Ask - bot.Symbol.Bid);
            bot.Server.Time = timeUtc;
            bot.Symbol.Bid = bid;
            bot.Symbol.Ask = bid + spread;
            bot.ExecutionBid = bot.Symbol.Bid;
            bot.ExecutionAsk = bot.Symbol.Ask;
            bot.MarkToMarket();
            bot.EngineObserveQuote();
        }
    }

    internal static class BarReplay
    {
        public static void PreloadSeries(
            Robot bot,
            IReadOnlyDictionary<TimeFrame, IReadOnlyList<MarketBar>> histories,
            DateTime firstReplayTimeUtc)
        {
            if (bot == null) throw new ArgumentNullException(nameof(bot));
            if (histories == null) throw new ArgumentNullException(nameof(histories));
            // Validate every series before mutating any history. An invalid capture
            // must not leave a partially initialized strategy available to trade.
            foreach (KeyValuePair<TimeFrame, IReadOnlyList<MarketBar>> series in histories)
            {
                DateTime previous = DateTime.MinValue;
                foreach (MarketBar bar in series.Value)
                {
                    if (bar.OpenTimeUtc <= previous)
                        throw new InvalidDataException("Warmup series " + series.Key + " must have strictly chronological unique timestamps.");
                    if (bar.OpenTimeUtc >= firstReplayTimeUtc)
                        throw new InvalidDataException("Warmup series " + series.Key + " contains a bar at or after the first replay event.");
                    previous = bar.OpenTimeUtc;
                }
                Bars target = TimeFrameInfo.Same(series.Key, bot.TimeFrame)
                    ? bot.Bars : bot.MarketData.GetBars(series.Key);
                if (target.Count > 0)
                    throw new InvalidOperationException("Warmup series " + series.Key + " would overwrite existing history.");
            }
            foreach (KeyValuePair<TimeFrame, IReadOnlyList<MarketBar>> series in histories)
            {
                Bars target = TimeFrameInfo.Same(series.Key, bot.TimeFrame)
                    ? bot.Bars : bot.MarketData.GetBars(series.Key);
                foreach (MarketBar bar in series.Value)
                    target.Add(bar.OpenTimeUtc, bar.Open, bar.High, bar.Low, bar.Close);
            }
        }

        public static void Preload(Robot bot, IReadOnlyList<MarketBar> bars, TimeFrame sourceTimeFrame)
        {
            if (bot == null)
                throw new ArgumentNullException(nameof(bot));
            if (bars == null || bars.Count == 0)
                return;

            bool chartIsHour = TimeFrameInfo.Same(bot.TimeFrame, TimeFrame.Hour);
            OhlcBarAggregator hourAggregator = new OhlcBarAggregator(
                TimeFrame.Hour, bot.MarketData.GetBars(TimeFrame.Hour));
            OhlcBarAggregator minute5Aggregator = TimeFrameInfo.Same(sourceTimeFrame, TimeFrame.Minute5)
                || TimeFrameInfo.CanAggregate(sourceTimeFrame, TimeFrame.Minute5)
                ? new OhlcBarAggregator(TimeFrame.Minute5, bot.MarketData.GetBars(TimeFrame.Minute5))
                : null;
            OhlcBarAggregator minute15Aggregator = TimeFrameInfo.Same(sourceTimeFrame, TimeFrame.Minute15)
                || TimeFrameInfo.CanAggregate(sourceTimeFrame, TimeFrame.Minute15)
                ? new OhlcBarAggregator(TimeFrame.Minute15, bot.MarketData.GetBars(TimeFrame.Minute15))
                : null;

            if (TimeFrameInfo.Same(sourceTimeFrame, bot.TimeFrame))
            {
                foreach (MarketBar bar in bars)
                {
                    bot.Bars.Add(bar.OpenTimeUtc, bar.Open, bar.High, bar.Low, bar.Close);
                    hourAggregator?.Update(bar);
                    minute5Aggregator?.Update(bar);
                    minute15Aggregator?.Update(bar);
                }
            }
            else if (TimeFrameInfo.CanAggregate(sourceTimeFrame, bot.TimeFrame))
            {
                BarSeriesBuilder chartBuilder = new BarSeriesBuilder(bot.TimeFrame, bot.Bars);
                foreach (MarketBar bar in bars)
                {
                    chartBuilder.UpdateBar(bar);
                    hourAggregator?.Update(bar);
                    minute5Aggregator?.Update(bar);
                    minute15Aggregator?.Update(bar);
                }
            }
            else
            {
                throw new InvalidOperationException("Warmup bar preload requires --bar-period to match or be lower than the chart timeframe.");
            }

            MarketReplay.ApplyBarOpen(bot, bars[bars.Count - 1]);
        }

        public static ReplaySummary Run(
            Robot bot,
            IReadOnlyList<MarketBar> bars,
            TimeFrame sourceTimeFrame,
            SourceBarPriceMode priceMode = SourceBarPriceMode.OhlcSyntheticTicks)
        {
            if (bot == null)
                throw new ArgumentNullException(nameof(bot));
            if (bars == null || bars.Count == 0)
                return new ReplaySummary();
            if (priceMode == SourceBarPriceMode.NativeM1)
            {
                if (!TimeFrameInfo.Same(sourceTimeFrame, TimeFrame.Minute))
                    throw new ArgumentException("native-m1 replay requires one-minute source bars (--bar-period m1).");
                return RunNativeMinute(bot, bars);
            }
            if (TimeFrameInfo.Same(sourceTimeFrame, bot.TimeFrame)
                || TimeFrameInfo.CanAggregate(sourceTimeFrame, bot.TimeFrame))
                return RunAggregated(bot, bars, sourceTimeFrame, priceMode);
            throw new InvalidOperationException(
                "Bar replay requires --bar-period to match or be lower than the chart timeframe.");
        }

        private static ReplaySummary RunNativeMinute(Robot bot, IReadOnlyList<MarketBar> bars)
        {
            var chart = new BarSeriesBuilder(bot.TimeFrame, bot.Bars);
            var additional = new[] { TimeFrame.Hour, TimeFrame.Minute15, TimeFrame.Minute5, TimeFrame.Minute }
                .Select(timeframe => new BarSeriesBuilder(timeframe, bot.MarketData.GetBars(timeframe)))
                .ToArray();
            var summary = new ReplaySummary { FirstTickTimeUtc = bars[0].OpenTimeUtc };
            var timer = new TimerDispatcher(bot);
            double spread = Math.Max(0.0, bot.Symbol.Ask - bot.Symbol.Bid);
            MarketBar previous = bars[0];
            MarketReplay.ApplyBarPrice(bot, previous.OpenTimeUtc, previous.Open);
            chart.Update(previous.OpenTimeUtc, previous.Open);
            foreach (BarSeriesBuilder series in additional) series.Update(previous.OpenTimeUtc, previous.Open);

            // The first quote initializes OnStart. Native M1 does not deliver it
            // again as OnTick or OnBar; callbacks begin at the next minute open.
            for (int index = 1; index < bars.Count && !bot.IsStopped; index++)
            {
                MarketBar current = bars[index];
                if (current.OpenTimeUtc <= previous.OpenTimeUtc)
                    throw new InvalidDataException("Native M1 source bars must be strictly chronological and unique.");
                DateTime previousTime = bot.Server.Time;
                bot.Server.Time = current.OpenTimeUtc;
                bot.ProcessNativeMinuteBarProtections(previous.High, previous.Low, spread);
                bot.DispatchPositionClosedEvents();
                chart.UpdateBar(previous);
                foreach (BarSeriesBuilder series in additional) series.UpdateBar(previous);
                MarketReplay.ApplyBarPrice(bot, current.OpenTimeUtc, current.Open);
                bot.ProcessStopsAndTargets(ProtectionFillMode.CurrentPrice, nativeTraversal: true);
                bot.DispatchPositionClosedEvents();
                // A native gap-opening protection closes before deferred
                // rollover; only positions surviving that quote accrue swaps.
                bot.ApplyRolloverSwaps(previousTime, current.OpenTimeUtc);
                timer.FireDue();

                bool newChartBar = chart.Update(current.OpenTimeUtc, current.Open);
                foreach (BarSeriesBuilder series in additional) series.Update(current.OpenTimeUtc, current.Open);
                bot.EngineOnTick();
                bot.DispatchPositionClosedEvents();
                summary.TickCount++;
                if (newChartBar)
                {
                    bot.EngineOnBar();
                    bot.DispatchPositionClosedEvents();
                    summary.OnBarCount++;
                }
                summary.LastTickTimeUtc = current.OpenTimeUtc;
                summary.RecordEquity(bot.Server.Time, bot.Account.Balance, bot.Account.Equity);
                previous = current;
            }

            // Native final reports include the last bar's hidden range fills at
            // the last opening timestamp. Their events are not flushed before
            // OnStop, and the visible quote remains that opening price.
            bot.ProcessNativeMinuteBarProtections(previous.High, previous.Low, spread);
            chart.UpdateBar(previous);
            foreach (BarSeriesBuilder series in additional) series.UpdateBar(previous);
            summary.LastTickTimeUtc = previous.OpenTimeUtc;
            summary.RecordEquity(bot.Server.Time, bot.Account.Balance, bot.Account.Equity);
            summary.ChartBarCount = bot.Bars.Count;
            summary.HourBarCount = TimeFrameInfo.Same(bot.TimeFrame, TimeFrame.Hour)
                ? bot.Bars.Count : bot.MarketData.GetBars(TimeFrame.Hour).Count;
            return summary;
        }

        private static ReplaySummary RunAggregated(
            Robot bot,
            IReadOnlyList<MarketBar> bars,
            TimeFrame sourceTimeFrame,
            SourceBarPriceMode priceMode)
        {
            if (!TimeFrameInfo.Same(sourceTimeFrame, bot.TimeFrame)
                && !TimeFrameInfo.CanAggregate(sourceTimeFrame, bot.TimeFrame))
                throw new InvalidOperationException("Bar replay requires --bar-period to match or be lower than the chart timeframe.");

            bool chartIsHour = TimeFrameInfo.Same(bot.TimeFrame, TimeFrame.Hour);
            bool chartIsMinute5 = TimeFrameInfo.Same(bot.TimeFrame, TimeFrame.Minute5);
            bool chartIsMinute15 = TimeFrameInfo.Same(bot.TimeFrame, TimeFrame.Minute15);
            BarSeriesBuilder chartBuilder = new BarSeriesBuilder(bot.TimeFrame, bot.Bars);
            OhlcBarAggregator hourAggregator = new OhlcBarAggregator(
                TimeFrame.Hour, bot.MarketData.GetBars(TimeFrame.Hour));
            OhlcBarAggregator minute5Aggregator = !TimeFrameInfo.Same(sourceTimeFrame, TimeFrame.Minute5)
                && !TimeFrameInfo.CanAggregate(sourceTimeFrame, TimeFrame.Minute5)
                ? null
                : new OhlcBarAggregator(TimeFrame.Minute5, bot.MarketData.GetBars(TimeFrame.Minute5));
            OhlcBarAggregator minute15Aggregator = chartIsMinute15
                || (!TimeFrameInfo.Same(sourceTimeFrame, TimeFrame.Minute15)
                    && !TimeFrameInfo.CanAggregate(sourceTimeFrame, TimeFrame.Minute15))
                ? null
                : new OhlcBarAggregator(TimeFrame.Minute15, bot.MarketData.GetBars(TimeFrame.Minute15));

            ReplaySummary summary = new ReplaySummary
            {
                FirstTickTimeUtc = bars[0].OpenTimeUtc
            };
            TimerDispatcher timer = new TimerDispatcher(bot);

            foreach (MarketBar bar in bars)
            {
                DateTime previousTime = bot.Server.Time;
                MarketReplay.ApplyBarPrice(bot, bar.OpenTimeUtc, bar.Open);
                bot.ApplyRolloverSwaps(previousTime, bar.OpenTimeUtc);
                bot.ProcessStopsAndTargets();
                bot.DispatchPositionClosedEvents();
                timer.FireDue();

                // Keep requested lower-timeframe MarketData series causal in
                // aggregated bar replay. Strategies running on H1 may still
                // consume completed M5/M15 structure; previously these series
                // were populated only by tick replay, silently producing an
                // empty lower-timeframe feed in optimizer bar scenarios.
                minute5Aggregator?.Update(bar);
                minute15Aggregator?.Update(bar);
                bool newChartBar = chartBuilder.Update(bar.OpenTimeUtc, bar.Open);
                if (newChartBar)
                {
                    bot.EngineOnBar();
                    bot.DispatchPositionClosedEvents();
                    summary.OnBarCount++;
                }

                RecordSyntheticTick(bot, summary);

                if (priceMode == SourceBarPriceMode.OhlcSyntheticTicks)
                {
                    ApplyIntraBarPoint(bot, chartBuilder, summary, bar.OpenTimeUtc, bar.High);
                    ApplyIntraBarPoint(bot, chartBuilder, summary, bar.OpenTimeUtc, bar.Low);
                    ApplyIntraBarPoint(bot, chartBuilder, summary, bar.OpenTimeUtc, bar.Close);
                }
                else
                {
                    chartBuilder.Update(bar.OpenTimeUtc, bar.High);
                    chartBuilder.Update(bar.OpenTimeUtc, bar.Low);
                    chartBuilder.Update(bar.OpenTimeUtc, bar.Close);
                }
                hourAggregator?.Update(bar);
            }

            summary.ChartBarCount = bot.Bars.Count;
            summary.HourBarCount = chartIsHour ? bot.Bars.Count : bot.MarketData.GetBars(TimeFrame.Hour).Count;
            return summary;
        }

        private static void ApplyIntraBarPoint(
            Robot bot,
            BarSeriesBuilder chartBuilder,
            ReplaySummary summary,
            DateTime timeUtc,
            double bid)
        {
            MarketReplay.ApplyBarPrice(bot, timeUtc, bid);
            bot.ProcessStopsAndTargets();
            bot.DispatchPositionClosedEvents();
            chartBuilder.Update(timeUtc, bid);
            RecordSyntheticTick(bot, summary);
        }

        private static void RecordSyntheticTick(Robot bot, ReplaySummary summary)
        {
            bot.EngineOnTick();
            bot.DispatchPositionClosedEvents();
            summary.TickCount++;
            summary.LastTickTimeUtc = bot.Server.Time;
            summary.RecordEquity(bot.Server.Time, bot.Account.Balance, bot.Account.Equity);
        }

        private static void AddOpeningChartBar(Bars bars, MarketBar bar)
        {
            bars.Add(bar.OpenTimeUtc, bar.Open, bar.Open, bar.Open, bar.Open);
        }

        private static void FinalizeLastChartBar(Bars bars, MarketBar bar)
        {
            int index = bars.Count - 1;
            bars.OpenPrices[index] = bar.Open;
            bars.HighPrices[index] = bar.High;
            bars.LowPrices[index] = bar.Low;
            bars.ClosePrices[index] = bar.Close;
        }
    }

    internal sealed class TimerDispatcher
    {
        private readonly Robot _bot;
        private DateTime _nextDueUtc;

        public TimerDispatcher(Robot bot)
        {
            _bot = bot ?? throw new ArgumentNullException(nameof(bot));
            if (_bot.Timer.IntervalSeconds > 0 && _bot.Server.Time != DateTime.MinValue)
                _nextDueUtc = _bot.Server.Time.AddSeconds(_bot.Timer.IntervalSeconds);
        }

        public void FireDue()
        {
            if (_bot.Timer.IntervalSeconds <= 0)
                return;
            if (_nextDueUtc == DateTime.MinValue)
                _nextDueUtc = _bot.Server.Time.AddSeconds(_bot.Timer.IntervalSeconds);

            while (_nextDueUtc <= _bot.Server.Time)
            {
                DateTime originalTime = _bot.Server.Time;
                _bot.Server.Time = _nextDueUtc;
                _bot.EngineOnTimer();
                _bot.DispatchPositionClosedEvents();
                _bot.Server.Time = originalTime;
                _nextDueUtc = _nextDueUtc.AddSeconds(_bot.Timer.IntervalSeconds);
            }
        }
    }

    internal sealed class BarSeriesBuilder
    {
        private readonly TimeFrameInfo _timeFrame;
        private readonly Bars _bars;
        private DateTime _currentOpenTime = DateTime.MinValue;

        public BarSeriesBuilder(TimeFrame timeFrame, Bars bars)
        {
            _timeFrame = TimeFrameInfo.From(timeFrame);
            _bars = bars ?? throw new ArgumentNullException(nameof(bars));
            if (_bars.Count > 0)
                _currentOpenTime = _bars.OpenTimes[_bars.Count - 1];
        }

        public bool Update(DateTime timeUtc, double price)
        {
            DateTime openTime = _timeFrame.GetOpenTime(timeUtc);
            if (_bars.Count == 0)
            {
                _bars.Add(openTime, price, price, price, price);
                _currentOpenTime = openTime;
                return false;
            }

            if (openTime > _currentOpenTime)
            {
                _bars.Add(openTime, price, price, price, price);
                _currentOpenTime = openTime;
                return true;
            }

            int index = _bars.Count - 1;
            _bars.HighPrices[index] = Math.Max(_bars.HighPrices[index], price);
            _bars.LowPrices[index] = Math.Min(_bars.LowPrices[index], price);
            _bars.ClosePrices[index] = price;
            return false;
        }

        public bool UpdateBar(MarketBar bar)
        {
            bool opened = Update(bar.OpenTimeUtc, bar.Open);
            Update(bar.OpenTimeUtc, bar.High);
            Update(bar.OpenTimeUtc, bar.Low);
            Update(bar.OpenTimeUtc, bar.Close);
            return opened;
        }
    }

    internal sealed class OhlcBarAggregator
    {
        private readonly TimeFrameInfo _timeFrame;
        private readonly Bars _bars;
        private DateTime _currentOpenTime = DateTime.MinValue;

        public OhlcBarAggregator(TimeFrame timeFrame, Bars bars)
        {
            _timeFrame = TimeFrameInfo.From(timeFrame);
            _bars = bars ?? throw new ArgumentNullException(nameof(bars));
            if (_bars.Count > 0)
                _currentOpenTime = _bars.OpenTimes[_bars.Count - 1];
        }

        public void Update(MarketBar closedBar)
        {
            DateTime openTime = _timeFrame.GetOpenTime(closedBar.OpenTimeUtc);
            if (_bars.Count == 0 || openTime > _currentOpenTime)
            {
                _bars.Add(openTime, closedBar.Open, closedBar.High, closedBar.Low, closedBar.Close);
                _currentOpenTime = openTime;
                return;
            }

            int index = _bars.Count - 1;
            _bars.HighPrices[index] = Math.Max(_bars.HighPrices[index], closedBar.High);
            _bars.LowPrices[index] = Math.Min(_bars.LowPrices[index], closedBar.Low);
            _bars.ClosePrices[index] = closedBar.Close;
        }
    }

    internal sealed class TimeFrameInfo
    {
        private readonly int _minutes;
        private readonly string _kind;

        private TimeFrameInfo(string kind, int minutes)
        {
            _kind = kind;
            _minutes = minutes;
        }

        public static TimeFrameInfo From(TimeFrame timeFrame)
        {
            string name = timeFrame?.ToString() ?? "";
            switch (name.ToLowerInvariant())
            {
                case "minute":
                    return new TimeFrameInfo("minute", 1);
                case "minute5":
                    return new TimeFrameInfo("minute", 5);
                case "minute15":
                    return new TimeFrameInfo("minute", 15);
                case "minute30":
                    return new TimeFrameInfo("minute", 30);
                case "hour":
                    return new TimeFrameInfo("minute", 60);
                case "hour4":
                    return new TimeFrameInfo("minute", 240);
                case "daily":
                    return new TimeFrameInfo("day", 1440);
                case "weekly":
                    return new TimeFrameInfo("week", 10080);
                case "monthly":
                    return new TimeFrameInfo("month", 0);
                default:
                    throw new InvalidOperationException("Unsupported TimeFrame: " + name);
            }
        }

        public static bool Same(TimeFrame left, TimeFrame right)
        {
            if (left == null || right == null)
                return left == right;
            return string.Equals(left.ToString(), right.ToString(), StringComparison.OrdinalIgnoreCase);
        }

        public static bool CanAggregate(TimeFrame source, TimeFrame target)
        {
            TimeFrameInfo sourceInfo = From(source);
            TimeFrameInfo targetInfo = From(target);
            return sourceInfo._kind == "minute"
                && targetInfo._kind == "minute"
                && sourceInfo._minutes > 0
                && targetInfo._minutes > sourceInfo._minutes
                && targetInfo._minutes % sourceInfo._minutes == 0;
        }

        public DateTime GetOpenTime(DateTime timeUtc)
        {
            DateTime utc = timeUtc.Kind == DateTimeKind.Utc ? timeUtc : DateTime.SpecifyKind(timeUtc, DateTimeKind.Utc);

            switch (_kind)
            {
                case "minute":
                    long ticksPerBucket = TimeSpan.FromMinutes(_minutes).Ticks;
                    long bucketTicks = utc.Ticks - utc.Ticks % ticksPerBucket;
                    return new DateTime(bucketTicks, DateTimeKind.Utc);
                case "day":
                    return new DateTime(utc.Year, utc.Month, utc.Day, 0, 0, 0, DateTimeKind.Utc);
                case "week":
                    int offset = ((int)utc.DayOfWeek + 6) % 7;
                    DateTime monday = utc.Date.AddDays(-offset);
                    return DateTime.SpecifyKind(monday, DateTimeKind.Utc);
                case "month":
                    return new DateTime(utc.Year, utc.Month, 1, 0, 0, 0, DateTimeKind.Utc);
                default:
                    throw new InvalidOperationException("Unsupported timeframe kind: " + _kind);
            }
        }
    }
}
