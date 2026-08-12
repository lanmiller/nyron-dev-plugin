# Что применить к живым файлам, когда закроют Блоки 1–3 (DEV-1210)

Плагин править можно в любой момент: сессии грузят его из marketplace-клона.
А `ai-evolve-docs-test/shared/wave-rules.md` идущие волны читают прямо с диска,
поэтому переход на сборку канона ждёт финала эпика.

## Переход: канон правил волн перестаёт быть ручной копией

Источник правды — шаблон плагина; проектная копия собирается скриптом. Причина:
ручная копия разошлась с каноном на 79 строк и вернула уже пойманный баг
(фильтр комментов по автору), а номера переходов Jira жили в двух местах и
разъехались.

Три шага, одна минута:

```bash
cp ~/ai-evolve/nyron-dev-plugin/docs/patches/wave-rules.project.ai-evolve.md ~/ai-evolve/ai-evolve-docs-test/shared/wave-rules.project.md
python3 ~/ai-evolve/nyron-dev-plugin/nyron-dev/hub/wave-rules-sync.py --root ~/ai-evolve --apply
cd ~/ai-evolve/ai-evolve-docs-test && git add shared/wave-rules.md shared/wave-rules.project.md && git commit -m "правила волн: канон собирается плагином, проектное вынесено во вставку" && git push
```

Перед коммитом посмотреть дифф глазами — сборка меняет весь файл целиком.

**Что дальше:** правки правил идут в шаблон плагина
(`nyron-dev/skills/nyron-waves/assets/wave-rules-template.md`), проектные зоны и
уроки — в `shared/wave-rules.project.md`, значения — в `.claude/nyron-dev.md`.
Расхождение ловится `wave-rules-sync.py --check` (код возврата 1).
