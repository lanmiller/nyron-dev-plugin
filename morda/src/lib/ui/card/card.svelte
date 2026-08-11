<script>
	// Карточка = кирпич `.panel` из app.css, собранный из частей: поверхность
	// --bg-2, граница (а не тень и не ring: лок теней не знает), радиус лока.
	// Внутренний отступ один на все части — переменная --card-spacing, 14px
	// (--sp-6), тот же, что у шапки панели.
	import { cn } from "$lib/utils.js";
	let {
		ref = $bindable(null),
		class: className,
		children,
		size = "default",
		...restProps
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="card"
	data-size={size}
	class={cn("group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-lg border border-border bg-card py-(--card-spacing) text-base text-card-foreground [--card-spacing:--spacing(3.5)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(2.5)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-lg *:[img:last-child]:rounded-b-lg", className)}
	{...restProps}
>
	{@render children?.()}
</div>