"""CLI package for SonarTrace."""

from . import _tracer_main  # noqa: F401
from .cli import main, run_command

__all__ = ["main", "run_command"]