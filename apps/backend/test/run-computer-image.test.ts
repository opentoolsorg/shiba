import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const testImageEnv = "SHIBA_RUN_COMPUTER_TEST_IMAGE";
const image = process.env[testImageEnv];

describe.skipIf(!image)("approved run computer image", () => {
  it("drives one real offline X desktop and serializes takeover and screenshot evidence", () => {
    if (!image) throw new Error("The sandbox test image was not configured.");
    const smoke = String.raw`
set -euo pipefail
C=/usr/local/bin/shiba-run-computer
shot='[["scrot","-o","/tmp/shiba-screen.png"],["base64","-w0","/tmp/shiba-screen.png"]]'
click='[["xdotool","mousemove","640","400"],["xdotool","click","1"]]'
expect_status() { local expected="$1" status=0; shift; "$@" || status=$?; test "$status" -eq "$expected"; }
expect_status 69 "$C" action view "$shot"
test ! -e /tmp/shiba-run-computer
mkdir -p /etc/cloudflare/certs
openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj /CN=Offline-test-CA \
    -keyout /tmp/test-only.key -out /etc/cloudflare/certs/cloudflare-containers-ca.crt 2>/dev/null
openssl req -nodes -newkey rsa:2048 -subj /CN=localhost -keyout /tmp/leaf.key -out /tmp/leaf.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n' >/tmp/leaf.ext
openssl x509 -req -days 1 -in /tmp/leaf.csr -CA /etc/cloudflare/certs/cloudflare-containers-ca.crt \
    -CAkey /tmp/test-only.key -CAcreateserial -extfile /tmp/leaf.ext -out /tmp/leaf.crt 2>/dev/null
"$C" start
"$C" start
export DISPLAY=:0 XAUTHORITY=/tmp/shiba-run-computer/Xauthority
xdotool search --onlyvisible --class '^chromium-browser$' >/dev/null
test "$(find /tmp/shiba-run-computer -maxdepth 1 -type d -name 'browser-*' | wc -l)" -eq 1
nssdb=$(find /tmp/shiba-run-computer -name nssdb -type d)
certutil -L -d "sql:$nssdb" | grep -Eq 'Cloudflare Containers egress +C,,'
expect_status 64 "$C" action view "$click"
expect_status 69 "$C" action human "$click"
expect_status 64 "$C" action agent '[["xdotool","exec","touch","/tmp/unexpected"]]'
expect_status 64 "$C" action agent '[["scrot","-o","/tmp/unexpected"],["base64","-w0","/tmp/unexpected"]]'
expect_status 64 "$C" tool key '{"keys":"Ctrl+exec"}'
test ! -e /tmp/unexpected
printf '<input autofocus oninput="document.title=this.value">' >/tmp/test.html
"$C" tool key '{"keys":"Ctrl+l"}'
"$C" tool type '{"text":"file:///tmp/test.html"}'
"$C" tool key '{"keys":"Return"}'
sleep 0.5
payload='--option; $(touch /tmp/unexpected)'
"$C" tool type '{"text":"--option; $(touch /tmp/unexpected)"}'
sleep 0.3
xdotool search --onlyvisible --class '^chromium-browser$' getwindowname %@ | grep -F -- "$payload"
test ! -e /tmp/unexpected
"$C" tool scroll '{"dx":0,"dy":120}'
latest=/tmp/shiba-run-computer/latest.png
test "$("$C" tool shot '{}')" = "$latest"
cp "$latest" /tmp/agent.png
"$C" control take "$(( $(date +%s%3N) + 20000 ))"
expect_status 75 "$C" tool click '{"x":10,"y":10}'
expect_status 75 "$C" tool shot '{}'
"$C" action human "$click"
"$C" action view "$shot" | base64 -d >/tmp/view.png
"$C" evidence | base64 -d >/tmp/evidence.png
cmp "$latest" /tmp/agent.png
cmp "$latest" /tmp/evidence.png
"$C" control release 0
"$C" tool click '{"x":640,"y":400}'
"$C" control take "$(( $(date +%s%3N) + 300 ))"
sleep 0.4
"$C" tool click '{"x":10,"y":10}'
/usr/bin/python3 - <<'PY'
import fcntl
from pathlib import Path
from PIL import Image
import socket
import subprocess
import time
for p in ('/tmp/shiba-run-computer/latest.png','/tmp/view.png'):
    image = Image.open(p)
    assert image.size == (1280, 800) and image.format == 'PNG' and Path(p).stat().st_size <= 375000
for port in (6000, 9222):
    with socket.socket() as s:
        assert s.connect_ex(('127.0.0.1', port)) != 0
import http.server
import ssl
import threading
class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<title>trusted localhost</title>')
with http.server.HTTPServer(('127.0.0.1', 0), Page) as server:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain('/tmp/leaf.crt', '/tmp/leaf.key')
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    for domain, title in [('localhost', 'trusted localhost'), ('127.0.0.1', 'Privacy error')]:
        control = ['/usr/local/bin/shiba-run-computer', 'tool']
        subprocess.run([*control, 'key', '{"keys":"Ctrl+l"}'], check=True)
        subprocess.run([*control, 'type', '{"text":"https://'+domain+':'+str(server.server_port)+'"}'], check=True)
        subprocess.run([*control, 'key', '{"keys":"Return"}'], check=True)
        until = time.monotonic() + 5
        while time.monotonic() < until:
            window = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--class',
                                              '^chromium-browser$', 'getwindowname', '%@'], text=True)
            if title in window:
                break
            time.sleep(.1)
        else:
            raise AssertionError((title, window))
root = Path('/tmp/shiba-run-computer')
with (root / 'lock').open() as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    waiting = subprocess.Popen(['/usr/local/bin/shiba-run-computer', 'tool', 'click', '{"x":10,"y":10}'])
    time.sleep(0.25)
    assert waiting.poll() is None
    (root / 'lease').write_text(str(time.time_ns() // 1_000_000 + 5000))
assert waiting.wait(timeout=3) == 75
PY
rm "$latest"
ln -s /tmp/agent.png "$latest"
expect_status 69 "$C" evidence
`;
    const run = spawnSync("docker", ["run", "--rm", "-i", "--network", "none", "--entrypoint", "/bin/bash", image, "-s"], {
      encoding: "utf8",
      input: smoke,
      timeout: 35_000,
    });
    expect(run.error).toBeUndefined();
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  }, 40_000);
});
