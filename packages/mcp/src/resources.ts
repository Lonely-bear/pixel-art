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
  compositeFrame,
  compositeWithOnion,
  describeCommands,
  encodePNG,
  extractRegion,
  PixelBuffer,
  resolveFrame,
  resolveLayer,
  scaleNearest,
} from '@pixel/core';
import type { DocumentStore } from './session.js';
import { PIXEL_ART_SKILL, SCRIPT_GUIDE, SCRIPT_GUIDE_URI, SKILL_URI } from './skill.js';

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
          layers: sprite.layers.filter((l) => f.cels.has(l.id)).map((l) => l.id),
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

  // Query strings are part of the URI, but the SDK's RFC 6570 matcher anchors the
  // template at `$`, so `pixel://documents/{id}/preview?frame=1` never reaches the
  // plain template. A second template with an exploded `{+query}` segment matches the
  // query form; both share one reader, which parses `uri.searchParams`.
  const previewConfig = {
    title: 'Document preview',
    description:
      'The composited sprite as a PNG image. Query options: `?frame=N` for a specific frame, `?frames=all` for a horizontal strip of every frame, `?scale=K` to upscale, `?rect=x,y,w,h` to crop-zoom a detail, `?layer=name` (repeatable, or `?layers=a,b`) to isolate layers, and `?onion=1` (or `?onionBefore=1&onionAfter=1`, with `?onionOpacity=`, `?loop=1`, `?beforeTint=`, `?afterTint=`) to ghost the neighbouring frames.',
    mimeType: 'image/png',
  };

  const readPreview = (uri: URL, variables: Record<string, unknown>): ReadResourceResult => {
    const doc = store.require(String(variables.id));
    const sprite = doc.editor.sprite;
    const params = new URL(uri.href).searchParams;

    const layerRefs = [
      ...params.getAll('layer'),
      ...(params.get('layers')?.split(',') ?? []),
    ]
      .map((ref) => ref.trim())
      .filter(Boolean);
    const layers = layerRefs.length > 0 ? layerRefs.map((ref) => resolveLayer(sprite, ref).id) : undefined;

    const numberParam = (name: string): number | undefined => {
      const raw = params.get(name);
      if (raw === null) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    const onionAll = params.get('onion');
    const onionBefore = Math.max(0, Math.floor(numberParam('onionBefore') ?? (onionAll !== null ? Math.max(1, numberParam('onion') ?? 1) : 0)));
    const onionAfter = Math.max(0, Math.floor(numberParam('onionAfter') ?? (onionAll !== null ? Math.max(1, numberParam('onion') ?? 1) : 0)));
    const onion =
      onionBefore > 0 || onionAfter > 0
        ? {
            before: onionBefore,
            after: onionAfter,
            opacity: numberParam('onionOpacity'),
            loop: params.get('loop') === '1' || params.get('loop') === 'true',
            beforeTint: params.get('beforeTint') ?? undefined,
            afterTint: params.get('afterTint') ?? undefined,
          }
        : undefined;

    const render = (frameId: string): PixelBuffer =>
      onion
        ? compositeWithOnion(sprite, frameId, { layers, ...onion })
        : compositeFrame(sprite, frameId, { layers });

    let buffer;
    if (params.get('frames') === 'all' && sprite.frames.length > 1) {
      const frames = sprite.frames.map((f) => render(f.id));
      const strip = new PixelBuffer(frames.length * sprite.width + (frames.length - 1), sprite.height);
      frames.forEach((img, i) => strip.blit(img, i * (sprite.width + 1), 0));
      buffer = strip;
    } else {
      const frameIndex = Number(params.get('frame') ?? 0);
      const frame = resolveFrame(sprite, Number.isFinite(frameIndex) ? frameIndex : 0);
      buffer = render(frame.id);
    }

    const rectParam = params.get('rect');
    if (rectParam) {
      const [rx, ry, rw, rh] = rectParam.split(',').map((n) => Math.floor(Number(n)));
      if ([rx, ry, rw, rh].every((n) => Number.isFinite(n)) && rw > 0 && rh > 0) {
        buffer = extractRegion(buffer, { x: rx, y: ry, w: rw, h: rh });
      }
    }

    const scaleParam = params.get('scale');
    const factor = scaleParam
      ? Math.max(1, Math.min(32, Math.floor(Number(scaleParam)) || 1))
      : Math.max(1, Math.min(16, Math.floor(256 / Math.max(buffer.width, buffer.height)) || 1));
    const shown = factor > 1 ? scaleNearest(buffer, factor) : buffer;
    return png(uri, encodePNG(shown));
  };

  server.registerResource(
    'document-preview',
    new ResourceTemplate('pixel://documents/{id}/preview', { list: undefined }),
    previewConfig,
    readPreview,
  );

  server.registerResource(
    'document-preview-query',
    new ResourceTemplate('pixel://documents/{id}/preview{+query}', { list: undefined }),
    previewConfig,
    readPreview,
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
    (uri) => json(uri, { commands: describeCommands(store.registry.list()) }),
  );

  server.registerResource(
    'command-guide',
    new ResourceTemplate('pixel://guide/{command}', {
      // Advertised with one example so a client can discover the manual without
      // having to be told the URI exists.
      list: () => ({ resources: [{ uri: 'pixel://guide/autotile', name: 'autotile' }] }),
    }),
    {
      title: 'Command manual',
      description:
        'The long-form manual for one command: conventions, ordering rules, re-run hazards and worked defaults. This is where the detail behind a tool description lives, so it can be read at the moment it is needed instead of sitting in every request. `describe_command` returns the same text.',
      mimeType: 'text/markdown',
    },
    (uri, variables) => {
      const name = String(variables.command);
      const command = store.registry.get(name);
      if (!command) {
        throw new Error(
          `No command named "${name}". Call list_commands to see the catalogue; a command with no guide returns just its description.`,
        );
      }
      const header = `# ${command.name}\n\n${command.description}\n`;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: command.guide ? `${header}\n${command.guide}` : `${header}\n_No long-form guide: the tool description and \`describe_command\` schema are the whole story._`,
          },
        ],
      };
    },
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

  server.registerResource(
    'script-guide',
    SCRIPT_GUIDE_URI,
    {
      title: 'Scripting and plugin guide',
      description:
        'How to use run_script and load_plugin: the sandbox API, its limits, the single-undo-step rule, and how defineCommand turns a plugin into real tools.',
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: SCRIPT_GUIDE }],
    }),
  );
}
