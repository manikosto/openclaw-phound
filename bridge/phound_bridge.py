"""Phound bridge for the OpenClaw channel plugin.

Runs the Phound SDK (and through it uccrobot) and speaks newline-delimited JSON
with the plugin: events go out on stdout, commands come in on stdin. The plugin
owns every decision (who may talk to the bot, what to answer); this process only
moves messages and call control between Phound and OpenClaw.

Call audio does not pass through here: on an answered call the bridge starts a
PCM stream and hands the plugin its websocket URL, and the plugin talks to it
directly.
"""

import functools
import json
import logging
import os
import sys
import threading

from phound import Phound
from phound.chats.text_helpers import MessageTextFormat
from phound.events import StreamStatus
from phound.handlers import BaseCallHandler, BaseChatHandler


STREAM_RATE = 16000
STREAM_SAMPLES = 320
# How long an incoming call rings while the plugin decides whether to take it.
CALL_DECISION_SECONDS = 15.0

logger = logging.getLogger("phound_bridge")


class Wire:
    """The JSON-lines link to the plugin. Writes are serialised across handler threads."""

    def __init__(self, out):
        self._out = out
        self._lock = threading.Lock()

    def emit(self, event, **fields):
        line = json.dumps({"event": event, **fields}, ensure_ascii=False)
        with self._lock:
            self._out.write(line + "\n")
            self._out.flush()


class Registry:
    """What the command reader needs to reach live handlers from its own thread."""

    def __init__(self):
        self.lock = threading.Lock()
        self.chats = {}  # chat_id -> BaseChatHandler
        self.calls = {}  # call_id -> CallHandler
        self.decisions = {}  # call_id -> (threading.Event, [accept])


def _attachments(message):
    return [{"name": a.name, "url": a.url, "size": a.size} for a in message.attachments]


def _message_fields(message):
    return {
        "message_id": message.id,
        "chat_id": message.chat_id,
        "chat_type": str(getattr(message.chat_type, "value", message.chat_type)),
        "chat_title": message.chat_title,
        "persona_uid": message.persona_uid,
        "from_uid": message.from_uid,
        "from_name": message.from_name,
        "from_number": message.from_number,
        "text": message.text,
        "attachments": _attachments(message),
    }


class ChatHandler(BaseChatHandler):
    def __init__(self, *, wire, registry, **kwargs):
        super().__init__(**kwargs)
        self._wire = wire
        self._registry = registry

    def on_start(self):
        with self._registry.lock:
            self._registry.chats[self.chat_id] = self

    def on_message(self, message):
        self._wire.emit("message", **_message_fields(message))

    def on_voice_message_completed(self, message):
        self._wire.emit(
            "voice_message",
            **_message_fields(message),
            audio_url=message.temporary_url or message.permanent_url,
        )


class CallHandler(BaseCallHandler):
    def __init__(self, *, wire, registry, **kwargs):
        super().__init__(**kwargs)
        self._wire = wire
        self._registry = registry
        self._id = ""

    def _register(self, call):
        self._id = call.id
        with self._registry.lock:
            self._registry.calls[call.id] = self

    def on_incoming_call(self, call):
        self._register(call)
        decided = threading.Event()
        verdict = [False]
        with self._registry.lock:
            self._registry.decisions[call.id] = (decided, verdict)
        self._wire.emit(
            "call_incoming",
            call_id=call.id,
            persona_uid=call.persona_uid,
            from_persona_uid=call.from_persona_uid,
            from_name=call.from_name,
            from_number=call.from_number,
            local_number=call.local_number,
        )
        # Blocking here is fine: this is the call's own thread, and the phone keeps ringing.
        decided.wait(CALL_DECISION_SECONDS)
        with self._registry.lock:
            self._registry.decisions.pop(call.id, None)
        if verdict[0]:
            self.answer()
        else:
            self.reject()

    def on_outgoing_call(self, call):
        self._register(call)
        # On an outgoing call the SDK reports the dialled number as from_number.
        self._wire.emit("call_outgoing", call_id=call.id, persona_uid=call.persona_uid, number=call.from_number)

    def on_call_chat_id(self, chat_id):
        self._wire.emit("call_chat", call_id=self._id, chat_id=chat_id)

    def on_call_ready(self):
        self._wire.emit("call_ready", call_id=self._id)
        self.start_stream("pcm", STREAM_RATE, STREAM_SAMPLES)

    def on_stream_update(self, stream):
        if stream.status == StreamStatus.STARTED and stream.data:
            self._wire.emit(
                "call_stream", call_id=self._id, url=stream.data, rate=STREAM_RATE, samples=STREAM_SAMPLES
            )

    def on_dtmf(self, dtmf):
        self._wire.emit("call_dtmf", call_id=self._id, digits=dtmf)

    def on_call_failed(self):
        self._wire.emit("call_failed", call_id=self._id)

    def on_hangup(self):
        with self._registry.lock:
            self._registry.calls.pop(self._id, None)
        self._wire.emit("call_hangup", call_id=self._id, answered=self.answered, reason=self.hangup_reason)


