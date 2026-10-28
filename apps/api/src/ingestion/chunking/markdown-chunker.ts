import { normalizeLineEndings, stripFrontMatter } from './normalize';
import { headingPathLabel, mergeTinySections, parseHeadingSections, Section } from './heading-sections';
import { packSection } from './section-packer';
import { approxTokens } from './text-metrics';
import { Chunk, ChunkerOptions, ChunkingOutcome } from './markdown-chunker.types';

const DEFAULT_TARGET_TOKENS = 400;
const DEFAULT_MIN_MERGE_TOKENS = 100;
const DEFAULT_OVERLAP_TOKENS = 50;
const DEFAULT_MAX_CHUNKS = 500;

function buildEmbeddingText(headingPath: string, text: string): string {
  return headingPath.length === 0 ? text : `${headingPath}\n\n${text}`;
}

/**
 * Pure function - no DB, no LLM, no I/O. Deterministic: the same `text` and
 * `options` always produce identical output, since every step (normalize,
 * split, merge, pack) depends only on its inputs.
 */
export function chunkMarkdown(text: string, options: ChunkerOptions): ChunkingOutcome {
  if (text.trim().length === 0) {
    return { ok: false, error: { code: 'EMPTY_INPUT', message: 'Document text is empty or whitespace-only.' } };
  }

  const targetTokens = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const minMergeTokens = options.minMergeTokens ?? DEFAULT_MIN_MERGE_TOKENS;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;

  const content = stripFrontMatter(normalizeLineEndings(text));
  if (content.trim().length === 0) {
    // The whole document was front matter.
    return { ok: false, error: { code: 'EMPTY_INPUT', message: 'Document has no content after removing front matter.' } };
  }

  const rawSections = parseHeadingSections(content);
  const sections = mergeTinySections(content, rawSections, minMergeTokens);

  const finalSpans: Array<{ section: Section; span: [number, number] }> = [];
  for (const section of sections) {
    const spans = packSection(content, section.start, section.end, targetTokens, overlapTokens);
    for (const span of spans) {
      finalSpans.push({ section, span });
    }
  }

  if (finalSpans.length > maxChunks) {
    return {
      ok: false,
      error: {
        code: 'TOO_MANY_CHUNKS',
        message: `Chunking produced ${finalSpans.length} chunks, exceeding the limit of ${maxChunks}.`,
      },
    };
  }

  const chunks: Chunk[] = finalSpans.map(({ section, span }, position) => {
    const [start, end] = span;
    const chunkText = content.slice(start, end);
    const headingPath = headingPathLabel(section.headingPath);
    return {
      position,
      chunkKey: `${options.documentSlug}-${position}`,
      headingPath,
      text: chunkText,
      embeddingText: buildEmbeddingText(headingPath, chunkText),
      approxTokens: approxTokens(chunkText),
      startOffset: start,
      endOffset: end,
    };
  });

  return { ok: true, chunks };
}
