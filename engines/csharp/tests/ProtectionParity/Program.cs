using System.Text.Json;
using cAlgo.API;

var specs = new Dictionary<string, EffectiveSymbolSpecification>();
for (int i = 0; i < args.Length; i += 2)
{
    if (args[i] != "--symbol-spec" || i + 1 >= args.Length)
        throw new ArgumentException("Usage: ProtectionParity --symbol-spec XAUUSD.json --symbol-spec EURUSD.json");
    using var json = JsonDocument.Parse(File.ReadAllText(args[i + 1]));
    string symbol = json.RootElement.GetProperty("symbol").GetString();
    specs.Add(symbol, EffectiveSymbolSpecificationLoader.Load(args[i + 1], symbol));
}
if (!specs.ContainsKey("XAUUSD") || !specs.ContainsKey("EURUSD"))
    throw new ArgumentException("Authenticated XAUUSD and EURUSD economic specifications are required.");

int assertions = 0;
using var fixtures = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "native-protection-fixtures.json")));
foreach (var fixture in fixtures.RootElement.EnumerateArray())
{
    string name = fixture.GetProperty("name").GetString();
    TradeType side = Enum.Parse<TradeType>(fixture.GetProperty("side").GetString());
    var spec = specs[fixture.GetProperty("symbol").GetString()];
    double pips = fixture.GetProperty("pips").GetDouble();
    foreach (bool target in new[] { false, true })
    {
        var bot = NewBot(spec, fixture.GetProperty("bid").GetDouble(), fixture.GetProperty("ask").GetDouble());
        var position = Open(bot, side, pips, pips);
        Check(position.EntryPrice == fixture.GetProperty("entry").GetDouble(), name + ": unchanged executable fill");
        Check(position.EntryBid == fixture.GetProperty("bid").GetDouble() && position.EntryAsk == fixture.GetProperty("ask").GetDouble(),
            name + ": recorded opening bid/ask");
        double expectedStop = fixture.GetProperty("stop_loss").GetDouble();
        double expectedTarget = fixture.GetProperty("take_profit").GetDouble();
        Check(position.StopLoss == fixture.GetProperty("raw_native_stop_loss").GetDouble()
            && position.TakeProfit == fixture.GetProperty("raw_native_take_profit").GetDouble(), name + ": native raw protection thresholds");
        double price = target ? expectedTarget : expectedStop;
        SetExitQuote(bot, side, price);
        DateTime touch = bot.Server.Time.AddMilliseconds(123);
        bot.Server.Time = touch;
        bot.ProcessStopsAndTargets(ProtectionFillMode.CurrentPrice);
        Check(bot.History.ClosedPositions.Count == 1, name + ": first exact touch must close");
        Check(position.ClosingTime == touch && position.ClosePrice == price, name + ": first-touch execution price and time");
        Check(position.CloseBid == bot.Symbol.Bid && position.CloseAsk == bot.Symbol.Ask, name + ": recorded closing bid/ask");
        Check(position.ClosingReason == (target ? "take_profit" : "stop_loss"), name + ": trigger reason");
    }
}

// This protection regression checks an exact quote differing by one binary ULP.
var regression = NewBot(specs["XAUUSD"], 2638.30, 2638.40);
var floating = Open(regression, TradeType.Buy, null, 9.700000000002547);
Check(floating.TakeProfit == 2639.37, "ATR arithmetic must resolve to a quoted target price");
regression.Server.Time = new DateTime(2025, 1, 3, 21, 44, 19, DateTimeKind.Utc).AddMilliseconds(493);
regression.Symbol.Bid = 2639.37;
regression.Symbol.Ask = 2639.65;
regression.ProcessStopsAndTargets(ProtectionFillMode.CurrentPrice);
Check(floating.ClosePrice == 2639.37 && floating.ClosingTime == regression.Server.Time, "recorded 21:44:19.493 touch must not wait for 21:44:19.620");

// Native EURUSD position 5, independently traced with the unmodified
// strategy: displayed SL 1.04590 is actually 1.0458999999999998. The rounded
// displayed touch at 02:38 does not fill; the 05:08 lower quote does.
var fxRaw = NewBot(specs["EURUSD"], 1.05161, 1.05161);
var rawStop = Open(fxRaw, TradeType.Buy, 57.1, 20.2);
Check(rawStop.StopLoss == 1.0458999999999998 && rawStop.TakeProfit == 1.0536299999999998,
    "EUR native raw absolute SL/TP retain the entry plus normalized-distance binary result");
