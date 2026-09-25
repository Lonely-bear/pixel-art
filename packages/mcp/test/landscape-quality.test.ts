import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPixelServer, type PixelServer } from '../src/server.js';

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content.find((item) => item.type === 'text')?.text ?? '{}');
}

let client: Client;
let pixel: PixelServer;

beforeEach(async () => {
  // Eager: this suite calls command tools directly. The lazy surface, and the
  // promotion paths that replace it, are covered in tool-surface.test.ts.
  pixel = createPixelServer({ initialDocument: null, commands: 'eager' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'landscape-calibration-test', version: '1.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    pixel.server.connect(serverTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  await pixel.server.close();
});

async function report(fileName: string): Promise<Record<string, unknown>> {
  const opened = payload((await client.callTool({
    name: 'open_document',
    arguments: { path: resolve('../../artwork', fileName), select: false },
  })) as ToolResult);
  const documentId = (opened.document as { id: string }).id;
  return payload((await client.callTool({
    name: 'quality_report',
    arguments: { document: documentId },
  })) as ToolResult);
}

describe('full-bleed landscape structure diagnostics', () => {
  it('measures all six primary artwork fixtures instead of returning an alpha blind spot', async () => {
    const files = [
      'sunset-lighthouse-512.pixel',
      'sunset-lighthouse-512-baseline-model-a.pixel',
      'moonlit-alpine-lake.pixel',
      'moonlit-alpine-lake-fast.pixel',
      'dusk-lake-valley.pixel',
      'autumn-dusk-lake-256.pixel',
    ];
    for (const file of files) {
      const body = await report(file);
      const landscape = body.landscape as {
        measurable: boolean;
        horizontalBoundaries: unknown[];
        horizon: unknown;
        ridge: unknown;
        waterline: unknown;
        guideLines: { present: boolean; vertical: boolean; diagonal: boolean };
        conclusion: string;
      };
      expect(landscape, file).toBeTruthy();
      expect(landscape.measurable, file).toBe(true);
      expect(Array.isArray(landscape.horizontalBoundaries), file).toBe(true);
      expect(landscape.conclusion, file).toMatch(/guide|boundary|structure/i);
      expect((body.warnings as Array<{ code: string }>).map((warning) => warning.code), file).not.toContain('landscape_repeated_bands');
      expect(landscape.guideLines, file).toEqual(
        expect.objectContaining({
          present: expect.any(Boolean),
          detected: expect.any(Boolean),
          vertical: expect.any(Boolean),
          diagonal: expect.any(Boolean),
        }),
      );
      expect((body.structure as { landscape: unknown }).landscape).toBeTruthy();
    }
  });

  it('keeps a generated ridged contour out of the uniform-rhythm warning', async () => {
    await client.callTool({
      name: 'create_document',
      arguments: { width: 128, height: 64, layers: ['base'] },
    });
    await client.callTool({
      name: 'ridge_line',
      arguments: {
        x: 0,
        y: 34,
        width: 128,
        amplitude: 18,
        scale: 32,
        octaves: 4,
        gain: 0.5,
        seed: 17,
        color: '#ffffff',
      },
    });
    const body = payload((await client.callTool({ name: 'quality_report', arguments: {} })) as ToolResult);
    const rhythm = (body.structure as { rhythm: { uniform: boolean } }).rhythm;
    expect(rhythm.uniform).toBe(false);
    expect((body.warnings as Array<{ code: string }>).map((warning) => warning.code)).not.toContain('uniform_rhythm');
  });

  it('does not flag the known-good agent2 and catches the known-bad landscape baselines', async () => {
    const good = await report('dusk-lake-valley-agent2.pixel');
    const badAgent = await report('dusk-lake-valley-agent.pixel');
    const badV2 = await report('dusk-lake-valley-v2.pixel');
    const warningCodes = (body: Record<string, unknown>) =>
      (body.warnings as Array<{ code: string }>).map((warning) => warning.code);

    expect((good.landscape as { measurable: boolean }).measurable).toBe(true);
    expect(warningCodes(good)).not.toContain('landscape_repeated_bands');
    expect(warningCodes(badAgent)).toContain('landscape_repeated_bands');
    expect(warningCodes(badV2)).toContain('landscape_repeated_bands');
  });
});
