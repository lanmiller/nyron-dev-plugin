<script>
	// Скелет загрузки. Мерцание НЕ переопределяется: берётся класс `.skeleton`
	// из app.css — та же анимация, что на действующих экранах. Заводской
	// animate-pulse убран сознательно: два разных «ожидания» в одном
	// интерфейсе читаются как две разные системы. Размер задаётся снаружи
	// утилитами (`h-4 w-1/2`) — слой utilities главнее слоя лока.
	import { cn } from "$lib/utils.js";
	let {
		ref = $bindable(null),
		class: className,
		...restProps
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="skeleton"
	class={cn("skeleton", className)}
	{...restProps}
></div>