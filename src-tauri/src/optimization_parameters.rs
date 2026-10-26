//! Validate draft parameters against host-recorded compiler reflection, without generating or scoring candidates.
use super::contract::OptimizationRunRequest;
use crate::workspace_build::{CompiledStrategy, StrategyParameter};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Complete validated base preset and exact dimension arrays passed unchanged to the original generator.
pub(super) struct ValidatedSearch {
    pub base: Value,
    pub dimensions: Value,
}

/// Bound metadata-driven parameter collections before any files or processes are created.
pub(super) fn validate_search(
    request: &OptimizationRunRequest,
    strategy: &CompiledStrategy,
) -> Result<ValidatedSearch, String> {
    if !["grid", "random"].contains(&request.method.as_str()) {
        return Err("Choose grid or seeded random search.".into());
    }
    if !(1..=100).contains(&request.max_runs) {
        return Err("Optimization budget must be between 1 and 100 candidates.".into());
    }
    if !(1..=2).contains(&request.max_workers) || request.seed < 0 {
        return Err("Use one or two workers and a non-negative 32-bit seed.".into());
    }
    if request.dimensions.is_empty() || request.dimensions.len() > 8 {
        return Err("Choose between one and eight search parameters.".into());
    }
    if strategy.parameters.len() > 256 || request.base_parameters.len() > 256 {
        return Err("The strategy exceeds the 256-parameter limit.".into());
    }
    let base = frozen_base_parameters(&request.base_parameters, strategy)?;
    let mut dimensions = serde_json::Map::new();
    let mut names = BTreeSet::new();
    for dimension in &request.dimensions {
        if !names.insert(dimension.name.clone()) {
            return Err("A search parameter cannot appear twice.".into());
        }
        let schema = find_parameter(strategy, &dimension.name)?;
        if dimension.values.is_empty() || dimension.values.len() > 32 {
            return Err(format!(
                "{} needs between 1 and 32 explicit values.",
                dimension.name
            ));
        }
        validate_dimension_values(schema, &dimension.values)?;
        dimensions.insert(
            schema.name.clone(),
            json!({"type": optimizer_type(schema), "values": dimension.values}),
        );
    }
    Ok(ValidatedSearch {
        base,
        dimensions: Value::Object(dimensions),
    })
}

/// Freeze every reflected default or explicit typed value; unknown environment properties are refused.
fn frozen_base_parameters(
    values: &BTreeMap<String, Value>,
    strategy: &CompiledStrategy,
) -> Result<Value, String> {
    for name in values.keys() {
        find_parameter(strategy, name)?;
    }
    let mut frozen = serde_json::Map::new();
    for schema in &strategy.parameters {
        let value = values
            .get(&schema.name)
            .cloned()
            .or_else(|| schema.default.clone())
            .unwrap_or(Value::Null);
        validate_parameter_value(schema, &value, true)?;
        frozen.insert(schema.name.clone(), value);
    }
    Ok(Value::Object(frozen))
}

/// Match only real compiler-reflected property names, never renderer-supplied metadata or Robot environment fields.
fn find_parameter<'a>(
    strategy: &'a CompiledStrategy,
    name: &str,
) -> Result<&'a StrategyParameter, String> {
    strategy
        .parameters
        .iter()
        .find(|schema| schema.name == name)
        .ok_or_else(|| format!("Parameter '{name}' is not in the approved strategy schema."))
}

/// Reject invalid or duplicate search values before passing exact arrays to the original generator.
fn validate_dimension_values(schema: &StrategyParameter, values: &[Value]) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for value in values {
        validate_parameter_value(schema, value, false)?;
        let key = value
            .as_f64()
            .map_or_else(|| value.to_string(), |number| format!("number:{number}"));
        if !seen.insert(key) {
            return Err(format!("{} contains duplicate search values.", schema.name));
        }
    }
    Ok(())
}

/// Preserve canonical reflected types/options/bounds; nullable defaults remain null only in the base preset.
fn validate_parameter_value(
    schema: &StrategyParameter,
    value: &Value,
    base: bool,
) -> Result<(), String> {
    if base && value.is_null() && schema.default.is_none() {
        return Ok(());
    }
    let valid = match schema.value_type.as_str() {
        "boolean" => value.is_boolean(),
        "integer" => value.as_f64().is_some_and(|number| {
            number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
        }),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "enum" => value
            .as_str()
            .is_some_and(|text| schema.options.iter().any(|option| option == text)),
        "timeframe" => value
            .as_str()
            .is_some_and(|text| !text.trim().is_empty() && text.len() <= 64),
        "string" => value.as_str().is_some_and(|text| text.len() <= 2048),
        _ => false,
    };
    if !valid {
        return Err(format!(
            "{} has an invalid value for reflected type {}.",
            schema.name, schema.value_type
        ));
    }
    if let Some(number) = value.as_f64() {
        validate_numeric_bounds(schema, number)?;
    }
    Ok(())
}

/// Apply inclusive bounds and declared step alignment without choosing or changing any candidate value.
fn validate_numeric_bounds(schema: &StrategyParameter, number: f64) -> Result<(), String> {
    let minimum = schema.min.as_ref().and_then(Value::as_f64);
    let maximum = schema.max.as_ref().and_then(Value::as_f64);
    if minimum.is_some_and(|limit| number < limit) || maximum.is_some_and(|limit| number > limit) {
        return Err(format!("{} is outside its reflected bounds.", schema.name));
    }
    let Some(step) = schema
        .step
        .as_ref()
        .and_then(Value::as_f64)
        .filter(|step| *step > 0.0)
    else {
        return Ok(());
    };
    let steps = (number - minimum.unwrap_or(0.0)) / step;
    if !steps.is_finite() || (steps - steps.round()).abs() > 0.0000001 {
        return Err(format!(
            "{} does not follow its reflected step.",
            schema.name
        ));
    }
    Ok(())
}

/// Translate reflected schema names to the original optimizer's supported value-array tags.
fn optimizer_type(schema: &StrategyParameter) -> &'static str {
    match schema.value_type.as_str() {
        "boolean" => "bool",
        "integer" => "int",
        "number" => "double",
        _ => "string",
    }
}
