using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using cAlgo.API;

namespace BacktestEngine.Run
{
    internal interface IMarketTickSource
    {
        bool TryGetNext(out MarketTick tick);
    }

    internal enum SyntheticRegime
    {
        Quiet,
        Normal,
        TrendUp,
        TrendDown,
        Crisis
    }

    internal sealed class SyntheticMarketModel
    {
        public int SchemaVersion { get; set; } = 1;
        public string Name { get; set; } = "hybrid-gjr-skewt-v1";
        public string Symbol { get; set; } = "XAUUSD";
        public double InitialPrice { get; set; } = 2500.0;
        public double TickSize { get; set; } = 0.01;
        public double PipSize { get; set; } = 0.1;
        public double BaseSpreadPips { get; set; } = 0.50;
        public double MedianTickSeconds { get; set; } = 0.75;
        public double DailyVolatility { get; set; } = 0.012;
        public double GarchAlpha { get; set; } = 0.06;
        public double GarchBeta { get; set; } = 0.90;
        public double GarchLeverage { get; set; } = 0.04;
        public int StudentTDegreesOfFreedom { get; set; } = 6;
        public double TrendDriftPerDay { get; set; } = 0.003;
        public double RegimeMeanHours { get; set; } = 9.0;
        public double JumpRatePerDay { get; set; } = 0.04;
        public double JumpSizeDailyVolatility { get; set; } = 0.60;
        public double SpreadVolatilitySensitivity { get; set; } = 0.35;
        public bool CloseWeekends { get; set; } = true;
        public double[] HourlyActivityMultipliers { get; set; } = Enumerable.Repeat(1.0, 24).ToArray();

        public static SyntheticMarketModel DefaultFor(Robot bot)
        {
            double price = Math.Max(bot?.Symbol?.Bid ?? 0.0, 1.0);
            double pipSize = Math.Max(bot?.Symbol?.PipSize ?? 0.0001, 0.00000001);
            double tickSize = Math.Max(bot?.Symbol?.TickSize ?? pipSize / 10.0, 0.00000001);
            bool metal = (bot?.SymbolName ?? "").StartsWith("XAU", StringComparison.OrdinalIgnoreCase);
            return new SyntheticMarketModel
            {
                Symbol = bot?.SymbolName ?? "SYNTHETIC",
                InitialPrice = price,
                PipSize = pipSize,
                TickSize = tickSize,
                BaseSpreadPips = Math.Max(0.1, ((bot?.Symbol?.Ask ?? price) - price) / pipSize),
                MedianTickSeconds = metal ? 0.35 : 0.75,
                DailyVolatility = metal ? 0.012 : 0.006,
                TrendDriftPerDay = metal ? 0.003 : 0.0015
            };
        }

        public static SyntheticMarketModel Load(string path, Robot bot)
        {
            if (string.IsNullOrWhiteSpace(path))
                return DefaultFor(bot);
            if (!File.Exists(path))
                throw new FileNotFoundException("Synthetic model file was not found.", path);
            JsonSerializerOptions jsonOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            SyntheticMarketModel model = JsonSerializer.Deserialize<SyntheticMarketModel>(File.ReadAllText(path), jsonOptions)
                ?? throw new InvalidOperationException("Synthetic model JSON is empty.");
            model.Validate();
            return model;
        }

