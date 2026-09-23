/**
 * MCP resources.
 *
 * Tools are for doing; resources are for *seeing*. Multimodal models iterate far
 * better when the artwork arrives as an actual `image/png` blob than when they
 * are handed a grid of hex codes, so the preview resource is the important one
 * here. The others let a client pull the document list, the command catalogue
 * and the craft guide without spending a tool call.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import {
  allCommands,
  compositeFrame,
  describeCommands,
  encodePNG,
  PixelBuffer,
  resolveFrame,
  scaleNearest,
} from '@pixel/core';
import type { DocumentStore } from './session.js';
import { PIXEL_ART_SKILL, SKILL_URI } from './skill.js';

function json(uri: URL, value: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function png(uri: URL, bytes: Uint8Array): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'image/png',
        blob: Buffer.from(bytes).toString('base64'),
      },
    ],
  };
}

export function registerResources(server: McpServer, store: DocumentStore): void {
  server.registerResource(
    'documents',
    'pixel://documents',
    {
      title: 'Open documents',
      description: 'Every document in this session, with its size, structure and version.',
      mimeType: 'application/json',
    },
    (uri) =>
      json(uri, {
        activeDocument: store.activeDocumentId,
        documents: store.list().map((d) => store.summary(d)),
      }),
  );

  server.registerResource(
    'document',
    new ResourceTemplate('pixel://documents/{id}', { list: undefined }),
    {
      title: 'Document details',
      description: 'Full structure of one document: layers, frames, tags, palette and version.',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const doc = store.require(String(variables.id));
      const sprite = doc.editor.sprite;
      return json(uri, {
        ...store.summary(doc),
        layers: sprite.layers.map((l, index) => ({ index, ...l })),
        frames: sprite.frames.map((f, index) => ({
          index,
          id: f.id,
          durationMs: f.durationMs,
          layers: [...f.cels.keys()],
        })),
        tags: sprite.tags,
        palette: {
          name: sprite.palette.name,
          colors: sprite.palette.colors.map((c) => {
            const hex = (n: number) => n.toString(16).padStart(2, '0');
            return c.a === 255
              ? `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`
              : `#${hex(c.r)}${hex(c.g)}${hex(c.b)}${hex(c.a)}`;
          }),
        },
      });
    },
  );

  server.registerResource(
    'document-preview',
    new ResourceTemplate('pixel://documents/{id}/preview', { list: undefined }),
    {
      title: 'Document preview',
      description:
        'The composited sprite as a PNG image. Add `?frame=N` for a specific frame or `?frames=all` for a horizontal strip of every frame.',
      mimeType: 'image/png',
    },
    (uri, variables) => {
      const doc = store.require(String(variables.id));
      const sprite = doc.editor.sprite;
      const params = new URL(uri.href).searchParams;

      let buffer;
      if (params.get('frames') === 'all' && sprite.frames.length > 1) {
        const frames = sprite.frames.map((f) => compositeFrame(sprite, f.id));
        const strip = new PixelBuffer(frames.length * sprite.width + (frames.length - 1), sprite.height);
        frames.forEach((img, i) => strip.blit(img, i * (sprite.width + 1), 0));
        buffer = strip;
      } else {
        const frameIndex = Number(params.get('frame') ?? 0);
        const frame = resolveFrame(sprite, Number.isFinite(frameIndex) ? frameIndex : 0);
        buffer = compositeFrame(sprite, frame.id);
      }

      const scaleParam = params.get('scale');
      const factor = scaleParam
        ? Math.max(1, Math.min(32, Math.floor(Number(scaleParam)) || 1))
        : Math.max(1, Math.min(16, Math.floor(256 / Math.max(buffer.width, buffer.height)) || 1));
      const shown = factor > 1 ? scaleNearest(buffer, factor) : buffer;
      return png(uri, encodePNG(shown));
    },
  );

  server.registerResource(
    'commands',
    'pixel://commands',
    {
      title: 'Command catalogue',
      description:
        'Every command the editor understands, with its JSON Schema. Anything here can be run through the `apply_ops` tool.',
      mimeType: 'application/json',
    },
    (uri) => json(uri, { commands: describeCommands(allCommands) }),
  );

  server.registerResource(
    'skill',
    SKILL_URI,
    {
      title: 'Pixel art craft guide',
      description:
        'How to draw pixel art that reads well: silhouette-first workflow, ramps, outlines, dithering, anti-aliasing, animation.',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: PIXEL_ART_SKILL }],
    }),
  );
}
