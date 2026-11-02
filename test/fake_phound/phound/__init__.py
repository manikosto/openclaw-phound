"""A stand-in for the phound SDK: just enough surface for phound_bridge.py, driven by a script."""

import os
import sys
import threading
import time

from phound.events import Call, ChatMessageStub, StreamStatus, StreamUpdate


def log(*parts):
    print("FAKE", *parts, file=sys.stderr, flush=True)
    if os.environ.get("FAKE_PHOUND_LOG"):
        with open(os.environ["FAKE_PHOUND_LOG"], "a", encoding="utf-8") as f:
            print("FAKE", *parts, file=f)


class Phound:
    def __init__(self):
        self.chat_factory = None
        self.call_factory = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def register_chat_handler(self, factory, chat_types=None):
        self.chat_factory = factory

    def register_call_handler(self, factory):
        self.call_factory = factory

    def send_message_nowait(self, text, from_persona_uid, chat_id="", persona_uid="", text_format=1, attachments=None, **_):
        log("process-send", repr(text), from_persona_uid, chat_id, persona_uid, int(text_format), *(["attachments", repr(attachments)] if attachments else []))

    def make_call(self, from_persona_uid, phone_number):
        log("make-call", from_persona_uid, phone_number)

    def start_listen_events(self):
        log("env-openai", "OPENAI_API_KEY" in os.environ)
        time.sleep(0.3)
        chat = self.chat_factory(chat_id="chat-1", persona_uid="bot-persona")
        chat.on_start()
        chat.on_message(ChatMessageStub(f"m-{time.time_ns()}", "hello bot", "chat-1", "bot-persona", "uid-alice", "Alice", "+15551234567"))
        call = self.call_factory(persona_uid="bot-persona")
        call.on_incoming_call(Call("call-1", "bot-persona", "", "Alice", "+15551234567", "+15550000000"))
        if call.answered_flag:
            call.on_call_chat_id("chat-1")
            call.on_call_ready()
        while True:
            time.sleep(1)
