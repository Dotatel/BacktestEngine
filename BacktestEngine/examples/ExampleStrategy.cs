using cAlgo.API;

namespace cAlgo.Robots
{
    // Mechanical execution example only; it makes no profitability claim.
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class ExampleStrategy : Robot
    {
        [Parameter("Volume Multiplier", DefaultValue = 1)]
        public int VolumeMultiplier { get; set; }
        [Parameter("Hold Ticks", DefaultValue = 100)]
        public int HoldTicks { get; set; }
        private int _ticks;
        private bool _buy = true;
        protected override void OnStart()
        {
            if (VolumeMultiplier < 1 || HoldTicks < 1)
                throw new System.ArgumentException("Example parameters must be positive.");
        }
        protected override void OnTick()
        {
            if (++_ticks % HoldTicks != 0) return;
            foreach (var position in Positions.FindAll("EXAMPLE", SymbolName))
                ClosePosition(position);
            ExecuteMarketOrder(_buy ? TradeType.Buy : TradeType.Sell, SymbolName,
                Symbol.VolumeInUnitsMin * VolumeMultiplier, "EXAMPLE");
            _buy = !_buy;
        }
    }
}
