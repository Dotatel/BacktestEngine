using System.Reflection;
using cAlgo.API;
using cAlgo.Robots;

namespace BacktestEngine.Tests.TemplateContract
{
    /// <summary>
    /// Deterministic shim-lifecycle contract checks for the four launcher robot templates.
    /// </summary>
    /// <remarks>
    /// The harness binds each robot to a bare shim Robot instance (real Bars, Symbol,
    /// Positions and Server objects) and drives the lifecycle the replay uses: the first
    /// quote opens one quote-only chart bar, then every later bar is opened as a
    /// quote-only forming bar before <c>EngineOnBar</c> runs and completed afterwards.
    /// No economic-symbol profile is applied, so <c>ExecuteMarketOrder</c> fails closed
    /// and every attempted entry surfaces as an "No effective symbol specification"
    /// <see cref="InvalidOperationException"/>. That throw, not a simulated fill, is the
    /// observation oracle: it proves a robot really tried to trade (signal fired) or
    /// really did not (guard held). Suppressed-re-entry checks inject one scaffolding
    /// position through the internal Positions.Add seam; injecting state is harness
    /// tooling and creates no economics, profits or acceptance evidence. These checks
    /// use illustrative constant price series and make no profitability, qualification
    /// or native-parity claim.
    /// </remarks>
    public static class TemplateContractChecks
    {
        /// <summary>Shim message fragment proving an entry attempt reached the order path.</summary>
        private const string OrderAttemptFragment = "No effective symbol specification";

        /// <summary>Chart symbol name shared by every harness robot.</summary>
        private const string SymbolName = "HARNESS";

        /// <summary>Harness pip size; only used for injected-scaffolding positions.</summary>
        private const double PipSize = 0.1;

        /// <summary>Count of passing deterministic assertions.</summary>
        private static int _assertions;

        /// <summary>
        /// Runs every template contract check and reports the assertion count.
        /// </summary>
        /// <returns>Process exit code zero after every check passes.</returns>
        /// <exception cref="InvalidOperationException">Thrown with TEMPLATE_CONTRACT_FAIL on the first failing check.</exception>
        public static int Main()
        {
            CheckTemplatesAreRobotSubclasses();
            CheckParameterValidation();
            CheckBreakoutIgnoresFormingBarGap();
            CheckSignalsFireOnlyOnCompletedBars();
            CheckDuplicatePositionSuppression();
            Console.WriteLine($"TEMPLATE_CONTRACT_OK assertions={_assertions}");
            return 0;
        }

        /// <summary>
        /// Asserts all four templates are public concrete Robot subclasses.
        /// </summary>
        private static void CheckTemplatesAreRobotSubclasses()
        {
            Check(typeof(EmaPullbackStrategy).IsSubclassOf(typeof(Robot)), "EmaPullbackStrategy is a Robot");
            Check(typeof(BreakoutStrategy).IsSubclassOf(typeof(Robot)), "BreakoutStrategy is a Robot");
            Check(typeof(MeanReversionStrategy).IsSubclassOf(typeof(Robot)), "MeanReversionStrategy is a Robot");
            Check(typeof(RsiReversalStrategy).IsSubclassOf(typeof(Robot)), "RsiReversalStrategy is a Robot");
        }

