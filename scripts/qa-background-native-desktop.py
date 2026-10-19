"""Run ONLY the explicitly compiled disposable BG Tauri app on a private Win32 desktop.

The desktop is never activated/switched. CDP controls WebView2 without sending
mouse or keyboard input to the user's interactive WinSta0\\Default desktop.
No seed creation, issuer signing, customer DB operation, or broad taskkill.
"""
import ctypes
import json
import os
import pathlib
import hashlib
import socket
import sys
import time
from ctypes import wintypes

if not __debug__:
    raise SystemExit('QA native launcher requires assertions: disable PYTHONOPTIMIZE')

IDENTIFIER = 'com.pharma.disposable.qa20261014bg'
PORT = 9333
NAME = 'PharmaSyntheticBgDesktop20261014'


def paths():
    base = pathlib.Path(os.environ['TEMP']) / 'pharma-qa-background-20261014-synthetic'
    return (base, base / 'pharma.exe',
            pathlib.Path(os.environ['APPDATA']) / IDENTIFIER / 'pharma_local.db',
            base / 'qa-manifest-desktop.json')


def preflight():
    base, exe, db, manifest = paths()
    assert sys.platform == 'win32', 'Windows desktop isolation required'
    assert exe.is_file() and db.is_file(), 'Disposable BG executable/data missing'
    if os.path.normcase(str(exe.resolve(strict=True))) != os.path.normcase(str(exe.absolute())):
        raise RuntimeError('Background executable resolves through an unexpected filesystem alias')
    if os.path.normcase(str(db.resolve(strict=True))) != os.path.normcase(str(db.absolute())):
        raise RuntimeError('Background database resolves through a junction/symlink')
    protected = [pathlib.Path(__file__).resolve().parents[1] / 'src-tauri/pharma_local.db']
    protected += [pathlib.Path(os.environ['APPDATA']) / app / 'pharma_local.db'
                  for app in ('com.pharma.disposable.qa20261014b','com.pharma.disposable.qa20261014c')]
    for other in protected:
        if other.exists() and os.path.samefile(db, other):
            raise RuntimeError('Background database aliases a protected or other-session database')
    assert (b'com.pharma.disposable.qa20261014bg' in exe.read_bytes()), 'Wrong binary identity'
    pin = base / 'synthetic-bg-executable-sha256.txt'
    if not pin.is_file() or hashlib.sha256(exe.read_bytes()).hexdigest() != pin.read_text(encoding='ascii').strip():
        raise RuntimeError('Background executable is not independently SHA256-pinned')
    assert (base / 'synthetic-test-public-key.txt').is_file(), 'Synthetic-only public verifier missing'
    assert db.stat().st_size > 4096 and db.read_bytes()[:16] == b'SQLite format 3\x00'
    password = pathlib.Path(os.environ['TEMP']) / 'pharma-qa-disposable-20261014-isolated' / 'synthetic-owner-password.txt'
    assert password.is_file(), 'Synthetic-only login fixture unavailable'
    return base, exe, db, manifest, password


