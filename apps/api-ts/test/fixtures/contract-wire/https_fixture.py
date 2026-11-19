"""STDLIB-only loopback TLS • constructed protocol, never cryptographic ICP proof.

The committed server private key is SYNTHETIC TEST ONLY. The CA private key is
not stored. No production keys, accounts, or PDF-signing certificates are used.
"""
import base64
import datetime
import hashlib
import hmac
import http.server
import json
from pathlib import Path
import ssl
import struct
import sys
import time

HERE = Path(__file__).resolve().parent
MODE = sys.argv[1]
MAGIC = b"AVILA-CVB1\n"


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def response(frame, request_headers, target):
    prefix = b"AVILA-CV1\n"
    assert frame.startswith(prefix)
    size = int.from_bytes(frame[len(prefix):len(prefix) + 4], "big")
    request = json.loads(frame[len(prefix) + 4:len(prefix) + 4 + size])
    operation = request["operation"]
    vector = json.loads((HERE / (operation + ".json")).read_text())
    key = base64.b64decode(vector["keyBase64"])
    frame_hash = digest(frame)
    sent = request_headers["x-validation-time"]
    assert abs(time.time() - int(sent)) < 60
    request_id = request["requestId"]
    message = f"AVILA-CV-AUTH/1\nPOST\n{target}\ntest\n{sent}\n{request_id}\n{frame_hash}\n{len(frame)}\n".encode()
    expected = "HMAC-SHA256 test:" + hmac.new(key, message, hashlib.sha256).hexdigest()
    assert hmac.compare_digest(request_headers["authorization"], expected)
    assert request_headers["x-validation-request-id"] == request_id
    assert request_headers["x-validation-content-sha256"] == frame_hash
    assert request_headers["content-type"] == vector["headers"]["content-type"]
    assert target == "/internal/v1/" + operation
    # Golden reports are constructed models. Change ONLY their request/clock
    # binding and recompute every commitment/MAC for the new request.
    body = base64.b64decode(vector["responseBundleBase64"])
    size = int.from_bytes(body[len(MAGIC):len(MAGIC) + 4], "big")
    meta = json.loads(body[len(MAGIC) + 4:len(MAGIC) + 4 + size])
    payload = body[len(MAGIC) + 4 + size:]
    parts = []
    for descriptor in meta["parts"]:
        parts.append(payload[:descriptor["length"]])
        payload = payload[descriptor["length"]:]
    report = json.loads(parts[0])
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for name in ["requestId", "tenantId", "envelopeId", "documentId"]:
        report[name] = request[name]
    report["requestSha256"] = frame_hash
    report["checkedAt"] = now
    report["report"]["binding"]["checkedAt"] = now
    report["report"]["binding"]["documentId"] = request["documentId"]
    evidence = digest(canonical({"certificates": [], "crls": [], "ocsps": [], "observedAt": now}))
    meta["evidenceSetSha256"] = evidence
    for check in report["report"]["checks"]:
        if check["name"] == "evidence_set":
            check["evidenceHashes"] = [evidence]
    report["reportSha256"] = digest(canonical(report["report"]))

    def sealed(data, content_type):
        msg = f"AVILA-CV-RESPONSE/1\ntest\n{request_id}\n{frame_hash}\n{digest(data)}\n{len(data)}\n".encode()
        return {"content-type": content_type, "content-length": str(len(data)), "x-validation-response-sha256": digest(data), "x-validation-response-mac": "HMAC-SHA256 test:" + hmac.new(key, msg, hashlib.sha256).hexdigest()}

    parts[0] = canonical(report)
    meta["parts"][0]["length"] = len(parts[0])
    meta["parts"][0]["sha256"] = digest(parts[0])
    meta["responseHeaders"] = sealed(parts[0], vector["responseHeaders"]["content-type"].replace("bundle", "result+json"))
    header = canonical(meta)
    body = MAGIC + struct.pack(">I", len(header)) + header + b"".join(parts)
    return body, sealed(body, vector["responseHeaders"]["content-type"])


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # No request headers, identity, document or secret logging.

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        if not 0 < length < 1024 * 1024:
            self.send_error(400)
            return
        frame = self.rfile.read(length)
        if MODE == "redirect" and self.path != "/redirect-target":
            self.send_response(307)
            self.send_header("Location", "/redirect-target")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        target = self.path if self.path != "/redirect-target" else "/internal/v1/preflight"
        body, headers = response(frame, self.headers, target)
        if MODE == "unavailable":
            self.send_error(503)
            return
        if MODE == "html":
            headers["content-type"] = "text/html"
        if MODE == "wrong_mac":
            headers["x-validation-response-mac"] = "HMAC-SHA256 test:" + "0" * 64
        if MODE == "oversize":
            headers["content-length"] = str(40 * 1024 * 1024 + 1)
        self.send_response(200)
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        if MODE in ("stall", "oversize"):
            time.sleep(10)
            return
        if MODE == "short":
            body = body[:-1]
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.minimum_version = ssl.TLSVersion.TLSv1_2
context.load_cert_chain(HERE / "tls-test-server.pem", HERE / "tls-test-server-key.pem")
server.socket = context.wrap_socket(server.socket, server_side=True)
print(server.server_port, flush=True)
server.serve_forever()
