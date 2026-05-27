"""Session 管理：处理会话的创建、保存、加载和列表。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from utils.session_contract import SESSION_SCHEMA_VERSION, append_agent_event, normalize_session_data
from utils.path import ensure_memory_dirs
from utils.session_repository import get_session_repository


class SessionManager:
    """Session 管理器：处理会话的持久化。"""
    
    def __init__(self):
        """初始化 Session 管理器。"""
        self.repository = get_session_repository()
        # STM JSON is now a legacy migration/archive location. Keep the
        # attribute for report hints and old scripts, but do not use it as the
        # production source of truth.
        self.stm_dir = ensure_memory_dirs()
    
    def create_session(self, initial_query: str) -> str:
        """
        创建新会话。
        
        Args:
            initial_query: 初始查询
            
        Returns:
            任务 ID（session ID）
        """
        session_id = str(uuid.uuid4())
        session_data = {
            "schema_version": SESSION_SCHEMA_VERSION,
            "session_id": session_id,
            "created_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
            "status": "active",
            "description": f"初始对话：{initial_query}",
            "initial_query": initial_query,
            "messages": [],
            "agent_events": [],
            # harness 级可进化记忆（与 messages 分离，便于审计/回滚/灰度）
            # - session_prefs: 会话记忆（临时偏好，例如 wiki style/topk/weibo 开关等）
            # - notes: 可选的结构化标注（例如用户偏好、约束、审阅结论）
            "harness_memory": {
                "session_prefs": {},
                "notes": {},
            },
            "token_usage": {
                "total_tokens": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "steps": []
            }
        }
        
        self.save_session(session_id, session_data)
        return session_id
    
    def save_session(
        self,
        task_id: str,
        session_data: Dict[str, Any],
        final_query: Optional[str] = None
    ) -> None:
        """
        保存会话数据
        
        Args:
            task_id: 任务 ID
            session_data: 会话数据
            final_query: 最终查询（用于更新描述）
        """
        session_data = normalize_session_data({**session_data, "session_id": task_id, "task_id": task_id})
        session_data["updated_at"] = datetime.now().isoformat()
        
        # 如果提供了最终查询，更新描述
        if final_query:
            session_data["description"] = f"分析{final_query}"
        
        self.repository.save_session(task_id, session_data)
    
    def replace_messages(
        self,
        task_id: str,
        messages: List[Dict[str, Any]],
        reset_token_usage: bool = True
    ) -> None:
        """
        替换会话中的所有消息（用于消息压缩后更新）
        
        Args:
            task_id: 任务 ID
            messages: 新的消息列表（dict 格式）
            reset_token_usage: 是否重置 token_usage（压缩后应重置，因为旧消息的 token 不再计入上下文）
        """
        session_data = self.load_session(task_id)
        if not session_data:
            return
        
        session_data["messages"] = messages
        session_data["updated_at"] = datetime.now().isoformat()
        
        # 压缩后重置 token_usage
        if reset_token_usage:
            if "token_usage" in session_data:
                # 重置累计值，但保留 steps 记录
                session_data["token_usage"]["total_tokens"] = 0
                session_data["token_usage"]["prompt_tokens"] = 0
                session_data["token_usage"]["completion_tokens"] = 0
        
        self.save_session(task_id, session_data)
    
    def load_session(self, task_id: str) -> Optional[Dict[str, Any]]:
        """
        加载会话数据
        
        Args:
            task_id: 任务 ID
            
        Returns:
            会话数据，如果不存在则返回 None
        """
        return self.repository.load_session(task_id)
    
    def list_sessions(self, limit: int = 5) -> List[Dict[str, Any]]:
        """
        列出最近的会话
        
        Args:
            limit: 返回的会话数量限制
            
        Returns:
            会话列表，按更新时间倒序排列
        """
        return self.repository.list_sessions(limit)

    def update_session(self, task_id: str, *, description: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """更新会话元数据。"""
        session_data = self.load_session(task_id)
        if not session_data:
            return None

        if description is not None:
            session_data["description"] = description

        self.save_session(task_id, session_data)
        return self.load_session(task_id)

    def update_message(
        self,
        task_id: str,
        message_id: str,
        *,
        content: str,
        mode: str = "message",
    ) -> Optional[Dict[str, Any]]:
        """Update one canonical message, optionally pruning following branch context."""
        session_data = self.load_session(task_id)
        if not session_data:
            return None
        messages = session_data.get("messages") if isinstance(session_data.get("messages"), list) else []
        index = next((i for i, item in enumerate(messages) if item.get("id") == message_id), -1)
        if index < 0:
            return None

        next_messages = [dict(item) for item in messages]
        next_messages[index]["content"] = content
        next_messages[index]["timestamp"] = datetime.now().isoformat()
        if mode == "branch":
            next_messages = next_messages[: index + 1]
        session_data["messages"] = next_messages
        self.save_session(task_id, session_data)
        return self.load_session(task_id)

    def delete_message(self, task_id: str, message_id: str, *, mode: str = "turn") -> Optional[Dict[str, Any]]:
        """Delete one message or one visible conversation turn."""
        session_data = self.load_session(task_id)
        if not session_data:
            return None
        messages = session_data.get("messages") if isinstance(session_data.get("messages"), list) else []
        index = next((i for i, item in enumerate(messages) if item.get("id") == message_id), -1)
        if index < 0:
            return None

        if mode == "branch":
            next_messages = messages[:index]
        elif mode == "message":
            next_messages = [item for i, item in enumerate(messages) if i != index]
        else:
            end = index + 1
            if messages[index].get("role") == "user":
                while end < len(messages) and messages[end].get("role") != "user":
                    end += 1
            else:
                while end < len(messages) and messages[end].get("role") != "user":
                    end += 1
            next_messages = messages[:index] + messages[end:]

        session_data["messages"] = next_messages
        self.save_session(task_id, session_data)
        return self.load_session(task_id)

    def delete_session(self, task_id: str) -> bool:
        """删除会话文件。"""
        return self.repository.soft_delete_session(task_id)
    
    def add_message(
        self,
        task_id: str,
        role: str,
        content: str,
        tool_name: Optional[str] = None,
        tool_calls: Optional[List[Dict[str, Any]]] = None,
        tool_call_id: Optional[str] = None
    ) -> None:
        """
        向会话添加消息
        
        Args:
            task_id: 任务 ID
            role: 消息角色（user/assistant/tool）
            content: 消息内容
            tool_name: 工具名称（仅当 role 为 tool 时使用）
            tool_calls: 工具调用信息（仅当 role 为 assistant 时使用）
            tool_call_id: 工具调用 ID（仅当 role 为 tool 时使用，必须与对应的 assistant 消息中的 tool_calls[].id 匹配）
        """
        session_data = self.load_session(task_id)
        if not session_data:
            return

        msg_data = {
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat()
        }
        
        if tool_name:
            msg_data["tool_name"] = tool_name
        
        if tool_calls:
            msg_data["tool_calls"] = tool_calls
        
        if tool_call_id:
            msg_data["tool_call_id"] = tool_call_id

        final_query: Optional[str] = None
        if role == "user":
            messages = session_data.get("messages") if isinstance(session_data.get("messages"), list) else []
            user_count = sum(1 for m in messages if m.get("role") == "user") + 1
            if user_count == 1:
                final_query = content

        self.repository.append_conversation_item(task_id, msg_data)
        if final_query:
            self.repository.update_session_metadata(
                task_id,
                title=f"分析{final_query}",
                initial_query=final_query,
            )

    def add_agent_event(self, task_id: str, event: Dict[str, Any]) -> None:
        """Append a UI/runtime event outside canonical model messages."""
        session_data = self.load_session(task_id)
        if not session_data:
            return
        normalized = append_agent_event(session_data, event)["agent_events"][-1]
        self.repository.append_agent_event(task_id, normalized)
    
    def add_token_usage(
        self,
        task_id: str,
        step_name: str,
        prompt_tokens: int,
        completion_tokens: int,
        total_tokens: int
    ) -> None:
        """
        添加 token 使用记录
        
        Args:
            task_id: 任务 ID
            step_name: 步骤名称
            prompt_tokens: Prompt tokens
            completion_tokens: Completion tokens
            total_tokens: 总 tokens
        """
        session_data = self.load_session(task_id)
        if not session_data:
            return
        
        if "token_usage" not in session_data:
            session_data["token_usage"] = {
                "total_tokens": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "steps": []
            }
        
        token_usage = session_data["token_usage"]
        token_usage["total_tokens"] += total_tokens
        token_usage["prompt_tokens"] += prompt_tokens
        token_usage["completion_tokens"] += completion_tokens
        
        token_usage["steps"].append({
            "step_name": step_name,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "timestamp": datetime.now().isoformat()
        })
        
        self.save_session(task_id, session_data)


# 全局 Session 管理器实例
_session_manager: Optional[SessionManager] = None


def get_session_manager() -> SessionManager:
    """获取全局 Session 管理器实例。"""
    global _session_manager
    if _session_manager is None:
        _session_manager = SessionManager()
    return _session_manager
