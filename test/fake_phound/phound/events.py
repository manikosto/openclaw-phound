from dataclasses import dataclass, field
from enum import Enum


class StreamStatus(str, Enum):
    STARTED = "started"


@dataclass
class StreamUpdate:
    status: StreamStatus
    data: str


@dataclass
class ChatMessageStub:
    id: str
    text: str
    chat_id: str
    persona_uid: str
    from_uid: str
    from_name: str
    from_number: str
    chat_type: str = "private"
    chat_title: str = ""
    attachments: list = field(default_factory=list)


@dataclass
class Call:
    id: str
    persona_uid: str
    from_persona_uid: str
    from_name: str
    from_number: str
    local_number: str
