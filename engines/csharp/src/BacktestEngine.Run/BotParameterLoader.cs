using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using cAlgo.API;

namespace BacktestEngine.Run
{
    internal sealed class BotParameterLoadResult
    {
        public string SourcePath { get; set; } = "";
        public string ChartSymbol { get; set; } = "";
        public TimeFrame ChartTimeFrame { get; set; }
        public int DefaultCount { get; set; }
        public int OverrideCount { get; set; }
        public IReadOnlyList<string> UnknownParameters { get; set; } = Array.Empty<string>();
    }

    internal static class BotParameterLoader
    {
        public static BotParameterLoadResult Apply(object bot, string cbotsetPath)
        {
            if (bot == null)
                throw new ArgumentNullException(nameof(bot));
            if (string.IsNullOrWhiteSpace(cbotsetPath))
                throw new ArgumentException("Parameter file path is required.", nameof(cbotsetPath));
            if (!File.Exists(cbotsetPath))
                throw new FileNotFoundException("Parameter file was not found.", cbotsetPath);

            string json = File.ReadAllText(cbotsetPath);
            using JsonDocument document = JsonDocument.Parse(json, new JsonDocumentOptions
            {
                AllowTrailingCommas = true,
                CommentHandling = JsonCommentHandling.Skip
            });

            Type botType = bot.GetType();
            List<PropertyInfo> writableProperties = botType
                .GetProperties(BindingFlags.Instance | BindingFlags.Public)
                .Where(property => property.CanWrite && property.GetIndexParameters().Length == 0)
                .ToList();

            int defaultCount = ApplyParameterAttributeDefaults(bot, writableProperties);
            Dictionary<string, PropertyInfo> propertiesByName = BuildPropertyLookup(writableProperties);

            int overrideCount = 0;
            List<string> unknownParameters = new List<string>();

            if (document.RootElement.TryGetProperty("Parameters", out JsonElement parameters)
                && parameters.ValueKind == JsonValueKind.Object)
            {
                foreach (JsonProperty parameter in parameters.EnumerateObject())
                {
                    if (!propertiesByName.TryGetValue(parameter.Name, out PropertyInfo property))
                    {
                        unknownParameters.Add(parameter.Name);
                        continue;
                    }

                    try
                    {
                        object value = ConvertJsonValue(parameter.Value, property.PropertyType);
                        property.SetValue(bot, value);
                        overrideCount++;
                    }
                    catch (Exception ex)
                    {
                        throw new InvalidOperationException(
                            $"Failed to load parameter '{parameter.Name}' into property '{property.Name}' of type '{property.PropertyType.FullName}'. Json kind='{parameter.Value.ValueKind}' raw={parameter.Value.GetRawText()}",
                            ex);
                    }
                }
            }

            string chartSymbol = "";
            TimeFrame chartTimeFrame = null;
            if (document.RootElement.TryGetProperty("Chart", out JsonElement chart)
                && chart.ValueKind == JsonValueKind.Object)
            {
                if (chart.TryGetProperty("Symbol", out JsonElement symbolElement))
                    chartSymbol = symbolElement.GetString() ?? "";
                if (chart.TryGetProperty("Period", out JsonElement periodElement))
                    chartTimeFrame = ParseTimeFrame(periodElement.GetString() ?? "");
            }

            return new BotParameterLoadResult
            {
                SourcePath = Path.GetFullPath(cbotsetPath),
                ChartSymbol = chartSymbol,
                ChartTimeFrame = chartTimeFrame,
                DefaultCount = defaultCount,
                OverrideCount = overrideCount,
                UnknownParameters = unknownParameters
            };
        }

        public static BotParameterLoadResult ApplyOverrides(object bot, BotParameterLoadResult existing, IReadOnlyDictionary<string, string> overrides)
        {
            if (bot == null)
                throw new ArgumentNullException(nameof(bot));
            if (overrides == null || overrides.Count == 0)
                return existing ?? new BotParameterLoadResult();

            Type botType = bot.GetType();
            List<PropertyInfo> writableProperties = botType
                .GetProperties(BindingFlags.Instance | BindingFlags.Public)
                .Where(property => property.CanWrite && property.GetIndexParameters().Length == 0)
                .ToList();
            Dictionary<string, PropertyInfo> propertiesByName = BuildPropertyLookup(writableProperties);

            List<string> unknownParameters = new List<string>(existing?.UnknownParameters ?? Array.Empty<string>());
            int applied = 0;
            foreach (KeyValuePair<string, string> entry in overrides)
            {
                if (!propertiesByName.TryGetValue(entry.Key, out PropertyInfo property))
                {
                    unknownParameters.Add(entry.Key);
                    continue;
                }

                object value = ConvertStringValue(entry.Value, property.PropertyType);
                property.SetValue(bot, value);
                applied++;
            }

            return new BotParameterLoadResult
            {
                SourcePath = existing?.SourcePath ?? "",
                ChartSymbol = existing?.ChartSymbol ?? "",
                ChartTimeFrame = existing?.ChartTimeFrame,
                DefaultCount = existing?.DefaultCount ?? 0,
                OverrideCount = (existing?.OverrideCount ?? 0) + applied,
                UnknownParameters = unknownParameters
            };
        }

        private static int ApplyParameterAttributeDefaults(object bot, IEnumerable<PropertyInfo> writableProperties)
        {
            int defaultCount = 0;

            foreach (PropertyInfo property in writableProperties)
            {
                ParameterAttribute attribute = property.GetCustomAttribute<ParameterAttribute>();
                if (attribute == null || attribute.DefaultValue == null)
                    continue;

                object converted = ConvertObjectValue(attribute.DefaultValue, property.PropertyType);
                property.SetValue(bot, converted);
                defaultCount++;
            }

            return defaultCount;
        }

