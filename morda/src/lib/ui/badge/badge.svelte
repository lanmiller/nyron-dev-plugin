<script module>
	// Метка. Два родственника из app.css: `.badge` (счётчик, терракота) и
	// `.chip` (плашка с границей). Здесь они сведены в один компонент
	// вариантами, потому что различие между ними — роль, а не форма.
	//
	// Смысловые варианты (ok / warn / hot) существуют не для красоты: в пульте
	// цвет метки — это состояние сессии, и брать его «на глаз» в каждом файле
	// заново — ровно та болезнь, из-за которой аудит дал 42/100.
	import { tv } from "tailwind-variants";

	export const badgeVariants = tv({
		base: "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border border-transparent px-2 py-0.5 text-micro font-bold transition-colors duration-120 [&>svg]:pointer-events-none [&>svg]:size-3!",
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground [a]:hover:brightness-[1.08]",
				secondary: "bg-accent text-ink-2 [a]:hover:text-ink-1",
				outline: "border-border bg-card font-medium text-ink-2 [a]:hover:border-primary [a]:hover:text-ink-1",
				destructive: "border-destructive/45 bg-card text-destructive",
				ok: "border-ok/45 bg-card text-ok",
				warn: "border-warn/45 bg-card text-warn",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	});
</script>

<script>
	import { cn } from "$lib/utils.js";
	let {
		ref = $bindable(null),
		href,
		class: className,
		variant = "default",
		children,
		...restProps
	} = $props();
</script>

<svelte:element
	this={href ? "a" : "span"}
	bind:this={ref}
	data-slot="badge"
	{href}
	class={cn(badgeVariants({ variant }), href && "no-underline", className)}
	{...restProps}
>
	{@render children?.()}
</svelte:element>
