<script>
	import { Separator as SeparatorPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		"data-slot": dataSlot = "separator",
		...restProps
	} = $props();
</script>

<SeparatorPrimitive.Root
	bind:ref
	data-slot={dataSlot}
	class={cn(
		// граница-разделитель берёт мягкий тон лока: она делит, а не рисует рамку
		"shrink-0 bg-border-soft data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px",
		// this is different in shadcn/ui but self-stretch breaks things for us
		"data-[orientation=vertical]:h-full",
		className
	)}
	{...restProps}
/>