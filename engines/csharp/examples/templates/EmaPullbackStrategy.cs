using System;
using System.Collections.Generic;
using cAlgo.API;

namespace cAlgo.Robots
{
    /// <summary>
    /// Educational long/short EMA pullback robot for the desktop launcher template list.
    /// </summary>
    /// <remarks>
    /// A long is evaluated when the slow EMA is rising and the completed close is above it,
    /// after the previous completed close pulled back to or below the fast EMA and the
    /// completed close recovered above it. Shorts mirror this. Market replay adds the next
    /// bar before <see cref="Robot.OnBar"/> runs, so every decision below reads the last
    /// <b>completed</b> bar at index <c>Bars.Count - 2</c> and never the forming quote bar
    /// at <c>Bars.Count - 1</c>; this keeps the decision causal. The robot holds at most
    /// one position per label and every entry carries a fixed stop-loss and take-profit.
    /// This template uses no built-in indicator library (the local cAlgo shim exposes none)
    /// and it makes no profitability, qualification or native-parity claim.
    /// </remarks>
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class EmaPullbackStrategy : Robot
    {
        /// <summary>Label shared by every order this robot opens, used for duplicate control.</summary>
        private const string PositionLabel = "EMA-PULLBACK";

        /// <summary>Gets the fast EMA length in completed bars.</summary>
        [Parameter("Fast EMA Period", DefaultValue = 9, MinValue = 2, MaxValue = 200)]
        public int FastPeriod { get; set; }

        /// <summary>Gets the slow EMA length in completed bars; must exceed <see cref="FastPeriod"/>.</summary>
        [Parameter("Slow EMA Period", DefaultValue = 21, MinValue = 3, MaxValue = 500)]
        public int SlowPeriod { get; set; }

        /// <summary>Gets the fixed stop-loss distance in pips for every entry.</summary>
        [Parameter("Stop Loss (pips)", DefaultValue = 20.0, MinValue = 0.1)]
        public double StopLossPips { get; set; }

        /// <summary>Gets the fixed take-profit distance in pips for every entry.</summary>
        [Parameter("Take Profit (pips)", DefaultValue = 40.0, MinValue = 0.1)]
        public double TakeProfitPips { get; set; }

        /// <summary>Gets the fixed-volume multiplier applied to the symbol minimum volume.</summary>
        [Parameter("Volume Multiplier", DefaultValue = 1, MinValue = 1, MaxValue = 1000)]
        public int VolumeMultiplier { get; set; }

        /// <summary>
        /// Gets the index of the last completed bar seen by this callback.
        /// </summary>
        /// <remarks>
        /// Replay fires <c>OnBar</c> after the next bar has been opened with the current
        /// quote only, so <c>Bars.Count - 1</c> is that forming bar and must never feed
        /// the signal. Returns a negative index before the first bar completes.
        /// </remarks>
        private int LatestCompletedIndex
        {
            get { return Bars.Count - 2; }
        }

        /// <summary>
        /// Validates the robot parameters before any replay callback can trade.
        /// </summary>
        /// <remarks>
        /// Fails closed: an invalid configuration aborts startup instead of trading.
        /// </remarks>
        protected override void OnStart()
        {
            ValidateParameters();
        }

        /// <summary>
        /// Evaluates the pullback signal on completed bars and enters at most one position.
        /// </summary>
        protected override void OnBar()
        {
            if (HasOpenPosition())
                return;
            TradeType tradeType;
            if (!TryGetPullbackSignal(out tradeType))
                return;
            Enter(tradeType);
        }

        /// <summary>
        /// Rejects parameter combinations the signal or volume helpers cannot use.
        /// </summary>
        /// <exception cref="ArgumentException">Thrown when any parameter is invalid.</exception>
        private void ValidateParameters()
        {
            if (FastPeriod < 2 || SlowPeriod <= FastPeriod || StopLossPips <= 0.0
                || TakeProfitPips <= 0.0 || VolumeMultiplier < 1)
                throw new ArgumentException(
                    "EmaPullbackStrategy requires 2 <= FastPeriod < SlowPeriod, positive stop/target pips and a volume multiplier of at least one.");
        }

        /// <summary>
        /// Reports whether this robot already holds a position under its label.
        /// </summary>
        /// <returns>True when at least one labelled position is open.</returns>
        private bool HasOpenPosition()
        {
            return Positions.FindAll(PositionLabel, SymbolName).Length > 0;
        }

        /// <summary>
        /// Decides the entry side from completed-bar EMA structure, if any.
        /// </summary>
        /// <param name="tradeType">Receives Buy or Sell when a signal exists.</param>
        /// <returns>True when a causal pullback signal was found.</returns>
        private bool TryGetPullbackSignal(out TradeType tradeType)
        {
            tradeType = TradeType.Buy;
            int latest = LatestCompletedIndex;
            if (latest < SlowPeriod)
                return false;
            double fastCurrent = CalculateEma(Bars.ClosePrices, FastPeriod, latest);
            double slowCurrent = CalculateEma(Bars.ClosePrices, SlowPeriod, latest);
            double fastPrevious = CalculateEma(Bars.ClosePrices, FastPeriod, latest - 1);
            double slowPrevious = CalculateEma(Bars.ClosePrices, SlowPeriod, latest - 1);
            double closeCurrent = Bars.ClosePrices[latest];
            double closePrevious = Bars.ClosePrices[latest - 1];
            bool uptrend = slowCurrent > slowPrevious && closeCurrent > slowCurrent;
            bool longPullback = closePrevious <= fastPrevious && closeCurrent > fastCurrent;
            if (uptrend && longPullback)
            {
                tradeType = TradeType.Buy;
                return true;
            }
            bool downtrend = slowCurrent < slowPrevious && closeCurrent < slowCurrent;
            bool shortPullback = closePrevious >= fastPrevious && closeCurrent < fastCurrent;
            if (downtrend && shortPullback)
            {
                tradeType = TradeType.Sell;
                return true;
            }
            return false;
        }

        /// <summary>
        /// Computes the exponential moving average of completed closes up to one index.
        /// </summary>
        /// <remarks>
        /// The average is seeded with the simple mean of the first <paramref name="period"/>
        /// closes inside the window and then smoothed forward; only indices at or before
        /// <paramref name="endIndex"/> are read, so no future value can leak into a decision.
        /// </remarks>
        /// <param name="closes">Completed close series, oldest first.</param>
        /// <param name="period">EMA length in bars, at least two.</param>
        /// <param name="endIndex">Last index to include; must be at least <c>period - 1</c>.</param>
        /// <returns>The EMA value at <paramref name="endIndex"/>.</returns>
        /// <exception cref="ArgumentOutOfRangeException">Thrown when the window is too short.</exception>
        private static double CalculateEma(IList<double> closes, int period, int endIndex)
        {
            int startIndex = endIndex - period + 1;
            if (startIndex < 0)
                throw new ArgumentOutOfRangeException(nameof(endIndex), "EMA window extends before the first bar.");
            double seed = 0.0;
            for (int index = startIndex; index <= endIndex; index++)
                seed += closes[index];
            double ema = seed / period;
            double smoothing = 2.0 / (period + 1.0);
            for (int index = startIndex + period; index <= endIndex; index++)
                ema += (closes[index] - ema) * smoothing;
            return ema;
        }

        /// <summary>
        /// Opens one fixed-volume market order with the configured stop and target.
        /// </summary>
        /// <param name="tradeType">Entry side chosen by the signal helper.</param>
        private void Enter(TradeType tradeType)
        {
            double volume = Symbol.VolumeInUnitsMin * VolumeMultiplier;
            TradeResult result = ExecuteMarketOrder(
                tradeType, SymbolName, volume, PositionLabel, StopLossPips, TakeProfitPips);
            if (!result.IsSuccessful)
                Print("EmaPullbackStrategy order was rejected: {0}", result.Error);
        }
    }
}
