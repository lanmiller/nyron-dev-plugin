<script>
  /**
   * Иконка пульта. Одна точка входа на весь интерфейс, чтобы размер и штрих
   * не расползлись по файлам — ровно та же болезнь, что аудит 11.08 нашёл у
   * кнопок («рисовались заново в каждом файле»).
   *
   *   <Icon name="folder" />              — 16px, цвет текста
   *   <Icon name="check" size={20} />     — крупнее, когда иконка ведущая
   *
   * Цвет НЕ параметр: иконка наследует currentColor, то есть окрашивается
   * тем же правилом, что и текст рядом. Список имён — icon-sets.iconify.design
   * (набор lucide), набор локальный, см. ./icons.js.
   */
  import OfflineIcon from '@iconify/svelte/dist/OfflineIcon.svelte';
  // Импорт ради регистрации набора: модули вычисляются до первого рендера,
  // поэтому к моменту отрисовки хранилище Iconify уже заполнено.
  import { ICON_PREFIX } from './icons.js';

  let { name, size = 16, class: extra = '', ...rest } = $props();
</script>

<OfflineIcon
  icon={ICON_PREFIX + name}
  width={size}
  height={size}
  class={extra ? `icon ${extra}` : 'icon'}
  aria-hidden="true"
  {...rest}
/>
