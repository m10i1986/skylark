#!/usr/bin/bash

cd "$(dirname "$0")" || exit 1
exec bun run src/cli.ts "$@"
