"""Validate one-shot request shapes before process or board operations begin."""

import json

from jsonschema import Draft202012Validator, ValidationError

MAX_REQUEST_BYTES = 65536
TEXT = {"type": "string", "maxLength": 32768}
NONEMPTY_TEXT = {**TEXT, "minLength": 1}
PID = {"type": "integer", "minimum": 1, "maximum": 0xFFFFFFFF}
BIRTH = {"type": "string", "pattern": "^[0-9]+$", "minLength": 1, "maxLength": 20}


class InvalidRequest(ValueError):
    code = "HELPER_REQUEST_INVALID"
    outcome = "unchanged"


def object_schema(properties: dict, required: list[str]) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


OWNER = object_schema({"pid": PID, "birth": BIRTH}, ["pid"])
RECORD = object_schema(
    {"pid": PID, "birth": BIRTH, "owner": OWNER, "job": NONEMPTY_TEXT, "remote": BIRTH},
    ["pid", "birth", "owner", "job", "remote"],
)
PROCESS = object_schema(
    {"pid": PID, "birth": BIRTH, "precision": {"enum": ["filetime", "microseconds"]}},
    ["pid"],
)
PATHS = object_schema(
    {key: NONEMPTY_TEXT for key in ("lease", "marker", "confirmation")},
    ["lease", "marker", "confirmation"],
)
COMPUTE_SHAPES = {
    "process-identities": (
        {"processes": {"type": "array", "items": PROCESS, "maxItems": 1024}},
        ["processes"],
    ),
    "confirm-board": ({"paths": PATHS}, ["paths"]),
    "launch": (
        {
            "argv": {"type": "array", "items": NONEMPTY_TEXT, "minItems": 1, "maxItems": 512},
            "owner": OWNER,
            "directory": NONEMPTY_TEXT,
        },
        ["argv", "owner"],
    ),
    "sample": ({"pids": {"type": "array", "items": PID, "maxItems": 1024}}, ["pids"]),
}
for command in ("stop", "release", "state"):
    COMPUTE_SHAPES[command] = ({"record": RECORD}, ["record"])
for command in ("recover-launch", "stop-directory", "release-directory"):
    COMPUTE_SHAPES[command] = ({"directory": NONEMPTY_TEXT}, ["directory"])
COMPUTE_VALIDATORS = {
    command: Draft202012Validator(
        object_schema({"command": {"const": command}, **properties}, ["command", *required])
    )
    for command, (properties, required) in COMPUTE_SHAPES.items()
}

HELPER_PROPERTIES = {
    "socket": TEXT,
    "token": TEXT,
    "pythonPath": NONEMPTY_TEXT,
    "timeoutMs": {"type": "integer", "minimum": 1},
    "directory": NONEMPTY_TEXT,
    "boardPath": NONEMPTY_TEXT,
    "instance": NONEMPTY_TEXT,
    "clientName": NONEMPTY_TEXT,
    "nets": {"type": "array", "items": TEXT, "maxItems": 10000},
    "avoidObjectIds": {"type": "array", "items": NONEMPTY_TEXT, "maxItems": 10000},
    "allowDesignViolations": {"type": "boolean"},
}
HELPER_VALIDATORS = {
    command: Draft202012Validator(
        object_schema(HELPER_PROPERTIES, [] if command == "discover" else ["socket", "directory"])
    )
    for command in (
        "discover",
        "export",
        "review",
        "repair",
        "import",
        "fill",
        "preview",
        "clear-preview",
    )
}


def read_request(stream) -> dict:
    payload = stream.read(MAX_REQUEST_BYTES + 1)
    if len(payload) > MAX_REQUEST_BYTES:
        raise InvalidRequest("请求内容超过允许大小，尚未执行任何板子操作")
    try:
        return json.loads(payload)
    except (ValueError, UnicodeError):
        raise InvalidRequest("请求格式无效，尚未执行任何板子操作") from None


def validate_request(request, validators: dict, command) -> dict:
    validator = validators.get(command) if isinstance(command, str) else None
    if validator is None:
        raise InvalidRequest("请求操作无法识别，尚未执行任何板子操作")
    try:
        validator.validate(request)
    except ValidationError:
        # ValidationError contains the input value, including IPC credentials.
        raise InvalidRequest("请求字段缺失或类型无效，尚未执行任何板子操作") from None
    return request


def compute_request(stream) -> dict:
    request = read_request(stream)
    command = request.get("command") if isinstance(request, dict) else None
    return validate_request(request, COMPUTE_VALIDATORS, command)


def helper_request(stream, command: str) -> dict:
    return validate_request(read_request(stream), HELPER_VALIDATORS, command)
