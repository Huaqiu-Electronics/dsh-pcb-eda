import { existsSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'

const isDefaultCommand = (value: string | undefined) => !value || /^kicad-cli(?:\.exe)?$/i.test(value.trim())

/** Explicit paths override discovery; default command names still discover the host and PATH. */
export function resolveKiCadPaths(executable = process.execPath, env: NodeJS.ProcessEnv = process.env): { kicadCliPath: string; symbolDir?: string } {
  const roots: string[] = []
  let directory = dirname(executable)
  for (;;) {
    roots.push(directory)
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const cliName = process.platform === 'win32' ? 'kicad-cli.exe' : 'kicad-cli'
  const candidates = roots.flatMap(root => [join(root, cliName), join(root, 'bin', cliName)])
  candidates.push(...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, cliName)))
  const override = env.KICAD_CLI_PATH?.trim()
  const kicadCliPath = (!isDefaultCommand(override) ? override : undefined) || candidates.find(candidate => existsSync(candidate)) || cliName
  const symbolCandidates = [env.KICAD_SYMBOL_DIR,
    ...Object.keys(env).filter(key => /^KICAD\d+_SYMBOL_DIR$/.test(key)).sort((a,b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0])).map(key => env[key]),
    join(dirname(dirname(kicadCliPath)), 'share', 'kicad', 'symbols'),
    ...roots.map(root => join(root, 'share', 'kicad', 'symbols'))]
  const symbolDir = symbolCandidates.find((candidate): candidate is string => !!candidate && existsSync(join(candidate, 'power.kicad_sym')))
  return { kicadCliPath, symbolDir }
}

// Configuration and skill loading share discovery results until deployment inputs change.
let cachedEnvironment:string|undefined;
const pathsByOverride=new Map<string|undefined,ReturnType<typeof resolveKiCadPaths>>();
export function getKiCadPaths(kicadCliPath?:string):ReturnType<typeof resolveKiCadPaths>{
 // Schema-filled defaults must not hide an environment override or host installation.
 if(isDefaultCommand(kicadCliPath))kicadCliPath=undefined;
 const env=process.env;
 const key=JSON.stringify([process.execPath,env.KICAD_CLI_PATH,env.KICAD_SYMBOL_DIR,env.PATH??env.Path,
  Object.keys(env).filter(name=>/^KICAD\d+_SYMBOL_DIR$/.test(name)).sort().map(name=>[name,env[name]])]);
 if(key!==cachedEnvironment){pathsByOverride.clear();cachedEnvironment=key;}
 let paths=pathsByOverride.get(kicadCliPath);
 if(!paths){
  paths=Object.freeze(resolveKiCadPaths(process.execPath,kicadCliPath?{...env,KICAD_CLI_PATH:kicadCliPath}:env));
  pathsByOverride.set(kicadCliPath,paths);
  pathsByOverride.set(paths.kicadCliPath,paths);
 }
 return paths;
}
