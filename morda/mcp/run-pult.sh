#!/bin/sh
# Лаунчер MCP-коннектора пульта: GUI-приложение (Claude Desktop) не имеет
# homebrew/nvm в PATH — голый `node` не резолвится и сервер молча не стартует
# (та же грабля, что у будки 22.07). Ищем node по известным местам, затем exec.
DIR="$(cd "$(dirname "$0")" && pwd)"
for N in node /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node" "$HOME/.nvm/versions/node/"*/bin/node; do
  command -v "$N" >/dev/null 2>&1 && exec "$N" "$DIR/pult-mcp.mjs"
done
echo '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"node not found for pult"}}' >&2
exit 127
