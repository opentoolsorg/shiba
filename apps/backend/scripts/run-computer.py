#!/usr/bin/python3 -I
import base64
from contextlib import contextmanager
import fcntl
import io
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import stat
import struct
import subprocess
import sys
import tempfile
import time

from PIL import Image

ROOT = Path("/tmp/shiba-run-computer")
WIDTH, HEIGHT = 1280, 800
MAX_PNG_BYTES = 375_000
MAX_LEASE_MS = 600_000
X_DISPLAY = ":0"
X_PATH = "/usr/bin"
CHROME = "/opt/chrome-linux64/chrome"
CLOUDFLARE_EGRESS_CA = Path("/etc/cloudflare/certs/cloudflare-containers-ca.crt")
SHOT_ARGV = [["scrot", "-o", "/tmp/shiba-screen.png"], ["base64", "-w0", "/tmp/shiba-screen.png"]]
BUTTONS = {"left": "1", "middle": "2", "right": "3"}
KEY = r"(?:[a-z0-9]|F(?:[1-9]|[12][0-9]|3[0-5])|Return|Escape|Tab|space|BackSpace|Delete|Insert|Home|End|Page_Up|Page_Down|Left|Right|Up|Down|Print|plus|minus|Shift|Alt|Ctrl|Meta|Super)"
CHORD = re.compile(rf"{KEY}(?:\+{KEY}){{0,7}}", re.ASCII | re.IGNORECASE)
UNAVAILABLE = "Computer desktop unavailable."
PAUSED = "Computer paused while a human controls it."
NO_HUMAN_LEASE = "Human control lease is not active."


class ComputerError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def require(condition):
    if not condition:
        raise ComputerError(64, "Invalid computer request.")


def now_ms():
    return time.time_ns() // 1_000_000


@contextmanager
def desktop_lock(start=False):
    if start:
        try:
            ROOT.mkdir(mode=0o700)
        except FileExistsError:
            pass
        else:
            ROOT.chmod(0o711)
    info = ROOT.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise ComputerError(69, UNAVAILABLE)
    with os.fdopen(os.open(ROOT / "lock", os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600), "r+") as lock:
        deadline = time.monotonic() + 4
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ComputerError(69, UNAVAILABLE) from None
                time.sleep(0.05)
        yield


def x_env(home=None):
    return {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "DISPLAY": X_DISPLAY,
        "HOME": str(home or ROOT),
        "XAUTHORITY": str((home or ROOT) / "Xauthority"),
    }


def x_command(argv, stdin=None, timeout=9):
    return subprocess.run(
        [f"{X_PATH}/{argv[0]}", *argv[1:]],
        env=x_env(), cwd=ROOT, input=stdin, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, timeout=timeout,
    ).returncode


def desktop_ready():
    return (ROOT / "ready").is_file() and x_command(["xdpyinfo"], timeout=2) == 0