class Commands:
    def __init__(self, phound, wire, registry):
        self._phound = phound
        self._wire = wire
        self._registry = registry

    def handle(self, command):
        name = command.get("cmd")
        method = getattr(self, f"cmd_{name}", None)
        if method is None:
            raise ValueError(f"unknown command: {name}")
        return method(command)

    def cmd_send(self, c):
        chat_id = c.get("chat_id", "")
        text_format = MessageTextFormat.GPTMARKDOWN if c.get("markdown") else MessageTextFormat.PLAIN
        with self._registry.lock:
            handler = self._registry.chats.get(chat_id) if chat_id else None
        if handler is not None:
            # The handler's chat is already open, so nothing can be rejected.
            handler.send_message_nowait(c["text"], text_format=text_format)
            return {"chat_id": chat_id}
        self._phound.send_message_nowait(
            c["text"],
            from_persona_uid=c["from_persona_uid"],
            chat_id=chat_id,
            persona_uid=c.get("persona_uid", ""),
            text_format=text_format,
        )
        return {"chat_id": chat_id}

    def cmd_typing(self, c):
        with self._registry.lock:
            handler = self._registry.chats.get(c["chat_id"])
        if handler is not None:
            handler.show_typing(timeout=c.get("timeout", 30))
        return {}

    def cmd_call_decision(self, c):
        with self._registry.lock:
            pending = self._registry.decisions.get(c["call_id"])
        if pending is None:
            raise ValueError("no incoming call is waiting for a decision")
        decided, verdict = pending
        verdict[0] = bool(c["accept"])
        decided.set()
        return {}

    def cmd_hangup(self, c):
        with self._registry.lock:
            handler = self._registry.calls.get(c["call_id"])
        if handler is None:
            raise ValueError("call not found")
        handler.hangup()
        return {}

    def cmd_call(self, c):
        self._phound.make_call(c["from_persona_uid"], c["number"])
        return {}


def read_commands(commands, wire, stop):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        command = {}
        try:
            command = json.loads(line)
            result = commands.handle(command)
            wire.emit("reply", id=command.get("id"), ok=True, result=result)
        except Exception as error:  # pylint: disable=broad-exception-caught
            wire.emit("reply", id=command.get("id"), ok=False, error=f"{type(error).__name__}: {error}")
    # The plugin closed our stdin: it is shutting the account down.
    stop.set()


def main():
    # Keep stdout for the wire alone: anything else that prints goes to stderr.
    out = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    logging.basicConfig(
        stream=sys.stderr,
        level=os.environ.get("PHOUND_BRIDGE_LOG_LEVEL", "INFO"),
        format="[%(name)s] %(levelname)s %(message)s",
    )
    wire = Wire(out)
    registry = Registry()
    stop = threading.Event()
    with Phound() as phound:
        deps = {"wire": wire, "registry": registry}
        phound.register_chat_handler(functools.partial(ChatHandler, **deps))
        phound.register_call_handler(functools.partial(CallHandler, **deps))
        commands = Commands(phound, wire, registry)
        threading.Thread(target=read_commands, args=(commands, wire, stop), daemon=True).start()
        listener = threading.Thread(target=phound.start_listen_events, daemon=True)
        listener.start()
        wire.emit("ready")
        while not stop.wait(1.0):
            if not listener.is_alive():
                logger.error("Phound event listener stopped")
                break


if __name__ == "__main__":
    main()
