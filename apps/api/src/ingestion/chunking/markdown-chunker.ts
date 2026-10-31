import { normalizeLineEndings, stripFrontMatter } from './normalize';
import { fullHeadingPathLabel, headingPathLabel, mergeTinySections, parseHeadingSections, Section } from './heading-sections';
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
      // A heading with no body of its own before its first subheading
      // (e.g. "## Refund Policy" directly followed by "### Standard
      // Window", nothing between them) has no same-parent sibling to
      // merge into (see mergeTinySections), so it's kept as its own
      // section - sometimes genuinely empty, sometimes containing nothing
      // but a backward-merge's absorbed heading-line text. Either way
      // there's nothing worth embedding or storing, and a database
      // schema requiring non-empty text would reject it outright (found
      // against a real document, not a hypothetical - see
      // docs/learning-notes.md). Dropped here, before positions are
      // assigned, so chunkKey/position stay fully sequential - this is
      // NOT a post-hoc filter that would leave gaps.
      const [start, end] = span;
      if (content.slice(start, end).trim().length === 0) {
        continue;
      }
      finalSpans.push({ section, span });
    }
  }

  if (finalSpans.length === 0) {
    // Every section the chunker found was heading-only, with no body text
    // anywhere (e.g. a document that's only a table of contents).
    return { ok: false, error: { code: 'EMPTY_INPUT', message: 'Document has no embeddable content after chunking.' } };
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
    // headingPath (display/citation) may be truncated; embeddingText is
    // always built from the FULL, untruncated title list - a display cap
    // must never silently remove real topic information from what's
    // actually sent to the embedding model.
    const headingPath = headingPathLabel(section);
    const fullHeadingPath = fullHeadingPathLabel(section);
    return {
      position,
      chunkKey: `${options.documentSlug}-${position}`,
      headingPath,
      headingTitles: section.titles,
      text: chunkText,
      embeddingText: buildEmbeddingText(fullHeadingPath, chunkText),
      approxTokens: approxTokens(chunkText),
      startOffset: start,
      endOffset: end,
    };
  });

  return { ok: true, chunks };
}
