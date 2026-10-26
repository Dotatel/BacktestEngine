using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using cAlgo.API;

namespace BacktestEngine.Run
{
    /// <summary>
    /// Emits truthful strategy parameter metadata for a strategy carried by the runner assembly.
    ///
    /// The host bridge and strategy editor need names, types, attributed bounds and reset
    /// defaults straight from reflection on the compiled source, never from source-text
    /// guessing. <see cref="StrategyRegistry"/> stays authoritative for the strategy set and
    /// replay behavior is untouched: this path only runs from the opt-in CLI flag.
    /// </summary>
    internal static class StrategyMetadata
    {
        /// <summary>Marker printed before the single-line JSON payload on stdout.</summary>
        private const string MetadataMarker = "BACKTESTENGINE_STRATEGY_METADATA";

        /// <summary>
        /// Reflects the requested strategy and prints one <see cref="MetadataMarker"/> JSON line.
        /// </summary>
        /// <param name="strategyName">Robot type name as accepted by <see cref="StrategyRegistry"/>.</param>
        /// <returns>Process exit code: 0 on success, 1 when the strategy is unknown.</returns>
        public static int Print(string strategyName)
        {
            StrategyDefinition strategy;
            try
            {
                strategy = StrategyRegistry.Resolve(strategyName);
            }
            catch (ArgumentException error)
            {
                Console.WriteLine(MetadataMarker + " " + ToJson(new { error = error.Message }));
                return 1;
            }

            Robot bot = strategy.Create();
            object payload = new
            {
                strategy = strategy.Name,
                strategyType = bot.GetType().FullName,
                parameters = DescribeParameters(bot),
            };
            Console.WriteLine(MetadataMarker + " " + ToJson(payload));
            return 0;
        }

        /// <summary>
        /// Describes every attributed writable strategy parameter of the bot type.
        /// </summary>
        /// <param name="bot">Constructed strategy instance.</param>
        /// <returns>Ordered parameter metadata entries; un-attributed fields are not listed.</returns>
        private static List<object> DescribeParameters(Robot bot)
        {
            PropertyInfo[] properties = bot.GetType().GetProperties(BindingFlags.Instance | BindingFlags.Public);
            return properties
                .Where(property => property.CanWrite && property.GetIndexParameters().Length == 0)
                .Select(property => new
                {
                    Property = property,
                    Attribute = property.GetCustomAttribute<ParameterAttribute>(),
                })
                .Where(entry => entry.Attribute != null)
                .OrderBy(entry => entry.Property.Name, StringComparer.OrdinalIgnoreCase)
                .Select(entry => DescribeParameter(bot, entry.Property, entry.Attribute))
                .ToList();
        }

        /// <summary>
        /// Describes one attributed parameter, keyed by property name (the "--param" key).
        /// </summary>
        /// <param name="bot">Constructed strategy instance used for construction-level defaults.</param>
        /// <param name="property">Reflected strategy property.</param>
        /// <param name="attribute">Attributed metadata of the property.</param>
        /// <returns>Parameter schema entry with attributed bounds and the truthful reset default.</returns>
        private static object DescribeParameter(Robot bot, PropertyInfo property, ParameterAttribute attribute)
        {
            object attributedDefault = attribute.DefaultValue != null
                ? BotParameterLoader.ConvertObjectValue(attribute.DefaultValue, property.PropertyType)
                : property.GetValue(bot);
            return new
            {
                name = property.Name,
                displayName = string.IsNullOrEmpty(attribute.Name) ? property.Name : attribute.Name,
                group = attribute.Group ?? "",
                valueType = DescribeValueType(property.PropertyType),
                @default = DescribeValue(attributedDefault, property.PropertyType),
                min = DescribeBound(attribute.MinValue, property.PropertyType),
                max = DescribeBound(attribute.MaxValue, property.PropertyType),
                step = DescribeBound(attribute.Step, property.PropertyType),
                options = EnumOptions(property.PropertyType),
            };
        }

        /// <summary>
        /// Converts one attributed bound with the loader's rules and renders it as JSON.
        /// </summary>
        /// <param name="bound">Raw attributed bound value, or null when the strategy supplies none.</param>
        /// <param name="propertyType">Declared property type.</param>
        /// <returns>JSON-writable bound value, or null when absent.</returns>
        private static object DescribeBound(object bound, Type propertyType)
        {
            return bound == null ? null : DescribeValue(BotParameterLoader.ConvertObjectValue(bound, propertyType), propertyType);
        }

        /// <summary>
        /// Maps a parameter property type to the canonical value type the editor consumes.
        /// </summary>
        /// <param name="propertyType">Declared property type.</param>
        /// <returns>One of integer, number, boolean, enum, timeframe, string.</returns>
        private static string DescribeValueType(Type propertyType)
        {
            return propertyType.IsEnum
                ? "enum"
                : IsIntegerType(propertyType) ? "integer"
                : IsNumberType(propertyType) ? "number"
                : propertyType == typeof(bool) ? "boolean"
                : propertyType == typeof(TimeFrame) ? "timeframe"
                : "string";
        }

        /// <summary>
        /// Tests whether a type is an integral CLR numeric type for the editor contract.
        /// </summary>
        /// <param name="propertyType">Declared property type.</param>
        /// <returns>True for signed/unsigned byte, short, int and long (including nullable forms).</returns>
        private static bool IsIntegerType(Type propertyType)
        {
            Type effective = Nullable.GetUnderlyingType(propertyType) ?? propertyType;
            return effective == typeof(byte) || effective == typeof(sbyte) || effective == typeof(short)
                || effective == typeof(ushort) || effective == typeof(int) || effective == typeof(uint)
                || effective == typeof(long) || effective == typeof(ulong);
        }

        /// <summary>
        /// Tests whether a type is a fractional CLR numeric type for the editor contract.
        /// </summary>
        /// <param name="propertyType">Declared property type.</param>
        /// <returns>True for float, double and decimal (including nullable forms).</returns>
        private static bool IsNumberType(Type propertyType)
        {
            Type effective = Nullable.GetUnderlyingType(propertyType) ?? propertyType;
            return effective == typeof(float) || effective == typeof(double) || effective == typeof(decimal);
        }

        /// <summary>
        /// Builds enum option names when the parameter type is an enumeration.
        /// </summary>
        /// <param name="propertyType">Declared property type.</param>
        /// <returns>Ascending enum names, or null for non-enum parameters.</returns>
        private static List<string> EnumOptions(Type propertyType)
        {
            return propertyType.IsEnum ? Enum.GetNames(propertyType).ToList() : null;
        }

        /// <summary>
        /// Renders a parameter value as JSON-native data without culture guessing.
        /// </summary>
        /// <param name="value">Converted metadatum or null when the strategy supplies none.</param>
        /// <param name="propertyType">Declared property type for enum name rendering.</param>
        /// <returns>A JSON-writable scalar, an enum name string, or null.</returns>
        private static object DescribeValue(object value, Type propertyType)
        {
            if (value == null)
                return null;
            if (propertyType.IsEnum || value is Enum)
                return value.ToString();
            if (value is bool || value is int || value is long || value is double || value is float || value is decimal)
                return value;
            return value.ToString();
        }

        /// <summary>
        /// Serializes a payload to compact single-line JSON for stdout parsing.
        /// </summary>
        /// <param name="payload">Anonymous metadata payload.</param>
        /// <returns>Single-line JSON text without trailing whitespace.</returns>
        private static string ToJson(object payload)
        {
            return JsonSerializer.Serialize(payload, new JsonSerializerOptions
            {
                WriteIndented = false,
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            });
        }
    }
}
