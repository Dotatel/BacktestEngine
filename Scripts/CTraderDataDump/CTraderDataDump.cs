using System;
using System.Globalization;
using System.IO;
using System.Text.Json;
using cAlgo.API;
using cAlgo.API.Internals;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.FullAccess)]
    public class CTraderDataDump : Robot
    {
        private const string TickFileName = "ticks.csv";
        private const string BarFileName = "bars.csv";
        private const string SymbolSpecFileName = "symbol_spec.json";
        private const string CaptureFileName = "capture.json";

        private StreamWriter _tickWriter;
        private StreamWriter _barWriter;
        private long _tickCount;
        private long _barCount;
        private DateTime _firstTickTime = DateTime.MinValue;
        private DateTime _lastTickTime = DateTime.MinValue;
        private double _minBid = double.PositiveInfinity;
        private double _maxBid = double.NegativeInfinity;
        private double _minAsk = double.PositiveInfinity;
        private double _maxAsk = double.NegativeInfinity;
        private double _minSpreadPips = double.PositiveInfinity;
        private double _maxSpreadPips = double.NegativeInfinity;
        private double _sumSpreadPips;
        private long _zeroOrNegativeSpreadCount;

        [Parameter("Output Directory", DefaultValue = "BacktestEngineDataDump")]
        public string OutputDirectory { get; set; }

        [Parameter("Capture Ticks", DefaultValue = true)]
        public bool CaptureTicks { get; set; }

        [Parameter("Capture Bars", DefaultValue = false)]
        public bool CaptureBars { get; set; }

        [Parameter("Max Ticks", DefaultValue = 0, MinValue = 0)]
        public int MaxTicks { get; set; }

        [Parameter("Flush Every Ticks", DefaultValue = 10000, MinValue = 1)]
        public int FlushEveryTicks { get; set; }

        [Parameter("Stop At Max Ticks", DefaultValue = true)]
        public bool StopAtMaxTicks { get; set; }

        [Parameter("Include Account Number", DefaultValue = false)]
        public bool IncludeAccountNumber { get; set; }

        protected override void OnStart()
        {
            Directory.CreateDirectory(ResolvedOutputDirectory());
            WriteSymbolSpec();

            if (CaptureTicks)
            {
                _tickWriter = new StreamWriter(Path.Combine(ResolvedOutputDirectory(), TickFileName), false);
                _tickWriter.WriteLine("time_utc,bid,ask,spread_price,spread_pips");
            }

            if (CaptureBars)
            {
                _barWriter = new StreamWriter(Path.Combine(ResolvedOutputDirectory(), BarFileName), false);
                _barWriter.WriteLine("time_utc,open,high,low,close");
            }

            Print("DATA_DUMP_START symbol={0} period={1} output={2} captureTicks={3} captureBars={4} maxTicks={5}",
                SymbolName, TimeFrame, ResolvedOutputDirectory(), CaptureTicks, CaptureBars, MaxTicks);
        }

        protected override void OnTick()
        {
            if (!CaptureTicks || _tickWriter == null)
                return;

            DateTime time = Server.Time;
            double bid = Symbol.Bid;
            double ask = Symbol.Ask;
            double spreadPrice = ask - bid;
            double spreadPips = Symbol.PipSize > 0.0 ? spreadPrice / Symbol.PipSize : 0.0;

            if (_tickCount == 0)
                _firstTickTime = time;
            _lastTickTime = time;
            _tickCount++;

            _minBid = Math.Min(_minBid, bid);
            _maxBid = Math.Max(_maxBid, bid);
            _minAsk = Math.Min(_minAsk, ask);
            _maxAsk = Math.Max(_maxAsk, ask);
            _minSpreadPips = Math.Min(_minSpreadPips, spreadPips);
            _maxSpreadPips = Math.Max(_maxSpreadPips, spreadPips);
            _sumSpreadPips += spreadPips;
            if (spreadPips <= 0.0)
                _zeroOrNegativeSpreadCount++;

            _tickWriter.WriteLine(string.Join(",",
                FormatTime(time),
                FormatNumber(bid),
                FormatNumber(ask),
                FormatNumber(spreadPrice),
                FormatNumber(spreadPips)));

            if (_tickCount % Math.Max(1, FlushEveryTicks) == 0)
            {
                _tickWriter.Flush();
                Print("DATA_DUMP_PROGRESS symbol={0} ticks={1} last={2:o}", SymbolName, _tickCount, _lastTickTime);
            }

            if (MaxTicks > 0 && _tickCount >= MaxTicks && StopAtMaxTicks)
            {
                Print("DATA_DUMP_MAX_TICKS_REACHED symbol={0} ticks={1}", SymbolName, _tickCount);
                Stop();
            }
        }

        protected override void OnBar()
        {
            if (!CaptureBars || _barWriter == null || Bars.Count < 2)
                return;

            int index = Bars.Count - 2;
            _barWriter.WriteLine(string.Join(",",
                FormatTime(Bars.OpenTimes[index]),
                FormatNumber(Bars.OpenPrices[index]),
                FormatNumber(Bars.HighPrices[index]),
                FormatNumber(Bars.LowPrices[index]),
                FormatNumber(Bars.ClosePrices[index])));
            _barCount++;

            if (_barCount % 1000 == 0)
            {
                _barWriter.Flush();
                Print("DATA_DUMP_BAR_PROGRESS symbol={0} bars={1} last={2:o}", SymbolName, _barCount, Bars.OpenTimes[index]);
            }
        }

        protected override void OnStop()
        {
            _tickWriter?.Flush();
            _tickWriter?.Dispose();
            _tickWriter = null;
            _barWriter?.Flush();
            _barWriter?.Dispose();
            _barWriter = null;
            WriteCapture();

            Print("DATA_DUMP_STOP symbol={0} ticks={1} bars={2} first={3:o} last={4:o} output={5}",
                SymbolName, _tickCount, _barCount, _firstTickTime, _lastTickTime, ResolvedOutputDirectory());
        }

        private string ResolvedOutputDirectory()
        {
            string raw = string.IsNullOrWhiteSpace(OutputDirectory)
                ? "BacktestEngineDataDump"
                : OutputDirectory.Trim();

            if (Path.IsPathRooted(raw))
                return raw;

            string documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            return Path.Combine(documents, raw);
        }

        private void WriteSymbolSpec()
        {
            var spec = new
            {
                captured_at_utc = FormatTime(Server.Time),
                broker_name = Account.BrokerName,
                account_number = AccountNumberForOutput(),
                account_asset = Account.Asset?.Name ?? "",
                account_precise_leverage = Account.PreciseLeverage,
                symbol = SymbolName,
                timeframe = TimeFrame.ToString(),
                bid = Symbol.Bid,
                ask = Symbol.Ask,
                spread_price = Symbol.Ask - Symbol.Bid,
                spread_pips = Symbol.PipSize > 0.0 ? (Symbol.Ask - Symbol.Bid) / Symbol.PipSize : 0.0,
                pip_size = Symbol.PipSize,
                tick_size = Symbol.TickSize,
                pip_value = Symbol.PipValue,
                tick_value = Symbol.TickValue,
                digits = Symbol.Digits,
                lot_size = Symbol.LotSize,
                volume_in_units_min = Symbol.VolumeInUnitsMin,
                volume_in_units_max = Symbol.VolumeInUnitsMax,
                volume_in_units_step = Symbol.VolumeInUnitsStep,
                base_asset = Symbol.BaseAsset?.Name ?? "",
                quote_asset = Symbol.QuoteAsset?.Name ?? "",
                pnl_conversion_fee_rate = Symbol.PnLConversionFeeRate,
                commission = Symbol.Commission,
                commission_type = Symbol.CommissionType.ToString(),
                min_commission = Symbol.MinCommission,
                min_commission_asset = Symbol.MinCommissionAsset?.Name ?? "",
                min_commission_type = Symbol.MinCommissionType.ToString(),
                min_distance_type = Symbol.MinDistanceType.ToString(),
                min_take_profit_distance = Symbol.MinTakeProfitDistance,
                min_stop_loss_distance = Symbol.MinStopLossDistance,
                swap_long = Symbol.SwapLong,
                swap_short = Symbol.SwapShort,
                swap_calculation_type = Symbol.SwapCalculationType.ToString(),
                swap_3_days_rollover = Symbol.Swap3DaysRollover?.ToString() ?? "",
                is_trading_enabled = Symbol.IsTradingEnabled,
                trading_mode = Symbol.TradingMode.ToString(),
                is_custom = Symbol.IsCustom
            };

            WriteJson(SymbolSpecFileName, spec);
        }

        private void WriteCapture()
        {
            double averageSpread = _tickCount > 0 ? _sumSpreadPips / _tickCount : 0.0;
            var capture = new
            {
                captured_at_utc = FormatTime(Server.Time),
                broker_name = Account.BrokerName,
                account_number = AccountNumberForOutput(),
                account_asset = Account.Asset?.Name ?? "",
                account_precise_leverage = Account.PreciseLeverage,
                symbol = SymbolName,
                timeframe = TimeFrame.ToString(),
                output_directory = ResolvedOutputDirectory(),
                ticks_file = CaptureTicks ? TickFileName : "",
                bars_file = CaptureBars ? BarFileName : "",
                symbol_spec_file = SymbolSpecFileName,
                capture_ticks = CaptureTicks,
                capture_bars = CaptureBars,
                max_ticks = MaxTicks,
                tick_count = _tickCount,
                bar_count = _barCount,
                first_tick_time_utc = _tickCount > 0 ? FormatTime(_firstTickTime) : "",
                last_tick_time_utc = _tickCount > 0 ? FormatTime(_lastTickTime) : "",
                min_bid = IsFinite(_minBid) ? _minBid : 0.0,
                max_bid = IsFinite(_maxBid) ? _maxBid : 0.0,
                min_ask = IsFinite(_minAsk) ? _minAsk : 0.0,
                max_ask = IsFinite(_maxAsk) ? _maxAsk : 0.0,
                min_spread_pips = IsFinite(_minSpreadPips) ? _minSpreadPips : 0.0,
                max_spread_pips = IsFinite(_maxSpreadPips) ? _maxSpreadPips : 0.0,
                average_spread_pips = averageSpread,
                zero_or_negative_spread_count = _zeroOrNegativeSpreadCount
            };

            WriteJson(CaptureFileName, capture);
        }

        private void WriteJson(string fileName, object value)
        {
            var options = new JsonSerializerOptions { WriteIndented = true };
            string path = Path.Combine(ResolvedOutputDirectory(), fileName);
            System.IO.File.WriteAllText(path, JsonSerializer.Serialize(value, options) + Environment.NewLine);
        }

        private static string FormatTime(DateTime time)
        {
            return time.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        }

        private static string FormatNumber(double value)
        {
            return value.ToString("G17", CultureInfo.InvariantCulture);
        }

        private string AccountNumberForOutput()
        {
            return IncludeAccountNumber
                ? Account.Number.ToString(CultureInfo.InvariantCulture)
                : "";
        }

        private static bool IsFinite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }
    }
}