        /// <summary>
        /// Asserts OnStart validates parameters and accepts the harness configuration.
        /// </summary>
        private static void CheckParameterValidation()
        {
            // Every parameter is assigned here: the shim applies [Parameter] defaults
            // in the runner binding step, which this bare-shim harness does not run.
            ExpectStartThrow(CreateConfiguredRobot<EmaPullbackStrategy>(bot => bot.SlowPeriod = 3), "FastPeriod must be below SlowPeriod");
            ExpectStartPass(CreateConfiguredRobot<EmaPullbackStrategy>(bot =>
            {
                bot.FastPeriod = 3;
                bot.SlowPeriod = 5;
                bot.StopLossPips = 20;
                bot.TakeProfitPips = 40;
                bot.VolumeMultiplier = 1;
            }));
            ExpectStartThrow(CreateConfiguredRobot<BreakoutStrategy>(bot => bot.LookbackBars = 1), "LookbackBars must be at least two");
            ExpectStartPass(CreateConfiguredRobot<BreakoutStrategy>(bot =>
            {
                bot.LookbackBars = 3;
                bot.StopLossPips = 20;
                bot.TakeProfitPips = 40;
                bot.VolumeMultiplier = 1;
            }));
            ExpectStartThrow(CreateConfiguredRobot<MeanReversionStrategy>(bot => bot.DeviationMultiplier = 0.0), "DeviationMultiplier must be positive");
            ExpectStartPass(CreateConfiguredRobot<MeanReversionStrategy>(bot =>
            {
                bot.AveragePeriod = 5;
                bot.DeviationMultiplier = 2.0;
                bot.StopLossPips = 20;
                bot.TakeProfitPips = 40;
                bot.VolumeMultiplier = 1;
            }));
            ExpectStartThrow(CreateConfiguredRobot<RsiReversalStrategy>(bot => bot.OverboughtLevel = 30.0), "OversoldLevel must be below OverboughtLevel");
            ExpectStartPass(CreateConfiguredRobot<RsiReversalStrategy>(bot =>
            {
                bot.RsiPeriod = 3;
                bot.OversoldLevel = 30.0;
                bot.OverboughtLevel = 70.0;
                bot.StopLossPips = 20;
                bot.TakeProfitPips = 40;
                bot.VolumeMultiplier = 1;
            }));
        }

        /// <summary>
        /// Asserts a gap that opens above the completed range never trades when the
        /// completed close stayed inside the range; the forming quote must be ignored.
        /// </summary>
        private static void CheckBreakoutIgnoresFormingBarGap()
        {
            Robot robot = CreateConfiguredRobot<BreakoutStrategy>(bot =>
            {
                bot.LookbackBars = 3;
                bot.StopLossPips = 20;
                bot.TakeProfitPips = 40;
                bot.VolumeMultiplier = 1;
            });
            SeedOpeningQuoteBar(robot, 100);
            robot.EngineOnStart();
            for (int bar = 1; bar <= 5; bar++)
            {
                OpenNextBarQuietly(robot, bar, 100);
                CompleteFormingBar(robot, 100);
            }
            // Bar six opens ten units above the completed range while the completed
            // closes stay inside it; the completed close, not the opening gap, decides.
            robot.Server.Time = BarOpen(6);
            robot.Bars.Add(BarOpen(6), 110, 110, 110, 110);
            Quote(robot, 110);
            try
            {
                robot.EngineOnBar();
            }
            catch (Exception error)
            {
                Fail($"BreakoutStrategy traded on the forming-bar gap instead of the completed close: {error.Message}");
            }
            Check(robot.Positions.FindAll("BREAKOUT", SymbolName).Length == 0, "gap produced no position attempt");
            Check(robot.Bars.Count == 7 && robot.Bars.ClosePrices[6] == 110, "gap quote remains visible in the forming bar");
        }

        /// <summary>
        /// Asserts each robot stays quiet through its completed-bar warmup and then
        /// attempts exactly one entry when the deterministic signal close completes.
        /// </summary>
        private static void CheckSignalsFireOnlyOnCompletedBars()
        {
            DriveBars(
                CreateConfiguredRobot<BreakoutStrategy>(bot =>
                {
                    bot.LookbackBars = 3;
                    bot.StopLossPips = 20;
                    bot.TakeProfitPips = 40;
                    bot.VolumeMultiplier = 1;
                }),
                new double[] { 100, 100, 100, 100, 104 }, 5, false);
            DriveBars(
                CreateConfiguredRobot<EmaPullbackStrategy>(bot =>
                {
                    bot.FastPeriod = 3;
                    bot.SlowPeriod = 5;
                    bot.StopLossPips = 20;
                    bot.TakeProfitPips = 40;
                    bot.VolumeMultiplier = 1;
                }),
                new[] { 100.0, 101, 102, 103, 104, 100, 104 }, 7, false);
            DriveBars(
                CreateConfiguredRobot<MeanReversionStrategy>(bot =>
                {
                    bot.AveragePeriod = 5;
                    bot.DeviationMultiplier = 2.0;
                    bot.StopLossPips = 20;
                    bot.TakeProfitPips = 40;
                    bot.VolumeMultiplier = 1;
                }),
                new double[] { 100, 100, 100, 100, 100, 90 }, 6, false);
            DriveBars(
                CreateConfiguredRobot<RsiReversalStrategy>(bot =>
                {
                    bot.RsiPeriod = 3;
                    bot.OversoldLevel = 30.0;
                    bot.OverboughtLevel = 70.0;
                    bot.StopLossPips = 20;
                    bot.TakeProfitPips = 40;
                    bot.VolumeMultiplier = 1;
                }),
                new double[] { 100, 95, 90, 85, 80, 81, 96 }, 7, false);
        }

