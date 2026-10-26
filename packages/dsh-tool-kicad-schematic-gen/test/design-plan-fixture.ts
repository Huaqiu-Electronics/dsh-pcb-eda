import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readDesignPlan} from '../src/schematic/design-plan.ts'
const path=join(mkdtempSync(join(tmpdir(),'design-plan-test-')),'project-brief.md')
export const planText='# Hardware implementation plan\n\n## Requirements\nProvide a regulated 3.3 V output from a 5 V input for a 100 mA load.\n\n## Parts and circuits\nUse a fixed 3.3 V LDO with the manufacturer recommended input and output capacitors.\n\n## Connections and budget\nConnect input to VIN, common ground to GND and VOUT to the load. Check pin mapping, capacitor stability, headroom and thermal power before implementation.\n'
writeFileSync(path,planText)
const plan=readDesignPlan(path)
export const testDesignPlan={path:plan.path,sha256:plan.sha256}
