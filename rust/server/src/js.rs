//! Request JSON and transient text preserve JavaScript UTF-16 strings as WTF-8.
//! SQLite reads deliberately use a different, lossy UTF-8 decoding boundary.
use std::{borrow::Borrow, collections::BTreeMap};

use rusqlite::types::{ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Visitor};
use serde_json::{Number, value::RawValue};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct JsString(Vec<u8>);

impl Borrow<[u8]> for JsString {
    fn borrow(&self) -> &[u8] {
        &self.0
    }
}

impl From<String> for JsString {
    fn from(value: String) -> Self {
        Self(value.into_bytes())
    }
}

impl JsString {
    pub fn as_str(&self) -> Option<&str> {
        std::str::from_utf8(&self.0).ok()
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn is_blank(&self) -> bool {
        String::from_utf8_lossy(&self.0)
            .trim_matches(crate::js_space)
            .is_empty()
    }
    fn json(&self) -> String {
        let mut result = String::from("\"");
        let mut rest = self.0.as_slice();
        while !rest.is_empty() {
            let (valid, next) = match std::str::from_utf8(rest) {
                Ok(text) => (text, rest.len()),
                Err(error) => (
                    std::str::from_utf8(&rest[..error.valid_up_to()]).unwrap(),
                    error.valid_up_to(),
                ),
            };
            let quoted = serde_json::to_string(valid).unwrap();
            result.push_str(&quoted[1..quoted.len() - 1]);
            rest = &rest[next..];
            if !rest.is_empty() {
                // Only the byte-string JSON deserializer constructs non-UTF-8
                // strings, and its sole non-scalar output is a WTF-8 surrogate.
                let unit = ((rest[0] as u16 & 15) << 12)
                    | ((rest[1] as u16 & 63) << 6)
                    | (rest[2] as u16 & 63);
                use std::fmt::Write;
                write!(result, "\\u{unit:04x}").unwrap();
                rest = &rest[3..];
            }
        }
        result.push('"');
        result
    }
}

impl<'de> Deserialize<'de> for JsString {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        struct Bytes;
        impl Visitor<'_> for Bytes {
            type Value = JsString;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON string")
            }
            fn visit_bytes<E: serde::de::Error>(self, bytes: &[u8]) -> Result<JsString, E> {
                let mut rest = bytes;
                while let Err(error) = std::str::from_utf8(rest) {
                    rest = &rest[error.valid_up_to()..];
                    if rest.len() < 3
                        || rest[0] != 0xed
                        || !(0xa0..=0xbf).contains(&rest[1])
                        || !(0x80..=0xbf).contains(&rest[2])
                    {
                        return Err(E::custom("invalid WTF-8 string"));
                    }
                    rest = &rest[3..];
                }
                Ok(JsString(bytes.to_vec()))
            }
        }
        de.deserialize_bytes(Bytes)
    }
}

impl Serialize for JsString {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let Some(text) = self.as_str() {
            return serializer.serialize_str(text);
        }
        RawValue::from_string(self.json())
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }
}

impl ToSql for JsString {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(&self.0)))
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Object(BTreeMap<JsString, Value>);

