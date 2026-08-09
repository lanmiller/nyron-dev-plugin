#!/bin/sh
# watchdog-run.sh <корень-проекта> — один тик надзирателя (для launchd/cron).
# Ошибки самого ядра видимы: guard-обёртка пишет их в канал ошибок будки
# (STOVP-41), наружу всегда 0 — расписание не сыпется.
ROOT="${1:?usage: watchdog-run.sh <project-root>}"
# ExperimentalWarning node:sqlite летел в stderr и guard писал ЛОЖНУЮ аварию
# в канал ошибок КАЖДЫЙ тик (пойман 09.08 первым же боевым днём)
export NODE_NO_WARNINGS=1
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 0
exec sh "$HERE/../hooks/guard.sh" watchdog node "$HERE/watchdog.mjs"
