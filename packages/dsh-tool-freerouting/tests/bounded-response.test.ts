import { expect, it, vi } from 'vitest';
import { boundedResponse } from '../src/proxy/bounded-response.js';

it('counts UTF-8 bytes and accepts a response exactly at the byte limit', async () => {
  await expect(boundedResponse(new Response('铜'), 3)).resolves.toBe('铜');
  await expect(boundedResponse(new Response('铜'), 2)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
});

it('cancels an advertised oversized body before reading it', async () => {
  const cancelled = vi.fn();
  const response = new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-length': '9' } });
  await expect(boundedResponse(response, 8)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  expect(cancelled).toHaveBeenCalledOnce();
});

it('propagates stream failure without treating it as a size violation', async () => {
  const cause = new Error('transport lost');
  const response = new Response(new ReadableStream({ start: (controller) => controller.error(cause) }));
  await expect(boundedResponse(response)).rejects.toBe(cause);
});

it('accepts an empty response', async () => {
  await expect(boundedResponse(new Response(null))).resolves.toBe('');
});
