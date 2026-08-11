<script>
	import { Tabs as TabsPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	} = $props();
</script>

<TabsPrimitive.Trigger
	bind:ref
	data-slot="tabs-trigger"
	class={cn(
		// цель пальца 40px в базе, под мышью — плотный ряд как у `.seg button`
		"relative inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-2.5 py-1 text-sm font-medium text-ink-3 transition-colors duration-120 fine:min-h-0 hover:text-ink-1 disabled:pointer-events-none disabled:opacity-40 group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		// активный сегмент капсулы — приподнятая поверхность, без тени
		"data-active:bg-accent data-active:text-ink-1",
		// вариант «строка»: активную вкладку показывает подчёркивание акцентом
		"group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:data-active:bg-transparent group-data-[variant=line]/tabs-list:data-active:text-ink-1",
		"after:absolute after:bg-primary after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-1px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
		className
	)}
	{...restProps}
/>