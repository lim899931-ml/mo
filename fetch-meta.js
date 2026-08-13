// Vercel serverless function: best-effort og:title / og:image scraper.
// Many platforms (xhs, douyin, wechat, instagram) block unauthenticated
// scraping — this returns { title: null, image: null } when nothing can
// be found so the frontend falls back to manual entry.

const UA_CANDIDATES = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)',
  'Twitterbot/1.0',
];

async function fetchWithTimeout(url, ua, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text') && !contentType.includes('html') && !contentType.includes('xml')) return null;
    return await resp.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractMeta(html, keys) {
  const metaTagRegex = /<meta\s+[^>]*>/gi;
  const tags = html.match(metaTagRegex) || [];
  for (const tagStr of tags) {
    const propMatch = tagStr.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
    if (!propMatch) continue;
    const prop = propMatch[1].toLowerCase();
    if (keys.includes(prop)) {
      const contentMatch = tagStr.match(/content\s*=\s*["']([^"']*)["']/i);
      if (contentMatch && contentMatch[1]) return contentMatch[1];
    }
  }
  return null;
}

function extractTitleTag(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : null;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function resolveUrl(maybeRelative, base) {
  try {
    return new URL(maybeRelative, base).toString();
  } catch (e) {
    return maybeRelative;
  }
}

module.exports = async (req, res) => {
  const url = req.query && req.query.url;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'missing url' });
    return;
  }

  let target;
  try {
    target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) throw new Error('bad protocol');
  } catch (e) {
    res.status(400).json({ error: 'invalid url' });
    return;
  }

  let html = null;
  for (const ua of UA_CANDIDATES) {
    const result = await fetchWithTimeout(target.toString(), ua, 7000);
    if (result) {
      html = result;
      if (/og:(title|image)/i.test(result)) break; // good enough, stop trying more UAs
    }
  }

  if (!html) {
    res.status(200).json({ title: null, image: null });
    return;
  }

  const rawTitle = extractMeta(html, ['og:title', 'twitter:title']) || extractTitleTag(html);
  const title = rawTitle ? decodeEntities(rawTitle).trim() : null;

  let image = extractMeta(html, ['og:image', 'og:image:secure_url', 'twitter:image']);
  if (image) image = resolveUrl(image, target);

  res.status(200).json({ title: title || null, image: image || null });
};
