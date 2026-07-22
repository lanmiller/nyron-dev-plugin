#!/usr/bin/env python3
"""Сводка токенов по транскриптам сессий (замер конвейера против бейзлайна).

Использование:
  python3 wave-tokens.py <transcript.jsonl> [...]        # по файлам
  python3 wave-tokens.py --grep <строка> <каталог>       # найти сессии по подстроке
                                                          # (ветка, тикет) и посчитать;
                                                          # ищет РЕКУРСИВНО (subagents/ и
                                                          # каталоги worktree-сессий)

Считает: input / output / cache_read / cache_write, разбивка output по моделям.
Sol/codex здесь НЕ виден (подписка, не Claude-токены) — это структурная
экономия конвейера v2, а не дыра замера.
"""
import json, sys, glob, os

def usage(path):
    inp = out = cr = cw = 0; model = {}
    for line in open(path, errors='ignore'):
        try: d = json.loads(line)
        except Exception: continue
        u = (d.get('message') or {}).get('usage')
        if not u: continue
        m = (d.get('message') or {}).get('model', '?')
        inp += u.get('input_tokens', 0); out += u.get('output_tokens', 0)
        cr += u.get('cache_read_input_tokens', 0)
        cw += u.get('cache_creation_input_tokens', 0)
        model[m] = model.get(m, 0) + u.get('output_tokens', 0)
    return inp, out, cr, cw, model

args = sys.argv[1:]
files = []
if args and args[0] == '--grep':
    needle, root = args[1], args[2]
    for f in glob.glob(os.path.join(root, '**', '*.jsonl'), recursive=True):
        try:
            if needle in open(f, errors='ignore').read(): files.append(f)
        except Exception: pass
    print(f'найдено сессий с «{needle}»: {len(files)}')
else:
    files = args

ti = to = 0
for p in files:
    i, o, cr, cw, m = usage(p)
    ti += i + cr + cw; to += o
    print(f'{os.path.basename(p)[:16]}…  in={i:,} out={o:,} cache_r={cr:,} cache_w={cw:,}')
    for k, v in sorted(m.items(), key=lambda x: -x[1]):
        print(f'    {k}: out={v:,}')
print(f'ИТОГО: output={to:,} (сравнивать с бейзлайном по output — cache дешёвый)')
