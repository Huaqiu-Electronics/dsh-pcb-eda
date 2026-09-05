import { afterEach, describe, expect, it, vi } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { ARTIFACTS_ROUTE_PREFIX, createArtifactsHandler } from '../src/routes.js'

describe('artifact route methods', () => {
  let server: http.Server | undefined

  afterEach(async () => {
    if (!server) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve())
    })
  })

  it('rejects non-GET requests before reading artifact data', async () => {
    const getArtifact = vi.fn()
    server = http.createServer(createArtifactsHandler({ get: getArtifact } as never))
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    const response = await new Promise<{ status: number; allow: string | undefined; body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `${ARTIFACTS_ROUTE_PREFIX}/art_deadbeef`,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          allow: res.headers.allow,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      req.on('error', reject)
      req.end()
    })

    expect(response).toEqual({
      status: 405,
      allow: 'GET',
      body: JSON.stringify({ error: 'method not allowed' }),
    })
    expect(getArtifact).not.toHaveBeenCalled()
  })
})
