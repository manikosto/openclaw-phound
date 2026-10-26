from phound.events import StreamStatus, StreamUpdate


def _log(*parts):
    from phound import log

    log(*parts)


class BaseChatHandler:
    def __init__(self, chat_id="", persona_uid="", **_):
        self.chat_id = chat_id
        self.persona_uid = persona_uid

    def send_message_nowait(self, text, text_format=1, **_):
        _log("handler-send", self.chat_id, repr(text), int(text_format))

    def show_typing(self, timeout=60, **_):
        _log("typing", self.chat_id)


class BaseCallHandler:
    def __init__(self, persona_uid="", **_):
        self.persona_uid = persona_uid
        self.answered_flag = False
        self.answered = False
        self.hangup_reason = None

    def answer(self):
        self.answered_flag = True
        self.answered = True
        _log("answer")

    def reject(self):
        _log("reject")

    def hangup(self):
        _log("hangup")
        self.on_hangup()

    def start_stream(self, audio_format, rate, samples):
        _log("start-stream", audio_format, rate, samples)
        self.on_stream_update(StreamUpdate(StreamStatus.STARTED, "ws://127.0.0.1:1/fake-stream"))
