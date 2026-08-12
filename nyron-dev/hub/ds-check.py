#!/usr/bin/env python3
"""Обход дизайн-системы в UI-файлах ветки.

Боевой случай 12.08.2026 (DEV-1274): вместо компонента `Badge` в код уехал
голый `<button>` с классами из `badgeVariants` — визуально то же, компонент
дизайн-системы обойдён. Поймал человек глазами; правило «недостающее сначала
добавляется В САМУ дизайн-систему» было записано, но ничем не проверялось.

Две проверки по файлам, которые трогает ветка:

  БЛОКЕР      — голый интерактивный элемент рядом с импортом `*Variants`
                из дизайн-системы: классы компонента взяты, сам компонент нет.
  ПОДОЗРЕНИЕ  — новый интерактивный элемент в файле, где нет ни одного импорта
                из дизайн-системы.

    python3 ds-check.py --repo <worktree> [-b main] [--ds '$lib/components/ui']
    python3 ds-check.py --repo <worktree> --rev <ref> --path <файл>   # проверить один файл

Код возврата: 0 — чисто или только подозрения; 1 — есть блокер; 2 — ошибка.
"""

import argparse
import re
import subprocess
import sys

UI_SUFFIXES = (".svelte", ".jsx", ".tsx", ".vue")
RAW = re.compile(r"<(button|input|select|textarea)\b")
VARIANTS = re.compile(r"import\s*\{[^}]*\b(\w+Variants)\b[^}]*\}\s*from\s*['\"]([^'\"]+)")


def git(repo, *args, check=True):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    if check and r.returncode:
        sys.exit(f"ошибка git: {r.stderr.strip()}")
    return r.stdout


def inspect(path, text, ds):
    """Вернуть (блокеры, подозрения) для одного файла."""
    blockers, doubts = [], []
    raw_tags = {m.group(1) for m in RAW.finditer(text)}
    if not raw_tags:
        return blockers, doubts
    variants = [m.group(1) for m in VARIANTS.finditer(text) if ds in m.group(2)]
    has_ds_import = ds in text
    if variants:
        blockers.append(
            f"{path}: голый <{'>, <'.join(sorted(raw_tags))}> рядом с "
            f"{', '.join(sorted(set(variants)))} — классы компонента взяты, сам "
            f"компонент обойдён. Недостающее добавляется В САМУ дизайн-систему."
        )
    elif not has_ds_import:
        doubts.append(
            f"{path}: <{'>, <'.join(sorted(raw_tags))}> и ни одного импорта из "
            f"дизайн-системы — проверить, есть ли готовый компонент."
        )
    return blockers, doubts


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", required=True)
    ap.add_argument("-b", "--base", default="main")
    ap.add_argument("--ds", default="$lib/components/ui", help="путь импортов дизайн-системы")
    ap.add_argument("--rev", help="проверить файлы на этой ревизии (вместо диффа)")
    ap.add_argument("--path", action="append", help="конкретный файл (с --rev)")
    a = ap.parse_args()

    if a.rev and a.path:
        pairs = [(p, git(a.repo, "show", f"{a.rev}:{p}")) for p in a.path]
    else:
        mb = (git(a.repo, "merge-base", f"origin/{a.base}", "HEAD", check=False).strip()
              or git(a.repo, "merge-base", a.base, "HEAD").strip())
        files = [f for f in git(a.repo, "diff", "--name-only", f"{mb}..HEAD").split()
                 if f.endswith(UI_SUFFIXES)]
        rev = a.rev or "HEAD"
        pairs = [(f, git(a.repo, "show", f"{rev}:{f}", check=False)) for f in files]

    blockers, doubts = [], []
    for path, text in pairs:
        if not text:
            continue
        b, d = inspect(path, text, a.ds)
        blockers += b
        doubts += d

    print(f"проверено UI-файлов: {len(pairs)}")
    for b in blockers:
        print(f"БЛОКЕР — {b}")
    for d in doubts:
        print(f"подозрение — {d}")
    if not blockers and not doubts:
        print("обхода дизайн-системы не видно")
    return 1 if blockers else 0


if __name__ == "__main__":
    sys.exit(main())
