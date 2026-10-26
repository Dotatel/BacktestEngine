using cAlgo.API;

namespace BacktestEngine.Run
{
    // Report compatibility, not a replacement for the full observed equity path.
    // Qualified against native 5.9 reports and live Account.Equity observations.
    internal sealed class NativeReportDrawdown : IDisposable
    {
        private readonly Robot _bot;
        private bool _hasDeal;
        private decimal _lowestBid, _highestAsk;
        private double _equityHighWater;
        public EquityPathMetrics Equity { get; } = new EquityPathMetrics();
        public EquityPathMetrics Balance { get; } = new EquityPathMetrics();
        public long Samples { get; private set; }

        public NativeReportDrawdown(Robot bot)
        {
            _bot = bot;
            _equityHighWater = bot.Account.Equity;
            Balance.Add(bot.Server.Time, bot.Account.Balance, bot.Account.Balance);
            bot.EngineDealCompleted += Deal;
            bot.EngineQuoteMarked += Quote;
        }

        private void Sample()
        {
            double equity = Math.Round(_bot.Account.Equity, _bot.Account.DepositAssetDigits,
                MidpointRounding.AwayFromZero);
            Equity.Add(_bot.Server.Time, _bot.Account.Balance, equity);
            Samples++;
        }

        private void Deal()
        {
            _hasDeal = true;
            _lowestBid = (decimal)_bot.Symbol.Bid;
            _highestAsk = (decimal)_bot.Symbol.Ask;
            Sample();
            Balance.Add(_bot.Server.Time, _bot.Account.Balance, _bot.Account.Balance);
        }

        private void Quote()
        {
            if (!_hasDeal) return;
            decimal bid = (decimal)_bot.Symbol.Bid, ask = (decimal)_bot.Symbol.Ask;
            decimal excursion = Math.Max(_lowestBid - bid, ask - _highestAsk);
            if (excursion <= 0) return;
            _lowestBid = Math.Min(_lowestBid, bid);
            _highestAsk = Math.Max(_highestAsk, ask);
            Sample();
            double equity = Math.Round(_bot.Account.Equity, _bot.Account.DepositAssetDigits,
                MidpointRounding.AwayFromZero);
            if (equity > _equityHighWater)
            {
                _equityHighWater = equity;
                // Following a new account high, move each opposite price bound
                // toward the current quote by the observed price excursion.
                if (bid > _lowestBid + excursion) _lowestBid += excursion;
                if (ask < _highestAsk - excursion) _highestAsk -= excursion;
            }
        }

        public void Complete()
        {
            Sample();
            Balance.Add(_bot.Server.Time, _bot.Account.Balance, _bot.Account.Balance);
        }

        public void Dispose()
        {
            _bot.EngineDealCompleted -= Deal;
            _bot.EngineQuoteMarked -= Quote;
        }
    }
}
