#!/bin/sh
# Verifies the gateway picked up a real API key — prints status only, never the key.
health=$(curl -s http://127.0.0.1:4519/health)
echo "gateway: $health"
case "$health" in
  *'"provider":"anthropic"'*) echo "✓ live model in use" ;;
  *'"provider":"mock"'*)      echo "✗ still mock — key not picked up (restart fren after editing .env)" ;;
  *)                          echo "✗ gateway not reachable — is it running?" ;;
esac
