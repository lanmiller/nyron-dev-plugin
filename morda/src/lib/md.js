/**
 * md.js — маленький безопасный маркдаун для транскриптов (окно сессии).
 * Внешние библиотеки не берём сознательно: рендерим ЧУЖОЙ текст (реплики
 * сессий), поэтому сначала полное экранирование, потом узкий белый список
 * конструкций. Ссылки — только http/https.
 */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function inline(s, tracker) {
  let out = s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    // голый URL — тоже ссылка (в чатах их пишут без разметки)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  // ключи тикетов проекта (DEV-1129) → трекер; не трогаем уже размеченное
  // и код (CTO 10.08: ссылки наружу, юзер там залогинен)
  if (tracker?.keys?.length) {
    const re = new RegExp(`(^|[^\\w/>-])((?:${tracker.keys.join('|')})-\\d+)\\b`, 'g');
    out = out.replace(re, (m, pre, key) =>
      `${pre}<a href="${tracker.base}${key}" target="_blank" rel="noopener noreferrer" class="ticket">${key}</a>`);
  }
  return out;
}

export function md(src, tracker = null) {
  const t = esc(src);
  const out = [];
  // сначала выпиливаем фенсы — внутри них ничего не трогаем
  const chunks = t.split(/^```[^\n]*\n?/m);
  for (let i = 0; i < chunks.length; i++) {
    if (i % 2 === 1) { out.push(`<pre><code>${chunks[i].replace(/\n$/, '')}</code></pre>`); continue; }
    const lines = chunks[i].split('\n');
    let para = [];
    let list = null; // 'ul' | 'ol'
    const flushPara = () => {
      if (para.length) { out.push(`<p>${inline(para.join('<br>'), tracker)}</p>`); para = []; }
    };
    const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    // Таблицы: у нас ими написана половина документации и брифов, без них
    // читалось сырым конвейером из палок (CTO 11.08). Разбираем шапку +
    // строку-разделитель + тело, выравнивание из разделителя (:--- / ---:).
    const isRow = (s) => /^\s*\|.*\|\s*$/.test(s);
    const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const alignOf = (s) => cells(s).map((c) =>
      /^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:?-+$/.test(c) ? 'left' : null);
    for (let li2 = 0; li2 < lines.length; li2++) {
      const line = lines[li2];
      const next = lines[li2 + 1];
      if (isRow(line) && next && isRow(next) && alignOf(next).every(Boolean)
          && cells(next).length === cells(line).length) {
        flushPara(); flushList();
        const align = alignOf(next);
        const head = cells(line);
        const rows = [];
        let j = li2 + 2;
        while (j < lines.length && isRow(lines[j])) { rows.push(cells(lines[j])); j++; }
        li2 = j - 1;
        const th = head.map((c, k) =>
          `<th${align[k] && align[k] !== 'left' ? ` style="text-align:${align[k]}"` : ''}>${inline(c, tracker)}</th>`).join('');
        const body = rows.map((r) => `<tr>${r.map((c, k) =>
          `<td${align[k] && align[k] !== 'left' ? ` style="text-align:${align[k]}"` : ''}>${inline(c, tracker)}</td>`).join('')}</tr>`).join('');
        out.push(`<div class="tw"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)/);
      const li = line.match(/^\s*[-*]\s+(.*)/);
      const oli = line.match(/^\s*\d+[.)]\s+(.*)/);
      const q = line.match(/^&gt;\s?(.*)/);
      if (h) { flushPara(); flushList(); out.push(`<h4>${inline(h[2], tracker)}</h4>`); }
      else if (li || oli) {
        flushPara();
        const want = li ? 'ul' : 'ol';
        if (list !== want) { flushList(); out.push(`<${want}>`); list = want; }
        out.push(`<li>${inline((li || oli)[1], tracker)}</li>`);
      } else if (q) { flushPara(); flushList(); out.push(`<blockquote>${inline(q[1], tracker)}</blockquote>`); }
      else if (!line.trim()) { flushPara(); flushList(); }
      else para.push(line);
    }
    flushPara(); flushList();
  }
  return out.join('\n');
}
