<script>
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	} = $props();
</script>

<DialogPrimitive.Overlay
	bind:ref
	data-slot="dialog-overlay"
	class={cn("fixed inset-0 isolate z-50 bg-scrim duration-120 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0", className)}
	{...restProps}
/>