impl Object {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key.as_bytes())
    }
    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.keys().filter_map(JsString::as_str)
    }
    pub fn text(&self, key: &str) -> crate::ApiResult<JsString> {
        match self.get(key) {
            Some(Value::String(text)) if !text.is_empty() => Ok(text.clone()),
            _ => Err(crate::ApiError::INVALID_INPUT),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(Number),
    String(JsString),
    Array(Vec<Value>),
    Object(Object),
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        if let Self::String(text) = self {
            text.as_str()
        } else {
            None
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Self::Bool(v) = self {
            Some(*v)
        } else {
            None
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        if let Self::Number(v) = self {
            v.as_i64()
        } else {
            None
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        if let Self::Number(v) = self {
            v.as_f64()
        } else {
            None
        }
    }
    pub fn as_array(&self) -> Option<&Vec<Value>> {
        if let Self::Array(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn is_boolean(&self) -> bool {
        matches!(self, Self::Bool(_))
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
    pub fn is_string(&self) -> bool {
        matches!(self, Self::String(_))
    }

    fn from_raw(raw: &RawValue, depth: usize) -> serde_json::Result<Self> {
        if depth >= 128 {
            return Err(<serde_json::Error as serde::de::Error>::custom(
                "JSON nesting limit",
            ));
        }
        let text = raw.get().trim_start();
        Ok(match text.as_bytes()[0] {
            b'"' => Self::String(serde_json::from_str(text)?),
            b'[' => Self::Array(
                serde_json::from_str::<Vec<Box<RawValue>>>(text)?
                    .iter()
                    .map(|value| Self::from_raw(value, depth + 1))
                    .collect::<Result<_, _>>()?,
            ),
            b'{' => {
                let raw: BTreeMap<JsString, Box<RawValue>> = serde_json::from_str(text)?;
                Self::Object(Object(
                    raw.into_iter()
                        .map(|(key, value)| Ok((key, Self::from_raw(&value, depth + 1)?)))
                        .collect::<serde_json::Result<_>>()?,
                ))
            }
            _ => match serde_json::from_str(text)? {
                serde_json::Value::Null => Self::Null,
                serde_json::Value::Bool(v) => Self::Bool(v),
                serde_json::Value::Number(v) => Self::Number(v),
                _ => unreachable!("RawValue is validated JSON"),
            },
        })
    }
}

pub fn parse(text: &str) -> serde_json::Result<Object> {
    let raw: Box<RawValue> = serde_json::from_str(text)?;
    match Value::from_raw(&raw, 0)? {
        Value::Object(object) => Ok(object),
        _ => Err(<serde_json::Error as serde::de::Error>::custom(
            "expected JSON object",
        )),
    }
}

#[derive(Serialize)]
pub struct ItemResponse {
    pub item: crate::db::Item,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_keys_and_sqlite_have_distinct_boundaries() {
        let input = parse(r#"{"text":"a\ud800b","text\ud800":1,"text�":2,"\ue000":3,"ignored":{"\udc00":"\ud800"}}"#).unwrap();
        let text = input.text("text").unwrap();
        assert_eq!(text.len(), 5);
        assert_eq!(serde_json::to_string(&text).unwrap(), r#""a\ud800b""#);
        assert_eq!(input.0.len(), 5);
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute("CREATE TABLE t(text TEXT)", []).unwrap();
        db.execute("INSERT INTO t VALUES (?)", [&text]).unwrap();
        let row = db
            .query_row("SELECT hex(text), typeof(text), text FROM t", [], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    String::from_utf8_lossy(row.get_ref(2)?.as_bytes()?).into_owned(),
                ))
            })
            .unwrap();
        assert_eq!(row, ("61EDA08062".into(), "text".into(), "a���b".into()));
    }

    #[test]
    fn syntax_duplicates_numbers_and_escaping() {
        for raw in [
            r#"{"text":"\ud800","te\u0078t":"last"}"#,
            r#"{"text":"last","\ud800":null}"#,
        ] {
            assert_eq!(
                parse(raw).unwrap().text("text").unwrap().as_str(),
                Some("last")
            );
        }
        for raw in [r#"{"text":"\ud83d\ude00"}"#, r#"{"text":"😀"}"#] {
            assert_eq!(
                parse(raw).unwrap().text("text").unwrap().as_str(),
                Some("😀")
            );
        }
        let input =
            parse(r#"{"text":"\\ud800\ue000�","x":1e400,"nested":[{"\ud800":"\udc00"}]}"#).unwrap();
        assert_eq!(
            input.text("text").unwrap().as_str(),
            Some("\\ud800\u{e000}�")
        );
        for invalid in [
            r#"{"text":"\ud800\q"}"#,
            r#"{"text":"\ud800\uZZZZ"}"#,
            r#"{"text":"\ud800","text":"last",}"#,
            r#"{"x":01}"#,
            "{}{}",
            "null",
            "[]",
        ] {
            assert!(parse(invalid).is_err(), "{invalid}");
        }
        assert!(serde_json::from_slice::<JsString>(b"\"\xff\"").is_err());
        assert!(
            parse(&format!(
                "{{\"nested\":{}{}}}",
                "[".repeat(130),
                "]".repeat(130)
            ))
            .is_err()
        );
    }
}
