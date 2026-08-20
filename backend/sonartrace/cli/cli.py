"""CLI entry point: ``sonartrace run <script.py>`` (PRD §4.2).

Spawns the tracer, aggregator, and WebSocket server as subprocesses, executes
the target script, and forwards its stdout/stderr to the terminal. Exits with
the script's exit code. Handles Ctrl+C for clean shutdown of all subprocesses.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import NoReturn

from sonartrace import AggregatorConfig
from sonartrace.server import create_app

__all__ = ["main", "run_command"]


def _find_free_port() -> int:
    """Find a free TCP port for the WebSocket server."""
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_server(port: int, timeout: float = 10.0) -> bool:
    """Wait for the WebSocket server to become ready by polling the health endpoint."""
    import urllib.request
    import urllib.error

    url = f"http://127.0.0.1:{port}/health"
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(url, timeout=0.5) as resp:
                if resp.status == 200:
                    # Give the server a moment to fully start WebSocket endpoints
                    time.sleep(1.0)
                    return True
        except (urllib.error.URLError, ConnectionRefusedError, OSError):
            time.sleep(0.1)
    return False


async def _run_server_in_background(port: int, aggregator_config: AggregatorConfig) -> None:
    """Run the FastAPI server (for in-process use)."""
    import uvicorn

    app = create_app(aggregator_config=aggregator_config)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    await server.serve()


def run_command(args: argparse.Namespace) -> int:
    """Execute the ``sonartrace run`` command."""
    script_path = Path(args.script).resolve()
    if not script_path.exists():
        print(f"Error: Script not found: {script_path}", file=sys.stderr)
        return 1

    # Find a free port for the WebSocket server
    port = _find_free_port()
    ws_url = f"ws://127.0.0.1:{port}"

    # Prepare environment for the traced script
    env = os.environ.copy()
    env["SONARTRACE_WS_URL"] = ws_url
    env["SONARTRACE_INGRESS_URL"] = f"{ws_url}/ws/ingress"
    env["SONARTRACE_CLIENT_URL"] = f"{ws_url}/ws/client"

    # Build aggregator config from CLI args
    aggregator_config = AggregatorConfig(
        window_ms=args.window_ms,
        threshold=args.threshold,
    )

    # Start the WebSocket server as a subprocess
    server_cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "sonartrace.server:create_app",
        "--factory",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--log-level",
        "warning",
    ]

    # Pass aggregator config via environment
    env["SONARTRACE_AGG_WINDOW_MS"] = str(aggregator_config.window_ms)
    env["SONARTRACE_AGG_THRESHOLD"] = str(aggregator_config.threshold)

    server_proc = subprocess.Popen(
        server_cmd,
        env=env,
        stdout=subprocess.PIPE if args.quiet else None,
        stderr=subprocess.PIPE if args.quiet else None,
    )

    try:
        # Wait for server to be ready
        if not _wait_for_server(port):
            print("Error: WebSocket server failed to start", file=sys.stderr)
            return 1

        # Build the tracer command: run the script with sonartrace tracing enabled
        tracer_cmd = [
            sys.executable,
            "-m",
            "sonartrace.cli._tracer_main",
            str(script_path),
            *args.script_args,
        ]

        tracer_proc = subprocess.Popen(
            tracer_cmd,
            env=env,
            stdout=subprocess.PIPE if args.quiet else None,
            stderr=subprocess.PIPE if args.quiet else None,
        )

        # Forward signals to both subprocesses
        def signal_handler(signum: int, frame: Any) -> None:
            for proc in (tracer_proc, server_proc):
                if proc.poll() is None:
                    proc.send_signal(signum)

        original_sigint = signal.signal(signal.SIGINT, signal_handler)
        original_sigterm = signal.signal(signal.SIGTERM, signal_handler)

        try:
            # Wait for tracer to complete
            tracer_exit_code = tracer_proc.wait()
        finally:
            signal.signal(signal.SIGINT, original_sigint)
            signal.signal(signal.SIGTERM, original_sigterm)

        # Give server a moment to flush any remaining frames
        time.sleep(0.2)

        # Terminate server
        if server_proc.poll() is None:
            server_proc.terminate()
            try:
                server_proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                server_proc.kill()
                server_proc.wait()

        return tracer_exit_code

    except Exception as exc:  # pragma: no cover
        print(f"Error: {exc}", file=sys.stderr)
        # Cleanup
        for proc in (server_proc,):
            if proc.poll() is None:
                proc.terminate()
        return 1


def _print_help() -> NoReturn:
    """Print help and exit."""
    parser = _build_parser()
    parser.print_help()
    sys.exit(0)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sonartrace",
        description="SonarTrace — real-time execution telemetry for audio sonification",
    )
    parser.add_argument("--version", action="version", version="%(prog)s 0.1.0")

    subparsers = parser.add_subparsers(dest="command", required=True)

    # run subcommand
    run_parser = subparsers.add_parser("run", help="Run a Python script with tracing")
    run_parser.add_argument("script", help="Path to the Python script to trace")
    run_parser.add_argument("script_args", nargs=argparse.REMAINDER, help="Arguments to pass to the script")
    run_parser.add_argument("--window-ms", type=int, default=50, help="Aggregation window in milliseconds (default: 50)")
    run_parser.add_argument("--threshold", type=int, default=20, help="CALL threshold per window before LOOP_BURST (default: 20)")
    run_parser.add_argument("--quiet", "-q", action="store_true", help="Suppress server/tracer output")
    run_parser.set_defaults(func=run_command)

    return parser


def main(argv: list[str] | None = None) -> int:
    """Main CLI entry point."""
    parser = _build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())