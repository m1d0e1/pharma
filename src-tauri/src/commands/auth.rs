use bcrypt::{hash, verify, DEFAULT_COST};

#[tauri::command]
pub fn bcrypt_hash(password: String) -> Result<String, String> {
    hash(password, DEFAULT_COST).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bcrypt_compare(password: String, hash: String) -> Result<bool, String> {
    verify(password, &hash).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bcrypt_hash_produces_valid_hash() {
        let result = bcrypt_hash("test_password123".into());
        assert!(result.is_ok());
        let hash_str = result.unwrap();
        assert!(hash_str.starts_with("$2b$"));
        assert!(hash_str.len() >= 50);
    }

    #[test]
    fn test_bcrypt_compare_correct_password() {
        let password = "securePass!42".to_string();
        let hash_str = bcrypt_hash(password.clone()).unwrap();
        let result = bcrypt_compare(password, hash_str).unwrap();
        assert!(result);
    }

    #[test]
    fn test_bcrypt_compare_wrong_password() {
        let hash_str = bcrypt_hash("real_password".into()).unwrap();
        let result = bcrypt_compare("wrong_password".into(), hash_str).unwrap();
        assert!(!result);
    }

    #[test]
    fn test_bcrypt_compare_invalid_hash() {
        let result = bcrypt_compare("password".into(), "not_a_valid_hash".into());
        assert!(result.is_err());
    }

    #[test]
    fn test_bcrypt_compare_empty_password() {
        let hash_str = bcrypt_hash("".into()).unwrap();
        let result = bcrypt_compare("".into(), hash_str.clone()).unwrap();
        assert!(result);
        let wrong = bcrypt_compare("x".into(), hash_str).unwrap();
        assert!(!wrong);
    }

    #[test]
    fn test_bcrypt_hash_different_each_time() {
        let a = bcrypt_hash("same".into()).unwrap();
        let b = bcrypt_hash("same".into()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn test_bcrypt_cost_stays_reasonable() {
        let start = std::time::Instant::now();
        bcrypt_hash("perf_test".into()).unwrap();
        let elapsed = start.elapsed();
        // bcrypt cost ~10-12 takes 50-800ms on modern hardware
        assert!(elapsed.as_millis() < 5000);
    }
}
