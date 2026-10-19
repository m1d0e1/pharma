//! Optional HTTPS activation/renewal client. No secrets in JS except the
//! initial operator-delivered code typed into the activation UI; persistent
//! credentials are encrypted using Windows user-bound DPAPI by LicenseGuard.
//! The server origin is COMPILED in, never renderer-chosen.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::FutureExt;
use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    panic::AssertUnwindSafe,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tokio::sync::{watch, Mutex};

use crate::licensing::{LicenseGuard, LicenseStatus};
use crate::licensing_config::authority_endpoint;

const AUTHORITY_URL: Option<&str> = option_env!("PHARMA_LICENSE_AUTHORITY_URL");
const MAX_RESPONSE_BYTES: usize = 32 * 1024;
const RENEW_WHEN_REMAINING_SECONDS: i64 = 6 * 3600;
// Applies to every successful online activation/renewal, including the watcher.
// Use monotonic time so changing the Windows clock cannot bypass the throttle.
const SUCCESS_COOLDOWN: Duration = Duration::from_secs(5 * 60);

type CredentialKey = [u8; 32];
type SharedResult = Option<Result<(), String>>;

#[derive(Default)]
struct OnlineRequestState {
    running: Option<(CredentialKey, watch::Receiver<SharedResult>)>,
    last_success: Option<(CredentialKey, Instant)>,
}

#[derive(Default)]
struct OnlineRequestGate {
    state: Mutex<OnlineRequestState>,
}

static ONLINE_REQUEST_GATE: OnceLock<Arc<OnlineRequestGate>> = OnceLock::new();

fn request_gate() -> Arc<OnlineRequestGate> {
    ONLINE_REQUEST_GATE
        .get_or_init(|| Arc::new(OnlineRequestGate::default()))
        .clone()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RenewalCredential {
    license_id: String,
    machine_fingerprint: String,
    activation_code: String,
}

fn credential_key(credential: &RenewalCredential) -> CredentialKey {
    // Store no plaintext activation code in the process-wide gate. The issuer
    // code is 256 bits of randomness; a SHA-256 digest only identifies callers
    // of the same credential for in-flight result sharing.
    let mut hash = Sha256::new();
    hash.update(credential.license_id.as_bytes());
    hash.update(b"\0");
    hash.update(credential.machine_fingerprint.as_bytes());
    hash.update(b"\0");
    hash.update(credential.activation_code.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&hash.finalize());
    key
}

async fn run_coalesced_request<F>(
    gate: Arc<OnlineRequestGate>,
    key: CredentialKey,
    cooldown: Duration,
    lease_valid: bool,
    request: F,
) -> Result<(), String>
where
    F: Future<Output = Result<(), String>> + Send + 'static,
{
    let mut receiver = {
        let mut state = gate.state.lock().await;
        if let Some((active_key, running)) = &state.running {
            if active_key != &key {
                return Err("Another online licensing request is already in progress".into());
            }
            // Concurrent requests for the same credential receive one signed
            // result, rather than issuing separate requests to the authority.
            running.clone()
        } else {
            if let Some((previous_key, finished_at)) = state.last_success {
                if finished_at.elapsed() < cooldown && (previous_key != key || lease_valid) {
                    return if previous_key == key {
                        Ok(())
                    } else {
                        Err(
                            "A license was activated or renewed recently; retry after the cooldown"
                                .into(),
                        )
                    };
                }
            }
            let (sender, receiver) = watch::channel::<SharedResult>(None);
            state.running = Some((key, receiver.clone()));
            let task_gate = Arc::clone(&gate);
            // The request is owned by the runtime, not by one IPC caller. A
            // window close or cancelled renderer future cannot abandon an
            // in-flight POST and immediately permit its duplicate.
            tokio::spawn(async move {
                let result = AssertUnwindSafe(request)
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| Err("Online licensing request failed unexpectedly".into()));
                let mut state = task_gate.state.lock().await;
                if result.is_ok() {
                    state.last_success = Some((key, Instant::now()));
                }
                let _ = sender.send(Some(result));
                state.running = None;
            });
            receiver
        }
    };
    loop {
        let completed = receiver.borrow().clone();
        if let Some(result) = completed {
            return result;
        }
        receiver
            .changed()
            .await
            .map_err(|_| "Online licensing request ended without a result".to_string())?;
    }
}

fn validate_credential(credential: &RenewalCredential) -> Result<(), String> {
    if credential.license_id.len() < 6
        || credential.license_id.len() > 128
        || !credential
            .license_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || credential.activation_code.len() != 43
        || !credential
            .activation_code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || credential.machine_fingerprint.len() != 64
        || !credential
            .machine_fingerprint
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(
            "Online license identifier, activation code or machine identity is malformed".into(),
        );
    }
    Ok(())
}

