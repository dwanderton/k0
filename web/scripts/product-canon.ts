/** Shared by the manifest enrichers: the model free-texts product names
 *  ("Vercel Monitoring", "Content Delivery", "previews") — collapse to one
 *  canonical vocabulary so chips are consistent and the agent's
 *  product-list matching actually matches. */
const PRODUCT_CANON: Record<string, string> = {
  "functions": "Vercel Functions",
  "serverless functions": "Vercel Functions",
  "edge functions": "Edge Functions",
  "middleware": "Edge Middleware",
  "edge middleware": "Edge Middleware",
  "routing middleware": "Edge Middleware",
  "preview deployments": "Preview Deployments",
  "previews": "Preview Deployments",
  "cdn": "CDN",
  "content delivery": "CDN",
  "edge network": "CDN",
  "web analytics": "Web Analytics",
  "analytics": "Web Analytics",
  "observability": "Observability",
  "monitoring": "Observability",
  "logs": "Observability",
  "log drains": "Observability",
  "speed insights": "Speed Insights",
  "feature flags": "Feature Flags",
  "flags": "Feature Flags",
  "firewall": "Firewall",
  "waf": "Firewall",
  "ddos mitigation": "Firewall",
  "bot management": "Firewall",
  "botid": "BotID",
  "isr": "ISR",
  "incremental static regeneration": "ISR",
  "fluid": "Fluid compute",
  "fluid compute": "Fluid compute",
  "ai sdk": "AI SDK",
  "ai gateway": "AI Gateway",
  "sandbox": "Sandbox",
  "blob": "Blob",
  "queues": "Queues",
  "edge config": "Edge Config",
  "cron": "Cron Jobs",
  "cron jobs": "Cron Jobs",
  "workflow": "Workflow",
  "workflows": "Workflow",
  "workflow sdk": "Workflow",
  "workflow devkit": "Workflow",
  "nextjs": "Next.js",
  "next.js": "Next.js",
  "toolbar": "Vercel Toolbar",
  "comments": "Vercel Toolbar",
  "for platforms": "Vercel for Platforms",
  "multi-tenant": "Vercel for Platforms",
  "domains": "Domains",
  "domains api": "Domains",
  "data cache": "Data Cache",
  "agent": "Vercel Agent",
  "container registry": "Container Registry",
  "microfrontends": "Microfrontends",
  "rolling releases": "Rolling Releases",
  "instant rollbacks": "Instant Rollbacks",
};

export function canonProducts(raw: string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const k = r.trim().toLowerCase().replace(/^vercel\s+/, "");
    // "Vercel" alone is the platform, not a product feature
    if (!k || k === "platform" || k === "vercel") continue;
    const c = PRODUCT_CANON[k] ?? r.trim();
    if (!out.includes(c)) out.push(c);
  }
  return out;
}
