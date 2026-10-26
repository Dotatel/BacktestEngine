using System;
using System.Collections.Generic;
using cAlgo.API;

namespace cAlgo.Robots
{
    /// <summary>
    /// Educational range-breakout robot for the desktop launcher template list.
    /// </summary>
    /// <remarks>
    /// A long is evaluated when the completed close breaks above the highest high of the
    /// preceding lookback window; shorts mirror this below the lowest low. The window never
    /// includes the signal bar itself. Market replay adds the next bar before
    /// <see cref="Robot.OnBar"/> runs, so every decision below reads the last
    /// <b>completed</b> bar at index <c>Bars.Count - 2</c> and never the forming quote bar
    /// at <c>Bars.Count - 1</c>; a gap that opens above the range without a completed
    /// close beyond it does not trade. The robot holds at most one position per label and
    /// every entry carries a fixed stop-loss and take-profit. This template uses no
    /// built-in indicator library (the local cAlgo shim exposes none) and it makes no
    /// profitability, qualification or native-parity claim.
    /// </remarks>
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class BreakoutStrategy : Robot
    {
        /// <summary>Label shared by every order this robot opens, used for duplicate control.</summary>
        private const string PositionLabel = "BREAKOUT";

        /// <summary>Gets the completed-bar window measured for the breakout range.</summary>
        [Parameter("Lookback Bars", DefaultValue = 20, MinValue = 2, MaxValue = 500)]
        public int LookbackBars { get; set; }

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
        /// Evaluates the breakout signal on completed bars and enters at most one position.
        /// </summary>
        protected override void OnBar()
        {
            if (HasOpenPosition())
                return;
            TradeType tradeType;
            if (!TryGetBreakoutSignal(out tradeType))
                return;
            Enter(tradeType);
        }

        /// <summary>
        /// Rejects parameter combinations the signal or volume helpers cannot use.
        /// </summary>
        /// <exception cref="ArgumentException">Thrown when any parameter is invalid.</exception>
        private void ValidateParameters()
        {
            if (LookbackBars < 2 || StopLossPips <= 0.0 || TakeProfitPips <= 0.0 || VolumeMultiplier < 1)
                throw new ArgumentException(
                    "BreakoutStrategy requires a lookback of at least two bars, positive stop/target pips and a volume multiplier of at least one.");
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
        /// Decides the entry side from a completed-bar close beyond the prior range, if any.
        /// </summary>
        /// <param name="tradeType">Receives Buy or Sell when a signal exists.</param>
        /// <returns>True when a causal breakout signal was found.</returns>
        private bool TryGetBreakoutSignal(out TradeType tradeType)
        {
            tradeType = TradeType.Buy;
            int latest = LatestCompletedIndex;
            int rangeEnd = latest - 1;
            int rangeStart = rangeEnd - LookbackBars + 1;
            if (rangeStart < 0)
                return false;
            double rangeHigh = CalculateRangeExtreme(Bars.HighPrices, rangeStart, rangeEnd, Math.Max);
            double rangeLow = CalculateRangeExtreme(Bars.LowPrices, rangeStart, rangeEnd, Math.Min);
            double close = Bars.ClosePrices[latest];
            if (close > rangeHigh)
            {
                tradeType = TradeType.Buy;
                return true;
            }
            if (close < rangeLow)
            {
                tradeType = TradeType.Sell;
                return true;
            }
            return false;
        }

        /// <summary>
        /// Reduces one price series segment to its extreme value with the supplied reducer.
        /// </summary>
        /// <param name="prices">Series segment holder (highs or lows).</param>
        /// <param name="startIndex">First included index.</param>
        /// <param name="endIndex">Last included index.</param>
        /// <param name="reducer">Binary extreme function such as Math.Max or Math.Min.</param>
        /// <returns>The extreme value over the inclusive index window.</returns>
        /// <exception cref="ArgumentOutOfRangeException">Thrown when the window is empty.</exception>
        private static double CalculateRangeExtreme(
            IList<double> prices, int startIndex, int endIndex, Func<double, double, double> reducer)
        {
            if (startIndex > endIndex)
                throw new ArgumentOutOfRangeException(nameof(endIndex), "Range window is empty.");
            double extreme = prices[startIndex];
            for (int index = startIndex + 1; index <= endIndex; index++)
                extreme = reducer(extreme, prices[index]);
            return extreme;
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
                Print("BreakoutStrategy order was rejected: {0}", result.Error);
        }
    }
}
