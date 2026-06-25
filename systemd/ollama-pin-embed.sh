#!/usr/bin/env bash
# Pin nomic-embed-text in ollama (keep_alive=-1) so the draft/RAG path never pays
# the ~31s cold-load on the 8GB Jetson. Paired with OLLAMA_MAX_LOADED_MODELS=2
# (mailbox/docker-compose.yml) so embed + one 4B stay resident and the two 4B
# models (draft / persona) take turns. Run by ollama-pin-embed.timer every 3 min.
# Ollama is host-published at 127.0.0.1:11435 (compose override -> container 11434).
curl -sf -m 20 -X POST http://127.0.0.1:11435/api/embeddings \
  -H 'content-type: application/json' \
  -d '{"model":"nomic-embed-text:v1.5","prompt":"keepwarm","keep_alive":-1}' >/dev/null 2>&1
