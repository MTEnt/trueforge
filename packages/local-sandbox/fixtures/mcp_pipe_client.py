#!/usr/bin/env python3
"""PoC Code Mode client: connect to host UDS, one request/response per call."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import struct
import sys
import time
import uuid
from typing import Any

MAX_FRAME_BYTES = 64 * 1024 * 1024


def _sock_path() -> str:
    path = os.environ.get("TFY_MCP_SOCK")
    if not path:
        raise RuntimeError("TFY_MCP_SOCK is not set")
    return path


def _read_exact(sock: socket.socket, size: int) -> bytes:
    body = b""
    while len(body) < size:
        chunk = sock.recv(size - len(body))
        if not chunk:
            raise RuntimeError("short read on Code Mode UDS")
        body += chunk
    return body


def _read_frame(sock: socket.socket) -> Any:
    header = _read_exact(sock, 4)
    (length,) = struct.unpack("<I", header)
    if length > MAX_FRAME_BYTES:
        raise RuntimeError(f"frame length {length} exceeds max {MAX_FRAME_BYTES}")
    return json.loads(_read_exact(sock, length).decode("utf-8"))


def _write_frame(sock: socket.socket, value: Any) -> None:
    payload = json.dumps(value).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        raise RuntimeError(f"frame exceeds {MAX_FRAME_BYTES} bytes")
    sock.sendall(struct.pack("<I", len(payload)) + payload)


def _request_sync(payload: dict[str, Any]) -> Any:
    """Connect → one framed request → one framed reply → close."""
    request_id = str(uuid.uuid4())
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(60)
        sock.connect(_sock_path())
        _write_frame(sock, {**payload, "request_id": request_id})
        reply = _read_frame(sock)
    finally:
        sock.close()
    if not isinstance(reply, dict):
        raise RuntimeError(f"Code Mode reply is not an object: {reply!r}")
    if reply.get("request_id") != request_id:
        raise RuntimeError("Code Mode reply request_id mismatch")
    if not reply.get("ok"):
        raise RuntimeError(f"Code Mode request failed: {reply.get('error', 'unknown error')}")
    return reply.get("result")


async def list_tools(server: str) -> Any:
    return await asyncio.to_thread(
        _request_sync,
        {"op": "list_tools", "server": server},
    )


async def call_tool(server: str, tool: str, body: dict[str, Any]) -> Any:
    return await asyncio.to_thread(
        _request_sync,
        {
            "op": "call_tool",
            "server": server,
            "tool": tool,
            "arguments": body,
        },
    )


async def _cmd_list_tools(server: str) -> None:
    await list_tools(server)
    print("list-tools-ok")


async def _cmd_call_tool(server: str, tool: str, args: dict[str, Any]) -> None:
    result = await call_tool(server, tool, args)
    print("call-tool-ok", json.dumps(result, default=str))


async def _cmd_multiplex(server: str, count: int) -> None:
    coros = [
        call_tool(server, "ping", {"message": f"m{i}", "delay_ms": 150})
        for i in range(count)
    ]
    started = time.monotonic()
    results = await asyncio.gather(*coros)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    print("multiplex-ok", elapsed_ms, json.dumps(results, default=str))


async def _async_main() -> None:
    parser = argparse.ArgumentParser(prog="mcp_pipe_client.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    list_p = sub.add_parser("list-tools", help="Invoke list_tools()")
    list_p.add_argument("--server", default="demo")

    call_p = sub.add_parser("call-tool", help="Invoke call_tool()")
    call_p.add_argument("--server", default="demo")
    call_p.add_argument("--tool", default="ping")
    call_p.add_argument("--args-json", default='{"message":"poc"}', type=json.loads)

    multi_p = sub.add_parser("multiplex", help="Concurrent call_tool via parallel UDS connects")
    multi_p.add_argument("--server", default="demo")
    multi_p.add_argument("--count", type=int, default=2)

    args = parser.parse_args()
    try:
        if args.cmd == "list-tools":
            await _cmd_list_tools(args.server)
            return
        if args.cmd == "multiplex":
            await _cmd_multiplex(args.server, args.count)
            return
        await _cmd_call_tool(args.server, args.tool, args.args_json)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(2) from e


def main() -> None:
    asyncio.run(_async_main())


if __name__ == "__main__":
    main()
