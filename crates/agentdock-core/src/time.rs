//! `Timestamp`: RFC 3339 UTC with exactly three fractional digits and a `Z` suffix
//! (`2026-11-17T02:00:07.000Z`), the only timestamp form the contracts allow.

use std::fmt;

use ::time::{macros::format_description, OffsetDateTime, PrimitiveDateTime};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The text is not `YYYY-MM-DDTHH:MM:SS.mmmZ` of a real calendar date and time.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("invalid timestamp (want YYYY-MM-DDTHH:MM:SS.mmmZ): {value:?}")]
pub struct TimestampError {
    pub value: String,
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` is always exactly this many bytes.
const TIMESTAMP_LEN: usize = 24;

/// A UTC instant truncated to milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(OffsetDateTime);

impl Timestamp {
    /// The current time; the sub-millisecond part is dropped.
    pub fn now() -> Self {
        let now = OffsetDateTime::now_utc();
        let millis_only = (now.nanosecond() / 1_000_000) * 1_000_000;
        // `millis_only` is below 1e9, so this cannot fail; falling back to `now` keeps the
        // function total without a panic path.
        Self(now.replace_nanosecond(millis_only).unwrap_or(now))
    }

    /// Parses exactly `YYYY-MM-DDTHH:MM:SS.mmmZ`. Other precisions, offsets (`+00:00`),
    /// lowercase `t`/`z`, surrounding whitespace and impossible dates (such as February 30) fail.
    pub fn parse(s: &str) -> Result<Self, TimestampError> {
        let err = || TimestampError {
            value: s.to_owned(),
        };
        let b = s.as_bytes();
        // Shape first: fixed length, fixed separators, digits everywhere else. This keeps the
        // accepted language identical to the schema pattern whatever `time` is lenient about
        // (signs, padding, ...).
        if b.len() != TIMESTAMP_LEN {
            return Err(err());
        }
        let shape_ok = b.iter().enumerate().all(|(i, &c)| match i {
            4 | 7 => c == b'-',
            10 => c == b'T',
            13 | 16 => c == b':',
            19 => c == b'.',
            23 => c == b'Z',
            _ => c.is_ascii_digit(),
        });
        if !shape_ok {
            return Err(err());
        }
        let format = format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        );
        let parsed = PrimitiveDateTime::parse(s, &format).map_err(|_| err())?;
        Ok(Self(parsed.assume_utc()))
    }

    /// `YYYY-MM-DDTHH:MM:SS.mmmZ`.
    pub fn to_rfc3339_millis(&self) -> String {
        let t = &self.0;
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            t.year(),
            u8::from(t.month()),
            t.day(),
            t.hour(),
            t.minute(),
            t.second(),
            t.millisecond()
        )
    }

    /// Milliseconds since the Unix epoch.
    pub fn unix_millis(&self) -> i128 {
        self.0.unix_timestamp_nanos().div_euclid(1_000_000)
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_rfc3339_millis())
    }
}

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_rfc3339_millis())
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Self::parse(&s).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_roundtrips_contract_example() {
        let t = Timestamp::parse("2026-11-17T02:00:07.123Z").unwrap();
        assert_eq!(t.to_rfc3339_millis(), "2026-11-17T02:00:07.123Z");
        assert_eq!(t.to_string(), "2026-11-17T02:00:07.123Z");
        assert_eq!(t.unix_millis(), 1_794_880_807_123);
    }

    #[test]
    fn timestamp_rejects_impossible_date() {
        // contract mutation e7_impossible_date
        for bad in [
            "2026-02-30T00:00:00.000Z",
            "2026-13-01T00:00:00.000Z",
            "2026-00-10T00:00:00.000Z",
            "2026-11-31T00:00:00.000Z",
            "2026-11-17T24:00:00.000Z",
            "2026-11-17T23:60:00.000Z",
            "2026-11-17T23:59:60.000Z",
        ] {
            assert!(Timestamp::parse(bad).is_err(), "{bad}");
        }
        assert!(Timestamp::parse("2028-02-29T00:00:00.000Z").is_ok());
        assert!(Timestamp::parse("2027-02-29T00:00:00.000Z").is_err());
    }

    #[test]
    fn timestamp_rejects_wrong_precision() {
        for bad in [
            "2026-11-17T02:00:07Z",
            "2026-11-17T02:00:07.0000Z",
            "2026-11-17T02:00:07.00Z",
            "2026-11-17T02:00:07.000+00:00",
            "2026-11-17T02:00:07.000z",
            "2026-11-17t02:00:07.000Z",
            "2026-11-17 02:00:07.000Z",
            "2026-11-17T02:00:07.000Z\n",
            " 2026-11-17T02:00:07.000Z",
            "+026-11-17T02:00:07.000Z",
            "2026-11-17T02:00:07,000Z",
            "２０２６-11-17T02:00:07.000Z",
            "",
        ] {
            assert!(Timestamp::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn timestamp_now_has_millis_only() {
        let now = Timestamp::now();
        let text = now.to_rfc3339_millis();
        assert_eq!(text.len(), 24);
        assert_eq!(Timestamp::parse(&text).unwrap(), now);
        assert_eq!(now.0.nanosecond() % 1_000_000, 0);
        let json = serde_json::to_string(&now).unwrap();
        assert_eq!(json.len(), 26);
    }

    #[test]
    fn timestamps_order_by_instant() {
        let a = Timestamp::parse("2026-11-17T02:00:07.000Z").unwrap();
        let b = Timestamp::parse("2026-11-17T02:00:07.001Z").unwrap();
        assert!(a < b);
        assert_eq!(b.unix_millis() - a.unix_millis(), 1);
    }

    #[test]
    fn year_zero_and_epoch_edges() {
        let epoch = Timestamp::parse("1970-01-01T00:00:00.000Z").unwrap();
        assert_eq!(epoch.unix_millis(), 0);
        let before = Timestamp::parse("1969-12-31T23:59:59.999Z").unwrap();
        assert_eq!(before.unix_millis(), -1);
        assert_eq!(before.to_rfc3339_millis(), "1969-12-31T23:59:59.999Z");
        let first = Timestamp::parse("0001-01-01T00:00:00.000Z").unwrap();
        assert_eq!(first.to_rfc3339_millis(), "0001-01-01T00:00:00.000Z");
    }

    #[test]
    fn serde_uses_the_string_form() {
        let t: Timestamp = serde_json::from_str("\"2026-11-17T02:00:07.000Z\"").unwrap();
        assert_eq!(
            serde_json::to_string(&t).unwrap(),
            "\"2026-11-17T02:00:07.000Z\""
        );
        assert!(serde_json::from_str::<Timestamp>("\"2026-02-30T00:00:00.000Z\"").is_err());
        assert!(serde_json::from_str::<Timestamp>("1").is_err());
    }
}
