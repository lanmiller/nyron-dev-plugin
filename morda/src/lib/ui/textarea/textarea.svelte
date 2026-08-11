<script>
	// Многострочное поле — то же правило, что у Input, плюс рост по контенту
	// (field-sizing-content): в пульте это ввод вопроса и ответа волне, где
	// заранее неизвестно, одна строка там или двадцать.
	import { cn } from "$lib/utils.js";
	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		"data-slot": dataSlot = "textarea",
		...restProps
	} = $props();
</script>

<textarea
	bind:this={ref}
	data-slot={dataSlot}
	class={cn(
		"flex field-sizing-content min-h-16 w-full rounded-lg border border-border bg-muted px-2.5 py-2 text-ink-1 outline-none transition-colors duration-120 placeholder:text-ink-4 hover:border-ink-4 focus-visible:border-primary disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-destructive",
		className
	)}
	bind:value
	{...restProps}></textarea>
