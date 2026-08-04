/**
 * Pull in Obsidian's global DOM augmentations (`createEl`, `empty`, `addClass`, …).
 *
 * They live in a `declare global` block inside `obsidian.d.ts`, which TypeScript only loads
 * once something references the package. This reference guarantees they are always in scope,
 * including for the test mock that reimplements them.
 */

/// <reference types="obsidian" />

export {};