        /// <summary>
        /// Asserts the identical signal sequences never attempt a second entry once one
        /// labelled position is open, for all four robots.
        /// </summary>
        private static void CheckDuplicatePositionSuppression()
        {
            DriveBars(
                CreateConfiguredRobot<BreakoutStrategy>(bot =>
                {
                    bot.LookbackBars = 3;
                    bot.StopLossPips = 20;
                    bot.TakeProfitPips = 40;
                    bot.VolumeMultiplier = 1;
                }),
                new double[] { 100, 100, 100, 100, 104 }, 5, true);
            DriveBars(
                CreateConfiguredRobot<EmaPullbackStrategy>(bot =>
                {
                    bot.FastPeriod = 3;
                    bot.SlowPeriod = 5;
                    bot.StopLossPips = 20;
                    bot.TakeProfitPips = 40;
                    bot.VolumeMultiplier = 1;
                }),
                new[] { 100.0, 101, 102, 103, 104, 100, 104 }, 7, true);
            DriveBars(
                CreateConfiguredRobot<MeanReversionStrategy>(bot =>
                {
                    bot.AveragePeriod = 5;
                    bot.DeviationMultiplier = 2.0;
                    bot.StopLossPips = 20;
                    bot.TakeProfitPips = 40;
                    bot.VolumeMultiplier = 1;
                }),
                new double[] { 100, 100, 100, 100, 100, 90 }, 6, true);
            DriveBars(
                CreateConfiguredRobot<RsiReversalStrategy>(bot =>
                {
                    bot.RsiPeriod = 3;
                    bot.OversoldLevel = 30.0;
                    bot.OverboughtLevel = 70.0;
                    bot.StopLossPips = 20;
                    bot.TakeProfitPips = 40;
                    bot.VolumeMultiplier = 1;
                }),
                new double[] { 100, 95, 90, 85, 80, 81, 96 }, 7, true);
        }

        /// <summary>
        /// Drives one robot through its deterministic price series up to the signal bar.
        /// </summary>
        /// <remarks>
        /// Bars 1..<c>firstSignalBar</c>-1 complete quietly (this is the warmup and
        /// closed-bar contract). On bar <c>firstSignalBar</c> the completed signal close
        /// exists at index <c>Bars.Count - 2</c>, so without an open position the robot
        /// must attempt its entry and the shim's fail-closed order path must throw; with
        /// one injected open position it must stay quiet and keep exactly one position.
        /// </remarks>
        /// <param name="robot">Configured harness robot.</param>
        /// <param name="closes">Completed close series including the signal close.</param>
        /// <param name="firstSignalBar">Bar whose OnBar first sees the signal close.</param>
        /// <param name="suppressWithPosition">Whether one open position is injected first.</param>
        private static void DriveBars(Robot robot, double[] closes, int firstSignalBar, bool suppressWithPosition)
        {
            SeedOpeningQuoteBar(robot, closes[0]);
            robot.EngineOnStart();
            if (suppressWithPosition)
                InjectOpenPosition(robot);
            for (int bar = 1; bar <= firstSignalBar; bar++)
            {
                if (bar < firstSignalBar || suppressWithPosition)
                    OpenNextBarQuietly(robot, bar, closes[bar - 1]);
                else
                    OpenBarExpectingOrderAttempt(robot, bar, closes[bar - 1]);
                if (bar < firstSignalBar)
                    CompleteFormingBar(robot, closes[bar]);
            }
            if (suppressWithPosition)
                Check(robot.Positions.FindAll(FindLabel(robot), SymbolName).Length == 1,
                    $"{robot.GetType().Name} kept exactly the injected position");
        }

