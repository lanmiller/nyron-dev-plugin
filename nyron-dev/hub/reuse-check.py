#!/usr/bin/env python3
"""Проверка переиспользования: прототип перенесён или нарисован заново.

Боевой случай 12.08.2026: в прототипе лежали шесть готовых компонентов, волна
посмотрела на них как на картинку и написала разметку с нуля — ветка +4819
строк, ссылок на компоненты прототипа ноль. Согласование при этом потеряло
смысл: правки прототипа в бой уже не попадут.

Скрипт сравнивает компоненты прототипа с тем, что реально импортирует ветка.

    python3 reuse-check.py --proto <каталог-прототипа> --repo <worktree> [-b main]

Код возврата: 0 — хотя бы один компонент переиспользован; 1 — ни одного
(сдача не проходит, нужно решение постановщика); 2 — ошибка запуска.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

COMPONENT_SUFFIXES = (".svelte", ".jsx", ".tsx", ".vue")


def git(repo, *args):
    r = subprocess.run(["git", "-C", str(repo), *args],
                       capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"ошибка git: {r.stderr.strip()}")
    return r.stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--proto", required=True, help="каталог прототипа")
    ap.add_argument("--repo", required=True, help="worktree проверяемой ветки")
    ap.add_argument("-b", "--base", default="main", help="базовая ветка (default: main)")
    args = ap.parse_args()

    proto = Path(args.proto)
    if not proto.is_dir():
        sys.exit(2)

    components = sorted(p.stem for p in proto.rglob("*")
                        if p.suffix in COMPONENT_SUFFIXES and p.stem[:1].isupper())
    if not components:
        print(f"в прототипе {proto} нет компонентов — проверять нечего")
        return 0

    base = args.base
    merge_base = git(args.repo, "merge-base", f"origin/{base}", "HEAD").strip() \
        or git(args.repo, "merge-base", base, "HEAD").strip()
    diff = git(args.repo, "diff", f"{merge_base}..HEAD")

    # добавленные строки вне самого прототипа
    added, cur_file, proto_name = [], "", proto.name
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            cur_file = line[6:]
        elif line.startswith("+") and not line.startswith("+++"):
            if proto_name not in cur_file:
                added.append(line)
    body = "\n".join(added)

    used = [c for c in components
            if re.search(rf"\b{re.escape(c)}\b", body)]
    lost = [c for c in components if c not in used]

    print(f"компонентов в прототипе: {len(components)} — {', '.join(components)}")
    print(f"переиспользовано боевым кодом: {len(used)}"
          + (f" — {', '.join(used)}" if used else ""))
    if lost:
        print(f"НЕ переиспользовано: {', '.join(lost)}")
    print(f"добавлено строк вне прототипа: {len(added)}")

    if not used:
        print("\nБЛОКЕР: прототип согласован, но ни один его компонент не"
              " использован — экран написан заново.\nЛибо перенести компоненты,"
              " либо получить решение постановщика, почему они не подошли.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
