using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using cAlgo.API;

namespace BacktestEngine.Run
{
    internal sealed class StrategyDefinition
    {
        public StrategyDefinition(Type robotType, string defaultSymbol)
        {
            RobotType = robotType ?? throw new ArgumentNullException(nameof(robotType));
            Name = robotType.Name;
            DefaultSymbol = defaultSymbol;
        }

        public Type RobotType { get; }
        public string Name { get; }
        public string DefaultSymbol { get; }

        public Robot Create()
        {
            return (Robot)Activator.CreateInstance(RobotType);
        }
    }

    internal static class StrategyRegistry
    {
        private static readonly Lazy<IReadOnlyList<StrategyDefinition>> Strategies =
            new Lazy<IReadOnlyList<StrategyDefinition>>(DiscoverStrategies);

        public static StrategyDefinition Resolve(string name)
        {
            string requested = string.IsNullOrWhiteSpace(name)
                ? (Strategies.Value.Count == 1 ? Strategies.Value[0].Name : "ExampleStrategy")
                : name.Trim();
            StrategyDefinition strategy = Strategies.Value.FirstOrDefault(
                item => string.Equals(item.Name, requested, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(item.RobotType.FullName, requested, StringComparison.OrdinalIgnoreCase));
            if (strategy != null)
                return strategy;

            string available = string.Join(", ", Strategies.Value.Select(item => item.Name));
            throw new ArgumentException("Unknown strategy '" + requested + "'. Available strategies: " + available + ".");
        }

        private static IReadOnlyList<StrategyDefinition> DiscoverStrategies()
        {
            return Assembly.GetExecutingAssembly()
                .GetTypes()
                .Where(type => !type.IsAbstract && typeof(Robot).IsAssignableFrom(type))
                .OrderBy(type => type.Name, StringComparer.OrdinalIgnoreCase)
                .Select(type => new StrategyDefinition(type, "XAUUSD"))
                .ToArray();
        }
    }
}
