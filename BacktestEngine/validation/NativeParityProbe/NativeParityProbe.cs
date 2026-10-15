using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using cAlgo.API;

namespace cAlgo.Robots
{
    // Backtest-only calibration. No strategy signal, fitted parameter or live deployment.
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.FullAccess)]
    public class NativeParityProbeV9 : Robot
    {
        private const string Label = "NATIVE_PARITY_PROBE";
        private readonly JsonSerializerOptions _json = new JsonSerializerOptions { WriteIndented = true };
        private readonly List<object> _historySummary = new List<object>();
        private readonly List<Position> _positions = new List<Position>();
        private StreamWriter _events;
        private DateTime _start;
        private DateTime _entry;
        private bool _opened;
        private bool _closed;
        private long _ticks;
        private int _bars;
        private DateTime _lastTickBarOpen;
        private Bars _minuteBars;
        private StreamWriter _minuteCsv;
        private int _nextMinuteIndex;
        private long _exportedMinutes;
        private DateTime _openAt;
        private int _watchedTicks;

        [Parameter("Output Directory", DefaultValue = "/tmp/native-parity-probe")]
        public string OutputDirectory { get; set; }
        [Parameter("Trade Enabled", DefaultValue = false)]
        public bool TradeEnabled { get; set; }
        [Parameter("Open After Minutes", DefaultValue = 1, MinValue = 0)]
        public double OpenAfterMinutes { get; set; }
        [Parameter("Hold Hours", DefaultValue = 96, MinValue = 0)]
        public double HoldHours { get; set; }
        [Parameter("Volume Multipliers", DefaultValue = "1,2,4,8")]
        public string VolumeMultipliers { get; set; }
        [Parameter("Base Volume", DefaultValue = 0, MinValue = 0)]
        public double BaseVolume { get; set; }
        [Parameter("H1 Minimum Bars", DefaultValue = 120, MinValue = 0)]
        public int H1MinimumBars { get; set; }
        [Parameter("M15 Minimum Bars", DefaultValue = 104, MinValue = 0)]
        public int M15MinimumBars { get; set; }
        [Parameter("M5 Minimum Bars", DefaultValue = 24, MinValue = 0)]
        public int M5MinimumBars { get; set; }
        [Parameter("M1 Minimum Bars", DefaultValue = 120, MinValue = 0)]
        public int M1MinimumBars { get; set; }
        [Parameter("Max Tick Events", DefaultValue = 0, MinValue = 0)]
        public int MaxTickEvents { get; set; }
        [Parameter("Stop After Close", DefaultValue = true)]
        public bool StopAfterClose { get; set; }
        [Parameter("Stop Loss Pips", DefaultValue = 0, MinValue = 0)]
        public double StopLossPips { get; set; }
        [Parameter("Take Profit Pips", DefaultValue = 0, MinValue = 0)]
        public double TakeProfitPips { get; set; }
        [Parameter("Capture History", DefaultValue = true)]
        public bool CaptureHistoryEnabled { get; set; }
        [Parameter("Sell First", DefaultValue = false)]
        public bool SellFirst { get; set; }
        [Parameter("Export Minute Bars", DefaultValue = false)]
        public bool ExportMinuteBars { get; set; }
        [Parameter("Protection Offsets Pips", DefaultValue = "")]
        public string ProtectionOffsetsPips { get; set; }

        [Parameter("Open At UTC", DefaultValue = "")]
        public string OpenAtUtc { get; set; }
        [Parameter("Watch Price", DefaultValue = 0)]
        public double WatchPrice { get; set; }
        [Parameter("Watch Every Tick", DefaultValue = false)]
        public bool WatchEveryTick { get; set; }

        protected override void OnStart()
        {
            if (RunningMode == RunningMode.RealTime)
                throw new InvalidOperationException("NativeParityProbe is restricted to backtesting.");
            Print("NATIVE_PARITY_PROBE_V9_ENTER_START");
            Directory.CreateDirectory(OutputDirectory);
            _start = Server.Time;
            _openAt = string.IsNullOrWhiteSpace(OpenAtUtc) ? _start.AddMinutes(OpenAfterMinutes)
                : DateTime.Parse(OpenAtUtc, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
            _lastTickBarOpen = Bars.Count > 0 ? Bars.OpenTimes.LastValue : DateTime.MinValue;
            _minuteBars = TimeFrame == TimeFrame.Minute ? Bars : MarketData.GetBars(TimeFrame.Minute);
            _events = new StreamWriter(Path.Combine(OutputDirectory, "events.jsonl"));
            Positions.Closed += Closed;
            WriteJson("symbol_spec.json", SymbolSnapshot());
            if (CaptureHistoryEnabled)
            {
                CaptureHistory(TimeFrame.Hour, "h1", TimeSpan.FromHours(1), H1MinimumBars);
                CaptureHistory(TimeFrame.Minute15, "m15", TimeSpan.FromMinutes(15), M15MinimumBars);
                CaptureHistory(TimeFrame.Minute5, "m5", TimeSpan.FromMinutes(5), M5MinimumBars);
                CaptureHistory(TimeFrame.Minute, "m1", TimeSpan.FromMinutes(1), M1MinimumBars);
            }
            WriteJson("history_manifest.json", new { start_utc = _start, chart_period = TimeFrame.ToString(), history = _historySummary });
            if (ExportMinuteBars)
            {
                if (_minuteBars == null)
                    throw new InvalidOperationException("This native data mode does not provide M1 bars to export.");
                _minuteCsv = new StreamWriter(Path.Combine(OutputDirectory, "replay_m1.csv"));
                _minuteCsv.WriteLine("time_utc,open,high,low,close,tick_volume");
                _nextMinuteIndex = Math.Max(0, _minuteBars.Count - 1);
            }
            Event("start", null, "");
            Print("NATIVE_PARITY_PROBE_START symbol={0} period={1} start={2:o} output={3}", SymbolName, TimeFrame, _start, OutputDirectory);
        }

        protected override void OnTick()
        {
            _ticks++;
            ExportCompletedMinutes(false);
            if (_ticks <= MaxTickEvents) Event("tick", null, "");
            if (Bars.Count > 0 && Bars.OpenTimes.LastValue != _lastTickBarOpen)
            {
                _lastTickBarOpen = Bars.OpenTimes.LastValue;
                if (_bars < 10) Event("boundary_tick", null, "");
            }
            if (_opened && _positions.Count > 0 && _watchedTicks < (WatchEveryTick ? 10000 : 50) && (WatchEveryTick || (WatchPrice > 0 && (Math.Abs(Symbol.Bid - WatchPrice) < Symbol.TickSize * 0.0001
                || Math.Abs(Symbol.Ask - WatchPrice) < Symbol.TickSize * 0.0001))))
            {
                _watchedTicks++;
                foreach (Position position in _positions) Event("watched_price_position", position, "Exact displayed price reached while still open");
            }
            if (!TradeEnabled) return;
            if (!_opened && Server.Time >= _openAt)
            {
                _opened = true;
                _entry = Server.Time;
                string[] offsets = (ProtectionOffsetsPips ?? "").Split(',');
                int level = 0;
                foreach (string part in VolumeMultipliers.Split(','))
                {
                    double multiplier = double.Parse(part, CultureInfo.InvariantCulture);
                    double volume = Symbol.NormalizeVolumeInUnits((BaseVolume > 0 ? BaseVolume : Symbol.VolumeInUnitsMin) * multiplier, RoundingMode.Down);
                    double offset = level < offsets.Length && !string.IsNullOrWhiteSpace(offsets[level])
                        ? double.Parse(offsets[level], CultureInfo.InvariantCulture) : 0;
                    level++;
                    foreach (TradeType side in SellFirst ? new[] { TradeType.Sell, TradeType.Buy } : new[] { TradeType.Buy, TradeType.Sell })
                    {
                        Event("order_request", null, side + " volume=" + volume.ToString("R", CultureInfo.InvariantCulture));
                        TradeResult result = ExecuteMarketOrder(side, SymbolName, volume, Label,
                            StopLossPips > 0 ? (double?)(StopLossPips + offset) : null,
                            TakeProfitPips > 0 ? (double?)(TakeProfitPips + offset) : null);
                        if (result.IsSuccessful) _positions.Add(result.Position);
                        Event(result.IsSuccessful ? "opened" : "rejected", result.Position, result.Error?.ToString() ?? "");
                    }
                }
            }
            if (_opened && !_closed && Server.Time >= _entry.AddHours(HoldHours))
            {
                _closed = true;
                foreach (Position position in _positions.ToArray())
                {
                    Event("close_request", position, "");
                    TradeResult result = ClosePosition(position);
                    if (!result.IsSuccessful) Event("close_rejected", position, result.Error?.ToString() ?? "");
                }
                if (StopAfterClose) Stop();
            }
        }

        protected override void OnBar()
        {
            _bars++;
            if (_bars <= 10) Event("bar", null, "");
        }

        private void Closed(PositionClosedEventArgs args)
        {
            if (args.Position.Label == Label)
            {
                Event("closed", args.Position, args.Reason.ToString());
                _positions.Remove(args.Position);
            }
        }

        protected override void OnStop()
        {
            Positions.Closed -= Closed;
            ExportCompletedMinutes(true);
            _minuteCsv?.Dispose();
            _minuteCsv = null;
            Event("stop", null, "");
            _events?.Dispose();
            _events = null;
            if (Directory.Exists(OutputDirectory)) WriteJson("final_symbol_spec.json", SymbolSnapshot());
            Print("NATIVE_PARITY_PROBE_STOP symbol={0} ticks={1} bars={2} opened={3} closed={4} exported_minutes={5}", SymbolName, _ticks, _bars, _opened, _closed, _exportedMinutes);
        }

        private void ExportCompletedMinutes(bool includeFinalMinute)
        {
            if (_minuteCsv == null || _minuteBars == null) return;
            int count = _minuteBars.Count - (includeFinalMinute ? 0 : 1);
            while (_nextMinuteIndex < count)
            {
                int i = _nextMinuteIndex++;
                _minuteCsv.WriteLine(string.Join(",", _minuteBars.OpenTimes[i].ToString("O", CultureInfo.InvariantCulture),
                    F(_minuteBars.OpenPrices[i]), F(_minuteBars.HighPrices[i]), F(_minuteBars.LowPrices[i]),
                    F(_minuteBars.ClosePrices[i]), F(_minuteBars.TickVolumes[i])));
                _exportedMinutes++;
                if (_exportedMinutes % 10000 == 0) _minuteCsv.Flush();
            }
        }

        private object SymbolSnapshot()
        {
            return new
            {
                captured_at_utc = Server.Time, symbol = SymbolName, timeframe = TimeFrame.ToString(),
                running_mode = RunningMode.ToString(), account_asset = Account.Asset.Name,
                account_digits = Account.Asset.Digits, account_leverage = Account.PreciseLeverage,
                bid = Symbol.Bid, ask = Symbol.Ask, spread_price = Symbol.Ask - Symbol.Bid,
                spread_pips = (Symbol.Ask - Symbol.Bid) / Symbol.PipSize,
                pip_size = Symbol.PipSize, tick_size = Symbol.TickSize, pip_value = Symbol.PipValue,
                tick_value = Symbol.TickValue, digits = Symbol.Digits, lot_size = Symbol.LotSize,
                volume_in_units_min = Symbol.VolumeInUnitsMin, volume_in_units_max = Symbol.VolumeInUnitsMax,
                volume_in_units_step = Symbol.VolumeInUnitsStep, base_asset = Symbol.BaseAsset.Name,
                quote_asset = Symbol.QuoteAsset.Name, pnl_conversion_fee_rate = Symbol.PnLConversionFeeRate,
                commission = Symbol.Commission, commission_type = Symbol.CommissionType.ToString(),
                min_commission = Symbol.MinCommission, min_commission_asset = Symbol.MinCommissionAsset?.Name,
                min_commission_type = Symbol.MinCommissionType.ToString(),
                min_distance_type = Symbol.MinDistanceType.ToString(),
                min_take_profit_distance = Symbol.MinTakeProfitDistance, min_stop_loss_distance = Symbol.MinStopLossDistance,
                swap_long = Symbol.SwapLong, swap_short = Symbol.SwapShort,
                swap_calculation_type = Symbol.SwapCalculationType.ToString(), swap_3_days_rollover = Symbol.Swap3DaysRollover?.ToString(),
                base_to_usd = ConvertAsset(Symbol.BaseAsset.Name, "USD"),
                quote_to_account = ConvertAsset(Symbol.QuoteAsset.Name, Account.Asset.Name),
                usd_to_account = ConvertAsset("USD", Account.Asset.Name)
            };
        }

        private object ConvertAsset(string from, string to)
        {
            // Convert a large amount before normalizing: Convert(1) is rounded
            // to the destination asset's digits, which loses most FX precision.
            try { return new { rate = AssetConverter.Convert(1000000, from, to) / 1000000, source_amount = 1000000, error = (string)null }; }
            catch (Exception ex) { return new { rate = (double?)null, error = ex.GetType().Name + ": " + ex.Message }; }
        }

        private void CaptureHistory(TimeFrame period, string name, TimeSpan duration, int minimum)
        {
            Bars bars;
            try { bars = period == TimeFrame ? Bars : MarketData.GetBars(period); }
            catch (Exception ex)
            {
                _historySummary.Add(new { period = name, available = false, error = ex.GetType().Name + ": " + ex.Message });
                return;
            }
            if (bars == null)
            {
                _historySummary.Add(new { period = name, available = false, error = "Native MarketData.GetBars returned null for this mode and period." });
                return;
            }
            int initial = bars.Count, loaded = 0, calls = 0;
            while (bars.Count < minimum && calls < 100)
            {
                calls++;
                int count = bars.LoadMoreHistory();
                if (count <= 0) break;
                loaded += count;
            }
            int written = 0;
            using (var csv = new StreamWriter(Path.Combine(OutputDirectory, "history_" + name + ".csv")))
            {
                csv.WriteLine("time_utc,open,high,low,close,tick_volume");
                for (int i = 0; i < bars.Count; i++)
                {
                    // Only bars completely before the start are safe for a preload.
                    if (bars.OpenTimes[i] + duration > _start) continue;
                    csv.WriteLine(string.Join(",", bars.OpenTimes[i].ToString("O", CultureInfo.InvariantCulture),
                        F(bars.OpenPrices[i]), F(bars.HighPrices[i]), F(bars.LowPrices[i]), F(bars.ClosePrices[i]), F(bars.TickVolumes[i])));
                    written++;
                }
            }
            _historySummary.Add(new { period = name, initial_count = initial, minimum_requested = minimum,
                load_calls = calls, loaded_count = loaded, final_count = bars.Count, completed_export_count = written,
                first_utc = bars.Count > 0 ? (DateTime?)bars.OpenTimes[0] : null,
                last_utc = bars.Count > 0 ? (DateTime?)bars.OpenTimes[bars.Count - 1] : null });
        }

        private void Event(string kind, Position position, string message)
        {
            if (_events == null) return;
            _events.WriteLine(JsonSerializer.Serialize(new
            {
                time_utc = Server.Time, event_type = kind, bid = Symbol.Bid, ask = Symbol.Ask,
                spread = Symbol.Ask - Symbol.Bid, position_id = position?.Id,
                side = position?.TradeType.ToString(), volume = position?.VolumeInUnits,
                entry_time_utc = position?.EntryTime, entry_price = position?.EntryPrice,
                stop_loss = position?.StopLoss, take_profit = position?.TakeProfit,
                current_price = position?.CurrentPrice, commissions = position?.Commissions,
                swaps = position?.Swap, gross = position?.GrossProfit, net = position?.NetProfit,
                account_balance = Account.Balance, account_equity = Account.Equity,
                message, bar_open_time = Bars.Count > 0 ? (DateTime?)Bars.OpenTimes.LastValue : null,
                bar_open = Bars.Count > 0 ? (double?)Bars.OpenPrices.LastValue : null,
                bar_high = Bars.Count > 0 ? (double?)Bars.HighPrices.LastValue : null,
                bar_low = Bars.Count > 0 ? (double?)Bars.LowPrices.LastValue : null,
                bar_close = Bars.Count > 0 ? (double?)Bars.ClosePrices.LastValue : null,
                previous_bar_time = Bars.Count > 1 ? (DateTime?)Bars.OpenTimes.Last(1) : null,
                previous_bar_open = Bars.Count > 1 ? (double?)Bars.OpenPrices.Last(1) : null,
                previous_bar_high = Bars.Count > 1 ? (double?)Bars.HighPrices.Last(1) : null,
                previous_bar_low = Bars.Count > 1 ? (double?)Bars.LowPrices.Last(1) : null,
                previous_bar_close = Bars.Count > 1 ? (double?)Bars.ClosePrices.Last(1) : null,
                previous_m1_time = _minuteBars != null && _minuteBars.Count > 1 ? (DateTime?)_minuteBars.OpenTimes.Last(1) : null,
                previous_m1_open = _minuteBars != null && _minuteBars.Count > 1 ? (double?)_minuteBars.OpenPrices.Last(1) : null,
                previous_m1_high = _minuteBars != null && _minuteBars.Count > 1 ? (double?)_minuteBars.HighPrices.Last(1) : null,
                previous_m1_low = _minuteBars != null && _minuteBars.Count > 1 ? (double?)_minuteBars.LowPrices.Last(1) : null,
                previous_m1_close = _minuteBars != null && _minuteBars.Count > 1 ? (double?)_minuteBars.ClosePrices.Last(1) : null
            }));
            _events.Flush();
        }

        private void WriteJson(string name, object value) => System.IO.File.WriteAllText(Path.Combine(OutputDirectory, name), JsonSerializer.Serialize(value, _json));
        private static string F(double value) => value.ToString("R", CultureInfo.InvariantCulture);
    }
}
