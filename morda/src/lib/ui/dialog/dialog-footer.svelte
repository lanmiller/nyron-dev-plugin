<script>
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { Button } from "$lib/ui/button/index.js";
	import { cn } from "$lib/utils.js";
	let {
		ref = $bindable(null),
		class: className,
		children,
		showCloseButton = false,
		...restProps
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="dialog-footer"
	class={cn("-mx-3.5 -mb-3.5 flex flex-col-reverse gap-2 rounded-b-lg border-t border-border-soft bg-muted p-3.5 sm:flex-row sm:justify-end", className)}
	{...restProps}
>
	{@render children?.()}
	{#if showCloseButton}
		<DialogPrimitive.Close>
			{#snippet child({ props })}
				<Button variant="outline" {...props}>Close</Button>
			{/snippet}
		</DialogPrimitive.Close>
	{/if}
</div>