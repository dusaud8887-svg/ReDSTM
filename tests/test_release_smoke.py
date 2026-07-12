from __future__ import annotations

import json

import pytest

from scripts.release_smoke import main


def test_missing_machine_credentials_fail_without_secret_output(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for name in (
        "REDSTM_CONTROL_URL",
        "REDSTM_ACCESS_CLIENT_ID",
        "REDSTM_ACCESS_CLIENT_SECRET",
    ):
        monkeypatch.delenv(name, raising=False)

    assert main(["--expected-release-sha256", "a" * 64]) == 1

    assert json.loads(capsys.readouterr().out) == {
        "ok": False,
        "safe_code": "release_smoke_config_invalid",
        "status": "failed",
    }
