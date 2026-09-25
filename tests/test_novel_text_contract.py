import json
from pathlib import Path

from scripts.text_archive.importer import canonical_novel_bytes


def test_shared_contract_fixture_matches_newtomi_body_bytes() -> None:
    fixture = Path(__file__).parent / "fixtures" / "novel_text_contract.json"
    payload = json.loads(fixture.read_text(encoding="utf-8"))
    plain = (payload["body"] + "\n").encode()
    wrapped = f"# {payload['title']}\n# {payload['url']}\n\n{payload['body']}\n".encode()
    assert canonical_novel_bytes(wrapped) == canonical_novel_bytes(plain) == plain
