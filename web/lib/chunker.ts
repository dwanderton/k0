/**
 * Deterministic page → chunk splitter for the embedding index. Pure
 * function of docs-cache.br content: same cache in, byte-identical chunks
 * out — chunk idx is the additive-rebuild anchor, so ordering must never
 * depend on anything but the page text.
 */

export interface Chunk {
  key: string;
  title: string;
  heading: string;
  idx: number;
  text: string;
}

const TARGET_MAX = 3200; // chars ≈ 800 tokens
const MERGE_MIN = 300;

function frontmatter(md: string): { title: string; body: string; fm: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { title: "", body: md, fm: "" };
  const pick = (k: string) =>
    m[1].match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  const title = pick("title");
  const description = pick("description");
  // Raw YAML embeds as noise; a clean "Title — description" line is the
  // strongest page-aboutness signal a first chunk can carry.
  const fm = [title, description].filter(Boolean).join(" — ");
  return { title, body: md.slice(m[0].length), fm };
}

/** >80% of content lines being markdown links = nav/footer noise, not prose. */
function isNavNoise(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 4) return false;
  const linkish = lines.filter((l) => /^\s*(?:[-*]\s*)?\[[^\]]*\]\([^)]*\)\s*$/.test(l.trim()));
  return linkish.length / lines.length > 0.8;
}

function splitLong(body: string): string[] {
  if (body.length <= TARGET_MAX) return [body];
  const paras = body
    .split(/\n\n+/)
    // A single para over budget (minified/no-break pages) gets hard-sliced —
    // an oversized chunk would blow the embed API's 8191-token cap.
    .flatMap((p) => {
      if (p.length <= TARGET_MAX) return [p];
      const parts: string[] = [];
      for (let i = 0; i < p.length; i += TARGET_MAX) parts.push(p.slice(i, i + TARGET_MAX));
      return parts;
    });
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > TARGET_MAX) {
      out.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function chunkPage(key: string, markdown: string): Chunk[] {
  let { title, body, fm } = frontmatter(markdown);
  // Description-led first chunks for ROOT pages only (/docs/<product>) —
  // that's where concept queries belong. Applied everywhere, descriptions
  // lift wrong boats too (a Platforms action page once outranked the real
  // add-a-domain guide on its description alone).
  const pathname = key.slice(key.indexOf(":") + 1);
  if (!/^\/docs\/[^/]+$/.test(pathname)) {
    fm = title; // deep pages: title prefix only, as before the experiment
  }
  // Frontmatter carries title/description — high retrieval signal, so it
  // rides in the page's first chunk.
  const sections: { heading: string; body: string }[] = [];
  let heading = "";
  let buf: string[] = fm ? [fm] : [];
  for (const line of body.split("\n")) {
    const h = line.match(/^#{1,3}\s+(.+)$/);
    if (h) {
      sections.push({ heading, body: buf.join("\n").trim() });
      heading = h[1].trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  sections.push({ heading, body: buf.join("\n").trim() });

  // Merge short sections into their predecessor (heading kept inline so
  // the signal isn't lost), then split oversized ones on paragraphs.
  const merged: { heading: string; body: string }[] = [];
  for (const s of sections) {
    if (!s.body && !s.heading) continue;
    const last = merged[merged.length - 1];
    if (last && s.body.length < MERGE_MIN) {
      last.body = `${last.body}\n\n## ${s.heading}\n${s.body}`.trim();
    } else {
      merged.push({ ...s });
    }
  }

  const chunks: Chunk[] = [];
  for (const s of merged) {
    for (const part of splitLong(s.body)) {
      const bodyText = part.trim();
      if (!bodyText || isNavNoise(bodyText)) continue;
      const label = [title, s.heading].filter(Boolean).join(" › ");
      chunks.push({
        key,
        title,
        heading: s.heading,
        idx: chunks.length,
        text: label ? `${label}\n\n${bodyText}` : bodyText,
      });
    }
  }
  return chunks;
}

export function chunkAll(cache: Map<string, string>): Chunk[] {
  const raw: Chunk[] = [];
  // Sort keys: chunk order must be independent of cache-map insertion order.
  for (const key of [...cache.keys()].sort()) {
    raw.push(...chunkPage(key, cache.get(key)!));
  }
  // Corpus-wide boilerplate dedup: identical bodies on ≥3 pages are template
  // chrome (blog "Explore"/"Social" blocks — 2,211 rows at first count), not
  // content. They embed as topical noise because the title prefix differs
  // per page. Body = text minus the title/heading label line.
  const body = (t: string) => t.split("\n").slice(1).join("\n").trim();
  const counts = new Map<string, number>();
  for (const c of raw) {
    const b = body(c.text);
    if (b.length > 200) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const out: Chunk[] = [];
  const perPage = new Map<string, number>();
  for (const c of raw) {
    if ((counts.get(body(c.text)) ?? 0) >= 3) continue;
    const idx = perPage.get(c.key) ?? 0;
    perPage.set(c.key, idx + 1);
    out.push({ ...c, idx }); // re-number so idx stays dense per page
  }
  return out;
}
