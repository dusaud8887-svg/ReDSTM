from __future__ import annotations

from argparse import Namespace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from crawler.session import SessionExport
from crawler.settings import REDSTM_SESSION_PREFLIGHT_TIMEOUT_SECONDS
from scripts import refresh_typemoon_session


def test_refresh_uses_the_crawl_preflight_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output = tmp_path / "session.json"
    calls: dict[str, object] = {}
    now = datetime(2026, 7, 15, tzinfo=UTC)

    monkeypatch.setattr(refresh_typemoon_session, "_parse_args", lambda: Namespace(output=output))
    monkeypatch.setenv("TYPEMOON_ID", "id")
    monkeypatch.setenv("TYPEMOON_PASSWORD", "password")
    monkeypatch.setattr(
        refresh_typemoon_session,
        "refresh_session_export",
        lambda path, **kwargs: (
            calls.update(path=path, **kwargs)
            or SessionExport((), now, now + timedelta(hours=4), "agent")
        ),
    )

    assert refresh_typemoon_session.main() == 0
    assert calls["path"] == output
    assert calls["timeout"] == REDSTM_SESSION_PREFLIGHT_TIMEOUT_SECONDS
