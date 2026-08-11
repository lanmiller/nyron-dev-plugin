<script>
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		inset,
		variant = "default",
		...restProps
	} = $props();
</script>

<DropdownMenuPrimitive.Item
	bind:ref
	data-slot="dropdown-menu-item"
	data-inset={inset}
	data-variant={variant}
	class={cn(
		// пункт меню = строка списка `.row`: наведение показывает поверхность
		"group/dropdown-menu-item relative flex min-h-11 cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-ink-2 outline-hidden transition-colors duration-120 select-none fine:min-h-0 focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-[inset]:pl-8 data-disabled:pointer-events-none data-disabled:opacity-40 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		className
	)}
	{...restProps}
/>