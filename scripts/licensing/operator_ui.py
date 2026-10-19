"""Local Windows GUI for the isolated Pharma QA issuer; NEVER a public admin API.

Run from project root: python -m scripts.licensing.operator_ui
No private signer, operator token, or activation code is served over HTTP.
"""
from __future__ import annotations

import io
import json
import re
import ssl
import tkinter as tk
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from tkinter import messagebox, ttk
from urllib.request import ProxyHandler, HTTPSHandler, build_opener

from . import local_qa

WINDOW_TITLE = "Pharma License Authority — LOCAL QA"
ACCENT = "#2563eb"
INK = "#152338"
SUBTLE = "#52657d"


def operator_command(*args: str) -> dict:
    """Call the existing security-validated CLI without exposing its output."""
    stdout, stderr = io.StringIO(), io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        code = local_qa.main(list(args))
    if code:
        # Error is not a credential or source traceback; the CLI sanitizes it.
        raise ValueError(stderr.getvalue().strip() or "QA operator request failed")
    return json.loads(stdout.getvalue())


def local_https_status() -> str:
    """Use default OS trust and hostname checks; no insecure TLS options."""
    opener = build_opener(ProxyHandler({}), HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(f"https://localhost:{local_qa.LOCAL_HTTPS_PORT}/v1/public-key", timeout=3) as result:
        answer = json.load(result)
    if answer.get("ok") is not True:
        raise ValueError("The HTTPS issuer did not return a verified public key")
    key = answer.get("result", {}).get("issuer_public_key_b64")
    if key != local_qa.issuer(local_qa.load()).issuer_public_key_b64:
        raise ValueError("The HTTPS issuer does not match this local QA signing key")
    return f"Online · https://localhost:{local_qa.LOCAL_HTTPS_PORT} · TLS verified"


class OperatorWindow:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title(WINDOW_TITLE)
        root.geometry("720x680")
        root.minsize(650, 640)
        root.configure(bg="#edf3fa")
        self._clipboard_secret: str | None = None
        self._clear_job: str | None = None

        header = tk.Frame(root, bg=INK, padx=24, pady=18)
        header.pack(fill="x")
        tk.Label(header, text="PHARMA  /  LICENSE AUTHORITY", fg="#a9c7fd", bg=INK,
                 font=("Segoe UI", 10, "bold"), anchor="w").pack(fill="x")
        tk.Label(header, text="Local activation control", fg="white", bg=INK,
                 font=("Segoe UI", 20, "bold"), anchor="w").pack(fill="x", pady=(4, 0))
        tk.Label(header, text="QA ONLY  •  This laptop  •  No customer or production license",
                 fg="#d3e1f5", bg=INK, font=("Segoe UI", 10), anchor="w").pack(fill="x", pady=(5, 0))

        main = tk.Frame(root, bg="#edf3fa", padx=24, pady=18)
        main.pack(fill="both", expand=True)

        server = tk.LabelFrame(main, text="  HTTPS activation server  ", bg="white", fg=INK,
                               font=("Segoe UI", 11, "bold"), padx=15, pady=12)
        server.pack(fill="x", pady=(0, 12))
        self.server_status = tk.StringVar(value="Checking secure localhost connection…")
        tk.Label(server, textvariable=self.server_status, bg="white", fg=SUBTLE,
                 font=("Segoe UI", 10), anchor="w").pack(fill="x", pady=(0, 8))
        self._button_row(server, [
            ("Check HTTPS", self.refresh),
            ("Start local server", self.start_server),
            ("Stop local server", self.stop_server),
        ])

        entitlement = tk.LabelFrame(main, text="  Test license  ", bg="white", fg=INK,
                                    font=("Segoe UI", 11, "bold"), padx=15, pady=12)
        entitlement.pack(fill="x", pady=(0, 12))
        self.license_status = tk.StringVar(value="Loading issuer state…")
        tk.Label(entitlement, textvariable=self.license_status, bg="white", fg=SUBTLE,
                 font=("Segoe UI", 10), justify="left", anchor="w", wraplength=600).pack(fill="x", pady=(0, 9))
        tk.Label(entitlement, text="Machine fingerprint (only for the very first QA license):",
                 bg="white", fg=SUBTLE, font=("Segoe UI", 9), anchor="w").pack(fill="x")
        self.fingerprint = ttk.Entry(entitlement, font=("Consolas", 10))
        self.fingerprint.pack(fill="x", pady=(4, 8))
        self._button_row(entitlement, [
            ("Issue first QA license", self.issue),
            ("Copy license ID", self.copy_id),
            ("Copy activation code", self.copy_activation),
        ])

        onboarding = tk.LabelFrame(main, text="  First-owner QA login  ", bg="white", fg=INK,
                                   font=("Segoe UI", 11, "bold"), padx=15, pady=12)
        onboarding.pack(fill="x", pady=(0, 10))
        tk.Label(onboarding, text="The same code is used for online activation and first-owner proof.",
                 bg="white", fg=SUBTLE, font=("Segoe UI", 9), anchor="w").pack(fill="x", pady=(0, 7))
        self._button_row(onboarding, [
            ("Copy QA owner password", self.copy_owner_password),
            ("Refresh status", self.refresh),
        ])

        self.notice = tk.StringVar(value="Private QA codes are never printed; copy them only to the isolated QA app.")
        tk.Label(main, textvariable=self.notice, fg=SUBTLE, bg="#edf3fa",
                 font=("Segoe UI", 9), wraplength=620, anchor="w", justify="left").pack(fill="x", pady=(4, 0))
        root.after(150, self.refresh)

    def _button_row(self, container, items):
        row = tk.Frame(container, bg="white")
        row.pack(fill="x")
        for index, (caption, handler) in enumerate(items):
            button = tk.Button(row, text=caption, command=lambda callback=handler: self._safe(callback),
                               font=("Segoe UI", 9, "bold"), fg="white" if index == 0 else INK,
                               bg=ACCENT if index == 0 else "#eaf0f9", activebackground="#b9d2f7",
                               activeforeground=INK, relief="flat", padx=13, pady=8, cursor="hand2")
            button.pack(side="left", padx=(0, 8))

    def _safe(self, callback):
        try:
            callback()
        except Exception as exc:
            self.notice.set("Operation failed. Check the QA server and your Windows user account.")
            messagebox.showerror("Local QA", str(exc), parent=self.root)

    def refresh(self):
        try:
            self.server_status.set(local_https_status())
        except Exception:
            self.server_status.set("Offline · Start the localhost HTTPS issuer to enable activation")
        record = operator_command("status")
        if record.get("state") == "not-issued":
            self.license_status.set("No test license yet · copy the fingerprint from Pharma HTTPS License QA")
        else:
            when = datetime.fromtimestamp(record["expires_at_utc"], tz=timezone.utc).strftime("%Y-%m-%d")
            self.license_status.set(f"{record['license_id']}\n"
                f"State: {record['state']}     Serial: {record['activation_serial']}"
                f"     Test term until: {when} UTC")

    def issue(self):
        value = self.fingerprint.get().strip()
        if not re.fullmatch(r"[a-f0-9]{64}", value):
            raise ValueError("Paste the exact 64-character lowercase fingerprint from the QA desktop")
        if not messagebox.askyesno("Confirm test issuance",
            "Issue one 7-day QA test license bound to this fingerprint?\n"
            "The signed license and activation code cannot be reset casually.",
            parent=self.root):
            return
        operator_command("grant", "--fingerprint", value)
        self.notice.set("Test license issued in the local DPAPI-backed operator account.")
        self.refresh()

    def copy(self, value: str, label: str):
        self.root.clipboard_clear()
        self.root.clipboard_append(value)
        self.root.update()
        self._clipboard_secret = value
        if self._clear_job is not None:
            self.root.after_cancel(self._clear_job)
        self._clear_job = self.root.after(45_000, self.clear_private_clipboard)
        self.notice.set(f"{label} copied to clipboard. Paste into Pharma HTTPS License QA; clipboard clears in 45 seconds.")

    def clear_private_clipboard(self):
        self._clear_job = None
        if self._clipboard_secret is not None:
            try:
                if self.root.clipboard_get() == self._clipboard_secret:
                    self.root.clipboard_clear()
            except tk.TclError:
                pass
            self._clipboard_secret = None

    def copy_id(self):
        self.copy(operator_command("online-credential")["license_id"], "License ID")

    def copy_activation(self):
        self.copy(operator_command("online-credential")["activation_code"], "QA activation code")

    def copy_owner_password(self):
        self.copy(operator_command("qa-owner-password")["qa_owner_password"], "QA owner password")

    def start_server(self):
        import subprocess
        from pathlib import Path
        root = Path(__file__).resolve().parents[2]
        script = root / "scripts" / "licensing" / "start-local-qa-https.ps1"
        # This script validates TLS trust, binds only loopback and refuses to
        # replace any existing listener. It never serves operator commands.
        result = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                                 "-File", str(script)], cwd=root,
                                capture_output=True, text=True, timeout=20,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode != 0:
            raise RuntimeError("QA server start failed; inspect the local start script and port 18765")
        self.refresh()

    def stop_server(self):
        import subprocess
        from pathlib import Path
        if not messagebox.askyesno("Stop QA issuer", "Stop localhost activation requests?\n"
                                   "The trusted test certificate remains installed until you remove it.",
                                   parent=self.root):
            return
        root = Path(__file__).resolve().parents[2]
        script = root / "scripts" / "licensing" / "stop-local-qa-https.ps1"
        result = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                                 "-File", str(script)], cwd=root,
                                capture_output=True, text=True, timeout=20,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode != 0:
            raise RuntimeError("Cannot safely identify the QA server process; not stopped")
        self.refresh()


def main():
    from os import environ
    if environ.get("PHARMA_SECURITY_RELEASE_APPROVED"):
        raise SystemExit("QA operator GUI must never run with a production release approval")
    # The tkinter UI is intentionally a local Windows process with access to
    # the current user's DPAPI keys; it never opens an operator HTTP listener.
    operator_command("status")
    root = tk.Tk()
    window = OperatorWindow(root)
    root.protocol("WM_DELETE_WINDOW", lambda: (window.clear_private_clipboard(), root.destroy()))
    root.mainloop()


if __name__ == "__main__":
    main()
