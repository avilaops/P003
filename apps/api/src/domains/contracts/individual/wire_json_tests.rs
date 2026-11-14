use super::*;
use serde_json::json;

#[test]
fn contract_wire_json_accepts_objects_and_rejects_duplicates_at_every_depth() {
    assert_eq!(
        parse(br#" {"a":[1,true,null,{"b":"value"}]} "#, 4096).unwrap(),
        json!({"a":[1,true,null,{"b":"value"}]})
    );
    for raw in [
        br#"{"x":1,"x":2}"#.as_slice(),
        br#"{"x":1,"\u0078":2}"#,
        br#"{"n":{"x":1,"x":2}}"#,
        br#"{"n":[{"x":1,"x":2}]}"#,
        br#"[]"#,
        br#"{"x":1}false"#,
        br#"{"x":NaN}"#,
        br#"{"x":1.0}"#,
        b"{}\xff",
    ] {
        assert!(parse(raw, 4096).is_err());
    }
    assert!(parse(b"{}", 1).is_err());
    assert!(parse(b"", 4096).is_err());
}

#[test]
fn contract_wire_json_depth_is_bounded_before_serde_parsing_and_ignores_quoted_braces() {
    let at_limit = format!("{{\"x\":{}0{}}}", "[".repeat(15), "]".repeat(15));
    let over = format!("{{\"x\":{}0{}}}", "[".repeat(16), "]".repeat(16));
    assert!(parse(at_limit.as_bytes(), 4096).is_ok());
    assert!(parse(over.as_bytes(), 4096).is_err());
    assert!(parse(br#"{"x":"[[[\"}]]]"}"#, 4096).is_ok());
}

#[test]
fn contract_wire_json_canonical_bytes_match_python_sorting_and_ascii_escaping() {
    let value = json!({"b":"ação\u{7f}😀","a":[null,true,1]});
    assert_eq!(
        canonical(&value).unwrap(),
        br#"{"a":[null,true,1],"b":"a\u00e7\u00e3o\u007f\ud83d\ude00"}"#
    );
    assert!(canonical(&json!({"x":1.0})).is_err());
    let raw = br#"{"z":18446744073709551615,"a":-9223372036854775808}"#;
    assert_eq!(
        canonical(&parse(raw, 4096).unwrap()).unwrap(),
        br#"{"a":-9223372036854775808,"z":18446744073709551615}"#
    );
}
