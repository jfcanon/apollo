"""Secret handling: the URL is built correctly and never logged intact."""

from __future__ import annotations

import logging
import sys

import pytest

from jarvis_listener.config import DEFAULT_AGENT_URL
from jarvis_listener.keychain import KeychainError, build_connection_url, read_device_secret, redact_url

# Obviously fake, and the same length as the real one so the redaction test
# exercises a realistic string.
TOKEN = "not-a-real-token-" + "0" * 47


def test_token_is_appended_as_a_query_parameter() -> None:
    url = build_connection_url(DEFAULT_AGENT_URL, TOKEN)
    assert url == f"{DEFAULT_AGENT_URL}?token={TOKEN}"


def test_an_existing_query_string_is_preserved() -> None:
    url = build_connection_url("wss://example.com/desk?mode=test", TOKEN)
    assert url == f"wss://example.com/desk?mode=test&token={TOKEN}"


def test_redaction_removes_the_token() -> None:
    redacted = redact_url(build_connection_url(DEFAULT_AGENT_URL, TOKEN))
    assert TOKEN not in redacted
    assert redacted.endswith("?token=***")


def test_redaction_keeps_other_parameters() -> None:
    redacted = redact_url(f"wss://example.com/desk?mode=test&token={TOKEN}")
    assert redacted == "wss://example.com/desk?mode=test&token=***"


def test_redaction_leaves_a_tokenless_url_alone() -> None:
    assert redact_url("wss://example.com/desk") == "wss://example.com/desk"


def test_a_missing_keychain_item_raises_rather_than_returning_empty() -> None:
    # An empty secret would produce a token-less URL and a confusing 401 rather
    # than a message naming the missing item.
    with pytest.raises(KeychainError):
        read_device_secret("jarvis-listener-does-not-exist", "nobody")


@pytest.mark.skipif(sys.platform != "darwin", reason="`security` is macOS-only")
def test_a_missing_keychain_item_explains_how_to_add_it() -> None:
    with pytest.raises(KeychainError) as failure:
        read_device_secret("jarvis-listener-does-not-exist", "nobody")
    assert "security add-generic-password" in str(failure.value)


def test_the_websockets_logger_is_muted_so_verbose_cannot_leak_the_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `websockets` logs the full request line, token included, at DEBUG. The
    # entry point mutes it; without that, `run --verbose` writes the device
    # secret to /tmp/jarvis-listener.log on every connect.
    from jarvis_listener.__main__ import main

    monkeypatch.setattr("jarvis_listener.client.describe_devices", lambda: "")
    main(["devices"])
    assert logging.getLogger("websockets").level >= logging.WARNING
