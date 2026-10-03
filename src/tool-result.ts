/**
 * Joins each run of adjacent text content blocks in a tool result into one
 * block.
 *
 * Some MCP clients only read the first content block of a tool result. The
 * OpenAI Responses API's remote MCP tool is one: a backend that answers in
 * several text blocks (Outline's `fetch` sends metadata first and the document
 * body second) has everything after the first block silently dropped. Joining
 * the text keeps the whole answer visible to those clients and reads the same
 * to clients that handled the blocks already. Non-text blocks are left where
 * they are, so text and images stay in their original order.
 */
export function mergeAdjacentTextContent<T>(result: T): T {
    const content = (result as any)?.content;
    if (!Array.isArray(content) || content.length < 2) {
        return result;
    }

    const merged: any[] = [];
    for (const block of content) {
        const previous = merged[merged.length - 1];
        if (isPlainText(block) && isPlainText(previous)) {
            merged[merged.length - 1] = { ...previous, text: `${previous.text}\n\n${block.text}` };
        } else {
            merged.push(block);
        }
    }

    if (merged.length === content.length) {
        return result;
    }

    return { ...(result as any), content: merged };
}

/** A text block with nothing besides its text that joining would lose. */
function isPlainText(block: any): boolean {
    return block?.type === 'text'
        && typeof block.text === 'string'
        && Object.keys(block).every((key) => key === 'type' || key === 'text');
}