        /// <summary>
        /// Creates a bare-shim robot bound to fresh harness collections.
        /// </summary>
        /// <typeparam name="TRobot">Concrete template robot type.</typeparam>
        /// <param name="configure">Parameter configuration applied before any lifecycle callback.</param>
        /// <returns>The configured robot.</returns>
        private static TRobot CreateConfiguredRobot<TRobot>(Action<TRobot> configure) where TRobot : Robot, new()
        {
            TRobot robot = new TRobot();
            robot.Symbol = new Symbol
            {
                Name = SymbolName,
                PipSize = PipSize,
                Digits = 2,
                VolumeInUnitsMin = 1.0,
            };
            robot.SymbolName = SymbolName;
            configure(robot);
            return robot;
        }

        /// <summary>
        /// Calls EngineOnStart expecting the parameter validation exception.
        /// </summary>
        /// <param name="robot">Robot configured with invalid parameters.</param>
        /// <param name="description">Human-readable expectation for diagnostics.</param>
        private static void ExpectStartThrow(Robot robot, string description)
        {
            try
            {
                robot.EngineOnStart();
            }
            catch (ArgumentException)
            {
                _assertions++;
                return;
            }
            Fail($"expected OnStart to reject invalid parameters ({description})");
        }

        /// <summary>
        /// Calls EngineOnStart expecting the configuration to be accepted.
        /// </summary>
        /// <param name="robot">Robot configured with valid parameters.</param>
        private static void ExpectStartPass(Robot robot)
        {
            robot.EngineOnStart();
            _assertions++;
        }

        /// <summary>
        /// Reproduces the replay start: the first quote opens one quote-only bar.
        /// </summary>
        /// <param name="robot">Harness robot.</param>
        /// <param name="quote">First observed quote price.</param>
        private static void SeedOpeningQuoteBar(Robot robot, double quote)
        {
            robot.Server.Time = BarOpen(0);
            robot.Bars.Add(BarOpen(0), quote, quote, quote, quote);
            Quote(robot, quote);
        }

        /// <summary>
        /// Opens one quote-only forming bar and fires OnBar, expecting no entry attempt.
        /// </summary>
        /// <param name="robot">Harness robot.</param>
        /// <param name="index">Zero-based bar index of the new bar.</param>
        /// <param name="open">Opening quote of the new bar.</param>
        private static void OpenNextBarQuietly(Robot robot, int index, double open)
        {
            AddFormingBar(robot, index, open);
            try
            {
                robot.EngineOnBar();
            }
            catch (Exception error)
            {
                Fail($"{robot.GetType().Name} attempted an entry during warmup OnBar {index} without an open position: {error.Message}");
            }
            _assertions++;
        }

        /// <summary>
        /// Opens one quote-only forming bar and fires OnBar, expecting the entry attempt
        /// the shim's fail-closed economic path produces.
        /// </summary>
        /// <param name="robot">Harness robot.</param>
        /// <param name="index">Zero-based bar index of the new bar.</param>
        /// <param name="open">Opening quote of the new bar.</param>
        private static void OpenBarExpectingOrderAttempt(Robot robot, int index, double open)
        {
            AddFormingBar(robot, index, open);
            try
            {
                robot.EngineOnBar();
            }
            catch (Exception error) when (error.Message.Contains(OrderAttemptFragment))
            {
                _assertions++;
                return;
            }
            Fail($"{robot.GetType().Name} did not attempt an entry on its deterministic signal bar {index}");
        }

