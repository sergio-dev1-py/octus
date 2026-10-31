/**
 * @octus/core — búsqueda web intercambiable y descarga con protección SSRF.
 * Todo resultado web es no confiable: se reporta, jamás se ejecuta como instrucción.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { ToolManifest } from "@octus/shared";
import { OctusError } from "../errors.js";
import type { ToolDefinition } from "./tool-definitions.js";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  readonly id: string;
  search(query: string, maxResults: number, signal: AbortSignal): Promise<WebSearchResult[]>;
}

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_BYTES = 1_000_000;

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, "");
  if (lower === "localhost") return true;
  if (lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".lan")) return true;
  return false;
}

function isPrivateIP(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("ff")) return true;
    return false;
  }
  return true;
}

/** Resuelve el host y bloquea destinos privados/locales (SSRF). */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OctusError("invalid_tool_args", `Invalid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OctusError("scope_violation", `Only http(s) URLs are allowed: ${url.protocol}//…`);
  }
  if (isPrivateHostname(url.hostname)) {
    throw new OctusError("scope_violation", `Blocked private/local host: ${url.hostname}`);
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new OctusError("tool_failed", `DNS resolution failed for ${url.hostname}`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateIP(a.address))) {
    throw new OctusError("scope_violation", `Blocked non-public address for host: ${url.hostname}`);
  }
  return url;
}

export interface FetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  truncatedBytes: boolean;
}

/** Descarga con redirecciones revalidadas, timeout y tope de bytes. */
export async function fetchPageText(
  rawUrl: string,
  options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_FETCH_BYTES;
  let current = rawUrl;
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicHttpUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      response = await fetch(url.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "octus-researcher/2 (+local research tool)", accept: "text/html,text/plain,application/json" },
      });
    } catch (error) {
      throw new OctusError("tool_failed", `Fetch failed for ${url.hostname}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new OctusError("tool_failed", "Redirect without location header");
      current = new URL(location, url).toString();
      continue;
    }
    break;
  }
  if (!response || [301, 302, 303, 307, 308].includes(response.status)) {
    throw new OctusError("tool_failed", `Too many redirects (>${MAX_REDIRECTS})`);
  }
  if (!response.ok) {
    throw new OctusError("tool_failed", `HTTP ${response.status} for ${new URL(current).hostname}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/|json|xml/i.test(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    throw new OctusError("tool_failed", `Unsupported content type: ${contentType.slice(0, 80)}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new OctusError("tool_failed", "Empty response body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return { finalUrl: current, status: response.status, contentType, text: htmlToText(text), truncatedBytes: truncated };
}

/** Extracción mínima de texto legible (sin dependencias). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Backend sin clave: DuckDuckGo HTML (intercambiable vía WebSearchProvider). */
export class DuckDuckGoProvider implements WebSearchProvider {
  readonly id = "duckduckgo";
  constructor(private readonly options: { baseUrl?: string; allowPrivate?: boolean } = {}) {}

  async search(query: string, maxResults: number, signal: AbortSignal): Promise<WebSearchResult[]> {
    const base = this.options.baseUrl ?? "https://html.duckduckgo.com";
    const target = `${base}/html/?q=${encodeURIComponent(query)}`;
    const url = this.options.allowPrivate ? new URL(target) : await assertPublicHttpUrl(target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { "user-agent": "octus-researcher/2 (+local research tool)" },
      });
      if (!res.ok) throw new OctusError("tool_failed", `Search backend HTTP ${res.status}`);
      const html = await res.text();
      return parseDuckDuckGo(html).slice(0, maxResults);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export function parseDuckDuckGo(html: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const linkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetPattern.exec(html)) !== null && snippets.length < 30) {
    snippets.push(htmlToText(snippetMatch[1] ?? "").slice(0, 500));
  }
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = linkPattern.exec(html)) !== null && out.length < 30) {
    let href = (match[1] ?? "").trim();
    // DuckDuckGo envuelve con //duckduckgo.com/l/?uddg=<encoded>
    const wrapped = href.match(/[?&]uddg=([^&]+)/);
    if (wrapped?.[1]) {
      try {
        href = decodeURIComponent(wrapped[1]);
      } catch {
        // conserva el original
      }
    }
    if (!href.startsWith("http://") && !href.startsWith("https://")) continue;
    out.push({ title: htmlToText(match[2] ?? "").slice(0, 300) || href, url: href, snippet: snippets[index] ?? "" });
    index++;
  }
  return out;
}

let activeProvider: WebSearchProvider = new DuckDuckGoProvider();

export function setWebSearchProvider(provider: WebSearchProvider): void {
  activeProvider = provider;
}

export function getWebSearchProvider(): WebSearchProvider {
  return activeProvider;
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

const websearchSchema = z.object({
  query: z.string().min(1).max(500).describe("Search query"),
  maxResults: z.number().int().min(1).max(10).optional().describe("Max results (default 5)"),
});

const webfetchSchema = z.object({
  url: z.string().min(1).max(2000).describe("http(s) URL to fetch"),
  maxChars: z.number().int().min(100).max(100_000).optional().describe("Max characters to return (default 12000)"),
});

function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const maybe = schema as unknown as { toJSONSchema?: () => Record<string, unknown> };
  return typeof maybe.toJSONSchema === "function" ? maybe.toJSONSchema() : { type: "object" };
}

export const websearchTool: ToolDefinition = {
  manifest: {
    name: "websearch",
    description: "Search the web (untrusted results). Returns titles, URLs and snippets.",
    inputJsonSchema: toJsonSchema(websearchSchema),
    permissionAction: "websearch",
  },
  schema: websearchSchema,
  async run(args: unknown, ctx: { signal: AbortSignal }) {
    const parsed = args as { query: string; maxResults?: number };
    const results = await getWebSearchProvider().search(parsed.query, parsed.maxResults ?? 5, ctx.signal);
    if (results.length === 0) return { text: "(no results — untrusted web content)" };
    const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
    return { text: `[untrusted web content]\n${text}` };
  },
};

export const webfetchTool: ToolDefinition = {
  manifest: {
    name: "webfetch",
    description: "Fetch an http(s) page as text (untrusted). Private/local IPs and excess redirects are blocked.",
    inputJsonSchema: toJsonSchema(webfetchSchema),
    permissionAction: "webfetch",
  },
  schema: webfetchSchema,
  async run(args: unknown, ctx: { signal: AbortSignal; maxInlineChars: number }) {
    const parsed = args as { url: string; maxChars?: number };
    const page = await fetchPageText(parsed.url, { signal: ctx.signal });
    const limit = Math.min(parsed.maxChars ?? 12_000, ctx.maxInlineChars);
    const sliced = page.text.slice(0, limit);
    const text = `[untrusted web content from ${page.finalUrl}]\n${sliced}${page.text.length > limit || page.truncatedBytes ? "\n…(truncated)" : ""}`;
    return { text, fullText: page.text.length > limit ? page.text : undefined };
  },
};

export const WEB_TOOLS: ToolDefinition[] = [websearchTool, webfetchTool];
