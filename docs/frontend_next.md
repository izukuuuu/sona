# Next.js 前端集成说明

Sona 现在保留 Python CLI / Streamlit 入口，并在仓库根新增独立 `frontend/` 作为 Next.js App Router 前端。

## 启动

终端 1：启动 Python API。

```bash
sona serve --host 127.0.0.1 --port 8765
```

终端 2：启动 Next.js。

```bash
npm --prefix frontend install
npm --prefix frontend run dev
```

前端默认访问 `http://127.0.0.1:3000`。Next.js BFF 读取 `SONA_API_BASE`，默认代理到 `http://127.0.0.1:8765`。可在 `frontend/.env.local` 中覆盖：

```env
SONA_API_BASE=http://127.0.0.1:8765
```

## `/` 指令迁移

前端不直接驱动 CLI 终端循环，而是调用 FastAPI 专用端点：

| 前端指令 | API |
| --- | --- |
| `/new` | `POST /v1/chat/sessions` |
| `/memory` | `GET /v1/chat/sessions` |
| 普通输入 | `POST /v1/chat/sessions/{task_id}/messages:stream` |
| `/event <query>` | `POST /v1/analyze-event` |
| `/wiki <query>` | `POST /v1/wiki/query` |
| `/wiki-approve <selector>` | `POST /v1/wiki/approve` |
| `/case <query>` | `POST /v1/cases/search` |
| `/hot [config]` | `POST /v1/hot/run` |
| `/monitor list` | `GET /v1/monitor/topics` |
| `/monitor demo` | `POST /v1/monitor/demo` |
| `/monitor create 名称\|领域\|关键词1,关键词2` | `POST /v1/monitor/topics` |
| `/monitor status <topic_id>` | `GET /v1/monitor/topics/{topic_id}/status` |
| `/monitor report <topic_id> [daily\|weekly]` | `POST /v1/monitor/topics/{topic_id}/report` |
| `/models` | `GET /v1/models` |
| `/tools` | `GET /v1/tools` |

`/set`、`/compress`、`/clear`、`/exit` 属于 CLI 管理或生命周期指令，前端 v1 不在聊天输入中执行。

## 验证

```bash
.\.venv\Scripts\python.exe -m pytest tests/contracts/test_frontend_api.py
npm --prefix frontend run lint
npm --prefix frontend run build
```
