import { z } from 'zod';

/**
 * A project's named, reusable Gatling artifact
 * (docs/superpowers/specs/2026-10-02-packages-design.md). Its kind is fixed at
 * creation — Gatling Enterprise's "a JS package cannot replace a JVM package".
 */
export const PackageKindSchema = z.enum(['gatling_jar', 'gatling_bundle']);
export type PackageKind = z.infer<typeof PackageKindSchema>;

/** Unique per project ignoring case — the database's rule, not this schema's. */
export const PackageNameSchema = z.string().trim().min(1).max(120);

export const PackageVersionSchema = z.object({
  artifactId: z.string().uuid(),
  filename: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  gatlingVersion: z.string().nullable(),
  /** The jar manifest's Gatling-Simulations; null when UNKNOWN — a bundle, a
   *  jar with no such header, or a version uploaded before packages existed.
   *  Never an empty list standing in for "unknown". */
  simulations: z.array(z.string()).nullable(),
  uploadedAt: z.string().datetime(),
});
export type PackageVersion = z.infer<typeof PackageVersionSchema>;

export const PackageUsageSchema = z.object({
  /** Distinct tests with a run from any version of this package. */
  tests: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  /** Jobs queued, starting, running or closing on any of its versions. */
  activeJobs: z.number().int().nonnegative(),
});
export type PackageUsage = z.infer<typeof PackageUsageSchema>;

export const PackageSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: PackageKindSchema,
  createdAt: z.string().datetime(),
  /** The last upload. */
  updatedAt: z.string().datetime(),
  current: PackageVersionSchema.nullable(),
  usage: PackageUsageSchema,
});
export type Package = z.infer<typeof PackageSchema>;

export const PackageListResponseSchema = z.object({ items: z.array(PackageSchema) });
export type PackageListResponse = z.infer<typeof PackageListResponseSchema>;

export const CreatePackageRequestSchema = z
  .object({ name: PackageNameSchema, kind: PackageKindSchema })
  .strict();
export type CreatePackageRequest = z.infer<typeof CreatePackageRequestSchema>;

export const RenamePackageRequestSchema = z.object({ name: PackageNameSchema }).strict();
export type RenamePackageRequest = z.infer<typeof RenamePackageRequestSchema>;
