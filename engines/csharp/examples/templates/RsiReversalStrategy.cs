using System;
using System.Collections.Generic;
using cAlgo.API;

namespace cAlgo.Robots
{
    /// <summary>
    /// Educational RSI reversal robot for the desktop launcher template list.
    /// </summary>
    /// <remarks>
    /// A long is evaluated when Wilder RSI previously closed below the oversold level and
    /// the completed bar pulls it back to or above that level; shorts mirror this below the
    /// overbought level. Trading only on the crossing back through the band avoids chasing
    /// an extended move. Market replay adds the next bar before <see cref="Robot.OnBar"/>
    /// runs, so every decision below reads the last <b>completed</b> bar at index
    /// <c>Bars.Count - 2</c> and never the forming quote bar at <c>Bars.Count - 1</c>;
    /// this keeps the decision causal. The robot holds at most one position per label and
    /// every entry carries a fixed stop-loss and take-profit. This template uses no
    /// built-in indicator library (the local cAlgo shim exposes none) and it makes no
    /// profitability, qualification or native-parity claim.
    /// </remarks>
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class RsiReversalStrategy : Robot
    {
        /// <summary>Label shared by every order this robot opens, used for duplicate control.</summary>
        private const string PositionLabel = "RSI-REVERSAL";

        /// <summary>Gets the RSI length in completed bars.</summary>
        [Parameter("RSI Period", DefaultValue = 14, MinValue = 2, MaxValue = 200)]
        public int RsiPeriod { get; set; }

        /// <summary>Gets the oversold level; a cross back above it is a long signal.</summary>
        [Parameter("Oversold Level", DefaultValue = 30.0, MinValue = 1.0, MaxValue = 49.0)]
        public double OversoldLevel { get; set; }

        /// <summary>Gets the overbought level; a cross back below it is a short signal.</summary>
        [Parameter("Overbought Level", DefaultValue = 70.0, MinValue = 51.0, MaxValue = 99.0)]
        public double OverboughtLevel { get; set; }

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
        /// Evaluates the reversal signal on completed bars and enters at most one position.
        /// </summary>
        protected override void OnBar()
        {
            if (HasOpenPosition())
                return;
            TradeType tradeType;
            if (!TryGetReversalSignal(out tradeType))
                return;
            Enter(tradeType);
        }

        /// <summary>
        /// Rejects parameter combinations the signal or volume helpers cannot use.
        /// </summary>
        /// <exception cref="ArgumentException">Thrown when any parameter is invalid.</exception>
        private void ValidateParameters()
        {
            if (RsiPeriod < 2 || OversoldLevel <= 0.0 || OversoldLevel >= OverboughtLevel
                || OverboughtLevel >= 100.0 || StopLossPips <= 0.0 || TakeProfitPips <= 0.0
                || VolumeMultiplier < 1)
                throw new ArgumentException(
                    "RsiReversalStrategy requires an RSI period of at least two bars, 0 < OversoldLevel < OverboughtLevel < 100, positive stop/target pips and a volume multiplier of at least one.");
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
        /// Decides the entry side from RSI band crossings over completed closes, if any.
        /// </summary>
        /// <param name="tradeType">Receives Buy or Sell when a signal exists.</param>
        /// <returns>True when a causal reversal signal was found.</returns>
        private bool TryGetReversalSignal(out TradeType tradeType)
        {
            tradeType = TradeType.Buy;
            int latest = LatestCompletedIndex;
            if (latest < RsiPeriod + 1)
                return false;
            double current = CalculateRsi(Bars.ClosePrices, RsiPeriod, latest);
            double previous = CalculateRsi(Bars.ClosePrices, RsiPeriod, latest - 1);
            bool crossedUp = previous < OversoldLevel && current >= OversoldLevel;
            bool crossedDown = previous > OverboughtLevel && current <= OverboughtLevel;
            if (crossedUp)
            {
                tradeType = TradeType.Buy;
                return true;
            }
            if (crossedDown)
            {
                tradeType = TradeType.Sell;
                return true;
            }
            return false;
        }

        /// <summary>
        /// Computes Wilder RSI from completed closes up to one index without future data.
        /// </summary>
        /// <remarks>
        /// The first change seed is the plain mean gain/loss over <paramref name="period"/>
        /// changes; later bars use Wilder smoothing, reading only indices at or before
        /// <paramref name="endIndex"/>. The method needs at least <c>period</c> completed
        /// changes, so callers must guarantee <c>endIndex >= period</c>.
        /// </remarks>
        /// <param name="closes">Completed close series, oldest first.</param>
        /// <param name="period">RSI length in bars, at least two.</param>
        /// <param name="endIndex">Last index to include; must be at least <c>period</c>.</param>
        /// <returns>The RSI value at <paramref name="endIndex"/>.</returns>
        /// <exception cref="ArgumentOutOfRangeException">Thrown when the window is too short.</exception>
        private static double CalculateRsi(IList<double> closes, int period, int endIndex)
        {
            if (endIndex < period)
                throw new ArgumentOutOfRangeException(nameof(endIndex), "RSI window extends before the first change.");
            double gainSum = 0.0;
            double lossSum = 0.0;
            for (int index = 1; index <= period; index++)
                AccumulateChange(closes[index] - closes[index - 1], ref gainSum, ref lossSum);
            double averageGain = gainSum / period;
            double averageLoss = lossSum / period;
            for (int index = period + 1; index <= endIndex; index++)
            {
                double change = closes[index] - closes[index - 1];
                averageGain = (averageGain * (period - 1) + Math.Max(change, 0.0)) / period;
                averageLoss = (averageLoss * (period - 1) + Math.Max(-change, 0.0)) / period;
            }
            return RsiFromAverages(averageGain, averageLoss);
        }

        /// <summary>
        /// Adds one price change to the running gain and loss totals.
        /// </summary>
        /// <param name="change">Signed price change between two consecutive closes.</param>
        /// <param name="gainSum">Running positive-change total.</param>
        /// <param name="lossSum">Running negative-change magnitude total.</param>
        private static void AccumulateChange(double change, ref double gainSum, ref double lossSum)
        {
            if (change >= 0.0)
                gainSum += change;
            else
                lossSum -= change;
        }

        /// <summary>
        /// Converts Wilder average gain and loss into the bounded RSI value.
        /// </summary>
        /// <param name="averageGain">Average positive change, non-negative.</param>
        /// <param name="averageLoss">Average negative-change magnitude, non-negative.</param>
        /// <returns>RSI in [0, 100]; 100 when there is no loss, 0 when there is no gain.</returns>
        private static double RsiFromAverages(double averageGain, double averageLoss)
        {
            if (averageLoss <= 0.0)
                return averageGain <= 0.0 ? 50.0 : 100.0;
            double relativeStrength = averageGain / averageLoss;
            return 100.0 - 100.0 / (1.0 + relativeStrength);
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
                Print("RsiReversalStrategy order was rejected: {0}", result.Error);
        }
    }
}
