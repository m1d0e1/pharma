use serde::{de, Deserialize, Deserializer};
use serde_json::Value;

pub(crate) fn one_i64() -> i64 {
    1
}

pub(crate) fn de_f64<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => 0.0,
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) if s.trim().is_empty() => 0.0,
        Value::String(s) => s.trim().parse::<f64>().map_err(de::Error::custom)?,
        other => return Err(de::Error::custom(format!("expected number, got {other}"))),
    })
}

pub(crate) fn de_opt_f64<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => None,
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.trim().is_empty() => None,
        Value::String(s) => Some(s.trim().parse::<f64>().map_err(de::Error::custom)?),
        other => {
            return Err(de::Error::custom(format!(
                "expected optional number, got {other}"
            )))
        }
    })
}

pub(crate) fn de_i64<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => 0,
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_u64().map(|v| v as i64))
            .or_else(|| n.as_f64().map(|v| v as i64))
            .unwrap_or(0),
        Value::String(s) if s.trim().is_empty() => 0,
        Value::String(s) => parse_i64_lossless(s.trim()).map_err(de::Error::custom)?,
        other => return Err(de::Error::custom(format!("expected integer, got {other}"))),
    })
}

pub(crate) fn de_opt_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => None,
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_u64().map(|v| v as i64))
            .or_else(|| n.as_f64().map(|v| v as i64)),
        Value::String(s) if s.trim().is_empty() => None,
        Value::String(s) => Some(parse_i64_lossless(s.trim()).map_err(de::Error::custom)?),
        other => {
            return Err(de::Error::custom(format!(
                "expected optional integer, got {other}"
            )))
        }
    })
}

pub(crate) fn de_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => String::new(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s,
        Value::Bool(b) => b.to_string(),
        other => return Err(de::Error::custom(format!("expected string, got {other}"))),
    })
}

pub(crate) fn de_opt_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => None,
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if s.trim().is_empty() => None,
        Value::String(s) => Some(s),
        Value::Bool(b) => Some(b.to_string()),
        other => {
            return Err(de::Error::custom(format!(
                "expected optional string, got {other}"
            )))
        }
    })
}

fn parse_i64_lossless(value: &str) -> Result<i64, String> {
    if let Ok(parsed) = value.parse::<i64>() {
        return Ok(parsed);
    }
    let parsed = value.parse::<f64>().map_err(|e| e.to_string())?;
    if parsed.fract() != 0.0 {
        return Err(format!("expected whole number, got {value}"));
    }
    Ok(parsed as i64)
}
