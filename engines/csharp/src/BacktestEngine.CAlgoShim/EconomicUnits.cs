using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace cAlgo.API
{
    public enum EconomicAssetFamily
    {
        Fx,
        Metal,
        Index,
        Equity,
        Crypto
    }

    public enum EconomicCommissionModel
    {
        UsdPerMillionUsdVolume
    }

    public enum EconomicCommissionSideSemantics
    {
        PerFill
    }

    public enum EconomicSwapCalculationType
    {
        Pips,
        Percentage
    }

    public enum EconomicConversionModel
    {
        Identity,
        Fixed
    }

    public enum SwapTimeAuthorityStatus
    {
        Authenticated,
        Assumed,
        Unknown
    }

    /// <summary>
    /// Immutable, versioned economic contract used by every BacktestEngine
    /// accounting path. Values are loaded once, validated against the original
    /// broker capture, hashed canonically, and then applied to the mutable cAlgo
    /// compatibility surface exposed to strategy code.
    /// </summary>
    public sealed class EffectiveSymbolSpecification
    {
        internal EffectiveSymbolSpecification(
            string schemaVersion,
            string specificationSource,
            string specificationSourceKind,
            string specificationSourceSha256,
            string specificationPath,
            string resolvedSourcePath,
            string symbol,
            EconomicAssetFamily assetFamily,
            string baseCurrency,
            string quoteCurrency,
            string accountCurrency,
            int accountCurrencyDigits,
            int digits,
            double pipSize,
            double tickSize,
            double pipValue,
            string pipValueCurrency,
            double tickValue,
            string tickValueCurrency,
            double lotSize,
            double contractMultiplier,
            double volumeInUnitsMin,
            double volumeInUnitsMax,
            double volumeInUnitsStep,
            string volumeUnits,
            EconomicCommissionModel commissionModel,
            double commissionRate,
            string commissionRateCurrency,
            EconomicCommissionSideSemantics commissionSideSemantics,
            double minimumCommission,
            string minimumCommissionCurrency,
            CommissionRoundingMode commissionRoundingMode,
            EconomicConversionModel quoteToAccountConversionModel,
            double quoteToAccountConversionRate,
            string usdNotionalConversionRule,
            double pnlConversionFeeRate,
            EconomicSwapCalculationType swapCalculationType,
            double swapLong,
            double swapShort,
            SwapTimeAuthorityStatus swapTimeAuthorityStatus,
            string swapTimeAuthorityKind,
            string swapTimeAuthoritySha256,
            string swapTimeAuthorityPath,
            string resolvedSwapTimeAuthorityPath,
            TimeSpan? swapTimeUtc,
            int swapPeriodHours,
            int swapGracePeriods,
            bool swapWeekendCharging,
            DayOfWeek swap3DaysRollover,
            int percentageSwapDayCount,
            double commissionBaseToUsdRate = 0.0,
            DateTime? nativeCommissionEndUtc = null)
        {
            SchemaVersion = schemaVersion;
            SpecificationSource = specificationSource;
            SpecificationSourceKind = specificationSourceKind;
            SpecificationSourceSha256 = specificationSourceSha256;
            SpecificationPath = specificationPath;
            ResolvedSourcePath = resolvedSourcePath;
            Symbol = symbol;
            AssetFamily = assetFamily;
            BaseCurrency = baseCurrency;
            QuoteCurrency = quoteCurrency;
            AccountCurrency = accountCurrency;
            AccountCurrencyDigits = accountCurrencyDigits;
            Digits = digits;
            PipSize = pipSize;
            TickSize = tickSize;
            PipValue = pipValue;
            PipValueCurrency = pipValueCurrency;
            TickValue = tickValue;
            TickValueCurrency = tickValueCurrency;
            LotSize = lotSize;
            ContractMultiplier = contractMultiplier;
            VolumeInUnitsMin = volumeInUnitsMin;
            VolumeInUnitsMax = volumeInUnitsMax;
            VolumeInUnitsStep = volumeInUnitsStep;
            VolumeUnits = volumeUnits;
            CommissionModel = commissionModel;
            CommissionRate = commissionRate;
            CommissionRateCurrency = commissionRateCurrency;
            CommissionSideSemantics = commissionSideSemantics;
            MinimumCommission = minimumCommission;
            MinimumCommissionCurrency = minimumCommissionCurrency;
            CommissionRoundingMode = commissionRoundingMode;
            QuoteToAccountConversionModel = quoteToAccountConversionModel;
            QuoteToAccountConversionRate = quoteToAccountConversionRate;
            UsdNotionalConversionRule = usdNotionalConversionRule;
            PnLConversionFeeRate = pnlConversionFeeRate;
            SwapCalculationType = swapCalculationType;
            SwapLong = swapLong;
            SwapShort = swapShort;
            SwapTimeAuthorityStatus = swapTimeAuthorityStatus;
            SwapTimeAuthorityKind = swapTimeAuthorityKind;
            SwapTimeAuthoritySha256 = swapTimeAuthoritySha256;
            SwapTimeAuthorityPath = swapTimeAuthorityPath;
            ResolvedSwapTimeAuthorityPath = resolvedSwapTimeAuthorityPath;
            SwapTimeUtc = swapTimeUtc;
            SwapPeriodHours = swapPeriodHours;
            SwapGracePeriods = swapGracePeriods;
            SwapWeekendCharging = swapWeekendCharging;
            Swap3DaysRollover = swap3DaysRollover;
            PercentageSwapDayCount = percentageSwapDayCount;
            CommissionBaseToUsdRate = commissionBaseToUsdRate;
            NativeCommissionEndUtc = nativeCommissionEndUtc;
            CanonicalPayloadJson = ComputeCanonicalPayloadJson();
            CanonicalSpecSha256 = ComputeCanonicalSha256(CanonicalPayloadJson);
        }

        public string SchemaVersion { get; }
        public string CanonicalSpecSha256 { get; }
        public string CanonicalPayloadJson { get; }
        public string SpecificationSource { get; }
        public string SpecificationSourceKind { get; }
        public string SpecificationSourceSha256 { get; }
        public string SpecificationPath { get; }
        public string ResolvedSourcePath { get; }
        public string Symbol { get; }
        public EconomicAssetFamily AssetFamily { get; }
        public string BaseCurrency { get; }
        public string QuoteCurrency { get; }
        public string AccountCurrency { get; }
        public int AccountCurrencyDigits { get; }
        public int Digits { get; }
        public double PipSize { get; }
        public double TickSize { get; }
        public double PipValue { get; }
        public string PipValueCurrency { get; }
        public double TickValue { get; }
        public string TickValueCurrency { get; }
        public double LotSize { get; }
        public double ContractMultiplier { get; }
        public double VolumeInUnitsMin { get; }
        public double VolumeInUnitsMax { get; }
        public double VolumeInUnitsStep { get; }
        public string VolumeUnits { get; }
        public EconomicCommissionModel CommissionModel { get; }
        public double CommissionRate { get; }
        public string CommissionRateCurrency { get; }
        public EconomicCommissionSideSemantics CommissionSideSemantics { get; }
        public double MinimumCommission { get; }
        public string MinimumCommissionCurrency { get; }
        public CommissionRoundingMode CommissionRoundingMode { get; }
        public EconomicConversionModel QuoteToAccountConversionModel { get; }
        public double QuoteToAccountConversionRate { get; }
        public string UsdNotionalConversionRule { get; }
        public double CommissionBaseToUsdRate { get; }
        public DateTime? NativeCommissionEndUtc { get; }
        public double PnLConversionFeeRate { get; }
        public EconomicSwapCalculationType SwapCalculationType { get; }
        public double SwapLong { get; }
        public double SwapShort { get; }
        public SwapTimeAuthorityStatus SwapTimeAuthorityStatus { get; }
        public string SwapTimeAuthorityKind { get; }
        public string SwapTimeAuthoritySha256 { get; }
        public string SwapTimeAuthorityPath { get; }
        public string ResolvedSwapTimeAuthorityPath { get; }
        public TimeSpan? SwapTimeUtc { get; }
        public int SwapPeriodHours { get; }
        public int SwapGracePeriods { get; }
        public bool SwapWeekendCharging { get; }
        public DayOfWeek Swap3DaysRollover { get; }
        public int PercentageSwapDayCount { get; }

        public EffectiveSymbolSpecification WithCommissionRateOverride(double rate, string sourceSuffix)
        {
            if (!IsFinite(rate) || rate < 0.0)
                throw new ArgumentOutOfRangeException(nameof(rate), "Commission override must be finite and non-negative.");
            if (NativeCommissionEndUtc.HasValue && rate != CommissionRate)
                throw new InvalidOperationException("Native commission calibration is bound to its captured commission rate; capture a new authority before changing the rate.");
            return new EffectiveSymbolSpecification(
                SchemaVersion,
                SpecificationSource + ";" + (sourceSuffix ?? "commission_override"),
                SpecificationSourceKind,
                SpecificationSourceSha256,
                SpecificationPath,
                ResolvedSourcePath,
                Symbol,
                AssetFamily,
                BaseCurrency,
                QuoteCurrency,
                AccountCurrency,
                AccountCurrencyDigits,
                Digits,
                PipSize,
                TickSize,
                PipValue,
                PipValueCurrency,
                TickValue,
                TickValueCurrency,
                LotSize,
                ContractMultiplier,
                VolumeInUnitsMin,
                VolumeInUnitsMax,
                VolumeInUnitsStep,
                VolumeUnits,
                CommissionModel,
                rate,
                CommissionRateCurrency,
                CommissionSideSemantics,
                MinimumCommission,
                MinimumCommissionCurrency,
                CommissionRoundingMode,
                QuoteToAccountConversionModel,
                QuoteToAccountConversionRate,
                UsdNotionalConversionRule,
                PnLConversionFeeRate,
                SwapCalculationType,
                SwapLong,
                SwapShort,
                SwapTimeAuthorityStatus,
                SwapTimeAuthorityKind,
                SwapTimeAuthoritySha256,
                SwapTimeAuthorityPath,
                ResolvedSwapTimeAuthorityPath,
                SwapTimeUtc,
                SwapPeriodHours,
                SwapGracePeriods,
                SwapWeekendCharging,
                Swap3DaysRollover,
                PercentageSwapDayCount,
                CommissionBaseToUsdRate,
                NativeCommissionEndUtc);
        }

        public EffectiveSymbolSpecification WithCommissionTermsForDeterministicFixture(
            double rate,
            double minimumCommission,
            string sourceSuffix)
        {
            if (!IsFinite(rate) || rate < 0.0 || !IsFinite(minimumCommission) || minimumCommission < 0.0)
                throw new ArgumentOutOfRangeException(nameof(rate), "Fixture commission terms must be finite and non-negative.");
            return new EffectiveSymbolSpecification(
                SchemaVersion,
                SpecificationSource + ";" + (sourceSuffix ?? "deterministic_commission_fixture"),
                SpecificationSourceKind,
                SpecificationSourceSha256,
                SpecificationPath,
                ResolvedSourcePath,
                Symbol,
                AssetFamily,
                BaseCurrency,
                QuoteCurrency,
                AccountCurrency,
                AccountCurrencyDigits,
                Digits,
                PipSize,
                TickSize,
                PipValue,
                PipValueCurrency,
                TickValue,
                TickValueCurrency,
                LotSize,
                ContractMultiplier,
                VolumeInUnitsMin,
                VolumeInUnitsMax,
                VolumeInUnitsStep,
                VolumeUnits,
                CommissionModel,
                rate,
                CommissionRateCurrency,
                CommissionSideSemantics,
                minimumCommission,
                MinimumCommissionCurrency,
                CommissionRoundingMode,
                QuoteToAccountConversionModel,
                QuoteToAccountConversionRate,
                UsdNotionalConversionRule,
                PnLConversionFeeRate,
                SwapCalculationType,
                SwapLong,
                SwapShort,
                SwapTimeAuthorityStatus,
                SwapTimeAuthorityKind,
                SwapTimeAuthoritySha256,
                SwapTimeAuthorityPath,
                ResolvedSwapTimeAuthorityPath,
                SwapTimeUtc,
                SwapPeriodHours,
                SwapGracePeriods,
                SwapWeekendCharging,
                Swap3DaysRollover,
                PercentageSwapDayCount,
                CommissionBaseToUsdRate,
                NativeCommissionEndUtc);
        }

        public EffectiveSymbolSpecification WithSwapTermsForDeterministicFixture(
            double swapLong,
            double swapShort,
            SwapTimeAuthorityStatus authorityStatus,
            string sourceSuffix)
        {
            return new EffectiveSymbolSpecification(
                SchemaVersion,
                SpecificationSource + ";" + (sourceSuffix ?? "deterministic_swap_fixture"),
                SpecificationSourceKind,
                SpecificationSourceSha256,
                SpecificationPath,
                ResolvedSourcePath,
                Symbol,
                AssetFamily,
                BaseCurrency,
                QuoteCurrency,
                AccountCurrency,
                AccountCurrencyDigits,
                Digits,
                PipSize,
                TickSize,
                PipValue,
                PipValueCurrency,
                TickValue,
                TickValueCurrency,
                LotSize,
                ContractMultiplier,
                VolumeInUnitsMin,
                VolumeInUnitsMax,
                VolumeInUnitsStep,
                VolumeUnits,
                CommissionModel,
                CommissionRate,
                CommissionRateCurrency,
                CommissionSideSemantics,
                MinimumCommission,
                MinimumCommissionCurrency,
                CommissionRoundingMode,
                QuoteToAccountConversionModel,
                QuoteToAccountConversionRate,
                UsdNotionalConversionRule,
                PnLConversionFeeRate,
                SwapCalculationType,
                swapLong,
                swapShort,
                authorityStatus,
                authorityStatus == SwapTimeAuthorityStatus.Authenticated ? SwapTimeAuthorityKind : "UNAVAILABLE",
                authorityStatus == SwapTimeAuthorityStatus.Authenticated ? SwapTimeAuthoritySha256 : new string('0', 64),
                authorityStatus == SwapTimeAuthorityStatus.Authenticated ? SwapTimeAuthorityPath : "UNAVAILABLE",
                authorityStatus == SwapTimeAuthorityStatus.Authenticated ? ResolvedSwapTimeAuthorityPath : "",
                authorityStatus == SwapTimeAuthorityStatus.Authenticated ? SwapTimeUtc : null,
                SwapPeriodHours,
                SwapGracePeriods,
                SwapWeekendCharging,
                Swap3DaysRollover,
                PercentageSwapDayCount,
                CommissionBaseToUsdRate,
                NativeCommissionEndUtc);
        }

        public IReadOnlyDictionary<string, object> ToContractRecord()
        {
            return new Dictionary<string, object>(StringComparer.Ordinal)
            {
                ["schema_version"] = SchemaVersion,
                ["canonical_spec_sha256"] = CanonicalSpecSha256,
                ["canonical_payload_json"] = CanonicalPayloadJson,
                ["specification_source"] = SpecificationSource,
                ["specification_source_kind"] = SpecificationSourceKind,
                ["specification_source_sha256"] = SpecificationSourceSha256,
                ["specification_path"] = SpecificationPath,
                ["resolved_source_path"] = ResolvedSourcePath,
                ["symbol"] = Symbol,
                ["asset_family"] = AssetFamily.ToString(),
                ["base_currency"] = BaseCurrency,
                ["quote_currency"] = QuoteCurrency,
                ["account_currency"] = AccountCurrency,
                ["account_currency_digits"] = AccountCurrencyDigits,
                ["digits"] = Digits,
                ["pip_size"] = PipSize,
                ["tick_size"] = TickSize,
                ["pip_value"] = PipValue,
                ["pip_value_currency"] = PipValueCurrency,
                ["tick_value"] = TickValue,
                ["tick_value_currency"] = TickValueCurrency,
                ["lot_size"] = LotSize,
                ["contract_multiplier"] = ContractMultiplier,
                ["volume_in_units_min"] = VolumeInUnitsMin,
                ["volume_in_units_max"] = VolumeInUnitsMax,
                ["volume_in_units_step"] = VolumeInUnitsStep,
                ["volume_units"] = VolumeUnits,
                ["commission_model"] = CommissionModel.ToString(),
                ["commission_rate"] = CommissionRate,
                ["commission_rate_currency"] = CommissionRateCurrency,
                ["commission_side_semantics"] = CommissionSideSemantics.ToString(),
                ["minimum_commission"] = MinimumCommission,
                ["minimum_commission_currency"] = MinimumCommissionCurrency,
                ["commission_rounding_mode"] = CommissionRoundingMode.ToString(),
                ["quote_to_account_conversion_model"] = QuoteToAccountConversionModel.ToString(),
                ["quote_to_account_conversion_rate"] = QuoteToAccountConversionRate,
                ["usd_notional_conversion_rule"] = UsdNotionalConversionRule,
                ["commission_base_to_usd_rate"] = CommissionBaseToUsdRate,
                ["native_commission_end_utc"] = NativeCommissionEndUtc?.ToString("o"),
                ["pnl_conversion_fee_rate"] = PnLConversionFeeRate,
                ["swap_calculation_type"] = SwapCalculationType.ToString(),
                ["swap_long"] = SwapLong,
                ["swap_short"] = SwapShort,
                ["swap_time_authority_status"] = SwapTimeAuthorityStatus.ToString(),
                ["swap_time_authority_kind"] = SwapTimeAuthorityKind,
                ["swap_time_authority_sha256"] = SwapTimeAuthoritySha256,
                ["swap_time_authority_path"] = SwapTimeAuthorityPath,
                ["resolved_swap_time_authority_path"] = ResolvedSwapTimeAuthorityPath,
                ["swap_time_utc"] = SwapTimeUtc.HasValue ? SwapTimeUtc.Value.ToString("c", CultureInfo.InvariantCulture) : "UNKNOWN",
                ["swap_period_hours"] = SwapPeriodHours,
                ["swap_grace_periods"] = SwapGracePeriods,
                ["swap_weekend_charging"] = SwapWeekendCharging,
                ["swap_3_days_rollover"] = Swap3DaysRollover.ToString(),
                ["percentage_swap_day_count"] = PercentageSwapDayCount
            };
        }

        private string ComputeCanonicalPayloadJson()
        {
            var payload = new
            {
                schema_version = SchemaVersion,
                specification_source = SpecificationSource,
                specification_source_kind = SpecificationSourceKind,
                specification_source_sha256 = SpecificationSourceSha256,
                symbol = Symbol,
                asset_family = AssetFamily.ToString(),
                base_currency = BaseCurrency,
                quote_currency = QuoteCurrency,
                account_currency = AccountCurrency,
                account_currency_digits = AccountCurrencyDigits,
                digits = Digits,
                pip_size = PipSize,
                tick_size = TickSize,
                pip_value = PipValue,
                pip_value_currency = PipValueCurrency,
                tick_value = TickValue,
                tick_value_currency = TickValueCurrency,
                lot_size = LotSize,
                contract_multiplier = ContractMultiplier,
                volume_in_units_min = VolumeInUnitsMin,
                volume_in_units_max = VolumeInUnitsMax,
                volume_in_units_step = VolumeInUnitsStep,
                volume_units = VolumeUnits,
                commission_model = CommissionModel.ToString(),
                commission_rate = CommissionRate,
                commission_rate_currency = CommissionRateCurrency,
                commission_side_semantics = CommissionSideSemantics.ToString(),
                minimum_commission = MinimumCommission,
                minimum_commission_currency = MinimumCommissionCurrency,
                commission_rounding_mode = CommissionRoundingMode.ToString(),
                quote_to_account_conversion_model = QuoteToAccountConversionModel.ToString(),
                quote_to_account_conversion_rate = QuoteToAccountConversionRate,
                usd_notional_conversion_rule = UsdNotionalConversionRule,
                commission_base_to_usd_rate = CommissionBaseToUsdRate,
                native_commission_end_utc = NativeCommissionEndUtc?.ToString("o"),
                pnl_conversion_fee_rate = PnLConversionFeeRate,
                swap_calculation_type = SwapCalculationType.ToString(),
                swap_long = SwapLong,
                swap_short = SwapShort,
                swap_time_authority_status = SwapTimeAuthorityStatus.ToString(),
                swap_time_authority_kind = SwapTimeAuthorityKind,
                swap_time_authority_sha256 = SwapTimeAuthoritySha256,
                swap_time_utc = SwapTimeUtc.HasValue ? SwapTimeUtc.Value.ToString("c", CultureInfo.InvariantCulture) : "UNKNOWN",
                swap_period_hours = SwapPeriodHours,
                swap_grace_periods = SwapGracePeriods,
                swap_weekend_charging = SwapWeekendCharging,
                swap_3_days_rollover = Swap3DaysRollover.ToString(),
                percentage_swap_day_count = PercentageSwapDayCount
            };
            return JsonSerializer.Serialize(payload);
        }

        private static string ComputeCanonicalSha256(string canonicalPayloadJson)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(canonicalPayloadJson);
            return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        }

        internal static bool IsFinite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    }

    public static class EffectiveSymbolSpecificationLoader
    {
        public const string SupportedSchemaVersion = "backtestengine.economic-symbol/v2";

        public static EffectiveSymbolSpecification Load(string path, string requestedSymbol)
        {
            if (string.IsNullOrWhiteSpace(path))
                throw new InvalidOperationException("A versioned --symbol-spec is required; silent symbol defaults are prohibited.");
            string fullPath = Path.GetFullPath(path);
            if (!File.Exists(fullPath))
                throw new FileNotFoundException("Effective symbol specification was not found.", fullPath);

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(File.ReadAllText(fullPath));
            }
            catch (JsonException exception)
            {
                throw new InvalidDataException("Effective symbol specification is malformed JSON.", exception);
            }

            using (document)
            {
                JsonElement root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                    throw new InvalidDataException("Effective symbol specification root must be an object.");

                string schemaVersion = RequiredString(root, "schema_version");
                if (!string.Equals(schemaVersion, SupportedSchemaVersion, StringComparison.Ordinal))
                    throw new NotSupportedException("Unsupported symbol specification schema_version '" + schemaVersion + "'.");

                string source = RequiredString(root, "specification_source");
                string sourceKind = RequiredString(root, "specification_source_kind");
                string sourceRelativePath = RequiredString(root, "specification_source_path");
                string sourceSha = RequiredSha256(root, "specification_source_sha256");
                string sourcePath = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(fullPath) ?? "", sourceRelativePath));
                VerifySourceHash(sourcePath, sourceSha);

                SwapTimeAuthorityStatus swapAuthorityStatus = RequiredEnum<SwapTimeAuthorityStatus>(root, "swap_time_authority_status");
                string swapAuthorityKind = RequiredString(root, "swap_time_authority_kind");
                string swapAuthorityRelativePath = RequiredString(root, "swap_time_authority_path");
                string swapAuthoritySha = RequiredSha256(root, "swap_time_authority_sha256");
                string swapAuthorityPath = swapAuthorityStatus == SwapTimeAuthorityStatus.Authenticated
                    ? Path.GetFullPath(Path.Combine(Path.GetDirectoryName(fullPath) ?? "", swapAuthorityRelativePath))
                    : "";
                if (swapAuthorityStatus == SwapTimeAuthorityStatus.Authenticated)
                    VerifySourceHash(swapAuthorityPath, swapAuthoritySha);

                string symbol = RequiredString(root, "symbol").ToUpperInvariant();
                string requested = (requestedSymbol ?? "").Trim().ToUpperInvariant();
                if (requested.Length == 0)
                    throw new InvalidDataException("Requested symbol is missing; symbol identity cannot be verified.");
                if (!string.Equals(requested, symbol, StringComparison.Ordinal))
                    throw new InvalidDataException("Requested symbol '" + requested + "' does not match specification symbol '" + symbol + "'.");

                EffectiveSymbolSpecification spec = new EffectiveSymbolSpecification(
                    schemaVersion,
                    source,
                    sourceKind,
                    sourceSha,
                    fullPath,
                    sourcePath,
                    symbol,
                    RequiredEnum<EconomicAssetFamily>(root, "asset_family"),
                    RequiredString(root, "base_currency").ToUpperInvariant(),
                    RequiredString(root, "quote_currency").ToUpperInvariant(),
                    RequiredString(root, "account_currency").ToUpperInvariant(),
                    RequiredInt(root, "account_currency_digits"),
                    RequiredInt(root, "digits"),
                    RequiredDouble(root, "pip_size"),
                    RequiredDouble(root, "tick_size"),
                    RequiredDouble(root, "pip_value"),
                    RequiredString(root, "pip_value_currency").ToUpperInvariant(),
                    RequiredDouble(root, "tick_value"),
                    RequiredString(root, "tick_value_currency").ToUpperInvariant(),
                    RequiredDouble(root, "lot_size"),
                    RequiredDouble(root, "contract_multiplier"),
                    RequiredDouble(root, "volume_in_units_min"),
                    RequiredDouble(root, "volume_in_units_max"),
                    RequiredDouble(root, "volume_in_units_step"),
                    RequiredString(root, "volume_units"),
                    RequiredEnum<EconomicCommissionModel>(root, "commission_model"),
                    RequiredDouble(root, "commission_rate"),
                    RequiredString(root, "commission_rate_currency").ToUpperInvariant(),
                    RequiredEnum<EconomicCommissionSideSemantics>(root, "commission_side_semantics"),
                    RequiredDouble(root, "minimum_commission"),
                    RequiredString(root, "minimum_commission_currency").ToUpperInvariant(),
                    RequiredEnum<CommissionRoundingMode>(root, "commission_rounding_mode"),
                    RequiredEnum<EconomicConversionModel>(root, "quote_to_account_conversion_model"),
                    RequiredDouble(root, "quote_to_account_conversion_rate"),
                    RequiredString(root, "usd_notional_conversion_rule"),
                    RequiredDouble(root, "pnl_conversion_fee_rate"),
                    RequiredEnum<EconomicSwapCalculationType>(root, "swap_calculation_type"),
                    RequiredDouble(root, "swap_long"),
                    RequiredDouble(root, "swap_short"),
                    swapAuthorityStatus,
                    swapAuthorityKind,
                    swapAuthoritySha,
                    swapAuthorityRelativePath,
                    swapAuthorityPath,
                    RequiredSwapTime(root, "swap_time_utc", swapAuthorityStatus),
                    RequiredInt(root, "swap_period_hours"),
                    RequiredInt(root, "swap_grace_periods"),
                    RequiredBool(root, "swap_weekend_charging"),
                    RequiredEnum<DayOfWeek>(root, "swap_3_days_rollover"),
                    RequiredInt(root, "percentage_swap_day_count"),
                    RequiredString(root, "usd_notional_conversion_rule") == "fixed_base_to_usd"
                        ? RequiredDouble(root, "commission_base_to_usd_rate") : 0.0,
                    root.TryGetProperty("commission_conversion_authority_path", out _)
                        ? DateTime.Parse(RequiredString(root, "native_commission_end_utc"), CultureInfo.InvariantCulture,
                            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal) : null);

                Validate(spec);
                ValidateAgainstAuthoritativeSource(spec, sourcePath, root);
                if (spec.SwapTimeAuthorityStatus == SwapTimeAuthorityStatus.Authenticated)
                    ValidateAgainstSwapAuthority(spec, swapAuthorityPath);
                return spec;
            }
        }

        private static void Validate(EffectiveSymbolSpecification spec)
        {
            if (spec.AccountCurrencyDigits < 0 || spec.AccountCurrencyDigits > 8)
                throw new InvalidDataException("account_currency_digits must be between 0 and 8.");
            if (spec.Digits < 0 || spec.Digits > 12)
                throw new InvalidDataException("digits must be between 0 and 12.");
            RequirePositiveFinite(spec.PipSize, "pip_size");
            RequirePositiveFinite(spec.TickSize, "tick_size");
            RequirePositiveFinite(spec.PipValue, "pip_value");
            RequirePositiveFinite(spec.TickValue, "tick_value");
            RequirePositiveFinite(spec.LotSize, "lot_size");
            RequirePositiveFinite(spec.ContractMultiplier, "contract_multiplier");
            RequirePositiveFinite(spec.VolumeInUnitsMin, "volume_in_units_min");
            RequirePositiveFinite(spec.VolumeInUnitsMax, "volume_in_units_max");
            RequirePositiveFinite(spec.VolumeInUnitsStep, "volume_in_units_step");
            if (spec.VolumeInUnitsMin > spec.VolumeInUnitsMax)
                throw new InvalidDataException("volume_in_units_min cannot exceed volume_in_units_max.");
            if (spec.TickSize > spec.PipSize)
                throw new InvalidDataException("tick_size cannot exceed pip_size.");
            if (!EffectiveSymbolSpecification.IsFinite(spec.CommissionRate) || spec.CommissionRate < 0.0)
                throw new InvalidDataException("commission_rate must be finite and non-negative.");
            if (!EffectiveSymbolSpecification.IsFinite(spec.MinimumCommission) || spec.MinimumCommission < 0.0)
                throw new InvalidDataException("minimum_commission must be finite and non-negative.");
            if (!EffectiveSymbolSpecification.IsFinite(spec.PnLConversionFeeRate) || spec.PnLConversionFeeRate < 0.0)
                throw new InvalidDataException("pnl_conversion_fee_rate must be finite and non-negative.");
            RequirePositiveFinite(spec.QuoteToAccountConversionRate, "quote_to_account_conversion_rate");
            if (!EffectiveSymbolSpecification.IsFinite(spec.SwapLong) || !EffectiveSymbolSpecification.IsFinite(spec.SwapShort))
                throw new InvalidDataException("swap rates must be finite.");
            if (spec.PercentageSwapDayCount <= 0)
                throw new InvalidDataException("percentage_swap_day_count must be positive.");
            if (spec.SwapTimeAuthorityStatus != SwapTimeAuthorityStatus.Unknown && !spec.SwapTimeUtc.HasValue)
                throw new InvalidDataException("Authenticated or assumed swap authority requires a valid swap_time_utc.");
            if (spec.SwapTimeAuthorityStatus == SwapTimeAuthorityStatus.Unknown && spec.SwapTimeUtc.HasValue)
                throw new InvalidDataException("UNKNOWN swap authority cannot carry a simulated rollover time.");
            if (spec.SwapPeriodHours != 24 || spec.SwapGracePeriods != 0 || spec.SwapWeekendCharging)
                throw new NotSupportedException("The active runtime supports only authenticated 24-hour, zero-grace, no-weekend swap schedules.");
            if (!string.Equals(spec.PipValueCurrency, spec.AccountCurrency, StringComparison.Ordinal)
                || !string.Equals(spec.TickValueCurrency, spec.AccountCurrency, StringComparison.Ordinal))
                throw new NotSupportedException("Pip and tick values must be expressed in account currency for schema v1.");
            if (!string.Equals(spec.CommissionRateCurrency, "USD", StringComparison.Ordinal))
                throw new NotSupportedException("Schema v1 supports USD-per-million commission rates only.");
            if (!string.Equals(spec.MinimumCommissionCurrency, spec.AccountCurrency, StringComparison.Ordinal))
                throw new NotSupportedException("Schema v1 minimum commission must be in account currency.");
            if (!string.Equals(spec.VolumeUnits, "base_or_contract_units", StringComparison.Ordinal))
                throw new NotSupportedException("Unsupported volume_units '" + spec.VolumeUnits + "'.");
            if (spec.QuoteToAccountConversionModel == EconomicConversionModel.Identity
                && !string.Equals(spec.QuoteCurrency, spec.AccountCurrency, StringComparison.Ordinal))
                throw new InvalidDataException("Identity quote conversion requires quote currency to equal account currency.");
            if (string.Equals(spec.QuoteCurrency, spec.AccountCurrency, StringComparison.Ordinal)
                && Math.Abs(spec.QuoteToAccountConversionRate - 1.0) > 1e-12)
                throw new InvalidDataException("Quote-to-account rate must equal one when currencies are identical.");
            double impliedPipValue = spec.PipSize * spec.QuoteToAccountConversionRate;
            double impliedTickValue = spec.TickSize * spec.QuoteToAccountConversionRate;
            AssertNear(spec.PipValue, impliedPipValue, "pip_value conversion consistency");
            AssertNear(spec.TickValue, impliedTickValue, "tick_value conversion consistency");

            string expectedUsdRule = string.Equals(spec.BaseCurrency, "USD", StringComparison.Ordinal)
                ? "base_currency_is_usd"
                : string.Equals(spec.QuoteCurrency, "USD", StringComparison.Ordinal)
                    ? "quote_currency_is_usd_price_times_volume"
                    : "";
            if (spec.UsdNotionalConversionRule == "fixed_base_to_usd")
                RequirePositiveFinite(spec.CommissionBaseToUsdRate, "commission_base_to_usd_rate");
            else if (expectedUsdRule.Length == 0 || !string.Equals(spec.UsdNotionalConversionRule, expectedUsdRule, StringComparison.Ordinal))
                throw new NotSupportedException("An explicit supported USD-notional conversion rule is required.");
        }

        private static void ValidateAgainstAuthoritativeSource(EffectiveSymbolSpecification spec, string sourcePath, JsonElement contract)
        {
            using JsonDocument source = JsonDocument.Parse(File.ReadAllText(sourcePath));
            JsonElement root = source.RootElement;
            AssertEqual(spec.Symbol, RequiredString(root, "symbol").ToUpperInvariant(), "source symbol");
            AssertEqual(spec.BaseCurrency, RequiredString(root, "base_asset").ToUpperInvariant(), "source base asset");
            AssertEqual(spec.QuoteCurrency, RequiredString(root, "quote_asset").ToUpperInvariant(), "source quote asset");
            AssertEqual(spec.AccountCurrency, RequiredString(root, "account_asset").ToUpperInvariant(), "source account asset");
            AssertEqual(spec.Digits, RequiredInt(root, "digits"), "source digits");
            AssertNear(spec.PipSize, RequiredDouble(root, "pip_size"), "source pip_size");
            AssertNear(spec.TickSize, RequiredDouble(root, "tick_size"), "source tick_size");
            AssertNear(spec.PipValue, RequiredDouble(root, "pip_value"), "source pip_value");
            AssertNear(spec.TickValue, RequiredDouble(root, "tick_value"), "source tick_value");
            AssertNear(spec.LotSize, RequiredDouble(root, "lot_size"), "source lot_size");
            AssertNear(spec.VolumeInUnitsMin, RequiredDouble(root, "volume_in_units_min"), "source volume min");
            AssertNear(spec.VolumeInUnitsMax, RequiredDouble(root, "volume_in_units_max"), "source volume max");
            AssertNear(spec.VolumeInUnitsStep, RequiredDouble(root, "volume_in_units_step"), "source volume step");
            AssertNear(spec.CommissionRate, RequiredDouble(root, "commission"), "source commission");
            if (spec.UsdNotionalConversionRule == "fixed_base_to_usd")
            {
                if (contract.TryGetProperty("commission_conversion_authority_path", out JsonElement authorityProperty))
                {
                    string authorityPath = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(spec.SpecificationPath)!, authorityProperty.GetString()!));
                    VerifySourceHash(authorityPath, RequiredSha256(contract, "commission_conversion_authority_sha256"));
                    using JsonDocument authority = JsonDocument.Parse(File.ReadAllText(authorityPath));
                    JsonElement fee = authority.RootElement;
                    AssertEqual("native-commission-calibration/v1", RequiredString(fee, "schema_version"), "commission authority schema");
                    AssertEqual(spec.Symbol, RequiredString(fee, "symbol"), "commission authority symbol");
                    AssertEqual(spec.CommissionModel.ToString(), RequiredString(fee, "commission_model"), "commission authority model");
                    AssertEqual(spec.AccountCurrencyDigits, RequiredInt(fee, "account_digits"), "commission authority account precision");
                    AssertNear(spec.CommissionRate, RequiredDouble(fee, "commission_rate"), "commission authority rate");
                    AssertNear(spec.CommissionBaseToUsdRate, RequiredDouble(fee, "fixed_base_to_usd_rate"), "commission conversion authority");
                    DateTime authorityEnd = DateTime.Parse(RequiredString(fee, "requested_native_end_utc"), CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
                    if (spec.NativeCommissionEndUtc != authorityEnd)
                        throw new InvalidDataException("Commission calibration end date does not match its native authority.");
                    AssertEqual(spec.AccountCurrency, RequiredString(fee, "account_currency"), "commission authority currency");
                    if (spec.CommissionRoundingMode != CommissionRoundingMode.CurrencyCent)
                        throw new InvalidDataException("Native commission calibration requires account-precision per-fill rounding.");
                    double lower = RequiredDouble(fee, "interval_lower_inclusive"), upper = RequiredDouble(fee, "interval_upper_exclusive");
                    if (spec.CommissionBaseToUsdRate < lower || spec.CommissionBaseToUsdRate >= upper)
                        throw new InvalidDataException("Commission conversion must lie within the captured rounding interval.");
                    string eventsPath = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(authorityPath)!, RequiredString(fee, "source_events_path")));
                    VerifySourceHash(eventsPath, RequiredSha256(fee, "source_events_sha256"));
                    string reportPath = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(authorityPath)!, RequiredString(fee, "source_report_path")));
                    VerifySourceHash(reportPath, RequiredSha256(fee, "source_report_sha256"));
                    string capturePath = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(authorityPath)!, RequiredString(fee, "source_spec_path")));
                    VerifySourceHash(capturePath, RequiredSha256(fee, "source_spec_sha256"));
                    ValidateCommissionEvidence(spec, fee, eventsPath, reportPath, capturePath, authorityEnd);
                }
                else
                    AssertNear(spec.CommissionBaseToUsdRate, RequiredDouble(root.GetProperty("base_to_usd"), "rate"), "source base to USD conversion");
            }
            AssertEqual(spec.CommissionModel.ToString(), RequiredString(root, "commission_type"), "source commission model");
            AssertNear(spec.MinimumCommission, RequiredDouble(root, "min_commission"), "source minimum commission");
            AssertEqual(spec.MinimumCommissionCurrency, RequiredString(root, "min_commission_asset").ToUpperInvariant(), "source minimum commission currency");
            AssertNear(spec.PnLConversionFeeRate, RequiredDouble(root, "pnl_conversion_fee_rate"), "source PnL conversion fee");
            AssertNear(spec.SwapLong, RequiredDouble(root, "swap_long"), "source swap_long");
            AssertNear(spec.SwapShort, RequiredDouble(root, "swap_short"), "source swap_short");
            AssertEqual(spec.SwapCalculationType.ToString(), RequiredString(root, "swap_calculation_type"), "source swap calculation type");
            AssertEqual(spec.Swap3DaysRollover.ToString(), RequiredString(root, "swap_3_days_rollover"), "source triple swap day");
        }

        private static void ValidateCommissionEvidence(EffectiveSymbolSpecification spec, JsonElement authority,
            string eventsPath, string reportPath, string capturePath, DateTime authorityEnd)
        {
            using JsonDocument capture = JsonDocument.Parse(File.ReadAllText(capturePath));
            JsonElement source = capture.RootElement;
            AssertEqual(spec.Symbol, RequiredString(source, "symbol"), "commission capture symbol");
            AssertEqual(spec.AccountCurrency, RequiredString(source, "account_asset"), "commission capture account currency");
            AssertEqual(spec.AccountCurrencyDigits, RequiredInt(source, "account_digits"), "commission capture account precision");
            AssertEqual(spec.CommissionModel.ToString(), RequiredString(source, "commission_type"), "commission capture model");
            AssertNear(spec.CommissionRate, RequiredDouble(source, "commission"), "commission capture rate");
            using JsonDocument report = JsonDocument.Parse(File.ReadAllText(reportPath));
            JsonElement main = report.RootElement.GetProperty("main");
            AssertEqual(spec.Symbol, RequiredString(main, "symbol"), "commission report symbol");
            AssertEqual(spec.AccountCurrency, RequiredString(main, "depositAsset"), "commission report account currency");
            AssertEqual(spec.AccountCurrencyDigits, RequiredInt(main, "depositAssetDigits"), "commission report account precision");
            AssertEqual(0, RequiredInt(main, "utcOffset"), "commission report UTC offset");
            AssertEqual("usdPerMillionUsdVolume", RequiredString(main.GetProperty("commissions"), "type"), "commission report model");
            AssertNear(spec.CommissionRate, RequiredDouble(main.GetProperty("commissions"), "value"), "commission report rate");
            DateTime reportEnd = DateTimeOffset.FromUnixTimeMilliseconds(main.GetProperty("testingPeriod").GetProperty("endDate").GetInt64()).UtcDateTime;
            if (reportEnd != authorityEnd)
                throw new InvalidDataException("Commission capture report end date does not match its calibration authority.");

            // Recompute the evidence instead of trusting the authority's passed
            // flags. The largest controlled volume identifies a rounding interval;
            // smaller volumes independently test the same fixed conversion rate.
            double calibrationVolume = RequiredDouble(authority, "calibration_volume");
            RequirePositiveFinite(calibrationVolume, "commission calibration volume");
            double quantum = Math.Pow(10.0, -spec.AccountCurrencyDigits);
            double observedLower = double.NegativeInfinity, observedUpper = double.PositiveInfinity;
            int calibrationCases = 0, heldOutCases = 0;
            foreach (string line in File.ReadLines(eventsPath))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                using JsonDocument eventDocument = JsonDocument.Parse(line);
                JsonElement entry = eventDocument.RootElement;
                if (!entry.TryGetProperty("event_type", out JsonElement kind) || kind.GetString() != "opened") continue;
                double volume = RequiredDouble(entry, "volume");
                RequirePositiveFinite(volume, "commission evidence volume");
                if (volume > calibrationVolume)
                    throw new InvalidDataException("Commission calibration volume must be the largest controlled volume.");
                double observedCost = -RequiredDouble(entry, "commissions");
                double predictedCost = (double)Math.Round(Math.Max((decimal)spec.MinimumCommission,
                    (decimal)volume * (decimal)spec.CommissionBaseToUsdRate / 1000000m * (decimal)spec.CommissionRate),
                    spec.AccountCurrencyDigits, MidpointRounding.AwayFromZero);
                AssertNear(observedCost, predictedCost, "commission native held-out fee");
                if (volume == calibrationVolume)
                {
                    if (observedCost <= spec.MinimumCommission || spec.CommissionRate <= 0.0)
                        throw new InvalidDataException("A minimum or zero commission cannot identify a fixed conversion rate.");
                    observedLower = Math.Max(observedLower, (observedCost - quantum / 2.0) * 1000000.0 / (volume * spec.CommissionRate));
                    observedUpper = Math.Min(observedUpper, (observedCost + quantum / 2.0) * 1000000.0 / (volume * spec.CommissionRate));
                    calibrationCases++;
                }
                else heldOutCases++;
            }
            if (calibrationCases == 0 || heldOutCases == 0)
                throw new InvalidDataException("Commission authority requires both calibration and held-out native fills.");
            AssertNear(RequiredDouble(authority, "interval_lower_inclusive"), observedLower, "commission interval lower bound");
            AssertNear(RequiredDouble(authority, "interval_upper_exclusive"), observedUpper, "commission interval upper bound");
        }


        private static void ValidateAgainstSwapAuthority(EffectiveSymbolSpecification spec, string authorityPath)
        {
            using JsonDocument authority = JsonDocument.Parse(File.ReadAllText(authorityPath));
            JsonElement root = authority.RootElement;
            AssertEqual("backtestengine.swap-authority/v1", RequiredString(root, "schema_version"), "swap authority schema");
            AssertEqual("AUTHENTICATED", RequiredString(root, "authority_status"), "swap authority status");
            AssertEqual(spec.Symbol, RequiredString(root, "symbol").ToUpperInvariant(), "swap authority symbol");
            AssertEqual(spec.AccountCurrency, RequiredString(root, "account_currency").ToUpperInvariant(), "swap authority account currency");
            AssertEqual(0, RequiredInt(root, "report_utc_offset_hours"), "swap authority report UTC offset");
            AssertEqual(spec.SwapTimeUtc!.Value.ToString("c", CultureInfo.InvariantCulture), RequiredString(root, "swap_time_utc"), "swap authority UTC time");
            AssertEqual(spec.SwapPeriodHours, RequiredInt(root, "swap_period_hours"), "swap authority period");
            AssertEqual(spec.SwapGracePeriods, RequiredInt(root, "swap_grace_periods"), "swap authority grace periods");
            if (spec.SwapWeekendCharging != RequiredBool(root, "swap_weekend_charging"))
                throw new InvalidDataException("swap authority weekend charging mismatch.");
            AssertEqual(spec.Swap3DaysRollover.ToString(), RequiredString(root, "swap_3_days_rollover"), "swap authority triple day");
            AssertEqual(spec.SwapCalculationType.ToString(), RequiredString(root, "swap_calculation_type"), "swap authority calculation type");

            string reportRelative = RequiredString(root, "source_report_relative_path");
            string reportPath = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(authorityPath) ?? "", reportRelative));
            VerifySourceHash(reportPath, RequiredSha256(root, "source_report_sha256"));
        }

        private static void VerifySourceHash(string path, string expectedSha)
        {
            if (!File.Exists(path))
                throw new FileNotFoundException("Authoritative specification source cannot be verified.", path);
            string actual = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
            if (!string.Equals(actual, expectedSha, StringComparison.Ordinal))
                throw new InvalidDataException("Authoritative specification SHA-256 mismatch. Expected " + expectedSha + " but found " + actual + ".");
        }

        private static string RequiredSha256(JsonElement root, string name)
        {
            string value = RequiredString(root, name).ToLowerInvariant();
            if (value.Length != 64)
                throw new InvalidDataException(name + " must contain 64 lowercase hexadecimal characters.");
            foreach (char ch in value)
            {
                if (!Uri.IsHexDigit(ch))
                    throw new InvalidDataException(name + " is not a valid SHA-256 value.");
            }
            return value;
        }

        private static string RequiredString(JsonElement root, string name)
        {
            if (!root.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(value.GetString()))
                throw new InvalidDataException("Missing or invalid required string '" + name + "'.");
            return value.GetString().Trim();
        }

        private static double RequiredDouble(JsonElement root, string name)
        {
            if (!root.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.Number
                || !value.TryGetDouble(out double result) || !EffectiveSymbolSpecification.IsFinite(result))
                throw new InvalidDataException("Missing or invalid required number '" + name + "'.");
            return result;
        }

        private static bool RequiredBool(JsonElement root, string name)
        {
            if (!root.TryGetProperty(name, out JsonElement value)
                || (value.ValueKind != JsonValueKind.True && value.ValueKind != JsonValueKind.False))
                throw new InvalidDataException("Missing or invalid required boolean '" + name + "'.");
            return value.GetBoolean();
        }

        private static int RequiredInt(JsonElement root, string name)
        {
            if (!root.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.Number
                || !value.TryGetInt32(out int result))
                throw new InvalidDataException("Missing or invalid required integer '" + name + "'.");
            return result;
        }

        private static T RequiredEnum<T>(JsonElement root, string name) where T : struct, Enum
        {
            string value = RequiredString(root, name).Replace("_", "", StringComparison.Ordinal);
            foreach (T candidate in Enum.GetValues<T>())
            {
                if (string.Equals(candidate.ToString().Replace("_", "", StringComparison.Ordinal), value, StringComparison.OrdinalIgnoreCase))
                    return candidate;
            }
            throw new NotSupportedException("Unsupported " + name + " '" + value + "'.");
        }

        private static TimeSpan? RequiredSwapTime(JsonElement root, string name, SwapTimeAuthorityStatus status)
        {
            string value = RequiredString(root, name);
            if (status == SwapTimeAuthorityStatus.Unknown)
            {
                if (!string.Equals(value, "UNKNOWN", StringComparison.Ordinal))
                    throw new InvalidDataException("Unknown swap authority must use swap_time_utc=UNKNOWN.");
                return null;
            }
            return RequiredTimeSpan(root, name);
        }

        private static TimeSpan RequiredTimeSpan(JsonElement root, string name)
        {
            string value = RequiredString(root, name);
            if (!TimeSpan.TryParse(value, CultureInfo.InvariantCulture, out TimeSpan result)
                || result < TimeSpan.Zero || result >= TimeSpan.FromDays(1.0))
                throw new InvalidDataException("Missing or invalid UTC time '" + name + "'.");
            return result;
        }

        private static void RequirePositiveFinite(double value, string name)
        {
            if (!EffectiveSymbolSpecification.IsFinite(value) || value <= 0.0)
                throw new InvalidDataException(name + " must be finite and positive.");
        }

        private static void AssertNear(double actual, double expected, string name)
        {
            double tolerance = 1e-9 + 1e-12 * Math.Max(Math.Abs(actual), Math.Abs(expected));
            if (Math.Abs(actual - expected) > tolerance)
                throw new InvalidDataException(name + " mismatch. Expected " + expected.ToString("R", CultureInfo.InvariantCulture)
                    + " but received " + actual.ToString("R", CultureInfo.InvariantCulture) + ".");
        }

        private static void AssertEqual(string actual, string expected, string name)
        {
            if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException(name + " mismatch. Expected '" + expected + "' but received '" + actual + "'.");
        }

        private static void AssertEqual(int actual, int expected, string name)
        {
            if (actual != expected)
                throw new InvalidDataException(name + " mismatch. Expected " + expected + " but received " + actual + ".");
        }
    }
}