async fn request_signed_lease(credential: &RenewalCredential) -> Result<String, String> {
    validate_credential(credential)?;
    let url = authority_endpoint(AUTHORITY_URL)?;
    // Prohibit redirects: a redirected POST would disclose the bearer code to
    // an unintended host. Default public WebPKI validation and hostname checks
    // remain enabled; do not add an insecure-cert-accepting QA exception.
    let client = Client::builder()
        .https_only(true)
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| "Cannot initialize secure licensing transport")?;
    let mut nonce = [0u8; 32];
    nonce[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    nonce[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Windows clock is invalid")?
        .as_secs() as i64;
    let response = client
        .post(url)
        .json(&json!({
            "license_id": credential.license_id,
            "activation_code": credential.activation_code,
            "machine_fingerprint": credential.machine_fingerprint,
            "request_nonce": URL_SAFE_NO_PAD.encode(nonce),
            "requested_at_utc": now,
        }))
        .send()
        .await
        .map_err(|_| "Secure licensing authority could not be reached")?;
    let status = response.status();
    if status.is_redirection() {
        return Err("License authority redirect was refused".into());
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
    {
        return Err("License authority response exceeds size limit".into());
    }
    let mut response = response;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "License authority response could not be read")?
    {
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(body.len()) {
            return Err("License authority response exceeds size limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    let answer: Value =
        serde_json::from_slice(&body).map_err(|_| "License authority response is malformed")?;
    if !status.is_success() || answer.get("ok") != Some(&Value::Bool(true)) {
        // Do not expose untrusted server-controlled strings or bearer secrets.
        return Err(if status.as_u16() == 429 {
            "Too many activation attempts; try later"
        } else {
            "License authority rejected the activation request"
        }
        .into());
    }
    let signed = answer
        .get("result")
        .ok_or("License authority response has no signed lease")?;
    serde_json::to_string(signed).map_err(|_| "Signed lease response cannot be decoded".into())
}

async fn activate_with_credential(
    guard: &LicenseGuard,
    credential: &RenewalCredential,
    persist_secret: bool,
) -> Result<LicenseStatus, String> {
    validate_credential(credential)?;
    if credential.machine_fingerprint != guard.current_fingerprint()? {
        return Err("Renewal credential belongs to another computer".into());
    }
    let signed = request_signed_lease(credential).await?;
    // The Ed25519 issuer key, signed bound fingerprint, generation, expiry,
    // clock and revocation policy are verified by the same local native guard.
    guard.install_online(&signed, &credential.license_id)?;
    if persist_secret {
        guard.store_online_credential(
            &serde_json::to_vec(credential).map_err(|_| "Invalid credential serialization")?,
        )?;
    }
    Ok(guard.status())
}

async fn gated_activation(
    app: AppHandle,
    credential: RenewalCredential,
    persist_secret: bool,
) -> Result<LicenseStatus, String> {
    // Reject malformed or machine-mismatched input before joining an in-flight
    // request; never let a cached result authorize different credentials.
    validate_credential(&credential)?;
    {
        let guard = app.state::<LicenseGuard>();
        if credential.machine_fingerprint != guard.current_fingerprint()? {
            return Err("Renewal credential belongs to another computer".into());
        }
    }
    let key = credential_key(&credential);
    let work_app = app.clone();
    let work_credential = credential.clone();
    // An expired short lease must renew even inside the success cooldown.
    let lease_valid = app.state::<LicenseGuard>().status().valid;
    run_coalesced_request(request_gate(), key, SUCCESS_COOLDOWN, lease_valid, async move {
        let guard = work_app.state::<LicenseGuard>();
        let status = activate_with_credential(&guard, &work_credential, persist_secret).await?;
        if status.valid {
            Ok(())
        } else {
            Err(status.reason)
        }
    })
    .await?;
    // A result that was shared or cooled down must still pass the *live*
    // native signature, TPM, generation, clock and license-id checks. Neither
    // a cached success nor a Tauri window state is an authorization decision.
    let status = app.state::<LicenseGuard>().status();
    if !status.valid {
        return Err(status.reason);
    }
    if status.license_id.as_deref() != Some(credential.license_id.as_str()) {
        return Err("The installed license does not match the requested credential".into());
    }
    Ok(status)
}

#[tauri::command]
pub async fn license_activate_online(
    app: AppHandle,
    license_id: String,
    activation_code: String,
) -> Result<LicenseStatus, String> {
    let credential = RenewalCredential {
        license_id,
        activation_code,
        machine_fingerprint: app.state::<LicenseGuard>().current_fingerprint()?,
    };
    gated_activation(app, credential, true).await
}

#[tauri::command]
pub async fn license_renew_online(app: AppHandle) -> Result<LicenseStatus, String> {
    let raw = app.state::<LicenseGuard>().load_online_credential()?;
    let credential: RenewalCredential = serde_json::from_slice(&raw)
        .map_err(|_| "Stored online renewal credentials are malformed")?;
    gated_activation(app, credential, false).await
}

pub fn spawn_renewal_watcher(app: AppHandle) {
    if AUTHORITY_URL.is_none() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        loop {
            interval.tick().await;
            let guard = app.state::<LicenseGuard>();
            // A valid lease farther than six hours from expiry needs no
            // refresh. Absent/expired leases can retry after a network outage.
            let status = guard.status();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(i64::MAX);
            if status.valid
                && (status.offline_term || status.lease_until_utc.is_some_and(|deadline| {
                    deadline > now.saturating_add(RENEW_WHEN_REMAINING_SECONDS)
                }))
            {
                continue;
            }
            if let Ok(raw) = guard.load_online_credential() {
                if let Ok(credential) = serde_json::from_slice::<RenewalCredential>(&raw) {
                    // No secret or external response is logged. Normal license
                    // gate denies business IPC if renewal ultimately fails.
                    let _ = gated_activation(app.clone(), credential, false).await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::oneshot;

    fn fresh_gate() -> Arc<OnlineRequestGate> {
        Arc::new(OnlineRequestGate::default())
    }

    #[tokio::test]
    async fn expired_lease_renews_inside_cooldown_but_valid_lease_reuses_success() {
        let gate = fresh_gate();
        let key = [12u8; 32];
        let calls = Arc::new(AtomicUsize::new(0));
        for lease_valid in [true, true, false] {
            let calls = Arc::clone(&calls);
            run_coalesced_request(Arc::clone(&gate), key, SUCCESS_COOLDOWN, lease_valid, async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }).await.unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn concurrent_identical_renewals_share_one_request_and_cooldown() {
        let gate = fresh_gate();
        let key = [11u8; 32];
        let calls = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel::<()>();
        let first_calls = Arc::clone(&calls);
        let first_gate = Arc::clone(&gate);
        let first = tokio::spawn(async move {
            run_coalesced_request(first_gate, key, Duration::from_secs(300), true, async move {
                first_calls.fetch_add(1, Ordering::SeqCst);
                let _ = started_tx.send(());
                finish_rx
                    .await
                    .map_err(|_| "test worker was dropped".to_string())?;
                Ok(())
            })
            .await
        });
        started_rx.await.unwrap();
        let joined_calls = Arc::clone(&calls);
        let joined_gate = Arc::clone(&gate);
        let joined = tokio::spawn(async move {
            run_coalesced_request(joined_gate, key, Duration::from_secs(300), true, async move {
                joined_calls.fetch_add(1, Ordering::SeqCst);
                Err("A second HTTPS POST must never run".into())
            })
            .await
        });
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        finish_tx.send(()).unwrap();
        assert!(first.await.unwrap().is_ok());
        assert!(joined.await.unwrap().is_ok());
        let cooled = run_coalesced_request(
            Arc::clone(&gate),
            key,
            Duration::from_secs(300),
            true,
            async move { panic!("cooldown must skip the network") },
        )
        .await;
        assert!(cooled.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn recent_success_blocks_other_credentials_until_monotonic_cooldown_ends() {
        let gate = fresh_gate();
        let first = [1u8; 32];
        let second = [2u8; 32];
        let cooldown = Duration::from_millis(25);
        assert!(
            run_coalesced_request(Arc::clone(&gate), first, cooldown, true, async { Ok(()) })
                .await
                .is_ok()
        );
        let blocked = run_coalesced_request(Arc::clone(&gate), second, cooldown, false, async {
            panic!("different credentials cannot bypass cooldown")
        })
        .await;
        assert!(blocked.unwrap_err().contains("cooldown"));
        tokio::time::sleep(Duration::from_millis(35)).await;
        assert!(
            run_coalesced_request(Arc::clone(&gate), second, cooldown, true, async { Ok(()) })
                .await
                .is_ok()
        );
        // The global cooldown now applies to the earlier credential, too.
        let blocked_again = run_coalesced_request(gate, first, cooldown, true, async {
            panic!("earlier credentials must also be throttled")
        })
        .await;
        assert!(blocked_again.unwrap_err().contains("cooldown"));
    }

    #[tokio::test]
    async fn different_credentials_cannot_join_an_unrelated_inflight_request() {
        let gate = fresh_gate();
        let (started_tx, started_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel::<()>();
        let first_gate = Arc::clone(&gate);
        let first = tokio::spawn(async move {
            run_coalesced_request(first_gate, [3u8; 32], Duration::from_secs(30), true, async move {
                let _ = started_tx.send(());
                finish_rx
                    .await
                    .map_err(|_| "test worker was dropped".to_string())
            })
            .await
        });
        started_rx.await.unwrap();
        let rejected = run_coalesced_request(
            Arc::clone(&gate),
            [4u8; 32],
            Duration::from_secs(30),
            false,
            async { panic!("different credential may not start a competing request") },
        )
        .await;
        assert!(rejected.unwrap_err().contains("already in progress"));
        finish_tx.send(()).unwrap();
        assert!(first.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn failed_request_does_not_start_a_success_cooldown() {
        let gate = fresh_gate();
        let key = [5u8; 32];
        let failed =
            run_coalesced_request(Arc::clone(&gate), key, Duration::from_secs(300), true, async {
                Err("synthetic network outage".to_string())
            })
            .await;
        assert_eq!(failed.unwrap_err(), "synthetic network outage");
        assert!(
            run_coalesced_request(Arc::clone(&gate), key, Duration::from_secs(300), true, async {
                Ok(())
            })
            .await
            .is_ok()
        );
    }

    #[tokio::test]
    async fn cancelled_ipc_waiter_cannot_cancel_or_duplicate_issuer_request() {
        let gate = fresh_gate();
        let key = [6u8; 32];
        let calls = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel::<()>();
        let first_gate = Arc::clone(&gate);
        let first_calls = Arc::clone(&calls);
        let caller = tokio::spawn(async move {
            run_coalesced_request(first_gate, key, Duration::from_secs(300), true, async move {
                first_calls.fetch_add(1, Ordering::SeqCst);
                let _ = started_tx.send(());
                finish_rx
                    .await
                    .map_err(|_| "test worker was dropped".to_string())
            })
            .await
        });
        started_rx.await.unwrap();
        caller.abort(); // Simulate renderer window closing during HTTPS.
        let next_calls = Arc::clone(&calls);
        let next_gate = Arc::clone(&gate);
        let next = tokio::spawn(async move {
            run_coalesced_request(next_gate, key, Duration::from_secs(300), true, async move {
                next_calls.fetch_add(1, Ordering::SeqCst);
                Err("cancellation must not trigger another POST".into())
            })
            .await
        });
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        finish_tx.send(()).unwrap();
        assert!(next.await.unwrap().is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn panic_in_owned_request_releases_gate_without_caching_success() {
        let gate = fresh_gate();
        let key = [7u8; 32];
        let failed =
            run_coalesced_request(Arc::clone(&gate), key, Duration::from_secs(300), true, async {
                panic!("synthetic worker panic")
            })
            .await;
        assert!(failed.unwrap_err().contains("failed unexpectedly"));
        assert!(
            run_coalesced_request(gate, key, Duration::from_secs(300), true, async { Ok(()) })
                .await
                .is_ok()
        );
    }

    #[test]
    fn credential_digest_changes_for_every_credential_field() {
        let credential = RenewalCredential {
            license_id: "license-qa".into(),
            machine_fingerprint: "a".repeat(64),
            activation_code: "_".repeat(43),
        };
        let original = credential_key(&credential);
        let mut changed = credential.clone();
        changed.activation_code = "A".repeat(43);
        assert_ne!(original, credential_key(&changed));
        changed = credential.clone();
        changed.license_id = "license-other".into();
        assert_ne!(original, credential_key(&changed));
        changed = credential.clone();
        changed.machine_fingerprint = "b".repeat(64);
        assert_ne!(original, credential_key(&changed));
    }

    #[test]
    fn authority_url_rejects_cleartext_redirectable_and_hostile_origins() {
        assert!(authority_endpoint(None).is_err());
        for invalid in [
            "http://example.com",
            "https://user:pw@example.com",
            "https://example.com/a",
            "https://example.com?token=secret",
            "https://example.com/#frag",
            "https://not a host",
        ] {
            assert!(authority_endpoint(Some(invalid)).is_err(), "{invalid}");
        }
        assert_eq!(
            authority_endpoint(Some("https://licenses.example.com/"))
                .unwrap()
                .as_str(),
            "https://licenses.example.com/v1/activate"
        );
    }
    #[test]
    fn renewal_credentials_are_shape_checked_before_any_network_use() {
        let mut c = RenewalCredential {
            license_id: "license-123".into(),
            machine_fingerprint: "a".repeat(64),
            activation_code: "_".repeat(43),
        };
        assert!(validate_credential(&c).is_ok());
        c.activation_code = "secret\nAuthorization: hacked".into();
        assert!(validate_credential(&c).is_err());
        c.activation_code = "_".repeat(43);
        c.license_id = "../bad".into();
        assert!(validate_credential(&c).is_err());
    }
}
