#!/usr/bin/env python3
"""Проверка скиллов плагина по чек-листу приёмки (docs/SKILLS-AUDIT.md).

Ловит то, что уже ломалось: описание, которое не грузится или пересказывает
метод; ссылки на несуществующие файлы; файлы-сироты в папке скилла; сленг,
от которого команда отказалась.

    python3 hub/skills-lint.py          # отчёт
    python3 hub/skills-lint.py --quiet  # только проблемы; код 1, если есть
"""

import re
import sys
from pathlib import Path

SKILLS = Path(__file__).resolve().parent.parent / "skills"
SLANG = ["адверсар", "триаж", "MECE", "fan-out"]
METHOD_WORDS = ["Задаёт ", "Даёт ", " стадий", "шаг 1", "этапы", "Формат ответа"]
MAX_DESC = 600
MAX_FM = 1024


def frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    return (m.group(1), m.group(0)) if m else (None, None)


def parse(fm):
    """Пары ключ-значение верхнего уровня; значение — до конца строки."""
    out = {}
    for line in fm.splitlines():
        m = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


def check(skill: Path):
    bad = []
    body = (skill / "SKILL.md").read_text(encoding="utf-8")
    fm, _ = frontmatter(body)
    if fm is None:
        return ["нет фронтматтера"]

    fields = parse(fm)
    if sorted(fields) != ["description", "name"]:
        bad.append(f"во фронтматтере лишние ключи: {sorted(fields)}")
    if fields.get("name") != skill.name:
        bad.append("name не совпадает с именем папки")
    if len(fm.encode()) > MAX_FM:
        bad.append(f"фронтматтер {len(fm.encode())} байт (> {MAX_FM})")
    if ": " in fields.get("description", ""):
        bad.append("двоеточие в описании — YAML не разберёт")

    desc = fields.get("description", "")
    if len(desc) > MAX_DESC:
        bad.append(f"описание {len(desc)} знаков (> {MAX_DESC})")
    if "Использовать, когда" not in desc:
        bad.append("в описании нет блока «Использовать, когда»")
    if desc.count("«") < 3:
        bad.append(f"в описании живых фраз в кавычках: {desc.count('«')} (нужно 3+)")
    for w in METHOD_WORDS:
        if w in desc:
            bad.append(f"описание пересказывает метод («{w.strip()}»)")

    words = len(body.split())
    if words > 2000:
        bad.append(f"тело {words} слов (> 2000)")

    # ссылки на файлы внутри скилла: и висячие, и сироты
    # путь своего скилла: не часть более длинного пути (чужой скилл — не наш файл)
    named = set(re.findall(r"(?<![\w/-])[\w./-]+\.(?:md|sh|py|json|mjs)", body))
    for rel in sorted(named):
        if rel.startswith(("references/", "assets/", "scripts/", "examples/")):
            if not (skill / rel).exists():
                bad.append(f"ссылка в никуда: {rel}")
    everything = "\n".join(
        f.read_text(encoding="utf-8", errors="ignore")
        for f in skill.rglob("*") if f.is_file()
    )
    for f in sorted(skill.rglob("*")):
        if f.is_file() and f.name != "SKILL.md" and f.name not in everything:
            bad.append(f"файл-сирота (нигде не упомянут): {f.relative_to(skill)}")

    for f in [skill / "SKILL.md", *skill.rglob("*.md")]:
        text = f.read_text(encoding="utf-8")
        for w in SLANG:
            if w.lower() in text.lower():
                bad.append(f"сленг «{w}» в {f.relative_to(skill)}")
    return bad


def main():
    quiet = "--quiet" in sys.argv
    total = 0
    for skill in sorted(p for p in SKILLS.iterdir() if (p / "SKILL.md").is_file()):
        bad = check(skill)
        total += len(bad)
        if bad:
            print(f"{skill.name}:")
            for b in bad:
                print(f"  — {b}")
        elif not quiet:
            print(f"{skill.name}: ок")
    if total:
        print(f"\nвсего замечаний: {total}", file=sys.stderr)
        return 1
    if not quiet:
        print("\nвсе скиллы проходят чек-лист")
    return 0


if __name__ == "__main__":
    sys.exit(main())
