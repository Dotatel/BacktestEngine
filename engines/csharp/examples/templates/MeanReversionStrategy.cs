using System;
using System.Collections.Generic;
using cAlgo.API;

namespace cAlgo.Robots
{
    /// <summary>
    /// Educational standard-deviation mean-reversion robot for the launcher template list.
    /// </summary>
    /// <remarks>
    /// A long is evaluated when the completed close falls to the average minus
    /// <see cref="DeviationMultiplier"/> standard deviations; shorts mirror this above the
    /// average. The window never includes forming data. Market replay adds the next bar
    /// before <see cref="Robot.OnBar"/> runs, so every decision below reads the last
    /// <b>completed</b> bar at index <c>Bars.Count - 2</c> and never the forming quote bar
    /// at <c>Bars.Count - 1</c>; this keeps the decision causal. A zero standard deviation
    /// window produces no signal. The robot holds at most one position per label and every
    /// entry carries a fixed stop-loss and take-profit. This template uses no built-in
    /// indicator library (the local cAlgo shim exposes none) and it makes no profitability,
    /// qualification or native-parity claim.
    /// </remarks>
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class MeanReversionStrategy : Robot
    {
        /// <summary>Label shared by every order this robot opens, used for duplicate control.</summary>
        private const string PositionLabel = "MEAN-REVERSION";

        /// <summary>Gets the rolling-window length in completed bars.</summary>
        [Parameter("Average Period", DefaultValue = 20, MinValue = 2, MaxValue = 500)]
        public int AveragePeriod { get; set; }

        /// <summary>Gets the standard-deviation multiple required to trade.</summary>
        [Parameter("Deviation Multiplier", DefaultValue = 2.0, MinValue = 0.1)]
        public double DeviationMultiplier { get; set; }

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
        /// Evaluates the reversion signal on completed bars and enters at most one position.
        /// </summary>
        protected override void OnBar()
        {
            if (HasOpenPosition())
                return;
            TradeType tradeType;
            if (!TryGetReversionSignal(out tradeType))
                return;
            Enter(tradeType);
        }

        /// <summary>
        /// Rejects parameter combinations the signal or volume helpers cannot use.
        /// </summary>
        /// <exception cref="ArgumentException">Thrown when any parameter is invalid.</exception>
        private void ValidateParameters()
        {
            if (AveragePeriod < 2 || DeviationMultiplier <= 0.0 || StopLossPips <= 0.0
                || TakeProfitPips <= 0.0 || VolumeMultiplier < 1)
                throw new ArgumentException(
                    "MeanReversionStrategy requires an average period of at least two bars, a positive deviation multiplier, positive stop/target pips and a volume multiplier of at least one.");
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
        /// Decides the entry side from completed-bar standard-deviation bands, if any.
        /// </summary>
        /// <param name="tradeType">Receives Buy or Sell when a signal exists.</param>
        /// <returns>True when a causal reversion signal was found.</returns>
        private bool TryGetReversionSignal(out TradeType tradeType)
        {
            tradeType = TradeType.Buy;
            int latest = LatestCompletedIndex;
            if (latest < AveragePeriod)
                return false;
            double average = CalculateAverage(Bars.ClosePrices, AveragePeriod, latest);
            double deviation = CalculateStandardDeviation(Bars.ClosePrices, AveragePeriod, latest, average);
            if (deviation <= 0.0)
                return false;
            double close = Bars.ClosePrices[latest];
            if (close <= average - DeviationMultiplier * deviation)
            {
                tradeType = TradeType.Buy;
                return true;
            }
            if (close >= average + DeviationMultiplier * deviation)
            {
                tradeType = TradeType.Sell;
                return true;
            }
            return false;
        }

        /// <summary>
        /// Computes the arithmetic mean of completed closes over an inclusive index window.
        /// </summary>
        /// <param name="closes">Completed close series, oldest first.</param>
        /// <param name="period">Window length in bars, at least two.</param>
        /// <param name="endIndex">Last index to include; must be at least <c>period - 1</c>.</param>
        /// <returns>The window average.</returns>
        /// <exception cref="ArgumentOutOfRangeException">Thrown when the window is too short.</exception>
        private static double CalculateAverage(IList<double> closes, int period, int endIndex)
        {
            int startIndex = endIndex - period + 1;
            if (startIndex < 0)
                throw new ArgumentOutOfRangeException(nameof(endIndex), "Average window extends before the first bar.");
            double sum = 0.0;
            for (int index = startIndex; index <= endIndex; index++)
                sum += closes[index];
            return sum / period;
        }

        /// <summary>
        /// Computes the population standard deviation of completed closes around a known mean.
        /// </summary>
        /// <param name="closes">Completed close series, oldest first.</param>
        /// <param name="period">Window length in bars, at least two.</param>
        /// <param name="endIndex">Last index to include; must be at least <c>period - 1</c>.</param>
        /// <param name="average">Pre-computed window mean from <see cref="CalculateAverage"/>.</param>
        /// <returns>The population standard deviation of the window.</returns>
        /// <exception cref="ArgumentOutOfRangeException">Thrown when the window is too short.</exception>
        private static double CalculateStandardDeviation(IList<double> closes, int period, int endIndex, double average)
        {
            int startIndex = endIndex - period + 1;
            if (startIndex < 0)
                throw new ArgumentOutOfRangeException(nameof(endIndex), "Deviation window extends before the first bar.");
            double squaredSum = 0.0;
            for (int index = startIndex; index <= endIndex; index++)
            {
                double difference = closes[index] - average;
                squaredSum += difference * difference;
            }
            return Math.Sqrt(squaredSum / period);
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
                Print("MeanReversionStrategy order was rejected: {0}", result.Error);
        }
    }
}
