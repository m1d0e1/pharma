"""Inspect only the already-running pinned synthetic QA WebView purchase nonce.

No purchase is submitted/retried, no native finance IPC is called, and no
nonce, credential, invoice content or payload fingerprint is printed.
"""
from __future__ import annotations

import json
import sys

from scripts.qa_v02110_authenticated_synthetic_windows_gui import custody
from scripts.qa_legacy_windows_gui_followon import ReadOnlyCdp


def check(pid: int) -> dict:
    endpoint = custody(pid)
    cdp = ReadOnlyCdp(endpoint)
    try:
        result = cdp.evaluate(
            """(() => {
              const keys = Object.keys(sessionStorage).filter(
                k => k.endsWith(':pending-native-create-v1'));
              return {
                route: location.pathname,
                intentCount: keys.length,
                intents: keys.map(key => {
                  let value;
                  try { value = JSON.parse(sessionStorage.getItem(key)); } catch { value = null; }
                  return {
                    syntheticScope: key.includes('qa_positive_20261018') &&
                      key.includes('qa_positive_owner_20261018'),
                    hasOriginalRequestIdentity: typeof value?.requestId === 'string' &&
                      typeof value?.fingerprint === 'string'
                  };
                })
              };
            })()"""
        )
        if not isinstance(result, dict) or result.get("intentCount", 0) > 1:
            raise RuntimeError("Ambiguous purchase creation identity")
        if any(not item.get("syntheticScope") or not item.get("hasOriginalRequestIdentity")
               for item in result["intents"]):
            raise RuntimeError("Purchase nonce is corrupt or not synthetic-scoped")
        if custody(pid) != endpoint:
            raise RuntimeError("WebView process changed during read-only observation")
        result["originalNonceOrFingerprintDisclosed"] = False
        result["purchaseSubmitted"] = False
        return result
    finally:
        cdp.close()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or not sys.argv[1].isdigit():
            raise RuntimeError("Exact pinned synthetic GUI PID required")
        print(json.dumps(check(int(sys.argv[1])), sort_keys=True))
    except (ValueError, RuntimeError, OSError):
        print("Synthetic QA purchase intent read-only check refused", file=sys.stderr)
        raise SystemExit(2)
