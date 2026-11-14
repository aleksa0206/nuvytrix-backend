/** Escapes LIKE wildcards so user search text is matched literally. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
