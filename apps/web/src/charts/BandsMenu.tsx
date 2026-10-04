import { ChevronDownIcon } from '../components/icons';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { BAND_LABEL, BANDS, type Band } from './transforms/percentiles';

/**
 * The percentile chart's band selector, as one menu (clean UI, PR 2).
 *
 * Ten chips sat above a legend listing the same ten bands in the same colours,
 * so the chart's controls were longer than its key. One trigger reads the
 * COUNT (`Bands · 6`) and opens a checkbox item per band, in `BANDS` order —
 * the legend's order — each with the swatch of the line it draws.
 *
 * ═══ THE MENU STAYS OPEN WHILE BANDS ARE TICKED ═══
 *
 * A menu item closes its menu on select; a reader picking three bands would
 * reopen it three times. `onSelect`'s `preventDefault` keeps it open, and
 * Escape (or a click outside) closes it and returns focus to the trigger.
 *
 * ═══ `modal={false}`, AND HERE IT IS THE POINT ═══
 *
 * The default marks the rest of the document inert and traps focus. With the
 * menu open over the chart it changes, the reader should SEE the line appear
 * as they tick it — the reason `ChartActions` and the account menu set the
 * same thing.
 *
 * The accessible name carries the count in words ("Percentile bands, 6
 * selected") because "Bands · 6" read aloud is a middle dot and a bare number.
 */
export default function BandsMenu({
  id,
  selected,
  onToggle,
}: {
  /** The owning chart's id: every testid derives from it, so a page with two
   *  percentile charts has two menus a test can tell apart. */
  readonly id: string;
  readonly selected: readonly Band[];
  readonly onToggle: (band: Band) => void;
}) {
  const n = selected.length;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Percentile bands, ${n} selected`}
          data-testid={`bands-${id}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-default bg-surface px-2 py-1 text-[0.8125rem] leading-none text-primary transition-colors hover:border-accent data-[state=open]:border-accent"
        >
          Bands · {n}
          <ChevronDownIcon className="h-3.5 w-3.5 text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[9rem]">
        {BANDS.map((band) => (
          <DropdownMenuCheckboxItem
            key={band}
            checked={selected.includes(band)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onToggle(band)}
            data-testid={`band-${band}-${id}`}
          >
            {/* Decorative: the label names the band; the colour is a second
                encoding of it, never the only one. */}
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: `var(--chart-pct-${band})` }}
            />
            {BAND_LABEL[band]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
