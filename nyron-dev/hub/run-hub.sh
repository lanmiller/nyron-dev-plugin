#!/bin/sh
# Лаунчер MCP-будки: GUI-приложение (Claude Desktop) не имеет homebrew/nvm в
# PATH — голый `command: "node"` в .mcp.json не резолвится, сервер молча не
# стартует, hub_* тулов нет (грабля рестарта 22.07). Ищем node по известным
# местам, затем exec.
DIR="$(cd "$(dirname "$0")" && pwd)"
for N in node /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node/"*/bin/node; do
  command -v "$N" >/dev/null 2>&1 && exec "$N" "$DIR/server.mjs"
done
echo '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"node not found for nyron-hub"}}' >&2
exit 127