def start_desktop():
    if (ROOT / "ready").exists():
        if not desktop_ready():
            raise ComputerError(69, UNAVAILABLE)
        return
    desktop = pwd.getpwnam("shiba-desktop")
    home = Path(tempfile.mkdtemp(prefix="browser-", dir=ROOT))
    runtime = home / "runtime"
    runtime.mkdir(mode=0o700)
    cookie = struct.pack(">H", 0xffff) + b"".join(
        struct.pack(">H", len(field)) + field
        for field in (b"", b"0", b"MIT-MAGIC-COOKIE-1", secrets.token_bytes(16))
    )
    for path in (ROOT / "Xauthority", home / "Xauthority"):
        path.write_bytes(cookie)
        path.chmod(0o600)
    for path in (home, runtime, home / "Xauthority"):
        os.chown(path, desktop.pw_uid, desktop.pw_gid)
    browser_env = {**x_env(home), "XDG_RUNTIME_DIR": str(runtime)}
    browser_user = {"user": desktop.pw_uid, "group": desktop.pw_gid, "extra_groups": []}
    if CLOUDFLARE_EGRESS_CA.is_file():
        nssdb = home / ".local/share/pki/nssdb"
        commands = [
            (["/usr/bin/mkdir", "-p", str(nssdb)], None),
            (["/usr/bin/certutil", "-N", "-d", f"sql:{nssdb}", "--empty-password"], None),
            (["/usr/bin/certutil", "-A", "-d", f"sql:{nssdb}", "-t", "C,,", "-n",
              "Cloudflare Containers egress"], CLOUDFLARE_EGRESS_CA.read_bytes()),
        ]
        for argv, stdin in commands:
            subprocess.run(argv, input=stdin, cwd=home, env=browser_env, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=True, timeout=2, **browser_user)
    processes = []

    def launch(argv, env, cwd=ROOT, **identity):
        proc = subprocess.Popen(
            argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, **identity,
        )
        processes.append(proc)

    def wait_for(command, deadline):
        while time.monotonic() < deadline and all(proc.poll() is None for proc in processes):
            if x_command(command, timeout=1) == 0:
                return True
            time.sleep(0.1)
        return False

    try:
        deadline = time.monotonic() + 16
        launch([f"{X_PATH}/Xvfb", X_DISPLAY, "-screen", "0", f"{WIDTH}x{HEIGHT}x24",
                "-nolisten", "tcp", "-noreset", "-auth", str(ROOT / "Xauthority")], x_env())
        if not wait_for(["xdpyinfo"], deadline):
            raise ComputerError(69, UNAVAILABLE)
        launch([f"{X_PATH}/openbox", "--sm-disable"], x_env())
        launch([
            CHROME, "--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking",
            "--disable-component-update", "--disable-sync", "--disable-extensions", "--disable-quic",
            "--disable-domain-reliability", "--disable-breakpad", "--disable-features=MediaRouter",
            "--no-first-run", "--no-default-browser-check", "--start-maximized",
            f"--user-data-dir={home / 'profile'}", "about:blank",
        ], browser_env, cwd=home, **browser_user)
        if not wait_for(["xdotool", "search", "--onlyvisible", "--class", "^chromium-browser$"], deadline):
            raise ComputerError(69, UNAVAILABLE)
        (ROOT / "ready").touch()
    except BaseException:
        for proc in reversed(processes):
            try:
                os.killpg(proc.pid, 15)
            except ProcessLookupError:
                pass
        raise


def png(retain):
    fd, temp = tempfile.mkstemp(suffix=".png", dir=ROOT)
    os.close(fd)
    file = Path(temp)
    try:
        if x_command(["scrot", "-o", str(file)]) != 0:
            raise ComputerError(69, UNAVAILABLE)
        data = file.read_bytes()
        if len(data) > MAX_PNG_BYTES:
            with Image.open(file) as image:
                rgb = image.convert("RGB")
            for bits in (8, 6, 4, 2, 1):
                out = io.BytesIO()
                rgb.quantize(colors=2**bits).save(out, format="PNG", optimize=True, bits=bits)
                data = out.getvalue()
                if len(data) <= MAX_PNG_BYTES:
                    break
            file.write_bytes(data)
        if len(data) > MAX_PNG_BYTES or not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ComputerError(69, UNAVAILABLE)
        if retain:
            file.replace(ROOT / "latest.png")
        return data
    finally:
        file.unlink(missing_ok=True)


def natural(value, minimum, maximum):
    return (
        isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]{0,15})", value)
        and minimum <= int(value) <= maximum
    )


def valid_text(value):
    return (isinstance(value, str) and value and "\x00" not in value
            and len(value.encode("utf-16-le")) <= 8_000)


def action_argv(commands):
    require(isinstance(commands, list) and 1 <= len(commands) <= 2)
    require(all(isinstance(a, list) and all(isinstance(x, str) for x in a) for a in commands))
    if commands == SHOT_ARGV:
        return "shot", []
    if len(commands) == 2:
        move, click = commands
        if len(move) == 4 and move[:2] == ["xdotool", "mousemove"]:
            require(all(natural(value, 0, 100_000) for value in move[2:]))
            require(len(click) == 3 and click[:2] == ["xdotool", "click"] and click[2] in ("1", "2", "3"))
            return "input", commands
    elif len(commands[0]) == 6 and commands[0][:5] == ["xdotool", "type", "--delay", "15", "--"]:
        require(valid_text(commands[0][5]))
        return "type", commands
    elif commands[0][:2] == ["xdotool", "key"]:
        keys = commands[0][2:]
        require(1 <= len(keys) <= 16 and all(CHORD.fullmatch(key) for key in keys))
        return "input", commands
    for argv in commands:
        require(
            len(argv) == 5 and argv[:3] == ["xdotool", "click", "--repeat"]
            and natural(argv[3], 1, 100) and argv[4] in ("4", "5", "6", "7")
        )
    require(len(commands) == 1 or (commands[0][4] in ("4", "5") and commands[1][4] in ("6", "7")))
    return "input", commands