        public void Save(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
                return;
            string fullPath = Path.GetFullPath(path);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath) ?? ".");
            JsonSerializerOptions options = new JsonSerializerOptions { WriteIndented = true };
            File.WriteAllText(fullPath, JsonSerializer.Serialize(this, options) + Environment.NewLine);
        }

        public void Validate()
        {
            if (TickSize <= 0.0 || PipSize <= 0.0)
                throw new InvalidOperationException("Synthetic model tick_size and pip_size must be positive.");
            if (InitialPrice <= 0.0 || DailyVolatility <= 0.0 || MedianTickSeconds <= 0.0)
                throw new InvalidOperationException("Synthetic model price, volatility and tick interval must be positive.");
            if (GarchAlpha < 0.0 || GarchBeta < 0.0 || GarchLeverage < 0.0
                || GarchAlpha + GarchBeta + 0.5 * GarchLeverage >= 0.9999)
                throw new InvalidOperationException("Synthetic GARCH parameters must be non-negative and stationary.");
            StudentTDegreesOfFreedom = Math.Max(3, Math.Min(30, StudentTDegreesOfFreedom));
            if (HourlyActivityMultipliers == null || HourlyActivityMultipliers.Length != 24)
                HourlyActivityMultipliers = Enumerable.Repeat(1.0, 24).ToArray();
        }
    }

    internal sealed class SyntheticScenario
    {
        public string Name { get; set; } = "baseline";
        public double VolatilityMultiplier { get; set; } = 1.0;
        public double DriftMultiplier { get; set; } = 1.0;
        public double TickRateMultiplier { get; set; } = 1.0;
        public double SpreadMultiplier { get; set; } = 1.0;
        public double JumpRateMultiplier { get; set; } = 1.0;
        public double CrisisProbabilityMultiplier { get; set; } = 1.0;

        public static SyntheticScenario Load(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
                return new SyntheticScenario();
            if (!File.Exists(path))
                throw new FileNotFoundException("Synthetic scenario file was not found.", path);
            SyntheticScenario scenario = JsonSerializer.Deserialize<SyntheticScenario>(
                File.ReadAllText(path),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new InvalidOperationException("Synthetic scenario JSON is empty.");
            scenario.Validate();
            return scenario;
        }

        private void Validate()
        {
            if (VolatilityMultiplier <= 0.0 || TickRateMultiplier <= 0.0 || SpreadMultiplier < 0.0
                || JumpRateMultiplier < 0.0 || CrisisProbabilityMultiplier < 0.0)
                throw new InvalidOperationException("Synthetic scenario multipliers are invalid.");
        }
    }

    internal sealed class SyntheticCalibrationAccumulator
    {
        private readonly int _capacity;
        private readonly Queue<MarketTick> _ticks;

        public SyntheticCalibrationAccumulator(int capacity)
        {
            _capacity = Math.Max(100, capacity);
            _ticks = new Queue<MarketTick>(_capacity);
        }

        public int Count => _ticks.Count;

        public void Add(IEnumerable<MarketTick> ticks)
        {
            if (ticks == null)
                return;
            foreach (MarketTick tick in ticks)
            {
                _ticks.Enqueue(tick);
                while (_ticks.Count > _capacity)
                    _ticks.Dequeue();
            }
        }

        public SyntheticMarketModel Build(Robot bot)
        {
            SyntheticMarketModel model = SyntheticMarketModel.DefaultFor(bot);
            MarketTick[] ticks = _ticks.ToArray();
            if (ticks.Length < 100)
                return model;

            model.InitialPrice = Math.Max(model.TickSize, (ticks[^1].Bid + ticks[^1].Ask) * 0.5);
            List<double> intervals = new List<double>(ticks.Length);
            List<double> spreads = new List<double>(ticks.Length);
            Dictionary<DateTime, double> dailyVariance = new Dictionary<DateTime, double>();
            double[] hourlyCounts = new double[24];
            for (int i = 0; i < ticks.Length; i++)
            {
                spreads.Add(Math.Max(0.0, ticks[i].Ask - ticks[i].Bid) / model.PipSize);
                hourlyCounts[ticks[i].TimeUtc.Hour]++;
                if (i == 0)
                    continue;
                double seconds = (ticks[i].TimeUtc - ticks[i - 1].TimeUtc).TotalSeconds;
                if (seconds > 0.0 && seconds <= 300.0)
                    intervals.Add(seconds);
                if (ticks[i - 1].Bid > 0.0 && ticks[i].Bid > 0.0)
                {
                    double logReturn = Math.Log(ticks[i].Bid / ticks[i - 1].Bid);
                    DateTime day = ticks[i].TimeUtc.Date;
                    dailyVariance[day] = dailyVariance.GetValueOrDefault(day) + logReturn * logReturn;
                }
            }

            intervals.Sort();
            spreads.Sort();
            if (intervals.Count > 0)
                model.MedianTickSeconds = Math.Max(0.02, Percentile(intervals, 0.50));
            if (spreads.Count > 0)
                model.BaseSpreadPips = Math.Max(model.TickSize / model.PipSize, Percentile(spreads, 0.50));
            double[] realizedVolatility = dailyVariance.Values.Where(value => value > 0.0).Select(Math.Sqrt).ToArray();
            if (realizedVolatility.Length >= 3)
            {
                Array.Sort(realizedVolatility);
                model.DailyVolatility = Math.Max(0.0001, Percentile(realizedVolatility, 0.50));
            }

            double meanHourly = hourlyCounts.Average();
            if (meanHourly > 0.0)
            {
                model.HourlyActivityMultipliers = hourlyCounts
                    .Select(value => Math.Max(0.05, Math.Min(5.0, value / meanHourly)))
                    .ToArray();
            }
            model.Validate();
            return model;
        }

        private static double Percentile(IReadOnlyList<double> sorted, double probability)
        {
            if (sorted == null || sorted.Count == 0)
                return 0.0;
            double index = Math.Max(0.0, Math.Min(1.0, probability)) * (sorted.Count - 1);
            int lower = (int)Math.Floor(index);
            int upper = Math.Min(sorted.Count - 1, lower + 1);
            double weight = index - lower;
            return sorted[lower] * (1.0 - weight) + sorted[upper] * weight;
        }
    }

    internal sealed class SyntheticTickSource : IMarketTickSource
    {
        private const double SecondsPerDay = 86400.0;
        private readonly SyntheticMarketModel _model;
        private readonly SyntheticScenario _scenario;
        private readonly DeterministicRandom _random;
        private readonly DateTime _endUtc;
        private readonly long _maxTicks;
        private DateTime _timeUtc;
        private double _mid;
        private double _variance = 1.0;
        private double _previousShock;
        private SyntheticRegime _regime = SyntheticRegime.Normal;
        private DateTime _nextRegimeChangeUtc;
        private long _generated;
        private long _jumpCount;
        private readonly long[] _regimeCounts = new long[5];

        public SyntheticTickSource(
            SyntheticMarketModel model,
            SyntheticScenario scenario,
            MarketTick initialTick,
            DateTime endUtc,
            long maxTicks,
            int seed)
        {
            _model = model ?? throw new ArgumentNullException(nameof(model));
            _scenario = scenario ?? new SyntheticScenario();
            _model.Validate();
            _random = new DeterministicRandom(unchecked((ulong)(uint)seed));
            _timeUtc = DateTime.SpecifyKind(initialTick.TimeUtc, DateTimeKind.Utc);
            _mid = Math.Max(_model.TickSize, (initialTick.Bid + initialTick.Ask) * 0.5);
            _endUtc = endUtc;
            _maxTicks = maxTicks;
            ScheduleNextRegime();
        }

        public long GeneratedCount => _generated;
        public long JumpCount => _jumpCount;
        public SyntheticRegime Regime => _regime;
        public IReadOnlyList<long> RegimeCounts => _regimeCounts;

        public bool TryGetNext(out MarketTick tick)
        {
            tick = default;
            if ((_maxTicks > 0 && _generated >= _maxTicks) || (_endUtc != DateTime.MaxValue && _timeUtc >= _endUtc))
                return false;

            double activity = Math.Max(0.05, _model.HourlyActivityMultipliers[_timeUtc.Hour]);
            activity *= Math.Max(0.01, _scenario.TickRateMultiplier) * RegimeTickMultiplier(_regime);
            double interval = _model.MedianTickSeconds * Math.Exp(0.65 * _random.NextNormal()) / activity;
            interval = Math.Max(0.01, Math.Min(120.0, interval));
            DateTime nextTime = _timeUtc.AddSeconds(interval);
            if (_model.CloseWeekends)
                nextTime = AdvanceThroughWeekend(nextTime);
            if (_endUtc != DateTime.MaxValue && nextTime > _endUtc)
                return false;
            _timeUtc = nextTime;

            if (_timeUtc >= _nextRegimeChangeUtc)
            {
                SelectNextRegime();
                ScheduleNextRegime();
            }

            double z = _random.NextStudentT(_model.StudentTDegreesOfFreedom);
            double alphaShock = _previousShock * _previousShock;
            double leverage = _previousShock < 0.0 ? _model.GarchLeverage * alphaShock : 0.0;
            double omega = Math.Max(0.000001, 1.0 - _model.GarchAlpha - _model.GarchBeta - 0.5 * _model.GarchLeverage);
            _variance = omega + _model.GarchAlpha * alphaShock + leverage + _model.GarchBeta * _variance;
            _variance = Math.Max(0.05, Math.Min(25.0, _variance));

            double regimeVolatility = RegimeVolatilityMultiplier(_regime);
            double sigma = _model.DailyVolatility * _scenario.VolatilityMultiplier
                * regimeVolatility * Math.Sqrt(_variance * interval / SecondsPerDay);
            double driftDirection = _regime == SyntheticRegime.TrendUp ? 1.0
                : _regime == SyntheticRegime.TrendDown ? -1.0 : 0.0;
            double drift = driftDirection * _model.TrendDriftPerDay * _scenario.DriftMultiplier * interval / SecondsPerDay;
            double logReturn = drift + sigma * z;
            double jumpProbability = _model.JumpRatePerDay * _scenario.JumpRateMultiplier
                * RegimeJumpMultiplier(_regime) * interval / SecondsPerDay;
            if (_random.NextDouble() < jumpProbability)
            {
                double direction = _random.NextDouble() < 0.52 ? -1.0 : 1.0;
                logReturn += direction * _model.DailyVolatility * _model.JumpSizeDailyVolatility
                    * _scenario.VolatilityMultiplier * (0.5 + Math.Abs(_random.NextNormal()));
                _jumpCount++;
            }

            _mid = Math.Max(_model.TickSize, _mid * Math.Exp(logReturn));
            _previousShock = z;
            double spreadNoise = Math.Exp(0.18 * _random.NextNormal());
            double spreadPips = _model.BaseSpreadPips * _scenario.SpreadMultiplier
                * RegimeSpreadMultiplier(_regime) * spreadNoise
                * (1.0 + _model.SpreadVolatilitySensitivity * Math.Min(5.0, Math.Abs(z) * Math.Sqrt(_variance)));
            double spread = Math.Max(_model.TickSize, spreadPips * _model.PipSize);
            double bid = RoundToTick(_mid - spread * 0.5, _model.TickSize);
            double ask = Math.Max(bid + _model.TickSize, RoundToTick(_mid + spread * 0.5, _model.TickSize));
            tick = new MarketTick(_timeUtc, bid, ask);
            _generated++;
            _regimeCounts[(int)_regime]++;
            return true;
        }

        private void SelectNextRegime()
        {
            double crisisWeight = 0.03 * _scenario.CrisisProbabilityMultiplier;
            double draw = _random.NextDouble() * (1.0 + crisisWeight);
            if (draw < 0.18)
                _regime = SyntheticRegime.Quiet;
            else if (draw < 0.72)
                _regime = SyntheticRegime.Normal;
            else if (draw < 0.86)
                _regime = SyntheticRegime.TrendUp;
            else if (draw < 1.0)
                _regime = SyntheticRegime.TrendDown;
            else
                _regime = SyntheticRegime.Crisis;
        }

        private void ScheduleNextRegime()
        {
            double hours = -Math.Log(Math.Max(1e-12, 1.0 - _random.NextDouble())) * Math.Max(0.25, _model.RegimeMeanHours);
            _nextRegimeChangeUtc = _timeUtc.AddHours(hours);
        }

        private static DateTime AdvanceThroughWeekend(DateTime timeUtc)
        {
            if (timeUtc.DayOfWeek == DayOfWeek.Friday && timeUtc.Hour >= 22)
                return timeUtc.Date.AddDays(2).AddHours(22);
            if (timeUtc.DayOfWeek == DayOfWeek.Saturday)
                return timeUtc.Date.AddDays(1).AddHours(22);
            if (timeUtc.DayOfWeek == DayOfWeek.Sunday && timeUtc.Hour < 22)
                return timeUtc.Date.AddHours(22);
            return timeUtc;
        }

        private static double RoundToTick(double value, double tickSize)
        {
            return Math.Max(tickSize, Math.Round(value / tickSize, MidpointRounding.AwayFromZero) * tickSize);
        }

        private static double RegimeVolatilityMultiplier(SyntheticRegime regime) => regime switch
        {
            SyntheticRegime.Quiet => 0.45,
            SyntheticRegime.Normal => 1.0,
            SyntheticRegime.TrendUp => 1.15,
            SyntheticRegime.TrendDown => 1.25,
            SyntheticRegime.Crisis => 3.25,
            _ => 1.0
        };

        private static double RegimeTickMultiplier(SyntheticRegime regime) => regime switch
        {
            SyntheticRegime.Quiet => 0.45,
            SyntheticRegime.Normal => 1.0,
            SyntheticRegime.TrendUp => 1.25,
            SyntheticRegime.TrendDown => 1.35,
            SyntheticRegime.Crisis => 2.75,
            _ => 1.0
        };

        private static double RegimeSpreadMultiplier(SyntheticRegime regime) => regime switch
        {
            SyntheticRegime.Quiet => 0.85,
            SyntheticRegime.Normal => 1.0,
            SyntheticRegime.TrendUp => 1.10,
            SyntheticRegime.TrendDown => 1.20,
            SyntheticRegime.Crisis => 2.75,
            _ => 1.0
        };

        private static double RegimeJumpMultiplier(SyntheticRegime regime) => regime == SyntheticRegime.Crisis ? 8.0 : 1.0;
    }

    internal sealed class SyntheticReplayMetadata
    {
        public string ModelName { get; set; } = "";
        public string ModelPath { get; set; } = "";
        public string ModelSha256 { get; set; } = "";
        public string ScenarioName { get; set; } = "";
        public string ScenarioPath { get; set; } = "";
        public string ScenarioSha256 { get; set; } = "";
        public int Seed { get; set; }
        public DateTime BoundaryTimeUtc { get; set; }
        public long HistoricalTicks { get; set; }
        public long GeneratedTicks { get; set; }
        public long JumpCount { get; set; }
        public long[] RegimeCounts { get; set; } = Array.Empty<long>();
        public string RecordedTicksPath { get; set; } = "";
    }

    internal sealed class SyntheticTickRecorder : IDisposable
    {
        private readonly StreamWriter _writer;

        public SyntheticTickRecorder(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
                return;
            string fullPath = Path.GetFullPath(path);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath) ?? ".");
            _writer = new StreamWriter(fullPath, false, new UTF8Encoding(false), 1 << 20);
            _writer.WriteLine("time_utc,bid,ask");
        }

        public void Write(MarketTick tick)
        {
            _writer?.WriteLine(string.Format(
                CultureInfo.InvariantCulture,
                "{0:O},{1:R},{2:R}",
                tick.TimeUtc,
                tick.Bid,
                tick.Ask));
        }

        public void Dispose()
        {
            _writer?.Dispose();
        }
    }

    internal sealed class ReplayPacer
    {
        private readonly string _mode;
        private readonly double _speed;
        private readonly Stopwatch _clock = new Stopwatch();
        private DateTime _simulationStart;
        private bool _started;

        public ReplayPacer(string value)
        {
            string normalized = (value ?? "max").Trim().ToLowerInvariant();
            if (normalized == "max" || normalized == "unlimited" || normalized == "0")
            {
                _mode = "max";
                return;
            }
            if (normalized == "step")
            {
                _mode = "step";
                return;
            }
            if (normalized == "realtime" || normalized == "real-time")
                normalized = "1";
            normalized = normalized.TrimEnd('x');
            if (!double.TryParse(normalized, NumberStyles.Float, CultureInfo.InvariantCulture, out _speed) || _speed <= 0.0)
                throw new ArgumentException("Simulation speed must be max, step, realtime, or a positive multiplier such as 100x.");
            _mode = "paced";
        }

        public void Wait(DateTime simulationTime)
        {
            if (_mode == "max")
                return;
            if (_mode == "step")
            {
                Console.ReadLine();
                return;
            }
            if (!_started)
            {
                _started = true;
                _simulationStart = simulationTime;
                _clock.Start();
                return;
            }
            double targetMilliseconds = (simulationTime - _simulationStart).TotalMilliseconds / _speed;
            while (true)
            {
                double remaining = targetMilliseconds - _clock.Elapsed.TotalMilliseconds;
                if (remaining <= 1.0)
                    break;
                Thread.Sleep((int)Math.Min(remaining, 1000.0));
            }
        }
    }

    internal sealed class DeterministicRandom
    {
        private ulong _state;
        private bool _hasSpareNormal;
        private double _spareNormal;

        public DeterministicRandom(ulong seed)
        {
            _state = seed == 0 ? 0x9E3779B97F4A7C15UL : seed;
        }

        public double NextDouble()
        {
            return (NextUInt64() >> 11) * (1.0 / 9007199254740992.0);
        }

        public double NextNormal()
        {
            if (_hasSpareNormal)
            {
                _hasSpareNormal = false;
                return _spareNormal;
            }
            double u1 = Math.Max(1e-15, NextDouble());
            double u2 = NextDouble();
            double radius = Math.Sqrt(-2.0 * Math.Log(u1));
            double angle = 2.0 * Math.PI * u2;
            _spareNormal = radius * Math.Sin(angle);
            _hasSpareNormal = true;
            return radius * Math.Cos(angle);
        }

        public double NextStudentT(int degreesOfFreedom)
        {
            int df = Math.Max(3, Math.Min(30, degreesOfFreedom));
            double numerator = NextNormal();
            double chiSquare = 0.0;
            for (int i = 0; i < df; i++)
            {
                double value = NextNormal();
                chiSquare += value * value;
            }
            double raw = numerator / Math.Sqrt(Math.Max(1e-12, chiSquare / df));
            return raw * Math.Sqrt((df - 2.0) / df);
        }

        private ulong NextUInt64()
        {
            ulong z = (_state += 0x9E3779B97F4A7C15UL);
            z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
            z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
            return z ^ (z >> 31);
        }
    }
}
