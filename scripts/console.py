from __future__ import annotations

import argparse
import json
import secrets
from dataclasses import dataclass
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

from crawler.archive import connect_archive

_COOKIE = "redstm_console"
_STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/console.css": ("console.css", "text/css; charset=utf-8"),
    "/console.js": ("console.js", "text/javascript; charset=utf-8"),
}


@dataclass(frozen=True, slots=True)
class ConsoleProfile:
    archive: Path
    static_root: Path
    release_root: Path | None = None
    doctor_report: Path | None = None
    backup_root: Path | None = None


def _read_json(path: Path | None) -> dict[str, Any] | None:
    if path is None or not path.is_file() or path.stat().st_size > 2 << 20:
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else None


def _backup_history(root: Path | None) -> list[dict[str, Any]]:
    if root is None or not root.is_dir():
        return []
    history = []
    paths = sorted(
        root.rglob("*.manifest.json"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    for path in paths[:20]:
        report = _read_json(path)
        if report is not None:
            history.append(
                {
                    "name": path.name,
                    "ok": report.get("ok"),
                    "created_at": report.get("created_at"),
                    "bytes": report.get("snapshot", {}).get("bytes")
                    if isinstance(report.get("snapshot"), dict)
                    else None,
                }
            )
    return history


def build_status(profile: ConsoleProfile) -> dict[str, Any]:
    with connect_archive(profile.archive, read_only=True) as connection:
        frontier = {state: 0 for state in ("pending", "running", "retry", "done", "dead")}
        frontier.update(
            {
                str(row["state"]): int(row["count"])
                for row in connection.execute(
                    "SELECT state, COUNT(*) AS count FROM crawl_frontier GROUP BY state"
                )
            }
        )
        counts = {
            "boards": int(connection.execute("SELECT COUNT(*) FROM boards").fetchone()[0]),
            "posts": int(connection.execute("SELECT COUNT(*) FROM posts").fetchone()[0]),
            "versions": int(connection.execute("SELECT COUNT(*) FROM post_versions").fetchone()[0]),
        }
        recent_runs = [
            dict(row)
            for row in connection.execute(
                """
                SELECT run_id, kind, status, started_at, finished_at, discovered, fetched,
                       changed, unchanged, failed
                FROM crawl_runs ORDER BY started_at DESC LIMIT 20
                """
            )
        ]
        queue_boards = [
            dict(row)
            for row in connection.execute(
                """
                SELECT board_id,
                       SUM(state = 'pending') AS pending,
                       SUM(state = 'retry') AS retry,
                       SUM(state = 'dead') AS dead
                FROM crawl_frontier GROUP BY board_id
                HAVING pending + retry + dead > 0
                ORDER BY dead DESC, retry DESC, pending DESC, board_id LIMIT 20
                """
            )
        ]

    release = _read_json(profile.release_root / "release.json" if profile.release_root else None)
    doctor = _read_json(profile.doctor_report)
    if frontier["running"]:
        readiness, reason = "Running", "현재 crawler lease가 실행 중입니다."
    elif doctor is not None and doctor.get("ok") is False:
        readiness, reason = "Blocked", "마지막 doctor report가 실패했습니다."
    elif frontier["retry"] or frontier["dead"] or doctor is None:
        readiness, reason = "Attention", "재시도·dead queue 또는 미확인 doctor가 남아 있습니다."
    else:
        readiness, reason = "Ready", "현재 read-only 검사에서 blocking failure가 없습니다."

    return {
        "readiness": {"state": readiness, "reason": reason},
        "archive": {
            "path": str(profile.archive),
            "bytes": profile.archive.stat().st_size,
            "counts": counts,
        },
        "frontier": frontier,
        "queue_boards": queue_boards,
        "recent_runs": recent_runs,
        "doctor": {
            "ok": doctor.get("ok"),
            "checked_at": doctor.get("checked_at"),
            "issues": doctor.get("issues", []),
        }
        if doctor is not None
        else None,
        "release": {
            "posts": release.get("post_count"),
            "comments": release.get("comment_count"),
            "boards": release.get("board_count"),
            "collections": release.get("collection_count"),
        }
        if release is not None
        else None,
        "backups": _backup_history(profile.backup_root),
    }


class ConsoleServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, profile: ConsoleProfile, port: int = 0, *, token: str | None = None) -> None:
        self.profile = profile
        self.token = token or secrets.token_urlsafe(32)
        super().__init__(("127.0.0.1", port), ConsoleHandler)

    @property
    def expected_host(self) -> str:
        return f"127.0.0.1:{self.server_port}"


class ConsoleHandler(BaseHTTPRequestHandler):
    server_version = "ReDSTMConsole/1"

    @property
    def console(self) -> ConsoleServer:
        return cast(ConsoleServer, self.server)

    def _security_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        )
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")

    def _send(
        self,
        status: int,
        body: bytes = b"",
        content_type: str = "text/plain; charset=utf-8",
    ) -> None:
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _valid_host(self) -> bool:
        return self.headers.get("Host") == self.console.expected_host

    def _authenticated(self) -> bool:
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
        except CookieError:
            return False
        value = cookie.get(_COOKIE)
        return value is not None and secrets.compare_digest(value.value, self.console.token)

    def do_GET(self) -> None:
        if not self._valid_host():
            self._send(HTTPStatus.FORBIDDEN)
            return
        path = urlsplit(self.path).path
        if path == "/api/status":
            if not self._authenticated():
                self._send(HTTPStatus.UNAUTHORIZED)
                return
            try:
                body = json.dumps(build_status(self.console.profile), ensure_ascii=False).encode()
            except OSError, ValueError:
                self._send(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    b'{"error":"status_unavailable"}',
                    "application/json; charset=utf-8",
                )
                return
            self._send(HTTPStatus.OK, body, "application/json; charset=utf-8")
            return
        if path == "/favicon.ico":
            self._send(HTTPStatus.NO_CONTENT)
            return
        asset = _STATIC.get(path)
        if asset is None:
            self._send(HTTPStatus.NOT_FOUND)
            return
        name, content_type = asset
        body = (self.console.profile.static_root / name).read_bytes()
        self._send(HTTPStatus.OK, body, content_type)

    def do_POST(self) -> None:
        expected_origin = f"http://{self.console.expected_host}"
        if not self._valid_host() or self.headers.get("Origin") != expected_origin:
            self._send(HTTPStatus.FORBIDDEN)
            return
        if urlsplit(self.path).path != "/api/session":
            self._send(HTTPStatus.NOT_FOUND)
            return
        if self.headers.get_content_type() != "application/json":
            self._send(HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send(HTTPStatus.BAD_REQUEST)
            return
        if not 0 < length <= 4096:
            self._send(HTTPStatus.BAD_REQUEST)
            return
        try:
            payload = json.loads(self.rfile.read(length))
            supplied = payload.get("token") if isinstance(payload, dict) else None
        except json.JSONDecodeError, UnicodeDecodeError:
            supplied = None
        if not isinstance(supplied, str) or not secrets.compare_digest(
            supplied, self.console.token
        ):
            self._send(HTTPStatus.UNAUTHORIZED)
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._security_headers()
        self.send_header(
            "Set-Cookie",
            f"{_COOKIE}={self.console.token}; HttpOnly; SameSite=Strict; Path=/",
        )
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        pass


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the read-only local ReDSTM console.")
    parser.add_argument("--archive", type=Path, default=Path(".data/canonical/archive.sqlite"))
    parser.add_argument("--release-root", type=Path, default=Path(".data/static/archive-zstd"))
    parser.add_argument(
        "--doctor-report",
        type=Path,
        default=Path(".data/migration/schema-v4-doctor.json"),
    )
    parser.add_argument("--backup-root", type=Path)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("port must be between 0 and 65535")
    return args


def main() -> int:
    args = _parse_args()
    root = Path(__file__).resolve().parents[1]
    profile = ConsoleProfile(
        archive=args.archive.expanduser().resolve(strict=True),
        static_root=(root / "console/public").resolve(strict=True),
        release_root=args.release_root.expanduser().resolve() if args.release_root else None,
        doctor_report=args.doctor_report.expanduser().resolve() if args.doctor_report else None,
        backup_root=args.backup_root.expanduser().resolve() if args.backup_root else None,
    )
    server = ConsoleServer(profile, args.port)
    print(f"http://{server.expected_host}/#token={server.token}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
