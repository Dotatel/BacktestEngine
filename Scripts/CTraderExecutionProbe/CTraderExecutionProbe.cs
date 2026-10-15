using System;
using System.Globalization;
using System.IO;
using System.Text.Json;
using cAlgo.API;

namespace cAlgo.Robots
{
    public enum ExecutionProbeSide
    {
        Buy,
        Sell
    }

    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.FullAccess)]
    public class CTraderExecutionProbe : Robot
    {
        private const string EventFileName = "events.csv";
        private const string CaptureFileName = "execution_probe.json";
        private const string Label = "BTE_EXEC_PROBE";

        private StreamWriter _eventWriter;
        private int _barCount;
        private int _openBar = -1;
        private bool _openRequested;
        private bool _closeRequested;
        private bool _closed;
        private Position _position;
        private DateTime _openRequestTime = DateTime.MinValue;
        private DateTime _closeRequestTime = DateTime.MinValue;

        [Parameter("Output Directory", DefaultValue = "BacktestEngineExecutionProbe")]
        public string OutputDirectory { get; set; }

        [Parameter("Side", DefaultValue = ExecutionProbeSide.Buy)]
        public ExecutionProbeSide Side { get; set; }

        [Parameter("Volume In Units", DefaultValue = 1.0, MinValue = 1.0)]
        public double VolumeInUnits { get; set; }

        [Parameter("Open On Bar", DefaultValue = 1, MinValue = 1)]
        public int OpenOnBar { get; set; }

        [Parameter("Close After Bars", DefaultValue = 1, MinValue = 1)]
        public int CloseAfterBars { get; set; }

        [Parameter("Stop Loss Pips", DefaultValue = 0.0, MinValue = 0.0)]
        public double StopLossPips { get; set; }

        [Parameter("Take Profit Pips", DefaultValue = 0.0, MinValue = 0.0)]
        public double TakeProfitPips { get; set; }

        [Parameter("Stop After Close", DefaultValue = true)]
        public bool StopAfterClose { get; set; }

        [Parameter("Max Bars", DefaultValue = 20, MinValue = 1)]
        public int MaxBars { get; set; }

        [Parameter("Capture Tick Events", DefaultValue = false)]
        public bool CaptureTickEvents { get; set; }

        protected override void OnStart()
        {
            Directory.CreateDirectory(ResolvedOutputDirectory());
            _eventWriter = new StreamWriter(Path.Combine(ResolvedOutputDirectory(), EventFileName), false);
            _eventWriter.WriteLine("time_utc,event,bar_count,position_id,side,bid,ask,entry_price,current_price,volume,pips,gross,commissions,net,bar_open,bar_high,bar_low,bar_close,previous_bar_open,previous_bar_high,previous_bar_low,previous_bar_close,close_reason,message");
            Positions.Closed += OnPositionClosed;

            WriteEvent("start", null, "symbol=" + SymbolName + ";period=" + TimeFrame);
            Print("EXEC_PROBE_START symbol={0} period={1} side={2} volume={3} output={4}",
                SymbolName, TimeFrame, Side, VolumeInUnits, ResolvedOutputDirectory());
        }

        protected override void OnBar()
        {
            _barCount++;
            WriteEvent("bar", _position, "");

            if (!_openRequested && _barCount >= OpenOnBar)
                OpenPosition();

            if (_position != null
                && !_closeRequested
                && _openBar >= 0
                && _barCount >= _openBar + CloseAfterBars)
            {
                CloseOpenPosition("close_after_bars");
            }

            if (MaxBars > 0 && _barCount >= MaxBars)
            {
                WriteEvent("max_bars_reached", _position, "");
                Stop();
            }
        }

        protected override void OnTick()
        {
            if (CaptureTickEvents)
                WriteEvent("tick", _position, "");
        }

        protected override void OnStop()
        {
            Positions.Closed -= OnPositionClosed;
            WriteCapture();
            WriteEvent("stop", _position, "");
            _eventWriter?.Flush();
            _eventWriter?.Dispose();
            _eventWriter = null;

            Print("EXEC_PROBE_STOP symbol={0} bars={1} opened={2} closed={3} output={4}",
                SymbolName, _barCount, _openRequested, _closed, ResolvedOutputDirectory());
        }

        private void OpenPosition()
        {
            _openRequested = true;
            _openBar = _barCount;
            _openRequestTime = Server.Time;

            TradeType tradeType = Side == ExecutionProbeSide.Sell ? TradeType.Sell : TradeType.Buy;
            double? stopLoss = StopLossPips > 0.0 ? StopLossPips : (double?)null;
            double? takeProfit = TakeProfitPips > 0.0 ? TakeProfitPips : (double?)null;
            TradeResult result = ExecuteMarketOrder(tradeType, SymbolName, VolumeInUnits, Label, stopLoss, takeProfit);

            if (!result.IsSuccessful)
            {
                WriteEvent("open_rejected", null, result.Error.ToString());
                Print("EXEC_PROBE_OPEN_REJECTED symbol={0} error={1}", SymbolName, result.Error);
                return;
            }

            _position = result.Position;
            WriteEvent("open_filled", _position, "");
            Print("EXEC_PROBE_OPEN_FILLED symbol={0} id={1} side={2} volume={3} entry={4}",
                SymbolName, _position.Id, _position.TradeType, _position.VolumeInUnits, _position.EntryPrice);
        }

        private void CloseOpenPosition(string reason)
        {
            if (_position == null)
                return;

            _closeRequested = true;
            _closeRequestTime = Server.Time;
            TradeResult result = ClosePosition(_position);
            if (!result.IsSuccessful)
            {
                WriteEvent("close_rejected", _position, result.Error.ToString());
                Print("EXEC_PROBE_CLOSE_REJECTED symbol={0} id={1} error={2}", SymbolName, _position.Id, result.Error);
                return;
            }

            WriteEvent("close_requested", _position, reason);
            Print("EXEC_PROBE_CLOSE_REQUESTED symbol={0} id={1} reason={2}", SymbolName, _position.Id, reason);
        }

        private void OnPositionClosed(PositionClosedEventArgs args)
        {
            Position position = args.Position;
            if (position == null || position.Label != Label || position.SymbolName != SymbolName)
                return;

            _closed = true;
            WriteEvent("closed", position, "", args.Reason.ToString());
            Print("EXEC_PROBE_CLOSED symbol={0} id={1} pips={2} gross={3} commissions={4} net={5}",
                SymbolName, position.Id, position.Pips, position.GrossProfit, position.Commissions, position.NetProfit);

            if (StopAfterClose)
                Stop();
        }

        private string ResolvedOutputDirectory()
        {
            string raw = string.IsNullOrWhiteSpace(OutputDirectory)
                ? "BacktestEngineExecutionProbe"
                : OutputDirectory.Trim();

            if (Path.IsPathRooted(raw))
                return raw;

            string documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            return Path.Combine(documents, raw);
        }

        private void WriteEvent(string eventName, Position position, string message)
        {
            WriteEvent(eventName, position, message, "");
        }

        private void WriteEvent(string eventName, Position position, string message, string closeReason)
        {
            if (_eventWriter == null)
                return;

            _eventWriter.WriteLine(string.Join(",",
                FormatTime(Server.Time),
                Escape(eventName),
                _barCount.ToString(CultureInfo.InvariantCulture),
                position != null ? position.Id.ToString(CultureInfo.InvariantCulture) : "",
                position != null ? position.TradeType.ToString() : Side.ToString(),
                FormatNumber(Symbol.Bid),
                FormatNumber(Symbol.Ask),
                position != null ? FormatNumber(position.EntryPrice) : "",
                position != null ? FormatNumber(position.CurrentPrice) : "",
                position != null ? FormatNumber(position.VolumeInUnits) : "",
                position != null ? FormatNumber(position.Pips) : "",
                position != null ? FormatNumber(position.GrossProfit) : "",
                position != null ? FormatNumber(position.Commissions) : "",
                position != null ? FormatNumber(position.NetProfit) : "",
                BarValue(Bars.OpenPrices),
                BarValue(Bars.HighPrices),
                BarValue(Bars.LowPrices),
                BarValue(Bars.ClosePrices),
                BarValue(Bars.OpenPrices, 1),
                BarValue(Bars.HighPrices, 1),
                BarValue(Bars.LowPrices, 1),
                BarValue(Bars.ClosePrices, 1),
                Escape(closeReason ?? ""),
                Escape(message ?? "")));
            _eventWriter.Flush();
        }

        private void WriteCapture()
        {
            var capture = new
            {
                captured_at_utc = FormatTime(Server.Time),
                symbol = SymbolName,
                timeframe = TimeFrame.ToString(),
                label = Label,
                side = Side.ToString(),
                volume_in_units = VolumeInUnits,
                open_on_bar = OpenOnBar,
                close_after_bars = CloseAfterBars,
                stop_loss_pips = StopLossPips,
                take_profit_pips = TakeProfitPips,
                capture_tick_events = CaptureTickEvents,
                bars_seen = _barCount,
                open_requested = _openRequested,
                close_requested = _closeRequested,
                closed = _closed,
                open_request_time_utc = _openRequestTime == DateTime.MinValue ? "" : FormatTime(_openRequestTime),
                close_request_time_utc = _closeRequestTime == DateTime.MinValue ? "" : FormatTime(_closeRequestTime),
                output_directory = ResolvedOutputDirectory(),
                events_file = EventFileName
            };

            var options = new JsonSerializerOptions { WriteIndented = true };
            System.IO.File.WriteAllText(
                Path.Combine(ResolvedOutputDirectory(), CaptureFileName),
                JsonSerializer.Serialize(capture, options) + Environment.NewLine);
        }

        private static string FormatTime(DateTime time)
        {
            return time.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        }

        private static string FormatNumber(double value)
        {
            return value.ToString("G17", CultureInfo.InvariantCulture);
        }

        private static string BarValue(DataSeries series, int offsetFromEnd = 0)
        {
            if (series == null || series.Count == 0)
                return "";

            int index = series.Count - 1 - offsetFromEnd;
            if (index < 0 || index >= series.Count)
                return "";

            return FormatNumber(series[index]);
        }

        private static string Escape(string value)
        {
            value = value ?? "";
            if (value.Contains(",") || value.Contains("\"") || value.Contains("\n"))
                return "\"" + value.Replace("\"", "\"\"") + "\"";
            return value;
        }
    }
}
