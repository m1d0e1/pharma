"""GUI login launcher; unwraps ONLY the new DPAPI-sealed disposable QA password."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess

from scripts.qa_lifecycle_bootstrap import load_approved_qa_credential


def main() -> None:
    secret = load_approved_qa_credential()
    result = subprocess.run(
        ['node', str(Path(__file__).with_name('qa_lifecycle_gui_login.js'))],
        input=json.dumps(secret), capture_output=True, text=True, timeout=30,
        cwd=Path(__file__).resolve().parents[1],
    )
    if result.returncode != 0:
        # Do not echo the JavaScript exception if it contains credential text.
        raise RuntimeError('Reviewed lifecycle QA GUI login failed; no financial mutation attempted')
    print(result.stdout, end='')


if __name__ == '__main__':
    main()
