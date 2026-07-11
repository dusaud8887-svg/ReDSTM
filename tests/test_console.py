from __future__ import annotations

import http.client
import json
import threading
from pathlib import Path

from crawler.archive import connect_archive, initialize_archive
from crawler.frontier import FrontierStore
from crawler.store import ArchiveStore
from scripts.console import ConsoleProfile, ConsoleServer


def test_console_is_loopback_authenticated_and_read_only(tmp_path: Path) -> None:
    archive = tmp_path / "archive.sqlite"
    initialize_archive(archive)
    with connect_archive(archive) as connection:
        connection.execute(
            """
            INSERT INTO boards (board_id, name, canonical_url, first_seen_at, last_seen_at)
            VALUES ('aa_a01', 'AA', 'https://www.typemoon.net/aa_a01', '2026-07-11', '2026-07-11')
            """
        )
    FrontierStore(archive).seed("aa_a01", 1, "https://www.typemoon.net/aa_a01/1")
    store = ArchiveStore(archive)
    run_id = store.start_run("sync")
    store.finish_run(run_id, status="succeeded")

    release_root = tmp_path / "release"
    release_root.mkdir()
    (release_root / "release.json").write_text(
        json.dumps({"post_count": 1, "comment_count": 2, "board_count": 1, "collection_count": 0}),
        encoding="utf-8",
    )
    doctor = tmp_path / "doctor.json"
    doctor.write_text(
        json.dumps({"ok": True, "checked_at": "2026-07-11T00:00:00+00:00", "issues": []}),
        encoding="utf-8",
    )
    profile = ConsoleProfile(
        archive=archive,
        static_root=Path(__file__).parents[1] / "console/public",
        release_root=release_root,
        doctor_report=doctor,
    )
    server = ConsoleServer(profile, token="test-token")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host = server.expected_host
    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
    try:
        connection.request("GET", "/api/status")
        response = connection.getresponse()
        assert response.status == 401
        assert response.getheader("Access-Control-Allow-Origin") is None
        assert "frame-ancestors 'none'" in response.getheader("Content-Security-Policy")
        response.read()

        body = json.dumps({"token": "test-token"})
        connection.request(
            "POST",
            "/api/session",
            body,
            {"Content-Type": "application/json", "Origin": "https://evil.test"},
        )
        response = connection.getresponse()
        assert response.status == 403
        response.read()

        connection.request(
            "POST",
            "/api/session",
            body,
            {"Content-Type": "application/json", "Origin": f"http://{host}"},
        )
        response = connection.getresponse()
        assert response.status == 204
        cookie = response.getheader("Set-Cookie")
        assert cookie is not None
        assert "HttpOnly" in cookie and "SameSite=Strict" in cookie
        response.read()

        connection.request("GET", "/api/status", headers={"Cookie": cookie.split(";", 1)[0]})
        response = connection.getresponse()
        assert response.status == 200
        status = json.loads(response.read())
        assert status["readiness"]["state"] == "Ready"
        assert status["archive"]["counts"] == {"boards": 1, "posts": 0, "versions": 0}
        assert status["frontier"]["pending"] == 1
        assert status["release"]["comments"] == 2

        connection.request(
            "POST",
            "/api/run",
            "{}",
            {"Origin": f"http://{host}", "Content-Type": "application/json"},
        )
        response = connection.getresponse()
        assert response.status == 404
        response.read()

        connection.request("GET", "/../pyproject.toml")
        response = connection.getresponse()
        assert response.status == 404
        response.read()
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join(5)
