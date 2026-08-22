#!/bin/sh
# Verifies the gateway picked up a real API key — prints status only, never the key.
health=$(curl -s http://127.0.0.1:4519/health)
echo "gateway: $health"
case "$health" in
  *'"provider":"deepseek"'*)  echo "✓ live model in use (DeepSeek)" ;;
  *'"provider":"anthropic"'*) echo "✓ live model in use (Anthropic)" ;;
  *'"provider":"mock"'*)      echo "✗ still mock — no key picked up (restart fren after editing .env)" ;;
  *)                          echo "✗ gateway not reachable — is it running?" ;;
esac

case "$health" in
  *'"voice":"elevenlabs"'*) echo "✓ voice configured (ElevenLabs)" ;;
  *'"voice":null'*)         echo "· no voice key — fren replies in text only" ;;
esac
