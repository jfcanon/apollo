"""Entry point: `python -m jarvis_listener [run|devices|selftest]`."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from jarvis_listener.client import ListenerClient, describe_devices, selftest
from jarvis_listener.config import load_config
from jarvis_listener.keychain import KeychainError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jarvis_listener", description=__doc__)
    parser.add_argument(
        "command", nargs="?", default="run", choices=("run", "devices", "selftest")
    )
    parser.add_argument("--verbose", action="store_true")
    arguments = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if arguments.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    # `websockets` logs the full request line at DEBUG, which contains the
    # device secret in the query string. Our own connect line is redacted; this
    # keeps --verbose from undoing that.
    logging.getLogger("websockets").setLevel(logging.WARNING)

    if arguments.command == "devices":
        print(describe_devices())
        return 0

    config = load_config()
    if arguments.command == "selftest":
        return selftest(config)

    try:
        asyncio.run(ListenerClient(config).run_forever())
    except KeychainError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
