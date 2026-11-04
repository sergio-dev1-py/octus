/**
 * Fallback para modelos que emiten tool calls dentro del texto (DSML/XML)
 * en vez de `tool_calls` nativos. El runtime las convierte en llamadas reales
 * y elimina el bloque del texto persistido.
 */
export interface EmbeddedToolCall {
  name: string;
  argumentsJson: string;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function coerce(name: string, raw: string): unknown {
  const value = decodeEntities(raw);
  const trimmed = value.trim();
  if (name !== "content" && name !== "newString" && name !== "oldString") return trimmed;
  // Contenido de archivos: preservar saltos/espacios; solo quitar el borde XML.
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

export function extractEmbeddedToolCalls(text: string): { text: string; calls: EmbeddedToolCall[] } {
  const calls: EmbeddedToolCall[] = [];
  // Prefijo opcional tipo DSML (`<｜DSML｜ invoke>`, `<dsml:invoke>`, `<invoke>`).
  const invoke = /<(?:[^>\s]+[\s:])?invoke\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:[^>\s]+[\s:])?invoke>/gi;
  for (const match of text.matchAll(invoke)) {
    const name = match[1]!;
    const body = match[2] ?? "";
    const args: Record<string, unknown> = {};
    const parameter = /<(?:[^>\s]+[\s:])?parameter\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:[^>\s]+[\s:])?parameter>/gi;
    for (const param of body.matchAll(parameter)) {
      args[param[1]!] = coerce(param[1]!, param[2] ?? "");
    }
    calls.push({ name, argumentsJson: JSON.stringify(args) });
  }
  if (calls.length === 0) return { text, calls };
  // Quita invokes y cualquier envoltorio tipo <tool_calls> / <｜DSML｜ calls>.
  const cleaned = text
    .replace(invoke, "")
    .replace(/<\/?[^>]*calls[^>]*>/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return { text: cleaned, calls };
}
