//! Strict bounded JSON boundary shared by the result and bundle decoders.
use super::transport::WireError;
use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Value};

const DEPTH_MAX: usize = 16;
const BYTES_MAX: usize = 256 * 1024;

pub(super) fn require(condition: bool) -> Result<(), WireError> {
    if condition { Ok(()) } else { Err(WireError) }
}
pub(super) fn keys(value: &Value, expected: &[&str]) -> Result<(), WireError> {
    let object = value.as_object().ok_or(WireError)?;
    require(object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key)))
}
pub(super) fn text(value: &Value) -> Result<&str, WireError> {
    value.as_str().ok_or(WireError)
}

pub(super) fn parse(raw: &[u8], max_bytes: usize) -> Result<Value, WireError> {
    if raw.is_empty() || raw.len() > max_bytes || !raw.is_ascii() {
        return Err(WireError);
    }
    let (mut depth, mut quoted, mut escaped) = (0usize, false, false);
    for byte in raw {
        if quoted {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'{' | b'[' => {
                    depth += 1;
                    if depth > DEPTH_MAX {
                        return Err(WireError);
                    }
                }
                b'}' | b']' => depth = depth.checked_sub(1).ok_or(WireError)?,
                _ => {}
            }
        }
    }
    if quoted || depth != 0 {
        return Err(WireError);
    }
    let mut decoder = serde_json::Deserializer::from_slice(raw);
    let value = StrictValue::deserialize(&mut decoder)
        .map_err(|_| WireError)?
        .0;
    decoder.end().map_err(|_| WireError)?;
    if !value.is_object() {
        return Err(WireError);
    }
    Ok(value)
}

struct StrictValue(Value);
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        struct StrictVisitor;
        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = StrictValue;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("bounded JSON with unique keys and typed integer numbers")
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Bool(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Number(v.into())))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Number(v.into())))
            }
            fn visit_f64<E: serde::de::Error>(self, _v: f64) -> Result<Self::Value, E> {
                Err(E::custom("floating numbers are not protocol fields"))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::String(v.into())))
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::String(v)))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(StrictValue(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = access.next_element::<StrictValue>()? {
                    values.push(value.0);
                }
                Ok(StrictValue(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some((key, value)) = access.next_entry::<String, StrictValue>()? {
                    if values.insert(key, value.0).is_some() {
                        return Err(serde::de::Error::custom("duplicate protocol key"));
                    }
                }
                Ok(StrictValue(Value::Object(values)))
            }
        }
        decoder.deserialize_any(StrictVisitor)
    }
}

pub(super) fn canonical(value: &Value) -> Result<Vec<u8>, WireError> {
    let mut output = Vec::new();
    write(value, &mut output, 0)?;
    Ok(output)
}
fn string(value: &str, output: &mut Vec<u8>) -> Result<(), WireError> {
    let escaped = serde_json::to_string(value).map_err(|_| WireError)?;
    for character in escaped.chars() {
        if u32::from(character) < 127 {
            output.push(character as u8);
        } else {
            for unit in character.encode_utf16(&mut [0; 2]) {
                output.extend_from_slice(format!("\\u{unit:04x}").as_bytes());
            }
        }
    }
    Ok(())
}
fn write(value: &Value, output: &mut Vec<u8>, depth: usize) -> Result<(), WireError> {
    if output.len() > BYTES_MAX || depth > DEPTH_MAX {
        return Err(WireError);
    }
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(v) => output.extend_from_slice(if *v { b"true" } else { b"false" }),
        Value::Number(v) => {
            if !v.is_i64() && !v.is_u64() {
                return Err(WireError);
            }
            output.extend_from_slice(v.to_string().as_bytes());
        }
        Value::String(v) => string(v, output)?,
        Value::Array(values) => {
            if depth == DEPTH_MAX {
                return Err(WireError);
            }
            output.push(b'[');
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                write(item, output, depth + 1)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            if depth == DEPTH_MAX {
                return Err(WireError);
            }
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
            output.push(b'{');
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                string(key, output)?;
                output.push(b':');
                write(item, output, depth + 1)?;
            }
            output.push(b'}');
        }
    }
    if output.len() > BYTES_MAX {
        return Err(WireError);
    }
    Ok(())
}

#[cfg(test)]
#[path = "wire_json_tests.rs"]
mod tests;
