/** Renderer — Markdown con saneado estricto (el contenido del modelo es no confiable). */
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true });

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
