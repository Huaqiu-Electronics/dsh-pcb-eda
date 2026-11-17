import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPublicationPlan, parsePublishArgs, topoOrder } from '../publish.mjs'

const workspacePkgs = () => [
  {
    rel: 'dsh-auth',
    dir: '/repo/packages/dsh-auth',
    name: '@huaqiu/dsh-auth',
    version: '0.6.30',
    manifest: { name: '@huaqiu/dsh-auth', version: '0.6.30' },
  },
  {
    rel: 'dsh-ui',
    dir: '/repo/packages/dsh-ui',
    name: '@huaqiu/dsh-ui',
    version: '0.6.30',
    manifest: { name: '@huaqiu/dsh-ui', version: '0.6.30', dependencies: { '@huaqiu/dsh-auth': '^0.6.30' } },
  },
]

const canonicalPkg = (version = '0.6.30') => ({
  rel: 'release-manifest',
  dir: '/repo/release-manifest',
  name: '@huaqiu/dsh-plugin-release-manifest',
  version,
  manifest: { name: '@huaqiu/dsh-plugin-release-manifest', version },
})

test('publish flags are parsed without executing npm commands', () => {
  assert.deepEqual(parsePublishArgs(['--dry-run', '--provenance', '--tag=v0.6.30']), {
    dryRun: true,
    provenance: true,
    tagArg: 'v0.6.30',
  })
  assert.equal(parsePublishArgs(['--tag', 'v1.2.3']).tagArg, 'v1.2.3')
})

test('topoOrder publishes dependencies before consumers', () => {
  const order = topoOrder(workspacePkgs())
  assert.deepEqual(order.map((p) => p.name), ['@huaqiu/dsh-auth', '@huaqiu/dsh-ui'])
})

test('publication plan appends the canonical manifest package last', () => {
  const plan = buildPublicationPlan(['--dry-run'], {
    publishablePackages: workspacePkgs,
    releaseManifestPackage: () => canonicalPkg(),
  })
  assert.equal(plan.version, '0.6.30')
  assert.equal(plan.dryRun, true)
  assert.equal(plan.workspaceCount, 2)
  assert.deepEqual(plan.plan.map((p) => p.name), [
    '@huaqiu/dsh-auth',
    '@huaqiu/dsh-ui',
    '@huaqiu/dsh-plugin-release-manifest',
  ])
})

test('publication plan refuses to mix versions', () => {
  assert.throws(
    () => buildPublicationPlan([], {
      publishablePackages: workspacePkgs,
      releaseManifestPackage: () => canonicalPkg('0.6.29'),
    }),
    /package versions out of sync/,
  )
})
