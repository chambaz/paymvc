import type { ComponentProps } from "react";

// A link styled like the demo's shadcn/ui Button. The landing page only needs links.
const base =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const variants = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  outline:
    "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
};

const sizes = {
  default: "h-9 px-4 py-2 has-[>svg]:px-3",
  lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
};

export function ButtonLink({
  variant = "default",
  size = "default",
  className = "",
  ...props
}: ComponentProps<"a"> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}) {
  return (
    <a
      data-slot="button"
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
