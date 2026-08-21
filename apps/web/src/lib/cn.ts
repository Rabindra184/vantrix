import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn/ui's `cn` — `clsx` for conditional composition, `tailwind-merge` so
 * a caller's `className` genuinely OVERRIDES a component's own utilities
 * rather than tying with them and losing on stylesheet order.
 *
 * The second half is the reason this exists at all: `Button` and `Badge` take
 * a `className`, and before this the component's classes and the caller's were
 * joined with `.join(' ')`, which left "who wins" to source order in the
 * generated CSS — invisible in review, wrong whenever Tailwind emitted the
 * component's utility later than the caller's. `twMerge` resolves the conflict
 * by meaning (`px-2` vs `px-3` is one decision, the caller's), not by luck.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
