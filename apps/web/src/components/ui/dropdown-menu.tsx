import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ComponentPropsWithoutRef, ElementRef } from 'react';
import { forwardRef } from 'react';
import { CheckIcon } from '../icons';
import { cn } from '../../lib/cn';

/**
 * shadcn/ui's dropdown-menu, on Radix, restyled onto THIS project's tokens.
 *
 * ═══ WHY THE DEPENDENCY, HAVING GONE WITHOUT IT ═══
 *
 * `apps/web` has followed shadcn's PATTERN without its toolchain — a
 * hand-written `cn`, cva variant maps, no `components.json` — and that was the
 * right trade for buttons and badges, which are styling with no interaction
 * model to get wrong.
 *
 * A menu is the opposite. Its role is a promise about keyboard behaviour:
 * arrows move between items, Home/End jump, typeahead selects, Escape closes,
 * focus returns to the trigger, and focus is trapped while open. Hand-rolling
 * that is how `ThemeToggle` once shipped `role="radio"` with no arrow handling
 * — a screen reader announcing "radio button, 1 of 3" for a control that
 * ignored every arrow key its user pressed. Radix implements the whole APG
 * pattern, including `menuitemradio`, which is what lets the theme control
 * live in here as REAL menu radios rather than a radiogroup smuggled inside a
 * menu (invalid) or a disclosure that declines to be a menu at all (what this
 * component replaces).
 *
 * ═══ THE STYLING IS NOT shadcn's DEFAULT, DELIBERATELY ═══
 *
 * Stock shadcn paints with `bg-popover`, `text-popover-foreground`,
 * `bg-accent`, `text-muted-foreground` — none of which exist here. This
 * project's tokens are `bg-surface`, `border-default`, `text-primary`,
 * `text-muted`, `shadow-panel`, and pasting the stock classes would emit
 * NOTHING for every one of them: Tailwind v4 generates utilities only from
 * `@theme` declarations, which is the silent-no-CSS trap CLAUDE.md already
 * records costing this project a 2.84:1 skip link. Every class below is a
 * token this repo actually declares.
 */

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const DropdownMenuContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  /* PORTALLED. The header is `sticky` with `backdrop-blur`, which creates a
     containing block — an absolutely positioned panel inside it is clipped by
     the header's own 56px height. Radix renders to the body and positions with
     a collision boundary, so the panel escapes that and also flips rather than
     running off-screen at 375px. */
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-[14rem] overflow-hidden rounded-lg border border-default bg-surface p-1.5 text-primary shadow-panel',
        // Radix stamps these data attributes through the open/close lifecycle;
        // the motion is small on purpose and `motion-reduce` opts out entirely.
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1',
        'motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';

const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none select-none',
      // `highlighted` is Radix's own word for "the arrow keys are on this one",
      // which is a different state from :hover and is what a keyboard user
      // actually needs painted.
      'data-[highlighted]:bg-sunken data-[highlighted]:text-primary',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

const DropdownMenuRadioItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      'relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-7 text-[13px] outline-none select-none',
      'data-[highlighted]:bg-sunken data-[highlighted]:text-primary',
      className,
    )}
    {...props}
  >
    {/* The tick is the only thing that says WHICH is current, so it sits in a
        reserved gutter rather than shifting the label when it appears. */}
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <CheckIcon className="h-3.5 w-3.5 text-accent" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem';

const DropdownMenuLabel = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Label>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn('px-2 py-1 text-[11px] tracking-wide text-faint uppercase', className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn('-mx-1.5 my-1.5 h-px bg-default', className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
};
