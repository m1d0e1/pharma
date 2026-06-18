use bcrypt::{hash, verify};

#[tauri::command]
pub fn bcrypt_hash(password: String) -> Result<String, String> {
    // cost of 12 matches the SALT_ROUNDS in the Next.js TypeScript side
    hash(password, 12).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bcrypt_compare(password: String, hash: String) -> Result<bool, String> {
    verify(password, &hash).map_err(|e| e.to_string())
}