def existing_pid_is_owned(pid, expected_executable):
    """Read-only Win32 process identity probe; NEVER call os.kill(pid, 0)."""
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetExitCodeProcess.restype = wintypes.BOOL
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                 wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        error = ctypes.get_last_error()
        if error == 87:  # ERROR_INVALID_PARAMETER: PID no longer exists
            return False
        raise ctypes.WinError(error)  # fail closed on inaccessible/reused process
    try:
        code = wintypes.DWORD()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        if code.value != 259:  # STILL_ACTIVE
            return False
        name = ctypes.create_unicode_buffer(32768)
        size = wintypes.DWORD(len(name))
        if not kernel.QueryFullProcessImageNameW(handle, 0, name, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        if pathlib.Path(name.value).resolve() != expected_executable.resolve():
            raise RuntimeError('Manifest PID belongs to an unrelated process; refusing launch')
        return True
    finally:
        kernel.CloseHandle(handle)


def launch():
    base, exe, db, manifest, password = preflight()
    if manifest.exists():
        old = json.loads(manifest.read_text(encoding='utf8'))
        if existing_pid_is_owned(old['pid'], exe):
            raise RuntimeError('QA BG process already running, refusing duplicate')
    with socket.socket() as probe:
        assert probe.connect_ex(('127.0.0.1', PORT)) != 0, 'Background CDP port already occupied'

    user32 = ctypes.WinDLL('user32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    user32.CreateDesktopW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p,
                                     wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    user32.CreateDesktopW.restype = wintypes.HANDLE
    user32.CloseDesktop.argtypes = [wintypes.HANDLE]
    user32.GetForegroundWindow.restype = wintypes.HWND
    desktop = user32.CreateDesktopW(NAME, None, None, 0, 0x000F01FF, None)
    if not desktop:
        raise ctypes.WinError(ctypes.get_last_error())

    class Startup(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('lpReserved', wintypes.LPWSTR),
                    ('lpDesktop', wintypes.LPWSTR), ('lpTitle', wintypes.LPWSTR),
                    ('dwX', wintypes.DWORD), ('dwY', wintypes.DWORD),
                    ('dwXSize', wintypes.DWORD), ('dwYSize', wintypes.DWORD),
                    ('dwXCountChars', wintypes.DWORD), ('dwYCountChars', wintypes.DWORD),
                    ('dwFillAttribute', wintypes.DWORD), ('dwFlags', wintypes.DWORD),
                    ('wShowWindow', wintypes.WORD), ('cbReserved2', wintypes.WORD),
                    ('lpReserved2', ctypes.c_void_p), ('hStdInput', wintypes.HANDLE),
                    ('hStdOutput', wintypes.HANDLE), ('hStdError', wintypes.HANDLE)]

    class ProcessInfo(ctypes.Structure):
        _fields_ = [('hProcess', wintypes.HANDLE), ('hThread', wintypes.HANDLE),
                    ('dwProcessId', wintypes.DWORD), ('dwThreadId', wintypes.DWORD)]

    kernel32.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p,
                                      ctypes.c_void_p, wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p,
                                      wintypes.LPCWSTR, ctypes.POINTER(Startup), ctypes.POINTER(ProcessInfo)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    env = os.environ.copy()
    env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = f'--remote-debugging-port={PORT}'
    env['WEBVIEW2_USER_DATA_FOLDER'] = str(base / 'webview2-private-desktop')
    block = ctypes.create_unicode_buffer('\x00'.join(f'{key}={value}' for key, value in sorted(env.items())) + '\x00\x00')
    info = Startup()
    info.cb = ctypes.sizeof(Startup)
    info.lpDesktop = 'WinSta0\\' + NAME
    info.dwFlags = 1  # STARTF_USESHOWWINDOW
    info.wShowWindow = 0  # SW_HIDE on a non-active Win32 desktop
    pid = ProcessInfo()
    command = ctypes.create_unicode_buffer('"' + str(exe) + '"')
    before = user32.GetForegroundWindow()
    try:
        # CREATE_UNICODE_ENVIRONMENT; no new interactive console or desktop switch.
        created = kernel32.CreateProcessW(None, command, None, None, False, 0x00000400,
                                          block, str(base), ctypes.byref(info), ctypes.byref(pid))
        if not created:
            raise ctypes.WinError(ctypes.get_last_error())
        time.sleep(2)
        after = user32.GetForegroundWindow()
        output = {'pid': int(pid.dwProcessId), 'disposable': True, 'identifier': IDENTIFIER,
                  'executable': str(exe), 'database': str(db),
                  'synthetic_password_file': str(password), 'cdp_port': PORT,
                  'private_desktop': NAME, 'foreground_unchanged': before == after}
        manifest.write_text(json.dumps(output, indent=2), encoding='utf8')
        print('QA_BG_PRIVATE_DESKTOP_PID=' + str(pid.dwProcessId))
        print('QA_BG_FOREGROUND_UNCHANGED=' + str(before == after))
        print('QA_BG_MANIFEST=' + str(manifest))
        if before != after:
            kernel32.TerminateProcess(pid.hProcess, 2)
            raise RuntimeError('Foreground changed during private desktop startup; exact BG PID terminated')
    finally:
        if pid.hThread: kernel32.CloseHandle(pid.hThread)
        if pid.hProcess: kernel32.CloseHandle(pid.hProcess)
        user32.CloseDesktop(desktop)


if __name__ == '__main__':
    if sys.argv[1:] == ['--check']:
        base, exe, db, manifest, password = preflight()
        print('QA_BG_PRIVATE_DESKTOP_PREFLIGHT=PASS')
    elif sys.argv[1:] == ['--launch']:
        launch()
    else:
        raise SystemExit('Usage: python scripts/qa-background-native-desktop.py --check|--launch')
