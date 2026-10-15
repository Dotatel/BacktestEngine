using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace cAlgo.API
{
    public static class TimeZones
    {
        public const string UTC = "UTC";
    }

    public enum AccessRights
    {
        None,
        FullAccess
    }

    public enum TradeType
    {
        Buy,
        Sell
    }

    public enum RoundingMode
    {
        Down,
        Up,
        ToNearest
    }

    public enum ProtectionFillMode
    {
        StopOrTargetPrice,
        CurrentPrice
    }

    public enum PositionCloseReason
    {
        Closed,
        StopLoss,
        TakeProfit,
        StopOut
    }

    public enum CommissionRoundingMode
    {
        CurrencyCent,
        CTraderXauUsdVolume
    }

    public enum LocalStorageScope
    {
        Instance
    }

    [AttributeUsage(AttributeTargets.Class)]
    public sealed class RobotAttribute : Attribute
    {
        public string TimeZone { get; set; } = TimeZones.UTC;
        public AccessRights AccessRights { get; set; } = AccessRights.None;
    }

    [AttributeUsage(AttributeTargets.Property)]
    public sealed class ParameterAttribute : Attribute
    {
        public ParameterAttribute(string name)
        {
            Name = name;
        }

        public string Name { get; }
        public object DefaultValue { get; set; }
        public object MinValue { get; set; }
        public object MaxValue { get; set; }
        public object Step { get; set; }
        public string Group { get; set; } = "";
    }

    public sealed class TimeFrame
    {
        private readonly string _name;

        private TimeFrame(string name)
        {
            _name = name;
        }

        public static TimeFrame Minute { get; } = new TimeFrame("Minute");
        public static TimeFrame Minute5 { get; } = new TimeFrame("Minute5");
        public static TimeFrame Minute15 { get; } = new TimeFrame("Minute15");
        public static TimeFrame Minute30 { get; } = new TimeFrame("Minute30");
        public static TimeFrame Hour { get; } = new TimeFrame("Hour");
        public static TimeFrame Hour4 { get; } = new TimeFrame("Hour4");
        public static TimeFrame Daily { get; } = new TimeFrame("Daily");
        public static TimeFrame Weekly { get; } = new TimeFrame("Weekly");
        public static TimeFrame Monthly { get; } = new TimeFrame("Monthly");

        public override string ToString()
        {
            return _name;
        }
    }

    public abstract class Robot
    {
        protected Robot()
        {
            Bars = new Bars();
            Symbol = new Symbol();
            Account = new Account();
            Positions = new Positions();
            History = new TradeHistory();
            MarketData = new MarketData();
            LocalStorage = new LocalStorage();
            Server = new Server();
            Timer = new Timer();
            SymbolName = "";
            TimeFrame = TimeFrame.Minute;
        }

        public Bars Bars { get; set; }
        public Symbol Symbol { get; set; }
        public Account Account { get; set; }
        public Positions Positions { get; set; }
        public TradeHistory History { get; }
        public MarketData MarketData { get; set; }
        public LocalStorage LocalStorage { get; set; }
        public Server Server { get; set; }
        public Timer Timer { get; set; }
        public string SymbolName { get; set; }
        public string RequestedSymbolName { get; set; } = "";
        public string SymbolSpecificationPath { get; set; } = "";
        public TimeFrame TimeFrame { get; set; }
        public double CommissionUsdPerMillion { get; set; }
        public double ExecutionSlippagePips { get; set; }
        public double ExecutionBid { get; set; } = double.NaN;
        public double ExecutionAsk { get; set; } = double.NaN;

        // Engine observers run synchronously, including between two orders in one callback.
        public event Action EngineDealCompleted;
        public event Action EngineQuoteMarked;
        public void EngineObserveQuote() => EngineQuoteMarked?.Invoke();

        public bool IsStopped { get; private set; }

        public void Stop()
        {
            IsStopped = true;
        }

        protected virtual void OnStart() { }
        protected virtual void OnBar() { }
        protected virtual void OnTick() { }
        protected virtual void OnTimer() { }
        protected virtual void OnStop() { }

        public void EngineOnStart()
        {
            OnStart();
            if (IsStopped)
                throw new InvalidOperationException("The strategy stopped during initialization. This run is invalid; inspect the startup error above.");
        }

        public void EngineOnBar()
        {
            if (!IsStopped)
                OnBar();
        }

        public void EngineOnTick()
        {
            if (!IsStopped)
                OnTick();
        }

        public void EngineOnTimer()
        {
            if (!IsStopped)
                OnTimer();
        }

        public void EngineOnStop()
        {
            OnStop();
        }

        public void DispatchPositionClosedEvents()
        {
            Positions.DispatchClosedEvents();
        }

        protected TradeResult ExecuteMarketOrder(
            TradeType tradeType,
            string symbolName,
            double volume,
            string label = "",
            double? stopLossPips = null,
            double? takeProfitPips = null,
            string comment = "")
        {
            EffectiveSymbolSpecification spec = RequireEconomicSpecification();
            if (volume <= 0.0)
                return TradeResult.Failure("Volume must be positive");
            if (!Symbol.IsValidVolumeInUnits(volume))
                return TradeResult.Failure("Volume is outside the effective symbol contract or not aligned to its step");

            double entryPrice = tradeType == TradeType.Buy ? FillBuy() : FillSell();
            double entryCommission = CalculateCommission(entryPrice, volume);
            // cTrader rounds the requested distance before applying it to the
            // fill price. Rounding the resulting absolute price differs at ties.
            double? normalizedStopDistance = NormalizeProtectionDistance(stopLossPips);
            double? normalizedTargetDistance = NormalizeProtectionDistance(takeProfitPips);
            var position = new Position
            {
                Id = Positions.NextId(),
                SymbolName = symbolName,
                Label = label ?? "",
                Comment = comment ?? "",
                TradeType = tradeType,
                VolumeInUnits = volume,
                EntryPrice = entryPrice,
                EntryTime = Server.Time,
                EntryBid = double.IsNaN(ExecutionBid) ? Symbol.Bid : ExecutionBid,
                EntryAsk = double.IsNaN(ExecutionAsk) ? Symbol.Ask : ExecutionAsk,
                PipSizeAtEntry = Symbol.PipSize,
                IntendedRiskMoney = normalizedStopDistance.HasValue
                    ? Symbol.AmountRisked(volume, normalizedStopDistance.Value / Symbol.PipSize)
                    : 0.0,
                EntryCommission = entryCommission,
                Commissions = entryCommission,
                EconomicSpecificationHash = spec.CanonicalSpecSha256
            };
            position.SetInitialProtectionDistances(normalizedStopDistance, normalizedTargetDistance);

            Positions.Add(position);
            MarkToMarket();
            EngineDealCompleted?.Invoke();
            return TradeResult.Success(position);
        }

        private double? NormalizeProtectionDistance(double? pips)
        {
            return pips.HasValue
                ? Math.Round(pips.Value * Symbol.PipSize, Symbol.Digits, MidpointRounding.AwayFromZero)
                : null;
        }

        protected TradeResult ClosePosition(Position position)
        {
            if (position == null)
                return TradeResult.Failure("Position is null");
            if (!Positions.Contains(position))
                return TradeResult.Failure("Position is not open");

            double closePrice = position.TradeType == TradeType.Buy ? FillSell() : FillBuy();
            return ClosePositionAtPrice(position, closePrice, "manual");
        }

        protected TradeResult ClosePosition(Position position, double volume)
        {
            if (position == null)
                return TradeResult.Failure("Position is null");
            if (!Positions.Contains(position))
                return TradeResult.Failure("Position is not open");
            if (!double.IsFinite(volume) || volume <= 0.0)
                return TradeResult.Failure("Close volume must be finite and positive");
            if (volume > position.VolumeInUnits)
                return TradeResult.Failure("Close volume exceeds the open position volume");
            if (volume == position.VolumeInUnits)
                return ClosePosition(position);
            return TradeResult.Failure("Partial position closes are not supported by this engine; no execution or account mutation occurred");
        }

        public void ProcessStopsAndTargets(ProtectionFillMode fillMode = ProtectionFillMode.StopOrTargetPrice, bool nativeTraversal = false)
        {
            if (nativeTraversal)
            {
                ProcessNativeProtectionBook(TradeType.Sell, false, fillMode);
                ProcessNativeProtectionBook(TradeType.Buy, false, fillMode);
                ProcessNativeProtectionBook(TradeType.Buy, true, fillMode);
                ProcessNativeProtectionBook(TradeType.Sell, true, fillMode);
                return;
            }
            foreach (Position position in Positions.All().ToArray())
            {
                if (TryGetStopOrTargetFill(position, fillMode, out double closePrice, out string reason))
                    ClosePositionAtPrice(position, closePrice, reason);
            }
        }

        private void ProcessNativeProtectionBook(TradeType side, bool target, ProtectionFillMode fillMode)
        {
            double Level(Position position) => (target ? position.TakeProfit : position.StopLoss).Value;
            bool ascending = target ? side == TradeType.Buy : side == TradeType.Sell;
            var candidates = Positions.All().Where(position => position.TradeType == side
                && (target ? position.TakeProfit : position.StopLoss).HasValue);
            List<Position> book = (ascending ? candidates.OrderBy(Level) : candidates.OrderByDescending(Level))
                .ThenByDescending(position => position.Id).ToList();
            for (int index = 0; index < book.Count; index++)
            {
                Position position = book[index];
                double level = Level(position);
                double quote = side == TradeType.Buy ? Symbol.Bid : Symbol.Ask;
                bool triggered = ascending ? quote >= level : quote <= level;
                if (!triggered) break;
                double fill = fillMode == ProtectionFillMode.CurrentPrice
                    ? (side == TradeType.Buy ? FillSell() : FillBuy())
                    : level + (side == TradeType.Buy ? -1.0 : 1.0) * ExecutionSlippagePips * Symbol.PipSize;
                ClosePositionAtPrice(position, fill, target ? "take_profit" : "stop_loss");
                // Native tick probes show a price-ordered book whose traversal
                // advances after removal: the adjacent pending protection waits
                // for another qualifying quote. Preserve that observed behavior.
                book.RemoveAt(index);
            }
        }

        public void ProcessNativeMinuteBarProtections(double highBid, double lowBid, double spread)
        {
            if (!double.IsFinite(highBid) || !double.IsFinite(lowBid) || highBid < lowBid
                || !double.IsFinite(spread) || spread < 0.0)
                throw new ArgumentException("Native minute protection requires a finite valid bid range and non-negative spread.");
            // Native M1 probes show range-based protection, not a synthetic price
            // path: an SL touched anywhere wins over a TP touched in the same bar.
            // Sell SLs execute at high ask, then buy SLs at low bid, before TPs.
            // Keep the visible quote unchanged until the next opening quote; the
            // broker delivers closed events while the strategy still sees it.
            var fills = new List<(Position Position, double Price, string Reason, int Order, double Bid, double Ask)>();
            double highAsk = highBid + spread;
            double lowAsk = lowBid + spread;
            double slippage = ExecutionSlippagePips * Symbol.PipSize;
            foreach (Position position in Positions.All().ToArray())
            {
                if (position.TradeType == TradeType.Sell)
                {
                    if (position.StopLoss.HasValue && highAsk >= position.StopLoss.Value)
                        fills.Add((position, highAsk + slippage, "stop_loss", 0, highBid, highAsk));
                    else if (position.TakeProfit.HasValue && lowAsk <= position.TakeProfit.Value)
                        fills.Add((position, lowAsk + slippage, "take_profit", 3, lowBid, lowAsk));
                }
                else
                {
                    if (position.StopLoss.HasValue && lowBid <= position.StopLoss.Value)
                        fills.Add((position, lowBid - slippage, "stop_loss", 1, lowBid, lowAsk));
                    else if (position.TakeProfit.HasValue && highBid >= position.TakeProfit.Value)
                        fills.Add((position, highBid - slippage, "take_profit", 2, highBid, highAsk));
                }
            }
            foreach (var phase in fills.GroupBy(fill => fill.Order).OrderBy(group => group.Key))
            {
                double Level((Position Position, double Price, string Reason, int Order, double Bid, double Ask) fill)
                    => (fill.Reason == "stop_loss" ? fill.Position.StopLoss : fill.Position.TakeProfit).Value;
                bool ascending = phase.Key == 0 || phase.Key == 2;
                var book = (ascending ? phase.OrderBy(Level) : phase.OrderByDescending(Level))
                    .ThenByDescending(fill => fill.Position.Id).ToList();
                for (int index = 0; index < book.Count; index++)
                {
                    var fill = book[index];
                    ClosePositionAtPrice(fill.Position, fill.Price, fill.Reason, fill.Bid, fill.Ask);
                    // Native M1 uses the same mutable sorted protection book as
                    // native ticks: removing a fill advances past its neighbor.
                    // A skipped SL can fill at the next opening quote or range;
                    // its touched TP must not replace that SL in this range.
                    book.RemoveAt(index);
                }
            }
        }

        public void MarkToMarket()
        {
            double equity = Account.Balance;
            foreach (Position position in Positions.All())
            {
                double closePrice = position.TradeType == TradeType.Buy
                    ? Symbol.Bid - ExecutionSlippagePips * Symbol.PipSize
                    : Symbol.Ask + ExecutionSlippagePips * Symbol.PipSize;
                double estimatedCloseCommission = CalculateCommission(closePrice, position.VolumeInUnits);
                UpdatePositionProfit(position, closePrice, estimatedCloseCommission);
                equity += position.NetProfit;
            }

            Account.Equity = equity;
        }

        public void ApplyRolloverSwaps(DateTime previousTime, DateTime currentTime)
        {
            EffectiveSymbolSpecification spec = RequireEconomicSpecification();
            if (previousTime == DateTime.MinValue || currentTime <= previousTime || !Positions.All().Any())
                return;
            if (spec.SwapTimeAuthorityStatus == SwapTimeAuthorityStatus.Unknown)
            {
                if (spec.SwapLong == 0.0 && spec.SwapShort == 0.0)
                    return;
                throw new InvalidOperationException("Swap time authority is UNKNOWN; advancing an open non-zero-swap position fails closed.");
            }

            DateTime rollover = NextRolloverAfter(previousTime);
            while (rollover <= currentTime)
            {
                // A gap between executable ticks can span weekend rollovers.
                // Wednesday's multiplier already accounts for those days in
                // the supported no-weekend schedule.
                if (!spec.SwapWeekendCharging
                    && (rollover.DayOfWeek == DayOfWeek.Saturday || rollover.DayOfWeek == DayOfWeek.Sunday))
                {
                    rollover = rollover.AddDays(1);
                    continue;
                }
                foreach (Position position in Positions.All())
                {
                    if (position.EntryTime >= rollover || position.LastSwapTime >= rollover)
                        continue;

                    double swapRate = position.TradeType == TradeType.Buy ? spec.SwapLong : spec.SwapShort;
                    int multiplier = IsTripleRolloverDay(rollover.DayOfWeek) ? 3 : 1;
                    double swap = spec.SwapCalculationType switch
                    {
                        EconomicSwapCalculationType.Pips =>
                            swapRate * spec.PipValue * position.VolumeInUnits * multiplier,
                        EconomicSwapCalculationType.Percentage =>
                            position.VolumeInUnits * Symbol.Bid * swapRate / 100.0
                            / spec.PercentageSwapDayCount * multiplier * spec.QuoteToAccountConversionRate,
                        _ => throw new NotSupportedException("Unsupported swap calculation type " + spec.SwapCalculationType + ".")
                    };
                    position.Swaps += Math.Round(swap, Account.DepositAssetDigits, MidpointRounding.AwayFromZero);
                    position.LastSwapTime = rollover;
                    MarkToMarket();
                }

                rollover = rollover.AddDays(1);
            }
        }

        private void UpdatePositionProfit(Position position, double closePrice, double closeCommission)
        {
            if (position == null)
                return;

            double pips = 0.0;
            if (Symbol.PipSize > 0.0)
            {
                pips = position.TradeType == TradeType.Buy
                    ? (closePrice - position.EntryPrice) / Symbol.PipSize
                    : (position.EntryPrice - closePrice) / Symbol.PipSize;
            }

            double grossProfit = pips * Symbol.PipValue * position.VolumeInUnits;
            double conversionFee = Math.Abs(grossProfit) * RequireEconomicSpecification().PnLConversionFeeRate;
            position.Pips = pips;
            position.GrossProfit = grossProfit;
            position.PnLConversionFees = -conversionFee;
            position.Commissions = position.EntryCommission + closeCommission;
            position.NetProfit = grossProfit + position.PnLConversionFees + position.Commissions + position.Swaps;
            position.NetR = position.IntendedRiskMoney > 0.0
                ? position.NetProfit / position.IntendedRiskMoney
                : 0.0;
            position.MaeNetProfit = Math.Min(position.MaeNetProfit, position.NetProfit);
            position.MfeNetProfit = Math.Max(position.MfeNetProfit, position.NetProfit);
        }

        public double EstimateCommissionForFill(double price, double volume)
        {
            return CalculateCommission(price, volume);
        }

        private double CalculateCommission(double price, double volume)
        {
            EffectiveSymbolSpecification spec = RequireEconomicSpecification();
            // Monetary multiplication and rounding use decimal so an exact
            // half-cent (for example 100k EUR * 1.14 * 22.5/million = 2.565)
            // cannot drift below the rounding boundary in binary arithmetic.
            decimal notionalUsd = spec.UsdNotionalConversionRule switch
            {
                "base_currency_is_usd" => Math.Abs((decimal)volume),
                "fixed_base_to_usd" => Math.Abs((decimal)volume) * (decimal)spec.CommissionBaseToUsdRate,
                "quote_currency_is_usd_price_times_volume" => Math.Abs((decimal)price * (decimal)volume),
                _ => throw new NotSupportedException("Unsupported USD notional conversion rule '" + spec.UsdNotionalConversionRule + "'.")
            };
            decimal variableCost = spec.CommissionModel switch
            {
                EconomicCommissionModel.UsdPerMillionUsdVolume => notionalUsd / 1000000m * (decimal)spec.CommissionRate,
                _ => throw new NotSupportedException("Unsupported commission model " + spec.CommissionModel + ".")
            };
            decimal cost = Math.Max(variableCost, (decimal)spec.MinimumCommission);
            if (cost <= 0m)
                return 0.0;
            return -RoundCommission(cost);
        }

        private double FillSell()
        {
            double bid = double.IsNaN(ExecutionBid) ? Symbol.Bid : ExecutionBid;
            return bid - ExecutionSlippagePips * Symbol.PipSize;
        }

        private double FillBuy()
        {
            double ask = double.IsNaN(ExecutionAsk) ? Symbol.Ask : ExecutionAsk;
            return ask + ExecutionSlippagePips * Symbol.PipSize;
        }

        private double RoundCommission(decimal cost)
        {
            if (RequireEconomicSpecification().CommissionRoundingMode == CommissionRoundingMode.CTraderXauUsdVolume && cost >= 0.1m)
                return (double)(Math.Floor(cost * 10m) / 10m);
            return (double)Math.Round(cost, Account.DepositAssetDigits, MidpointRounding.AwayFromZero);
        }

        private DateTime NextRolloverAfter(DateTime time)
        {
            TimeSpan rolloverTime = Symbol.SwapTimeUtc
                ?? throw new InvalidOperationException("Swap time authority is UNKNOWN; rollover cannot be scheduled.");
            DateTime date = time.Date.Add(rolloverTime);
            if (date <= time)
                date = date.AddDays(1);
            return DateTime.SpecifyKind(date, DateTimeKind.Utc);
        }

        private bool IsTripleRolloverDay(DayOfWeek day)
        {
            return day == RequireEconomicSpecification().Swap3DaysRollover;
        }

        private EffectiveSymbolSpecification RequireEconomicSpecification()
        {
            return Symbol.EffectiveSpecification
                ?? throw new InvalidOperationException("No effective symbol specification is applied; economic accounting fails closed.");
        }

        private TradeResult ClosePositionAtPrice(Position position, double closePrice, string reason,
            double? executionBid = null, double? executionAsk = null)
        {
            if (position == null)
                return TradeResult.Failure("Position is null");
            if (!Positions.Contains(position))
                return TradeResult.Failure("Position is not open");

            double closeCommission = CalculateCommission(closePrice, position.VolumeInUnits);
            UpdatePositionProfit(position, closePrice, closeCommission);

            position.ClosePrice = closePrice;
            position.ClosingTime = Server.Time;
            position.CloseBid = executionBid ?? (double.IsNaN(ExecutionBid) ? Symbol.Bid : ExecutionBid);
            position.CloseAsk = executionAsk ?? (double.IsNaN(ExecutionAsk) ? Symbol.Ask : ExecutionAsk);
            position.ClosingCommission = closeCommission;
            position.Commissions = position.EntryCommission + position.ClosingCommission;
            position.ClosingReason = reason ?? "";

            Account.Balance += position.NetProfit;

            Positions.Remove(position);
            History.Add(position);
            MarkToMarket();
            EngineDealCompleted?.Invoke();
            Positions.QueueClosed(position, ToPositionCloseReason(position.ClosingReason));
            return TradeResult.Success(position);
        }

        private static PositionCloseReason ToPositionCloseReason(string reason)
        {
            return reason switch
            {
                "stop_loss" => PositionCloseReason.StopLoss,
                "take_profit" => PositionCloseReason.TakeProfit,
                _ => PositionCloseReason.Closed
            };
        }

        private bool TryGetStopOrTargetFill(Position position, ProtectionFillMode fillMode, out double closePrice, out string reason)
        {
            closePrice = 0.0;
            reason = "";

            if (Symbol.PipSize <= 0.0)
                return false;

            if (position.TradeType == TradeType.Buy)
            {
                if (position.StopLoss.HasValue)
                {
                    double stopPrice = position.StopLoss.Value;
                    if (Symbol.Bid <= stopPrice)
                    {
                        closePrice = fillMode == ProtectionFillMode.CurrentPrice
                            ? FillSell()
                            : stopPrice - ExecutionSlippagePips * Symbol.PipSize;
                        reason = "stop_loss";
                        return true;
                    }
                }

                if (position.TakeProfit.HasValue)
                {
                    double targetPrice = position.TakeProfit.Value;
                    if (Symbol.Bid >= targetPrice)
                    {
                        closePrice = fillMode == ProtectionFillMode.CurrentPrice
                            ? FillSell()
                            : targetPrice - ExecutionSlippagePips * Symbol.PipSize;
                        reason = "take_profit";
                        return true;
                    }
                }
            }
            else
            {
                if (position.StopLoss.HasValue)
                {
                    double stopPrice = position.StopLoss.Value;
                    if (Symbol.Ask >= stopPrice)
                    {
                        closePrice = fillMode == ProtectionFillMode.CurrentPrice
                            ? FillBuy()
                            : stopPrice + ExecutionSlippagePips * Symbol.PipSize;
                        reason = "stop_loss";
                        return true;
                    }
                }

                if (position.TakeProfit.HasValue)
                {
                    double targetPrice = position.TakeProfit.Value;
                    if (Symbol.Ask <= targetPrice)
                    {
                        closePrice = fillMode == ProtectionFillMode.CurrentPrice
                            ? FillBuy()
                            : targetPrice + ExecutionSlippagePips * Symbol.PipSize;
                        reason = "take_profit";
                        return true;
                    }
                }
            }

            return false;
        }

        protected void Print(string message)
        {
            Console.WriteLine(message);
        }

        protected void Print(string format, params object[] args)
        {
            Console.WriteLine(string.Format(CultureInfo.InvariantCulture, format, args));
        }
    }

    public sealed class Server
    {
        public DateTime Time { get; set; } = DateTime.MinValue;
    }

    public sealed class Timer
    {
        public int IntervalSeconds { get; private set; }

        public void Start(int seconds)
        {
            IntervalSeconds = seconds;
        }
    }

    public sealed class MarketData
    {
        private readonly Dictionary<string, Bars> _barsByKey = new Dictionary<string, Bars>(StringComparer.OrdinalIgnoreCase);

        public Bars GetBars(TimeFrame timeFrame)
        {
            return GetBars(timeFrame, "");
        }

        public Bars GetBars(TimeFrame timeFrame, string symbolName)
        {
            string key = (symbolName ?? "") + "|" + timeFrame;
            if (!_barsByKey.TryGetValue(key, out Bars bars))
            {
                bars = new Bars();
                _barsByKey[key] = bars;
            }
            return bars;
        }
    }

    /// <summary>
    /// In-memory equivalent of cTrader instance local storage. BacktestEngine
    /// intentionally starts each Robot with an isolated store so replay state
    /// cannot leak between runs.
    /// </summary>
    public sealed class LocalStorage
    {
        private readonly Dictionary<string, string> _values = new Dictionary<string, string>(StringComparer.Ordinal);

        public string GetString(string key, LocalStorageScope scope)
        {
            return key != null && _values.TryGetValue(key, out string value) ? value : null;
        }

        public void SetString(string key, string value, LocalStorageScope scope)
        {
            if (key == null) throw new ArgumentNullException(nameof(key));
            _values[key] = value ?? string.Empty;
        }

        public void Remove(string key, LocalStorageScope scope)
        {
            if (key != null) _values.Remove(key);
        }

        public void Reload(LocalStorageScope scope) { }

        public void Flush(LocalStorageScope scope) { }
    }

    public sealed class Bars
    {
        public int LoadMoreHistory()
        {
            // BacktestEngine history is preloaded explicitly by MarketReplay.
            return 0;
        }
        public IList<DateTime> OpenTimes { get; } = new List<DateTime>();
        public IList<double> OpenPrices { get; } = new List<double>();
        public IList<double> HighPrices { get; } = new List<double>();
        public IList<double> LowPrices { get; } = new List<double>();
        public IList<double> ClosePrices { get; } = new List<double>();

        public int Count
        {
            get { return ClosePrices.Count; }
        }

        public void Add(DateTime openTime, double open, double high, double low, double close)
        {
            OpenTimes.Add(openTime);
            OpenPrices.Add(open);
            HighPrices.Add(high);
            LowPrices.Add(low);
            ClosePrices.Add(close);
        }
    }

    public sealed class Account
    {
        public cAlgo.API.Internals.AccountType AccountType { get; set; } =
            cAlgo.API.Internals.AccountType.Hedged;
        public int Number { get; set; } = 1;
        public string DepositAssetName { get; set; } = "";
        public int DepositAssetDigits { get; set; } = 2;
        public double StartingBalance { get; set; } = 10000.0;
        public double Balance { get; set; } = 10000.0;
        public double Equity { get; set; } = 10000.0;
    }

    public sealed class Symbol
    {
        public Symbol()
        {
            MarketHours = new MarketHours(this);
        }

        public string Name { get; set; } = "";
        public string BaseAsset { get; set; } = "";
        public string QuoteAsset { get; set; } = "";
        public double Ask { get; set; }
        public double Bid { get; set; }
        public double PipSize { get; set; }
        public double TickSize { get; set; }
        public double PipValue { get; set; }
        public double TickValue { get; set; }
        public int Digits { get; set; }
        public double LotSize { get; set; }
        public double ContractMultiplier { get; set; }
        public double VolumeInUnitsMin { get; set; }
        public double VolumeInUnitsMax { get; set; }
        public double VolumeInUnitsStep { get; set; }
        public double Commission { get; set; }
        public string CommissionType { get; set; } = "";
        public double MinCommission { get; set; }
        public CommissionRoundingMode CommissionRoundingMode { get; set; } = CommissionRoundingMode.CurrencyCent;
        public double SwapLong { get; set; }
        public double SwapShort { get; set; }
        public TimeSpan? SwapTimeUtc { get; set; }
        public DayOfWeek Swap3DaysRollover { get; set; }
        public EffectiveSymbolSpecification EffectiveSpecification { get; private set; }
        public MarketHours MarketHours { get; }

        public void ApplyEffectiveSpecification(EffectiveSymbolSpecification spec)
        {
            EffectiveSpecification = spec ?? throw new ArgumentNullException(nameof(spec));
            Name = spec.Symbol;
            BaseAsset = spec.BaseCurrency;
            QuoteAsset = spec.QuoteCurrency;
            Digits = spec.Digits;
            PipSize = spec.PipSize;
            TickSize = spec.TickSize;
            PipValue = spec.PipValue;
            TickValue = spec.TickValue;
            LotSize = spec.LotSize;
            ContractMultiplier = spec.ContractMultiplier;
            VolumeInUnitsMin = spec.VolumeInUnitsMin;
            VolumeInUnitsMax = spec.VolumeInUnitsMax;
            VolumeInUnitsStep = spec.VolumeInUnitsStep;
            Commission = spec.CommissionRate;
            CommissionType = spec.CommissionModel.ToString();
            MinCommission = spec.MinimumCommission;
            CommissionRoundingMode = spec.CommissionRoundingMode;
            SwapLong = spec.SwapLong;
            SwapShort = spec.SwapShort;
            SwapTimeUtc = spec.SwapTimeUtc;
            Swap3DaysRollover = spec.Swap3DaysRollover;
        }

        public double NormalizeVolumeInUnits(double volume, RoundingMode roundingMode)
        {
            if (VolumeInUnitsStep <= 0)
                return volume;
            if (volume <= 0.0)
                return 0.0;

            double steps = volume / VolumeInUnitsStep;
            double rounded = roundingMode switch
            {
                RoundingMode.Up => Math.Ceiling(steps),
                RoundingMode.ToNearest => Math.Round(steps, MidpointRounding.AwayFromZero),
                _ => Math.Floor(steps)
            };

            double result = rounded * VolumeInUnitsStep;
            if (result < VolumeInUnitsMin)
                return VolumeInUnitsMin;
            return Math.Min(result, VolumeInUnitsMax);
        }

        public bool IsValidVolumeInUnits(double volume)
        {
            if (double.IsNaN(volume) || double.IsInfinity(volume)
                || volume < VolumeInUnitsMin - 1e-12 || volume > VolumeInUnitsMax + 1e-12
                || VolumeInUnitsStep <= 0.0)
                return false;
            double steps = volume / VolumeInUnitsStep;
            return Math.Abs(steps - Math.Round(steps)) <= 1e-9;
        }

        public double QuantityToVolumeInUnits(double quantity)
        {
            if (double.IsNaN(quantity) || double.IsInfinity(quantity) || quantity <= 0.0 || LotSize <= 0.0)
                return 0.0;
            return quantity * LotSize;
        }

        public double PriceDistanceToPips(double priceDistance)
        {
            return PipSize > 0.0 ? priceDistance / PipSize : 0.0;
        }

        public double PriceDistanceToTicks(double priceDistance)
        {
            return TickSize > 0.0 ? priceDistance / TickSize : 0.0;
        }

        public double VolumeForFixedRisk(double amount, double stopLossInPips, RoundingMode roundingMode)
        {
            if (double.IsNaN(amount) || double.IsInfinity(amount) || amount <= 0.0
                || double.IsNaN(stopLossInPips) || double.IsInfinity(stopLossInPips) || stopLossInPips <= 0.0
                || double.IsNaN(PipValue) || double.IsInfinity(PipValue) || PipValue <= 0.0)
                return 0.0;
            double rawVolume = amount / (stopLossInPips * PipValue);
            return NormalizeVolumeInUnits(rawVolume, roundingMode);
        }

        public double AmountRisked(double volume, double stopLossInPips)
        {
            if (double.IsNaN(volume) || double.IsInfinity(volume) || volume <= 0.0
                || double.IsNaN(stopLossInPips) || double.IsInfinity(stopLossInPips) || stopLossInPips <= 0.0
                || double.IsNaN(PipValue) || double.IsInfinity(PipValue) || PipValue <= 0.0)
                return 0.0;
            return volume * stopLossInPips * PipValue;
        }
    }

    /// <summary>
    /// Minimal deterministic market-hours contract for engine parity. Crypto
    /// symbols are continuous; FX and metals use the generator's frozen
    /// Friday 22:00 through Sunday 22:00 UTC closure. Production cTrader uses
    /// the broker-provided Symbol.MarketHours implementation instead.
    /// </summary>
    public sealed class MarketHours
    {
        private readonly Symbol _symbol;

        internal MarketHours(Symbol symbol)
        {
            _symbol = symbol;
        }

        public bool IsOpened(DateTime value)
        {
            DateTime utc = value.Kind == DateTimeKind.Utc ? value : value.ToUniversalTime();
            string name = _symbol.Name ?? string.Empty;
            if (name.StartsWith("BTC", StringComparison.OrdinalIgnoreCase)
                || name.StartsWith("ETH", StringComparison.OrdinalIgnoreCase)
                || name.StartsWith("SOL", StringComparison.OrdinalIgnoreCase)
                || name.StartsWith("XRP", StringComparison.OrdinalIgnoreCase))
                return true;
            if (utc.DayOfWeek == DayOfWeek.Saturday)
                return false;
            if (utc.DayOfWeek == DayOfWeek.Friday)
                return utc.TimeOfDay < TimeSpan.FromHours(22.0);
            if (utc.DayOfWeek == DayOfWeek.Sunday)
                return utc.TimeOfDay >= TimeSpan.FromHours(22.0);
            return true;
        }
    }

    public sealed class Positions : IEnumerable<Position>
    {
        private readonly List<Position> _positions = new List<Position>();
        private long _nextId = 1;

        public event Action<PositionClosedEventArgs> Closed;

        internal long NextId()
        {
            return _nextId++;
        }

        internal void Add(Position position)
        {
            _positions.Add(position);
        }

        internal bool Contains(Position position)
        {
            return _positions.Contains(position);
        }

        internal IReadOnlyList<Position> All()
        {
            return _positions;
        }

        internal void Remove(Position position)
        {
            _positions.Remove(position);
        }

        private readonly Queue<PositionClosedEventArgs> _closedEvents = new Queue<PositionClosedEventArgs>();

        internal void QueueClosed(Position position, PositionCloseReason reason)
        {
            _closedEvents.Enqueue(new PositionClosedEventArgs(position, reason));
        }

        internal void DispatchClosedEvents()
        {
            while (_closedEvents.Count > 0)
            {
                PositionClosedEventArgs args = _closedEvents.Dequeue();
                Closed?.Invoke(args);
            }
        }

        public Position[] FindAll(string label, string symbolName)
        {
            return _positions
                .Where(position =>
                    string.Equals(position.Label, label, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(position.SymbolName, symbolName, StringComparison.OrdinalIgnoreCase))
                .ToArray();
        }

        public IEnumerator<Position> GetEnumerator()
        {
            return _positions.GetEnumerator();
        }

        IEnumerator IEnumerable.GetEnumerator()
        {
            return GetEnumerator();
        }
    }

    public sealed class Position
    {
        public long Id { get; set; }
        public string SymbolName { get; set; } = "";
        public string Label { get; set; } = "";
        public string Comment { get; set; } = "";
        public TradeType TradeType { get; set; }
        public double VolumeInUnits { get; set; }
        public double EntryPrice { get; set; }
        public DateTime EntryTime { get; set; }
        public double EntryBid { get; set; }
        public double EntryAsk { get; set; }
        public double PipSizeAtEntry { get; set; }
        public double ClosePrice { get; set; }
        public DateTime ClosingTime { get; set; }
        public double CloseBid { get; set; }
        public double CloseAsk { get; set; }
        private double? _stopLossPips;
        private double? _takeProfitPips;
        private double? _stopLossPrice;
        private double? _takeProfitPrice;
        public double? StopLossPips
        {
            get => _stopLossPips;
            set { _stopLossPips = value; _stopLossPrice = null; }
        }
        public double? TakeProfitPips
        {
            get => _takeProfitPips;
            set { _takeProfitPips = value; _takeProfitPrice = null; }
        }
        public double? StopLoss => _stopLossPrice ?? (!StopLossPips.HasValue || PipSizeAtEntry <= 0.0
            ? null
            : (TradeType == TradeType.Buy
                ? EntryPrice - StopLossPips.Value * PipSizeAtEntry
                : EntryPrice + StopLossPips.Value * PipSizeAtEntry));
        public double? TakeProfit => _takeProfitPrice ?? (!TakeProfitPips.HasValue || PipSizeAtEntry <= 0.0
            ? null
            : (TradeType == TradeType.Buy
                ? EntryPrice + TakeProfitPips.Value * PipSizeAtEntry
                : EntryPrice - TakeProfitPips.Value * PipSizeAtEntry));
        public double EntryCommission { get; set; }
        public double ClosingCommission { get; set; }
        public double Commissions { get; set; }
        public double Swaps { get; set; }
        public double Swap => Swaps;
        public double GrossProfit { get; set; }
        public double PnLConversionFees { get; set; }
        public double NetProfit { get; set; }
        public double Pips { get; set; }
        public double IntendedRiskMoney { get; set; }
        public double NetR { get; set; }
        public double MaeNetProfit { get; set; } = double.PositiveInfinity;
        public double MfeNetProfit { get; set; } = double.NegativeInfinity;
        public string EconomicSpecificationHash { get; set; } = "";
        public DateTime LastSwapTime { get; set; } = DateTime.MinValue;
        public string ClosingReason { get; set; } = "";

        internal void SetInitialProtectionDistances(double? stopDistance, double? targetDistance)
        {
            StopLossPips = stopDistance / PipSizeAtEntry;
            TakeProfitPips = targetDistance / PipSizeAtEntry;
            // cTrader stores the raw binary sum after rounding the distance.
            // Rounding the absolute level can execute at a quote that has not
            // crossed the native threshold. Do not divide and multiply again.
            double direction = TradeType == TradeType.Buy ? 1.0 : -1.0;
            _stopLossPrice = stopDistance.HasValue ? EntryPrice - direction * stopDistance.Value : null;
            _takeProfitPrice = targetDistance.HasValue ? EntryPrice + direction * targetDistance.Value : null;
        }

        public TradeResult ModifyTakeProfitPrice(double? takeProfitPrice)
        {
            if (!takeProfitPrice.HasValue)
            {
                TakeProfitPips = null;
                return TradeResult.Success(this);
            }
            if (PipSizeAtEntry <= 0.0 || takeProfitPrice.Value <= 0.0)
                return TradeResult.Failure("Invalid take-profit price");
            double pips = TradeType == TradeType.Buy
                ? (takeProfitPrice.Value - EntryPrice) / PipSizeAtEntry
                : (EntryPrice - takeProfitPrice.Value) / PipSizeAtEntry;
            if (pips <= 0.0 || double.IsNaN(pips) || double.IsInfinity(pips))
                return TradeResult.Failure("Take-profit must remain on the profitable side");
            TakeProfitPips = pips;
            return TradeResult.Success(this);
        }
    }

    public sealed class TradeHistory
    {
        private readonly List<Position> _closedPositions = new List<Position>();

        internal void Add(Position position)
        {
            _closedPositions.Add(position);
        }

        public IReadOnlyList<Position> ClosedPositions
        {
            get { return _closedPositions; }
        }
    }

    public sealed class PositionClosedEventArgs : EventArgs
    {
        public PositionClosedEventArgs(Position position, PositionCloseReason reason)
        {
            Position = position;
            Reason = reason;
        }

        public Position Position { get; }
        public PositionCloseReason Reason { get; }
    }

    public sealed class TradeResult
    {
        private TradeResult(bool isSuccessful, Position position, string error)
        {
            IsSuccessful = isSuccessful;
            Position = position;
            Error = error;
        }

        public bool IsSuccessful { get; }
        public Position Position { get; }
        public string Error { get; }

        public static TradeResult Success(Position position)
        {
            return new TradeResult(true, position, "");
        }

        public static TradeResult Failure(string error)
        {
            return new TradeResult(false, null, error);
        }
    }
}

namespace cAlgo.API.Internals
{
    public enum AccountType
    {
        Hedged,
        Netted
    }

    public interface IAccount
    {
    }
}
