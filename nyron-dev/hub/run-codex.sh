#!/bin/sh
# Тот же PATH-фикс для codex MCP (GUI-окружение без homebrew/npm-global).
for C in codex /opt/homebrew/bin/codex /usr/local/bin/codex "$HOME/.local/bin/codex" "$HOME/.npm-global/bin/codex"; do
  command -v "$C" >/dev/null 2>&1 && exec "$C" mcp-server
done
echo "codex not found" >&2
exit 127
