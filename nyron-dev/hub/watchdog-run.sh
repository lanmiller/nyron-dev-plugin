#!/bin/sh
# watchdog-run.sh <корень-проекта> — один тик надзирателя (для launchd/cron).
# Ошибки самого ядра видимы: guard-обёртка пишет их в канал ошибок будки
# (STOVP-41), наружу всегда 0 — расписание не сыпется.
ROOT="${1:?usage: watchdog-run.sh <project-root>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 0
exec sh "$HERE/../hooks/guard.sh" watchdog node "$HERE/watchdog.mjs"
