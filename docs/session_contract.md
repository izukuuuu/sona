# Session Contract v4

The web/API runtime stores conversations in a SQLite database file. The default
path is `data/sona.db`, and `SONA_SESSION_DB_PATH` can override it. The same DB
file also hosts official LangGraph SQLite checkpoint tables created by
`langgraph-checkpoint-sqlite`; application code must not reimplement or mutate
those internal checkpoint tables directly.

Legacy JSON files under `memory/STM` are migration/archive input only. They must
not drive the frontend recent-topic list or `/v1/tasks` in production.

## Design Rules

- `messages` is the only source used to rebuild model context.
- `session_id` is the public API identifier and maps 1:1 to LangGraph `thread_id`.
- LangGraph checkpoint state is addressed with `thread_id`, `checkpoint_ns`, and
  `checkpoint_id`; Sona stores those references on `agent_runs`.
- `agent_events` stores UI/runtime stream events and must never be injected into model context.
- Tool context must be round-trippable: every `tool` message with `tool_call_id` must have a preceding assistant message with a matching `tool_calls[].id`.
- Tool messages follow a Lobe-compatible shape: assistant messages carry `tools`; tool result messages link back with `parent_id` and `plugin`.
- Session files are schema-versioned and normalized on load/save.
- Legacy STM files are imported with `scripts/migrate_stm_to_sqlite.py`; smoke/test sessions are skipped by default.
- `agent_events`, `agent_runs`, and `artifacts` are not model context. They are UI/runtime/audit data.
- Cross-session long-term memory is stored as namespace/key JSON records in
  `memory_store`, not in `messages` or checkpoint history.
- SQLite is the portable single-backend deployment target. Multi-backend
  concurrent writers should move the repository/checkpointer implementation to
  Postgres without changing the frontend contract.

## Session Shape

```json
{
  "schema_version": 3,
  "task_id": "uuid",
  "thread_id": "uuid",
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

`schema_version` remains the session envelope version. Application database
migrations are tracked separately in `schema_migrations`.

SQLite stores that envelope across normalized tables:

- `sessions`: thread metadata, title, timestamps, status, soft delete.
- `conversation_items`: ordered model-context item stream, append-first with stable item IDs.
- `agent_runs`: execution lifecycle plus LangGraph checkpoint references.
- `agent_events`: UI/audit stream, excluded from model context.
- `artifacts`: reports, traces, sandbox/object paths.
- `session_prefs`: session-scoped harness memory.
- `memory_store`: long-term JSON memory organized by namespace and key.
- `schema_migrations`: application database schema version.

LangGraph owns its official checkpoint tables in the same SQLite file. Current
known table names include `checkpoints` and `writes`, but application code must
interact with them through `SqliteSaver`.

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
.\.venv\Scripts\python.exe scripts\migrate_stm_to_sqlite.py --dry-run
.\.venv\Scripts\python.exe scripts\migrate_stm_to_sqlite.py --apply
```

The script leaves STM files untouched. Known smoke/test sessions are skipped unless `--include-test` is provided.
