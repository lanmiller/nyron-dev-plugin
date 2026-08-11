<script module>
	// Вкладки. Вариант `default` — это сегментированный переключатель `.seg`
	// из app.css (капсула на глубине, активный сегмент — приподнятая
	// поверхность); вариант `line` — подчёркивание акцентом для крупных
	// разделов окна сессии.
	import { tv } from "tailwind-variants";

	export const tabsListVariants = tv({
		base: "group/tabs-list inline-flex w-fit items-center justify-center rounded-full p-0.5 text-ink-3 data-[variant=line]:rounded-none group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
		variants: {
			variant: {
				default: "cn-tabs-list-variant-default gap-0.5 border border-border bg-muted",
				line: "cn-tabs-list-variant-line gap-1 border-b border-border-soft bg-transparent p-0",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	});
</script>

<script>
	import { Tabs as TabsPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		variant = "default",
		class: className,
		...restProps
	} = $props();
</script>

<TabsPrimitive.List
	bind:ref
	data-slot="tabs-list"
	data-variant={variant}
	class={cn(tabsListVariants({ variant }), className)}
	{...restProps}
/>