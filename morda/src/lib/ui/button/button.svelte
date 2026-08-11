<script module>
	// Кнопка пульта. Варианты и размеры — те же, что у класса `.btn` в
	// app.css (он остаётся: на нём стоят действующие экраны), поэтому
	// shadcn-кнопка и старая кнопка рядом на витрине выглядят одинаково.
	//
	// Отличия от заводского shadcn — сознательные:
	//   • фокус не рисуется своим кольцом: на весь пульт одно правило
	//     `:focus-visible` в app.css, поэтому здесь НЕТ `outline-none`;
	//   • теней нет нигде (лок: глубина слоями и границами, не тенью);
	//   • размеры mobile-first: база — цель пальца 44px, вариант `fine:`
	//     (мышь) ужимает до плотной раскладки лока.
	import { tv } from "tailwind-variants";
	import { cn } from "$lib/utils.js";
	export const buttonVariants = tv({
		base: "group/button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border font-medium transition-[background-color,border-color,color,filter] duration-120 select-none disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		variants: {
			variant: {
				// главное действие в блоке — ровно одно на экран
				default: "border-primary bg-primary font-semibold text-primary-foreground hover:brightness-[1.08]",
				// рядовое действие: поверхность карточки, граница ведёт при наведении
				outline: "border-border bg-card text-ink-1 hover:border-primary active:bg-accent",
				// плоское действие на глубине (панель, ряд списка)
				secondary: "border-border-soft bg-muted text-ink-2 hover:border-border hover:text-ink-1 active:bg-accent",
				// действие-инструмент: проявляется поверхностью, не рамкой
				ghost: "border-transparent text-ink-2 hover:bg-accent hover:text-ink-1 aria-expanded:bg-accent aria-expanded:text-ink-1",
				// разрушающее: цвет = состояние, а не «красная кнопка ради красной»
				destructive: "border-destructive/45 bg-card text-destructive hover:border-destructive hover:bg-destructive/10",
				// третичное: действие, притворяющееся текстом
				link: "border-transparent text-ink-3 underline-offset-4 hover:text-primary hover:underline",
			},
			size: {
				// 44px — минимальная цель пальца (--tap), под мышью 7px/14px как у `.btn`
				default: "min-h-(--tap) px-4 py-[11px] text-base fine:min-h-0 fine:px-3.5 fine:py-[7px]",
				sm: "min-h-9 px-3 py-2 text-sm fine:min-h-0 fine:px-[11px] fine:py-[5px]",
				xs: "min-h-8 px-2.5 py-1.5 text-xs fine:min-h-0 fine:px-2 fine:py-0.5 [&_svg:not([class*='size-'])]:size-3.5",
				lg: "min-h-12 px-5 py-3 text-lg fine:min-h-0 fine:px-5 fine:py-2.5",
				icon: "size-11 p-0 fine:size-8",
				"icon-sm": "size-9 p-0 fine:size-7",
				"icon-xs": "size-8 p-0 fine:size-6 [&_svg:not([class*='size-'])]:size-3.5",
				"icon-lg": "size-12 p-0 fine:size-9",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

</script>

<script>
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	} = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		data-variant={variant}
		class={cn(buttonVariants({ variant, size }), "no-underline", className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		data-variant={variant}
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
