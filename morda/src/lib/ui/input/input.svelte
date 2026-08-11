<script>
	// Поле ввода. Повторяет правило лока для `input[type='text']` в app.css:
	// поверхность глубины (--bg-0), граница ведёт при наведении, акцент — при
	// фокусе. Кегль здесь НЕ задаётся: он приходит из app.css правилом для
	// [data-slot='input'] (16px на телефоне, иначе iOS зумит страницу).
	import { cn } from "$lib/utils.js";
	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		files = $bindable(),
		class: className,
		"data-slot": dataSlot = "input",
		...restProps
	} = $props();

	const base =
		"w-full min-w-0 rounded-lg border border-border bg-muted px-2.5 py-[11px] text-ink-1 outline-none transition-colors duration-120 fine:py-2 placeholder:text-ink-4 hover:border-ink-4 focus-visible:border-primary disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-destructive file:mr-2 file:border-0 file:bg-transparent file:font-medium file:text-ink-2";
</script>

{#if type === "file"}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(base, className)}
		type="file"
		bind:files
		bind:value
		{...restProps}
	/>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		class={cn(base, className)}
		{type}
		bind:value
		{...restProps}
	/>
{/if}
