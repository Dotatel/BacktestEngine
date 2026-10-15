using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using cAlgo.API;

namespace BacktestEngine.Run
{
    internal sealed class LiveSimulationPublisher : IDisposable
    {
        private readonly StreamWriter _writer;
        private readonly int _publishEveryTicks;
        private long _ticksSincePublish;

        public LiveSimulationPublisher(string path, int publishEveryTicks)
        {
            _publishEveryTicks = Math.Max(1, publishEveryTicks);
            if (string.IsNullOrWhiteSpace(path))
                return;
            string fullPath = Path.GetFullPath(path);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath) ?? ".");
            _writer = new StreamWriter(fullPath, false, new UTF8Encoding(false), 1 << 16)
            {
                AutoFlush = true
            };
        }

        public bool Enabled => _writer != null;

        public void Publish(
            Robot bot,
            MarketTick tick,
            ReplaySummary summary,
            long historicalTicks,
            long generatedTicks,
            SyntheticRegime regime,
            bool force = false,
            string status = "running")
        {
            if (_writer == null || bot == null)
                return;
            _ticksSincePublish++;
            if (!force && _ticksSincePublish < _publishEveryTicks)
                return;
            _ticksSincePublish = 0;

            Position[] open = bot.Positions.ToArray();
            Position[] closed = bot.History.ClosedPositions.TakeLast(30).ToArray();
            var snapshot = new
            {
                type = "snapshot",
                status,
                wall_time_utc = DateTime.UtcNow,
                simulation_time_utc = tick.TimeUtc,
                symbol = bot.SymbolName,
                bid = tick.Bid,
                ask = tick.Ask,
                spread = tick.Ask - tick.Bid,
                balance = bot.Account.Balance,
                equity = bot.Account.Equity,
                net_profit = bot.Account.Equity - bot.Account.StartingBalance,
                return_percent = bot.Account.StartingBalance > 0.0
                    ? (bot.Account.Equity - bot.Account.StartingBalance) / bot.Account.StartingBalance * 100.0
                    : 0.0,
                max_equity_drawdown_percent = summary?.EquityPath?.MaxEquityDrawdownPercent ?? 0.0,
                historical_ticks = historicalTicks,
                generated_ticks = generatedTicks,
                total_ticks = summary?.TickCount ?? 0,
                regime = regime.ToString(),
                open_positions = open.Select(position => new
                {
                    id = position.Id,
                    label = position.Label,
                    side = position.TradeType.ToString(),
                    volume = position.VolumeInUnits,
                    entry_time_utc = position.EntryTime,
                    entry_price = position.EntryPrice,
                    current_price = position.TradeType == TradeType.Buy ? tick.Bid : tick.Ask,
                    pips = position.Pips,
                    net_profit = position.NetProfit,
                    age_hours = Math.Max(0.0, (tick.TimeUtc - position.EntryTime).TotalHours)
                }).ToArray(),
                closed_trade_count = bot.History.ClosedPositions.Count,
                recent_closed_trades = closed.Select(position => new
                {
                    id = position.Id,
                    label = position.Label,
                    side = position.TradeType.ToString(),
                    volume = position.VolumeInUnits,
                    entry_time_utc = position.EntryTime,
                    close_time_utc = position.ClosingTime,
                    entry_price = position.EntryPrice,
                    close_price = position.ClosePrice,
                    close_reason = position.ClosingReason,
                    pips = position.Pips,
                    net_profit = position.NetProfit
                }).ToArray()
            };
            _writer.WriteLine(JsonSerializer.Serialize(snapshot));
        }

        public void Dispose()
        {
            _writer?.Dispose();
        }
    }
}
