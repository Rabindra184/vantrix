/**
 * The Report's chart grid: two columns from `2xl`, one below it — each figure
 * holds a 288px plot plus a legend, and two of those in a 1280px window leave a
 * 60-bucket time axis dropping every other tick label. One definition for the
 * Report and each of its agent sections, so their grids cannot drift apart.
 */
export const REPORT_GRID = 'grid grid-cols-1 gap-6 2xl:grid-cols-2';
