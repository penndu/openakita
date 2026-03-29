"""
OpenAkita 核心模块
"""

from .agent_state import AgentState, TaskState, TaskStatus
from .errors import UserCancelledError
from .identity import Identity


def __getattr__(name: str):
    if name == "Agent":
        from .agent import Agent
        return Agent
    if name == "Brain":
        from .brain import Brain
        return Brain
    if name == "RalphLoop":
        from .ralph import RalphLoop
        return RalphLoop
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "Agent", "AgentState", "TaskState", "TaskStatus",
    "Brain", "Identity", "RalphLoop", "UserCancelledError",
]
