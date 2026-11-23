/** Same-origin calls to the `@huaqiu/hardware-artifacts` Host routes. */
import type {
  DiscoveryInfo, HardwareProjectInfo, InstallationsInfo, NativeApplication,
} from './model.js'

const PREFIX = '/api/v1/hardware'

interface Envelope<T> {
  readonly ok?: boolean
  readonly error?: { readonly code?: string; readonly message?: string }
  readonly data?: T
  readonly [key: string]: unknown
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${PREFIX}${path}`, init)
  const body = await response.json().catch(() => undefined) as Envelope<T> | undefined
  if (!response.ok || body?.ok === false) {
    const detail = body?.error?.message ?? `HTTP ${response.status}`
    throw new Error(detail)
  }
  return body as T
}

function query(cwd: string | undefined, project?: string): string {
  const params = new URLSearchParams()
  if (cwd !== undefined && cwd !== '') params.set('cwd', cwd)
  if (project !== undefined && project !== '') params.set('project', project)
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

export async function loadProjects(cwd?: string, project?: string): Promise<DiscoveryInfo> {
  const body = await request<DiscoveryInfo>(`/projects${query(cwd, project)}`)
  const fallback: DiscoveryInfo = {
    cwd: body.cwd,
    projects: Array.isArray(body.projects) ? body.projects : [],
    ...(body.selected === undefined ? {} : { selected: body.selected as HardwareProjectInfo }),
    ...(body.issue === undefined ? {} : { issue: body.issue }),
  }
  return fallback
}

export async function loadInstallations(): Promise<InstallationsInfo> {
  return request<InstallationsInfo>('/installations')
}

export async function environment(): Promise<{ text?: string; childEnv?: Record<string, string> }> {
  return request<{ text?: string; childEnv?: Record<string, string> }>('/environment')
}

export async function openArtifact(requestBody: {
  application: NativeApplication
  artifactPath: string
  kind: string
  projectPath?: string
}): Promise<void> {
  await request('/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
}
