/** Public scripting API, retained as the ./builder package export. */
export * from './schematic/builder.ts'
export { resolveKiCadPaths } from './runtime-paths.ts'
export {attachPinLabel,attachPinLabels} from './schematic/label-leads.ts'
export {readDesignPlan,loadDesignPlan} from './schematic/design-plan.ts'
export {SCHEMATIC_GRID_MM,snapGrid,gridPoint} from './schematic/grid.ts'