fxRaw.Server.Time = new DateTime(2025, 1, 27, 2, 38, 48, DateTimeKind.Utc).AddMilliseconds(177);
fxRaw.Symbol.Bid = fxRaw.Symbol.Ask = 1.0459;
fxRaw.ProcessStopsAndTargets(ProtectionFillMode.CurrentPrice, nativeTraversal: true);
Check(fxRaw.History.ClosedPositions.Count == 0, "rounded displayed SL touch must not cross a lower raw native threshold");
fxRaw.Server.Time = new DateTime(2025, 1, 27, 5, 8, 48, DateTimeKind.Utc).AddMilliseconds(858);
fxRaw.Symbol.Bid = fxRaw.Symbol.Ask = 1.04588;
fxRaw.ProcessStopsAndTargets(ProtectionFillMode.CurrentPrice, nativeTraversal: true);
Check(rawStop.ClosePrice == 1.04588 && rawStop.ClosingTime == fxRaw.Server.Time,
    "native raw threshold closes at the first actual beyond-threshold quote");

// A gap crosses a normalized trigger; tick execution still uses the executable
// quote. Normalization must never replace a market fill with the requested level.
foreach (TradeType side in new[] { TradeType.Buy, TradeType.Sell })
foreach (ProtectionFillMode mode in new[] { ProtectionFillMode.CurrentPrice, ProtectionFillMode.StopOrTargetPrice })
{
    var bot = NewBot(specs["XAUUSD"], 2638.30, 2638.40);
    var position = Open(bot, side, null, 9.700000000002547);
    double level = position.TakeProfit.Value;
    double beyond = Math.Round(level + (side == TradeType.Buy ? 0.03 : -0.03), specs["XAUUSD"].Digits);
    SetExitQuote(bot, side, beyond);
    bot.ProcessStopsAndTargets(mode);
    Check(position.ClosePrice == (mode == ProtectionFillMode.CurrentPrice ? beyond : level), "gap fill respects the selected execution mode");
}
using var traversalCases = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "native-traversal-fixtures.json")));
foreach (var test in traversalCases.RootElement.EnumerateArray())
{
    string name = test.GetProperty("name").GetString();
    var bot = NewBot(specs["XAUUSD"], test.GetProperty("bid").GetDouble(), test.GetProperty("ask").GetDouble());
    bot.Server.Time = DateTime.Parse(test.GetProperty("time").GetString(), null, System.Globalization.DateTimeStyles.AdjustToUniversal);
    foreach (var item in test.GetProperty("positions").EnumerateArray())
    {
        var opened = bot.Open(Enum.Parse<TradeType>(item.GetProperty("side").GetString()), item.GetProperty("volume").GetDouble(),
            item.TryGetProperty("stop_pips", out var stop) ? stop.GetDouble() : item.GetProperty("pips").GetDouble(),
            item.TryGetProperty("target_pips", out var target) ? target.GetDouble() : item.GetProperty("pips").GetDouble());
        Check(opened.IsSuccessful && opened.Position.Id == item.GetProperty("id").GetInt64(), name + ": native opening sequence");
    }
    foreach (var tick in test.GetProperty("ticks").EnumerateArray())
    {
        bot.Server.Time = DateTime.Parse(tick[0].GetString(), null, System.Globalization.DateTimeStyles.AdjustToUniversal);
        bot.Symbol.Bid = tick[1].GetDouble(); bot.Symbol.Ask = tick[2].GetDouble();
        bot.ProcessStopsAndTargets(ProtectionFillMode.CurrentPrice, nativeTraversal: true);
    }
    var expected = test.GetProperty("expected_closes").EnumerateArray().ToArray();
    Check(bot.History.ClosedPositions.Count == expected.Length, name + ": native completed position count");
    for (int i = 0; i < expected.Length; i++)
    {
        var actual = bot.History.ClosedPositions[i]; var reference = expected[i];
        Check(actual.Id == reference.GetProperty("id").GetInt64(), name + ": native protection queue order " + i);
        Check(actual.ClosingTime == DateTime.Parse(reference.GetProperty("time").GetString(), null, System.Globalization.DateTimeStyles.AdjustToUniversal),
            name + ": native close timestamp " + i);
        Check(actual.ClosePrice == reference.GetProperty("price").GetDouble(), name + ": native executable close price " + i);
    }
}