        /// <summary>
        /// Adds one quote-only forming bar exactly as the replay bar builder does.
        /// </summary>
        /// <param name="robot">Harness robot.</param>
        /// <param name="index">Zero-based bar index of the new bar.</param>
        /// <param name="open">Opening quote.</param>
        private static void AddFormingBar(Robot robot, int index, double open)
        {
            robot.Server.Time = BarOpen(index);
            robot.Bars.Add(BarOpen(index), open, open, open, open);
            Quote(robot, open);
        }

        /// <summary>
        /// Completes the forming bar with its final close before the next bar opens.
        /// </summary>
        /// <param name="robot">Harness robot.</param>
        /// <param name="close">Final close of the forming bar.</param>
        private static void CompleteFormingBar(Robot robot, double close)
        {
            int index = robot.Bars.Count - 1;
            robot.Bars.HighPrices[index] = Math.Max(robot.Bars.HighPrices[index], close);
            robot.Bars.LowPrices[index] = Math.Min(robot.Bars.LowPrices[index], close);
            robot.Bars.ClosePrices[index] = close;
            Quote(robot, close);
        }

        /// <summary>
        /// Injects one scaffolding open position through the internal add seam.
        /// </summary>
        /// <param name="robot">Harness robot that must now treat the position as its own.</param>
        private static void InjectOpenPosition(Robot robot)
        {
            Position position = new Position
            {
                Id = 1,
                SymbolName = SymbolName,
                Label = FindLabel(robot),
                TradeType = TradeType.Buy,
                VolumeInUnits = 1.0,
                EntryPrice = 100.0,
                EntryTime = BarOpen(0),
                PipSizeAtEntry = PipSize,
            };
            MethodInfo add = typeof(Positions).GetMethod("Add", BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("The shim no longer exposes the internal Positions.Add seam.");
            add.Invoke(robot.Positions, new object[] { position });
            _assertions++;
        }

        /// <summary>
        /// Maps a harness robot to the fixed label its template trades under.
        /// </summary>
        /// <param name="robot">Harness robot.</param>
        /// <returns>The template's order label.</returns>
        /// <exception cref="InvalidOperationException">Thrown for an unknown robot type.</exception>
        private static string FindLabel(Robot robot)
        {
            if (robot is EmaPullbackStrategy)
                return "EMA-PULLBACK";
            if (robot is BreakoutStrategy)
                return "BREAKOUT";
            if (robot is MeanReversionStrategy)
                return "MEAN-REVERSION";
            if (robot is RsiReversalStrategy)
                return "RSI-REVERSAL";
            throw new InvalidOperationException($"Unknown harness robot type {robot.GetType().Name}.");
        }

        /// <summary>
        /// Applies one bid/ask quote pair at the given spread to the harness symbol.
        /// </summary>
        /// <param name="robot">Harness robot.</param>
        /// <param name="bid">Observed bid quote.</param>
        private static void Quote(Robot robot, double bid)
        {
            robot.Symbol.Bid = bid;
            robot.Symbol.Ask = bid + PipSize;
        }

        /// <summary>
        /// Builds one UTC timestamp at a fixed one-minute bar spacing.
        /// </summary>
        /// <param name="index">Zero-based bar index.</param>
        /// <returns>The bar's open time.</returns>
        private static DateTime BarOpen(int index)
        {
            return new DateTime(2026, 1, 1, 0, index, 0, DateTimeKind.Utc);
        }

        /// <summary>
        /// Records one passing deterministic assertion.
        /// </summary>
        /// <param name="condition">Observed condition.</param>
        /// <param name="description">What the assertion proves.</param>
        private static void Check(bool condition, string description)
        {
            if (!condition)
                Fail(description);
            _assertions++;
        }

        /// <summary>
        /// Aborts the run with a TEMPLATE_CONTRACT_FAIL diagnostic.
        /// </summary>
        /// <param name="message">Failure explanation.</param>
        /// <exception cref="InvalidOperationException">Always thrown.</exception>
        private static void Fail(string message)
        {
            throw new InvalidOperationException($"TEMPLATE_CONTRACT_FAIL ({_assertions} assertions passed): {message}");
        }
    }
}