def tool_argv(verb, data):
    require(isinstance(data, dict))
    if verb == "shot":
        require(not data)
        return SHOT_ARGV
    if verb == "click":
        require(data.keys() in ({"x", "y"}, {"x", "y", "button"}))
        x, y = data["x"], data["y"]
        require(type(x) is int and 0 <= x < WIDTH and type(y) is int and 0 <= y < HEIGHT)
        button = data.get("button", "left")
        require(isinstance(button, str) and button in BUTTONS)
        return [["xdotool", "mousemove", str(x), str(y)], ["xdotool", "click", BUTTONS[button]]]
    if verb == "type":
        require(data.keys() == {"text"} and valid_text(data["text"]))
        return [["xdotool", "type", "--delay", "15", "--", data["text"]]]
    if verb == "key":
        require(data.keys() == {"keys"} and isinstance(data["keys"], str))
        return [["xdotool", "key", *data["keys"].split()]]
    require(verb == "scroll" and data.keys() == {"dx", "dy"})
    dx, dy = data["dx"], data["dy"]
    require(all(type(n) is int and abs(n) <= 100_000 for n in (dx, dy)) and (dx != 0 or dy != 0))
    return [["xdotool", "click", "--repeat", str(min(100, max(1, (abs(n) + 60) // 120))),
             str(button + (n > 0))] for n, button in ((dy, 4), (dx, 6)) if n]


def active_lease():
    try:
        return int((ROOT / "lease").read_text()) > now_ms()
    except FileNotFoundError:
        return False


def perform_action(actor, commands, retain=False):
    require(actor in ("agent", "human", "view"))
    kind, argv = action_argv(commands)
    require(actor != "view" or kind == "shot")
    with desktop_lock():
        if not desktop_ready():
            raise ComputerError(69, UNAVAILABLE)
        leased = active_lease()
        if actor == "agent" and leased:
            raise ComputerError(75, PAUSED)
        if actor == "human" and kind != "shot" and not leased:
            raise ComputerError(69, NO_HUMAN_LEASE)
        if kind == "shot":
            return png(retain)
        if kind == "type":
            result = x_command(["xdotool", "type", "--delay", "1", "--file", "-"], stdin=argv[0][5].encode())
        else:
            result = next((code for command in argv if (code := x_command(command)) != 0), 0)
        if result != 0:
            raise ComputerError(69, UNAVAILABLE)
    return None


def set_control(mode, value):
    require(mode in ("take", "release") and natural(value, 0, 9_999_999_999_999))
    with desktop_lock():
        if not desktop_ready():
            raise ComputerError(69, UNAVAILABLE)
        if mode == "take":
            now = now_ms()
            require(now < int(value) <= now + MAX_LEASE_MS)
        else:
            require(value == "0")
        (ROOT / "lease").write_text(value)


def parse_json(value):
    require(len(value) <= 32_768)
    return json.loads(value)


def main(args):
    if args == ["start"]:
        with desktop_lock(start=True):
            start_desktop()
        return
    if args == ["evidence"]:
        with desktop_lock():
            with os.fdopen(os.open(ROOT / "latest.png", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as file:
                if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                    raise ComputerError(69, UNAVAILABLE)
                shot = file.read(MAX_PNG_BYTES + 1)
            if len(shot) > MAX_PNG_BYTES or not shot.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ComputerError(69, UNAVAILABLE)
            sys.stdout.buffer.write(base64.b64encode(shot))
        return
    require(len(args) == 3)
    command, verb, payload = args
    if command == "action":
        shot = perform_action(verb, parse_json(payload))
        if shot is not None:
            sys.stdout.buffer.write(base64.b64encode(shot))
    elif command == "control":
        set_control(verb, payload)
    else:
        require(command == "tool")
        shot = perform_action("agent", tool_argv(verb, parse_json(payload)), retain=True)
        if shot is not None:
            print(ROOT / "latest.png")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main(sys.argv[1:])
    except ComputerError as error:
        print(error, file=sys.stderr)
        sys.exit(error.code)
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        print("Invalid computer request.", file=sys.stderr)
        sys.exit(64)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print(UNAVAILABLE, file=sys.stderr)
        sys.exit(69)
