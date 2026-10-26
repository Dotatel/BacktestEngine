using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using cAlgo.API;

if (args.Length != 4 || args[0] != "--symbol-spec" || args[2] != "--runner")
    throw new ArgumentException("Usage: CommissionParity --symbol-spec <calibrated v2 JSON> --runner <BacktestEngine.Run.dll>");
string originalSpec = Path.GetFullPath(args[1]);
string runner = Path.GetFullPath(args[3]);
string root = Path.Combine(Path.GetTempPath(), "commission-parity-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
int assertions = 0;
var input = JsonNode.Parse(File.ReadAllText(originalSpec)).AsObject();
string symbol = input["symbol"].GetValue<string>();
string originalAuthority = Resolve(originalSpec, input["commission_conversion_authority_path"].GetValue<string>());
var authority = JsonNode.Parse(File.ReadAllText(originalAuthority)).AsObject();
var spec = EffectiveSymbolSpecificationLoader.Load(originalSpec, symbol);
var events = File.ReadLines(Resolve(originalAuthority, authority["source_events_path"].GetValue<string>()))
    .Where(line => !string.IsNullOrWhiteSpace(line)).Select(line => JsonNode.Parse(line).AsObject()).ToArray();

// Reproduce actual native fills and their timing, including both held-out sides.
foreach (var open in events.Where(e => e["event_type"].GetValue<string>() == "opened"))
{
    var close = events.Single(e => e["event_type"].GetValue<string>() == "closed"
        && e["position_id"].GetValue<long>() == open["position_id"].GetValue<long>());
    var bot = new FeeRobot { SymbolName = symbol };
    bot.Symbol.ApplyEffectiveSpecification(spec);
    bot.Account.Balance = bot.Account.Equity = 1000000;
    bot.Account.DepositAssetDigits = spec.AccountCurrencyDigits;
    SetQuote(bot, open);
    var opened = bot.Open(Enum.Parse<TradeType>(open["side"].GetValue<string>()), open["volume"].GetValue<double>());
    Check(opened.IsSuccessful, "native controlled order opens");
    var position = opened.Position;
    Near(position.EntryPrice, open["entry_price"].GetValue<double>(), "entry price");
    Near(position.EntryCommission, open["commissions"].GetValue<double>(), "native entry commission");
    Check(position.EntryTime == Utc(open["time_utc"].GetValue<string>()), "entry time");
    DateTime entered = bot.Server.Time;
    SetQuote(bot, close);
    bot.ApplyRolloverSwaps(entered, bot.Server.Time);
    Check(bot.Close(position).IsSuccessful, "native controlled order closes");
    Near(position.Commissions, close["commissions"].GetValue<double>(), "native round-trip commission");
    Near(position.Swaps, close["swaps"].GetValue<double>(), "native weekend swaps");
    Near(position.GrossProfit, close["gross"].GetValue<double>(), "native gross profit");
    Near(position.NetProfit, close["net"].GetValue<double>(), "native net profit");
    Check(position.ClosingTime == Utc(close["time_utc"].GetValue<string>()), "close time");
}

var clone = spec.WithCommissionRateOverride(spec.CommissionRate, "same-rate regression");
Check(clone.NativeCommissionEndUtc == spec.NativeCommissionEndUtc && clone.CommissionBaseToUsdRate == spec.CommissionBaseToUsdRate,
    "same-rate clone preserves the fixed conversion and native end date");
Reject(() => spec.WithCommissionRateOverride(spec.CommissionRate + 1, "wrong-rate"), "changing an empirically calibrated commission rate");
var swapClone = spec.WithSwapTermsForDeterministicFixture(spec.SwapLong, spec.SwapShort, spec.SwapTimeAuthorityStatus, "same-swap regression");
Check(swapClone.NativeCommissionEndUtc == spec.NativeCommissionEndUtc && swapClone.CommissionBaseToUsdRate == spec.CommissionBaseToUsdRate,
    "swap fixture clone preserves commission provenance");

CheckMutation("authority-schema", (_, fee) => fee["schema_version"] = "unknown/v1");
CheckMutation("authority-model", (_, fee) => fee["commission_model"] = "Other");
CheckMutation("authority-digits", (_, fee) => fee["account_digits"] = 0);
CheckMutation("authority-interval", (_, fee) => fee["interval_upper_exclusive"] = fee["interval_upper_exclusive"].GetValue<double>() + 100);
CheckMutation("profile-rate", (contract, _) => contract["commission_rate"] = spec.CommissionRate + 1);
CheckMutation("profile-end", (contract, _) => contract["native_commission_end_utc"] = "2026-06-29T00:00:00Z");
foreach (string kind in new[] { "events", "report", "spec" })
{
    var p = Profile("tampered-" + kind);
    File.AppendAllText(p.Fee["source_" + kind + "_path"].GetValue<string>(), "\n ");
    Reject(() => Load(p.SpecPath), "tampered transitive " + kind + " hash");
}
foreach (string kind in new[] { "report-symbol", "report-end", "report-rate", "capture-symbol", "capture-digits", "observed-fee" })
{
    var p = Profile(kind);
    if (kind == "observed-fee")
    {
        string path = p.Fee["source_events_path"].GetValue<string>();
        var lines = File.ReadAllLines(path);
        for (int i = 0; i < lines.Length; i++)
        {
            var e = JsonNode.Parse(lines[i]);
            if (e["event_type"].GetValue<string>() != "opened") continue;
            e["commissions"] = e["commissions"].GetValue<double>() - 0.01;
            lines[i] = e.ToJsonString();
            break;
        }
        File.WriteAllLines(path, lines);
        p.Fee["source_events_sha256"] = Hash(path);
    }
    else
    {
        string sourceKind = kind.StartsWith("report") ? "report" : "spec";
        string path = p.Fee["source_" + sourceKind + "_path"].GetValue<string>();
        var document = JsonNode.Parse(File.ReadAllText(path));
        if (kind == "report-symbol") document["main"]["symbol"] = "WRONG";
        if (kind == "report-end") document["main"]["testingPeriod"]["endDate"] = 0;
        if (kind == "report-rate") document["main"]["commissions"]["value"] = spec.CommissionRate + 1;
        if (kind == "capture-symbol") document["symbol"] = "WRONG";
        if (kind == "capture-digits") document["account_digits"] = 0;
        File.WriteAllText(path, document.ToJsonString());
        p.Fee["source_" + sourceKind + "_sha256"] = Hash(path);
    }
    Save(p);
    Reject(() => Load(p.SpecPath), "semantically inconsistent " + kind + " even when its hashes were updated");
}

string ticks = Path.Combine(root, "ticks.csv");
File.WriteAllText(ticks, "time_utc,bid,ask\n2025-01-10T00:00:00Z,2670,2670.1\n");
string correctEnd = spec.NativeCommissionEndUtc.Value.Date.AddDays(1).ToString("o");
foreach (string end in new[] { "", spec.NativeCommissionEndUtc.Value.Date.ToString("o"),
    spec.NativeCommissionEndUtc.Value.Date.AddHours(12).ToString("o"), spec.NativeCommissionEndUtc.Value.Date.AddDays(2).ToString("o"), correctEnd })
{
    var info = new ProcessStartInfo(Environment.ProcessPath) { RedirectStandardOutput = true, RedirectStandardError = true };
    // The executable host might be the test apphost; use the same dotnet host that built the runner.
    info.FileName = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "/usr/local/share/dotnet/dotnet";
    foreach (string token in new[] { runner, "--strategy", "ExampleStrategy", "--symbol", symbol, "--symbol-spec", originalSpec,
        "--ticks", ticks, "--report-json", Path.Combine(root, "runner-" + Guid.NewGuid().ToString("N") + ".json") }) info.ArgumentList.Add(token);
    if (end.Length > 0) { info.ArgumentList.Add("--end-utc"); info.ArgumentList.Add(end); }
    using var process = Process.Start(info);
    var stdout = process.StandardOutput.ReadToEndAsync();
    var stderr = process.StandardError.ReadToEndAsync();
    if (!process.WaitForExit(30000)) { process.Kill(); throw new Exception("Runner guard test timed out"); }
    string output = stdout.Result + stderr.Result;
    Check(end == correctEnd ? process.ExitCode == 0 : process.ExitCode != 0 && output.Contains("bound to its test end date"),
        "runner requires the exact exclusive native end date: " + end + " output=" + output);
}

// The cache must observe transitive files even when authority-declared hashes
// have not been updated, so a stale report cannot bypass the loader's rejection.
var cache = Profile("cache");
string first = Fingerprint(cache.SpecPath);
foreach (string kind in new[] { "events", "report", "spec" })
{
    string path = cache.Fee["source_" + kind + "_path"].GetValue<string>();
    string old = File.ReadAllText(path);
    File.WriteAllText(path, old + "\n ");
    Check(Fingerprint(cache.SpecPath) != first, "cache invalidates changed transitive " + kind);
    File.WriteAllText(path, old);
}
string cycle = Path.Combine(root, "cycle.json"), alias = Path.Combine(root, "cycle-alias.json");
File.WriteAllText(cycle, "{\"source_spec_path\":\"cycle-alias.json\"}");
File.CreateSymbolicLink(alias, cycle);
Check(Fingerprint(cycle) == Fingerprint(cycle), "cyclic authority aliases terminate with a stable fingerprint");
Console.WriteLine($"COMMISSION_PARITY status=passed assertions={assertions} native_cases={events.Count(e => e["event_type"].GetValue<string>() == "opened")}");
Console.WriteLine("Artifacts: " + root);

EffectiveSymbolSpecification Load(string path) => EffectiveSymbolSpecificationLoader.Load(path, symbol);
void Check(bool condition, string name) { assertions++; if (!condition) throw new Exception(name); }
void Near(double actual, double expected, string name) => Check(Math.Abs(actual - expected) <= 1e-7, name + $": actual={actual:R} expected={expected:R}");
void Reject(Action action, string name)
{
    try { action(); }
    catch (Exception e) when (e is InvalidDataException || e is InvalidOperationException || e is NotSupportedException) { assertions++; return; }
    throw new Exception("Expected rejection: " + name);
}
DateTime Utc(string value) => DateTime.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
string Resolve(string containing, string reference) => Path.GetFullPath(Path.IsPathRooted(reference) ? reference : Path.Combine(Path.GetDirectoryName(containing), reference));
string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
void SetQuote(FeeRobot bot, JsonObject e) { bot.Server.Time = Utc(e["time_utc"].GetValue<string>()); bot.Symbol.Bid = e["bid"].GetValue<double>(); bot.Symbol.Ask = e["ask"].GetValue<double>(); }

ProfileFiles Profile(string name)
{
    string dir = Path.Combine(root, name); Directory.CreateDirectory(dir);
    var contract = input.DeepClone().AsObject(); var fee = authority.DeepClone().AsObject();
    foreach (string kind in new[] { "events", "report", "spec" })
    {
        string source = Resolve(originalAuthority, fee["source_" + kind + "_path"].GetValue<string>());
        string target = Path.Combine(dir, kind + Path.GetExtension(source));
        File.Copy(source, target); fee["source_" + kind + "_path"] = target;
    }
    foreach (string key in new[] { "specification_source_path", "swap_time_authority_path" }) contract[key] = Resolve(originalSpec, contract[key].GetValue<string>());
    var files = new ProfileFiles(Path.Combine(dir, "contract.json"), Path.Combine(dir, "authority.json"), contract, fee);
    Save(files); return files;
}
void Save(ProfileFiles files)
{
    File.WriteAllText(files.FeePath, files.Fee.ToJsonString());
    files.Contract["commission_conversion_authority_path"] = files.FeePath;
    files.Contract["commission_conversion_authority_sha256"] = Hash(files.FeePath);
    File.WriteAllText(files.SpecPath, files.Contract.ToJsonString());
}
void CheckMutation(string name, Action<JsonObject, JsonObject> mutation)
{
    var files = Profile(name); mutation(files.Contract, files.Fee); Save(files);
    Reject(() => Load(files.SpecPath), name);
}
string Fingerprint(string profile)
{
    var assembly = Assembly.Load("BacktestEngine.Optimizer");
    Type configType = assembly.GetType("BacktestEngine.Optimizer.OptimizerConfig"), scenarioType = assembly.GetType("BacktestEngine.Optimizer.ScenarioConfig");
    object config = Activator.CreateInstance(configType), scenario = Activator.CreateInstance(scenarioType);
    scenarioType.GetProperty("SymbolSpec").SetValue(scenario, profile);
    scenarioType.GetProperty("DataFile").SetValue(scenario, ticks);
    configType.GetProperty("Scenario").SetValue(config, scenario);
    string project = Path.Combine(root, "runner", "fake.csproj");
    string binaries = Path.Combine(Path.GetDirectoryName(project), "bin", "Debug"); Directory.CreateDirectory(binaries);
    File.WriteAllText(Path.Combine(binaries, "fixture.dll"), "fingerprint fixture only");
    configType.GetProperty("RunnerProject").SetValue(config, project);
    return (string)assembly.GetType("BacktestEngine.Optimizer.ReplayProvenance").GetMethod("Compute").Invoke(null, new[] { root, config });
}
record ProfileFiles(string SpecPath, string FeePath, JsonObject Contract, JsonObject Fee);
sealed class FeeRobot : Robot
{
    public TradeResult Open(TradeType side, double volume) => ExecuteMarketOrder(side, SymbolName, volume);
    public TradeResult Close(Position position) => ClosePosition(position);
}