foreach (TradeType side in new[] { TradeType.Buy, TradeType.Sell })
{
    var bot = NewBot(specs["XAUUSD"], 100, 100.1);
    var position = Open(bot, side, 2, null);
    bot.ProcessNativeMinuteBarProtections(101, 99, 0.1);
    double expectedBid = side == TradeType.Buy ? 99 : 101;
    Check(position.CloseBid == expectedBid && position.CloseAsk == expectedBid + 0.1,
        "native M1 records the executable extreme quote, not the preceding callback quote");
    Check(bot.Symbol.Bid == 100 && bot.Symbol.Ask == 100.1,
        "native M1 quote capture preserves the strategy-visible callback quote");
}
var partialBot = NewBot(specs["XAUUSD"], 2670, 2670.1);
var partialPosition = partialBot.Open(TradeType.Buy, partialBot.Symbol.VolumeInUnitsMin * 2, 10, 10).Position;
double originalBalance = partialBot.Account.Balance, originalEquity = partialBot.Account.Equity;
double originalVolume = partialPosition.VolumeInUnits, originalFees = partialPosition.Commissions;
foreach (double closeVolume in new[] { originalVolume / 2, originalVolume + partialBot.Symbol.VolumeInUnitsStep, double.NaN, double.PositiveInfinity })
{
    var result = partialBot.CloseVolume(partialPosition, closeVolume);
    Check(!result.IsSuccessful && !string.IsNullOrWhiteSpace(result.Error), "unsupported partial or invalid close volume fails explicitly");
    Check(partialBot.Account.Balance == originalBalance && partialBot.Account.Equity == originalEquity
        && partialPosition.VolumeInUnits == originalVolume && partialPosition.Commissions == originalFees
        && partialBot.History.ClosedPositions.Count == 0,
        "failed close must not alter balance, equity, volume, fees or realized history");
}
Check(partialBot.CloseVolume(partialPosition, originalVolume).IsSuccessful
    && partialBot.History.ClosedPositions.Count == 1, "explicit full volume delegates to the supported full-close path");
Console.WriteLine($"PROTECTION_PARITY status=passed assertions={assertions} native_level_cases=10 native_traversal_cases={traversalCases.RootElement.GetArrayLength()}");

ProbeRobot NewBot(EffectiveSymbolSpecification spec, double bid, double ask)
{
    var bot = new ProbeRobot { SymbolName = spec.Symbol };
    bot.Symbol.ApplyEffectiveSpecification(spec);
    bot.Symbol.Bid = bid;
    bot.Symbol.Ask = ask;
    bot.Account.Balance = bot.Account.Equity = 100000;
    bot.Server.Time = new DateTime(2025, 1, 10, 0, 1, 0, DateTimeKind.Utc);
    return bot;
}

Position Open(ProbeRobot bot, TradeType side, double? stop, double? target)
{
    var result = bot.Open(side, bot.Symbol.VolumeInUnitsMin, stop, target);
    Check(result.IsSuccessful && result.Position != null, "protected order accepted");
    return result.Position;
}

void SetExitQuote(ProbeRobot bot, TradeType side, double price)
{
    bot.Symbol.Bid = side == TradeType.Buy ? price : Math.Round(price - bot.Symbol.TickSize * 2, bot.Symbol.Digits);
    bot.Symbol.Ask = side == TradeType.Sell ? price : Math.Round(price + bot.Symbol.TickSize * 2, bot.Symbol.Digits);
}

void Check(bool value, string description)
{
    assertions++;
    if (!value) throw new InvalidOperationException(description);
}

sealed class ProbeRobot : Robot
{
    public TradeResult Open(TradeType side, double volume, double? stop, double? target) => ExecuteMarketOrder(side, SymbolName, volume, "PROTECTION_PARITY", stop, target);
    public TradeResult CloseVolume(Position position, double volume) => ClosePosition(position, volume);
}
