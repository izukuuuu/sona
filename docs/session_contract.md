# Session Contract v3

This project stores local conversations as durable session JSON files in `memory/STM`.

## Design Rules

- `messages` is the only source used to rebuild model context.
- `agent_events` stores UI/runtime stream events and must never be injected into model context.
- Tool context must be round-trippable: every `tool` message with `tool_call_id` must have a preceding assistant message with a matching `tool_calls[].id`.
- Tool messages follow a Lobe-compatible shape: assistant messages carry `tools`; tool result messages link back with `parent_id` and `plugin`.
- Session files are schema-versioned and normalized on load/save.
- Legacy files are migrated in place after backup.

## Shape

```json
{
  "schema_version": 3,
  "task_id": "uuid",
  "status": "active",
  "created_at": "iso",
  "updated_at": "iso",
  "description": "display title",
  "initial_query": "first user query",
  "messages": [],
  "agent_events": [],
  "harness_memory": {
    "session_prefs": {},
    "notes": {}
  },
  "token_usage": {
    "total_tokens": 0,
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "steps": []
  }
}
```

## Message Contract

Allowed roles: `user`, `assistant`, `tool`, `system`.

Common fields:

- `id`: stable message id.
- `role`: one allowed role.
- `content`: string.
- `timestamp`: ISO timestamp.
- `metadata`: optional object.

Assistant tool-call fields:

```json
{
  "role": "assistant",
  "content": "",
  "tool_calls": [
    {
      "id": "tool-call-id",
      "name": "tool_name",
      "args": {},
      "type": "function",
      "function": {
        "name": "tool_name",
        "arguments": "{}"
      },
      "identifier": "sona",
      "apiName": "tool_name"
    }
  ],
  "tools": [
    {
      "id": "tool-call-id",
      "name": "tool_name",
      "args": {},
      "type": "function",
      "function": {
        "name": "tool_name",
        "arguments": "{}"
      },
      "identifier": "sona",
      "apiName": "tool_name"
    }
  ]
}
```

Tool result fields:

```json
{
  "role": "tool",
  "parent_id": "assistant-message-id",
  "tool_name": "tool_name",
  "tool_call_id": "tool-call-id",
  "content": "tool output",
  "plugin": {
    "toolCallId": "tool-call-id",
    "apiName": "tool_name",
    "identifier": "sona",
    "type": "default",
    "arguments": "",
    "state": { "status": "success" }
  }
}
```

## Lobe Mapping

LobeChat stores tool calls in the assistant message `tools` JSONB field. Tool result messages are ordinary messages with `role: "tool"` and a `parentId` relationship to the assistant tool-call message. Extra tool metadata is kept in a plugin side table keyed by the tool result message and `toolCallId`.

This repository keeps a file-based equivalent:

- `assistant.tool_calls`: LangChain/OpenAI-compatible context recovery.
- `assistant.tools`: Lobe-compatible UI/tool payload.
- `tool.parent_id`: file-based equivalent of Lobe `parentId`.
- `tool.plugin`: file-based equivalent of Lobe `message_plugins`.

The frontend can render this the Lobe way by grouping tool messages under `parent_id`, while model context recovery keeps using `tool_calls` plus `tool_call_id`.

## Migration

Run:

```powershell
.\.venv\Scripts\python.exe scripts\migrate_sessions.py
```

The script backs up changed files under `cache/session_migration_backup/<timestamp>/`.
