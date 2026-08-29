"""The device shared secret, read from the macOS Keychain and nowhere else.

    security add-generic-password -s jarvis-listener -a apollo -w '<device secret>'

The secret is the same `DEVICE_SHARED_SECRET` the ESP32 carries; see
documentation/operations/auth.md for why it is not the dashboard secret. It is
never written to a file, never passed as an argument to another process, and
never logged -- `redact_url` exists so the connection URL can be logged safely.
"""

from __future__ import annotations

import subprocess
from urllib.parse import urlsplit, urlunsplit


class KeychainError(RuntimeError):
    pass


def read_device_secret(service: str, account: str) -> str:
    """Fetch the secret. Raises rather than falling back to an env var.

    An environment fallback would be the obvious convenience, and it is exactly
    how the secret ends up in a shell history or a launchd plist.
    """
    try:
        completed = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except FileNotFoundError as error:  # pragma: no cover - macOS only
        raise KeychainError("`security` not found; this daemon is macOS-only") from error
    except subprocess.TimeoutExpired as error:
        raise KeychainError("Keychain read timed out (is the keychain locked?)") from error

    secret = completed.stdout.strip()
    if completed.returncode != 0 or not secret:
        raise KeychainError(
            f"no Keychain item for service={service!r} account={account!r}. Add it with:\n"
            f"  security add-generic-password -s {service} -a {account} -w '<device secret>'"
        )
    return secret


def build_connection_url(agent_url: str, token: str) -> str:
    parts = urlsplit(agent_url)
    query = f"token={token}" if not parts.query else f"{parts.query}&token={token}"
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


def redact_url(url: str) -> str:
    """The same URL with the token replaced, for logs."""
    parts = urlsplit(url)
    if "token=" not in parts.query:
        return url
    redacted = "&".join(
        "token=***" if pair.startswith("token=") else pair for pair in parts.query.split("&")
    )
    return urlunsplit((parts.scheme, parts.netloc, parts.path, redacted, parts.fragment))
