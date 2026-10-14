"""Internal ownership and resource records exchanged with the Node host.

These annotations describe existing JSON fields; they do not replace runtime
identity checks, size limits or protocol validation at the IPC boundary.
"""

from typing import Literal, NotRequired, TypedDict

ProcessState = Literal["alive", "closed"]


class ProcessOwner(TypedDict):
    pid: int
    birth: NotRequired[str]


class ComputeRecord(TypedDict):
    pid: int
    birth: str
    owner: ProcessOwner
    job: str
    remote: str


class ProcessMemory(TypedDict):
    pid: int
    private: int
    working: int


class ResourceSample(TypedDict):
    available: int
    commitAvailable: int
    total: int
    processes: list[ProcessMemory]
