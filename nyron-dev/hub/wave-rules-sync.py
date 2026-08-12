#!/usr/bin/env python3
"""Сборка проектного канона правил волн из шаблона плагина.

Источник правды — `skills/nyron-waves/assets/wave-rules-template.md` в плагине.
Проектная копия (`<docs_dir>/shared/wave-rules.md`) СОБИРАЕТСЯ этим скриптом и
руками не правится: раньше она была ручной копией и разошлась с шаблоном на
79 строк, вернув уже пойманный баг (фильтр комментов по автору, 12.08.2026).

Из чего собирается:
  1. шаблон плагина — универсальные правила с плейсхолдерами `{{ключ}}`;
  2. конфиг проекта `.claude/nyron-dev.md` (+ `.local.md` поверх) — значения;
  3. проектная вставка `<docs_dir>/shared/wave-rules.project.md` — уроки и
     команды ЭТОГО проекта; её пишет команда руками, шаблон её не трогает.

Запуск:
  python3 wave-rules-sync.py             # показать дифф, ничего не писать
  python3 wave-rules-sync.py --check     # тихо; код возврата 1 при расхождении
  python3 wave-rules-sync.py --apply     # записать проектный канон
  python3 wave-rules-sync.py --out ФАЙЛ  # записать в произвольный файл (смоук)
"""

import argparse
import difflib
import os
import re
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = PLUGIN_ROOT / "skills/nyron-waves/assets/wave-rules-template.md"
CONFIG_NAME = ".claude/nyron-dev.md"
LOCAL_NAME = ".claude/nyron-dev.local.md"


# --- конфиг -----------------------------------------------------------------

def frontmatter(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    return m.group(1) if m else ""


def parse_yaml(src: str) -> dict:
    try:
        import yaml  # PyYAML есть не на всякой машине — отсюда фолбэк ниже
        return yaml.safe_load(src) or {}
    except ImportError:
        return parse_yaml_minimal(src)


def parse_yaml_minimal(src: str) -> dict:
    """Подмножество YAML, которым написан конфиг: словари, списки, скаляры.

    Вложенный узел заводится словарём; если его первым потомком приходит
    элемент списка («- …»), узел на месте превращается в список.
    """
    root: dict = {}
    stack = [(-1, root, None, None)]  # (отступ, узел, родитель, ключ в родителе)
    for raw in src.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        line = strip_comment(raw.strip())
        if not line:
            continue
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        _, node, parent, key = stack[-1]

        if line.startswith("- "):
            if isinstance(node, dict) and parent is not None:
                node = parent[key] = []
                stack[-1] = (stack[-1][0], node, parent, key)
            if isinstance(node, list):
                node.append(unquote(line[2:]))
            continue

        if ":" not in line or not isinstance(node, dict):
            continue
        name, _, value = line.partition(":")
        name, value = name.strip(), value.strip()
        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            node[name] = [unquote(x) for x in inner.split(",")] if inner else []
        elif value == "":
            child: dict = {}
            node[name] = child
            stack.append((indent, child, node, name))
        else:
            node[name] = unquote(value)
    return root


def strip_comment(line: str) -> str:
    out, quote = [], ""
    for i, ch in enumerate(line):
        if quote:
            out.append(ch)
            if ch == quote:
                quote = ""
            continue
        if ch in "\"'":
            quote = ch
            out.append(ch)
            continue
        if ch == "#" and (i == 0 or line[i - 1] in " \t"):
            break
        out.append(ch)
    return "".join(out).strip()


def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def find_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / CONFIG_NAME).is_file():
            return candidate
    sys.exit(f"конфиг {CONFIG_NAME} не найден вверх по дереву от {start}")


def deep_merge(base: dict, over: dict) -> dict:
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            deep_merge(base[key], value)
        else:
            base[key] = value
    return base


# --- подстановка ------------------------------------------------------------

def flatten(node, prefix="") -> dict:
    out = {}
    if isinstance(node, dict):
        for key, value in node.items():
            out.update(flatten(value, f"{prefix}{key}."))
    elif isinstance(node, list):
        out[prefix.rstrip(".")] = "\n".join(f"- {item}" for item in node)
    else:
        out[prefix.rstrip(".")] = "" if node is None else str(node)
    return out


def render(template: str, values: dict, missing: list) -> str:
    def sub(match):
        key = match.group(1).strip()
        if key in values:
            return values[key]
        missing.append(key)
        return match.group(0)

    return re.sub(r"\{\{([^{}]+)\}\}", sub, template)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", help="корень проекта (по умолчанию — поиск вверх от cwd)")
    ap.add_argument("--apply", action="store_true", help="записать проектный канон")
    ap.add_argument("--check", action="store_true", help="тихо; код 1 при расхождении")
    ap.add_argument("--out", help="записать в этот файл вместо проектного канона")
    ap.add_argument("--project-rules", help="взять проектную вставку из этого файла")
    args = ap.parse_args()

    root = Path(args.root).resolve() if args.root else find_root(Path.cwd().resolve())
    config = parse_yaml(frontmatter(root / CONFIG_NAME))
    if (root / LOCAL_NAME).is_file():
        deep_merge(config, parse_yaml(frontmatter(root / LOCAL_NAME)))

    docs_dir = config.get("docs_dir", "docs")
    target = Path(args.out) if args.out else root / docs_dir / "shared/wave-rules.md"
    project_part = (
        Path(args.project_rules) if args.project_rules
        else root / docs_dir / "shared/wave-rules.project.md"
    )

    values = flatten(config)
    values["project_rules"] = (
        project_part.read_text(encoding="utf-8").strip()
        if project_part.is_file()
        else "_Проектной вставки нет: создайте `%s/shared/wave-rules.project.md`._"
        % docs_dir
    )
    values["docs_dir"] = docs_dir
    values["generated_from"] = os.path.relpath(TEMPLATE, PLUGIN_ROOT)

    missing: list = []
    body = render(TEMPLATE.read_text(encoding="utf-8"), values, missing)
    if missing:
        print("НЕ ЗАПОЛНЕНЫ ключи конфига: " + ", ".join(sorted(set(missing))),
              file=sys.stderr)

    header = (
        "<!-- СГЕНЕРИРОВАНО плагином nyron-dev из %s.\n"
        "     Руками НЕ править: правки уедут при следующей сборке.\n"
        "     Универсальное правило — в шаблон плагина; проектное — в\n"
        "     %s/shared/wave-rules.project.md; значения — в .claude/nyron-dev.md.\n"
        "     Пересобрать: python3 <plugin>/hub/wave-rules-sync.py --apply -->\n\n"
        % (values["generated_from"], docs_dir)
    )
    result = header + body

    old = target.read_text(encoding="utf-8") if target.is_file() else ""
    if old == result:
        if not args.check:
            print(f"без изменений: {target}")
        return 0

    if args.apply or args.out:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(result, encoding="utf-8")
        print(f"записано: {target}")
        return 0

    if args.check:
        print(f"РАСХОЖДЕНИЕ: {target} не совпадает со сборкой из шаблона",
              file=sys.stderr)
        return 1

    sys.stdout.writelines(
        difflib.unified_diff(
            old.splitlines(keepends=True), result.splitlines(keepends=True),
            fromfile=str(target), tofile="сборка из шаблона",
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
