<script>
	import { cn } from "$lib/utils.js";
	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="card-footer"
	class={cn("flex items-center gap-2 rounded-b-lg border-t border-border-soft bg-muted p-(--card-spacing)", className)}
	{...restProps}
>
	{@render children?.()}
</div>