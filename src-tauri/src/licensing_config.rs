//! Compile-time and runtime licensing configuration use identical parsers.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use url::Url;

pub fn authority_endpoint(raw: Option<&str>) -> Result<Url, String> {
    let base = raw.ok_or("Online licensing authority URL is not configured in this application")?;
    let origin = Url::parse(base).map_err(|_| "Configured online license authority URL is invalid")?;
    if origin.scheme() != "https"
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
    {
        return Err("Online license authority must be an HTTPS origin with no credentials, path, query or fragment".into());
    }
    origin.join("v1/activate").map_err(|_| "Cannot construct license activation endpoint".into())
}

pub fn verification_key(value: &str) -> Result<Vec<u8>, String> {
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| "Invalid embedded verification public key")?;
    if bytes.len() != 32 {
        return Err("Embedded Ed25519 verification key has invalid length".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_malformed_origins_and_noncanonical_keys() {
        for raw in ["https://:443", "https://example.com:abc", "http://example.com", "https://user@example.com", "https://example.com/path", "https://example.com/?q=1"] {
            assert!(authority_endpoint(Some(raw)).is_err(), "{raw}");
        }
        assert_eq!(authority_endpoint(Some("https://example.com/")).unwrap().as_str(), "https://example.com/v1/activate");
        assert!(verification_key(&"_".repeat(43)).is_err());
        assert!(verification_key(&URL_SAFE_NO_PAD.encode([0u8; 31])).is_err());
        assert_eq!(verification_key(&URL_SAFE_NO_PAD.encode([7u8; 32])).unwrap(), vec![7u8; 32]);
    }
}
