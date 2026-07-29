#!/usr/bin/env python3
"""jira-slim.py — прокси-фильтр stdio-MCP для mcp-atlassian.

Проблема (диагноз 28.07): jira_transition_issue / jira_assign_issue /
jira_add_comment возвращают ВЕСЬ тикет со всеми комментами эхом. У тикета
с девятью простынями это десятки повторов одного текста за смену — токены
волн улетают в космос на чтение того, что они сами только что написали.

Решение: обёртка запускает настоящий сервер (docker mcp-atlassian) и
пропускает через себя JSON-RPC поток. Ответы «шумных» тулз ужимаются до
короткого подтверждения; всё остальное проходит нетронутым. Это НЕ форк
сервера — прозрачный слой, сервер обновляется как обновлялся.

Подключение (.mcp.json проекта): command = python3, args =
["<плагин>/nyron-dev/hub/jira-slim.py", "docker", "run", "-i", ...те же
аргументы, что были...]. Переменные окружения проходят насквозь.
"""
import json
import os
import subprocess
import sys
import threading

# Тулзы, чьи ответы ужимаем, и какие поля из ответа оставить (если найдём).
NOISY = {
    "jira_transition_issue": ("key", "status"),
    "jira_assign_issue": ("key", "assignee"),
    "jira_add_comment": ("id", "created", "author"),
    "jira_edit_comment": ("id", "created", "author"),
    "jira_update_issue": ("key", "status"),
    "jira_link_to_epic": ("key",),
    "jira_create_issue_link": (),
}
MAX_PASS = 2000  # символов: ответы короче не трогаем вообще


def slim_payload(tool: str, text: str) -> str:
    """Ужать текст результата шумной тулзы до подтверждения с ключевыми полями."""
    keep = NOISY[tool]
    picked = {}
    try:
        data = json.loads(text)
        if isinstance(data, dict) and isinstance(data.get("result"), str):
            data = json.loads(data["result"])
        if isinstance(data, dict):
            for k in keep:
                v = data.get(k)
                if isinstance(v, dict):
                    v = v.get("name") or v.get("display_name") or v.get("displayName") or v
                if v is not None:
                    picked[k] = v
    except (ValueError, TypeError):
        pass
    parts = ", ".join(f"{k}={v}" for k, v in picked.items())
    return (
        f"OK [{tool}] {parts}\n"
        f"(полный ответ усечён jira-slim: сервер возвращает весь тикет эхом; "
        f"нужны детали — jira_get_issue с узким fields)"
    )


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: jira-slim.py <real-server-cmd> [args...]\n")
        return 2
    proc = subprocess.Popen(
        sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=sys.stderr, bufsize=0, env=os.environ,
    )
    pending: dict = {}  # id запроса -> имя тулзы (только для tools/call)
    lock = threading.Lock()

    def pump_requests() -> None:  # Claude -> сервер
        try:
            for raw in sys.stdin.buffer:
                try:
                    msg = json.loads(raw)
                    if msg.get("method") == "tools/call":
                        name = (msg.get("params") or {}).get("name", "")
                        if name in NOISY and msg.get("id") is not None:
                            with lock:
                                pending[msg["id"]] = name
                except ValueError:
                    pass
                proc.stdin.write(raw)
                proc.stdin.flush()
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass

    threading.Thread(target=pump_requests, daemon=True).start()

    out = sys.stdout.buffer
    for raw in proc.stdout:  # сервер -> Claude
        line = raw
        try:
            msg = json.loads(raw)
            mid = msg.get("id")
            with lock:
                tool = pending.pop(mid, None) if mid is not None else None
            if tool and isinstance(msg.get("result"), dict):
                content = msg["result"].get("content")
                if isinstance(content, list):
                    total = sum(len(c.get("text", "")) for c in content
                                if isinstance(c, dict) and c.get("type") == "text")
                    if total > MAX_PASS:
                        big = next(c for c in content
                                   if isinstance(c, dict) and c.get("type") == "text")
                        msg["result"]["content"] = [{
                            "type": "text",
                            "text": slim_payload(tool, big.get("text", "")),
                        }]
                        line = (json.dumps(msg, ensure_ascii=False) + "\n").encode()
        except (ValueError, TypeError, StopIteration):
            pass
        out.write(line)
        out.flush()
    return proc.wait()


if __name__ == "__main__":
    sys.exit(main())