        private static Dictionary<string, PropertyInfo> BuildPropertyLookup(IEnumerable<PropertyInfo> writableProperties)
        {
            Dictionary<string, PropertyInfo> lookup = new Dictionary<string, PropertyInfo>(StringComparer.OrdinalIgnoreCase);

            foreach (PropertyInfo property in writableProperties)
            {
                ParameterAttribute attribute = property.GetCustomAttribute<ParameterAttribute>();
                // A cBot preset can set declared strategy parameters, not the
                // writable execution/environment properties inherited from Robot.
                if (attribute == null)
                    continue;
                lookup[property.Name] = property;
                if (!string.IsNullOrWhiteSpace(attribute.Name))
                    lookup[attribute.Name] = property;
            }

            return lookup;
        }

        private static object ConvertJsonValue(JsonElement element, Type targetType)
        {
            Type nonNullableType = Nullable.GetUnderlyingType(targetType) ?? targetType;

            if (element.ValueKind == JsonValueKind.Null)
            {
                if (Nullable.GetUnderlyingType(targetType) != null || !targetType.IsValueType)
                    return null;
                throw new InvalidOperationException("Cannot assign null to " + targetType.Name + ".");
            }

            if (nonNullableType == typeof(string))
                return element.ValueKind == JsonValueKind.String ? element.GetString() : element.ToString();

            if (nonNullableType == typeof(bool))
            {
                if (element.ValueKind == JsonValueKind.True || element.ValueKind == JsonValueKind.False)
                    return element.GetBoolean();
                return bool.Parse(element.GetString() ?? "");
            }

            if (nonNullableType.IsEnum)
            {
                if (element.ValueKind == JsonValueKind.String)
                {
                    string enumText = element.GetString() ?? "";
                    if (int.TryParse(enumText, NumberStyles.Integer, CultureInfo.InvariantCulture, out int enumInt))
                        return Enum.ToObject(nonNullableType, enumInt);
                    return Enum.Parse(nonNullableType, enumText, ignoreCase: true);
                }

                int enumValue = element.GetInt32();
                return Enum.ToObject(nonNullableType, enumValue);
            }

            if (nonNullableType == typeof(int))
                return element.ValueKind == JsonValueKind.String
                    ? int.Parse(element.GetString() ?? "", NumberStyles.Integer, CultureInfo.InvariantCulture)
                    : element.GetInt32();
            if (nonNullableType == typeof(long))
                return element.ValueKind == JsonValueKind.String
                    ? long.Parse(element.GetString() ?? "", NumberStyles.Integer, CultureInfo.InvariantCulture)
                    : element.GetInt64();
            if (nonNullableType == typeof(double))
                return element.ValueKind == JsonValueKind.String
                    ? double.Parse(element.GetString() ?? "", NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture)
                    : element.GetDouble();
            if (nonNullableType == typeof(decimal))
                return element.ValueKind == JsonValueKind.String
                    ? decimal.Parse(element.GetString() ?? "", NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture)
                    : element.GetDecimal();

            return JsonSerializer.Deserialize(element.GetRawText(), nonNullableType);
        }

        internal static object ConvertObjectValue(object value, Type targetType)
        {
            Type nonNullableType = Nullable.GetUnderlyingType(targetType) ?? targetType;

            if (value == null)
                return null;

            if (nonNullableType.IsInstanceOfType(value))
                return value;

            if (nonNullableType.IsEnum)
            {
                if (value is string text)
                    return Enum.Parse(nonNullableType, text, ignoreCase: true);

                Type underlyingType = Enum.GetUnderlyingType(nonNullableType);
                object numericValue = Convert.ChangeType(value, underlyingType, CultureInfo.InvariantCulture);
                return Enum.ToObject(nonNullableType, numericValue);
            }

            return Convert.ChangeType(value, nonNullableType, CultureInfo.InvariantCulture);
        }

        private static object ConvertStringValue(string value, Type targetType)
        {
            Type nonNullableType = Nullable.GetUnderlyingType(targetType) ?? targetType;
            if (nonNullableType == typeof(string))
                return value;
            if (nonNullableType == typeof(bool))
                return bool.Parse(value);
            if (nonNullableType.IsEnum)
                return Enum.Parse(nonNullableType, value, ignoreCase: true);
            return Convert.ChangeType(value, nonNullableType, CultureInfo.InvariantCulture);
        }

        public static TimeFrame ParseTimeFrame(string value)
        {
            string normalized = (value ?? "").Trim();
            if (normalized.Length == 0)
                return null;

            switch (normalized.ToLowerInvariant())
            {
                case "m1":
                case "minute":
                case "minute1":
                    return TimeFrame.Minute;
                case "m5":
                case "minute5":
                    return TimeFrame.Minute5;
                case "m15":
                case "minute15":
                    return TimeFrame.Minute15;
                case "m30":
                case "minute30":
                    return TimeFrame.Minute30;
                case "h1":
                case "hour":
                case "hour1":
                    return TimeFrame.Hour;
                case "h4":
                case "hour4":
                    return TimeFrame.Hour4;
                case "d1":
                case "daily":
                case "day":
                    return TimeFrame.Daily;
                case "w1":
                case "weekly":
                case "week":
                    return TimeFrame.Weekly;
                case "mn1":
                case "monthly":
                case "month":
                    return TimeFrame.Monthly;
                default:
                    throw new InvalidOperationException("Unsupported cTrader period '" + value + "'.");
            }
        }
    }
}
