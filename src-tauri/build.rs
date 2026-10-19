#[path = "src/licensing_config.rs"]
mod licensing_config;

fn main() {
    println!("cargo:rustc-check-cfg=cfg(pharma_security_release)");
    println!("cargo:rustc-check-cfg=cfg(pharma_strict_renderer_sql_qa)");
    println!("cargo:rerun-if-env-changed=PHARMA_STRICT_RENDERER_SQL_QA");
    // Test-only optimized debug binaries can exercise the *same* fail-closed
    // renderer SQL boundary as release without requiring release TPM/signing
    // infrastructure. This must never weaken the production release gate.
    if std::env::var("PHARMA_STRICT_RENDERER_SQL_QA").as_deref() == Ok("1") {
        println!("cargo:rustc-cfg=pharma_strict_renderer_sql_qa");
    }
    // A release with no pinned issuer public key would permanently deny every
    // legitimate activation. Fail the build rather than ship an unusable app.
    println!("cargo:rerun-if-env-changed=PHARMA_LICENSE_VERIFY_KEY_B64");
    println!("cargo:rerun-if-env-changed=PHARMA_LICENSE_DEVICE_MODE");
    println!("cargo:rerun-if-env-changed=PHARMA_LICENSE_AUTHORITY_URL");
    println!("cargo:rerun-if-env-changed=PHARMA_LICENSE_OFFLINE_ONLY");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        // Cargo profile, rather than debug_assertions, controls the fail-closed
        // IPC SQL boundary. Release with debug symbols/assertions stays strict.
        println!("cargo:rustc-cfg=pharma_security_release");
        if std::env::var("PHARMA_LICENSE_DEVICE_MODE").as_deref() != Ok("tpm-v2") {
            panic!("Release must explicitly use PHARMA_LICENSE_DEVICE_MODE=tpm-v2; legacy MachineGuid-only binding is restricted to debug/QA builds. A real Windows TPM and device reassignment workflow are required");
        }
        let offline_only = std::env::var("PHARMA_LICENSE_OFFLINE_ONLY").as_deref() == Ok("1");
        if offline_only {
            // A reviewed manual-offline release needs no Azure endpoint. The
            // client has no outbound authority URL to contact; issuance still
            // requires the separately held commercial signing key.
            if std::env::var("PHARMA_LICENSE_AUTHORITY_URL")
                .ok().is_some_and(|value| !value.trim().is_empty())
            {
                panic!("An offline-only release must not embed an online licensing authority URL");
            }
        } else {
            let endpoint = std::env::var("PHARMA_LICENSE_AUTHORITY_URL")
                .expect("Online release requires an operator-approved HTTPS license authority URL; use PHARMA_LICENSE_OFFLINE_ONLY=1 for reviewed offline issuance");
            licensing_config::authority_endpoint(Some(&endpoint))
                .expect("License authority URL must be an explicit HTTPS origin without credentials, path, query or fragment; never transmit customer codes over HTTP");
        }
        let key = std::env::var("PHARMA_LICENSE_VERIFY_KEY_B64")
            .expect("Release requires PHARMA_LICENSE_VERIFY_KEY_B64, the 32-byte raw Ed25519 PUBLIC key encoded as base64url without padding");
        licensing_config::verification_key(&key)
            .expect("Release verification key must be an unpadded base64url Ed25519 public key; never embed a private signing key");
        // The Stage 2 QA tool intentionally publishes this reproducible test
        // key. Shipping a release pinned to it would let anyone forge a license.
        if key == "QwRr_kCSs-lJlOraFdzCDYqqB7ZY_TlU644O-4vcpd4" {
            panic!("Release issuer public key matches the publicly known QA test key; configure a separate private production issuer");
        }
        // Publicly served by our Azure for Students EDUCATIONAL-only authority.
        // Its production-shaped DNS name does not make its signer commercial.
        if key == "1P_GZRtjQCUNkm9sDQrS6w8RInIVdus9Y_y2tC6BCRg" {
            panic!("Release issuer public key matches the educational Azure test signer; a separate approved commercial issuer is required");
        }
    }
    tauri_build::build()
}
