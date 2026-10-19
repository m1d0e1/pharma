"""Pinned read-only WebView2 five-route negative test of final postseed QA build.

Never uses customer credentials, business IPC, original profile or license grant.
Do not pass a different executable path, SHA, app identifier, or debug port.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

from scripts import qa_v02110_fresh_guarded_real_windows_gui as negative


negative.APP_ID = "com.pharma.disposable.postseedqa20261018"
negative.QA_EXE = Path(
    r"D:\PhD\Tools\pharma-builds\v02110-postseed-guarded-a29750f69cf84219b123e21f3843424d"
    r"\Pharma-0.2.110-POSTSEED-GUARDED-QA-only.exe"
)
negative.QA_SHA = "5dc73771cad80dfd8fca41c2228072581e358c2d4db724b8a85bcdb8d176b6a5"
negative.PORT = 9344


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or not sys.argv[1].isdigit():
            raise RuntimeError("Exact pinned postseed QA process ID required")
        manifest = json.loads(
            (negative.QA_EXE.parent / "QA_ONLY_RELEASE_BLOCKED.json").read_text(encoding="utf-8-sig")
        )
        if (manifest.get("appId") != negative.APP_ID
                or manifest.get("executableSha256", "").lower() != negative.QA_SHA
                or manifest.get("nativeAccountSeedSchemaSha256") !=
                "17B88E160EB7310B552BEFA582B7ED3DD0EB1274028FB8D4AF0BDFA3D71E1791"
                or manifest.get("historyCustodyApproved") is not False):
            raise RuntimeError("Retained postseed binary/source provenance is not pinned")
        result = negative.check(int(sys.argv[1]))
        result["latest_rust_seed_fix_in_build"] = True
        print(json.dumps(result, sort_keys=True))
    except (RuntimeError, ValueError, OSError) as error:
        print("Postseed actual Windows negative GUI REFUSED: " + str(error), file=sys.stderr)
        raise SystemExit(2)
